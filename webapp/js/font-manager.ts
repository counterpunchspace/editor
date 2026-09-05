// Font Manager
// Keeps track of all open fonts, and access to font data.
// Also maintains the opened font dropdown UI.
// Implements editing-font compilation architecture:
// "editing" font: Recompiled on demand with subset of glyphs for display in canvas

import APP_SETTINGS from './settings';
import * as Y from 'yjs';
import {
    fontCompilation,
    fullFontCompilation,
    requestOpenFontConversion,
    COMPILATION_TARGETS,
    adoptTransferredUint8Array
} from './font-compilation';
import { get_glyph_order } from '../wasm-dist/babelfont_fontc_web';
import * as babelfontWasm from '../wasm-dist/babelfont_fontc_web';
import type { Babelfont } from './babelfont';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import {
    Font,
    Path,
    DecomposedAffineTransform,
    FIP001_BOOLEAN_KEY,
    FIP001_BOOLEAN_SUBTRACTION,
    GLYPHS_ATTR_KEY,
    pathHasSubtractionFlag,
    withSuppressedModelRecording
} from './babelfont-model';
import { canonicalizeImportedFontJson } from './font-import-canonicalization';
import { jsonToYDoc, fromYType, getYPath } from './change-bridge-ydoc';
import {
    describeRestingLayerViolation,
    omitRestingLayerRuntimeKeys,
    toRestingLayerJson,
    toRestingShapeJson
} from './resting-layer-json';
import { sidebarErrorDisplay } from './sidebar-error-display';
import type { FilesystemPlugin } from './filesystem-plugins';
import { Logger } from './logger';
import { showUnsavedChangesDialog } from './ui/confirm-dialog';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

const NO_OP_YJS_UPDATE = new Uint8Array([0, 0]);
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import {
    ensureStartupStateReady,
    isStartupStateReady,
    resetStartupStateReady
} from './state-restore';
import { decodeFeatures, formatUrl, readUrlState } from './url-state';
import {
    normalizeWorkerReplayTargets,
    type WorkerReplayTarget
} from './change-log';
import {
    beginStartupInteractionLock,
    endStartupInteractionLock
} from './startup-interaction-lock';
import { ensureWasmInitialized } from './wasm-init';
import {
    cancelManagedFileInternalWrite,
    markManagedFileInternalWrite
} from './managed-file-events';

const { save_font_as_glyphs } = babelfontWasm as object as {
    save_font_as_glyphs: (babelfontJson: string) => string;
};

const console = new Logger('FontManager');

let startupOpenSessionActive = false;
let startupOpenSessionEditingCompileCount = 0;
let startupCompiledSubsetKey = '';

export function setStartupEditingCompileGateForTests(options: {
    active: boolean;
    compileCount?: number;
    compiledSubsetKey?: string;
}): void {
    startupOpenSessionActive = options.active;
    startupOpenSessionEditingCompileCount = options.compileCount ?? 0;
    startupCompiledSubsetKey = options.compiledSubsetKey ?? '';
}

export async function serializeFontForSourceSave(
    path: string,
    babelfontJson: string
): Promise<string> {
    const extension = path.split('.').pop()?.toLowerCase();

    if (extension === 'babelfont') {
        return babelfontJson;
    }

    if (extension === 'glyphs') {
        await ensureWasmInitialized();
        const glyphsSerializationInput = JSON.stringify(
            stampPathBooleanFlagsForGlyphsSave(JSON.parse(babelfontJson))
        );
        return save_font_as_glyphs(glyphsSerializationInput);
    }

    throw new Error(
        `Cannot save ${path} in its original format: source saving currently supports .babelfont and .glyphs files.`
    );
}

function stampPathBooleanFlagsForGlyphsSave(data: unknown): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
    }

    const font = data as { glyphs?: unknown };
    if (!Array.isArray(font.glyphs)) {
        return data;
    }

    const stampShape = (shape: unknown): void => {
        if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
            return;
        }
        const record = shape as Record<string, unknown>;
        const pathPayload =
            record.Path && typeof record.Path === 'object'
                ? (record.Path as Record<string, unknown>)
                : 'nodes' in record
                  ? record
                  : null;
        if (!pathPayload) {
            return;
        }
        const formatSpecific = (pathPayload.format_specific || {}) as Record<
            string,
            unknown
        >;
        if (!pathHasSubtractionFlag(formatSpecific)) {
            return;
        }
        const attr = {
            ...((formatSpecific[GLYPHS_ATTR_KEY] as
                Record<string, unknown> | undefined) || {})
        };
        attr[FIP001_BOOLEAN_KEY] = FIP001_BOOLEAN_SUBTRACTION;
        pathPayload.format_specific = {
            ...formatSpecific,
            [FIP001_BOOLEAN_KEY]: FIP001_BOOLEAN_SUBTRACTION,
            [GLYPHS_ATTR_KEY]: attr
        };
    };

    for (const glyph of font.glyphs) {
        if (!glyph || typeof glyph !== 'object') {
            continue;
        }
        const layers = (glyph as { layers?: unknown }).layers;
        if (!Array.isArray(layers)) {
            continue;
        }
        for (const layer of layers) {
            if (!layer || typeof layer !== 'object') {
                continue;
            }
            const shapes = (layer as { shapes?: unknown }).shapes;
            if (!Array.isArray(shapes)) {
                continue;
            }
            for (const shape of shapes) {
                stampShape(shape);
            }
        }
    }

    return data;
}

export type GlyphData = {
    glyphName: string;
    layers: {
        id: string;
        name: string;
        _master: string;
        location?: DesignspaceLocation;
    }[];
    masters: {
        id: string;
        name: string;
        location: UserspaceLocation;
    }[];
    axesOrder: string[];
};

export type RustBatchLayerTarget = {
    glyphName: string;
    layerId: string;
};

export type RustBatchMetadata = {
    changedGlyphs: string[];
    layerTargets: RustBatchLayerTarget[];
    layerOperations: Array<{
        glyphName: string;
        layerId: string;
        oldValue?: unknown;
        newValue?: unknown;
    }>;
    mastersOperation?: {
        oldValue?: unknown;
        newValue: unknown;
    } | null;
    axesOperation?: {
        oldValue?: unknown;
        newValue: unknown;
    } | null;
};

export type RustBatchDocumentUpdate = {
    documentId: string;
    update: Uint8Array;
};

export type RustBatchResult = {
    update: Uint8Array;
    updates?: RustBatchDocumentUpdate[];
    metadata: RustBatchMetadata;
};

export function rustBatchHasContent(result: RustBatchResult): boolean {
    if (result.update.length > 0) {
        return true;
    }
    return Boolean(result.updates?.some((packet) => packet.update.length > 0));
}

export type AddMasterInterpolationLocation = {
    glyphName: string;
    designLocation: DesignspaceLocation;
};

type LayerCacheUpdate = {
    glyphName: string;
    layerId: string;
    layerData: Babelfont.Layer;
};

type ExplicitLayerCacheInput = LayerCacheUpdate;

/**
 * Counters that record traffic across the JS ↔ Rust/worker boundary.
 *
 * These are the numbers the Counterpunch compilation policy locks down:
 * during interactive editing every commit MUST flow through the authoritative
 * Yjs update path (`forwardWorkerYjsUpdate` → `applyYjsUpdate` worker
 * message). Full-font
 * crossings (`storeFontJson`) MUST stay at zero outside of font open,
 * external reload, and explicit force-full sync. Tests assert the
 * deltas of these counters per edit/cascade/undo/remote operation.
 */
export type BoundaryCrossingStats = {
    /** Number of `forwardWorkerYjsUpdate` batches (1 per batch). */
    submitBatchCalls: number;
    /** Total number of layer entries crossed in batches. */
    layersTransmitted: number;
    /** Number of distinct glyphs crossed in batches (running count). */
    glyphsTransmitted: number;
    /**
     * Number of full-font `storeFontJson` crossings since the last
     * reset. Should stay 0 during normal interactive editing.
     */
    fullFontCrossings: number;
};

/**
 * Shared empty fingerprint baseline map. Returned by the (now no-op)
 * `getLayerFingerprintsFromStoredJson` to avoid re-parsing the
 * megabyte-scale `babelfontJson` on every commit batch.
 */
const EMPTY_FINGERPRINT_MAP: Map<string, string> = new Map();

class FontDataIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FontDataIntegrityError';
    }
}

type SerializableLayerRecord = {
    id?: string;
    width?: number | null;
};

type SerializableGlyphRecord = {
    name?: string;
    layers?: SerializableLayerRecord[];
};

type SerializableFontRecord = {
    glyphs?: SerializableGlyphRecord[];
};

function assertFiniteLayerWidth(
    width: number | null | undefined,
    context: {
        glyphName?: string | null;
        layerId?: string | null;
        operation: string;
    }
): asserts width is number {
    if (typeof width === 'number' && Number.isFinite(width)) {
        return;
    }

    const glyphName = context.glyphName || '[unknown glyph]';
    const layerId = context.layerId || '[unknown layer]';
    throw new FontDataIntegrityError(
        `Layer ${glyphName}/${layerId} has invalid width during ${context.operation}; refusing to serialize malformed layer data.`
    );
}

function assertBabelfontLayerWidths(
    data: SerializableFontRecord,
    operation: string
): void {
    if (!Array.isArray(data?.glyphs)) {
        return;
    }

    for (const glyph of data.glyphs) {
        if (!Array.isArray(glyph?.layers)) {
            continue;
        }

        for (const layer of glyph.layers) {
            assertFiniteLayerWidth(layer?.width, {
                glyphName: glyph?.name,
                layerId: layer?.id,
                operation
            });
        }
    }
}

type ReloadCurrentFontOptions = {
    preserveUiState?: boolean;
};

type CapturedGlyphCanvasState = {
    wasEditMode: boolean;
    selectedGlyphIndex: number;
    selectedLayerId: string | null;
    cursorPosition: number;
    textBuffer: string;
    variationSettings: UserspaceLocation | null;
    viewport: {
        scale: number;
        panX: number;
        panY: number;
    } | null;
};

export type EditingCompileContext = {
    changeSource: string | null;
    editType: 'outline' | 'anchor' | 'kerning-value' | 'kerning-groups' | null;
    dataFreshnessMode:
        'authoritative-worker-yjs' | 'live-drag-worker-preview' | null;
};

type EditingCompileRequestOptions = {
    compileContext?: EditingCompileContext | null;
};

function normalizeEditingCompileContext(
    context?: EditingCompileContext | null
): EditingCompileContext {
    return {
        changeSource: context?.changeSource ?? null,
        editType: context?.editType ?? null,
        dataFreshnessMode: context?.dataFreshnessMode ?? null
    };
}

class OpenedFont {
    babelfontJson: string;
    babelfontData: any;
    fontModel: Font; // Object model facade
    name: string;
    path: string;
    needsRecompile: boolean;
    hasUnsavedChanges: boolean;
    sourcePlugin: FilesystemPlugin;
    fileHandle?: FileSystemFileHandle;
    directoryHandle?: FileSystemDirectoryHandle;
    changeVersion: number; // Counter incremented on every change to track data freshness
    compileRequestVersion: number; // Counter incremented on every editing-font compile request

    constructor(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        const canonicalImport = canonicalizeImportedFontJson(babelfontJson);
        this.babelfontJson = canonicalImport.babelfontJson;
        this.babelfontData = canonicalImport.fontData;
        this.sourcePlugin = sourcePlugin;
        this.fileHandle = fileHandle;
        this.directoryHandle = directoryHandle;

        assertBabelfontLayerWidths(
            this.babelfontData,
            'OpenedFont.constructor'
        );

        this.fontModel = canonicalImport.fontModel;
        this.path = path;
        this.name =
            this.babelfontData?.names?.family_name?.dflt || 'Untitled Font';
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
        this.changeVersion = 0;
        this.compileRequestVersion = 0;
    }

    private normalizeComponentTransformForRust(
        transform: unknown
    ): Babelfont.DecomposedAffine {
        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        const identity = DecomposedAffineTransform.identity();
        if (!transform || typeof transform !== 'object') {
            return identity;
        }

        const record = transform as Record<string, unknown>;
        const translation = Array.isArray(record.translation)
            ? [
                  Number(record.translation[0]) || 0,
                  Number(record.translation[1]) || 0
              ]
            : [0, 0];
        const scale = Array.isArray(record.scale)
            ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
            : [1, 1];
        const rawSkew = Array.isArray(record.skew)
            ? record.skew
            : [record.skew ?? 0, 0];
        const skew = [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0] as [
            number,
            number
        ];
        const rotation = Number(record.rotation) || 0;
        const order =
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? (record.order as Babelfont.TransformOrder)
                : identity.order;

        return {
            translation: translation as [number, number],
            scale: scale as [number, number],
            rotation,
            skew,
            order
        };
    }

    /**
     * Mark font as changed:
     * - needsRecompile: auto-compile pipeline should rebuild editing font
     * - hasUnsavedChanges: save indicator and unload warnings
     * This allows tracking whether data changed during compilation
     */
    markDirty(
        changeSource?: string,
        options?: {
            requestEditingCompile?: boolean;
            compileContext?: EditingCompileContext | null;
        }
    ): void {
        const requestEditingCompile = options?.requestEditingCompile !== false;
        this.needsRecompile = requestEditingCompile;
        if (!this.isCloudBacked()) {
            this.hasUnsavedChanges = true;
        }
        this.changeVersion++;
        this.compileRequestVersion++;
        if (requestEditingCompile) {
            (window as any).fontManager?.recordEditingCompileRequestContext?.(
                this.compileRequestVersion,
                options?.compileContext
            );
        }
    }

    /**
     * Request editing-font recompilation without marking font data as changed.
     * Use this when switching compilation mode (e.g. outline-only -> full)
     * without any new source data edits.
     */
    requestRecompileWithoutDataChange(
        options?: EditingCompileRequestOptions
    ): void {
        this.needsRecompile = true;
        this.compileRequestVersion++;
        (window as any).fontManager?.recordEditingCompileRequestContext?.(
            this.compileRequestVersion,
            options?.compileContext
        );
    }

    isCloudBacked(): boolean {
        return this.sourcePlugin?.getId?.() === 'cloud';
    }

    /**
     * Sync the JSON string from the object model data
     * Call this after making changes through the object model.
     * Path nodes are arrays in both runtime and serialized storage JSON.
     */
    syncJsonFromModel(): void {
        assertBabelfontLayerWidths(this.babelfontData, 'syncJsonFromModel');

        // Process all layers to prepare for serialization
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (!layer?.shapes) continue;

                for (let i = 0; i < layer.shapes.length; i++) {
                    const shape = layer.shapes[i];

                    if (
                        shape &&
                        typeof shape === 'object' &&
                        ('Path' in shape || 'Component' in shape)
                    ) {
                        throw new TypeError(
                            'Wrapped shapes are not allowed in syncJsonFromModel.'
                        );
                    }

                    const componentCandidate =
                        'reference' in shape ? shape : null;

                    if (componentCandidate) {
                        componentCandidate.transform =
                            this.normalizeComponentTransformForRust(
                                componentCandidate.transform
                            );
                    }
                }
            }
        }

        // `babelfontJson` backs bridge/worker seeding and must retain logical
        // automatic component placement. Rust owns physicalization at
        // compile-read; only explicit export asks for compile-facing JSON.
        this.babelfontJson = this.fontModel.toJSONString({
            compileFacing: false
        });
    }

    /**
     * Save font using the source plugin's adapter
     */
    async save(): Promise<void> {
        this.syncJsonFromModel();
        const pluginId = this.sourcePlugin.getId();
        const serializedFont = await serializeFontForSourceSave(
            this.path,
            this.babelfontJson
        );

        // For disk plugin, need file handle and permission check
        if (pluginId === 'disk') {
            if (!this.fileHandle) {
                throw new Error('No file handle available for disk save');
            }

            // Check permission
            const permission = await (this.fileHandle as any).queryPermission({
                mode: 'readwrite'
            });
            if (permission !== 'granted') {
                const requestedPermission = await (
                    this.fileHandle as any
                ).requestPermission({ mode: 'readwrite' });
                if (requestedPermission !== 'granted') {
                    throw new Error('Write permission not granted');
                }
            }

            // Write to file
            markManagedFileInternalWrite(pluginId, this.path);
            try {
                const writable = await this.fileHandle.createWritable();
                await writable.write(serializedFont);
                await writable.close();
            } catch (error) {
                cancelManagedFileInternalWrite(pluginId, this.path);
                if (error instanceof Error && error.name === 'SecurityError') {
                    throw new Error(
                        'Permission denied. Please re-enable disk access and try again.'
                    );
                }
                throw error;
            }
        } else {
            // For other plugins, use adapter's writeFile method
            const adapter = this.sourcePlugin.getAdapter();
            await adapter.writeFile(this.path, serializedFont);
        }

        // Clear unsaved/sync flags after successful save
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
    }
}

class FontManager {
    fontDisplay: HTMLElement | null;
    fontIconElement: HTMLElement | null;
    fontNameElement: HTMLElement | null;
    fontRoleBadgeElement: HTMLElement | null;
    dirtyIndicator: HTMLElement | null;

    openedFonts: Map<string, OpenedFont>; // Record of fontId to OpenedFont
    currentFontId: string | null = null;
    editingFont: Uint8Array | null;
    currentText: string;
    selectedFeatures: string[];
    isCompiling: boolean;
    glyphOrderCache: string[] | null;
    lastChangeSource: string | null = null; // Track what triggered the last change (keyboard, mouse-drag, etc.)
    lastEditType:
        'outline' | 'anchor' | 'kerning-value' | 'kerning-groups' | null = null; // Track edit type for compilation optimization
    lastCompilationMode:
        | 'full'
        | 'outline-only'
        | 'anchor-only'
        | 'kerning-only'
        | 'text-input' = 'full'; // Track last compilation mode
    /**
     * The `changeVersion` of the font at the time the last *full* editing
     * compile completed successfully.  Used by the committed-change funnel to
     * skip incremental compiles that would be redundant after the debounce full
     * compile has already covered the same data version.
     * -1 means no full compile has run yet for the current font.
     */
    lastFullCompiledDataVersion: number = -1;
    /**
     * Highest preview revision that has been applied. Live preview revisions
     * are deliberately allowed to lag queued pointer ticks: rejecting every
     * result until input becomes idle starves the visible drag path.
     */
    private lastAppliedLivePreviewRevision: number = -1;
    closureCache: {
        subsetGlyphs: string[];
        activeFeatures: string;
        closureSet: string[];
    } | null = null;
    editingSubsetSnapshotGlyphs: string[];
    editingSubsetSnapshotKey: string;
    isExternalReloading: boolean = false;
    pendingDebugEditingFontSaveAfterDrag: boolean;
    pendingBabelfontJsonSyncAfterDrag: boolean;
    pendingCommittedKeyboardDriftCheckAfterDrag: boolean;
    workerCacheUpdatePromise: Promise<void> | null;
    forceFullEditingCacheRefresh: boolean;
    workerLayerFingerprintCache: Map<string, string>;
    lastWorkerDocumentEpoch: number;
    lastWorkerFilterEpoch: number;
    lastWorkerFontCacheEpoch: number;
    /** True while the worker document is quarantined after a failed sync. */
    private workerMirrorQuarantined: boolean;
    private editingCompileContextsByRevision: Map<
        string,
        EditingCompileContext
    >;
    private workerYjsSendQueue: Promise<unknown>;
    private workerPreviewSendQueue: Promise<unknown>;
    private pendingCloudBadgeVisibleAtByAssetId: Map<string, number>;
    private pendingCloudBadgeDelayTimer: ReturnType<typeof setTimeout> | null;
    private pendingCloudBadgeDelayAssetId: string | null;

    /**
     * Memoizes the result of validateBabelfontJsonForRust.
     * The validator parses, walks, and re-serializes the entire babelfontJson.
     * Only runs when `pendingBabelfontJsonSyncAfterDrag` is set (after
     * undo/redo/remote-sync) or when forceValidation is explicitly requested.
     * Caching by input identity eliminates repeated overhead when the same
     * string is passed multiple times. Cache is invalidated implicitly: any
     * new input string (a different object reference or different content)
     * misses and re-runs the validator.
     */
    private _validatedBabelfontJsonCache: {
        input: string;
        output: string;
    } | null = null;

    /**
     * Running counters for traffic across the JS \u2194 Rust/worker boundary.
     * See {@link BoundaryCrossingStats} and {@link getBoundaryCrossingStats}.
     */
    private _boundaryCrossingStats: {
        submitBatchCalls: number;
        layersTransmitted: number;
        fullFontCrossings: number;
        transmittedGlyphs: Set<string>;
    } = {
        submitBatchCalls: 0,
        layersTransmitted: 0,
        fullFontCrossings: 0,
        transmittedGlyphs: new Set<string>()
    };

    constructor() {
        this.fontDisplay = null;
        this.fontIconElement = null;
        this.fontNameElement = null;
        this.fontRoleBadgeElement = null;
        this.dirtyIndicator = null;
        this.openedFonts = new Map<string, OpenedFont>();
        this.editingFont = null; // Uint8Array of compiled editing font
        this.currentText = '';
        this.selectedFeatures = [];
        this.isCompiling = false;
        this.glyphOrderCache = null; // Cache for glyph order to avoid re-parsing
        this.clearEditingCompileContext();
        this.lastCompilationMode = 'full';
        this.lastFullCompiledDataVersion = -1;
        this.lastAppliedLivePreviewRevision = -1;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.isExternalReloading = false;
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.pendingCommittedKeyboardDriftCheckAfterDrag = false;
        this.workerCacheUpdatePromise = null;
        this.forceFullEditingCacheRefresh = false;
        this.workerLayerFingerprintCache = new Map();
        this.lastWorkerDocumentEpoch = 0;
        this.lastWorkerFilterEpoch = 0;
        this.lastWorkerFontCacheEpoch = 0;
        this.workerMirrorQuarantined = false;
        this.editingCompileContextsByRevision = new Map();
        this.workerYjsSendQueue = Promise.resolve();
        this.workerPreviewSendQueue = Promise.resolve();
        this.pendingCloudBadgeVisibleAtByAssetId = new Map();
        this.pendingCloudBadgeDelayTimer = null;
        this.pendingCloudBadgeDelayAssetId = null;

        window.addEventListener('cloudConnectionStatusChanged', () => {
            this.updateFontDisplay();
            void this.updateDirtyIndicator();
        });
        window.addEventListener('cloudAssetRoleChanged', () => {
            this.updateFontDisplay();
        });
    }
    init() {
        this.fontDisplay = document.getElementById('current-font-display');
        this.fontIconElement =
            this.fontDisplay?.querySelector('.font-icon') || null;
        this.fontNameElement =
            this.fontDisplay?.querySelector('.font-name') || null;
        this.fontRoleBadgeElement =
            this.fontDisplay?.querySelector('.font-window-role-badge') || null;
        this.dirtyIndicator = document.getElementById('file-dirty-indicator');

        // Listen for cloud sync status changes to update dirty indicator
        window.addEventListener('cloudConnectionStatusChanged', () => {
            void this.updateDirtyIndicator();
        });
    }

    private ensureCloudConnectionWarningBadge(): HTMLElement | null {
        const container = this.fontDisplay?.parentElement;
        if (!container) {
            return null;
        }

        let badge =
            (document.getElementById(
                'cloud-status-chip'
            ) as HTMLElement | null) ??
            (container.querySelector(
                '.cloud-status-chip'
            ) as HTMLElement | null);
        if (badge) {
            return badge;
        }

        badge = document.createElement('span');
        badge.id = 'cloud-status-chip';
        badge.className = 'cloud-status-chip';
        badge.setAttribute('role', 'status');
        badge.setAttribute('aria-live', 'polite');
        badge.hidden = true;
        badge.innerHTML =
            '<span class="material-symbols-outlined">cloud_done</span>';

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );

