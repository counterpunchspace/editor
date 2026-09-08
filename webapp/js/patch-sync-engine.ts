/**
 * PatchSyncEngine — Central patch-driven sync processor.
 *
 * Every mutation to the babelfont model goes through this class.
 * It keeps a Yjs Y.Doc in sync with the JSON, manages per-glyph
 * UndoManagers, maintains the change log, and broadcasts updates
 * to other windows via BroadcastChannel.
 */

import * as Y from 'yjs';
import {
    jsonToYDoc,
    jsonToCoreFontMap,
    fillGlyphYMap,
    yDocToJson,
    fromYType,
    toYType,
    setYPath,
    deleteYPath,
    getYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath,
    normalizeValueForYDocWrite,
    INDEXED_MAP_KEYS,
    stabilizeIndexedMapPath,
    diffYArray,
    applyIndexedMapArray as applyIndexedMapArrayToYMap,
    ensureGlyphLayersMap,
    replaceYMapContents
} from './change-bridge-ydoc';
import {
    repairLayerGeometryOrphans,
    readLayerGeometry,
    writeLayerGeometry
} from './layer-geometry-ydoc';
import {
    omitRestingLayerRuntimeKeys,
    RESTING_LAYER_IDENTITY_KEYS,
    RESTING_LAYER_RUNTIME_KEYS,
    toRestingLayerJson
} from './resting-layer-json';
import {
    buildHistoryStackItems,
    type ChangeLogEntry,
    type ChangeOp,
    type HistoryStackItem,
    type HistoryUndoSurface,
    type UndoScope,
    type UndoSurfaceAffinity,
    type WorkerReplayTarget,
    type GlyphRename,
    createLogEntry,
    deriveGlyphName,
    deriveLayerId,
    deriveGlyphNameFromPath,
    deriveGlyphNamesFromPaths,
    deriveLayerIdFromPath,
    deriveLayerIdsFromPaths,
    deriveObjectInfoFromPath,
    getPathSegments,
    invalidateHistoryStateCache,
    joinPathWithGlyphSeparator,
    normalizeWorkerReplayTargets,
    normalizeGlyphRenames,
    glyphRenamesForHistoryAction,
    normalizeChangeLogEntry,
    resolveCollaborationOriginatingLayer,
    resolveCommitOriginatingLayer,
    resolveHistoryTargetItem,
    resolveUndoSurfaceAffinity,
    resetLogCounter,
    isDerivedLayerChangePath
} from './change-log';
import { Logger } from './logger';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    type CollaborationMessageEnvelope,
    type DerivedForwardChange
} from './collaboration-message';
import { windowRole } from './window-role';
import {
    withSuppressedModelRecording,
    pathHasSubtractionFlag
} from './babelfont-model';
import { diffFontDataToPatchPairs } from './font-data-diff';
import { getUndoRedoContext } from './undo-redo-context';
import {
    stampImmutableGlyphIds,
    applyCloudOwnedData,
    ensureImmutableGlyphId,
    listGlyphRecords,
    catalogFromCoreJson,
    isCatalogTombstone,
    CLOUD_PLUGIN_OWNED_KEY,
    CORE_CODEPOINT_INDEX_KEY,
    CORE_GLYPH_CATALOG_KEY,
    type CloudOwnedFontData
} from './filesystem-plugins/cloud-glyph-catalog';
import {
    buildFontDepsForGlyph,
    catalogEntriesForDepsParse,
    patchSourceEdges,
    writeCompleteFontDepsIfLoaded
} from './filesystem-plugins/cloud-font-deps';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    GLYPH_REVISIONS_KEY,
    GLYPH_SYNC_MAP_KEY,
    GLYPH_SYNC_REVISION_KEY,
    areGlyphRevisionOnlyEntries,
    glyphDocumentId,
    glyphIdFromDocumentId,
    type EncodedShard
} from './filesystem-plugins/cloud-document-set';
import {
    measureShardBytesForSubmit,
    evaluateCollabSubmit,
    type CollabSubmitDecision,
    type CollabSubmitRequest
} from './filesystem-plugins/cloud-shard-limits';
import {
    computeLayerRecompositionClosure,
    deriveEditKindsFromChangeLogEntries,
    shouldResettleDerivedLayersOnHistoryReplay,
    type FontModelLike
} from './recomposition-closure';

const console = new Logger('PatchSyncEngine');

type Unsafe = ReturnType<typeof JSON.parse>;
type YjsUpdate = Uint8Array<ArrayBufferLike>;
type OptionalLayerField = 'anchors' | 'guides' | 'format_specific';

type LayerSnapshotSyncTarget = WorkerReplayTarget & {
    layerJson: unknown;
    authoritativeOptionalLayerFields?: readonly OptionalLayerField[];
};

export type { ChangeLogEntry } from './change-log';

export type LocalUpdateListener = (
    update: YjsUpdate,
    collaborationMessage?: CollaborationMessageEnvelope | null,
    changeLogEntries?: ChangeLogEntry[],
    documentId?: string
) => void;

export type CommittedChangeOrigin = 'local' | 'remote';

export type CommittedChangeListener = (
    entries: ChangeLogEntry[],
    context: {
        origin: CommittedChangeOrigin;
        update: YjsUpdate;
        documentId?: string;
    }
) => void;

export type GlyphRevisionSignalListener = (
    update: YjsUpdate,
    entries: ChangeLogEntry[]
) => void;

export class MetadataFreeRemoteUpdateError extends Error {
    constructor() {
        super(
            'Refusing metadata-free non-noop remote Yjs update; semantic metadata is required for scoped model and compile convergence'
        );
        this.name = 'MetadataFreeRemoteUpdateError';
    }
}

export type CollaborationLogItem = {
    id: string;
    direction: 'local' | 'remote';
    timestamp: number;
    transactionDurationMs: number | null;
    summary: string;
    label: string | null;
    source: string;
    editSource: string | null;
    windowId: string | null;
    windowRoleLabel: string;
    historyItemId: string;
    promptGroupId: string | null;
    groupedMessageCount?: number;
    historyAction: 'change' | 'undo' | 'redo';
    targetHistoryItemId: string | null;
    undoScope: UndoScope;
    undoSurfaceAffinity: UndoSurfaceAffinity | null;
    historyTargetKey: string | null;
    historyTargetLabel: string | null;
    originatingGlyphName: string | null;
    originatingLayerId: string | null;
    updateByteLength: number;
    updateBase64Preview: string;
    changedGlyphNames: string[];
    changedLayerIds: string[];
    workerReplayTargets: WorkerReplayTarget[];
    changes: CollaborationMessageEnvelope['changes'];
    derivedForwardChanges: DerivedForwardChange[];
};

type SyntheticChangeOperation = {
    op: ChangeOp;
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    editSource?: string | null;
    compileChangeSource?: string | null;
    compileEditType?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
    glyphRenames?: GlyphRename[];
};

export type BatchApplyMode =
    'default' | 'font-snapshot' | 'glyph-snapshot' | 'layer-snapshot';

export type TransactionBufferedOperation = SyntheticChangeOperation & {
    applyPath?: (string | number)[];
    applyOldValue?: unknown;
    applyNewValue?: unknown;
    applyMode?: BatchApplyMode;
    originatingGlyphName?: string | null;
    originatingLayerId?: string | null;
};

export type TransactionCommitResult = {
    changeLogEntries: ChangeLogEntry[];
    workerReplayTargets: WorkerReplayTarget[];
    changedGlyphNames: string[];
    changedLayerIds: string[];
};

export type ExternalSourceReloadResult = {
    status: 'committed' | 'noop' | 'stale';
    commit: TransactionCommitResult | null;
};

type TransactionFinalizer = (
    operations: TransactionBufferedOperation[],
    context: {
        label: string | null;
        transactionId: number | null;
        historyItemId: string | null;
        historyTarget: TransactionHistoryTarget | null;
    }
) => TransactionBufferedOperation[] | null | undefined;

/**
 * Origin token used by Yjs transactions that represent same-user edits.
 * Linked windows should all be able to undo these changes.
 */
const USER_EDIT_ORIGIN = 'user-edit';
const SYSTEM_REMOTE_ORIGIN = 'system-remote';
const HISTORY_REPLAY_ORIGIN = 'history-replay';
const FONT_EDIT_ORIGIN = 'font-edit';
const GLYPH_EDIT_ORIGIN = 'glyph-edit';
/** Remote cloud applies; not in any UndoManager trackedOrigins. */
export const CLOUD_REMOTE_ORIGIN = 'cloud-remote';

function assertCloudAssetMutable(): void {
    if (window.cloudPlugin?.canMutateCurrentAsset?.() === false) {
        throw new Error('Cloud asset is read-only');
    }
}

export type ApplyRemoteUpdateOptions = {
    captureInUndo?: boolean;
};
const GLYPH_REVISION_ORIGIN = 'glyph-revision-signal';
const LAYER_EDIT_ORIGIN_PREFIX = 'layer-edit:';

function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function isNoOpYjsUpdate(update: Uint8Array): boolean {
    return (
        update.length === 0 ||
        (update.length === 2 && update[0] === 0 && update[1] === 0)
    );
}

type UndoTarget = {
    glyphName: string | null;
    layerId: string | null;
};

type UndoHistoryStacks = {
    active: string[];
    undone: string[];
};

type ResolvedUndoHistorySource = {
    historyItemId: string | null;
    historyItem: HistoryStackItem | null;
};

const FONT_UNDO_HISTORY_KEY = '__font-undo-history__';

function removeHistoryItemFromStack(stack: string[], itemId: string): void {
    const index = stack.lastIndexOf(itemId);
    if (index >= 0) {
        stack.splice(index, 1);
    }
}

function cloneChangeLogEntryForHistoryAction(
    entry: ChangeLogEntry,
    historyAction: 'undo' | 'redo',
    targetHistoryItemId: string | null,
    timestamp: number,
    windowId: string,
    windowRoleLabel: string
): ChangeLogEntry {
    const { semanticChangeLogEntries: _semanticChangeLogEntries, ...fields } =
        entry;
    return normalizeChangeLogEntry({
        ...fields,
        timestamp,
        windowId,
        windowRoleLabel,
        historyAction,
        targetHistoryItemId,
        transactionId: null,
        glyphRenames: glyphRenamesForHistoryAction(
            fields.glyphRenames,
            historyAction
        )
    });
}

function getSemanticEntriesForHistoryItem(
    item: HistoryStackItem | null | undefined,
    historyAction: 'undo' | 'redo',
    targetHistoryItemId: string | null,
    timestamp: number,
    windowId: string,
    windowRoleLabel: string
): ChangeLogEntry[] | null {
    const sourceEntries = item?.entries?.length
        ? item.entries[0].semanticChangeLogEntries?.length
            ? item.entries[0].semanticChangeLogEntries
            : item.entries
        : null;
    if (!sourceEntries?.length) {
        return null;
    }
    return sourceEntries.map((itemEntry) =>
        cloneChangeLogEntryForHistoryAction(
            itemEntry,
            historyAction,
            targetHistoryItemId,
            timestamp,
            windowId,
            windowRoleLabel
        )
    );
}

function getEffectiveEmissionEntries(
    changeLogEntries: ChangeLogEntry[]
): ChangeLogEntry[] {
    const semanticEntries = changeLogEntries.flatMap(
        (entry) => entry.semanticChangeLogEntries ?? []
    );
    return semanticEntries.length ? semanticEntries : changeLogEntries;
}

type HistoryTarget = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

export type TransactionHistoryTarget = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

export type UndoRedoResult = {
    scope: UndoScope;
    glyphName: string | null;
    layerId: string | null;
    historyItem: HistoryStackItem | null;
};

type UndoManagerWithScope = {
    manager: Y.UndoManager | null;
    scope: UndoScope;
};

type LayerFingerprintTarget = {
    glyphName: string;
    layerId: string;
};

type LayerFingerprintSnapshotEntry = LayerFingerprintTarget & {
    fingerprint: string | null;
};

type LayerSyncMetadata = {
    editSource?: string | null;
    compileChangeSource?: string | null;
    compileEditType?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
    preserveOmittedFields?: boolean;
};

const INDEXED_ARRAY_ORDER_KEYS: Record<string, string> = {
    anchors: 'anchorOrder',
    guides: 'guideOrder'
};

const GRANULAR_LAYER_ARRAY_KEYS = new Set(['anchors', 'guides']);

function getLayerManagerKey(glyphName: string, layerId: string): string {
    return `${glyphName}@@${layerId}`;
}

function getLayerEditOrigin(glyphName: string, layerId: string): string {
    return `${LAYER_EDIT_ORIGIN_PREFIX}${glyphName}@@${layerId}`;
}

function getLayerFingerprintTargetKey(
    glyphName: string,
    layerId: string
): string {
    return `${glyphName}@@${layerId}`;
}

function normalizeLayerSignatureNodeType(nodeType: unknown): string {
    switch (nodeType) {
        case 'Move':
        case 'Line':
        case 'OffCurve':
        case 'Curve':
        case 'QCurve':
            return nodeType;
        default:
            return String(nodeType || 'Unknown');
    }
}

function getComponentReferenceFromShape(shape: Unsafe): string {
    if (!shape || typeof shape !== 'object') {
        return '';
    }

    if (
        'Component' in shape &&
        shape.Component &&
        typeof shape.Component === 'object'
    ) {
        return String((shape.Component as Unsafe).reference || '');
    }

    return String(shape.reference || '');
}

function getPathLikeShape(shape: Unsafe): Unsafe | null {
    if (!shape || typeof shape !== 'object') {
        return null;
    }

    if ('Path' in shape && shape.Path && typeof shape.Path === 'object') {
        return shape.Path as Unsafe;
    }

    if (Array.isArray(shape.nodes)) {
        return shape;
    }

    return null;
}

function getLayerFingerprintFromJson(layerJson: Unsafe): string | null {
    if (!layerJson || typeof layerJson !== 'object') {
        return null;
    }

    const shapes = Array.isArray(layerJson.shapes) ? layerJson.shapes : [];
    const anchors = Array.isArray(layerJson.anchors) ? layerJson.anchors : [];

    const componentSignatures = shapes
        .filter(
            (shape: unknown) =>
                !!shape &&
                typeof shape === 'object' &&
                ('Component' in shape || 'reference' in shape)
        )
        .map(
            (shape: unknown) =>
                `C:${getComponentReferenceFromShape(shape as Unsafe)}`
        );

    const pathSignatures = shapes
        .map((shape: unknown) => getPathLikeShape(shape as Unsafe))
        .filter((shape: Unsafe | null): shape is Unsafe => Boolean(shape))
        .map((pathShape: Unsafe) => {
            const nodes = Array.isArray(pathShape.nodes) ? pathShape.nodes : [];
            const nodeTypes = nodes.map((node: unknown) =>
                normalizeLayerSignatureNodeType((node as Unsafe)?.nodetype)
            );
            const closedFlag = pathShape.closed === false ? '0' : '1';
            const booleanFlag = pathHasSubtractionFlag(
                pathShape.format_specific
            )
                ? ':subtraction'
                : '';
            return `P:${closedFlag}:${nodeTypes.length}:${nodeTypes.join(',')}${booleanFlag}`;
        });

    const anchorSignatures = anchors
        .map((anchor: unknown) => `A:${String((anchor as Unsafe)?.name || '')}`)
        .sort((a: string, b: string) => a.localeCompare(b));

    return [
        `components[${componentSignatures.join('|')}]`,
        `paths[${pathSignatures.join('|')}]`,
        `anchors[${anchorSignatures.join('|')}]`
    ].join(';');
}

/**
 * Central patch processor that keeps Yjs Y.Doc in sync with the
 * babelfont JSON object model.
 */
export class PatchSyncEngine {
    /** Font-core Yjs document (non-glyph fields + glyphOrder). */
    readonly yDoc: Y.Doc;
    readonly depsDoc: Y.Doc;
    /** Root font map inside the core Y.Doc */
    readonly fontMap: Y.Map<unknown>;
    private _glyphDocs = new Map<string, Y.Doc>();
    private _glyphIdByName = new Map<string, string>();
    private _glyphNameById = new Map<string, string>();
    private _lastBroadcastStateVectorByDoc = new Map<string, Uint8Array>();
    private _lastEncodedShardBytes = new Map<string, number>();
    private _docUpdateUnsubscribers: Array<() => void> = [];
    private _docUpdateUnsubById = new Map<string, () => void>();
    /** Per-glyph undo managers (keyed by glyph name) */
    private _undoManagers = new Map<string, Y.UndoManager>();
    /** Per-layer undo managers (keyed by glyph@@layer) */
    private _layerUndoManagers = new Map<
        string,
        { manager: Y.UndoManager; target: Y.Map<unknown> }
    >();
    /** "Font-level" undo manager for axes/masters/instances/font properties */
    private _fontUndoManager: Y.UndoManager | null = null;
    /** Local history-item stacks aligned with each undo-manager scope */
    private _undoHistoryStacks = new Map<string, UndoHistoryStacks>();
    /** Change log of all recorded changes */
    private _changeLog: ChangeLogEntry[] = [];
    /** Unique window identifier */
    readonly windowId: string;
    /** Reference to the raw babelfont JSON (the one babelfont-model.ts wraps) */
    private _fontJson: Record<string, Unsafe> | null = null;
    /** Transaction nesting depth */
    private _txDepth = 0;
    /** Current transaction label (outermost) */
    private _txLabel: string | null = null;
    /** Current transaction ID */
    private _txId: number | null = null;
    /** Wall-clock start time for the outermost transaction. */
    private _txStartTimeMs: number | null = null;
    /** Next transaction ID counter */
    private _nextTxId = 1;
    /** When set, cloud WAL intent already persisted; Yjs apply may proceed. */
    private _cloudWalApplyReady = false;
    /** Serializes cloud WAL-before-apply commits so callers can await them. */
    private _cloudWalCommitChain: Promise<void> = Promise.resolve();
    /** Serializes persist-then-deliver of local cloud emits after apply. */
    private _cloudEmitPersistChain: Promise<void> = Promise.resolve();
    private _lastCloudCommitDebug: Record<string, unknown> | null = null;
    /** Next logical history item counter */
    private _nextHistoryItemId = 1;
    /** Current transaction-level history item ID */
    private _txHistoryItemId: string | null = null;
    /** Optional summary for an assistant-grouped history item. */
    private _txHistorySummary: string | null = null;
    /** Presentation-only group ID for an assistant prompt. */
    private _txPromptGroupId: string | null = null;
    /** Optional explicit history target for the current transaction */
    private _txHistoryTarget: TransactionHistoryTarget | null = null;
    /** Compact state-vector captured at the start of the outermost transaction. */
    private _txStartStateVector: Uint8Array | null = null;
    /** Buffered operations for the current outermost transaction */
    private _txBufferedOperations: TransactionBufferedOperation[] = [];
    /** Flag: currently applying remote update (suppress outbound broadcast) */
    private _isApplyingRemote = false;

    /**
     * Optional callback that receives every Yjs binary update (local and
     * remote) together with the ChangeLogEntry list so the compilation worker
     * can maintain its own Y.Doc without receiving the full font JSON on every
     * edit. Set via `setYjsWorkerCallback`.
     */
    private _yjsWorkerCallback:
        | ((
              update: YjsUpdate,
              changeLogEntries: ChangeLogEntry[],
              documentId?: string
          ) => void)
        | null = null;
    /**
     * Catch-up snapshots replace a worker shard instead of applying as a
     * delta. Incremental `applyYjsUpdate` needs cache metadata that a full
     * document state does not carry.
     */
    private _workerDocumentReplaceCallback:
        ((documentId: string, state: YjsUpdate) => void) | null = null;
    /** Flag: suppress Y.Doc sync (during initFromJson) */
    private _isSyncing = false;
    /** Callback when a remote change arrives (for UI refresh) */
    private _onRemoteChange: ((entries: ChangeLogEntry[]) => void) | null =
        null;
    /** Flat log of local and remote collaboration messages */
    private _collaborationLog: CollaborationLogItem[] = [];
    /** Callback when the Y.Doc is updated locally (for broadcasting) */
    private _localUpdateListeners: Set<LocalUpdateListener> = new Set();
    /** Callbacks for committed local/remote changes after Yjs apply */
    private _committedChangeListeners: Set<CommittedChangeListener> = new Set();
    private _glyphRevisionListeners: Set<GlyphRevisionSignalListener> =
        new Set();
    private _coreHydratedListeners: Set<() => void> = new Set();
    /** Sparse residency: in-memory only. Never written to font-deps. */
    private _sparseSession = false;
    private _sparseWorkingGlyphIds: Set<string> = new Set();
    /** Callback to trigger dirty marking on the font manager side */
    private _onDirty: (() => void) | null = null;
    /** Callback after _syncJsonFromYDoc (undo/redo/remote) for external resync */
    private _onAfterSync: (() => void) | null = null;
    /** Nested HTTP hydrate applies one Font.fromData at the end, not per shard. */
    private _afterSyncDeferDepth = 0;
    private _afterSyncSkipped = false;
    /** Suppress recording (used during undo/redo application) */
    private _suppressRecording = false;
    /** Number of active scoped recording suppressions. */
    private _recordingSuppressionDepth = 0;
    /** Index into _changeLog marking the last entry broadcast to peers */
    private _lastBroadcastLogIndex = 0;
    /** Index into _changeLog marking the last entry emitted to local-update listeners */
    private _lastLocalUpdateLogIndex = 0;
    private _glyphRevisionClock = 0;
    /** Monotonic local sequence for emitted collaboration messages */
    private _nextCollaborationMessageSequence = 1;
    /** Subscribers for same-tab history UI updates */
    private _changeLogListeners = new Set<
        (entries: ChangeLogEntry[]) => void
    >();
    /** Subscribers for the flat collaboration message inspector */
    private _collaborationLogListeners = new Set<
        (items: CollaborationLogItem[]) => void
    >();
    /** Optional callback that can append derived operations before commit */
    private _transactionFinalizer: TransactionFinalizer | null = null;
    /** Suppress raw yDoc.on('update') broadcasting while emitting canonical diffs manually. */
    private _suppressAutomaticLocalUpdateEmission = false;
    /**
     * Compact Yjs state-vector (one clock entry per client, typically < 100 bytes)
     * captured after each local or remote Y.Doc mutation. Used to compute the
     * minimal incremental diff for outbound broadcasts without serialising the
     * entire font document.
     */
    private _lastBroadcastStateVector: Uint8Array = new Uint8Array(0);

