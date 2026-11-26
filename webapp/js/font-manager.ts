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
    adoptTransferredUint8Array,
    isTerminalWorkerDocumentError,
    markTerminalWorkerDocumentError,
    terminalWorkerErrorDocumentId
} from './font-compilation';
import { get_glyph_order } from './opentype-table-reader';
import { prepareCompileFilters } from './compile-filter-host';
import { callSourceWasmOp } from './source-wasm-ops';
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
    withSuppressedModelRecording,
    jsonPartsToChunks,
    jsonPartsToData,
    isEmptyYjsUpdate,
    type AxisStationCopyPlan,
    type BabelfontJsonParts
} from './babelfont-model';
import {
    canonicalizeImportedFontJson,
    canonicalizeImportedGlyphs
} from './font-import-canonicalization';
import {
    designspaceUfoDirs,
    FolderSaveTracker,
    FolderSourceState,
    folderSourceFormatForPath,
    folderSourceRoot,
    hashBytes,
    isFolderSourceFile,
    isGlyphFile,
    joinSourcePath,
    readFolderSource,
    type FolderSourceFormat
} from './folder-source';
import { compilationPlan, type CompileEditStamp } from './edit-intent';
import {
    jsonToYDoc,
    fromYDrawing,
    fromYType,
    getYPath
} from './change-bridge-ydoc';
import {
    describeDrawingStationViolation,
    describeRestingDrawingViolation,
    omitRestingDrawingRuntimeKeys,
    toRestingDrawingJson,
    toRestingShapeJson
} from './resting-drawing-json';
import { sidebarErrorDisplay } from './sidebar-error-display';
import type { FilesystemPlugin } from './filesystem-plugins';
import type { FontModelReadyDetail } from './change-bridge-init';
import { FONT_DEPS_DOCUMENT_ID } from './filesystem-plugins/cloud-document-set';
import { catalogBucketOfDocument } from './filesystem-plugins/cloud-room-layout';
import {
    LocalSparseHydrator,
    sanitizeGlyphEmptyReferenceComponents,
    type LocalSparseBootstrapPayload
} from './local-sparse-hydrator';
import { Logger } from './logger';
import type {
    LivePreviewCompile,
    LivePreviewDrawingRecord
} from './linked-live-preview';
import {
    showProceedDialog,
    showUnsavedChangesDialog
} from './ui/confirm-dialog';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

const NO_OP_YJS_UPDATE = new Uint8Array([0, 0]);

/**
 * Core Arabic joining letters and common harakat pre-warmed on the first
 * interactive Arabic keystroke so typing an Arabic sentence compiles once
 * instead of triggering a fresh WASM compile on every unseen character.
 */
const ARABIC_CORE_TYPING_CODEPOINTS: readonly number[] = [
    0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629,
    0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f, 0x0630, 0x0631, 0x0632,
    0x0633, 0x0634, 0x0635, 0x0636, 0x0637, 0x0638, 0x0639, 0x063a, 0x0641,
    0x0642, 0x0643, 0x0644, 0x0645, 0x0646, 0x0647, 0x0648, 0x0649, 0x064a,
    0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651, 0x0652
];
const MAX_STICKY_TYPING_GLYPHS = 120;
import {
    beginLoadingCursor,
    endLoadingCursor,
    withLoadingCursor
} from './loading-cursor';
import {
    ensureStartupStateReady,
    isStartupStateReady,
    resetStartupStateReady
} from './state-restore';
import {
    decodeFeatures,
    formatUrl,
    readUrlState,
    updateUrlState
} from './url-state';
import {
    catalogEntriesForDepsParse,
    closeComponentNamesFromFontJson,
    closeReverseComponentNamesFromDeps,
    layoutSubstitutionNamesFromSeeds,
    readFontDepsIndex,
    seedGlyphIdsFromText
} from './filesystem-plugins/cloud-font-deps';
import {
    normalizeWorkerReplayTargets,
    type WorkerReplayTarget
} from './change-log';
import {
    beginStartupInteractionLock,
    endStartupInteractionLock
} from './startup-interaction-lock';
import {
    cancelManagedFileInternalWrite,
    markManagedFileInternalWrite,
    normalizeManagedPath
} from './managed-file-events';
import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { getTheme } from './tippy-utils';

/** Files written for a folder source, by path relative to its folder. */
type FolderSourceEntries = { files: Record<string, string>; removed: string[] };

const FOLDER_WRITE_CONCURRENCY = 8;

const console = new Logger('FontManager');

/** A live stage older than this is not posted to linked windows. */
const LINKED_PREVIEW_STAGE_MAX_AGE_MS = 1000;

/** A plain copy of drawing data that any window message can carry. */
function toPlainDrawingData<T>(drawingData: T): T {
    return JSON.parse(JSON.stringify(drawingData)) as T;
}

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

/** A Glyphs file format version Counterpunch can save in. */
export type GlyphsFormatVersion = 3 | 4;

const GLYPHS_FORMAT_VERSION_KEY = 'com.schriftgestalt.Glyphs.formatVersion';
const GLYPHS_SAVE_FORMAT_VERSION_KEY =
    'com.schriftgestalt.Glyphs.saveFormatVersion';

/**
 * The Glyphs file format version a font was read in (a Glyphs 2 file counts
 * as 3, the oldest one Counterpunch writes), or null for a font that does
 * not come from a Glyphs file.
 */
export function glyphsFormatVersionOf(
    data: unknown
): GlyphsFormatVersion | null {
    const formatSpecific = (
        data as { format_specific?: Record<string, unknown> } | null
    )?.format_specific;
    const version = Number(formatSpecific?.[GLYPHS_FORMAT_VERSION_KEY]);
    if (!Number.isFinite(version) || version <= 0) {
        return null;
    }
    return version >= 4 ? 4 : 3;
}

/** Asks the Glyphs writer for `version`, when one was chosen. */
function withGlyphsSaveVersion(
    data: unknown,
    version: GlyphsFormatVersion | null
): unknown {
    if (!version || !data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
    }
    const font = data as { format_specific?: Record<string, unknown> };
    font.format_specific = {
        ...(font.format_specific ?? {}),
        [GLYPHS_SAVE_FORMAT_VERSION_KEY]: version
    };
    return data;
}

/** V8's string length limit; other engines allow longer strings. */
const MAX_JS_STRING_LENGTH = 2 ** 29 - 24;
let maxJsStringLength = MAX_JS_STRING_LENGTH;

/** Lower the string length limit so tests can save a "too large" font. */
export function setMaxJsStringLengthForTests(length: number | null): void {
    maxJsStringLength = length ?? MAX_JS_STRING_LENGTH;
}

/**
 * A font's `.babelfont` JSON: one string, or split at its glyphs
 * (`Font.toJSONParts`) when one string could go over the string length limit.
 */
export type BabelfontJsonSource = string | BabelfontJsonParts;

/** The parsed value of `source`. */
function babelfontSourceData(source: BabelfontJsonSource): unknown {
    return typeof source === 'string'
        ? JSON.parse(source)
        : jsonPartsToData(source);
}

/** The text of `source` as one string, or null when it is too long for one. */
function joinedBabelfontSource(source: BabelfontJsonSource): string | null {
    if (typeof source === 'string') {
        return source;
    }
    const chunks = jsonPartsToChunks(source);
    let length = 0;
    for (const chunk of chunks) {
        length += chunk.length;
    }
    return length <= maxJsStringLength ? chunks.join('') : null;
}

/**
 * The `.babelfont` file text of `source`: one string when it fits, else its
 * UTF-8 bytes. The chunks split between JSON tokens, so each encodes alone.
 */
function babelfontFileContents(
    source: BabelfontJsonSource
): string | Uint8Array<ArrayBuffer> {
    const joined = joinedBabelfontSource(source);
    if (joined !== null) {
        return joined;
    }
    const encoder = new TextEncoder();
    const encoded = jsonPartsToChunks(source as BabelfontJsonParts).map(
        (chunk) => encoder.encode(chunk)
    );
    let length = 0;
    for (const bytes of encoded) {
        length += bytes.length;
    }
    const contents = new Uint8Array(length);
    let offset = 0;
    for (const bytes of encoded) {
        contents.set(bytes, offset);
        offset += bytes.length;
    }
    return contents;
}

/**
 * `source` for a Rust serializer, which reads JSON whatever its whitespace:
 * the indented text when it fits in one string, else compact JSON.
 */
function rustBabelfontInput(source: BabelfontJsonSource): string {
    return (
        joinedBabelfontSource(source) ??
        JSON.stringify(babelfontSourceData(source))
    );
}

/** The UTF-8 bytes of saved file contents. */
export function fileContentsBytes(contents: string | Uint8Array): Uint8Array {
    return typeof contents === 'string'
        ? new TextEncoder().encode(contents)
        : contents;
}

/**
 * Serialize a local sparse font directly from `fontc-worker`'s complete
 * resident `FONT_CACHE`, avoiding any main-thread full-font JSON build.
 */
export async function serializeCachedLocalFontForSourceSave(
    path: string
): Promise<string> {
    const extension = path.split('.').pop()?.toLowerCase();
    await fontCompilation.awaitWorkerDocumentReadyForCompile();
    if (extension === 'babelfont') {
        return callSourceWasmOp('export_cached_font_as_babelfont_json', []);
    }
    if (extension === 'glyphs') {
        return callSourceWasmOp('save_cached_font_as_glyphs', []);
    }
    throw new Error(
        `Cannot save ${path} in its original format: source saving supports .babelfont, .glyphs, .glyphspackage, .ufo and .designspace sources. Use Save As to save it in one of those.`
    );
}

export async function serializeFontForSourceSave(
    path: string,
    source: BabelfontJsonSource,
    glyphsVersion: GlyphsFormatVersion | null = null
): Promise<string | Uint8Array<ArrayBuffer>> {
    const extension = path.split('.').pop()?.toLowerCase();

    if (extension === 'babelfont') {
        return babelfontFileContents(source);
    }

    if (extension === 'glyphs') {
        const glyphsSerializationInput = JSON.stringify(
            withGlyphsSaveVersion(
                stampPathBooleanFlagsForGlyphsSave(babelfontSourceData(source)),
                glyphsVersion
            )
        );
        return callSourceWasmOp('save_font_as_glyphs', [
            glyphsSerializationInput
        ]);
    }

    throw new Error(
        `Cannot save ${path} in its original format: source saving supports .babelfont, .glyphs, .glyphspackage, .ufo and .designspace sources. Use Save As to save it in one of those.`
    );
}

/**
 * Serialize a font as the files of a folder source: with `glyphs`, only those
 * glyphs' files (plus font-level files with `fontLevel`). Returns null when a
 * partial save cannot express the change and the whole source must be saved.
 */
export async function serializeFolderSourceEntries(
    format: FolderSourceFormat,
    source: BabelfontJsonSource,
    request: {
        glyphs: string[] | null;
        fontLevel: boolean;
        layoutEntries: Record<string, string>;
        /** Designspace: the document's file name. */
        document?: string;
    },
    glyphsVersion: GlyphsFormatVersion | null = null
): Promise<FolderSourceEntries | null> {
    const input =
        format === 'glyphspackage'
            ? JSON.stringify(
                  withGlyphsSaveVersion(
                      stampPathBooleanFlagsForGlyphsSave(
                          babelfontSourceData(source)
                      ),
                      glyphsVersion
                  )
              )
            : rustBabelfontInput(source);
    const result = JSON.parse(
        await callSourceWasmOp('save_font_source_entries', [
            format,
            input,
            JSON.stringify(request)
        ])
    ) as FolderSourceEntries | { needsFullSave: string };
    if ('needsFullSave' in result) {
        console.log(`Saving the whole source: ${result.needsFullSave}`);
        return null;
    }
    return result;
}

/** Runs `task` over `items`, `concurrency` at a time. */
async function forEachConcurrently<T>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<void>
): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            await task(items[next++]);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
}

/** The file's bytes, or null when it no longer exists or is a directory. */
async function readSourceFileOrNull(
    sourcePlugin: FilesystemPlugin,
    path: string
): Promise<Uint8Array | null> {
    try {
        const content = await sourcePlugin.getAdapter().readFile(path);
        return typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;
    } catch {
        return null;
    }
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
        const drawings = (glyph as { layers?: unknown }).layers;
        if (!Array.isArray(drawings)) {
            continue;
        }
        for (const drawing of drawings) {
            if (!drawing || typeof drawing !== 'object') {
                continue;
            }
            const shapes = (drawing as { shapes?: unknown }).shapes;
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
        _station: string;
        location?: DesignspaceLocation;
    }[];
    masters: {
        id: string;
        name: string;
        location: UserspaceLocation;
    }[];
    axesOrder: string[];
};

export type RustBatchDrawingTarget = {
    glyphName: string;
    layerId: string;
};

export type RustBatchMetadata = {
    changedGlyphs: string[];
    layerTargets: RustBatchDrawingTarget[];
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
    instancesOperation?: {
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
    if (!isEmptyYjsUpdate(result.update)) {
        return true;
    }
    return Boolean(
        result.updates?.some((packet) => !isEmptyYjsUpdate(packet.update))
    );
}

export type AddStationInterpolationLocation = {
    glyphName: string;
    designLocation: DesignspaceLocation;
};

type DrawingCacheUpdate = {
    glyphName: string;
    layerId: string;
    layerData: Babelfont.Layer;
};

type ExplicitDrawingCacheInput = DrawingCacheUpdate;

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
    /** Total number of drawing entries crossed in batches. */
    drawingsTransmitted: number;
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
 * `getDrawingFingerprintsFromStoredJson` to avoid re-parsing the
 * megabyte-scale `babelfontJson` on every commit batch.
 */
const EMPTY_FINGERPRINT_MAP: Map<string, string> = new Map();

class FontDataIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FontDataIntegrityError';
    }
}

type SerializableDrawingRecord = {
    id?: string;
    width?: number | null;
};

type SerializableGlyphRecord = {
    name?: string;
    layers?: SerializableDrawingRecord[];
};

type SerializableFontRecord = {
    glyphs?: SerializableGlyphRecord[];
};

function assertFiniteDrawingWidth(
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
    const drawingId = context.layerId || '[unknown drawing]';
    throw new FontDataIntegrityError(
        `Drawing ${glyphName}/${drawingId} has invalid width during ${context.operation}; refusing to serialize malformed drawing data.`
    );
}