        if (shareButton) {
            container.insertBefore(badge, shareButton);
        } else if (cloudAccessRoleBadge) {
            container.insertBefore(badge, cloudAccessRoleBadge);
        } else {
            container.appendChild(badge);
        }

        return badge;
    }

    /**
     * Delay the connected pending-sync warning so brief durable-ack latency
     * does not flash the titlebar chip during normal cloud transmissions.
     */
    private shouldShowDelayedPendingCloudBadge(
        assetId: string,
        pendingSyncCount: number,
        status: string | undefined,
        hasConnectionProblem: boolean
    ): boolean {
        if (
            pendingSyncCount < 1 ||
            status !== 'connected' ||
            hasConnectionProblem
        ) {
            this.pendingCloudBadgeVisibleAtByAssetId.delete(assetId);
            if (this.pendingCloudBadgeDelayAssetId === assetId) {
                this.clearPendingCloudBadgeDelayTimer();
            }
            return false;
        }

        const delayMs = 1000;
        const now = Date.now();
        let visibleAt = this.pendingCloudBadgeVisibleAtByAssetId.get(assetId);
        if (visibleAt === undefined) {
            visibleAt = now + delayMs;
            this.pendingCloudBadgeVisibleAtByAssetId.set(assetId, visibleAt);
        }

        if (now >= visibleAt) {
            if (this.pendingCloudBadgeDelayAssetId === assetId) {
                this.clearPendingCloudBadgeDelayTimer();
            }
            return true;
        }

        this.armPendingCloudBadgeDelayTimer(assetId, visibleAt - now);
        return false;
    }

    private armPendingCloudBadgeDelayTimer(
        assetId: string,
        delayMs: number
    ): void {
        if (
            this.pendingCloudBadgeDelayTimer !== null &&
            this.pendingCloudBadgeDelayAssetId === assetId
        ) {
            return;
        }

        this.clearPendingCloudBadgeDelayTimer();
        this.pendingCloudBadgeDelayAssetId = assetId;
        this.pendingCloudBadgeDelayTimer = setTimeout(
            () => {
                this.pendingCloudBadgeDelayTimer = null;
                this.pendingCloudBadgeDelayAssetId = null;
                this.updateFontDisplay();
            },
            Math.max(0, delayMs)
        );
    }

    private clearPendingCloudBadgeDelayTimer(): void {
        if (this.pendingCloudBadgeDelayTimer !== null) {
            clearTimeout(this.pendingCloudBadgeDelayTimer);
            this.pendingCloudBadgeDelayTimer = null;
        }
        this.pendingCloudBadgeDelayAssetId = null;
    }

    private getCloudConnectionWarningState(font: OpenedFont | null): {
        visible: boolean;
        title: string;
        icon: string;
        tone: 'idle' | 'warning' | 'error';
    } {
        const hiddenState = {
            visible: false,
            title: '',
            icon: 'cloud_done',
            tone: 'idle' as const
        };

        if (!font?.isCloudBacked()) {
            return hiddenState;
        }

        const assetId = this.normalizeCloudAssetId(font);
        if (!assetId) {
            return hiddenState;
        }

        const sizeWarningState =
            window.cloudPlugin?.getAssetSizeWarningState?.(assetId);
        if (sizeWarningState?.visible) {
            return {
                visible: true,
                title: sizeWarningState.title,
                icon: sizeWarningState.icon,
                tone: sizeWarningState.tone
            };
        }

        const pendingSyncCount =
            window.cloudPlugin?.getAssetPendingSyncCount?.(assetId) ?? 0;
        const hasConnectionProblem =
            window.cloudPlugin?.hasConnectionProblem?.(assetId) ?? false;
        const status = window.cloudPlugin?.getAssetConnectionStatus?.(assetId);
        const detail = window.cloudPlugin?.getAssetConnectionDetail?.(assetId);
        const transferActivity =
            window.cloudPlugin?.getAssetTransferActivity?.(assetId) ?? 'idle';
        const transferPresentation =
            transferActivity === 'sending'
                ? {
                      icon: 'cloud_upload',
                      tone: 'idle' as const,
                      fallbackReason: 'Sending changes to the cloud'
                  }
                : transferActivity === 'receiving'
                  ? {
                        icon: 'cloud_download',
                        tone: 'idle' as const,
                        fallbackReason: 'Receiving cloud updates'
                    }
                  : null;
        const connectedPendingPresentation =
            this.shouldShowDelayedPendingCloudBadge(
                assetId,
                pendingSyncCount,
                status,
                hasConnectionProblem
            )
                ? {
                      icon: 'cloud_upload',
                      tone: 'warning' as const,
                      fallbackReason: `${pendingSyncCount} cloud edit${pendingSyncCount === 1 ? '' : 's'} waiting for durable sync`
                  }
                : null;

        const presentation = hasConnectionProblem
            ? status === 'connecting'
                ? {
                      icon: 'cloud_sync',
                      tone: 'warning' as const,
                      fallbackReason: 'Reconnecting to the cloud room'
                  }
                : status === 'authenticating'
                  ? {
                        icon: 'cloud_sync',
                        tone: 'warning' as const,
                        fallbackReason: 'Authenticating cloud room access'
                    }
                  : status === 'syncing'
                    ? {
                          icon: 'sync',
                          tone: 'warning' as const,
                          fallbackReason: 'Syncing cloud room state'
                      }
                    : status === 'disconnected'
                      ? {
                            icon: 'cloud_off',
                            tone: 'warning' as const,
                            fallbackReason: 'Cloud room is disconnected'
                        }
                      : {
                            icon: 'cloud_alert',
                            tone: 'error' as const,
                            fallbackReason: 'Cloud connection error'
                        }
            : transferPresentation
              ? transferPresentation
              : connectedPendingPresentation
                ? connectedPendingPresentation
                : status === 'connecting'
                  ? {
                        icon: 'cloud_sync',
                        tone: 'idle' as const,
                        fallbackReason: 'Connecting to the cloud room'
                    }
                  : status === 'authenticating'
                    ? {
                          icon: 'cloud_sync',
                          tone: 'idle' as const,
                          fallbackReason: 'Authenticating cloud room access'
                      }
                    : status === 'syncing'
                      ? {
                            icon: 'sync',
                            tone: 'idle' as const,
                            fallbackReason: 'Syncing cloud room state'
                        }
                      : {
                            icon: 'cloud_done',
                            tone: 'idle' as const,
                            fallbackReason:
                                'Connected. Changes sync continuously.'
                        };

        return {
            visible: true,
            title: `Cloud status: ${detail || presentation.fallbackReason}`,
            icon: presentation.icon,
            tone: presentation.tone
        };
    }

    setEditingCompileContext(
        changeSource: string | null,
        editType: typeof this.lastEditType
    ): void {
        this.lastChangeSource = changeSource;
        this.lastEditType = editType;
    }

    clearEditingCompileContext(): void {
        this.setEditingCompileContext(null, null);
    }

    recordEditingCompileRequestContext(
        compileRequestVersion: number,
        compileContext?: EditingCompileContext | null
    ): void {
        const revisionKey = String(compileRequestVersion);
        this.editingCompileContextsByRevision.set(revisionKey, {
            ...(compileContext === undefined
                ? {
                      changeSource: this.lastChangeSource,
                      editType: this.lastEditType,
                      dataFreshnessMode: null
                  }
                : normalizeEditingCompileContext(compileContext))
        });
        this.pruneEditingCompileRequestContexts(compileRequestVersion);
    }

    private getEditingCompileContextForRequest(
        revisionKey: string
    ): EditingCompileContext {
        return (
            this.editingCompileContextsByRevision.get(revisionKey) ??
            normalizeEditingCompileContext(null)
        );
    }

    private clearEditingCompileRequestContext(revisionKey: string): void {
        this.editingCompileContextsByRevision.delete(revisionKey);
    }

    private pruneEditingCompileRequestContexts(
        currentCompileRequestVersion: number
    ): void {
        for (const revisionKey of this.editingCompileContextsByRevision.keys()) {
            const revision = Number(revisionKey);
            if (
                Number.isFinite(revision) &&
                revision < currentCompileRequestVersion - 20
            ) {
                this.editingCompileContextsByRevision.delete(revisionKey);
            }
        }
    }

    private clearEditingCompileContextIfCurrentRequest(
        changeSource: string | null,
        editType: typeof this.lastEditType,
        revisionKey: string
    ): void {
        this.clearEditingCompileRequestContext(revisionKey);
        if (!this.currentFont) {
            return;
        }
        if (String(this.currentFont.compileRequestVersion) !== revisionKey) {
            return;
        }
        if (
            this.lastChangeSource === changeSource &&
            this.lastEditType === editType
        ) {
            this.clearEditingCompileContext();
        }
    }

    private normalizeWorkerBatchUpdate(value: unknown): Uint8Array {
        if (value instanceof Uint8Array) {
            return value;
        }
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }
        if (Array.isArray(value)) {
            return new Uint8Array(value);
        }
        return new Uint8Array();
    }

    private normalizeWorkerBatchUpdates(
        value: unknown
    ): RustBatchDocumentUpdate[] | undefined {
        if (!Array.isArray(value) || value.length === 0) {
            return undefined;
        }
        const packets = value.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') {
                return [];
            }
            const record = entry as Record<string, unknown>;
            if (typeof record.documentId !== 'string' || !record.documentId) {
                return [];
            }
            const update = this.normalizeWorkerBatchUpdate(record.update);
            if (!update.length) {
                return [];
            }
            return [{ documentId: record.documentId, update }];
        });
        return packets.length ? packets : undefined;
    }

    private parseWorkerBatchMetadata(value: unknown): RustBatchMetadata {
        const rawMetadata =
            typeof value === 'string' && value.length > 0
                ? (JSON.parse(value) as Record<string, unknown>)
                : {};
        const changedGlyphs = Array.isArray(rawMetadata.changedGlyphs)
            ? rawMetadata.changedGlyphs.filter(
                  (glyphName): glyphName is string =>
                      typeof glyphName === 'string' && glyphName.length > 0
              )
            : [];
        const layerTargets = Array.isArray(rawMetadata.layerTargets)
            ? rawMetadata.layerTargets.flatMap((target) => {
                  if (!target || typeof target !== 'object') {
                      return [];
                  }
                  const glyphName = (target as Record<string, unknown>)
                      .glyphName;
                  const layerId = (target as Record<string, unknown>).layerId;
                  return typeof glyphName === 'string' &&
                      typeof layerId === 'string'
                      ? [{ glyphName, layerId }]
                      : [];
              })
            : [];
        const layerOperations = Array.isArray(rawMetadata.layerOperations)
            ? rawMetadata.layerOperations.flatMap((operation) => {
                  if (!operation || typeof operation !== 'object') {
                      return [];
                  }
                  const record = operation as Record<string, unknown>;
                  const glyphName = record.glyphName;
                  const layerId = record.layerId;
                  if (
                      typeof glyphName !== 'string' ||
                      typeof layerId !== 'string'
                  ) {
                      return [];
                  }
                  return [
                      {
                          glyphName,
                          layerId,
                          oldValue: record.oldValue,
                          newValue: record.newValue
                      }
                  ];
              })
            : [];
        const mastersOperation =
            rawMetadata.mastersOperation &&
            typeof rawMetadata.mastersOperation === 'object'
                ? (rawMetadata.mastersOperation as {
                      oldValue?: unknown;
                      newValue: unknown;
                  })
                : null;
        const axesOperation =
            rawMetadata.axesOperation &&
            typeof rawMetadata.axesOperation === 'object'
                ? (rawMetadata.axesOperation as {
                      oldValue?: unknown;
                      newValue: unknown;
                  })
                : null;

        return {
            changedGlyphs,
            layerTargets,
            layerOperations,
            mastersOperation,
            axesOperation
        };
    }

    private async requestRustBatchFromWorker(
        message: Record<string, unknown>
    ): Promise<RustBatchResult> {
        const initialized = await fontCompilation.initialize();
        if (!initialized) {
            throw new Error('Font compilation worker is not initialized');
        }

        await fontCompilation.awaitWorkerDocumentSync();
        const response = (await fontCompilation.sendMessage(message)) as {
            update?: unknown;
            updates?: unknown;
            metadataJson?: unknown;
        };

        return {
            update: this.normalizeWorkerBatchUpdate(response.update),
            updates: this.normalizeWorkerBatchUpdates(response.updates),
            metadata: this.parseWorkerBatchMetadata(response.metadataJson)
        };
    }

    async buildWorkerReinterpolateLayerBatch(
        glyphName: string,
        layerId: string
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'reinterpolateLayerYjs',
            glyphName,
            layerId
        });
    }

    async buildWorkerReinterpolateMasterLayersBatch(
        masterId: string
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'reinterpolateMasterLayersYjs',
            masterId
        });
    }

    async buildWorkerAddMasterWithInterpolatedLayersBatch(
        master: Babelfont.Master,
        interpolationLocations?: AddMasterInterpolationLocation[],
        axes?: Babelfont.Axis[]
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'addMasterWithInterpolatedLayersYjs',
            master,
            interpolationLocations: interpolationLocations ?? [],
            ...(axes ? { axes } : {})
        });
    }

    async buildWorkerRefineLayerSnapshotsBatch(
        baseUpdate: Uint8Array,
        overrides: Array<{
            glyphName: string;
            layerId: string;
            layer: unknown;
        }>
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'refineLayerSnapshotsYjs',
            baseUpdate,
            overrides
        });
    }

    async buildWorkerRemoveMastersBatch(
        masterIds: string[]
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'removeMastersYjs',
            masterIds
        });
    }

    private ensureWindowRoleBadge(): HTMLElement | null {
        if (!this.fontDisplay) {
            return null;
        }

        if (!this.fontRoleBadgeElement) {
            const badge = document.createElement('span');
            badge.className = 'font-window-role-badge';
            this.fontDisplay.appendChild(badge);
            this.fontRoleBadgeElement = badge;
        }

        return this.fontRoleBadgeElement;
    }

    private updateWindowTitle() {
        const worktreeName = window.WORKTREE_NAME || '';
        const baseTitle = worktreeName
            ? `Counterpunch Editor [${worktreeName}]`
            : 'Counterpunch Editor';
        const roleSuffix = window.windowRole?.getTitleSuffix() ?? '(Main)';
        const dirtyPrefix =
            window.windowRole?.isMainWindow() &&
            this.shouldShowDirtyState(this.currentFont)
                ? '● '
                : '';

        if (this.currentFont?.name) {
            document.title = `${dirtyPrefix}${this.currentFont.name} ${roleSuffix} - ${baseTitle}`;
            return;
        }

        document.title = `${baseTitle} ${roleSuffix}`;
    }

    get currentFont(): OpenedFont | null {
        if (this.currentFontId && this.openedFonts.has(this.currentFontId)) {
            const font = this.openedFonts.get(this.currentFontId) || null;
            // Update global reference for Python/script access
            if (font) {
                window.currentFontModel = font.fontModel;
            } else {
                window.currentFontModel = null;
            }
            return font;
        }
        window.currentFontModel = null;
        return null;
    }

    private normalizeCloudAssetId(font: OpenedFont | null): string | null {
        if (!font?.isCloudBacked()) {
            return null;
        }

        return font.path.replace(/^cloud:\/\//, '').replace(/^\/+/, '') || null;
    }

    shouldShowDirtyState(font: OpenedFont | null): boolean {
        if (!font) {
            return false;
        }

        return this.hasUnsyncedChanges(font);
    }

    /**
     * Check whether a font has unsynced changes.
     *
     * For non-cloud fonts this checks the `hasUnsavedChanges` flag.
     * For cloud-backed fonts this checks the pending outgoing sync packet count.
     */
    hasUnsyncedChanges(font: OpenedFont | null): boolean {
        if (!font) return false;
        if (!font.isCloudBacked()) return !!font.hasUnsavedChanges;
        const assetId = font.path.replace(/^cloud:\/\//, '');
        return (
            (window.cloudPlugin?.getAssetPendingSyncCount?.(assetId) ?? 0) > 0
        );
    }

    hasAnyDirtyState(): boolean {
        for (const openedFont of this.openedFonts.values()) {
            if (this.shouldShowDirtyState(openedFont)) {
                return true;
            }
        }

        return false;
    }

    updateFontDisplay() {
        if (!this.fontIconElement || !this.fontNameElement) return;

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );
        const cloudConnectionWarningBadge =
            this.ensureCloudConnectionWarningBadge();
        const isCloudPluginVisibleInUI =
            window.cloudPlugin?.isVisibleInUI?.() !== false;
        const roleLabel = window.windowRole?.getRoleLabel() ?? 'Main';
        const roleBadge = this.ensureWindowRoleBadge();

        if (roleBadge) {
            roleBadge.textContent = roleLabel;
            roleBadge.setAttribute('title', `Window role: ${roleLabel}`);
        }

        if (this.openedFonts.size === 0 || !this.currentFontId) {
            // No fonts open
            this.fontIconElement.innerHTML = '';
            this.fontNameElement.textContent = 'No fonts open';
            if (this.fontDisplay) {
                this.fontDisplay.title = roleLabel;
            }
            if (shareButton) {
                shareButton.classList.remove('visible');
                shareButton.hidden = !isCloudPluginVisibleInUI;
                shareButton.setAttribute('title', 'Invite people');
            }
            if (cloudConnectionWarningBadge) {
                cloudConnectionWarningBadge.classList.remove(
                    'visible',
                    'tone-error',
                    'tone-warning'
                );
                cloudConnectionWarningBadge.hidden = true;
                cloudConnectionWarningBadge.removeAttribute('title');
                cloudConnectionWarningBadge.removeAttribute('aria-label');
            }
            if (cloudAccessRoleBadge) {
                cloudAccessRoleBadge.classList.remove(
                    'visible',
                    'role-editor',
                    'role-viewer'
                );
                cloudAccessRoleBadge.innerHTML = '';
                cloudAccessRoleBadge.removeAttribute('title');
            }
        } else {
            // Display current font
            const currentFont = this.openedFonts.get(this.currentFontId);
            if (currentFont) {
                const sourceIcon = currentFont.sourcePlugin.getIcon();
                const sourceName = currentFont.sourcePlugin.getName();
                this.fontIconElement.innerHTML = sourceIcon;
                this.fontNameElement.textContent = currentFont.name;
                if (this.fontDisplay) {
                    this.fontDisplay.title = `${currentFont.path} (${sourceName}) — ${roleLabel}`;
                }
                if (cloudConnectionWarningBadge) {
                    const warningState = isCloudPluginVisibleInUI
                        ? this.getCloudConnectionWarningState(currentFont)
                        : {
                              visible: false,
                              title: '',
                              icon: 'cloud_done',
                              tone: 'idle' as const
                          };
                    cloudConnectionWarningBadge.classList.toggle(
                        'visible',
                        warningState.visible
                    );
                    cloudConnectionWarningBadge.classList.toggle(
                        'tone-error',
                        warningState.visible && warningState.tone === 'error'
                    );
                    cloudConnectionWarningBadge.classList.toggle(
                        'tone-warning',
                        warningState.visible && warningState.tone === 'warning'
                    );
                    if (warningState.visible) {
                        cloudConnectionWarningBadge.hidden = false;
                        cloudConnectionWarningBadge.setAttribute(
                            'title',
                            warningState.title
                        );
                        cloudConnectionWarningBadge.setAttribute(
                            'aria-label',
                            warningState.title
                        );
                        const iconElement =
                            cloudConnectionWarningBadge.querySelector(
                                '.material-symbols-outlined'
                            );
                        if (iconElement) {
                            iconElement.textContent = warningState.icon;
                        }
                    } else {
                        cloudConnectionWarningBadge.hidden = true;
                        cloudConnectionWarningBadge.removeAttribute('title');
                        cloudConnectionWarningBadge.removeAttribute(
                            'aria-label'
                        );
                    }
                }
                if (cloudAccessRoleBadge) {
                    const cloudRole = currentFont.isCloudBacked()
                        ? isCloudPluginVisibleInUI
                            ? (window.cloudPlugin?.getCurrentAssetRole?.() ??
                              null)
                            : null
                        : null;
                    const isAuthenticated =
                        window.authManager?.isAuthenticated?.() !== false;
                    if (shareButton) {
                        const shouldShowShareButton =
                            isAuthenticated &&
                            isCloudPluginVisibleInUI &&
                            currentFont.isCloudBacked() &&
                            cloudRole === 'owner';
                        shareButton.classList.toggle(
                            'visible',
                            shouldShowShareButton
                        );
                        shareButton.hidden = !isCloudPluginVisibleInUI;
                        shareButton.setAttribute(
                            'title',
                            currentFont.isCloudBacked()
                                ? 'Invite people'
                                : 'Manage access'
                        );
                    }
                    if (cloudRole === 'editor' || cloudRole === 'viewer') {
                        cloudAccessRoleBadge.classList.add('visible');
                        cloudAccessRoleBadge.classList.remove(
                            cloudRole === 'editor'
                                ? 'role-viewer'
                                : 'role-editor'
                        );
                        cloudAccessRoleBadge.classList.add(`role-${cloudRole}`);
                        cloudAccessRoleBadge.innerHTML = `<span class="material-symbols-outlined">${cloudRole === 'editor' ? 'edit' : 'visibility'}</span>`;
                        cloudAccessRoleBadge.setAttribute(
                            'title',
                            cloudRole === 'editor'
                                ? 'Editor access. You can modify this shared font.'
                                : 'Viewer access. You can inspect but not change this shared font.'
                        );
                    } else {
                        cloudAccessRoleBadge.classList.remove(
                            'visible',
                            'role-editor',
                            'role-viewer'
                        );
                        cloudAccessRoleBadge.hidden = !isCloudPluginVisibleInUI;
                        cloudAccessRoleBadge.innerHTML = '';
                        cloudAccessRoleBadge.removeAttribute('title');
                    }
                }
            }
        }

        this.updateWindowTitle();
    }

    async updateDirtyIndicator() {
        const shouldShowIndicator =
            window.windowRole?.isMainWindow() &&
            this.shouldShowDirtyState(this.currentFont);

        if (this.currentFont?.isCloudBacked()) {
            const assetId = this.currentFont.path.replace(/^cloud:\/\//, '');
            const pendingCount =
                window.cloudPlugin?.getAssetPendingSyncCount?.(assetId) ?? 0;
            this.dirtyIndicator!.title =
                pendingCount > 0
                    ? `Syncing ${pendingCount} change${pendingCount !== 1 ? 's' : ''}…`
                    : 'Cloud font — changes sync continuously';
        } else {
            this.dirtyIndicator!.title = 'File has unsaved changes';
        }

        // Update visual indicator
        if (shouldShowIndicator) {
            this.dirtyIndicator!.classList.add('visible');
        } else {
            this.dirtyIndicator!.classList.remove('visible');
        }

        this.updateWindowTitle();
    }

    async onOpened() {
        await this.updateFontDisplay();
        // Update save button state
        if (window.saveButton) {
            window.saveButton.updateButtonState();
        }
    }

    async onClosed() {
        await this.onOpened();
    }

    private resetStateForNewFont(): void {
        this.openedFonts.clear();
        this.currentFontId = null;
        this.editingFont = null;
        this.glyphOrderCache = null;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.clearEditingCompileContext();
        this.lastCompilationMode = 'full';
        this.lastFullCompiledDataVersion = -1;
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.pendingCommittedKeyboardDriftCheckAfterDrag = false;
        this.forceFullEditingCacheRefresh = false;
        this.workerLayerFingerprintCache.clear();
        this.workerMirrorQuarantined = false;
        window.currentFontModel = null;
        (window.fontInterpolation as any)?.resetRequestTracking?.();

        if (window.glyphCanvas) {
            window.glyphCanvas.resetForOpenedFontReplacement();
        }
    }

    private getParentPath(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx >= 0 ? path.slice(0, idx) : '';
    }

    private async collectGlyphsPackageEntries(
        rootPath: string,
        sourcePlugin: FilesystemPlugin
    ): Promise<Record<string, Uint8Array>> {
        const entries: Record<string, Uint8Array> = {};
        const requiredTopLevelFiles = new Set([
            'fontinfo.plist',
            'order.plist',
            'UIState.plist'
        ]);
        const adapter = sourcePlugin.getAdapter();

        const walk = async (currentPath: string): Promise<void> => {
            const items = await adapter.scanDirectory(currentPath);

            for (const [, data] of Object.entries(items)) {
                const itemPath = data.path;
                if (data.is_dir) {
                    await walk(itemPath);
                    continue;
                }

                const content = await adapter.readFile(itemPath);
                const bytes =
                    typeof content === 'string'
                        ? new TextEncoder().encode(content)
                        : new Uint8Array(content as any);

                const relativePath = itemPath
                    .slice(rootPath.length)
                    .replace(/^\/+/, '');

                const isGlyphFile =
                    relativePath.startsWith('glyphs/') &&
                    relativePath.endsWith('.glyph');
                const isRequiredTopLevel =
                    requiredTopLevelFiles.has(relativePath);

                if (!isGlyphFile && !isRequiredTopLevel) {
                    continue;
                }

                entries[relativePath] = bytes;
            }
        };

        await walk(rootPath);
        return entries;
    }

    private async collectAllDirectoryEntries(
        rootPath: string,
        sourcePlugin: FilesystemPlugin
    ): Promise<Record<string, Uint8Array>> {
        const entries: Record<string, Uint8Array> = {};
        const adapter = sourcePlugin.getAdapter();

        const walk = async (currentPath: string): Promise<void> => {
            const items = await adapter.scanDirectory(currentPath);

            for (const [, data] of Object.entries(items)) {
                const itemPath = data.path;
                if (data.is_dir) {
                    await walk(itemPath);
                    continue;
                }

                const content = await adapter.readFile(itemPath);
                const bytes =
                    typeof content === 'string'
                        ? new TextEncoder().encode(content)
                        : new Uint8Array(content as any);

                const relativePath = itemPath
                    .slice(rootPath.length)
                    .replace(/^\/+/, '');
                entries[relativePath] = bytes;
            }
        };

        await walk(rootPath);
        return entries;
    }

    private async readFromFileHandle(
        fileHandle: FileSystemFileHandle,
        extension: string
    ): Promise<string | Uint8Array> {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (extension === 'babelfont') {
            return new TextDecoder('utf-8').decode(bytes);
        }

        return bytes;
    }

    private async loadBabelfontJsonFromSource(
        font: OpenedFont
    ): Promise<string> {
        const extension = font.path.split('.').pop()?.toLowerCase() || '';
        const isGlyphsPackage =
            extension === 'glyphspackage' || extension === 'glyphpackage';
        const isUfoDirectory = extension === 'ufo';
        const isDesignspace = extension === 'designspace';
        const isDetachedDiskSource =
            font.sourcePlugin.getId() === 'disk' &&
            !font.directoryHandle &&
            !!font.fileHandle;

        let contents: string | Uint8Array | undefined;
        let packageEntries: Record<string, Uint8Array> | undefined;
        let projectEntries: Record<string, Uint8Array> | undefined;

        if (isDetachedDiskSource) {
            if (isGlyphsPackage || isUfoDirectory || isDesignspace) {
                throw new Error(
                    'This source format requires folder context. Attach the containing folder in Disk context and reopen the source from there.'
                );
            }

            contents = await this.readFromFileHandle(
                font.fileHandle!,
                extension
            );
        } else if (isGlyphsPackage) {
            packageEntries = await this.collectGlyphsPackageEntries(
                font.path,
                font.sourcePlugin
            );

            if (
                !packageEntries['fontinfo.plist'] ||
                !packageEntries['order.plist']
            ) {
                throw new Error(
                    'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                );
            }
        } else if (isUfoDirectory) {
            projectEntries = await this.collectAllDirectoryEntries(
                font.path,
                font.sourcePlugin
            );
        } else if (isDesignspace) {
            const projectRoot = this.getParentPath(font.path);
            projectEntries = await this.collectAllDirectoryEntries(
                projectRoot,
                font.sourcePlugin
            );
        } else {
            contents = await font.sourcePlugin.getAdapter().readFile(font.path);
            if (extension === 'babelfont' && contents instanceof Uint8Array) {
                contents = new TextDecoder('utf-8').decode(contents);
            }
        }

        if (extension === 'babelfont') {
            return contents as string;
        }

        return await requestOpenFontConversion({
            filename: font.path.split('/').pop() || font.path,
            contents,
            packageEntries,
            projectEntries
        });
    }

    private captureGlyphCanvasState(): CapturedGlyphCanvasState | null {
        const glyphCanvas = window.glyphCanvas as any;
        if (!glyphCanvas || !glyphCanvas.textRunEditor) {
            return null;
        }

        return {
            wasEditMode: !!glyphCanvas.outlineEditor?.active,
            selectedGlyphIndex:
                typeof glyphCanvas.textRunEditor.selectedGlyphIndex === 'number'
                    ? glyphCanvas.textRunEditor.selectedGlyphIndex
                    : -1,
            selectedLayerId: glyphCanvas.outlineEditor?.selectedLayerId || null,
            cursorPosition:
                typeof glyphCanvas.textRunEditor.cursorPosition === 'number'
                    ? glyphCanvas.textRunEditor.cursorPosition
                    : 0,
            textBuffer: glyphCanvas.textRunEditor.textBuffer || '',
            variationSettings: glyphCanvas.axesManager?.variationSettings
                ? { ...glyphCanvas.axesManager.variationSettings }
                : null,
            viewport: glyphCanvas.viewportManager
                ? {
                      scale: glyphCanvas.viewportManager.scale,
                      panX: glyphCanvas.viewportManager.panX,
                      panY: glyphCanvas.viewportManager.panY
                  }
                : null
        };
    }

    private async restoreGlyphCanvasState(
        state: CapturedGlyphCanvasState
    ): Promise<void> {
        const glyphCanvas = window.glyphCanvas as any;
        if (!glyphCanvas || !glyphCanvas.textRunEditor) {
            return;
        }

        if (state.variationSettings && glyphCanvas.axesManager) {
            glyphCanvas.axesManager.variationSettings = {
                ...state.variationSettings
            };
        }

        glyphCanvas.textRunEditor.textBuffer = state.textBuffer || '';
        glyphCanvas.textRunEditor.shapeText();

        const maxCursorPosition = glyphCanvas.textRunEditor.textBuffer.length;
        glyphCanvas.textRunEditor.cursorPosition = Math.max(
            0,
            Math.min(state.cursorPosition, maxCursorPosition)
        );
        glyphCanvas.textRunEditor.updateCursorVisualPosition();

        if (state.wasEditMode && state.selectedGlyphIndex >= 0) {
            await glyphCanvas.textRunEditor.selectGlyphByIndex(
                state.selectedGlyphIndex
            );

            if (state.selectedLayerId) {
                glyphCanvas.outlineEditor.selectedLayerId =
                    state.selectedLayerId;
            }
        } else if (glyphCanvas.outlineEditor?.active) {
            glyphCanvas.exitGlyphEditMode();
        }

        if (state.viewport && glyphCanvas.viewportManager) {
            glyphCanvas.viewportManager.scale = state.viewport.scale;
            glyphCanvas.viewportManager.panX = state.viewport.panX;
            glyphCanvas.viewportManager.panY = state.viewport.panY;
        }

        glyphCanvas.render();
    }

    async reloadCurrentFontFromSource(
        options: ReloadCurrentFontOptions = {}
    ): Promise<boolean> {
        if (!this.currentFont || !this.currentFontId) {
            return false;
        }

        if (this.isExternalReloading) {
            return false;
        }

        const preserveUiState = options.preserveUiState !== false;
        const capturedUiState = preserveUiState
            ? this.captureGlyphCanvasState()
            : null;

        const previousFontId = this.currentFontId;
        const previousOpenedFont = this.currentFont;
        const previousEditingFont = this.editingFont;
        const previousGlyphOrderCache = this.glyphOrderCache;
        const previousClosureCache = this.closureCache;
        const bridge = window.patchSyncEngine;
        const bridgeStateVector = bridge?.encodeBridgeStateVector();

        this.isExternalReloading = true;
        beginLoadingCursor();

        try {
            const babelfontJson =
                await this.loadBabelfontJsonFromSource(previousOpenedFont);
            const canonicalImport = canonicalizeImportedFontJson(babelfontJson);

            this.recordFullFontCrossing();
            let reloadedFont = previousOpenedFont;
            if (bridge && bridgeStateVector) {
                const reloadResult = bridge.applyExternalSourceReload(
                    canonicalImport.fontData,
                    bridgeStateVector
                );
                if (reloadResult.status === 'stale') {
                    return false;
                }

                if (reloadResult.status === 'committed') {
                    await this.awaitWorkerCacheUpdate();
                }
            } else {
                const storeResult = await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: canonicalImport.babelfontJson
                });
                if (storeResult?.error) {
                    throw new Error(
                        `Failed to cache externally reloaded font: ${storeResult.error}`
                    );
                }

                reloadedFont = new OpenedFont(
                    babelfontJson,
                    previousOpenedFont.path,
                    previousOpenedFont.sourcePlugin,
                    previousOpenedFont.fileHandle,
                    previousOpenedFont.directoryHandle
                );
                this.openedFonts.set(previousFontId, reloadedFont);
                this.currentFontId = previousFontId;
            }

            this.editingFont = null;
            this.glyphOrderCache = null;
            this.closureCache = null;
            this.editingSubsetSnapshotGlyphs = [];
            this.editingSubsetSnapshotKey = '';
            this.setEditingCompileContext('external-reload', null);

            const subsetGlyphs =
                window.glyphCanvas?.textRunEditor?.glyphNameBuffer;
            const textBuffer =
                window.glyphCanvas?.textRunEditor?.textBuffer ||
                this.currentText ||
                '';

            await this.compileEditingFont(
                textBuffer,
                this.selectedFeatures,
                subsetGlyphs && subsetGlyphs.length > 0
                    ? subsetGlyphs
                    : undefined
            );

            if (capturedUiState) {
                await this.restoreGlyphCanvasState(capturedUiState);
            }

            await this.updateFontDisplay();
            await this.updateDirtyIndicator();
            if (window.saveButton) {
                window.saveButton.updateButtonState();
            }

            window.dispatchEvent(
                new CustomEvent('fontReady', {
                    detail: { path: reloadedFont.path, reloaded: true }
                })
            );

            return true;
        } catch (error) {
            this.openedFonts.set(previousFontId, previousOpenedFont);
            this.currentFontId = previousFontId;
            this.editingFont = previousEditingFont;
            this.glyphOrderCache = previousGlyphOrderCache;
            this.closureCache = previousClosureCache;
            throw error;
        } finally {
            this.isExternalReloading = false;
            endLoadingCursor();
        }
    }

    /**
     * Initialize the font manager when a font is loaded.
     *
     * @param {string} babelfontJson - The .babelfont JSON string
     * @param {string} path - File path
     * @param {FilesystemPlugin} sourcePlugin - The filesystem plugin used to load this font
     * @param {FileSystemFileHandle} fileHandle - Optional file handle (for disk plugin)
     * @param {FileSystemDirectoryHandle} directoryHandle - Optional directory handle (for disk plugin)
     */
    async loadFont(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        this.resetStateForNewFont();

        const canonicalizeSpanId = timelineSpanStart(
            'font.loadFont.canonicalize'
        );
        let newFont = new OpenedFont(
            babelfontJson,
            path,
            sourcePlugin,
            fileHandle,
            directoryHandle
        );
        timelineSpanEnd(canonicalizeSpanId);
        let newid = `font-${Date.now()}`;
        this.openedFonts.set(newid, newFont);
        this.currentFontId = newid;
        window.currentFontModel = newFont.fontModel;

        this.editingFont = null;
        this.glyphOrderCache = null; // Clear cache for new font
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';

        // Reset initialFontLoaded flag in glyphCanvas when new font is loaded
        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }

        this.updateWindowTitle();

        // Notify the patch sync engine bootstrap pipeline that the font model is ready
        window.dispatchEvent(
            new CustomEvent('fontModelReady', {
                detail: {
                    path,
                    babelfontData: newFont.babelfontData
                }
            })
        );
    }

    /**
     * Generate a minimal empty babelfont JSON string.
     * One master with design/export vertical metrics, hollow rectangular
     * .notdef, space glyph, Regular style name, no axes or instances.
     */
    private generateEmptyFontJson(): string {
        // Build a minimal font from scratch.
        // Rust babelfont::Font requires: upm, version, date, names, features, glyphs.
        // Master requires: name, id, location, metrics, kerning.
        // All other fields have #[serde(default)] so they are optional.
        const masterId = crypto.randomUUID();
        const notdefLayerId = crypto.randomUUID();
        const spaceLayerId = crypto.randomUUID();
        // Standard UPM-1000 vertical metrics so guides, overview framing,
        // and binary export have usable values from the first open.
        const metrics = {
            Ascender: 800,
            Descender: -200,
            CapHeight: 700,
            XHeight: 500,
            TypoAscender: 800,
            TypoDescender: -200,
            TypoLineGap: 0,
            HheaAscender: 800,
            HheaDescender: -200,
            HheaLineGap: 0,
            WinAscent: 800,
            WinDescent: 200
        };
        // Classic hollow .notdef: outer rectangle + counter, width 600.
        const notdefWidth = 600;
        const notdefShapes = [
            {
                closed: true,
                nodes: [
                    { x: 80, y: 0, nodetype: 'Line' },
                    { x: 520, y: 0, nodetype: 'Line' },
                    { x: 520, y: 700, nodetype: 'Line' },
                    { x: 80, y: 700, nodetype: 'Line' }
                ]
            },
            {
                closed: true,
                nodes: [
                    { x: 140, y: 60, nodetype: 'Line' },
                    { x: 140, y: 640, nodetype: 'Line' },
                    { x: 460, y: 640, nodetype: 'Line' },
                    { x: 460, y: 60, nodetype: 'Line' }
                ]
            }
        ];
        const fontData: any = {
            upm: 1000,
            version: [1, 0],
            date: new Date().toISOString(),
            names: {
                family_name: { dflt: 'Untitled' },
                preferred_subfamily_name: { dflt: 'Regular' },
                full_name: { dflt: 'Untitled Regular' }
            },
            features: {
                classes: {},
                prefixes: {},
                features: []
            },
            // No axes — a static font with no axes and one master means the
            // glyph rendering path uses the single master directly instead
            // of trying to interpolate between nonexistent masters.
            masters: [
                {
                    id: masterId,
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics,
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: '.notdef',
                    category: 'Unknown',
                    exported: true,
                    layers: [
                        {
                            id: notdefLayerId,
                            width: notdefWidth,
                            master: {
                                type: 'DefaultForMaster',
                                master: masterId
                            },
                            shapes: notdefShapes
                        }
                    ]
                },
                {
                    name: 'space',
                    category: 'Base',
                    codepoints: [32],
                    exported: true,
                    layers: [
                        {
                            id: spaceLayerId,
                            width: 250,
                            master: {
                                type: 'DefaultForMaster',
                                master: masterId
                            },
                            shapes: []
                        }
                    ]
                }
            ]
        };
        return JSON.stringify(fontData);
    }

    private _newFontInProgress = false;

    /**
     * Handle the "New" file action.
     *
     * 1. Prompts to save/discard/cancel if the current font has unsynced changes.
     * 2. Generates a minimal empty font and dispatches `fontLoaded`.
     *
     * Uses the same `fontLoaded` event the file browser dispatches when a user
     * opens a font file, so the existing open-font pipeline handles all state
     * reset, worker caching, compilation, canvas setup, and event dispatch.
     *
     * Uses a concurrency guard to prevent stacked invocations (e.g. rapid
     * clicks on the menu item while a dialog is still open).
     */
    async handleNewFont(): Promise<void> {
        console.log('[FontManager] handleNewFont ENTER', {
            newFontInProgress: this._newFontInProgress
        });
        if (this._newFontInProgress) return;
        this._newFontInProgress = true;
        try {
            const currentFont = this.currentFont;
            console.log('[FontManager] handleNewFont', {
                hasCurrentFont: !!currentFont
            });

            // Prompt if there are unsynced changes (works for cloud and non-cloud)
            if (currentFont && this.hasUnsyncedChanges(currentFont)) {
                console.log('[FontManager] handleNewFont: showing dialog');
                const fontName = currentFont.name || 'Untitled';
                const choice = await showUnsavedChangesDialog(fontName);
                console.log(
                    '[FontManager] handleNewFont: dialog choice',
                    choice
                );
                if (choice === 'cancel') return;
                if (choice === 'save') {
                    if (
                        !currentFont.fileHandle &&
                        !currentFont.isCloudBacked()
                    ) {
                        await window.showFontFileDialog?.({
                            mode: 'save-as'
                        });
                    } else {
                        await window.saveButton?.handleSave?.();
                    }
                }
            }

            console.log('[FontManager] handleNewFont: clearing caches');
            try {
                await fontCompilation.sendMessage({ type: 'clearCache' });
                console.log('[FontManager] handleNewFont: clearCache done');
            } catch (e) {
                console.warn(
                    '[FontManager] handleNewFont: clearCache failed',
                    e
                );
            }

            // Reset all JS-side caches
            if (window.windowSync) {
                window.windowSync.destroy();
                window.windowSync = undefined;
            }
            if (window.patchSyncEngine) {
                window.patchSyncEngine.destroy();
                window.patchSyncEngine = undefined;
                window.changeBridge = undefined;
            }
            this.currentText = '';
            try {
                localStorage.removeItem('glyphCanvasTextBuffer');
            } catch {
                // localStorage may not be available
            }

            // Clear stale URL params
            if (window.history?.replaceState) {
                const url = new URL(window.location.href);
                url.searchParams.delete('text');
                url.searchParams.delete('cursor');
                url.searchParams.delete('mode');
                url.searchParams.delete('location');
                url.searchParams.delete('features');
                url.searchParams.delete('glyph_stack');
                url.searchParams.delete('isInterpolating');
                url.searchParams.delete('isAnimating');
                window.history.replaceState(null, '', formatUrl(url));
            }

            // Reset the state manager's cached location so the startup
            // state restore doesn't re-apply the previous font's axis
            // values to the new empty font (which has no axes).
            if (window.stateManager) {
                window.stateManager.editor_variation_location = {};
            }

            // Use disk plugin (no file handle → Save redirects to Save As)
            const plugin =
                window.pluginRegistry?.get('disk') ??
                window.pluginRegistry?.get('memory');

            // Dispatch fontLoaded — the existing open-font pipeline handles
            // compilation singletons, loadFont, fontModelReady, bridge init,
            // worker Yjs seed, compile editing font, etc.
            const emptyFontJson = this.generateEmptyFontJson();

            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: 'untitled.babelfont',
                        babelfontJson: emptyFontJson,
                        sourcePlugin: plugin
                    }
                })
            );
        } finally {
            this._newFontInProgress = false;
        }
    }

    /**
     * Get glyph names for the given text using the editing font
     *
     * @param {string} text - Text to get glyph names for
     * @returns {Promise<Array<string>>} - Array of glyph names
     */
    async getGlyphNamesForText(text: string): Promise<string[]> {
        if (!this.editingFont) {
            throw new Error('Editing font not compiled yet');
        }

        return await window.shapeTextWithFont(this.editingFont, text);
    }

    private createSubsetKey(glyphNames: string[]): string {
        return [...new Set(glyphNames)].sort().join('\u0000');
    }

    private normalizeSubsetGlyphs(glyphNames: string[]): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();
        for (const glyphName of glyphNames) {
            if (
                typeof glyphName !== 'string' ||
                !glyphName.length ||
                seen.has(glyphName)
            ) {
                continue;
            }
            normalized.push(glyphName);
            seen.add(glyphName);
        }
        return normalized;
    }

    updateEditingSubsetSnapshot(subsetGlyphs: string[]): boolean {
        const normalized = this.normalizeSubsetGlyphs(subsetGlyphs || []);
        const subsetKey = this.createSubsetKey(normalized);
        if (subsetKey === this.editingSubsetSnapshotKey) {
            return false;
        }

        this.editingSubsetSnapshotGlyphs = normalized;
        this.editingSubsetSnapshotKey = subsetKey;
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(
                new CustomEvent('editingSubsetChanged', {
                    detail: { glyphs: normalized }
                })
            );
        }
        return true;
    }

    getEditingSubsetSnapshot(): string[] {
        return [...this.editingSubsetSnapshotGlyphs];
    }

    resolveEditingTextForCompile(explicitText: string = ''): string {
        if (explicitText) {
            return explicitText;
        }

        // The one-shot startup compile runs before URL/state restore applies
        // `?text=` to the live buffer. Prefer that URL/state text over the
        // constructor default ("Hamburgevons") so glyphs like adieresis are
        // in the first editing subset.
        if (!isStartupStateReady()) {
            const urlText = readUrlState().text;
            if (urlText) {
                return urlText;
            }
            const stateText = window.stateManager?.editor_text_buffer;
            if (stateText) {
                return stateText;
            }
        }

        return (
            window.glyphCanvas?.textRunEditor?.textBuffer ||
            this.currentText ||
            localStorage.getItem('glyphCanvasTextBuffer') ||
            'Hamburgevons'
        );
    }

    resolveEditingFeaturesForCompile(
        explicitFeatures: string[] = []
    ): string[] {
        if (explicitFeatures.length > 0) {
            return explicitFeatures;
        }

        // Startup compile runs before URL restore applies `?features=` to
        // FeaturesManager. Use the URL/state tags so layout closure and the
        // first shaping pass include those discretionary features.
        if (!isStartupStateReady()) {
            const urlFeatures = readUrlState().features;
            if (urlFeatures) {
                const decoded = decodeFeatures(urlFeatures);
                if (decoded && decoded.length > 0) {
                    return decoded;
                }
            }
            const stateFeatures = Object.entries(
                window.stateManager?.editor_opentype_features_in_subset || {}
            )
                .filter(([, enabled]) => enabled)
                .map(([tag]) => tag);
            if (stateFeatures.length > 0) {
                return stateFeatures;
            }
        }

        return explicitFeatures;
    }

    getLiveVisibleGlyphNames(): string[] {
        const glyphNameBuffer =
            window.glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
        const activeGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            null;

        return this.normalizeSubsetGlyphs([
            ...this.getEditingSubsetSnapshot(),
            ...glyphNameBuffer,
            ...(activeGlyphName ? [activeGlyphName] : [])
        ]);
    }

    getHydratedGlyphNames(): string[] {
        const glyphs = this.currentFont?.fontModel?.glyphs;
        if (!Array.isArray(glyphs)) {
            return [];
        }
        return this.normalizeSubsetGlyphs(
            glyphs
                .map((glyph) => glyph?.name)
                .filter((name): name is string => !!name)
        );
    }

    isHydrationSparse(): boolean {
        const hydratedCount = this.getHydratedGlyphNames().length;
        if (!hydratedCount) {
            return false;
        }
        const fontJson = this.currentFont?.babelfontData as
            Record<string, unknown> | undefined;
        const catalogObject =
            fontJson?.glyphCatalog &&
            typeof fontJson.glyphCatalog === 'object' &&
            !Array.isArray(fontJson.glyphCatalog)
                ? (fontJson.glyphCatalog as Record<string, unknown>)
                : null;
        const catalogCount = catalogObject
            ? Object.keys(catalogObject).length
            : 0;
        const tokenCount =
            window.patchSyncEngine?.listGlyphRevisionTokens?.()?.length ?? 0;
        const yGlyphOrder =
            window.patchSyncEngine?.fontMap?.get?.('glyphOrder');
        const coreOrderCount = Array.isArray(yGlyphOrder)
            ? yGlyphOrder.length
            : yGlyphOrder &&
                typeof (yGlyphOrder as { toArray?: () => unknown[] })
                    .toArray === 'function'
              ? (yGlyphOrder as { toArray: () => unknown[] }).toArray().length
              : 0;
        const universe = Math.max(catalogCount, tokenCount, coreOrderCount);
        return universe > hydratedCount;
    }

    constrainSubsetToHydratedGlyphs(glyphNames: string[]): string[] {
        const hydrated = new Set(this.getHydratedGlyphNames());
        if (!hydrated.size) {
            return this.normalizeSubsetGlyphs(glyphNames);
        }

        const fontModel = this.currentFont?.fontModel;
        const included = new Set(
            this.normalizeSubsetGlyphs(glyphNames).filter((name) =>
                hydrated.has(name)
            )
        );
        const queue = [...included];
        while (queue.length) {
            const current = queue.pop();
            if (!current) {
                continue;
            }
            const glyph = fontModel?.findGlyph?.(current);
            const layers = Array.isArray(glyph?.layers) ? glyph.layers : [];
            for (const layer of layers) {
                const shapes = Array.isArray(layer?.shapes) ? layer.shapes : [];
                for (const shape of shapes) {
                    const reference = (
                        shape as unknown as {
                            data?: { reference?: unknown };
                        }
                    ).data?.reference;
                    if (
                        typeof reference === 'string' &&
                        hydrated.has(reference) &&
                        !included.has(reference)
                    ) {
                        included.add(reference);
                        queue.push(reference);
                    }
                }
            }
        }

        if (included.size > 0) {
            return [...included];
        }
        if (hydrated.has('.notdef')) {
            return ['.notdef'];
        }
        const firstHydrated = [...hydrated][0];
        return firstHydrated ? [firstHydrated] : [];
    }

    getConstrainedEditingSubsetGlyphs(): string[] {
        return this.constrainSubsetToHydratedGlyphs([
            ...this.getEditingSubsetSnapshot(),
            ...this.getLiveVisibleGlyphNames(),
            ...this.deriveSubsetGlyphsFromText(
                this.resolveEditingTextForCompile()
            )
        ]);
    }

    getAutomaticCompositionDragScopeGlyphNames(
        sourceGlyphName: string,
        fontModel:
            | Pick<Font, 'collectComponentDependentGlyphs'>
            | null
            | undefined = this.currentFont?.fontModel
    ): Set<string> {
        const scopedGlyphNames = new Set<string>();
        if (!sourceGlyphName || !fontModel) {
            return scopedGlyphNames;
        }

        const visibleGlyphNames = new Set(this.getLiveVisibleGlyphNames());
        visibleGlyphNames.add(sourceGlyphName);
        return fontModel.collectComponentDependentGlyphs([sourceGlyphName], {
            includeSourceGlyphNames: true,
            retainGlyphNames: visibleGlyphNames
        });
    }

    syncSerializedLayerIntoObjectModel(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ): Babelfont.Layer | null {
        const currentFont = this.currentFont;
        const modelLayer = currentFont?.fontModel
            ?.findGlyph(glyphName)
            ?.findLayerById(layerId);

        if (!modelLayer) {
            return null;
        }

        if (typeof modelLayer.syncFromEditorLayerData === 'function') {
            withSuppressedModelRecording(() => {
                modelLayer.syncFromEditorLayerData({
                    width: layerData.width,
                    ...(layerData.height !== undefined
                        ? { height: layerData.height }
                        : {}),
                    ...(layerData.vertWidth !== undefined
                        ? { vertWidth: layerData.vertWidth }
                        : {}),
                    ...(layerData.shapes !== undefined
                        ? { shapes: layerData.shapes }
                        : {}),
                    ...(layerData.anchors !== undefined
                        ? { anchors: layerData.anchors }
                        : {}),
                    ...(layerData.guides !== undefined
                        ? { guides: layerData.guides }
                        : {}),
                    ...(layerData.format_specific !== undefined
                        ? { format_specific: layerData.format_specific }
                        : {})
                });
            });

            const syncedLayerData = modelLayer.toJSON() as Babelfont.Layer &
                Record<string, unknown>;
            Object.assign(syncedLayerData, {
                ...(layerData.name !== undefined
                    ? { name: layerData.name }
                    : {}),
                ...(layerData.location !== undefined
                    ? { location: layerData.location }
                    : {}),
                ...(layerData.color !== undefined
                    ? { color: layerData.color }
                    : {}),
                ...(layerData.background_layer_id !== undefined
                    ? {
                          background_layer_id: layerData.background_layer_id
                      }
                    : {}),
                ...(layerData.layer_index !== undefined
                    ? { layer_index: layerData.layer_index }
                    : {}),
                ...(layerData.is_background !== undefined
                    ? { is_background: layerData.is_background }
                    : {}),
                ...(layerData.master !== undefined
                    ? { master: layerData.master }
                    : {}),
                id: layerId
            });

            modelLayer.invalidateContentCaches();
            return syncedLayerData;
        }

        const rawLayerData = modelLayer.toJSON() as Babelfont.Layer &
            Record<string, unknown>;
        Object.assign(rawLayerData, layerData);

        modelLayer.invalidateContentCaches();

        return rawLayerData;
    }

    private syncSerializedLayerIntoStoredFontData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ): Babelfont.Layer | null {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return null;
        }

        const storedLayer = glyph.layers.find((layer) => layer.id === layerId);
        if (!storedLayer) {
            return null;
        }

        const mutableStoredLayer = storedLayer as unknown as Record<
            string,
            unknown
        >;

        for (const key of Object.keys(storedLayer)) {
            if (!Object.prototype.hasOwnProperty.call(layerData, key)) {
                delete mutableStoredLayer[key];
            }
        }

        Object.assign(storedLayer, layerData);
        return storedLayer;
    }

    private normalizeComponentTransformForRust(
        transform: unknown
    ): Babelfont.DecomposedAffine {
        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        const identity = DecomposedAffineTransform.identity();
        if (!transform || typeof transform !== 'object') {
            return identity;
        }

        const record = transform as Record<string, unknown>;
        const translation = Array.isArray(record.translation)
            ? [
                  Number(record.translation[0]) || 0,
                  Number(record.translation[1]) || 0
              ]
            : [0, 0];
        const scale = Array.isArray(record.scale)
            ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
            : [1, 1];
        const rawSkew = Array.isArray(record.skew)
            ? record.skew
            : [record.skew ?? 0, 0];
        const skew = [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0] as [
            number,
            number
        ];
        const rotation = Number(record.rotation) || 0;
        const order =
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? (record.order as Babelfont.TransformOrder)
                : identity.order;

        return {
            translation: translation as [number, number],
            scale: scale as [number, number],
            rotation,
            skew,
            order
        };
    }

    private normalizeShapeForRust(shape: any): any {
        if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
            return shape;
        }

        const hasPathWrapper =
            'Path' in shape && shape.Path && typeof shape.Path === 'object';
        const hasComponentWrapper =
            'Component' in shape &&
            shape.Component &&
            typeof shape.Component === 'object';
        const hasFlatPathFields = 'nodes' in shape;
        const hasFlatComponentFields = 'reference' in shape;

        if ((hasPathWrapper || hasFlatPathFields) && hasFlatComponentFields) {
            console.warn(
                '[FontManager] Normalizing invalid hybrid shape to path payload during Rust normalization',
                shape
            );
        }

        const pathCandidate = hasPathWrapper ? shape.Path : shape;

        if ('nodes' in pathCandidate) {
            if (!Array.isArray(pathCandidate.nodes)) {
                throw new TypeError(
                    'Path shape nodes must be an array before Rust normalization.'
                );
            }

            return {
                ...(pathCandidate.id && { id: pathCandidate.id }),
                nodes: pathCandidate.nodes,
                closed: pathCandidate.closed,
                ...(pathCandidate.format_specific && {
                    format_specific: pathCandidate.format_specific
                })
            };
        }

        const componentCandidate = hasComponentWrapper
            ? shape.Component
            : shape;

        if ('reference' in componentCandidate && !hasFlatPathFields) {
            const normalizedLocation = this.normalizeLocationForRust(
                componentCandidate.location
            );
            return {
                ...(componentCandidate.id && { id: componentCandidate.id }),
                reference: componentCandidate.reference,
                transform: this.normalizeComponentTransformForRust(
                    componentCandidate.transform
                ),
                ...(normalizedLocation && {
                    location: normalizedLocation
                }),
                ...(componentCandidate.format_specific && {
                    format_specific: componentCandidate.format_specific
                })
            };
        }

        return { ...shape };
    }

    private normalizeOptionalFiniteNumber(value: any): number | undefined {
        return typeof value === 'number' && Number.isFinite(value)
            ? value
            : undefined;
    }

    private normalizeLocationForRust(
        location: any
    ): Record<string, number> | undefined {
        if (
            !location ||
            typeof location !== 'object' ||
            Array.isArray(location)
        ) {
            return undefined;
        }

        const normalizedEntries = Object.entries(location).filter(
            ([, value]) => typeof value === 'number' && Number.isFinite(value)
        ) as Array<[string, number]>;

        return normalizedEntries.length
            ? Object.fromEntries(normalizedEntries)
            : undefined;
    }

    private normalizeLayerForRust(layerData: any): any {
        if (!layerData || typeof layerData !== 'object') {
            return layerData;
        }

        assertFiniteLayerWidth(layerData.width, {
            layerId:
                typeof layerData.id === 'string' ? layerData.id : undefined,
            operation: 'normalizeLayerForRust'
        });

        const shapes = Array.isArray(layerData.shapes)
            ? layerData.shapes.map((shape: any) =>
                  this.normalizeShapeForRust(shape)
              )
            : [];

        const normalizedLayer = {
            ...layerData,
            shapes,
            ...(Array.isArray(layerData.anchors)
                ? {
                      anchors: layerData.anchors.map((anchor: any) => ({
                          ...(typeof anchor?.id === 'string'
                              ? { id: anchor.id }
                              : {}),
                          name: anchor?.name,
                          x: anchor?.x,
                          y: anchor?.y,
                          ...(anchor?.format_specific !== undefined
                              ? { format_specific: anchor.format_specific }
                              : {})
                      }))
                  }
                : {}),
            ...(Array.isArray(layerData.guides)
                ? {
                      guides: layerData.guides.map((guide: any) => ({
                          ...(typeof guide?.id === 'string'
                              ? { id: guide.id }
                              : {}),
                          pos: {
                              x: guide?.pos?.x,
                              y: guide?.pos?.y,
                              ...(this.normalizeOptionalFiniteNumber(
                                  guide?.pos?.angle
                              ) !== undefined
                                  ? { angle: guide.pos.angle }
                                  : {})
                          },
                          name: guide?.name,
                          ...(guide?.color && { color: guide.color }),
                          ...(guide?.format_specific !== undefined
                              ? { format_specific: guide.format_specific }
                              : {})
                      }))
                  }
                : {})
        };

        const normalizedHeight = this.normalizeOptionalFiniteNumber(
            layerData.height
        );
        if (normalizedHeight === undefined) {
            delete normalizedLayer.height;
        } else {
            normalizedLayer.height = normalizedHeight;
        }

        const normalizedVertWidth = this.normalizeOptionalFiniteNumber(
            layerData.vertWidth
        );
        if (normalizedVertWidth === undefined) {
            delete normalizedLayer.vertWidth;
        } else {
            normalizedLayer.vertWidth = normalizedVertWidth;
        }

        const normalizedLocation = this.normalizeLocationForRust(
            layerData.location
        );
        if (normalizedLocation) {
            normalizedLayer.location = normalizedLocation;
        } else {
            delete normalizedLayer.location;
        }

        return normalizedLayer;
    }

    /**
     * Compile the editing font for display in canvas.
     * Subset to the provided glyph names for faster compilation.
     *
     * @param {string} text - Text being edited (stored for recompilation)
     * @param {Array<string>} features - Selected OpenType features (stored for recompilation)
     * @param {Array<string>} subsetGlyphs - Glyph names to include in the subset
     */
    async compileEditingFont(
        text: string = '',
        features: string[] = [],
        subsetGlyphs?: string[]
    ) {
        if (!this.currentFont) {
            throw new Error('No font loaded');
        }

        if (!fontCompilation || !fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        // Store current text and features for future use
        const resolvedText = this.resolveEditingTextForCompile(text);
        this.currentText = resolvedText;
        const resolvedFeatures =
            this.resolveEditingFeaturesForCompile(features);
        this.selectedFeatures = resolvedFeatures;

        let responseRevisionKey = String(
            this.currentFont.compileRequestVersion
        );
        let requestedRevisionKey = responseRevisionKey;
        let compileContextAtRequest =
            this.getEditingCompileContextForRequest(requestedRevisionKey);
        let incrementalChangeSource = compileContextAtRequest.changeSource;
        let editTypeAtRequest: typeof this.lastEditType =
            compileContextAtRequest.editType;
        let dataFreshnessModeAtRequest =
            compileContextAtRequest.dataFreshnessMode;

        const hasExplicitWorkerFreshnessAtRequest = () =>
            dataFreshnessModeAtRequest === 'authoritative-worker-yjs' ||
            dataFreshnessModeAtRequest === 'live-drag-worker-preview';
        let compileSource = incrementalChangeSource || 'unknown';
        let isIncrementalEditingCompile =
            compileSource.startsWith('mouse-drag') ||
            compileSource.startsWith('keyboard') ||
            compileSource.startsWith('remote-') ||
            compileSource === 'master-reinterpolate-batch';
        let isMouseDragSource = compileSource.startsWith('mouse-drag');
        let isKeyboardSource = compileSource.startsWith('keyboard');
        let isRemoteSource = compileSource.startsWith('remote-');
        let isMasterReinterpolateBatchSource =
            compileSource === 'master-reinterpolate-batch';
        const forceFullWorkerCompileAtStart = this.forceFullEditingCacheRefresh;
        const shouldPrepareIncrementalLayerUpdate =
            (isMouseDragSource || isKeyboardSource) &&
            !forceFullWorkerCompileAtStart;
        const activeDirtyGlyphName = shouldPrepareIncrementalLayerUpdate
            ? window.glyphCanvas?.outlineEditor?.currentGlyphName ||
              window.glyphCanvas?.getCurrentGlyphName?.() ||
              null
            : null;
        const activeDirtyLayerId = shouldPrepareIncrementalLayerUpdate
            ? window.glyphCanvas?.outlineEditor?.selectedLayerId || null
            : null;
        const canUseIncrementalDirtyLayerPatch = (() => {
            if (!activeDirtyGlyphName || !activeDirtyLayerId) {
                return false;
            }

            const dirtyGlyph = this.currentFont.fontModel?.glyphs?.find(
                (glyph: any) => glyph?.name === activeDirtyGlyphName
            );
            if (!dirtyGlyph) {
                return false;
            }

            return dirtyGlyph.layers?.some(
                (layer: any) => layer?.id === activeDirtyLayerId
            );
        })();

        // Capture whether JSON was stale before sync clears the flag,
        // so validateBabelfontJsonForRust knows to run.
        const wasJsonStale = this.pendingBabelfontJsonSyncAfterDrag;

        // Always sync when the JSON is stale (e.g. after undo/redo/remote sync),
        // even during incremental editing compiles, so the Rust compiler never
        // receives stale format artifacts from the model.
        const canKeepStaleJsonDuringActiveMouseDrag =
            wasJsonStale &&
            canUseIncrementalDirtyLayerPatch &&
            isMouseDragSource;
        const canSkipCanonicalJsonSyncForStartupCompile =
            startupOpenSessionActive &&
            (fontCompilation.hasWorkerCacheDocument() ||
                fontCompilation.hasPendingWorkerDocumentSync());
        const canSkipCanonicalJsonSyncForRequest =
            hasExplicitWorkerFreshnessAtRequest() ||
            canKeepStaleJsonDuringActiveMouseDrag ||
            canSkipCanonicalJsonSyncForStartupCompile;

        if (
            (!isIncrementalEditingCompile || wasJsonStale) &&
            !canSkipCanonicalJsonSyncForRequest
        ) {
            try {
                if (!this.syncBabelfontJsonFromCurrentModel()) {
                    throw new Error(
                        'Failed to sync font model before editing compile'
                    );
                }
            } catch (error) {
                this.clearEditingCompileContextIfCurrentRequest(
                    incrementalChangeSource,
                    editTypeAtRequest,
                    requestedRevisionKey
                );
                throw error;
            }
            this.pendingBabelfontJsonSyncAfterDrag = false;
        }

        const startTime = performance.now();
        const compileEditingSpanId = timelineSpanStart('font.compileEditing', {
            textBuffer: text,
            features: resolvedFeatures,
            subsetGlyphs: subsetGlyphs || []
        });

        let consumedStartupCompileSlot = false;

        try {
            // Compute layout closure subset
            let glyphsToInclude = subsetGlyphs;
            if (!glyphsToInclude || glyphsToInclude.length === 0) {
                const fallbackText =
                    this.resolveEditingTextForCompile(resolvedText);
                glyphsToInclude = this.deriveSubsetGlyphsFromText(fallbackText);

                if (!glyphsToInclude.length) {
                    const snapshotSubsetGlyphs =
                        this.getEditingSubsetSnapshot();
                    if (snapshotSubsetGlyphs.length > 0) {
                        glyphsToInclude = snapshotSubsetGlyphs;
                    } else {
                        const fallbackSubsetGlyphs =
                            window.glyphCanvas?.textRunEditor
                                ?.glyphNameBuffer || [];
                        if (fallbackSubsetGlyphs.length > 0) {
                            glyphsToInclude = fallbackSubsetGlyphs;
                        } else {
                            console.log(
                                '[FontManager] Skipping editing font compile without subset glyphs'
                            );
                            this.clearEditingCompileContextIfCurrentRequest(
                                incrementalChangeSource,
                                editTypeAtRequest,
                                requestedRevisionKey
                            );
                            return this.editingFont;
                        }
                    }
                }
            }

            const activeEditedGlyphName =
                window.glyphCanvas?.outlineEditor?.currentGlyphName ||
                window.glyphCanvas?.getCurrentGlyphName?.();
            if (
                activeEditedGlyphName &&
                !glyphsToInclude.includes(activeEditedGlyphName)
            ) {
                glyphsToInclude = [...glyphsToInclude, activeEditedGlyphName];
            }
            glyphsToInclude =
                this.constrainSubsetToHydratedGlyphs(glyphsToInclude);
            this.updateEditingSubsetSnapshot(glyphsToInclude);

            if (startupOpenSessionActive) {
                const incomingSubsetKey = this.createSubsetKey(glyphsToInclude);
                if (
                    startupOpenSessionEditingCompileCount >= 1 &&
                    incomingSubsetKey === startupCompiledSubsetKey
                ) {
                    console.log(
                        '[FontManager] Skipping extra editing compile during font.openSession'
                    );
                    this.clearEditingCompileContextIfCurrentRequest(
                        incrementalChangeSource,
                        editTypeAtRequest,
                        requestedRevisionKey
                    );
                    return this.editingFont;
                }
                startupOpenSessionEditingCompileCount += 1;
                startupCompiledSubsetKey = incomingSubsetKey;
                consumedStartupCompileSlot = true;
            }

            const baseSubsetGlyphs = glyphsToInclude;

            const closureToCompileBridgeSpanId = timelineSpanStart(
                'font.compileEditing.closureToCompileBridge',
                {
                    subsetGlyphCount: glyphsToInclude?.length || 0
                }
            );

            // Compile editing font with layout closure subset
            console.log(
                `🔨 Compiling editing font, subset_glyphs: ${glyphsToInclude ? glyphsToInclude.length + ' glyphs' : 'none (full font)'}`
            );
            let result;
            let isStaleCompileResult = false;
            let dragActiveAtRequest = false;
            let compilationMode:
                | 'full'
                | 'outline-only'
                | 'anchor-only'
                | 'kerning-only'
                | 'text-input' = 'full';
            try {
                timelineMark(
                    'font.compileEditing.closureToCompileBridge.beforeCompileFromJson'
                );

                const normalizeSubsetSpanId = timelineSpanStart(
                    'font.compileEditing.normalizeSubsetForCompile',
                    {
                        subsetGlyphCount: baseSubsetGlyphs?.length || 0
                    }
                );
                const subsetForCompile = baseSubsetGlyphs
                    ? [...baseSubsetGlyphs]
                    : baseSubsetGlyphs;
                timelineSpanEnd(normalizeSubsetSpanId);

                requestedRevisionKey = String(
                    this.currentFont.compileRequestVersion
                );
                compileContextAtRequest =
                    this.getEditingCompileContextForRequest(
                        requestedRevisionKey
                    );
                incrementalChangeSource = compileContextAtRequest.changeSource;
                editTypeAtRequest = compileContextAtRequest.editType;
                dataFreshnessModeAtRequest =
                    compileContextAtRequest.dataFreshnessMode;
                compileSource = incrementalChangeSource || 'unknown';
                isIncrementalEditingCompile =
                    compileSource.startsWith('mouse-drag') ||
                    compileSource.startsWith('keyboard') ||
                    compileSource.startsWith('remote-') ||
                    compileSource === 'master-reinterpolate-batch';
                isMouseDragSource = compileSource.startsWith('mouse-drag');
                isKeyboardSource = compileSource.startsWith('keyboard');
                isRemoteSource = compileSource.startsWith('remote-');
                isMasterReinterpolateBatchSource =
                    compileSource === 'master-reinterpolate-batch';
                dragActiveAtRequest =
                    isMouseDragSource ||
                    !!window.glyphCanvas?.outlineEditor?.draggingSomething;
                const forceFullWorkerCompile = forceFullWorkerCompileAtStart;
                if (forceFullWorkerCompile) {
                    this.forceFullEditingCacheRefresh = false;
                }
                const isInteractiveSource =
                    isMouseDragSource || isKeyboardSource;
                // Determine compilation mode based on edit type
                const isInteractiveEdit =
                    isInteractiveSource &&
                    (dragActiveAtRequest || isKeyboardSource);
                // Remote edits use the same fast-path mode as the
                // original edit (anchor-only / outline-only) so the
                // linked window's editing compile is efficient.
                const isRemoteFastPathEdit =
                    isRemoteSource && editTypeAtRequest !== null;
                const isCommittedLayerBatchFastPathEdit =
                    isMasterReinterpolateBatchSource &&
                    editTypeAtRequest === 'outline';
                const isTextInputEdit =
                    incrementalChangeSource === 'text-input';
                compilationMode = 'full';
                let optionOverrides:
                    | {
                          skip_features?: boolean;
                          skip_kerning?: boolean;
                          skip_outlines?: boolean;
                          produce_varc_table?: boolean;
                      }
                    | undefined;
                const sparseHydration = this.isHydrationSparse();
                if (
                    !forceFullWorkerCompile &&
                    (isInteractiveEdit ||
                        isRemoteFastPathEdit ||
                        isCommittedLayerBatchFastPathEdit) &&
                    editTypeAtRequest === 'outline'
                ) {
                    compilationMode = 'outline-only';
                    optionOverrides = {
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false
                    };
                } else if (
                    !forceFullWorkerCompile &&
                    (isInteractiveEdit || isRemoteFastPathEdit) &&
                    editTypeAtRequest === 'anchor'
                ) {
                    compilationMode = 'anchor-only';
                    optionOverrides = {
                        produce_varc_table: false
                    };
                } else if (
                    !forceFullWorkerCompile &&
                    (isInteractiveEdit || isRemoteFastPathEdit) &&
                    (editTypeAtRequest === 'kerning-value' ||
                        editTypeAtRequest === 'kerning-groups')
                ) {
                    compilationMode = 'kerning-only';
                    optionOverrides = {
                        produce_varc_table: false
                    };
                } else if (isTextInputEdit) {
                    // Text typing: font data unchanged, only subset changed.
                    // Features and kerning must stay ON — Arabic and other
                    // connected scripts rely on them to keep letters joined.
                    // A deferred full compile fires after typing settles.
                    compilationMode = 'text-input';
                    optionOverrides = {
                        produce_varc_table: false
                    };
                }

                if (sparseHydration) {
                    optionOverrides = {
                        ...optionOverrides,
                        skip_features: true,
                        skip_kerning: true
                    };
                }

                // Pre-compilation validation: assert canonical shape/array
                // structure before any compile path that still consumes the
                // local babelfont JSON string. Request-scoped worker freshness
                // means compileEditingCached will compile from the worker Y.Doc
                // instead, including feature-code commits once the worker cache
                // is proven fresh for this request.
                const jsonToSend = this.currentFont.babelfontJson;
                const validatedJson =
                    hasExplicitWorkerFreshnessAtRequest() ||
                    canSkipCanonicalJsonSyncForStartupCompile
                        ? jsonToSend
                        : this.validateBabelfontJsonForRust(
                              jsonToSend,
                              wasJsonStale ||
                                  this.pendingBabelfontJsonSyncAfterDrag
                          );

                result = await fontCompilation.compileEditingFromJsonCached(
                    validatedJson,
                    requestedRevisionKey,
                    subsetForCompile ?? [],
                    {
                        dragActive: dragActiveAtRequest,
                        compileSource: incrementalChangeSource || undefined,
                        selectedFeatures: resolvedFeatures,
                        optionOverrides,
                        usePatchedWorkerCache:
                            dataFreshnessModeAtRequest ===
                                'authoritative-worker-yjs' ||
                            (isIncrementalEditingCompile &&
                                wasJsonStale &&
                                !forceFullWorkerCompile),
                        usePreviewLayerOverlay:
                            dataFreshnessModeAtRequest ===
                            'live-drag-worker-preview'
                    }
                );

                timelineMark(
                    'font.compileEditing.closureToCompileBridge.compileResultReceived'
                );

                const currentRevisionKey = String(
                    this.currentFont.compileRequestVersion
                );
                responseRevisionKey = String(
                    result.fontRevisionKey || requestedRevisionKey
                );
                const isLivePreviewCompile =
                    dataFreshnessModeAtRequest === 'live-drag-worker-preview';
                const previewRevision = Number(responseRevisionKey);
                const mayApplyLivePreview =
                    isLivePreviewCompile &&
                    Number.isFinite(previewRevision) &&
                    previewRevision > this.lastAppliedLivePreviewRevision;
                isStaleCompileResult =
                    responseRevisionKey !== currentRevisionKey &&
                    !mayApplyLivePreview;
                if (isStaleCompileResult) {
                    timelineMark('font.compileEditing.staleResultObserved');
                }

                timelineMark(
                    'font.compileEditing.closureToCompileBridge.afterCompileFromJson'
                );
            } finally {
                timelineSpanEnd(closureToCompileBridgeSpanId);
            }

            if (isStaleCompileResult) {
                console.log(
                    `[FontManager] Ignoring stale editing compile result (response v${responseRevisionKey}, current v${this.currentFont.compileRequestVersion})`
                );
                this.clearEditingCompileRequestContext(responseRevisionKey);
                return this.editingFont;
            }

            const applyCompiledResultSpanId = timelineSpanStart(
                'font.compileEditing.applyCompiledResult',
                { byteLength: result.result.byteLength }
            );
            this.editingFont = adoptTransferredUint8Array(result.result);
            if (
                dataFreshnessModeAtRequest === 'live-drag-worker-preview' &&
                Number.isFinite(Number(responseRevisionKey))
            ) {
                this.lastAppliedLivePreviewRevision =
                    Number(responseRevisionKey);
            }
            timelineSpanEnd(applyCompiledResultSpanId);
            const duration = (performance.now() - startTime).toFixed(2);

            const sourceInfo = incrementalChangeSource
                ? ` [triggered by: ${incrementalChangeSource}]`
                : '';
            console.log(
                `✅ Editing font compiled in ${duration}ms (${this.editingFont.length} bytes)${sourceInfo}`
            );

            // A successful compile resolves both ordinary and sticky edit errors.
            sidebarErrorDisplay.hideError(true);

            // Live drag previews are not commit-safe debug artifacts. Persist
            // only the authoritative Yjs compile that follows the drag.
            const isOutlineDragActive = dragActiveAtRequest;
            const isAuthoritativeCommittedCompile =
                dataFreshnessModeAtRequest === 'authoritative-worker-yjs';

            const debugSaveSpanId = timelineSpanStart(
                'font.compileEditing.debugFontSaveCheck',
                {
                    saveDebugFonts:
                        APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS === true,
                    isOutlineDragActive
                }
            );
            if (isOutlineDragActive && !isAuthoritativeCommittedCompile) {
                this.pendingDebugEditingFontSaveAfterDrag = true;
            } else {
                this.saveEditingFontToFileSystem();
                this.pendingDebugEditingFontSaveAfterDrag = false;
            }
            timelineSpanEnd(debugSaveSpanId);

            // Track compilation mode for axis/layer switch gating
            this.lastCompilationMode = compilationMode;

            // Dispatch event to notify canvas that new font is ready
            timelineMark(
                'font.compileEditing.dispatchEvent.editingFontCompiled'
            );
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: this.editingFont,
                        fontPath: this.currentFont.path,
                        duration: duration,
                        fontRevisionKey: responseRevisionKey,
                        dragActive: dragActiveAtRequest,
                        changeSource: incrementalChangeSource,
                        editType: editTypeAtRequest,
                        dataFreshnessMode: dataFreshnessModeAtRequest,
                        compilationMode
                    }
                })
            );
            timelineMark(
                'font.compileEditing.dispatchEvent.editingFontCompiled.done'
            );
            if (compilationMode === 'full') {
                // Record the data version covered by this full compile so the
                // committed-change funnel can skip redundant incremental
                // compiles whose data was already covered (APP.md Document
                // Collaboration: "any transient compile or edit-source state
                // must be cleaned up again so one edit cannot poison the next
                // one").  Unconditional clear also prevents a late-arriving
                // handleCommittedChangeRefresh from re-arming lastChangeSource
                // after the debounce full compile already cleared it.
                this.lastFullCompiledDataVersion =
                    this.currentFont.changeVersion;
                this.clearEditingCompileRequestContext(responseRevisionKey);
                this.clearEditingCompileContext();
            } else {
                this.clearEditingCompileContextIfCurrentRequest(
                    incrementalChangeSource,
                    editTypeAtRequest,
                    responseRevisionKey
                );
            }

            return this.editingFont;
        } catch (error) {
            this.clearEditingCompileContextIfCurrentRequest(
                incrementalChangeSource,
                editTypeAtRequest,
                requestedRevisionKey
            );
            if (
                consumedStartupCompileSlot &&
                startupOpenSessionEditingCompileCount > 0
            ) {
                startupOpenSessionEditingCompileCount -= 1;
            }
            const errorMsg = (error as Error)?.message || String(error);
            if (
                errorMsg.includes(
                    'Editing compile requires a ready worker Yjs document'
                )
            ) {
                return this.editingFont;
            }
            console.error('❌ Failed to compile editing font:', error);
            window.glyphCanvas?.releaseDeferredPaintAfterFailedCompile?.();
            // Log the problematic JSON area when Rust reports a line/column
            if (
                errorMsg.includes('expected a sequence') ||
                errorMsg.includes('expected a map') ||
                errorMsg.includes('did not match any variant')
            ) {
                const lineMatch = errorMsg.match(/line (\d+)/);
                const colMatch = errorMsg.match(/column (\d+)/);
                if (lineMatch && colMatch) {
                    const lineNum = parseInt(lineMatch[1]);
                    const colNum = parseInt(colMatch[1]);
                    const jsonStr = this.currentFont?.babelfontJson || '';
                    const lines = jsonStr.split('\n');
                    if (lineNum > 0 && lineNum <= lines.length) {
                        const problemLine = lines[lineNum - 1];
                        const start = Math.max(0, colNum - 40);
                        const end = Math.min(problemLine.length, colNum + 40);
                        // Also scan backwards to find the enclosing shape object
                        let shapeStart = lineNum - 1;
                        while (
                            shapeStart > 0 &&
                            !lines[shapeStart - 1].match(/"shapes"/)
                        ) {
                            shapeStart--;
                            if (lineNum - shapeStart > 50) break;
                        }
                        console.error(
                            `[FontManager] Rust parse error context at line ${lineNum}, col ${colNum}:\n` +
                                `  ...${problemLine.substring(start, end)}...\n` +
                                `  Surrounding lines (${shapeStart + 1}-${Math.min(lineNum + 2, lines.length)}):\n` +
                                lines
                                    .slice(
                                        Math.max(shapeStart - 2, 0),
                                        Math.min(lineNum + 2, lines.length)
                                    )
                                    .map(
                                        (l: string, i: number) =>
                                            `  ${shapeStart - 1 + i}: ${l.substring(0, 300)}`
                                    )
                                    .join('\n')
                        );
                    }
                }
            }
            sidebarErrorDisplay.showError(error, 'editing');
            throw error;
        } finally {
            timelineSpanEnd(compileEditingSpanId);
        }
    }

    deriveSubsetGlyphsFromText(text: string): string[] {
        const fontModel = this.currentFont?.fontModel;
        if (!fontModel || !text) {
            return [];
        }

        const subset: string[] = [];
        const seen = new Set<string>();
        const notdefName = fontModel.findGlyph('.notdef')?.name || null;

        const pushGlyph = (name?: string | null) => {
            if (!name || seen.has(name)) {
                return;
            }
            subset.push(name);
            seen.add(name);
        };

        const pushMappedGlyph = (name?: string | null) => {
            // Missing codepoints must still pull .notdef into the editing
            // subset. Otherwise empty/new fonts never compile (fallback text
            // like "Hamburgevons" maps to nothing) and shaping has no font.
            pushGlyph(name || notdefName);
        };

        let index = 0;
        while (index < text.length) {
            const char = text[index];

            if (
                char === '/' &&
                index + 1 < text.length &&
                text[index + 1] === '/'
            ) {
                const slashGlyph = fontModel.findGlyphByCodepoint(
                    '/'.codePointAt(0)!
                );
                pushMappedGlyph(slashGlyph?.name);
                index += 2;
                continue;
            }

            if (char === '/') {
                let cursor = index + 1;
                while (
                    cursor < text.length &&
                    text[cursor] !== '/' &&
                    !/\s/.test(text[cursor])
                ) {
                    cursor++;
                }

                const tokenName = text.slice(index + 1, cursor);
                const terminator = cursor < text.length ? text[cursor] : '';
                const validTerminator =
                    terminator === '/' ||
                    terminator === '' ||
                    /\s/.test(terminator);

                if (tokenName && validTerminator) {
                    const tokenGlyph = fontModel.findGlyph(tokenName);
                    if (tokenGlyph?.name) {
                        pushGlyph(tokenGlyph.name);
                        index = cursor;
                        if (terminator === '/') {
                            index += 1;
                        } else if (terminator && /\s/.test(terminator)) {
                            index += 1;
                        }
                        continue;
                    }
                }
            }

            const codepoint = text.codePointAt(index);
            if (codepoint !== undefined) {
                const glyph = fontModel.findGlyphByCodepoint(codepoint);
                pushMappedGlyph(glyph?.name);
                index += codepoint > 0xffff ? 2 : 1;
            } else {
                index += 1;
            }
        }

        return subset;
    }

    /**
     * Recompile editing font after font data changes
     * Implements continuous fresh-start compilation: if data changes during
     * compilation, marks dirty again so the auto-compile loop will trigger
     * a fresh compilation with the latest data.
     * Returns true if data changed during compilation and needs another compile.
     */
    async recompileEditingFont(): Promise<boolean> {
        if (!this.currentFont) return false;

        // Multi-layer structural edits can enqueue an explicit worker cache
        // refresh before requesting recompilation. Wait for that refresh so the
        // editing-font compile never races against stale Rust cache contents.
        await this.awaitWorkerCacheUpdate();

        // Capture change version at start of compilation
        const startChangeVersion = this.currentFont.changeVersion;
        const startCompileRequestVersion =
            this.currentFont.compileRequestVersion;

        const startCompileContext = this.getEditingCompileContextForRequest(
            String(startCompileRequestVersion)
        );
        const changeSource = startCompileContext.changeSource || 'unknown';
        const isOutlineIncrementalChange =
            changeSource.startsWith('mouse-drag') ||
            changeSource.startsWith('keyboard') ||
            changeSource === 'master-reinterpolate-batch';

        let subsetGlyphs = this.getEditingSubsetSnapshot();

        // A stale narrow snapshot (e.g. a one-glyph forced compile while the
        // text run still shows more glyphs) must not win over the current
        // editing text / visible run. Merge text-derived and live-visible
        // glyphs so dependents like adieresis stay in the editing subset.
        const textBuffer = this.resolveEditingTextForCompile(
            this.currentText || ''
        );
        subsetGlyphs = this.normalizeSubsetGlyphs([
            ...subsetGlyphs,
            ...this.getLiveVisibleGlyphNames()
        ]);
        if (textBuffer.length > 0) {
            subsetGlyphs = this.normalizeSubsetGlyphs([
                ...subsetGlyphs,
                ...this.deriveSubsetGlyphsFromText(textBuffer)
            ]);
        } else if (subsetGlyphs.length === 0) {
            subsetGlyphs = this.normalizeSubsetGlyphs(
                this.deriveSubsetGlyphsFromText('Hamburgevons')
            );
        }

        if (subsetGlyphs.length > 0) {
            subsetGlyphs = this.constrainSubsetToHydratedGlyphs(subsetGlyphs);
            this.updateEditingSubsetSnapshot(subsetGlyphs);
        } else if (!isOutlineIncrementalChange) {
            subsetGlyphs = this.constrainSubsetToHydratedGlyphs(
                window.glyphCanvas?.textRunEditor?.glyphNameBuffer || []
            );
        }

        // Compile with current data
        await this.compileEditingFont(
            this.currentText,
            this.selectedFeatures,
            subsetGlyphs.length > 0 ? subsetGlyphs : undefined
        );

        // After compilation, check if data changed during the compilation
        if (
            this.currentFont.compileRequestVersion !==
            startCompileRequestVersion
        ) {
            // Another compile request arrived while this compile was in flight.
            // Keep the compile flag enabled so the auto-compile loop produces
            // a fresh result, even when the new request did not mutate font data.
            console.log(
                `[FontManager] Compile request changed during compilation (data v${startChangeVersion} → v${this.currentFont.changeVersion}, compile v${startCompileRequestVersion} → v${this.currentFont.compileRequestVersion}), marking for recompile...`
            );
            return true; // Indicates recompilation needed
        } else {
            // No changes occurred during compilation, safe to clear compile flag
            this.currentFont.needsRecompile = false;
            return false; // No recompilation needed
        }
    }

    /**
     * Save compiled fonts to file system for review
     */
    saveFontsToFileSystem() {
        this.saveEditingFontToFileSystem();
    }

    /**
     * Save editing font to file system
     */
    saveEditingFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!this.editingFont) {
            return;
        }

        window.uploadFiles(
            [
                new File(
                    [this.editingFont as Uint8Array<ArrayBuffer>],
                    '_debug_editing_font.ttf',
                    { type: 'font/ttf' }
                )
            ],
            {
                directory: '/user',
                pluginId: 'memory'
            }
        );
    }

    /**
     * Ensure a full editing font (with features/kerning) has been compiled.
     * Call this before axis slider changes or layer switches that depend
     * on correct HarfBuzz positioning.
     * Returns a promise that resolves when the full compile is ready.
     */
    async ensureFullEditingCompile(): Promise<void> {
        if (this.lastCompilationMode === 'full') {
            return; // Already have a full compile
        }
        console.log(
            '[FontManager] Forcing full compile before axis/layer change'
        );
        const compileContext = {
            changeSource: this.lastChangeSource,
            editType: null,
            dataFreshnessMode: null
        };
        this.setEditingCompileContext(
            compileContext.changeSource,
            compileContext.editType
        );
        this.currentFont?.requestRecompileWithoutDataChange({
            compileContext
        });
        window.autoCompileManager.checkAndSchedule();
        // Wait for the compile to finish
        await new Promise<void>((resolve) => {
            const handler = () => {
                window.removeEventListener('editingFontCompiled', handler);
                resolve();
            };
            window.addEventListener('editingFontCompiled', handler);
        });
    }

    /**
     * Validate canonical babelfont JSON before Rust compilation.
     * Rejects wrapped shapes, invalid path node values, and object-for-array drift.
     * Canonical path nodes are arrays and pass through unchanged.
     * Returns the validated JSON string unchanged.
     */
    private validateBabelfontJsonForRust(
        babelfontJson: string,
        forceValidation: boolean = false
    ): string {
        // Only run full validation when needed.
        // `pendingBabelfontJsonSyncAfterDrag` is set after undo/redo/remote-sync
        // to catch Y.Doc roundtrip corruption that toJSONString's replacer misses.
        const needsValidation =
            forceValidation || this.pendingBabelfontJsonSyncAfterDrag;

        // Memoize: validation is a pure function of the input string.
        // During a stream of interactive edits, `currentFont.babelfontJson`
        // is not re-synced from the model (sync is deferred to the
        // debounced full compile), so the same string is otherwise
        // re-validated on every keystroke at ~50 ms a pop. Reference
        // equality is sufficient: a new string means new content; an
        // identical string means identical (already-validated) content.
        const cached = this._validatedBabelfontJsonCache;
        if (cached && cached.input === babelfontJson) {
            return cached.output;
        }

        const cacheAndReturn = (output: string): string => {
            this._validatedBabelfontJsonCache = {
                input: babelfontJson,
                output
            };
            return output;
        };

        if (!needsValidation) {
            return cacheAndReturn(babelfontJson);
        }

        // Parse, fix, re-serialize
        try {
            const data = JSON.parse(babelfontJson);
            let fixCount = 0;
            const knownMasterIds = new Set(
                Array.isArray(data?.masters)
                    ? data.masters
                          .map((master: any) =>
                              master && typeof master === 'object'
                                  ? String(master.id || '')
                                  : ''
                          )
                          .filter(Boolean)
                    : []
            );

            // Fields that must always be arrays in babelfont format
            const arrayFields = new Set([
                'shapes',
                'anchors',
                'guides',
                'layers',
                'glyphs',
                'masters',
                'instances',
                'axes',
                'map',
                'codepoints'
            ]);

            /** Convert a plain object with numeric keys like {"0":..., "1":...} back to an array */
            const numericKeyObjectToArray = (obj: any): any[] => {
                const keys = Object.keys(obj);
                if (keys.length === 0) return [];
                const indices = keys.map((k) => parseInt(k, 10));
                if (
                    !indices.every((i) => !isNaN(i) && i >= 0) ||
                    !keys.every((k) => String(parseInt(k, 10)) === k)
                ) {
                    // Not purely numeric keys — shouldn't convert
                    return [];
                }
                const maxIdx = Math.max(...indices);
                const arr: any[] = new Array(maxIdx + 1);
                for (let i = 0; i < keys.length; i++) {
                    arr[indices[i]] = obj[keys[i]];
                }
                return arr;
            };

            const normalizeLayerMasterValue = (
                masterValue: any,
                isBackground: boolean,
                layerId: string
            ): Record<string, unknown> | null => {
                if (typeof masterValue === 'string' && masterValue.length) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue
                    };
                }

                if (
                    !masterValue ||
                    typeof masterValue !== 'object' ||
                    Array.isArray(masterValue)
                ) {
                    if (!isBackground && knownMasterIds.has(layerId)) {
                        return {
                            type: 'DefaultForMaster',
                            master: layerId
                        };
                    }
                    return null;
                }

                if (masterValue.type === 'FreeFloating') {
                    return { type: 'FreeFloating' };
                }

                if (
                    (masterValue.type === 'DefaultForMaster' ||
                        masterValue.type === 'AssociatedWithMaster') &&
                    typeof masterValue.master === 'string' &&
                    masterValue.master.length
                ) {
                    return {
                        type: masterValue.type,
                        master: masterValue.master
                    };
                }

                if (
                    typeof masterValue.master === 'string' &&
                    masterValue.master.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.master
                    };
                }

                if (
                    typeof masterValue.DefaultForMaster === 'string' &&
                    masterValue.DefaultForMaster.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.DefaultForMaster
                    };
                }

                if (
                    typeof masterValue.default_for_master === 'string' &&
                    masterValue.default_for_master.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.default_for_master
                    };
                }

                if (
                    typeof masterValue.AssociatedWithMaster === 'string' &&
                    masterValue.AssociatedWithMaster.length
                ) {
                    return {
                        type: 'AssociatedWithMaster',
                        master: masterValue.AssociatedWithMaster
                    };
                }

                if (
                    typeof masterValue.associated_with_master === 'string' &&
                    masterValue.associated_with_master.length
                ) {
                    return {
                        type: 'AssociatedWithMaster',
                        master: masterValue.associated_with_master
                    };
                }

                if ('FreeFloating' in masterValue) {
                    return { type: 'FreeFloating' };
                }

                if (!isBackground && knownMasterIds.has(layerId)) {
                    return {
                        type: 'DefaultForMaster',
                        master: layerId
                    };
                }

                return null;
            };

            const canonicalizeGlyphLayerIdentities = (
                glyph: any,
                glyphPath: string
            ): void => {
                if (!glyph || !Array.isArray(glyph.layers)) {
                    return;
                }

                for (const layer of glyph.layers) {
                    if (!layer || typeof layer !== 'object') {
                        continue;
                    }

                    const layerId =
                        typeof layer.id === 'string' ? layer.id : '';
                    const normalizedMaster = normalizeLayerMasterValue(
                        layer.master,
                        layer.is_background === true,
                        layerId
                    );

                    if (normalizedMaster) {
                        const masterChanged =
                            JSON.stringify(layer.master ?? null) !==
                            JSON.stringify(normalizedMaster);
                        if (masterChanged) {
                            layer.master = normalizedMaster;
                            fixCount++;
                        }

                        if (
                            normalizedMaster.type === 'DefaultForMaster' &&
                            typeof normalizedMaster.master === 'string' &&
                            normalizedMaster.master.length
                        ) {
                            const canonicalLayerId = normalizedMaster.master;
                            const conflictingLayer = glyph.layers.find(
                                (candidate: any) =>
                                    candidate !== layer &&
                                    candidate &&
                                    typeof candidate.id === 'string' &&
                                    candidate.id === canonicalLayerId
                            );

                            if (
                                !conflictingLayer &&
                                layer.id !== canonicalLayerId
                            ) {
                                layer.id = canonicalLayerId;
                                fixCount++;
                                console.warn(
                                    `[FontManager] Canonicalized default layer id at ${glyphPath} from ${layerId || '[missing]'} to ${canonicalLayerId}`
                                );
                            }
                        }
                    }
                }
            };

            if (Array.isArray(data?.glyphs)) {
                data.glyphs.forEach((glyph: any, index: number) => {
                    canonicalizeGlyphLayerIdentities(glyph, `glyphs[${index}]`);
                });
            }

            assertBabelfontLayerWidths(data, 'validateBabelfontJsonForRust');

            const fixValue = (val: any, path: string = ''): void => {
                if (!val || typeof val !== 'object') return;

                if (Array.isArray(val)) {
                    // Recurse into array items (e.g. shapes inside a glyphs array)
                    for (let i = 0; i < val.length; i++) {
                        fixValue(val[i], `${path}[${i}]`);
                    }
                    return;
                }

                if ('nodes' in val) {
                    if (!Array.isArray(val.nodes)) {
                        throw new TypeError(
                            `Path shape nodes must be an array before compile validation at ${path || 'root'}.`
                        );
                    }
                    if (!('closed' in val)) {
                        throw new TypeError(
                            `Path shape closed flag must be explicit before compile validation at ${path || 'root'}.`
                        );
                    }
                }

                if ('Path' in val || 'Component' in val) {
                    throw new TypeError(
                        `Wrapped shapes are not allowed before compile validation at ${path || 'root'}.`
                    );
                }

                if ('reference' in val) {
                    if (!('transform' in val)) {
                        throw new TypeError(
                            `Component shapes must carry an explicit transform before compile validation at ${path || 'root'}.`
                        );
                    }
                    if (Array.isArray(val.transform)) {
                        throw new TypeError(
                            `Component transforms must be decomposed objects before compile validation at ${path || 'root'}.`
                        );
                    }
                }

                for (const field of arrayFields) {
                    if (
                        field in val &&
                        val[field] !== null &&
                        typeof val[field] === 'object' &&
                        !Array.isArray(val[field])
                    ) {
                        throw new TypeError(
                            `Field "${field}" must remain an array before compile validation at ${path || 'root'}.`
                        );
                    }
                }
                // Recurse into all object values
                for (const key of Object.keys(val)) {
                    fixValue(val[key], `${path}.${key}`);
                }
            };

            if (data && typeof data === 'object') {
                fixValue(data);
                assertBabelfontLayerWidths(
                    data,
                    'validateBabelfontJsonForRust'
                );

                // Post-fix scan: detect shapes that still don't match
                // Rust's untagged enum (Path or Component)
                const scanShapes = (val: any, path: string = ''): void => {
                    if (!val || typeof val !== 'object') return;
                    if (Array.isArray(val)) {
                        for (let i = 0; i < val.length; i++) {
                            scanShapes(val[i], `${path}[${i}]`);
                        }
                        return;
                    }
                    // If this object is inside a "shapes" array and looks like a shape
                    if (
                        path.includes('.shapes[') ||
                        path.includes('[shapes][')
                    ) {
                        const hasNodes = 'nodes' in val;
                        const hasClosed = 'closed' in val;
                        const hasReference = 'reference' in val;
                        const hasTransform = 'transform' in val;
                        const isPath =
                            hasNodes && Array.isArray(val.nodes) && hasClosed;
                        const isComponent = hasReference;
                        if (!isPath && !isComponent) {
                            console.error(
                                `[FontManager] Malformed shape at ${path}: keys=[${Object.keys(val).join(',')}], ` +
                                    `nodes=${hasNodes ? typeof val.nodes : 'missing'}, ` +
                                    `closed=${hasClosed}, reference=${hasReference}, transform=${hasTransform}`
                            );
                        }
                    }
                    for (const key of Object.keys(val)) {
                        scanShapes(val[key], `${path}.${key}`);
                    }
                };
                // Scan glyphs[].layers[].shapes[] for malformed shapes
                if (Array.isArray(data.glyphs)) {
                    for (let gi = 0; gi < data.glyphs.length; gi++) {
                        const glyph = data.glyphs[gi];
                        if (glyph?.layers && Array.isArray(glyph.layers)) {
                            for (let li = 0; li < glyph.layers.length; li++) {
                                const layer = glyph.layers[li];
                                if (
                                    layer?.shapes &&
                                    Array.isArray(layer.shapes)
                                ) {
                                    for (
                                        let si = 0;
                                        si < layer.shapes.length;
                                        si++
                                    ) {
                                        const shape = layer.shapes[si];
                                        const hasNodes =
                                            shape && 'nodes' in shape;
                                        const hasClosed =
                                            shape && 'closed' in shape;
                                        const hasReference =
                                            shape && 'reference' in shape;
                                        const hasTransform =
                                            shape && 'transform' in shape;
                                        const isPath =
                                            hasNodes &&
                                            Array.isArray(shape.nodes) &&
                                            hasClosed;
                                        const isComponent = hasReference;
                                        if (!isPath && !isComponent) {
                                            console.error(
                                                `[FontManager] Malformed shape: glyph=${glyph.name}, layer=${layer.id}, shape[${si}]: ` +
                                                    `keys=[${Object.keys(shape).join(',')}], ` +
                                                    `nodes=${hasNodes ? typeof shape.nodes + (Array.isArray(shape.nodes) ? '(array)' : '') : 'missing'}, ` +
                                                    `closed=${hasClosed}, reference=${hasReference}, transform=${hasTransform}`
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (fixCount > 0) {
                throw new Error(
                    '[FontManager] validateBabelfontJsonForRust must not repair node or shape structure.'
                );
            } else if (forceValidation) {
                console.log(
                    `[FontManager] Validation ran (forceValidation=${forceValidation}), no issues found`
                );
            }
        } catch (e) {
            console.warn(
                '[FontManager] Failed to validate/fix babelfontJson:',
                e
            );
            if (e instanceof FontDataIntegrityError || e instanceof TypeError) {
                throw e;
            }
        }

        return cacheAndReturn(babelfontJson);
    }

    private syncBabelfontJsonFromCurrentModel(): boolean {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return false;
        }

        try {
            currentFont.syncJsonFromModel();
            window.currentFontModel = currentFont.fontModel;
            return true;
        } catch (error) {
            console.error(
                '[FontManager] Error syncing babelfont JSON from model:',
                error
            );
            return false;
        }
    }

    /**
     * Get the current editing font bytes
     */
    getEditingFont() {
        return this.editingFont;
    }

    /**
     * Get the glyph order (array of glyph names) from the source font
     */
    getGlyphOrder() {
        // Return cached glyph order if available
        if (this.glyphOrderCache) {
            return this.glyphOrderCache;
        }

        // Extract from compiled editing font using WASM
        if (this.editingFont) {
            try {
                const glyphOrder = get_glyph_order(this.editingFont);
                // Cache the result
                this.glyphOrderCache = glyphOrder;
                return glyphOrder;
            } catch (error) {
                console.error(
                    '[FontManager]',
                    'Failed to extract glyph order from editing font:',
                    error
                );
            }
        }

        const modelGlyphOrder =
            this.currentFont?.fontModel?.glyphs
                ?.map((glyph) => glyph?.name)
                .filter((name): name is string => !!name) || [];
        if (modelGlyphOrder.length > 0) {
            this.glyphOrderCache = modelGlyphOrder;
            return modelGlyphOrder;
        }

        return [];
    }

    /**
     * Get glyph name by GID from source font
     */
    getGlyphName(gid: number): string {
        const glyphOrder = this.getGlyphOrder();
        if (gid >= 0 && gid < glyphOrder.length) {
            return glyphOrder[gid];
        }
        return `GID${gid}`;
    }

    /**
     * Check if fonts are ready
     */
    isReady() {
        return this.editingFont !== null;
    }

    private getGlyph(glyphName: string): Babelfont.Glyph | null {
        // Get glyph data for a specific glyph name
        if (!this.currentFont) {
            return null;
        }
        let glyphs: Babelfont.Glyph[] = this.currentFont.babelfontData?.glyphs;
        if (!glyphs) {
            return null;
        }
        let glyph = glyphs.find((g) => g.name === glyphName);
        if (!glyph) {
            return null;
        }
        return glyph;
    }

    private serializeLayerForStorage(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer,
        options?: {
            preserveExistingShapes?: boolean;
            authoritativeOptionalLayerFields?: Array<
                'anchors' | 'guides' | 'format_specific'
            >;
        }
    ): Babelfont.Layer | null {
        const hasOwnKeys = (value: unknown): value is Record<string, unknown> =>
            !!value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0;

        const copyPersistedLayerFields = (value: Record<string, unknown>) => {
            const {
                anchors: _anchors,
                guides: _guides,
                format_specific: _formatSpecific,
                ...persistedFields
            } = omitRestingLayerRuntimeKeys(value);
            return persistedFields;
        };

        const cleanShapeForSaving = (shape: Babelfont.Shape): any => {
            return toRestingShapeJson(shape, {
                allowWrapped: true,
                strict: true,
                context: 'layer storage serialization'
            });
        };

        const originalLayer = this.getGlyph(glyphName)?.layers?.find(
            (entry: any) => entry.id === layerId
        );
        const existingLayer = originalLayer;
        if (!originalLayer && !layerData) {
            return null;
        }
        const authoritativeOptionalLayerFields = new Set(
            options?.authoritativeOptionalLayerFields
        );

        const resolvedWidth =
            typeof layerData.width === 'number' &&
            Number.isFinite(layerData.width)
                ? layerData.width
                : originalLayer?.width;
        assertFiniteLayerWidth(resolvedWidth, {
            glyphName,
            layerId,
            operation: 'serializeLayerForStorage'
        });

        const cleanOriginalShapes = Array.isArray(originalLayer?.shapes)
            ? originalLayer.shapes.map(cleanShapeForSaving)
            : originalLayer?.shapes;
        const cleanShapes = Array.isArray(layerData.shapes)
            ? layerData.shapes.map(cleanShapeForSaving)
            : cleanOriginalShapes;
        const storedShapes =
            options?.preserveExistingShapes && originalLayer?.shapes
                ? cleanOriginalShapes
                : cleanShapes;

        const cleanAnchors =
            Array.isArray(layerData.anchors) &&
            (layerData.anchors.length > 0 ||
                Array.isArray(originalLayer?.anchors) ||
                authoritativeOptionalLayerFields.has('anchors'))
                ? layerData.anchors.map((anchor) => {
                      const { format_specific, ...persistedAnchor } = anchor;
                      return {
                          ...persistedAnchor,
                          name: anchor.name,
                          x: anchor.x,
                          y: anchor.y,
                          ...(hasOwnKeys(format_specific) && {
                              format_specific
                          })
                      };
                  })
                : originalLayer?.anchors;

        const cleanGuides =
            Array.isArray(layerData.guides) &&
            (layerData.guides.length > 0 ||
                Array.isArray(originalLayer?.guides) ||
                authoritativeOptionalLayerFields.has('guides'))
                ? layerData.guides.map((guide) => {
                      const { format_specific, ...persistedGuide } = guide;
                      return {
                          ...persistedGuide,
                          pos: {
                              ...guide.pos,
                              x: guide.pos.x,
                              y: guide.pos.y,
                              angle: guide.pos.angle
                          },
                          name: guide.name,
                          ...(hasOwnKeys(format_specific) && {
                              format_specific
                          })
                      };
                  })
                : originalLayer?.guides;

        const formatSpecific =
            hasOwnKeys(layerData.format_specific) ||
            authoritativeOptionalLayerFields.has('format_specific')
                ? layerData.format_specific
                : hasOwnKeys(originalLayer?.format_specific)
                  ? originalLayer?.format_specific
                  : undefined;

        const layerName = layerData.name ?? originalLayer?.name;

        return toRestingLayerJson(
            {
                ...(originalLayer
                    ? copyPersistedLayerFields(originalLayer as any)
                    : {}),
                ...copyPersistedLayerFields(layerData as any),
                width: resolvedWidth,
                ...(layerData.height !== undefined && {
                    height: layerData.height
                }),
                ...(layerData.vertWidth !== undefined && {
                    vertWidth: layerData.vertWidth
                }),
                ...(layerName !== undefined && { name: layerName }),
                id: layerId,
                master: originalLayer?.master ?? layerData.master,
                ...(Array.isArray(storedShapes) && { shapes: storedShapes }),
                ...(cleanAnchors && { anchors: cleanAnchors }),
                ...(cleanGuides && { guides: cleanGuides }),
                ...((layerData.color ?? originalLayer?.color) && {
                    color: layerData.color ?? originalLayer?.color
                }),
                ...(layerData.layer_index !== undefined && {
                    layer_index: layerData.layer_index
                }),
                ...(layerData.is_background !== undefined
                    ? { is_background: layerData.is_background }
                    : originalLayer?.is_background === true
                      ? { is_background: true }
                      : {}),
                ...((layerData.background_layer_id ??
                    originalLayer?.background_layer_id) && {
                    background_layer_id:
                        layerData.background_layer_id ??
                        originalLayer?.background_layer_id
                }),
                ...((layerData.location ?? originalLayer?.location) && {
                    location: {
                        ...(layerData.location ?? originalLayer?.location)
                    }
                }),
                ...(formatSpecific && {
                    format_specific: formatSpecific
                }),
                ...((layerData as any).master && {
                    master: (layerData as any).master
                })
            },
            {
                existing: originalLayer ?? undefined,
                mode: 'replace',
                allowWrapped: true,
                context: 'layer storage serialization'
            }
        ) as unknown as Babelfont.Layer;
    }

    private updateStoredLayerData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ): boolean {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return false;
        }

        const layerIndex = glyph.layers.findIndex(
            (layer) => layer.id === layerId
        );
        if (layerIndex === -1) {
            return false;
        }

        glyph.layers[layerIndex] = layerData;
        return true;
    }

    syncLayerFromModelToStorage(glyphName: string, layerId: string): boolean {
        const glyph = this.currentFont?.fontModel?.findGlyph(glyphName);
        const layer = glyph?.findLayerById(layerId);
        if (!layer) {
            return false;
        }

        const serializedLayer = this.serializeLayerForStorage(
            glyphName,
            layerId,
            layer.toJSON(),
            undefined
        );
        return (
            !!serializedLayer &&
            this.updateStoredLayerData(glyphName, layerId, serializedLayer)
        );
    }

    removeStoredLayerData(glyphName: string, layerId: string): boolean {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return false;
        }

        const layerIndex = glyph.layers.findIndex(
            (layer) => layer.id === layerId
        );
        if (layerIndex === -1) {
            return false;
        }

        glyph.layers.splice(layerIndex, 1);
        return true;
    }

    private getWorkerLayerFingerprintKey(
        glyphName: string,
        layerId: string
    ): string {
        return `${glyphName}::${layerId}`;
    }

    private getLayerWorkerFingerprint(layerData: Babelfont.Layer): string {
        return JSON.stringify(this.normalizeLayerForRust(layerData));
    }

    /**
     * Baseline fingerprints for changed-layer detection.
     *
     * Historically this parsed the entire `currentFont.babelfontJson`
     * (multi-megabyte JSON) on every commit batch — a steady ~50-100ms
     * cost per edit even though the only baseline that matters is
     * "what is currently in the Rust worker cache". That state is
     * already tracked incrementally in `workerLayerFingerprintCache`:
     * it is cleared whenever the worker cache is fully reseeded
     * (`storeFontJson`/`forceFullWorkerCacheUpdate` via
     * {@link recordFullFontCrossing}) and updated on every successful
     * `forwardWorkerYjsUpdate` batch. Returning an empty Map here
     * keeps the logic correct (a missing fingerprint forces the layer
     * to be included in the next batch — the safe fallback) while
     * removing the per-commit JSON.parse from the hot path entirely.
     * See COMPILATION_EDIT_POLICY.md.
     */
    private getLayerFingerprintsFromStoredJson(
        _glyphNames: Iterable<string>
    ): Map<string, string> {
        return EMPTY_FINGERPRINT_MAP;
    }

    /** Build a full binary Yjs snapshot from the current in-memory font data for worker refreshes. */
    private buildWorkerYjsStateFromCurrentFont(): Uint8Array | null {
        const bridge = window.patchSyncEngine;
        if (bridge?.fontMap && typeof bridge.encodeBridgeState === 'function') {
            return bridge.encodeBridgeState();
        }

        const currentFont = this.currentFont;
        const currentFontData = currentFont?.babelfontData;
        if (
            (!currentFontData || typeof currentFontData !== 'object') &&
            !currentFont?.babelfontJson
        ) {
            return null;
        }

        const parsed = currentFontData
            ? (JSON.parse(JSON.stringify(currentFontData)) as Record<
                  string,
                  unknown
              >)
            : (JSON.parse(currentFont.babelfontJson) as Record<
                  string,
                  unknown
              >);
        const yDoc = new Y.Doc();
        jsonToYDoc(parsed, yDoc.getMap('font'));
        return Y.encodeStateAsUpdate(yDoc);
    }

    /** Public accessor so window-sync can build a Rust-compatible seed state. */
    buildWorkerSeedYjsState(): Uint8Array | null {
        return this.buildWorkerYjsStateFromCurrentFont();
    }

    buildWorkerSeedDocumentSet(): Array<{
        documentId: string;
        bytes: Uint8Array;
    }> | null {
        const bridge = window.patchSyncEngine as
            | (typeof window.patchSyncEngine & {
                  encodeDocumentSet?: () => Array<{
                      documentId: string;
                      bytes: Uint8Array;
                  }>;
              })
            | undefined;
        const shards = bridge?.encodeDocumentSet?.();
        return shards?.length ? shards : null;
    }

    /**
     * Build a Yjs binary state from a raw babelfont JSON string, without
     * touching the current font or any bridge. Used to seed the worker's
     * Y.Doc with the empty font before the normal pipeline runs.
     */
    private buildWorkerYjsStateFromJson(
        babelfontJson: string
    ): Uint8Array | null {
        try {
            const parsed = JSON.parse(babelfontJson) as Record<string, unknown>;
            const yDoc = new Y.Doc();
            jsonToYDoc(parsed, yDoc.getMap('font'));
            return Y.encodeStateAsUpdate(yDoc);
        } catch {
            return null;
        }
    }

    /** Discard JS fingerprint/epoch state that must stay coherent with the worker document. */
    private invalidateWorkerCacheMirror(): void {
        this.workerLayerFingerprintCache.clear();
        this.lastWorkerDocumentEpoch = 0;
        this.lastWorkerFilterEpoch = 0;
        this.lastWorkerFontCacheEpoch = 0;
        this.workerMirrorQuarantined = true;
        fontCompilation?.setWorkerCacheDocumentReady(false);
    }

    private workerLayerTargetsAreResting(
        layerTargets: WorkerReplayTarget[]
    ): boolean {
        if (!layerTargets.length) {
            return true;
        }
        const fontMap = window.patchSyncEngine?.fontMap;
        if (!fontMap) {
            return true;
        }

        for (const target of layerTargets) {
            if (!target?.glyphName || !target?.layerId) {
                continue;
            }
            const layerValue = getYPath(fontMap, [
                'glyphs',
                target.glyphName,
                'layers',
                target.layerId
            ]);
            if (layerValue === undefined || layerValue === null) {
                continue;
            }
            const layerJson = fromYType(layerValue);
            const violation = describeRestingLayerViolation(layerJson);
            if (violation) {
                console.error(
                    `[FontManager] Resting-layer preflight failed for ${target.glyphName}/${target.layerId}: ${violation}`
                );
                return false;
            }
        }
        return true;
    }

    private async sendWorkerYjsUpdate(
        update: Uint8Array,
        changedGlyphs: string[],
        invalidateLayoutClosure: boolean,
        nonGlyphChangeHints: string[] = [],
        layerTargets: WorkerReplayTarget[] = [],
        glyphRenames: Array<{ oldName: string; newName: string }> = [],
        documentId?: string
    ): Promise<boolean> {
        const runSend = async (): Promise<boolean> => {
            if (!fontCompilation) {
                return false;
            }

            // Bridge initialization starts the authoritative worker seed
            // asynchronously. A commit can arrive while that seed is in
            // flight; queue its incremental delta behind the seed rather than
            // dropping it before Rust has a compatible Y.Doc. This promise is
            // already settled for the steady-state hot path.
            await fontCompilation.awaitWorkerDocumentSync();

            if (!fontCompilation?.isInitialized) {
                return false;
            }

            // Quarantine is an exceptional failure state (e.g. a prior
            // applyYjsUpdate throw). Re-seed from the authoritative bridge
            // once so later incremental edits are not stuck forever; this is
            // the same recovery class as cloud reconnect rebaseline.
            if (this.workerMirrorQuarantined) {
                const recovered =
                    await this.recoverWorkerCacheFromAuthoritativeState(
                        'sendWorkerYjsUpdate while quarantined'
                    );
                if (!recovered || this.workerMirrorQuarantined) {
                    return false;
                }
            }

            const hasRefreshMetadata =
                changedGlyphs.length > 0 ||
                nonGlyphChangeHints.length > 0 ||
                layerTargets.length > 0 ||
                glyphRenames.length > 0;
            const updateToSend =
                update.length > 0
                    ? update
                    : hasRefreshMetadata
                      ? NO_OP_YJS_UPDATE
                      : update;

            if (!updateToSend.length) {
                return true;
            }

            const normalizedLayerTargets =
                normalizeWorkerReplayTargets(layerTargets);
            if (!this.workerLayerTargetsAreResting(normalizedLayerTargets)) {
                console.error(
                    '[FontManager] Refusing applyYjsUpdate; JS Y.Doc layer is not resting JSON',
                    { changedGlyphs, layerTargets: normalizedLayerTargets }
                );
                return false;
            }

            try {
                const response = await fontCompilation.sendMessage({
                    type: 'applyYjsUpdate',
                    update: updateToSend,
                    changedGlyphs,
                    nonGlyphChangeHints,
                    ...(normalizedLayerTargets.length
                        ? { layerTargets: normalizedLayerTargets }
                        : undefined),
                    ...(glyphRenames.length ? { glyphRenames } : undefined),
                    invalidateLayoutClosure,
                    documentId
                });

                // Keep incremental worker updates strictly serialized.
                // Overlapping applyYjsUpdate calls can otherwise race the
                // worker-side Y.Doc/cache state during rapid GUI edits.
                if (response?.skipped === 'ydoc_not_initialized') {
                    this.invalidateWorkerCacheMirror();
                    console.warn(
                        '[FontManager] Worker Y.Doc was not initialized for incremental Yjs update',
                        {
                            changedGlyphs,
                            invalidateLayoutClosure
                        }
                    );
                    return this.recoverWorkerCacheFromAuthoritativeState(
                        'applyYjsUpdate skipped; worker Y.Doc missing'
                    );
                }

                const workerCacheStatus = response?.workerCacheStatus;
                if (
                    !workerCacheStatus ||
                    workerCacheStatus.coherent !== true ||
                    !Number.isFinite(workerCacheStatus.documentEpoch)
                ) {
                    this.invalidateWorkerCacheMirror();
                    console.warn(
                        '[FontManager] Worker Yjs update completed without a coherent cache acknowledgement',
                        {
                            changedGlyphs,
                            invalidateLayoutClosure,
                            workerCacheStatus
                        }
                    );
                    return false;
                }

                this.lastWorkerDocumentEpoch = workerCacheStatus.documentEpoch;
                this.lastWorkerFilterEpoch = Number.isFinite(
                    workerCacheStatus.filterEpoch
                )
                    ? workerCacheStatus.filterEpoch
                    : this.lastWorkerFilterEpoch;
                this.lastWorkerFontCacheEpoch = Number.isFinite(
                    workerCacheStatus.fontCacheEpoch
                )
                    ? workerCacheStatus.fontCacheEpoch
                    : this.lastWorkerFontCacheEpoch;

                return true;
            } catch (error) {
                this.invalidateWorkerCacheMirror();
                console.warn(
                    '[FontManager] Failed to send worker Yjs update:',
                    {
                        changedGlyphs,
                        invalidateLayoutClosure
                    },
                    error
                );
                return this.recoverWorkerCacheFromAuthoritativeState(
                    'applyYjsUpdate failed; reseeding from bridge'
                );
            }
        };

        const queuedSend = this.workerYjsSendQueue
            .catch(() => undefined)
            .then(async () => {
                await this.workerPreviewSendQueue.catch(() => undefined);
                return runSend();
            });
        this.workerYjsSendQueue = queuedSend.catch(() => undefined);
        return queuedSend;
    }

    private enqueueWorkerPreviewSend<T>(runSend: () => Promise<T>): Promise<T> {
        const queuedSend = this.workerPreviewSendQueue
            .catch(() => undefined)
            .then(runSend);
        this.workerPreviewSendQueue = queuedSend.catch(() => undefined);
        return queuedSend;
    }

    private async sendWorkerPreviewLayerOverlay(
        layerUpdates: Array<{
            glyphName: string;
            layerId: string;
            layerData: Babelfont.Layer;
        }>,
        changedGlyphs: string[],
        invalidateLayoutClosure: boolean,
        nonGlyphChangeHints: string[] = [],
        layerTargets: WorkerReplayTarget[] = []
    ): Promise<boolean> {
        const runSend = async (): Promise<boolean> => {
            if (!fontCompilation?.isInitialized) {
                return false;
            }

            if (!layerUpdates.length) {
                return true;
            }

            try {
                const normalizedLayerTargets =
                    normalizeWorkerReplayTargets(layerTargets);
                const response = await fontCompilation.sendMessage({
                    type: 'applyPreviewLayerOverlay',
                    layerUpdates,
                    changedGlyphs,
                    nonGlyphChangeHints,
                    ...(normalizedLayerTargets.length
                        ? { layerTargets: normalizedLayerTargets }
                        : undefined),
                    invalidateLayoutClosure
                });

                if (response?.success === false || response?.error) {
                    return false;
                }

                return true;
            } catch (error) {
                console.warn(
                    '[FontManager] Failed to send worker preview layer overlay:',
                    {
                        changedGlyphs,
                        invalidateLayoutClosure
                    },
                    error
                );
                return false;
            }
        };

        return this.enqueueWorkerPreviewSend(runSend);
    }

    private async recoverWorkerCacheFromAuthoritativeState(
        reason: string
    ): Promise<boolean> {
        const documentSet = window.patchSyncEngine?.encodeDocumentSet?.();
        const bridgeState = window.patchSyncEngine?.encodeBridgeState?.();
        if (
            (!documentSet?.length && !bridgeState?.length) ||
            !fontCompilation
        ) {
            this.workerMirrorQuarantined = true;
            fontCompilation?.setWorkerCacheDocumentReady(false);
            console.error(
                '[FontManager] Cannot recover worker cache without bridge state:',
                reason
            );
            return false;
        }

        try {
            const recovery = documentSet?.length
                ? fontCompilation.seedWorkerDocumentSet(documentSet)
                : fontCompilation.seedWorkerYDocFromState(
                      bridgeState as Uint8Array
                  );
            await fontCompilation.trackWorkerDocumentSync(recovery);
            this.acknowledgeWorkerBridgeReseed();
            console.warn(
                '[FontManager] Re-seeded worker cache from authoritative bridge state:',
                reason
            );
            return true;
        } catch (error) {
            this.workerMirrorQuarantined = true;
            fontCompilation.setWorkerCacheDocumentReady(false);
            console.error(
                '[FontManager] Failed to recover worker cache from bridge state:',
                reason,
                error
            );
            return false;
        }
    }

    /**
     * Mark the editing worker as aligned with the bridge after an explicit
     * bootstrap/rebaseline `seedYdoc`. Clears quarantine so later incremental
     * packets are not forced through a redundant recover.
     */
    acknowledgeWorkerBridgeReseed(): void {
        this.workerLayerFingerprintCache.clear();
        this.workerMirrorQuarantined = false;
        fontCompilation?.setWorkerCacheDocumentReady(true);
    }

    async recoverWorkerCacheFromBridgeState(reason: string): Promise<boolean> {
        return this.recoverWorkerCacheFromAuthoritativeState(reason);
    }

    private collectLayerUpdatesForTargetsFromModel(
        targets: Iterable<WorkerReplayTarget>
    ): {
        updates: LayerCacheUpdate[];
        removedFingerprintKeys: string[];
    } | null {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: LayerCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        const seenTargets = new Set<string>();

        for (const target of targets) {
            const glyphName = target?.glyphName;
            const layerId = target?.layerId;
            if (!glyphName || !layerId) {
                continue;
            }

            const fingerprintKey = this.getWorkerLayerFingerprintKey(
                glyphName,
                layerId
            );
            if (seenTargets.has(fingerprintKey)) {
                continue;
            }
            seenTargets.add(fingerprintKey);

            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const rawModelGlyph = modelGlyph as any;
            const modelLayer =
                rawModelGlyph?.data?.layers?.find(
                    (entry: any) => entry?.id === layerId
                ) ??
                modelGlyph?.layers?.find((entry: any) => entry?.id === layerId);

            if (!modelLayer) {
                removedFingerprintKeys.push(fingerprintKey);
                continue;
            }

            const rawLayerData =
                typeof modelLayer.toJSON === 'function'
                    ? modelLayer.toJSON()
                    : modelLayer;
            const serializedLayer = this.serializeLayerForStorage(
                glyphName,
                layerId,
                rawLayerData
            );
            if (!serializedLayer) {
                return null;
            }

            updates.push({
                glyphName,
                layerId,
                layerData: serializedLayer
            });
        }

        return {
            updates,
            removedFingerprintKeys
        };
    }

    private collectLayerUpdatesForTargetsFromBridge(
        targets: Iterable<WorkerReplayTarget>
    ): {
        updates: LayerCacheUpdate[];
        removedFingerprintKeys: string[];
    } | null {
        const currentFont = this.currentFont;
        const fontMap = window.patchSyncEngine?.fontMap;
        if (!currentFont || !fontMap) {
            return null;
        }

        const updates: LayerCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        const seenTargets = new Set<string>();

        for (const target of targets) {
            const glyphName = target?.glyphName;
            const layerId = target?.layerId;
            if (!glyphName || !layerId) {
                continue;
            }

            const fingerprintKey = this.getWorkerLayerFingerprintKey(
                glyphName,
                layerId
            );
            if (seenTargets.has(fingerprintKey)) {
                continue;
            }
            seenTargets.add(fingerprintKey);

            const bridgeLayer = getYPath(fontMap, [
                'glyphs',
                glyphName,
                'layers',
                layerId
            ]);
            if (!bridgeLayer) {
                removedFingerprintKeys.push(fingerprintKey);
                continue;
            }

            const rawLayerData = fromYType(bridgeLayer) as Babelfont.Layer;
            let serializedLayer = this.serializeLayerForStorage(
                glyphName,
                layerId,
                rawLayerData
            );
            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const modelLayer = modelGlyph?.layers?.find(
                (entry: any) => entry?.id === layerId
            );
            const rawModelLayerData =
                typeof modelLayer?.toJSON === 'function'
                    ? modelLayer.toJSON()
                    : modelLayer;
            const modelSerializedLayer = rawModelLayerData
                ? this.serializeLayerForStorage(
                      glyphName,
                      layerId,
                      rawModelLayerData
                  )
                : null;
            if (
                serializedLayer &&
                modelSerializedLayer &&
                Array.isArray(modelSerializedLayer.shapes) &&
                modelSerializedLayer.shapes.length > 0 &&
                (!Array.isArray(serializedLayer.shapes) ||
                    serializedLayer.shapes.length === 0)
            ) {
                serializedLayer = modelSerializedLayer;
            }
            if (!serializedLayer) {
                return null;
            }

            updates.push({
                glyphName,
                layerId,
                layerData: serializedLayer
            });
        }

        return {
            updates,
            removedFingerprintKeys
        };
    }

    async forwardWorkerYjsUpdate(
        update: Uint8Array,
        changedGlyphs: string[],
        options?: {
            invalidateLayoutClosure?: boolean;
            layerTargets?: WorkerReplayTarget[];
            nonGlyphChangeHints?: string[];
            glyphRenames?: Array<{ oldName: string; newName: string }>;
            documentId?: string;
        }
    ): Promise<boolean> {
        const previousWorkerCacheUpdatePromise = this.workerCacheUpdatePromise;
        const forwardedUpdatePromise = this.forwardWorkerYjsUpdateInternal(
            update,
            changedGlyphs,
            options
        );
        const cacheUpdatePromise = previousWorkerCacheUpdatePromise
            ? Promise.allSettled([
                  previousWorkerCacheUpdatePromise,
                  forwardedUpdatePromise
              ]).then(() => undefined)
            : forwardedUpdatePromise.then(() => undefined);
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        void cacheUpdatePromise.finally(() => {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        });

        return await forwardedUpdatePromise;
    }

    private async forwardWorkerYjsUpdateInternal(
        update: Uint8Array,
        changedGlyphs: string[],
        options?: {
            invalidateLayoutClosure?: boolean;
            layerTargets?: WorkerReplayTarget[];
            nonGlyphChangeHints?: string[];
            glyphRenames?: Array<{ oldName: string; newName: string }>;
            documentId?: string;
        }
    ): Promise<boolean> {
        const normalizedChangedGlyphs = Array.from(
            new Set(changedGlyphs.filter((glyphName) => !!glyphName))
        );
        const normalizedNonGlyphChangeHints = Array.from(
            new Set((options?.nonGlyphChangeHints || []).filter(Boolean))
        );
        const normalizedLayerTargets = normalizeWorkerReplayTargets(
            options?.layerTargets || []
        );

        if (!normalizedChangedGlyphs.length && !normalizedLayerTargets.length) {
            return this.sendWorkerYjsUpdate(
                update,
                [],
                options?.invalidateLayoutClosure !== false,
                normalizedNonGlyphChangeHints,
                normalizedLayerTargets,
                options?.glyphRenames || [],
                options?.documentId
            );
        }
        // Authoritative mutation is the Yjs binary already being sent.
        // Do not walk the bridge with `fromYType` just to fingerprint.
        let fingerprintUpdates: LayerCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        if (normalizedLayerTargets.length) {
            fingerprintUpdates =
                this.collectChangedLayerUpdatesFromTargets(
                    normalizedLayerTargets
                ) || [];
            const fingerprintedKeys = new Set(
                fingerprintUpdates.map((update) =>
                    this.getWorkerLayerFingerprintKey(
                        update.glyphName,
                        update.layerId
                    )
                )
            );
            for (const target of normalizedLayerTargets) {
                const fingerprintKey = this.getWorkerLayerFingerprintKey(
                    target.glyphName,
                    target.layerId
                );
                if (!fingerprintedKeys.has(fingerprintKey)) {
                    removedFingerprintKeys.push(fingerprintKey);
                }
            }
        } else {
            fingerprintUpdates =
                this.collectChangedLayerUpdatesFromModel(
                    normalizedChangedGlyphs,
                    null,
                    { skipFingerprintBaseline: true }
                ) || [];
        }

        const sent = await this.sendWorkerYjsUpdate(
            update,
            normalizedChangedGlyphs,
            options?.invalidateLayoutClosure !== false,
            normalizedNonGlyphChangeHints,
            normalizedLayerTargets,
            options?.glyphRenames || [],
            options?.documentId
        );

        if (!sent) {
            this.workerLayerFingerprintCache.clear();
            return false;
        }

        for (const fingerprintKey of removedFingerprintKeys) {
            this.workerLayerFingerprintCache.delete(fingerprintKey);
        }

        const missingGlyphNames = normalizedChangedGlyphs.filter(
            (glyphName) => !this.currentFont?.fontModel?.findGlyph(glyphName)
        );
        if (missingGlyphNames.length > 0) {
            for (const fingerprintKey of Array.from(
                this.workerLayerFingerprintCache.keys()
            )) {
                if (
                    missingGlyphNames.some((glyphName) =>
                        fingerprintKey.startsWith(`${glyphName}::`)
                    )
                ) {
                    this.workerLayerFingerprintCache.delete(fingerprintKey);
                }
            }
        }

        const transmittedLayerCount =
            normalizedLayerTargets.length || fingerprintUpdates.length;
        if (transmittedLayerCount > 0) {
            this._boundaryCrossingStats.submitBatchCalls++;
            this._boundaryCrossingStats.layersTransmitted +=
                transmittedLayerCount;
            for (const layerUpdate of fingerprintUpdates) {
                const normalizedLayer = this.normalizeLayerForRust(
                    layerUpdate.layerData
                );
                this.workerLayerFingerprintCache.set(
                    this.getWorkerLayerFingerprintKey(
                        layerUpdate.glyphName,
                        layerUpdate.layerId
                    ),
                    JSON.stringify(normalizedLayer)
                );
                this._boundaryCrossingStats.transmittedGlyphs.add(
                    layerUpdate.glyphName
                );
            }
            for (const target of normalizedLayerTargets) {
                this._boundaryCrossingStats.transmittedGlyphs.add(
                    target.glyphName
                );
            }
        }

        return true;
    }

    private prepareCompileFacingLayerUpdate(
        glyphName: string,
        layerId: string,
        rawLayerData: Babelfont.Layer
    ): LayerCacheUpdate {
        const storedWidth = this.getGlyph(glyphName)?.layers?.find(
            (entry: { id?: string }) => entry?.id === layerId
        )?.width;
        const resolvedWidth =
            typeof rawLayerData?.width === 'number' &&
            Number.isFinite(rawLayerData.width)
                ? rawLayerData.width
                : storedWidth;
        assertFiniteLayerWidth(resolvedWidth, {
            glyphName,
            layerId,
            operation: 'prepareCompileFacingLayerUpdate'
        });
        return {
            glyphName,
            layerId,
            layerData:
                rawLayerData?.width === resolvedWidth
                    ? rawLayerData
                    : { ...rawLayerData, width: resolvedWidth }
        };
    }

    private collectChangedLayerUpdatesFromTargets(
        targets: Iterable<WorkerReplayTarget>,
        options?: {
            skipFingerprintBaseline?: boolean;
            compileFacing?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
        }
    ): LayerCacheUpdate[] | null {
        const normalizedTargets = normalizeWorkerReplayTargets(targets);
        if (normalizedTargets.length === 0) {
            return [];
        }

        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: LayerCacheUpdate[] = [];
        const explicitLayerData = new Map<string, Babelfont.Layer>();
        for (const input of options?.explicitLayerData || []) {
            if (input?.glyphName && input?.layerId && input?.layerData) {
                explicitLayerData.set(
                    this.getWorkerLayerFingerprintKey(
                        input.glyphName,
                        input.layerId
                    ),
                    input.layerData
                );
            }
        }

        for (const target of normalizedTargets) {
            const modelGlyph = currentFont.fontModel?.findGlyph?.(
                target.glyphName
            );
            const modelLayer = modelGlyph?.findLayerById?.(target.layerId);
            if (!modelLayer) {
                console.warn(
                    '[FontManager] Missing matched layer for preview/sync target',
                    target
                );
                continue;
            }

            const fingerprintKey = this.getWorkerLayerFingerprintKey(
                target.glyphName,
                target.layerId
            );
            const explicitLayer = explicitLayerData.get(fingerprintKey);
            const rawLayerData =
                explicitLayer ??
                (options?.compileFacing &&
                typeof (modelLayer as { toCompileJSON?: () => unknown })
                    .toCompileJSON === 'function'
                    ? (
                          modelLayer as { toCompileJSON: () => Babelfont.Layer }
                      ).toCompileJSON()
                    : typeof modelLayer.toJSON === 'function'
                      ? (modelLayer.toJSON() as Babelfont.Layer)
                      : (modelLayer as Babelfont.Layer));

            if (options?.compileFacing) {
                updates.push(
                    this.prepareCompileFacingLayerUpdate(
                        target.glyphName,
                        target.layerId,
                        rawLayerData
                    )
                );
                continue;
            }

            const serializedLayer = this.serializeLayerForStorage(
                target.glyphName,
                target.layerId,
                rawLayerData
            );
            if (!serializedLayer) {
                return null;
            }

            updates.push({
                glyphName: target.glyphName,
                layerId: target.layerId,
                layerData: serializedLayer
            });
        }

        return updates;
    }

    private collectChangedLayerUpdatesFromModel(
        glyphNames: Iterable<string>,
        preferredLayerId?: string | null,
        options?: {
            skipFingerprintBaseline?: boolean;
            compileFacing?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
        }
    ): LayerCacheUpdate[] | null {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: LayerCacheUpdate[] = [];
        const explicitLayerData = new Map<string, Babelfont.Layer>();
        for (const input of options?.explicitLayerData || []) {
            if (input?.glyphName && input?.layerId && input?.layerData) {
                explicitLayerData.set(
                    this.getWorkerLayerFingerprintKey(
                        input.glyphName,
                        input.layerId
                    ),
                    input.layerData
                );
            }
        }
        const glyphNameList = Array.from(glyphNames);
        const storedJsonFingerprints = options?.skipFingerprintBaseline
            ? new Map<string, string>()
            : this.getLayerFingerprintsFromStoredJson(glyphNameList);
        const sourceGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            glyphNameList[0] ||
            null;
        const sourceLayer =
            preferredLayerId && sourceGlyphName
                ? currentFont.fontModel
                      ?.findGlyph(sourceGlyphName)
                      ?.layers?.find(
                          (layer: any) => layer?.id === preferredLayerId
                      )
                : null;

        for (const glyphName of glyphNameList) {
            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const storedGlyph = this.getGlyph(glyphName);
            if (!modelGlyph || !storedGlyph?.layers) {
                return null;
            }

            const modelLayers = preferredLayerId
                ? [
                      glyphName === sourceGlyphName
                          ? sourceLayer
                          : sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ||
                            modelGlyph.layers?.find(
                                (layer: any) => layer?.id === preferredLayerId
                            )
                  ].filter(Boolean)
                : modelGlyph.layers || [];

            if (preferredLayerId && modelLayers.length === 0) {
                console.warn(
                    '[FontManager] Failed to resolve matching layer for dependent glyph',
                    { glyphName, preferredLayerId, sourceGlyphName }
                );
            }

            for (const modelLayer of modelLayers) {
                const layerId = modelLayer?.id;
                if (typeof layerId !== 'string' || !layerId) {
                    return null;
                }

                const fingerprintKey = this.getWorkerLayerFingerprintKey(
                    glyphName,
                    layerId
                );
                const explicitLayer = explicitLayerData.get(fingerprintKey);
                const rawLayerData =
                    explicitLayer ??
                    (options?.compileFacing &&
                    typeof modelLayer.toCompileJSON === 'function'
                        ? modelLayer.toCompileJSON()
                        : typeof modelLayer.toJSON === 'function'
                          ? modelLayer.toJSON()
                          : modelLayer);

                if (options?.compileFacing) {
                    updates.push(
                        this.prepareCompileFacingLayerUpdate(
                            glyphName,
                            layerId,
                            rawLayerData
                        )
                    );
                    continue;
                }

                const serializedLayer = this.serializeLayerForStorage(
                    glyphName,
                    layerId,
                    rawLayerData
                );
                if (!serializedLayer) {
                    return null;
                }

                // When skipFingerprintBaseline is set (live drag), skip the
                // expensive fingerprint comparison and always include the update
                if (!options?.skipFingerprintBaseline) {
                    const modelFingerprint =
                        this.getLayerWorkerFingerprint(serializedLayer);
                    const baselineFingerprint =
                        this.workerLayerFingerprintCache.get(fingerprintKey) ??
                        storedJsonFingerprints.get(fingerprintKey) ??
                        null;

                    if (
                        !(preferredLayerId && glyphName === sourceGlyphName) &&
                        baselineFingerprint === modelFingerprint
                    ) {
                        continue;
                    }
                }

                // Compile-facing preview payloads must never replace resting
                // storage — that poisons logical component translates and
                // double-bakes =+/-= on the next drag.
                if (
                    !options?.compileFacing &&
                    !this.updateStoredLayerData(
                        glyphName,
                        layerId,
                        serializedLayer
                    )
                ) {
                    return null;
                }

                updates.push({
                    glyphName,
                    layerId,
                    layerData: serializedLayer
                });
            }
        }

        return updates;
    }

    private async submitLayerUpdatesToWorkerPreview(
        updates: LayerCacheUpdate[],
        options?: { invalidateLayoutClosure?: boolean }
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }

        if (!updates.length) {
            return true;
        }

        try {
            const normalizedUpdates = updates.map((update) => ({
                glyphName: update.glyphName,
                layerId: update.layerId,
                layerData: this.normalizeLayerForRust(update.layerData)
            }));

            return await this.sendWorkerPreviewLayerOverlay(
                normalizedUpdates,
                Array.from(
                    new Set(normalizedUpdates.map((update) => update.glyphName))
                ),
                options?.invalidateLayoutClosure ?? false,
                [],
                normalizedUpdates.map(({ glyphName, layerId }) => ({
                    glyphName,
                    layerId
                }))
            );
        } catch (error) {
            console.warn(
                '[FontManager] Failed to submit live-drag layer overlay to worker preview cache:',
                updates.map(({ glyphName, layerId }) => ({
                    glyphName,
                    layerId
                })),
                error
            );
            return false;
        }
    }

    /**
     * Snapshot the running JS ↔ Rust/worker boundary-crossing counters.
     * Call {@link resetBoundaryCrossingStats} at the start of an edit
     * and read the snapshot at the end to assert that exactly the
     * expected number of batched layer updates / full-font crossings
     * occurred.
     */
    getBoundaryCrossingStats(): BoundaryCrossingStats {
        return {
            submitBatchCalls: this._boundaryCrossingStats.submitBatchCalls,
            layersTransmitted: this._boundaryCrossingStats.layersTransmitted,
            glyphsTransmitted:
                this._boundaryCrossingStats.transmittedGlyphs.size,
            fullFontCrossings: this._boundaryCrossingStats.fullFontCrossings
        };
    }

    /**
     * Read-only sizes for the Preferences memory breakdown. Does not
     * serialize the font or walk model wrappers.
     */
    getMemoryInspectionSnapshot(): {
        fonts: Array<{
            id: string;
            name: string;
            babelfontJson: string;
            babelfontData: unknown;
        }>;
        validatedCacheInput: string | null;
        validatedCacheOutput: string | null;
        editingFontBytes: number;
        closureCache: FontManager['closureCache'];
        glyphOrderCache: string[] | null;
        fingerprintCache: Map<string, string>;
    } {
        const fonts = Array.from(this.openedFonts.entries()).map(
            ([id, font]) => ({
                id,
                name: font.name,
                babelfontJson: font.babelfontJson,
                babelfontData: font.babelfontData
            })
        );
        return {
            fonts,
            validatedCacheInput:
                this._validatedBabelfontJsonCache?.input ?? null,
            validatedCacheOutput:
                this._validatedBabelfontJsonCache?.output ?? null,
            editingFontBytes: this.editingFont?.byteLength ?? 0,
            closureCache: this.closureCache,
            glyphOrderCache: this.glyphOrderCache,
            fingerprintCache: this.workerLayerFingerprintCache
        };
    }

    /**
     * Reset the running boundary-crossing counters. Tests and the AI
     * profiling harness call this between edits to measure per-edit
     * costs in isolation.
     */
    resetBoundaryCrossingStats(): void {
        this._boundaryCrossingStats.submitBatchCalls = 0;
        this._boundaryCrossingStats.layersTransmitted = 0;
        this._boundaryCrossingStats.fullFontCrossings = 0;
        this._boundaryCrossingStats.transmittedGlyphs.clear();
    }

    /**
     * Record a full-font crossing (`storeFontJson`). Centralised so the
     * boundary-crossing counters cover every full-font path.
     *
     * After a full crossing the worker has received a fresh
     * `babelfontJson` and the previous incremental fingerprints become
     * a stale baseline (they refer to a state that may not match what
     * Rust now has). Clearing the cache forces the next batch to
     * include every touched layer — the safe direction — and the
     * cache is then incrementally rebuilt by subsequent successful
     * `forwardWorkerYjsUpdate` batches. This keeps the
     * fingerprint cache as the documented single source of truth (see
     * COMPILATION_EDIT_POLICY.md §11).
     */
    recordFullFontCrossing(): void {
        this._boundaryCrossingStats.fullFontCrossings++;
        this.workerLayerFingerprintCache.clear();
    }

    async refreshWorkerCacheForReplayTargets(
        targets: Iterable<WorkerReplayTarget>
    ): Promise<boolean> {
        const refreshPromise = (async () => {
            const currentFont = this.currentFont;
            if (!currentFont || !fontCompilation?.isInitialized) {
                return false;
            }

            const normalizedTargets = normalizeWorkerReplayTargets(targets);
            if (!normalizedTargets.length) {
                return false;
            }

            // Fingerprint bookkeeping only — worker mutation arrives via
            // forwarded bridge Yjs updates, not whole-layer encode.
            const targetLayerUpdates =
                this.collectLayerUpdatesForTargetsFromBridge(
                    normalizedTargets
                ) ||
                this.collectLayerUpdatesForTargetsFromModel(normalizedTargets);

            if (targetLayerUpdates) {
                for (const fingerprintKey of targetLayerUpdates.removedFingerprintKeys) {
                    this.workerLayerFingerprintCache.delete(fingerprintKey);
                }
                for (const update of targetLayerUpdates.updates) {
                    const normalized = this.normalizeLayerForRust(
                        update.layerData
                    );
                    this.workerLayerFingerprintCache.set(
                        this.getWorkerLayerFingerprintKey(
                            update.glyphName,
                            update.layerId
                        ),
                        JSON.stringify(normalized)
                    );
                }
            }

            try {
                await fontCompilation.awaitWorkerDocumentSync();
            } catch {
                return false;
            }

            return true;
        })();

        const previousWorkerCacheUpdatePromise = this.workerCacheUpdatePromise;
        const cacheUpdatePromise = previousWorkerCacheUpdatePromise
            ? Promise.allSettled([
                  previousWorkerCacheUpdatePromise,
                  refreshPromise
              ]).then(() => undefined)
            : refreshPromise.then(() => undefined);
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            return await refreshPromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    /**
     * Looks for a font-level format_specific key in the current font
     *
     * @param {string} key
     * @returns {any}
     */
    getFormatSpecific(key: string): any {
        return this.currentFont?.babelfontData?.format_specific?.[key];
    }

    /**
     * Sets a font-level format_specific key in the current font
     *
     * @param {string} key
     * @param {any} value
     */
    setFormatSpecific(key: string, value: any) {
        if (this.currentFont?.babelfontData) {
            if (!this.currentFont.babelfontData.format_specific) {
                this.currentFont.babelfontData.format_specific = {};
            }
            this.currentFont.babelfontData.format_specific[key] = value;
        }
    }

    fetchGlyphData(glyphName: string): GlyphData | null {
        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            return null;
        }
        let master_ids = new Set<string>();
        for (let master of this.currentFont!.babelfontData.masters) {
            master_ids.add(master.id);
        }
        let layersData: any[] = [];
        for (let layer of glyph.layers || []) {
            // Include non-background layers that are either:
            // - default layers for their master, or
            // - brace layers (AssociatedWithMaster + non-empty location)
            if (!layer.is_background) {
                const layerAny = layer as any;
                const hasTaggedMaster =
                    layerAny.master &&
                    typeof layerAny.master === 'object' &&
                    'type' in layerAny.master;
                const isDefaultLayer =
                    hasTaggedMaster &&
                    layerAny.master.type === 'DefaultForMaster';
                const isAssociatedLayer =
                    hasTaggedMaster &&
                    layerAny.master.type === 'AssociatedWithMaster';
                const hasBraceLocation =
                    !!layer.location && Object.keys(layer.location).length > 0;

                if (isDefaultLayer || (isAssociatedLayer && hasBraceLocation)) {
                    const masterIdStr = layerAny.master?.master || layer.id;
                    if (master_ids.has(masterIdStr)) {
                        layersData.push({
                            id: layer.id as string,
                            name: layer.name || 'Default',
                            _master: masterIdStr,
                            location: layer.location
                        });
                    }
                }
            }
        }
        const axes = this.currentFont!.babelfontData.axes || [];
        let axes_order = axes.map((axis: Babelfont.Axis) => axis.tag);

        let mastersData: any[] = [];
        for (let master of this.currentFont!.babelfontData
            .masters as Babelfont.Master[]) {
            let userspaceLocation = designspaceToUserspace(
                master.location || {},
                axes
            );
            // Extract master name from I18NDictionary (use 'en' or first available)
            let masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name?.en ||
                      Object.values(master.name || {})[0] ||
                      'Unknown';
            mastersData.push({
                id: master.id,
                name: masterName,
                location: userspaceLocation
            });
        }
        return {
            glyphName: glyph.name,
            layers: layersData,
            masters: mastersData,
            axesOrder: axes_order
        };
    }

    serializeLayerForCommittedSync(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer,
        options?: {
            preserveExistingShapes?: boolean;
            authoritativeOptionalLayerFields?: Array<
                'anchors' | 'guides' | 'format_specific'
            >;
        }
    ): Babelfont.Layer | null {
        return this.serializeLayerForStorage(
            glyphName,
            layerId,
            layerData,
            options
        );
    }

    async saveLayerData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer,
        changeSource: string = 'unknown'
    ) {
        const layerDataCopy = this.serializeLayerForStorage(
            glyphName,
            layerId,
            layerData
        );
        if (!layerDataCopy) {
            console.error(
                '[FontManager]',
                `Failed to serialize layer ${layerId} in glyph ${glyphName}`
            );
            return;
        }

        const isInteractiveEdit =
            changeSource.startsWith('mouse-drag') ||
            changeSource.startsWith('keyboard');

        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} not found - cannot save layer data`
            );
            return;
        }

        if (!glyph.layers) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} has no layers - cannot save layer data`
            );
            return;
        }

        const storedLayer = this.syncSerializedLayerIntoStoredFontData(
            glyphName,
            layerId,
            layerDataCopy
        );
        if (!storedLayer) {
            console.error(
                '[FontManager]',
                `Failed to commit stored layer ${layerId} in glyph ${glyphName}`
            );
            return;
        }

        this.syncSerializedLayerIntoObjectModel(
            glyphName,
            layerId,
            storedLayer
        );

        // Local layer saves mutate the authoritative font object in place.
        // Re-point the bridge snapshot immediately so the subsequent Yjs sync
        // diffs against the just-saved layer instead of a stale detached JSON.
        window.patchSyncEngine?.setFontJson?.(this.currentFont!.babelfontData);

        if (isInteractiveEdit) {
            this.pendingBabelfontJsonSyncAfterDrag = true;
        } else {
            if (!this.syncBabelfontJsonFromCurrentModel()) {
                return;
            }
            this.pendingBabelfontJsonSyncAfterDrag = false;
        }

        if (isInteractiveEdit) {
            this.clearEditingCompileContext();
        } else {
            const editType = changeSource.endsWith('-anchor')
                ? 'anchor'
                : changeSource.endsWith('-outline')
                  ? 'outline'
                  : null;
            this.setEditingCompileContext(changeSource, editType);
        }

        if (isInteractiveEdit) {
            this.currentFont!.markDirty(changeSource, {
                requestEditingCompile: false
            });
        } else {
            this.currentFont!.markDirty(changeSource);
        }
        await this.updateDirtyIndicator();
    }

    /** Wait for the authoritative bridge Yjs update already sent to Rust. */
    async updateWorkerFontCache(): Promise<void> {
        const run = async (): Promise<void> => {
            if (!this.currentFont) {
                return;
            }

            try {
                await fontCompilation.awaitWorkerDocumentSync();
            } catch (error) {
                console.error(
                    '[FontManager] Error waiting for authoritative worker Yjs sync:',
                    error
                );
            }
        };

        const cacheUpdatePromise = run();
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            await cacheUpdatePromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    /**
     * Re-seed the Rust worker document from the authoritative bridge state.
     * Kept for API compatibility; does not encode whole layers into Yjs.
     */
    async forceFullWorkerCacheUpdate(): Promise<void> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return;
        }

        const cacheUpdatePromise = (async () => {
            this.pendingBabelfontJsonSyncAfterDrag = false;
            await this.recoverWorkerCacheFromAuthoritativeState(
                'forceFullWorkerCacheUpdate'
            );
        })();

        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            await cacheUpdatePromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    async awaitWorkerCacheUpdate(): Promise<void> {
        if (!this.workerCacheUpdatePromise) {
            return;
        }
        try {
            await this.workerCacheUpdatePromise;
        } catch {
            // Ignore update failures here — undo/redo refresh has its own forced sync path.
        }
    }

    async refreshGlyphsAfterModelBatch(
        glyphNames: Iterable<string>,
        layerId?: string | null,
        options?: {
            dispatchGlyphChanged?: boolean;
            skipFingerprintBaseline?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
        }
    ): Promise<void> {
        const refreshPromise = (async () => {
            const currentFont = this.currentFont;
            const uniqueGlyphNames = Array.from(
                new Set(
                    Array.from(glyphNames || []).filter(
                        (glyphName): glyphName is string =>
                            typeof glyphName === 'string' &&
                            glyphName.length > 0
                    )
                )
            );

            if (!currentFont || !uniqueGlyphNames.length) {
                return;
            }

            // With PatchSyncEngine, worker mutation already flows through
            // forwardWorkerYjsUpdate; do not whole-layer encode.
            // Without a bridge, still avoid deleted submit paths — dispatch only.
            if (options?.dispatchGlyphChanged === false) {
                return;
            }

            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail:
                        uniqueGlyphNames.length === 1
                            ? {
                                  glyphName: uniqueGlyphNames[0],
                                  layerId: layerId ?? undefined
                              }
                            : {
                                  glyphName: uniqueGlyphNames[0],
                                  glyphNames: uniqueGlyphNames,
                                  layerId: layerId ?? undefined
                              }
                })
            );
        })();

        this.workerCacheUpdatePromise = refreshPromise;
        try {
            await refreshPromise;
        } finally {
            if (this.workerCacheUpdatePromise === refreshPromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    async stageLiveDragPreviewFromModel(
        glyphNamesOrTargets: Iterable<string> | Iterable<WorkerReplayTarget>,
        layerId?: string | null,
        options?: {
            dispatchGlyphChanged?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
            /** When set, use these explicit per-glyph layer targets instead of
             *  glyph-names + a shared source layerId. */
            layerTargets?: Iterable<WorkerReplayTarget>;
        }
    ): Promise<void> {
        const explicitTargets = normalizeWorkerReplayTargets(
            options?.layerTargets ??
                (Array.from(glyphNamesOrTargets as Iterable<unknown>).every(
                    (entry) =>
                        entry &&
                        typeof entry === 'object' &&
                        typeof (entry as WorkerReplayTarget).glyphName ===
                            'string' &&
                        typeof (entry as WorkerReplayTarget).layerId ===
                            'string'
                )
                    ? (glyphNamesOrTargets as Iterable<WorkerReplayTarget>)
                    : null)
        );

        const uniqueGlyphNames =
            explicitTargets.length > 0
                ? Array.from(
                      new Set(explicitTargets.map((target) => target.glyphName))
                  )
                : Array.from(
                      new Set(
                          Array.from(
                              glyphNamesOrTargets as Iterable<string>
                          ).filter(
                              (glyphName): glyphName is string =>
                                  typeof glyphName === 'string' &&
                                  glyphName.length > 0
                          )
                      )
                  );

        if (!this.currentFont || uniqueGlyphNames.length === 0) {
            return;
        }

        const previewPromise = (async () => {
            const pendingLayerUpdates =
                explicitTargets.length > 0
                    ? this.collectChangedLayerUpdatesFromTargets(
                          explicitTargets,
                          {
                              skipFingerprintBaseline: true,
                              compileFacing: true,
                              ...(options?.explicitLayerData
                                  ? {
                                        explicitLayerData:
                                            options.explicitLayerData
                                    }
                                  : undefined)
                          }
                      )
                    : this.collectChangedLayerUpdatesFromModel(
                          uniqueGlyphNames,
                          layerId,
                          {
                              skipFingerprintBaseline: true,
                              compileFacing: true,
                              ...(options?.explicitLayerData
                                  ? {
                                        explicitLayerData:
                                            options.explicitLayerData
                                    }
                                  : undefined)
                          }
                      );

            const updatedIncrementally =
                !!pendingLayerUpdates &&
                pendingLayerUpdates.length > 0 &&
                (await this.submitLayerUpdatesToWorkerPreview(
                    pendingLayerUpdates
                ));

            if (!updatedIncrementally) {
                throw new Error(
                    'Incremental worker preview overlay failed during live drag refresh'
                );
            }
        })();

        this.workerCacheUpdatePromise = previewPromise;
        try {
            await previewPromise;
        } finally {
            if (this.workerCacheUpdatePromise === previewPromise) {
                this.workerCacheUpdatePromise = null;
            }
        }

        if (options?.dispatchGlyphChanged === false) {
            return;
        }

        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail:
                    explicitTargets.length === 1
                        ? {
                              glyphName: explicitTargets[0].glyphName,
                              layerId: explicitTargets[0].layerId
                          }
                        : explicitTargets.length > 1
                          ? {
                                glyphName: explicitTargets[0].glyphName,
                                glyphNames: uniqueGlyphNames,
                                layerTargets: explicitTargets
                            }
                          : uniqueGlyphNames.length === 1
                            ? {
                                  glyphName: uniqueGlyphNames[0],
                                  layerId: layerId ?? undefined
                              }
                            : {
                                  glyphName: uniqueGlyphNames[0],
                                  glyphNames: uniqueGlyphNames,
                                  layerId: layerId ?? undefined
                              }
            })
        );
    }

    clearLiveDragPreview(): void {
        if (!fontCompilation?.isInitialized) {
            return;
        }

        this.enqueueWorkerPreviewSend(async () => {
            try {
                await fontCompilation.sendMessage({
                    type: 'clearPreviewLayerOverlay'
                });
            } catch (error) {
                console.warn(
                    '[FontManager] Failed to clear worker preview layer overlay:',
                    error
                );
            }
        });
    }

    async submitLayerToWorkerCache(
        glyphName: string,
        layerId: string
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }

        const glyph = this.currentFont.fontModel?.glyphs?.find(
            (entry: any) => entry?.name === glyphName
        );
        const layer = glyph?.layers?.find(
            (entry: any) => entry?.id === layerId
        );
        if (!layer) {
            return false;
        }

        const rawLayerData =
            typeof layer.toJSON === 'function' ? layer.toJSON() : layer;
        const serializedLayer = this.serializeLayerForStorage(
            glyphName,
            layerId,
            rawLayerData
        );
        if (!serializedLayer) {
            return false;
        }

        try {
            await fontCompilation.awaitWorkerDocumentSync();
        } catch {
            return false;
        }

        const normalized = this.normalizeLayerForRust(serializedLayer);
        this.workerLayerFingerprintCache.set(
            this.getWorkerLayerFingerprintKey(glyphName, layerId),
            JSON.stringify(normalized)
        );
        return true;
    }
}