    /**
     * Fast deep equality that is deterministic about object key order
     * (same semantics as the old _stableStringify comparison) but avoids
     * building intermediate normalized objects and stringifying.
     * Short-circuits on the first difference.
     */
    private _isDeepEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return a === b;
        if (typeof a !== 'object') return a === b;

        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i++) {
                if (!this._isDeepEqual(a[i], b[i])) return false;
            }
            return true;
        }

        if (Array.isArray(b)) return false;

        const aObj = a as Record<string, unknown>;
        const bObj = b as Record<string, unknown>;
        const aKeys = Object.keys(aObj).sort();
        const bKeys = Object.keys(bObj).sort();
        if (aKeys.length !== bKeys.length) return false;
        for (let i = 0; i < aKeys.length; i++) {
            if (aKeys[i] !== bKeys[i]) return false;
            if (!this._isDeepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) {
                return false;
            }
        }
        return true;
    }
    private _getWindowRoleLabel(): string {
        return window.windowRole?.getRoleLabel() ?? windowRole.getRoleLabel();
    }

    private _createHistoryItemId(): string {
        return `history-item-${this._nextHistoryItemId++}`;
    }

    private _getCurrentHistoryItemId(): string {
        return this._txHistoryItemId ?? this._createHistoryItemId();
    }

    private _collectLayerFingerprintSnapshot(
        targets?: LayerFingerprintTarget[] | null
    ): Map<string, LayerFingerprintSnapshotEntry> {
        const snapshot = new Map<string, LayerFingerprintSnapshotEntry>();
        const glyphs = (this._fontJson as Unsafe)?.glyphs;
        if (!Array.isArray(glyphs)) {
            return snapshot;
        }

        // Targeted fast path: when the caller scoped this to a small set of
        // (glyph, layer) pairs, do an indexed lookup instead of iterating
        // every glyph and every layer in the font. For 1058 glyphs with
        // ~5 layers each, this is the difference between 5000+ iterations
        // and N (typically 1-20) per call. _syncJsonFromYDoc fires this
        // twice (before/after) on every Yjs sync (undo, remote, scoped).
        if (targets?.length) {
            // Build glyph-name → glyph index once. Build lazily so we only
            // pay the O(glyphs) cost on the first miss; if every target's
            // glyph is at the head of the array, we can avoid even that.
            let glyphIndex: Map<string, Unsafe> | null = null;
            const ensureGlyphIndex = (): Map<string, Unsafe> => {
                if (glyphIndex) return glyphIndex;
                const idx = new Map<string, Unsafe>();
                for (const glyph of glyphs) {
                    const name =
                        typeof glyph?.name === 'string' ? glyph.name : null;
                    if (name && !idx.has(name)) {
                        idx.set(name, glyph);
                    }
                }
                glyphIndex = idx;
                return idx;
            };

            const dedupe = new Set<string>();
            for (const target of targets) {
                const glyphName = target?.glyphName;
                const layerId = target?.layerId;
                if (!glyphName || !layerId) continue;

                const targetKey = getLayerFingerprintTargetKey(
                    glyphName,
                    layerId
                );
                if (dedupe.has(targetKey)) continue;
                dedupe.add(targetKey);

                const glyph = ensureGlyphIndex().get(glyphName);
                if (!glyph) continue;

                const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
                // Layer counts per glyph are tiny (typically 1-10). A linear
                // find here is faster than building a per-glyph index.
                const layer = layers.find(
                    (l: Unsafe) => typeof l?.id === 'string' && l.id === layerId
                );
                if (!layer) continue;

                snapshot.set(targetKey, {
                    glyphName,
                    layerId,
                    fingerprint: getLayerFingerprintFromJson(layer)
                });
            }
            return snapshot;
        }

        // Untargeted path: full font scan. Used for full Yjs rebuilds.
        for (const glyph of glyphs) {
            const glyphName =
                typeof glyph?.name === 'string' ? glyph.name : null;
            if (!glyphName) {
                continue;
            }

            const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
            for (const layer of layers) {
                const layerId = typeof layer?.id === 'string' ? layer.id : null;
                if (!layerId) {
                    continue;
                }

                const targetKey = getLayerFingerprintTargetKey(
                    glyphName,
                    layerId
                );
                snapshot.set(targetKey, {
                    glyphName,
                    layerId,
                    fingerprint: getLayerFingerprintFromJson(layer)
                });
            }
        }

        return snapshot;
    }

    private _emitLayerFingerprintChangedEvents(
        previousSnapshot: Map<string, LayerFingerprintSnapshotEntry>,
        nextSnapshot: Map<string, LayerFingerprintSnapshotEntry>
    ): void {
        if (typeof window === 'undefined') {
            return;
        }

        const targetKeys = new Set<string>([
            ...previousSnapshot.keys(),
            ...nextSnapshot.keys()
        ]);

        for (const targetKey of targetKeys) {
            const previous = previousSnapshot.get(targetKey) ?? null;
            const next = nextSnapshot.get(targetKey) ?? null;
            const previousFingerprint = previous?.fingerprint ?? null;
            const nextFingerprint = next?.fingerprint ?? null;

            if (previousFingerprint === nextFingerprint) {
                continue;
            }

            const glyphName = next?.glyphName ?? previous?.glyphName;
            const layerId = next?.layerId ?? previous?.layerId;
            if (!glyphName || !layerId) {
                continue;
            }

            window.dispatchEvent(
                new CustomEvent('layerFingerprintChanged', {
                    detail: {
                        glyphName,
                        layerId
                    }
                })
            );
        }
    }

    constructor(windowId?: string) {
        this.windowId = windowId ?? windowRole.instanceId;
        this.yDoc = new Y.Doc({ gc: false });
        this.depsDoc = new Y.Doc({ gc: false });
        this.fontMap = this.yDoc.getMap('font');

        const LOCAL_EDIT_ORIGINS: Set<string> = new Set([
            USER_EDIT_ORIGIN,
            FONT_EDIT_ORIGIN,
            GLYPH_EDIT_ORIGIN,
            HISTORY_REPLAY_ORIGIN
        ]);
        this._isLocalEditOrigin = (origin: unknown): boolean => {
            if (typeof origin !== 'string') return false;
            if (LOCAL_EDIT_ORIGINS.has(origin)) return true;
            if (origin.startsWith(LAYER_EDIT_ORIGIN_PREFIX)) return true;
            return false;
        };
        this._bindDocUpdates(this.yDoc, FONT_CORE_DOCUMENT_ID);
        this._bindDocUpdates(this.depsDoc, FONT_DEPS_DOCUMENT_ID);
    }

    private _isLocalEditOrigin: (origin: unknown) => boolean = () => false;

    private _bindDocUpdates(doc: Y.Doc, documentId: string): void {
        const handler = (update: YjsUpdate, origin: unknown) => {
            if (
                this._isLocalEditOrigin(origin) &&
                !this._isApplyingRemote &&
                !this._suppressAutomaticLocalUpdateEmission
            ) {
                this._emitRawLocalUpdate(update, documentId);
            }
        };
        doc.on('update', handler);
        this._docUpdateUnsubscribers.push(() => {
            doc.off('update', handler);
        });
        this._docUpdateUnsubById.set(documentId, () => {
            doc.off('update', handler);
        });
    }

    private _noteBroadcastStateVector(documentId: string): void {
        const doc = this._docForId(documentId);
        if (!doc) {
            return;
        }
        const vector = Y.encodeStateVector(doc);
        this._lastBroadcastStateVectorByDoc.set(documentId, vector);
        if (documentId === FONT_CORE_DOCUMENT_ID) {
            this._lastBroadcastStateVector = vector;
        }
    }

    documentIdForPath(path: Array<string | number>): string {
        if (path[0] === 'glyphs' && path.length >= 2) {
            const key = String(path[1]);
            const glyphId = this._glyphIdByName.get(key) || key;
            return glyphDocumentId(glyphId);
        }
        if (path[0] === 'fontDeps' || path[0] === 'deps') {
            return FONT_DEPS_DOCUMENT_ID;
        }
        return FONT_CORE_DOCUMENT_ID;
    }

    private _collectGlyphRenamesFromEntries(
        entries: ChangeLogEntry[]
    ): GlyphRename[] {
        return entries.flatMap((entry) =>
            normalizeGlyphRenames(entry.glyphRenames)
        );
    }

    private _liveGlyphName(
        pathName: string,
        renames: GlyphRename[] = []
    ): string {
        if (this._glyphIdByName.has(pathName)) {
            return pathName;
        }
        for (const rename of renames) {
            if (
                rename.oldName === pathName &&
                this._glyphIdByName.has(rename.newName)
            ) {
                return rename.newName;
            }
            if (
                rename.newName === pathName &&
                this._glyphIdByName.has(rename.oldName)
            ) {
                return rename.oldName;
            }
        }
        return pathName;
    }

    private _documentIdForHistoryEntry(
        entry: ChangeLogEntry,
        extraRenames: GlyphRename[] = []
    ): string {
        if (!entry.path || entry.path === 'font') {
            return FONT_CORE_DOCUMENT_ID;
        }
        const segments = this._toYDocPath(this._parseEntryPath(entry.path));
        if (segments[0] === 'glyphs' && segments.length >= 2) {
            const liveName = this._liveGlyphName(String(segments[1]), [
                ...normalizeGlyphRenames(entry.glyphRenames),
                ...extraRenames
            ]);
            return this.documentIdForPath([
                'glyphs',
                liveName,
                ...segments.slice(2)
            ]);
        }
        return this.documentIdForPath(segments);
    }

    private _docForId(documentId: string): Y.Doc | null {
        if (documentId === FONT_CORE_DOCUMENT_ID) {
            return this.yDoc;
        }
        if (documentId === FONT_DEPS_DOCUMENT_ID) {
            return this.depsDoc;
        }
        if (documentId.startsWith('glyph:')) {
            return (
                this._glyphDocs.get(documentId.slice('glyph:'.length)) || null
            );
        }
        return this._glyphDocs.get(documentId) || null;
    }

    private _glyphMapForName(glyphName: string): Y.Map<unknown> | null {
        const glyphId = this._glyphIdByName.get(glyphName);
        if (glyphId) {
            const doc = this._glyphDocs.get(glyphId);
            const glyphMap = doc?.getMap('glyph');
            if (glyphMap instanceof Y.Map) {
                return glyphMap;
            }
        }
        // Sharded fonts keep leftover glyph bodies on font-core from older
        // protocol versions. Those must not count as hydrated — only glyph
        // documents do. Fall back to the core map only for unsharded docs.
        if (this._glyphDocs.size > 0) {
            return null;
        }
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) {
            return null;
        }
        const glyphMap = glyphsMap.get(glyphName);
        return glyphMap instanceof Y.Map ? glyphMap : null;
    }

    private _ensureGlyphDoc(
        glyphId: string,
        glyphName: string,
        glyphJson?: Record<string, unknown>
    ): Y.Doc {
        let doc = this._glyphDocs.get(glyphId);
        if (!doc) {
            doc = new Y.Doc({ gc: false });
            this._glyphDocs.set(glyphId, doc);
            this._bindDocUpdates(doc, glyphDocumentId(glyphId));
        }
        this._glyphIdByName.set(glyphName, glyphId);
        this._glyphNameById.set(glyphId, glyphName);
        if (glyphJson) {
            doc.transact(() => {
                const glyphMap = doc.getMap('glyph');
                glyphMap.forEach((_value, key) => glyphMap.delete(key));
                fillGlyphYMap(glyphJson, glyphMap);
            }, USER_EDIT_ORIGIN);
        }
        return doc;
    }

    private _destroyGlyphDocs(): void {
        for (const doc of this._glyphDocs.values()) {
            doc.destroy();
        }
        this._glyphDocs.clear();
        this._glyphIdByName.clear();
        this._glyphNameById.clear();
    }

    glyphDocumentIdForName(glyphName: string): string | null {
        const glyphId = this._glyphIdByName.get(glyphName);
        return glyphId ? glyphDocumentId(glyphId) : null;
    }

    /** Playwright/debug: first path node x from the glyph Y.Doc, or null. */
    debugGlyphFirstNodeX(glyphName: string): number | null {
        const glyphMap = this._glyphMapForName(glyphName);
        if (!glyphMap) {
            return null;
        }
        const layers = glyphMap.get('layers');
        if (!(layers instanceof Y.Map) || layers.size === 0) {
            return null;
        }
        const firstLayer = layers.values().next().value;
        if (!(firstLayer instanceof Y.Map)) {
            return null;
        }
        try {
            const shapes = readLayerGeometry(firstLayer);
            const nodes = Array.isArray(shapes?.[0]?.nodes)
                ? (shapes[0].nodes as Array<{ x?: unknown }>)
                : [];
            const x = nodes[0]?.x;
            return typeof x === 'number' && Number.isFinite(x) ? x : null;
        } catch {
            return null;
        }
    }

    debugCollabGlyphSnapshot(glyphName: string): Record<string, unknown> {
        const modelGlyph = (
            window as Window & {
                currentFontModel?: {
                    findGlyph?: (name: string) => {
                        layers?: Array<{
                            paths?: Array<{ nodes?: Array<{ x?: unknown }> }>;
                        }>;
                    };
                };
            }
        ).currentFontModel?.findGlyph?.(glyphName);
        const modelX = modelGlyph?.layers?.[0]?.paths?.[0]?.nodes?.[0]?.x;
        const jsonGlyphs = (this._fontJson as { glyphs?: unknown } | null)
            ?.glyphs;
        const jsonGlyph = Array.isArray(jsonGlyphs)
            ? jsonGlyphs.find(
                  (glyph) =>
                      glyph &&
                      typeof glyph === 'object' &&
                      (glyph as { name?: unknown }).name === glyphName
              )
            : null;
        const jsonLayer =
            jsonGlyph && typeof jsonGlyph === 'object'
                ? (jsonGlyph as { layers?: Array<Record<string, unknown>> })
                      .layers?.[0]
                : null;
        const jsonShapes = jsonLayer?.shapes as
            Array<{ nodes?: Array<{ x?: unknown }> }> | undefined;
        const jsonPaths = jsonLayer?.paths as
            Array<{ nodes?: Array<{ x?: unknown }> }> | undefined;
        const jsonX =
            jsonShapes?.[0]?.nodes?.[0]?.x ?? jsonPaths?.[0]?.nodes?.[0]?.x;
        return {
            glyphName,
            glyphDocumentId: this.glyphDocumentIdForName(glyphName),
            modelX: typeof modelX === 'number' ? modelX : null,
            jsonX: typeof jsonX === 'number' ? jsonX : null,
            yDocX: this.debugGlyphFirstNodeX(glyphName),
            lastCloudCommit: this._lastCloudCommitDebug
        };
    }

    listLiveGlyphDocumentIds(): string[] {
        return [...this._glyphDocs.keys()]
            .filter((glyphId) => this._glyphNameById.has(glyphId))
            .map((glyphId) => glyphDocumentId(glyphId));
    }

    /**
     * Cached Yjs encode sizes for the live tooltip. Encodes a shard when the
     * cache has never seen it so hover stays accurate after sparse hydrate.
     */
    getLiveShardSizeSnapshot(): {
        fontCoreBytes: number;
        fontDepsBytes: number;
        largestGlyphBytes: number;
        largestGlyphName: string | null;
    } {
        const encodedLength = (
            documentId: string,
            doc: Y.Doc | null | undefined
        ): number => {
            const cached = this._lastEncodedShardBytes.get(documentId);
            if (typeof cached === 'number' && Number.isFinite(cached)) {
                return cached;
            }
            if (!doc) {
                return 0;
            }
            const byteLength = Y.encodeStateAsUpdate(doc).byteLength;
            this._lastEncodedShardBytes.set(documentId, byteLength);
            return byteLength;
        };

        let largestGlyphBytes = 0;
        let largestGlyphName: string | null = null;
        for (const [glyphId, doc] of this._glyphDocs) {
            if (!this._glyphNameById.has(glyphId)) {
                continue;
            }
            const byteLength = encodedLength(glyphDocumentId(glyphId), doc);
            if (byteLength > largestGlyphBytes) {
                largestGlyphBytes = byteLength;
                largestGlyphName = this._glyphNameById.get(glyphId) ?? null;
            }
        }

        return {
            fontCoreBytes: encodedLength(FONT_CORE_DOCUMENT_ID, this.yDoc),
            fontDepsBytes: encodedLength(FONT_DEPS_DOCUMENT_ID, this.depsDoc),
            largestGlyphBytes,
            largestGlyphName
        };
    }

    beginSparseWorkingSet(glyphIds: string[] = []): void {
        this._sparseSession = true;
        this._sparseWorkingGlyphIds = new Set(glyphIds.filter(Boolean));
    }

    hasSparseWorkingSet(): boolean {
        return this._sparseSession;
    }

    listSparseWorkingGlyphIds(): string[] {
        return [...this._sparseWorkingGlyphIds];
    }

    isSparseWorkingGlyphName(glyphName: string): boolean {
        const glyphId = this._glyphIdByName.get(glyphName);
        if (!glyphId) {
            return false;
        }
        return this._sparseWorkingGlyphIds.has(glyphId);
    }

    replaceSparseWorkingGlyphIds(glyphIds: string[]): void {
        this.beginSparseWorkingSet(glyphIds);
    }

    private _clearSparseWorkingSet(): void {
        this._sparseSession = false;
        this._sparseWorkingGlyphIds.clear();
    }

    encodeDocumentState(documentId: string = FONT_CORE_DOCUMENT_ID): YjsUpdate {
        const doc = this._docForId(documentId);
        return doc ? Y.encodeStateAsUpdate(doc) : new Uint8Array();
    }

    encodeDocumentStateVector(
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): YjsUpdate {
        const doc = this._docForId(documentId);
        return doc ? Y.encodeStateVector(doc) : new Uint8Array();
    }

    applyDocumentCheckpoint(documentId: string, state: YjsUpdate): void {
        if (!state?.length) {
            return;
        }
        let repairedGlyphName: string | null = null;
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            let doc = this._docForId(documentId);
            if (!doc && documentId.startsWith('glyph:')) {
                doc = this._ensureGlyphDocFromShard({
                    documentId,
                    bytes: state
                });
            }
            if (!doc) {
                doc = this.yDoc;
            }
            Y.applyUpdate(doc, state, SYSTEM_REMOTE_ORIGIN);
            this._noteBroadcastStateVector(documentId);
            if (documentId === FONT_CORE_DOCUMENT_ID) {
                this._rehydrateEntireFontJsonFromYDoc();
            } else if (documentId.startsWith('glyph:')) {
                this._rebuildGlyphNameIndexFromDocs();
                const glyphName = this._glyphNameById.get(
                    documentId.slice('glyph:'.length)
                );
                if (glyphName) {
                    this._patchGlyphFromYDoc(glyphName, {
                        ignoreExisting: true
                    });
                    repairedGlyphName = glyphName;
                }
            }
            this._repairGeometryOrphansAfterConvergedState(documentId);
            this._emitAfterSync();
        } finally {
            this._isApplyingRemote = false;
        }
        // Glyph shards are authoritative. Once a full checkpoint has been
        // merged, repair only that source's denormalized edge map against its
        // authoritative revision; the local deps update is then broadcast as
        // an ordinary CRDT delta. Skip during sparse HTTP hydrate: each
        // shard would otherwise POST/WS font-deps and trip rate limits.
        if (
            repairedGlyphName &&
            this._fontJson &&
            this._afterSyncDeferDepth === 0
        ) {
            const glyphId = this._glyphIdByName.get(repairedGlyphName);
            const glyphRevision = glyphId
                ? this._glyphDocs
                      .get(glyphId)
                      ?.getMap(GLYPH_SYNC_MAP_KEY)
                      .get(GLYPH_SYNC_REVISION_KEY)
                : null;
            const depsRevision =
                glyphId &&
                this.depsDoc.getMap('deps').get('sourceRevision') instanceof
                    Y.Map
                    ? (
                          this.depsDoc
                              .getMap('deps')
                              .get('sourceRevision') as Y.Map<unknown>
                      ).get(glyphId)
                    : null;
            if (glyphRevision !== depsRevision) {
                this.syncFontDepsFromFontJson(this._fontJson, [
                    repairedGlyphName
                ]);
            }
        }
    }

    applyDocumentCatchUp(
        documentId: string,
        update: YjsUpdate,
        _collaborationMessages?: CollaborationMessageEnvelope[],
        _remoteEntries?: ChangeLogEntry[],
        expectedRevision?: string
    ): boolean {
        if (!update?.length) {
            return false;
        }
        this.applyDocumentCheckpoint(documentId, update);
        if (documentId !== FONT_DEPS_DOCUMENT_ID) {
            // Live WS catch-up is often a delta vs the HTTP-hydrated SV.
            // Worker replace seeds an empty Yrs doc, so it must receive a
            // full encodeStateAsUpdate of the merged JS shard.
            const workerState = this.encodeDocumentState(documentId);
            if (workerState.length) {
                this._workerDocumentReplaceCallback?.(documentId, workerState);
            }
        }
        if (
            expectedRevision &&
            !this.glyphHasCatchUpRevision(documentId, expectedRevision)
        ) {
            return false;
        }
        return true;
    }

    glyphHasCatchUpRevision(documentId: string, revision: string): boolean {
        const glyphId = glyphIdFromDocumentId(documentId);
        if (!glyphId) {
            return false;
        }
        const doc = this._glyphDocs.get(glyphId);
        const token = doc
            ?.getMap(GLYPH_SYNC_MAP_KEY)
            .get(GLYPH_SYNC_REVISION_KEY);
        return token === revision;
    }

    listGlyphRevisionTokens(): Array<{ glyphId: string; revision: string }> {
        const revisions = this.yDoc.getMap(GLYPH_REVISIONS_KEY);
        const tokens: Array<{ glyphId: string; revision: string }> = [];
        revisions.forEach((value, glyphId) => {
            if (typeof value === 'string' && value) {
                tokens.push({ glyphId, revision: value });
            }
        });
        return tokens;
    }

    onCoreHydrated(cb: () => void): void {
        this._coreHydratedListeners.add(cb);
    }

    offCoreHydrated(cb: () => void): void {
        this._coreHydratedListeners.delete(cb);
    }

    syncCloudOwnedProjection(owned: CloudOwnedFontData): void {
        if (!this._fontJson) {
            this._fontJson = {};
        }
        const fontRecord = this._fontJson as Record<string, unknown>;
        const existingFormat =
            fontRecord.format_specific &&
            typeof fontRecord.format_specific === 'object' &&
            !Array.isArray(fontRecord.format_specific)
                ? (fontRecord.format_specific as Record<string, unknown>)
                : {};
        const operations: TransactionBufferedOperation[] = [
            {
                op: 'set',
                path: [CORE_GLYPH_CATALOG_KEY],
                oldValue: fontRecord[CORE_GLYPH_CATALOG_KEY],
                newValue: owned.glyphCatalog
            },
            {
                op: 'set',
                path: [CORE_CODEPOINT_INDEX_KEY],
                oldValue: fontRecord[CORE_CODEPOINT_INDEX_KEY],
                newValue: owned.codepointIndex
            }
        ];
        if (CLOUD_PLUGIN_OWNED_KEY in existingFormat) {
            operations.push({
                op: 'remove',
                path: ['format_specific', CLOUD_PLUGIN_OWNED_KEY],
                oldValue: existingFormat[CLOUD_PLUGIN_OWNED_KEY],
                newValue: undefined
            });
        }
        this._queueOrCommitOperations(operations, 'Update cloud catalog');
        fontRecord[CORE_GLYPH_CATALOG_KEY] = owned.glyphCatalog;
        fontRecord[CORE_CODEPOINT_INDEX_KEY] = owned.codepointIndex;
        if (CLOUD_PLUGIN_OWNED_KEY in existingFormat) {
            const nextFormat = { ...existingFormat };
            delete nextFormat[CLOUD_PLUGIN_OWNED_KEY];
            if (Object.keys(nextFormat).length) {
                fontRecord.format_specific = nextFormat;
            } else {
                delete fontRecord.format_specific;
            }
        }
    }

    syncFontDepsFromFontJson(
        fontJson: Record<string, unknown>,
        glyphNames?: string[]
    ): void {
        const depsMap = this.depsDoc.getMap('deps');
        this.depsDoc.transact(() => {
            if (!glyphNames || glyphNames.length === 0) {
                writeCompleteFontDepsIfLoaded(depsMap, fontJson);
                return;
            }
            const glyphs = listGlyphRecords(fontJson);
            const idByName = new Map<string, string>();
            const glyphByName = new Map<string, Record<string, unknown>>();
            const catalog = catalogEntriesForDepsParse(fontJson);
            for (const entry of catalog) {
                idByName.set(entry.name, entry.glyphId);
            }
            for (const glyph of glyphs) {
                const name = String(glyph.name || '');
                if (name) {
                    const glyphId = ensureImmutableGlyphId(glyph);
                    idByName.set(name, glyphId);
                    glyphByName.set(name, glyph);
                    if (
                        !catalog.some(
                            (entry) =>
                                entry.glyphId === glyphId || entry.name === name
                        )
                    ) {
                        catalog.push({ glyphId, name });
                    }
                }
            }
            for (const name of glyphNames) {
                const sourceId = idByName.get(name);
                const glyph = glyphByName.get(name);
                if (!sourceId || !glyph) {
                    continue;
                }
                const sourceRevision = this._glyphDocs
                    .get(sourceId)
                    ?.getMap(GLYPH_SYNC_MAP_KEY)
                    .get(GLYPH_SYNC_REVISION_KEY);
                patchSourceEdges(
                    depsMap,
                    sourceId,
                    buildFontDepsForGlyph(glyph, catalog),
                    typeof sourceRevision === 'string' && sourceRevision
                        ? sourceRevision
                        : '0'
                );
            }
        }, FONT_EDIT_ORIGIN);
    }

    syncCompleteFontDepsFromLoadedGlyphs(
        fontJson: Record<string, unknown>
    ): boolean {
        let wrote = false;
        this.depsDoc.transact(() => {
            wrote = writeCompleteFontDepsIfLoaded(
                this.depsDoc.getMap('deps'),
                fontJson
            );
        }, FONT_EDIT_ORIGIN);
        return wrote;
    }

    encodeDocumentSet(): EncodedShard[] {
        const shards: EncodedShard[] = [
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                bytes: Y.encodeStateAsUpdate(this.yDoc)
            },
            {
                documentId: FONT_DEPS_DOCUMENT_ID,
                bytes: Y.encodeStateAsUpdate(this.depsDoc)
            }
        ];
        for (const [glyphId, doc] of this._glyphDocs) {
            shards.push({
                documentId: glyphDocumentId(glyphId),
                bytes: Y.encodeStateAsUpdate(doc)
            });
        }
        for (const shard of shards) {
            this._lastEncodedShardBytes.set(
                shard.documentId,
                shard.bytes.byteLength
            );
        }
        return shards;
    }

    getEstimatedLiveEncodedBytes(): number {
        let total = 0;
        for (const byteLength of this._lastEncodedShardBytes.values()) {
            if (Number.isFinite(byteLength) && byteLength > 0) {
                total += byteLength;
            }
        }
        return total;
    }

    private _glyphHasRetainedLocalState(
        glyphId: string,
        glyphName: string | undefined
    ): boolean {
        if (this._txDepth > 0) {
            return true;
        }
        const documentId = glyphDocumentId(glyphId);
        const doc = this._glyphDocs.get(glyphId);
        const lastVector = this._lastBroadcastStateVectorByDoc.get(documentId);
        if (doc && lastVector) {
            const delta = Y.encodeStateAsUpdate(doc, lastVector);
            if (delta.byteLength > 2) {
                return true;
            }
        }
        if (!glyphName) {
            return false;
        }
        const glyphUndo = this._undoManagers.get(glyphName);
        if (
            glyphUndo &&
            (glyphUndo.undoStack.length > 0 || glyphUndo.redoStack.length > 0)
        ) {
            return true;
        }
        const glyphHistory = this._undoHistoryStacks.get(glyphName);
        if (
            glyphHistory &&
            (glyphHistory.active.length > 0 || glyphHistory.undone.length > 0)
        ) {
            return true;
        }
        const layerPrefix = `${glyphName}@@`;
        for (const [key, entry] of this._layerUndoManagers) {
            if (!key.startsWith(layerPrefix)) {
                continue;
            }
            if (
                entry.manager.undoStack.length > 0 ||
                entry.manager.redoStack.length > 0
            ) {
                return true;
            }
        }
        for (const [key, stacks] of this._undoHistoryStacks) {
            if (!key.startsWith(layerPrefix)) {
                continue;
            }
            if (stacks.active.length > 0 || stacks.undone.length > 0) {
                return true;
            }
        }
        return false;
    }

    private _releaseGlyphLocalManagers(glyphName: string): void {
        const glyphUndo = this._undoManagers.get(glyphName);
        glyphUndo?.destroy();
        this._undoManagers.delete(glyphName);
        this._undoHistoryStacks.delete(glyphName);
        const layerPrefix = `${glyphName}@@`;
        for (const key of [...this._layerUndoManagers.keys()]) {
            if (!key.startsWith(layerPrefix)) {
                continue;
            }
            this._layerUndoManagers.get(key)?.manager.destroy();
            this._layerUndoManagers.delete(key);
        }
        for (const key of [...this._undoHistoryStacks.keys()]) {
            if (key.startsWith(layerPrefix)) {
                this._undoHistoryStacks.delete(key);
            }
        }
    }

    unloadCleanGlyphDocuments(keepIds: Iterable<string>): string[] {
        const keep = new Set([...keepIds].filter(Boolean));
        const linkedPeers = (
            window as Window & {
                windowSync?: { peers?: { size?: number } };
            }
        ).windowSync?.peers;
        if (linkedPeers && Number(linkedPeers.size) > 0) {
            return [];
        }
        const liveName =
            (
                window as Window & {
                    glyphCanvas?: {
                        outlineEditor?: { currentGlyphName?: string };
                        getCurrentGlyphName?: () => string | null;
                    };
                }
            ).glyphCanvas?.outlineEditor?.currentGlyphName ||
            (
                window as Window & {
                    glyphCanvas?: { getCurrentGlyphName?: () => string | null };
                }
            ).glyphCanvas?.getCurrentGlyphName?.() ||
            null;
        if (liveName) {
            const liveId = this._glyphIdByName.get(liveName);
            if (liveId) {
                keep.add(liveId);
            }
        }
        const unloaded: string[] = [];
        for (const glyphId of [...this._glyphDocs.keys()]) {
            if (keep.has(glyphId) || this._sparseWorkingGlyphIds.has(glyphId)) {
                continue;
            }
            const name = this._glyphNameById.get(glyphId);
            if (this._glyphHasRetainedLocalState(glyphId, name)) {
                continue;
            }
            const documentId = glyphDocumentId(glyphId);
            this._docUpdateUnsubById.get(documentId)?.();
            this._docUpdateUnsubById.delete(documentId);
            this._lastBroadcastStateVectorByDoc.delete(documentId);
            const doc = this._glyphDocs.get(glyphId);
            doc?.destroy();
            this._glyphDocs.delete(glyphId);
            this._glyphNameById.delete(glyphId);
            if (name) {
                this._glyphIdByName.delete(name);
                this._releaseGlyphLocalManagers(name);
            }
            this._lastEncodedShardBytes.delete(documentId);
            unloaded.push(glyphId);
        }
        return unloaded;
    }

    applyDocumentSetState(shards: EncodedShard[]): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            for (const shard of shards) {
                const doc =
                    shard.documentId === FONT_CORE_DOCUMENT_ID
                        ? this.yDoc
                        : shard.documentId === FONT_DEPS_DOCUMENT_ID
                          ? this.depsDoc
                          : this._ensureGlyphDocFromShard(shard);
                Y.applyUpdate(doc, shard.bytes, SYSTEM_REMOTE_ORIGIN);
                this._noteBroadcastStateVector(shard.documentId);
                this._lastEncodedShardBytes.set(
                    shard.documentId,
                    shard.bytes.byteLength
                );
            }
            this._rebuildGlyphNameIndexFromDocs();
            this._rehydrateEntireFontJsonFromYDoc();
            this._canonicalizeFullStateRawFontJson();
            this._repairGeometryOrphansAfterConvergedState();
            this._setupFontUndoManager();
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
        } finally {
            this._isApplyingRemote = false;
        }
    }

    private _ensureGlyphDocFromShard(shard: EncodedShard): Y.Doc {
        const glyphId = shard.documentId.startsWith('glyph:')
            ? shard.documentId.slice('glyph:'.length)
            : shard.documentId;
        let doc = this._glyphDocs.get(glyphId);
        if (!doc) {
            doc = new Y.Doc({ gc: false });
            this._glyphDocs.set(glyphId, doc);
            this._bindDocUpdates(doc, glyphDocumentId(glyphId));
        }
        return doc;
    }

    private _rebuildGlyphNameIndexFromDocs(): void {
        this._glyphIdByName.clear();
        this._glyphNameById.clear();
        for (const [glyphId, doc] of this._glyphDocs) {
            const glyphMap = doc.getMap('glyph');
            const nameValue = glyphMap.get('name');
            const name =
                typeof nameValue === 'string' && nameValue
                    ? nameValue
                    : glyphId;
            this._glyphIdByName.set(name, glyphId);
            this._glyphNameById.set(glyphId, name);
        }
    }

    private _routedYPath(
        path: Array<string | number>,
        options?: { createIfMissing?: boolean }
    ): {
        map: Y.Map<unknown>;
        path: Array<string | number>;
        doc: Y.Doc;
        documentId: string;
    } {
        const documentId = this.documentIdForPath(path);
        if (path[0] === 'glyphs' && path.length >= 2) {
            const glyphName = String(path[1]);
            let glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap && options?.createIfMissing) {
                const glyphId = this._glyphIdByName.get(glyphName) || glyphName;
                this._ensureGlyphDoc(glyphId, glyphName);
                glyphMap = this._glyphMapForName(glyphName);
            }
            if (!glyphMap) {
                return {
                    map: this.fontMap,
                    path,
                    doc: this.yDoc,
                    documentId
                };
            }
            return {
                map: glyphMap,
                path: path.slice(2),
                doc:
                    this._docForId(documentId) ||
                    this._ensureGlyphDoc(
                        this._glyphIdByName.get(glyphName) || glyphName,
                        glyphName
                    ),
                documentId
            };
        }
        if (documentId === FONT_DEPS_DOCUMENT_ID) {
            const depsMap = this.depsDoc.getMap('deps');
            return {
                map: depsMap,
                path: path[0] === 'deps' ? path.slice(1) : path.slice(1),
                doc: this.depsDoc,
                documentId
            };
        }
        if (path[0] === GLYPH_REVISIONS_KEY) {
            return {
                map: this.yDoc.getMap(GLYPH_REVISIONS_KEY),
                path: path.slice(1),
                doc: this.yDoc,
                documentId: FONT_CORE_DOCUMENT_ID
            };
        }
        return {
            map: this.fontMap,
            path,
            doc: this.yDoc,
            documentId
        };
    }

    private _setRoutedYPath(
        path: Array<string | number>,
        value: unknown
    ): void {
        if (
            path[0] === 'glyphs' &&
            path.length === 2 &&
            value &&
            typeof value === 'object'
        ) {
            this._applyGlyphSnapshot(String(path[1]), value);
            return;
        }
        if (path[0] === 'glyphs' && path.length === 2 && value == null) {
            this._removeGlyphDoc(String(path[1]));
            return;
        }
        const routed = this._routedYPath(path, { createIfMissing: true });
        setYPath(routed.map, routed.path, value);
    }

    private _deleteRoutedYPath(path: Array<string | number>): void {
        if (path[0] === 'glyphs' && path.length === 2) {
            this._removeGlyphDoc(String(path[1]));
            return;
        }
        const routed = this._routedYPath(path);
        deleteYPath(routed.map, routed.path);
    }

    private _getRoutedYPath(path: Array<string | number>): unknown {
        if (path[0] === 'glyphs' && path.length === 2) {
            return this._glyphMapForName(String(path[1])) || undefined;
        }
        const routed = this._routedYPath(path);
        if (path[0] === 'glyphs' && path.length >= 2 && routed.path === path) {
            return undefined;
        }
        return getYPath(routed.map, routed.path);
    }

    getYValue(path: Array<string | number>): unknown {
        return this._getRoutedYPath(path);
    }

    private _pendingDestroyedGlyphIds = new Set<string>();

    private _removeGlyphDoc(glyphName: string): void {
        const glyphId = this._glyphIdByName.get(glyphName);
        if (!glyphId) {
            const glyphsMap = this.fontMap.get('glyphs');
            if (glyphsMap instanceof Y.Map) {
                glyphsMap.delete(glyphName);
            }
            return;
        }
        this._pendingDestroyedGlyphIds.add(glyphId);
    }

    private _flushDestroyedGlyphDocs(): void {
        for (const glyphId of this._pendingDestroyedGlyphIds) {
            const glyphName = this._glyphNameById.get(glyphId);
            if (glyphName) {
                this._glyphIdByName.delete(glyphName);
            }
            this._glyphNameById.delete(glyphId);
        }
        this._pendingDestroyedGlyphIds.clear();
    }

    private _syncGlyphNameIndexToOrder(): void {
        const remaining = new Set(this._readYGlyphOrderNames());
        for (const [glyphName, glyphId] of [...this._glyphIdByName]) {
            if (!remaining.has(glyphName)) {
                this._glyphIdByName.delete(glyphName);
                this._glyphNameById.delete(glyphId);
            }
        }
        for (const glyphName of remaining) {
            if (this._glyphIdByName.has(glyphName)) {
                continue;
            }
            for (const [glyphId, doc] of this._glyphDocs) {
                const nameValue = doc.getMap('glyph').get('name');
                if (nameValue === glyphName) {
                    this._glyphIdByName.set(glyphName, glyphId);
                    this._glyphNameById.set(glyphId, glyphName);
                    break;
                }
            }
        }
    }

    private _applyGlyphNameRemapsFromEntries(
        entries: ChangeLogEntry[],
        direction: 'undo' | 'redo'
    ): void {
        const remaps: Array<{ oldName: string; newName: string }> = [];
        for (const entry of entries) {
            for (const rename of normalizeGlyphRenames(entry.glyphRenames)) {
                remaps.push(
                    direction === 'undo'
                        ? {
                              oldName: rename.newName,
                              newName: rename.oldName
                          }
                        : {
                              oldName: rename.oldName,
                              newName: rename.newName
                          }
                );
            }
        }
        if (!remaps.length) {
            return;
        }
        const resolved = remaps.flatMap((remap) => {
            const glyphId =
                this._glyphIdByName.get(remap.oldName) ||
                this._glyphIdByName.get(remap.newName);
            if (!glyphId) {
                return [];
            }
            return [{ ...remap, glyphId }];
        });
        for (const remap of resolved) {
            this._glyphIdByName.delete(remap.oldName);
        }
        for (const remap of resolved) {
            this._glyphIdByName.set(remap.newName, remap.glyphId);
            this._glyphNameById.set(remap.glyphId, remap.newName);
        }
    }

    private _emitRawLocalUpdate(
        update: YjsUpdate,
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): void {
        if (!update.length) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            this._noteBroadcastStateVector(documentId);
            return;
        }

        this._emitLocalUpdate(
            update,
            this._getNewChangeLogEntriesForLocalUpdate(),
            documentId
        );
        this._noteBroadcastStateVector(documentId);
    }

    private _emitLocalUpdate(
        update: YjsUpdate,
        changeLogEntries: ChangeLogEntry[],
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): void {
        // Undo/redo may append a coarse control entry for history-stack state,
        // but every emitted Yjs packet must still be observed through the same
        // semantic metadata shape as the original forward edit. Unwrap control
        // rows here so worker/cache/compile/broadcast consumers never need an
        // undo-specific path.
        const emissionEntries = getEffectiveEmissionEntries(changeLogEntries);
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                emissionEntries,
                {
                    localSequence: this._nextCollaborationMessageSequence++,
                    source: 'change-bridge',
                    windowId: this.windowId
                }
            );
        if (collaborationMessage) {
            this._appendCollaborationLogItems([
                this._createCollaborationLogItem(
                    collaborationMessage,
                    update,
                    'local',
                    this._deriveForwardChangesFromChangeLogEntries(
                        emissionEntries
                    )
                )
            ]);
        }
        const deliver = (): void => {
            pushCollabIntegrityEvent('emit-local', {
                documentId,
                bytes: update.length,
                hasCollaborationMessage: Boolean(collaborationMessage),
                entries: emissionEntries.length
            });
            for (const cb of this._localUpdateListeners) {
                cb(update, collaborationMessage, emissionEntries, documentId);
            }
            if (
                emissionEntries.length > 0 &&
                !areGlyphRevisionOnlyEntries(emissionEntries)
            ) {
                this._yjsWorkerCallback?.(update, emissionEntries, documentId);
            }
            for (const cb of this._committedChangeListeners) {
                cb(emissionEntries, { origin: 'local', update, documentId });
            }
        };
        const plugin = window.cloudPlugin;
        if (
            typeof plugin?.persistOutgoingCloudUpdate === 'function' &&
            collaborationMessage
        ) {
            const pending = Promise.resolve(
                plugin.persistOutgoingCloudUpdate(
                    update,
                    collaborationMessage,
                    documentId
                )
            ).then(
                (ok) => {
                    pushCollabIntegrityEvent('emit-persist', {
                        documentId,
                        bytes: update.length,
                        ok: ok !== false
                    });
                    if (ok !== false) {
                        deliver();
                    }
                },
                (error) => {
                    pushCollabIntegrityEvent('emit-persist', {
                        documentId,
                        bytes: update.length,
                        ok: false,
                        error: String(error)
                    });
                }
            );
            this._cloudEmitPersistChain = Promise.all([
                this._cloudEmitPersistChain,
                pending
            ]).then(
                () => undefined,
                () => undefined
            );
            return;
        }
        deliver();
    }

    private _documentIdsForHistoryItem(
        item: HistoryStackItem | null | undefined,
        fallbackDocumentId: string
    ): string[] {
        const documentIds = new Set<string>([fallbackDocumentId]);
        const itemRenames = this._collectGlyphRenamesFromEntries(
            item?.entries ?? []
        );
        for (const entry of item?.entries ?? []) {
            if (!entry.path || entry.path === 'font') {
                documentIds.add(FONT_CORE_DOCUMENT_ID);
                continue;
            }
            documentIds.add(
                this._documentIdForHistoryEntry(entry, itemRenames)
            );
        }
        return [...documentIds];
    }

    private _captureDocumentBaselines(
        documentIds: string[]
    ): Map<string, Uint8Array> {
        const baselines = new Map<string, Uint8Array>();
        for (const documentId of documentIds) {
            const doc = this._docForId(documentId);
            if (doc) {
                baselines.set(documentId, Y.encodeStateVector(doc));
            }
        }
        return baselines;
    }

    private _emitCanonicalLocalUpdatesSince(
        baselines: Map<string, Uint8Array>
    ): void {
        const allEntries = getEffectiveEmissionEntries(
            this._getNewChangeLogEntriesForLocalUpdate()
        );
        let emitted = false;
        for (const [documentId, baseline] of baselines) {
            const doc = this._docForId(documentId) || this.yDoc;
            const incrementalUpdate = Y.encodeStateAsUpdate(doc, baseline);
            this._noteBroadcastStateVector(documentId);
            const historyRenames =
                this._collectGlyphRenamesFromEntries(allEntries);
            const docEntries = allEntries.filter((entry) => {
                if (!entry.path || entry.path === 'font') {
                    return documentId === FONT_CORE_DOCUMENT_ID;
                }
                return (
                    this._documentIdForHistoryEntry(entry, historyRenames) ===
                    documentId
                );
            });
            if (
                incrementalUpdate.length === 0 ||
                (isNoOpYjsUpdate(incrementalUpdate) && !docEntries.length)
            ) {
                continue;
            }
            if (!docEntries.length) {
                pushCollabIntegrityEvent('emit-skip-no-changelog', {
                    documentId,
                    bytes: incrementalUpdate.length
                });
                continue;
            }
            this._emitLocalUpdate(incrementalUpdate, docEntries, documentId);
            emitted = true;
        }
        if (!emitted) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
        }
    }

    private _documentIdForUndoTarget(target: {
        glyphName: string | null;
        layerId?: string | null;
    }): string {
        if (target.glyphName) {
            return this.documentIdForPath(['glyphs', target.glyphName]);
        }
        return FONT_CORE_DOCUMENT_ID;
    }

    private _emitCanonicalLocalUpdateSince(
        previousStateVector: Uint8Array,
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): void {
        const doc = this._docForId(documentId) || this.yDoc;
        const incrementalUpdate = Y.encodeStateAsUpdate(
            doc,
            previousStateVector
        );
        this._noteBroadcastStateVector(documentId);

        if (incrementalUpdate.length === 0) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            return;
        }

        this._emitLocalUpdate(
            incrementalUpdate,
            this._getNewChangeLogEntriesForLocalUpdate(),
            documentId
        );
    }

    private _emitCanonicalLocalUpdateFromBaseline(): void {
        this._emitCanonicalLocalUpdateSince(this._lastBroadcastStateVector);
    }

    getFontJsonSnapshot(): Record<string, Unsafe> | null {
        return this._fontJson;
    }

    /**
     * Read-only sizes for the Preferences memory breakdown.
     * Does not encode the Y.Doc (that would allocate and move Used).
     */
    getMemoryInspectionSnapshot(): {
        fontJson: Record<string, Unsafe> | null;
        yDocStore: unknown;
        decodedStructs: number;
        undoStacks: unknown[];
        undoStackItems: number;
        changeLog: ChangeLogEntry[];
        collaborationLog: CollaborationLogItem[];
    } {
        const undoManagers: Array<{
            undoStack?: unknown[];
            redoStack?: unknown[];
        }> = [
            this._fontUndoManager,
            ...this._undoManagers.values(),
            ...Array.from(this._layerUndoManagers.values()).map(
                (entry) => entry.manager
            )
        ].filter((manager): manager is Y.UndoManager => manager != null);

        const undoStacks: unknown[] = [];
        let undoStackItems = 0;
        for (const manager of undoManagers) {
            undoStacks.push(manager.undoStack, manager.redoStack);
            undoStackItems += manager.undoStack?.length ?? 0;
            undoStackItems += manager.redoStack?.length ?? 0;
        }

        let decodedStructs = 0;
        this.yDoc.store.clients.forEach((structs) => {
            decodedStructs += structs.length;
        });

        return {
            fontJson: this._fontJson,
            yDocStore: this.yDoc.store,
            decodedStructs,
            undoStacks,
            undoStackItems,
            changeLog: this._changeLog,
            collaborationLog: this._collaborationLog
        };
    }

    // ── Lifecycle ────────────────────────────────────────────────

    /**
     * Initialize the Y.Doc from the current babelfont JSON.
     * Call this once after a font is loaded, before steady-state incremental
     * Yjs updates begin.
     */
    initFromJson(fontJson: Record<string, Unsafe>): void {
        this._clearSparseWorkingSet();
        this._fontJson = fontJson;
        this._isSyncing = true;
        stampImmutableGlyphIds(fontJson);
        applyCloudOwnedData(fontJson);
        this._destroyGlyphDocs();
        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            this.yDoc.transact(() => {
                this.fontMap.forEach((_v: unknown, k: string) => {
                    this.fontMap.delete(k);
                });
                jsonToCoreFontMap(fontJson, this.fontMap);
            }, USER_EDIT_ORIGIN);
            for (const glyph of listGlyphRecords(fontJson)) {
                const glyphId = ensureImmutableGlyphId(glyph);
                const name = String(glyph.name || glyphId);
                this._ensureGlyphDoc(glyphId, name, glyph);
            }
        } finally {
            this._suppressAutomaticLocalUpdateEmission = false;
            this._isSyncing = false;
        }
        this._rehydrateEntireFontJsonFromYDoc();
        this._setupFontUndoManager();
        this._noteBroadcastStateVector(FONT_CORE_DOCUMENT_ID);
        this._noteBroadcastStateVector(FONT_DEPS_DOCUMENT_ID);
        for (const glyphId of this._glyphDocs.keys()) {
            this._noteBroadcastStateVector(glyphDocumentId(glyphId));
        }
    }

    /**
     * Set the font JSON reference without populating the Y.Doc.
     * Used by sync (secondary) windows that will receive the Y.Doc
     * state from a peer via applyFullState().
     */
    setFontJson(fontJson: Record<string, Unsafe>): void {
        this._fontJson = fontJson;
    }

    /** Register a callback for when a remote change modifies local JSON. */
    onRemoteChange(cb: (entries: ChangeLogEntry[]) => void): void {
        this._onRemoteChange = cb;
    }

    onCollaborationLogUpdate(
        cb: (items: CollaborationLogItem[]) => void
    ): () => void {
        this._collaborationLogListeners.add(cb);
        cb(this.getCollaborationLog());
        return () => {
            this._collaborationLogListeners.delete(cb);
        };
    }

    /** Register a callback for local Y.Doc updates (for broadcasting). */
    onLocalUpdate(cb: LocalUpdateListener): void {
        this._localUpdateListeners.add(cb);
    }

    /** Unregister a callback previously passed to onLocalUpdate. */
    offLocalUpdate(cb: LocalUpdateListener): void {
        this._localUpdateListeners.delete(cb);
    }

    /**
     * Wait until cloud WAL-before-apply commits queued by this engine have
     * finished applying to Yjs. UI edits return before that async path.
     */
    async waitForPendingCloudCommits(): Promise<void> {
        await this._cloudWalCommitChain;
        await this._cloudEmitPersistChain;
    }

    /** Register a callback for committed local and remote changes. */
    onCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.add(cb);
    }

    /** Unregister a callback previously passed to onCommittedChange. */
    offCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.delete(cb);
    }

    onGlyphRevisionSignal(cb: GlyphRevisionSignalListener): void {
        this._glyphRevisionListeners.add(cb);
    }

    offGlyphRevisionSignal(cb: GlyphRevisionSignalListener): void {
        this._glyphRevisionListeners.delete(cb);
    }

    /** Register a callback to mark the font as dirty. */
    onDirty(cb: () => void): void {
        this._onDirty = cb;
    }

    /** Register a callback for after _syncJsonFromYDoc (undo/redo/remote). */
    onAfterSync(cb: () => void): void {
        this._onAfterSync = cb;
    }

    /**
     * Coalesce Font.fromData / compile-context resets across a burst of
     * glyph-shard catch-ups (sparse typing hydrate).
     */
    beginDeferredAfterSync(): void {
        this._afterSyncDeferDepth += 1;
    }

    endDeferredAfterSync(): void {
        this._afterSyncDeferDepth = Math.max(0, this._afterSyncDeferDepth - 1);
        if (this._afterSyncDeferDepth === 0 && this._afterSyncSkipped) {
            this._afterSyncSkipped = false;
            this._onAfterSync?.();
        }
    }

    runWithDeferredAfterSync<T>(fn: () => T): T {
        this.beginDeferredAfterSync();
        try {
            return fn();
        } finally {
            this.endDeferredAfterSync();
        }
    }

    private _emitAfterSync(): void {
        if (this._afterSyncDeferDepth > 0) {
            this._afterSyncSkipped = true;
            return;
        }
        this._onAfterSync?.();
    }

    setTransactionFinalizer(cb: TransactionFinalizer | null): void {
        this._transactionFinalizer = cb;
    }

    /** Clean up resources. */
    destroy(): void {
        for (const entry of this._layerUndoManagers.values()) {
            entry.manager.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this._undoHistoryStacks.clear();
        for (const unsub of this._docUpdateUnsubscribers) {
            unsub();
        }
        this._docUpdateUnsubscribers = [];
        this._docUpdateUnsubById.clear();
        this._destroyGlyphDocs();
        this.depsDoc.destroy();
        this.yDoc.destroy();
        this._fontJson = null;
        this._changeLog = [];
        this._collaborationLog = [];
        this._onRemoteChange = null;
        this._localUpdateListeners.clear();
        this._committedChangeListeners.clear();
        this._glyphRevisionListeners.clear();
        this._coreHydratedListeners.clear();
        this._clearSparseWorkingSet();
        this._onDirty = null;
        this._onAfterSync = null;
        this._changeLogListeners.clear();
        this._collaborationLogListeners.clear();
        this._transactionFinalizer = null;
        this._txStartTimeMs = null;
        this._lastBroadcastStateVector = new Uint8Array(0);
    }

    onChangeLogUpdate(cb: (entries: ChangeLogEntry[]) => void): () => void {
        this._changeLogListeners.add(cb);
        cb(this.getChangeLog());
        return () => {
            this._changeLogListeners.delete(cb);
        };
    }

    private _stabilizeRecordedPath(
        path: (string | number)[]
    ): (string | number)[] {
        if (path[0] === 'glyphs' && path.length >= 2) {
            const glyphMap = this.getYValue(['glyphs', path[1]]);
            if (glyphMap instanceof Y.Map) {
                return [
                    path[0],
                    path[1],
                    ...stabilizeIndexedMapPath(glyphMap, path.slice(2))
                ];
            }
            return path;
        }
        return stabilizeIndexedMapPath(this.fontMap, path);
    }

    // ── Change recording ─────────────────────────────────────────

    /**
     * Record a property change. Called by model setters.
     *
     * @param path   Array path from font root, e.g. ["glyphs","A","layers","uuid","width"]
     * @param prop   Terminal property name, e.g. "width"
     * @param oldVal Previous value
     * @param newVal New value
     */
    recordChange(
        path: (string | number)[],
        prop: string | number,
        oldVal: unknown,
        newVal: unknown
    ): void {
        if (this._suppressRecording || this._isSyncing) return;
        assertCloudAssetMutable();

        const fullPath = this._stabilizeRecordedPath([...path, prop]);
        this._queueOrCommitOperations([
            {
                op: 'set',
                path: fullPath,
                oldValue: cloneHistoryValue(oldVal),
                newValue: cloneHistoryValue(newVal)
            }
        ]);
    }

    /**
     * Record an add operation (new glyph, layer, shape, etc.).
     * Glyph-root adds also sync `glyphOrder` from the model array when the
     * glyph is already spliced there (addGlyph / duplicate / paste), so
     * `_syncAllGlyphsFromYDoc` does not append the new name at the end.
     */
    recordAdd(path: (string | number)[], value: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;
        assertCloudAssetMutable();

        const isObjectValue =
            !!value && typeof value === 'object' && !Array.isArray(value);
        const isLayerRoot =
            path.length === 4 && path[0] === 'glyphs' && path[2] === 'layers';
        const operations: TransactionBufferedOperation[] = [
            {
                op: 'add',
                path,
                oldValue: undefined,
                newValue: cloneHistoryValue(value),
                applyMode:
                    isObjectValue && this._isGlyphRootPath(path)
                        ? 'glyph-snapshot'
                        : isObjectValue && isLayerRoot
                          ? 'layer-snapshot'
                          : 'default'
            }
        ];

        if (this._isGlyphRootPath(path)) {
            const glyphOrderOp = this._createModelGlyphOrderSyncOperation(
                String(path[1]),
                'add'
            );
            if (glyphOrderOp) {
                operations.push(glyphOrderOp);
            }
        }

        this._queueOrCommitOperations(operations);
    }

    /**
     * Record a remove operation.
     */
    recordRemove(path: (string | number)[], oldValue: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;
        assertCloudAssetMutable();

        const operations: TransactionBufferedOperation[] = [
            {
                op: 'remove',
                path,
                oldValue: cloneHistoryValue(oldValue),
                newValue: undefined
            }
        ];

        if (this._isGlyphRootPath(path)) {
            const glyphOrderOp =
                this._createModelGlyphOrderSyncOperation(
                    String(path[1]),
                    'remove'
                ) || this._createGlyphOrderRemoveOperation(String(path[1]));
            if (glyphOrderOp) {
                operations.push(glyphOrderOp);
            }
        }

        this._queueOrCommitOperations(operations);
    }

    /**
     * True when the Y.Doc glyph map still holds `glyphName`.
     * Used to preflight renames before model mutation.
     */
    hasGlyphInYDoc(glyphName: string): boolean {
        return this._readNormalizedGlyphSnapshotFromYDoc(glyphName) != null;
    }

    /**
     * Rename glyph-map keys while preserving their order and storage encoding.
     * Removes every old key before inserting new keys so swaps stay collision-free.
     */
    renameGlyphs(
        renames: Array<{
            oldName: string;
            newName: string;
            glyph: Record<string, unknown>;
        }>,
        label: string
    ): void {
        if (!renames.length || this._suppressRecording || this._isSyncing) {
            return;
        }

        const prepared = renames.map(({ oldName, newName, glyph }) => {
            const oldGlyph = this._readNormalizedGlyphSnapshotFromYDoc(oldName);
            if (!oldGlyph) {
                throw new Error(
                    `Cannot rename glyph "${oldName}": absent from Y.Doc`
                );
            }
            return { oldName, newName, glyph, oldGlyph };
        });

        const fontJson = this._fontJson as {
            glyphs?: Array<{ name?: string }>;
        } | null;
        const oldOrder = Array.isArray(fontJson?.glyphs)
            ? fontJson.glyphs.map((glyph) => glyph.name || '')
            : [];
        const renameMap = new Map(
            prepared.map(({ oldName, newName }) => [oldName, newName])
        );
        const nextOrder = oldOrder.map((name) => renameMap.get(name) || name);
        const operations: TransactionBufferedOperation[] = [];

        for (const { oldName, newName } of prepared) {
            operations.push({
                op: 'set',
                path: ['glyphs', oldName, 'name'],
                oldValue: oldName,
                newValue: newName,
                glyphRenames: [{ oldName, newName }]
            });
        }

        operations.push({
            op: 'set',
            path: ['glyphOrder'],
            oldValue: oldOrder,
            newValue: nextOrder
        });
        this._queueOrCommitOperations(operations, label);
    }

    applySyntheticChangeSet(
        label: string,
        operations: SyntheticChangeOperation[]
    ): void {
        if (
            !operations.length ||
            !this._fontJson ||
            this._suppressRecording ||
            this._isSyncing
        ) {
            return;
        }
        assertCloudAssetMutable();

        if (!operations.some((operation) => operation.path.length > 0)) {
            return;
        }

        this._queueOrCommitOperations(
            operations.map((operation) => {
                const isObjectValue =
                    !!operation.newValue &&
                    typeof operation.newValue === 'object' &&
                    !Array.isArray(operation.newValue);
                const isGlyphRoot = this._isGlyphRootPath(operation.path);
                const isLayerRoot =
                    operation.path.length === 4 &&
                    operation.path[0] === 'glyphs' &&
                    operation.path[2] === 'layers';

                return {
                    op: operation.op,
                    path: operation.path,
                    oldValue: cloneHistoryValue(operation.oldValue),
                    newValue: cloneHistoryValue(operation.newValue),
                    editSource: operation.editSource ?? null,
                    compileChangeSource: operation.compileChangeSource ?? null,
                    compileEditType: operation.compileEditType ?? null,
                    visualAnchorSide: operation.visualAnchorSide ?? null,
                    workerReplayTargets: normalizeWorkerReplayTargets(
                        operation.workerReplayTargets
                    ),
                    applyMode:
                        isObjectValue && isGlyphRoot
                            ? ('glyph-snapshot' as BatchApplyMode)
                            : isObjectValue && isLayerRoot
                              ? ('layer-snapshot' as BatchApplyMode)
                              : 'default'
                };
            }),
            label
        );
    }

    /**
     * Commit an externally edited source snapshot through the regular Yjs
     * change path. The caller supplies the state vector captured before the
     * asynchronous source read so a concurrent local or remote edit cannot be
     * overwritten by the disk snapshot.
     */
    applyExternalSourceReload(
        fontSnapshot: unknown,
        expectedStateVector: Uint8Array
    ): ExternalSourceReloadResult {
        if (
            !this._fontJson ||
            this._suppressRecording ||
            this._isSyncing ||
            this._isApplyingRemote ||
            this._txDepth > 0 ||
            !stateVectorsEqual(
                expectedStateVector,
                Y.encodeStateVector(this.yDoc)
            )
        ) {
            return { status: 'stale', commit: null };
        }

        const previousSnapshot = this._normalizeExternalSourceReloadSnapshot(
            this._captureYDocFontJson()
        );
        const normalizedPreviousSnapshot = this._normalizeFontSnapshot(
            previousSnapshot,
            previousSnapshot
        );
        const storageFontSnapshot =
            this._normalizeExternalSourceReloadSnapshot(fontSnapshot);
        const nextSnapshot = this._normalizeFontSnapshot(
            storageFontSnapshot,
            previousSnapshot
        );
        this._adoptIndexedFontLayerIds(
            normalizedPreviousSnapshot,
            nextSnapshot
        );
        this._stampLiveShapeIdsOnReloadSnapshots(
            this._fontJson,
            normalizedPreviousSnapshot,
            nextSnapshot
        );
        this._adoptGlyphIds(normalizedPreviousSnapshot, nextSnapshot);
        this._preserveLiveCoreKeysAbsentFromSource(
            storageFontSnapshot,
            normalizedPreviousSnapshot,
            nextSnapshot
        );
        this._omitLiveOnlyModelKeys(
            nextSnapshot,
            normalizedPreviousSnapshot,
            this._fontJson
        );
        if (this._isDeepEqual(normalizedPreviousSnapshot, nextSnapshot)) {
            return { status: 'noop', commit: null };
        }

        const commit = this._queueOrCommitOperations(
            diffFontDataToPatchPairs(
                normalizedPreviousSnapshot,
                nextSnapshot
            ).map(({ forward, inverse }) => {
                const path = forward.path;
                const newValue =
                    forward.op === 'remove' ? undefined : forward.value;
                const oldValue =
                    inverse.op === 'remove' ? undefined : inverse.value;
                const isObjectValue =
                    !!newValue &&
                    typeof newValue === 'object' &&
                    !Array.isArray(newValue);
                const isGlyphRoot = this._isGlyphRootPath(path);
                const isLayerRoot =
                    path.length === 4 &&
                    path[0] === 'glyphs' &&
                    path[2] === 'layers';

                return {
                    op:
                        forward.op === 'replace'
                            ? ('set' as ChangeOp)
                            : forward.op,
                    path,
                    oldValue,
                    newValue,
                    applyMode:
                        isObjectValue && isGlyphRoot
                            ? ('glyph-snapshot' as BatchApplyMode)
                            : isObjectValue && isLayerRoot
                              ? ('layer-snapshot' as BatchApplyMode)
                              : 'default'
                };
            }),
            'Reload external source',
            true
        );

        if (commit) {
            this._syncRemoteJsonFromYDoc(commit.changeLogEntries);
            this._onAfterSync?.();
        }

        return {
            status: commit ? 'committed' : 'noop',
            commit
        };
    }

    private _normalizeExternalSourceReloadSnapshot(value: unknown): unknown {
        const normalizeShapes = (
            candidate: unknown,
            isShapeEntry = false
        ): unknown => {
            if (Array.isArray(candidate)) {
                return candidate.map((item) =>
                    normalizeShapes(item, isShapeEntry)
                );
            }
            if (!candidate || typeof candidate !== 'object') {
                return candidate;
            }

            const record = candidate as Record<string, unknown>;
            const normalizedRecord = isShapeEntry
                ? normalizeValueForYDocWrite(record)
                : { ...record };
            if (
                !normalizedRecord ||
                typeof normalizedRecord !== 'object' ||
                Array.isArray(normalizedRecord)
            ) {
                throw new TypeError(
                    'Expected a normalized shape record for external reload.'
                );
            }

            return Object.fromEntries(
                Object.entries(normalizedRecord).map(([key, item]) => [
                    key,
                    normalizeShapes(item, key === 'shapes')
                ])
            );
        };

        return this._prepareStorageValue(normalizeShapes(value));
    }

    // ── Transactions ─────────────────────────────────────────────

    /**
     * Start a named batch transaction.
     * Nested calls increment a depth counter; only the outermost commits.
     */
    beginTransaction(
        label: string,
        historyTarget?: TransactionHistoryTarget | null,
        historyMetadata?: {
            historyItemId?: string | null;
            promptGroupId?: string | null;
            historySummary?: string | null;
        }
    ): void {
        this._txDepth++;
        if (this._txDepth === 1) {
            this._txLabel = label;
            this._txId = this._nextTxId++;
            this._txStartTimeMs = performance.now();
            this._txHistoryItemId =
                historyMetadata?.historyItemId ?? this._createHistoryItemId();
            this._txPromptGroupId = historyMetadata?.promptGroupId ?? null;
            this._txHistorySummary = historyMetadata?.historySummary ?? null;
            this._txHistoryTarget = historyTarget ?? null;
            // Capture a compact state-vector (< 100 bytes) rather than the
            // full font serialization so the fallback canonical-diff path in
            // _emitCanonicalLocalUpdateSince stays cheap.
            this._txStartStateVector = Y.encodeStateVector(this.yDoc);
        }
    }

    /** Update presentation metadata for the current outermost transaction. */
    updateTransactionMetadata(
        promptGroupId: string,
        label: string,
        historySummary: string
    ): boolean {
        if (this._txDepth <= 0 || this._txPromptGroupId !== promptGroupId) {
            return false;
        }

        this._txLabel = label;
        this._txHistorySummary = historySummary;
        return true;
    }

    /**
     * End the current batch transaction.
     */
    endTransaction(): TransactionCommitResult | null {
        if (this._txDepth <= 0) return null;
        this._txDepth--;
        let commitResult: TransactionCommitResult | null = null;
        if (this._txDepth === 0) {
            if (this._txBufferedOperations.length) {
                commitResult = this._commitOperations(
                    this._txBufferedOperations,
                    this._txLabel,
                    this._txId,
                    this._txHistoryItemId,
                    this._txHistoryTarget,
                    this._txPromptGroupId,
                    this._txHistorySummary
                );
            }
            this._txBufferedOperations = [];
            this._txLabel = null;
            this._txId = null;
            this._txStartTimeMs = null;
            this._txHistoryItemId = null;
            this._txPromptGroupId = null;
            this._txHistorySummary = null;
            this._txHistoryTarget = null;
            this._txStartStateVector = null;
        }
        return commitResult;
    }

    /** Whether a transaction is currently open. */
    get inTransaction(): boolean {
        return this._txDepth > 0;
    }

    setRecordingSuppressed(suppressed: boolean): void {
        this._recordingSuppressionDepth = suppressed ? 1 : 0;
        this._suppressRecording = suppressed;
    }

    /**
     * Suppress model recording until the returned release function is called.
     * Each release is idempotent so overlapping lifecycle cleanup is safe.
     */
    beginRecordingSuppression(): () => void {
        this._recordingSuppressionDepth += 1;
        this._suppressRecording = true;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this._recordingSuppressionDepth = Math.max(
                0,
                this._recordingSuppressionDepth - 1
            );
            this._suppressRecording = this._recordingSuppressionDepth > 0;
        };
    }

    runWithoutRecording<T>(fn: () => T): T {
        const wasSuppressed = this._suppressRecording;
        this._suppressRecording = true;
        try {
            return fn();
        } finally {
            this._suppressRecording = wasSuppressed;
        }
    }

    // ── Bulk sync (after drag / external mutation) ───────────────

    /**
     * Sync a glyph's current JSON data into the Y.Doc.
     *
     * Call this after operations that mutate `babelfontData` directly
     * (e.g. outline-editor drag) instead of going through model setters.
     * Updates the existing Y.Map in-place so per-glyph UndoManagers
     * keep their scope reference.
     */
    syncGlyphFromJson(
        glyphName: string,
        label: string,
        oldValue?: string,
        newValue?: string,
        layerId?: string | null,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null,
        previousGlyphSnapshot?: Record<string, unknown>
    ): void {
        this.syncGlyphsFromJson(
            [glyphName],
            label,
            oldValue,
            newValue,
            layerId,
            visualAnchorSide,
            workerReplayTargets,
            editSource,
            compileChangeSource,
            compileEditType,
            previousGlyphSnapshot
                ? { [glyphName]: previousGlyphSnapshot }
                : undefined
        );
    }

    /**
     * Sync multiple changed layers into Y.Doc in one transaction.
     * Each target stays on the layer fast path so linked windows only
     * receive the minimum changed layer snapshots.
     */
    syncLayersFromJson(
        layerTargets: WorkerReplayTarget[],
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing) {
            return;
        }

        assertCloudAssetMutable();

        const uniqueTargets = normalizeWorkerReplayTargets(layerTargets);
        if (!uniqueTargets.length) {
            return;
        }

        if (uniqueTargets.length === 1) {
            const [target] = uniqueTargets;
            this._trySyncSingleLayer(
                target.glyphName,
                target.layerId,
                label,
                oldValue,
                newValue,
                visualAnchorSide,
                workerReplayTargets,
                editSource,
                compileChangeSource,
                compileEditType,
                true
            );
            return;
        }

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) {
            return;
        }

        const operations: TransactionBufferedOperation[] = [];

        for (const { glyphName, layerId } of uniqueTargets) {
            const glyphJson = glyphs.find(
                (g: Record<string, unknown>) => g.name === glyphName
            ) as Record<string, unknown> | undefined;
            if (!glyphJson) {
                continue;
            }

            const glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap) {
                continue;
            }

            const layersMap = glyphMap.get('layers') as
                Y.Map<unknown> | undefined;
            if (!layersMap) {
                continue;
            }

            const glyphLayers = (glyphJson.layers ?? []) as Array<
                Record<string, unknown>
            >;
            const layerJson = glyphLayers.find(
                (layer: Record<string, unknown>) => layer.id === layerId
            );
            if (!layerJson) {
                continue;
            }
            const storageLayerJson = this._prepareLayerSnapshotForHistory(
                layerId,
                layerJson,
                layersMap.get(layerId)
                    ? fromYType(layersMap.get(layerId) as Y.Map<unknown>)
                    : null
            );
            operations.push(
                ...this._buildLayerSyncOperations(
                    glyphName,
                    layerId,
                    layersMap,
                    storageLayerJson,
                    label,
                    oldValue,
                    newValue,
                    {
                        editSource: editSource ?? compileChangeSource ?? null,
                        compileChangeSource,
                        compileEditType,
                        visualAnchorSide,
                        workerReplayTargets,
                        preserveOmittedFields: true
                    }
                )
            );
        }

        if (!operations.length) {
            return;
        }

        this._queueOrCommitOperations(operations, label);

        console.log(
            `Layer sync committed for ${uniqueTargets
                .map((target) => `${target.glyphName}/${target.layerId}`)
                .join(', ')} (${label}) [batched fast path]`
        );
    }

    /**
     * Sync explicit changed-layer snapshots into Y.Doc in one transaction.
     * Use this when the caller already has committed next-layer JSON and the
     * bridge's shared `_fontJson` reference may alias mutable editor storage.
     */
    syncLayerSnapshotsFromJson(
        layerTargets: LayerSnapshotSyncTarget[],
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): void {
        if (this._suppressRecording || this._isSyncing) {
            return;
        }
        assertCloudAssetMutable();

        const uniqueTargets: LayerSnapshotSyncTarget[] = [];
        const seenTargets = new Set<string>();
        for (const target of layerTargets) {
            if (!target.glyphName || !target.layerId || !target.layerJson) {
                continue;
            }
            const key = `${target.glyphName}@@${target.layerId}`;
            if (seenTargets.has(key)) {
                continue;
            }
            seenTargets.add(key);
            uniqueTargets.push(target);
        }

        if (!uniqueTargets.length) {
            return;
        }

        const operations: TransactionBufferedOperation[] = [];
        for (const {
            glyphName,
            layerId,
            layerJson,
            authoritativeOptionalLayerFields
        } of uniqueTargets) {
            const glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap) {
                continue;
            }

            const layersMap = glyphMap.get('layers') as
                Y.Map<unknown> | undefined;
            if (!layersMap) {
                continue;
            }

            const yLayerMap = layersMap.get(layerId);
            const yLayerJson = yLayerMap ? fromYType(yLayerMap) : null;
            const storageLayerJson = this._prepareLayerSnapshotForHistory(
                layerId,
                layerJson,
                yLayerJson
            );
            if (authoritativeOptionalLayerFields !== undefined) {
                if (
                    yLayerJson &&
                    typeof yLayerJson === 'object' &&
                    !Array.isArray(yLayerJson)
                ) {
                    const existingLayer = yLayerJson as Record<string, unknown>;
                    const authoritativeFields = new Set(
                        authoritativeOptionalLayerFields
                    );
                    for (const key of [
                        'anchors',
                        'guides',
                        'format_specific'
                    ] as OptionalLayerField[]) {
                        if (authoritativeFields.has(key)) {
                            continue;
                        }
                        if (
                            Object.prototype.hasOwnProperty.call(
                                existingLayer,
                                key
                            )
                        ) {
                            storageLayerJson[key] = cloneHistoryValue(
                                existingLayer[key]
                            );
                        } else {
                            delete storageLayerJson[key];
                        }
                    }
                }
            }
            operations.push(
                ...this._buildLayerSyncOperations(
                    glyphName,
                    layerId,
                    layersMap,
                    storageLayerJson,
                    label,
                    oldValue,
                    newValue,
                    {
                        editSource: editSource ?? compileChangeSource ?? null,
                        compileChangeSource,
                        compileEditType,
                        visualAnchorSide,
                        workerReplayTargets
                    }
                )
            );
        }

        if (!operations.length) {
            this._emitMetadataOnlyLayerSnapshotUpdate(
                uniqueTargets,
                label,
                oldValue,
                newValue,
                visualAnchorSide,
                workerReplayTargets,
                editSource,
                compileChangeSource,
                compileEditType
            );
            return;
        }

        const wasInTransaction = this._txDepth > 0;
        const commitResult = this._queueOrCommitOperations(operations, label);
        // Only reload layers that this packet actually wrote into Yjs.
        // workerReplayTargets are intentionally wider (invalidate-only
        // dependents for compile/cache). Reloading those from Yjs would
        // clobber live-already-recomposed model state with stale document
        // data when those dependents were not part of the mutation set.
        if (!wasInTransaction && operations.length) {
            const writtenLayerTargets = normalizeWorkerReplayTargets(
                operations.map((operation) => {
                    const applyPath = operation.applyPath ?? operation.path;
                    return {
                        glyphName: deriveGlyphName(applyPath) || '',
                        layerId: deriveLayerId(applyPath) || ''
                    };
                })
            );
            if (writtenLayerTargets.length) {
                this._syncPatchedLayerTargetsFromYDoc(writtenLayerTargets);
            }
        }
        if (!wasInTransaction && !commitResult) {
            this._emitMetadataOnlyLayerSnapshotUpdate(
                uniqueTargets,
                label,
                oldValue,
                newValue,
                visualAnchorSide,
                workerReplayTargets,
                editSource,
                compileChangeSource,
                compileEditType
            );
            return;
        }

        console.log(
            `Layer snapshot sync committed for ${uniqueTargets
                .map((target) => `${target.glyphName}/${target.layerId}`)
                .join(', ')} (${label}) [batched fast path]`
        );
    }

    private _emitMetadataOnlyLayerSnapshotUpdate(
        uniqueTargets: LayerSnapshotSyncTarget[],
        label: string,
        oldValue: string | undefined,
        newValue: string | undefined,
        visualAnchorSide: 'left' | 'right' | null | undefined,
        workerReplayTargets: WorkerReplayTarget[] | undefined,
        editSource: string | null | undefined,
        compileChangeSource: string | null | undefined,
        compileEditType: string | null | undefined
    ): void {
        const normalizedReplayTargets =
            normalizeWorkerReplayTargets(workerReplayTargets);
        if (!normalizedReplayTargets.length) {
            return;
        }

        const update = Y.encodeStateAsUpdate(
            this.yDoc,
            Y.encodeStateVector(this.yDoc)
        );
        const timestamp = Date.now();
        const historyItemId = this._createHistoryItemId();
        const changeLogEntries = uniqueTargets.map((target) =>
            createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId,
                historyAction: 'change',
                transactionLabel: label,
                transactionId: null,
                op: 'set',
                path: `glyphs.${target.glyphName}:layers.${target.layerId}`,
                oldValue: oldValue ?? target.glyphName,
                newValue: newValue ?? label,
                replayOldValue: undefined,
                replayNewValue: undefined,
                editSource: editSource ?? compileChangeSource ?? null,
                compileChangeSource: compileChangeSource ?? null,
                compileEditType: compileEditType ?? null,
                visualAnchorSide: visualAnchorSide ?? null,
                workerReplayTargets: normalizedReplayTargets
            })
        );
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
        this._emitLocalUpdate(update, changeLogEntries);
    }

    private _buildLayerSyncOperations(
        glyphName: string,
        layerId: string,
        layersMap: Y.Map<unknown>,
        storageLayerJson: Record<string, unknown>,
        label: string,
        oldValue: string | undefined,
        newValue: string | undefined,
        metadata: LayerSyncMetadata
    ): TransactionBufferedOperation[] {
        const yLayerMap = layersMap.get(layerId);
        const yLayerJson = yLayerMap ? fromYType(yLayerMap) : null;
        if (!yLayerJson) {
            return [
                {
                    op: 'set' as ChangeOp,
                    path: ['glyphs', glyphName, 'layers', layerId],
                    oldValue: null,
                    newValue: cloneHistoryValue(storageLayerJson),
                    editSource: metadata.editSource,
                    compileChangeSource: metadata.compileChangeSource,
                    compileEditType: metadata.compileEditType,
                    visualAnchorSide: metadata.visualAnchorSide,
                    workerReplayTargets: metadata.workerReplayTargets,
                    originatingGlyphName: glyphName,
                    originatingLayerId: layerId,
                    applyPath: ['glyphs', glyphName, 'layers', layerId],
                    applyNewValue: storageLayerJson,
                    applyMode: 'layer-snapshot' as BatchApplyMode
                }
            ];
        }

        const previousLayer = yLayerJson as Record<string, unknown>;
        if (
            !Object.prototype.hasOwnProperty.call(storageLayerJson, 'name') &&
            Object.prototype.hasOwnProperty.call(previousLayer, 'name')
        ) {
            storageLayerJson.name = cloneHistoryValue(previousLayer.name);
        }
        if (
            this._shouldUseGranularSingleLayerSync(
                glyphName,
                layerId,
                previousLayer,
                storageLayerJson
            )
        ) {
            this._adoptIndexedLayerIds(previousLayer, storageLayerJson);
            return this._buildGranularLayerSyncOperations(
                glyphName,
                layerId,
                previousLayer,
                storageLayerJson,
                metadata
            );
        }

        const sparseLayerDelta = this._buildSparseLayerDelta(
            previousLayer,
            storageLayerJson,
            layerId
        );
        if (!sparseLayerDelta) {
            return [];
        }

        return [
            {
                op: 'set' as ChangeOp,
                path: ['glyphs', glyphName, 'layers', layerId],
                oldValue: oldValue ?? glyphName,
                newValue: newValue ?? label,
                editSource: metadata.editSource,
                compileChangeSource: metadata.compileChangeSource,
                compileEditType: metadata.compileEditType,
                visualAnchorSide: metadata.visualAnchorSide,
                workerReplayTargets: metadata.workerReplayTargets,
                originatingGlyphName: glyphName,
                originatingLayerId: layerId,
                applyPath: ['glyphs', glyphName, 'layers', layerId],
                applyOldValue: sparseLayerDelta.oldValues,
                applyNewValue: sparseLayerDelta.delta,
                applyMode: 'layer-snapshot' as BatchApplyMode
            }
        ];
    }

    private _buildGranularLayerSyncOperations(
        glyphName: string,
        layerId: string,
        previousLayer: Record<string, unknown>,
        nextLayer: Record<string, unknown>,
        metadata: LayerSyncMetadata
    ): TransactionBufferedOperation[] {
        const basePath: (string | number)[] = [
            'glyphs',
            glyphName,
            'layers',
            layerId
        ];
        return this._buildGranularValueSyncOperations(
            basePath,
            previousLayer,
            nextLayer,
            metadata
        );
    }

    private _buildGranularValueSyncOperations(
        path: (string | number)[],
        previousValue: unknown,
        nextValue: unknown,
        metadata: LayerSyncMetadata
    ): TransactionBufferedOperation[] {
        if (this._isDeepEqual(previousValue, nextValue)) {
            return [];
        }

        const lastSegment = path[path.length - 1];
        if (
            typeof lastSegment === 'string' &&
            GRANULAR_LAYER_ARRAY_KEYS.has(lastSegment) &&
            Array.isArray(previousValue) &&
            Array.isArray(nextValue)
        ) {
            return this._buildGranularIndexedArraySyncOperations(
                path,
                lastSegment,
                previousValue,
                nextValue,
                metadata
            );
        }

        // Paths have no persisted IDs, so numeric child paths cannot safely
        // replay a contour insertion, deletion, or structural replacement.
        // Keep coordinate-only node edits granular.
        if (
            lastSegment === 'shapes' &&
            Array.isArray(previousValue) &&
            Array.isArray(nextValue) &&
            this._haveShapeStructuresChanged(previousValue, nextValue)
        ) {
            return [
                this._createGranularLayerOperation(
                    'set',
                    path,
                    previousValue,
                    nextValue,
                    metadata
                )
            ];
        }

        if (
            previousValue &&
            nextValue &&
            typeof previousValue === 'object' &&
            typeof nextValue === 'object' &&
            !Array.isArray(previousValue) &&
            !Array.isArray(nextValue)
        ) {
            const previousRecord = previousValue as Record<string, unknown>;
            const nextRecord = nextValue as Record<string, unknown>;
            const keys = new Set([
                ...Object.keys(previousRecord),
                ...Object.keys(nextRecord)
            ]);
            const operations: TransactionBufferedOperation[] = [];
            for (const key of keys) {
                if (key === 'id') {
                    continue;
                }
                if (
                    metadata.preserveOmittedFields &&
                    !Object.prototype.hasOwnProperty.call(nextRecord, key)
                ) {
                    continue;
                }
                operations.push(
                    ...this._buildGranularValueSyncOperations(
                        [...path, key],
                        previousRecord[key],
                        nextRecord[key],
                        metadata
                    )
                );
            }
            return operations;
        }

        if (Array.isArray(previousValue) && Array.isArray(nextValue)) {
            // Unkeyed arrays have no stable member identity. A cardinality
            // change shifts numeric paths, so replay it as one array value.
            if (previousValue.length !== nextValue.length) {
                return [
                    this._createGranularLayerOperation(
                        'set',
                        path,
                        previousValue,
                        nextValue,
                        metadata
                    )
                ];
            }

            const operations: TransactionBufferedOperation[] = [];
            const maxLength = Math.max(previousValue.length, nextValue.length);
            for (let index = 0; index < maxLength; index++) {
                operations.push(
                    ...this._buildGranularValueSyncOperations(
                        [...path, index],
                        previousValue[index],
                        nextValue[index],
                        metadata
                    )
                );
            }
            return operations;
        }

        if (previousValue === undefined) {
            return [
                this._createGranularLayerOperation(
                    'add',
                    path,
                    undefined,
                    nextValue,
                    metadata
                )
            ];
        }
        if (nextValue === undefined) {
            return [
                this._createGranularLayerOperation(
                    'remove',
                    path,
                    previousValue,
                    undefined,
                    metadata
                )
            ];
        }
        return [
            this._createGranularLayerOperation(
                'set',
                path,
                previousValue,
                nextValue,
                metadata
            )
        ];
    }

    private _haveShapeStructuresChanged(
        previousShapes: unknown[],
        nextShapes: unknown[]
    ): boolean {
        if (previousShapes.length !== nextShapes.length) {
            return true;
        }

        const shapeSignature = (shape: unknown): string => {
            if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
                return typeof shape;
            }

            const record = shape as Record<string, unknown>;
            if (Array.isArray(record.nodes)) {
                const booleanFlag = pathHasSubtractionFlag(
                    record.format_specific as
                        | Record<string, ReturnType<typeof JSON.parse>>
                        | undefined
                )
                    ? ':subtraction'
                    : '';
                return `path:${record.nodes.length}:${String(record.closed)}${booleanFlag}`;
            }
            if (typeof record.reference === 'string') {
                return 'component';
            }
            return 'shape';
        };

        return previousShapes.some(
            (shape, index) =>
                shapeSignature(shape) !== shapeSignature(nextShapes[index])
        );
    }

    private _buildGranularIndexedArraySyncOperations(
        path: (string | number)[],
        arrayKey: string,
        previousArray: unknown[],
        nextArray: unknown[],
        metadata: LayerSyncMetadata
    ): TransactionBufferedOperation[] {
        const previousById = this._mapArrayItemsById(previousArray);
        const nextById = this._mapArrayItemsById(nextArray);
        if (!previousById || !nextById) {
            return [
                this._createGranularLayerOperation(
                    'set',
                    path,
                    previousArray,
                    nextArray,
                    metadata
                )
            ];
        }

        const operations: TransactionBufferedOperation[] = [];
        const previousIds = previousArray.map((item) =>
            String((item as Record<string, unknown>).id)
        );
        const nextIds = nextArray.map((item) =>
            String((item as Record<string, unknown>).id)
        );

        // Indexed positions are not stable when membership or order changes.
        // Replace the collection as one ordered Yjs value so undo and redo
        // restore the same IDs and order rather than replaying shifted indices.
        if (!this._isDeepEqual(previousIds, nextIds)) {
            return [
                this._createGranularLayerOperation(
                    'set',
                    path,
                    previousArray,
                    nextArray,
                    metadata
                )
            ];
        }

        nextIds.forEach((id, nextIndex) => {
            const nextItem = nextById.get(id);
            const previousIndex = previousIds.indexOf(id);
            operations.push(
                ...this._buildGranularValueSyncOperations(
                    [...path, previousIndex],
                    previousById.get(id),
                    nextItem,
                    metadata
                )
            );
        });

        return operations;
    }

    private _createGranularLayerOperation(
        op: ChangeOp,
        path: (string | number)[],
        oldValue: unknown,
        newValue: unknown,
        metadata: LayerSyncMetadata
    ): TransactionBufferedOperation {
        const originatingGlyphName =
            path[0] === 'glyphs' && typeof path[1] === 'string'
                ? path[1]
                : null;
        const originatingLayerId =
            path[2] === 'layers' && typeof path[3] === 'string'
                ? path[3]
                : null;
        return {
            op,
            path,
            oldValue: cloneHistoryValue(oldValue),
            newValue: cloneHistoryValue(newValue),
            editSource: metadata.editSource ?? null,
            compileChangeSource: metadata.compileChangeSource ?? null,
            compileEditType: metadata.compileEditType ?? null,
            visualAnchorSide: metadata.visualAnchorSide ?? null,
            workerReplayTargets: metadata.workerReplayTargets,
            originatingGlyphName,
            originatingLayerId
        };
    }

    private _mapArrayItemsById(
        items: unknown[]
    ): Map<string, Record<string, unknown>> | null {
        const map = new Map<string, Record<string, unknown>>();
        for (const item of items) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return null;
            }
            const id = (item as Record<string, unknown>).id;
            if (typeof id !== 'string' || !id) {
                return null;
            }
            map.set(id, item as Record<string, unknown>);
        }
        return map;
    }

    private _adoptIndexedLayerIds(
        previousLayer: Record<string, unknown>,
        nextLayer: Record<string, unknown>,
        replaceExistingIds = false
    ): void {
        this._adoptIndexedArrayIds(
            previousLayer.anchors,
            nextLayer.anchors,
            replaceExistingIds
        );
        this._adoptIndexedArrayIds(
            previousLayer.anchors,
            nextLayer.anchors,
            replaceExistingIds
        );
        this._adoptIndexedArrayIds(
            previousLayer.guides,
            nextLayer.guides,
            replaceExistingIds
        );
    }

    private _alignReloadShapeIdentities(
        previousShapes: unknown,
        nextShapes: unknown
    ): void {
        if (!Array.isArray(previousShapes) || !Array.isArray(nextShapes)) {
            return;
        }
        if (previousShapes.length !== nextShapes.length) {
            this._adoptIndexedArrayIds(previousShapes, nextShapes, true);
            return;
        }
        for (let index = 0; index < nextShapes.length; index += 1) {
            const previousShape = previousShapes[index];
            const nextShape = nextShapes[index];
            if (
                !previousShape ||
                typeof previousShape !== 'object' ||
                Array.isArray(previousShape) ||
                !nextShape ||
                typeof nextShape !== 'object' ||
                Array.isArray(nextShape)
            ) {
                continue;
            }
            const previousId = (previousShape as Record<string, unknown>).id;
            if (typeof previousId === 'string' && previousId) {
                (nextShape as Record<string, unknown>).id = previousId;
            } else {
                delete (nextShape as Record<string, unknown>).id;
            }
        }
    }

    private _stampLiveShapeIdsOnReloadSnapshots(
        liveSnapshot: unknown,
        previousSnapshot: unknown,
        nextSnapshot: unknown
    ): void {
        const liveGlyphs = this._coerceFontGlyphSnapshots(
            (liveSnapshot as Record<string, unknown> | null)?.glyphs
        );
        const previousGlyphs = this._coerceFontGlyphSnapshots(
            (previousSnapshot as Record<string, unknown> | null)?.glyphs
        );
        const nextGlyphs = this._coerceFontGlyphSnapshots(
            (nextSnapshot as Record<string, unknown> | null)?.glyphs
        );
        const liveByName = new Map(
            liveGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );
        const previousByName = new Map(
            previousGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );
        for (const nextGlyph of nextGlyphs) {
            const name = String(nextGlyph.name || '');
            const liveGlyph = liveByName.get(name);
            const previousGlyph = previousByName.get(name);
            if (!liveGlyph && !previousGlyph) {
                continue;
            }
            const liveLayers = new Map(
                this._coerceGlyphLayerSnapshots(liveGlyph?.layers).map(
                    (layer) => [String(layer.id || ''), layer]
                )
            );
            const previousLayers = new Map(
                this._coerceGlyphLayerSnapshots(previousGlyph?.layers).map(
                    (layer) => [String(layer.id || ''), layer]
                )
            );
            for (const nextLayer of this._coerceGlyphLayerSnapshots(
                nextGlyph.layers
            )) {
                const layerId = String(nextLayer.id || '');
                const identityShapes =
                    liveLayers.get(layerId)?.shapes ??
                    previousLayers.get(layerId)?.shapes;
                this._alignReloadShapeIdentities(
                    identityShapes,
                    nextLayer.shapes
                );
                this._alignReloadShapeIdentities(
                    identityShapes,
                    previousLayers.get(layerId)?.shapes
                );
            }
        }
    }

    private _adoptIndexedFontLayerIds(
        previousSnapshot: unknown,
        nextSnapshot: unknown
    ): void {
        const asRecords = (value: unknown): Array<Record<string, unknown>> =>
            Array.isArray(value)
                ? value.filter(
                      (item): item is Record<string, unknown> =>
                          !!item &&
                          typeof item === 'object' &&
                          !Array.isArray(item)
                  )
                : [];
        const previousMasters = asRecords(
            (previousSnapshot as Record<string, unknown>)?.masters
        );
        const nextMasters = asRecords(
            (nextSnapshot as Record<string, unknown>)?.masters
        );
        const previousMastersById = new Map(
            previousMasters.map((master) => [String(master.id || ''), master])
        );

        for (const nextMaster of nextMasters) {
            const previousMaster = previousMastersById.get(
                String(nextMaster.id || '')
            );
            if (previousMaster) {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        previousMaster,
                        'kerning_rtl'
                    ) &&
                    nextMaster.kerning_rtl &&
                    typeof nextMaster.kerning_rtl === 'object' &&
                    !Array.isArray(nextMaster.kerning_rtl) &&
                    Object.keys(nextMaster.kerning_rtl).length === 0
                ) {
                    delete nextMaster.kerning_rtl;
                }
                this._adoptIndexedArrayIds(
                    previousMaster.guides,
                    nextMaster.guides,
                    true
                );
            }
        }

        const previousGlyphs = this._coerceFontGlyphSnapshots(
            (previousSnapshot as Record<string, unknown>)?.glyphs
        );
        const nextGlyphs = this._coerceFontGlyphSnapshots(
            (nextSnapshot as Record<string, unknown>)?.glyphs
        );
        const previousGlyphsByName = new Map(
            previousGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );

        for (const nextGlyph of nextGlyphs) {
            const previousGlyph = previousGlyphsByName.get(
                String(nextGlyph.name || '')
            );
            if (!previousGlyph) {
                continue;
            }

            const previousLayersById = new Map(
                this._coerceGlyphLayerSnapshots(previousGlyph.layers).map(
                    (layer) => [String(layer.id || ''), layer]
                )
            );
            for (const nextLayer of this._coerceGlyphLayerSnapshots(
                nextGlyph.layers
            )) {
                const previousLayer = previousLayersById.get(
                    String(nextLayer.id || '')
                );
                if (previousLayer) {
                    this._adoptIndexedLayerIds(previousLayer, nextLayer, true);
                    this._alignReloadShapeIdentities(
                        previousLayer.shapes,
                        nextLayer.shapes
                    );
                }
            }
        }
    }

    private _adoptGlyphIds(
        previousSnapshot: unknown,
        nextSnapshot: unknown
    ): void {
        const previousGlyphs = this._coerceFontGlyphSnapshots(
            (previousSnapshot as Record<string, unknown>)?.glyphs
        );
        const nextGlyphs = this._coerceFontGlyphSnapshots(
            (nextSnapshot as Record<string, unknown>)?.glyphs
        );
        const previousByName = new Map(
            previousGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );
        const usedIds = new Set(
            previousGlyphs
                .map((glyph) => (typeof glyph.id === 'string' ? glyph.id : ''))
                .filter((id) => id.length > 0)
        );

        for (const nextGlyph of nextGlyphs) {
            const previousGlyph = previousByName.get(
                String(nextGlyph.name || '')
            );
            if (previousGlyph && typeof previousGlyph.id === 'string') {
                nextGlyph.id = previousGlyph.id;
                usedIds.add(previousGlyph.id);
                continue;
            }
            const incomingId =
                typeof nextGlyph.id === 'string' ? nextGlyph.id : '';
            if (!incomingId || usedIds.has(incomingId)) {
                delete nextGlyph.id;
                usedIds.add(ensureImmutableGlyphId(nextGlyph));
                continue;
            }
            usedIds.add(incomingId);
        }
    }

    private _preserveLiveCoreKeysAbsentFromSource(
        incomingSnapshot: unknown,
        previousSnapshot: unknown,
        nextSnapshot: unknown
    ): void {
        const incoming =
            incomingSnapshot &&
            typeof incomingSnapshot === 'object' &&
            !Array.isArray(incomingSnapshot)
                ? (incomingSnapshot as Record<string, unknown>)
                : null;
        const previous =
            previousSnapshot &&
            typeof previousSnapshot === 'object' &&
            !Array.isArray(previousSnapshot)
                ? (previousSnapshot as Record<string, unknown>)
                : null;
        const next =
            nextSnapshot &&
            typeof nextSnapshot === 'object' &&
            !Array.isArray(nextSnapshot)
                ? (nextSnapshot as Record<string, unknown>)
                : null;
        if (!previous || !next) {
            return;
        }
        for (const key of [CORE_GLYPH_CATALOG_KEY, CORE_CODEPOINT_INDEX_KEY]) {
            if (
                incoming &&
                Object.prototype.hasOwnProperty.call(incoming, key)
            ) {
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(previous, key)) {
                next[key] = previous[key];
            } else {
                delete next[key];
            }
        }
    }

    private _omitLiveOnlyModelKeys(
        nextSnapshot: unknown,
        previousSnapshot: unknown,
        liveSnapshot: unknown
    ): void {
        const omitFromRecord = (
            nextRecord: Record<string, unknown>,
            previousRecord: Record<string, unknown> | null,
            liveRecord: Record<string, unknown> | null
        ): void => {
            if (!liveRecord) {
                return;
            }
            for (const key of Object.keys(nextRecord)) {
                const previousHasKey =
                    !!previousRecord &&
                    Object.prototype.hasOwnProperty.call(previousRecord, key);
                const liveHasKey = Object.prototype.hasOwnProperty.call(
                    liveRecord,
                    key
                );
                if (!previousHasKey && liveHasKey) {
                    delete nextRecord[key];
                    continue;
                }
                const nextValue = nextRecord[key];
                if (
                    nextValue &&
                    typeof nextValue === 'object' &&
                    !Array.isArray(nextValue)
                ) {
                    omitFromRecord(
                        nextValue as Record<string, unknown>,
                        previousRecord?.[key] &&
                            typeof previousRecord[key] === 'object' &&
                            !Array.isArray(previousRecord[key])
                            ? (previousRecord[key] as Record<string, unknown>)
                            : null,
                        liveRecord[key] &&
                            typeof liveRecord[key] === 'object' &&
                            !Array.isArray(liveRecord[key])
                            ? (liveRecord[key] as Record<string, unknown>)
                            : null
                    );
                }
            }
        };

        const nextFont = nextSnapshot as Record<string, unknown> | null;
        const previousFont = previousSnapshot as Record<string, unknown> | null;
        const liveFont = liveSnapshot as Record<string, unknown> | null;
        if (!nextFont || !previousFont || !liveFont) {
            return;
        }

        const nextGlyphs = this._coerceFontGlyphSnapshots(nextFont.glyphs);
        const previousGlyphs = this._coerceFontGlyphSnapshots(
            previousFont.glyphs
        );
        const liveGlyphs = this._coerceFontGlyphSnapshots(liveFont.glyphs);
        const previousByName = new Map(
            previousGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );
        const liveByName = new Map(
            liveGlyphs.map((glyph) => [String(glyph.name || ''), glyph])
        );

        for (const nextGlyph of nextGlyphs) {
            const name = String(nextGlyph.name || '');
            omitFromRecord(
                nextGlyph,
                previousByName.get(name) ?? null,
                liveByName.get(name) ?? null
            );
            const nextLayers = this._coerceGlyphLayerSnapshots(
                nextGlyph.layers
            );
            const previousLayers = this._coerceGlyphLayerSnapshots(
                previousByName.get(name)?.layers
            );
            const liveLayers = this._coerceGlyphLayerSnapshots(
                liveByName.get(name)?.layers
            );
            const previousLayersById = new Map(
                previousLayers.map((layer) => [String(layer.id || ''), layer])
            );
            const liveLayersById = new Map(
                liveLayers.map((layer) => [String(layer.id || ''), layer])
            );
            for (const nextLayer of nextLayers) {
                omitFromRecord(
                    nextLayer,
                    previousLayersById.get(String(nextLayer.id || '')) ?? null,
                    liveLayersById.get(String(nextLayer.id || '')) ?? null
                );
            }
        }
    }

    private _adoptIndexedArrayIds(
        previousValue: unknown,
        nextValue: unknown,
        replaceExistingIds = false
    ): void {
        if (!Array.isArray(previousValue) || !Array.isArray(nextValue)) {
            return;
        }
        nextValue.forEach((nextItem, index) => {
            const previousItem = previousValue[index];
            if (
                !nextItem ||
                typeof nextItem !== 'object' ||
                Array.isArray(nextItem) ||
                !previousItem ||
                typeof previousItem !== 'object' ||
                Array.isArray(previousItem)
            ) {
                return;
            }
            const nextRecord = nextItem as Record<string, unknown>;
            const previousRecord = previousItem as Record<string, unknown>;
            if (
                (replaceExistingIds || !nextRecord.id) &&
                typeof previousRecord.id === 'string'
            ) {
                nextRecord.id = previousRecord.id;
            }
        });
    }

    private _isCompleteLayerSnapshot(
        nextLayer: Record<string, unknown>
    ): boolean {
        return (
            Object.prototype.hasOwnProperty.call(nextLayer, 'width') &&
            Object.prototype.hasOwnProperty.call(nextLayer, 'master') &&
            Object.prototype.hasOwnProperty.call(nextLayer, 'shapes')
        );
    }

    private _shouldUseGranularSingleLayerSync(
        glyphName: string,
        layerId: string,
        previousLayer: Record<string, unknown>,
        nextLayer: Record<string, unknown>
    ): boolean {
        if (this._hasBufferedLayerRootOperation(glyphName, layerId)) {
            return false;
        }

        // Partial layer fragments must stay on the sparse layer-delta path so
        // omitted fields remain untouched. Granular sync is only safe for
        // complete layer snapshots that carry the layer's core fields.
        if (!this._isCompleteLayerSnapshot(nextLayer)) {
            return false;
        }

        return true;
    }

    private _hasBufferedLayerRootOperation(
        glyphName: string,
        layerId: string
    ): boolean {
        return this._txBufferedOperations.some((operation) => {
            if (operation.path.length !== 4) {
                return false;
            }

            return (
                operation.path[0] === 'glyphs' &&
                operation.path[1] === glyphName &&
                operation.path[2] === 'layers' &&
                operation.path[3] === layerId
            );
        });
    }

    private _buildSparseLayerDelta(
        previousLayer: Record<string, unknown> | null,
        nextLayer: Record<string, unknown>,
        layerId: string
    ): {
        delta: Record<string, unknown>;
        oldValues: Record<string, unknown>;
    } | null {
        const delta: Record<string, unknown> = { id: layerId };
        const oldValues: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(nextLayer)) {
            const oldValue = previousLayer?.[key];
            if (this._isDeepEqual(value, oldValue)) {
                continue;
            }

            delta[key] = value;
            if (oldValue !== undefined) {
                oldValues[key] = oldValue;
            }
        }

        if (Object.keys(delta).length <= 1) {
            return null;
        }

        return { delta, oldValues };
    }

    /**
     * Sync multiple glyph JSON payloads into Y.Doc in one transaction.
     * This keeps paired root/component edits aligned as a single undo step.
     */
    syncGlyphsFromJson(
        glyphNames: string[],
        label: string,
        oldValue?: string,
        newValue?: string,
        layerId?: string | null,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null,
        previousGlyphSnapshots?: Record<string, Record<string, unknown>>
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing)
            return;

        assertCloudAssetMutable();

        const uniqueGlyphNames = Array.from(
            new Set(glyphNames.filter((name) => typeof name === 'string'))
        );
        if (!uniqueGlyphNames.length) {
            return;
        }

        // Fast path: single glyph + known layer → compare and sync only
        // the affected layer, avoiding full-glyph JSON reconstruction,
        // deep-equality checks, and cloning.
        if (uniqueGlyphNames.length === 1 && layerId) {
            if (
                this._trySyncSingleLayer(
                    uniqueGlyphNames[0],
                    layerId,
                    label,
                    oldValue!,
                    newValue!,
                    visualAnchorSide,
                    workerReplayTargets,
                    editSource,
                    compileChangeSource,
                    compileEditType
                )
            ) {
                return;
            }
        }

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return;

        const targets: Array<{
            glyphName: string;
            previousGlyphJson: Record<string, unknown>;
            glyphJson: Record<string, unknown>;
        }> = [];

        for (const glyphName of uniqueGlyphNames) {
            const glyphJson = glyphs.find(
                (g: Record<string, unknown>) => g.name === glyphName
            ) as Record<string, unknown> | undefined;
            if (!glyphJson) {
                continue;
            }

            const glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap) {
                continue;
            }

            const yGlyphJson = this._readNormalizedGlyphSnapshotFromYDoc(
                glyphName,
                glyphJson
            );
            if (!yGlyphJson) {
                continue;
            }
            const storageGlyphJson = this._prepareStorageValue(
                glyphJson
            ) as Record<string, unknown>;
            if (this._isDeepEqual(yGlyphJson, storageGlyphJson)) {
                continue;
            }

            const previousGlyphJson = previousGlyphSnapshots?.[glyphName]
                ? cloneHistoryValue(previousGlyphSnapshots[glyphName])
                : cloneHistoryValue(yGlyphJson);

            targets.push({
                glyphName,
                previousGlyphJson,
                glyphJson: storageGlyphJson
            });
        }

        if (!targets.length) {
            return;
        }

        const undoScope = this._deriveBulkUndoScope(targets, layerId ?? null);
        this._queueOrCommitOperations(
            targets.map((target) => {
                const glyphLayers = (target.glyphJson.layers ?? []) as Array<
                    Record<string, unknown>
                >;
                const previousGlyphLayers = Array.isArray(
                    target.previousGlyphJson.layers
                )
                    ? (target.previousGlyphJson.layers as Array<
                          Record<string, unknown>
                      >)
                    : [];
                const glyphSnapshot = this._normalizeGlyphSnapshot(
                    target.glyphJson,
                    target.previousGlyphJson
                );
                const previousGlyphSnapshot = this._normalizeGlyphSnapshot(
                    target.previousGlyphJson
                );
                const layerSnapshot = layerId
                    ? this._normalizeLayerSnapshot(
                          layerId,
                          glyphLayers.find(
                              (layer: Record<string, unknown>) =>
                                  layer.id === layerId
                          ),
                          previousGlyphLayers.find(
                              (layer: Record<string, unknown>) =>
                                  layer.id === layerId
                          )
                      )
                    : undefined;
                const previousLayerSnapshot = layerId
                    ? previousGlyphLayers.find(
                          (layer: Record<string, unknown>) =>
                              layer.id === layerId
                      )
                    : undefined;
                const isLayerScope = undoScope === 'layer' && layerId;
                const originatingLayerId =
                    layerId ??
                    (Array.isArray(target.glyphJson.layers)
                        ? String(
                              (
                                  target.glyphJson.layers as Array<
                                      Record<string, unknown>
                                  >
                              ).find((layer) => layer?.id)?.id ?? ''
                          ) || null
                        : null);

                return {
                    op: 'set' as ChangeOp,
                    path: isLayerScope
                        ? ['glyphs', target.glyphName, 'layers', layerId]
                        : ['glyphs', target.glyphName],
                    oldValue:
                        undoScope === 'font'
                            ? target.previousGlyphJson
                            : cloneHistoryValue(oldValue ?? target.glyphName),
                    newValue:
                        undoScope === 'font'
                            ? cloneHistoryValue(target.glyphJson)
                            : cloneHistoryValue(newValue ?? label),
                    editSource: editSource ?? compileChangeSource ?? null,
                    compileChangeSource,
                    compileEditType,
                    visualAnchorSide,
                    workerReplayTargets,
                    originatingGlyphName: target.glyphName,
                    originatingLayerId,
                    applyPath: isLayerScope
                        ? ['glyphs', target.glyphName, 'layers', layerId]
                        : ['glyphs', target.glyphName],
                    applyOldValue: isLayerScope
                        ? previousLayerSnapshot
                        : previousGlyphSnapshot,
                    applyNewValue: isLayerScope ? layerSnapshot : glyphSnapshot,
                    applyMode: isLayerScope
                        ? 'layer-snapshot'
                        : 'glyph-snapshot'
                };
            }),
            label
        );

        console.log(
            `Glyph sync committed for ${targets.map((target) => target.glyphName).join(', ')} (${label})`
        );
    }

    /**
     * Instead of reconstructing the entire glyph from the Y.Doc,
     * deep-comparing the whole glyph, and cloning it multiple times,
     * this only touches the one affected layer — dramatically reducing
     * JSON serialization overhead for point-move operations.
     *
     * Returns true if the fast path handled the sync (even if no
     * changes were found), false if the caller should fall back to
     * the full glyph path.
     */
    private _trySyncSingleLayer(
        glyphName: string,
        layerId: string,
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null,
        preserveOmittedFields = false
    ): boolean {
        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return false;

        const glyphJson = glyphs.find(
            (g: Record<string, unknown>) => g.name === glyphName
        ) as Record<string, unknown> | undefined;
        if (!glyphJson) return false;

        const glyphMap = this._glyphMapForName(glyphName);
        if (!glyphMap) return false;

        const layersMap = glyphMap.get('layers') as Y.Map<unknown> | undefined;
        if (!layersMap) return false;

        // Find the layer in the in-memory model
        const glyphLayers = (glyphJson.layers ?? []) as Array<
            Record<string, unknown>
        >;
        const layerJson = glyphLayers.find(
            (l: Record<string, unknown>) => l.id === layerId
        );
        if (!layerJson) return false;
        const existingYLayer = layersMap.get(layerId);
        const storageLayerJson = this._prepareLayerSnapshotForHistory(
            layerId,
            layerJson,
            existingYLayer instanceof Y.Map ? fromYType(existingYLayer) : null
        );
        const operations = this._buildLayerSyncOperations(
            glyphName,
            layerId,
            layersMap,
            storageLayerJson,
            label,
            oldValue,
            newValue,
            {
                editSource: editSource ?? compileChangeSource ?? null,
                compileChangeSource,
                compileEditType,
                visualAnchorSide,
                workerReplayTargets,
                preserveOmittedFields
            }
        );
        if (!operations.length) {
            return false;
        }

        this._queueOrCommitOperations(operations, label);

        console.log(
            `Glyph sync committed for ${glyphName} layer ${layerId} (${label}) [fast path]`
        );
        return true;
    }

    // ── Undo / Redo ──────────────────────────────────────────────

    /**
     * Undo the last change for a specific glyph, or font-level if no
     * glyph name is given.
     *
     * YJS_ONLY: Both the native UndoManager branch and history-replay branch
     * emit a canonical binary Yjs update into the standard post-commit funnel.
     */
    undo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): UndoRedoResult | null {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'undo',
            historyTargetKey,
            surface
        );
        // Explicit undo surfaces must not fall through to the font stack when
        // the surface filter finds nothing (History bright ≡ Cmd+Z).
        if (surface && !targetItem) {
            return null;
        }
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'undo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const shouldReplayHistoryItem = this._shouldReplayHistoryItemDirectly(
            targetItem,
            'undo'
        );
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'undo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (
            scope !== 'font' &&
            !shouldReplayHistoryItem &&
            (!um ||
                um.undoStack.length === 0 ||
                !authoritativeHistory.historyItem)
        ) {
            if (!authoritativeHistory.historyItem) {
                return null;
            }
        }
        if (scope === 'font' && !authoritativeHistory.historyItem) {
            return null;
        }
        const undoDocumentIds = this._documentIdsForHistoryItem(
            authoritativeHistory.historyItem,
            this._documentIdForUndoTarget(target)
        );
        const localUpdateBaselines =
            this._captureDocumentBaselines(undoDocumentIds);
        this._suppressRecording = true;
        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            const targetHistoryItemId = authoritativeHistory.historyItemId;
            const semanticHistoryItem = authoritativeHistory.historyItem;
            const timestamp = Date.now();
            const metadataEntries = getSemanticEntriesForHistoryItem(
                semanticHistoryItem,
                'undo',
                targetHistoryItemId,
                timestamp,
                this.windowId,
                this._getWindowRoleLabel()
            );
            if (!metadataEntries?.length && !target.glyphName) {
                return null;
            }
            const workerReplayTargets = normalizeWorkerReplayTargets([
                ...(semanticHistoryItem?.workerReplayTargets ?? []),
                ...(target.glyphName && target.layerId
                    ? [{ glyphName: target.glyphName, layerId: target.layerId }]
                    : [])
            ]);
            // Log entry before um.undo() so it's available when the
            // Y.Doc update event fires and WindowSync broadcasts it.
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyAction: 'undo',
                targetHistoryItemId,
                transactionLabel: 'Undo',
                transactionId: null,
                op: 'set' as ChangeOp,
                undoScope: scope,
                path:
                    scope === 'layer' && target.glyphName && target.layerId
                        ? `glyphs.${target.glyphName}.layers.${target.layerId}`
                        : scope === 'glyph' && target.glyphName
                          ? `glyphs.${target.glyphName}`
                          : 'font',
                oldValue: undefined,
                newValue: 'undo',
                workerReplayTargets,
                semanticChangeLogEntries: metadataEntries ?? undefined
            });
            this._appendChangeLogEntry(entry);

            const isHistoryReplay =
                !!targetItem && (scope === 'font' || shouldReplayHistoryItem);

            const historyReplayWrittenTargets = isHistoryReplay
                ? this._applyHistoryItem(targetItem, 'undo')
                : [];
            if (!isHistoryReplay) {
                um?.undo();
            }

            const layerScopeHints = historyReplayWrittenTargets.length
                ? historyReplayWrittenTargets
                : !(isHistoryReplay && targetItem?.undoScope !== 'layer')
                  ? workerReplayTargets.length > 0 &&
                    workerReplayTargets.every(
                        (replayTarget) =>
                            !!replayTarget.glyphName &&
                            !!replayTarget.layerId &&
                            this._canPatchLayerFromYDoc(replayTarget)
                    )
                      ? workerReplayTargets
                      : scope === 'layer' &&
                          target.glyphName &&
                          target.layerId &&
                          this._canPatchLayerFromYDoc({
                              glyphName: target.glyphName,
                              layerId: target.layerId
                          })
                        ? {
                              glyphName: target.glyphName,
                              layerId: target.layerId
                          }
                        : null
                  : null;
            if (layerScopeHints) {
                this._syncJsonFromYDoc(layerScopeHints);
            } else if (metadataEntries?.length) {
                this._syncRemoteJsonFromYDoc(metadataEntries);
            } else if (target.glyphName) {
                this._syncRemoteJsonFromYDoc([entry]);
            } else {
                throw new Error(
                    'Undo requires semantic change metadata for non-layer updates.'
                );
            }

            this._onAfterSync?.();
            this._onDirty?.();
            if (!this._isApplyingRemote) {
                this._withGlyphRevisionCatchUp(
                    this._glyphIdsFromDocumentIds(localUpdateBaselines.keys()),
                    () =>
                        this._emitCanonicalLocalUpdatesSince(
                            localUpdateBaselines
                        )
                );
            }
            this._advanceUndoHistoryItem(
                scope,
                target.glyphName,
                target.layerId,
                'undo',
                targetHistoryItemId
            );
            return {
                scope,
                glyphName: target.glyphName,
                layerId: target.layerId,
                historyItem: semanticHistoryItem
            };
        } finally {
            this._suppressRecording = false;
            this._suppressAutomaticLocalUpdateEmission = false;
        }
    }

    /**
     * Redo the last undone change.
     *
     * YJS_ONLY: Both the native UndoManager branch and history-replay branch
     * emit a canonical binary Yjs update into the standard post-commit funnel.
     */
    redo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): UndoRedoResult | null {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'redo',
            historyTargetKey,
            surface
        );
        if (surface && !targetItem) {
            return null;
        }
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'redo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const shouldReplayHistoryItem = this._shouldReplayHistoryItemDirectly(
            targetItem,
            'redo'
        );
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'redo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (
            scope !== 'font' &&
            !shouldReplayHistoryItem &&
            (!um ||
                um.redoStack.length === 0 ||
                !authoritativeHistory.historyItem)
        ) {
            if (!authoritativeHistory.historyItem) {
                return null;
            }
        }
        if (scope === 'font' && !authoritativeHistory.historyItem) {
            return null;
        }
        const redoDocumentIds = this._documentIdsForHistoryItem(
            authoritativeHistory.historyItem,
            this._documentIdForUndoTarget(target)
        );
        const localUpdateBaselines =
            this._captureDocumentBaselines(redoDocumentIds);
        this._suppressRecording = true;
        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            const targetHistoryItemId = authoritativeHistory.historyItemId;
            const semanticHistoryItem = authoritativeHistory.historyItem;
            const timestamp = Date.now();
            const metadataEntries = getSemanticEntriesForHistoryItem(
                semanticHistoryItem,
                'redo',
                targetHistoryItemId,
                timestamp,
                this.windowId,
                this._getWindowRoleLabel()
            );
            if (!metadataEntries?.length && !target.glyphName) {
                return null;
            }
            const workerReplayTargets = normalizeWorkerReplayTargets([
                ...(semanticHistoryItem?.workerReplayTargets ?? []),
                ...(target.glyphName && target.layerId
                    ? [{ glyphName: target.glyphName, layerId: target.layerId }]
                    : [])
            ]);
            // Log entry before um.redo() so it's available for broadcast.
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyAction: 'redo',
                targetHistoryItemId,
                transactionLabel: 'Redo',
                transactionId: null,
                op: 'set' as ChangeOp,
                undoScope: scope,
                path:
                    scope === 'layer' && target.glyphName && target.layerId
                        ? `glyphs.${target.glyphName}.layers.${target.layerId}`
                        : scope === 'glyph' && target.glyphName
                          ? `glyphs.${target.glyphName}`
                          : 'font',
                oldValue: undefined,
                newValue: 'redo',
                workerReplayTargets,
                semanticChangeLogEntries: metadataEntries ?? undefined
            });
            this._appendChangeLogEntry(entry);

            const isHistoryReplay =
                !!targetItem && (scope === 'font' || shouldReplayHistoryItem);

            const historyReplayWrittenTargets = isHistoryReplay
                ? this._applyHistoryItem(targetItem, 'redo')
                : [];
            if (!isHistoryReplay) {
                um?.redo();
            }

            const layerScopeHints = historyReplayWrittenTargets.length
                ? historyReplayWrittenTargets
                : !(isHistoryReplay && targetItem?.undoScope !== 'layer')
                  ? workerReplayTargets.length > 0 &&
                    workerReplayTargets.every(
                        (replayTarget) =>
                            !!replayTarget.glyphName &&
                            !!replayTarget.layerId &&
                            this._canPatchLayerFromYDoc(replayTarget)
                    )
                      ? workerReplayTargets
                      : scope === 'layer' &&
                          target.glyphName &&
                          target.layerId &&
                          this._canPatchLayerFromYDoc({
                              glyphName: target.glyphName,
                              layerId: target.layerId
                          })
                        ? {
                              glyphName: target.glyphName,
                              layerId: target.layerId
                          }
                        : null
                  : null;
            if (layerScopeHints) {
                this._syncJsonFromYDoc(layerScopeHints);
            } else if (metadataEntries?.length) {
                this._syncRemoteJsonFromYDoc(metadataEntries);
            } else if (target.glyphName) {
                this._syncRemoteJsonFromYDoc([entry]);
            } else {
                throw new Error(
                    'Redo requires semantic change metadata for non-layer updates.'
                );
            }

            this._onAfterSync?.();
            this._onDirty?.();
            if (!this._isApplyingRemote) {
                this._withGlyphRevisionCatchUp(
                    this._glyphIdsFromDocumentIds(localUpdateBaselines.keys()),
                    () =>
                        this._emitCanonicalLocalUpdatesSince(
                            localUpdateBaselines
                        )
                );
            }
            this._advanceUndoHistoryItem(
                scope,
                target.glyphName,
                target.layerId,
                'redo',
                targetHistoryItemId
            );
            return {
                scope,
                glyphName: target.glyphName,
                layerId: target.layerId,
                historyItem: semanticHistoryItem
            };
        } finally {
            this._suppressRecording = false;
            this._suppressAutomaticLocalUpdateEmission = false;
        }
    }

    /** Check if undo is available. */
    canUndo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): boolean {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'undo',
            historyTargetKey,
            surface
        );
        if (surface && !targetItem) {
            return false;
        }
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'undo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'undo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (scope === 'font') {
            return !!authoritativeHistory.historyItem;
        }
        if (this._shouldReplayHistoryItemDirectly(targetItem, 'undo')) {
            return true;
        }
        return (
            !!authoritativeHistory.historyItem &&
            !!um &&
            um.undoStack.length > 0
        );
    }

    /** Check if redo is available. */
    canRedo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): boolean {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'redo',
            historyTargetKey,
            surface
        );
        if (surface && !targetItem) {
            return false;
        }
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'redo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'redo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (scope === 'font') {
            return !!authoritativeHistory.historyItem;
        }
        if (
            targetItem &&
            this._shouldReplayHistoryItemDirectly(targetItem, 'redo')
        ) {
            return true;
        }
        return (
            !!authoritativeHistory.historyItem &&
            !!um &&
            um.redoStack.length > 0
        );
    }

    // ── Cross-window ─────────────────────────────────────────────

    /**
     * Apply a remote Y.Doc update from another window.
     * Optionally import accompanying change log entries.
     *
     * YJS_ONLY (binary): The remote binary Yjs update is applied and
     * the worker also receives it via _yjsWorkerCallback.
     * Remote JSON/model sync must stay branch-scoped: top-level keys, glyphs,
     * and layers are patched from the authoritative Y.Doc without any full
     * yDocToJson rebuild on the receiving window hot path.
     */
    applyRemoteUpdate(
        update: Uint8Array,
        remoteEntries?: ChangeLogEntry[],
        remoteCollaborationMessages?: CollaborationMessageEnvelope[],
        documentId?: string,
        options?: ApplyRemoteUpdateOptions
    ): boolean {
        const captureInUndo = options?.captureInUndo !== false;
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            const effectiveRemoteEntries = remoteEntries?.length
                ? remoteEntries
                : (remoteCollaborationMessages?.flatMap((message) =>
                      createChangeLogEntriesFromCollaborationMessageEnvelope(
                          message,
                          {
                              windowRoleLabel: this._getWindowRoleLabel()
                          }
                      )
                  ) ?? []);
            if (!effectiveRemoteEntries.length) {
                if (this._isRemoteUpdateNoopOnAnyDoc(update)) {
                    return false;
                }
                throw new MetadataFreeRemoteUpdateError();
            }
            const resolvedDocumentId =
                documentId ||
                (effectiveRemoteEntries[0]
                    ? this.documentIdForPath(
                          getPathSegments(effectiveRemoteEntries[0].path)
                      )
                    : FONT_CORE_DOCUMENT_ID);
            let targetDoc = this._docForId(resolvedDocumentId);
            if (!targetDoc && resolvedDocumentId.startsWith('glyph:')) {
                const glyphId = resolvedDocumentId.slice('glyph:'.length);
                const catalog = catalogFromCoreJson(
                    this._fontJson as Record<string, unknown>
                )?.glyphCatalog;
                if (isCatalogTombstone(catalog, glyphId)) {
                    return false;
                }
                const glyphName =
                    this._glyphNameById.get(glyphId) ||
                    this._deriveGlyphNameFromPath(
                        effectiveRemoteEntries[0]?.path || ''
                    ) ||
                    glyphId;
                this._ensureGlyphDoc(glyphId, glyphName);
                targetDoc = this._docForId(resolvedDocumentId);
            }
            targetDoc = targetDoc || this.yDoc;
            let didChange = false;
            const observeRemoteTransaction = (transaction: Y.Transaction) => {
                didChange ||=
                    transaction.changed.size > 0 ||
                    transaction.deleteSet.clients.size > 0 ||
                    [...transaction.afterState].some(
                        ([client, clock]) =>
                            clock > (transaction.beforeState.get(client) ?? 0)
                    );
            };
            if (effectiveRemoteEntries?.length) {
                this._ensureUndoManagersForRemoteEntries(
                    effectiveRemoteEntries
                );
            }
            targetDoc.on('afterTransaction', observeRemoteTransaction);
            try {
                Y.applyUpdate(
                    targetDoc,
                    update,
                    captureInUndo
                        ? this._getRemoteUpdateOrigin(effectiveRemoteEntries)
                        : CLOUD_REMOTE_ORIGIN
                );
            } finally {
                targetDoc.off('afterTransaction', observeRemoteTransaction);
            }
            if (!didChange) {
                return false;
            }
            this._reconcileGlyphDocsAfterRemoteEntries(effectiveRemoteEntries);
            this._syncRemoteJsonFromYDoc(effectiveRemoteEntries);
            if (
                effectiveRemoteEntries.length > 0 &&
                !areGlyphRevisionOnlyEntries(effectiveRemoteEntries)
            ) {
                this._yjsWorkerCallback?.(
                    update,
                    effectiveRemoteEntries,
                    resolvedDocumentId
                );
            }
            this._onAfterSync?.();
            this._onDirty?.();
            if (
                captureInUndo &&
                effectiveRemoteEntries &&
                effectiveRemoteEntries.length > 0
            ) {
                this._appendChangeLogEntries(effectiveRemoteEntries);
                this._recordUndoHistoryItemsFromRemoteEntries(
                    effectiveRemoteEntries
                );
                this._lastBroadcastLogIndex = this._changeLog.length;
                this._lastLocalUpdateLogIndex = this._changeLog.length;
            }
            if (remoteCollaborationMessages?.length) {
                this._appendCollaborationLogItems(
                    remoteCollaborationMessages.map((message) =>
                        this._createCollaborationLogItem(
                            message,
                            update,
                            'remote',
                            this._deriveForwardChangesFromCollaborationMessage(
                                message
                            )
                        )
                    )
                );
            }
            this._onRemoteChange?.(effectiveRemoteEntries ?? []);
            for (const cb of this._committedChangeListeners) {
                cb(effectiveRemoteEntries ?? [], {
                    origin: 'remote',
                    update,
                    documentId: resolvedDocumentId
                });
            }
            this._noteBroadcastStateVector(resolvedDocumentId);
            return didChange;
        } finally {
            this._isApplyingRemote = false;
        }
    }

    private _reconcileGlyphDocsAfterRemoteEntries(
        remoteEntries: ChangeLogEntry[]
    ): void {
        const glyphOrderTouched = remoteEntries.some((entry) => {
            const segments = getPathSegments(String(entry.path || ''));
            return segments[0] === 'glyphOrder';
        });
        const glyphRootRemoved = remoteEntries.some((entry) => {
            const segments = getPathSegments(String(entry.path || ''));
            return this._isGlyphRootPath(segments) && entry.op === 'remove';
        });
        if (glyphOrderTouched || glyphRootRemoved) {
            this._syncGlyphNameIndexToOrder();
        }
    }

    private _isRemoteUpdateNoopOnAnyDoc(update: Uint8Array): boolean {
        const docs: Y.Doc[] = [
            this.yDoc,
            this.depsDoc,
            ...this._glyphDocs.values()
        ];
        return docs.some((doc) => this._isRemoteUpdateNoop(update, doc));
    }

    private _isRemoteUpdateNoop(
        update: Uint8Array,
        doc: Y.Doc = this.yDoc
    ): boolean {
        const decodedUpdate = Y.decodeUpdate(update);

        for (const struct of decodedUpdate.structs) {
            const knownClock = Y.getState(doc.store, struct.id.client);
            if (struct.id.clock + struct.length > knownClock) {
                return false;
            }
        }

        for (const [client, deleteItems] of decodedUpdate.ds.clients) {
            const structs = doc.store.clients.get(client);
            if (!structs) {
                return false;
            }

            for (const deleteItem of deleteItems) {
                const deleteEnd = deleteItem.clock + deleteItem.len;
                if (Y.getState(doc.store, client) < deleteEnd) {
                    return false;
                }

                let index = Y.findIndexSS(structs, deleteItem.clock);
                while (
                    index < structs.length &&
                    structs[index].id.clock < deleteEnd
                ) {
                    const struct = structs[index];
                    if (struct instanceof Y.Item && !struct.deleted) {
                        return false;
                    }
                    index += 1;
                }
            }
        }

        return true;
    }

    /**
     * Patch live babelfont JSON for a remote Yjs update using only the
     * touched branches identified by change-log metadata.
     */
    private _syncRemoteJsonFromYDoc(remoteEntries?: ChangeLogEntry[]): void {
        if (!this._fontJson) {
            return;
        }

        const entries = remoteEntries ?? [];
        const layerTargets = new Map<
            string,
            { glyphName: string; layerId: string }
        >();
        const glyphNames = new Set<string>();
        const topLevelKeys = new Set<string>();
        let syncEntireFont = entries.length === 0;

        for (const entry of entries) {
            const pathSegments = this._getPathSegments(
                String(entry.path || '')
            );
            if (!pathSegments.length) {
                syncEntireFont = true;
                continue;
            }

            const topLevelKey = pathSegments[0];
            if (topLevelKey === 'font') {
                syncEntireFont = true;
                continue;
            }
            if (topLevelKey === GLYPH_REVISIONS_KEY) {
                continue;
            }
            if (topLevelKey !== 'glyphs') {
                topLevelKeys.add(topLevelKey);
                continue;
            }

            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            const layerId = this._deriveLayerIdFromPath(entry.path);
            const explicitLayerTargets = normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            );
            const hasExplicitLayerTargets = explicitLayerTargets.length > 0;
            if (!glyphName) {
                syncEntireFont = true;
                continue;
            }

            const isWholeGlyphChange = !layerId && entry.undoScope !== 'layer';
            const isWholeLayerChange =
                layerId !== null &&
                pathSegments.length === 4 &&
                pathSegments[2] === 'layers' &&
                !hasExplicitLayerTargets;

            if (isWholeGlyphChange || isWholeLayerChange) {
                glyphNames.add(glyphName);
                continue;
            }
        }

        if (!syncEntireFont) {
            for (const entry of entries) {
                const explicitLayerTargets = normalizeWorkerReplayTargets(
                    entry.workerReplayTargets
                );
                if (explicitLayerTargets.length > 0) {
                    for (const target of explicitLayerTargets) {
                        if (glyphNames.has(target.glyphName)) {
                            continue;
                        }
                        layerTargets.set(
                            getLayerFingerprintTargetKey(
                                target.glyphName,
                                target.layerId
                            ),
                            target
                        );
                    }
                    continue;
                }

                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                if (!glyphName || !layerId || glyphNames.has(glyphName)) {
                    continue;
                }

                layerTargets.set(
                    getLayerFingerprintTargetKey(glyphName, layerId),
                    { glyphName, layerId }
                );
            }
        }

        const fingerprintTargets = this._collectRemoteFingerprintTargets(
            syncEntireFont,
            glyphNames,
            Array.from(layerTargets.values())
        );
        const previousFingerprintSnapshot =
            fingerprintTargets !== undefined
                ? this._collectLayerFingerprintSnapshot(fingerprintTargets)
                : null;

        if (syncEntireFont) {
            throw new Error(
                'Remote Yjs updates require scoped change metadata.'
            );
        } else {
            for (const glyphName of glyphNames) {
                this._patchGlyphFromYDoc(glyphName);
            }
            const fallbackGlyphNames = new Set<string>();
            for (const target of layerTargets.values()) {
                if (glyphNames.has(target.glyphName)) {
                    continue;
                }
                if (!this._patchLayerFromYDoc(target)) {
                    fallbackGlyphNames.add(target.glyphName);
                }
            }
            for (const glyphName of fallbackGlyphNames) {
                this._patchGlyphFromYDoc(glyphName);
            }
            for (const key of topLevelKeys) {
                this._syncTopLevelFontKeyFromYDoc(key);
            }
        }

        this._applyExplicitPropertyRemovalsToFontJson(entries);

        if (previousFingerprintSnapshot) {
            this._emitLayerFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectLayerFingerprintSnapshot(fingerprintTargets)
            );
        }
    }

    /**
     * Rehydrate every top-level font key and glyph snapshot from the current
     * Y.Doc after an explicit full-state bootstrap or rebaseline.
     */
    private _rehydrateEntireFontJsonFromYDoc(): void {
        if (!this._fontJson) {
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const nextTopLevelKeys = new Set<string>();
        this.fontMap.forEach((_value: unknown, key: string) => {
            nextTopLevelKeys.add(key);
        });

        this._syncAllGlyphsFromYDoc();

        for (const key of nextTopLevelKeys) {
            if (key === 'glyphs' || key === 'glyphOrder') {
                continue;
            }
            this._syncTopLevelFontKeyFromYDoc(key);
        }

        for (const key of Object.keys(fontRecord)) {
            if (key === 'glyphs' || key === 'glyphOrder') {
                continue;
            }
            if (!nextTopLevelKeys.has(key)) {
                delete fontRecord[key];
            }
        }
    }

    private _collectRemoteFingerprintTargets(
        syncEntireFont: boolean,
        glyphNames: Set<string>,
        layerTargets: Array<{ glyphName: string; layerId: string }>
    ): LayerFingerprintTarget[] | null | undefined {
        if (syncEntireFont) {
            return null;
        }

        const targets = normalizeWorkerReplayTargets(layerTargets);
        for (const glyphName of glyphNames) {
            this._appendGlyphLayerFingerprintTargets(glyphName, targets);
        }

        return targets.length > 0
            ? normalizeWorkerReplayTargets(targets)
            : undefined;
    }

    private _appendGlyphLayerFingerprintTargets(
        glyphName: string,
        targets: LayerFingerprintTarget[]
    ): void {
        const seen = new Set(
            targets.map((target) =>
                getLayerFingerprintTargetKey(target.glyphName, target.layerId)
            )
        );
        const pushTarget = (layerId: string | null) => {
            if (!layerId) {
                return;
            }
            const targetKey = getLayerFingerprintTargetKey(glyphName, layerId);
            if (seen.has(targetKey)) {
                return;
            }
            seen.add(targetKey);
            targets.push({ glyphName, layerId });
        };

        const glyphs = Array.isArray((this._fontJson as Unsafe)?.glyphs)
            ? (((this._fontJson as Unsafe).glyphs as Unsafe[]).find(
                  (glyph) => glyph?.name === glyphName
              ) as Unsafe | undefined)
            : undefined;
        const existingLayers = Array.isArray(glyphs?.layers)
            ? (glyphs.layers as Unsafe[])
            : [];
        for (const layer of existingLayers) {
            pushTarget(typeof layer?.id === 'string' ? layer.id : null);
        }

        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }
        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) {
            return;
        }
        layersMap.forEach((_value: unknown, layerId: string) => {
            pushTarget(layerId);
        });
    }

    private _captureYDocFontJson(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        this.fontMap.forEach((value: unknown, key: string) => {
            if (key === 'glyphs' || key === 'glyphOrder') {
                return;
            }
            snapshot[key] = this._cloneRuntimeValue(
                cloneHistoryValue(fromYType(value))
            );
        });
        const glyphOrder = this.fontMap.get('glyphOrder');
        const fromOrder =
            glyphOrder instanceof Y.Array
                ? glyphOrder.toArray().map(String)
                : [];
        const orderedGlyphNames = fromOrder.length
            ? fromOrder
            : [...this._glyphIdByName.keys()];
        const glyphs: Unsafe[] = [];
        for (const glyphName of orderedGlyphNames) {
            const glyphSnapshot =
                this._readNormalizedGlyphSnapshotFromYDoc(glyphName);
            if (glyphSnapshot) {
                glyphs.push(glyphSnapshot);
            }
        }
        snapshot.glyphs = glyphs;
        return snapshot;
    }

    private _assignJsonObjectInPlace(
        target: Record<string, unknown>,
        source: Record<string, unknown>
    ): void {
        for (const key of Object.keys(target)) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) {
                delete target[key];
            }
        }
        for (const [key, value] of Object.entries(source)) {
            target[key] = value;
        }
    }

    private _assignGlyphSnapshotInPlace(
        existing: Unsafe,
        snapshot: Unsafe
    ): void {
        const existingLayers = Array.isArray(existing.layers)
            ? (existing.layers as Unsafe[])
            : [];
        const snapshotLayers = Array.isArray(snapshot.layers)
            ? (snapshot.layers as Unsafe[])
            : [];
        const layersById = new Map<string, Unsafe>();
        for (const layer of existingLayers) {
            if (typeof layer?.id === 'string' && layer.id) {
                layersById.set(layer.id, layer);
            }
        }
        const nextLayers: Unsafe[] = [];
        for (const layerSnapshot of snapshotLayers) {
            const layerId =
                typeof layerSnapshot?.id === 'string' ? layerSnapshot.id : '';
            if (!layerId) {
                throw new Error('malformed glyph snapshot: layer missing id');
            }
            const existingLayer = layersById.get(layerId);
            if (
                existingLayer &&
                typeof existingLayer === 'object' &&
                !Array.isArray(existingLayer)
            ) {
                this._assignJsonObjectInPlace(
                    existingLayer as Record<string, unknown>,
                    layerSnapshot as Record<string, unknown>
                );
                nextLayers.push(existingLayer);
            } else {
                nextLayers.push(layerSnapshot);
            }
        }
        this._assignJsonObjectInPlace(existing as Record<string, unknown>, {
            ...(snapshot as Record<string, unknown>),
            layers: nextLayers
        });
    }

    private _syncAllGlyphsFromYDoc(): void {
        if (!this._fontJson) {
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const existingGlyphs = Array.isArray(fontRecord.glyphs)
            ? (fontRecord.glyphs as Unsafe[])
            : [];
        const existingGlyphsByName = new Map<string, Unsafe>(
            existingGlyphs
                .filter(
                    (glyph): glyph is Unsafe =>
                        !!glyph && typeof glyph?.name === 'string'
                )
                .map((glyph) => [String(glyph.name), glyph])
        );

        const existingGlyphsById = new Map<string, Unsafe>();
        for (const glyph of existingGlyphs) {
            if (typeof glyph?.id === 'string' && glyph.id) {
                existingGlyphsById.set(String(glyph.id), glyph);
            }
        }
        const nextGlyphs: Unsafe[] = [];
        const glyphOrder = this.fontMap.get('glyphOrder');
        const fromOrder =
            glyphOrder instanceof Y.Array
                ? glyphOrder.toArray().map(String)
                : [];
        const orderedGlyphNames = fromOrder.length
            ? fromOrder
            : [...this._glyphIdByName.keys()];
        const reconstructed: Array<{
            glyphName: string;
            glyphId?: string;
            glyphSnapshot: Unsafe;
        }> = [];
        for (const glyphName of orderedGlyphNames) {
            const glyphSnapshot =
                this._readNormalizedGlyphSnapshotFromYDoc(glyphName);
            if (!glyphSnapshot) {
                continue;
            }
            reconstructed.push({
                glyphName,
                glyphId: this._glyphIdByName.get(glyphName),
                glyphSnapshot
            });
        }
        for (const { glyphName, glyphId, glyphSnapshot } of reconstructed) {
            const existingGlyph =
                existingGlyphsByName.get(glyphName) ||
                (glyphId ? existingGlyphsById.get(glyphId) : undefined);
            if (
                existingGlyph &&
                typeof existingGlyph === 'object' &&
                !Array.isArray(existingGlyph)
            ) {
                this._assignGlyphSnapshotInPlace(existingGlyph, glyphSnapshot);
                nextGlyphs.push(existingGlyph);
            } else {
                nextGlyphs.push(glyphSnapshot);
            }
        }

        if (nextGlyphs.length > 0 || Array.isArray(fontRecord.glyphs)) {
            fontRecord.glyphs = nextGlyphs;
        }
    }

    private _syncTopLevelFontKeyFromYDoc(key: string): void {
        if (!this._fontJson) {
            return;
        }

        if (key === 'glyphs' || key === 'glyphOrder') {
            this._syncAllGlyphsFromYDoc();
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const value = this.fontMap.get(key);
        if (value === undefined) {
            delete fontRecord[key];
            return;
        }

        fontRecord[key] = this._cloneRuntimeValue(
            cloneHistoryValue(fromYType(value))
        );
    }

    private _readNormalizedGlyphSnapshotFromYDoc(
        glyphName: string,
        readOptions?: { ignoreExisting?: boolean }
    ): Unsafe | null {
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return null;
        }

        const glyphSnapshot = this._cloneRuntimeValue(
            this._normalizeGlyphSnapshot(fromYType(glyphMap), undefined, {
                strictLayers: true,
                ignoreExisting: readOptions?.ignoreExisting === true
            })
        ) as Unsafe;
        return glyphSnapshot;
    }

    private _patchGlyphFromYDoc(
        glyphName: string,
        options?: { ignoreExisting?: boolean }
    ): boolean {
        if (!this._fontJson) {
            return false;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const glyphs = Array.isArray(fontRecord.glyphs)
            ? (fontRecord.glyphs as Unsafe[])
            : [];
        if (!Array.isArray(fontRecord.glyphs)) {
            fontRecord.glyphs = glyphs;
        }

        const glyphIndex = glyphs.findIndex(
            (glyph) => glyph?.name === glyphName
        );
        const glyphSnapshot = this._readNormalizedGlyphSnapshotFromYDoc(
            glyphName,
            { ignoreExisting: options?.ignoreExisting === true }
        );

        if (!glyphSnapshot) {
            if (glyphIndex >= 0) {
                glyphs.splice(glyphIndex, 1);
            }
            return true;
        }

        if (glyphIndex >= 0) {
            const existingGlyph = glyphs[glyphIndex];
            if (
                existingGlyph &&
                typeof existingGlyph === 'object' &&
                !Array.isArray(existingGlyph)
            ) {
                this._assignGlyphSnapshotInPlace(existingGlyph, glyphSnapshot);
            } else {
                glyphs[glyphIndex] = glyphSnapshot;
            }
            return true;
        }

        const yGlyphsMap = this.fontMap.get('glyphs');
        if (!(yGlyphsMap instanceof Y.Map) && !this._glyphDocs.size) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        // Prefer glyphOrder over Y.Map insertion order so newly added glyphs
        // land next to their namesake instead of at the end of the array.
        const glyphOrder = this.fontMap.get('glyphOrder');
        const orderedGlyphNames: string[] =
            glyphOrder instanceof Y.Array
                ? glyphOrder.toArray().map(String)
                : [];
        if (orderedGlyphNames.length === 0) {
            orderedGlyphNames.push(...this._glyphIdByName.keys());
        }
        const glyphOrderIndex = orderedGlyphNames.indexOf(glyphName);
        if (glyphOrderIndex < 0) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        const followingGlyphName = orderedGlyphNames
            .slice(glyphOrderIndex + 1)
            .find((candidateGlyphName) =>
                glyphs.some((glyph) => glyph?.name === candidateGlyphName)
            );
        if (!followingGlyphName) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        const insertIndex = glyphs.findIndex(
            (glyph) => glyph?.name === followingGlyphName
        );
        if (insertIndex < 0) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        glyphs.splice(insertIndex, 0, glyphSnapshot);
        return true;
    }

    private _applyExplicitPropertyRemovalsToFontJson(
        remoteEntries?: ChangeLogEntry[]
    ): void {
        if (!remoteEntries?.length || !this._fontJson) {
            return;
        }

        const glyphs = Array.isArray((this._fontJson as Unsafe).glyphs)
            ? ((this._fontJson as Unsafe).glyphs as Unsafe[])
            : null;
        if (!glyphs) {
            return;
        }

        for (const entry of remoteEntries) {
            if (entry.op !== 'remove' || entry.historyAction === 'undo') {
                continue;
            }

            const pathSegments = this._getPathSegments(
                String(entry.path || '')
            );
            if (pathSegments[0] !== 'glyphs') {
                continue;
            }

            const glyphName = pathSegments[1];
            const glyphRecord = glyphs.find(
                (glyph) => glyph?.name === glyphName
            );

            if (!glyphRecord) {
                continue;
            }

            if (pathSegments.length === 3) {
                delete glyphRecord[pathSegments[2]];
                continue;
            }

            if (pathSegments.length === 4 && pathSegments[2] === 'layers') {
                const layerId = pathSegments[3];
                const layers = Array.isArray(glyphRecord.layers)
                    ? (glyphRecord.layers as Unsafe[])
                    : null;
                if (!layers) {
                    continue;
                }

                const layerIndex = layers.findIndex(
                    (layer) => layer?.id === layerId
                );
                if (layerIndex >= 0) {
                    layers.splice(layerIndex, 1);
                }
                continue;
            }

            if (pathSegments.length !== 5 || pathSegments[2] !== 'layers') {
                continue;
            }

            const layerId = pathSegments[3];
            const propertyKey = pathSegments[4];
            const layers = Array.isArray(glyphRecord.layers)
                ? (glyphRecord.layers as Unsafe[])
                : null;
            const layerRecord = layers?.find((layer) => layer?.id === layerId);
            if (!layerRecord) {
                continue;
            }

            delete layerRecord[propertyKey];
        }
    }

    /**
     * Export the full Y.Doc state for bootstrapping a new window.
     */
    getFullState(): YjsUpdate {
        return Y.encodeStateAsUpdate(this.yDoc);
    }

    getDocumentSetState(): EncodedShard[] {
        return this.encodeDocumentSet();
    }

    /**
     * Apply a full state snapshot (for new window bootstrap).
     * The receiving window should NOT call initFromJson() before this —
     * independently initialised Y.Docs have conflicting CRDT state.
     *
     * YJS_ONLY (N2): Binary Yjs state — no JSON crossing.
     * The explicit rehydrate below is reserved for bootstrap and rebaseline,
     * never for an ordinary committed update.
     */
    applyFullState(state: YjsUpdate): void {
        let applied = false;
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            Y.applyUpdate(this.yDoc, state, SYSTEM_REMOTE_ORIGIN);
            this._rehydrateEntireFontJsonFromYDoc();
            this._canonicalizeFullStateRawFontJson();
            this._repairGeometryOrphansAfterConvergedState();
            // First hydrate needs an UndoManager. Later rebaselines must not
            // silently wipe gc:false history; call truncateUndoHistory().
            if (!this._fontUndoManager) {
                this._setupFontUndoManager();
            }
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
            this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
            applied = true;
        } finally {
            this._isApplyingRemote = false;
        }
        if (applied) {
            this._notifyCoreHydrated();
        }
    }

    /** Encode the full Y.Doc state as a Yjs update binary. */
    encodeBridgeState(): YjsUpdate {
        return this.encodeDocumentState(FONT_CORE_DOCUMENT_ID);
    }

    /** Encode the Y.Doc state vector (compact — one entry per known client). */
    encodeBridgeStateVector(): YjsUpdate {
        return this.encodeDocumentStateVector(FONT_CORE_DOCUMENT_ID);
    }

    /**
     * Encode the minimal update diff that a peer (described by peerStateVector)
     * is missing. Returns an empty update if we have nothing new to share.
     */
    encodeStateDiff(
        peerStateVector: YjsUpdate,
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): YjsUpdate {
        const doc = this._docForId(documentId) || this.yDoc;
        if (!peerStateVector?.byteLength) {
            return Y.encodeStateAsUpdate(doc);
        }
        return Y.encodeStateAsUpdate(doc, peerStateVector);
    }

    /**
     * Register a callback that will be called with every binary Yjs update
     * (both local edits and remote/undo changes) and the accompanying
     * ChangeLogEntry list. Pass `null` to unregister.
     *
     * The callback is intended to forward updates to the WASM compilation
     * worker so it can maintain its own Rust Y.Doc without receiving the full
     * font JSON on every edit.
     */
    setYjsWorkerCallback(
        cb:
            | ((
                  update: YjsUpdate,
                  changeLogEntries: ChangeLogEntry[],
                  documentId?: string
              ) => void)
            | null
    ): void {
        this._yjsWorkerCallback = cb;
    }

    setWorkerDocumentReplaceCallback(
        cb: ((documentId: string, state: YjsUpdate) => void) | null
    ): void {
        this._workerDocumentReplaceCallback = cb;
    }

    /**
     * Apply a Yjs update directly to the Y.Doc without triggering compilation
     * or JSON synchronisation.  Used by CloudAdapter to re-seed the Y.Doc
     * after a bridge replacement (fontModelReady) so that subsequent
     * incremental updates from remote peers can be applied (their left-sibling
     * references will be resolvable).
     */
    applyYDocUpdateSilent(
        update: YjsUpdate,
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): void {
        if (!update || update.length === 0) return;
        const doc = this._docForId(documentId) || this.yDoc;
        Y.applyUpdate(doc, update);
        this._noteBroadcastStateVector(documentId);
    }

    applyLocalGeneratedYjsUpdate(
        update: YjsUpdate,
        operations: TransactionBufferedOperation[],
        label: string | null,
        historyTarget?: TransactionHistoryTarget | null,
        documentUpdates?: Array<{ documentId: string; update: YjsUpdate }>
    ): TransactionCommitResult | null {
        const packets = (documentUpdates || []).filter(
            (packet) => packet.update?.length
        );
        const normalizedOperations = operations
            .filter((operation) => operation.path.length > 0)
            .map((operation) => this._normalizeBufferedOperation(operation));
        if (
            (!update?.length && !packets.length) ||
            !normalizedOperations.length
        ) {
            return null;
        }
        if (this._txDepth > 0) {
            throw new Error(
                'applyLocalGeneratedYjsUpdate does not support open transactions'
            );
        }

        const scopeInfo = this._deriveBufferedScope(normalizedOperations);
        this._prepareBatchUndoManagers(scopeInfo);

        const nextHistoryItemId = this._createHistoryItemId();
        const timestamp = Date.now();
        const undoSurfaceAffinity = this._resolveCommitUndoSurfaceAffinity({
            label,
            historyTarget,
            operations: normalizedOperations
        });
        const originatingLayer =
            this._resolveCommitOriginatingLayer(normalizedOperations);
        const changeLogEntries: ChangeLogEntry[] = normalizedOperations.map(
            (operation) => {
                const operationHistoryTarget =
                    historyTarget ?? this._deriveHistoryTarget(operation.path);
                const workerReplayTargets =
                    this._deriveWorkerReplayTargets(operation);
                return createLogEntry({
                    timestamp,
                    windowId: this.windowId,
                    windowRoleLabel: this._getWindowRoleLabel(),
                    historyItemId: nextHistoryItemId,
                    historyAction: 'change',
                    transactionLabel: label,
                    transactionId: null,
                    op: operation.op,
                    undoScope: scopeInfo.scope,
                    undoSurfaceAffinity,
                    path: joinPathWithGlyphSeparator(operation.path),
                    oldValue: operation.oldValue,
                    newValue: operation.newValue,
                    compileChangeSource: operation.compileChangeSource ?? null,
                    compileEditType: operation.compileEditType ?? null,
                    replayOldValue:
                        operation.op !== 'set'
                            ? undefined
                            : cloneHistoryValue(
                                  operation.applyOldValue === undefined
                                      ? operation.oldValue
                                      : operation.applyOldValue
                              ),
                    replayNewValue:
                        operation.op !== 'set'
                            ? undefined
                            : cloneHistoryValue(
                                  operation.applyNewValue === undefined
                                      ? operation.newValue
                                      : operation.applyNewValue
                              ),
                    visualAnchorSide: operation.visualAnchorSide ?? null,
                    workerReplayTargets,
                    glyphRenames: operation.glyphRenames,
                    historyTargetType: operationHistoryTarget?.type ?? null,
                    historyTargetKey: operationHistoryTarget?.key ?? null,
                    historyTargetLabel: operationHistoryTarget?.label ?? null,
                    originatingGlyphName: originatingLayer.glyphName,
                    originatingLayerId: originatingLayer.layerId
                });
            }
        );

        this._appendChangeLogEntries(changeLogEntries);
        const localUpdateLogIndexBeforeCommit = this._lastLocalUpdateLogIndex;

        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            const uniqueDocumentIds = [
                ...new Set(
                    normalizedOperations.map((operation) =>
                        this.documentIdForPath(operation.path)
                    )
                )
            ];
            const packetsToApply =
                packets.length > 0
                    ? packets
                    : [
                          {
                              documentId:
                                  uniqueDocumentIds.length === 1
                                      ? uniqueDocumentIds[0]
                                      : FONT_CORE_DOCUMENT_ID,
                              update
                          }
                      ];
            for (const packet of packetsToApply) {
                const targetDoc =
                    this._docForId(packet.documentId) || this.yDoc;
                Y.applyUpdate(
                    targetDoc,
                    packet.update,
                    this._originForDocument(packet.documentId, scopeInfo.origin)
                );
                this._noteBroadcastStateVector(packet.documentId);
            }
            this._syncRemoteJsonFromYDoc(changeLogEntries);
            this._onAfterSync?.();
            this._onDirty?.();

            if (
                this._lastLocalUpdateLogIndex ===
                    localUpdateLogIndexBeforeCommit &&
                !this._isApplyingRemote
            ) {
                this._lastLocalUpdateLogIndex = this._changeLog.length;
                for (const packet of packetsToApply) {
                    this._emitLocalUpdate(
                        packet.update,
                        changeLogEntries,
                        packet.documentId
                    );
                }
            }
        } finally {
            this._suppressAutomaticLocalUpdateEmission = false;
            this._finishBatchUndoManagers(scopeInfo);
        }

        return {
            changeLogEntries,
            workerReplayTargets: normalizeWorkerReplayTargets(
                changeLogEntries.flatMap((entry) => entry.workerReplayTargets)
            ),
            changedGlyphNames: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveGlyphNameFromPath(entry.path))
                        .filter((glyphName): glyphName is string =>
                            Boolean(glyphName)
                        )
                )
            ],
            changedLayerIds: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveLayerIdFromPath(entry.path))
                        .filter((layerId): layerId is string =>
                            Boolean(layerId)
                        )
                )
            ]
        };
    }

    // ── Change log ───────────────────────────────────────────────

    /** Get the full change log. */
    getChangeLog(): ChangeLogEntry[] {
        return this._changeLog;
    }

    getCollaborationLog(): CollaborationLogItem[] {
        return this._collaborationLog;
    }

    getChangeLogForGlyph(glyphName?: string | null): ChangeLogEntry[] {
        if (!glyphName) {
            return this._changeLog;
        }
        return this._changeLog.filter(
            (entry) => this._deriveGlyphNameFromPath(entry.path) === glyphName
        );
    }

    /** Import change log entries (e.g. from another window). */
    importChangeLog(entries: ChangeLogEntry[]): void {
        this._changeLog = entries.map((entry) =>
            normalizeChangeLogEntry(entry)
        );
        this._lastBroadcastLogIndex = this._changeLog.length;
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._notifyChangeLogListeners();
    }

    importCollaborationMessages(messages: CollaborationLogItem[]): void {
        this._collaborationLog = [...messages];
        this._notifyCollaborationLogListeners();
    }

    /**
     * Replace the imported baseline while preserving unsent local entries.
     * Used by cloud bootstrap so reconnects do not discard offline edits.
     */
    mergeImportedChangeLog(entries: ChangeLogEntry[]): void {
        const importedEntries = entries.map((entry) =>
            normalizeChangeLogEntry(entry)
        );
        const pendingBroadcastEntries = this._changeLog
            .slice(this._lastBroadcastLogIndex)
            .map((entry) => normalizeChangeLogEntry(entry));
        const mergedEntries = [...importedEntries, ...pendingBroadcastEntries];
        const seenEntryKeys = new Set<string>();

        this._changeLog = mergedEntries.filter((entry) => {
            const entryKey = [
                entry.windowId,
                String(entry.transactionId),
                String(entry.timestamp),
                entry.historyAction,
                entry.op,
                entry.path
            ].join(':');
            if (seenEntryKeys.has(entryKey)) {
                return false;
            }
            seenEntryKeys.add(entryKey);
            return true;
        });
        this._lastBroadcastLogIndex = importedEntries.length;
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._notifyChangeLogListeners();
    }

    mergeImportedCollaborationMessages(messages: CollaborationLogItem[]): void {
        const existing = new Map<string, CollaborationLogItem>();
        for (const item of [...messages, ...this._collaborationLog]) {
            existing.set(item.id, item);
        }
        this._collaborationLog = [...existing.values()].sort(
            (left, right) => left.timestamp - right.timestamp
        );
        this._notifyCollaborationLogListeners();
    }

    /**
     * Get change log entries added since the last call.
     * Used by WindowSync to piggyback entries on yjs-update messages.
     */
    getNewChangeLogEntries(): ChangeLogEntry[] {
        const entries = this._changeLog.slice(this._lastBroadcastLogIndex);
        this._lastBroadcastLogIndex = this._changeLog.length;
        return entries;
    }

    advanceBroadcastLogCursor(entryCount: number): void {
        if (!Number.isFinite(entryCount) || entryCount <= 0) {
            return;
        }

        this._lastBroadcastLogIndex = Math.min(
            this._changeLog.length,
            this._lastBroadcastLogIndex + Math.floor(entryCount)
        );
    }

    private _getNewChangeLogEntriesForLocalUpdate(): ChangeLogEntry[] {
        const entries = this._changeLog.slice(this._lastLocalUpdateLogIndex);
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        return entries;
    }

    /** Reset state (for tests). */
    reset(): void {
        this._changeLog = [];
        this._collaborationLog = [];
        this._lastBroadcastLogIndex = 0;
        this._lastLocalUpdateLogIndex = 0;
        this._glyphRevisionClock = 0;
        this._txDepth = 0;
        this._txLabel = null;
        this._txId = null;
        this._txStartTimeMs = null;
        this._txHistoryItemId = null;
        this._txHistoryTarget = null;
        this._txBufferedOperations = [];
        this._nextTxId = 1;
        this._nextHistoryItemId = 1;
        this._nextCollaborationMessageSequence = 1;
        resetLogCounter();
        for (const entry of this._layerUndoManagers.values()) {
            entry.manager.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this._undoHistoryStacks.clear();
        this._notifyChangeLogListeners();
        this._notifyCollaborationLogListeners();
    }

    // ── Internal ─────────────────────────────────────────────────

    /**
     * Convert a babelfont JSON path to a Y.Doc path.
     *
     * Glyphs and layers in Y.Doc are keyed by name/ID (Y.Map) rather than
     * array index. So ["glyphs", 0, "layers", 2, "width"] becomes
     * ["glyphs", "A", "layers", "layer-uuid", "width"] etc.
     *
     * Since the model already passes human-readable keys (glyph names,
     * layer IDs) for these segments, this function only needs to ensure
     * numeric array indices remain numbers for Y.Array segments.
     */
    private _toYDocPath(path: (string | number)[]): (string | number)[] {
        if (
            path[0] === 'features' &&
            path[1] === 'features' &&
            typeof path[2] === 'string'
        ) {
            const match = String(path[2]).match(/^feature-index:(\d+)$/);
            if (match) {
                return [
                    path[0],
                    path[1],
                    Number.parseInt(match[1], 10),
                    ...path.slice(3)
                ];
            }
        }

        return path;
    }

    /**
     * Sync the local babelfont JSON from the current Y.Doc state.
     * Called after remote updates or undo/redo.
     *
     * YJS_ONLY when fast path succeeds: _patchLayerFromYDoc applies
     * only the touched layers — no full JSON rebuild.
     * When scope hints are unavailable, the live JSON/model is rebuilt from
     * branch-scoped reads of top-level keys and glyph snapshots, not from a
     * monolithic yDocToJson conversion.
     */
    /**
     * Patch the live babelfontData object from the current Y.Doc state.
     *
     * When `scopeHint` is provided (layer-scoped undo/redo), only that one
     * layer is reconstructed from Y.Doc — ~100-1000× faster than a full
     * font rebuild for large fonts. Falls through to the full sync if any
     * Y.Doc path lookup fails.
     *
     * YJS_ONLY when _patchLayerFromYDoc succeeds for all scopeHints
     * (per-layer Y.Doc→JSON, no full rebuild).
     */
    private _syncJsonFromYDoc(
        scopeHints?:
            | { glyphName: string; layerId: string }
            | Array<{ glyphName: string; layerId: string }>
            | null
    ): void {
        const normalizedScopeHints = Array.isArray(scopeHints)
            ? normalizeWorkerReplayTargets(scopeHints)
            : scopeHints
              ? normalizeWorkerReplayTargets([scopeHints])
              : [];
        if (!this._fontJson) return;

        const fingerprintTargets =
            normalizedScopeHints.length > 0 ? normalizedScopeHints : null;
        const previousFingerprintSnapshot =
            this._collectLayerFingerprintSnapshot(fingerprintTargets);

        // Fast path: only reconstruct the touched layers from Y.Doc.
        if (
            normalizedScopeHints.length > 0 &&
            normalizedScopeHints.every((scopeHint) =>
                this._patchLayerFromYDoc(scopeHint)
            )
        ) {
            this._syncPatchedLayersIntoObjectModel(normalizedScopeHints);
            this._emitLayerFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectLayerFingerprintSnapshot(fingerprintTargets)
            );
            return;
        }

        throw new Error(
            'Steady-state Yjs synchronization requires valid layer scope hints.'
        );
    }

    private _canPatchLayerFromYDoc(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const glyphMap = this._glyphMapForName(scopeHint.glyphName);
        const layersMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const glyph = (this._fontJson as Unsafe)?.glyphs?.find(
            (candidate: Unsafe) => candidate?.name === scopeHint.glyphName
        );
        return (
            layersMap instanceof Y.Map &&
            layersMap.get(scopeHint.layerId) instanceof Y.Map &&
            glyph?.layers?.some(
                (layer: Unsafe) => layer?.id === scopeHint.layerId
            )
        );
    }

    private _patchLayerFromYDoc(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const glyphMap = this._glyphMapForName(scopeHint.glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return false;
        }

        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) {
            return false;
        }

        const layerMap = layersMap.get(scopeHint.layerId);
        if (!(layerMap instanceof Y.Map)) {
            return false;
        }

        const glyphs = (this._fontJson as Unsafe).glyphs as
            Unsafe[] | undefined;
        const glyphIdx =
            glyphs?.findIndex((g: Unsafe) => g.name === scopeHint.glyphName) ??
            -1;
        if (glyphIdx < 0 || !glyphs) {
            return false;
        }

        const layers = glyphs[glyphIdx].layers as Unsafe[] | undefined;
        const layerIdx =
            layers?.findIndex((l: Unsafe) => l.id === scopeHint.layerId) ?? -1;
        if (layerIdx < 0 || !layers) {
            return false;
        }

        const patchedLayer = this._cloneRuntimeValue(
            this._normalizeLayerSnapshot(
                scopeHint.layerId,
                fromYType(layerMap),
                layers[layerIdx]
            )
        ) as Unsafe;

        if (
            patchedLayer &&
            typeof patchedLayer === 'object' &&
            !Array.isArray(patchedLayer)
        ) {
            const layerRecord = patchedLayer as Record<string, unknown>;
            if (!('width' in layerRecord)) {
                console.warn(
                    `[PatchSyncEngine] _syncJsonFromYDoc: layer ${scopeHint.layerId} missing "width" after fromYType. Keys: ${Object.keys(layerRecord).join(',')}`
                );
                const yKeys: string[] = [];
                layerMap.forEach((_v: unknown, k: string) => {
                    yKeys.push(k);
                });
                console.warn(
                    `[PatchSyncEngine] Y.Map keys for layer: ${yKeys.join(',')}`
                );
            }
        }

        if (
            layers[layerIdx] &&
            typeof layers[layerIdx] === 'object' &&
            !Array.isArray(layers[layerIdx]) &&
            patchedLayer &&
            typeof patchedLayer === 'object' &&
            !Array.isArray(patchedLayer)
        ) {
            this._assignJsonObjectInPlace(
                layers[layerIdx] as Record<string, unknown>,
                patchedLayer as Record<string, unknown>
            );
        } else {
            layers[layerIdx] = patchedLayer;
        }
        return true;
    }

    private _syncPatchedLayersIntoObjectModel(
        scopeHints: Array<{ glyphName: string; layerId: string }>
    ): void {
        const fontModel = (window as Unsafe).fontManager?.currentFont
            ?.fontModel;
        const glyphs = Array.isArray((this._fontJson as Unsafe)?.glyphs)
            ? ((this._fontJson as Unsafe).glyphs as Unsafe[])
            : [];
        if (!fontModel || glyphs.length === 0) {
            return;
        }

        withSuppressedModelRecording(() => {
            for (const scopeHint of scopeHints) {
                const modelLayer = fontModel
                    .findGlyph?.(scopeHint.glyphName)
                    ?.findLayerById?.(scopeHint.layerId);
                const storedLayer = glyphs
                    .find((glyph) => glyph?.name === scopeHint.glyphName)
                    ?.layers?.find(
                        (layer: Unsafe) => layer?.id === scopeHint.layerId
                    );
                if (!modelLayer || !storedLayer) {
                    continue;
                }

                if (typeof modelLayer.syncFromEditorLayerData === 'function') {
                    modelLayer.syncFromEditorLayerData({
                        width: storedLayer.width,
                        ...(storedLayer.height !== undefined
                            ? { height: storedLayer.height }
                            : {}),
                        ...(storedLayer.vertWidth !== undefined
                            ? { vertWidth: storedLayer.vertWidth }
                            : {}),
                        ...(storedLayer.shapes !== undefined
                            ? { shapes: storedLayer.shapes }
                            : {}),
                        ...(storedLayer.anchors !== undefined
                            ? { anchors: storedLayer.anchors }
                            : {}),
                        ...(storedLayer.guides !== undefined
                            ? { guides: storedLayer.guides }
                            : {}),
                        ...(storedLayer.format_specific !== undefined
                            ? { format_specific: storedLayer.format_specific }
                            : {})
                    });
                    modelLayer.invalidateContentCaches?.();
                    continue;
                }

                const rawLayerData = modelLayer.toJSON?.();
                if (rawLayerData && typeof rawLayerData === 'object') {
                    Object.assign(rawLayerData, storedLayer);
                }
                modelLayer.invalidateContentCaches?.();
            }
        });
    }

    private _syncPatchedLayerTargetsFromYDoc(
        scopeHints: Array<{ glyphName: string; layerId: string }>
    ): void {
        const normalizedScopeHints = normalizeWorkerReplayTargets(scopeHints);
        if (!normalizedScopeHints.length || !this._fontJson) {
            return;
        }

        const previousFingerprintSnapshot =
            this._collectLayerFingerprintSnapshot(normalizedScopeHints);
        const patchedScopeHints = normalizedScopeHints.filter((scopeHint) =>
            this._patchLayerFromYDoc(scopeHint)
        );
        if (!patchedScopeHints.length) {
            return;
        }

        this._syncPatchedLayersIntoObjectModel(patchedScopeHints);
        this._emitLayerFingerprintChangedEvents(
            previousFingerprintSnapshot,
            this._collectLayerFingerprintSnapshot(normalizedScopeHints)
        );
    }

    /**
     * Setup the font-level UndoManager (everything outside glyphs).
     * Scoped to the root fontMap but excludes the "glyphs" sub-map.
     */
    private _setupFontUndoManager(): void {
        this._fontUndoManager?.destroy();
        // Track all top-level keys in the font map
        this._fontUndoManager = new Y.UndoManager(this.fontMap, {
            trackedOrigins: new Set([FONT_EDIT_ORIGIN]),
            captureTimeout: 0
        });
    }

    /** Explicit gc:false history wipe. Rebaseline must not call this implicitly. */
    truncateUndoHistory(): void {
        this._setupFontUndoManager();
        for (const [glyphName, manager] of this._undoManagers) {
            manager.destroy();
            this._undoManagers.delete(glyphName);
        }
        for (const [layerKey, entry] of this._layerUndoManagers) {
            entry.manager.destroy();
            this._layerUndoManagers.delete(layerKey);
        }
        this._undoHistoryStacks.clear();
    }

    mergeRemoteUpdates(updates: Uint8Array[]): void {
        if (!updates.length) {
            return;
        }
        this._isApplyingRemote = true;
        try {
            for (const update of updates) {
                if (update?.byteLength) {
                    Y.applyUpdate(this.yDoc, update, SYSTEM_REMOTE_ORIGIN);
                }
            }
            this._rehydrateEntireFontJsonFromYDoc();
        } finally {
            this._isApplyingRemote = false;
        }
    }

    /**
     * Get or create a per-glyph UndoManager.
     */
    getGlyphUndoManager(glyphName: string): Y.UndoManager | null {
        if (this._undoManagers.has(glyphName)) {
            return this._undoManagers.get(glyphName)!;
        }
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) return null;

        const um = new Y.UndoManager(glyphMap, {
            trackedOrigins: new Set([GLYPH_EDIT_ORIGIN]),
            captureTimeout: 0
        });
        this._undoManagers.set(glyphName, um);
        return um;
    }

    getLayerUndoManager(
        glyphName: string,
        layerId: string
    ): Y.UndoManager | null {
        const managerKey = getLayerManagerKey(glyphName, layerId);
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) return null;
        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) return null;

        const existingEntry = this._layerUndoManagers.get(managerKey);
        if (existingEntry) {
            if (existingEntry.target === layersMap) {
                return existingEntry.manager;
            }
            existingEntry.manager.destroy();
            this._layerUndoManagers.delete(managerKey);
        }

        const um = new Y.UndoManager(layersMap, {
            trackedOrigins: new Set([getLayerEditOrigin(glyphName, layerId)]),
            captureTimeout: 0
        });
        this._layerUndoManagers.set(managerKey, {
            manager: um,
            target: layersMap
        });
        return um;
    }

    private _deriveUndoScope(
        glyphName: string | null,
        layerId: string | null
    ): UndoScope {
        if (!glyphName) {
            return 'font';
        }
        if (layerId) {
            return 'layer';
        }
        return 'glyph';
    }

    private _resolveCommitUndoSurfaceAffinity(options: {
        label?: string | null;
        historyTarget?: TransactionHistoryTarget | null;
        operations: Array<{
            path: (string | number)[];
            editSource?: string | null;
            compileChangeSource?: string | null;
        }>;
    }): UndoSurfaceAffinity | null {
        let contextSurface: HistoryUndoSurface | null = null;
        try {
            contextSurface = getUndoRedoContext().surface;
        } catch {
            contextSurface = null;
        }
        const primary = options.operations[0];
        return resolveUndoSurfaceAffinity({
            contextSurface,
            editSource: primary?.editSource ?? null,
            compileChangeSource: primary?.compileChangeSource ?? null,
            historyTargetKey: options.historyTarget?.key ?? null,
            transactionLabel: options.label ?? null,
            paths: options.operations.map((operation) =>
                joinPathWithGlyphSeparator(operation.path)
            )
        });
    }

    private _resolveCommitOriginatingLayer(
        operations: TransactionBufferedOperation[]
    ): { glyphName: string | null; layerId: string | null } {
        let contextSurface: HistoryUndoSurface | null = null;
        let contextGlyphName: string | null = null;
        let contextLayerId: string | null = null;
        try {
            const context = getUndoRedoContext();
            contextSurface = context.surface;
            contextGlyphName = context.undoGlyphName ?? null;
            contextLayerId = context.undoLayerId ?? null;
        } catch {
            contextSurface = null;
        }
        return resolveCommitOriginatingLayer({
            contextSurface,
            contextGlyphName,
            contextLayerId,
            operations
        });
    }

    private _collabSubmitPlugin(): {
        getId?: () => string;
        canSubmitCollabUpdate?: (
            requests: CollabSubmitRequest[]
        ) => CollabSubmitDecision;
        notifyCollabSubmitRejected?: (decision: CollabSubmitDecision) => void;
    } | null {
        const plugin = window.fontManager?.currentFont?.sourcePlugin as
            | {
                  getId?: () => string;
                  canSubmitCollabUpdate?: (
                      requests: CollabSubmitRequest[]
                  ) => CollabSubmitDecision;
                  notifyCollabSubmitRejected?: (
                      decision: CollabSubmitDecision
                  ) => void;
              }
            | undefined;
        return plugin ?? null;
    }

    private _askCollabSubmitPermission(
        requests: CollabSubmitRequest[]
    ): CollabSubmitDecision {
        if (!requests.length) {
            return { allowed: true };
        }
        const plugin = this._collabSubmitPlugin();
        if (typeof plugin?.canSubmitCollabUpdate !== 'function') {
            return { allowed: true };
        }
        if (plugin.getId?.() === 'cloud') {
            const settingsDecision = evaluateCollabSubmit(requests);
            if (!settingsDecision.allowed) {
                return settingsDecision;
            }
        }
        return plugin.canSubmitCollabUpdate(requests);
    }

    private _undoManagersForCommitScope(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): Y.UndoManager[] {
        const managers: Y.UndoManager[] = [];
        if (
            scopeInfo.scope === 'layer' &&
            scopeInfo.glyphName &&
            scopeInfo.layerId
        ) {
            const manager = this.getLayerUndoManager(
                scopeInfo.glyphName,
                scopeInfo.layerId
            );
            if (manager) {
                managers.push(manager);
            }
            return managers;
        }
        if (scopeInfo.scope === 'glyph' && scopeInfo.glyphName) {
            const manager = this.getGlyphUndoManager(scopeInfo.glyphName);
            if (manager) {
                managers.push(manager);
            }
            return managers;
        }
        if (this._fontUndoManager) {
            managers.push(this._fontUndoManager);
        }
        return managers;
    }

    private _snapshotUndoStackMarks(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): Array<{ manager: Y.UndoManager; undo: number; redo: number }> {
        return this._undoManagersForCommitScope(scopeInfo).map((manager) => ({
            manager,
            undo: manager.undoStack.length,
            redo: manager.redoStack.length
        }));
    }

    private _rejectLocalCollabSubmit(
        undoRollbackMarks: Array<{
            manager: Y.UndoManager;
            undo: number;
            redo: number;
        }>,
        changeLogEntries: ChangeLogEntry[],
        decision: CollabSubmitDecision
    ): void {
        this._suppressAutomaticLocalUpdateEmission = true;
        this._suppressRecording = true;
        try {
            for (const mark of undoRollbackMarks) {
                while (mark.manager.undoStack.length > mark.undo) {
                    mark.manager.undo();
                }
                if (mark.manager.redoStack.length > mark.redo) {
                    mark.manager.redoStack.splice(mark.redo);
                }
            }
        } finally {
            this._suppressRecording = false;
            this._suppressAutomaticLocalUpdateEmission = false;
        }
        if (changeLogEntries.length) {
            this._changeLog.splice(
                Math.max(0, this._changeLog.length - changeLogEntries.length)
            );
            invalidateHistoryStateCache(this._changeLog);
            this._notifyChangeLogListeners();
        }
        this._rehydrateEntireFontJsonFromYDoc();
        this._onAfterSync?.();
        const plugin = this._collabSubmitPlugin();
        if (typeof plugin?.notifyCollabSubmitRejected === 'function') {
            plugin.notifyCollabSubmitRejected(decision);
        }
    }

    private _queueOrCommitOperations(
        operations: TransactionBufferedOperation[],
        label?: string | null,
        skipTransactionFinalizer = false
    ): TransactionCommitResult | null {
        const normalizedOperations = operations
            .filter((operation) => operation.path.length > 0)
            .map((operation) => this._normalizeBufferedOperation(operation));
        if (!normalizedOperations.length) {
            return null;
        }

        if (this._txDepth > 0) {
            // Clone values before buffering — the model may mutate while the
            // transaction is still open.
            this._txBufferedOperations.push(
                ...normalizedOperations.map((op) =>
                    this._cloneBufferedOperation(op)
                )
            );
            return null;
        }

        return this._commitOperations(
            normalizedOperations,
            label ?? null,
            null,
            null,
            undefined,
            undefined,
            undefined,
            skipTransactionFinalizer
        );
    }

    private _shouldPersistCloudWalBeforeApply(): boolean {
        if (this._cloudWalApplyReady) {
            return false;
        }
        if (window.fontManager?.currentFont?.isCloudBacked?.() !== true) {
            return false;
        }
        return (
            typeof window.cloudPlugin?.persistCloudMutationIntent === 'function'
        );
    }

    private async _commitOperationsAfterCloudWal(
        operations: TransactionBufferedOperation[],
        label: string | null,
        transactionId: number | null,
        historyItemId?: string | null,
        historyTarget?: TransactionHistoryTarget | null,
        promptGroupId?: string | null,
        historySummary?: string | null,
        skipTransactionFinalizer = false
    ): Promise<void> {
        const documentIds = [
            ...new Set(
                operations.map((operation) =>
                    this.documentIdForPath(
                        this._toYDocPath(operation.applyPath ?? operation.path)
                    )
                )
            )
        ];
        const persisted =
            await window.cloudPlugin?.persistCloudMutationIntent?.(documentIds);
        this._lastCloudCommitDebug = {
            documentIds,
            operationCount: operations.length,
            persisted
        };
        pushCollabIntegrityEvent('wal-before-apply', {
            documentIds,
            operationCount: operations.length,
            persisted
        });
        if (persisted === false) {
            console.warn(
                'PatchSyncEngine: cloud write-ahead persist failed; local apply skipped'
            );
            return;
        }
        this._cloudWalApplyReady = true;
        try {
            this._commitOperations(
                operations,
                label,
                transactionId,
                historyItemId,
                historyTarget,
                promptGroupId,
                historySummary,
                skipTransactionFinalizer
            );
            await this._cloudEmitPersistChain;
            this._lastCloudCommitDebug = {
                ...this._lastCloudCommitDebug,
                applied: true
            };
        } finally {
            this._cloudWalApplyReady = false;
        }
    }

    private _normalizeBufferedOperation(
        operation: TransactionBufferedOperation
    ): TransactionBufferedOperation {
        return {
            op: operation.op,
            path: [...operation.path],
            oldValue: operation.oldValue,
            newValue: operation.newValue,
            editSource: operation.editSource ?? null,
            compileChangeSource: operation.compileChangeSource ?? null,
            compileEditType: operation.compileEditType ?? null,
            visualAnchorSide: operation.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                operation.workerReplayTargets
            ),
            glyphRenames: normalizeGlyphRenames(operation.glyphRenames),
            applyPath: operation.applyPath
                ? [...operation.applyPath]
                : undefined,
            applyOldValue: operation.applyOldValue,
            applyNewValue: operation.applyNewValue,
            applyMode: operation.applyMode ?? 'default',
            originatingGlyphName: operation.originatingGlyphName ?? null,
            originatingLayerId: operation.originatingLayerId ?? null
        };
    }

    private _cloneBufferedOperation(
        operation: TransactionBufferedOperation
    ): TransactionBufferedOperation {
        return {
            ...operation,
            path: [...operation.path],
            oldValue: cloneHistoryValue(operation.oldValue),
            newValue: cloneHistoryValue(operation.newValue),
            editSource: operation.editSource ?? null,
            compileChangeSource: operation.compileChangeSource ?? null,
            compileEditType: operation.compileEditType ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                operation.workerReplayTargets
            ),
            glyphRenames: normalizeGlyphRenames(operation.glyphRenames),
            applyPath: operation.applyPath
                ? [...operation.applyPath]
                : undefined,
            applyOldValue:
                operation.applyOldValue === undefined
                    ? undefined
                    : cloneHistoryValue(operation.applyOldValue),
            applyNewValue:
                operation.applyNewValue === undefined
                    ? undefined
                    : cloneHistoryValue(operation.applyNewValue),
            applyMode: operation.applyMode ?? 'default'
        };
    }

    private _commitOperations(
        operations: TransactionBufferedOperation[],
        label: string | null,
        transactionId: number | null,
        historyItemId?: string | null,
        historyTarget?: TransactionHistoryTarget | null,
        promptGroupId?: string | null,
        historySummary?: string | null,
        skipTransactionFinalizer = false
    ): TransactionCommitResult | null {
        const normalizedOperations = operations.filter(
            (operation) => operation.path.length > 0
        );
        if (!normalizedOperations.length) {
            return null;
        }

        let finalizedOperations = normalizedOperations;
        if (this._transactionFinalizer && !skipTransactionFinalizer) {
            const derivedOperations = this._transactionFinalizer(
                normalizedOperations.map((operation) =>
                    this._cloneBufferedOperation(operation)
                ),
                {
                    label,
                    transactionId,
                    historyItemId: historyItemId ?? this._txHistoryItemId,
                    historyTarget: historyTarget ?? this._txHistoryTarget
                }
            );
            if (derivedOperations?.length) {
                finalizedOperations = [
                    ...normalizedOperations,
                    ...derivedOperations.map((operation) =>
                        this._normalizeBufferedOperation(operation)
                    )
                ];
            }
        }

        // Snapshot-mode operations carry a full layer/glyph object and are
        // always material changes, so skip the no-op reduction. Default-mode
        // property changes (e.g. feature code edits) may be no-ops and still
        // need the reduction to filter them out.
        const effectiveOperations =
            finalizedOperations.length === 1 &&
            (finalizedOperations[0].applyMode === 'font-snapshot' ||
                finalizedOperations[0].applyMode === 'layer-snapshot' ||
                finalizedOperations[0].applyMode === 'glyph-snapshot')
                ? finalizedOperations
                : this._reduceToNetChangingOperations(finalizedOperations);
        if (!effectiveOperations.length) {
            return null;
        }

        if (this._shouldPersistCloudWalBeforeApply()) {
            const pending = this._commitOperationsAfterCloudWal(
                effectiveOperations,
                label,
                transactionId,
                historyItemId,
                historyTarget,
                promptGroupId,
                historySummary,
                skipTransactionFinalizer
            );
            this._cloudWalCommitChain = Promise.all([
                this._cloudWalCommitChain,
                pending
            ]).then(
                () => undefined,
                (error) => {
                    console.warn(
                        'PatchSyncEngine: cloud WAL commit failed:',
                        error
                    );
                }
            );
            return null;
        }

        const scopeInfo = this._deriveBufferedScope(effectiveOperations);
        this._prepareBatchUndoManagers(scopeInfo);
        const undoRollbackMarks = this._snapshotUndoStackMarks(scopeInfo);

        const nextHistoryItemId =
            historyItemId ?? this._getCurrentHistoryItemId();
        const timestamp = Date.now();
        const transactionDurationMs =
            transactionId !== null && this._txStartTimeMs !== null
                ? Math.max(0, performance.now() - this._txStartTimeMs)
                : null;
        const operationPaths = effectiveOperations.map((operation) =>
            joinPathWithGlyphSeparator(operation.path)
        );
        const primaryHistoryTarget =
            historyTarget ??
            this._deriveHistoryTarget(effectiveOperations[0]?.path ?? []);
        const undoSurfaceAffinity = this._resolveCommitUndoSurfaceAffinity({
            label,
            historyTarget: primaryHistoryTarget,
            operations: effectiveOperations
        });
        const originatingLayer =
            this._resolveCommitOriginatingLayer(effectiveOperations);
        const changeLogEntries: ChangeLogEntry[] = [];

        for (const operation of effectiveOperations) {
            const operationHistoryTarget =
                historyTarget ?? this._deriveHistoryTarget(operation.path);
            const workerReplayTargets =
                this._deriveWorkerReplayTargets(operation);
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId: nextHistoryItemId,
                promptGroupId,
                historySummary,
                historyAction: 'change',
                transactionLabel: label,
                transactionId,
                transactionDurationMs,
                op: operation.op,
                undoScope: this._deriveUndoScope(
                    deriveGlyphName(operation.path),
                    deriveLayerId(operation.path)
                ),
                undoSurfaceAffinity,
                path: joinPathWithGlyphSeparator(operation.path),
                oldValue: operation.oldValue,
                newValue: operation.newValue,
                editSource: operation.editSource ?? null,
                compileChangeSource: operation.compileChangeSource ?? null,
                compileEditType: operation.compileEditType ?? null,
                replayOldValue: this._cloneReplayValue(
                    operation.applyOldValue === undefined
                        ? operation.oldValue
                        : operation.applyOldValue
                ),
                replayNewValue: this._cloneReplayValue(
                    operation.applyNewValue === undefined
                        ? operation.newValue
                        : operation.applyNewValue
                ),
                visualAnchorSide: operation.visualAnchorSide ?? null,
                workerReplayTargets,
                glyphRenames: operation.glyphRenames,
                historyTargetType: operationHistoryTarget?.type ?? null,
                historyTargetKey: operationHistoryTarget?.key ?? null,
                historyTargetLabel: operationHistoryTarget?.label ?? null,
                originatingGlyphName: originatingLayer.glyphName,
                originatingLayerId: originatingLayer.layerId
            });
            changeLogEntries.push(entry);
        }

        this._appendChangeLogEntries(changeLogEntries);

        this._ensureDocumentsForOperations(effectiveOperations);

        const glyphNameRemaps = effectiveOperations.flatMap((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            if (
                applyPath.length !== 3 ||
                applyPath[0] !== 'glyphs' ||
                applyPath[2] !== 'name'
            ) {
                return [];
            }
            const oldName = String(applyPath[1]);
            const glyphId = this._glyphIdByName.get(oldName);
            if (!glyphId) {
                return [];
            }
            return [
                {
                    glyphId,
                    oldName,
                    newName: String(operation.newValue ?? '')
                }
            ];
        });

        const localUpdateBaselineByDoc = new Map<string, Uint8Array>();
        const docsTouched = new Set<string>();
        for (const operation of effectiveOperations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            docsTouched.add(this.documentIdForPath(applyPath));
            if (operation.op === 'remove' && this._isGlyphRootPath(applyPath)) {
                docsTouched.add(FONT_CORE_DOCUMENT_ID);
            }
        }
        for (const documentId of docsTouched) {
            const doc = this._docForId(documentId);
            if (!doc) {
                continue;
            }
            localUpdateBaselineByDoc.set(
                documentId,
                this._lastBroadcastStateVectorByDoc.get(documentId) ||
                    (documentId === FONT_CORE_DOCUMENT_ID
                        ? (this._txStartStateVector ??
                          this._lastBroadcastStateVector)
                        : Y.encodeStateVector(doc))
            );
        }

        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            for (const documentId of docsTouched) {
                const doc = this._docForId(documentId);
                if (!doc) {
                    continue;
                }
                const opsForDoc = effectiveOperations.filter((operation) => {
                    const applyPath = this._toYDocPath(
                        operation.applyPath ?? operation.path
                    );
                    return this.documentIdForPath(applyPath) === documentId;
                });
                const geometryOps = this._dropObsoletePositionWrites(opsForDoc);
                doc.transact(
                    () => {
                        for (const operation of geometryOps) {
                            this._applyBufferedOperation(operation);
                        }
                        this._repairGeometryOrphansForOperations(geometryOps);
                    },
                    this._originForDocument(documentId, scopeInfo.origin)
                );
            }
        } finally {
            this._suppressAutomaticLocalUpdateEmission = false;
        }

        if (!this._isApplyingRemote) {
            const pendingPackets: Array<{
                documentId: string;
                update: YjsUpdate;
                entries: ChangeLogEntry[];
                shardBytes: number;
            }> = [];
            for (const documentId of docsTouched) {
                const doc = this._docForId(documentId);
                if (!doc) {
                    continue;
                }
                const baseline =
                    localUpdateBaselineByDoc.get(documentId) ||
                    Y.encodeStateVector(doc);
                const exactCommitUpdate = Y.encodeStateAsUpdate(doc, baseline);
                if (exactCommitUpdate.length === 0) {
                    continue;
                }
                const measured = measureShardBytesForSubmit({
                    lastEncodedBytes:
                        this._lastEncodedShardBytes.get(documentId) || 0,
                    packetBytes: exactCommitUpdate.byteLength,
                    encodeFullShard: () => Y.encodeStateAsUpdate(doc).byteLength
                });
                const docEntries = changeLogEntries.filter((entry) => {
                    const segments = getPathSegments(entry.path);
                    return this.documentIdForPath(segments) === documentId;
                });
                pendingPackets.push({
                    documentId,
                    update: exactCommitUpdate,
                    entries: docEntries.length ? docEntries : changeLogEntries,
                    shardBytes: measured.shardBytes
                });
            }
            const decision = this._askCollabSubmitPermission(
                pendingPackets.map((packet) => ({
                    documentId: packet.documentId,
                    packetBytes: packet.update.byteLength,
                    shardBytes: packet.shardBytes
                }))
            );
            if (!decision.allowed) {
                this._rejectLocalCollabSubmit(
                    undoRollbackMarks,
                    changeLogEntries,
                    decision
                );
                this._finishBatchUndoManagers(scopeInfo);
                return null;
            }
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            this._withGlyphRevisionCatchUp(
                this._glyphIdsTouchedByOperations(effectiveOperations),
                () => {
                    for (const packet of pendingPackets) {
                        const doc = this._docForId(packet.documentId);
                        const baseline =
                            localUpdateBaselineByDoc.get(packet.documentId) ||
                            (doc ? Y.encodeStateVector(doc) : null);
                        const stampedUpdate =
                            doc && baseline
                                ? Y.encodeStateAsUpdate(doc, baseline)
                                : packet.update;
                        const measured = doc
                            ? measureShardBytesForSubmit({
                                  lastEncodedBytes:
                                      this._lastEncodedShardBytes.get(
                                          packet.documentId
                                      ) || 0,
                                  packetBytes: stampedUpdate.byteLength,
                                  encodeFullShard: () =>
                                      Y.encodeStateAsUpdate(doc).byteLength
                              })
                            : { shardBytes: packet.shardBytes };
                        this._noteBroadcastStateVector(packet.documentId);
                        this._lastEncodedShardBytes.set(
                            packet.documentId,
                            measured.shardBytes
                        );
                        this._emitLocalUpdate(
                            stampedUpdate,
                            packet.entries,
                            packet.documentId
                        );
                    }
                }
            );
        }

        for (const remap of glyphNameRemaps) {
            this._glyphIdByName.delete(remap.oldName);
        }
        for (const remap of glyphNameRemaps) {
            if (!remap.newName) {
                continue;
            }
            this._glyphIdByName.set(remap.newName, remap.glyphId);
            this._glyphNameById.set(remap.glyphId, remap.newName);
        }

        if (!this._isApplyingRemote) {
            this._syncRemoteJsonFromYDoc(changeLogEntries);
        }

        this._flushDestroyedGlyphDocs();

        this._recordUndoHistoryItem(
            scopeInfo.scope,
            scopeInfo.glyphName,
            scopeInfo.layerId,
            nextHistoryItemId
        );

        this._finishBatchUndoManagers(scopeInfo);
        this._onDirty?.();

        if (effectiveOperations.length === 1) {
            console.log(
                `[PatchSyncEngine] Change recorded: ${joinPathWithGlyphSeparator(effectiveOperations[0].path)}`
            );
        }

        return {
            changeLogEntries,
            workerReplayTargets: normalizeWorkerReplayTargets(
                changeLogEntries.flatMap((entry) => entry.workerReplayTargets)
            ),
            changedGlyphNames: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveGlyphNameFromPath(entry.path))
                        .filter((glyphName): glyphName is string =>
                            Boolean(glyphName)
                        )
                )
            ],
            changedLayerIds: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveLayerIdFromPath(entry.path))
                        .filter((layerId): layerId is string =>
                            Boolean(layerId)
                        )
                )
            ]
        };
    }

    private _deriveWorkerReplayTargets(
        operation: TransactionBufferedOperation
    ): WorkerReplayTarget[] {
        const explicitTargets = normalizeWorkerReplayTargets(
            operation.workerReplayTargets
        );
        if (explicitTargets.length) {
            return explicitTargets;
        }

        const applyPath = operation.applyPath ?? operation.path;
        const glyphName = deriveGlyphName(applyPath);
        const layerId = deriveLayerId(applyPath);

        if (glyphName && layerId) {
            return [{ glyphName, layerId }];
        }

        if (
            operation.applyMode !== 'glyph-snapshot' ||
            operation.op !== 'set' ||
            !glyphName
        ) {
            return [];
        }

        const glyphSnapshot =
            operation.applyNewValue === undefined
                ? operation.newValue
                : operation.applyNewValue;
        if (!glyphSnapshot || typeof glyphSnapshot !== 'object') {
            return [];
        }

        const layers = Array.isArray((glyphSnapshot as Unsafe).layers)
            ? ((glyphSnapshot as Unsafe).layers as Unsafe[])
            : [];
        return normalizeWorkerReplayTargets(
            layers.map((layer) => {
                const snapshotLayerId =
                    layer && typeof layer === 'object'
                        ? String(layer.id || '')
                        : '';
                return snapshotLayerId
                    ? {
                          glyphName,
                          layerId: snapshotLayerId
                      }
                    : null;
            })
        );
    }

    private _reduceToNetChangingOperations(
        operations: TransactionBufferedOperation[]
    ): TransactionBufferedOperation[] {
        const byApplyPath = new Map<
            string,
            {
                originalValue: unknown;
                finalValue: unknown;
            }
        >();

        operations.forEach((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const pathKey = JSON.stringify(applyPath);
            const existing = byApplyPath.get(pathKey);
            const finalValue =
                operation.op === 'remove'
                    ? undefined
                    : cloneHistoryValue(
                          operation.applyNewValue === undefined
                              ? operation.newValue
                              : operation.applyNewValue
                      );

            if (!existing) {
                byApplyPath.set(pathKey, {
                    finalValue,
                    originalValue: cloneHistoryValue(
                        this._getRoutedYPath(applyPath)
                    )
                });
                return;
            }

            existing.finalValue = finalValue;
        });

        const noOpPathKeys = new Set(
            Array.from(byApplyPath.entries())
                .filter(([, entry]) =>
                    this._isDeepEqual(entry.originalValue, entry.finalValue)
                )
                .map(([pathKey]) => pathKey)
        );

        if (!noOpPathKeys.size) {
            return operations;
        }

        return operations.filter((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const pathKey = JSON.stringify(applyPath);
            return !noOpPathKeys.has(pathKey);
        });
    }

    private _collectRemovedNodeIds(
        operations: TransactionBufferedOperation[]
    ): Set<string> {
        const removed = new Set<string>();
        const collectFromShapes = (oldShapes: unknown, newShapes: unknown) => {
            if (!Array.isArray(oldShapes) || !Array.isArray(newShapes)) {
                return;
            }
            const nextIds = new Set<string>();
            for (const shape of newShapes) {
                const nodes = (shape as { nodes?: { id?: string }[] })?.nodes;
                if (!Array.isArray(nodes)) {
                    continue;
                }
                for (const node of nodes) {
                    if (node?.id) {
                        nextIds.add(node.id);
                    }
                }
            }
            for (const shape of oldShapes) {
                const nodes = (shape as { nodes?: { id?: string }[] })?.nodes;
                if (!Array.isArray(nodes)) {
                    continue;
                }
                for (const node of nodes) {
                    if (node?.id && !nextIds.has(node.id)) {
                        removed.add(node.id);
                    }
                }
            }
        };
        for (const operation of operations) {
            const path = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            if (path[path.length - 1] === 'nodes') {
                collectFromShapes(
                    [{ nodes: operation.oldValue }],
                    [{ nodes: operation.newValue }]
                );
            } else if (path[path.length - 1] === 'shapes') {
                collectFromShapes(operation.oldValue, operation.newValue);
            }
        }
        return removed;
    }

    private _dropObsoletePositionWrites(
        operations: TransactionBufferedOperation[]
    ): TransactionBufferedOperation[] {
        const removedNodeIds = this._collectRemovedNodeIds(operations);
        if (!removedNodeIds.size) {
            return operations;
        }
        return operations.filter((operation) => {
            const path = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const positionIndex = path.indexOf('nodePositionsById');
            if (positionIndex < 0) {
                return true;
            }
            const nodeId = path[positionIndex + 1];
            return !removedNodeIds.has(String(nodeId));
        });
    }

    private _repairGeometryOrphansForOperations(
        operations: TransactionBufferedOperation[]
    ): void {
        // A topology mutation can be concurrent with a remote topology that
        // retains one of its removed nodes. Leave those positions as harmless
        // orphans until a later converged repair pass rather than tombstoning
        // a coordinate that the winning topology still references.
        if (
            operations.some((operation) => {
                const path = this._toYDocPath(
                    operation.applyPath ?? operation.path
                );
                return (
                    path[path.length - 1] === 'shapes' ||
                    path[path.length - 1] === 'nodes'
                );
            })
        ) {
            return;
        }
        const seen = new Set<string>();
        for (const operation of operations) {
            const path = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            if (path[0] !== 'glyphs' || path[2] !== 'layers') {
                continue;
            }
            const glyphName = String(path[1]);
            const layerId = String(path[3]);
            const key = `${glyphName}:${layerId}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const glyphMap = this._glyphMapForName(glyphName);
            if (!(glyphMap instanceof Y.Map)) {
                continue;
            }
            const layersMap = glyphMap.get('layers');
            if (!(layersMap instanceof Y.Map)) {
                continue;
            }
            const layerMap = layersMap.get(layerId);
            if (layerMap instanceof Y.Map) {
                repairLayerGeometryOrphans(layerMap);
            }
        }
    }

    /**
     * A complete document-set state is a convergence boundary. Never schedule
     * this after a local structural edit: an unseen topology may still retain
     * a node while deliberately omitting its unchanged packed coordinate.
     */
    private _repairGeometryOrphansAfterConvergedState(
        documentId?: string
    ): void {
        const targetDoc = documentId ? this._docForId(documentId) : undefined;
        const layersByDoc = new Map<Y.Doc, Y.Map<unknown>[]>();
        for (const glyphName of new Set(this._glyphNameById.values())) {
            const glyphMap = this._glyphMapForName(glyphName);
            if (!(glyphMap instanceof Y.Map)) {
                continue;
            }
            const layersMap = glyphMap.get('layers');
            if (!(layersMap instanceof Y.Map)) {
                continue;
            }
            layersMap.forEach((layer) => {
                if (
                    !(layer instanceof Y.Map) ||
                    !layer.doc ||
                    (targetDoc && layer.doc !== targetDoc)
                ) {
                    return;
                }
                const layers = layersByDoc.get(layer.doc) || [];
                layers.push(layer);
                layersByDoc.set(layer.doc, layers);
            });
        }
        for (const [doc, layers] of layersByDoc) {
            doc.transact(() => {
                for (const layer of layers) {
                    repairLayerGeometryOrphans(layer);
                }
            }, SYSTEM_REMOTE_ORIGIN);
        }
    }

    private _applyBufferedOperation(
        operation: TransactionBufferedOperation
    ): void {
        if (operation.applyMode === 'font-snapshot') {
            this._applyFontSnapshot(
                operation.applyNewValue === undefined
                    ? operation.newValue
                    : operation.applyNewValue
            );
            return;
        }

        const applyPath = this._toYDocPath(
            operation.applyPath ?? operation.path
        );
        const applyValue =
            operation.applyNewValue === undefined
                ? operation.newValue
                : operation.applyNewValue;

        if (operation.op === 'remove') {
            this._deleteRoutedYPath(applyPath);
            return;
        }

        if (
            operation.applyMode === 'glyph-snapshot' &&
            this._isGlyphRootPath(applyPath)
        ) {
            this._applyGlyphSnapshot(String(applyPath[1]), applyValue);
            return;
        }

        if (
            operation.applyMode === 'layer-snapshot' &&
            applyPath.length === 4 &&
            applyPath[0] === 'glyphs' &&
            applyPath[2] === 'layers'
        ) {
            this._applyLayerDelta(
                String(applyPath[1]),
                String(applyPath[3]),
                applyValue
            );
            return;
        }

        this._setRoutedYPath(applyPath, applyValue);
    }

    private _deriveBufferedScope(operations: TransactionBufferedOperation[]): {
        scope: UndoScope;
        origin: string;
        glyphName: string | null;
        layerId: string | null;
    } {
        const touchedGlyphNames = new Set<string>();
        const touchedLayerKeys = new Set<string>();
        let hasFontScopedChange = false;
        let hasGlyphScopedChange = false;

        for (const operation of operations) {
            const glyphName = deriveGlyphName(operation.path);
            const layerId = deriveLayerId(operation.path);
            if (!glyphName) {
                hasFontScopedChange = true;
            }
            if (glyphName) {
                touchedGlyphNames.add(glyphName);
            }
            if (glyphName && layerId) {
                touchedLayerKeys.add(getLayerManagerKey(glyphName, layerId));
            } else if (glyphName) {
                hasGlyphScopedChange = true;
            }
        }

        if (!hasFontScopedChange && touchedGlyphNames.size === 1) {
            const glyphName = [...touchedGlyphNames][0];
            if (!hasGlyphScopedChange && touchedLayerKeys.size === 1) {
                const [managerKey] = [...touchedLayerKeys];
                const [, layerId] = managerKey.split('@@');
                return {
                    scope: 'layer',
                    origin: this._getEditOrigin(glyphName, layerId, 'layer'),
                    glyphName,
                    layerId
                };
            }
            return {
                scope: 'glyph',
                origin: this._getEditOrigin(glyphName, null, 'glyph'),
                glyphName,
                layerId: null
            };
        }

        return {
            scope: 'font',
            origin: FONT_EDIT_ORIGIN,
            glyphName: null,
            layerId: null
        };
    }

    private _prepareBatchUndoManagers(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): void {
        if (
            scopeInfo.scope === 'layer' &&
            scopeInfo.glyphName &&
            scopeInfo.layerId
        ) {
            this.getLayerUndoManager(
                scopeInfo.glyphName,
                scopeInfo.layerId
            )?.stopCapturing();
            return;
        }
        if (scopeInfo.scope === 'glyph' && scopeInfo.glyphName) {
            this.getGlyphUndoManager(scopeInfo.glyphName)?.stopCapturing();
            return;
        }
        this._fontUndoManager?.stopCapturing();
        if (scopeInfo.scope === 'font') {
            for (const glyphName of this._glyphIdByName.keys()) {
                this.getGlyphUndoManager(glyphName)?.stopCapturing();
            }
        }
    }

    private _ensureDocumentsForOperations(
        operations: TransactionBufferedOperation[]
    ): void {
        for (const operation of operations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            if (applyPath[0] !== 'glyphs' || applyPath.length < 2) {
                continue;
            }
            const glyphName = String(applyPath[1]);
            if (this._glyphMapForName(glyphName)) {
                continue;
            }
            const snapshot =
                applyPath.length === 2 &&
                operation.newValue &&
                typeof operation.newValue === 'object'
                    ? (operation.newValue as Record<string, unknown>)
                    : { name: glyphName };
            const glyphId = ensureImmutableGlyphId(snapshot);
            this._ensureGlyphDoc(glyphId, glyphName);
        }
    }

    private _originForDocument(
        documentId: string,
        fallbackOrigin: string
    ): string {
        if (!documentId.startsWith('glyph:')) {
            return FONT_EDIT_ORIGIN;
        }
        if (fallbackOrigin === FONT_EDIT_ORIGIN) {
            return GLYPH_EDIT_ORIGIN;
        }
        return fallbackOrigin;
    }

    private _glyphIdsTouchedByOperations(
        operations: Array<{
            path: Array<string | number>;
            applyPath?: Array<string | number>;
        }>
    ): string[] {
        const ids = new Set<string>();
        for (const operation of operations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const glyphId = glyphIdFromDocumentId(
                this.documentIdForPath(applyPath)
            );
            if (glyphId) {
                ids.add(glyphId);
            }
        }
        return [...ids];
    }

    private _glyphIdsFromDocumentIds(documentIds: Iterable<string>): string[] {
        const ids = new Set<string>();
        for (const documentId of documentIds) {
            const glyphId = glyphIdFromDocumentId(documentId);
            if (glyphId) {
                ids.add(glyphId);
            }
        }
        return [...ids];
    }

    private _allocateGlyphRevisionTokens(glyphIds: string[]): Array<{
        glyphId: string;
        revision: string;
        previous: unknown;
    }> {
        const uniqueIds = [...new Set(glyphIds.filter(Boolean))];
        if (!uniqueIds.length || this._isApplyingRemote) {
            return [];
        }
        const revisions = this.yDoc.getMap(GLYPH_REVISIONS_KEY);
        return uniqueIds.map((glyphId) => {
            const previous = revisions.get(glyphId) ?? null;
            const revision = `${this.windowId}:${++this._glyphRevisionClock}`;
            return { glyphId, revision, previous };
        });
    }

    private _stampGlyphCatchUpRevisions(
        tokens: Array<{ glyphId: string; revision: string }>
    ): void {
        for (const { glyphId, revision } of tokens) {
            const doc = this._glyphDocs.get(glyphId);
            if (!doc) {
                continue;
            }
            doc.transact(() => {
                const sync = doc.getMap(GLYPH_SYNC_MAP_KEY);
                sync.set(GLYPH_SYNC_REVISION_KEY, revision);
                const catalog = catalogFromCoreJson(
                    this._fontJson as Record<string, unknown>
                )?.glyphCatalog;
                const generation = catalog?.[glyphId]?.generation;
                if (generation != null) {
                    sync.set('generation', generation);
                }
            }, GLYPH_REVISION_ORIGIN);
        }
    }

    private _publishGlyphRevisionCoreSignal(
        tokens: Array<{
            glyphId: string;
            revision: string;
            previous: unknown;
        }>
    ): void {
        if (!tokens.length || this._isApplyingRemote) {
            return;
        }
        const historyItemId = `glyph-revision-${this.windowId}-${tokens[0].revision}`;
        const baseline = Y.encodeStateVector(this.yDoc);
        const entries: ChangeLogEntry[] = [];
        this.yDoc.transact(() => {
            const revisions = this.yDoc.getMap(GLYPH_REVISIONS_KEY);
            for (const { glyphId, revision, previous } of tokens) {
                revisions.set(glyphId, revision);
                entries.push(
                    createLogEntry({
                        timestamp: Date.now(),
                        windowId: this.windowId,
                        windowRoleLabel: this._getWindowRoleLabel(),
                        historyAction: 'change',
                        transactionLabel: 'Glyph revision',
                        transactionId: null,
                        historyItemId,
                        op: 'set',
                        undoScope: 'font',
                        path: joinPathWithGlyphSeparator([
                            GLYPH_REVISIONS_KEY,
                            glyphId
                        ]),
                        oldValue: previous,
                        newValue: revision
                    })
                );
            }
        }, GLYPH_REVISION_ORIGIN);
        const update = Y.encodeStateAsUpdate(this.yDoc, baseline);
        if (!update.length || !entries.length) {
            return;
        }
        this._noteBroadcastStateVector(FONT_CORE_DOCUMENT_ID);
        for (const cb of this._glyphRevisionListeners) {
            cb(update, entries);
        }
    }

    private _withGlyphRevisionCatchUp(
        glyphIds: string[],
        emitLocalGlyphUpdates: () => void
    ): void {
        const tokens = this._allocateGlyphRevisionTokens(glyphIds);
        this._stampGlyphCatchUpRevisions(tokens);
        emitLocalGlyphUpdates();
        const publish = (): void => {
            this._publishGlyphRevisionCoreSignal(tokens);
        };
        const plugin = window.cloudPlugin;
        if (typeof plugin?.waitForCloudGlyphDurability === 'function') {
            void Promise.resolve(plugin.waitForCloudGlyphDurability()).then(
                publish,
                publish
            );
            return;
        }
        publish();
    }

    private _notifyCoreHydrated(): void {
        for (const cb of this._coreHydratedListeners) {
            try {
                cb();
            } catch (error) {
                console.warn('PatchSyncEngine: onCoreHydrated failed', error);
            }
        }
    }

    private _finishBatchUndoManagers(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): void {
        if (
            scopeInfo.scope === 'layer' &&
            scopeInfo.glyphName &&
            scopeInfo.layerId
        ) {
            this.getLayerUndoManager(
                scopeInfo.glyphName,
                scopeInfo.layerId
            )?.stopCapturing();
            return;
        }
        if (scopeInfo.scope === 'glyph' && scopeInfo.glyphName) {
            this.getGlyphUndoManager(scopeInfo.glyphName)?.stopCapturing();
            return;
        }
        this._fontUndoManager?.stopCapturing();
    }

    private _getEditOrigin(
        glyphName: string | null,
        layerId: string | null,
        scope: UndoScope
    ): string {
        if (scope === 'layer' && glyphName && layerId) {
            return getLayerEditOrigin(glyphName, layerId);
        }
        if (scope === 'glyph') {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
    }

    private _getUndoHistoryScopeKey(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): string {
        if (scope === 'layer' && glyphName && layerId) {
            return getLayerManagerKey(glyphName, layerId);
        }
        if (scope === 'glyph' && glyphName) {
            return glyphName;
        }
        return FONT_UNDO_HISTORY_KEY;
    }

    private _getUndoHistoryStacksForScope(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): UndoHistoryStacks {
        const key = this._getUndoHistoryScopeKey(scope, glyphName, layerId);
        const existing = this._undoHistoryStacks.get(key);
        if (existing) {
            return existing;
        }

        const created: UndoHistoryStacks = { active: [], undone: [] };
        this._undoHistoryStacks.set(key, created);
        return created;
    }

    private _recordUndoHistoryItem(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyItemId: string
    ): void {
        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        removeHistoryItemFromStack(stacks.active, historyItemId);
        removeHistoryItemFromStack(stacks.undone, historyItemId);
        stacks.active.push(historyItemId);
        stacks.undone.length = 0;
    }

    private _recordUndoHistoryItemsFromRemoteEntries(
        remoteEntries: ChangeLogEntry[]
    ): void {
        const recorded = new Set<string>();
        for (const entry of remoteEntries) {
            if (entry.historyAction !== 'change' || !entry.historyItemId) {
                continue;
            }
            if (recorded.has(entry.historyItemId)) {
                continue;
            }
            recorded.add(entry.historyItemId);
            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            const layerId =
                entry.undoScope === 'layer'
                    ? this._deriveLayerIdFromPath(entry.path)
                    : null;
            this._recordUndoHistoryItem(
                entry.undoScope,
                glyphName,
                layerId,
                entry.historyItemId
            );
        }
    }

    private _peekUndoHistoryItemId(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyAction: 'undo' | 'redo'
    ): string | null {
        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        const sourceStack =
            historyAction === 'undo' ? stacks.active : stacks.undone;
        return sourceStack.length ? sourceStack[sourceStack.length - 1] : null;
    }

    private _advanceUndoHistoryItem(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyAction: 'undo' | 'redo',
        historyItemId: string | null
    ): void {
        if (!historyItemId) {
            return;
        }

        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        const sourceStack =
            historyAction === 'undo' ? stacks.active : stacks.undone;
        const targetStack =
            historyAction === 'undo' ? stacks.undone : stacks.active;
        removeHistoryItemFromStack(sourceStack, historyItemId);
        removeHistoryItemFromStack(targetStack, historyItemId);
        targetStack.push(historyItemId);
    }

    private _findHistoryItemById(
        historyItemId: string | null
    ): HistoryStackItem | null {
        if (!historyItemId) {
            return null;
        }

        return (
            buildHistoryStackItems(this._changeLog, {
                includeUndone: true
            }).find((item) => item.id === historyItemId) ?? null
        );
    }

    private _resolveAuthoritativeUndoHistory(
        historyAction: 'undo' | 'redo',
        targetItem: HistoryStackItem | null,
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): ResolvedUndoHistorySource {
        const historyItemId =
            targetItem?.id ??
            this._peekUndoHistoryItemId(
                scope,
                glyphName,
                layerId,
                historyAction
            );

        return {
            historyItemId,
            historyItem: targetItem ?? this._findHistoryItemById(historyItemId)
        };
    }

    private _deriveBulkUndoScope(
        targets: Array<{ glyphName: string }>,
        layerId: string | null
    ): UndoScope {
        const glyphNames = new Set(targets.map((target) => target.glyphName));
        if (glyphNames.size !== 1) {
            return 'font';
        }
        if (layerId) {
            return 'layer';
        }
        return 'glyph';
    }

    private _getRemoteUpdateOrigin(remoteEntries?: ChangeLogEntry[]): string {
        if (!remoteEntries?.length) {
            return USER_EDIT_ORIGIN;
        }

        const targetItem = remoteEntries.find(
            (entry) => entry.historyAction === 'change'
        );
        const glyphNames = new Set(
            remoteEntries
                .map((entry) => this._deriveGlyphNameFromPath(entry.path))
                .filter((glyphName): glyphName is string => !!glyphName)
        );
        const layerKeys = new Set(
            remoteEntries
                .filter((entry) => entry.undoScope === 'layer')
                .map((entry) => {
                    const glyphName = this._deriveGlyphNameFromPath(entry.path);
                    const layerId = this._deriveLayerIdFromPath(entry.path);
                    return glyphName && layerId
                        ? getLayerManagerKey(glyphName, layerId)
                        : null;
                })
                .filter((key): key is string => !!key)
        );

        if (remoteEntries.some((entry) => entry.undoScope === 'font')) {
            return FONT_EDIT_ORIGIN;
        }
        // Composite/dependent layer packets still undo on the originating
        // layer surface. Treating extra replay glyphs as FONT_EDIT_ORIGIN
        // leaves the layer UndoManager empty, so linked windows cannot undo
        // after collaboration envelopes omit Yjs snapshot bodies.
        if (
            remoteEntries.some((entry) => entry.undoScope === 'layer') &&
            !remoteEntries.some((entry) => entry.undoScope === 'glyph')
        ) {
            const originating = remoteEntries.find(
                (entry) =>
                    !!entry.originatingGlyphName && !!entry.originatingLayerId
            );
            if (
                originating?.originatingGlyphName &&
                originating.originatingLayerId
            ) {
                return getLayerEditOrigin(
                    originating.originatingGlyphName,
                    originating.originatingLayerId
                );
            }
        }
        if (layerKeys.size === 1 && glyphNames.size === 1) {
            const entry =
                targetItem ??
                remoteEntries.find(
                    (candidate) =>
                        !!this._deriveGlyphNameFromPath(candidate.path) &&
                        !!this._deriveLayerIdFromPath(candidate.path)
                );
            if (entry) {
                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                if (glyphName && layerId) {
                    return getLayerEditOrigin(glyphName, layerId);
                }
            }
        }
        if (glyphNames.size === 1) {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
    }

    private _ensureUndoManagersForRemoteEntries(
        remoteEntries: ChangeLogEntry[]
    ): void {
        const glyphNames = new Set<string>();
        const layerTargets = new Map<
            string,
            { glyphName: string; layerId: string }
        >();

        for (const entry of remoteEntries) {
            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            const layerId = this._deriveLayerIdFromPath(entry.path);
            if (glyphName) {
                glyphNames.add(glyphName);
            }
            if (glyphName && layerId) {
                layerTargets.set(`${glyphName}@@${layerId}`, {
                    glyphName,
                    layerId
                });
            }
            if (entry.originatingGlyphName && entry.originatingLayerId) {
                layerTargets.set(
                    `${entry.originatingGlyphName}@@${entry.originatingLayerId}`,
                    {
                        glyphName: entry.originatingGlyphName,
                        layerId: entry.originatingLayerId
                    }
                );
            }
            for (const target of normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            )) {
                glyphNames.add(target.glyphName);
                layerTargets.set(
                    `${target.glyphName}@@${target.layerId}`,
                    target
                );
            }
        }

        for (const glyphName of glyphNames) {
            this.getGlyphUndoManager(glyphName);
        }
        for (const target of layerTargets.values()) {
            this.getLayerUndoManager(target.glyphName, target.layerId);
        }
    }

    private _getRemoteLayerSyncScopes(
        remoteEntries?: ChangeLogEntry[]
    ): Array<{ glyphName: string; layerId: string }> | null {
        if (!remoteEntries?.length) {
            return null;
        }

        if (
            remoteEntries.some((entry) => {
                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                return !!glyphName && !layerId;
            })
        ) {
            return null;
        }

        const targets = normalizeWorkerReplayTargets(
            remoteEntries.flatMap((entry) => {
                if (entry.workerReplayTargets?.length) {
                    return entry.workerReplayTargets;
                }

                if (entry.undoScope !== 'layer') {
                    return [];
                }

                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                return glyphName && layerId ? [{ glyphName, layerId }] : [];
            })
        );

        if (!targets.length) {
            return null;
        }

        return targets;
    }

    private _hasMaterializedLayerRoot(
        glyphName: string,
        layerId: string
    ): boolean {
        const glyphMap = this._glyphMapForName(glyphName);
        const layersMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const layerValue =
            layersMap instanceof Y.Map ? layersMap.get(layerId) : undefined;
        if (!(layerValue instanceof Y.Map)) {
            return false;
        }

        const layerSnapshot = fromYType(layerValue);
        if (
            !layerSnapshot ||
            typeof layerSnapshot !== 'object' ||
            Array.isArray(layerSnapshot)
        ) {
            return false;
        }

        const layerRecord = layerSnapshot as Record<string, unknown>;
        return (
            typeof layerRecord.id === 'string' &&
            layerRecord.id.length > 0 &&
            layerRecord.id === layerId
        );
    }

    private _resolveUndoHistoryItem(
        glyphName: string | undefined,
        layerId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): HistoryStackItem | null {
        const resolvedGlyphName = glyphName ?? null;
        const resolvedLayerId = layerId ?? null;
        const resolvedHistoryTargetKey = historyTargetKey ?? null;

        // Prefer the newest visible history item whose backing UndoManager
        // still has stack depth. This prevents stale change-log entries from
        // blocking undo/redo after branch edits clear a manager's stack.
        const candidates = buildHistoryStackItems(this._changeLog, {
            glyphName: resolvedGlyphName,
            layerId: resolvedLayerId,
            includeUndone: true,
            historyTargetKey: resolvedHistoryTargetKey,
            surface: surface ?? null
        }).filter((item) =>
            historyAction === 'undo' ? item.isActive : !item.isActive
        );

        for (let index = candidates.length - 1; index >= 0; index--) {
            const candidate = candidates[index];
            if (
                this._shouldReplayHistoryItemDirectly(candidate, historyAction)
            ) {
                return candidate;
            }
            const target = this._targetFromHistoryItem(
                candidate,
                resolvedGlyphName,
                resolvedLayerId
            );
            const { manager, scope } = this._getUndoManagerForTarget(target);
            if (scope === 'font') {
                return candidate;
            }
            if (!manager) {
                continue;
            }
            const stackDepth =
                historyAction === 'undo'
                    ? manager.undoStack.length
                    : manager.redoStack.length;
            if (stackDepth > 0) {
                return candidate;
            }
        }

        return resolveHistoryTargetItem(this._changeLog, {
            glyphName: resolvedGlyphName,
            layerId: resolvedLayerId,
            historyAction,
            historyTargetKey: resolvedHistoryTargetKey,
            surface: surface ?? null
        });
    }

    private _resolveUndoTarget(
        glyphName: string | undefined,
        layerId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        targetItem?: HistoryStackItem | null
    ): UndoTarget {
        if (targetItem) {
            return this._targetFromHistoryItem(
                targetItem,
                glyphName ?? null,
                layerId ?? null
            );
        }
        return {
            glyphName: glyphName ?? null,
            layerId: layerId ?? null
        };
    }

    private _deriveHistoryTarget(
        path: (string | number)[]
    ): HistoryTarget | null {
        if (!this._fontJson || path[0] !== 'features' || path.length < 3) {
            return null;
        }
        const fontFeatures = (this._fontJson as Unsafe).features;
        const features =
            fontFeatures &&
            typeof fontFeatures === 'object' &&
            Array.isArray((fontFeatures as Unsafe).features)
                ? ((fontFeatures as Unsafe).features as unknown[])
                : [];

        if (path[1] === 'prefixes' && typeof path[2] === 'string') {
            return {
                type: 'prefix',
                key: `prefix:${path[2]}`,
                label: String(path[2])
            };
        }

        if (path[1] === 'classes' && typeof path[2] === 'string') {
            return {
                type: 'class',
                key: `class:${path[2]}`,
                label: String(path[2])
            };
        }

        if (path[1] !== 'features') {
            return null;
        }

        let featureIndex = -1;
        if (typeof path[2] === 'number') {
            featureIndex = path[2];
        } else if (typeof path[2] === 'string') {
            const featuresMap = this.fontMap.get('features');
            if (featuresMap instanceof Y.Map) {
                const order = featuresMap.get('featureOrder');
                if (order instanceof Y.Array) {
                    featureIndex = (order.toArray() as string[]).indexOf(
                        path[2]
                    );
                }
            }
        }
        if (featureIndex < 0) {
            return null;
        }
        const featureEntry = features[featureIndex];
        if (!Array.isArray(featureEntry)) {
            return null;
        }

        const tag = String(featureEntry[0] ?? '');
        if (!tag) {
            return {
                type: 'feature',
                key: `feature-index:${featureIndex}`,
                label: `#${featureIndex + 1}`
            };
        }

        let occurrence = 0;
        for (let index = 0; index <= featureIndex; index++) {
            if (
                String(
                    (features[index] as unknown[] | undefined)?.[0] ?? ''
                ) === tag
            ) {
                occurrence += 1;
            }
        }

        return {
            type: 'feature',
            key: `feature:${tag}:${occurrence}`,
            label: occurrence > 1 ? `${tag} #${occurrence}` : tag
        };
    }

    private _getPathSegments(path: string): string[] {
        return getPathSegments(path);
    }

    private _deriveGlyphNameFromPath(path: string): string | null {
        return deriveGlyphNameFromPath(path);
    }

    private _deriveLayerIdFromPath(path: string): string | null {
        return deriveLayerIdFromPath(path);
    }

    private _parseEntryPath(path: string): (string | number)[] {
        return this._getPathSegments(path).map((segment) =>
            /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment
        );
    }

    private _applyHistoryItem(
        item: HistoryStackItem,
        direction: 'undo' | 'redo'
    ): WorkerReplayTarget[] {
        const resettleDerivedLayers =
            shouldResettleDerivedLayersOnHistoryReplay(
                item,
                !!this._getResettleFontModel()
            );
        const orderedEntries =
            direction === 'undo' ? [...item.entries].reverse() : item.entries;
        const replayEntries = resettleDerivedLayers
            ? orderedEntries.filter(
                  (entry) =>
                      !isDerivedLayerChangePath(
                          entry.path,
                          item.originatingGlyphName
                      )
              )
            : orderedEntries;

        let writtenTargets: WorkerReplayTarget[] = [];
        const itemRenames = this._collectGlyphRenamesFromEntries(replayEntries);
        if (direction === 'undo') {
            this._applyGlyphNameRemapsFromEntries(replayEntries, direction);
        }
        const entriesByDocument = new Map<string, ChangeLogEntry[]>();
        for (const entry of replayEntries) {
            const documentId = this._documentIdForHistoryEntry(
                entry,
                itemRenames
            );
            const bucket = entriesByDocument.get(documentId) || [];
            bucket.push(entry);
            entriesByDocument.set(documentId, bucket);
        }
        for (const [documentId, entries] of entriesByDocument) {
            const doc = this._docForId(documentId) || this.yDoc;
            doc.transact(() => {
                for (const entry of entries) {
                    this._applyHistoryReplayEntry(
                        entry,
                        direction,
                        itemRenames
                    );
                }
            }, HISTORY_REPLAY_ORIGIN);
        }
        if (direction === 'redo') {
            this._applyGlyphNameRemapsFromEntries(replayEntries, direction);
        }
        if (resettleDerivedLayers) {
            writtenTargets = this._resettleDerivedLayersAfterOriginReplay(item);
        }

        return writtenTargets;
    }

    private _applyHistoryReplayEntry(
        entry: ChangeLogEntry,
        direction: 'undo' | 'redo',
        itemRenames: GlyphRename[] = []
    ): void {
        const replayValue = this._getHistoryReplayValue(entry, direction);
        if (entry.path === 'font') {
            this._applyFontSnapshot(replayValue);
            return;
        }
        const path = this._toYDocPath(this._parseEntryPath(entry.path));
        if (path[0] === 'glyphs' && path.length >= 2) {
            path[1] = this._liveGlyphName(String(path[1]), [
                ...normalizeGlyphRenames(entry.glyphRenames),
                ...itemRenames
            ]);
        }
        if (
            path.length === 3 &&
            path[0] === 'glyphs' &&
            path[2] === 'name' &&
            typeof replayValue === 'string'
        ) {
            const glyphMap = this._glyphMapForName(String(path[1]));
            if (glyphMap instanceof Y.Map) {
                glyphMap.set('name', replayValue);
            }
            return;
        }
        if (this._isGlyphRootPath(path) && replayValue) {
            this._applyGlyphSnapshot(String(path[1]), replayValue);
            return;
        }
        if (
            path.length === 4 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            typeof path[1] === 'string' &&
            typeof path[3] === 'string' &&
            replayValue !== undefined
        ) {
            this._applyLayerDelta(path[1], path[3], replayValue);
            return;
        }
        if (direction === 'undo') {
            if (entry.op === 'add') {
                this._deleteRoutedYPath(path);
                return;
            }
            if (entry.op === 'remove' || entry.op === 'set') {
                if (entry.op === 'set' && replayValue === undefined) {
                    this._deleteRoutedYPath(path);
                } else {
                    this._setRoutedYPath(path, replayValue);
                }
            }
            return;
        }

        if (entry.op === 'remove') {
            this._deleteRoutedYPath(path);
            return;
        }
        this._setRoutedYPath(path, replayValue);
    }

    private _getResettleFontModel(): FontModelLike | null {
        const fontModel = window.fontManager?.currentFont?.fontModel as
            FontModelLike | undefined;
        if (!fontModel || typeof fontModel.findGlyph !== 'function') {
            return null;
        }
        if (
            typeof fontModel.rebuildAutomaticCompositesForGlyphs !==
                'function' &&
            typeof fontModel.recomputeMetricsKeys !== 'function'
        ) {
            return null;
        }
        return fontModel;
    }

    private _collectOriginLayerTargets(
        item: HistoryStackItem,
        entries: ChangeLogEntry[]
    ): WorkerReplayTarget[] {
        return normalizeWorkerReplayTargets([
            item.originatingGlyphName && item.originatingLayerId
                ? {
                      glyphName: item.originatingGlyphName,
                      layerId: item.originatingLayerId
                  }
                : null,
            ...entries.map((entry) => ({
                glyphName: deriveGlyphNameFromPath(entry.path) || '',
                layerId: deriveLayerIdFromPath(entry.path) || ''
            }))
        ]);
    }

    private _getFontJsonLayer(
        glyphName: string,
        layerId: string
    ): Record<string, unknown> | null {
        const glyphs = Array.isArray(this._fontJson?.glyphs)
            ? (this._fontJson.glyphs as Unsafe[])
            : [];
        const glyphJson = glyphs.find((glyph) => glyph?.name === glyphName);
        const layerJson = Array.isArray(glyphJson?.layers)
            ? (glyphJson.layers as Unsafe[]).find(
                  (layer) => layer?.id === layerId
              )
            : null;
        if (!layerJson || typeof layerJson !== 'object') {
            return null;
        }
        return layerJson as Record<string, unknown>;
    }

    private _resettleDerivedLayersAfterOriginReplay(
        item: HistoryStackItem
    ): WorkerReplayTarget[] {
        const fontModel = this._getResettleFontModel();
        const originTargets = this._collectOriginLayerTargets(
            item,
            item.entries.filter(
                (entry) =>
                    !isDerivedLayerChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
            )
        );
        if (!fontModel) {
            return originTargets;
        }

        if (originTargets.length) {
            this._syncPatchedLayerTargetsFromYDoc(originTargets);
        }

        const editKinds = deriveEditKindsFromChangeLogEntries(
            item.entries.filter(
                (entry) =>
                    !isDerivedLayerChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
            )
        );
        if (editKinds.size === 0 || !originTargets.length) {
            return originTargets;
        }

        const sourceTarget = originTargets[0];
        const closure = computeLayerRecompositionClosure({
            sourceTargets: originTargets,
            editKinds,
            scope: 'all',
            fontModel,
            activeLayerId: sourceTarget?.layerId ?? item.originatingLayerId,
            sourceGlyphName:
                sourceTarget?.glyphName ?? item.originatingGlyphName,
            suppressor: this
        });

        const originatingGlyphName = item.originatingGlyphName ?? null;
        const derivedTargets = closure.recomposeTargets.filter((target) => {
            if (
                originatingGlyphName &&
                target.glyphName === originatingGlyphName
            ) {
                return false;
            }
            return !!this._getFontJsonLayer(target.glyphName, target.layerId);
        });
        for (const target of derivedTargets) {
            this._applySettledLayerFromFontJson(
                target.glyphName,
                target.layerId
            );
        }
        return normalizeWorkerReplayTargets([
            ...originTargets,
            ...derivedTargets
        ]);
    }

    private _applySettledLayerFromFontJson(
        glyphName: string,
        layerId: string
    ): void {
        const layerJson = this._getFontJsonLayer(glyphName, layerId);
        if (!layerJson) {
            return;
        }
        const glyphMap = this._glyphMapForName(glyphName);
        const layersMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const yLayerMap =
            layersMap instanceof Y.Map ? layersMap.get(layerId) : null;
        if (!(yLayerMap instanceof Y.Map)) {
            return;
        }

        const yLayerJson = fromYType(yLayerMap) as Record<string, unknown>;
        const delta: Record<string, unknown> = { id: layerId };
        let hasChanges = false;
        for (const [key, value] of Object.entries(layerJson)) {
            if (JSON.stringify(value) === JSON.stringify(yLayerJson?.[key])) {
                continue;
            }
            delta[key] = cloneHistoryValue(value);
            hasChanges = true;
        }
        for (const key of Object.keys(yLayerJson || {})) {
            if (key === 'id' || key in layerJson) {
                continue;
            }
            delta[key] = null;
            hasChanges = true;
        }
        if (!hasChanges) {
            return;
        }
        this._applyLayerDelta(glyphName, layerId, delta);
    }

    private _getHistoryReplayValue(
        entry: ChangeLogEntry,
        direction: 'undo' | 'redo'
    ): unknown {
        if (direction === 'undo') {
            return entry.replayOldValue ?? entry.oldValue;
        }
        return entry.replayNewValue ?? entry.newValue;
    }

    private _cloneReplayValue(value: unknown): unknown {
        return value === undefined ? undefined : cloneHistoryValue(value);
    }

    private _prepareLayerSnapshotForHistory(
        layerId: string,
        layerJson: unknown,
        existingLayerJson: unknown
    ): Record<string, unknown> {
        return this._normalizeLayerSnapshot(
            layerId,
            this._prepareStorageValue(layerJson),
            existingLayerJson
        ) as Record<string, unknown>;
    }

    private _prepareStorageValue(value: unknown): unknown {
        const stripEditorIds = (
            candidate: unknown,
            isShapeEntry = false,
            isNodeEntry = false
        ): unknown => {
            if (Array.isArray(candidate)) {
                return candidate.map((item) =>
                    stripEditorIds(item, isShapeEntry, isNodeEntry)
                );
            }
            if (!candidate || typeof candidate !== 'object') {
                return candidate;
            }

            const record = omitRestingLayerRuntimeKeys(
                candidate as Record<string, unknown>
            );
            const isPathOrComponent =
                isShapeEntry &&
                (Object.prototype.hasOwnProperty.call(record, 'nodes') ||
                    Object.prototype.hasOwnProperty.call(record, 'reference'));
            const storageRecord =
                isPathOrComponent || isNodeEntry
                    ? (() => {
                          const { id: _id, ...withoutId } = record;
                          return withoutId;
                      })()
                    : { ...record };

            return Object.fromEntries(
                Object.entries(storageRecord).map(([key, item]) => [
                    key,
                    stripEditorIds(item, key === 'shapes', key === 'nodes')
                ])
            );
        };

        return stripEditorIds(cloneHistoryValue(value));
    }

    private _cloneRuntimeValue(value: unknown): unknown {
        return cloneHistoryValue(value);
    }

    private _shouldReplayHistoryItemDirectly(
        item: HistoryStackItem | null | undefined,
        direction: 'undo' | 'redo'
    ): boolean {
        if (!item) {
            return false;
        }
        const resettleDerivedLayers =
            shouldResettleDerivedLayersOnHistoryReplay(
                item,
                !!this._getResettleFontModel()
            );
        return this._canReplayHistoryItemDirectly(
            item,
            direction,
            resettleDerivedLayers
        );
    }

    private _canReplayHistoryItemDirectly(
        item: HistoryStackItem,
        direction: 'undo' | 'redo',
        originEntriesOnly = false
    ): boolean {
        const entries = originEntriesOnly
            ? item.entries.filter(
                  (entry) =>
                      !isDerivedLayerChangePath(
                          entry.path,
                          item.originatingGlyphName
                      )
              )
            : item.entries;
        if (!entries.length) {
            return false;
        }

        return entries.every((entry) => {
            // Direct replay supports 'set', 'add', and 'remove' ops.
            // 'add' on undo → deleteYPath (no replay value needed).
            // 'remove' on redo → deleteYPath (no replay value needed).
            // 'set' needs a replay value, except undo of a newly created
            // property (undefined old value) which deletes the path.
            const needsReplayValue =
                entry.op === 'set' ||
                (entry.op === 'remove' && direction === 'undo') ||
                (entry.op === 'add' && direction === 'redo');

            if (needsReplayValue) {
                const replayValue =
                    direction === 'undo'
                        ? entry.replayOldValue
                        : entry.replayNewValue;
                if (replayValue === undefined) {
                    if (!(entry.op === 'set' && direction === 'undo')) {
                        return false;
                    }
                    // Newly created property: undo deletes it via history replay.
                } else {
                    const path = this._toYDocPath(
                        this._parseEntryPath(entry.path)
                    );

                    if (this._isGlyphRootPath(path)) {
                        return !!replayValue && typeof replayValue === 'object';
                    }

                    if (
                        path.length === 4 &&
                        path[0] === 'glyphs' &&
                        path[2] === 'layers' &&
                        typeof path[1] === 'string' &&
                        typeof path[3] === 'string'
                    ) {
                        return !!replayValue && typeof replayValue === 'object';
                    }
                }
            }

            return true;
        });
    }

    private _isGlyphRootPath(path: (string | number)[]): boolean {
        return path.length === 2 && path[0] === 'glyphs' && !!path[1];
    }

    /** Glyph names in current font JSON array order (model / `_fontJson`). */
    private _glyphNamesFromFontJson(): string[] {
        if (!this._fontJson) {
            return [];
        }
        const glyphs = (this._fontJson as Record<string, unknown>).glyphs;
        if (!Array.isArray(glyphs)) {
            return [];
        }
        return glyphs
            .map((glyph) =>
                glyph && typeof glyph === 'object'
                    ? String(
                          (glyph as Record<string, unknown>).name || ''
                      ).trim()
                    : ''
            )
            .filter((name) => name.length > 0);
    }

    private _readYGlyphOrderNames(): string[] {
        const glyphOrder = this.fontMap.get('glyphOrder');
        if (glyphOrder instanceof Y.Array) {
            return glyphOrder.toArray().map(String);
        }
        return [];
    }

    /**
     * When the model array already reflects an add/remove, emit a `glyphOrder`
     * set so Yjs order matches insert position (not map-append order).
     */
    private _createModelGlyphOrderSyncOperation(
        glyphName: string,
        mode: 'add' | 'remove'
    ): TransactionBufferedOperation | null {
        const nextOrder = this._glyphNamesFromFontJson();
        const nameInModel = nextOrder.includes(glyphName);
        if (mode === 'add' && !nameInModel) {
            return null;
        }
        if (mode === 'remove' && nameInModel) {
            return null;
        }
        const oldOrder = this._readYGlyphOrderNames();
        if (
            oldOrder.length === nextOrder.length &&
            oldOrder.every((name, index) => name === nextOrder[index])
        ) {
            return null;
        }
        return {
            op: 'set',
            path: ['glyphOrder'],
            oldValue: oldOrder,
            newValue: [...nextOrder]
        };
    }

    private _createGlyphOrderRemoveOperation(
        glyphName: string
    ): TransactionBufferedOperation | null {
        const oldOrder = this._readYGlyphOrderNames();
        const nextOrder = oldOrder.filter((name) => name !== glyphName);
        if (nextOrder.length === oldOrder.length) {
            return null;
        }
        return {
            op: 'set',
            path: ['glyphOrder'],
            oldValue: oldOrder,
            newValue: nextOrder
        };
    }

    /**
     * Replace a Y.Array's contents without replacing the array object itself.
     * This keeps the shared container identity stable across windows.
     *
     * Uses LCS-based minimal diff (diffYArray) instead of full teardown
     * to produce smaller Yjs deltas for length-changing edits to
     * features.features, kern-group lists, and codepoints.
     */
    private _replaceYArrayContents(
        targetArray: Y.Array<unknown>,
        nextValues: unknown[]
    ): void {
        diffYArray(targetArray, nextValues);
    }

    private _replaceYArrayEntry(
        targetArray: Y.Array<unknown>,
        index: number,
        nextValue: unknown
    ): void {
        const currentValue = targetArray.get(index);
        const currentJsonValue =
            currentValue instanceof Y.Map || currentValue instanceof Y.Array
                ? fromYType(currentValue)
                : currentValue;

        if (this._isDeepEqual(currentJsonValue, nextValue)) {
            return;
        }

        if (Array.isArray(nextValue)) {
            if (currentValue instanceof Y.Array) {
                this._replaceYArrayContents(currentValue, nextValue);
            } else {
                targetArray.delete(index, 1);
                targetArray.insert(index, [toYType(nextValue)]);
            }
            return;
        }

        if (
            nextValue &&
            typeof nextValue === 'object' &&
            !Array.isArray(nextValue)
        ) {
            const nextRecord = nextValue as Record<string, unknown>;
            if (currentValue instanceof Y.Map) {
                this._replaceYMapContents(currentValue, nextRecord);
            } else {
                targetArray.delete(index, 1);
                targetArray.insert(index, [toYType(nextRecord)]);
            }
            return;
        }

        targetArray.delete(index, 1);
        targetArray.insert(index, [nextValue]);
    }

    /**
     * Replace a Y.Map's entries in place, deleting keys absent from the
     * incoming snapshot and recursively reusing nested shared containers.
     */
    private _replaceYMapContents(
        targetMap: Y.Map<unknown>,
        nextRecord: Record<string, unknown>
    ): void {
        replaceYMapContents(targetMap, nextRecord);
    }

    /**
     * Replace one Y.Map entry while preserving nested Y.Map/YArray objects
     * when the incoming value has the same container shape.
     */
    private _replaceYMapEntry(
        targetMap: Y.Map<unknown>,
        key: string,
        nextValue: unknown
    ): void {
        const currentValue = targetMap.get(key);
        const currentJsonValue =
            currentValue instanceof Y.Map || currentValue instanceof Y.Array
                ? fromYType(currentValue)
                : currentValue;

        if (this._isDeepEqual(currentJsonValue, nextValue)) {
            return;
        }

        if (Array.isArray(nextValue)) {
            if (currentValue instanceof Y.Array) {
                this._replaceYArrayContents(currentValue, nextValue);
            } else {
                targetMap.set(key, toYType(nextValue));
            }
            return;
        }

        if (
            nextValue &&
            typeof nextValue === 'object' &&
            !Array.isArray(nextValue)
        ) {
            const nextRecord = nextValue as Record<string, unknown>;
            if (currentValue instanceof Y.Map) {
                this._replaceYMapContents(currentValue, nextRecord);
            } else {
                const nestedMap = new Y.Map<unknown>();
                targetMap.set(key, nestedMap);
                this._replaceYMapContents(nestedMap, nextRecord);
            }
            return;
        }

        targetMap.set(key, nextValue);
    }

    private _replaceLayerMapContents(
        layerMap: Y.Map<unknown>,
        nextRecord: Record<string, unknown>
    ): void {
        const existingRecord = fromYType(layerMap) as Record<
            string,
            unknown
        > | null;
        const sanitizedRecord = toRestingLayerJson(nextRecord, {
            existing: existingRecord,
            mode: 'replace',
            context: 'Y.Doc write'
        });
        const nextKeys = new Set(Object.keys(sanitizedRecord));
        const indexedStorageKeysToKeep = new Set<string>();
        for (const key of nextKeys) {
            const mapping = INDEXED_MAP_KEYS[key];
            if (mapping) {
                indexedStorageKeysToKeep.add(mapping.byId);
                indexedStorageKeysToKeep.add(mapping.order);
            }
        }

        layerMap.forEach((_value: unknown, key: string) => {
            if (
                nextKeys.has(key) ||
                indexedStorageKeysToKeep.has(key) ||
                (RESTING_LAYER_IDENTITY_KEYS as readonly string[]).includes(key)
            ) {
                return;
            }

            layerMap.delete(key);
        });

        for (const runtimeKey of RESTING_LAYER_RUNTIME_KEYS) {
            layerMap.delete(runtimeKey);
        }

        for (const [key, value] of Object.entries(sanitizedRecord)) {
            if (key === 'shapes' && Array.isArray(value)) {
                writeLayerGeometry(layerMap, value, toYType);
                continue;
            }
            const mapping = INDEXED_MAP_KEYS[key];
            if (mapping) {
                layerMap.delete(key);
                if (Array.isArray(value)) {
                    applyIndexedMapArrayToYMap(layerMap, key, value);
                    continue;
                }
                layerMap.delete(mapping.byId);
                layerMap.delete(mapping.order);
            }

            this._replaceYMapEntry(layerMap, key, value);
        }
    }

    private _applyGlyphSnapshot(
        glyphName: string,
        glyphSnapshot: unknown
    ): void {
        if (!glyphSnapshot || typeof glyphSnapshot !== 'object') {
            this._removeGlyphDoc(glyphName);
            return;
        }

        const glyphRecord = glyphSnapshot as Record<string, unknown>;
        const glyphId = ensureImmutableGlyphId(glyphRecord);
        this._ensureGlyphDoc(glyphId, glyphName);
        let glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }

        const existingGlyphSnapshot =
            fromYType(glyphMap) ??
            (this._fontJson as Unsafe)?.glyphs?.find(
                (glyph: Record<string, unknown>) => glyph?.name === glyphName
            );
        const glyphJson = this._normalizeGlyphSnapshot(
            glyphSnapshot,
            existingGlyphSnapshot
        ) as Record<string, unknown>;

        for (const [gk, gv] of Object.entries(glyphJson)) {
            if (gk === 'layers' && Array.isArray(gv)) {
                let layersMap = glyphMap.get('layers') as
                    Y.Map<unknown> | undefined;
                if (!(layersMap instanceof Y.Map)) {
                    layersMap = new Y.Map<unknown>();
                    glyphMap.set('layers', layersMap);
                }

                const nextLayerIds = new Set<string>();
                for (const layerJson of gv as Record<string, unknown>[]) {
                    const layerId = (layerJson.id as string) ?? '';
                    if (!layerId) {
                        continue;
                    }
                    nextLayerIds.add(layerId);
                    // Patch the existing layerMap in place to preserve the
                    // Y.Map instance reference so layer UndoManagers (which
                    // register on the specific Y.Map object) remain valid
                    // after a glyph snapshot is applied.
                    let layerMap = layersMap.get(layerId) as
                        Y.Map<unknown> | undefined;
                    if (!(layerMap instanceof Y.Map)) {
                        layerMap = new Y.Map<unknown>();
                        layersMap.set(layerId, layerMap);
                    }
                    const normalizedLayerJson = this._normalizeLayerSnapshot(
                        layerId,
                        layerJson,
                        fromYType(layerMap)
                    ) as Record<string, unknown>;
                    this._replaceLayerMapContents(
                        layerMap,
                        normalizedLayerJson
                    );
                }

                // Remove layers that are no longer in the snapshot
                layersMap.forEach((_value: unknown, key: string) => {
                    if (!nextLayerIds.has(key)) {
                        layersMap?.delete(key);
                    }
                });
                setYPath(glyphMap, ['layerOrder'], Array.from(nextLayerIds));
                continue;
            }

            this._replaceYMapEntry(glyphMap, gk, gv);
        }

        // Remove glyph-level keys no longer in the snapshot
        const glyphKeys = new Set(Object.keys(glyphJson));
        if (Array.isArray(glyphJson.layers)) {
            glyphKeys.add('layerOrder');
        }
        glyphMap.forEach((_value: unknown, key: string) => {
            if (!glyphKeys.has(key)) {
                glyphMap?.delete(key);
            }
        });
    }

    private _applyFontSnapshot(fontSnapshot: unknown): void {
        if (
            !fontSnapshot ||
            typeof fontSnapshot !== 'object' ||
            Array.isArray(fontSnapshot)
        ) {
            return;
        }

        const normalizedSnapshot = this._normalizeFontSnapshot(
            fontSnapshot,
            this._fontJson
        ) as Record<string, unknown>;
        const nextGlyphs = this._coerceFontGlyphSnapshots(
            normalizedSnapshot.glyphs
        );
        const nextGlyphNames = new Set<string>();

        for (const glyph of nextGlyphs) {
            const glyphName =
                glyph && typeof glyph === 'object'
                    ? String((glyph as Record<string, unknown>).name || '')
                    : '';
            if (!glyphName) {
                continue;
            }
            nextGlyphNames.add(glyphName);
            this._applyGlyphSnapshot(glyphName, glyph);
        }

        const knownNames = new Set(this._glyphIdByName.keys());
        for (const glyphName of knownNames) {
            if (!nextGlyphNames.has(glyphName)) {
                this._removeGlyphDoc(glyphName);
            }
        }
        setYPath(this.fontMap, ['glyphOrder'], [...nextGlyphNames]);

        const nextKeys = new Set(Object.keys(normalizedSnapshot));
        for (const [key, value] of Object.entries(normalizedSnapshot)) {
            if (key === 'glyphs' || key === 'glyphOrder') {
                continue;
            }
            this._replaceYMapEntry(this.fontMap, key, value);
        }
        this.fontMap.forEach((_value: unknown, key: string) => {
            if (
                key !== 'glyphs' &&
                key !== 'glyphOrder' &&
                !nextKeys.has(key)
            ) {
                this.fontMap.delete(key);
            }
        });
    }

    private _normalizeFontSnapshot(
        fontSnapshot: unknown,
        existingFontSnapshot?: unknown
    ): unknown {
        if (
            !fontSnapshot ||
            typeof fontSnapshot !== 'object' ||
            Array.isArray(fontSnapshot)
        ) {
            return fontSnapshot;
        }

        const existingFontRecord =
            existingFontSnapshot &&
            typeof existingFontSnapshot === 'object' &&
            !Array.isArray(existingFontSnapshot)
                ? (cloneHistoryValue(existingFontSnapshot) as Record<
                      string,
                      unknown
                  >)
                : {};
        const normalizedFontRecord = cloneHistoryValue(fontSnapshot) as Record<
            string,
            unknown
        >;

        if (
            Object.prototype.hasOwnProperty.call(normalizedFontRecord, 'glyphs')
        ) {
            const incomingGlyphs = this._coerceFontGlyphSnapshots(
                normalizedFontRecord.glyphs
            );
            const existingGlyphs = this._coerceFontGlyphSnapshots(
                existingFontRecord.glyphs
            );
            const existingGlyphsByName = new Map(
                existingGlyphs
                    .filter(
                        (glyph): glyph is Record<string, unknown> =>
                            !!glyph && typeof glyph === 'object'
                    )
                    .map((glyph) => [String(glyph.name || ''), glyph])
            );

            normalizedFontRecord.glyphs = incomingGlyphs
                .map((glyph) => {
                    const glyphName =
                        glyph && typeof glyph === 'object'
                            ? String(glyph.name || '')
                            : '';
                    if (!glyphName) {
                        return null;
                    }

                    return this._normalizeGlyphSnapshot(
                        glyph,
                        existingGlyphsByName.get(glyphName)
                    );
                })
                .filter((glyph): glyph is Record<string, unknown> => !!glyph);
        }

        return normalizedFontRecord;
    }

    private _coerceFontGlyphSnapshots(
        glyphsSnapshot: unknown
    ): Array<Record<string, unknown>> {
        if (Array.isArray(glyphsSnapshot)) {
            return glyphsSnapshot.filter(
                (glyph): glyph is Record<string, unknown> =>
                    !!glyph &&
                    typeof glyph === 'object' &&
                    !Array.isArray(glyph)
            );
        }

        if (
            glyphsSnapshot &&
            typeof glyphsSnapshot === 'object' &&
            !Array.isArray(glyphsSnapshot)
        ) {
            return Object.entries(glyphsSnapshot as Record<string, unknown>)
                .filter(([, glyph]) => !!glyph && typeof glyph === 'object')
                .map(([glyphName, glyph]) => {
                    const glyphRecord = cloneHistoryValue(glyph) as Record<
                        string,
                        unknown
                    >;
                    if (
                        typeof glyphRecord.name !== 'string' ||
                        !glyphRecord.name.length
                    ) {
                        glyphRecord.name = glyphName;
                    }
                    return glyphRecord;
                });
        }

        return [];
    }

    private _normalizeGlyphSnapshot(
        glyphSnapshot: unknown,
        existingGlyphSnapshot?: unknown,
        options?: { strictLayers?: boolean; ignoreExisting?: boolean }
    ): unknown {
        if (
            !glyphSnapshot ||
            typeof glyphSnapshot !== 'object' ||
            Array.isArray(glyphSnapshot)
        ) {
            return glyphSnapshot;
        }

        const ignoreExisting = options?.ignoreExisting === true;
        const existingGlyphRecord =
            !ignoreExisting &&
            existingGlyphSnapshot &&
            typeof existingGlyphSnapshot === 'object' &&
            !Array.isArray(existingGlyphSnapshot)
                ? (cloneHistoryValue(existingGlyphSnapshot) as Record<
                      string,
                      unknown
                  >)
                : {};
        const incomingGlyphRecord = cloneHistoryValue(glyphSnapshot) as Record<
            string,
            unknown
        >;
        const mergedGlyphRecord = ignoreExisting
            ? { ...incomingGlyphRecord }
            : {
                  ...existingGlyphRecord,
                  ...incomingGlyphRecord
              };

        if (
            Object.prototype.hasOwnProperty.call(incomingGlyphRecord, 'layers')
        ) {
            const incomingLayers = this._coerceGlyphLayerSnapshots(
                incomingGlyphRecord.layers
            );
            const existingLayers = this._coerceGlyphLayerSnapshots(
                existingGlyphRecord.layers
            );
            const existingLayersById = new Map(
                existingLayers
                    .filter(
                        (layer): layer is Record<string, unknown> =>
                            !!layer && typeof layer === 'object'
                    )
                    .map((layer) => [String(layer.id || ''), layer])
            );

            mergedGlyphRecord.layers = incomingLayers
                .map((layer) => {
                    const layerId =
                        layer && typeof layer === 'object'
                            ? String(layer.id || '')
                            : '';
                    if (!layerId) {
                        if (options?.strictLayers) {
                            throw new Error(
                                'malformed glyph snapshot: layer missing id'
                            );
                        }
                        return null;
                    }
                    return this._normalizeLayerSnapshot(
                        layerId,
                        layer,
                        ignoreExisting
                            ? undefined
                            : existingLayersById.get(layerId),
                        !ignoreExisting
                    );
                })
                .filter((layer): layer is Record<string, unknown> => !!layer);
        }

        return mergedGlyphRecord;
    }

    private _coerceGlyphLayerSnapshots(
        layersSnapshot: unknown
    ): Array<Record<string, unknown>> {
        if (Array.isArray(layersSnapshot)) {
            return layersSnapshot.filter(
                (layer): layer is Record<string, unknown> =>
                    !!layer &&
                    typeof layer === 'object' &&
                    !Array.isArray(layer)
            );
        }

        if (
            layersSnapshot &&
            typeof layersSnapshot === 'object' &&
            !Array.isArray(layersSnapshot)
        ) {
            return Object.entries(layersSnapshot as Record<string, unknown>)
                .filter(([, layer]) => !!layer && typeof layer === 'object')
                .map(([layerId, layer]) => {
                    const layerRecord = cloneHistoryValue(layer) as Record<
                        string,
                        unknown
                    >;
                    if (
                        typeof layerRecord.id !== 'string' ||
                        !layerRecord.id.length
                    ) {
                        layerRecord.id = layerId;
                    }
                    return layerRecord;
                });
        }

        return [];
    }

    private _canonicalizeFullStateRawFontJson(): void {
        const fontJson = this._fontJson as Unsafe;
        if (
            !fontJson ||
            typeof fontJson !== 'object' ||
            Array.isArray(fontJson)
        ) {
            return;
        }

        const masterNameById = new Map<string, string>();
        const masters = Array.isArray(fontJson.masters)
            ? (fontJson.masters as Unsafe[])
            : [];

        for (const master of masters) {
            if (
                !master ||
                typeof master !== 'object' ||
                Array.isArray(master)
            ) {
                continue;
            }

            const masterId =
                typeof master.id === 'string' && master.id.length
                    ? master.id
                    : '';
            const masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name &&
                        typeof master.name === 'object' &&
                        typeof (master.name as Record<string, unknown>).dflt ===
                            'string'
                      ? String(
                            (master.name as Record<string, unknown>).dflt || ''
                        )
                      : '';

            if (masterId && masterName) {
                masterNameById.set(masterId, masterName);
            }
        }

        const glyphs = Array.isArray(fontJson.glyphs)
            ? (fontJson.glyphs as Unsafe[])
            : [];
        for (const glyph of glyphs) {
            if (!glyph || typeof glyph !== 'object' || Array.isArray(glyph)) {
                continue;
            }

            const layers = Array.isArray(glyph.layers)
                ? (glyph.layers as Unsafe[])
                : [];
            for (const layer of layers) {
                if (
                    !layer ||
                    typeof layer !== 'object' ||
                    Array.isArray(layer)
                ) {
                    continue;
                }

                if (layer.height === undefined) {
                    delete layer.height;
                }
                if (layer.vertWidth === undefined) {
                    delete layer.vertWidth;
                }
                if (layer.isInterpolated === false) {
                    delete layer.isInterpolated;
                }
                if (layer.name === undefined) {
                    delete layer.name;
                }

                const master = layer.master;
                if (
                    !master ||
                    typeof master !== 'object' ||
                    Array.isArray(master) ||
                    master.type !== 'DefaultForMaster' ||
                    typeof master.master !== 'string' ||
                    !master.master.length
                ) {
                    continue;
                }

                const masterName = masterNameById.get(master.master);
                if (
                    typeof layer.name === 'string' &&
                    (!layer.name.length ||
                        (masterName && layer.name === masterName))
                ) {
                    delete layer.name;
                }
            }
        }
    }

    private _getKnownMasterIds(): Set<string> {
        const masterIds = new Set<string>();
        const masters = (this._fontJson as Unsafe)?.masters;
        if (!Array.isArray(masters)) {
            return masterIds;
        }

        for (const master of masters) {
            const masterId =
                master && typeof master === 'object'
                    ? String((master as Record<string, unknown>).id || '')
                    : '';
            if (masterId) {
                masterIds.add(masterId);
            }
        }

        return masterIds;
    }

    private _normalizeLayerMasterSnapshot(
        layerId: string,
        layerRecord: Record<string, unknown>,
        existingLayerRecord: Record<string, unknown>
    ): void {
        const normalizeMasterValue = (
            masterValue: unknown
        ): Record<string, unknown> | null => {
            if (!masterValue || typeof masterValue !== 'object') {
                if (typeof masterValue === 'string' && masterValue.length) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue
                    };
                }
                return null;
            }

            if (Array.isArray(masterValue)) {
                return null;
            }

            const masterRecord = cloneHistoryValue(masterValue) as Record<
                string,
                unknown
            >;

            if (masterRecord.type === 'FreeFloating') {
                return { type: 'FreeFloating' };
            }

            if (
                (masterRecord.type === 'DefaultForMaster' ||
                    masterRecord.type === 'AssociatedWithMaster') &&
                typeof masterRecord.master === 'string' &&
                masterRecord.master.length
            ) {
                return {
                    type: masterRecord.type,
                    master: masterRecord.master
                };
            }

            if (
                typeof masterRecord.master === 'string' &&
                masterRecord.master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.master
                };
            }

            if (
                typeof masterRecord.DefaultForMaster === 'string' &&
                masterRecord.DefaultForMaster.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.DefaultForMaster
                };
            }

            if (
                typeof masterRecord.default_for_master === 'string' &&
                masterRecord.default_for_master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.default_for_master
                };
            }

            if (
                typeof masterRecord.AssociatedWithMaster === 'string' &&
                masterRecord.AssociatedWithMaster.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: masterRecord.AssociatedWithMaster
                };
            }

            if (
                typeof masterRecord.associated_with_master === 'string' &&
                masterRecord.associated_with_master.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: masterRecord.associated_with_master
                };
            }

            if ('FreeFloating' in masterRecord) {
                return { type: 'FreeFloating' };
            }

            return null;
        };

        const normalizedMaster =
            normalizeMasterValue(layerRecord.master) ??
            normalizeMasterValue(existingLayerRecord.master);

        if (normalizedMaster) {
            layerRecord.master = normalizedMaster;
            return;
        }

        if (
            layerRecord.is_background !== true &&
            this._getKnownMasterIds().has(layerId)
        ) {
            layerRecord.master = {
                type: 'DefaultForMaster',
                master: layerId
            };
        }
    }

    private _normalizeLayerSnapshot(
        layerId: string,
        layerSnapshot: unknown,
        existingLayerSnapshot?: unknown,
        preserveMissingKeys = true,
        isExistingFresh?: boolean
    ): unknown {
        if (
            !layerSnapshot ||
            typeof layerSnapshot !== 'object' ||
            Array.isArray(layerSnapshot)
        ) {
            return layerSnapshot;
        }

        const existingLayerRecord =
            existingLayerSnapshot &&
            typeof existingLayerSnapshot === 'object' &&
            !Array.isArray(existingLayerSnapshot)
                ? isExistingFresh
                    ? (existingLayerSnapshot as Record<string, unknown>)
                    : (cloneHistoryValue(existingLayerSnapshot) as Record<
                          string,
                          unknown
                      >)
                : {};
        const incomingLayerRecord = cloneHistoryValue(layerSnapshot) as Record<
            string,
            unknown
        >;
        const mergedLayerRecord = preserveMissingKeys
            ? {
                  ...existingLayerRecord,
                  ...incomingLayerRecord
              }
            : { ...incomingLayerRecord };

        if (
            typeof mergedLayerRecord.id !== 'string' ||
            !mergedLayerRecord.id.length
        ) {
            mergedLayerRecord.id = layerId;
        }

        this._normalizeLayerMasterSnapshot(
            layerId,
            mergedLayerRecord,
            existingLayerRecord
        );

        const layerMaster = mergedLayerRecord.master as
            Record<string, unknown> | undefined;
        if (
            layerMaster &&
            typeof layerMaster === 'object' &&
            !Array.isArray(layerMaster) &&
            layerMaster.type === 'DefaultForMaster' &&
            typeof layerMaster.master === 'string' &&
            typeof mergedLayerRecord.name === 'string'
        ) {
            const masterName = Array.isArray(
                (this._fontJson as Unsafe)?.masters
            )
                ? (((this._fontJson as Unsafe).masters as Unsafe[]).find(
                      (master) => master?.id === layerMaster.master
                  )?.name as string | { dflt?: string } | undefined)
                : undefined;
            const normalizedMasterName =
                typeof masterName === 'string'
                    ? masterName
                    : masterName && typeof masterName === 'object'
                      ? String(masterName.dflt || '')
                      : '';
            if (
                !mergedLayerRecord.name.length ||
                (normalizedMasterName &&
                    mergedLayerRecord.name === normalizedMasterName)
            ) {
                delete mergedLayerRecord.name;
            }
        }

        if (
            typeof mergedLayerRecord.width !== 'number' ||
            !Number.isFinite(mergedLayerRecord.width)
        ) {
            const incomingHasWidth = Object.prototype.hasOwnProperty.call(
                incomingLayerRecord,
                'width'
            );
            const existingWidth = existingLayerRecord.width;
            if (
                !incomingHasWidth &&
                typeof existingWidth === 'number' &&
                Number.isFinite(existingWidth)
            ) {
                mergedLayerRecord.width = existingWidth;
            } else {
                throw new Error(
                    `[PatchSyncEngine] Layer ${layerId} has invalid width; refusing to normalize malformed layer snapshot.`
                );
            }
        }

        for (const [key, value] of Object.entries(mergedLayerRecord)) {
            if (value === undefined) {
                delete mergedLayerRecord[key];
            }
        }

        if (mergedLayerRecord.isInterpolated === false) {
            delete mergedLayerRecord.isInterpolated;
        }

        return toRestingLayerJson(mergedLayerRecord, {
            existing: preserveMissingKeys ? existingLayerRecord : undefined,
            mode: 'replace',
            context: 'history snapshot'
        });
    }

    /**
     * Apply a sparse layer delta to the Y.Doc.
     *
     * The delta contains ONLY the fields that changed.  Fields absent
     * from the delta are left untouched in the Y.Doc — this is the
     * fundamental contract that prevents key loss during cross-window
     * and cloud sync.
     *
     * Scalar/object fields in the delta replace the existing value.
     * Array fields (shapes, anchors, guides) in the delta replace the
     * entire array.  Fields with value `null` are deleted from the
     * Y.Map.
     */
    private _applyLayerDelta(
        glyphName: string,
        layerId: string,
        delta: unknown
    ): void {
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }

        const layersMap = ensureGlyphLayersMap(glyphMap);

        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
            console.warn(
                `[PatchSyncEngine] Ignoring malformed layer delta for ${glyphName}/${layerId}; expected object payload.`
            );
            return;
        }

        const deltaRecord = delta as Record<string, unknown>;

        // Empty delta → nothing to apply.
        const deltaKeys = Object.keys(deltaRecord);
        if (deltaKeys.length === 0) {
            return;
        }

        const existingLayerValue = layersMap.get(layerId);
        let layerMap =
            existingLayerValue instanceof Y.Map
                ? existingLayerValue
                : undefined;

        // Creating a new layer from a sparse delta requires width and master.
        if (!(layerMap instanceof Y.Map)) {
            const hasWidth =
                typeof deltaRecord.width === 'number' &&
                Number.isFinite(deltaRecord.width);
            const hasMaster =
                !!deltaRecord.master &&
                typeof deltaRecord.master === 'object' &&
                !Array.isArray(deltaRecord.master);
            if (!hasWidth || !hasMaster) {
                console.warn(
                    `[PatchSyncEngine] Ignoring sparse layer delta for missing ${glyphName}/${layerId}; cannot create layer root from sparse payload.`
                );
                return;
            }
            layerMap = new Y.Map<unknown>();
            layersMap.set(layerId, layerMap);
        }

        // Read existing Y.Doc state for master normalization context.
        const existingYDocRecord = fromYType(layerMap) as Record<
            string,
            unknown
        > | null;

        // Clone the delta — _normalizeLayerMasterSnapshot mutates it.
        const workingRecord = toRestingLayerJson(
            cloneHistoryValue(deltaRecord) as Record<string, unknown>,
            {
                existing: existingYDocRecord,
                mode: 'delta',
                context: 'Y.Doc write'
            }
        ) as Record<string, unknown>;

        // Normalize master if it changed.
        if ('master' in workingRecord) {
            this._normalizeLayerMasterSnapshot(
                layerId,
                workingRecord,
                existingYDocRecord ?? {}
            );
        }

        // Validate width if it's in the delta.
        if ('width' in workingRecord) {
            if (
                typeof workingRecord.width !== 'number' ||
                !Number.isFinite(workingRecord.width)
            ) {
                console.warn(
                    `[PatchSyncEngine] Layer delta for ${glyphName}/${layerId} has invalid width; refusing to apply width.`
                );
                delete workingRecord.width;
            }
        }

        // Validate master if it's in the delta.
        if ('master' in workingRecord && !workingRecord.master) {
            console.warn(
                `[PatchSyncEngine] Layer delta for ${glyphName}/${layerId} has invalid master; refusing to apply master.`
            );
            delete workingRecord.master;
        }

        // Strip isInterpolated if set to false in the delta.
        if (workingRecord.isInterpolated === false) {
            workingRecord.isInterpolated = null;
        }

        for (const runtimeKey of RESTING_LAYER_RUNTIME_KEYS) {
            layerMap.delete(runtimeKey);
        }

        // Apply each delta key to the Y.Map.
        for (const [key, value] of Object.entries(workingRecord)) {
            if (value === null || value === undefined) {
                if (
                    (RESTING_LAYER_IDENTITY_KEYS as readonly string[]).includes(
                        key
                    )
                ) {
                    continue;
                }
                // For indexed-map keys, delete the *ById+*Order keys
                // so downstream readers see the data as absent (not
                // empty), preserving merge semantics.
                if (INDEXED_MAP_KEYS[key]) {
                    const mapping = INDEXED_MAP_KEYS[key]!;
                    layerMap.delete(mapping.byId);
                    layerMap.delete(mapping.order);
                } else {
                    layerMap.delete(key);
                }
            } else {
                // Anchors/guides are stored as indexed maps. Shapes use
                // atomic topology plus packed node positions.
                if (
                    (key === 'anchors' || key === 'guides') &&
                    Array.isArray(value)
                ) {
                    applyIndexedMapArrayToYMap(layerMap, key, value);
                    continue;
                }
                if (key === 'shapes' && Array.isArray(value)) {
                    writeLayerGeometry(layerMap, value, toYType);
                    continue;
                }

                this._replaceYMapEntry(layerMap, key, value);
            }
        }
    }

    private _targetFromHistoryItem(
        item: HistoryStackItem,
        fallbackGlyphName: string | null,
        fallbackLayerId: string | null
    ): UndoTarget {
        const glyphNames = deriveGlyphNamesFromPaths(item.touchedPaths);
        const layerIds = deriveLayerIdsFromPaths(item.touchedPaths);
        if (item.undoScope === 'layer') {
            return {
                glyphName: glyphNames[0] ?? fallbackGlyphName,
                layerId: layerIds[0] ?? fallbackLayerId
            };
        }
        if (item.undoScope === 'glyph') {
            return {
                glyphName: glyphNames[0] ?? fallbackGlyphName,
                layerId: null
            };
        }
        return {
            glyphName: null,
            layerId: null
        };
    }

    private _getUndoManagerForTarget(target: UndoTarget): UndoManagerWithScope {
        if (target.glyphName && target.layerId) {
            return {
                manager: this.getLayerUndoManager(
                    target.glyphName,
                    target.layerId
                ),
                scope: 'layer'
            };
        }
        if (target.glyphName) {
            return {
                manager: this.getGlyphUndoManager(target.glyphName),
                scope: 'glyph'
            };
        }
        return {
            manager: this._fontUndoManager,
            scope: 'font'
        };
    }

    private _appendChangeLogEntry(entry: ChangeLogEntry): void {
        this._changeLog.push(normalizeChangeLogEntry(entry));
        this._notifyChangeLogListeners();
    }

    private _appendChangeLogEntries(entries: ChangeLogEntry[]): void {
        if (!entries.length) {
            return;
        }
        this._changeLog.push(
            ...entries.map((entry) => normalizeChangeLogEntry(entry))
        );
        this._notifyChangeLogListeners();
    }

    private _deriveForwardChangesFromChangeLogEntries(
        entries: ChangeLogEntry[]
    ): DerivedForwardChange[] {
        return entries.map((entry) => ({
            path: entry.path,
            op: entry.op,
            oldValue: cloneHistoryValue(
                entry.replayOldValue === undefined
                    ? entry.oldValue
                    : entry.replayOldValue
            ),
            newValue: cloneHistoryValue(
                entry.replayNewValue === undefined
                    ? entry.newValue
                    : entry.replayNewValue
            ),
            objectType: deriveObjectInfoFromPath(entry.path).objectType
        }));
    }

    private _deriveForwardChangesFromCollaborationMessage(
        message: CollaborationMessageEnvelope
    ): DerivedForwardChange[] {
        return message.changes.map((change) => ({
            path: change.path,
            op: change.op,
            oldValue: cloneHistoryValue(change.replayOldValue),
            newValue: cloneHistoryValue(change.replayNewValue),
            objectType: deriveObjectInfoFromPath(change.path).objectType
        }));
    }

    private _createCollaborationLogItem(
        message: CollaborationMessageEnvelope,
        update: Uint8Array,
        direction: 'local' | 'remote',
        derivedForwardChanges: DerivedForwardChange[]
    ): CollaborationLogItem {
        const originating = resolveCollaborationOriginatingLayer(
            message.metadata.undoScope,
            message.changes.length
                ? message.changes.map((change, index) => ({
                      path: change.path,
                      originatingGlyphName:
                          index === 0
                              ? (message.metadata.originatingGlyphName ?? null)
                              : null,
                      originatingLayerId:
                          index === 0
                              ? (message.metadata.originatingLayerId ?? null)
                              : null
                  }))
                : [
                      {
                          path: '',
                          originatingGlyphName:
                              message.metadata.originatingGlyphName ?? null,
                          originatingLayerId:
                              message.metadata.originatingLayerId ?? null
                      }
                  ]
        );
        return {
            id: collaborationMessageKey(message),
            direction,
            timestamp: message.timestamp,
            transactionDurationMs:
                message.metadata.transactionDurationMs ?? null,
            summary: message.summary,
            label: message.label,
            source: message.source,
            editSource: message.metadata.editSource ?? null,
            windowId: message.windowId,
            windowRoleLabel:
                message.metadata.sourceWindowRoleLabel ??
                this._getWindowRoleLabel(),
            historyItemId: message.metadata.historyItemId,
            promptGroupId: message.metadata.promptGroupId ?? null,
            historyAction: message.metadata.historyAction,
            targetHistoryItemId: message.metadata.targetHistoryItemId ?? null,
            undoScope: message.metadata.undoScope,
            undoSurfaceAffinity: message.metadata.undoSurfaceAffinity ?? null,
            historyTargetKey: message.metadata.historyTargetKey ?? null,
            historyTargetLabel: message.metadata.historyTargetLabel ?? null,
            originatingGlyphName: originating.glyphName,
            originatingLayerId: originating.layerId,
            updateByteLength: update.byteLength,
            updateBase64Preview: this._toUpdateBase64Preview(update),
            changedGlyphNames: [...message.metadata.changedGlyphNames],
            changedLayerIds: [...message.metadata.changedLayerIds],
            workerReplayTargets: normalizeWorkerReplayTargets(
                message.metadata.workerReplayTargets
            ),
            changes: message.changes.map((change) => ({
                ...change,
                workerReplayTargets: change.workerReplayTargets
                    ? [...change.workerReplayTargets]
                    : undefined
            })),
            derivedForwardChanges
        };
    }

    private _appendCollaborationLogItems(items: CollaborationLogItem[]): void {
        if (!items.length) {
            return;
        }

        const existingIds = new Set(
            this._collaborationLog.map((item) => item.id)
        );
        let didAddItem = false;
        let lastTimestamp =
            this._collaborationLog.length > 0
                ? this._collaborationLog[this._collaborationLog.length - 1]
                      .timestamp
                : Number.NEGATIVE_INFINITY;
        let requiresSort = false;

        for (const item of items) {
            if (existingIds.has(item.id)) {
                continue;
            }
            if (item.timestamp < lastTimestamp) {
                requiresSort = true;
            }
            this._collaborationLog.push(item);
            existingIds.add(item.id);
            lastTimestamp = item.timestamp;
            didAddItem = true;
        }

        if (!didAddItem) {
            return;
        }

        if (requiresSort) {
            this._collaborationLog.sort(
                (left, right) => left.timestamp - right.timestamp
            );
        }
        this._notifyCollaborationLogListeners();
    }

    private _notifyCollaborationLogListeners(): void {
        const items = this.getCollaborationLog();
        for (const listener of this._collaborationLogListeners) {
            listener(items);
        }
    }

    private _toUpdateBase64Preview(update: Uint8Array): string {
        let binary = '';
        const previewLength = Math.min(update.length, 96);
        for (let index = 0; index < previewLength; index++) {
            binary += String.fromCharCode(update[index]);
        }
        const base64 = btoa(binary);
        return update.length > previewLength ? `${base64}...` : base64;
    }

    private _notifyChangeLogListeners(): void {
        const entries = this.getChangeLog();
        for (const listener of this._changeLogListeners) {
            listener(entries);
        }
    }
}

function cloneHistoryValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}