function assertBabelfontDrawingWidths(
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

        for (const drawing of glyph.layers) {
            assertFiniteDrawingWidth(drawing?.width, {
                glyphName: glyph?.name,
                layerId: drawing?.id,
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
    selectedDrawingId: string | null;
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
    editType: CompileEditStamp;
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

/** What a font's source held when read; see OpenedFont.folderSource. */
export type SourceSnapshot = {
    folderSource?: FolderSourceState;
    sourceFileHash?: string;
};

/** Remember what `font`'s source held when last read. */
function applySourceSnapshot(font: OpenedFont, snapshot: SourceSnapshot): void {
    if (snapshot.folderSource) {
        font.folderSource = snapshot.folderSource;
    }
    if (snapshot.sourceFileHash) {
        font.sourceFileHash = snapshot.sourceFileHash;
    }
}

class OpenedFont {
    /** Serialized model; null until read after import or a sync. */
    private _babelfontJson: string | null = null;
    /** Goes up whenever the serialization may have changed. */
    serializationEpoch = 0;
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
    /** A folder source's (.ufo, .glyphspackage) files as last read or written. */
    folderSource?: FolderSourceState;
    /** What changed since the last save, so that saving writes only that. */
    folderSaveTracker: FolderSaveTracker;
    /** A single-file source's content hash as last read or written. */
    sourceFileHash?: string;
    /**
     * The Glyphs file format version to save in, as chosen in Save As; null
     * saves in the version the font was read in.
     */
    glyphsSaveVersion: GlyphsFormatVersion | null = null;

    constructor(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        const canonicalImport = canonicalizeImportedFontJson(babelfontJson);
        this.babelfontData = canonicalImport.fontData;
        this.sourcePlugin = sourcePlugin;
        this.fileHandle = fileHandle;
        this.directoryHandle = directoryHandle;

        assertBabelfontDrawingWidths(
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
        this.folderSaveTracker = new FolderSaveTracker();
    }

    /**
     * The font as `.babelfont` JSON. Import and sync do not build it: for a
     * large font (17,000 CJK glyphs) the string goes over the engine's
     * string length limit. A read serializes the model. Code that must work
     * for any font uses `babelfontJsonSource` or `serializedFontData`.
     */
    get babelfontJson(): string {
        if (this._babelfontJson !== null) {
            return this._babelfontJson;
        }
        return this.fontModel.toJSONString({
            compileFacing: false
        });
    }

    set babelfontJson(json: string) {
        this._babelfontJson = json;
        this.serializationEpoch++;
    }

    /** The serialized font if built, without serializing it. */
    get builtBabelfontJson(): string {
        return this._babelfontJson ?? '';
    }

    /** The `.babelfont` JSON as one string if built, otherwise glyph by glyph. */
    babelfontJsonSource(): string | BabelfontJsonParts {
        return (
            this._babelfontJson ??
            this.fontModel.toJSONParts({ compileFacing: false })
        );
    }

    /** The parsed `.babelfont` JSON, built without one whole-font string. */
    serializedFontData(): Record<string, unknown> {
        const source = this.babelfontJsonSource();
        return typeof source === 'string'
            ? (JSON.parse(source) as Record<string, unknown>)
            : jsonPartsToData(source);
    }

    /** Install a font object already built from a linked-window snapshot. */
    static fromResidentData(
        fontData: Record<string, unknown>,
        fontModel: Font,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ): OpenedFont {
        const opened = Object.create(OpenedFont.prototype) as OpenedFont;
        opened.babelfontData = fontData;
        opened.fontModel = fontModel;
        opened._babelfontJson = null;
        opened.serializationEpoch = 0;
        opened.sourcePlugin = sourcePlugin;
        opened.fileHandle = fileHandle;
        opened.directoryHandle = directoryHandle;
        opened.path = path;
        opened.name =
            (fontData as { names?: { family_name?: { dflt?: string } } })?.names
                ?.family_name?.dflt || 'Untitled Font';
        opened.needsRecompile = false;
        opened.hasUnsavedChanges = false;
        opened.changeVersion = 0;
        opened.compileRequestVersion = 0;
        opened.folderSaveTracker = new FolderSaveTracker();
        return opened;
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
            keepPendingCompile?: boolean;
            compileContext?: EditingCompileContext | null;
        }
    ): void {
        const requestEditingCompile = options?.requestEditingCompile !== false;
        this.needsRecompile =
            requestEditingCompile ||
            (options?.keepPendingCompile === true && this.needsRecompile);
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
     * Sync the serialized font from the object model data.
     * Call this after making changes through the object model.
     * Path nodes are arrays in both runtime and serialized storage JSON.
     * The next read of `babelfontJson` serializes the model again.
     */
    syncJsonFromModel(): void {
        assertBabelfontDrawingWidths(this.babelfontData, 'syncJsonFromModel');
        this.normalizeComponentTransformsForRust(this.babelfontData.glyphs);

        // `babelfontJson` backs bridge/worker seeding and must retain logical
        // automatic component placement. Rust owns physicalization at
        // compile-read; only explicit export asks for compile-facing JSON.
        this._babelfontJson = null;
        this.serializationEpoch++;
    }

    /** Prepare the glyphs' components for the Rust serializers. */
    private normalizeComponentTransformsForRust(
        glyphs: Babelfont.Glyph[] | undefined
    ): void {
        for (const glyph of glyphs || []) {
            for (const drawing of glyph.layers || []) {
                if (!drawing?.shapes) continue;

                for (let i = 0; i < drawing.shapes.length; i++) {
                    const shape = drawing.shapes[i];

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
    }

    /**
     * Save font using the source plugin's adapter
     */
    /** Every save, from any backend, shows the busy cursor while it runs. */
    save(): Promise<void> {
        return withLoadingCursor(() => this.saveToSource());
    }

    private async saveToSource(): Promise<void> {
        const folderFormat = folderSourceFormatForPath(this.path);
        if (folderFormat) {
            await this.saveFolderSource(folderFormat);
            return;
        }
        const pluginId = this.sourcePlugin.getId();
        let serializedFont: string | Uint8Array<ArrayBuffer>;
        if (window.fontManager?.isLocalSparseFont?.()) {
            serializedFont = await serializeCachedLocalFontForSourceSave(
                this.path
            );
        } else {
            this.syncJsonFromModel();
            serializedFont = await serializeFontForSourceSave(
                this.path,
                this.babelfontJsonSource(),
                this.glyphsSaveVersion
            );
        }

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
        await this.sourcePlugin.afterSave({
            fontName: this.name,
            ...this.folderSaveTracker.summary(this.hasUnsavedChanges)
        });
        this.folderSaveTracker.reset();
        this.sourceFileHash = hashBytes(fileContentsBytes(serializedFont));

        // Clear unsaved/sync flags after successful save
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
    }

    /**
     * Save a folder source, writing only the files whose content changed:
     * a glyph edit rewrites that glyph's file. Files a save makes obsolete
     * (a deleted or renamed glyph's) are removed.
     */
    private async saveFolderSource(format: FolderSourceFormat): Promise<void> {
        const state = this.folderSource;
        if (!state) {
            throw new Error(
                `Cannot save ${this.path}: open it from its folder to save it.`
            );
        }
        const adapter = this.sourcePlugin.getAdapter();
        if (adapter.checkPermission && adapter.requestPermission) {
            if (
                (await adapter.checkPermission()) !== 'granted' &&
                (await adapter.requestPermission()) !== 'granted'
            ) {
                throw new Error('Write permission not granted');
            }
        }

        const plan = this.folderSaveTracker.plan(
            format,
            this.hasUnsavedChanges
        );
        const root = folderSourceRoot(this.path, format);
        const layoutEntries = state.layoutEntries();
        const document = state.layout.document;
        let entries: FolderSourceEntries | null = null;
        const useCachedLocalSparse =
            window.fontManager?.isLocalSparseFont?.() === true;
        if (!plan.full) {
            if (useCachedLocalSparse) {
                const parsed = JSON.parse(
                    await callSourceWasmOp('save_cached_font_source_entries', [
                        format,
                        JSON.stringify({
                            glyphs: plan.glyphs,
                            fontLevel: plan.fontLevel,
                            layoutEntries,
                            document
                        })
                    ])
                ) as FolderSourceEntries | { needsFullSave: string };
                entries = 'needsFullSave' in parsed ? null : parsed;
            } else {
                entries = await serializeFolderSourceEntries(
                    format,
                    this.folderSourceJson(new Set(plan.glyphs)),
                    {
                        glyphs: plan.glyphs,
                        fontLevel: plan.fontLevel,
                        layoutEntries,
                        document
                    },
                    this.glyphsSaveVersion
                );
            }
        }
        let stale: string[];
        if (entries) {
            stale = entries.removed.filter((path) => state.has(path));
            if (format === 'glyphspackage' && plan.fontLevel) {
                // The font-level files of a package are all written, so one
                // not written any more (a removed feature's) is stale.
                const written = new Set(Object.keys(entries.files));
                stale.push(
                    ...state
                        .managedPaths()
                        .filter(
                            (path) =>
                                !isGlyphFile(state.layout, path) &&
                                !written.has(path) &&
                                !stale.includes(path)
                        )
                );
            }
        } else {
            if (useCachedLocalSparse) {
                entries = JSON.parse(
                    await callSourceWasmOp('save_cached_font_source_entries', [
                        format,
                        JSON.stringify({
                            glyphs: null,
                            fontLevel: true,
                            layoutEntries,
                            document
                        })
                    ])
                ) as FolderSourceEntries;
            } else {
                entries = (await serializeFolderSourceEntries(
                    format,
                    this.folderSourceJson(null),
                    { glyphs: null, fontLevel: true, layoutEntries, document },
                    this.glyphsSaveVersion
                )) as FolderSourceEntries;
            }
            const written = new Set(Object.keys(entries.files));
            stale = state.managedPaths().filter((path) => !written.has(path));
        }

        // A designspace may have gained or lost UFOs; their files belong to
        // the project from this save on.
        if (document && entries.files[document] !== undefined) {
            state.setUfoDirs(await designspaceUfoDirs(entries.files[document]));
        }

        const pluginId = this.sourcePlugin.getId();
        const changed = Object.entries(entries.files).filter(
            ([path, text]) => !state.isUnchanged(path, text)
        );
        await forEachConcurrently(
            changed,
            FOLDER_WRITE_CONCURRENCY,
            async ([relativePath, text]) => {
                const path = joinSourcePath(root, relativePath);
                markManagedFileInternalWrite(pluginId, path);
                await adapter.writeFile(path, text);
                state.record(relativePath, text);
            }
        );
        for (const relativePath of stale) {
            await adapter.deleteItem(joinSourcePath(root, relativePath), false);
            state.forget(relativePath);
        }
        console.log(
            `Saved ${this.path}: ${changed.length} file(s) written, ${stale.length} removed`
        );
        await this.sourcePlugin.afterSave({
            fontName: this.name,
            glyphs: plan.full ? null : plan.glyphs,
            fontLevel: plan.full || plan.fontLevel
        });

        this.folderSaveTracker.reset();
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
    }

    /** The font as JSON for a folder save, with outlines only for `glyphs`. */
    private folderSourceJson(
        glyphs: ReadonlySet<string> | null
    ): BabelfontJsonParts {
        assertBabelfontDrawingWidths(this.babelfontData, 'folderSourceJson');
        const allGlyphs: Babelfont.Glyph[] = this.babelfontData.glyphs || [];
        this.normalizeComponentTransformsForRust(
            glyphs ? allGlyphs.filter((g) => glyphs.has(g.name)) : allGlyphs
        );
        return this.fontModel.toJSONParts({
            compileFacing: false,
            glyphBodies: glyphs ?? undefined
        });
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
    lastEditType: CompileEditStamp = null;
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
    /**
     * Highest revision of any applied editing compile. A kerning-only result
     * newer than this is shown even when a later request is queued: during a
     * held key or a handle drag every request is soon superseded, and
     * dropping them all would freeze the text until the gesture ends.
     */
    private lastAppliedEditingRevision: number = -1;
    closureCache: {
        subsetGlyphs: string[];
        activeFeatures: string;
        closureSet: string[];
    } | null = null;
    editingSubsetSnapshotGlyphs: string[];
    editingSubsetSnapshotKey: string;
    coveredSparseHydrationKey: string | null = null;
    private localSparseHydrator: LocalSparseHydrator | null = null;
    private editingCompileInFlight: Promise<unknown> | null = null;
    private editingCompileEnqueueGen = 0;
    isExternalReloading: boolean = false;
    private pendingExternalSourcePaths = new Set<string>();
    private externalSourceChangeQueue: Promise<void> = Promise.resolve();
    pendingDebugEditingFontSaveAfterDrag: boolean;
    pendingBabelfontJsonSyncAfterDrag: boolean;
    pendingCommittedKeyboardDriftCheckAfterDrag: boolean;
    workerCacheUpdatePromise: Promise<void> | null;
    /**
     * Drawings the last live stage sent to the worker, for the live compile
     * request that follows it; linked windows get the same.
     */
    private _stagedLinkedPreview: {
        updates: DrawingCacheUpdate[];
        stagedAt: number;
    } | null = null;
    forceFullEditingCacheRefresh: boolean;
    workerDrawingFingerprintCache: Map<string, string>;
    lastWorkerDocumentEpoch: number;
    lastWorkerFilterEpoch: number;
    lastWorkerFontCacheEpoch: number;
    /** True while the worker document is quarantined after a failed sync. */
    private workerMirrorQuarantined: boolean;
    /**
     * Documents the worker reported as having lost an update
     * (`ClockGapError`) or as broken (`BrokenDocumentError`). Updates for
     * them are refused, and the worker is never reseeded behind them, until
     * the font is opened again.
     */
    private workerBrokenDocumentErrors: Map<string, Error> = new Map();
    private editingCompileContextsByRevision: Map<
        string,
        EditingCompileContext
    >;
    private stickyTypingSubsetGlyphs: Set<string> = new Set();
    private pendingFusedPreviewOverlay: {
        layerUpdates: Array<{
            glyphName: string;
            layerId: string;
            layerData: Babelfont.Layer;
        }>;
        changedGlyphs: string[];
        nonGlyphChangeHints: string[];
        layerTargets: WorkerReplayTarget[];
        invalidateLayoutClosure: boolean;
    } | null = null;
    private workerYjsSendQueue: Promise<unknown>;
    private workerPreviewSendQueue: Promise<unknown>;
    private pendingCloudBadgeVisibleAtByAssetId: Map<string, number>;
    private cloudPersistFailed = false;
    private cloudPersistStorageFullMessage: string | null = null;
    private pendingCloudBadgeDelayTimer: ReturnType<typeof setTimeout> | null;
    private pendingCloudBadgeDelayAssetId: string | null;
    private cloudStatusTippy: TippyInstance | null;

    /**
     * The font serialization `validateFontDataForRust` last saw. The
     * validator walks the whole serialized font, so it skips a font whose
     * serialization has not changed since (same font, same
     * `serializationEpoch`).
     */
    private _validatedFontSerialization: {
        font: OpenedFont;
        epoch: number;
    } | null = null;

    /**
     * Running counters for traffic across the JS \u2194 Rust/worker boundary.
     * See {@link BoundaryCrossingStats} and {@link getBoundaryCrossingStats}.
     */
    private _boundaryCrossingStats: {
        submitBatchCalls: number;
        drawingsTransmitted: number;
        fullFontCrossings: number;
        transmittedGlyphs: Set<string>;
    } = {
        submitBatchCalls: 0,
        drawingsTransmitted: 0,
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
        this.lastAppliedEditingRevision = -1;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.stickyTypingSubsetGlyphs.clear();
        this.coveredSparseHydrationKey = null;
        this.localSparseHydrator = null;
        this.isExternalReloading = false;
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.pendingCommittedKeyboardDriftCheckAfterDrag = false;
        this.workerCacheUpdatePromise = null;
        this.forceFullEditingCacheRefresh = false;
        this.workerDrawingFingerprintCache = new Map();
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
        this.cloudStatusTippy = null;

        window.addEventListener('cloudConnectionStatusChanged', () => {
            if (!this.dirtyIndicator && !this.fontDisplay) {
                return;
            }
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

        window.addEventListener('cloudAssetNoticeChanged', () => {
            this.updateFontDisplay();
        });
        window.addEventListener('history-replay-blocked', (event) => {
            this.showHistoryReplayBlockedNotice(
                (
                    event as CustomEvent<{
                        historyAction?: string;
                        reason?: string;
                    } | null>
                ).detail ?? null
            );
        });
        window.addEventListener('cloud-persist-failed', (event) => {
            this.cloudPersistFailed = true;
            const detail = (
                event as CustomEvent<{ storageFull?: boolean; reason?: string }>
            ).detail;
            this.cloudPersistStorageFullMessage =
                detail?.storageFull === true &&
                typeof detail.reason === 'string'
                    ? detail.reason
                    : null;
            this.updateFontDisplay();
        });
        window.addEventListener('cloudConnectionStatusChanged', () => {
            void this.updateDirtyIndicator();
            const font = this.currentFontId
                ? (this.openedFonts.get(this.currentFontId) ?? null)
                : null;
            const assetId = this.normalizeCloudAssetId(font);
            if (
                this.cloudPersistFailed &&
                assetId &&
                (window.cloudPlugin?.getAssetPendingSyncCount?.(assetId) ??
                    -1) === 0 &&
                window.cloudPlugin?.getAssetConnectionStatus?.(assetId) ===
                    'connected'
            ) {
                this.cloudPersistFailed = false;
                this.updateFontDisplay();
            }
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

    private destroyCloudStatusTooltip(): void {
        this.cloudStatusTippy?.destroy();
        this.cloudStatusTippy = null;
    }

    private ensureCloudStatusTooltip(badge: HTMLElement): void {
        if (
            this.cloudStatusTippy &&
            this.cloudStatusTippy.reference !== badge
        ) {
            this.destroyCloudStatusTooltip();
        }
        if (this.cloudStatusTippy) {
            return;
        }
        this.cloudStatusTippy = tippy(badge, {
            content: '',
            allowHTML: true,
            interactive: false,
            trigger: 'mouseenter focus',
            appendTo: () => document.body,
            placement: 'bottom',
            theme: getTheme(),
            maxWidth: 360,
            onShow: (instance) => {
                instance.setProps({ theme: getTheme() });
                instance.setContent(this.buildCloudStatusTooltipContent());
            }
        });
    }

    private buildCloudStatusTooltipContent(): string {
        const currentFont = this.currentFontId
            ? (this.openedFonts.get(this.currentFontId) ?? null)
            : null;
        const warningState = this.getCloudConnectionWarningState(currentFont);
        const assetId = this.normalizeCloudAssetId(currentFont);
        const html = assetId
            ? window.cloudPlugin?.getCloudStatusTooltipHtml?.(
                  assetId,
                  warningState.title
              )
            : null;
        return html || warningState.title || '';
    }

    private syncCloudStatusTooltip(
        badge: HTMLElement,
        warningState: { visible: boolean; title: string }
    ): void {
        if (!warningState.visible) {
            this.cloudStatusTippy?.hide();
            return;
        }
        this.ensureCloudStatusTooltip(badge);
        if (this.cloudStatusTippy?.state.isVisible) {
            this.cloudStatusTippy.setContent(
                this.buildCloudStatusTooltipContent()
            );
        }
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

        const notice = window.cloudPlugin?.getAssetNotice?.(assetId);
        if (notice) {
            return {
                visible: true,
                title: `Cloud status: ${notice.title}`,
                icon: notice.tone === 'error' ? 'cloud_off' : 'info',
                tone: notice.tone
            };
        }

        if (this.cloudPersistFailed) {
            return {
                visible: true,
                title: `Cloud status: Not saving — ${
                    this.cloudPersistStorageFullMessage ??
                    'local durability persist failed'
                }`,
                icon: 'cloud_off',
                tone: 'error' as const
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
        // A batch without its packet is refused, never read as no edit.
        throw new TypeError('The worker batch returned no Yjs update.');
    }

    /**
     * The batch's per-document packets exactly as the worker returned them.
     * A malformed entry is refused: dropping it would lose that document's
     * edits while the rest of the batch applies.
     */
    private normalizeWorkerBatchUpdates(
        value: unknown
    ): RustBatchDocumentUpdate[] | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (!Array.isArray(value)) {
            throw new TypeError(
                'The worker batch returned per-document packets that are not a list.'
            );
        }
        if (value.length === 0) {
            return undefined;
        }
        return value.map((entry) => {
            const record =
                entry && typeof entry === 'object'
                    ? (entry as Record<string, unknown>)
                    : null;
            if (
                !record ||
                typeof record.documentId !== 'string' ||
                !record.documentId
            ) {
                throw new TypeError(
                    'The worker batch returned a packet without its document id.'
                );
            }
            return {
                documentId: record.documentId,
                update: this.normalizeWorkerBatchUpdate(record.update)
            };
        });
    }

    private parseWorkerBatchMetadata(value: unknown): RustBatchMetadata {
        if (typeof value !== 'string' || !value.length) {
            throw new TypeError('The worker batch returned no metadata.');
        }
        const rawMetadata = JSON.parse(value) as Record<string, unknown>;
        const changedGlyphs = Array.isArray(rawMetadata.changedGlyphs)
            ? rawMetadata.changedGlyphs.filter(
                  (glyphName): glyphName is string =>
                      typeof glyphName === 'string' && glyphName.length > 0
              )
            : [];
        const drawingTargets = Array.isArray(rawMetadata.layerTargets)
            ? rawMetadata.layerTargets.map((target) => {
                  const record =
                      target && typeof target === 'object'
                          ? (target as Record<string, unknown>)
                          : {};
                  const glyphName = record.glyphName;
                  const drawingId = record.layerId;
                  if (
                      typeof glyphName !== 'string' ||
                      typeof drawingId !== 'string'
                  ) {
                      throw new TypeError(
                          'The worker batch named a drawing target without its glyph or drawing.'
                      );
                  }
                  return { glyphName, layerId: drawingId };
              })
            : [];
        const drawingOperations = Array.isArray(rawMetadata.layerOperations)
            ? rawMetadata.layerOperations.map((operation) => {
                  const record =
                      operation && typeof operation === 'object'
                          ? (operation as Record<string, unknown>)
                          : {};
                  const glyphName = record.glyphName;
                  const drawingId = record.layerId;
                  if (
                      typeof glyphName !== 'string' ||
                      typeof drawingId !== 'string'
                  ) {
                      // Dropping it would apply the packet without the
                      // drawing's model update.
                      throw new TypeError(
                          'The worker batch returned a drawing operation without its glyph or drawing.'
                      );
                  }
                  return {
                      glyphName,
                      layerId: drawingId,
                      oldValue: record.oldValue,
                      newValue: record.newValue
                  };
              })
            : [];
        const stationsOperation =
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
        const instancesOperation =
            rawMetadata.instancesOperation &&
            typeof rawMetadata.instancesOperation === 'object'
                ? (rawMetadata.instancesOperation as {
                      oldValue?: unknown;
                      newValue: unknown;
                  })
                : null;

        return {
            changedGlyphs,
            layerTargets: drawingTargets,
            layerOperations: drawingOperations,
            mastersOperation: stationsOperation,
            axesOperation,
            instancesOperation
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

    async buildWorkerReinterpolateDrawingBatch(
        glyphName: string,
        drawingId: string
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'reinterpolateDrawingYjs',
            glyphName,
            layerId: drawingId
        });
    }

    async buildWorkerReinterpolateStationDrawingsBatch(
        stationId: string
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'reinterpolateStationDrawingsYjs',
            masterId: stationId
        });
    }

    async buildWorkerAddStationWithInterpolatedDrawingsBatch(
        station: Babelfont.Master,
        interpolationLocations?: AddStationInterpolationLocation[],
        axes?: Babelfont.Axis[]
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'addStationWithInterpolatedDrawingsYjs',
            master: station,
            interpolationLocations: interpolationLocations ?? [],
            ...(axes ? { axes } : {})
        });
    }

    async buildWorkerAddAxisWithStationCopiesBatch(
        plan: AxisStationCopyPlan
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'addAxisWithStationCopiesYjs',
            plan
        });
    }

    async buildWorkerRefineDrawingSnapshotsBatch(
        baseUpdate: Uint8Array,
        overrides: Array<{
            glyphName: string;
            layerId: string;
            layer: unknown;
        }>,
        /**
         * The base batch's packets per document, glyph packets included, or
         * undefined when it had none.
         */
        baseUpdates?: Array<{ documentId: string; update: Uint8Array }>
    ): Promise<RustBatchResult> {
        if (!(baseUpdate instanceof Uint8Array)) {
            throw new TypeError(
                'Refining drawing snapshots needs the base batch’s Yjs update.'
            );
        }
        if (baseUpdates !== undefined) {
            if (!Array.isArray(baseUpdates)) {
                throw new TypeError(
                    'Base packets for a refine must be a list of {documentId, update}.'
                );
            }
            for (const packet of baseUpdates) {
                if (
                    !packet ||
                    typeof packet.documentId !== 'string' ||
                    !packet.documentId ||
                    !(packet.update instanceof Uint8Array)
                ) {
                    throw new TypeError(
                        'Each base packet for a refine needs a document id and a Yjs update.'
                    );
                }
            }
        }
        return this.requestRustBatchFromWorker({
            type: 'refineDrawingSnapshotsYjs',
            baseUpdate,
            overrides,
            baseUpdates
        });
    }

    async buildWorkerRemoveStationsBatch(
        stationIds: string[]
    ): Promise<RustBatchResult> {
        return this.requestRustBatchFromWorker({
            type: 'removeStationsYjs',
            masterIds: stationIds
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

    /**
     * Show the cloud asset notice for an undo or redo the engine refused
     * because a collaborator changed the same thing since. Other reasons
     * (document-not-loaded) have their own notice (font-windows/dialogs.ts),
     * so this shows nothing for them.
     */
    showHistoryReplayBlockedNotice(
        detail: { historyAction?: string; reason?: string } | null
    ): void {
        if (detail?.reason !== 'collaborator-edit') {
            return;
        }
        const font = this.currentFontId
            ? (this.openedFonts.get(this.currentFontId) ?? null)
            : null;
        const assetId = this.normalizeCloudAssetId(font);
        const plugin = window.cloudPlugin;
        if (!assetId || !plugin?.setAssetNotice) {
            return;
        }
        const action = detail.historyAction === 'redo' ? 'Redo' : 'Undo';
        plugin.setAssetNotice(assetId, {
            kind: 'history-blocked',
            tone: 'warning',
            title: `${action} skipped: a collaborator changed this since, and their edit was kept.`
        });
        setTimeout(() => {
            plugin.clearAssetNotice?.(assetId, 'history-blocked');
        }, 8000);
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
        if (
            font === this.currentFont &&
            window.patchSyncEngine?.hasCloudPersistInFlight === true
        ) {
            // The edit is not in the outbox yet, so it is not counted below.
            return true;
        }
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
        if (
            this.cloudStatusTippy &&
            !this.cloudStatusTippy.reference.isConnected
        ) {
            this.destroyCloudStatusTooltip();
        }
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
                this.destroyCloudStatusTooltip();
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
                        cloudConnectionWarningBadge.removeAttribute('title');
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
                        this.syncCloudStatusTooltip(
                            cloudConnectionWarningBadge,
                            warningState
                        );
                    } else {
                        cloudConnectionWarningBadge.hidden = true;
                        cloudConnectionWarningBadge.removeAttribute('title');
                        cloudConnectionWarningBadge.removeAttribute(
                            'aria-label'
                        );
                        this.destroyCloudStatusTooltip();
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
        if (!this.dirtyIndicator) {
            return;
        }

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
        this.stickyTypingSubsetGlyphs.clear();
        this.coveredSparseHydrationKey = null;
        this.localSparseHydrator = null;
        this.clearEditingCompileContext();
        this.lastCompilationMode = 'full';
        this.lastFullCompiledDataVersion = -1;
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.pendingCommittedKeyboardDriftCheckAfterDrag = false;
        this.forceFullEditingCacheRefresh = false;
        this.workerDrawingFingerprintCache.clear();
        this.editingCompileContextsByRevision.clear();
        this._validatedFontSerialization = null;
        fontCompilation.lastStoredFontJson = null;
        this.workerMirrorQuarantined = false;
        this.workerBrokenDocumentErrors.clear();
        window.currentFontModel = null;
        (window.fontInterpolation as any)?.resetRequestTracking?.();

        if (window.glyphCanvas) {
            window.glyphCanvas.resetForOpenedFontReplacement();
        }
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

    /**
     * Read and convert the font's source again. `snapshot` receives what was
     * read, for telling later external changes from Counterpunch's own.
     */
    private async loadBabelfontJsonFromSource(
        font: OpenedFont,
        snapshot: SourceSnapshot = {}
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
        } else if (isGlyphsPackage || isUfoDirectory || isDesignspace) {
            const format = isGlyphsPackage
                ? 'glyphspackage'
                : isUfoDirectory
                  ? 'ufo'
                  : 'designspace';
            const { entries, state } = await readFolderSource(
                font.sourcePlugin.getAdapter(),
                font.path,
                format
            );
            if (
                isGlyphsPackage &&
                (!entries['fontinfo.plist'] || !entries['order.plist'])
            ) {
                throw new Error(
                    'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                );
            }
            if (isGlyphsPackage) {
                packageEntries = entries;
            } else {
                projectEntries = entries;
            }
            snapshot.folderSource = state;
        } else {
            contents = await font.sourcePlugin.getAdapter().readFile(font.path);
            if (extension === 'babelfont' && contents instanceof Uint8Array) {
                contents = new TextDecoder('utf-8').decode(contents);
            }
        }
        if (contents !== undefined) {
            snapshot.sourceFileHash = hashBytes(
                typeof contents === 'string'
                    ? new TextEncoder().encode(contents)
                    : contents
            );
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
            selectedDrawingId:
                glyphCanvas.outlineEditor?.selectedDrawingId || null,
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

        // Font compile/reload captures are often older than live typing
        // (constructor default "Hamburgevons" vs setTextBuffer). Never
        // replace the live buffer from that snapshot.
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

            if (state.selectedDrawingId) {
                glyphCanvas.outlineEditor.selectedDrawingId =
                    state.selectedDrawingId;
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

    /**
     * React to files of the current font's source changing on disk. Files
     * that still hold what Counterpunch read or wrote (its own saves) are
     * ignored. In a folder source, changed glyph files update just those
     * glyphs; anything else reloads the whole source. Changes arriving while
     * one is handled are handled after it.
     */
    handleExternalSourceChanges(changedPaths: string[]): Promise<void> {
        for (const path of changedPaths) {
            this.pendingExternalSourcePaths.add(path);
        }
        this.externalSourceChangeQueue = this.externalSourceChangeQueue
            .then(() => this.processExternalSourceChanges())
            .catch((error) => {
                console.error('External source change failed:', error);
                alert(
                    `Failed to reload externally changed font: ${error instanceof Error ? error.message : String(error)}`
                );
            });
        return this.externalSourceChangeQueue;
    }

    private async processExternalSourceChanges(): Promise<void> {
        const changedPaths = [...this.pendingExternalSourcePaths];
        this.pendingExternalSourcePaths.clear();
        const font = this.currentFont;
        if (!font || changedPaths.length === 0) {
            return;
        }
        const format = folderSourceFormatForPath(font.path);
        if (format && font.folderSource) {
            await this.applyFolderSourceChanges(font, format, changedPaths);
            return;
        }
        if (font.sourceFileHash) {
            // A file launched on its own is read through its handle.
            const bytes =
                font.fileHandle && !font.directoryHandle
                    ? new Uint8Array(
                          await (await font.fileHandle.getFile()).arrayBuffer()
                      )
                    : await readSourceFileOrNull(font.sourcePlugin, font.path);
            if (bytes && hashBytes(bytes) === font.sourceFileHash) {
                return;
            }
        }
        await this.reloadWholeSourceUnlessKeepingLocal(font);
    }

    private async reloadWholeSourceUnlessKeepingLocal(
        font: OpenedFont
    ): Promise<void> {
        if (
            font.hasUnsavedChanges &&
            !(await showProceedDialog(
                'Font changed on disk',
                `${font.path.split('/').pop()} changed on disk, and you have unsaved changes. Reload it from disk and discard them, or keep your changes?`,
                {
                    proceedLabel: 'Reload from disk',
                    cancelLabel: 'Keep my changes',
                    danger: true
                }
            ))
        ) {
            return;
        }
        await this.reloadCurrentFontFromSource({ preserveUiState: true });
    }

    private async applyFolderSourceChanges(
        font: OpenedFont,
        format: FolderSourceFormat,
        changedPaths: string[]
    ): Promise<void> {
        const state = font.folderSource!;
        const sourceRoot = folderSourceRoot(font.path, format);
        const root = `${normalizeManagedPath(sourceRoot).replace(/\/+$/, '')}/`;
        const relativePaths = [
            ...new Set(
                changedPaths
                    .map(normalizeManagedPath)
                    .filter((path) => path.startsWith(root))
                    .map((path) => path.slice(root.length))
                    .filter((path) => isFolderSourceFile(state.layout, path))
            )
        ];
        const changed: Array<{ path: string; bytes: Uint8Array | null }> = [];
        for (const relativePath of relativePaths) {
            const bytes = await readSourceFileOrNull(
                font.sourcePlugin,
                joinSourcePath(sourceRoot, relativePath)
            );
            const unchanged =
                bytes === null
                    ? !state.has(relativePath)
                    : state.isUnchanged(relativePath, bytes);
            if (!unchanged) {
                changed.push({ path: relativePath, bytes });
            }
        }
        if (changed.length === 0) {
            return;
        }
        const onlyGlyphFiles = changed.every(
            ({ path, bytes }) =>
                bytes !== null &&
                state.has(path) &&
                isGlyphFile(state.layout, path)
        );
        if (
            onlyGlyphFiles &&
            (await this.reloadGlyphFiles(
                font,
                format,
                changed as Array<{ path: string; bytes: Uint8Array }>
            ))
        ) {
            return;
        }
        await this.reloadWholeSourceUnlessKeepingLocal(font);
    }

    /**
     * Update the glyphs whose files changed, from those files alone. Returns
     * false when the change needs a whole reload: a glyph is new, or (in a
     * .glyphspackage) its kerning groups changed.
     */
    private async reloadGlyphFiles(
        font: OpenedFont,
        format: FolderSourceFormat,
        changed: Array<{ path: string; bytes: Uint8Array }>
    ): Promise<boolean> {
        const state = font.folderSource!;
        const sourceRoot = folderSourceRoot(font.path, format);
        const bridge = window.patchSyncEngine;
        if (!bridge) {
            return false;
        }
        const decoder = new TextDecoder();
        const liveData = font.babelfontData as Babelfont.Font;
        const liveGlyph = (name: string) =>
            liveData.glyphs.find((glyph) => glyph.name === name);
        const stations = liveData.masters || [];
        let glyphs: Babelfont.Glyph[];

        if (format === 'ufo' || format === 'designspace') {
            const layoutJson = JSON.stringify(state.layoutEntries());
            const document = state.documentText();
            const stationId =
                stations.length === 1 ? stations[0].id : undefined;
            if (format === 'designspace' ? !document : !stationId) {
                return false;
            }
            const changedPaths = JSON.stringify(
                changed.map(({ path }) => path)
            );
            const located = JSON.parse(
                format === 'designspace'
                    ? await callSourceWasmOp(
                          'designspace_glyph_files_for_paths',
                          [document!, layoutJson, changedPaths]
                      )
                    : await callSourceWasmOp('ufo_glyph_files_for_paths', [
                          layoutJson,
                          changedPaths
                      ])
            ) as { glyphs: Record<string, string[]>; unknown: string[] };
            if (located.unknown.length > 0) {
                return false;
            }
            const changedText = new Map(
                changed.map(({ path, bytes }) => [path, decoder.decode(bytes)])
            );
            const glifs: Record<string, string> = {};
            for (const path of Object.values(located.glyphs).flat()) {
                const text =
                    changedText.get(path) ??
                    (await readSourceFileOrNull(
                        font.sourcePlugin,
                        joinSourcePath(sourceRoot, path)
                    ).then((bytes) => (bytes ? decoder.decode(bytes) : null)));
                if (text === null || text === undefined) {
                    return false;
                }
                glifs[path] = text;
            }
            const names = JSON.stringify(Object.keys(located.glyphs));
            const fromDisk = JSON.parse(
                format === 'designspace'
                    ? await callSourceWasmOp('load_designspace_glyphs', [
                          document!,
                          layoutJson,
                          JSON.stringify(glifs),
                          names
                      ])
                    : await callSourceWasmOp('load_ufo_glyphs', [
                          layoutJson,
                          JSON.stringify(glifs),
                          names,
                          stationId!
                      ])
            ) as Babelfont.Glyph[];
            glyphs = [];
            for (const diskGlyph of fromDisk) {
                const live = liveGlyph(diskGlyph.name);
                if (!live) {
                    return false;
                }
                // A .glif holds a glyph's drawings and codepoints; the rest is
                // in lib.plist, which did not change.
                glyphs.push({
                    ...live,
                    layers: diskGlyph.layers,
                    codepoints: diskGlyph.codepoints
                });
            }
        } else {
            const fontinfo = state.fontinfoText();
            if (!fontinfo) {
                return false;
            }
            const loaded = JSON.parse(
                await callSourceWasmOp('load_glyphspackage_glyphs', [
                    fontinfo,
                    JSON.stringify(
                        Object.fromEntries(
                            changed.map(({ path, bytes }) => [
                                path,
                                decoder.decode(bytes)
                            ])
                        )
                    )
                ])
            ) as {
                glyphs: Babelfont.Glyph[];
                kernGroups: Record<string, [string | null, string | null]>;
            };
            const groupOf = (
                groups: Record<string, string[]> | undefined,
                name: string
            ) =>
                Object.entries(groups || {}).find(([, members]) =>
                    members.includes(name)
                )?.[0] ?? null;
            for (const glyph of loaded.glyphs) {
                const [first, second] = loaded.kernGroups[glyph.name] || [];
                if (
                    !liveGlyph(glyph.name) ||
                    groupOf(liveData.first_kern_groups, glyph.name) !== first ||
                    groupOf(liveData.second_kern_groups, glyph.name) !== second
                ) {
                    return false;
                }
            }
            glyphs = loaded.glyphs;
        }

        const locallyEdited = glyphs
            .map((glyph) => glyph.name)
            .filter((name) => font.folderSaveTracker.isGlyphDirty(name));
        if (
            locallyEdited.length > 0 &&
            !(await showProceedDialog(
                'Glyphs changed on disk',
                `${locallyEdited.join(', ')} changed on disk, and you have unsaved changes to ${locallyEdited.length === 1 ? 'it' : 'them'}. Take the version on disk, or keep yours?`,
                {
                    proceedLabel: 'Take the disk version',
                    cancelLabel: 'Keep mine',
                    danger: true
                }
            ))
        ) {
            // Keeping the local glyphs: the next save writes them over these.
            for (const { path, bytes } of changed) {
                state.record(path, bytes);
            }
            return true;
        }

        const wasClean = !font.hasUnsavedChanges;
        const result = bridge.applyExternalGlyphReload(
            canonicalizeImportedGlyphs(glyphs, stations) as unknown as Array<
                Record<string, unknown>
            >
        );
        if (result.status === 'stale') {
            // Mid-transaction or sync: try again shortly.
            window.setTimeout(
                () =>
                    void this.handleExternalSourceChanges(
                        changed.map(({ path }) =>
                            joinSourcePath(sourceRoot, path)
                        )
                    ),
                250
            );
            return true;
        }
        for (const { path, bytes } of changed) {
            state.record(path, bytes);
        }
        for (const glyph of glyphs) {
            font.folderSaveTracker.markGlyphClean(glyph.name);
        }
        if (wasClean) {
            font.hasUnsavedChanges = false;
            await this.updateDirtyIndicator();
            window.saveButton?.updateButtonState();
        }
        console.log(
            `Reloaded ${glyphs.length} glyph(s) from ${font.path}: ${result.status}`
        );
        return true;
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
            const snapshot: SourceSnapshot = {};
            const babelfontJson = await this.loadBabelfontJsonFromSource(
                previousOpenedFont,
                snapshot
            );
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
                    babelfontJson: rustBabelfontInput(
                        canonicalImport.fontModel.toJSONParts({
                            compileFacing: false
                        })
                    )
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
            // The font now holds what the source holds.
            applySourceSnapshot(reloadedFont, snapshot);
            reloadedFont.folderSaveTracker.reset();
            reloadedFont.hasUnsavedChanges = false;

            this.editingFont = null;
            this.glyphOrderCache = null;
            this.closureCache = null;
            this.editingSubsetSnapshotGlyphs = [];
            this.editingSubsetSnapshotKey = '';
            this.coveredSparseHydrationKey = null;
            this.localSparseHydrator = null;
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
        this.stickyTypingSubsetGlyphs.clear();
        this.coveredSparseHydrationKey = null;
        this.localSparseHydrator = null;

        // Reset initialFontLoaded flag in glyphCanvas when new font is loaded
        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }

        this.updateWindowTitle();

        // Notify the patch sync engine bootstrap pipeline that the font model is ready
        const readyDetail: FontModelReadyDetail = {
            path,
            babelfontData: newFont.babelfontData
        };
        window.dispatchEvent(
            new CustomEvent('fontModelReady', { detail: readyDetail })
        );
        // The bridge could not load the font: the open stops here.
        this.abandonOpenWithoutBridge(readyDetail);
    }

    /**
     * Install a resident snapshot without parsing source JSON again.
     * babelfontJson stays empty until a later compile or save rebuilds it.
     */
    adoptResidentFont(
        fontData: Record<string, unknown>,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        this.resetStateForNewFont();
        assertBabelfontDrawingWidths(fontData, 'adoptResidentFont');
        const fontModel = Font.fromData(fontData as never);
        const newFont = OpenedFont.fromResidentData(
            fontData,
            fontModel,
            path,
            sourcePlugin,
            fileHandle,
            directoryHandle
        );
        const newid = `font-${Date.now()}`;
        this.openedFonts.set(newid, newFont);
        this.currentFontId = newid;
        window.currentFontModel = newFont.fontModel;
        this.editingFont = null;
        this.glyphOrderCache = null;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.stickyTypingSubsetGlyphs.clear();
        this.coveredSparseHydrationKey = null;
        this.localSparseHydrator = null;
        this.pendingBabelfontJsonSyncAfterDrag = true;
        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }
        this.updateWindowTitle();
        const readyDetail: FontModelReadyDetail = {
            path,
            babelfontData: newFont.babelfontData,
            linkedSnapshot: true
        };
        window.dispatchEvent(
            new CustomEvent('fontModelReady', { detail: readyDetail })
        );
        this.abandonOpenWithoutBridge(readyDetail);
    }

    /**
     * Install a locally opened font from `openFontSparse`'s compact core +
     * catalog + initial working-set glyphs without serializing or parsing a
     * monolithic full-font JSON string.
     */
    async loadFontSparse(
        bootstrap: LocalSparseBootstrapPayload,
        initialGlyphs: Array<Record<string, unknown>>,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ): Promise<void> {
        this.resetStateForNewFont();

        const canonicalizeSpanId = timelineSpanStart(
            'font.loadFont.canonicalize'
        );
        const coreData = bootstrap.coreData;
        const preparedGlyphs: Array<Record<string, unknown>> = [];
        for (const glyph of initialGlyphs) {
            const name = typeof glyph.name === 'string' ? glyph.name : '';
            const glyphId = bootstrap.glyphIdByName.get(name);
            if (!name || !glyphId) continue;
            sanitizeGlyphEmptyReferenceComponents(glyph);
            glyph.id = glyphId;
            preparedGlyphs.push(glyph);
        }
        coreData.glyphs = preparedGlyphs;
        const fontModel = new Font(coreData as unknown as Babelfont.Font);
        const newFont = OpenedFont.fromResidentData(
            coreData,
            fontModel,
            path,
            sourcePlugin,
            fileHandle,
            directoryHandle
        );
        timelineSpanEnd(canonicalizeSpanId);

        const newid = `font-${Date.now()}`;
        this.openedFonts.set(newid, newFont);
        this.currentFontId = newid;
        window.currentFontModel = newFont.fontModel;
        this.localSparseHydrator = bootstrap.isSparse
            ? new LocalSparseHydrator(bootstrap)
            : null;

        this.editingFont = null;
        this.glyphOrderCache = null;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.stickyTypingSubsetGlyphs.clear();
        this.coveredSparseHydrationKey = null;

        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }

        this.updateWindowTitle();

        const workingGlyphIds = preparedGlyphs
            .map((g) => (typeof g.id === 'string' ? g.id : ''))
            .filter(Boolean);
        const readyDetail: FontModelReadyDetail & {
            localSparseBootstrap?: {
                workingGlyphIds: string[];
                fontDeps: LocalSparseBootstrapPayload['fontDeps'];
            };
        } = {
            path,
            babelfontData: newFont.babelfontData,
            ...(bootstrap.isSparse
                ? {
                      localSparseBootstrap: {
                          workingGlyphIds,
                          fontDeps: bootstrap.fontDeps
                      }
                  }
                : undefined)
        };
        window.dispatchEvent(
            new CustomEvent('fontModelReady', { detail: readyDetail })
        );
        this.abandonOpenWithoutBridge(readyDetail);
    }

    /**
     * A font whose bridge could not be built is not left open: nothing
     * would record or compile its edits. The previous font's bridge is
     * already gone, so the editor holds no font, and the open fails with
     * why.
     */
    private abandonOpenWithoutBridge(readyDetail: FontModelReadyDetail): void {
        if (!readyDetail.bridgeError) {
            return;
        }
        this.resetStateForNewFont();
        this.updateWindowTitle();
        throw readyDetail.bridgeError;
    }

    /**
     * Generate a minimal empty babelfont JSON string.
     * One station with design/export vertical metrics, hollow rectangular
     * .notdef, space glyph, Regular style name, no axes or instances.
     */
    private generateEmptyFontJson(): string {
        // Build a minimal font from scratch.
        // Rust babelfont::Font requires: upm, version, date, names, features, glyphs.
        // Station requires: name, id, location, metrics, kerning.
        // All other fields have #[serde(default)] so they are optional.
        const stationId = crypto.randomUUID();
        const notdefDrawingId = crypto.randomUUID();
        const spaceDrawingId = crypto.randomUUID();
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
            // No axes — a static font with no axes and one station means the
            // glyph rendering path uses the single station directly instead
            // of trying to interpolate between nonexistent stations.
            masters: [
                {
                    id: stationId,
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
                            id: notdefDrawingId,
                            width: notdefWidth,
                            master: {
                                type: 'DefaultForMaster',
                                master: stationId
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
                            id: spaceDrawingId,
                            width: 250,
                            master: {
                                type: 'DefaultForMaster',
                                master: stationId
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
                        await window.saveFontAs?.();
                    } else {
                        await window.saveButton?.handleSave?.();
                    }
                }
            }

            console.log('[FontManager] handleNewFont: clearing caches');
            // A compile worker that has not finished initializing holds no cache.
            if (fontCompilation.worker && fontCompilation.isInitialized) {
                try {
                    await fontCompilation.sendMessage({ type: 'clearCache' });
                    console.log('[FontManager] handleNewFont: clearCache done');
                } catch (e) {
                    console.warn(
                        '[FontManager] handleNewFont: clearCache failed',
                        e
                    );
                }
            }

            // Reset all JS-side caches. Linked windows show this document
            // and the new font has none, so they close.
            if (window.windowSync) {
                if (window.windowRole?.isMainWindow()) {
                    window.windowSync.announceMainWindowClosing();
                }
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
            if (readUrlState().sparse === true) {
                return '';
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
        const activeGlyphName = this.getActiveEditorGlyphName();

        return this.normalizeSubsetGlyphs([
            ...this.getEditingSubsetSnapshot(),
            ...glyphNameBuffer,
            ...(activeGlyphName ? [activeGlyphName] : [])
        ]);
    }

    getActiveEditorGlyphName(): string | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (!outlineEditor?.active) {
            return null;
        }
        const name =
            outlineEditor.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            null;
        if (!name || name === 'undefined') {
            return null;
        }
        return name;
    }

    notifyActiveEditorGlyphRoom(): void {
        if (typeof window === 'undefined' || !window.dispatchEvent) {
            return;
        }
        window.dispatchEvent(
            new CustomEvent('activeEditorGlyphChanged', {
                detail: { glyphName: this.getActiveEditorGlyphName() }
            })
        );
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
        const { resident, total } = this.getGlyphResidency();
        return total > resident;
    }

    /**
     * Glyphs whose bodies are loaded versus every glyph the font defines.
     * Locally opened fonts load every glyph; sparse cloud sessions only hold
     * the working set, and the catalog, revision tokens and core glyph order
     * name the rest.
     */
    getGlyphResidency(): { resident: number; total: number } {
        const hydratedCount = this.getHydratedGlyphNames().length;
        const fontJson = this.currentFont?.babelfontData as
            Record<string, unknown> | undefined;
        const catalogObject =
            fontJson?.glyphCatalog &&
            typeof fontJson.glyphCatalog === 'object' &&
            !Array.isArray(fontJson.glyphCatalog)
                ? (fontJson.glyphCatalog as Record<string, unknown>)
                : null;
        const catalogCount = catalogObject
            ? Object.values(catalogObject).filter((entry) => {
                  if (!entry || typeof entry !== 'object') {
                      return false;
                  }
                  return (entry as { deleted?: unknown }).deleted !== true;
              }).length
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
        return {
            resident: hydratedCount,
            total: Math.max(universe, hydratedCount)
        };
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
            const drawings = Array.isArray(glyph?.drawings)
                ? glyph.drawings
                : [];
            for (const drawing of drawings) {
                const shapes = Array.isArray(drawing?.shapes)
                    ? drawing.shapes
                    : [];
                for (const shape of shapes) {
                    const shapeRecord = shape as unknown as {
                        reference?: unknown;
                        data?: { reference?: unknown };
                    };
                    const reference =
                        (typeof shapeRecord.reference === 'string' &&
                            shapeRecord.reference) ||
                        shapeRecord.data?.reference;
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

    /**
     * True when the live text maps to hydrated glyphs that are not in the
     * last compiled editing subset, or to catalog glyphs still waiting to
     * land in the model. Used to avoid a skip loop where unconstrained
     * subset names match a previous attempt that compiled without those
     * glyphs (cmap missing → .notdef).
     */
    needsEditingCompileForText(text: string): boolean {
        if (!text) {
            return false;
        }
        const derived = this.deriveSubsetGlyphsFromText(text);
        const constrained = this.constrainSubsetToHydratedGlyphs(derived);
        const compiled = new Set(this.getEditingSubsetSnapshot());
        const constrainedSet = new Set(constrained);
        if (!compiled.size && constrained.length > 0) {
            return true;
        }
        for (const name of constrained) {
            if (!compiled.has(name)) {
                return true;
            }
        }
        for (const name of derived) {
            if (!name || name === '.notdef') {
                continue;
            }
            if (!constrainedSet.has(name)) {
                return true;
            }
        }
        const compiledNameMap =
            window.glyphCanvas?.textRunEditor?.editingFontNameToGid;
        if (compiledNameMap instanceof Map && compiledNameMap.size > 0) {
            for (const name of constrained) {
                if (name && name !== '.notdef' && !compiledNameMap.has(name)) {
                    return true;
                }
            }
        }
        return false;
    }

    isLocalSparseFont(): boolean {
        return !!this.localSparseHydrator?.isActive();
    }

    /**
     * During interactive keystroke typing, keep the typing subset sticky across
     * consecutive keystrokes (capped at MAX_STICKY_TYPING_GLYPHS) and pre-warm
     * core Arabic joining letters + harakat on the first Arabic keystroke so
     * typing a sentence triggers 1–2 WASM compiles instead of one per character.
     * Programmatic `setTextBuffer` calls clear the sticky set so snapshots and
     * explicit subset compiles remain deterministic.
     */
    private expandStickyTypingSubset(
        resolvedText: string,
        baseGlyphs: string[]
    ): string[] {
        const isInteractiveKeystroke =
            window.glyphCanvas?.textRunEditor?.lastTextChangeWasKeystroke ===
            true;
        if (!isInteractiveKeystroke) {
            this.stickyTypingSubsetGlyphs.clear();
            return baseGlyphs;
        }
        const addSticky = (name?: string | null) => {
            if (!name || this.stickyTypingSubsetGlyphs.has(name)) {
                return;
            }
            this.stickyTypingSubsetGlyphs.add(name);
            if (this.stickyTypingSubsetGlyphs.size > MAX_STICKY_TYPING_GLYPHS) {
                const oldest = this.stickyTypingSubsetGlyphs
                    .values()
                    .next().value;
                if (oldest) {
                    this.stickyTypingSubsetGlyphs.delete(oldest);
                }
            }
        };
        if (/[\u0600-\u06FF]/.test(resolvedText)) {
            const fontModel = this.currentFont?.fontModel;
            for (const cp of ARABIC_CORE_TYPING_CODEPOINTS) {
                const glyph =
                    fontModel?.findGlyphByCodepoint?.(cp) ??
                    (typeof this.findCatalogGlyphByCodepoint === 'function'
                        ? this.findCatalogGlyphByCodepoint(cp)
                        : null);
                if (glyph?.name) {
                    addSticky(glyph.name);
                }
            }
        }
        for (const name of baseGlyphs) {
            addSticky(name);
        }
        return this.normalizeSubsetGlyphs([
            ...baseGlyphs,
            ...this.stickyTypingSubsetGlyphs
        ]);
    }

    /**
     * Look up a glyph by Unicode codepoint across both resident glyphs and
     * the sparse glyph catalog (local or cloud), so typing an unhydrated
     * character waits for hydration + compile rather than flashing `.notdef`.
     */
    findCatalogGlyphByCodepoint(
        codepoint: number
    ): { name: string; exported: boolean } | null {
        const resident =
            this.currentFont?.fontModel?.findGlyphByCodepoint?.(codepoint);
        if (resident) {
            return {
                name: resident.name,
                exported: resident.exported !== false
            };
        }
        if (this.localSparseHydrator?.isActive()) {
            const bootstrap = this.localSparseHydrator.getBootstrap();
            const ids = bootstrap.codepointIndex[String(codepoint)];
            if (ids && ids.length > 0) {
                for (const id of ids) {
                    const entry = bootstrap.glyphCatalog[id];
                    if (entry?.name) {
                        return {
                            name: entry.name,
                            exported: entry.exported !== false
                        };
                    }
                }
            }
            return null;
        }
        const rawCatalog = (
            this.currentFont?.babelfontData as
                | {
                      glyph_catalog?: Record<
                          string,
                          {
                              name?: string;
                              codepoints?: number[];
                              exported?: boolean;
                          }
                      >;
                  }
                | undefined
        )?.glyph_catalog;
        if (rawCatalog && typeof rawCatalog === 'object') {
            for (const entry of Object.values(rawCatalog)) {
                if (
                    Array.isArray(entry?.codepoints) &&
                    entry.codepoints.includes(codepoint) &&
                    entry.name
                ) {
                    return {
                        name: entry.name,
                        exported: entry.exported !== false
                    };
                }
            }
        }
        return null;
    }

    async ensureLocalGlyphsHydrated(names: string[]): Promise<void> {
        if (!this.localSparseHydrator?.isActive() || !names.length) {
            return;
        }
        await this.localSparseHydrator.ensureHydrated({
            glyphNames: names,
            purpose: 'ui'
        });
    }

    async hydrateAllLocalGlyphs(): Promise<void> {
        if (!this.localSparseHydrator?.isActive()) {
            return;
        }
        await this.localSparseHydrator.hydrateAll();
    }

    async ensureSparseHydration(input: {
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }): Promise<string[]> {
        if (this.localSparseHydrator?.isActive()) {
            return this.localSparseHydrator.ensureHydrated(input);
        }
        const plugin = window.cloudPlugin as
            | {
                  activeAssetId?: string | null;
                  ensureSparseHydration?: (req: {
                      text?: string;
                      glyphNames?: string[];
                      purpose?: 'ui' | 'compile';
                  }) => Promise<string[]>;
              }
            | undefined;
        if (
            typeof plugin?.ensureSparseHydration === 'function' &&
            plugin.activeAssetId
        ) {
            return plugin.ensureSparseHydration(input);
        }
        return [];
    }

    async ensureSparseHydrationForCompile(
        textOverride?: string,
        explicitGlyphNames?: string[]
    ): Promise<void> {
        if (!this.isHydrationSparse()) {
            return;
        }
        const isLocal = this.localSparseHydrator?.isActive() === true;
        const plugin = window.cloudPlugin as
            | {
                  activeAssetId?: string | null;
                  ensureSparseHydration?: (input: {
                      text?: string;
                      glyphNames?: string[];
                      purpose?: 'ui' | 'compile';
                  }) => Promise<string[]>;
              }
            | undefined;
        if (
            !isLocal &&
            (typeof plugin?.ensureSparseHydration !== 'function' ||
                !plugin.activeAssetId)
        ) {
            return;
        }
        const currentGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            null;
        const text =
            typeof textOverride === 'string' && textOverride.length > 0
                ? textOverride
                : this.resolveEditingTextForCompile();
        const explicitList = Array.isArray(explicitGlyphNames)
            ? explicitGlyphNames.filter(Boolean)
            : [];
        const coverageKey = `${this.currentFont?.changeVersion ?? 0}\0${text}\0${currentGlyphName || ''}\0${explicitList.join(',')}`;
        if (this.coveredSparseHydrationKey === coverageKey) {
            return;
        }
        const request = {
            text,
            glyphNames: [
                ...explicitList,
                ...(currentGlyphName ? [currentGlyphName] : []),
                ...this.getLiveVisibleGlyphNames()
            ],
            // Local sparse fonts only need forward prerequisites to compile and
            // render the active text; composites hydrate on demand in <3 ms when
            // edited. Cloud sparse rooms keep `ui` to match sparse open.
            purpose: (isLocal ? 'compile' : 'ui') as 'compile' | 'ui'
        };
        if (typeof this.ensureSparseHydration === 'function') {
            await this.ensureSparseHydration(request);
        } else if (isLocal && this.localSparseHydrator) {
            await this.localSparseHydrator.ensureHydrated(request);
        } else if (typeof plugin?.ensureSparseHydration === 'function') {
            await plugin.ensureSparseHydration(request);
        }
        this.coveredSparseHydrationKey = coverageKey;
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

    syncSerializedDrawingIntoObjectModel(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer
    ): Babelfont.Layer | null {
        const currentFont = this.currentFont;
        const modelDrawing = currentFont?.fontModel
            ?.findGlyph(glyphName)
            ?.findDrawingById(drawingId);

        if (!modelDrawing) {
            return null;
        }

        if (typeof modelDrawing.syncFromEditorDrawingData === 'function') {
            withSuppressedModelRecording(() => {
                modelDrawing.syncFromEditorDrawingData({
                    width: drawingData.width,
                    ...(drawingData.height !== undefined
                        ? { height: drawingData.height }
                        : {}),
                    ...(drawingData.vertWidth !== undefined
                        ? { vertWidth: drawingData.vertWidth }
                        : {}),
                    ...(drawingData.shapes !== undefined
                        ? { shapes: drawingData.shapes }
                        : {}),
                    ...(drawingData.anchors !== undefined
                        ? { anchors: drawingData.anchors }
                        : {}),
                    ...(drawingData.guides !== undefined
                        ? { guides: drawingData.guides }
                        : {}),
                    ...(drawingData.format_specific !== undefined
                        ? { format_specific: drawingData.format_specific }
                        : {})
                });
            });

            const syncedDrawingData = modelDrawing.toJSON() as Babelfont.Layer &
                Record<string, unknown>;
            Object.assign(syncedDrawingData, {
                ...(drawingData.name !== undefined
                    ? { name: drawingData.name }
                    : {}),
                ...(drawingData.location !== undefined
                    ? { location: drawingData.location }
                    : {}),
                ...(drawingData.color !== undefined
                    ? { color: drawingData.color }
                    : {}),
                ...(drawingData.background_layer_id !== undefined
                    ? {
                          background_layer_id: drawingData.background_layer_id
                      }
                    : {}),
                ...(drawingData.layer_index !== undefined
                    ? { layer_index: drawingData.layer_index }
                    : {}),
                ...(drawingData.is_background !== undefined
                    ? { is_background: drawingData.is_background }
                    : {}),
                ...(drawingData.master !== undefined
                    ? { master: drawingData.master }
                    : {}),
                id: drawingId
            });

            modelDrawing.invalidateContentCaches();
            return syncedDrawingData;
        }

        const rawDrawingData = modelDrawing.toJSON() as Babelfont.Layer &
            Record<string, unknown>;
        Object.assign(rawDrawingData, drawingData);

        modelDrawing.invalidateContentCaches();

        return rawDrawingData;
    }

    private syncSerializedDrawingIntoStoredFontData(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer
    ): Babelfont.Layer | null {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return null;
        }

        const storedDrawing = glyph.layers.find(
            (drawing) => drawing.id === drawingId
        );
        if (!storedDrawing) {
            return null;
        }

        const mutableStoredDrawing = storedDrawing as unknown as Record<
            string,
            unknown
        >;

        for (const key of Object.keys(storedDrawing)) {
            if (!Object.prototype.hasOwnProperty.call(drawingData, key)) {
                delete mutableStoredDrawing[key];
            }
        }

        Object.assign(storedDrawing, drawingData);
        return storedDrawing;
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

    private normalizeDrawingForRust(drawingData: any): any {
        if (!drawingData || typeof drawingData !== 'object') {
            return drawingData;
        }

        assertFiniteDrawingWidth(drawingData.width, {
            layerId:
                typeof drawingData.id === 'string' ? drawingData.id : undefined,
            operation: 'normalizeDrawingForRust'
        });

        const shapes = Array.isArray(drawingData.shapes)
            ? drawingData.shapes.map((shape: any) =>
                  this.normalizeShapeForRust(shape)
              )
            : [];

        const normalizedDrawing = {
            ...drawingData,
            shapes,
            ...(Array.isArray(drawingData.anchors)
                ? {
                      anchors: drawingData.anchors.map((anchor: any) => ({
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
            ...(Array.isArray(drawingData.guides)
                ? {
                      guides: drawingData.guides.map((guide: any) => ({
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
            drawingData.height
        );
        if (normalizedHeight === undefined) {
            delete normalizedDrawing.height;
        } else {
            normalizedDrawing.height = normalizedHeight;
        }

        const normalizedVertWidth = this.normalizeOptionalFiniteNumber(
            drawingData.vertWidth
        );
        if (normalizedVertWidth === undefined) {
            delete normalizedDrawing.vertWidth;
        } else {
            normalizedDrawing.vertWidth = normalizedVertWidth;
        }

        const normalizedLocation = this.normalizeLocationForRust(
            drawingData.location
        );
        if (normalizedLocation) {
            normalizedDrawing.location = normalizedLocation;
        } else {
            delete normalizedDrawing.location;
        }

        return normalizedDrawing;
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

        const generation = ++this.editingCompileEnqueueGen;
        if (this.editingCompileInFlight) {
            if (
                typeof this.currentFont.requestRecompileWithoutDataChange ===
                'function'
            ) {
                this.currentFont.requestRecompileWithoutDataChange();
            } else {
                this.currentFont.compileRequestVersion =
                    Number(this.currentFont.compileRequestVersion || 0) + 1;
            }
            try {
                await this.editingCompileInFlight;
            } catch {
                /* in-flight compile already reported */
            }
            if (generation !== this.editingCompileEnqueueGen) {
                return this.editingFont;
            }
        }

        const run = this.compileEditingFontUnqueued(
            text,
            features,
            subsetGlyphs
        );
        this.editingCompileInFlight = run;
        try {
            return await run;
        } finally {
            if (this.editingCompileInFlight === run) {
                this.editingCompileInFlight = null;
            }
        }
    }

    private async compileEditingFontUnqueued(
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
            compileSource === 'station-reinterpolate-batch';
        let isMouseDragSource = compileSource.startsWith('mouse-drag');
        let isKeyboardSource = compileSource.startsWith('keyboard');
        let isRemoteSource = compileSource.startsWith('remote-');
        let isStationReinterpolateBatchSource =
            compileSource === 'station-reinterpolate-batch';
        const forceFullWorkerCompileAtStart = this.forceFullEditingCacheRefresh;
        const shouldPrepareIncrementalDrawingUpdate =
            (isMouseDragSource || isKeyboardSource) &&
            !forceFullWorkerCompileAtStart;
        const activeDirtyGlyphName = shouldPrepareIncrementalDrawingUpdate
            ? window.glyphCanvas?.outlineEditor?.currentGlyphName ||
              window.glyphCanvas?.getCurrentGlyphName?.() ||
              null
            : null;
        const activeDirtyDrawingId = shouldPrepareIncrementalDrawingUpdate
            ? window.glyphCanvas?.outlineEditor?.selectedDrawingId || null
            : null;
        const canUseIncrementalDirtyDrawingPatch = (() => {
            if (!activeDirtyGlyphName || !activeDirtyDrawingId) {
                return false;
            }

            const dirtyGlyph = this.currentFont.fontModel?.glyphs?.find(
                (glyph: any) => glyph?.name === activeDirtyGlyphName
            );
            if (!dirtyGlyph) {
                return false;
            }

            return dirtyGlyph.drawings?.some(
                (drawing: any) => drawing?.id === activeDirtyDrawingId
            );
        })();

        // Capture whether JSON was stale before sync clears the flag,
        // so validateFontDataForRust knows to run.
        const wasJsonStale = this.pendingBabelfontJsonSyncAfterDrag;

        // Always sync when the JSON is stale (e.g. after undo/redo/remote sync),
        // even during incremental editing compiles, so the Rust compiler never
        // receives stale format artifacts from the model.
        const canKeepStaleJsonDuringActiveMouseDrag =
            wasJsonStale &&
            canUseIncrementalDirtyDrawingPatch &&
            isMouseDragSource;
        const canSkipCanonicalJsonSyncForStartupCompile =
            startupOpenSessionActive &&
            (fontCompilation.hasWorkerCacheDocument() ||
                fontCompilation.hasPendingWorkerDocumentSync());
        // Typing changes the shaped subset, not the font: the worker compiles
        // from its own document, so serializing (and validating) the whole
        // model again on every keystroke would only repeat work. The typing
        // path sets only lastChangeSource; an edit records its own context
        // for the revision, and then the model is synced as usual.
        const canSkipCanonicalJsonSyncForTextInput =
            this.lastChangeSource === 'text-input' &&
            !incrementalChangeSource &&
            !wasJsonStale &&
            fontCompilation.hasWorkerCacheDocument();
        const canSkipCanonicalJsonSyncForRequest =
            hasExplicitWorkerFreshnessAtRequest() ||
            canKeepStaleJsonDuringActiveMouseDrag ||
            canSkipCanonicalJsonSyncForStartupCompile ||
            canSkipCanonicalJsonSyncForTextInput;

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
            const preCompileContext = this.getEditingCompileContextForRequest(
                String(this.currentFont.compileRequestVersion)
            );
            const isTextInputRequest =
                preCompileContext.changeSource === 'text-input' ||
                this.lastChangeSource === 'text-input';
            const isLocalSparseTextInput =
                isTextInputRequest &&
                this.isLocalSparseFont() &&
                window.glyphCanvas?.textRunEditor
                    ?.lastTextChangeWasKeystroke === true;

            if (!isLocalSparseTextInput) {
                await this.ensureSparseHydrationForCompile(
                    resolvedText,
                    subsetGlyphs
                );
            }
            // Compute layout closure subset
            let glyphsToInclude = subsetGlyphs;
            if (this.isLocalSparseFont()) {
                glyphsToInclude = this.normalizeSubsetGlyphs([
                    ...(glyphsToInclude || []),
                    ...this.deriveSubsetGlyphsFromText(resolvedText)
                ]);
            } else if (this.isHydrationSparse()) {
                glyphsToInclude = this.normalizeSubsetGlyphs([
                    ...(glyphsToInclude || []),
                    ...this.deriveSubsetGlyphsFromText(resolvedText),
                    ...this.getLiveVisibleGlyphNames()
                ]);
            }
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
                            window.glyphCanvas?.releaseDeferredPaintAfterFailedCompile?.();
                            return this.editingFont;
                        }
                    }
                }
            }

            if (isTextInputRequest) {
                glyphsToInclude = this.expandStickyTypingSubset(
                    resolvedText,
                    glyphsToInclude
                );
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
            if (isLocalSparseTextInput) {
                // `fontc-worker`'s FONT_CACHE already holds the complete local
                // font, so compile immediately in 1 worker hop and hydrate
                // main-thread JS shards asynchronously after compile returns.
                const catalogByName =
                    this.localSparseHydrator?.getBootstrap().glyphIdByName;
                if (catalogByName && catalogByName.size > 0) {
                    const filtered = glyphsToInclude.filter((name) =>
                        catalogByName.has(name)
                    );
                    if (filtered.length > 0) {
                        glyphsToInclude = filtered;
                    }
                }
            } else {
                glyphsToInclude =
                    this.constrainSubsetToHydratedGlyphs(glyphsToInclude);
            }
            this.updateEditingSubsetSnapshot(glyphsToInclude);
            this.notifyActiveEditorGlyphRoom();

            if (startupOpenSessionActive) {
                const incomingSubsetKey = `${this.currentFont.compileRequestVersion}\0${this.createSubsetKey(glyphsToInclude)}`;
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
                    window.glyphCanvas?.releaseDeferredPaintAfterFailedCompile?.();
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
                    compileSource === 'station-reinterpolate-batch';
                isMouseDragSource = compileSource.startsWith('mouse-drag');
                isKeyboardSource = compileSource.startsWith('keyboard');
                isRemoteSource = compileSource.startsWith('remote-');
                isStationReinterpolateBatchSource =
                    compileSource === 'station-reinterpolate-batch';
                dragActiveAtRequest =
                    isMouseDragSource ||
                    !!window.glyphCanvas?.outlineEditor?.draggingSomething;
                const forceFullWorkerCompile = forceFullWorkerCompileAtStart;
                if (forceFullWorkerCompile) {
                    this.forceFullEditingCacheRefresh = false;
                }
                const plan = compilationPlan({
                    changeSource: incrementalChangeSource,
                    editType: editTypeAtRequest,
                    dataFreshnessMode: dataFreshnessModeAtRequest,
                    forceFull: forceFullWorkerCompile
                });
                compilationMode = plan.skipCompile
                    ? 'full'
                    : plan.compilationMode;
                const optionOverrides = plan.optionOverrides;

                // Pre-compilation validation: assert canonical shape/array
                // structure before any compile path that still consumes the
                // local babelfont JSON string. Request-scoped worker freshness
                // means compileEditingCached will compile from the worker Y.Doc
                // instead, including feature-code commits once the worker cache
                // is proven fresh for this request.
                if (
                    !hasExplicitWorkerFreshnessAtRequest() &&
                    !canSkipCanonicalJsonSyncForStartupCompile &&
                    !canSkipCanonicalJsonSyncForTextInput
                ) {
                    this.validateFontDataForRust(
                        this.currentFont,
                        wasJsonStale || this.pendingBabelfontJsonSyncAfterDrag
                    );
                }

                const compileFilters = optionOverrides?.skip_features
                    ? {
                          drawingUpdates: [] as Array<{
                              glyphName: string;
                              layerId: string;
                              layerData: unknown;
                          }>,
                          features: ''
                      }
                    : await prepareCompileFilters(subsetForCompile ?? null);
                if (compileFilters.drawingUpdates.length > 0) {
                    await this.sendWorkerPreviewDrawingOverlay(
                        compileFilters.drawingUpdates as Array<{
                            glyphName: string;
                            layerId: string;
                            layerData: Babelfont.Layer;
                        }>,
                        compileFilters.drawingUpdates.map(
                            (update) => update.glyphName
                        ),
                        true
                    );
                }
                if (!optionOverrides?.skip_features) {
                    fontCompilation.setCompileFeatureOverlay(
                        compileFilters.features || ''
                    );
                }

                const fusedPreviewOverlay =
                    dataFreshnessModeAtRequest === 'live-drag-worker-preview'
                        ? this.pendingFusedPreviewOverlay
                        : null;
                if (fusedPreviewOverlay) {
                    this.pendingFusedPreviewOverlay = null;
                }

                result = await fontCompilation.compileEditingFromJsonCached(
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
                        usePreviewDrawingOverlay:
                            dataFreshnessModeAtRequest ===
                            'live-drag-worker-preview',
                        ...(fusedPreviewOverlay
                            ? { previewOverlay: fusedPreviewOverlay }
                            : undefined)
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
                const mayApplyKerningProgress =
                    compilationMode === 'kerning-only' &&
                    Number.isFinite(previewRevision) &&
                    previewRevision > this.lastAppliedEditingRevision;
                isStaleCompileResult =
                    responseRevisionKey !== currentRevisionKey &&
                    !mayApplyLivePreview &&
                    !mayApplyKerningProgress;
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
            if (Number.isFinite(Number(responseRevisionKey))) {
                this.lastAppliedEditingRevision = Math.max(
                    this.lastAppliedEditingRevision,
                    Number(responseRevisionKey)
                );
            }
            timelineSpanEnd(applyCompiledResultSpanId);
            if (isLocalSparseTextInput && glyphsToInclude.length > 0) {
                const bgText = resolvedText;
                const bgGlyphs = glyphsToInclude;
                window.setTimeout(() => {
                    void this.ensureSparseHydrationForCompile(
                        bgText,
                        bgGlyphs
                    ).catch(() => undefined);
                }, 0);
            }
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

            // Track compilation mode for axis/drawing switch gating
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
                    const jsonStr = this.currentFont?.builtBabelfontJson || '';
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
                const glyph =
                    fontModel.findGlyphByCodepoint(codepoint) ??
                    (typeof this.findCatalogGlyphByCodepoint === 'function'
                        ? this.findCatalogGlyphByCodepoint(codepoint)
                        : null);
                pushMappedGlyph(glyph?.name);
                index += codepoint > 0xffff ? 2 : 1;
            } else {
                index += 1;
            }
        }

        const fontJson = this.currentFont?.babelfontData as
            Record<string, unknown> | undefined;
        const isLocalSparse =
            typeof this.isLocalSparseFont === 'function' &&
            this.isLocalSparseFont();
        if (fontJson && !isLocalSparse) {
            const catalog = catalogEntriesForDepsParse(fontJson);
            const idToName = new Map(
                catalog.map((entry) => [entry.glyphId, entry.name])
            );
            for (const glyphId of seedGlyphIdsFromText(fontJson, text)) {
                pushGlyph(idToName.get(glyphId));
            }
            for (const name of layoutSubstitutionNamesFromSeeds({
                fontJson,
                seedNames: subset.filter((name) => name !== notdefName)
            })) {
                pushGlyph(name);
            }
            for (const name of closeComponentNamesFromFontJson({
                fontJson,
                seedNames: subset.filter((name) => name !== notdefName)
            })) {
                pushGlyph(name);
            }
            const depsDoc = window.patchSyncEngine?.depsDoc;
            if (depsDoc) {
                for (const name of closeReverseComponentNamesFromDeps({
                    edges: readFontDepsIndex(depsDoc.getMap('deps')).edges,
                    seedNames: subset.filter((name) => name !== notdefName),
                    catalog: catalogEntriesForDepsParse(fontJson)
                })) {
                    pushGlyph(name);
                }
            }
        }

        const componentQueue = subset.filter((name) => name !== notdefName);
        for (let index = 0; index < componentQueue.length; index += 1) {
            const glyph = fontModel.findGlyph(componentQueue[index]);
            const drawings = Array.isArray(glyph?.drawings)
                ? glyph.drawings
                : [];
            for (const drawing of drawings) {
                const shapes = Array.isArray(drawing?.shapes)
                    ? drawing.shapes
                    : [];
                for (const shape of shapes) {
                    const shapeRecord = shape as unknown as {
                        reference?: unknown;
                        data?: { reference?: unknown };
                    };
                    const reference =
                        (typeof shapeRecord.reference === 'string' &&
                            shapeRecord.reference) ||
                        (typeof shapeRecord.data?.reference === 'string' &&
                            shapeRecord.data.reference);
                    if (
                        typeof reference === 'string' &&
                        reference &&
                        !seen.has(reference)
                    ) {
                        pushGlyph(reference);
                        componentQueue.push(reference);
                    }
                }
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

        // Multi-drawing structural edits can enqueue an explicit worker cache
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
            changeSource === 'station-reinterpolate-batch';

        let subsetGlyphs = this.getEditingSubsetSnapshot();

        // A stale narrow snapshot (e.g. a one-glyph forced compile while the
        // text run still shows more glyphs) must not win over the current
        // editing text / visible run. Merge text-derived and live-visible
        // glyphs so dependents like adieresis stay in the editing subset.
        const textBuffer = this.resolveEditingTextForCompile(
            this.currentText || ''
        );
        await this.ensureSparseHydrationForCompile();
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
            this.notifyActiveEditorGlyphRoom();
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
     * Call this before axis slider changes or drawing switches that depend
     * on correct HarfBuzz positioning.
     * Returns a promise that resolves when the full compile is ready.
     */
    async ensureFullEditingCompile(): Promise<void> {
        if (this.lastCompilationMode === 'full') {
            return; // Already have a full compile
        }
        console.log(
            '[FontManager] Forcing full compile before axis/drawing change'
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
     * Validate the font's canonical serialization before Rust compilation.
     * It is read glyph by glyph (`OpenedFont.serializedFontData`), so no
     * string holds the whole font.
     */
    private validateFontDataForRust(
        font: OpenedFont,
        forceValidation: boolean = false
    ): void {
        // Only run full validation when needed.
        // `pendingBabelfontJsonSyncAfterDrag` is set after undo/redo/remote-sync
        // to catch Y.Doc roundtrip corruption that toJSONString's replacer misses.
        const needsValidation =
            forceValidation || this.pendingBabelfontJsonSyncAfterDrag;

        // During a stream of interactive edits the serialization is not
        // re-synced from the model (sync is deferred to the debounced full
        // compile), so the same serialization would otherwise be validated
        // again on every keystroke.
        const cached = this._validatedFontSerialization;
        if (
            cached &&
            cached.font === font &&
            cached.epoch === font.serializationEpoch
        ) {
            return;
        }
        this._validatedFontSerialization = {
            font,
            epoch: font.serializationEpoch
        };

        if (!needsValidation) {
            return;
        }
        this.validateBabelfontDataForRust(
            font.serializedFontData(),
            forceValidation
        );
    }

    /**
     * Validate canonical babelfont data, as parsed from its JSON.
     * Rejects wrapped shapes, invalid path node values, and object-for-array drift.
     */
    private validateBabelfontDataForRust(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any,
        forceValidation: boolean
    ): void {
        try {
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

            // A drawing's station link is checked, never rewritten: a
            // drawing without a valid one is refused.
            if (Array.isArray(data?.glyphs)) {
                data.glyphs.forEach((glyph: any, glyphIndex: number) => {
                    if (!glyph || !Array.isArray(glyph.layers)) {
                        return;
                    }
                    glyph.layers.forEach(
                        (drawing: any, drawingIndex: number) => {
                            if (!drawing || typeof drawing !== 'object') {
                                return;
                            }
                            const violation = describeDrawingStationViolation(
                                drawing.master,
                                { isBackground: drawing.is_background === true }
                            );
                            if (violation) {
                                throw new TypeError(
                                    `Glyph “${glyph.name}” drawing ${drawing.id ?? `glyphs[${glyphIndex}].layers[${drawingIndex}]`}: ${violation}.`
                                );
                            }
                        }
                    );
                });
            }

            assertBabelfontDrawingWidths(data, 'validateBabelfontDataForRust');

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
                    // Cloud catalog entries encode codepoints as a compact
                    // membership map (for example {"65": true}); glyph
                    // records still require their codepoints to be arrays.
                    const isCloudCatalogCodepoints =
                        field === 'codepoints' &&
                        path.startsWith('.glyphCatalog.');
                    if (
                        field in val &&
                        val[field] !== null &&
                        typeof val[field] === 'object' &&
                        !Array.isArray(val[field]) &&
                        !isCloudCatalogCodepoints
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
                assertBabelfontDrawingWidths(
                    data,
                    'validateBabelfontDataForRust'
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
                                const drawing = glyph.layers[li];
                                if (
                                    drawing?.shapes &&
                                    Array.isArray(drawing.shapes)
                                ) {
                                    for (
                                        let si = 0;
                                        si < drawing.shapes.length;
                                        si++
                                    ) {
                                        const shape = drawing.shapes[si];
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
                                                `[FontManager] Malformed shape: glyph=${glyph.name}, drawing=${drawing.id}, shape[${si}]: ` +
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

            if (forceValidation) {
                console.log(
                    `[FontManager] Validation ran (forceValidation=${forceValidation}), no issues found`
                );
            }
        } catch (e) {
            // Every validation failure stops the compile; none is skipped.
            console.error('[FontManager] Font data failed validation:', e);
            throw e;
        }
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
            throw error;
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

    private serializeDrawingForStorage(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer,
        options?: {
            authoritativeOptionalDrawingFields?: Array<
                'anchors' | 'guides' | 'format_specific'
            >;
        }
    ): Babelfont.Layer | null {
        const hasOwnKeys = (value: unknown): value is Record<string, unknown> =>
            !!value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0;

        const copyPersistedDrawingFields = (value: Record<string, unknown>) => {
            const {
                anchors: _anchors,
                guides: _guides,
                format_specific: _formatSpecific,
                ...persistedFields
            } = omitRestingDrawingRuntimeKeys(value);
            return persistedFields;
        };

        const cleanShapeForSaving = (shape: Babelfont.Shape): any => {
            return toRestingShapeJson(shape, {
                allowWrapped: true,
                strict: true,
                context: 'drawing storage serialization'
            });
        };

        const originalDrawing = this.getGlyph(glyphName)?.layers?.find(
            (entry: any) => entry.id === drawingId
        );
        const existingDrawing = originalDrawing;
        if (!originalDrawing && !drawingData) {
            return null;
        }
        const authoritativeOptionalDrawingFields = new Set(
            options?.authoritativeOptionalDrawingFields
        );

        // This writes a whole drawing: its width and shapes come from the
        // drawing being written, never from the stored copy. A drawing
        // without them is refused rather than completed from storage.
        if (!drawingData) {
            throw new Error(
                `Couldn’t store drawing ${glyphName}/${drawingId}: no drawing was given.`
            );
        }
        const resolvedWidth = drawingData.width;
        assertFiniteDrawingWidth(resolvedWidth, {
            glyphName,
            layerId: drawingId,
            operation: 'serializeDrawingForStorage'
        });
        if (!Array.isArray(drawingData.shapes)) {
            throw new Error(
                `Couldn’t store drawing ${glyphName}/${drawingId}: it has no shapes list, and a whole drawing must carry its shapes.`
            );
        }
        const storedShapes = drawingData.shapes.map(cleanShapeForSaving);

        const cleanAnchors =
            Array.isArray(drawingData.anchors) &&
            (drawingData.anchors.length > 0 ||
                Array.isArray(originalDrawing?.anchors) ||
                authoritativeOptionalDrawingFields.has('anchors'))
                ? drawingData.anchors.map((anchor) => {
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
                : originalDrawing?.anchors;

        const cleanGuides =
            Array.isArray(drawingData.guides) &&
            (drawingData.guides.length > 0 ||
                Array.isArray(originalDrawing?.guides) ||
                authoritativeOptionalDrawingFields.has('guides'))
                ? drawingData.guides.map((guide) => {
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
                : originalDrawing?.guides;

        const formatSpecific =
            hasOwnKeys(drawingData.format_specific) ||
            authoritativeOptionalDrawingFields.has('format_specific')
                ? drawingData.format_specific
                : hasOwnKeys(originalDrawing?.format_specific)
                  ? originalDrawing?.format_specific
                  : undefined;

        const drawingName = drawingData.name ?? originalDrawing?.name;

        return toRestingDrawingJson(
            {
                ...(originalDrawing
                    ? copyPersistedDrawingFields(originalDrawing as any)
                    : {}),
                ...copyPersistedDrawingFields(drawingData as any),
                width: resolvedWidth,
                ...(drawingData.height !== undefined && {
                    height: drawingData.height
                }),
                ...(drawingData.vertWidth !== undefined && {
                    vertWidth: drawingData.vertWidth
                }),
                ...(drawingName !== undefined && { name: drawingName }),
                id: drawingId,
                master: originalDrawing?.master ?? drawingData.master,
                shapes: storedShapes,
                ...(cleanAnchors && { anchors: cleanAnchors }),
                ...(cleanGuides && { guides: cleanGuides }),
                ...((drawingData.color ?? originalDrawing?.color) && {
                    color: drawingData.color ?? originalDrawing?.color
                }),
                ...(drawingData.layer_index !== undefined && {
                    layer_index: drawingData.layer_index
                }),
                ...(drawingData.is_background !== undefined
                    ? { is_background: drawingData.is_background }
                    : originalDrawing?.is_background === true
                      ? { is_background: true }
                      : {}),
                ...((drawingData.background_layer_id ??
                    originalDrawing?.background_layer_id) && {
                    background_layer_id:
                        drawingData.background_layer_id ??
                        originalDrawing?.background_layer_id
                }),
                ...((drawingData.location ?? originalDrawing?.location) && {
                    location: {
                        ...(drawingData.location ?? originalDrawing?.location)
                    }
                }),
                ...(formatSpecific && {
                    format_specific: formatSpecific
                }),
                ...((drawingData as any).master && {
                    master: (drawingData as any).master
                })
            },
            {
                existing: originalDrawing ?? undefined,
                mode: 'replace',
                allowWrapped: true,
                context: 'drawing storage serialization'
            }
        ) as unknown as Babelfont.Layer;
    }

    private updateStoredDrawingData(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer
    ): boolean {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return false;
        }

        const drawingIndex = glyph.layers.findIndex(
            (drawing) => drawing.id === drawingId
        );
        if (drawingIndex === -1) {
            return false;
        }

        glyph.layers[drawingIndex] = drawingData;
        return true;
    }

    syncDrawingFromModelToStorage(
        glyphName: string,
        drawingId: string
    ): boolean {
        const glyph = this.currentFont?.fontModel?.findGlyph(glyphName);
        const drawing = glyph?.findDrawingById(drawingId);
        if (!drawing) {
            return false;
        }

        const serializedDrawing = this.serializeDrawingForStorage(
            glyphName,
            drawingId,
            drawing.toJSON(),
            undefined
        );
        return (
            !!serializedDrawing &&
            this.updateStoredDrawingData(
                glyphName,
                drawingId,
                serializedDrawing
            )
        );
    }

    removeStoredDrawingData(glyphName: string, drawingId: string): boolean {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return false;
        }

        const drawingIndex = glyph.layers.findIndex(
            (drawing) => drawing.id === drawingId
        );
        if (drawingIndex === -1) {
            return false;
        }

        glyph.layers.splice(drawingIndex, 1);
        return true;
    }

    private getWorkerDrawingFingerprintKey(
        glyphName: string,
        drawingId: string
    ): string {
        return `${glyphName}::${drawingId}`;
    }

    private getDrawingWorkerFingerprint(drawingData: Babelfont.Layer): string {
        return JSON.stringify(this.normalizeDrawingForRust(drawingData));
    }

    /**
     * Baseline fingerprints for changed-drawing detection.
     *
     * Historically this parsed the entire `currentFont.babelfontJson`
     * (multi-megabyte JSON) on every commit batch — a steady ~50-100ms
     * cost per edit even though the only baseline that matters is
     * "what is currently in the Rust worker cache". That state is
     * already tracked incrementally in `workerDrawingFingerprintCache`:
     * it is cleared whenever the worker cache is fully reseeded
     * (`storeFontJson`/`forceFullWorkerCacheUpdate` via
     * {@link recordFullFontCrossing}) and updated on every successful
     * `forwardWorkerYjsUpdate` batch. Returning an empty Map here
     * keeps the logic correct (a missing fingerprint forces the drawing
     * to be included in the next batch — the safe fallback) while
     * removing the per-commit JSON.parse from the hot path entirely.
     * See COMPILATION_EDIT_POLICY.md.
     */
    private getDrawingFingerprintsFromStoredJson(
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
    /** Discard JS fingerprint/epoch state that must stay coherent with the worker document. */
    private invalidateWorkerCacheMirror(): void {
        this.workerDrawingFingerprintCache.clear();
        this.lastWorkerDocumentEpoch = 0;
        this.lastWorkerFilterEpoch = 0;
        this.lastWorkerFontCacheEpoch = 0;
        this.workerMirrorQuarantined = true;
        fontCompilation?.setWorkerCacheDocumentReady(false);
    }

    private workerDrawingTargetsAreResting(
        drawingTargets: WorkerReplayTarget[]
    ): boolean {
        if (!drawingTargets.length) {
            return true;
        }
        const fontMap = window.patchSyncEngine?.fontMap;
        if (!fontMap) {
            return true;
        }

        for (const target of drawingTargets) {
            if (!target?.glyphName || !target?.layerId) {
                continue;
            }
            const drawingValue = getYPath(fontMap, [
                'glyphs',
                target.glyphName,
                'layers',
                target.layerId
            ]);
            if (drawingValue === undefined || drawingValue === null) {
                continue;
            }
            const drawingJson = fromYDrawing(drawingValue);
            if (
                !drawingJson ||
                typeof drawingJson !== 'object' ||
                Array.isArray(drawingJson)
            ) {
                continue;
            }
            const violation = describeRestingDrawingViolation(
                omitRestingDrawingRuntimeKeys(
                    drawingJson as Record<string, unknown>
                )
            );
            if (violation) {
                console.error(
                    `[FontManager] Resting-drawing preflight failed for ${target.glyphName}/${target.layerId}: ${violation}`
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
        drawingTargets: WorkerReplayTarget[] = [],
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

            // A document the worker lost an update for stays refused: its
            // later updates would build on the gap.
            const workerDocumentId = documentId ?? 'font-core';
            const brokenError =
                this.workerBrokenDocumentErrors.get(workerDocumentId);
            if (brokenError) {
                throw brokenError;
            }

            // Quarantine is an exceptional failure state (e.g. a prior
            // applyYjsUpdate throw). Re-seed from the authoritative bridge
            // once so later incremental edits are not stuck forever; this is
            // the same recovery class as cloud reconnect rebaseline. A
            // terminal document error is never reseeded (see
            // recoverWorkerCacheFromAuthoritativeState).
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
                drawingTargets.length > 0 ||
                glyphRenames.length > 0;
            if (
                documentId === FONT_DEPS_DOCUMENT_ID ||
                (documentId && catalogBucketOfDocument(documentId) !== null)
            ) {
                // The worker keeps no copy of these documents, so there is
                // nothing to keep in step and no gap to leave.
                return true;
            }
            if (!hasRefreshMetadata && update.length > 0) {
                // Skipping it would leave a gap in the worker's copy that
                // every later update of this document trips on. Keys no
                // compile cache reads arrive marked `cache-neutral`.
                throw new Error(
                    `Refusing to send an undescribed update for ${documentId ?? 'font-core'} to the compile worker.`
                );
            }
            const updateToSend =
                update.length > 0
                    ? update
                    : hasRefreshMetadata
                      ? NO_OP_YJS_UPDATE
                      : update;

            if (!updateToSend.length) {
                return true;
            }

            const normalizedDrawingTargets =
                normalizeWorkerReplayTargets(drawingTargets);
            if (
                !this.workerDrawingTargetsAreResting(normalizedDrawingTargets)
            ) {
                console.error(
                    '[FontManager] Refusing applyYjsUpdate; JS Y.Doc drawing is not resting JSON',
                    { changedGlyphs, layerTargets: normalizedDrawingTargets }
                );
                return false;
            }

            // A glyph delete empties the glyph's map. The worker must still
            // see that packet: it drops the emptied glyph, and a later packet
            // of the same document (an undo of the delete) builds on it.
            try {
                // A glyph document the worker does not hold yet (a new
                // glyph, or one loaded since the seed) gets its whole state
                // first; the worker refuses an update for it otherwise.
                await fontCompilation.ensureWorkerHoldsDocument(documentId);
                const response = await fontCompilation.sendMessage({
                    type: 'applyYjsUpdate',
                    update: updateToSend,
                    changedGlyphs,
                    nonGlyphChangeHints,
                    ...(normalizedDrawingTargets.length
                        ? { layerTargets: normalizedDrawingTargets }
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

                if (response?.skipped === 'catalog_document') {
                    // The worker compiles nothing from the catalog rooms
                    // (glyph names come from glyph documents), so skipping
                    // one leaves its cache as coherent as it was.
                    return true;
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
                if (isTerminalWorkerDocumentError(error)) {
                    // The worker's copy lost an update or is broken. Mark the
                    // document broken and surface the error; nothing retries
                    // or reseeds it.
                    const failure = markTerminalWorkerDocumentError(
                        error,
                        workerDocumentId
                    );
                    this.workerBrokenDocumentErrors.set(
                        terminalWorkerErrorDocumentId(
                            failure,
                            workerDocumentId
                        ),
                        failure
                    );
                    console.error(
                        '[FontManager] The compile worker refused a Yjs update; the document is broken:',
                        { documentId: workerDocumentId, changedGlyphs },
                        failure
                    );
                    throw failure;
                }
                this.invalidateWorkerCacheMirror();
                console.error(
                    '[FontManager] Failed to send worker Yjs update:',
                    {
                        changedGlyphs,
                        invalidateLayoutClosure
                    },
                    error
                );
                throw error;
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

    /**
     * Replace the editing worker's Y.Doc set with the bridge's, in order
     * after any incremental packets already queued.
     */
    reseedWorkerFromBridge(reason: string): Promise<boolean> {
        const queuedReseed = this.workerYjsSendQueue
            .catch(() => undefined)
            .then(async () => {
                await this.workerPreviewSendQueue.catch(() => undefined);
                // A failed sync is what a reseed repairs: wait for it to
                // settle, not to succeed.
                await fontCompilation
                    ?.awaitWorkerDocumentSync()
                    .catch(() => undefined);
                return this.recoverWorkerCacheFromAuthoritativeState(reason, {
                    quiet: true
                });
            });
        this.workerYjsSendQueue = queuedReseed.catch(() => undefined);
        const cacheUpdatePromise = queuedReseed.then(() => undefined);
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        // The failure reaches the caller through the promise returned
        // below; this bookkeeping chain only clears the slot.
        void cacheUpdatePromise
            .finally(() => {
                if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                    this.workerCacheUpdatePromise = null;
                }
            })
            .catch(() => undefined);
        return queuedReseed;
    }

    private enqueueWorkerPreviewSend<T>(runSend: () => Promise<T>): Promise<T> {
        const queuedSend = this.workerPreviewSendQueue
            .catch(() => undefined)
            .then(runSend);
        this.workerPreviewSendQueue = queuedSend.catch(() => undefined);
        return queuedSend;
    }

    private async sendWorkerPreviewDrawingOverlay(
        drawingUpdates: Array<{
            glyphName: string;
            layerId: string;
            layerData: Babelfont.Layer;
        }>,
        changedGlyphs: string[],
        invalidateLayoutClosure: boolean,
        nonGlyphChangeHints: string[] = [],
        drawingTargets: WorkerReplayTarget[] = []
    ): Promise<boolean> {
        const runSend = async (): Promise<boolean> => {
            if (!fontCompilation?.isInitialized) {
                return false;
            }

            if (!drawingUpdates.length) {
                return true;
            }

            try {
                const normalizedDrawingTargets =
                    normalizeWorkerReplayTargets(drawingTargets);
                const response = await fontCompilation.sendMessage({
                    type: 'applyPreviewDrawingOverlay',
                    layerUpdates: drawingUpdates,
                    changedGlyphs,
                    nonGlyphChangeHints,
                    ...(normalizedDrawingTargets.length
                        ? { layerTargets: normalizedDrawingTargets }
                        : undefined),
                    invalidateLayoutClosure
                });

                if (response?.success === false || response?.error) {
                    return false;
                }

                return true;
            } catch (error) {
                console.warn(
                    '[FontManager] Failed to send worker preview drawing overlay:',
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
        reason: string,
        options?: { quiet?: boolean }
    ): Promise<boolean> {
        // A reseed would clear the worker's record of a document that lost
        // an update; that document stays broken until the font is opened
        // again.
        for (const [documentId, error] of this.workerBrokenDocumentErrors) {
            throw new Error(
                `The compile worker is not reseeded (${reason}): document ${documentId} is broken. ${error.message}`
            );
        }
        const documentSet = window.patchSyncEngine?.encodeDocumentSet?.();
        const bridgeState = window.patchSyncEngine?.encodeBridgeState?.();
        if (
            (!documentSet?.length && !bridgeState?.length) ||
            !fontCompilation
        ) {
            this.workerMirrorQuarantined = true;
            fontCompilation?.setWorkerCacheDocumentReady(false);
            throw new Error(
                `Cannot rebuild the compile worker’s documents without the editor’s documents (${reason}).`
            );
        }

        try {
            const recovery = documentSet?.length
                ? fontCompilation.seedWorkerDocumentSet(documentSet)
                : fontCompilation.seedWorkerYDocFromState(
                      bridgeState as Uint8Array
                  );
            await fontCompilation.trackWorkerDocumentSync(recovery);
            this.acknowledgeWorkerBridgeReseed();
            if (!options?.quiet) {
                console.warn(
                    '[FontManager] Re-seeded worker cache from authoritative bridge state:',
                    reason
                );
            }
            return true;
        } catch (error) {
            this.workerMirrorQuarantined = true;
            fontCompilation.setWorkerCacheDocumentReady(false);
            console.error(
                '[FontManager] Failed to recover worker cache from bridge state:',
                reason,
                error
            );
            if (isTerminalWorkerDocumentError(error)) {
                const failure = markTerminalWorkerDocumentError(
                    error,
                    'font-core'
                );
                this.workerBrokenDocumentErrors.set(
                    terminalWorkerErrorDocumentId(failure, 'font-core'),
                    failure
                );
                throw failure;
            }
            throw error;
        }
    }

    /**
     * Mark the editing worker as aligned with the bridge after an explicit
     * bootstrap/rebaseline `seedYdoc`. Clears quarantine so later incremental
     * packets are not forced through a redundant recover.
     */
    acknowledgeWorkerBridgeReseed(): void {
        this.workerDrawingFingerprintCache.clear();
        this.workerMirrorQuarantined = false;
        fontCompilation?.setWorkerCacheDocumentReady(true);
    }

    async recoverWorkerCacheFromBridgeState(reason: string): Promise<boolean> {
        return this.recoverWorkerCacheFromAuthoritativeState(reason);
    }

    private collectDrawingUpdatesForTargetsFromModel(
        targets: Iterable<WorkerReplayTarget>
    ): {
        updates: DrawingCacheUpdate[];
        removedFingerprintKeys: string[];
    } | null {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: DrawingCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        const seenTargets = new Set<string>();

        for (const target of targets) {
            const glyphName = target?.glyphName;
            const drawingId = target?.layerId;
            if (!glyphName || !drawingId) {
                continue;
            }

            const fingerprintKey = this.getWorkerDrawingFingerprintKey(
                glyphName,
                drawingId
            );
            if (seenTargets.has(fingerprintKey)) {
                continue;
            }
            seenTargets.add(fingerprintKey);

            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const rawModelGlyph = modelGlyph as any;
            const modelDrawing =
                rawModelGlyph?.data?.layers?.find(
                    (entry: any) => entry?.id === drawingId
                ) ??
                modelGlyph?.drawings?.find(
                    (entry: any) => entry?.id === drawingId
                );

            if (!modelDrawing) {
                removedFingerprintKeys.push(fingerprintKey);
                continue;
            }

            const rawDrawingData =
                typeof modelDrawing.toJSON === 'function'
                    ? modelDrawing.toJSON()
                    : modelDrawing;
            const serializedDrawing = this.serializeDrawingForStorage(
                glyphName,
                drawingId,
                rawDrawingData
            );
            if (!serializedDrawing) {
                return null;
            }

            updates.push({
                glyphName,
                layerId: drawingId,
                layerData: serializedDrawing
            });
        }

        return {
            updates,
            removedFingerprintKeys
        };
    }

    private collectDrawingUpdatesForTargetsFromBridge(
        targets: Iterable<WorkerReplayTarget>
    ): {
        updates: DrawingCacheUpdate[];
        removedFingerprintKeys: string[];
    } | null {
        const currentFont = this.currentFont;
        const fontMap = window.patchSyncEngine?.fontMap;
        if (!currentFont || !fontMap) {
            return null;
        }

        const updates: DrawingCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        const seenTargets = new Set<string>();

        for (const target of targets) {
            const glyphName = target?.glyphName;
            const drawingId = target?.layerId;
            if (!glyphName || !drawingId) {
                continue;
            }

            const fingerprintKey = this.getWorkerDrawingFingerprintKey(
                glyphName,
                drawingId
            );
            if (seenTargets.has(fingerprintKey)) {
                continue;
            }
            seenTargets.add(fingerprintKey);

            const bridgeDrawing = getYPath(fontMap, [
                'glyphs',
                glyphName,
                'layers',
                drawingId
            ]);
            if (!bridgeDrawing) {
                removedFingerprintKeys.push(fingerprintKey);
                continue;
            }

            const rawDrawingData = fromYType(bridgeDrawing) as Babelfont.Layer;
            let serializedDrawing = this.serializeDrawingForStorage(
                glyphName,
                drawingId,
                rawDrawingData
            );
            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const modelDrawing = modelGlyph?.drawings?.find(
                (entry: any) => entry?.id === drawingId
            );
            const rawModelDrawingData =
                typeof modelDrawing?.toJSON === 'function'
                    ? modelDrawing.toJSON()
                    : modelDrawing;
            const modelSerializedDrawing = rawModelDrawingData
                ? this.serializeDrawingForStorage(
                      glyphName,
                      drawingId,
                      rawModelDrawingData
                  )
                : null;
            if (
                serializedDrawing &&
                modelSerializedDrawing &&
                Array.isArray(modelSerializedDrawing.shapes) &&
                modelSerializedDrawing.shapes.length > 0 &&
                (!Array.isArray(serializedDrawing.shapes) ||
                    serializedDrawing.shapes.length === 0)
            ) {
                serializedDrawing = modelSerializedDrawing;
            }
            if (!serializedDrawing) {
                return null;
            }

            updates.push({
                glyphName,
                layerId: drawingId,
                layerData: serializedDrawing
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
        // The failure reaches the caller through the promise returned
        // below; this bookkeeping chain only clears the slot.
        void cacheUpdatePromise
            .finally(() => {
                if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                    this.workerCacheUpdatePromise = null;
                }
            })
            .catch(() => undefined);

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
        const normalizedDrawingTargets = normalizeWorkerReplayTargets(
            options?.layerTargets || []
        );

        if (
            !normalizedChangedGlyphs.length &&
            !normalizedDrawingTargets.length
        ) {
            return this.sendWorkerYjsUpdate(
                update,
                [],
                options?.invalidateLayoutClosure !== false,
                normalizedNonGlyphChangeHints,
                normalizedDrawingTargets,
                options?.glyphRenames || [],
                options?.documentId
            );
        }
        // Authoritative mutation is the Yjs binary already being sent.
        // Do not walk the bridge with `fromYType` just to fingerprint.
        let fingerprintUpdates: DrawingCacheUpdate[] = [];
        const removedFingerprintKeys: string[] = [];
        if (normalizedDrawingTargets.length) {
            fingerprintUpdates =
                this.collectChangedDrawingUpdatesFromTargets(
                    normalizedDrawingTargets
                ) || [];
            const fingerprintedKeys = new Set(
                fingerprintUpdates.map((update) =>
                    this.getWorkerDrawingFingerprintKey(
                        update.glyphName,
                        update.layerId
                    )
                )
            );
            for (const target of normalizedDrawingTargets) {
                const fingerprintKey = this.getWorkerDrawingFingerprintKey(
                    target.glyphName,
                    target.layerId
                );
                if (!fingerprintedKeys.has(fingerprintKey)) {
                    removedFingerprintKeys.push(fingerprintKey);
                }
            }
        } else {
            fingerprintUpdates =
                this.collectChangedDrawingUpdatesFromModel(
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
            normalizedDrawingTargets,
            options?.glyphRenames || [],
            options?.documentId
        );

        if (!sent) {
            this.workerDrawingFingerprintCache.clear();
            return false;
        }

        for (const fingerprintKey of removedFingerprintKeys) {
            this.workerDrawingFingerprintCache.delete(fingerprintKey);
        }

        const missingGlyphNames = normalizedChangedGlyphs.filter(
            (glyphName) => !this.currentFont?.fontModel?.findGlyph(glyphName)
        );
        if (missingGlyphNames.length > 0) {
            for (const fingerprintKey of Array.from(
                this.workerDrawingFingerprintCache.keys()
            )) {
                if (
                    missingGlyphNames.some((glyphName) =>
                        fingerprintKey.startsWith(`${glyphName}::`)
                    )
                ) {
                    this.workerDrawingFingerprintCache.delete(fingerprintKey);
                }
            }
        }

        const transmittedDrawingCount =
            normalizedDrawingTargets.length || fingerprintUpdates.length;
        if (transmittedDrawingCount > 0) {
            this._boundaryCrossingStats.submitBatchCalls++;
            this._boundaryCrossingStats.drawingsTransmitted +=
                transmittedDrawingCount;
            for (const drawingUpdate of fingerprintUpdates) {
                const normalizedDrawing = this.normalizeDrawingForRust(
                    drawingUpdate.layerData
                );
                this.workerDrawingFingerprintCache.set(
                    this.getWorkerDrawingFingerprintKey(
                        drawingUpdate.glyphName,
                        drawingUpdate.layerId
                    ),
                    JSON.stringify(normalizedDrawing)
                );
                this._boundaryCrossingStats.transmittedGlyphs.add(
                    drawingUpdate.glyphName
                );
            }
            for (const target of normalizedDrawingTargets) {
                this._boundaryCrossingStats.transmittedGlyphs.add(
                    target.glyphName
                );
            }
        }

        return true;
    }

    private prepareCompileFacingDrawingUpdate(
        glyphName: string,
        drawingId: string,
        rawDrawingData: Babelfont.Layer
    ): DrawingCacheUpdate {
        const storedWidth = this.getGlyph(glyphName)?.layers?.find(
            (entry: { id?: string }) => entry?.id === drawingId
        )?.width;
        const resolvedWidth =
            typeof rawDrawingData?.width === 'number' &&
            Number.isFinite(rawDrawingData.width)
                ? rawDrawingData.width
                : storedWidth;
        assertFiniteDrawingWidth(resolvedWidth, {
            glyphName,
            layerId: drawingId,
            operation: 'prepareCompileFacingDrawingUpdate'
        });
        return {
            glyphName,
            layerId: drawingId,
            layerData:
                rawDrawingData?.width === resolvedWidth
                    ? rawDrawingData
                    : { ...rawDrawingData, width: resolvedWidth }
        };
    }

    private collectChangedDrawingUpdatesFromTargets(
        targets: Iterable<WorkerReplayTarget>,
        options?: {
            skipFingerprintBaseline?: boolean;
            compileFacing?: boolean;
            explicitDrawingData?: Iterable<ExplicitDrawingCacheInput>;
        }
    ): DrawingCacheUpdate[] | null {
        const normalizedTargets = normalizeWorkerReplayTargets(targets);
        if (normalizedTargets.length === 0) {
            return [];
        }

        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: DrawingCacheUpdate[] = [];
        const explicitDrawingData = new Map<string, Babelfont.Layer>();
        for (const input of options?.explicitDrawingData || []) {
            if (input?.glyphName && input?.layerId && input?.layerData) {
                explicitDrawingData.set(
                    this.getWorkerDrawingFingerprintKey(
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
            const modelDrawing = modelGlyph?.findDrawingById?.(target.layerId);
            if (!modelDrawing) {
                console.warn(
                    '[FontManager] Missing matched drawing for preview/sync target',
                    target
                );
                continue;
            }

            const fingerprintKey = this.getWorkerDrawingFingerprintKey(
                target.glyphName,
                target.layerId
            );
            const explicitDrawing = explicitDrawingData.get(fingerprintKey);
            const rawDrawingData =
                explicitDrawing ??
                (options?.compileFacing &&
                typeof (modelDrawing as { toCompileJSON?: () => unknown })
                    .toCompileJSON === 'function'
                    ? (
                          modelDrawing as {
                              toCompileJSON: () => Babelfont.Layer;
                          }
                      ).toCompileJSON()
                    : typeof modelDrawing.toJSON === 'function'
                      ? (modelDrawing.toJSON() as Babelfont.Layer)
                      : (modelDrawing as Babelfont.Layer));

            if (options?.compileFacing) {
                updates.push(
                    this.prepareCompileFacingDrawingUpdate(
                        target.glyphName,
                        target.layerId,
                        rawDrawingData
                    )
                );
                continue;
            }

            const serializedDrawing = this.serializeDrawingForStorage(
                target.glyphName,
                target.layerId,
                rawDrawingData
            );
            if (!serializedDrawing) {
                return null;
            }

            updates.push({
                glyphName: target.glyphName,
                layerId: target.layerId,
                layerData: serializedDrawing
            });
        }

        return updates;
    }

    private collectChangedDrawingUpdatesFromModel(
        glyphNames: Iterable<string>,
        preferredDrawingId?: string | null,
        options?: {
            skipFingerprintBaseline?: boolean;
            compileFacing?: boolean;
            explicitDrawingData?: Iterable<ExplicitDrawingCacheInput>;
        }
    ): DrawingCacheUpdate[] | null {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: DrawingCacheUpdate[] = [];
        const explicitDrawingData = new Map<string, Babelfont.Layer>();
        for (const input of options?.explicitDrawingData || []) {
            if (input?.glyphName && input?.layerId && input?.layerData) {
                explicitDrawingData.set(
                    this.getWorkerDrawingFingerprintKey(
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
            : this.getDrawingFingerprintsFromStoredJson(glyphNameList);
        const sourceGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            glyphNameList[0] ||
            null;
        const sourceDrawing =
            preferredDrawingId && sourceGlyphName
                ? currentFont.fontModel
                      ?.findGlyph(sourceGlyphName)
                      ?.drawings?.find(
                          (drawing: any) => drawing?.id === preferredDrawingId
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

            const modelDrawings = preferredDrawingId
                ? [
                      glyphName === sourceGlyphName
                          ? sourceDrawing
                          : sourceDrawing?.getMatchingDrawingOnGlyph?.(
                                glyphName
                            ) ||
                            modelGlyph.drawings?.find(
                                (drawing: any) =>
                                    drawing?.id === preferredDrawingId
                            )
                  ].filter(Boolean)
                : modelGlyph.drawings || [];

            if (preferredDrawingId && modelDrawings.length === 0) {
                console.warn(
                    '[FontManager] Failed to resolve matching drawing for dependent glyph',
                    {
                        glyphName,
                        preferredLayerId: preferredDrawingId,
                        sourceGlyphName
                    }
                );
            }

            for (const modelDrawing of modelDrawings) {
                const drawingId = modelDrawing?.id;
                if (typeof drawingId !== 'string' || !drawingId) {
                    return null;
                }

                const fingerprintKey = this.getWorkerDrawingFingerprintKey(
                    glyphName,
                    drawingId
                );
                const explicitDrawing = explicitDrawingData.get(fingerprintKey);
                const rawDrawingData =
                    explicitDrawing ??
                    (options?.compileFacing &&
                    typeof modelDrawing.toCompileJSON === 'function'
                        ? modelDrawing.toCompileJSON()
                        : typeof modelDrawing.toJSON === 'function'
                          ? modelDrawing.toJSON()
                          : modelDrawing);

                if (options?.compileFacing) {
                    updates.push(
                        this.prepareCompileFacingDrawingUpdate(
                            glyphName,
                            drawingId,
                            rawDrawingData
                        )
                    );
                    continue;
                }

                const serializedDrawing = this.serializeDrawingForStorage(
                    glyphName,
                    drawingId,
                    rawDrawingData
                );
                if (!serializedDrawing) {
                    return null;
                }

                // When skipFingerprintBaseline is set (live drag), skip the
                // expensive fingerprint comparison and always include the update
                if (!options?.skipFingerprintBaseline) {
                    const modelFingerprint =
                        this.getDrawingWorkerFingerprint(serializedDrawing);
                    const baselineFingerprint =
                        this.workerDrawingFingerprintCache.get(
                            fingerprintKey
                        ) ??
                        storedJsonFingerprints.get(fingerprintKey) ??
                        null;

                    if (
                        !(
                            preferredDrawingId && glyphName === sourceGlyphName
                        ) &&
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
                    !this.updateStoredDrawingData(
                        glyphName,
                        drawingId,
                        serializedDrawing
                    )
                ) {
                    return null;
                }

                updates.push({
                    glyphName,
                    layerId: drawingId,
                    layerData: serializedDrawing
                });
            }
        }

        return updates;
    }

    private async submitDrawingUpdatesToWorkerPreview(
        updates: DrawingCacheUpdate[],
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
                layerData: this.normalizeDrawingForRust(update.layerData)
            }));

            return await this.sendWorkerPreviewDrawingOverlay(
                normalizedUpdates,
                Array.from(
                    new Set(normalizedUpdates.map((update) => update.glyphName))
                ),
                options?.invalidateLayoutClosure ?? false,
                [],
                normalizedUpdates.map(({ glyphName, layerId: drawingId }) => ({
                    glyphName,
                    layerId: drawingId
                }))
            );
        } catch (error) {
            console.warn(
                '[FontManager] Failed to submit live-drag drawing overlay to worker preview cache:',
                updates.map(({ glyphName, layerId: drawingId }) => ({
                    glyphName,
                    layerId: drawingId
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
     * expected number of batched drawing updates / full-font crossings
     * occurred.
     */
    getBoundaryCrossingStats(): BoundaryCrossingStats {
        return {
            submitBatchCalls: this._boundaryCrossingStats.submitBatchCalls,
            drawingsTransmitted:
                this._boundaryCrossingStats.drawingsTransmitted,
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
        editingFontBytes: number;
        closureCache: FontManager['closureCache'];
        glyphOrderCache: string[] | null;
        fingerprintCache: Map<string, string>;
    } {
        const fonts = Array.from(this.openedFonts.entries()).map(
            ([id, font]) => ({
                id,
                name: font.name,
                babelfontJson: font.builtBabelfontJson,
                babelfontData: font.babelfontData
            })
        );
        return {
            fonts,
            editingFontBytes: this.editingFont?.byteLength ?? 0,
            closureCache: this.closureCache,
            glyphOrderCache: this.glyphOrderCache,
            fingerprintCache: this.workerDrawingFingerprintCache
        };
    }

    /**
     * Reset the running boundary-crossing counters. Tests and the AI
     * profiling harness call this between edits to measure per-edit
     * costs in isolation.
     */
    resetBoundaryCrossingStats(): void {
        this._boundaryCrossingStats.submitBatchCalls = 0;
        this._boundaryCrossingStats.drawingsTransmitted = 0;
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
     * include every touched drawing — the safe direction — and the
     * cache is then incrementally rebuilt by subsequent successful
     * `forwardWorkerYjsUpdate` batches. This keeps the
     * fingerprint cache as the documented single source of truth (see
     * COMPILATION_EDIT_POLICY.md §11).
     */
    recordFullFontCrossing(): void {
        this._boundaryCrossingStats.fullFontCrossings++;
        this.workerDrawingFingerprintCache.clear();
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
            // forwarded bridge Yjs updates, not whole-drawing encode.
            const targetDrawingUpdates =
                this.collectDrawingUpdatesForTargetsFromBridge(
                    normalizedTargets
                ) ||
                this.collectDrawingUpdatesForTargetsFromModel(
                    normalizedTargets
                );

            if (targetDrawingUpdates) {
                for (const fingerprintKey of targetDrawingUpdates.removedFingerprintKeys) {
                    this.workerDrawingFingerprintCache.delete(fingerprintKey);
                }
                for (const update of targetDrawingUpdates.updates) {
                    const normalized = this.normalizeDrawingForRust(
                        update.layerData
                    );
                    this.workerDrawingFingerprintCache.set(
                        this.getWorkerDrawingFingerprintKey(
                            update.glyphName,
                            update.layerId
                        ),
                        JSON.stringify(normalized)
                    );
                }
            }

            // A failed worker sync is an error, not a cache that is
            // merely not refreshed.
            await fontCompilation.awaitWorkerDocumentSync();

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
        // Awaited by awaitWorkerCacheUpdate, and surfaced below.
        void cacheUpdatePromise.catch(() => undefined);
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
        let stationIds = new Set<string>();
        for (let station of this.currentFont!.babelfontData.masters) {
            stationIds.add(station.id);
        }
        let drawingsData: any[] = [];
        for (let drawing of glyph.layers || []) {
            // Include non-background drawings that are either:
            // - default drawings for their station, or
            // - free drawings (AssociatedWithMaster + non-empty location)
            if (!drawing.is_background) {
                const drawingAny = drawing as any;
                const hasTaggedStation =
                    drawingAny.master &&
                    typeof drawingAny.master === 'object' &&
                    'type' in drawingAny.master;
                const isDefaultDrawing =
                    hasTaggedStation &&
                    drawingAny.master.type === 'DefaultForMaster';
                const isAssociatedDrawing =
                    hasTaggedStation &&
                    drawingAny.master.type === 'AssociatedWithMaster';
                const hasBraceLocation =
                    !!drawing.location &&
                    Object.keys(drawing.location).length > 0;

                if (
                    isDefaultDrawing ||
                    (isAssociatedDrawing && hasBraceLocation)
                ) {
                    const stationIdStr =
                        drawingAny.master?.master || drawing.id;
                    if (stationIds.has(stationIdStr)) {
                        drawingsData.push({
                            id: drawing.id as string,
                            name: drawing.name || 'Default',
                            _station: stationIdStr,
                            location: drawing.location
                        });
                    }
                }
            }
        }
        const axes = this.currentFont!.babelfontData.axes || [];
        let axes_order = axes.map((axis: Babelfont.Axis) => axis.tag);

        let stationsData: any[] = [];
        for (let station of this.currentFont!.babelfontData
            .masters as Babelfont.Master[]) {
            let userspaceLocation = designspaceToUserspace(
                station.location || {},
                axes
            );
            // Extract station name from I18NDictionary (use 'en' or first available)
            let stationName =
                typeof station.name === 'string'
                    ? station.name
                    : station.name?.en ||
                      Object.values(station.name || {})[0] ||
                      'Unknown';
            stationsData.push({
                id: station.id,
                name: stationName,
                location: userspaceLocation
            });
        }
        return {
            glyphName: glyph.name,
            layers: drawingsData,
            masters: stationsData,
            axesOrder: axes_order
        };
    }

    serializeDrawingForCommittedSync(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer,
        options?: {
            authoritativeOptionalDrawingFields?: Array<
                'anchors' | 'guides' | 'format_specific'
            >;
        }
    ): Babelfont.Layer | null {
        return this.serializeDrawingForStorage(
            glyphName,
            drawingId,
            drawingData,
            options
        );
    }

    async saveDrawingData(
        glyphName: string,
        drawingId: string,
        drawingData: Babelfont.Layer,
        changeSource: string = 'unknown'
    ) {
        const drawingDataCopy = this.serializeDrawingForStorage(
            glyphName,
            drawingId,
            drawingData
        );
        if (!drawingDataCopy) {
            console.error(
                '[FontManager]',
                `Failed to serialize drawing ${drawingId} in glyph ${glyphName}`
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
                `Glyph ${glyphName} not found - cannot save drawing data`
            );
            return;
        }

        if (!glyph.layers) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} has no drawings - cannot save drawing data`
            );
            return;
        }

        const storedDrawing = this.syncSerializedDrawingIntoStoredFontData(
            glyphName,
            drawingId,
            drawingDataCopy
        );
        if (!storedDrawing) {
            console.error(
                '[FontManager]',
                `Failed to commit stored drawing ${drawingId} in glyph ${glyphName}`
            );
            return;
        }

        this.syncSerializedDrawingIntoObjectModel(
            glyphName,
            drawingId,
            storedDrawing
        );

        // Local drawing saves mutate the authoritative font object in place.
        // Re-point the bridge snapshot immediately so the subsequent Yjs sync
        // diffs against the just-saved drawing instead of a stale detached JSON.
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
            this.setEditingCompileContext(changeSource, null);
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

            await fontCompilation.awaitWorkerDocumentSync();
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
     * Kept for API compatibility; does not encode whole drawings into Yjs.
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
        // A failed worker update is surfaced to the caller.
        await this.workerCacheUpdatePromise;
    }

    async refreshGlyphsAfterModelBatch(
        glyphNames: Iterable<string>,
        drawingId?: string | null,
        options?: {
            dispatchGlyphChanged?: boolean;
            skipFingerprintBaseline?: boolean;
            explicitDrawingData?: Iterable<ExplicitDrawingCacheInput>;
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
            // forwardWorkerYjsUpdate; do not whole-drawing encode.
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
                                  layerId: drawingId ?? undefined
                              }
                            : {
                                  glyphName: uniqueGlyphNames[0],
                                  glyphNames: uniqueGlyphNames,
                                  layerId: drawingId ?? undefined
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
        drawingId?: string | null,
        options?: {
            dispatchGlyphChanged?: boolean;
            fuseWithNextCompile?: boolean;
            explicitDrawingData?: Iterable<ExplicitDrawingCacheInput>;
            /** When set, use these explicit per-glyph drawing targets instead of
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
            const pendingDrawingUpdates =
                explicitTargets.length > 0
                    ? this.collectChangedDrawingUpdatesFromTargets(
                          explicitTargets,
                          {
                              skipFingerprintBaseline: true,
                              compileFacing: true,
                              ...(options?.explicitDrawingData
                                  ? {
                                        explicitDrawingData:
                                            options.explicitDrawingData
                                    }
                                  : undefined)
                          }
                      )
                    : this.collectChangedDrawingUpdatesFromModel(
                          uniqueGlyphNames,
                          drawingId,
                          {
                              skipFingerprintBaseline: true,
                              compileFacing: true,
                              ...(options?.explicitDrawingData
                                  ? {
                                        explicitDrawingData:
                                            options.explicitDrawingData
                                    }
                                  : undefined)
                          }
                      );

            if (
                (options?.fuseWithNextCompile ||
                    options?.dispatchGlyphChanged === false) &&
                fontCompilation.supportsFusedPreviewCompile?.() &&
                pendingDrawingUpdates &&
                pendingDrawingUpdates.length > 0
            ) {
                const normalizedUpdates = pendingDrawingUpdates.map(
                    (update) => ({
                        glyphName: update.glyphName,
                        layerId: update.layerId,
                        layerData: this.normalizeDrawingForRust(
                            update.layerData
                        )
                    })
                );
                const mergedByKey = new Map<
                    string,
                    {
                        glyphName: string;
                        layerId: string;
                        layerData: Babelfont.Layer;
                    }
                >();
                if (this.pendingFusedPreviewOverlay) {
                    for (const existing of this.pendingFusedPreviewOverlay
                        .layerUpdates) {
                        mergedByKey.set(
                            `${existing.glyphName}\0${existing.layerId}`,
                            existing
                        );
                    }
                }
                for (const update of normalizedUpdates) {
                    mergedByKey.set(
                        `${update.glyphName}\0${update.layerId}`,
                        update
                    );
                }
                const mergedUpdates = Array.from(mergedByKey.values());
                this.pendingFusedPreviewOverlay = {
                    layerUpdates: mergedUpdates,
                    changedGlyphs: Array.from(
                        new Set(mergedUpdates.map((u) => u.glyphName))
                    ),
                    nonGlyphChangeHints: [],
                    layerTargets: normalizeWorkerReplayTargets(
                        mergedUpdates.map((u) => ({
                            glyphName: u.glyphName,
                            layerId: u.layerId
                        }))
                    ),
                    invalidateLayoutClosure: false
                };
            } else {
                this.pendingFusedPreviewOverlay = null;
                const updatedIncrementally =
                    !!pendingDrawingUpdates &&
                    pendingDrawingUpdates.length > 0 &&
                    (await this.submitDrawingUpdatesToWorkerPreview(
                        pendingDrawingUpdates
                    ));

                if (!updatedIncrementally) {
                    throw new Error(
                        'Incremental worker preview overlay failed during live drag refresh'
                    );
                }
            }
            this._stagedLinkedPreview = {
                updates: pendingDrawingUpdates,
                stagedAt: performance.now()
            };
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
                                  layerId: drawingId ?? undefined
                              }
                            : {
                                  glyphName: uniqueGlyphNames[0],
                                  glyphNames: uniqueGlyphNames,
                                  layerId: drawingId ?? undefined
                              }
            })
        );
    }

    /**
     * Post the drawings staged last to the linked windows, so they follow the
     * gesture before it commits (see linked-live-preview.ts).
     */
    broadcastLinkedLivePreview(compile: LivePreviewCompile | null): void {
        const sync = window.windowSync;
        // Each stage is posted once, by the compile request right after it;
        // a stage left over from an earlier gesture is never posted.
        const staged =
            this._stagedLinkedPreview &&
            performance.now() - this._stagedLinkedPreview.stagedAt <
                LINKED_PREVIEW_STAGE_MAX_AGE_MS
                ? this._stagedLinkedPreview.updates
                : null;
        this._stagedLinkedPreview = null;
        if (!staged?.length) {
            return;
        }
        window.patchSyncEngine?.noteLivePreviewTick?.(
            staged.map((update) => update.layerId)
        );
        if (!sync?.hasLinkedPeers?.()) {
            return;
        }
        const model: LivePreviewDrawingRecord[] = [];
        for (const update of staged) {
            const drawing = this.currentFont?.fontModel
                ?.findGlyph?.(update.glyphName)
                ?.findDrawingById?.(update.layerId);
            // Automatic drawings recompose in the receiving window.
            if (!drawing || drawing.isAutomaticAlignedDrawing?.()) {
                continue;
            }
            const drawingData = drawing.toJSON?.();
            if (drawingData && typeof drawingData === 'object') {
                model.push({
                    glyphName: update.glyphName,
                    layerId: update.layerId,
                    layerData: drawingData
                });
            }
        }
        // The window message must be plain data: drawings recomposed during
        // the drag (an automatically aligned Ä, say) can hold live model
        // arrays that cannot be copied to another window. postMessage then
        // fails, and linked windows would never see the drag.
        sync.queueLivePreview({
            overlay: staged.map((update) => ({
                glyphName: update.glyphName,
                layerId: update.layerId,
                layerData: toPlainDrawingData(update.layerData)
            })),
            model: model.map((record) => ({
                ...record,
                layerData: toPlainDrawingData(record.layerData)
            })),
            compile
        });
    }

    /**
     * Stage a collaborator’s cascade, recomposed here ahead of its documents
     * (see remote-cascade-preview.ts), as the worker’s preview overlay. It
     * waits for document updates already on their way to the worker: each
     * one drops the overlay.
     */
    async stageRemoteCascadePreview(
        targets: WorkerReplayTarget[]
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const pending = this.workerCacheUpdatePromise;
            if (!pending) {
                break;
            }
            await pending.catch(() => undefined);
        }
        const updates = this.collectChangedDrawingUpdatesFromTargets(targets, {
            skipFingerprintBaseline: true,
            compileFacing: true
        });
        if (!updates?.length) {
            return false;
        }
        return this.submitDrawingUpdatesToWorkerPreview(updates);
    }

    /** A linked window stages what the editing window posted. */
    stageLinkedLivePreviewOverlay(
        records: LivePreviewDrawingRecord[]
    ): Promise<boolean> {
        return this.submitDrawingUpdatesToWorkerPreview(records);
    }

    clearLiveDragPreview(options?: { notifyPeers?: boolean }): void {
        this._stagedLinkedPreview = null;
        this.pendingFusedPreviewOverlay = null;
        if (options?.notifyPeers !== false) {
            window.windowSync?.endLivePreview?.();
        }
        if (!fontCompilation?.isInitialized) {
            return;
        }

        this.enqueueWorkerPreviewSend(async () => {
            try {
                await fontCompilation.sendMessage({
                    type: 'clearPreviewDrawingOverlay'
                });
            } catch (error) {
                console.warn(
                    '[FontManager] Failed to clear worker preview drawing overlay:',
                    error
                );
            }
        });
    }

    /**
     * Drop a collaborator cascade's preview overlay. Only an update the
     * worker takes drops it otherwise, and a preview reverted to drawings
     * the documents already hold sends none.
     */
    clearRemoteCascadePreviewOverlay(): Promise<void> {
        if (!fontCompilation?.isInitialized) {
            return Promise.resolve();
        }
        return this.enqueueWorkerPreviewSend(async () => {
            try {
                await fontCompilation.sendMessage({
                    type: 'clearPreviewDrawingOverlay'
                });
            } catch (error) {
                console.warn(
                    '[FontManager] Failed to clear the cascade preview overlay:',
                    error
                );
            }
        });
    }

    async submitDrawingToWorkerCache(
        glyphName: string,
        drawingId: string
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }

        const glyph = this.currentFont.fontModel?.glyphs?.find(
            (entry: any) => entry?.name === glyphName
        );
        const drawing = glyph?.drawings?.find(
            (entry: any) => entry?.id === drawingId
        );
        if (!drawing) {
            return false;
        }

        const rawDrawingData =
            typeof drawing.toJSON === 'function' ? drawing.toJSON() : drawing;
        const serializedDrawing = this.serializeDrawingForStorage(
            glyphName,
            drawingId,
            rawDrawingData
        );
        if (!serializedDrawing) {
            return false;
        }

        await fontCompilation.awaitWorkerDocumentSync();

        const normalized = this.normalizeDrawingForRust(serializedDrawing);
        this.workerDrawingFingerprintCache.set(
            this.getWorkerDrawingFingerprintKey(glyphName, drawingId),
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

/** Drop the previous font's edit-mode cursor from the URL and state. */
function clearEditCursorForReplacedFont(): void {
    updateUrlState({ mode: null, cursor: null });
    if (window.stateManager) {
        window.stateManager.editor_mode = 'text';
        window.stateManager.editor_cursor_position = 0;
    }
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
    const incomingDetail = (event as CustomEvent).detail;
    const incomingPath = String(incomingDetail?.path || '');
    const incomingCloudAssetId = incomingPath.startsWith('cloud://')
        ? incomingPath.slice('cloud://'.length).replace(/^\/+/, '')
        : '';
    const currentCloudAssetId = window.cloudPlugin?.activeAssetId;
    // Cloud open sets activeAssetId before dispatching fontLoaded. Tearing
    // that session down here left URL/invitee opens with no font installed.
    if (!incomingCloudAssetId || currentCloudAssetId !== incomingCloudAssetId) {
        window.cloudPlugin?.disconnectFromRoom?.();
    }

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
    let fontModelLoaded = false;
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

    const waitForInitialOverviewRender = (openSessionId: string) => {
        if (
            !activeOpenSessionDetail ||
            activeOpenSessionDetail.openSessionId !== openSessionId ||
            !(window as Window & { glyphOverviewInstance?: unknown })
                .glyphOverviewInstance
        ) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const onOverviewRendered = (event: Event) => {
                const detail = (
                    event as CustomEvent<{ openSessionId?: string }>
                ).detail;
                if (detail?.openSessionId !== openSessionId) {
                    return;
                }
                window.removeEventListener(
                    'overviewInitialRenderComplete',
                    onOverviewRendered
                );
                resolve();
            };
            window.addEventListener(
                'overviewInitialRenderComplete',
                onOverviewRendered
            );
        });
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
        if (startupFinalizeStarted || !canvasReady || !fontModelLoaded) {
            return;
        }

        startupFinalizeStarted = true;

        try {
            if (window.glyphCanvas) {
                await ensureStartupStateReady(window.glyphCanvas);
            }

            emitOpenLifecycle(openSessionId, 'startupStateReady');
            await releaseStartupGates(openSessionId, 'canvas+state-ready');
        } catch (error) {
            console.warn(
                '[FontManager]',
                'Startup state restore failed before fontReady; continuing:',
                error
            );
            await releaseStartupGates(openSessionId, 'canvas+state-error');
        }
    };

    const releaseStartupGates = async (
        openSessionId: string,
        reason: string
    ) => {
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

        const overviewRender = waitForInitialOverviewRender(openSessionId);
        dispatchFontReadyIfNeeded(openSessionId);
        await overviewRender;
        endLoadingCursor();
        timelineSpanEnd(openSessionSpanId);
    };

    try {
        // Get the babelfont JSON from the event
        const detail = (event as CustomEvent).detail;
        const openSessionId = createOpenSessionId();
        const openedAt = performance.now();

        // Each open must re-run URL/state restore; otherwise a concurrent setFont
        // can keep stomping axes to the font default after the first session.
        resetStartupStateReady();

        // A replaced font opens in text mode. The URL and state manager still
        // hold the previous font's edit-mode cursor, which the restore above
        // must not apply to a different font.
        if (fontManager?.currentFont) {
            clearEditCursorForReplacedFont();
        }

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

        // Listen before loading: a compile still landing from an earlier open
        // in this window can shape and signal this session while its font
        // loads, and the canvas sends that signal once per session.
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
            void finalizeStartupReadiness(openSessionId);
        };

        window.addEventListener('canvasInitialReady', canvasReadyListener);

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

        // Load font into font manager. A linked snapshot already built the
        // object from the main window's resident shards.
        const residentFontData = (
            detail as { residentFontData?: Record<string, unknown> }
        ).residentFontData;
        const localSparse = (
            detail as {
                localSparse?: {
                    bootstrap: LocalSparseBootstrapPayload;
                    initialGlyphs: Array<Record<string, unknown>>;
                };
            }
        ).localSparse;
        if (residentFontData) {
            fontManager!.adoptResidentFont(
                residentFontData,
                detail.path,
                detail.sourcePlugin,
                detail.fileHandle,
                detail.directoryHandle
            );
        } else if (localSparse) {
            await fontManager!.loadFontSparse(
                localSparse.bootstrap,
                localSparse.initialGlyphs,
                detail.path,
                detail.sourcePlugin,
                detail.fileHandle,
                detail.directoryHandle
            );
            const sourceSnapshot = (
                detail as { sourceSnapshot?: SourceSnapshot }
            ).sourceSnapshot;
            if (sourceSnapshot && fontManager!.currentFont) {
                applySourceSnapshot(fontManager!.currentFont, sourceSnapshot);
            }
        } else {
            await fontManager!.loadFont(
                detail.babelfontJson,
                detail.path,
                detail.sourcePlugin,
                detail.fileHandle,
                detail.directoryHandle
            );
            const sourceSnapshot = (
                detail as { sourceSnapshot?: SourceSnapshot }
            ).sourceSnapshot;
            if (sourceSnapshot && fontManager!.currentFont) {
                applySourceSnapshot(fontManager!.currentFont, sourceSnapshot);
            }
        }

        emitOpenLifecycle(openSessionId, 'loadFontComplete', {
            openedAt
        });

        releaseStartupInteractivity(openSessionId, 'font-model-ready');

        fontModelLoaded = true;
        void finalizeStartupReadiness(openSessionId);

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

            // The deadline releases without waiting for the restore: parts
            // of it wait for animation frames, which a background tab or
            // hidden pane never runs, so waiting here held `fontReady` back
            // for good.
            if (window.glyphCanvas && !startupFinalizeStarted) {
                void ensureStartupStateReady(window.glyphCanvas).catch(
                    (error) => {
                        console.warn(
                            '[FontManager]',
                            'Startup state restore failed after the startup deadline:',
                            error
                        );
                    }
                );
            }

            void releaseStartupGates(openSessionId, 'startup-ready-timeout');
        }, 8000);
    } catch (error) {
        void releaseStartupGates('open-unknown', 'error');
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
        // A failed open stays visible, not only in the console.
        sidebarErrorDisplay.showError(error, 'editing', { sticky: true });
    }
});