// Create singleton instance when page loads
let fontManager: FontManager = new FontManager();

// Expose to window for global access (needed by object model dirty flag tracking)
(window as any).fontManager = fontManager;

// Initialize global font model reference
window.currentFontModel = null;

document.addEventListener('DOMContentLoaded', () => {
    fontManager.init();
});
export default fontManager;

// Wait for font compilation system to be ready
async function fontCompilationReady(): Promise<boolean> {
    if (fontCompilation?.isInitialized) {
        return true;
    }

    const initialized = await fontCompilation.initialize();
    if (!initialized) {
        console.error(
            '[FontManager]',
            '❌ Font compilation system not ready after initialization'
        );
        return false;
    }

    return true;
}

function createOpenSessionId(): string {
    return `open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitOpenLifecycle(
    openSessionId: string,
    phase: string,
    extra: Record<string, unknown> = {}
): void {
    timelineMark(`font.lifecycle.${phase}`);
    window.dispatchEvent(
        new CustomEvent('fontOpenLifecycle', {
            detail: {
                openSessionId,
                phase,
                timestamp: performance.now(),
                ...extra
            }
        })
    );
}

// Listen for font loaded events from file browser
window.addEventListener('fontLoaded', async (event: Event) => {
    // Disconnect any active cloud room before loading a new font, so edits to
    // the incoming font don't leak into the previous font's cloud room, and
    // remote updates from the old room don't contaminate the new font's Y.Doc.
    window.cloudPlugin?.disconnectFromRoom?.();

    if (!(await fontCompilationReady())) {
        return;
    }

    const openSessionSpanId = timelineSpanStart('font.openSession');

    let fullCompileDeferredTimer: number | null = null;
    let canvasReadyListener: ((event: Event) => void) | null = null;
    let startupReleased = false;
    let startupInteractivityReleased = false;
    let startupFinalizeStarted = false;
    let canvasReady = false;
    let fontReadyDispatched = false;
    let activeOpenSessionDetail: {
        path: string;
        openSessionId: string;
        openedAt: number;
    } | null = null;

    const dispatchFontReadyIfNeeded = (openSessionId: string) => {
        if (fontReadyDispatched || !activeOpenSessionDetail) {
            return;
        }

        if (activeOpenSessionDetail.openSessionId !== openSessionId) {
            return;
        }

        window.dispatchEvent(
            new CustomEvent('fontReady', {
                detail: {
                    path: activeOpenSessionDetail.path,
                    openSessionId: activeOpenSessionDetail.openSessionId,
                    openedAt: activeOpenSessionDetail.openedAt
                }
            })
        );

        fontReadyDispatched = true;
        emitOpenLifecycle(openSessionId, 'fontReadyDispatched');
    };

    const releaseStartupInteractivity = (
        openSessionId: string,
        reason: string
    ) => {
        if (startupInteractivityReleased) {
            return;
        }

        startupInteractivityReleased = true;

        window.autoCompileManager?.setStartupBlocked?.(false);

        emitOpenLifecycle(openSessionId, 'startupInteractivityReleased', {
            reason
        });

        endStartupInteractionLock();

        window.dispatchEvent(
            new CustomEvent('fontInteractiveReady', {
                detail: {
                    path: activeOpenSessionDetail?.path ?? null,
                    openSessionId,
                    openedAt: activeOpenSessionDetail?.openedAt ?? null
                }
            })
        );
    };

    const finalizeStartupReadiness = async (openSessionId: string) => {
        if (startupFinalizeStarted || !canvasReady) {
            return;
        }

        startupFinalizeStarted = true;

        try {
            if (window.glyphCanvas) {
                await ensureStartupStateReady(window.glyphCanvas);
            }

            emitOpenLifecycle(openSessionId, 'startupStateReady');
            releaseStartupGates(openSessionId, 'canvas+state-ready');
        } catch (error) {
            console.warn(
                '[FontManager]',
                'Startup state restore failed before fontReady; continuing:',
                error
            );
            releaseStartupGates(openSessionId, 'canvas+state-error');
        }
    };

    const releaseStartupGates = (openSessionId: string, reason: string) => {
        if (startupReleased) {
            return;
        }

        startupReleased = true;

        startupOpenSessionActive = false;
        startupOpenSessionEditingCompileCount = 0;
        startupCompiledSubsetKey = '';

        if (canvasReadyListener) {
            window.removeEventListener(
                'canvasInitialReady',
                canvasReadyListener
            );
            canvasReadyListener = null;
        }

        if (fullCompileDeferredTimer !== null) {
            clearTimeout(fullCompileDeferredTimer);
            fullCompileDeferredTimer = null;
        }

        if (!startupInteractivityReleased) {
            window.autoCompileManager?.setStartupBlocked?.(false);
        }

        emitOpenLifecycle(openSessionId, 'startupReleased', {
            reason
        });

        if (!startupInteractivityReleased) {
            endStartupInteractionLock();
            startupInteractivityReleased = true;
        }

        endLoadingCursor();

        timelineSpanEnd(openSessionSpanId);
        dispatchFontReadyIfNeeded(openSessionId);
    };

    try {
        // Get the babelfont JSON from the event
        const detail = (event as CustomEvent).detail;
        const openSessionId = createOpenSessionId();
        const openedAt = performance.now();

        // Each open must re-run URL/state restore; otherwise a concurrent setFont
        // can keep stomping axes to the font default after the first session.
        resetStartupStateReady();

        activeOpenSessionDetail = {
            path: detail.path,
            openSessionId,
            openedAt
        };

        startupOpenSessionActive = true;
        startupOpenSessionEditingCompileCount = 0;
        startupCompiledSubsetKey = '';
        beginStartupInteractionLock();

        emitOpenLifecycle(openSessionId, 'fontLoaded', {
            path: detail.path,
            sourcePluginId: detail.sourcePlugin?.id || null
        });

        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.lastStoredFontJson = null;
        fontCompilation.pendingStoreFontJsonPayload = null;
        fontCompilation.pendingStoreFontJsonPromise = null;
        fontCompilation.lastEditingSubsetKey = null;
        fullFontCompilation.setWorkerCacheDocumentReady(false);
        fullFontCompilation.lastStoredFontJson = null;
        fullFontCompilation.pendingStoreFontJsonPayload = null;
        fullFontCompilation.pendingStoreFontJsonPromise = null;
        fullFontCompilation.lastEditingSubsetKey = null;

        window.autoCompileManager?.setStartupBlocked?.(true);

        // Load font into font manager
        await fontManager!.loadFont(
            detail.babelfontJson,
            detail.path,
            detail.sourcePlugin,
            detail.fileHandle,
            detail.directoryHandle
        );

        emitOpenLifecycle(openSessionId, 'loadFontComplete', {
            openedAt
        });

        releaseStartupInteractivity(openSessionId, 'font-model-ready');

        canvasReadyListener = (canvasEvent: Event) => {
            const canvasDetail = (canvasEvent as CustomEvent).detail;
            if (
                canvasDetail?.openSessionId &&
                canvasDetail.openSessionId !== openSessionId
            ) {
                return;
            }

            canvasReady = true;
            emitOpenLifecycle(openSessionId, 'canvasInitialReady');
            releaseStartupInteractivity(openSessionId, 'canvas-ready');
            void finalizeStartupReadiness(openSessionId);
        };

        window.addEventListener('canvasInitialReady', canvasReadyListener);

        // Update display
        await fontManager!.onOpened();

        emitOpenLifecycle(openSessionId, 'onOpenedComplete');

        // Trigger initial editing compile and capture the first result.
        emitOpenLifecycle(openSessionId, 'editingCompileStart');
        window.addEventListener(
            'editingFontCompiled',
            () => {
                const editingCompileElapsedMs = performance.now() - openedAt;
                emitOpenLifecycle(openSessionId, 'editingCompileComplete', {
                    elapsedMs: editingCompileElapsedMs
                });
            },
            { once: true }
        );

        fontManager!.compileEditingFont().catch((error) => {
            console.error(
                '[FontManager]',
                'Initial editing compile failed:',
                error
            );
        });

        fullCompileDeferredTimer = window.setTimeout(() => {
            emitOpenLifecycle(openSessionId, 'startup-ready-timeout-waiting', {
                canvasReady,
                startupFinalizeStarted
            });

            if (window.glyphCanvas && !startupFinalizeStarted) {
                void ensureStartupStateReady(window.glyphCanvas)
                    .catch((error) => {
                        console.warn(
                            '[FontManager]',
                            'Startup state restore timed out waiting for canvas; enabling sync anyway:',
                            error
                        );
                    })
                    .finally(() => {
                        releaseStartupGates(
                            openSessionId,
                            'startup-ready-timeout'
                        );
                    });
                return;
            }

            releaseStartupGates(openSessionId, 'startup-ready-timeout');
        }, 8000);
    } catch (error) {
        releaseStartupGates('open-unknown', 'error');
        timelineMark('font.openSession.error');

        console.error('[FontManager]', 'Failed to initialize font manager:');
        console.error(
            '[FontManager]',
            'Error message:',
            error instanceof Error ? error.message : String(error)
        );
        console.error(
            '[FontManager]',
            'Error stack:',
            error instanceof Error ? error.stack : 'No stack'
        );
        console.error('[FontManager]', 'Raw error object:', error);

        // Error will be shown in sidebar by the error handlers above
    }
});
