/**
 * PatchSyncEngine — Central patch-driven sync processor.
 *
 * Every mutation to the babelfont model goes through this class.
 * It keeps a Yjs Y.Doc in sync with the JSON, maintains the change log
 * (the only undo/redo source, replayed per history item), and broadcasts
 * updates to other windows via BroadcastChannel.
 */

import { MAX_YJS_PACKET_BYTES } from './generated/collab-protocol-limits';
import * as Y from 'yjs';
import { assertCompileStamp } from './edit-intent';
import { rebasePythonExecutionBaseline } from './python-execution-baseline';
import {
    jsonToYDoc,
    jsonToCoreFontMap,
    fillGlyphYMap,
    yDocToJson,
    fromYDrawing,
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
    ensureGlyphDrawingsMap,
    createGlyphDrawingsMap,
    drawingToYMap,
    replaceYMapContents,
    YMAP_INFRASTRUCTURE_KEYS,
    DRAWING_FORMAT_SPECIFIC_KEY,
    writeDrawingFormatSpecific
} from './change-bridge-ydoc';
import {
    assertDrawingGeometryComplete,
    readDrawingGeometry,
    writeDrawingGeometry
} from './drawing-geometry-ydoc';
import {
    describeDrawingStationViolation,
    omitRestingDrawingRuntimeKeys,
    RESTING_DRAWING_IDENTITY_KEYS,
    RESTING_DRAWING_RUNTIME_KEYS,
    toRestingDrawingJson
} from './resting-drawing-json';
import {
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
    deriveDrawingId,
    deriveGlyphNameFromPath,
    deriveGlyphNamesFromPaths,
    deriveDrawingIdFromPath,
    deriveDrawingIdsFromPaths,
    deriveObjectInfoFromPath,
    getDrawingTouchKey,
    historyReplayValue,
    isSnapshotRootPath,
    getPathSegments,
    invalidateHistoryStateCache,
    isReplayableHistoryEntry,
    joinPathWithGlyphSeparator,
    normalizeWorkerReplayTargets,
    normalizeGlyphRenames,
    glyphRenamesForHistoryAction,
    normalizeChangeLogEntry,
    resolveCollaborationOriginatingDrawing,
    resolveCommitOriginatingDrawing,
    resolveHistoryTargetItem,
    resolveUndoSurfaceAffinity,
    resetLogCounter,
    isDerivedDrawingChangePath
} from './change-log';
import type { Babelfont } from './babelfont';
import { Logger } from './logger';
import {
    canonicalDrawing,
    describeDrawingDifference,
    drawingFingerprint,
    isCollabTraceOn,
    recordCollabTrace
} from './collab-trace';
import { ApplyKind } from './apply-kind';
import APP_SETTINGS from './settings';
import {
    CloudSendHold,
    EditBurstTracker,
    type EditBurst,
    type HeldCloudPacket
} from './edit-burst';
import {
    EnvelopeTooLargeError,
    mergeEnvelopesForWire
} from './cloud-envelope-budget';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    base64ToBytes,
    bytesToBase64,
    CloudWalPersistError
} from './cloud-durable-wal';
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
    buildFontDepsForGlyphWithIndex,
    catalogNameIndexFromEntries,
    catalogEntriesForDepsParse,
    parseMetricsKeyReferencedNames,
    patchSourceEdges,
    readFontDepsIndex,
    sparseWriteClosureIds,
    writeCompleteFontDepsIfLoaded,
    writeFontDepsYMap,
    type FontDepsIndex
} from './filesystem-plugins/cloud-font-deps';
import { sanitizeGlyphEmptyReferenceComponents } from './local-sparse-hydrator';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    GLYPH_REVISIONS_KEY,
    GLYPH_SYNC_MAP_KEY,
    GLYPH_SYNC_REVISION_KEY,
    glyphDocumentId,
    glyphIdFromDocumentId,
    type EncodedShard
} from './filesystem-plugins/cloud-document-set';
import {
    CATALOG_ROOT_KEY,
    FEATURES_ROOT_KEY,
    FONT_FEATURES_DOCUMENT_ID,
    FORWARDED_ROOT_KEY,
    KERNING_ROOT_KEY,
    LAYOUT_MAP_KEY,
    LAYOUT_MOVED_FROM_KEY,
    LAYOUT_SEEDS_KEY,
    catalogRoomFor,
    catalogRoomIds,
    codepointIndexFromCatalog,
    isLayoutDocumentId,
    kerningRoomFor,
    kerningRoomIds,
    kerningFieldDirection,
    kerningFieldForDirection,
    kerningKey,
    layoutDocumentIds,
    layoutDocumentKind,
    layoutTopLevelKey,
    parseKerningKey,
    parseRoomLayout,
    type KerningDirection,
    type RoomLayout
} from './filesystem-plugins/cloud-room-layout';
import {
    forwardedValueMatches,
    forwardedValueOf,
    isUntouchedSeedEntry,
    keysChangedSinceSnapshot,
    stableJson,
    yValueJson,
    type MovedRoomRecord,
    type SeededRoomRecord
} from './filesystem-plugins/cloud-room-move';
import { flattenKerningMap } from './delete-glyphs-preflight';
import {
    ClockGapError,
    DocumentStateNotLoadedError,
    applyUpdateWithIntegrity,
    assertCompleteGlyphState,
    assertDocumentWritable,
    assertNoPendingState,
    assertUpdateIntegrates,
    clearBrokenDocumentScope,
    createBrokenDocumentScope,
    isDocumentBroken,
    isDocumentIdBroken,
    markDocumentBroken
} from './yjs-update-integrity';
import {
    measureShardBytesForSubmit,
    evaluateCollabSubmit,
    type CollabSubmitDecision,
    type CollabSubmitRequest
} from './filesystem-plugins/cloud-shard-limits';
import {
    computeDrawingRecompositionClosure,
    deriveEditKindsFromChangeLogEntries,
    shouldResettleDerivedDrawingsOnHistoryReplay,
    type FontModelLike
} from './recomposition-closure';

const console = new Logger('PatchSyncEngine');

/**
 * One envelope for the packets of a held send. A burst writes the same value
 * many times; the room and its collaborators need the change once, from the
 * value before the burst to the value after it, under the burst’s own label.
 */
function mergeBurstEnvelopes(
    envelopes: CollaborationMessageEnvelope[],
    documentId: string,
    isBurst: boolean
): CollaborationMessageEnvelope {
    const requireMerged = (
        merged: CollaborationMessageEnvelope | null
    ): CollaborationMessageEnvelope => {
        if (!merged) {
            throw new Error(
                `[PatchSyncEngine] Held packets for “${documentId}” have no envelope to merge.`
            );
        }
        return merged;
    };
    if (!isBurst) {
        return requireMerged(mergeEnvelopesForWire(envelopes, { documentId }));
    }
    const collapsed: CollaborationMessageEnvelope['changes'] = [];
    for (const change of envelopes.flatMap((envelope) => envelope.changes)) {
        const previous = collapsed[collapsed.length - 1];
        if (
            previous &&
            previous.op === 'set' &&
            change.op === 'set' &&
            previous.path === change.path &&
            !previous.glyphRenames &&
            !change.glyphRenames
        ) {
            collapsed[collapsed.length - 1] = {
                ...previous,
                replayNewValue: change.replayNewValue
            };
            continue;
        }
        collapsed.push(change);
    }
    const [first, ...rest] = envelopes;
    const merged = requireMerged(
        mergeEnvelopesForWire(
            [
                { ...first, changes: collapsed },
                ...rest.map((envelope) => ({ ...envelope, changes: [] }))
            ],
            { documentId }
        )
    );
    return { ...merged, summary: first.summary, label: first.label };
}

type Unsafe = ReturnType<typeof JSON.parse>;
type YjsUpdate = Uint8Array<ArrayBufferLike>;

/** An undo or redo resolved and checked before it writes anything. */
type PreparedHistoryReplay = {
    /** Entries in replay order. */
    replayEntries: ChangeLogEntry[];
    resettleDerivedDrawings: boolean;
    itemRenames: GlyphRename[];
    /** Entries per document, font-core first; every document is held here. */
    buckets: Array<[string, ChangeLogEntry[]]>;
};

/** A copy of the engine's glyph name index (see `_snapshotGlyphNameMaps`). */
type GlyphNameMapsSnapshot = {
    idByName: Map<string, string>;
    nameById: Map<string, string>;
    retiredIdByName: Map<string, string>;
    removedNameById: Map<string, string>;
    pendingDestroyedIds: Set<string>;
};
type OptionalDrawingField = 'anchors' | 'guides' | 'format_specific';

type DrawingSnapshotSyncTarget = WorkerReplayTarget & {
    drawingJson: unknown;
    authoritativeOptionalDrawingFields?: readonly OptionalDrawingField[];
};

export type { ChangeLogEntry } from './change-log';

/** Hears of a glyph or layout document that is now held in this window. */
export type DocumentLoadedListener = (documentId: string) => void;
/**
 * Hears that a font became read-only (the reason shown with refused edits)
 * or writable again (null), from setReadOnly or destroy.
 */
export type ReadOnlyChangedListener = (reason: string | null) => void;

/** What a listener may need to know about the commit behind a packet. */
export type LocalUpdateMeta = {
    /** The edit burst the packet belongs to; null for a one-off edit. */
    burstKey: string | null;
    /** Glyph rows a glyph-revision stamp announces (main holds it for them). */
    dependsOn?: string[];
};

export type LocalUpdateListener = (
    update: YjsUpdate,
    collaborationMessage?: CollaborationMessageEnvelope | null,
    changeLogEntries?: ChangeLogEntry[],
    documentId?: string,
    meta?: LocalUpdateMeta
) => void;

/**
 * Listeners flagged `cloud` send packets to the room. The engine hands them
 * a burst’s packets once, merged, after the burst ends; every other
 * listener sees each packet at once.
 */
export type LocalUpdateListenerOptions = { cloud?: boolean };

/** Compile source stamped on changes that reload a font's own files. */
export const EXTERNAL_SOURCE_RELOAD_SOURCE = 'external-source-reload';

/** Compile source stamped on what a collaborator catch-up changed here. */
export const CATCH_UP_COMPILE_SOURCE = 'remote-catch-up';

/** A resident document as it was before a catch-up applied. */
type CatchUpDescription =
    | { kind: 'glyph'; glyphId: string; snapshot: Record<string, unknown> }
    | { kind: 'core'; snapshot: Record<string, unknown> };

export type CommittedChangeOrigin = 'local' | 'remote';

/** Several documents emitted by one commit, so UI can refresh once. */
export type CommittedUiBatch = {
    id: string;
    index: number;
    count: number;
};

/**
 * Position of a packet inside a commit that renames glyphs across several
 * documents. The worker cannot validate such a rename one shard at a time.
 */
export type WorkerRenameBatchPart = 'partial' | 'last';

/** Per-commit work shared by the packets of one multi-document emit. */
type SharedLocalEmission = {
    /** First packet's envelope; later packets copy it with their sequence. */
    envelope?: CollaborationMessageEnvelope | null;
    forwardChanges?: DerivedForwardChange[];
    /** Entries that describe each packet; null keeps the full commit. */
    entriesByDocument: Map<string, ChangeLogEntry[]> | null;
};

export type YjsWorkerCallback = (
    update: YjsUpdate,
    changeLogEntries: ChangeLogEntry[],
    documentId?: string,
    options?: { renameBatch?: WorkerRenameBatchPart }
) => void;

export type CommittedChangeListener = (
    entries: ChangeLogEntry[],
    context: {
        origin: CommittedChangeOrigin;
        update: YjsUpdate;
        documentId?: string;
        uiBatch?: CommittedUiBatch;
        /** A collaborator’s live packet, not a catch-up or a linked window’s own edit. */
        fromCollaborator?: boolean;
        /** This user's edit relayed from a linked window (main window only). */
        fromLinkedWindow?: boolean;
        /**
         * Nothing was written and no packet went anywhere: an edit whose
         * drawings already matched their documents. Listeners refresh
         * compile and caches for the entries' replay targets only.
         */
        localOnly?: boolean;
    }
) => void;

/**
 * Why the engine replaced model glyph or drawing data with what the
 * documents hold.
 */
export type GlyphModelRebuildCause =
    | 'remote-update'
    | 'catch-up'
    | 'checkpoint'
    | 'snapshot'
    | 'rebaseline'
    | 'hydrate'
    | 'unload'
    | 'submit-refused'
    | 'read-only-refused'
    | 'null-commit-read-back'
    | 'history-replay'
    | 'external-reload'
    | 'deferred-after-sync'
    | 'read-back';

export type GlyphModelRebuildEvent = {
    /** Glyphs whose model data is replaced; null when any glyph may be. */
    glyphs: string[] | null;
    cause: GlyphModelRebuildCause;
};

/**
 * Runs synchronously before the engine replaces model data, so an editor
 * can commit an edit it still holds (a debounced keyboard preview) first.
 */
export type BeforeGlyphModelRebuildListener = (
    event: GlyphModelRebuildEvent
) => void;

/** Runs after the engine replaced model glyph or drawing data. */
export type GlyphModelRebuiltListener = (event: GlyphModelRebuildEvent) => void;

/** An undo or redo that did not happen, or failed part way. */
export type HistoryReplayProblem =
    | {
          kind: 'blocked';
          reason: 'collaborator-edit' | 'document-not-loaded';
          historyAction: string;
          historyItemId: string;
          documentIds?: string[];
      }
    | {
          kind: 'failed';
          historyAction: string;
          historyItemId: string;
          reason: string;
          documentIdsNotRolledBack: string[];
          /**
           * The own history item id of the undo or redo entry this window
           * took out of its change log; absent when nothing was taken out.
           * Linked windows take the same entry back (`takeBackHistoryEntry`).
           */
          takenBackHistoryItemId?: string;
      };

/**
 * A failed undo or redo another window took back (see window-sync): this
 * window removes the same relayed control entry from its change log.
 */
export type HistoryEntryTakeBack = {
    historyAction: 'undo' | 'redo';
    /** The history item the failed undo or redo was for. */
    targetHistoryItemId: string;
    /** The taken-back entry's own history item id, when it is known. */
    entryHistoryItemId: string | null;
    /** The window whose replay failed: the entry's author. */
    windowId: string;
};

export type HistoryReplayProblemListener = (
    problem: HistoryReplayProblem
) => void;

/** A model-rebuild scope: what it replaced, and whether it is reported. */
type GlyphModelRebuildScope = {
    cause: GlyphModelRebuildCause;
    silent: boolean;
    glyphs: Set<string>;
    all: boolean;
};

/** Own glyph revisions remembered to ignore their echo from the feed. */
const MAX_OWN_GLYPH_REVISIONS = 20_000;

/**
 * How long a feed revision waits for the rest of its commit. Each glyph room
 * reports its own write, so a composite's revision can arrive before its
 * base glyph's; it matches the longest time a remote cascade preview waits.
 */
export const GLYPH_REVISION_COMMIT_HOLD_MS = 10_000;

/**
 * The commit a revision token belongs to. A commit that writes several
 * glyphs gives them consecutive clocks and names the range in each token:
 * `<windowId>:<clock>/<first>-<last>`. Null for a single-glyph commit.
 */
function glyphRevisionCommit(
    revision: string
): { key: string; size: number } | null {
    const match = /^(.+):(\d+)\/(\d+)-(\d+)$/.exec(revision);
    if (!match) {
        return null;
    }
    const first = Number(match[3]);
    const last = Number(match[4]);
    const size = last - first + 1;
    if (!(size > 1) || size > 100_000) {
        return null;
    }
    return { key: `${match[1]}:${first}-${last}`, size };
}

/** A feed revision and when it arrived, for ordering late releases. */
type HeldGlyphRevision = { glyphId: string; revision: string; arrival: number };

/**
 * Glyph revisions from the room's revision feed. `initial` marks the first
 * page after opening: a snapshot to compare against, not a list of changes.
 */
export type GlyphRevisionFeedListener = (
    glyphIds: string[],
    options: { initial: boolean }
) => void;

export class MetadataFreeRemoteUpdateError extends Error {
    constructor() {
        super(
            'Refusing metadata-free non-noop remote Yjs update; semantic metadata is required for scoped model and compile convergence'
        );
        this.name = 'MetadataFreeRemoteUpdateError';
    }
}

/**
 * A drawing read from or written to Yjs lacks a field every drawing must
 * have: a finite `width`, a non-empty string `id`, or a `master` that names
 * an existing station. Nothing fills it in; the document is refused.
 */
export class DrawingInvariantError extends Error {
    readonly drawingId: string;
    constructor(drawingId: string, problem: string, context: string) {
        super(
            `[PatchSyncEngine] Drawing ${drawingId || '(no id)'} ${problem} (${context})`
        );
        this.name = 'DrawingInvariantError';
        this.drawingId = drawingId;
    }
}

/**
 * A local edit was refused because the font is read-only in this window:
 * the user lost write access (or only ever had read access). Separate from
 * a broken document: nothing is damaged, and edits from collaborators keep
 * arriving. Nothing is written or sent.
 */
export class ReadOnlyFontError extends Error {
    readonly reason: string;
    constructor(reason: string, context: string) {
        super(
            `This font is read-only: ${reason} Your ${context} was not made.`
        );
        this.name = 'ReadOnlyFontError';
        this.reason = reason;
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
    /** The envelope named every glyph of its document (see the envelope). */
    allGlyphsChanged?: true;
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
    'default' | 'font-snapshot' | 'glyph-snapshot' | 'drawing-snapshot';

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
        intents: Record<string, unknown>;
    }
) => TransactionBufferedOperation[] | null | undefined;

/**
 * Origin token used by Yjs transactions that represent same-user edits.
 * Linked windows should all be able to undo these changes.
 */
const USER_EDIT_ORIGIN = 'user-edit';
/** Change-log path describing a font-deps packet on the wire. */
export const FONT_DEPS_ENTRY_PATH = 'fontDeps';
const SYSTEM_REMOTE_ORIGIN = 'system-remote';
/** A peer’s or linked window’s update applied by applyRemoteUpdate. */
const PEER_REMOTE_ORIGIN = 'peer-remote';
const HISTORY_REPLAY_ORIGIN = 'history-replay';
const FONT_EDIT_ORIGIN = 'font-edit';

/**
 * True when `transaction` changed `doc`: a new struct or a deletion. Read
 * after a throw inside it, to tell a refusal before any write (the document
 * is whole) from one after a partial write.
 */
function transactionWroteSomething(
    doc: Y.Doc,
    transaction: Y.Transaction
): boolean {
    if (transaction.deleteSet.clients.size > 0) {
        return true;
    }
    for (const [client, clock] of Y.decodeStateVector(
        Y.encodeStateVector(doc)
    )) {
        if (clock > (transaction.beforeState.get(client) ?? 0)) {
            return true;
        }
    }
    return false;
}

/** A Yjs v1 update with no structs and no deletions. */
function isEmptyYjsUpdate(update: Uint8Array): boolean {
    return (
        update.length === 0 || (update.length === 2 && !update[0] && !update[1])
    );
}
const GLYPH_EDIT_ORIGIN = 'glyph-edit';
/** Remote cloud applies; never treated as a local edit origin. */
export const CLOUD_REMOTE_ORIGIN = 'cloud-remote';
/** Edits carried over from a rebase's old rooms; sent explicitly. */
const LAYOUT_FORWARD_ORIGIN = 'layout-forward';

/**
 * Origins of updates that came from somewhere else: the room, a peer, a
 * catch-up, a checkpoint or a linked window. Every other update a document
 * emits is this window’s own and goes to its outbox, whatever
 * `transaction.local` says (Yjs sets it false for every applied update,
 * worker edits included).
 */
const NETWORK_ORIGINS: ReadonlySet<unknown> = new Set<unknown>([
    SYSTEM_REMOTE_ORIGIN,
    PEER_REMOTE_ORIGIN,
    CLOUD_REMOTE_ORIGIN
]);

/** An empty Yjs v1 update: no structs, no deletions. */
const EMPTY_YJS_UPDATE: YjsUpdate = new Uint8Array([0, 0]);

function assertCloudAssetMutable(): void {
    if (window.cloudPlugin?.canMutateCurrentAsset?.() === false) {
        throw new Error('Cloud asset is read-only');
    }
}

export type ApplyRemoteUpdateOptions = {
    captureInUndo?: boolean;
    /**
     * The update is another person’s edit (from the cloud room), not one
     * relayed from this user’s own linked window. Undo must not overwrite it.
     */
    fromCollaborator?: boolean;
    /**
     * The update is this user's edit made in a linked window, which this
     * main window relays to the cloud: its catalog and deps projections are
     * this window's to write, as for its own edits.
     */
    fromLinkedWindow?: boolean;
    /**
     * The update is one of this user's unsent edits, restored from the
     * write-ahead log. It applies only to a document whose state from the
     * room is loaded here; otherwise a `DocumentStateNotLoadedError` is
     * thrown before anything is applied, and nothing is marked broken.
     */
    restoredUnsentEdit?: boolean;
};

/** Most recent collaborator-touched paths kept for the undo guard. */
const MAX_COLLABORATOR_TOUCHES = 2000;

function historyPathSegments(path: string): string[] {
    return getPathSegments(path)
        .map((segment) => String(segment))
        .filter((segment) => segment !== '');
}

/**
 * Two change paths touch the same data when one contains the other,
 * compared segment by segment: a glyph name is one segment even with dots,
 * so `adieresis` does not contain `adieresis.ss01`.
 */
function historyPathsOverlap(left: string, right: string): boolean {
    if (left === right) {
        return true;
    }
    const leftSegments = historyPathSegments(left);
    const rightSegments = historyPathSegments(right);
    if (!leftSegments.length || !rightSegments.length) {
        return false;
    }
    const shared = Math.min(leftSegments.length, rightSegments.length);
    for (let index = 0; index < shared; index += 1) {
        if (leftSegments[index] !== rightSegments[index]) {
            return false;
        }
    }
    return true;
}
/**
 * The glyph whose set of drawings this change path adds, removes or
 * replaces whole (a station drawing, free drawing or variation drawing, or
 * the whole drawing list), or null.
 */
function drawingSetChangeGlyphName(path: string): string | null {
    const segments = historyPathSegments(path);
    if (
        segments[0] === 'glyphs' &&
        segments.length >= 3 &&
        segments.length <= 4 &&
        segments[2] === 'layers'
    ) {
        return segments[1] ?? null;
    }
    return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** What makes a node interpolation-compatible: its type. Null when unknown. */
function nodeStructureSignature(node: unknown): string | null {
    if (!isPlainRecord(node)) {
        return null;
    }
    const nodeType = node.nodetype ?? node.type;
    return typeof nodeType === 'string' ? nodeType : null;
}

function nodesStructureSignature(nodes: unknown): string | null {
    if (!Array.isArray(nodes)) {
        return null;
    }
    const signatures = nodes.map(nodeStructureSignature);
    return signatures.every((signature) => signature !== null)
        ? signatures.join(',')
        : null;
}

/** A path's open/closed state and node types, or a component's glyph. */
function shapeStructureSignature(shape: unknown): string | null {
    if (!isPlainRecord(shape)) {
        return null;
    }
    if (typeof shape.reference === 'string') {
        return `component:${shape.reference}`;
    }
    const nodes = nodesStructureSignature(shape.nodes);
    return nodes === null ? null : `path:${String(shape.closed)}:${nodes}`;
}

function shapesStructureSignature(shapes: unknown): string | null {
    if (!Array.isArray(shapes)) {
        return null;
    }
    const signatures = shapes.map(shapeStructureSignature);
    return signatures.every((signature) => signature !== null)
        ? signatures.join('|')
        : null;
}

/** Signatures differ, or either side cannot be read: count it as changed. */
function structureSignaturesDiffer(
    signature: (value: unknown) => string | null,
    oldValue: unknown,
    newValue: unknown
): boolean {
    const before = signature(oldValue);
    const after = signature(newValue);
    return before === null || after === null || before !== after;
}

/**
 * Whether a history entry changes what interpolation needs to match across
 * a glyph’s drawings: a contour opened or closed, a node inserted, removed
 * or given another type, a shape or component added, removed, reordered or
 * swapped. Moving points or components does not. Anchors never count: a
 * glyph whose drawings differ in anchors still compiles (interpolation only
 * warns), so undoing an anchor add or remove stays allowed. A glyph-level
 * entry counts as such a change.
 */
function historyEntryChangesInterpolationStructure(
    entry: ChangeLogEntry
): boolean {
    const segments = historyPathSegments(String(entry.path || ''));
    if (segments[0] !== 'glyphs' || segments.length < 2) {
        return false;
    }
    if (segments.length < 4) {
        return segments.length === 2 || segments[2] === 'layers';
    }
    if (segments[2] !== 'layers') {
        return false;
    }
    const addsOrRemoves = entry.op === 'add' || entry.op === 'remove';
    const { oldValue, newValue } = entry;
    if (segments.length === 4) {
        if (addsOrRemoves || !isPlainRecord(oldValue)) {
            return true;
        }
        if (!isPlainRecord(newValue)) {
            return true;
        }
        return structureSignaturesDiffer(
            shapesStructureSignature,
            oldValue.shapes ?? [],
            newValue.shapes ?? []
        );
    }
    const area = segments[4];
    const rest = segments.slice(5);
    if (area === 'geometryTopology') {
        return true;
    }
    if (area === 'shapes') {
        if (rest.length === 0) {
            return (
                addsOrRemoves ||
                structureSignaturesDiffer(
                    shapesStructureSignature,
                    oldValue,
                    newValue
                )
            );
        }
        if (rest.length === 1) {
            return (
                addsOrRemoves ||
                structureSignaturesDiffer(
                    shapeStructureSignature,
                    oldValue,
                    newValue
                )
            );
        }
        const key = rest[1];
        if (rest.length === 2) {
            if (key === 'nodes') {
                return (
                    addsOrRemoves ||
                    structureSignaturesDiffer(
                        nodesStructureSignature,
                        oldValue,
                        newValue
                    )
                );
            }
            return (
                (key === 'closed' || key === 'reference') &&
                (addsOrRemoves ||
                    JSON.stringify(oldValue) !== JSON.stringify(newValue))
            );
        }
        if (key !== 'nodes') {
            return false;
        }
        if (rest.length === 3) {
            return (
                addsOrRemoves ||
                structureSignaturesDiffer(
                    nodeStructureSignature,
                    oldValue,
                    newValue
                )
            );
        }
        return (
            rest.length === 4 &&
            (rest[3] === 'nodetype' || rest[3] === 'type') &&
            (addsOrRemoves || oldValue !== newValue)
        );
    }
    return false;
}
const GLYPH_REVISION_ORIGIN = 'glyph-revision-signal';
const DRAWING_EDIT_ORIGIN_PREFIX = 'drawing-edit:';

function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

/** Whether a history item's own entries already write this glyph drawing. */
function historyItemWritesDrawing(
    item: HistoryStackItem,
    target: WorkerReplayTarget
): boolean {
    return item.entries.some(
        (entry) =>
            deriveGlyphNameFromPath(entry.path) === target.glyphName &&
            (deriveDrawingIdFromPath(entry.path) ?? target.layerId) ===
                target.layerId
    );
}

type UndoTarget = {
    glyphName: string | null;
    layerId: string | null;
};

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

type DrawingFingerprintTarget = {
    glyphName: string;
    layerId: string;
};

type DrawingFingerprintSnapshotEntry = DrawingFingerprintTarget & {
    fingerprint: string | null;
};

type DrawingSyncMetadata = {
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

const GRANULAR_DRAWING_ARRAY_KEYS = new Set(['anchors', 'guides']);

function getDrawingManagerKey(glyphName: string, drawingId: string): string {
    return `${glyphName}@@${drawingId}`;
}

function getDrawingEditOrigin(glyphName: string, drawingId: string): string {
    return `${DRAWING_EDIT_ORIGIN_PREFIX}${glyphName}@@${drawingId}`;
}

function getDrawingFingerprintTargetKey(
    glyphName: string,
    drawingId: string
): string {
    return `${glyphName}@@${drawingId}`;
}

function normalizeDrawingSignatureNodeType(nodeType: unknown): string {
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

function getDrawingFingerprintFromJson(drawingJson: Unsafe): string | null {
    if (!drawingJson || typeof drawingJson !== 'object') {
        return null;
    }

    const shapes = Array.isArray(drawingJson.shapes) ? drawingJson.shapes : [];
    const anchors = Array.isArray(drawingJson.anchors)
        ? drawingJson.anchors
        : [];

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
                normalizeDrawingSignatureNodeType((node as Unsafe)?.nodetype)
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
 * Catalog entries often set optional fields to undefined. Yjs omits those
 * keys, so a later projection must not treat the missing key as a change.
 */
function normalizeCloudOwnedValue(value: unknown): unknown {
    if (value === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

/** Yjs stores glyph codepoints as a membership map (`{ "65": true }`). */
function codepointsAsSortedNumbers(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item))
            .sort((left, right) => left - right);
    }
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>)
            .filter(([, member]) => member === true)
            .map(([key]) => Number(key))
            .filter((item) => Number.isFinite(item))
            .sort((left, right) => left - right);
    }
    return [];
}

/** Key-order independent compare for catalog and cmap projections. */
function stableCloudOwnedJson(value: unknown): string {
    const normalized = normalizeCloudOwnedValue(value);
    if (Array.isArray(normalized)) {
        return `[${normalized.map((item) => stableCloudOwnedJson(item)).join(',')}]`;
    }
    if (normalized && typeof normalized === 'object') {
        const record = normalized as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => {
                const item =
                    key === 'codepoints'
                        ? codepointsAsSortedNumbers(record[key])
                        : record[key];
                return `${JSON.stringify(key)}:${stableCloudOwnedJson(item)}`;
            })
            .join(',')}}`;
    }
    return JSON.stringify(normalized) ?? 'null';
}

/**
 * Central patch processor that keeps Yjs Y.Doc in sync with the
 * babelfont JSON object model.
 */
/**
 * A room's encoded size as the cloud stores and compacts it: deleted content
 * collected. Local documents keep it (gc off), so content deleted in this
 * session, such as a large value replaced by a small one, would otherwise
 * count against the room limit until the window reloads.
 */
function collectedEncodedByteLength(doc: Y.Doc): number {
    const collected = new Y.Doc({ gc: true });
    try {
        Y.applyUpdate(collected, Y.encodeStateAsUpdate(doc));
        return Y.encodeStateAsUpdate(collected).byteLength;
    } finally {
        collected.destroy();
    }
}

const utf8Encoder = new TextEncoder();

/** UTF-8 size of a value's JSON. */
function jsonByteLength(value: unknown): number {
    if (value === undefined) {
        return 0;
    }
    return utf8Encoder.encode(JSON.stringify(value) ?? '').byteLength;
}

/** Size of the largest single string or number in a value: what Yjs cannot split. */
function largestLeafByteLength(value: unknown): number {
    if (Array.isArray(value)) {
        return value.reduce<number>(
            (max, item) => Math.max(max, largestLeafByteLength(item)),
            0
        );
    }
    if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).reduce<number>(
            (max, item) => Math.max(max, largestLeafByteLength(item)),
            0
        );
    }
    return jsonByteLength(value);
}

export class PatchSyncEngine {
    /** Font-core Yjs document (non-glyph fields + glyphOrder). */
    readonly yDoc: Y.Doc;
    readonly depsDoc: Y.Doc;
    /** Root font map inside the core Y.Doc */
    readonly fontMap: Y.Map<unknown>;
    private _glyphDocs = new Map<string, Y.Doc>();
    /**
     * Compact encoded Yjs states for resident glyph shards whose live Y.Doc
     * has been parked to save V8 heap. Mutually exclusive with `_glyphDocs`;
     * woken transparently on first edit, remote update, undo, or query.
     */
    private _dormantGlyphStates = new Map<string, Uint8Array>();
    private _dormantDocumentCheckpoints = new Map<string, string>();
    private _glyphEvictionSuspendDepth = 0;
    private static readonly MAX_LIVE_GLYPH_DOCS = 64;
    private static readonly INITIAL_LIVE_GLYPH_DOCS = 16;
    /** The name each deleted glyph had, to describe its document's last packet. */
    private _removedGlyphNameById = new Map<string, string>();
    private _glyphIdByName = new Map<string, string>();
    private _glyphNameById = new Map<string, string>();
    /**
     * This window’s updates of each document that no packet has carried yet,
     * in the order Yjs made them. Every outgoing packet is the merge of a
     * document’s queue, so it carries exactly this window’s own structs and
     * deletions, never a diff against a remembered state vector.
     */
    private _outbox = new Map<string, YjsUpdate[]>();
    /**
     * Font-core updates of a room-layout move (adopt, rebase, prune), kept
     * apart until publishAdoptedRoomLayout sends them. Null when no move is
     * in progress.
     */
    private _layoutCoreOutbox: YjsUpdate[] | null = null;
    /** True while a room-layout move writes font-core. */
    private _capturingLayoutCore = false;
    private _lastEncodedShardBytes = new Map<string, number>();
    private _docUpdateUnsubById = new Map<string, () => void>();
    /** Glyph names touched by forward change-log entries (unload guard). */
    private _historyGlyphNames: {
        log: ChangeLogEntry[];
        length: number;
        names: Set<string>;
    } | null = null;
    /** Change log of all recorded changes */
    /**
     * Paths a collaborator changed, with the change-log length at that time.
     * Undo replays stored values, so replaying an item over a later
     * collaborator edit of the same path would silently revert their work.
     */
    private _collaboratorTouches: Array<{ seq: number; path: string }> = [];
    /**
     * Glyphs in which a collaborator added, removed or replaced a drawing,
     * by change-log index. Undoing a structural edit of the glyph’s other
     * drawings after that would leave the new drawing incompatible.
     */
    private _collaboratorDrawingSetTouches: Array<{
        seq: number;
        glyphName: string;
    }> = [];
    /** Room baselines of the undo or redo being replayed, so rooms it reaches through dependent composites are sent too. */
    private _historyReplayBaselines: Map<string, Uint8Array> | null = null;
    /** Dependent composite drawings the current replay recomposed outside the item's own entries. */
    private _historyReplayDependentTargets: WorkerReplayTarget[] = [];
    private _changeLog: ChangeLogEntry[] = [];
    /** Unique window identifier */
    readonly windowId: string;
    /** Reference to the raw babelfont JSON (the one babelfont-model.ts wraps) */
    private _fontJson: Record<string, Unsafe> | null = null;
    /** Transaction nesting depth */
    private _txDepth = 0;
    /** Current transaction label (outermost) */
    private _txLabel: string | null = null;
    private _txCompileChangeSource: string | null = null;
    private _txCompileEditType: string | null = null;
    /** Current transaction ID */
    private _txId: number | null = null;
    /** Wall-clock start time for the outermost transaction. */
    private _txStartTimeMs: number | null = null;
    /** Next transaction ID counter */
    private _nextTxId = 1;
    /** Identifies multi-document emits that belong to one UI refresh. */
    private _nextUiBatchSerial = 1;
    /** Transaction-scoped tokens that already persisted a cloud WAL prepared row. */
    private _cloudWalApplyTokens = new Set<string>();
    /** Serializes cloud WAL-before-apply commits so callers can await them. */
    private _cloudWalCommitChain: Promise<void> = Promise.resolve();
    /** Serializes persist-then-deliver of local cloud emits after apply. */
    private _cloudEmitPersistChain: Promise<void> = Promise.resolve();
    /** Local cloud emits whose outbox write has not finished yet. */
    private _cloudEmitPersistsInFlight = 0;
    /** Continuous gestures: one history item and one cloud send per burst. */
    private _editBursts = new EditBurstTracker({
        idleMs: APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE,
        maxMs: APP_SETTINGS.EDIT_BURST_MAX_MS,
        createHistoryItemId: () => this._createHistoryItemId()
    });
    /** Holds the cloud-bound copy of a burst; see `CloudSendHold`. */
    // Broken documents by id: a document marked while not resident, or
    // unloaded and loaded again, stays refused until the font is reloaded.
    private readonly _brokenScope = createBrokenDocumentScope();
    // Why local writes to this font are refused, or null while they are
    // allowed (setReadOnly).
    private _readOnlyReason: string | null = null;
    private readonly _readOnlyChangedListeners =
        new Set<ReadOnlyChangedListener>();
    /**
     * Documents whose whole state is held here: loaded from the room (a
     * shard, checkpoint or full state), built here from the font, or a glyph
     * made from its complete state. A document made empty on demand is not
     * in it until its state arrives. Restored unsent edits wait for it.
     */
    private readonly _stateLoadedDocumentIds = new Set<string>();
    /**
     * Glyph documents (by document id) with a catch-up running, or one
     * queued to run after it. Their catch-up rows apply to the instance the
     * cursor was read from, so they are never unloaded meanwhile.
     */
    private readonly _glyphCatchUpsInFlight = new Set<string>();
    private readonly _glyphCatchUpsPending = new Set<string>();

    private _cloudHold = new CloudSendHold({
        minGapMs: APP_SETTINGS.CLOUD_SEND_MIN_GAP_MS,
        trailingMs: APP_SETTINGS.CLOUD_SEND_TRAILING_MS,
        flush: (packets) => this._flushHeldCloudPackets(packets),
        onHeld: (packet) => this._stageHeldCloudPacket(packet)
    });
    /**
     * Per document, the cloud delivery still waiting for an earlier one to
     * take its queue place (a held linked-window run waits for its device
     * row). Every later delivery of that document, own or relayed, and its
     * outbox write go behind it, so the room gets one document's packets in
     * the order this window received or made them.
     */
    private _cloudDeliveryGates = new Map<string, Promise<void>>();
    /** Bursts opened by `runInEditBurst` that have not returned yet. */
    private _ambientBursts: EditBurst[] = [];
    /** Drawings each live-preview burst stages; its commit closes it. */
    private _liveBurstDrawings = new Map<string, Set<string>>();
    /** The burst the open outermost transaction began in. */
    private _txBurst: EditBurst | null = null;
    /** Listeners that send to the room (see `LocalUpdateListenerOptions`). */
    private _cloudLocalListeners = new Set<LocalUpdateListener>();
    /** Packets emitted in one synchronous task are one commit for the rate limit. */
    private _cloudCommitSerial = 0;
    private _cloudCommitOpen = false;
    private _unbindBurstFinalize: (() => void) | null = null;
    private _pageHideHandler: (() => void) | null = null;
    /**
     * While a multi-document commit is emitting, catalog projection waits
     * and lands as one core write after every glyph packet has been delivered.
     */
    private _catalogDeferDepth = 0;
    private _deferredCatalogOwners = new Set<{
        flushDeferredCatalogProjection?: () => void;
    }>();
    /** Collects glyph WAL clientTransactionIds for the next core revision row. */
    /**
     * Revision tokens of the glyph writes being emitted; each glyph's
     * envelope carries its token to the room (see `_withGlyphRevisionCatchUp`).
     */
    private _pendingGlyphRevisions: Map<string, string> | null = null;
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
    private _txIntents: Record<string, unknown> = {};
    private _afterOutermostCommit: Array<() => void> = [];
    /** Buffered operations for the current outermost transaction */
    private _txBufferedOperations: TransactionBufferedOperation[] = [];
    /** Apply-path classification (replaces suppress-flag cluster). */
    private _applyKind: ApplyKind = ApplyKind.Local;
    private _applyKindStack: ApplyKind[] = [];

    /**
     * Optional callback that receives every Yjs binary update (local and
     * remote) together with the ChangeLogEntry list so the compilation worker
     * can maintain its own Y.Doc without receiving the full font JSON on every
     * edit. Set via `setYjsWorkerCallback`.
     */
    private _yjsWorkerCallback: YjsWorkerCallback | null = null;
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
    private _beforeGlyphModelRebuildListeners =
        new Set<BeforeGlyphModelRebuildListener>();
    private _glyphModelRebuiltListeners = new Set<GlyphModelRebuiltListener>();
    private _historyReplayProblemListeners =
        new Set<HistoryReplayProblemListener>();
    /** Open model-rebuild scopes, innermost last. */
    private _glyphModelRebuildScopes: GlyphModelRebuildScope[] = [];
    private _runningBeforeGlyphModelRebuild = false;
    /** Depth of `_commitOperations` calls in progress. */
    private _commitDepth = 0;
    private _documentLoadedListeners = new Set<DocumentLoadedListener>();
    /** Documents created since the last load notification, in order. */
    private _documentsLoadedPendingNotice = new Set<string>();
    private _documentLoadedNoticeScheduled = false;
    private _destroyed = false;
    /** Latest revision token per glyph, from the font-core room's feed. */
    private _glyphRevisionFeed = new Map<string, string>();
    private _glyphRevisionFeedListeners = new Set<GlyphRevisionFeedListener>();
    /**
     * Revisions written by this window or relayed from its linked windows.
     * The feed can echo an older one after a newer local edit; such an echo
     * names content this window already has.
     */
    private _ownGlyphRevisions = new Set<string>();
    /**
     * Feed revisions waiting for the rest of their commit, by commit. A
     * composite fetched before its base would be recomposed here from the
     * old base, and the next edit would write that back over the sender's.
     */
    private _heldGlyphRevisions = new Map<
        string,
        {
            size: number;
            arrived: Set<string>;
            entries: Map<string, HeldGlyphRevision>;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    /** Feed revisions counted as they arrive, and the count of each glyph's. */
    private _glyphRevisionArrivals = 0;
    private _glyphRevisionFeedArrival = new Map<string, number>();
    private _coreHydratedListeners: Set<() => void> = new Set();
    /** Sparse residency: in-memory only. Never written to font-deps. */
    private _sparseSession = false;
    private _sparseWorkingGlyphIds: Set<string> = new Set();
    private _depsVersion = 0;
    private _sparseWriteClosureCache: {
        key: string;
        ids: string[];
    } | null = null;
    /** Callback to trigger dirty marking on the font manager side */
    private _onDirty: (() => void) | null = null;
    /** Callback after _syncJsonFromYDoc (undo/redo/remote) for external resync */
    private _onAfterSync: (() => void) | null = null;
    /** Nested HTTP hydrate applies one Font.fromData at the end, not per shard. */
    private _afterSyncDeferDepth = 0;
    private _afterSyncSkipped = false;

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
        return (
            this._txHistoryItemId ??
            this._currentBurst()?.historyItemId ??
            this._createHistoryItemId()
        );
    }

    private _collectDrawingFingerprintSnapshot(
        targets?: DrawingFingerprintTarget[] | null
    ): Map<string, DrawingFingerprintSnapshotEntry> {
        const snapshot = new Map<string, DrawingFingerprintSnapshotEntry>();
        const glyphs = (this._fontJson as Unsafe)?.glyphs;
        if (!Array.isArray(glyphs)) {
            return snapshot;
        }

        // Targeted fast path: when the caller scoped this to a small set of
        // (glyph, drawing) pairs, do an indexed lookup instead of iterating
        // every glyph and every drawing in the font. For 1058 glyphs with
        // ~5 drawings each, this is the difference between 5000+ iterations
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
                const drawingId = target?.layerId;
                if (!glyphName || !drawingId) continue;

                const targetKey = getDrawingFingerprintTargetKey(
                    glyphName,
                    drawingId
                );
                if (dedupe.has(targetKey)) continue;
                dedupe.add(targetKey);

                const glyph = ensureGlyphIndex().get(glyphName);
                if (!glyph) continue;

                const drawings = Array.isArray(glyph.layers)
                    ? glyph.layers
                    : [];
                // Drawing counts per glyph are tiny (typically 1-10). A linear
                // find here is faster than building a per-glyph index.
                const drawing = drawings.find(
                    (l: Unsafe) =>
                        typeof l?.id === 'string' && l.id === drawingId
                );
                if (!drawing) continue;

                snapshot.set(targetKey, {
                    glyphName,
                    layerId: drawingId,
                    fingerprint: getDrawingFingerprintFromJson(drawing)
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

            const drawings = Array.isArray(glyph.layers) ? glyph.layers : [];
            for (const drawing of drawings) {
                const drawingId =
                    typeof drawing?.id === 'string' ? drawing.id : null;
                if (!drawingId) {
                    continue;
                }

                const targetKey = getDrawingFingerprintTargetKey(
                    glyphName,
                    drawingId
                );
                snapshot.set(targetKey, {
                    glyphName,
                    layerId: drawingId,
                    fingerprint: getDrawingFingerprintFromJson(drawing)
                });
            }
        }

        return snapshot;
    }

    private _emitDrawingFingerprintChangedEvents(
        previousSnapshot: Map<string, DrawingFingerprintSnapshotEntry>,
        nextSnapshot: Map<string, DrawingFingerprintSnapshotEntry>
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
            const drawingId = next?.layerId ?? previous?.layerId;
            if (!glyphName || !drawingId) {
                continue;
            }

            window.dispatchEvent(
                new CustomEvent('drawingFingerprintChanged', {
                    detail: {
                        glyphName,
                        layerId: drawingId
                    }
                })
            );
        }
    }

    constructor(windowId?: string) {
        this.windowId = windowId ?? windowRole.instanceId;
        this.yDoc = new Y.Doc({ gc: true });
        this.depsDoc = new Y.Doc({ gc: true });
        this.depsDoc.on('update', () => {
            this._depsVersion += 1;
        });
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
            if (origin.startsWith(DRAWING_EDIT_ORIGIN_PREFIX)) return true;
            return false;
        };
        this._bindDocUpdates(this.yDoc, FONT_CORE_DOCUMENT_ID);
        this._bindDocUpdates(this.depsDoc, FONT_DEPS_DOCUMENT_ID);
        // Rooms a rebase moved away from stay readable while listed.
        this.yDoc.getMap(LAYOUT_MOVED_FROM_KEY).observe(() => {
            const layout = this.roomLayout;
            if (layout) {
                this._dropLayoutDocsOutside(layout);
            }
        });
        this.yDoc.getMap(LAYOUT_MAP_KEY).observe(() => {
            this._roomLayoutCache = undefined;
            const after = this.roomLayout;
            if (after) {
                this._dropLayoutDocsOutside(after);
            }
            // Compare with what listeners last heard, not with the cache:
            // code running in the same remote apply may already have read
            // the new layout.
            const key = JSON.stringify(after);
            if (key !== this._notifiedRoomLayoutKey) {
                this._notifiedRoomLayoutKey = key;
                for (const listener of [...this._roomLayoutListeners]) {
                    listener(after);
                }
            }
        });
        this._unbindBurstFinalize = this._editBursts.onFinalize((burst) => {
            this._liveBurstDrawings.delete(burst.key);
            this._cloudHold.flushBurst(burst.key);
            return this.waitForPendingCloudCommits();
        });
        if (typeof window !== 'undefined' && window.addEventListener) {
            // A tab that closes must not take a held burst with it.
            this._pageHideHandler = () => {
                void this._editBursts.finalizeAll();
                this._cloudHold.flushAll();
            };
            window.addEventListener('pagehide', this._pageHideHandler);
        }
    }

    private _isLocalEditOrigin: (origin: unknown) => boolean = () => false;

    private _bindDocUpdates(doc: Y.Doc, documentId: string): void {
        const handler = (update: YjsUpdate, origin: unknown) => {
            if (NETWORK_ORIGINS.has(origin)) {
                return;
            }
            this._queueLocalUpdate(documentId, update);
            if (
                this._isLocalEditOrigin(origin) &&
                !this._isApplyingRemote &&
                !this._suppressAutomaticLocalUpdateEmission
            ) {
                this._emitRawLocalUpdate(documentId);
            }
        };
        this._docUpdateUnsubById.get(documentId)?.();
        doc.on('update', handler);
        this._docUpdateUnsubById.set(documentId, () => {
            doc.off('update', handler);
        });
    }

    private _queueLocalUpdate(documentId: string, update: YjsUpdate): void {
        if (
            documentId === FONT_CORE_DOCUMENT_ID &&
            this._capturingLayoutCore &&
            this._layoutCoreOutbox
        ) {
            this._layoutCoreOutbox.push(update);
            return;
        }
        const queue = this._outbox.get(documentId);
        if (queue) {
            queue.push(update);
        } else {
            this._outbox.set(documentId, [update]);
        }
    }

    /**
     * Take every queued local update of `documentId`, merged in order. The
     * caller sends it; an empty update when nothing is queued.
     */
    private _takeOutbox(documentId: string): YjsUpdate {
        const queue = this._outbox.get(documentId);
        this._outbox.delete(documentId);
        if (!queue?.length) {
            return EMPTY_YJS_UPDATE;
        }
        return queue.length === 1 ? queue[0] : Y.mergeUpdates(queue);
    }

    /**
     * Put an update taken from the outbox back at its front: its packet
     * could not be made, and it stays queued ahead of later updates.
     */
    private _requeueUnsent(documentId: string, update: YjsUpdate): void {
        if (isEmptyYjsUpdate(update)) {
            return;
        }
        const queue = this._outbox.get(documentId);
        if (queue) {
            queue.unshift(update);
        } else {
            this._outbox.set(documentId, [update]);
        }
    }

    /** True while this window holds updates of `documentId` no packet carried. */
    hasUnsentLocalUpdates(documentId: string): boolean {
        return (this._outbox.get(documentId)?.length ?? 0) > 0;
    }

    /**
     * The document’s whole state reaches its room as a snapshot (a load, or a
     * seed of a new room), so its queued updates travel in that snapshot and
     * are not sent again as a packet.
     */
    private _noteWholeStateDelivered(documentId: string): void {
        this._outbox.delete(documentId);
    }

    /**
     * Send what a remote apply, catch-up or checkpoint left queued: local
     * writes observers made while it ran. Each goes out described as its
     * whole document, so no local transaction stays behind unsent.
     */
    private _flushStrandedOutboxes(): void {
        if (
            this._txDepth > 0 ||
            this._isApplyingRemote ||
            this._suppressAutomaticLocalUpdateEmission ||
            !this._outbox.size
        ) {
            return;
        }
        const packets: Array<{
            update: YjsUpdate;
            entries: ChangeLogEntry[];
            documentId: string;
        }> = [];
        for (const documentId of [...this._outbox.keys()]) {
            const update = this._takeOutbox(documentId);
            if (isEmptyYjsUpdate(update)) {
                continue;
            }
            packets.push({
                update,
                entries: [
                    this._wholeDocumentEntry(documentId, 'Document update')
                ],
                documentId
            });
        }
        if (packets.length) {
            this._emitLocalUpdateBatch(packets);
        }
    }

    /**
     * Describes a packet whose document changed without entries of its own
     * (an undo stamp, an observer write): receivers re-read the whole glyph,
     * or the whole document.
     */
    /**
     * Drop a glyph id from the name index, keeping the name it had: a
     * packet for that glyph's document (an undo that removes or brings back
     * the glyph, a stamp) is still described by that name.
     */
    private _forgetGlyphNameForId(glyphId: string): void {
        const glyphName = this._glyphNameById.get(glyphId);
        if (glyphName) {
            this._removedGlyphNameById.set(glyphId, glyphName);
        }
        this._glyphNameById.delete(glyphId);
    }

    private _wholeDocumentEntry(
        documentId: string,
        label: string
    ): ChangeLogEntry {
        const glyphId = glyphIdFromDocumentId(documentId);
        // A deleted glyph is described by the name it had when deleted.
        const glyphName = glyphId
            ? (this._glyphNameById.get(glyphId) ??
              this._removedGlyphNameById.get(glyphId))
            : null;
        if (glyphId && !glyphName) {
            throw new Error(
                `[PatchSyncEngine] ${documentId} changed but has no glyph name; its packet cannot be described`
            );
        }
        const path = glyphName
            ? joinPathWithGlyphSeparator(['glyphs', glyphName])
            : documentId === FONT_DEPS_DOCUMENT_ID
              ? FONT_DEPS_ENTRY_PATH
              : isLayoutDocumentId(documentId)
                ? layoutTopLevelKey(documentId)
                : 'font';
        return createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._createHistoryItemId(),
            historyAction: 'change',
            transactionLabel: label,
            transactionId: null,
            op: 'set',
            path,
            oldValue: undefined,
            newValue: undefined,
            replayOldValue: undefined,
            replayNewValue: undefined,
            compileChangeSource: null,
            compileEditType: null,
            ...(glyphName ? { undoScope: 'glyph' as const } : {})
        });
    }

    // ── Room layout 2 (cloud-room-layout.ts) ─────────────────────

    private _roomLayoutCache: RoomLayout | null | undefined = undefined;
    private _roomLayoutListeners = new Set<
        (layout: RoomLayout | null) => void
    >();
    private _notifiedRoomLayoutKey = 'null';

    /** Called when font-core's layout changes (a peer upgraded the font). */
    onRoomLayoutChange(
        listener: (layout: RoomLayout | null) => void
    ): () => void {
        this._roomLayoutListeners.add(listener);
        return () => this._roomLayoutListeners.delete(listener);
    }
    private _layoutDocs = new Map<string, Y.Doc>();
    private _routingLayout(): RoomLayout | null {
        return this.roomLayout;
    }

    /**
     * Rooms besides its own that one write reaches: a whole catalog, station
     * list, station or kerning map spreads over the buckets.
     */
    private _extraLayoutDocumentIds(path: Array<string | number>): string[] {
        const layout = this._routingLayout();
        if (!layout) {
            return [];
        }
        if (path[0] === CORE_GLYPH_CATALOG_KEY && path.length === 1) {
            return catalogRoomIds(layout);
        }
        if (
            path[0] === 'masters' &&
            (path.length <= 2 ||
                (path.length === 3 && kerningFieldDirection(String(path[2]))))
        ) {
            return kerningRoomIds(layout);
        }
        return [];
    }

    /** The asset's room layout, or null while it keeps everything in core. */
    get roomLayout(): RoomLayout | null {
        if (this._roomLayoutCache === undefined) {
            this._roomLayoutCache = parseRoomLayout(
                this.yDoc.getMap(LAYOUT_MAP_KEY).toJSON()
            );
        }
        return this._roomLayoutCache;
    }

    /** Document ids of the features, catalog and kerning rooms. */
    layoutDocumentIds(): string[] {
        const layout = this.roomLayout;
        return layout ? layoutDocumentIds(layout) : [];
    }

    /**
     * After a rebase, rooms the layout no longer names are not read. A room
     * the rebase moved away from is kept aside (retired) while font-core
     * lists it, so edits that reach it late can be carried over.
     */
    private _dropLayoutDocsOutside(layout: RoomLayout): void {
        const keep = new Set(layoutDocumentIds(layout));
        const moved = new Set(this.layoutMovedFromRoomIds());
        for (const [documentId, doc] of [...this._layoutDocs]) {
            if (keep.has(documentId)) continue;
            this._layoutDocs.delete(documentId);
            this._stateLoadedDocumentIds.delete(documentId);
            if (moved.has(documentId)) {
                this._retiredLayoutDocs.set(documentId, doc);
                this._retiredForwardReady = false;
                continue;
            }
            this._docUpdateUnsubById.get(documentId)?.();
            this._docUpdateUnsubById.delete(documentId);
            this._outbox.delete(documentId);
            doc.destroy();
        }
        for (const documentId of [...this._retiredLayoutDocs.keys()]) {
            if (!moved.has(documentId) || keep.has(documentId)) {
                this._dropRetiredLayoutDoc(documentId);
            }
        }
    }

    // ── Rebase hand-over: old rooms' late edits ──────────────────

    /** Rooms a rebase moved away from, held until their late edits are in. */
    private _retiredLayoutDocs = new Map<string, Y.Doc>();
    /**
     * True once the new rooms hold the copy here (and the old rooms are
     * caught up): late edits may be carried over as they arrive.
     */
    private _retiredForwardReady = false;
    private _retiredForwardScheduled = false;

    private _dropRetiredLayoutDoc(documentId: string): void {
        const doc = this._retiredLayoutDocs.get(documentId);
        if (!doc) return;
        this._docUpdateUnsubById.get(documentId)?.();
        this._docUpdateUnsubById.delete(documentId);
        this._retiredLayoutDocs.delete(documentId);
        doc.destroy();
    }

    /** Room ids font-core lists as moved away from by a rebase. */
    layoutMovedFromRoomIds(): string[] {
        return [...this.yDoc.getMap(LAYOUT_MOVED_FROM_KEY).keys()];
    }

    /** Old rooms this window still holds after a rebase. */
    retiredLayoutDocumentIds(): string[] {
        return [...this._retiredLayoutDocs.keys()];
    }

    /**
     * Hold every room font-core lists as moved away from (empty until
     * caught up), so the owner can carry over edits that reached them after
     * the windows that made them closed. Returns the held room ids.
     */
    retireMovedLayoutRooms(): string[] {
        const layout = this.roomLayout;
        if (!layout) {
            return [];
        }
        const current = new Set(layoutDocumentIds(layout));
        for (const documentId of this.layoutMovedFromRoomIds()) {
            if (
                current.has(documentId) ||
                this._retiredLayoutDocs.has(documentId) ||
                !isLayoutDocumentId(documentId)
            ) {
                continue;
            }
            const doc = new Y.Doc({ gc: false });
            this._retiredLayoutDocs.set(documentId, doc);
            this._bindDocUpdates(doc, documentId);
            this._retiredForwardReady = false;
        }
        return this.retiredLayoutDocumentIds();
    }

    /** Stop holding the old rooms (their late edits were carried over). */
    dropRetiredLayoutDocs(): void {
        for (const documentId of [...this._retiredLayoutDocs.keys()]) {
            this._dropRetiredLayoutDoc(documentId);
        }
        this._retiredForwardReady = false;
    }

    /** A room update for an old room: kept there, carried over later. */
    private _applyRetiredLayoutUpdate(
        documentId: string,
        update: Uint8Array
    ): boolean {
        const doc = this._retiredLayoutDocs.get(documentId);
        if (!doc || !update?.length) {
            return false;
        }
        applyUpdateWithIntegrity(
            doc,
            update,
            documentId,
            CLOUD_REMOTE_ORIGIN,
            this._brokenScope
        );
        this._scheduleRetiredForward();
        return true;
    }

    /**
     * A catalog or kerning room the layout does not name and this window
     * does not hold: an old room. Its updates are not read (they would
     * otherwise recreate it as a current room).
     */
    private _isReleasedLayoutRoom(documentId: string | undefined): boolean {
        if (!documentId || this._retiredLayoutDocs.has(documentId)) {
            return false;
        }
        const kind = layoutDocumentKind(documentId);
        if (kind !== 'catalog' && kind !== 'kerning') {
            return false;
        }
        const layout = this.roomLayout;
        return !!layout && !layoutDocumentIds(layout).includes(documentId);
    }

    private _scheduleRetiredForward(): void {
        if (!this._retiredForwardReady || this._retiredForwardScheduled) {
            return;
        }
        this._retiredForwardScheduled = true;
        queueMicrotask(() => {
            this._retiredForwardScheduled = false;
            this.forwardRetiredLayoutEdits();
        });
    }

    /**
     * Carry edits that reached the old rooms after a rebase copied them into
     * the new rooms. Call once the new rooms hold the copy here; from then on
     * edits arriving in the old rooms are carried over as they arrive.
     *
     * A key is written when its new room value is still the copy, or still
     * the value last carried over. A value edited in the new room since is
     * newer than anything left in an old room, and stays. Several windows
     * may carry the same edit; they write the same value. Returns the number
     * of keys written.
     */
    forwardRetiredLayoutEdits(): number {
        this._retiredForwardReady = true;
        const layout = this.roomLayout;
        if (!layout || !this._retiredLayoutDocs.size) {
            return 0;
        }
        const movedFrom = this.yDoc.getMap(LAYOUT_MOVED_FROM_KEY);
        const seeds = this.yDoc.getMap(LAYOUT_SEEDS_KEY);
        const current = new Set(layoutDocumentIds(layout));
        const byTarget = new Map<string, Map<string, unknown>>();
        for (const [documentId, doc] of this._retiredLayoutDocs) {
            const kind = layoutDocumentKind(documentId);
            if (kind !== 'catalog' && kind !== 'kerning') {
                continue;
            }
            const record = movedFrom.get(documentId) as
                MovedRoomRecord | undefined;
            if (!record?.snapshot) {
                continue;
            }
            let snapshot: Y.Snapshot;
            try {
                snapshot = Y.decodeSnapshot(base64ToBytes(record.snapshot));
            } catch {
                continue;
            }
            const root = doc.getMap(
                kind === 'catalog' ? CATALOG_ROOT_KEY : KERNING_ROOT_KEY
            );
            for (const key of keysChangedSinceSnapshot(doc, root, snapshot)) {
                let target: string | null = null;
                if (kind === 'catalog') {
                    target = catalogRoomFor(layout, key);
                } else {
                    const parsed = parseKerningKey(key);
                    target = parsed
                        ? kerningRoomFor(layout, parsed.pair)
                        : null;
                }
                if (!target || !current.has(target)) {
                    continue;
                }
                if (!byTarget.has(target)) {
                    byTarget.set(target, new Map());
                }
                byTarget.get(target)!.set(key, yValueJson(root.get(key)));
            }
        }
        let written = 0;
        const touchedKeys = new Set<string>();
        for (const [target, entries] of byTarget) {
            const doc = this._ensureLayoutDoc(target);
            const map = doc.getMap(
                layoutDocumentKind(target) === 'catalog'
                    ? CATALOG_ROOT_KEY
                    : KERNING_ROOT_KEY
            );
            const forwarded = doc.getMap(FORWARDED_ROOT_KEY);
            const seed = seeds.get(target) as SeededRoomRecord | undefined;
            const writes: Array<[string, unknown]> = [];
            for (const [key, value] of entries) {
                const now = yValueJson(map.get(key));
                if (stableJson(now) === stableJson(value)) {
                    continue;
                }
                const item = (
                    map as unknown as { _map: Map<string, Y.Item> }
                )._map.get(key);
                const untouched =
                    !item || (seed ? isUntouchedSeedEntry(item, seed) : false);
                if (
                    untouched ||
                    forwardedValueMatches(forwarded.get(key), now)
                ) {
                    writes.push([key, value]);
                }
            }
            if (!writes.length) {
                continue;
            }
            assertDocumentWritable(doc, target, this._brokenScope);
            doc.transact(() => {
                for (const [key, value] of writes) {
                    if (value === undefined) {
                        map.delete(key);
                    } else {
                        map.set(key, toYType(value));
                    }
                    forwarded.set(key, forwardedValueOf(value));
                }
            }, LAYOUT_FORWARD_ORIGIN);
            written += writes.length;
            const topKey = layoutTopLevelKey(target);
            touchedKeys.add(topKey);
            const entry = createLogEntry({
                timestamp: Date.now(),
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId: this._createHistoryItemId(),
                historyAction: 'change',
                transactionLabel: 'Room layout',
                transactionId: null,
                op: 'set',
                path: topKey,
                oldValue: undefined,
                newValue: undefined,
                replayOldValue: undefined,
                replayNewValue: undefined,
                compileChangeSource: 'cloud-room-layout',
                compileEditType: null
            });
            this._emitLocalUpdate(this._takeOutbox(target), [], target, {
                skipCollaborationLog: true,
                envelopeEntries: [entry]
            });
            if (layoutDocumentKind(target) === 'kerning') {
                this._workerDocumentReplaceCallback?.(
                    target,
                    Y.encodeStateAsUpdate(doc)
                );
            }
        }
        if (written) {
            for (const key of touchedKeys) {
                this._syncTopLevelFontKeyFromYDoc(key);
            }
            this._emitAfterSync();
            this._onDirty?.();
        }
        return written;
    }

    /**
     * Forget moves older than `cutoff`: their old rooms are no longer read
     * and get purged. The core change is sent with publishAdoptedRoomLayout.
     */
    pruneLayoutMoves(cutoff: number): boolean {
        if (this._layoutCoreOutbox) {
            return false;
        }
        const maps = [
            this.yDoc.getMap(LAYOUT_MOVED_FROM_KEY),
            this.yDoc.getMap(LAYOUT_SEEDS_KEY)
        ];
        const stale = maps.map((map) =>
            [...map.entries()]
                .filter(([, record]) => {
                    const at = Number((record as { at?: unknown })?.at);
                    return !Number.isFinite(at) || at < cutoff;
                })
                .map(([key]) => key)
        );
        if (!stale.some((keys) => keys.length)) {
            return false;
        }
        this._layoutCoreOutbox = [];
        this._pushApplyKind(ApplyKind.ManualEmit);
        this._capturingLayoutCore = true;
        try {
            this.yDoc.transact(() => {
                maps.forEach((map, index) => {
                    for (const key of stale[index]) map.delete(key);
                });
            }, FONT_EDIT_ORIGIN);
        } finally {
            this._capturingLayoutCore = false;
            this._popApplyKind();
        }
        return true;
    }

    /** How full the current layout's buckets are, for rebasedRoomLayout. */
    roomLayoutFill(): {
        largestCatalogBucket: number;
        largestKerningBucket: number;
        glyphs: number;
        kerningPairs: number;
    } | null {
        if (!this.roomLayout) {
            return null;
        }
        const catalogSizes = this._catalogBucketMaps().map((map) => map.size);
        const kerningSizes = this._kerningBucketMaps().map((map) => map.size);
        return {
            largestCatalogBucket: Math.max(0, ...catalogSizes),
            largestKerningBucket: Math.max(0, ...kerningSizes),
            glyphs: catalogSizes.reduce((a, b) => a + b, 0),
            kerningPairs: kerningSizes.reduce((a, b) => a + b, 0)
        };
    }

    /**
     * Move to a layout with more buckets (fresh room ids): write the catalog
     * and kerning into the new rooms and point font-core's layout at them.
     * Nothing is sent; like adoptRoomLayout, the owner's adapters seed the
     * new rooms and publishAdoptedRoomLayout sends the core change.
     */
    rebaseRoomLayout(next: RoomLayout): boolean {
        const current = this.roomLayout;
        if (!current || this._layoutCoreOutbox) {
            return false;
        }
        const catalogMoves =
            next.catalogBuckets !== current.catalogBuckets ||
            (next.catalogBase ?? 0) !== (current.catalogBase ?? 0);
        const kerningMoves =
            next.kerningBuckets !== current.kerningBuckets ||
            (next.kerningBase ?? 0) !== (current.kerningBase ?? 0);
        if (!catalogMoves && !kerningMoves) {
            return false;
        }
        const catalog = catalogMoves ? (this._readCatalogJson() ?? {}) : {};
        const stations = kerningMoves
            ? ((this._readTopLevelJsonFromY('masters') as unknown[]) ?? [])
            : [];
        this._layoutCoreOutbox = [];
        // What the copy holds of each old room: later edits there are
        // carried over (forwardRetiredLayoutEdits).
        const at = Date.now();
        const nextIds = new Set(layoutDocumentIds(next));
        const movedFrom = layoutDocumentIds(current)
            .filter((documentId) => !nextIds.has(documentId))
            .map((documentId): [string, MovedRoomRecord] => {
                const doc = this._layoutDocs.get(documentId);
                return [
                    documentId,
                    {
                        at,
                        snapshot: bytesToBase64(
                            Y.encodeSnapshot(
                                doc ? Y.snapshot(doc) : Y.emptySnapshot
                            )
                        )
                    }
                ];
            });
        this._pushApplyKind(ApplyKind.ManualEmit);
        this._capturingLayoutCore = true;
        try {
            this.yDoc.transact(() => {
                const map = this.yDoc.getMap(LAYOUT_MAP_KEY);
                map.set('catalogBuckets', next.catalogBuckets);
                map.set('kerningBuckets', next.kerningBuckets);
                map.set('catalogBase', next.catalogBase ?? 0);
                map.set('kerningBase', next.kerningBase ?? 0);
                const moved = this.yDoc.getMap(LAYOUT_MOVED_FROM_KEY);
                for (const [documentId, record] of movedFrom) {
                    moved.set(documentId, record);
                }
            }, FONT_EDIT_ORIGIN);
            this._roomLayoutCache = next;
            this._notifiedRoomLayoutKey = JSON.stringify(this.roomLayout);
            const byRoom = new Map<string, Array<[string, unknown]>>();
            const add = (documentId: string, key: string, value: unknown) => {
                if (!byRoom.has(documentId)) byRoom.set(documentId, []);
                byRoom.get(documentId)!.push([key, value]);
            };
            for (const [glyphId, entry] of Object.entries(catalog)) {
                add(catalogRoomFor(next, glyphId), glyphId, toYType(entry));
            }
            for (const station of Array.isArray(stations) ? stations : []) {
                const record = (station ?? {}) as Record<string, unknown>;
                const stationId =
                    typeof record.id === 'string' ? record.id : '';
                if (!stationId) continue;
                for (const direction of ['l', 'r'] as const) {
                    for (const [pair, value] of Object.entries(
                        flattenKerningMap(
                            record[kerningFieldForDirection(direction)]
                        )
                    )) {
                        add(
                            kerningRoomFor(next, pair),
                            kerningKey(stationId, direction, pair),
                            value
                        );
                    }
                }
            }
            for (const [documentId, entries] of byRoom) {
                const doc = this._ensureLayoutDoc(documentId);
                const root =
                    layoutDocumentKind(documentId) === 'catalog'
                        ? CATALOG_ROOT_KEY
                        : KERNING_ROOT_KEY;
                doc.transact(() => {
                    const map = doc.getMap(root);
                    for (const [key, value] of entries) {
                        map.set(key, value);
                    }
                }, FONT_EDIT_ORIGIN);
            }
            // Which items of the new rooms are the copy: a value made only
            // of them was not edited since the move.
            this.yDoc.transact(() => {
                const seeds = this.yDoc.getMap(LAYOUT_SEEDS_KEY);
                for (const documentId of nextIds) {
                    if (layoutDocumentIds(current).includes(documentId)) {
                        continue;
                    }
                    const doc = this._ensureLayoutDoc(documentId);
                    seeds.set(documentId, {
                        at,
                        client: doc.clientID,
                        clock: Y.getState(doc.store, doc.clientID)
                    } satisfies SeededRoomRecord);
                }
            }, FONT_EDIT_ORIGIN);
        } finally {
            this._capturingLayoutCore = false;
            this._popApplyKind();
        }
        this._dropLayoutDocsOutside(next);
        // The new rooms are seeded from these states (see above); rooms the
        // layout keeps send their queued edits as usual.
        const keptRoomIds = new Set(layoutDocumentIds(current));
        for (const documentId of layoutDocumentIds(next)) {
            this._ensureLayoutDoc(documentId);
            if (!keptRoomIds.has(documentId)) {
                this._noteWholeStateDelivered(documentId);
                // Built here: this window holds the new room's whole state.
                this._stateLoadedDocumentIds.add(documentId);
            }
        }
        for (const documentId of [
            FONT_CORE_DOCUMENT_ID,
            ...kerningRoomIds(next)
        ]) {
            const doc = this._docForId(documentId);
            if (doc) {
                this._workerDocumentReplaceCallback?.(
                    documentId,
                    Y.encodeStateAsUpdate(doc)
                );
            }
        }
        return true;
    }

    private _destroyLayoutDocs(): void {
        for (const [documentId, doc] of this._layoutDocs) {
            this._docUpdateUnsubById.get(documentId)?.();
            this._docUpdateUnsubById.delete(documentId);
            this._outbox.delete(documentId);
            this._stateLoadedDocumentIds.delete(documentId);
            doc.destroy();
        }
        this._layoutDocs.clear();
        this.dropRetiredLayoutDocs();
        this._layoutCoreOutbox = null;
    }

    private _ensureLayoutDoc(documentId: string): Y.Doc {
        let doc = this._layoutDocs.get(documentId);
        if (!doc) {
            this._assertDocumentIdWritable(documentId);
            doc = new Y.Doc({ gc: false });
            this._layoutDocs.set(documentId, doc);
            this._bindDocUpdates(doc, documentId);
            this._noteDocumentLoaded(documentId);
        }
        return doc;
    }

    /**
     * The features room stores `features` exactly as font-core did: root map
     * `font`, key `features`, so paths and the indexed feature list match.
     */
    private _featuresRoot(): Y.Map<unknown> {
        return this._ensureLayoutDoc(FONT_FEATURES_DOCUMENT_ID).getMap(
            FEATURES_ROOT_KEY
        );
    }

    private _featuresYMap(): Y.Map<unknown> | null {
        const value = this.roomLayout
            ? this._featuresRoot().get('features')
            : this.fontMap.get('features');
        return value instanceof Y.Map ? value : null;
    }

    private _catalogBucketMap(glyphId: string): Y.Map<unknown> {
        const layout = this.roomLayout as RoomLayout;
        return this._ensureLayoutDoc(catalogRoomFor(layout, glyphId)).getMap(
            CATALOG_ROOT_KEY
        );
    }

    private _catalogBucketMaps(): Array<Y.Map<unknown>> {
        const layout = this.roomLayout;
        if (!layout) {
            return [];
        }
        return catalogRoomIds(layout).map((documentId) =>
            this._ensureLayoutDoc(documentId).getMap(CATALOG_ROOT_KEY)
        );
    }

    private _kerningBucketMaps(): Array<Y.Map<unknown>> {
        const layout = this.roomLayout;
        if (!layout) {
            return [];
        }
        return kerningRoomIds(layout).map((documentId) =>
            this._ensureLayoutDoc(documentId).getMap(KERNING_ROOT_KEY)
        );
    }

    private _kerningBucketMap(pair: string): Y.Map<unknown> {
        const layout = this.roomLayout as RoomLayout;
        return this._ensureLayoutDoc(kerningRoomFor(layout, pair)).getMap(
            KERNING_ROOT_KEY
        );
    }

    /** Catalog entry from whichever store this asset uses. */
    private _catalogYEntry(glyphId: string): unknown {
        if (this.roomLayout) {
            return this._catalogBucketMap(glyphId).get(glyphId);
        }
        const yCatalog = this.fontMap.get(CORE_GLYPH_CATALOG_KEY);
        return yCatalog instanceof Y.Map ? yCatalog.get(glyphId) : undefined;
    }

    /** Every catalog entry, as JSON, from whichever store this asset uses. */
    private _readCatalogJson(): Record<string, unknown> | undefined {
        if (!this.roomLayout) {
            const yCatalog = this.fontMap.get(CORE_GLYPH_CATALOG_KEY);
            return yCatalog instanceof Y.Map
                ? (fromYType(yCatalog) as Record<string, unknown>)
                : undefined;
        }
        const catalog: Record<string, unknown> = {};
        for (const map of this._catalogBucketMaps()) {
            Object.assign(catalog, fromYType(map) as Record<string, unknown>);
        }
        return catalog;
    }

    private _stationIdAt(index: number): string | null {
        const stations = this.fontMap.get('masters');
        if (!(stations instanceof Y.Array)) {
            return null;
        }
        const station = stations.get(index);
        const id =
            station instanceof Y.Map
                ? station.get('id')
                : (station as { id?: unknown } | undefined)?.id;
        return typeof id === 'string' && id ? id : null;
    }

    private _stationIds(): string[] {
        const stations = this.fontMap.get('masters');
        if (!(stations instanceof Y.Array)) {
            return [];
        }
        return stations
            .toArray()
            .map((station) =>
                station instanceof Y.Map
                    ? station.get('id')
                    : (station as { id?: unknown } | undefined)?.id
            )
            .filter((id): id is string => typeof id === 'string' && !!id);
    }

    /** Flat pairs of one station and direction from the kerning rooms. */
    private _readKerningPairs(
        stationId: string,
        direction: KerningDirection
    ): Record<string, unknown> {
        const pairs: Record<string, unknown> = {};
        for (const map of this._kerningBucketMaps()) {
            map.forEach((value, key) => {
                const parsed = parseKerningKey(key);
                if (
                    parsed &&
                    parsed.masterId === stationId &&
                    parsed.direction === direction
                ) {
                    pairs[parsed.pair] = value;
                }
            });
        }
        return pairs;
    }

    /** Make one station's pairs in one direction equal `next`. */
    private _writeKerningPairs(
        stationId: string,
        direction: KerningDirection,
        next: Record<string, number> | null
    ): void {
        const wanted = next ?? {};
        const current = this._readKerningPairs(stationId, direction);
        for (const pair of Object.keys(current)) {
            if (!(pair in wanted)) {
                this._kerningBucketMap(pair).delete(
                    kerningKey(stationId, direction, pair)
                );
            }
        }
        for (const [pair, value] of Object.entries(wanted)) {
            if (current[pair] !== value) {
                this._kerningBucketMap(pair).set(
                    kerningKey(stationId, direction, pair),
                    value
                );
            }
        }
    }

    private _deleteStationKerning(stationId: string): void {
        this._writeKerningPairs(stationId, 'l', null);
        this._writeKerningPairs(stationId, 'r', null);
    }

    /** A station as stored in core under layout 2: without its kerning. */
    private _withoutKerning(station: unknown): unknown {
        if (!station || typeof station !== 'object' || Array.isArray(station)) {
            return station;
        }
        const { kerning, kerning_rtl, ...rest } = station as Record<
            string,
            unknown
        >;
        void kerning;
        void kerning_rtl;
        return rest;
    }

    /** Move a station value's kerning fields into the kerning rooms. */
    private _writeStationKerningFromValue(station: unknown): void {
        if (!station || typeof station !== 'object' || Array.isArray(station)) {
            return;
        }
        const record = station as Record<string, unknown>;
        const stationId = typeof record.id === 'string' ? record.id : null;
        if (!stationId) {
            return;
        }
        for (const direction of ['l', 'r'] as const) {
            const field = kerningFieldForDirection(direction);
            if (field in record) {
                this._writeKerningPairs(
                    stationId,
                    direction,
                    flattenKerningMap(record[field])
                );
            }
        }
    }

    /**
     * Layout 2 writes that no single Y path can express. Returns true when
     * the write was handled here.
     */
    private _layoutSetPath(
        path: Array<string | number>,
        value: unknown
    ): boolean {
        if (path[0] === LAYOUT_MAP_KEY) {
            // Only adoptRoomLayout (and a later rebase) writes the layout.
            return true;
        }
        const layout = this.roomLayout;
        if (!layout) {
            return false;
        }
        const root = path[0];
        if (root === 'features' && path.length === 1) {
            setYPath(this._featuresRoot(), ['features'], value);
            return true;
        }
        if (root === CORE_CODEPOINT_INDEX_KEY) {
            // Derived from the catalog in memory; never stored in layout 2.
            return true;
        }
        if (root === CORE_GLYPH_CATALOG_KEY && path.length === 1) {
            const next =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? (value as Record<string, unknown>)
                    : {};
            for (const map of this._catalogBucketMaps()) {
                for (const glyphId of [...map.keys()]) {
                    if (!(glyphId in next)) {
                        map.delete(glyphId);
                    }
                }
            }
            for (const [glyphId, entry] of Object.entries(next)) {
                this._replaceYMapEntry(
                    this._catalogBucketMap(glyphId),
                    glyphId,
                    entry
                );
            }
            return true;
        }
        if (root !== 'masters') {
            return false;
        }
        if (path.length === 1) {
            const next = Array.isArray(value) ? value : [];
            const keep = new Set(
                next
                    .map((station) => (station as { id?: unknown })?.id)
                    .filter((id): id is string => typeof id === 'string')
            );
            for (const stationId of this._stationIds()) {
                if (!keep.has(stationId)) {
                    this._deleteStationKerning(stationId);
                }
            }
            const existing = new Set(this._stationIds());
            this._replaceYMapEntry(
                this.fontMap,
                'masters',
                next.map((station) => this._withoutKerning(station))
            );
            // Kerning edits arrive on kerning paths. A whole station list only
            // brings the kerning of stations that are new here: a copy read
            // before the kerning rooms loaded would otherwise wipe them.
            for (const station of next) {
                const id = (station as { id?: unknown } | null)?.id;
                if (typeof id === 'string' && !existing.has(id)) {
                    this._writeStationKerningFromValue(station);
                }
            }
            return true;
        }
        if (path.length === 2) {
            const id = (value as { id?: unknown } | null)?.id;
            const isNew =
                typeof id === 'string' && !this._stationIds().includes(id);
            setYPath(this.fontMap, path, this._withoutKerning(value));
            if (isNew) {
                this._writeStationKerningFromValue(value);
            }
            return true;
        }
        const direction = kerningFieldDirection(String(path[2]));
        if (!direction) {
            return false;
        }
        const stationId = this._stationIdAt(Number(path[1]));
        if (!stationId) {
            return true;
        }
        if (path.length === 3) {
            this._writeKerningPairs(
                stationId,
                direction,
                flattenKerningMap(value)
            );
            return true;
        }
        const pair = String(path[3]);
        const bucket = this._kerningBucketMap(pair);
        const key = kerningKey(stationId, direction, pair);
        if (value === undefined || value === null) {
            bucket.delete(key);
        } else {
            bucket.set(key, value);
        }
        return true;
    }

    private _layoutDeletePath(path: Array<string | number>): boolean {
        if (path[0] === LAYOUT_MAP_KEY) {
            // A layout is never taken back; a rebase replaces it.
            return true;
        }
        const layout = this.roomLayout;
        if (!layout) {
            return false;
        }
        const root = path[0];
        if (root === 'features' && path.length === 1) {
            this._featuresRoot().delete('features');
            return true;
        }
        if (root === CORE_CODEPOINT_INDEX_KEY) {
            return true;
        }
        if (root === CORE_GLYPH_CATALOG_KEY && path.length === 1) {
            for (const map of this._catalogBucketMaps()) {
                for (const glyphId of [...map.keys()]) {
                    map.delete(glyphId);
                }
            }
            return true;
        }
        if (root !== 'masters') {
            return false;
        }
        if (path.length === 1) {
            for (const stationId of this._stationIds()) {
                this._deleteStationKerning(stationId);
            }
            this.fontMap.delete('masters');
            return true;
        }
        if (path.length === 2) {
            const stationId = this._stationIdAt(Number(path[1]));
            if (stationId) {
                this._deleteStationKerning(stationId);
            }
            deleteYPath(this.fontMap, path);
            return true;
        }
        const direction = kerningFieldDirection(String(path[2]));
        if (!direction) {
            return false;
        }
        const stationId = this._stationIdAt(Number(path[1]));
        if (!stationId) {
            return true;
        }
        if (path.length === 3) {
            this._writeKerningPairs(stationId, direction, null);
            return true;
        }
        const pair = String(path[3]);
        this._kerningBucketMap(pair).delete(
            kerningKey(stationId, direction, pair)
        );
        return true;
    }

    /** Layout 2 reads that no single Y path can express; undefined if not. */
    private _layoutGetPath(path: Array<string | number>): {
        handled: boolean;
        value?: unknown;
    } {
        if (path[0] === LAYOUT_MAP_KEY) {
            return {
                handled: true,
                value:
                    path.length === 1
                        ? this.yDoc.getMap(LAYOUT_MAP_KEY)
                        : getYPath(
                              this.yDoc.getMap(LAYOUT_MAP_KEY),
                              path.slice(1)
                          )
            };
        }
        if (!this.roomLayout) {
            return { handled: false };
        }
        const root = path[0];
        if (root === CORE_CODEPOINT_INDEX_KEY) {
            return { handled: true, value: undefined };
        }
        if (root === CORE_GLYPH_CATALOG_KEY && path.length === 1) {
            return { handled: true, value: this._readCatalogJson() };
        }
        if (root === 'masters' && path.length >= 3) {
            const direction = kerningFieldDirection(String(path[2]));
            if (!direction) {
                return { handled: false };
            }
            const stationId = this._stationIdAt(Number(path[1]));
            if (!stationId) {
                return { handled: true, value: undefined };
            }
            if (path.length === 3) {
                return {
                    handled: true,
                    value: this._readKerningPairs(stationId, direction)
                };
            }
            const pair = String(path[3]);
            return {
                handled: true,
                value: this._kerningBucketMap(pair).get(
                    kerningKey(stationId, direction, pair)
                )
            };
        }
        return { handled: false };
    }

    /**
     * Logical top-level font value as JSON: layout 2 assembles features,
     * the catalog and station kerning from their rooms.
     */
    private _readTopLevelJsonFromY(key: string): unknown {
        if (this.roomLayout) {
            if (key === 'features') {
                const features = this._featuresRoot().get('features');
                // Empty until the features room loads; its catch-up re-reads.
                return features === undefined
                    ? { classes: {}, prefixes: {}, features: [] }
                    : fromYType(features);
            }
            if (key === CORE_GLYPH_CATALOG_KEY) {
                return this._readCatalogJson();
            }
            if (key === CORE_CODEPOINT_INDEX_KEY) {
                return codepointIndexFromCatalog(this._readCatalogJson());
            }
            if (key === 'masters') {
                const stations = this.fontMap.get('masters');
                if (stations === undefined) {
                    return undefined;
                }
                const json = fromYType(stations);
                if (Array.isArray(json)) {
                    for (const station of json) {
                        if (!station || typeof station !== 'object') continue;
                        const record = station as Record<string, unknown>;
                        const id =
                            typeof record.id === 'string' ? record.id : '';
                        record.kerning = this._readKerningPairs(id, 'l');
                        record.kerning_rtl = this._readKerningPairs(id, 'r');
                    }
                }
                return json;
            }
        }
        const value = this.fontMap.get(key);
        return value === undefined ? undefined : fromYType(value);
    }

    /** Top-level keys of the logical font, across core and layout rooms. */
    private _logicalTopLevelKeys(): Set<string> {
        const keys = new Set<string>();
        this.fontMap.forEach((_value: unknown, key: string) => {
            keys.add(key);
        });
        if (this.roomLayout) {
            keys.add('features');
            keys.add(CORE_GLYPH_CATALOG_KEY);
            keys.add(CORE_CODEPOINT_INDEX_KEY);
        }
        return keys;
    }

    /**
     * Writing the layout map. The first layout moves this asset's features,
     * catalog and station kerning out of core in the same core transaction;
     * the caller writes their values to the rooms right after (see
     * adoptRoomLayout).
     */
    private _setRoomLayoutValue(value: unknown): void {
        const layout = parseRoomLayout(value);
        if (!layout) {
            return;
        }
        const previous = this.roomLayout;
        if (
            previous &&
            (previous.catalogBuckets !== layout.catalogBuckets ||
                previous.kerningBuckets !== layout.kerningBuckets)
        ) {
            throw new Error(
                'A room layout cannot change bucket counts in place; rebase the asset.'
            );
        }
        const map = this.yDoc.getMap(LAYOUT_MAP_KEY);
        map.set('version', layout.version);
        map.set('catalogBuckets', layout.catalogBuckets);
        map.set('kerningBuckets', layout.kerningBuckets);
        this._roomLayoutCache = layout;
        if (previous) {
            return;
        }
        this.fontMap.delete('features');
        this.fontMap.delete(CORE_GLYPH_CATALOG_KEY);
        this.fontMap.delete(CORE_CODEPOINT_INDEX_KEY);
        const stations = this.fontMap.get('masters');
        if (stations instanceof Y.Array) {
            for (const station of stations.toArray()) {
                if (station instanceof Y.Map) {
                    station.delete('kerning');
                    station.delete('kerning_rtl');
                }
            }
        }
    }

    /**
     * True between adoptRoomLayout and publishAdoptedRoomLayout: this window
     * is the one moving the asset to layout 2 and may seed its empty rooms.
     */
    isAdoptingRoomLayout(): boolean {
        return this._layoutCoreOutbox !== null;
    }

    /**
     * Move a layout 1 asset to room layout 2 in this window: core gets the
     * layout and loses its features, catalog and station kerning; the rooms
     * get them. Nothing is sent. A new asset then seeds the whole document
     * set. An asset that already has rooms seeds the layout rooms (they can
     * be far larger than one live write) and then calls
     * publishAdoptedRoomLayout, which sends the core change to peers.
     */
    adoptRoomLayout(
        layout: RoomLayout,
        options: { seedsWholeAsset?: boolean } = {}
    ): boolean {
        if (this.roomLayout) {
            return false;
        }
        const features = this._readTopLevelJsonFromY('features');
        const catalog = this._readTopLevelJsonFromY(CORE_GLYPH_CATALOG_KEY);
        const stations = this._readTopLevelJsonFromY('masters');
        this._layoutCoreOutbox = [];
        this._pushApplyKind(ApplyKind.ManualEmit);
        this._capturingLayoutCore = true;
        try {
            this.yDoc.transact(
                () => this._setRoomLayoutValue(layout),
                FONT_EDIT_ORIGIN
            );
            if (features !== undefined) {
                this._ensureLayoutDoc(FONT_FEATURES_DOCUMENT_ID).transact(
                    () =>
                        setYPath(this._featuresRoot(), ['features'], features),
                    FONT_EDIT_ORIGIN
                );
            }
            const byCatalogBucket = new Map<string, Array<[string, unknown]>>();
            for (const [glyphId, entry] of Object.entries(
                (catalog as Record<string, unknown> | undefined) ?? {}
            )) {
                const documentId = catalogRoomFor(layout, glyphId);
                if (!byCatalogBucket.has(documentId)) {
                    byCatalogBucket.set(documentId, []);
                }
                byCatalogBucket.get(documentId)!.push([glyphId, entry]);
            }
            for (const [documentId, entries] of byCatalogBucket) {
                const doc = this._ensureLayoutDoc(documentId);
                doc.transact(() => {
                    const map = doc.getMap(CATALOG_ROOT_KEY);
                    for (const [glyphId, entry] of entries) {
                        map.set(glyphId, toYType(entry));
                    }
                }, FONT_EDIT_ORIGIN);
            }
            const byKerningBucket = new Map<string, Array<[string, unknown]>>();
            for (const station of Array.isArray(stations) ? stations : []) {
                const record = (station ?? {}) as Record<string, unknown>;
                const stationId =
                    typeof record.id === 'string' ? record.id : '';
                if (!stationId) continue;
                for (const direction of ['l', 'r'] as const) {
                    const pairs = flattenKerningMap(
                        record[kerningFieldForDirection(direction)]
                    );
                    for (const [pair, value] of Object.entries(pairs)) {
                        const documentId = kerningRoomFor(layout, pair);
                        if (!byKerningBucket.has(documentId)) {
                            byKerningBucket.set(documentId, []);
                        }
                        byKerningBucket
                            .get(documentId)!
                            .push([
                                kerningKey(stationId, direction, pair),
                                value
                            ]);
                    }
                }
            }
            for (const [documentId, entries] of byKerningBucket) {
                const doc = this._ensureLayoutDoc(documentId);
                doc.transact(() => {
                    const map = doc.getMap(KERNING_ROOT_KEY);
                    for (const [key, value] of entries) {
                        map.set(key, value);
                    }
                }, FONT_EDIT_ORIGIN);
            }
            for (const documentId of layoutDocumentIds(layout)) {
                this._ensureLayoutDoc(documentId);
            }
        } finally {
            this._capturingLayoutCore = false;
            this._popApplyKind();
        }
        // The rooms are seeded from these states; nothing of them is a
        // pending live delta. A new asset seeds core too.
        for (const documentId of layoutDocumentIds(layout)) {
            this._noteWholeStateDelivered(documentId);
            // Built here: this window holds each seeded room's whole state.
            this._stateLoadedDocumentIds.add(documentId);
        }
        if (options.seedsWholeAsset) {
            this._noteWholeStateDelivered(FONT_CORE_DOCUMENT_ID);
            this._layoutCoreOutbox = null;
        }
        for (const documentId of [
            FONT_CORE_DOCUMENT_ID,
            FONT_FEATURES_DOCUMENT_ID,
            ...kerningRoomIds(layout)
        ]) {
            const doc = this._docForId(documentId);
            if (doc) {
                this._workerDocumentReplaceCallback?.(
                    documentId,
                    Y.encodeStateAsUpdate(doc)
                );
            }
        }
        return true;
    }

    /**
     * Send the core half of adoptRoomLayout once the layout rooms are seeded:
     * peers read the layout and stop reading features, the catalog and
     * kerning from core.
     */
    publishAdoptedRoomLayout(): boolean {
        const queued = this._layoutCoreOutbox;
        if (!queued || !this.roomLayout) {
            return false;
        }
        this._layoutCoreOutbox = null;
        if (!queued.length) {
            return false;
        }
        const update = Y.mergeUpdates(queued);
        const historyItemId = this._createHistoryItemId();
        const entries = [
            LAYOUT_MAP_KEY,
            'features',
            CORE_GLYPH_CATALOG_KEY,
            'masters'
        ].map((path) =>
            createLogEntry({
                timestamp: Date.now(),
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Room layout',
                transactionId: null,
                op: 'set',
                path,
                oldValue: undefined,
                newValue: undefined,
                replayOldValue: undefined,
                replayNewValue: undefined,
                compileChangeSource: 'cloud-room-layout',
                compileEditType: null
            })
        );
        this._emitLocalUpdate(update, [], FONT_CORE_DOCUMENT_ID, {
            skipCollaborationLog: true,
            envelopeEntries: entries
        });
        return true;
    }

    documentIdForPath(path: Array<string | number>): string {
        const layout = this._routingLayout();
        if (layout) {
            if (path[0] === 'features') {
                return FONT_FEATURES_DOCUMENT_ID;
            }
            if (path[0] === CORE_GLYPH_CATALOG_KEY && path.length >= 2) {
                return catalogRoomFor(layout, String(path[1]));
            }
            if (
                path[0] === 'masters' &&
                path.length >= 3 &&
                kerningFieldDirection(String(path[2]))
            ) {
                // A whole kerning map spreads over every bucket (see
                // _extraLayoutDocumentIds); it does not touch core.
                return path.length === 3
                    ? kerningRoomIds(layout)[0]
                    : kerningRoomFor(layout, String(path[3]));
            }
        }
        if (path[0] === 'glyphs' && path.length >= 2) {
            const key = String(path[1]);
            const glyphId =
                this._glyphIdByName.get(key) ||
                this._retiredGlyphIdByName.get(key) ||
                key;
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

    /**
     * The Y.Doc object that holds a document here, or null when it is not
     * loaded. Its identity changes when the document is unloaded or
     * replaced, so state keyed by it (catch-up cursors) goes with it.
     */
    getDocumentInstance(documentId: string): Y.Doc | null {
        return this._docForId(documentId);
    }

    private _docForId(documentId: string): Y.Doc | null {
        if (documentId === FONT_CORE_DOCUMENT_ID) {
            return this.yDoc;
        }
        if (documentId === FONT_DEPS_DOCUMENT_ID) {
            return this.depsDoc;
        }
        if (isLayoutDocumentId(documentId)) {
            return (
                this._layoutDocs.get(documentId) ||
                this._retiredLayoutDocs.get(documentId) ||
                null
            );
        }
        if (documentId.startsWith('glyph:')) {
            return (
                this._wakeGlyphDoc(documentId.slice('glyph:'.length)) || null
            );
        }
        return this._wakeGlyphDoc(documentId) || null;
    }

    /** True when this window holds the glyph shard (either live or dormant). */
    private _hasHeldGlyphDoc(glyphId: string): boolean {
        return (
            this._glyphDocs.has(glyphId) ||
            this._dormantGlyphStates.has(glyphId)
        );
    }

    private _heldGlyphDocCount(): number {
        return this._glyphDocs.size + this._dormantGlyphStates.size;
    }

    private _touchLiveGlyphDoc(glyphId: string, doc: Y.Doc): void {
        // Refresh Map insertion order for O(1) LRU tracking.
        this._glyphDocs.delete(glyphId);
        this._glyphDocs.set(glyphId, doc);
    }

    /**
     * Return the live Y.Doc for `glyphId`, rehydrating it from
     * `_dormantGlyphStates` on demand while preserving exact CRDT item IDs,
     * clientIDs, clocks, and state vectors.
     */
    private _wakeGlyphDoc(glyphId: string): Y.Doc | null {
        const existing = this._glyphDocs.get(glyphId);
        if (existing) {
            this._touchLiveGlyphDoc(glyphId, existing);
            return existing;
        }
        const dormantBytes = this._dormantGlyphStates.get(glyphId);
        if (!dormantBytes) {
            return null;
        }
        this._dormantGlyphStates.delete(glyphId);
        const documentId = glyphDocumentId(glyphId);
        const doc = new Y.Doc({ gc: true });
        Y.applyUpdate(doc, dormantBytes, SYSTEM_REMOTE_ORIGIN);
        const checkpoint = this._dormantDocumentCheckpoints.get(documentId);
        if (checkpoint) {
            this._dormantDocumentCheckpoints.delete(documentId);
            this._documentCheckpoints.set(doc, checkpoint);
        }
        this._glyphDocs.set(glyphId, doc);
        this._bindDocUpdates(doc, documentId);
        if (
            this._glyphEvictionSuspendDepth === 0 &&
            this._glyphDocs.size > PatchSyncEngine.MAX_LIVE_GLYPH_DOCS
        ) {
            this._evictIdleLiveGlyphDocs(
                PatchSyncEngine.MAX_LIVE_GLYPH_DOCS,
                glyphId
            );
        }
        return doc;
    }

    /**
     * Compact a live glyph Y.Doc back into `_dormantGlyphStates` and destroy
     * its decoded CRDT tree when it has no pending/unsent/in-flight state.
     */
    private _parkGlyphDoc(glyphId: string, protectGlyphId?: string): boolean {
        if (glyphId === protectGlyphId) {
            return false;
        }
        const doc = this._glyphDocs.get(glyphId);
        if (!doc) {
            return false;
        }
        const documentId = glyphDocumentId(glyphId);
        if (
            this._pendingDestroyedGlyphIds.has(glyphId) ||
            this._outbox.get(documentId)?.length ||
            this.hasGlyphCatchUp(documentId) ||
            isDocumentBroken(doc) ||
            this.isDocumentIdBroken(documentId)
        ) {
            return false;
        }
        const bytes = Y.encodeStateAsUpdate(doc);
        const checkpoint = this._documentCheckpoints.get(doc);
        if (checkpoint) {
            this._dormantDocumentCheckpoints.set(documentId, checkpoint);
        }
        this._dormantGlyphStates.set(glyphId, bytes);
        this._lastEncodedShardBytes.set(documentId, bytes.byteLength);
        this._docUpdateUnsubById.get(documentId)?.();
        this._docUpdateUnsubById.delete(documentId);
        this._glyphDocs.delete(glyphId);
        doc.destroy();
        return true;
    }

    /**
     * Evict least-recently-used live glyph Y.Docs back to dormant bytes until
     * at most `maxLive` remain decoded.
     */
    private _evictIdleLiveGlyphDocs(
        maxLive: number = PatchSyncEngine.MAX_LIVE_GLYPH_DOCS,
        protectGlyphId?: string
    ): number {
        if (this._glyphDocs.size <= maxLive) {
            return 0;
        }
        const activeGlyphName =
            typeof window !== 'undefined'
                ? (
                      window as Window & {
                          glyphCanvas?: {
                              getCurrentGlyphName?: () => string | null;
                          };
                      }
                  ).glyphCanvas?.getCurrentGlyphName?.() || null
                : null;
        const activeGlyphId = activeGlyphName
            ? this._glyphIdByName.get(activeGlyphName)
            : undefined;
        let parked = 0;
        for (const glyphId of [...this._glyphDocs.keys()]) {
            if (this._glyphDocs.size <= maxLive) {
                break;
            }
            if (glyphId === activeGlyphId) {
                continue;
            }
            if (this._parkGlyphDoc(glyphId, protectGlyphId)) {
                parked += 1;
            }
        }
        return parked;
    }

    /**
     * The document `documentId` names. One this window does not hold is an
     * error: its bytes or writes never go into another document instead.
     */
    private _requireDocForId(documentId: string): Y.Doc {
        const doc = this._docForId(documentId);
        if (!doc) {
            throw new Error(
                `[PatchSyncEngine] “${documentId}” is not loaded in this window`
            );
        }
        return doc;
    }

    /**
     * A glyph this window does not hold is made only from its complete
     * state. A delta names only what changed, and a glyph made from it would
     * lack everything else (its name, its drawings’ widths), so it is
     * refused before the document exists. A state that integrates into an
     * empty document can still be a delta: a client’s first edit to a root
     * map starts at clock 0. A complete glyph state carries the glyph’s name.
     */
    private _assertCompleteGlyphState(
        update: Uint8Array,
        documentId: string
    ): void {
        assertCompleteGlyphState(update, documentId);
    }

    private _glyphMapForName(glyphName: string): Y.Map<unknown> | null {
        const glyphId = this._glyphIdByName.get(glyphName);
        if (glyphId) {
            const doc = this._wakeGlyphDoc(glyphId);
            const glyphMap = doc?.getMap('glyph');
            if (glyphMap instanceof Y.Map) {
                return glyphMap;
            }
        }
        return null;
    }

    /**
     * A remote glyphOrder update drops a name whose map is still empty.
     * The body arrives in a later packet, after that index pass, so bind the
     * document that this update just wrote before JSON is read from it.
     */
    private _bindAppliedGlyphDocument(documentId: string): void {
        if (!documentId.startsWith('glyph:')) {
            return;
        }
        const glyphId = documentId.slice('glyph:'.length);
        const glyphMap = this._glyphDocs.get(glyphId)?.getMap('glyph');
        if (!(glyphMap instanceof Y.Map) || glyphMap.size === 0) {
            return;
        }
        const glyphName = glyphMap.get('name');
        if (typeof glyphName !== 'string' || !glyphName) {
            return;
        }
        const previousName = this._glyphNameById.get(glyphId);
        if (
            previousName &&
            previousName !== glyphName &&
            this._glyphIdByName.get(previousName) === glyphId
        ) {
            this._glyphIdByName.delete(previousName);
        }
        this._glyphIdByName.set(glyphName, glyphId);
        this._glyphNameById.set(glyphId, glyphName);
        this._retiredGlyphIdByName.delete(glyphName);
    }

    private _ensureGlyphDoc(
        glyphId: string,
        glyphName: string,
        glyphJson?: Record<string, unknown>
    ): Y.Doc {
        let doc = this._wakeGlyphDoc(glyphId);
        if (!doc) {
            this._assertDocumentIdWritable(glyphDocumentId(glyphId));
            doc = new Y.Doc({ gc: true });
            this._glyphDocs.set(glyphId, doc);
            this._bindDocUpdates(doc, glyphDocumentId(glyphId));
            this._noteDocumentLoaded(glyphDocumentId(glyphId));
            // Every caller fills it with the glyph's whole state: the font,
            // a new glyph, or a complete state checked before this.
            this._stateLoadedDocumentIds.add(glyphDocumentId(glyphId));
        }
        this._glyphIdByName.set(glyphName, glyphId);
        this._glyphNameById.set(glyphId, glyphName);
        this._retiredGlyphIdByName.delete(glyphName);
        if (glyphJson) {
            doc.transact(() => {
                const glyphMap = doc.getMap('glyph');
                glyphMap.forEach((_value, key) => glyphMap.delete(key));
                fillGlyphYMap(glyphJson, glyphMap);
                // A glyph's drawings map exists from its creation on, even
                // when it has no drawings yet.
                if (glyphMap.get('layers') === undefined) {
                    createGlyphDrawingsMap(glyphMap);
                }
            }, USER_EDIT_ORIGIN);
        }
        return doc;
    }

    private _destroyGlyphDocs(): void {
        for (const [glyphId, doc] of this._glyphDocs) {
            const documentId = glyphDocumentId(glyphId);
            this._docUpdateUnsubById.get(documentId)?.();
            this._docUpdateUnsubById.delete(documentId);
            this._stateLoadedDocumentIds.delete(documentId);
            doc.destroy();
        }
        for (const glyphId of this._dormantGlyphStates.keys()) {
            this._stateLoadedDocumentIds.delete(glyphDocumentId(glyphId));
        }
        this._glyphDocs.clear();
        this._dormantGlyphStates.clear();
        this._dormantDocumentCheckpoints.clear();
        this._glyphIdByName.clear();
        this._glyphNameById.clear();
        this._removedGlyphNameById.clear();
    }

    /** The name the index gives a glyph id, or null. */
    glyphNameForId(glyphId: string): string | null {
        return this._glyphNameById.get(glyphId) ?? null;
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
        const drawings = glyphMap.get('layers');
        if (!(drawings instanceof Y.Map) || drawings.size === 0) {
            return null;
        }
        const firstDrawing = drawings.values().next().value;
        if (!(firstDrawing instanceof Y.Map)) {
            return null;
        }
        try {
            const shapes = readDrawingGeometry(firstDrawing);
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
        const modelX = modelGlyph?.drawings?.[0]?.paths?.[0]?.nodes?.[0]?.x;
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
        const jsonDrawing =
            jsonGlyph && typeof jsonGlyph === 'object'
                ? (jsonGlyph as { layers?: Array<Record<string, unknown>> })
                      .layers?.[0]
                : null;
        const jsonShapes = jsonDrawing?.shapes as
            Array<{ nodes?: Array<{ x?: unknown }> }> | undefined;
        const jsonPaths = jsonDrawing?.paths as
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
        return [...this._glyphDocs.keys(), ...this._dormantGlyphStates.keys()]
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
        for (const [glyphId, bytes] of this._dormantGlyphStates) {
            if (!this._glyphNameById.has(glyphId)) {
                continue;
            }
            const byteLength = bytes.byteLength;
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

    /**
     * Catalog glyphs that an edit of `glyphNames` would rewrite (composites,
     * metrics-key inheritors, transitively, from live font-deps) but that are
     * not resident in this sparse session. Editing those sources must wait
     * until these are hydrated: the cascade only reaches resident glyphs.
     */
    listSparseWriteBlockers(glyphNames: Iterable<string>): string[] {
        if (!this._sparseSession) {
            return [];
        }
        const sourceIds = [...new Set(glyphNames)]
            .map((name) => this._glyphIdByName.get(name))
            .filter((id): id is string => Boolean(id))
            .sort();
        if (!sourceIds.length) {
            return [];
        }
        // The closure depends only on font-deps; residency is checked live.
        const key = `${this._depsVersion}\0${sourceIds.join('\0')}`;
        if (this._sparseWriteClosureCache?.key !== key) {
            this._sparseWriteClosureCache = {
                key,
                ids: sparseWriteClosureIds({
                    sourceIds,
                    edges: readFontDepsIndex(this.depsDoc.getMap('deps')).edges
                })
            };
        }
        const missing = this._sparseWriteClosureCache.ids.filter(
            (id) => !this._hasHeldGlyphDoc(id)
        );
        if (!missing.length) {
            return [];
        }
        const live = new Set(this.listLiveCatalogGlyphIds());
        return missing
            .filter((id) => live.has(id))
            .map((id) => this._catalogGlyphName(id) || id);
    }

    /**
     * Catalog glyphs a metrics-key string names that are not resident here.
     * Applying such a key would store it without resolving its value.
     */
    listNonResidentMetricsKeyReferences(rawKey: string): string[] {
        if (!this._sparseSession) {
            return [];
        }
        const idByName = new Map<string, string>();
        for (const glyphId of this.listLiveCatalogGlyphIds()) {
            const name = this._catalogGlyphName(glyphId);
            if (name) {
                idByName.set(name, glyphId);
            }
        }
        const namesByLength = [...idByName.keys()].sort(
            (left, right) => right.length - left.length
        );
        return parseMetricsKeyReferencedNames(rawKey, namesByLength).filter(
            (name) => !this._hasHeldGlyphDoc(idByName.get(name) || '')
        );
    }

    /** Refuse a glyph write whose dependents are not resident. */
    private _assertSparseWriteClosureResident(
        path: Array<string | number>
    ): void {
        if (!this._sparseSession || path[0] !== 'glyphs' || !path[1]) {
            return;
        }
        const glyphName = String(path[1]);
        const blockers = this.listSparseWriteBlockers([glyphName]);
        if (blockers.length) {
            throw new Error(
                `“${glyphName}” cannot be edited yet: glyphs that depend on it are still on the server (${blockers.slice(0, 5).join(', ')}${blockers.length > 5 ? ', …' : ''}).`
            );
        }
    }

    replaceSparseWorkingGlyphIds(glyphIds: string[]): void {
        this.beginSparseWorkingSet(glyphIds);
    }

    /** Install or clear the sparse working set relayed from the main window. */
    setSparseResidency(active: boolean, workingGlyphIds: string[] = []): void {
        if (!active) {
            this._clearSparseWorkingSet();
            return;
        }
        this.beginSparseWorkingSet(workingGlyphIds);
    }

    private _clearSparseWorkingSet(): void {
        this._sparseSession = false;
        this._sparseWorkingGlyphIds.clear();
    }

    encodeDocumentState(documentId: string = FONT_CORE_DOCUMENT_ID): YjsUpdate {
        if (documentId.startsWith('glyph:')) {
            const dormant = this._dormantGlyphStates.get(
                documentId.slice('glyph:'.length)
            );
            if (dormant) {
                return dormant.slice();
            }
        }
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
        this._withGlyphModelRebuild(
            'checkpoint',
            this._glyphNamesForRebuildHint(documentId, undefined),
            () => this._applyDocumentCheckpoint(documentId, state)
        );
    }

    private _applyDocumentCheckpoint(
        documentId: string,
        state: YjsUpdate
    ): void {
        if (!state?.length) {
            return;
        }
        if (this._retiredLayoutDocs.has(documentId)) {
            this._applyRetiredLayoutUpdate(documentId, state);
            return;
        }
        if (this._isReleasedLayoutRoom(documentId)) {
            return;
        }
        if (this._isTombstonedGlyphDocument(documentId)) {
            return;
        }
        let repairedGlyphName: string | null = null;
        this._pushApplyKind(ApplyKind.Remote);
        try {
            if (!this._fontJson) this._fontJson = {};
            let doc = this._docForId(documentId);
            if (!doc && isLayoutDocumentId(documentId)) {
                doc = this._ensureLayoutDoc(documentId);
            }
            if (!doc && documentId.startsWith('glyph:')) {
                this._assertCompleteGlyphState(state, documentId);
                doc = this._ensureGlyphDocFromShard({
                    documentId,
                    bytes: state
                });
            }
            if (!doc) {
                doc = this._requireDocForId(documentId);
            }
            applyUpdateWithIntegrity(
                doc,
                state,
                documentId,
                SYSTEM_REMOTE_ORIGIN,
                this._brokenScope
            );
            this._stateLoadedDocumentIds.add(documentId);
            if (documentId === FONT_CORE_DOCUMENT_ID) {
                this._rehydrateEntireFontJsonFromYDoc();
            } else if (isLayoutDocumentId(documentId)) {
                this._syncTopLevelFontKeyFromYDoc(
                    layoutTopLevelKey(documentId)
                );
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
            this._emitAfterSync();
        } finally {
            this._popApplyKind();
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
                ? this._wakeGlyphDoc(glyphId)
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
        this._assertGeometryCompleteAfterConvergedState(documentId);
        this._flushStrandedOutboxes();
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
        return this._withGlyphModelRebuild(
            'catch-up',
            this._glyphNamesForRebuildHint(documentId, _remoteEntries),
            () =>
                this._applyDocumentCatchUp(
                    documentId,
                    update,
                    _collaborationMessages,
                    _remoteEntries,
                    expectedRevision
                )
        );
    }

    private _applyDocumentCatchUp(
        documentId: string,
        update: YjsUpdate,
        _collaborationMessages?: CollaborationMessageEnvelope[],
        _remoteEntries?: ChangeLogEntry[],
        expectedRevision?: string
    ): boolean {
        if (!update?.length) {
            return false;
        }
        if (this._retiredLayoutDocs.has(documentId)) {
            return this._applyRetiredLayoutUpdate(documentId, update);
        }
        if (this._isReleasedLayoutRoom(documentId)) {
            return false;
        }
        // A catch-up started before the glyph was deleted (a rename's, say)
        // can land after the deletion; it must not bring the glyph back.
        // If this window already holds the pre-deletion shard, still apply an
        // incoming deletion so the local Y.Doc and the compile worker drop it
        // from GLYPH_ID_BY_NAME and recompile without the stale glyph.
        if (this._isTombstonedGlyphDocument(documentId)) {
            if (!this.hasResidentGlyphDocument(documentId)) {
                return false;
            }
            const glyphId = glyphIdFromDocumentId(documentId);
            const doc = glyphId ? this._wakeGlyphDoc(glyphId) : null;
            if (!doc) {
                return false;
            }
            const glyphMapBefore = doc.getMap('glyph');
            const hadGlyphDataBefore =
                glyphMapBefore instanceof Y.Map && glyphMapBefore.size > 0;
            const describedBefore = hadGlyphDataBefore
                ? this._readCatchUpDescription(documentId)
                : null;
            applyUpdateWithIntegrity(
                doc,
                update,
                documentId,
                SYSTEM_REMOTE_ORIGIN,
                this._brokenScope
            );
            const glyphMapAfter = doc.getMap('glyph');
            const hasGlyphDataAfter =
                glyphMapAfter instanceof Y.Map && glyphMapAfter.size > 0;
            if (hadGlyphDataBefore && !hasGlyphDataAfter) {
                const workerState = this.encodeDocumentState(documentId);
                if (workerState.length) {
                    this._workerDocumentReplaceCallback?.(
                        documentId,
                        workerState
                    );
                }
                if (describedBefore) {
                    this._emitCatchUpCommittedChange(
                        documentId,
                        update,
                        describedBefore
                    );
                }
            }
            return !hasGlyphDataAfter;
        }
        // Only a glyph already held here counts: hydrating a glyph for the
        // first time is not anyone’s edit.
        const stateBefore = this.hasResidentGlyphDocument(documentId)
            ? this.encodeDocumentStateVector(documentId)
            : null;
        const describedBefore = this._readCatchUpDescription(documentId);
        this.beginDeferredAfterSync();
        try {
            this.applyDocumentCheckpoint(documentId, update);
        } finally {
            this.endDeferredAfterSync();
        }
        // Catch-up brings in other people’s edits of a glyph that has no live
        // socket here; undo must not overwrite them.
        const touchedGlyphName =
            stateBefore &&
            !stateVectorsEqual(
                stateBefore,
                this.encodeDocumentStateVector(documentId)
            )
                ? (this._glyphNameById.get(documentId.slice('glyph:'.length)) ??
                  null)
                : null;
        if (documentId !== FONT_DEPS_DOCUMENT_ID) {
            // Live WS catch-up is often a delta vs the HTTP-hydrated SV.
            // Worker replace seeds an empty Yrs doc, so it must receive a
            // full encodeStateAsUpdate of the merged JS shard.
            const workerState = this.encodeDocumentState(documentId);
            if (workerState.length) {
                this._workerDocumentReplaceCallback?.(documentId, workerState);
            }
        }
        const described = describedBefore
            ? this._emitCatchUpCommittedChange(
                  documentId,
                  update,
                  describedBefore
              )
            : null;
        if (touchedGlyphName) {
            // Guard exactly what changed; the whole glyph only when the
            // change could not be described.
            this._noteCollaboratorTouches(
                described
                    ? described.map((entry) => String(entry.path || ''))
                    : [joinPathWithGlyphSeparator(['glyphs', touchedGlyphName])]
            );
        }
        if (
            expectedRevision &&
            !this.glyphHasCatchUpRevision(documentId, expectedRevision)
        ) {
            return false;
        }
        return true;
    }

    /**
     * What a catch-up may change, read before it applies: the glyph of a
     * resident glyph shard, or the core keys of a hydrated font. Null for a
     * document hydrated here for the first time, which is nobody’s edit.
     */
    private _readCatchUpDescription(
        documentId: string
    ): CatchUpDescription | null {
        if (
            documentId === FONT_CORE_DOCUMENT_ID ||
            isLayoutDocumentId(documentId)
        ) {
            // Layout 2 rooms hold parts of the core keys (features, the
            // catalog, station kerning); describe them the same way.
            const snapshot = this._readCoreCatchUpSnapshot();
            return snapshot ? { kind: 'core', snapshot } : null;
        }
        const glyphId = glyphIdFromDocumentId(documentId);
        if (!glyphId || !this.hasResidentGlyphDocument(documentId)) {
            return null;
        }
        const glyphName = this._glyphNameById.get(glyphId);
        let snapshot = glyphName
            ? this._readNormalizedGlyphSnapshotFromYDoc(glyphName, {
                  ignoreExisting: true
              })
            : null;
        if (!snapshot) {
            const doc = this._wakeGlyphDoc(glyphId);
            const glyphMap = doc?.getMap('glyph');
            const storedName =
                glyphMap instanceof Y.Map ? glyphMap.get('name') : undefined;
            if (
                glyphMap instanceof Y.Map &&
                glyphMap.size > 0 &&
                typeof storedName === 'string' &&
                storedName
            ) {
                snapshot = this._cloneRuntimeValue(
                    this._normalizeGlyphSnapshot(
                        fromYType(glyphMap),
                        undefined,
                        {
                            strictDrawings: true,
                            ignoreExisting: true
                        }
                    )
                ) as Unsafe;
            }
        }
        return snapshot ? { kind: 'glyph', glyphId, snapshot } : null;
    }

    /** Core keys of the font JSON; glyphs live in their own shards. */
    private _readCoreCatchUpSnapshot(): Record<string, unknown> | null {
        if (!this._fontJson) {
            return null;
        }
        const snapshot: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(this._fontJson)) {
            if (key !== 'glyphs' && key !== GLYPH_REVISIONS_KEY) {
                snapshot[key] = value;
            }
        }
        return Object.keys(snapshot).length
            ? (this._cloneRuntimeValue(snapshot) as Record<string, unknown>)
            : null;
    }

    /**
     * A catch-up is a checkpoint, not a packet, but for this window it is a
     * collaborator’s edit like any other: it must reach the committed funnel
     * so the canvas, the overview (with dependents) and the editing compile
     * see it. The entries describe what the checkpoint changed here; they are
     * not recorded in history.
     */
    private _emitCatchUpCommittedChange(
        documentId: string,
        update: YjsUpdate,
        before: CatchUpDescription
    ): ChangeLogEntry[] {
        let beforeRoot: Record<string, unknown>;
        let afterRoot: Record<string, unknown>;
        if (before.kind === 'glyph') {
            const glyphName = this._glyphNameById.get(before.glyphId);
            const after = glyphName
                ? this._readNormalizedGlyphSnapshotFromYDoc(glyphName, {
                      ignoreExisting: true
                  })
                : null;
            beforeRoot = { glyphs: [before.snapshot] };
            afterRoot = { glyphs: after ? [after] : [] };
        } else {
            beforeRoot = before.snapshot;
            afterRoot = this._readCoreCatchUpSnapshot() ?? {};
        }
        const timestamp = Date.now();
        const historyItemId = `catch-up-${documentId}-${timestamp}`;
        const entries = diffFontDataToPatchPairs(beforeRoot, afterRoot).flatMap(
            ({ forward, inverse }) => {
                const path = forward.path;
                if (
                    path[0] === GLYPH_REVISIONS_KEY ||
                    path[0] === FONT_DEPS_ENTRY_PATH ||
                    (before.kind === 'glyph' && path[0] === 'glyphOrder')
                ) {
                    return [];
                }
                const glyphName =
                    path[0] === 'glyphs' && path.length >= 2
                        ? String(path[1])
                        : null;
                const drawingId =
                    glyphName && path[2] === 'layers' && path.length >= 4
                        ? String(path[3])
                        : null;
                return [
                    createLogEntry({
                        timestamp,
                        windowId: 'remote',
                        windowRoleLabel: this._getWindowRoleLabel(),
                        historyAction: 'change',
                        transactionLabel: 'Collaborator edit',
                        transactionId: null,
                        historyItemId,
                        op: forward.op === 'replace' ? 'set' : forward.op,
                        undoScope: drawingId
                            ? 'layer'
                            : glyphName
                              ? 'glyph'
                              : 'font',
                        path: joinPathWithGlyphSeparator(path),
                        oldValue:
                            inverse.op === 'remove' ? undefined : inverse.value,
                        newValue:
                            forward.op === 'remove' ? undefined : forward.value,
                        compileChangeSource: CATCH_UP_COMPILE_SOURCE,
                        compileEditType: null,
                        ...(glyphName && drawingId
                            ? {
                                  workerReplayTargets: [
                                      { glyphName, layerId: drawingId }
                                  ]
                              }
                            : {})
                    })
                ];
            }
        );
        if (!entries.length) {
            return entries;
        }
        // A glyph catch-up brings writes this window did not make. Like a
        // live collaborator packet, its drawings are cascade sources: a
        // composite stored by a concurrent writer from an older view of
        // them must be recomposed. Only in the window that caught up: a
        // linked window gets the main window's relay, and the main window's
        // recomposition, not one from its own view.
        const fromCollaborator =
            before.kind === 'glyph' && !window.windowRole?.isLinkedWindow?.();
        for (const cb of this._committedChangeListeners) {
            cb(entries, {
                origin: 'remote',
                update,
                documentId,
                ...(fromCollaborator ? { fromCollaborator } : {})
            });
        }
        return entries;
    }

    /** True when the catalog says the glyph was deleted. */
    isDeletedGlyphDocument(documentId: string): boolean {
        return this._isTombstonedGlyphDocument(documentId);
    }

    /** True when a resident glyph shard holds an empty glyph map (deleted). */
    isEmptyGlyphDocument(documentId: string): boolean {
        const glyphId = glyphIdFromDocumentId(documentId);
        if (!glyphId || !this._hasHeldGlyphDoc(glyphId)) {
            return false;
        }
        const glyphMap = this._wakeGlyphDoc(glyphId)?.getMap('glyph');
        if (!(glyphMap instanceof Y.Map) || glyphMap.size === 0) {
            return true;
        }
        const storedName = glyphMap.get('name');
        return typeof storedName !== 'string' || !storedName;
    }

    /** A glyph shard whose catalog entry is a tombstone (the glyph was deleted). */
    private _isTombstonedGlyphDocument(documentId: string): boolean {
        if (!documentId.startsWith('glyph:') || !this._fontJson) {
            return false;
        }
        const catalog = catalogFromCoreJson(
            this._fontJson as Record<string, unknown>
        )?.glyphCatalog;
        return isCatalogTombstone(catalog, documentId.slice('glyph:'.length));
    }

    glyphHasCatchUpRevision(documentId: string, revision: string): boolean {
        const glyphId = glyphIdFromDocumentId(documentId);
        if (!glyphId) {
            return false;
        }
        // A collaborator's write released after a newer one is not here
        // until a catch-up has brought it, whatever the stamp says.
        if (this._lateGlyphRevisionsAwaitingFetch.has(glyphId)) {
            return false;
        }
        const doc = this._wakeGlyphDoc(glyphId);
        const token = doc
            ?.getMap(GLYPH_SYNC_MAP_KEY)
            .get(GLYPH_SYNC_REVISION_KEY);
        return token === revision;
    }

    /** True when this window already has the glyph shard, even if it is not on screen. */
    hasResidentGlyphDocument(documentId: string): boolean {
        const glyphId = glyphIdFromDocumentId(documentId);
        return !!glyphId && this._hasHeldGlyphDoc(glyphId);
    }

    /** True when the font model lists the catalog name for this shard. */
    catalogGlyphIsInModel(documentId: string): boolean {
        const glyphId = glyphIdFromDocumentId(documentId);
        if (!glyphId || !this._fontJson) {
            return false;
        }
        const owned = catalogFromCoreJson(
            this._fontJson as Record<string, unknown>
        );
        const name =
            owned?.glyphCatalog[glyphId]?.name ||
            this._glyphNameById.get(glyphId);
        if (!name || name === glyphId) {
            return false;
        }
        const glyphs = (this._fontJson as Record<string, unknown>).glyphs;
        return (
            Array.isArray(glyphs) &&
            glyphs.some(
                (glyph) =>
                    !!glyph &&
                    typeof glyph === 'object' &&
                    ((glyph as { name?: string }).name === name ||
                        (glyph as { id?: string }).id === glyphId)
            )
        );
    }

    /** Copy a resident shard into the font model under its catalog name. */
    materializeResidentCatalogGlyph(documentId: string): void {
        this._withGlyphModelRebuild(
            'hydrate',
            this._glyphNamesForRebuildHint(documentId, undefined),
            () => this._materializeResidentCatalogGlyph(documentId)
        );
    }

    private _materializeResidentCatalogGlyph(documentId: string): void {
        // A catch-up can finish after the glyph's deletion arrived; the
        // glyph room and font-core are not ordered with each other.
        if (
            !documentId.startsWith('glyph:') ||
            this._isTombstonedGlyphDocument(documentId)
        ) {
            return;
        }
        const glyphId = documentId.slice('glyph:'.length);
        // A delete empties the glyph's map. Its catalog tombstone can still
        // be on its way, and the name its index entry keeps may already
        // belong to a glyph added again under it.
        const storedName = this._wakeGlyphDoc(glyphId)
            ?.getMap('glyph')
            .get('name');
        if (typeof storedName !== 'string' || !storedName) {
            return;
        }
        this._aliasResidentGlyphNamesFromCatalog();
        const name = this._glyphNameById.get(glyphId);
        if (!name || name === glyphId) {
            return;
        }
        this._patchGlyphFromYDoc(name, { ignoreExisting: true });
    }

    /** Glyph name from the core catalog, also for glyphs that are not resident. */
    private _catalogGlyphName(glyphId: string): string | null {
        const known = this._glyphNameById.get(glyphId);
        if (known) {
            return known;
        }
        const entry = this._catalogYEntry(glyphId) ?? null;
        const name =
            entry instanceof Y.Map
                ? entry.get('name')
                : (entry as { name?: unknown } | null)?.name;
        return typeof name === 'string' && name ? name : null;
    }

    /** Non-deleted catalog glyph ids, read from font-core without building font JSON. */
    listLiveCatalogGlyphIds(): string[] {
        const maps = this.roomLayout
            ? this._catalogBucketMaps()
            : [this.fontMap.get(CORE_GLYPH_CATALOG_KEY)].filter(
                  (map): map is Y.Map<unknown> => map instanceof Y.Map
              );
        const ids: string[] = [];
        for (const yCatalog of maps) {
            yCatalog.forEach((entry, glyphId) => {
                const deleted =
                    entry instanceof Y.Map
                        ? entry.get('deleted')
                        : (entry as { deleted?: unknown } | null)?.deleted;
                if (glyphId && deleted !== true) {
                    ids.push(glyphId);
                }
            });
        }
        return ids;
    }

    listGlyphRevisionTokens(): Array<{ glyphId: string; revision: string }> {
        return [...this._glyphRevisionFeed].map(([glyphId, revision]) => ({
            glyphId,
            revision
        }));
    }

    /**
     * Apply revision tokens from the room's feed (main window) or from the
     * main window's relay (linked windows). Returns the glyphs whose token
     * changed. A revision from a commit that wrote several glyphs waits until
     * the feed has named all of them (see `GLYPH_REVISION_COMMIT_HOLD_MS`),
     * unless `hold` is false: the initial snapshot, this window's own
     * revisions, and what the main window relays, which it held already.
     */
    applyGlyphRevisionFeed(
        revisions: Array<{ glyphId: string; revision: string }>,
        options: { initial?: boolean; hold?: boolean; own?: boolean } = {}
    ): string[] {
        const hold = options.hold !== false && options.initial !== true;
        const ready: HeldGlyphRevision[] = [];
        const traced: string[] = [];
        for (const entry of revisions) {
            if (
                !entry ||
                typeof entry.glyphId !== 'string' ||
                typeof entry.revision !== 'string' ||
                !entry.glyphId ||
                !entry.revision
            ) {
                continue;
            }
            if (this._ownGlyphRevisions.has(entry.revision)) {
                traced.push(`${entry.glyphId} ${entry.revision} own`);
                continue;
            }
            const arrived = {
                glyphId: entry.glyphId,
                revision: entry.revision,
                arrival: ++this._glyphRevisionArrivals
            };
            const released = hold
                ? this._takeGlyphRevisionCommit(arrived)
                : [arrived];
            traced.push(
                `${entry.glyphId} ${entry.revision}${released.length ? '' : ' held'}`
            );
            ready.push(...released);
        }
        if (traced.length && !options.initial) {
            recordCollabTrace(
                'revision-feed',
                revisions
                    .map((entry) => this._glyphNameById.get(entry?.glyphId))
                    .filter((name): name is string => !!name),
                { revisions: traced }
            );
        }
        return this._applyReadyGlyphRevisions(
            ready,
            options.initial === true,
            options.own === true
        );
    }

    /**
     * A catch-up brought this collaborator revision, or the glyph's live
     * socket delivers it: this window's own writes may name the glyph's
     * revision again.
     */
    noteGlyphRevisionFetched(glyphId: string, revision?: string): void {
        if (
            !revision ||
            this._glyphRevisionsAwaitingFetch.get(glyphId) === revision
        ) {
            this._glyphRevisionsAwaitingFetch.delete(glyphId);
        }
        // A catch-up to the room's tail, or the glyph's live socket, brings
        // every row after the cursor, a late older write's included.
        this._lateGlyphRevisionsAwaitingFetch.delete(glyphId);
    }

    private _applyReadyGlyphRevisions(
        ready: HeldGlyphRevision[],
        initial: boolean,
        own = false
    ): string[] {
        const changed: string[] = [];
        for (const item of ready) {
            // A collaborator's revision this window has not fetched stays the
            // one to catch up to. This window's own write to the glyph would
            // otherwise replace it, and the catch-up, finding its own stamp,
            // would never fetch the collaborator's write.
            if (own && this._glyphRevisionsAwaitingFetch.has(item.glyphId)) {
                continue;
            }
            // The feed names a glyph's revisions oldest first. One released
            // late must not replace a revision that arrived after it. This
            // window's own revisions are not feed arrivals: a collaborator
            // revision held for its commit's siblings still applies after
            // this window wrote the glyph.
            if (!own) {
                if (
                    (this._glyphRevisionFeedArrival.get(item.glyphId) ?? 0) >
                    item.arrival
                ) {
                    // The feed keeps its newest revision, but the late write
                    // is still one this window has to fetch: the glyph waits
                    // for a catch-up of the log rows after its cursor.
                    if (
                        !initial &&
                        this._glyphRevisionFeed.get(item.glyphId) !==
                            item.revision
                    ) {
                        this._lateGlyphRevisionsAwaitingFetch.set(
                            item.glyphId,
                            item.revision
                        );
                        if (!changed.includes(item.glyphId)) {
                            changed.push(item.glyphId);
                        }
                    }
                    continue;
                }
                this._glyphRevisionFeedArrival.set(item.glyphId, item.arrival);
            }
            if (this._glyphRevisionFeed.get(item.glyphId) !== item.revision) {
                this._glyphRevisionFeed.set(item.glyphId, item.revision);
                changed.push(item.glyphId);
                if (!own && !initial) {
                    this._glyphRevisionsAwaitingFetch.set(
                        item.glyphId,
                        item.revision
                    );
                }
            }
        }
        if (changed.length || initial) {
            for (const cb of [...this._glyphRevisionFeedListeners]) {
                cb(changed, { initial });
            }
        }
        return changed;
    }

    /**
     * The revisions to apply now for this one: none while its commit is
     * incomplete, all of the commit's once the last arrives.
     */
    private _takeGlyphRevisionCommit(
        entry: HeldGlyphRevision
    ): HeldGlyphRevision[] {
        const commit = glyphRevisionCommit(entry.revision);
        if (!commit) {
            return [entry];
        }
        let held = this._heldGlyphRevisions.get(commit.key);
        if (!held) {
            const key = commit.key;
            held = {
                size: commit.size,
                arrived: new Set(),
                entries: new Map(),
                // A sibling may never come: a newer write replaced it first.
                timer: setTimeout(() => {
                    this._applyReadyGlyphRevisions(
                        this._takeHeldGlyphRevisions(key),
                        false
                    );
                }, GLYPH_REVISION_COMMIT_HOLD_MS)
            };
            this._heldGlyphRevisions.set(commit.key, held);
        }
        held.arrived.add(entry.revision);
        held.entries.set(entry.glyphId, entry);
        return held.arrived.size < held.size
            ? []
            : this._takeHeldGlyphRevisions(commit.key);
    }

    private _takeHeldGlyphRevisions(key: string): HeldGlyphRevision[] {
        const held = this._heldGlyphRevisions.get(key);
        if (!held) {
            return [];
        }
        clearTimeout(held.timer);
        this._heldGlyphRevisions.delete(key);
        return [...held.entries.values()];
    }

    private _clearHeldGlyphRevisions(): void {
        for (const held of this._heldGlyphRevisions.values()) {
            clearTimeout(held.timer);
        }
        this._heldGlyphRevisions.clear();
    }

    private _noteOwnGlyphRevision(revision: unknown): void {
        if (typeof revision !== 'string' || !revision) {
            return;
        }
        this._ownGlyphRevisions.add(revision);
        if (this._ownGlyphRevisions.size > MAX_OWN_GLYPH_REVISIONS) {
            const oldest = this._ownGlyphRevisions.values().next().value;
            if (oldest !== undefined) {
                this._ownGlyphRevisions.delete(oldest);
            }
        }
    }

    onGlyphRevisionFeed(cb: GlyphRevisionFeedListener): () => void {
        this._glyphRevisionFeedListeners.add(cb);
        return () => this._glyphRevisionFeedListeners.delete(cb);
    }

    onCoreHydrated(cb: () => void): void {
        this._coreHydratedListeners.add(cb);
    }

    offCoreHydrated(cb: () => void): void {
        this._coreHydratedListeners.delete(cb);
    }

    /**
     * Copy the Y.Doc catalog onto the live font JSON before a sparse fetch.
     * A font-core update can be encoded and relayed before the model key is
     * refreshed, so seed lookup would miss a glyph the catalog already names.
     */
    refreshOwnedCatalogFromYDoc(): void {
        if (this.roomLayout) {
            this._syncTopLevelFontKeyFromYDoc(CORE_GLYPH_CATALOG_KEY);
            return;
        }
        if (this.fontMap.get(CORE_GLYPH_CATALOG_KEY) === undefined) {
            return;
        }
        this._syncTopLevelFontKeyFromYDoc(CORE_GLYPH_CATALOG_KEY);
        if (this.fontMap.get(CORE_CODEPOINT_INDEX_KEY) !== undefined) {
            this._syncTopLevelFontKeyFromYDoc(CORE_CODEPOINT_INDEX_KEY);
        }
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
        const catalogOp = {
            compileChangeSource: 'cloud-catalog',
            compileEditType: null
        } as const;
        const layoutActive = !!this.roomLayout;
        const yIndex = layoutActive
            ? undefined
            : this.fontMap.get(CORE_CODEPOINT_INDEX_KEY);
        const previousCatalog = (this._readCatalogJson() ??
            {}) as CloudOwnedFontData['glyphCatalog'];
        const previousIndex =
            yIndex instanceof Y.Map
                ? (fromYType(yIndex) as CloudOwnedFontData['codepointIndex'])
                : {};
        const catalogChanged = (previous: unknown, next: unknown): boolean =>
            stableCloudOwnedJson(previous) !== stableCloudOwnedJson(next);
        const operations: TransactionBufferedOperation[] = [];
        for (const [glyphId, entry] of Object.entries(owned.glyphCatalog)) {
            if (!catalogChanged(previousCatalog[glyphId], entry)) {
                continue;
            }
            operations.push({
                op: 'set',
                path: [CORE_GLYPH_CATALOG_KEY, glyphId],
                oldValue: previousCatalog[glyphId],
                newValue: entry,
                ...catalogOp
            });
        }
        for (const glyphId of Object.keys(previousCatalog)) {
            if (owned.glyphCatalog[glyphId]) {
                continue;
            }
            operations.push({
                op: 'remove',
                path: [CORE_GLYPH_CATALOG_KEY, glyphId],
                oldValue: previousCatalog[glyphId],
                newValue: undefined,
                ...catalogOp
            });
        }
        for (const [codepoint, glyphIds] of Object.entries(
            layoutActive ? {} : owned.codepointIndex
        )) {
            if (!catalogChanged(previousIndex[codepoint], glyphIds)) {
                continue;
            }
            operations.push({
                op: 'set',
                path: [CORE_CODEPOINT_INDEX_KEY, codepoint],
                oldValue: previousIndex[codepoint],
                newValue: glyphIds,
                ...catalogOp
            });
        }
        for (const codepoint of Object.keys(previousIndex)) {
            if (owned.codepointIndex[codepoint] && !layoutActive) {
                continue;
            }
            operations.push({
                op: 'remove',
                path: [CORE_CODEPOINT_INDEX_KEY, codepoint],
                oldValue: previousIndex[codepoint],
                newValue: undefined,
                ...catalogOp
            });
        }
        if (CLOUD_PLUGIN_OWNED_KEY in existingFormat) {
            operations.push({
                op: 'remove',
                path: ['format_specific', CLOUD_PLUGIN_OWNED_KEY],
                oldValue: existingFormat[CLOUD_PLUGIN_OWNED_KEY],
                newValue: undefined,
                compileChangeSource: 'cloud-catalog',
                compileEditType: null
            });
        }
        if (operations.length) {
            this._queueOrCommitOperations(operations, 'Update cloud catalog');
        }
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

    /**
     * Write font-deps and send the delta with collaboration metadata. Peers
     * refuse an undescribed packet, and a plain local-edit transaction here
     * went out undescribed: it runs after the commit that caused it, so it
     * had no change-log entries of its own.
     */
    private _writeFontDeps(sourceIds: string[], write: () => void): void {
        assertDocumentWritable(
            this.depsDoc,
            FONT_DEPS_DOCUMENT_ID,
            this._brokenScope
        );
        this._pushApplyKind(ApplyKind.ManualEmit);
        try {
            this.depsDoc.transact(write, FONT_EDIT_ORIGIN);
        } finally {
            this._popApplyKind();
        }
        const update = this._takeOutbox(FONT_DEPS_DOCUMENT_ID);
        if (isEmptyYjsUpdate(update)) {
            return;
        }
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._createHistoryItemId(),
            historyAction: 'change',
            transactionLabel: 'Font dependencies',
            transactionId: null,
            op: 'set',
            path: FONT_DEPS_ENTRY_PATH,
            oldValue: undefined,
            newValue: sourceIds,
            replayOldValue: undefined,
            replayNewValue: undefined,
            compileChangeSource: 'cloud-font-deps',
            compileEditType: null
        });
        this._emitLocalUpdate(update, [], FONT_DEPS_DOCUMENT_ID, {
            skipCollaborationLog: true,
            envelopeEntries: [entry]
        });
    }

    syncFontDepsFromFontJson(
        fontJson: Record<string, unknown>,
        glyphNames?: string[]
    ): void {
        const depsMap = this.depsDoc.getMap('deps');
        this._writeFontDeps(glyphNames ?? [], () => {
            if (!glyphNames || glyphNames.length === 0) {
                writeCompleteFontDepsIfLoaded(depsMap, fontJson);
                return;
            }
            const glyphs = listGlyphRecords(fontJson);
            const idByName = new Map<string, string>();
            const glyphByName = new Map<string, Record<string, unknown>>();
            const catalog = catalogEntriesForDepsParse(fontJson);
            const catalogIds = new Set<string>();
            for (const entry of catalog) {
                idByName.set(entry.name, entry.glyphId);
                catalogIds.add(entry.glyphId);
            }
            const catalogNames = new Set(idByName.keys());
            for (const glyph of glyphs) {
                const name = String(glyph.name || '');
                if (name) {
                    const glyphId = ensureImmutableGlyphId(glyph);
                    idByName.set(name, glyphId);
                    glyphByName.set(name, glyph);
                    if (!catalogIds.has(glyphId) && !catalogNames.has(name)) {
                        catalog.push({ glyphId, name });
                        catalogIds.add(glyphId);
                        catalogNames.add(name);
                    }
                }
            }
            const nameIndex = catalogNameIndexFromEntries(catalog);
            for (const name of glyphNames) {
                const sourceId = idByName.get(name);
                const glyph = glyphByName.get(name);
                if (!sourceId || !glyph) {
                    continue;
                }
                const sourceRevision = this._wakeGlyphDoc(sourceId)
                    ?.getMap(GLYPH_SYNC_MAP_KEY)
                    .get(GLYPH_SYNC_REVISION_KEY);
                patchSourceEdges(
                    depsMap,
                    sourceId,
                    buildFontDepsForGlyphWithIndex(glyph, nameIndex),
                    typeof sourceRevision === 'string' && sourceRevision
                        ? sourceRevision
                        : '0'
                );
            }
        });
    }

    syncCompleteFontDepsFromLoadedGlyphs(
        fontJson: Record<string, unknown>
    ): boolean {
        let wrote = false;
        this._writeFontDeps([], () => {
            wrote = writeCompleteFontDepsIfLoaded(
                this.depsDoc.getMap('deps'),
                fontJson
            );
        });
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
        for (const documentId of this.layoutDocumentIds()) {
            shards.push({
                documentId,
                bytes: Y.encodeStateAsUpdate(this._ensureLayoutDoc(documentId))
            });
        }
        for (const [glyphId, doc] of this._glyphDocs) {
            shards.push({
                documentId: glyphDocumentId(glyphId),
                bytes: Y.encodeStateAsUpdate(doc)
            });
        }
        for (const [glyphId, bytes] of this._dormantGlyphStates) {
            shards.push({
                documentId: glyphDocumentId(glyphId),
                bytes: bytes.slice()
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

    /**
     * The document set as a new cloud asset stores it: each document passed
     * through a garbage-collected copy, so content this window deleted (the
     * catalog, features and kerning adoptRoomLayout moved out of core, earlier
     * edits) is not uploaded. State vectors stay the same.
     */
    encodeDocumentSetForSeed(): EncodedShard[] {
        return this.encodeDocumentSet().map((shard) => {
            const doc = new Y.Doc({ gc: true });
            try {
                Y.applyUpdate(doc, shard.bytes);
                return {
                    documentId: shard.documentId,
                    bytes: Y.encodeStateAsUpdate(doc)
                };
            } finally {
                doc.destroy();
            }
        });
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

    /** Cached encoded sizes for prepareToSave without a full re-encode. */
    getCachedShardSizeReports(): Array<{
        documentId: string;
        byteLength: number;
    }> {
        return [...this._lastEncodedShardBytes.entries()]
            .filter(([, byteLength]) => Number.isFinite(byteLength))
            .map(([documentId, byteLength]) => ({ documentId, byteLength }));
    }

    private _glyphHasRetainedLocalState(
        glyphId: string,
        glyphName: string | undefined
    ): boolean {
        if (this._txDepth > 0) {
            return true;
        }
        if (this.hasUnsentLocalUpdates(glyphDocumentId(glyphId))) {
            return true;
        }
        // A deleted glyph's name is forgotten for its id, but history may
        // still name it: undoing the delete writes into this document.
        const name = glyphName ?? this._removedGlyphNameById.get(glyphId);
        if (!name) {
            return false;
        }
        return this._glyphNamesWithHistory().has(name);
    }

    /**
     * Undo replays into glyph documents, so glyphs with history stay
     * resident. A rename's entry names the old name in its path; the glyph
     * goes by the new one now, so both count.
     */
    private _glyphNamesWithHistory(): Set<string> {
        const cached = this._historyGlyphNames;
        const reusable =
            cached &&
            cached.log === this._changeLog &&
            cached.length <= this._changeLog.length;
        const state = reusable
            ? cached
            : { log: this._changeLog, length: 0, names: new Set<string>() };
        for (
            let index = state.length;
            index < this._changeLog.length;
            index++
        ) {
            const entry = this._changeLog[index];
            if (entry.historyAction !== 'change') {
                continue;
            }
            const glyphName = deriveGlyphNameFromPath(entry.path);
            if (glyphName) {
                state.names.add(glyphName);
            }
            for (const rename of normalizeGlyphRenames(entry.glyphRenames)) {
                state.names.add(rename.oldName);
                state.names.add(rename.newName);
            }
        }
        state.length = this._changeLog.length;
        this._historyGlyphNames = state;
        return state.names;
    }

    /**
     * The cloud plugin reports a glyph document's catch-up running
     * (`active`) and finished. While it runs, the glyph is never unloaded,
     * whoever asks: its rows apply to the instance the cursor came from.
     */
    noteGlyphCatchUpInFlight(documentId: string, active: boolean): void {
        if (active) this._glyphCatchUpsInFlight.add(documentId);
        else this._glyphCatchUpsInFlight.delete(documentId);
    }

    /**
     * The cloud plugin reports a glyph document's catch-up queued to run
     * again (`pending`) and taken off that queue. A queued glyph is not
     * unloaded either.
     */
    noteGlyphCatchUpPending(documentId: string, pending: boolean): void {
        if (pending) this._glyphCatchUpsPending.add(documentId);
        else this._glyphCatchUpsPending.delete(documentId);
    }

    /** True while the glyph document has a catch-up running or queued. */
    hasGlyphCatchUp(documentId: string): boolean {
        return (
            this._glyphCatchUpsInFlight.has(documentId) ||
            this._glyphCatchUpsPending.has(documentId)
        );
    }

    /** The cloud session ended: no catch-up runs or waits any more. */
    clearGlyphCatchUps(): void {
        this._glyphCatchUpsInFlight.clear();
        this._glyphCatchUpsPending.clear();
    }

    /**
     * True when this window holds `documentId`'s whole state: loaded from
     * the room, built here from the font, or a glyph made from its complete
     * state. An unsent edit restored from the write-ahead log waits until
     * this is true (see `ApplyRemoteUpdateOptions.restoredUnsentEdit`).
     */
    hasLoadedDocumentState(documentId: string): boolean {
        return (
            this._stateLoadedDocumentIds.has(documentId) &&
            this._docForId(documentId) !== null
        );
    }

    unloadCleanGlyphDocuments(
        keepIds: Iterable<string>,
        options?: { ignorePeers?: boolean }
    ): string[] {
        return this._withGlyphModelRebuild('unload', null, () =>
            this._unloadCleanGlyphDocuments(keepIds, options)
        );
    }

    private _unloadCleanGlyphDocuments(
        keepIds: Iterable<string>,
        options?: { ignorePeers?: boolean }
    ): string[] {
        const keep = new Set([...keepIds].filter(Boolean));
        const linkedPeers = (
            window as Window & {
                windowSync?: { peers?: { size?: number } };
            }
        ).windowSync?.peers;
        if (
            !options?.ignorePeers &&
            linkedPeers &&
            Number(linkedPeers.size) > 0
        ) {
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
        const keptForCatchUp: string[] = [];
        for (const glyphId of [
            ...this._glyphDocs.keys(),
            ...this._dormantGlyphStates.keys()
        ]) {
            if (keep.has(glyphId) || this._sparseWorkingGlyphIds.has(glyphId)) {
                continue;
            }
            const name = this._glyphNameById.get(glyphId);
            if (this._glyphHasRetainedLocalState(glyphId, name)) {
                continue;
            }
            const documentId = glyphDocumentId(glyphId);
            // A catch-up running or queued for this glyph applies its rows
            // to this instance; unloaded, they would land in nothing (or a
            // later instance whose cursor they don't continue).
            if (this.hasGlyphCatchUp(documentId)) {
                keptForCatchUp.push(documentId);
                continue;
            }
            // A broken document stays resident: loading it again from the
            // room would fill the refused gap by asking for it.
            const residentDoc = this._glyphDocs.get(glyphId);
            if (
                (residentDoc && isDocumentBroken(residentDoc)) ||
                this.isDocumentIdBroken(documentId)
            ) {
                continue;
            }
            this._docUpdateUnsubById.get(documentId)?.();
            this._docUpdateUnsubById.delete(documentId);
            const doc = this._glyphDocs.get(glyphId);
            doc?.destroy();
            this._glyphDocs.delete(glyphId);
            this._dormantGlyphStates.delete(glyphId);
            this._dormantDocumentCheckpoints.delete(documentId);
            this._forgetGlyphNameForId(glyphId);
            if (name) {
                this._glyphIdByName.delete(name);
            }
            this._lastEncodedShardBytes.delete(documentId);
            this._stateLoadedDocumentIds.delete(documentId);
            unloaded.push(glyphId);
        }
        if (keptForCatchUp.length) {
            recordCollabTrace(
                'glyph-unload-kept-catch-up',
                keptForCatchUp
                    .map((documentId) =>
                        this._glyphNameById.get(
                            documentId.slice('glyph:'.length)
                        )
                    )
                    .filter((name): name is string => !!name),
                { documents: keptForCatchUp }
            );
        }
        if (unloaded.length) {
            recordCollabTrace(
                'glyph-unloaded',
                unloaded
                    .map((glyphId) => this._removedGlyphNameById.get(glyphId))
                    .filter((name): name is string => !!name),
                {
                    documents: unloaded.map(glyphDocumentId),
                    kept: keep.size,
                    working: this._sparseWorkingGlyphIds.size,
                    caller: new Error().stack?.split('\n').slice(2, 6) ?? []
                }
            );
            this._syncAllGlyphsFromYDoc(false, { dropGlyphIds: unloaded });
            this._emitAfterSync();
        }
        return unloaded;
    }

    /**
     * Room checkpoints a document was loaded from, by sha256. Kept on the
     * document object itself, so a document that is dropped and made again
     * never claims a checkpoint it does not hold.
     */
    private _documentCheckpoints = new WeakMap<Y.Doc, string>();

    private _noteShardCheckpoint(doc: Y.Doc, shard: EncodedShard): void {
        const sha256 = String(shard.checkpointSha256 || '').toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha256)) {
            this._documentCheckpoints.set(doc, sha256);
        }
    }

    /** The checkpoint (sha256) this document was loaded from, if known. */
    documentCheckpointSha256(documentId: string): string | null {
        const dormantCheckpoint =
            this._dormantDocumentCheckpoints.get(documentId);
        if (dormantCheckpoint) {
            return dormantCheckpoint;
        }
        const doc = this._docForId(documentId);
        return doc ? (this._documentCheckpoints.get(doc) ?? null) : null;
    }

    applyDocumentSetState(shards: EncodedShard[]): void {
        this._withGlyphModelRebuild('snapshot', null, () =>
            this._applyDocumentSetState(shards)
        );
    }

    private _applyDocumentSetState(shards: EncodedShard[]): void {
        this._pushApplyKind(ApplyKind.Remote);
        try {
            if (!this._fontJson) this._fontJson = {};
            for (const shard of shards) {
                const doc = this._docForShard(shard);
                applyUpdateWithIntegrity(
                    doc,
                    shard.bytes,
                    shard.documentId,
                    SYSTEM_REMOTE_ORIGIN,
                    this._brokenScope
                );
                this._noteShardCheckpoint(doc, shard);
                this._stateLoadedDocumentIds.add(shard.documentId);
                this._lastEncodedShardBytes.set(
                    shard.documentId,
                    shard.bytes.byteLength
                );
            }
            this._rebuildGlyphNameIndexFromDocs();
            this._rehydrateEntireFontJsonFromYDoc();
            this._canonicalizeFullStateRawFontJson();
            this._evictIdleLiveGlyphDocs(PatchSyncEngine.MAX_LIVE_GLYPH_DOCS);
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
        } finally {
            this._popApplyKind();
        }
        this._assertGeometryCompleteAfterConvergedState();
        this._flushStrandedOutboxes();
    }

    /**
     * Install snapshot shard bytes without rebuilding the font model.
     * Linked-window batches use this so a full resident set does not
     * rehydrate once per batch.
     */
    applySnapshotBytes(shards: EncodedShard[]): void {
        if (!shards.length) {
            return;
        }
        this._pushApplyKind(ApplyKind.Remote);
        try {
            if (!this._fontJson) {
                this._fontJson = {};
            }
            for (const shard of shards) {
                const doc = this._docForShard(shard);
                applyUpdateWithIntegrity(
                    doc,
                    shard.bytes,
                    shard.documentId,
                    SYSTEM_REMOTE_ORIGIN,
                    this._brokenScope
                );
                this._noteShardCheckpoint(doc, shard);
                this._stateLoadedDocumentIds.add(shard.documentId);
                this._lastEncodedShardBytes.set(
                    shard.documentId,
                    shard.bytes.byteLength
                );
            }
        } finally {
            this._popApplyKind();
        }
    }

    /**
     * Build the font JSON once after every resident snapshot shard is in.
     */
    materializeSnapshotFont(): Record<string, Unsafe> {
        return this._withGlyphModelRebuild('snapshot', null, () =>
            this._materializeSnapshotFont()
        );
    }

    private _materializeSnapshotFont(): Record<string, Unsafe> {
        if (!this._fontJson) {
            this._fontJson = {};
        }
        this._rebuildGlyphNameIndexFromDocs();
        this._rehydrateEntireFontJsonFromYDoc();
        this._canonicalizeFullStateRawFontJson();
        this._evictIdleLiveGlyphDocs(PatchSyncEngine.MAX_LIVE_GLYPH_DOCS);
        this._emitAfterSync();
        return this._fontJson;
    }

    private _docForShard(shard: EncodedShard): Y.Doc {
        if (shard.documentId === FONT_CORE_DOCUMENT_ID) {
            return this.yDoc;
        }
        if (shard.documentId === FONT_DEPS_DOCUMENT_ID) {
            return this.depsDoc;
        }
        if (isLayoutDocumentId(shard.documentId)) {
            return this._ensureLayoutDoc(shard.documentId);
        }
        return this._ensureGlyphDocFromShard(shard);
    }

    private _ensureGlyphDocFromShard(shard: EncodedShard): Y.Doc {
        const glyphId = shard.documentId.startsWith('glyph:')
            ? shard.documentId.slice('glyph:'.length)
            : shard.documentId;
        let doc = this._wakeGlyphDoc(glyphId);
        if (!doc) {
            this._assertDocumentIdWritable(glyphDocumentId(glyphId));
            doc = new Y.Doc({ gc: true });
            this._glyphDocs.set(glyphId, doc);
            this._bindDocUpdates(doc, glyphDocumentId(glyphId));
            this._noteDocumentLoaded(glyphDocumentId(glyphId));
        }
        return doc;
    }

    private _rebuildGlyphNameIndexFromDocs(): void {
        const previousDormantNames = new Map<string, string>();
        for (const glyphId of this._dormantGlyphStates.keys()) {
            const existing = this._glyphNameById.get(glyphId);
            if (existing) {
                previousDormantNames.set(glyphId, existing);
            }
        }
        this._glyphIdByName.clear();
        this._glyphNameById.clear();
        // A deleted glyph's document can stay resident a while, still named.
        // It must not take the name back: a glyph added again under that
        // name would then write into the deleted glyph's room, which never
        // sends.
        const catalog = this._fontJson
            ? catalogFromCoreJson(this._fontJson as Record<string, unknown>)
                  ?.glyphCatalog
            : undefined;
        for (const [glyphId, name] of previousDormantNames) {
            if (
                isCatalogTombstone(catalog, glyphId) ||
                this._pendingDestroyedGlyphIds.has(glyphId)
            ) {
                continue;
            }
            this._glyphIdByName.set(name, glyphId);
            this._glyphNameById.set(glyphId, name);
        }
        for (const [glyphId, doc] of this._glyphDocs) {
            if (
                isCatalogTombstone(catalog, glyphId) ||
                this._pendingDestroyedGlyphIds.has(glyphId)
            ) {
                continue;
            }
            const glyphMap = doc.getMap('glyph');
            const nameValue = glyphMap.get('name');
            const name =
                typeof nameValue === 'string' && nameValue
                    ? nameValue
                    : glyphId;
            const holder = this._glyphIdByName.get(name);
            if (holder && holder !== glyphId) {
                // Two documents with one name: the catalog's glyph keeps it.
                if (catalog?.[glyphId]?.name !== name) {
                    continue;
                }
                this._forgetGlyphNameForId(holder);
            }
            this._glyphIdByName.set(name, glyphId);
            this._glyphNameById.set(glyphId, name);
        }
        this._aliasResidentGlyphNamesFromCatalog();
    }

    /**
     * A name the index gave a glyph the catalog has since deleted is free: a
     * catalog tombstone can arrive after the glyph's last catch-up indexed
     * it, and a glyph added again under that name must not resolve to the
     * deleted glyph.
     */
    /**
     * A window that is not subscribed to a glyph's room hears its delete only
     * as a glyphOrder change. A catch-up of that room fetched before the
     * delete can land after it and put the glyph back, and only the catalog
     * tombstone, written later, says it is gone. Drop a tombstoned glyph
     * glyphOrder no longer lists; one an undo restored is back in the order.
     */
    private _dropTombstonedGlyphsMissingFromOrder(): void {
        const fontRecord = this._fontJson as Record<string, unknown> | null;
        if (!fontRecord || !Array.isArray(fontRecord.glyphs)) {
            return;
        }
        const catalog = catalogFromCoreJson(fontRecord)?.glyphCatalog;
        const glyphOrder = this.fontMap.get('glyphOrder');
        if (
            !catalog ||
            !(glyphOrder instanceof Y.Array) ||
            !glyphOrder.length
        ) {
            return;
        }
        const ordered = new Set(glyphOrder.toArray().map(String));
        const glyphs = fontRecord.glyphs as Unsafe[];
        for (let index = glyphs.length - 1; index >= 0; index -= 1) {
            const name =
                typeof glyphs[index]?.name === 'string'
                    ? String(glyphs[index].name)
                    : '';
            const glyphId =
                (typeof glyphs[index]?.id === 'string' && glyphs[index].id) ||
                this._glyphIdByName.get(name);
            if (
                glyphId &&
                !ordered.has(name) &&
                isCatalogTombstone(catalog, String(glyphId))
            ) {
                glyphs.splice(index, 1);
            }
        }
    }

    private _dropDeletedGlyphNamesFromIndex(): void {
        if (!this._fontJson) {
            return;
        }
        const catalog = catalogFromCoreJson(
            this._fontJson as Record<string, unknown>
        )?.glyphCatalog;
        if (!catalog) {
            return;
        }
        for (const [glyphName, glyphId] of [...this._glyphIdByName]) {
            if (isCatalogTombstone(catalog, glyphId)) {
                this._glyphIdByName.delete(glyphName);
                this._forgetGlyphNameForId(glyphId);
            }
        }
    }

    /**
     * A caught-up shard can be resident before its Y.Map has a name, so the
     * index falls back to the glyph id. The catalog already knows the name.
     */
    private _aliasResidentGlyphNamesFromCatalog(): void {
        if (!this._fontJson) {
            return;
        }
        const owned = catalogFromCoreJson(
            this._fontJson as Record<string, unknown>
        );
        if (!owned) {
            return;
        }
        for (const entry of Object.values(owned.glyphCatalog)) {
            if (!entry?.glyphId || !entry.name || entry.deleted === true) {
                continue;
            }
            if (!this._hasHeldGlyphDoc(entry.glyphId)) {
                continue;
            }
            const indexedName = this._glyphNameById.get(entry.glyphId);
            // A real glyph name wins. The catalog only fills the id fallback
            // used when a shard arrives before its name field.
            if (indexedName && indexedName !== entry.glyphId) {
                continue;
            }
            const previousId = this._glyphIdByName.get(entry.name);
            if (previousId && previousId !== entry.glyphId) {
                continue;
            }
            this._glyphIdByName.set(entry.name, entry.glyphId);
            this._glyphNameById.set(entry.glyphId, entry.name);
        }
    }

    private _routedYPath(
        path: Array<string | number>,
        options?: { forWrite?: boolean }
    ): {
        map: Y.Map<unknown>;
        path: Array<string | number>;
        doc: Y.Doc;
        documentId: string;
    } {
        const documentId = this.documentIdForPath(path);
        if (path[0] === 'glyphs' && path.length >= 2) {
            const glyphName = String(path[1]);
            const glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap && options?.forWrite) {
                // Glyphs are created whole (_applyGlyphSnapshot, or before a
                // commit by _ensureDocumentsForOperations), never by a write
                // into one of their paths.
                throw new Error(
                    `[PatchSyncEngine] Refusing to write ${path.join('.')}: glyph ${glyphName} has no document`
                );
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
                doc: glyphMap.doc as Y.Doc,
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
        if (this.roomLayout && documentId === FONT_FEATURES_DOCUMENT_ID) {
            const doc = this._ensureLayoutDoc(documentId);
            return {
                map: doc.getMap(FEATURES_ROOT_KEY),
                path,
                doc,
                documentId
            };
        }
        if (this.roomLayout && layoutDocumentKind(documentId) === 'catalog') {
            const doc = this._ensureLayoutDoc(documentId);
            return {
                map: doc.getMap(CATALOG_ROOT_KEY),
                path: path.slice(1),
                doc,
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
        if (this._layoutSetPath(path, value)) {
            return;
        }
        const routed = this._routedYPath(path, { forWrite: true });
        setYPath(routed.map, routed.path, value);
    }

    private _deleteRoutedYPath(path: Array<string | number>): void {
        if (path[0] === 'glyphs' && path.length === 2) {
            this._removeGlyphDoc(String(path[1]));
            return;
        }
        if (this._layoutDeletePath(path)) {
            return;
        }
        const routed = this._routedYPath(path);
        deleteYPath(routed.map, routed.path);
    }

    private _getRoutedYPath(path: Array<string | number>): unknown {
        if (path[0] === 'glyphs' && path.length === 2) {
            return this._glyphMapForName(String(path[1])) || undefined;
        }
        const layoutRead = this._layoutGetPath(path);
        if (layoutRead.handled) {
            return layoutRead.value;
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
    /** Collaborator revisions per glyph id that no catch-up has confirmed yet. */
    private _glyphRevisionsAwaitingFetch = new Map<string, string>();
    /**
     * Collaborator revisions released after a newer one of the same glyph
     * (held for their commit's siblings): the feed keeps the newer token,
     * but the write still has to be fetched.
     */
    private _lateGlyphRevisionsAwaitingFetch = new Map<string, string>();
    private _retiredGlyphIdByName = new Map<string, string>();

    private _removeGlyphDoc(glyphName: string): void {
        const glyphId = this._glyphIdByName.get(glyphName);
        if (glyphId) {
            this._removedGlyphNameById.set(glyphId, glyphName);
        }
        const glyphMap = this._glyphMapForName(glyphName);
        if (glyphMap instanceof Y.Map) {
            for (const key of [...glyphMap.keys()]) {
                glyphMap.delete(key);
            }
        }
        const glyphsMap = this.fontMap.get('glyphs');
        if (glyphsMap instanceof Y.Map && glyphsMap.has(glyphName)) {
            glyphsMap.delete(glyphName);
        }
        if (!glyphId) {
            return;
        }
        this._retiredGlyphIdByName.set(glyphName, glyphId);
        this._pendingDestroyedGlyphIds.add(glyphId);
    }

    private _flushDestroyedGlyphDocs(): void {
        for (const glyphId of this._pendingDestroyedGlyphIds) {
            const glyphName = this._glyphNameById.get(glyphId);
            if (glyphName) {
                this._glyphIdByName.delete(glyphName);
            }
            this._forgetGlyphNameForId(glyphId);
        }
        this._pendingDestroyedGlyphIds.clear();
    }

    private _syncGlyphNameIndexToOrder(options?: {
        pairSingleRename?: boolean;
    }): void {
        const remaining = new Set(this._readYGlyphOrderNames());
        const displaced: string[] = [];
        for (const [glyphName, glyphId] of [...this._glyphIdByName]) {
            if (remaining.has(glyphName)) {
                continue;
            }
            this._glyphIdByName.delete(glyphName);
            if (this._hasHeldGlyphDoc(glyphId)) {
                displaced.push(glyphId);
            } else {
                this._forgetGlyphNameForId(glyphId);
            }
        }
        for (const glyphName of remaining) {
            if (this._glyphIdByName.has(glyphName)) {
                continue;
            }
            let matched = false;
            for (const [glyphId, doc] of this._glyphDocs) {
                const nameValue = doc.getMap('glyph').get('name');
                if (nameValue === glyphName) {
                    this._glyphIdByName.set(glyphName, glyphId);
                    this._glyphNameById.set(glyphId, glyphName);
                    const displacedIndex = displaced.indexOf(glyphId);
                    if (displacedIndex >= 0) {
                        displaced.splice(displacedIndex, 1);
                    }
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                for (const glyphId of this._dormantGlyphStates.keys()) {
                    if (this._glyphNameById.get(glyphId) === glyphName) {
                        this._glyphIdByName.set(glyphName, glyphId);
                        const displacedIndex = displaced.indexOf(glyphId);
                        if (displacedIndex >= 0) {
                            displaced.splice(displacedIndex, 1);
                        }
                        break;
                    }
                }
            }
        }
        const openNames = [...remaining].filter(
            (glyphName) => !this._glyphIdByName.has(glyphName)
        );
        if (
            options?.pairSingleRename &&
            displaced.length === 1 &&
            openNames.length === 1
        ) {
            this._glyphIdByName.set(openNames[0], displaced[0]);
            this._glyphNameById.set(displaced[0], openNames[0]);
            return;
        }
        for (const glyphId of displaced) {
            const mapped = this._glyphNameById.get(glyphId);
            if (!mapped || !remaining.has(mapped)) {
                if (!this._hasHeldGlyphDoc(glyphId)) {
                    this._forgetGlyphNameForId(glyphId);
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
            const mappedId = [...this._glyphNameById.entries()].find(
                ([, glyphName]) => glyphName === remap.oldName
            )?.[0];
            const glyphId =
                this._glyphIdByName.get(remap.oldName) ||
                this._glyphIdByName.get(remap.newName) ||
                mappedId;
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
        documentId: string = FONT_CORE_DOCUMENT_ID
    ): void {
        const update = this._takeOutbox(documentId);
        if (isEmptyYjsUpdate(update)) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            return;
        }

        this._emitLocalUpdate(
            update,
            this._getNewChangeLogEntriesForLocalUpdate(),
            documentId
        );
    }

    /**
     * Emit one Yjs packet per document, tagged so a multi-glyph commit
     * refreshes the overview once instead of once per glyph.
     */
    private _emitLocalUpdateBatch(
        packets: Array<{
            update: YjsUpdate;
            entries: ChangeLogEntry[];
            documentId: string;
            options?: {
                dependsOn?: string[];
                skipCollaborationLog?: boolean;
            };
        }>
    ): void {
        const count = packets.length;
        const id =
            count > 1 ? `ui-batch:${this._nextUiBatchSerial++}` : undefined;
        const isRenameBatch =
            count > 1 &&
            packets.some((packet) =>
                packet.entries.some(
                    (entry) => normalizeGlyphRenames(entry.glyphRenames).length
                )
            );
        // A multi-document commit hands every packet the same entries. Each
        // packet is described by its own document's entries only: the room
        // caps every description at 64 KiB, and one packet per glyph that
        // each listed the whole commit (add station) could not fit, so the
        // room refused those writes. It also kept every receiver re-reading
        // every glyph once per packet. Rename batches keep the full list:
        // the worker validates those against every renamed shard at once.
        const sharedEntries =
            count > 1 &&
            packets.every((packet) => packet.entries === packets[0].entries)
                ? packets[0].entries
                : null;
        const sharedEmission: SharedLocalEmission | undefined = sharedEntries
            ? {
                  entriesByDocument: isRenameBatch
                      ? null
                      : this._splitCommitEntriesByPacket(
                            getEffectiveEmissionEntries(sharedEntries),
                            packets.map((packet) => packet.documentId)
                        )
              }
            : undefined;
        let index = 0;
        try {
            for (; index < packets.length; index += 1) {
                const packet = packets[index];
                const renameBatch: WorkerRenameBatchPart | undefined =
                    isRenameBatch
                        ? index === count - 1
                            ? 'last'
                            : 'partial'
                        : undefined;
                this._emitLocalUpdate(
                    packet.update,
                    packet.entries,
                    packet.documentId,
                    {
                        ...packet.options,
                        ...(id ? { uiBatch: { id, index, count } } : {}),
                        ...(renameBatch ? { renameBatch } : {}),
                        ...(sharedEmission ? { sharedEmission } : {})
                    }
                );
            }
        } finally {
            // The packet that threw put itself back; the ones after it were
            // taken from the outbox too and stay queued, in order.
            for (let rest = packets.length - 1; rest > index; rest -= 1) {
                this._requeueUnsent(
                    packets[rest].documentId,
                    packets[rest].update
                );
            }
        }
    }

    /**
     * Splits one commit's entries across its packets by the document each
     * entry lives in. Entries whose document has no packet go with the font
     * core packet (or the first packet), except a glyph's drawing entries:
     * that glyph did not change. Receivers re-read only the paths a packet
     * lists after applying it, so a packet left without entries lists its
     * whole document instead.
     */
    private _splitCommitEntriesByPacket(
        entries: ChangeLogEntry[],
        documentIds: string[]
    ): Map<string, ChangeLogEntry[]> {
        const byDocument = new Map<string, ChangeLogEntry[]>(
            documentIds.map((documentId) => [documentId, []])
        );
        if (!entries.length) {
            return byDocument;
        }
        const fallbackDocumentId = byDocument.has(FONT_CORE_DOCUMENT_ID)
            ? FONT_CORE_DOCUMENT_ID
            : documentIds[0];
        const renames = this._collectGlyphRenamesFromEntries(entries);
        for (const entry of entries) {
            const documentId = this._documentIdForHistoryEntry(entry, renames);
            const own = byDocument.get(documentId);
            if (own) {
                own.push(entry);
                continue;
            }
            // A glyph document that sent no packet did not change: its
            // drawing entries describe no packet, least of all another
            // document's.
            if (
                documentId.startsWith('glyph:') &&
                this._isGlyphDrawingPath(entry.path)
            ) {
                continue;
            }
            byDocument.get(fallbackDocumentId)?.push(entry);
        }
        for (const [documentId, own] of byDocument) {
            if (own.length) {
                continue;
            }
            const glyphName = documentId.startsWith('glyph:')
                ? this._glyphNameById.get(documentId.slice('glyph:'.length))
                : undefined;
            byDocument.set(
                documentId,
                glyphName
                    ? [
                          {
                              ...entries[0],
                              path: joinPathWithGlyphSeparator([
                                  'glyphs',
                                  glyphName
                              ]),
                              op: 'set',
                              oldValue: undefined,
                              newValue: undefined,
                              replayOldValue: undefined,
                              replayNewValue: undefined,
                              workerReplayTargets: [],
                              glyphRenames: [],
                              // A whole-glyph re-read, not a drawing edit.
                              undoScope: 'glyph'
                          }
                      ]
                    : // Described whole, never by other documents' paths.
                      [this._wholeDocumentEntry(documentId, 'Document update')]
            );
        }
        return byDocument;
    }

    private _emitLocalUpdate(
        update: YjsUpdate,
        changeLogEntries: ChangeLogEntry[],
        documentId: string = FONT_CORE_DOCUMENT_ID,
        options?: {
            dependsOn?: string[];
            skipCollaborationLog?: boolean;
            uiBatch?: CommittedUiBatch;
            renameBatch?: WorkerRenameBatchPart;
            sharedEmission?: SharedLocalEmission;
            /**
             * Entries that describe the packet on the wire only. This
             * window's worker and committed-change listeners still see
             * `changeLogEntries` (derived data such as font-deps).
             */
            envelopeEntries?: ChangeLogEntry[];
        }
    ): void {
        let handedOff = false;
        try {
            this._describeAndDeliverLocalUpdate(
                update,
                changeLogEntries,
                documentId,
                options,
                () => {
                    handedOff = true;
                }
            );
        } catch (error) {
            // A packet that could not be made leaves its updates queued.
            if (!handedOff) {
                this._requeueUnsent(documentId, update);
            }
            throw error;
        }
    }

    private _describeAndDeliverLocalUpdate(
        update: YjsUpdate,
        changeLogEntries: ChangeLogEntry[],
        documentId: string,
        options:
            | {
                  dependsOn?: string[];
                  skipCollaborationLog?: boolean;
                  uiBatch?: CommittedUiBatch;
                  renameBatch?: WorkerRenameBatchPart;
                  sharedEmission?: SharedLocalEmission;
                  /**
                   * Entries that describe the packet on the wire only. This
                   * window's worker and committed-change listeners still see
                   * `changeLogEntries` (derived data such as font-deps).
                   */
                  envelopeEntries?: ChangeLogEntry[];
              }
            | undefined,
        onHandedOff: () => void
    ): void {
        const shared = options?.sharedEmission;
        // Every packet carries an envelope: one without entries would skip
        // the device outbox and the room’s description checks. A document
        // that changed with no entries of its own is described whole.
        if (
            !getEffectiveEmissionEntries(changeLogEntries).length &&
            !options?.envelopeEntries?.length &&
            !shared?.entriesByDocument?.get(documentId)?.length
        ) {
            changeLogEntries = [
                this._wholeDocumentEntry(documentId, 'Document update')
            ];
        }
        // Undo/redo may append a coarse control entry for history-stack state,
        // but every emitted Yjs packet must still be observed through the same
        // semantic metadata shape as the original forward edit. Unwrap control
        // rows here so worker/cache/compile/broadcast consumers never need an
        // undo-specific path.
        const emissionEntries = getEffectiveEmissionEntries(changeLogEntries);
        // Entries describing this packet alone (multi-document commits);
        // otherwise every packet carries the commit's entries.
        const packetEntries =
            shared?.entriesByDocument?.get(documentId) ?? null;
        // Body reused across packets only when they all carry the same list.
        const reuseBody = shared && !packetEntries ? shared : null;
        const describedEntries = packetEntries ?? emissionEntries;
        const localSequence = this._nextCollaborationMessageSequence++;
        let collaborationMessage: CollaborationMessageEnvelope | null;
        if (reuseBody && reuseBody.envelope !== undefined) {
            collaborationMessage = reuseBody.envelope
                ? { ...reuseBody.envelope, localSequence }
                : null;
        } else {
            collaborationMessage =
                createCollaborationMessageEnvelopeFromChangeLogEntries(
                    options?.envelopeEntries?.length
                        ? options.envelopeEntries
                        : describedEntries,
                    {
                        localSequence,
                        source: 'change-bridge',
                        windowId: this.windowId
                    }
                );
            if (reuseBody) {
                reuseBody.envelope = collaborationMessage;
            }
        }
        if (!collaborationMessage) {
            throw new Error(
                `[PatchSyncEngine] Refusing to send a packet for ${documentId} without a collaboration envelope`
            );
        }
        // Glyph drawings live in their glyph's document. A font-core packet
        // described as a drawing edit carries an edit that went nowhere (or
        // font-core writes described as one); a rename batch alone lists
        // the whole commit on every packet.
        if (
            documentId === FONT_CORE_DOCUMENT_ID &&
            !options?.renameBatch &&
            this._fontHasGlyphDocuments()
        ) {
            const wireEntries = options?.envelopeEntries?.length
                ? options.envelopeEntries
                : describedEntries;
            const drawingEntry = wireEntries.find((entry) =>
                this._isGlyphDrawingPath(entry.path)
            );
            if (drawingEntry) {
                throw new Error(
                    `[PatchSyncEngine] Refusing to send a font-core packet described as the glyph drawing edit ${drawingEntry.path}`
                );
            }
        }
        if (!options?.skipCollaborationLog) {
            let forwardChanges = reuseBody?.forwardChanges;
            if (!forwardChanges) {
                forwardChanges =
                    this._deriveForwardChangesFromChangeLogEntries(
                        describedEntries
                    );
                if (reuseBody) {
                    reuseBody.forwardChanges = forwardChanges;
                }
            }
            this._appendCollaborationLogItems([
                this._createCollaborationLogItem(
                    collaborationMessage,
                    update,
                    'local',
                    forwardChanges
                )
            ]);
        }
        const emittedGlyphId = glyphIdFromDocumentId(documentId);
        const glyphRevision = emittedGlyphId
            ? this._pendingGlyphRevisions?.get(emittedGlyphId)
            : undefined;
        if (collaborationMessage && glyphRevision) {
            // The room passes it on to font-core's revision feed once the
            // write is durable.
            collaborationMessage = { ...collaborationMessage, glyphRevision };
        }
        onHandedOff();
        const burstKey = this._currentBurstKey();
        const meta: LocalUpdateMeta = { burstKey };
        const deliver = (includeCloudListeners = true): void => {
            pushCollabIntegrityEvent('emit-local', {
                documentId,
                bytes: update.length,
                hasCollaborationMessage: Boolean(collaborationMessage),
                entries: emissionEntries.length
            });
            for (const cb of this._localUpdateListeners) {
                if (
                    !includeCloudListeners &&
                    this._cloudLocalListeners.has(cb)
                ) {
                    continue;
                }
                cb(
                    update,
                    collaborationMessage,
                    describedEntries,
                    documentId,
                    meta
                );
            }
            if (options?.renameBatch) {
                this._yjsWorkerCallback?.(update, emissionEntries, documentId, {
                    renameBatch: options.renameBatch
                });
            } else {
                // Every packet goes to the worker as it comes, in order, so
                // the worker's document history stays complete.
                this._yjsWorkerCallback?.(update, describedEntries, documentId);
            }
            // This window's UI listeners coalesce a uiBatch and still see
            // the whole commit on every packet.
            for (const cb of this._committedChangeListeners) {
                cb(emissionEntries, {
                    origin: 'local',
                    update,
                    documentId,
                    ...(options?.uiBatch ? { uiBatch: options.uiBatch } : {})
                });
            }
        };
        const plugin = window.cloudPlugin;
        if (
            typeof plugin?.persistOutgoingCloudUpdate === 'function' &&
            collaborationMessage &&
            // Linked windows have no cloud session; the main window writes
            // the durable row when it relays the edit.
            !window.windowRole?.isLinkedWindow?.() &&
            window.fontManager?.currentFont?.isCloudBacked?.() === true
        ) {
            const holdDecision = this._cloudHold.submit(
                {
                    kind: 'local',
                    burstKey,
                    documentId,
                    update,
                    envelope: collaborationMessage,
                    entries: describedEntries
                },
                this._currentCloudCommitId()
            );
            if (holdDecision === 'held') {
                // Every local consumer sees the edit now; the room gets the
                // burst once, merged, when it ends. The device outbox got it
                // when the hold took it (`onHeld`), so a tab closed
                // mid-burst does not lose it.
                deliver(false);
                return;
            }
            // Every listener, the cloud one included, gets the packet now,
            // in commit order: the adapter holds it until its outbox row
            // exists, so the row write never reorders packets. A held
            // linked-window run of this document still taking its queue
            // place goes first, row and packet.
            const envelope = collaborationMessage;
            const gate = this._cloudDeliveryGates.get(documentId);
            this._persistOutgoingInOrder(
                () =>
                    plugin.persistOutgoingCloudUpdate(
                        update,
                        envelope,
                        documentId,
                        options?.dependsOn
                    ),
                update,
                documentId,
                false,
                gate
            );
            if (!gate) {
                deliver();
                return;
            }
            deliver(false);
            const cloudListeners = [...this._cloudLocalListeners];
            this._deliverToCloudInOrder(documentId, () => {
                for (const cb of cloudListeners) {
                    cb(
                        update,
                        collaborationMessage,
                        describedEntries,
                        documentId,
                        meta
                    );
                }
            });
            return;
        }
        deliver();
    }

    /**
     * Write a packet's device outbox row after the rows before it. A storage
     * failure (`CloudWalPersistError`) keeps the row in memory and is only
     * reported; any other failure, or a refusal, stops the document: it is
     * marked broken, so no later edit to it is made or sent.
     */
    private _persistOutgoingInOrder(
        persist: () => Promise<boolean> | boolean,
        update: YjsUpdate,
        documentId: string,
        held: boolean,
        after?: Promise<unknown>,
        onWritten?: () => void
    ): void {
        this._cloudEmitPersistsInFlight += 1;
        this._cloudEmitPersistChain = this._cloudEmitPersistChain
            .then(() => after)
            .then(() => Promise.resolve(persist()))
            .then(
                (ok) => {
                    pushCollabIntegrityEvent('emit-persist', {
                        documentId,
                        bytes: update.length,
                        ok: ok !== false,
                        ...(held ? { held: true } : {})
                    });
                    if (ok === false) {
                        const error = new Error(
                            `The edit to ${documentId} was not written to this device’s outbox`
                        );
                        this._reportCloudPersistFailure(documentId, error);
                        this.markDocumentBroken(documentId, error);
                        return;
                    }
                    onWritten?.();
                },
                (error) => {
                    pushCollabIntegrityEvent('emit-persist', {
                        documentId,
                        bytes: update.length,
                        ok: false,
                        ...(held ? { held: true } : {}),
                        error: String(error)
                    });
                    const failure =
                        error instanceof Error
                            ? error
                            : new Error(String(error));
                    this._reportCloudPersistFailure(documentId, failure);
                    if (!(failure instanceof CloudWalPersistError)) {
                        this.markDocumentBroken(documentId, failure);
                    }
                }
            )
            .then(
                () => undefined,
                () => undefined
            )
            .then(() => {
                this._cloudEmitPersistsInFlight -= 1;
            });
    }

    /** True while a local edit is still on its way into the cloud outbox. */
    get hasCloudPersistInFlight(): boolean {
        // A burst the room has not been sent yet is still on its way too.
        return (
            this._cloudEmitPersistsInFlight > 0 ||
            this._cloudHold.hasPending() ||
            this._cloudDeliveryGates.size > 0
        );
    }

    private _reportCloudPersistFailure(
        documentId: string,
        failure: string | Error
    ): void {
        const reason = typeof failure === 'string' ? failure : failure.message;
        console.error(
            `Cloud durability persist failed for ${documentId}: ${reason}; edit is not yet durable`
        );
        const storageFull =
            failure instanceof CloudWalPersistError && failure.quotaExceeded;
        window.dispatchEvent(
            new CustomEvent('cloud-persist-failed', {
                detail: { documentId, reason, storageFull }
            })
        );
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
            for (const documentId of this._documentIdsForHistoryEntry(
                entry,
                itemRenames
            )) {
                documentIds.add(documentId);
            }
        }
        return [...documentIds];
    }

    /**
     * Every room one history entry writes: its own, plus the buckets a whole
     * kerning map or catalog spreads over (see _extraLayoutDocumentIds), so
     * an undo reaches the same rooms as the edit did.
     */
    private _documentIdsForHistoryEntry(
        entry: ChangeLogEntry,
        renames: GlyphRename[] = []
    ): string[] {
        const primary = this._documentIdForHistoryEntry(entry, renames);
        if (!entry.path || entry.path === 'font') {
            return [primary];
        }
        const extra = this._extraLayoutDocumentIds(
            this._toYDocPath(this._parseEntryPath(entry.path))
        );
        return extra.length ? [...new Set([primary, ...extra])] : [primary];
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

    /**
     * Send what an undo or redo queued: the rooms it was expected to write
     * first, then any other room it reached. A room that changed without an
     * entry of its own (a revision stamp) is described whole, never skipped.
     */
    private _emitCanonicalLocalUpdatesSince(
        baselines: Map<string, Uint8Array>
    ): void {
        const allEntries = getEffectiveEmissionEntries(
            this._getNewChangeLogEntriesForLocalUpdate()
        );
        const packets: Array<{
            update: YjsUpdate;
            entries: ChangeLogEntry[];
            documentId: string;
        }> = [];
        const historyRenames = this._collectGlyphRenamesFromEntries(allEntries);
        const documentIds = [
            ...new Set([...baselines.keys(), ...this._outbox.keys()])
        ];
        for (const documentId of documentIds) {
            const incrementalUpdate = this._takeOutbox(documentId);
            if (isEmptyYjsUpdate(incrementalUpdate)) {
                continue;
            }
            const ownEntries = allEntries.filter((entry) => {
                if (!entry.path || entry.path === 'font') {
                    return documentId === FONT_CORE_DOCUMENT_ID;
                }
                return this._documentIdsForHistoryEntry(
                    entry,
                    historyRenames
                ).includes(documentId);
            });
            // An undo that removed or brought back a glyph names it in its
            // own entries even when the name index no longer points at this
            // document: those entries describe the packet.
            const glyphId = glyphIdFromDocumentId(documentId);
            const removedGlyphEntries =
                !ownEntries.length && glyphId
                    ? allEntries.filter((entry) => {
                          const name = this._deriveGlyphNameFromPath(
                              entry.path || ''
                          );
                          return (
                              !!name &&
                              (this._retiredGlyphIdByName.get(name) ===
                                  glyphId ||
                                  this._removedGlyphNameById.get(glyphId) ===
                                      name)
                          );
                      })
                    : [];
            const docEntries = ownEntries.length
                ? ownEntries
                : removedGlyphEntries.length
                  ? removedGlyphEntries
                  : [this._wholeDocumentEntry(documentId, 'Undo or redo')];
            packets.push({
                update: incrementalUpdate,
                entries: docEntries,
                documentId
            });
        }
        if (!packets.length) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            return;
        }
        this._emitLocalUpdateBatch(packets);
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
        dormantGlyphCount: number;
        dormantGlyphBytes: number;
        liveGlyphCount: number;
        changeLog: ChangeLogEntry[];
        collaborationLog: CollaborationLogItem[];
    } {
        let decodedStructs = 0;
        const countDoc = (doc: Y.Doc) => {
            doc.store.clients.forEach((structs) => {
                decodedStructs += structs.length;
            });
        };
        countDoc(this.yDoc);
        countDoc(this.depsDoc);
        for (const doc of this._glyphDocs.values()) {
            countDoc(doc);
        }
        for (const doc of this._layoutDocs.values()) {
            countDoc(doc);
        }
        let dormantGlyphBytes = 0;
        for (const bytes of this._dormantGlyphStates.values()) {
            dormantGlyphBytes += bytes.byteLength;
        }

        return {
            fontJson: this._fontJson,
            yDocStore: this.yDoc.store,
            decodedStructs,
            dormantGlyphCount: this._dormantGlyphStates.size,
            dormantGlyphBytes,
            liveGlyphCount: this._glyphDocs.size,
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
        // font-core and deps keep their document objects with new content.
        this._documentCheckpoints = new WeakMap();
        this._fontJson = fontJson;
        this._isSyncing = true;
        stampImmutableGlyphIds(fontJson);
        if (catalogFromCoreJson(fontJson)) {
            applyCloudOwnedData(fontJson);
        }
        this._destroyGlyphDocs();
        this._destroyLayoutDocs();
        this._pushApplyKind(ApplyKind.ManualEmit);
        try {
            this.yDoc.transact(() => {
                this.fontMap.forEach((_v: unknown, k: string) => {
                    this.fontMap.delete(k);
                });
                const layoutMap = this.yDoc.getMap(LAYOUT_MAP_KEY);
                for (const key of [...layoutMap.keys()]) {
                    layoutMap.delete(key);
                }
                jsonToCoreFontMap(fontJson, this.fontMap);
            }, USER_EDIT_ORIGIN);
            this._roomLayoutCache = undefined;
            for (const glyph of listGlyphRecords(fontJson)) {
                sanitizeGlyphEmptyReferenceComponents(glyph);
                const glyphId = ensureImmutableGlyphId(glyph);
                const name = String(glyph.name || glyphId);
                this._ensureGlyphDoc(glyphId, name, glyph);
            }
        } finally {
            this._popApplyKind();
            this._isSyncing = false;
        }
        // A newly loaded font: no model object of the old one survives it.
        this._withGlyphModelRebuild(
            'rebaseline',
            null,
            () => this._rehydrateEntireFontJsonFromYDoc(),
            { silent: true }
        );
        // The loaded font is the documents’ starting state, not an edit: a
        // cloud asset gets it as the seed of its rooms.
        this._noteWholeStateDelivered(FONT_CORE_DOCUMENT_ID);
        this._noteWholeStateDelivered(FONT_DEPS_DOCUMENT_ID);
        this._stateLoadedDocumentIds.add(FONT_CORE_DOCUMENT_ID);
        this._stateLoadedDocumentIds.add(FONT_DEPS_DOCUMENT_ID);
        for (const glyphId of this._glyphDocs.keys()) {
            this._noteWholeStateDelivered(glyphDocumentId(glyphId));
        }
        // Park excess initial glyph Y.Docs into compact encoded bytes so large
        // fonts do not retain hundreds/thousands of decoded CRDT trees in heap.
        this._evictIdleLiveGlyphDocs(PatchSyncEngine.INITIAL_LIVE_GLYPH_DOCS);
    }

    /**
     * Populate `depsDoc` directly from precomputed dependency edges during
     * local sparse open without emitting a user edit packet.
     */
    seedFontDepsFromIndex(deps: FontDepsIndex): void {
        this._pushApplyKind(ApplyKind.ManualEmit);
        this._isSyncing = true;
        try {
            this.depsDoc.transact(() => {
                writeFontDepsYMap(this.depsDoc.getMap('deps'), deps);
            }, SYSTEM_REMOTE_ORIGIN);
        } finally {
            this._isSyncing = false;
            this._popApplyKind();
        }
        this._noteWholeStateDelivered(FONT_DEPS_DOCUMENT_ID);
        this._stateLoadedDocumentIds.add(FONT_DEPS_DOCUMENT_ID);
    }

    /**
     * Hydrate one or more local sparse glyphs fetched from `fontc-worker`'s
     * complete `FONT_CACHE` into `PatchSyncEngine` + `_fontJson`, returning
     * their encoded Yjs shards so the worker binds identical CRDT item IDs.
     */
    hydrateLocalGlyphsFromWorker(
        items: Array<{
            glyphId: string;
            glyphName: string;
            glyphJson: Record<string, unknown>;
        }>
    ): EncodedShard[] {
        if (!items.length) {
            return [];
        }
        const encodedShards: EncodedShard[] = [];
        this._glyphEvictionSuspendDepth += 1;
        this._pushApplyKind(ApplyKind.ManualEmit);
        this._isSyncing = true;
        try {
            for (const { glyphId, glyphName, glyphJson } of items) {
                const documentId = glyphDocumentId(glyphId);
                if (this._hasHeldGlyphDoc(glyphId)) {
                    continue;
                }
                sanitizeGlyphEmptyReferenceComponents(glyphJson);
                glyphJson.id = glyphId;
                const doc = this._ensureGlyphDoc(glyphId, glyphName, glyphJson);
                this._sparseWorkingGlyphIds.add(glyphId);
                this._noteWholeStateDelivered(documentId);
                this._stateLoadedDocumentIds.add(documentId);
                const bytes = Y.encodeStateAsUpdate(doc);
                this._lastEncodedShardBytes.set(documentId, bytes.byteLength);
                encodedShards.push({ documentId, bytes });
            }
        } finally {
            this._isSyncing = false;
            this._popApplyKind();
            this._glyphEvictionSuspendDepth -= 1;
        }
        if (encodedShards.length) {
            const hydratedNames = items.map((item) => item.glyphName);
            this._withGlyphModelRebuild(
                'hydrate',
                hydratedNames,
                () => {
                    for (const { glyphName } of items) {
                        this._patchGlyphFromYDoc(glyphName, {
                            ignoreExisting: true
                        });
                    }
                },
                { silent: true }
            );
            this._evictIdleLiveGlyphDocs(PatchSyncEngine.MAX_LIVE_GLYPH_DOCS);
        }
        return encodedShards;
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
    onLocalUpdate(
        cb: LocalUpdateListener,
        options?: LocalUpdateListenerOptions
    ): void {
        this._localUpdateListeners.add(cb);
        if (options?.cloud) {
            this._cloudLocalListeners.add(cb);
        }
    }

    /** Unregister a callback previously passed to onLocalUpdate. */
    offLocalUpdate(cb: LocalUpdateListener): void {
        this._localUpdateListeners.delete(cb);
        this._cloudLocalListeners.delete(cb);
    }

    // ── Edit bursts ──────────────────────────────────────────────

    /**
     * Run a gesture tick (one key repeat, one arrow-adjusted field step) as
     * part of burst `key`. Transactions that `fn` begins before it returns
     * (its synchronous part) share the burst's history item, and the room
     * gets the burst once, merged, after the gesture pauses. Local consumers
     * (worker, UI, linked windows) still see every tick at once. Work that
     * `fn` awaits afterwards is not part of the burst, so an unrelated edit
     * made meanwhile never joins it.
     *
     * `shareHistory: false` keeps the commits' own history items and holds
     * only the cloud send.
     */
    runInEditBurst<T>(
        key: string,
        fn: () => T,
        options?: { shareHistory?: boolean }
    ): T {
        const burst = this._editBursts.tick(key, options);
        this._ambientBursts.push(burst);
        try {
            return fn();
        } finally {
            const index = this._ambientBursts.lastIndexOf(burst);
            if (index >= 0) {
                this._ambientBursts.splice(index, 1);
            }
        }
    }

    /**
     * A drag or key nudge stages its drawings without committing. Each stage
     * is a tick of a burst that the commit ends: the commit becomes the
     * burst's history item.
     */
    noteLivePreviewTick(drawingIds: string[]): void {
        const ids = [...new Set(drawingIds)].sort();
        if (!ids.length) {
            return;
        }
        const key = `live:${ids.join(',')}`;
        this._editBursts.tick(key, {
            shareHistory: false,
            // A drag may pause; the commit ends the burst, not the idle timer.
            idleMs: APP_SETTINGS.EDIT_BURST_MAX_MS
        });
        this._liveBurstDrawings.set(key, new Set(ids));
    }

    private _finalizeLiveBursts(
        committedDrawingIds: string[],
        historyItemId: string
    ): void {
        const committed = new Set(committedDrawingIds);
        for (const [key, drawingIds] of [...this._liveBurstDrawings]) {
            if (
                ![...drawingIds].some((drawingId) => committed.has(drawingId))
            ) {
                continue;
            }
            this._liveBurstDrawings.delete(key);
            const burst = this._editBursts.get(key);
            if (burst) {
                burst.historyItemId = historyItemId;
            }
            void this._editBursts.finalize(key);
        }
    }

    /** The burst a commit made now belongs to, if any. */
    private _currentBurst(): EditBurst | null {
        return (
            this._txBurst ??
            this._ambientBursts[this._ambientBursts.length - 1] ??
            null
        );
    }

    private _currentBurstKey(): string | null {
        return this._currentBurst()?.key ?? null;
    }

    /**
     * Packets of one commit share an id for the cloud rate limit: a commit
     * starts here, and packets emitted without one (font-deps writes)
     * follow the commit before them in the same task.
     */
    private _beginCloudCommit(): void {
        this._cloudCommitSerial += 1;
        this._openCloudCommitWindow();
    }

    private _openCloudCommitWindow(): void {
        if (this._cloudCommitOpen) {
            return;
        }
        this._cloudCommitOpen = true;
        queueMicrotask(() => {
            this._cloudCommitOpen = false;
        });
    }

    private _currentCloudCommitId(): number {
        if (!this._cloudCommitOpen) {
            this._cloudCommitSerial += 1;
            this._openCloudCommitWindow();
        }
        return this._cloudCommitSerial;
    }

    /**
     * A packet another window of this font made, relayed by main to the
     * room. Burst packets and quick series are held and merged exactly like
     * this window's own.
     */
    relayPeerPacketToCloud(
        update: Uint8Array,
        collaborationMessage: CollaborationMessageEnvelope | null | undefined,
        documentId: string | undefined,
        burstKey: string | null | undefined,
        dependsOn?: string[]
    ): void {
        const relayedRevision = collaborationMessage?.glyphRevision;
        const relayedGlyphId = documentId
            ? glyphIdFromDocumentId(documentId)
            : null;
        if (relayedGlyphId && typeof relayedRevision === 'string') {
            // The linked window's edit is in this window's glyph now, with
            // its stamp; record it as the glyph's current revision.
            this.applyGlyphRevisionFeed(
                [{ glyphId: relayedGlyphId, revision: relayedRevision }],
                { hold: false, own: true }
            );
        }
        this._noteOwnGlyphRevision(relayedRevision);
        const relay = (
            relayUpdate: Uint8Array,
            envelope: CollaborationMessageEnvelope | null | undefined,
            relayDocumentId: string | undefined
        ): void => {
            window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                relayUpdate,
                envelope ?? null,
                relayDocumentId,
                // Only the packet this call relays carries them; a merged
                // burst gets new ids and is not held.
                relayUpdate === update ? dependsOn : undefined
            );
        };
        const key = burstKey || null;
        if (key) {
            this._editBursts.tick(key, {
                shareHistory: false,
                origin: 'remote',
                historyItemId: collaborationMessage?.metadata?.historyItemId
            });
        }
        if (
            !collaborationMessage ||
            window.fontManager?.currentFont?.isCloudBacked?.() !== true
        ) {
            relay(update, collaborationMessage, documentId);
            return;
        }
        recordCollabTrace('relay-in', [], {
            document: documentId,
            burstKey: key
        });
        const decision = this._cloudHold.submit(
            {
                kind: 'relay',
                burstKey: key,
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                update,
                envelope: collaborationMessage,
                entries: []
            },
            this._currentCloudCommitId()
        );
        recordCollabTrace('relay-hold', [], {
            document: documentId,
            decision
        });
        if (decision === 'passthrough') {
            // Behind a held run of this document still taking its place.
            this._deliverToCloudInOrder(
                documentId || FONT_CORE_DOCUMENT_ID,
                () => relay(update, collaborationMessage, documentId)
            );
        }
        // A held packet was staged in the device outbox by `onHeld`.
    }

    /** Send everything held back to the room now (save, close, undo). */
    async flushPendingCloudSends(): Promise<void> {
        await this._editBursts.finalizeAll();
        this._cloudHold.flushAll();
        await this.waitForPendingCloudCommits();
    }

    /** True while a burst's cloud send is still held. */
    get hasHeldCloudSends(): boolean {
        return this._cloudHold.hasPending();
    }

    /**
     * Held packets already in the device outbox, per run: one row per run
     * of one document's packets of one kind (see `_heldRunKey`), rewritten
     * with the merged run so far. A tab that closes (or crashes) mid-burst
     * leaves it there, and the next open sends it like any unsent edit.
     */
    private _stagedHeld = new Map<
        string,
        {
            documentId: string;
            update: Uint8Array;
            envelope: CollaborationMessageEnvelope;
            stagedId: string | null;
            written: Promise<unknown>;
        }
    >();

    /**
     * One envelope for held packets of a document. An envelope no lossless
     * step fits (EnvelopeTooLargeError) is never dropped or cut down: the
     * document is marked broken and the error is thrown.
     */
    private _mergeHeldEnvelopes(
        envelopes: CollaborationMessageEnvelope[],
        documentId: string,
        isBurst: boolean
    ): CollaborationMessageEnvelope {
        try {
            return mergeBurstEnvelopes(envelopes, documentId, isBurst);
        } catch (error) {
            if (error instanceof EnvelopeTooLargeError) {
                this.markDocumentBroken(documentId, error);
            }
            throw error;
        }
    }

    /**
     * The last run of held packets of each document since the last flush.
     * A run is a stretch of one document's held packets of one kind (this
     * window's own, or relayed from a linked window) that no packet of the
     * other kind interrupts. Runs keep one document's packets in arrival
     * order across kinds: a main-window edit made on top of a linked
     * window's held tick must never reach the room before that tick.
     */
    private _heldRunCursor = new Map<
        string,
        { kind: HeldCloudPacket['kind']; index: number }
    >();
    /** Device outbox writes of held packets, chained per document. */
    private _heldStageChains = new Map<string, Promise<unknown>>();

    /** The run key a held packet joins, advancing the document's cursor. */
    private _heldRunKey(
        cursor: Map<string, { kind: HeldCloudPacket['kind']; index: number }>,
        packet: HeldCloudPacket
    ): string {
        const last = cursor.get(packet.documentId);
        const index =
            last && last.kind === packet.kind
                ? last.index
                : last
                  ? last.index + 1
                  : 0;
        cursor.set(packet.documentId, { kind: packet.kind, index });
        return `${packet.kind}\u0000${packet.documentId}\u0000${index}`;
    }

    private _stageHeldCloudPacket(packet: HeldCloudPacket): void {
        // Every held packet advances the cursor, staged or not, so the runs
        // match the ones the flush finds.
        const groupKey = this._heldRunKey(this._heldRunCursor, packet);
        const plugin = window.cloudPlugin;
        if (
            !packet.envelope ||
            typeof plugin?.stageHeldCloudUpdate !== 'function'
        ) {
            return;
        }
        const previous = this._stagedHeld.get(groupKey);
        const update = previous
            ? Y.mergeUpdates([previous.update, packet.update])
            : packet.update;
        const envelope = previous
            ? this._mergeHeldEnvelopes(
                  [previous.envelope, packet.envelope],
                  packet.documentId,
                  true
              )
            : packet.envelope;
        const stagedId = collaborationMessageKey(envelope);
        const replaced =
            previous?.stagedId && previous.stagedId !== stagedId
                ? previous.stagedId
                : null;
        // One chain per document, across kinds: the rows land (and get
        // their creation time) in arrival order.
        const chained =
            this._heldStageChains.get(packet.documentId) ??
            previous?.written ??
            Promise.resolve();
        const written = chained
            .then(() =>
                plugin.stageHeldCloudUpdate?.(
                    update,
                    envelope,
                    packet.documentId,
                    replaced
                )
            )
            .catch((error: unknown) => {
                // Storage trouble keeps the row in memory and is only
                // reported; any other failure means the held edit can't be
                // kept, so the document stops rather than losing it.
                if (error instanceof CloudWalPersistError) {
                    console.warn(
                        'Could not keep a held edit on this device',
                        error
                    );
                    return;
                }
                this.markDocumentBroken(
                    packet.documentId,
                    error instanceof Error ? error : new Error(String(error))
                );
            });
        this._stagedHeld.set(groupKey, {
            documentId: packet.documentId,
            update,
            envelope,
            stagedId,
            written
        });
        this._heldStageChains.set(packet.documentId, written);
        void written.then(() => {
            if (this._heldStageChains.get(packet.documentId) === written) {
                this._heldStageChains.delete(packet.documentId);
            }
        });
    }

    /**
     * The staged row of a held group being flushed: `written` settles once
     * its outbox writes are done; `release` drops the row after the merged
     * row is written, unless the merged row replaced it (same id).
     */
    private _takeStagedHeldGroup(
        groupKey: string,
        finalEnvelope: CollaborationMessageEnvelope | null
    ): { written: Promise<unknown>; release: () => void } {
        const staged = this._stagedHeld.get(groupKey);
        this._stagedHeld.delete(groupKey);
        if (!staged) {
            return { written: Promise.resolve(), release: () => {} };
        }
        const finalId = finalEnvelope
            ? collaborationMessageKey(finalEnvelope)
            : null;
        return {
            written: staged.written,
            release: () => {
                if (staged.stagedId && staged.stagedId !== finalId) {
                    void Promise.resolve(
                        window.cloudPlugin?.dropStagedCloudUpdate?.(
                            staged.documentId,
                            staged.stagedId
                        )
                    ).catch(() => {});
                }
            }
        };
    }

    private _flushHeldCloudPackets(packets: HeldCloudPacket[]): void {
        // Staging starts over with the next held packet.
        this._heldRunCursor.clear();
        // Runs, not kinds: one document's relayed and own packets keep
        // their arrival order (see `_heldRunCursor`).
        const cursor = new Map<
            string,
            { kind: HeldCloudPacket['kind']; index: number }
        >();
        const groups = new Map<string, HeldCloudPacket[]>();
        for (const packet of packets) {
            const groupKey = this._heldRunKey(cursor, packet);
            const group = groups.get(groupKey);
            if (group) {
                group.push(packet);
            } else {
                groups.set(groupKey, [packet]);
            }
        }
        // Glyph rows first: the core revision row depends on them. The sort
        // is stable, so each document's runs stay in arrival order.
        const ordered = [...groups.entries()].sort(
            ([, left], [, right]) =>
                Number(!left[0].documentId.startsWith('glyph:')) -
                Number(!right[0].documentId.startsWith('glyph:'))
        );
        const dependsOn: string[] = [];
        for (const [groupKey, group] of ordered) {
            const documentId = group[0].documentId;
            const update =
                group.length === 1
                    ? group[0].update
                    : Y.mergeUpdates(group.map((packet) => packet.update));
            const envelopes = group
                .map((packet) => packet.envelope)
                .filter(
                    (envelope): envelope is CollaborationMessageEnvelope =>
                        !!envelope
                );
            const envelope =
                envelopes.length > 1
                    ? this._mergeHeldEnvelopes(
                          envelopes,
                          documentId,
                          group.every((packet) => packet.burstKey)
                      )
                    : (envelopes[0] ?? null);
            const staged = this._takeStagedHeldGroup(groupKey, envelope);
            if (group[0].kind === 'relay') {
                recordCollabTrace('relay-flush', [], {
                    document: documentId,
                    packets: group.length
                });
                // The relay takes its queue place once its staged row is
                // written; the document's later packets wait for that. The
                // staged row is dropped only once the relayed row is durable
                // on this device; otherwise it stays and is sent again.
                this._deliverToCloudInOrder(
                    documentId,
                    () => {
                        this._releaseStagedAfterRelay(
                            window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                                update,
                                envelope,
                                documentId
                            ),
                            staged,
                            documentId
                        );
                    },
                    staged.written
                );
                continue;
            }
            const entries = group.flatMap((packet) => packet.entries);
            this._persistAndDeliverToCloud(
                update,
                envelope,
                documentId,
                entries,
                documentId.startsWith('glyph:') ? undefined : [...dependsOn],
                staged
            );
            if (envelope && documentId.startsWith('glyph:')) {
                dependsOn.push(collaborationMessageKey(envelope));
            }
        }
    }

    /**
     * Drop a held run's staged row once its relayed row is durable. A relay
     * that settles false (or no relay at all) keeps the staged row, so the
     * edit is still on this device and goes out again on the next open.
     */
    private _releaseStagedAfterRelay(
        durable: Promise<boolean> | boolean | undefined,
        staged: { release: () => void },
        documentId: string
    ): void {
        void Promise.resolve(durable).then(
            (ok) => {
                if (ok === true) {
                    staged.release();
                    return;
                }
                recordCollabTrace('relay-staged-kept', [], {
                    document: documentId,
                    reason: ok === false ? 'not-durable' : 'no-relay'
                });
            },
            (error: unknown) => {
                recordCollabTrace('relay-staged-kept', [], {
                    document: documentId,
                    reason: 'relay-rejected',
                    error:
                        error instanceof Error ? error.message : String(error)
                });
            }
        );
    }

    /**
     * Deliver one of `documentId`'s cloud packets in order: now when nothing
     * of that document waits, otherwise behind what waits. `waitFor` holds
     * this delivery (and everything of the document behind it) until it
     * settles.
     */
    private _deliverToCloudInOrder(
        documentId: string,
        deliver: () => void,
        waitFor?: Promise<unknown>
    ): void {
        const gate = this._cloudDeliveryGates.get(documentId);
        if (!gate && !waitFor) {
            deliver();
            return;
        }
        const next: Promise<void> = (gate ?? Promise.resolve())
            .then(() => waitFor)
            .then(() => deliver())
            .catch((error: unknown) => {
                console.error(
                    `Cloud delivery of a held packet of ${documentId} failed:`,
                    error
                );
            })
            .then(() => {
                if (this._cloudDeliveryGates.get(documentId) === next) {
                    this._cloudDeliveryGates.delete(documentId);
                }
            });
        this._cloudDeliveryGates.set(documentId, next);
    }

    /** Hand the packet to the cloud listeners and queue its outbox row. */
    private _persistAndDeliverToCloud(
        update: YjsUpdate,
        envelope: CollaborationMessageEnvelope | null,
        documentId: string,
        entries: ChangeLogEntry[],
        dependsOn?: string[],
        staged?: { written: Promise<unknown>; release: () => void }
    ): void {
        const plugin = window.cloudPlugin;
        const meta: LocalUpdateMeta = { burstKey: null };
        // Taken now: a bridge replaced before the outbox write finishes has
        // already dropped its listeners, and the packet must still go out.
        const cloudListeners = [...this._cloudLocalListeners];
        const deliverToCloud = (): void => {
            // Revision rows travel the same way: the core socket takes them
            // from this hook, as it does every other core packet.
            for (const cb of cloudListeners) {
                cb(update, envelope, entries, documentId, meta);
            }
        };
        if (typeof plugin?.persistOutgoingCloudUpdate !== 'function') {
            deliverToCloud();
            return;
        }
        // The burst's outbox row is written first, so the merged row is the
        // one that stays. The cloud listeners get the packet now, in order;
        // the adapter holds it until its row exists. A relayed run of this
        // document ahead of it takes its place (and starts its row) first.
        const gate = this._cloudDeliveryGates.get(documentId);
        this._persistOutgoingInOrder(
            () =>
                plugin.persistOutgoingCloudUpdate(
                    update,
                    envelope,
                    documentId,
                    dependsOn
                ),
            update,
            documentId,
            true,
            gate ? Promise.all([gate, staged?.written]) : staged?.written,
            () => staged?.release()
        );
        this._deliverToCloudInOrder(documentId, deliverToCloud);
    }

    /**
     * Wait until cloud WAL-before-apply commits queued by this engine have
     * finished applying to Yjs. UI edits return before that async path.
     */
    async waitForPendingCloudCommits(): Promise<void> {
        await this._cloudWalCommitChain;
        await Promise.all([...this._cloudDeliveryGates.values()]);
        await this._cloudEmitPersistChain;
    }

    /** Register a callback for committed local and remote changes. */
    onCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.add(cb);
    }

    /**
     * Register a callback that runs synchronously before the engine
     * replaces model glyph or drawing data with the documents' state (a
     * remote update, catch-up, checkpoint, snapshot, rebaseline, hydrate,
     * unload, or a read-back after a refused or empty commit). An editor
     * commits an edit it still holds here, so the replacement does not
     * leave it on a detached object. It does not run inside a commit or a
     * remote apply, where a commit cannot be made; the rebuilt event still
     * fires. A listener that throws stops the replacement. Returns the
     * unsubscribe function.
     */
    onBeforeGlyphModelRebuild(
        listener: BeforeGlyphModelRebuildListener
    ): () => void {
        this._beforeGlyphModelRebuildListeners.add(listener);
        return () => {
            this._beforeGlyphModelRebuildListeners.delete(listener);
        };
    }

    /**
     * Register a callback for model glyph or drawing data the engine
     * replaced with the documents' state. An editor re-resolves the
     * drawings it holds. Returns the unsubscribe function.
     */
    onGlyphModelRebuilt(listener: GlyphModelRebuiltListener): () => void {
        this._glyphModelRebuiltListeners.add(listener);
        return () => {
            this._glyphModelRebuiltListeners.delete(listener);
        };
    }

    /**
     * Register a callback for an undo or redo that was refused before any
     * write, or failed and was rolled back. Linked windows learn of it
     * through this. Returns the unsubscribe function.
     */
    onHistoryReplayProblem(listener: HistoryReplayProblemListener): () => void {
        this._historyReplayProblemListeners.add(listener);
        return () => {
            this._historyReplayProblemListeners.delete(listener);
        };
    }

    private _announceHistoryReplayProblem(problem: HistoryReplayProblem): void {
        const { kind, ...detail } = problem;
        window.dispatchEvent(
            new CustomEvent(
                kind === 'blocked'
                    ? 'history-replay-blocked'
                    : 'history-replay-failed',
                { detail }
            )
        );
        for (const listener of [...this._historyReplayProblemListeners]) {
            try {
                listener(problem);
            } catch (error) {
                console.error(
                    'A history replay problem listener failed',
                    error
                );
            }
        }
    }

    /**
     * Run `replace`, which overwrites model glyph or drawing data with the
     * documents' state, inside a rebuild scope. The outermost reported
     * scope runs the before-rebuild listeners first (when a commit can be
     * made) and reports every glyph it replaced once it ends. A silent
     * scope (a commit reading back what it just wrote) reports nothing.
     */
    private _withGlyphModelRebuild<T>(
        cause: GlyphModelRebuildCause,
        glyphsHint: string[] | null,
        replace: () => T,
        options?: { silent?: boolean; runBeforeListeners?: boolean }
    ): T {
        const silent = options?.silent === true;
        const outer = this._glyphModelRebuildScopes.length === 0;
        if (
            outer &&
            !silent &&
            options?.runBeforeListeners !== false &&
            (glyphsHint === null || glyphsHint.length > 0)
        ) {
            this._runBeforeGlyphModelRebuild({
                glyphs: glyphsHint ? [...new Set(glyphsHint)] : null,
                cause
            });
        }
        const scope: GlyphModelRebuildScope = {
            cause,
            silent,
            glyphs: new Set(),
            all: false
        };
        this._glyphModelRebuildScopes.push(scope);
        let result: T;
        try {
            result = replace();
        } catch (error) {
            this._glyphModelRebuildScopes.pop();
            // Still report what was replaced before it failed, but never
            // let a listener's error take the place of this one.
            try {
                this._closeGlyphModelRebuildScope(scope);
            } catch (listenerError) {
                console.error(
                    'A model rebuild listener failed after a failed rebuild',
                    listenerError
                );
            }
            throw error;
        }
        this._glyphModelRebuildScopes.pop();
        this._closeGlyphModelRebuildScope(scope);
        return result;
    }

    private _runBeforeGlyphModelRebuild(event: GlyphModelRebuildEvent): void {
        if (
            !this._beforeGlyphModelRebuildListeners.size ||
            this._runningBeforeGlyphModelRebuild ||
            this._isApplyingRemote ||
            this._txDepth > 0 ||
            this._commitDepth > 0 ||
            this._suppressRecording ||
            this._isSyncing
        ) {
            return;
        }
        this._runningBeforeGlyphModelRebuild = true;
        try {
            for (const listener of [
                ...this._beforeGlyphModelRebuildListeners
            ]) {
                listener(event);
            }
        } finally {
            this._runningBeforeGlyphModelRebuild = false;
        }
    }

    /** Hand a finished scope's glyphs to its parent, or report them. */
    private _closeGlyphModelRebuildScope(scope: GlyphModelRebuildScope): void {
        if (scope.silent || (!scope.all && !scope.glyphs.size)) {
            return;
        }
        const parent =
            this._glyphModelRebuildScopes[
                this._glyphModelRebuildScopes.length - 1
            ];
        if (parent) {
            if (!parent.silent) {
                parent.all ||= scope.all;
                for (const glyphName of scope.glyphs) {
                    parent.glyphs.add(glyphName);
                }
            }
            return;
        }
        this._reportGlyphModelRebuilt({
            glyphs: scope.all ? null : [...scope.glyphs],
            cause: scope.cause
        });
    }

    /**
     * Note model data replaced from the documents: `null` for every glyph.
     * Outside any scope it is reported at once as a read-back.
     */
    private _noteGlyphModelRebuilt(glyphNames: string[] | null): void {
        const scope =
            this._glyphModelRebuildScopes[
                this._glyphModelRebuildScopes.length - 1
            ];
        if (!scope) {
            if (glyphNames === null || glyphNames.length) {
                this._reportGlyphModelRebuilt({
                    glyphs: glyphNames ? [...new Set(glyphNames)] : null,
                    cause: 'read-back'
                });
            }
            return;
        }
        if (scope.silent) {
            return;
        }
        if (glyphNames === null) {
            scope.all = true;
            return;
        }
        for (const glyphName of glyphNames) {
            scope.glyphs.add(glyphName);
        }
    }

    private _reportGlyphModelRebuilt(event: GlyphModelRebuildEvent): void {
        recordCollabTrace('model-glyph-rebuilt', event.glyphs ?? [], {
            glyphs: event.glyphs ?? 'all',
            cause: event.cause
        });
        const errors: unknown[] = [];
        for (const listener of [...this._glyphModelRebuiltListeners]) {
            try {
                listener(event);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) {
            for (const error of errors.slice(1)) {
                console.error('A model rebuild listener failed', error);
            }
            throw errors[0];
        }
    }

    /** Glyph names a remote packet or catch-up for `documentId` may replace. */
    private _glyphNamesForRebuildHint(
        documentId: string | undefined,
        entries: ChangeLogEntry[] | undefined
    ): string[] | null {
        const names = new Set<string>();
        const glyphId = documentId ? glyphIdFromDocumentId(documentId) : null;
        if (glyphId) {
            const name = this._glyphNameById.get(glyphId);
            if (name) {
                names.add(name);
            }
        }
        for (const entry of entries ?? []) {
            // A rename or a new glyph order re-reads every glyph
            // (_reconcileGlyphDocsAfterRemoteEntries), not only the named.
            if (
                normalizeGlyphRenames(entry.glyphRenames).length ||
                getPathSegments(String(entry.path || ''))[0] === 'glyphOrder'
            ) {
                return null;
            }
            const name = this._deriveGlyphNameFromPath(entry.path || '');
            if (name) {
                names.add(name);
            }
            for (const target of entry.workerReplayTargets ?? []) {
                names.add(target.glyphName);
            }
        }
        // Font-core may rename or reorder any glyph; a glyph document named
        // nothing yet may become any name.
        if (!names.size) {
            return null;
        }
        return [...names];
    }

    /**
     * Register a callback for glyph and layout documents that become loaded
     * here (created from a complete state, a snapshot, a hydrate or a
     * residency change). It runs once the operation that created the
     * document has finished filling it. Returns the unsubscribe function.
     */
    onDocumentLoaded(listener: DocumentLoadedListener): () => void {
        this._documentLoadedListeners.add(listener);
        return () => {
            this._documentLoadedListeners.delete(listener);
        };
    }

    /**
     * Record that `documentId` is now held here. Listeners and the
     * linked-window relay hear of it after the current operation, so held
     * deltas never apply into a document that is still being filled, nor
     * re-enter an apply.
     */
    private _noteDocumentLoaded(documentId: string): void {
        this._documentsLoadedPendingNotice.add(documentId);
        if (this._documentLoadedNoticeScheduled) {
            return;
        }
        this._documentLoadedNoticeScheduled = true;
        queueMicrotask(() => this._announceLoadedDocuments());
    }

    private _announceLoadedDocuments(): void {
        this._documentLoadedNoticeScheduled = false;
        const documentIds = [...this._documentsLoadedPendingNotice].filter(
            (documentId) => this._docForId(documentId) !== null
        );
        this._documentsLoadedPendingNotice.clear();
        if (this._destroyed || !documentIds.length) {
            return;
        }
        const errors: unknown[] = [];
        for (const documentId of documentIds) {
            for (const listener of [...this._documentLoadedListeners]) {
                try {
                    listener(documentId);
                } catch (error) {
                    errors.push(error);
                }
            }
        }
        try {
            window.windowSync?.drainDeltasHeldUntilLoaded?.();
        } catch (error) {
            errors.push(error);
        }
        if (errors.length) {
            for (const error of errors.slice(1)) {
                console.error(
                    'A listener failed after a document was loaded',
                    error
                );
            }
            throw errors[0];
        }
    }

    /** Unregister a callback previously passed to onCommittedChange. */
    offCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.delete(cb);
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
            try {
                this._runAfterSyncRebuild('deferred-after-sync');
            } catch (error) {
                // A before-listener could not write the editor's pending
                // edit, so the model was not rebuilt over it. It stays due
                // (the next deferred run does it); this runs in a catch-up's
                // `finally`, where a throw would hide the catch-up's result.
                this._afterSyncSkipped = true;
                recordCollabTrace('model-rebuild-deferred-kept', [], {
                    cause: 'deferred-after-sync',
                    error:
                        error instanceof Error ? error.message : String(error)
                });
                console.error(
                    'The font model was not rebuilt after a catch-up: a pending edit could not be written first',
                    error
                );
            }
        }
    }

    /**
     * Run the after-sync hook, which rebuilds the whole font model from the
     * patched font data, as a model rebuild of every glyph. A deferred one
     * runs after an async catch-up or hydrate (a reconnect), when the editor
     * may hold an edit made while it ran: the before-listeners let it write
     * that edit first, and the rebuild is reported and traced.
     */
    private _runAfterSyncRebuild(cause: GlyphModelRebuildCause): void {
        if (!this._onAfterSync) {
            return;
        }
        this._withGlyphModelRebuild(cause, null, () => {
            this._onAfterSync?.();
            this._noteGlyphModelRebuilt(null);
        });
    }

    runWithDeferredAfterSync<T>(fn: () => T): T {
        this.beginDeferredAfterSync();
        try {
            return fn();
        } finally {
            this.endDeferredAfterSync();
        }
    }

    private _remoteAfterSyncBatch: { pending: boolean } | null = null;

    /**
     * Apply several remote updates in one synchronous batch (a linked-window
     * BroadcastChannel flush) with one after-sync model rebuild at the end.
     * Unlike `runWithDeferredAfterSync`, this never spans an await, so it
     * cannot hold back a cloud packet that lands during an async catch-up.
     */
    runWithBatchedRemoteAfterSync(fn: () => void): void {
        if (this._remoteAfterSyncBatch) {
            fn();
            return;
        }
        const batch = { pending: false };
        this._remoteAfterSyncBatch = batch;
        // A linked window's commit arrives here as one packet per document;
        // main projects the catalog and font-deps for it once, not per packet.
        this._catalogDeferDepth += 1;
        try {
            fn();
        } finally {
            this._releaseCatalogDefer();
            this._remoteAfterSyncBatch = null;
            if (batch.pending) {
                this._runAfterSyncRebuild('remote-update');
            }
        }
    }

    /** End one catalog-defer window; the last one writes what was queued. */
    private _releaseCatalogDefer(): void {
        this._catalogDeferDepth = Math.max(0, this._catalogDeferDepth - 1);
        if (this._catalogDeferDepth !== 0) {
            return;
        }
        const owners = [...this._deferredCatalogOwners];
        this._deferredCatalogOwners.clear();
        for (const owner of owners) {
            owner.flushDeferredCatalogProjection?.();
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

    /** Attach a value the feature-generator finalizer can read for this transaction. */
    setTransactionIntent(key: string, value: unknown): void {
        if (this._txDepth > 0) {
            this._txIntents[key] = value;
        }
    }

    /** Clean up resources. */
    destroy(): void {
        this._cloudHold.flushAll();
        this._cloudHold.destroy();
        this._editBursts.destroy();
        this._unbindBurstFinalize?.();
        this._unbindBurstFinalize = null;
        if (this._pageHideHandler && typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this._pageHideHandler);
            this._pageHideHandler = null;
        }
        this._cloudLocalListeners.clear();
        this._liveBurstDrawings.clear();
        for (const unsub of this._docUpdateUnsubById.values()) {
            unsub();
        }
        this._docUpdateUnsubById.clear();
        this._destroyGlyphDocs();
        this._destroyLayoutDocs();
        this.dropRetiredLayoutDocs();
        this.depsDoc.destroy();
        this.yDoc.destroy();
        clearBrokenDocumentScope(this._brokenScope);
        // A destroyed font is no longer read-only: listeners hear it end, so
        // a later read-only period (another font, a reload) is shown again.
        // Teardown goes on even if a listener throws.
        for (const error of this._changeReadOnlyReason(null)) {
            console.error(
                'A listener failed when a destroyed font stopped being read-only',
                error
            );
        }
        this._readOnlyChangedListeners.clear();
        this._stateLoadedDocumentIds.clear();
        this._glyphCatchUpsInFlight.clear();
        this._glyphCatchUpsPending.clear();
        this._fontJson = null;
        this._changeLog = [];
        this._collaborationLog = [];
        this._onRemoteChange = null;
        this._localUpdateListeners.clear();
        this._committedChangeListeners.clear();
        this._beforeGlyphModelRebuildListeners.clear();
        this._glyphModelRebuiltListeners.clear();
        this._historyReplayProblemListeners.clear();
        this._destroyed = true;
        this._documentLoadedListeners.clear();
        this._documentsLoadedPendingNotice.clear();
        this._glyphRevisionFeedListeners.clear();
        this._glyphRevisionFeed.clear();
        this._glyphRevisionFeedArrival.clear();
        this._glyphRevisionsAwaitingFetch.clear();
        this._lateGlyphRevisionsAwaitingFetch.clear();
        this._clearHeldGlyphRevisions();
        this._coreHydratedListeners.clear();
        this._clearSparseWorkingSet();
        this._onDirty = null;
        this._onAfterSync = null;
        this._changeLogListeners.clear();
        this._collaborationLogListeners.clear();
        this._transactionFinalizer = null;
        this._txStartTimeMs = null;
        this._outbox.clear();
        this._layoutCoreOutbox = null;
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
        this._assertSparseWriteClosureResident(path);

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
     * Record an add operation (new glyph, drawing, shape, etc.).
     * Glyph-root adds also sync `glyphOrder` from the model array when the
     * glyph is already spliced there (addGlyph / duplicate / paste), so
     * `_syncAllGlyphsFromYDoc` does not append the new name at the end.
     */
    recordAdd(path: (string | number)[], value: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;
        assertCloudAssetMutable();
        this._assertSparseWriteClosureResident(path);

        const isObjectValue =
            !!value && typeof value === 'object' && !Array.isArray(value);
        const isDrawingRoot =
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
                        : isObjectValue && isDrawingRoot
                          ? 'drawing-snapshot'
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
        this._assertSparseWriteClosureResident(path);

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
            newValue: nextOrder,
            glyphRenames: prepared.map(({ oldName, newName }) => ({
                oldName,
                newName
            }))
        });
        this._queueOrCommitOperations(operations, label);
    }

    applySyntheticChangeSet(
        label: string,
        operations: SyntheticChangeOperation[],
        options?: {
            ignoreRecordingSuppression?: boolean;
            compileChangeSource?: string | null;
            compileEditType?: string | null;
        }
    ): void {
        if (!operations.length || !this._fontJson || this._isSyncing) {
            return;
        }
        if (this._suppressRecording && !options?.ignoreRecordingSuppression) {
            return;
        }
        const stamped = assertCompileStamp(
            options?.compileChangeSource ??
                operations.find((operation) => operation.compileChangeSource)
                    ?.compileChangeSource,
            options?.compileEditType !== undefined
                ? options.compileEditType
                : operations.find(
                      (operation) => operation.compileEditType !== undefined
                  )?.compileEditType
        );
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
                const isDrawingRoot =
                    operation.path.length === 4 &&
                    operation.path[0] === 'glyphs' &&
                    operation.path[2] === 'layers';

                return {
                    op: operation.op,
                    path: operation.path,
                    oldValue: cloneHistoryValue(operation.oldValue),
                    newValue: cloneHistoryValue(operation.newValue),
                    editSource: operation.editSource ?? null,
                    compileChangeSource:
                        operation.compileChangeSource ??
                        stamped.compileChangeSource,
                    compileEditType:
                        operation.compileEditType !== undefined
                            ? operation.compileEditType
                            : stamped.compileEditType,
                    visualAnchorSide: operation.visualAnchorSide ?? null,
                    workerReplayTargets: normalizeWorkerReplayTargets(
                        operation.workerReplayTargets
                    ),
                    applyMode:
                        isObjectValue && isGlyphRoot
                            ? ('glyph-snapshot' as BatchApplyMode)
                            : isObjectValue && isDrawingRoot
                              ? ('drawing-snapshot' as BatchApplyMode)
                              : 'default'
                };
            }),
            label,
            false,
            false
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
            !this._canApplyExternalReload() ||
            !stateVectorsEqual(
                expectedStateVector,
                Y.encodeStateVector(this.yDoc)
            )
        ) {
            return { status: 'stale', commit: null };
        }

        return this._commitExternalReload(
            this._captureYDocFontJson(),
            fontSnapshot,
            this._fontJson
        );
    }

    /**
     * Commit glyphs re-read from their own files in a folder source, like
     * applyExternalSourceReload for those glyphs alone: no whole-font capture
     * or diff. Every glyph must already exist in the font; the caller reads
     * the files before calling, so no state vector check is needed.
     */
    applyExternalGlyphReload(
        glyphSnapshots: Array<Record<string, unknown>>
    ): ExternalSourceReloadResult {
        if (!this._canApplyExternalReload()) {
            return { status: 'stale', commit: null };
        }
        const liveGlyphs = (this._fontJson?.glyphs || []) as Array<
            Record<string, unknown>
        >;
        const previousGlyphs: Unsafe[] = [];
        const liveGlyphsByName: Array<Record<string, unknown>> = [];
        for (const glyph of glyphSnapshots) {
            const name = String(glyph.name || '');
            const previous = this._readNormalizedGlyphSnapshotFromYDoc(name);
            const live = liveGlyphs.find(
                (candidate) => candidate.name === name
            );
            if (!previous || !live) {
                return { status: 'stale', commit: null };
            }
            previousGlyphs.push(previous);
            liveGlyphsByName.push(live);
        }
        return this._commitExternalReload(
            { glyphs: previousGlyphs },
            { glyphs: glyphSnapshots },
            { glyphs: liveGlyphsByName }
        );
    }

    private _canApplyExternalReload(): boolean {
        return (
            !!this._fontJson &&
            !this._suppressRecording &&
            !this._isSyncing &&
            !this._isApplyingRemote &&
            this._txDepth === 0
        );
    }

    /** Diff a reloaded snapshot against the live one and commit the difference. */
    private _commitExternalReload(
        liveYDocSnapshot: unknown,
        fontSnapshot: unknown,
        liveJsonSnapshot: unknown
    ): ExternalSourceReloadResult {
        const previousSnapshot =
            this._normalizeExternalSourceReloadSnapshot(liveYDocSnapshot);
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
        this._adoptIndexedFontDrawingIds(
            normalizedPreviousSnapshot,
            nextSnapshot
        );
        this._stampLiveShapeIdsOnReloadSnapshots(
            liveJsonSnapshot,
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
            liveJsonSnapshot
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
                const isDrawingRoot =
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
                    compileChangeSource: EXTERNAL_SOURCE_RELOAD_SOURCE,
                    compileEditType: null,
                    applyMode:
                        isObjectValue && isGlyphRoot
                            ? ('glyph-snapshot' as BatchApplyMode)
                            : isObjectValue && isDrawingRoot
                              ? ('drawing-snapshot' as BatchApplyMode)
                              : 'default'
                };
            }),
            'Reload external source',
            true
        );

        if (commit) {
            this._withGlyphModelRebuild(
                'external-reload',
                normalizeWorkerReplayTargets(
                    commit.changeLogEntries.flatMap(
                        (entry) => entry.workerReplayTargets
                    )
                ).map((target) => target.glyphName),
                () => this._syncRemoteJsonFromYDoc(commit.changeLogEntries),
                { runBeforeListeners: false }
            );
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
            // Source converters leave out `smooth: false`; the live document
            // spells it out, and an unchanged node must compare equal.
            const shapeRecord = normalizedRecord as Record<string, unknown>;
            if (isShapeEntry && Array.isArray(shapeRecord.nodes)) {
                shapeRecord.nodes = shapeRecord.nodes.map((node: unknown) =>
                    node &&
                    typeof node === 'object' &&
                    !Array.isArray(node) &&
                    !('smooth' in node)
                        ? { ...node, smooth: false }
                        : node
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
            compileChangeSource?: string | null;
            compileEditType?: string | null;
        }
    ): void {
        this._txDepth++;
        if (this._txDepth === 1) {
            const stamp = assertCompileStamp(
                historyMetadata?.compileChangeSource,
                historyMetadata?.compileEditType
            );
            this._txLabel = label;
            this._txCompileChangeSource = stamp.compileChangeSource;
            this._txCompileEditType = stamp.compileEditType;
            this._txId = this._nextTxId++;
            this._txStartTimeMs = performance.now();
            this._txBurst =
                this._ambientBursts[this._ambientBursts.length - 1] ?? null;
            this._txHistoryItemId =
                historyMetadata?.historyItemId ??
                this._txBurst?.historyItemId ??
                this._createHistoryItemId();
            this._txPromptGroupId = historyMetadata?.promptGroupId ?? null;
            this._txHistorySummary = historyMetadata?.historySummary ?? null;
            this._txHistoryTarget = historyTarget ?? null;
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
            // A composition rebuild can carry a ccmp intent and no model
            // edits, when the shells are already empty. That intent still
            // has to reach the feature-generator finalizer.
            // A refused commit (a read-only font, a broken document) still
            // ends the transaction: its operations must not ride along with
            // the next one.
            try {
                if (
                    this._txBufferedOperations.length ||
                    Object.keys(this._txIntents).length
                ) {
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
            } catch (error) {
                this._resetOutermostTransactionState();
                // Nothing committed, so nothing runs "after the commit": a
                // callback kept here would run after the next, unrelated one.
                this._afterOutermostCommit = [];
                throw error;
            }
            this._resetOutermostTransactionState();
            const afterCommit = this._afterOutermostCommit;
            this._afterOutermostCommit = [];
            for (const callback of afterCommit) {
                callback();
            }
        }
        return commitResult;
    }

    private _resetOutermostTransactionState(): void {
        this._txBufferedOperations = [];
        this._txLabel = null;
        this._txCompileChangeSource = null;
        this._txCompileEditType = null;
        this._txId = null;
        this._txStartTimeMs = null;
        this._txHistoryItemId = null;
        this._txBurst = null;
        this._txPromptGroupId = null;
        this._txHistorySummary = null;
        this._txHistoryTarget = null;
        this._txIntents = {};
    }

    /**
     * Run `callback` once the outermost transaction has committed, or now
     * when no transaction is open.
     */
    runAfterOutermostCommit(callback: () => void): void {
        if (this._txDepth > 0) {
            this._afterOutermostCommit.push(callback);
            return;
        }
        callback();
    }

    /** Whether a transaction is currently open. */
    get inTransaction(): boolean {
        return this._txDepth > 0;
    }

    /** Catalog projection should queue until the current commit finishes emitting. */
    get deferCatalogProjection(): boolean {
        return this._catalogDeferDepth > 0;
    }

    /** Remember which plugin queued catalog work for this commit. */
    noteDeferredCatalogOwner(owner: {
        flushDeferredCatalogProjection?: () => void;
    }): void {
        this._deferredCatalogOwners.add(owner);
    }

    private _pushApplyKind(kind: ApplyKind): void {
        this._applyKindStack.push(this._applyKind);
        this._applyKind = kind;
    }

    private _popApplyKind(): void {
        this._applyKind = this._applyKindStack.pop() ?? ApplyKind.Local;
    }

    private _runWithApplyKind<T>(kind: ApplyKind, fn: () => T): T {
        this._pushApplyKind(kind);
        try {
            return fn();
        } finally {
            this._popApplyKind();
        }
    }

    /** Remote or catch-up apply — suppress outbound local broadcast semantics. */
    private get _isApplyingRemote(): boolean {
        return (
            this._applyKind === ApplyKind.Remote ||
            this._applyKind === ApplyKind.CatchUp
        );
    }

    /** Local and ManualEmit still record (or already recorded). */
    private get _suppressRecording(): boolean {
        return (
            this._applyKind !== ApplyKind.Local &&
            this._applyKind !== ApplyKind.ManualEmit
        );
    }

    /**
     * Local and Silent still allow automatic yDoc update emission.
     * Remote / CatchUp / UndoRedo / ManualEmit suppress it.
     */
    private get _suppressAutomaticLocalUpdateEmission(): boolean {
        return (
            this._applyKind !== ApplyKind.Local &&
            this._applyKind !== ApplyKind.Silent
        );
    }

    setRecordingSuppressed(suppressed: boolean): void {
        if (suppressed) {
            if (this._applyKind === ApplyKind.Local) {
                this._pushApplyKind(ApplyKind.Silent);
            }
            return;
        }
        while (this._applyKindStack.length > 0) {
            this._popApplyKind();
        }
        this._applyKind = ApplyKind.Local;
    }

    /**
     * Suppress model recording until the returned release function is called.
     * Each release is idempotent so overlapping lifecycle cleanup is safe.
     */
    beginRecordingSuppression(): () => void {
        this._pushApplyKind(ApplyKind.Silent);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this._popApplyKind();
        };
    }

    runWithoutRecording<T>(fn: () => T): T {
        return this._runWithApplyKind(ApplyKind.Silent, fn);
    }

    // ── Bulk sync (after drag / external mutation) ───────────────

    /**
     * Sync a glyph's current JSON data into the Y.Doc.
     *
     * Call this after operations that mutate `babelfontData` directly
     * (e.g. outline-editor drag) instead of going through model setters.
     * Updates the existing Y.Map in-place.
     */
    syncGlyphFromJson(
        glyphName: string,
        label: string,
        oldValue?: string,
        newValue?: string,
        drawingId?: string | null,
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
            drawingId,
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
     * Sync multiple changed drawings into Y.Doc in one transaction.
     * Each target stays on the drawing fast path so linked windows only
     * receive the minimum changed drawing snapshots.
     */
    syncDrawingsFromJson(
        drawingTargets: WorkerReplayTarget[],
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

        assertCompileStamp(compileChangeSource, compileEditType);
        assertCloudAssetMutable();

        const uniqueTargets = normalizeWorkerReplayTargets(drawingTargets);
        if (!uniqueTargets.length) {
            return;
        }

        if (uniqueTargets.length === 1) {
            const [target] = uniqueTargets;
            this._trySyncSingleDrawing(
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

        for (const { glyphName, layerId: drawingId } of uniqueTargets) {
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

            const drawingsMap = glyphMap.get('layers') as
                Y.Map<unknown> | undefined;
            if (!drawingsMap) {
                continue;
            }

            const glyphDrawings = (glyphJson.layers ?? []) as Array<
                Record<string, unknown>
            >;
            const drawingJson = glyphDrawings.find(
                (drawing: Record<string, unknown>) => drawing.id === drawingId
            );
            if (!drawingJson) {
                continue;
            }
            const yDrawingForHistory = drawingsMap.get(drawingId);
            const storageDrawingJson = this._prepareDrawingSnapshotForHistory(
                drawingId,
                drawingJson,
                yDrawingForHistory instanceof Y.Map
                    ? fromYDrawing(yDrawingForHistory)
                    : null,
                yDrawingForHistory instanceof Y.Map ? yDrawingForHistory : null
            );
            operations.push(
                ...this._buildDrawingSyncOperations(
                    glyphName,
                    drawingId,
                    drawingsMap,
                    storageDrawingJson,
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
            `Drawing sync committed for ${uniqueTargets
                .map((target) => `${target.glyphName}/${target.layerId}`)
                .join(', ')} (${label}) [batched fast path]`
        );
    }

    /**
     * Sync explicit changed-drawing snapshots into Y.Doc in one transaction.
     * Use this when the caller already has committed next-drawing JSON and the
     * bridge's shared `_fontJson` reference may alias mutable editor storage.
     */
    syncDrawingSnapshotsFromJson(
        drawingTargets: DrawingSnapshotSyncTarget[],
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
        assertCompileStamp(compileChangeSource, compileEditType);
        assertCloudAssetMutable();

        const uniqueTargets: DrawingSnapshotSyncTarget[] = [];
        const seenTargets = new Set<string>();
        for (const target of drawingTargets) {
            if (!target.glyphName || !target.layerId || !target.drawingJson) {
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
        const shardedFont = this._fontHasGlyphDocuments();
        for (const {
            glyphName,
            layerId: drawingId,
            drawingJson,
            authoritativeOptionalDrawingFields
        } of uniqueTargets) {
            const glyphMap = this._glyphMapForName(glyphName);
            if (!glyphMap) {
                if (shardedFont) {
                    // The edit would go nowhere: refuse it loudly before
                    // anything is recorded, instead of dropping it.
                    throw new Error(
                        `[PatchSyncEngine] Cannot save the edit “${label}” to ${glyphName}/${drawingId}: the glyph’s document is not loaded in this window`
                    );
                }
                continue;
            }

            const drawingsMap = glyphMap.get('layers') as
                Y.Map<unknown> | undefined;
            if (!drawingsMap) {
                if (shardedFont) {
                    throw new Error(
                        `[PatchSyncEngine] Cannot save the edit “${label}” to ${glyphName}/${drawingId}: the glyph’s document holds no drawings`
                    );
                }
                continue;
            }

            const yDrawingMap = drawingsMap.get(drawingId);
            const yDrawingJson = yDrawingMap ? fromYDrawing(yDrawingMap) : null;
            const storageDrawingJson = this._prepareDrawingSnapshotForHistory(
                drawingId,
                drawingJson,
                yDrawingJson,
                yDrawingMap instanceof Y.Map ? yDrawingMap : null
            );
            if (authoritativeOptionalDrawingFields !== undefined) {
                if (
                    yDrawingJson &&
                    typeof yDrawingJson === 'object' &&
                    !Array.isArray(yDrawingJson)
                ) {
                    const existingDrawing = yDrawingJson as Record<
                        string,
                        unknown
                    >;
                    const authoritativeFields = new Set(
                        authoritativeOptionalDrawingFields
                    );
                    for (const key of [
                        'anchors',
                        'guides',
                        'format_specific'
                    ] as OptionalDrawingField[]) {
                        if (authoritativeFields.has(key)) {
                            continue;
                        }
                        if (
                            Object.prototype.hasOwnProperty.call(
                                existingDrawing,
                                key
                            )
                        ) {
                            storageDrawingJson[key] = cloneHistoryValue(
                                existingDrawing[key]
                            );
                        } else {
                            delete storageDrawingJson[key];
                        }
                    }
                }
            }
            operations.push(
                ...this._buildDrawingSyncOperations(
                    glyphName,
                    drawingId,
                    drawingsMap,
                    storageDrawingJson,
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
            // Nothing to write: no packet goes to any room.
            this._notifyLocalDrawingSnapshotNoop(
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
        // Only reload drawings that this packet actually wrote into Yjs.
        // workerReplayTargets are intentionally wider (invalidate-only
        // dependents for compile/cache). Reloading those from Yjs would
        // clobber live-already-recomposed model state with stale document
        // data when those dependents were not part of the mutation set.
        if (!wasInTransaction && operations.length) {
            const writtenDrawingTargets = normalizeWorkerReplayTargets(
                operations.map((operation) => {
                    const applyPath = operation.applyPath ?? operation.path;
                    return {
                        glyphName: deriveGlyphName(applyPath) || '',
                        layerId: deriveDrawingId(applyPath) || ''
                    };
                })
            );
            if (writtenDrawingTargets.length) {
                // A commit that wrote nothing (reduced away, or refused)
                // puts the model back to the documents: reported. One that
                // wrote reads back its own write: silent.
                this._withGlyphModelRebuild(
                    'null-commit-read-back',
                    writtenDrawingTargets.map((target) => target.glyphName),
                    () =>
                        this._syncPatchedDrawingTargetsFromYDoc(
                            writtenDrawingTargets
                        ),
                    { silent: Boolean(commitResult), runBeforeListeners: false }
                );
            }
        }
        if (!wasInTransaction && !commitResult) {
            this._notifyLocalDrawingSnapshotNoop(
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
            `Drawing snapshot sync committed for ${uniqueTargets
                .map((target) => `${target.glyphName}/${target.layerId}`)
                .join(', ')} (${label}) [batched fast path]`
        );
    }

    /**
     * A drawing-snapshot sync that wrote nothing still refreshes compile
     * and caches for its replay targets, in this window only: committed-
     * change listeners and the compile worker hear of it, marked
     * `localOnly`, one notice per glyph document. No packet is made, so no
     * room, outbox or linked window sees it.
     */
    private _notifyLocalDrawingSnapshotNoop(
        uniqueTargets: DrawingSnapshotSyncTarget[],
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
        const entriesByDocument = new Map<string, ChangeLogEntry[]>();
        uniqueTargets.forEach((target, index) => {
            const documentId = this.documentIdForPath([
                'glyphs',
                target.glyphName
            ]);
            const list = entriesByDocument.get(documentId) ?? [];
            list.push(changeLogEntries[index]);
            entriesByDocument.set(documentId, list);
        });
        for (const [documentId, entries] of entriesByDocument) {
            this._yjsWorkerCallback?.(EMPTY_YJS_UPDATE, entries, documentId);
            for (const cb of this._committedChangeListeners) {
                cb(entries, {
                    origin: 'local',
                    update: EMPTY_YJS_UPDATE,
                    documentId,
                    localOnly: true
                });
            }
        }
    }

    /**
     * True when glyphs live in documents of their own (every current font),
     * so a glyph path never belongs in font-core.
     */
    private _fontHasGlyphDocuments(): boolean {
        return this._heldGlyphDocCount() > 0 || this._glyphIdByName.size > 0;
    }

    /** True for a path inside a glyph's drawings (`glyphs.<name>:layers…`). */
    private _isGlyphDrawingPath(path: string | null | undefined): boolean {
        if (!path) {
            return false;
        }
        const segments = this._getPathSegments(String(path));
        return segments[0] === 'glyphs' && segments[2] === 'layers';
    }

    private _buildDrawingSyncOperations(
        glyphName: string,
        drawingId: string,
        drawingsMap: Y.Map<unknown>,
        storageDrawingJson: Record<string, unknown>,
        label: string,
        oldValue: string | undefined,
        newValue: string | undefined,
        metadata: DrawingSyncMetadata
    ): TransactionBufferedOperation[] {
        const yDrawingMap = drawingsMap.get(drawingId);
        const yDrawingJson = yDrawingMap ? fromYDrawing(yDrawingMap) : null;
        if (!yDrawingJson) {
            return [
                {
                    op: 'set' as ChangeOp,
                    path: ['glyphs', glyphName, 'layers', drawingId],
                    oldValue: null,
                    newValue: cloneHistoryValue(storageDrawingJson),
                    editSource: metadata.editSource,
                    compileChangeSource: metadata.compileChangeSource,
                    compileEditType: metadata.compileEditType,
                    visualAnchorSide: metadata.visualAnchorSide,
                    workerReplayTargets: metadata.workerReplayTargets,
                    originatingGlyphName: glyphName,
                    originatingLayerId: drawingId,
                    applyPath: ['glyphs', glyphName, 'layers', drawingId],
                    applyNewValue: storageDrawingJson,
                    applyMode: 'drawing-snapshot' as BatchApplyMode
                }
            ];
        }

        const previousDrawing = yDrawingJson as Record<string, unknown>;
        if (
            !Object.prototype.hasOwnProperty.call(storageDrawingJson, 'name') &&
            Object.prototype.hasOwnProperty.call(previousDrawing, 'name')
        ) {
            storageDrawingJson.name = cloneHistoryValue(previousDrawing.name);
        }
        if (
            this._shouldUseGranularSingleDrawingSync(
                glyphName,
                drawingId,
                previousDrawing,
                storageDrawingJson
            )
        ) {
            this._adoptIndexedDrawingIds(previousDrawing, storageDrawingJson);
            return this._buildGranularDrawingSyncOperations(
                glyphName,
                drawingId,
                previousDrawing,
                storageDrawingJson,
                metadata
            );
        }

        const sparseDrawingDelta = this._buildSparseDrawingDelta(
            previousDrawing,
            storageDrawingJson,
            drawingId
        );
        if (!sparseDrawingDelta) {
            return [];
        }

        return [
            {
                op: 'set' as ChangeOp,
                path: ['glyphs', glyphName, 'layers', drawingId],
                oldValue: oldValue ?? glyphName,
                newValue: newValue ?? label,
                editSource: metadata.editSource,
                compileChangeSource: metadata.compileChangeSource,
                compileEditType: metadata.compileEditType,
                visualAnchorSide: metadata.visualAnchorSide,
                workerReplayTargets: metadata.workerReplayTargets,
                originatingGlyphName: glyphName,
                originatingLayerId: drawingId,
                applyPath: ['glyphs', glyphName, 'layers', drawingId],
                applyOldValue: sparseDrawingDelta.oldValues,
                applyNewValue: sparseDrawingDelta.delta,
                applyMode: 'drawing-snapshot' as BatchApplyMode
            }
        ];
    }

    private _buildGranularDrawingSyncOperations(
        glyphName: string,
        drawingId: string,
        previousDrawing: Record<string, unknown>,
        nextDrawing: Record<string, unknown>,
        metadata: DrawingSyncMetadata
    ): TransactionBufferedOperation[] {
        const basePath: (string | number)[] = [
            'glyphs',
            glyphName,
            'layers',
            drawingId
        ];
        return this._buildGranularValueSyncOperations(
            basePath,
            previousDrawing,
            nextDrawing,
            metadata
        );
    }

    private _buildGranularValueSyncOperations(
        path: (string | number)[],
        previousValue: unknown,
        nextValue: unknown,
        metadata: DrawingSyncMetadata
    ): TransactionBufferedOperation[] {
        if (this._isDeepEqual(previousValue, nextValue)) {
            return [];
        }

        const lastSegment = path[path.length - 1];
        if (
            typeof lastSegment === 'string' &&
            GRANULAR_DRAWING_ARRAY_KEYS.has(lastSegment) &&
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
                this._createGranularDrawingOperation(
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
                    this._createGranularDrawingOperation(
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
                this._createGranularDrawingOperation(
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
                this._createGranularDrawingOperation(
                    'remove',
                    path,
                    previousValue,
                    undefined,
                    metadata
                )
            ];
        }
        return [
            this._createGranularDrawingOperation(
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
        metadata: DrawingSyncMetadata
    ): TransactionBufferedOperation[] {
        const previousById = this._mapArrayItemsById(previousArray);
        const nextById = this._mapArrayItemsById(nextArray);
        if (!previousById || !nextById) {
            return [
                this._createGranularDrawingOperation(
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
                this._createGranularDrawingOperation(
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

    private _createGranularDrawingOperation(
        op: ChangeOp,
        path: (string | number)[],
        oldValue: unknown,
        newValue: unknown,
        metadata: DrawingSyncMetadata
    ): TransactionBufferedOperation {
        const originatingGlyphName =
            path[0] === 'glyphs' && typeof path[1] === 'string'
                ? path[1]
                : null;
        const originatingDrawingId =
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
            originatingLayerId: originatingDrawingId
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

    private _adoptIndexedDrawingIds(
        previousDrawing: Record<string, unknown>,
        nextDrawing: Record<string, unknown>,
        replaceExistingIds = false
    ): void {
        this._adoptIndexedArrayIds(
            previousDrawing.anchors,
            nextDrawing.anchors,
            replaceExistingIds
        );
        this._adoptIndexedArrayIds(
            previousDrawing.anchors,
            nextDrawing.anchors,
            replaceExistingIds
        );
        this._adoptIndexedArrayIds(
            previousDrawing.guides,
            nextDrawing.guides,
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
            const liveDrawings = new Map(
                this._coerceGlyphDrawingSnapshots(liveGlyph?.layers).map(
                    (drawing) => [String(drawing.id || ''), drawing]
                )
            );
            const previousDrawings = new Map(
                this._coerceGlyphDrawingSnapshots(previousGlyph?.layers).map(
                    (drawing) => [String(drawing.id || ''), drawing]
                )
            );
            for (const nextDrawing of this._coerceGlyphDrawingSnapshots(
                nextGlyph.layers
            )) {
                const drawingId = String(nextDrawing.id || '');
                const identityShapes =
                    liveDrawings.get(drawingId)?.shapes ??
                    previousDrawings.get(drawingId)?.shapes;
                this._alignReloadShapeIdentities(
                    identityShapes,
                    nextDrawing.shapes
                );
                this._alignReloadShapeIdentities(
                    identityShapes,
                    previousDrawings.get(drawingId)?.shapes
                );
            }
        }
    }

    private _adoptIndexedFontDrawingIds(
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
        const previousStations = asRecords(
            (previousSnapshot as Record<string, unknown>)?.masters
        );
        const nextStations = asRecords(
            (nextSnapshot as Record<string, unknown>)?.masters
        );
        const previousStationsById = new Map(
            previousStations.map((station) => [
                String(station.id || ''),
                station
            ])
        );

        for (const nextStation of nextStations) {
            const previousStation = previousStationsById.get(
                String(nextStation.id || '')
            );
            if (previousStation) {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        previousStation,
                        'kerning_rtl'
                    ) &&
                    nextStation.kerning_rtl &&
                    typeof nextStation.kerning_rtl === 'object' &&
                    !Array.isArray(nextStation.kerning_rtl) &&
                    Object.keys(nextStation.kerning_rtl).length === 0
                ) {
                    delete nextStation.kerning_rtl;
                }
                this._adoptIndexedArrayIds(
                    previousStation.guides,
                    nextStation.guides,
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

            const previousDrawingsById = new Map(
                this._coerceGlyphDrawingSnapshots(previousGlyph.layers).map(
                    (drawing) => [String(drawing.id || ''), drawing]
                )
            );
            for (const nextDrawing of this._coerceGlyphDrawingSnapshots(
                nextGlyph.layers
            )) {
                const previousDrawing = previousDrawingsById.get(
                    String(nextDrawing.id || '')
                );
                if (previousDrawing) {
                    this._adoptIndexedDrawingIds(
                        previousDrawing,
                        nextDrawing,
                        true
                    );
                    this._alignReloadShapeIdentities(
                        previousDrawing.shapes,
                        nextDrawing.shapes
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
            const nextDrawings = this._coerceGlyphDrawingSnapshots(
                nextGlyph.layers
            );
            const previousDrawings = this._coerceGlyphDrawingSnapshots(
                previousByName.get(name)?.layers
            );
            const liveDrawings = this._coerceGlyphDrawingSnapshots(
                liveByName.get(name)?.layers
            );
            const previousDrawingsById = new Map(
                previousDrawings.map((drawing) => [
                    String(drawing.id || ''),
                    drawing
                ])
            );
            const liveDrawingsById = new Map(
                liveDrawings.map((drawing) => [
                    String(drawing.id || ''),
                    drawing
                ])
            );
            for (const nextDrawing of nextDrawings) {
                omitFromRecord(
                    nextDrawing,
                    previousDrawingsById.get(String(nextDrawing.id || '')) ??
                        null,
                    liveDrawingsById.get(String(nextDrawing.id || '')) ?? null
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

    private _isCompleteDrawingSnapshot(
        nextDrawing: Record<string, unknown>
    ): boolean {
        return (
            Object.prototype.hasOwnProperty.call(nextDrawing, 'width') &&
            Object.prototype.hasOwnProperty.call(nextDrawing, 'master') &&
            Object.prototype.hasOwnProperty.call(nextDrawing, 'shapes')
        );
    }

    private _shouldUseGranularSingleDrawingSync(
        glyphName: string,
        drawingId: string,
        previousDrawing: Record<string, unknown>,
        nextDrawing: Record<string, unknown>
    ): boolean {
        if (this._hasBufferedDrawingRootOperation(glyphName, drawingId)) {
            return false;
        }

        // Partial drawing fragments must stay on the sparse drawing-delta path so
        // omitted fields remain untouched. Granular sync is only safe for
        // complete drawing snapshots that carry the drawing's core fields.
        if (!this._isCompleteDrawingSnapshot(nextDrawing)) {
            return false;
        }

        return true;
    }

    private _hasBufferedDrawingRootOperation(
        glyphName: string,
        drawingId: string
    ): boolean {
        return this._txBufferedOperations.some((operation) => {
            if (operation.path.length !== 4) {
                return false;
            }

            return (
                operation.path[0] === 'glyphs' &&
                operation.path[1] === glyphName &&
                operation.path[2] === 'layers' &&
                operation.path[3] === drawingId
            );
        });
    }

    private _buildSparseDrawingDelta(
        previousDrawing: Record<string, unknown> | null,
        nextDrawing: Record<string, unknown>,
        drawingId: string
    ): {
        delta: Record<string, unknown>;
        oldValues: Record<string, unknown>;
    } | null {
        const delta: Record<string, unknown> = { id: drawingId };
        const oldValues: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(nextDrawing)) {
            const oldValue = previousDrawing?.[key];
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
        drawingId?: string | null,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null,
        previousGlyphSnapshots?: Record<string, Record<string, unknown>>
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing)
            return;

        assertCompileStamp(compileChangeSource, compileEditType);
        assertCloudAssetMutable();

        const uniqueGlyphNames = Array.from(
            new Set(glyphNames.filter((name) => typeof name === 'string'))
        );
        if (!uniqueGlyphNames.length) {
            return;
        }

        // Fast path: single glyph + known drawing → compare and sync only
        // the affected drawing, avoiding full-glyph JSON reconstruction,
        // deep-equality checks, and cloning.
        if (uniqueGlyphNames.length === 1 && drawingId) {
            if (
                this._trySyncSingleDrawing(
                    uniqueGlyphNames[0],
                    drawingId,
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

        const undoScope = this._deriveBulkUndoScope(targets, drawingId ?? null);
        this._queueOrCommitOperations(
            targets.map((target) => {
                const glyphDrawings = (target.glyphJson.layers ?? []) as Array<
                    Record<string, unknown>
                >;
                const previousGlyphDrawings = Array.isArray(
                    target.previousGlyphJson.layers
                )
                    ? (target.previousGlyphJson.layers as Array<
                          Record<string, unknown>
                      >)
                    : [];
                // A drawing id whose JSON is already gone is a structural
                // delete. Drawing scope would apply the transaction label as
                // a delta and leave the Y drawing in place.
                const syncDrawingId =
                    drawingId &&
                    glyphDrawings.some(
                        (drawing: Record<string, unknown>) =>
                            drawing.id === drawingId
                    )
                        ? drawingId
                        : null;
                const glyphSnapshot = this._normalizeGlyphSnapshot(
                    target.glyphJson,
                    target.previousGlyphJson
                );
                const previousGlyphSnapshot = this._normalizeGlyphSnapshot(
                    target.previousGlyphJson
                );
                const drawingSnapshot = syncDrawingId
                    ? this._normalizeDrawingSnapshot(
                          syncDrawingId,
                          glyphDrawings.find(
                              (drawing: Record<string, unknown>) =>
                                  drawing.id === syncDrawingId
                          ),
                          previousGlyphDrawings.find(
                              (drawing: Record<string, unknown>) =>
                                  drawing.id === syncDrawingId
                          )
                      )
                    : undefined;
                const previousDrawingSnapshot = syncDrawingId
                    ? previousGlyphDrawings.find(
                          (drawing: Record<string, unknown>) =>
                              drawing.id === syncDrawingId
                      )
                    : undefined;
                const isDrawingScope = undoScope === 'layer' && !!syncDrawingId;
                const originatingDrawingId =
                    syncDrawingId ??
                    (Array.isArray(target.glyphJson.layers)
                        ? String(
                              (
                                  target.glyphJson.layers as Array<
                                      Record<string, unknown>
                                  >
                              ).find((drawing) => drawing?.id)?.id ?? ''
                          ) || null
                        : null);

                const drawingPathId = syncDrawingId ?? drawingId ?? '';
                return {
                    op: 'set' as ChangeOp,
                    path: isDrawingScope
                        ? ['glyphs', target.glyphName, 'layers', drawingPathId]
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
                    originatingLayerId: originatingDrawingId,
                    applyPath: isDrawingScope
                        ? ['glyphs', target.glyphName, 'layers', drawingPathId]
                        : ['glyphs', target.glyphName],
                    applyOldValue: isDrawingScope
                        ? previousDrawingSnapshot
                        : previousGlyphSnapshot,
                    applyNewValue: isDrawingScope
                        ? drawingSnapshot
                        : glyphSnapshot,
                    applyMode: isDrawingScope
                        ? 'drawing-snapshot'
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
     * this only touches the one affected drawing — dramatically reducing
     * JSON serialization overhead for point-move operations.
     *
     * Returns true if the fast path handled the sync (even if no
     * changes were found), false if the caller should fall back to
     * the full glyph path.
     */
    private _trySyncSingleDrawing(
        glyphName: string,
        drawingId: string,
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

        const drawingsMap = glyphMap.get('layers') as
            Y.Map<unknown> | undefined;
        if (!drawingsMap) return false;

        // Find the drawing in the in-memory model
        const glyphDrawings = (glyphJson.layers ?? []) as Array<
            Record<string, unknown>
        >;
        const drawingJson = glyphDrawings.find(
            (l: Record<string, unknown>) => l.id === drawingId
        );
        if (!drawingJson) return false;
        const existingYDrawing = drawingsMap.get(drawingId);
        const storageDrawingJson = this._prepareDrawingSnapshotForHistory(
            drawingId,
            drawingJson,
            existingYDrawing instanceof Y.Map
                ? fromYType(existingYDrawing)
                : null,
            existingYDrawing instanceof Y.Map ? existingYDrawing : null
        );
        const operations = this._buildDrawingSyncOperations(
            glyphName,
            drawingId,
            drawingsMap,
            storageDrawingJson,
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
            return true;
        }

        this._queueOrCommitOperations(operations, label);

        console.log(
            `Glyph sync committed for ${glyphName} drawing ${drawingId} (${label}) [fast path]`
        );
        return true;
    }

    // ── Undo / Redo ──────────────────────────────────────────────

    /**
     * Undo the most recently applied history item on the given surface.
     *
     * YJS_ONLY: History replay is the only undo engine; it emits a canonical
     * binary Yjs update into the standard post-commit funnel.
     */
    undo(
        glyphName?: string,
        drawingId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): UndoRedoResult | null {
        return this._replayHistoryAction(
            'undo',
            glyphName,
            drawingId,
            historyTargetKey,
            surface
        );
    }

    /** Redo the most recently undone history item on the given surface. */
    redo(
        glyphName?: string,
        drawingId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): UndoRedoResult | null {
        return this._replayHistoryAction(
            'redo',
            glyphName,
            drawingId,
            historyTargetKey,
            surface
        );
    }

    /** Check if undo is available. */
    canUndo(
        glyphName?: string,
        drawingId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): boolean {
        return !!this._resolveUndoHistoryItem(
            glyphName,
            drawingId,
            'undo',
            historyTargetKey,
            surface
        );
    }

    /** Check if redo is available. */
    canRedo(
        glyphName?: string,
        drawingId?: string | null,
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): boolean {
        return !!this._resolveUndoHistoryItem(
            glyphName,
            drawingId,
            'redo',
            historyTargetKey,
            surface
        );
    }

    private _replayHistoryAction(
        historyAction: 'undo' | 'redo',
        glyphName: string | undefined,
        drawingId: string | null | undefined,
        historyTargetKey: string | null | undefined,
        surface: HistoryUndoSurface | null | undefined
    ): UndoRedoResult | null {
        // The editor commits what it holds before it asks for an undo; a
        // commit made here, after the replay wrote, would undo the undo.
        return this._withGlyphModelRebuild(
            'history-replay',
            null,
            () =>
                this._replayHistoryActionInScope(
                    historyAction,
                    glyphName,
                    drawingId,
                    historyTargetKey,
                    surface
                ),
            { runBeforeListeners: false }
        );
    }

    private _replayHistoryActionInScope(
        historyAction: 'undo' | 'redo',
        glyphName: string | undefined,
        drawingId: string | null | undefined,
        historyTargetKey: string | null | undefined,
        surface: HistoryUndoSurface | null | undefined
    ): UndoRedoResult | null {
        // Refused before the history moves: nothing is undone or redone.
        this._assertLocalWriteAllowed(historyAction);
        // A tick after undo must start a new history item, not extend the
        // one just undone; the held cloud send also goes out first.
        void this._editBursts.finalizeAll();
        const historyItem = this._resolveUndoHistoryItem(
            glyphName,
            drawingId,
            historyAction,
            historyTargetKey,
            surface
        );
        if (!historyItem) {
            return null;
        }
        if (this._historyItemOverlapsLaterCollaboratorEdit(historyItem)) {
            console.warn(
                `Skipping ${historyAction}: a collaborator changed the same data after history item ${historyItem.id}`
            );
            this._announceHistoryReplayProblem({
                kind: 'blocked',
                reason: 'collaborator-edit',
                historyAction,
                historyItemId: historyItem.id
            });
            return null;
        }
        if (!this._canReplayHistoryItem(historyItem, historyAction)) {
            console.warn(
                `Skipping ${historyAction}: history item ${historyItem.id} has no replayable values`
            );
            return null;
        }
        // Every document the replay writes is resolved and checked before
        // the history moves or anything is written; a refusal leaves both
        // as they are.
        const prepared = this._prepareHistoryReplay(historyItem, historyAction);
        if (!prepared) {
            return null;
        }
        const target = this._targetFromHistoryItem(
            historyItem,
            glyphName ?? null,
            drawingId ?? null
        );
        const scope = this._scopeForTarget(target);
        const documentIds = this._documentIdsForHistoryItem(
            historyItem,
            this._documentIdForUndoTarget(target)
        );
        const localUpdateBaselines =
            this._captureDocumentBaselines(documentIds);
        this._pushApplyKind(ApplyKind.UndoRedo);
        try {
            const timestamp = Date.now();
            const metadataEntries = getSemanticEntriesForHistoryItem(
                historyItem,
                historyAction,
                historyItem.id,
                timestamp,
                this.windowId,
                this._getWindowRoleLabel()
            );
            if (!metadataEntries?.length && !target.glyphName) {
                return null;
            }
            const workerReplayTargets = normalizeWorkerReplayTargets([
                ...historyItem.workerReplayTargets,
                ...(target.glyphName && target.layerId
                    ? [{ glyphName: target.glyphName, layerId: target.layerId }]
                    : [])
            ]);
            // Log entry before replay so it's available when the Y.Doc
            // update event fires and WindowSync broadcasts it.
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyAction,
                targetHistoryItemId: historyItem.id,
                transactionLabel: historyAction === 'undo' ? 'Undo' : 'Redo',
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
                newValue: historyAction,
                workerReplayTargets,
                semanticChangeLogEntries: metadataEntries ?? undefined
            });
            this._appendChangeLogEntry(entry);
            const loggedEntryIndex = this._changeLog.length - 1;
            const loggedEntry = this._changeLog[loggedEntryIndex];
            const nameMaps = this._snapshotGlyphNameMaps();
            const committed: Array<[string, ChangeLogEntry[]]> = [];

            this._historyReplayBaselines = localUpdateBaselines;
            this._historyReplayDependentTargets = [];
            let writtenTargets: WorkerReplayTarget[] = [];
            let dependentTargets: WorkerReplayTarget[];
            let failure: { error: unknown } | null = null;
            try {
                writtenTargets = this._applyHistoryItem(
                    historyItem,
                    historyAction,
                    prepared,
                    committed
                );
            } catch (error) {
                failure = { error };
            } finally {
                dependentTargets = this._historyReplayDependentTargets;
                this._historyReplayBaselines = null;
                this._historyReplayDependentTargets = [];
            }
            if (failure) {
                this._abandonHistoryReplay(
                    {
                        historyAction,
                        historyItemId: historyItem.id,
                        prepared,
                        committed,
                        nameMaps,
                        loggedEntry,
                        loggedEntryIndex,
                        baselines: localUpdateBaselines,
                        dependentTargets
                    },
                    failure.error
                );
                throw failure.error;
            }
            this._noteDependentTargetsOnHistoryEntry(
                loggedEntryIndex,
                dependentTargets
            );
            const drawingSyncTargets = writtenTargets.length
                ? writtenTargets
                : this._historyReplayDrawingSyncTargets(
                      historyItem,
                      scope,
                      workerReplayTargets
                  );
            if (drawingSyncTargets) {
                this._syncJsonFromYDoc(drawingSyncTargets);
            } else if (metadataEntries?.length) {
                this._syncRemoteJsonFromYDoc(metadataEntries);
            } else {
                this._syncRemoteJsonFromYDoc([entry]);
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
            return {
                scope,
                glyphName: target.glyphName,
                layerId: target.layerId,
                historyItem
            };
        } finally {
            this._popApplyKind();
        }
    }

    /**
     * Drawing-patch the JSON shadow when every path the item touched lives
     * under a patchable drawing covered by the replay targets; otherwise the
     * caller falls back to semantic-entry sync.
     */
    private _historyReplayDrawingSyncTargets(
        historyItem: HistoryStackItem,
        scope: UndoScope,
        workerReplayTargets: WorkerReplayTarget[]
    ): WorkerReplayTarget[] | null {
        if (scope !== 'layer' || !workerReplayTargets.length) {
            return null;
        }
        if (
            !workerReplayTargets.every((replayTarget) =>
                this._canPatchDrawingFromYDoc(replayTarget)
            )
        ) {
            return null;
        }
        const coveredDrawingKeys = new Set(
            workerReplayTargets.map((replayTarget) =>
                getDrawingTouchKey(replayTarget.glyphName, replayTarget.layerId)
            )
        );
        const everyPathCovered = historyItem.touchedPaths.every((path) =>
            coveredDrawingKeys.has(
                getDrawingTouchKey(
                    deriveGlyphNameFromPath(path),
                    deriveDrawingIdFromPath(path)
                )
            )
        );
        return everyPathCovered ? workerReplayTargets : null;
    }

    /** Public JSON of a glyph or drawing root, or null when absent. */
    private _readReplaySnapshot(entryPath: string): unknown {
        const path = this._toYDocPath(this._parseEntryPath(entryPath));
        if (this._isGlyphRootPath(path)) {
            return this._readNormalizedGlyphSnapshotFromYDoc(String(path[1]), {
                ignoreExisting: true
            });
        }
        const value = this.getYValue(path);
        return value instanceof Y.Map
            ? cloneHistoryValue(fromYType(value))
            : null;
    }

    /**
     * Envelopes may omit glyph/drawing snapshot bodies to stay under the
     * packet limit. The receiver reads them from its own Y.Doc around the
     * apply so the history item stays replayable.
     */
    private _withRemoteReplaySnapshots(
        entries: ChangeLogEntry[],
        snapshotFillEntries: ChangeLogEntry[],
        snapshotsBefore: unknown[]
    ): ChangeLogEntry[] {
        if (!snapshotFillEntries.length) {
            return entries;
        }
        return entries.map((entry) => {
            const index = snapshotFillEntries.indexOf(entry);
            if (index < 0) {
                return entry;
            }
            const before = snapshotsBefore[index];
            const after = this._readReplaySnapshot(entry.path);
            if (JSON.stringify(before) === JSON.stringify(after)) {
                return entry;
            }
            return { ...entry, replayOldValue: before, replayNewValue: after };
        });
    }

    // ── Cross-window ─────────────────────────────────────────────

    /**
     * Apply a remote Y.Doc update from another window.
     * Optionally import accompanying change log entries.
     *
     * YJS_ONLY (binary): The remote binary Yjs update is applied and
     * the worker also receives it via _yjsWorkerCallback.
     * Remote JSON/model sync must stay branch-scoped: top-level keys, glyphs,
     * and drawings are patched from the authoritative Y.Doc without any full
     * yDocToJson rebuild on the receiving window hot path.
     */
    /**
     * Make this font read-only (`reason`, a sentence saying why, carried by
     * every refused edit’s error and shown to the user once per read-only
     * period) or writable again (null). While it
     * is read-only every local write is refused with `ReadOnlyFontError`
     * before anything changes: commits (editor edits and Python scripts),
     * undo and redo, live preview writes and the font worker’s packets.
     * Updates from collaborators still apply. This is not the broken mark:
     * no document is damaged.
     *
     * Each change (read-only to writable, writable to read-only, or a new
     * reason) is told to `onReadOnlyChanged` listeners after it takes
     * effect; setting the current state again tells no one. Writable again
     * (null), and destroy, end the read-only period: the UI forgets that it
     * showed the reason, so the next read-only period shows it again. A
     * listener that throws does not undo the change; every listener still
     * runs and the first error is rethrown.
     */
    setReadOnly(reason: string | null): void {
        if (reason !== null && (typeof reason !== 'string' || !reason.trim())) {
            throw new TypeError(
                'A read-only font needs a reason to show with refused edits.'
            );
        }
        const errors = this._changeReadOnlyReason(reason);
        if (errors.length) {
            for (const error of errors.slice(1)) {
                console.error(
                    'A listener failed when the font’s read-only state changed',
                    error
                );
            }
            throw errors[0];
        }
    }

    /**
     * Register a callback for each change of this font’s read-only state
     * (setReadOnly, destroy): the new reason, or null once it is writable
     * again. Returns the unsubscribe function.
     */
    onReadOnlyChanged(listener: ReadOnlyChangedListener): () => void {
        this._readOnlyChangedListeners.add(listener);
        return () => {
            this._readOnlyChangedListeners.delete(listener);
        };
    }

    /** Set the read-only reason and tell listeners; returns their errors. */
    private _changeReadOnlyReason(reason: string | null): unknown[] {
        if (this._readOnlyReason === reason) {
            return [];
        }
        this._readOnlyReason = reason;
        const errors: unknown[] = [];
        for (const listener of [...this._readOnlyChangedListeners]) {
            // A listener changed the state again: that nested change has
            // already told every listener the newer state, so the rest must
            // not hear this stale one after it.
            if (this._readOnlyReason !== reason) {
                break;
            }
            try {
                listener(reason);
            } catch (error) {
                errors.push(error);
            }
        }
        return errors;
    }

    /** True while local writes to this font are refused (setReadOnly). */
    isReadOnly(): boolean {
        return this._readOnlyReason !== null;
    }

    /** Throws `ReadOnlyFontError` while this font is read-only. */
    private _assertLocalWriteAllowed(context: string): void {
        if (this._readOnlyReason !== null) {
            throw new ReadOnlyFontError(this._readOnlyReason, context);
        }
    }

    /** Record that `documentId` lost an update; it refuses edits from now on. */
    markDocumentBroken(documentId: string, error: Error): void {
        // Kept by id too: a document this window does not hold yet is
        // refused when it loads, never recorded against font-core.
        markDocumentBroken(
            this._docForId(documentId),
            documentId,
            error,
            this._brokenScope
        );
    }

    /** True when `documentId` tripped a gate in this font session. */
    isDocumentIdBroken(documentId: string): boolean {
        return isDocumentIdBroken(this._brokenScope, documentId);
    }

    /** Throws when `documentId` is broken: nothing may load or write it. */
    private _assertDocumentIdWritable(documentId: string): void {
        assertDocumentWritable(null, documentId, this._brokenScope);
    }

    applyRemoteUpdate(
        update: Uint8Array,
        remoteEntries?: ChangeLogEntry[],
        remoteCollaborationMessages?: CollaborationMessageEnvelope[],
        documentId?: string,
        options?: ApplyRemoteUpdateOptions
    ): boolean {
        // A linked window's edit is this user's own, made before the
        // read-only state reached that window: refused here like an edit
        // made in this window, before anything changes. A collaborator's
        // update still applies.
        if (options?.fromLinkedWindow) {
            this._assertLocalWriteAllowed('edit in another window');
        }
        const changed = this._withGlyphModelRebuild(
            'remote-update',
            this._glyphNamesForRebuildHint(documentId, remoteEntries),
            () =>
                this._applyRemoteUpdate(
                    update,
                    remoteEntries,
                    remoteCollaborationMessages,
                    documentId,
                    options
                )
        );
        this._flushStrandedOutboxes();
        return changed;
    }

    private _applyRemoteUpdate(
        update: Uint8Array,
        remoteEntries?: ChangeLogEntry[],
        remoteCollaborationMessages?: CollaborationMessageEnvelope[],
        documentId?: string,
        options?: ApplyRemoteUpdateOptions
    ): boolean {
        const captureInUndo = options?.captureInUndo !== false;
        if (documentId && this._retiredLayoutDocs.has(documentId)) {
            return this._applyRetiredLayoutUpdate(documentId, update);
        }
        if (this._isReleasedLayoutRoom(documentId)) {
            return false;
        }
        this._pushApplyKind(ApplyKind.Remote);
        try {
            if (!this._fontJson) this._fontJson = {};
            const describedEntries = remoteEntries?.length
                ? remoteEntries
                : (remoteCollaborationMessages?.flatMap((message) =>
                      createChangeLogEntriesFromCollaborationMessageEnvelope(
                          message,
                          {
                              windowRoleLabel: this._getWindowRoleLabel(),
                              localWindowId: this.windowId
                          }
                      )
                  ) ?? []);
            // Envelope fitting replaced the glyph lists of these with
            // “every glyph of the packet’s document changed”.
            const wholeDocumentMessages = (
                remoteCollaborationMessages ?? []
            ).filter((message) => message.metadata.allGlyphsChanged === true);
            if (wholeDocumentMessages.length && !documentId) {
                throw new Error(
                    '[PatchSyncEngine] An envelope that names every glyph of its document arrived without the document’s id.'
                );
            }
            if (!describedEntries.length && !wholeDocumentMessages.length) {
                if (this._isRemoteUpdateNoopOnAnyDoc(update)) {
                    return false;
                }
                throw new MetadataFreeRemoteUpdateError();
            }
            const resolvedDocumentId =
                documentId ||
                (describedEntries[0]
                    ? this.documentIdForPath(
                          getPathSegments(describedEntries[0].path)
                      )
                    : FONT_CORE_DOCUMENT_ID);
            if (
                options?.restoredUnsentEdit &&
                !this.hasLoadedDocumentState(resolvedDocumentId)
            ) {
                // Applied now, the edit would make or fill the document
                // ahead of its room state: the window would then count it
                // as held and never load the rest. It waits, unbroken.
                recordCollabTrace('wal-restore-waits', [], {
                    document: resolvedDocumentId,
                    resident: this._docForId(resolvedDocumentId) !== null
                });
                throw new DocumentStateNotLoadedError(resolvedDocumentId);
            }
            let targetDoc = this._docForId(resolvedDocumentId);
            if (!targetDoc && isLayoutDocumentId(resolvedDocumentId)) {
                targetDoc = this._ensureLayoutDoc(resolvedDocumentId);
            }
            if (!targetDoc && resolvedDocumentId.startsWith('glyph:')) {
                const glyphId = resolvedDocumentId.slice('glyph:'.length);
                const catalog = catalogFromCoreJson(
                    this._fontJson as Record<string, unknown>
                )?.glyphCatalog;
                if (isCatalogTombstone(catalog, glyphId)) {
                    return false;
                }
                // Only a complete state makes a glyph here: a new glyph's
                // first packet (ClockGapError otherwise).
                this._assertCompleteGlyphState(update, resolvedDocumentId);
                const glyphName =
                    this._glyphNameById.get(glyphId) ||
                    this._deriveGlyphNameFromPath(
                        describedEntries[0]?.path || ''
                    ) ||
                    glyphId;
                this._ensureGlyphDoc(glyphId, glyphName);
                targetDoc = this._docForId(resolvedDocumentId);
            }
            targetDoc = targetDoc || this._requireDocForId(resolvedDocumentId);
            const wholeDocumentGlyphEntries = wholeDocumentMessages.length
                ? this._wholeDocumentGlyphEntries(
                      resolvedDocumentId,
                      wholeDocumentMessages
                  )
                : [];
            const effectiveRemoteEntries = wholeDocumentGlyphEntries.length
                ? [
                      ...describedEntries,
                      ...wholeDocumentGlyphEntries.map(({ entry }) => entry)
                  ]
                : describedEntries;
            const snapshotFillEntries = captureInUndo
                ? effectiveRemoteEntries.filter(
                      (entry) =>
                          entry.op === 'set' &&
                          isSnapshotRootPath(entry.path) &&
                          !isReplayableHistoryEntry(entry)
                  )
                : [];
            const snapshotsBefore = snapshotFillEntries.map((entry) =>
                this._readReplaySnapshot(entry.path)
            );
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
            targetDoc.on('afterTransaction', observeRemoteTransaction);
            try {
                applyUpdateWithIntegrity(
                    targetDoc,
                    update,
                    resolvedDocumentId,
                    captureInUndo ? PEER_REMOTE_ORIGIN : CLOUD_REMOTE_ORIGIN,
                    this._brokenScope
                );
            } finally {
                targetDoc.off('afterTransaction', observeRemoteTransaction);
            }
            if (!didChange) {
                // This document already had every byte (the integrity gate
                // refuses an update that would wait for an earlier one).
                if (isCollabTraceOn()) {
                    this._traceRemoteUpdate(
                        'remote-noop',
                        resolvedDocumentId,
                        effectiveRemoteEntries,
                        options
                    );
                }
                return false;
            }
            if (options?.fromCollaborator) {
                this._noteCollaboratorTouches(
                    effectiveRemoteEntries.map((entry) =>
                        String(entry.path || '')
                    )
                );
            }
            this._reconcileGlyphDocsAfterRemoteEntries(effectiveRemoteEntries);
            this._bindAppliedGlyphDocument(resolvedDocumentId);
            this._renameWholeDocumentGlyphEntries(wholeDocumentGlyphEntries);
            if (effectiveRemoteEntries.length) {
                this._syncRemoteJsonFromYDoc(effectiveRemoteEntries);
            }
            // A document-wide envelope on a document that holds no glyph
            // data (font-core in a sharded font, a layout room) has nothing
            // to re-read: its kept paths describe the rest.
            this._fillWholeDocumentReplayTargets(wholeDocumentGlyphEntries);
            if (isCollabTraceOn()) {
                this._traceRemoteUpdate(
                    'remote',
                    resolvedDocumentId,
                    effectiveRemoteEntries,
                    options
                );
            }
            const pythonBaseline = window.pythonExecutionHistoryContext;
            if (pythonBaseline?.beforeFontDataJson && this._fontJson) {
                pythonBaseline.beforeFontDataJson =
                    rebasePythonExecutionBaseline(
                        pythonBaseline.beforeFontDataJson,
                        this._fontJson,
                        effectiveRemoteEntries.map((entry) =>
                            String(entry.path || '')
                        )
                    );
            }
            this._yjsWorkerCallback?.(
                update,
                effectiveRemoteEntries,
                resolvedDocumentId
            );
            if (this._remoteAfterSyncBatch) {
                this._remoteAfterSyncBatch.pending = true;
            } else {
                this._onAfterSync?.();
            }
            this._onDirty?.();
            if (
                captureInUndo &&
                effectiveRemoteEntries &&
                effectiveRemoteEntries.length > 0
            ) {
                this._appendChangeLogEntries(
                    this._withRemoteReplaySnapshots(
                        effectiveRemoteEntries,
                        snapshotFillEntries,
                        snapshotsBefore
                    )
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
                    documentId: resolvedDocumentId,
                    ...(options?.fromCollaborator
                        ? { fromCollaborator: true }
                        : undefined),
                    ...(options?.fromLinkedWindow
                        ? { fromLinkedWindow: true }
                        : undefined)
                });
            }
            return didChange;
        } finally {
            this._popApplyKind();
        }
    }

    /**
     * The glyphs a document-wide envelope (`metadata.allGlyphsChanged`)
     * stands for: the glyph of a glyph document, the glyphs font-core
     * itself stores, none in a layout room. Each becomes a `glyphs.<name>:`
     * set, so the receiver re-reads it whole from its own Y.Doc. Replay
     * targets are worked out after the apply.
     */
    private _wholeDocumentGlyphEntries(
        documentId: string,
        messages: CollaborationMessageEnvelope[]
    ): Array<{ entry: ChangeLogEntry; glyphId: string | null }> {
        let glyphs: Array<{ name: string; glyphId: string | null }> = [];
        if (documentId.startsWith('glyph:')) {
            const glyphId = documentId.slice('glyph:'.length);
            const indexedName = this._glyphNameById.get(glyphId);
            const storedName = indexedName
                ? indexedName
                : this._wakeGlyphDoc(glyphId)?.getMap('glyph').get('name');
            const name =
                indexedName ||
                (typeof storedName === 'string' ? storedName : '') ||
                glyphId;
            glyphs = [{ name, glyphId }];
        } else if (documentId === FONT_CORE_DOCUMENT_ID) {
            const coreGlyphs = this.fontMap.get('glyphs');
            if (coreGlyphs instanceof Y.Map) {
                glyphs = [...coreGlyphs.keys()].map((name) => ({
                    name: String(name),
                    glyphId: null
                }));
            }
        }
        if (!glyphs.length) {
            return [];
        }
        return messages.flatMap((message) => {
            const entries =
                createChangeLogEntriesFromCollaborationMessageEnvelope(
                    {
                        ...message,
                        changes: glyphs.map(({ name }) => ({
                            path: `glyphs.${name}:`,
                            op: 'set' as const
                        })),
                        metadata: {
                            ...message.metadata,
                            workerReplayTargets: []
                        }
                    },
                    {
                        windowRoleLabel: this._getWindowRoleLabel(),
                        localWindowId: this.windowId
                    }
                );
            return entries.map((entry, index) => ({
                entry,
                glyphId: glyphs[index].glyphId
            }));
        });
    }

    /** A glyph document renamed by the packet re-reads its new name. */
    private _renameWholeDocumentGlyphEntries(
        wholeDocumentEntries: Array<{
            entry: ChangeLogEntry;
            glyphId: string | null;
        }>
    ): void {
        for (const { entry, glyphId } of wholeDocumentEntries) {
            const name = glyphId ? this._glyphNameById.get(glyphId) : null;
            if (name && entry.path !== `glyphs.${name}:`) {
                entry.path = `glyphs.${name}:`;
            }
        }
    }

    /**
     * Replay targets of a document-wide envelope, from this window’s own
     * font: every drawing of each re-read glyph, plus every drawing of the
     * composites that use it (directly or through other composites).
     */
    private _fillWholeDocumentReplayTargets(
        wholeDocumentEntries: Array<{
            entry: ChangeLogEntry;
            glyphId: string | null;
        }>
    ): void {
        if (!wholeDocumentEntries.length) {
            return;
        }
        const glyphs = Array.isArray(this._fontJson?.glyphs)
            ? (this._fontJson.glyphs as Unsafe[])
            : [];
        const drawingIdsByGlyph = new Map<string, string[]>();
        const usersByReference = new Map<string, Set<string>>();
        for (const glyph of glyphs) {
            const glyphName =
                glyph && typeof glyph.name === 'string' ? glyph.name : '';
            if (!glyphName) {
                continue;
            }
            const drawings: Unsafe[] = Array.isArray(glyph.layers)
                ? glyph.layers
                : [];
            drawingIdsByGlyph.set(
                glyphName,
                drawings
                    .map((drawing) =>
                        drawing && typeof drawing.id === 'string'
                            ? drawing.id
                            : ''
                    )
                    .filter((drawingId) => !!drawingId)
            );
            for (const drawing of drawings) {
                const shapes: unknown[] = Array.isArray(drawing?.shapes)
                    ? drawing.shapes
                    : [];
                for (const shape of shapes) {
                    const reference = getComponentReferenceFromShape(
                        shape as Unsafe
                    );
                    if (!reference) {
                        continue;
                    }
                    const users = usersByReference.get(reference) ?? new Set();
                    users.add(glyphName);
                    usersByReference.set(reference, users);
                }
            }
        }
        for (const { entry } of wholeDocumentEntries) {
            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            if (!glyphName) {
                continue;
            }
            const affected = new Set<string>([glyphName]);
            const queue = [glyphName];
            while (queue.length) {
                const reference = queue.shift() as string;
                for (const user of usersByReference.get(reference) ?? []) {
                    if (!affected.has(user)) {
                        affected.add(user);
                        queue.push(user);
                    }
                }
            }
            entry.workerReplayTargets = normalizeWorkerReplayTargets(
                [...affected].flatMap((name) =>
                    (drawingIdsByGlyph.get(name) ?? []).map((layerId) => ({
                        glyphName: name,
                        layerId
                    }))
                )
            );
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
        const hadGlyphRenames = remoteEntries.some(
            (entry) => normalizeGlyphRenames(entry.glyphRenames).length > 0
        );
        if (hadGlyphRenames) {
            this._applyGlyphNameRemapsFromEntries(remoteEntries, 'redo');
        }
        if (glyphOrderTouched || glyphRootRemoved) {
            if (glyphOrderTouched) {
                this._remapGlyphIndexFromOrderEntries(remoteEntries);
            }
            this._syncGlyphNameIndexToOrder({
                pairSingleRename: remoteEntries.some(
                    (entry) =>
                        normalizeGlyphRenames(entry.glyphRenames).length > 0
                )
            });
        }
        if (hadGlyphRenames && !glyphOrderTouched) {
            this._syncAllGlyphsFromYDoc();
        }
    }

    private _remapGlyphIndexFromOrderEntries(
        remoteEntries: ChangeLogEntry[]
    ): void {
        for (const entry of remoteEntries) {
            const segments = getPathSegments(String(entry.path || ''));
            const previousNames = Array.isArray(entry.oldValue)
                ? entry.oldValue
                : Array.isArray(entry.replayOldValue)
                  ? entry.replayOldValue
                  : null;
            if (segments[0] !== 'glyphOrder' || !previousNames) {
                continue;
            }
            const oldNames = previousNames.map((name) => String(name));
            const nextNames = Array.isArray(entry.newValue)
                ? entry.newValue
                : Array.isArray(entry.replayNewValue)
                  ? entry.replayNewValue
                  : null;
            const newNames = nextNames
                ? nextNames.map((name) => String(name))
                : this._readYGlyphOrderNames();
            if (!oldNames.length || oldNames.length !== newNames.length) {
                continue;
            }
            const changes: Array<{ oldName: string; newName: string }> = [];
            for (let index = 0; index < oldNames.length; index += 1) {
                const oldName = oldNames[index];
                const newName = newNames[index];
                if (!oldName || !newName || oldName === newName) {
                    continue;
                }
                changes.push({ oldName, newName });
            }
            if (changes.length !== 1) {
                continue;
            }
            const { oldName, newName } = changes[0];
            const glyphId = this._glyphIdByName.get(oldName);
            if (!glyphId) {
                continue;
            }
            const owner = this._glyphIdByName.get(newName);
            if (owner && owner !== glyphId) {
                continue;
            }
            this._glyphIdByName.delete(oldName);
            this._glyphIdByName.set(newName, glyphId);
            this._glyphNameById.set(glyphId, newName);
        }
    }

    private _isRemoteUpdateNoopOnAnyDoc(update: Uint8Array): boolean {
        const docs: Y.Doc[] = [
            this.yDoc,
            this.depsDoc,
            ...this._glyphDocs.values()
        ];
        if (docs.some((doc) => this._isRemoteUpdateNoop(update, doc))) {
            return true;
        }
        if (this._dormantGlyphStates.size === 0) {
            return false;
        }
        const decodedUpdate = Y.decodeUpdate(update);
        const hasDeletes = decodedUpdate.ds.clients.size > 0;
        for (const [glyphId, bytes] of this._dormantGlyphStates) {
            const sv = Y.decodeStateVector(
                Y.encodeStateVectorFromUpdate(bytes)
            );
            let structsCovered = true;
            for (const struct of decodedUpdate.structs) {
                const knownClock = sv.get(struct.id.client) ?? 0;
                if (struct.id.clock + struct.length > knownClock) {
                    structsCovered = false;
                    break;
                }
            }
            if (!structsCovered) {
                continue;
            }
            if (!hasDeletes) {
                return true;
            }
            const woken = this._wakeGlyphDoc(glyphId);
            if (woken && this._isRemoteUpdateNoop(update, woken)) {
                return true;
            }
        }
        return false;
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
        const drawingTargets = new Map<
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
            if (
                topLevelKey === GLYPH_REVISIONS_KEY ||
                topLevelKey === FONT_DEPS_ENTRY_PATH
            ) {
                continue;
            }
            if (topLevelKey !== 'glyphs') {
                topLevelKeys.add(topLevelKey);
                continue;
            }

            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            const drawingId = this._deriveDrawingIdFromPath(entry.path);
            const explicitDrawingTargets = normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            );
            const hasExplicitDrawingTargets = explicitDrawingTargets.length > 0;
            if (!glyphName) {
                syncEntireFont = true;
                continue;
            }

            // A bare `glyphs.X:` set means "re-read this glyph": envelope
            // fitting collapses changes to it, whatever the history scope.
            const isGlyphRootSet =
                pathSegments.length === 2 && entry.op === 'set';
            const isWholeGlyphChange =
                !drawingId && (entry.undoScope !== 'layer' || isGlyphRootSet);
            const isWholeDrawingChange =
                drawingId !== null &&
                pathSegments.length === 4 &&
                pathSegments[2] === 'layers' &&
                !hasExplicitDrawingTargets;

            if (isWholeGlyphChange || isWholeDrawingChange) {
                glyphNames.add(glyphName);
                continue;
            }
        }

        if (!syncEntireFont) {
            for (const entry of entries) {
                const explicitDrawingTargets = normalizeWorkerReplayTargets(
                    entry.workerReplayTargets
                );
                if (explicitDrawingTargets.length > 0) {
                    for (const target of explicitDrawingTargets) {
                        if (glyphNames.has(target.glyphName)) {
                            continue;
                        }
                        drawingTargets.set(
                            getDrawingFingerprintTargetKey(
                                target.glyphName,
                                target.layerId
                            ),
                            target
                        );
                    }
                    continue;
                }

                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const drawingId = this._deriveDrawingIdFromPath(entry.path);
                if (!glyphName || !drawingId || glyphNames.has(glyphName)) {
                    continue;
                }

                drawingTargets.set(
                    getDrawingFingerprintTargetKey(glyphName, drawingId),
                    { glyphName, layerId: drawingId }
                );
            }
        }

        const fingerprintTargets = this._collectRemoteFingerprintTargets(
            syncEntireFont,
            glyphNames,
            Array.from(drawingTargets.values())
        );
        const previousFingerprintSnapshot =
            fingerprintTargets !== undefined
                ? this._collectDrawingFingerprintSnapshot(fingerprintTargets)
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
            for (const target of drawingTargets.values()) {
                if (glyphNames.has(target.glyphName)) {
                    continue;
                }
                if (!this._patchDrawingFromYDoc(target)) {
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
            this._emitDrawingFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectDrawingFingerprintSnapshot(fingerprintTargets)
            );
        }
    }

    /**
     * Rehydrate every top-level font key and glyph snapshot from the current
     * Y.Doc after an explicit full-state bootstrap or rebaseline.
     */
    private _rehydrateEntireFontJsonFromYDoc(options?: {
        mergeExistingGlyphs?: boolean;
    }): void {
        if (!this._fontJson) {
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const nextTopLevelKeys = this._logicalTopLevelKeys();

        this._syncAllGlyphsFromYDoc(options?.mergeExistingGlyphs === true);

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
            if (key === CORE_CODEPOINT_INDEX_KEY && this.roomLayout) {
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
        drawingTargets: Array<{ glyphName: string; layerId: string }>
    ): DrawingFingerprintTarget[] | null | undefined {
        if (syncEntireFont) {
            return null;
        }

        const targets = normalizeWorkerReplayTargets(drawingTargets);
        for (const glyphName of glyphNames) {
            this._appendGlyphDrawingFingerprintTargets(glyphName, targets);
        }

        return targets.length > 0
            ? normalizeWorkerReplayTargets(targets)
            : undefined;
    }

    private _appendGlyphDrawingFingerprintTargets(
        glyphName: string,
        targets: DrawingFingerprintTarget[]
    ): void {
        const seen = new Set(
            targets.map((target) =>
                getDrawingFingerprintTargetKey(target.glyphName, target.layerId)
            )
        );
        const pushTarget = (drawingId: string | null) => {
            if (!drawingId) {
                return;
            }
            const targetKey = getDrawingFingerprintTargetKey(
                glyphName,
                drawingId
            );
            if (seen.has(targetKey)) {
                return;
            }
            seen.add(targetKey);
            targets.push({ glyphName, layerId: drawingId });
        };

        const glyphs = Array.isArray((this._fontJson as Unsafe)?.glyphs)
            ? (((this._fontJson as Unsafe).glyphs as Unsafe[]).find(
                  (glyph) => glyph?.name === glyphName
              ) as Unsafe | undefined)
            : undefined;
        const existingDrawings = Array.isArray(glyphs?.layers)
            ? (glyphs.layers as Unsafe[])
            : [];
        for (const drawing of existingDrawings) {
            pushTarget(typeof drawing?.id === 'string' ? drawing.id : null);
        }

        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }
        const drawingsMap = glyphMap.get('layers');
        if (!(drawingsMap instanceof Y.Map)) {
            return;
        }
        drawingsMap.forEach((_value: unknown, drawingId: string) => {
            pushTarget(drawingId);
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
        const existingDrawings = Array.isArray(existing.layers)
            ? (existing.layers as Unsafe[])
            : [];
        const snapshotDrawings = Array.isArray(snapshot.layers)
            ? (snapshot.layers as Unsafe[])
            : [];
        const drawingsById = new Map<string, Unsafe>();
        for (const drawing of existingDrawings) {
            if (typeof drawing?.id === 'string' && drawing.id) {
                drawingsById.set(drawing.id, drawing);
            }
        }
        const nextDrawings: Unsafe[] = [];
        for (const drawingSnapshot of snapshotDrawings) {
            const drawingId =
                typeof drawingSnapshot?.id === 'string'
                    ? drawingSnapshot.id
                    : '';
            if (!drawingId) {
                throw new Error('malformed glyph snapshot: drawing missing id');
            }
            const existingDrawing = drawingsById.get(drawingId);
            if (
                existingDrawing &&
                typeof existingDrawing === 'object' &&
                !Array.isArray(existingDrawing)
            ) {
                this._assignJsonObjectInPlace(
                    existingDrawing as Record<string, unknown>,
                    drawingSnapshot as Record<string, unknown>
                );
                nextDrawings.push(existingDrawing);
            } else {
                nextDrawings.push(drawingSnapshot);
            }
        }
        this._assignJsonObjectInPlace(existing as Record<string, unknown>, {
            ...(snapshot as Record<string, unknown>),
            layers: nextDrawings
        });
    }

    private _stampOrderedGlyphName(glyph: Unsafe, glyphName: string): void {
        if (
            !glyph ||
            typeof glyph !== 'object' ||
            Array.isArray(glyph) ||
            typeof (glyph as { name?: unknown }).name !== 'string' ||
            (glyph as { name?: string }).name === glyphName
        ) {
            return;
        }
        withSuppressedModelRecording(() => {
            (glyph as { name: string }).name = glyphName;
        });
    }

    /**
     * Glyph-root adds still sitting in an open transaction are not in the
     * Yjs glyph order yet. A rebuild must keep them until that transaction
     * commits or the add is removed from the buffer.
     */
    private _uncommittedLocalGlyphAdds(): string[] {
        const names: string[] = [];
        const seen = new Set<string>();
        for (const operation of this._txBufferedOperations) {
            if (!this._isGlyphRootPath(operation.path)) {
                continue;
            }
            const glyphName = String(operation.path[1] || '');
            if (!glyphName) {
                continue;
            }
            if (operation.op === 'remove') {
                const index = names.indexOf(glyphName);
                if (index >= 0) {
                    names.splice(index, 1);
                }
                seen.delete(glyphName);
                continue;
            }
            if (operation.op === 'add' && !seen.has(glyphName)) {
                names.push(glyphName);
                seen.add(glyphName);
            }
        }
        return names;
    }

    private _syncAllGlyphsFromYDoc(
        mergeExistingGlyphs = false,
        options?: { dropGlyphIds?: Iterable<string> }
    ): void {
        if (!this._fontJson) {
            return;
        }
        this._syncAllGlyphsFromYDocInner(mergeExistingGlyphs, options);
        this._noteGlyphModelRebuilt(null);
    }

    private _syncAllGlyphsFromYDocInner(
        mergeExistingGlyphs: boolean,
        options?: { dropGlyphIds?: Iterable<string> }
    ): void {
        if (!this._fontJson) {
            return;
        }
        this._aliasResidentGlyphNamesFromCatalog();
        const dropGlyphIds = new Set(options?.dropGlyphIds || []);

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
            preserveExisting?: boolean;
        }> = [];
        for (const glyphName of orderedGlyphNames) {
            const existingGlyph =
                existingGlyphsByName.get(glyphName) ||
                (this._glyphIdByName.get(glyphName)
                    ? existingGlyphsById.get(
                          String(this._glyphIdByName.get(glyphName))
                      )
                    : undefined);
            const glyphSnapshot = this._readNormalizedGlyphSnapshotFromYDoc(
                glyphName,
                {
                    ignoreExisting: !mergeExistingGlyphs,
                    existingGlyph: mergeExistingGlyphs
                        ? existingGlyph
                        : undefined
                }
            );
            if (!glyphSnapshot) {
                const existingId =
                    this._glyphIdByName.get(glyphName) ||
                    (typeof existingGlyph?.id === 'string'
                        ? existingGlyph.id
                        : '');
                if (
                    existingGlyph &&
                    (!existingId || !dropGlyphIds.has(existingId))
                ) {
                    reconstructed.push({
                        glyphName,
                        glyphId: this._glyphIdByName.get(glyphName),
                        glyphSnapshot: existingGlyph,
                        preserveExisting: true
                    });
                }
                continue;
            }
            reconstructed.push({
                glyphName,
                glyphId: this._glyphIdByName.get(glyphName),
                glyphSnapshot
            });
        }
        for (const glyphName of this._uncommittedLocalGlyphAdds()) {
            if (reconstructed.some((item) => item.glyphName === glyphName)) {
                continue;
            }
            const existingGlyph = existingGlyphsByName.get(glyphName);
            const existingId =
                typeof existingGlyph?.id === 'string' ? existingGlyph.id : '';
            if (
                !existingGlyph ||
                (existingId && dropGlyphIds.has(existingId))
            ) {
                continue;
            }
            reconstructed.push({
                glyphName,
                glyphId:
                    this._glyphIdByName.get(glyphName) ||
                    existingId ||
                    undefined,
                glyphSnapshot: existingGlyph,
                preserveExisting: true
            });
        }
        for (const {
            glyphName,
            glyphId,
            glyphSnapshot,
            preserveExisting
        } of reconstructed) {
            const existingGlyph =
                existingGlyphsByName.get(glyphName) ||
                (glyphId ? existingGlyphsById.get(glyphId) : undefined);
            if (preserveExisting && existingGlyph) {
                this._stampOrderedGlyphName(existingGlyph, glyphName);
                nextGlyphs.push(existingGlyph);
                continue;
            }
            if (
                existingGlyph &&
                typeof existingGlyph === 'object' &&
                !Array.isArray(existingGlyph)
            ) {
                this._assignGlyphSnapshotInPlace(existingGlyph, glyphSnapshot);
                this._stampOrderedGlyphName(existingGlyph, glyphName);
                nextGlyphs.push(existingGlyph);
            } else {
                this._stampOrderedGlyphName(glyphSnapshot, glyphName);
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
        const value = this._readTopLevelJsonFromY(key);
        if (value === undefined) {
            if (key === CORE_CODEPOINT_INDEX_KEY && this.roomLayout) {
                // Derived in memory from the catalog under layout 2.
                return;
            }
            delete fontRecord[key];
            return;
        }

        fontRecord[key] = this._cloneRuntimeValue(cloneHistoryValue(value));
        if (key === CORE_GLYPH_CATALOG_KEY && this.roomLayout) {
            // The index is derived from the catalog under layout 2.
            fontRecord[CORE_CODEPOINT_INDEX_KEY] = codepointIndexFromCatalog(
                value as Record<string, unknown>
            );
        }
        if (key === CORE_GLYPH_CATALOG_KEY) {
            this._dropTombstonedGlyphsMissingFromOrder();
            this._dropDeletedGlyphNamesFromIndex();
            this._aliasResidentGlyphNamesFromCatalog();
            // Checkpoint and live font-core applies both land here. The
            // committed-change listener misses a catalog that arrived as a
            // document snapshot, so sparse windows replan from this copy.
            if (
                this._isApplyingRemote &&
                this._sparseSession &&
                typeof window !== 'undefined'
            ) {
                window.dispatchEvent(
                    new CustomEvent('cloud-catalog-resident-closure')
                );
            }
        }
    }

    private _readNormalizedGlyphSnapshotFromYDoc(
        glyphName: string,
        readOptions?: { ignoreExisting?: boolean; existingGlyph?: unknown }
    ): Unsafe | null {
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map) || glyphMap.size === 0) {
            return null;
        }

        const glyphSnapshot = this._cloneRuntimeValue(
            this._normalizeGlyphSnapshot(
                fromYType(glyphMap),
                readOptions?.existingGlyph,
                {
                    strictDrawings: true,
                    ignoreExisting: readOptions?.ignoreExisting === true
                }
            )
        ) as Unsafe;
        return glyphSnapshot;
    }

    private _patchGlyphFromYDoc(
        glyphName: string,
        options?: { ignoreExisting?: boolean }
    ): boolean {
        const patched = this._patchGlyphFromYDocInner(glyphName, options);
        if (patched) {
            this._noteGlyphModelRebuilt([glyphName]);
        }
        return patched;
    }

    private _patchGlyphFromYDocInner(
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

        let glyphIndex = glyphs.findIndex((glyph) => glyph?.name === glyphName);
        const glyphSnapshot = this._readNormalizedGlyphSnapshotFromYDoc(
            glyphName,
            { ignoreExisting: true }
        );

        if (!glyphSnapshot) {
            if (glyphIndex >= 0) {
                glyphs.splice(glyphIndex, 1);
            }
            return true;
        }

        // One entry per glyph: a glyph's room can name it by a name core has
        // already renamed (a catch-up older than the rename). Find the entry
        // by its immutable id too, and drop any second entry with that id,
        // or the window shows the glyph twice, under both names.
        const glyphId =
            this._glyphIdByName.get(glyphName) ||
            (typeof (glyphSnapshot as { id?: unknown }).id === 'string'
                ? ((glyphSnapshot as { id?: string }).id as string)
                : null);
        if (glyphIndex < 0 && glyphId) {
            glyphIndex = glyphs.findIndex((glyph) => glyph?.id === glyphId);
        }
        if (glyphId) {
            for (let index = glyphs.length - 1; index >= 0; index -= 1) {
                if (index !== glyphIndex && glyphs[index]?.id === glyphId) {
                    glyphs.splice(index, 1);
                    if (index < glyphIndex) {
                        glyphIndex -= 1;
                    }
                }
            }
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
        if (!(yGlyphsMap instanceof Y.Map) && !this._heldGlyphDocCount()) {
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
            const glyphIndex = glyphs.findIndex(
                (glyph) => glyph?.name === glyphName
            );
            if (glyphIndex < 0) {
                continue;
            }

            if (pathSegments.length === 2) {
                glyphs.splice(glyphIndex, 1);
                continue;
            }

            const glyphRecord = glyphs[glyphIndex];

            if (pathSegments.length === 3) {
                delete glyphRecord[pathSegments[2]];
                continue;
            }

            if (pathSegments.length === 4 && pathSegments[2] === 'layers') {
                const drawingId = pathSegments[3];
                const drawings = Array.isArray(glyphRecord.layers)
                    ? (glyphRecord.layers as Unsafe[])
                    : null;
                if (!drawings) {
                    continue;
                }

                const drawingIndex = drawings.findIndex(
                    (drawing) => drawing?.id === drawingId
                );
                if (drawingIndex >= 0) {
                    drawings.splice(drawingIndex, 1);
                }
                continue;
            }

            if (pathSegments.length !== 5 || pathSegments[2] !== 'layers') {
                continue;
            }

            const drawingId = pathSegments[3];
            const propertyKey = pathSegments[4];
            const drawings = Array.isArray(glyphRecord.layers)
                ? (glyphRecord.layers as Unsafe[])
                : null;
            const drawingRecord = drawings?.find(
                (drawing) => drawing?.id === drawingId
            );
            if (!drawingRecord) {
                continue;
            }

            delete drawingRecord[propertyKey];
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
        this._withGlyphModelRebuild('rebaseline', null, () =>
            this._applyFullState(state)
        );
    }

    private _applyFullState(state: YjsUpdate): void {
        let applied = false;
        this._pushApplyKind(ApplyKind.Remote);
        try {
            if (!this._fontJson) this._fontJson = {};
            applyUpdateWithIntegrity(
                this.yDoc,
                state,
                FONT_CORE_DOCUMENT_ID,
                SYSTEM_REMOTE_ORIGIN,
                this._brokenScope
            );
            this._stateLoadedDocumentIds.add(FONT_CORE_DOCUMENT_ID);
            this._rehydrateEntireFontJsonFromYDoc({
                mergeExistingGlyphs: true
            });
            this._canonicalizeFullStateRawFontJson();
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
            applied = true;
        } finally {
            this._popApplyKind();
        }
        if (applied) {
            this._notifyCoreHydrated();
            this._flushStrandedOutboxes();
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
        const doc = this._requireDocForId(documentId);
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
    setYjsWorkerCallback(cb: YjsWorkerCallback | null): void {
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
        const doc = this._requireDocForId(documentId);
        applyUpdateWithIntegrity(
            doc,
            update,
            documentId,
            SYSTEM_REMOTE_ORIGIN,
            this._brokenScope
        );
        // The whole state of the replaced engine's document.
        this._stateLoadedDocumentIds.add(documentId);
    }

    applyLocalGeneratedYjsUpdate(
        update: YjsUpdate,
        operations: TransactionBufferedOperation[],
        label: string | null,
        historyTarget?: TransactionHistoryTarget | null,
        documentUpdates?: Array<{ documentId: string; update: YjsUpdate }>
    ): TransactionCommitResult | null {
        this._assertLocalWriteAllowed(label ? `edit “${label}”` : 'edit');
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
        // Undivided worker bytes belong to exactly one document; they never
        // go into font-core in place of the documents they were made for.
        if (
            !packets.length &&
            new Set(
                normalizedOperations.map((operation) =>
                    this.documentIdForPath(operation.path)
                )
            ).size !== 1
        ) {
            throw new Error(
                '[PatchSyncEngine] Refusing a worker update that spans several documents without one packet per document'
            );
        }

        const scopeInfo = this._deriveBufferedScope(normalizedOperations);

        const nextHistoryItemId = this._createHistoryItemId();
        const timestamp = Date.now();
        const undoSurfaceAffinity = this._resolveCommitUndoSurfaceAffinity({
            label,
            historyTarget,
            operations: normalizedOperations
        });
        const originatingDrawing =
            this._resolveCommitOriginatingDrawing(normalizedOperations);
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
                    originatingGlyphName: originatingDrawing.glyphName,
                    originatingLayerId: originatingDrawing.layerId
                });
            }
        );

        this._appendChangeLogEntries(changeLogEntries);
        const localUpdateLogIndexBeforeCommit = this._lastLocalUpdateLogIndex;

        this._pushApplyKind(ApplyKind.ManualEmit);
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
                              documentId: uniqueDocumentIds[0],
                              update
                          }
                      ];
            // The worker's bytes never go out themselves: applying them here
            // queues exactly what they changed in this window's documents,
            // and that is what is sent, with the revision stamp added below.
            for (const packet of packetsToApply) {
                const targetDoc = this._requireDocForId(packet.documentId);
                applyUpdateWithIntegrity(
                    targetDoc,
                    packet.update,
                    packet.documentId,
                    this._originForDocument(
                        packet.documentId,
                        scopeInfo.origin
                    ),
                    this._brokenScope
                );
            }
            // Reads back what this window generated and just wrote.
            this._withGlyphModelRebuild(
                'read-back',
                null,
                () => this._syncRemoteJsonFromYDoc(changeLogEntries),
                { silent: true }
            );
            this._onAfterSync?.();
            this._onDirty?.();

            if (
                this._lastLocalUpdateLogIndex ===
                localUpdateLogIndexBeforeCommit
            ) {
                this._lastLocalUpdateLogIndex = this._changeLog.length;
                // Peers fetch glyph shards outside their live set only when
                // the shard's revision changes, like for any other edit.
                // Stamp every touched glyph so the stamp travels in its
                // packet, and publish the revisions on font-core after the
                // glyph packets.
                const glyphIds = [
                    ...new Set(
                        packetsToApply
                            .map((packet) => packet.documentId)
                            .filter((documentId) =>
                                documentId.startsWith('glyph:')
                            )
                            .map((documentId) =>
                                documentId.slice('glyph:'.length)
                            )
                    )
                ];
                this._withGlyphRevisionCatchUp(glyphIds, () => {
                    this._emitLocalUpdateBatch(
                        [
                            ...new Set(
                                packetsToApply.map(
                                    (packet) => packet.documentId
                                )
                            )
                        ]
                            .map((documentId) => ({
                                update: this._takeOutbox(documentId),
                                entries: changeLogEntries,
                                documentId
                            }))
                            .filter(
                                (packet) => !isEmptyYjsUpdate(packet.update)
                            )
                    );
                });
            }
        } finally {
            this._popApplyKind();
        }
        this._flushStrandedOutboxes();

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
                        .map((entry) => deriveDrawingIdFromPath(entry.path))
                        .filter((drawingId): drawingId is string =>
                            Boolean(drawingId)
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
        this._txCompileChangeSource = null;
        this._txCompileEditType = null;
        this._txId = null;
        this._txStartTimeMs = null;
        this._txHistoryItemId = null;
        this._txHistoryTarget = null;
        this._txBufferedOperations = [];
        this._nextTxId = 1;
        this._nextHistoryItemId = 1;
        this._nextCollaborationMessageSequence = 1;
        resetLogCounter();
        this._notifyChangeLogListeners();
        this._notifyCollaborationLogListeners();
    }

    // ── Internal ─────────────────────────────────────────────────

    /**
     * Convert a babelfont JSON path to a Y.Doc path.
     *
     * Glyphs and drawings in Y.Doc are keyed by name/ID (Y.Map) rather than
     * array index. So ["glyphs", 0, "layers", 2, "width"] becomes
     * ["glyphs", "A", "layers", "drawing-uuid", "width"] etc.
     *
     * Since the model already passes human-readable keys (glyph names,
     * drawing IDs) for these segments, this function only needs to ensure
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
     * YJS_ONLY when fast path succeeds: _patchDrawingFromYDoc applies
     * only the touched drawings — no full JSON rebuild.
     * When scope hints are unavailable, the live JSON/model is rebuilt from
     * branch-scoped reads of top-level keys and glyph snapshots, not from a
     * monolithic yDocToJson conversion.
     */
    /**
     * Patch the live babelfontData object from the current Y.Doc state.
     *
     * When `scopeHint` is provided (drawing-scoped undo/redo), only that one
     * drawing is reconstructed from Y.Doc — ~100-1000× faster than a full
     * font rebuild for large fonts. Falls through to the full sync if any
     * Y.Doc path lookup fails.
     *
     * YJS_ONLY when _patchDrawingFromYDoc succeeds for all scopeHints
     * (per-drawing Y.Doc→JSON, no full rebuild).
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
            this._collectDrawingFingerprintSnapshot(fingerprintTargets);

        // Fast path: only reconstruct the touched drawings from Y.Doc.
        if (
            normalizedScopeHints.length > 0 &&
            normalizedScopeHints.every((scopeHint) =>
                this._patchDrawingFromYDoc(scopeHint)
            )
        ) {
            this._syncPatchedDrawingsIntoObjectModel(normalizedScopeHints);
            this._emitDrawingFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectDrawingFingerprintSnapshot(fingerprintTargets)
            );
            return;
        }

        throw new Error(
            'Steady-state Yjs synchronization requires valid drawing scope hints.'
        );
    }

    private _canPatchDrawingFromYDoc(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const glyphMap = this._glyphMapForName(scopeHint.glyphName);
        const drawingsMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const glyph = (this._fontJson as Unsafe)?.glyphs?.find(
            (candidate: Unsafe) => candidate?.name === scopeHint.glyphName
        );
        return (
            drawingsMap instanceof Y.Map &&
            drawingsMap.get(scopeHint.layerId) instanceof Y.Map &&
            glyph?.layers?.some(
                (drawing: Unsafe) => drawing?.id === scopeHint.layerId
            )
        );
    }

    private _patchDrawingFromYDoc(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const patched = this._patchDrawingFromYDocInner(scopeHint);
        if (patched) {
            this._noteGlyphModelRebuilt([scopeHint.glyphName]);
        }
        return patched;
    }

    private _patchDrawingFromYDocInner(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const glyphMap = this._glyphMapForName(scopeHint.glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return false;
        }

        const drawingsMap = glyphMap.get('layers');
        if (!(drawingsMap instanceof Y.Map)) {
            return false;
        }

        const drawingMap = drawingsMap.get(scopeHint.layerId);
        if (!(drawingMap instanceof Y.Map)) {
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

        const drawings = glyphs[glyphIdx].layers as Unsafe[] | undefined;
        const drawingIdx =
            drawings?.findIndex((l: Unsafe) => l.id === scopeHint.layerId) ??
            -1;
        if (drawingIdx < 0 || !drawings) {
            return false;
        }

        const patchedDrawing = this._cloneRuntimeValue(
            // The stored drawing alone: a key it no longer has leaves the
            // font JSON drawing too (see `fromStore`).
            this._normalizeDrawingSnapshot(
                scopeHint.layerId,
                fromYDrawing(drawingMap),
                undefined,
                false,
                undefined,
                true
            )
        ) as Unsafe;

        if (
            drawings[drawingIdx] &&
            typeof drawings[drawingIdx] === 'object' &&
            !Array.isArray(drawings[drawingIdx]) &&
            patchedDrawing &&
            typeof patchedDrawing === 'object' &&
            !Array.isArray(patchedDrawing)
        ) {
            this._assignJsonObjectInPlace(
                drawings[drawingIdx] as Record<string, unknown>,
                patchedDrawing as Record<string, unknown>
            );
        } else {
            drawings[drawingIdx] = patchedDrawing;
        }
        return true;
    }

    /**
     * Show another window's uncommitted drawings in this window's model
     * without recording a change or touching the documents. The commit that
     * follows replaces them; `revertLivePreviewDrawings` undoes them.
     */
    applyLivePreviewDrawings(
        records: Array<{
            glyphName: string;
            layerId: string;
            layerData: Babelfont.Layer;
        }>
    ): void {
        const fontModel = (window as Unsafe).fontManager?.currentFont
            ?.fontModel;
        if (!fontModel) {
            return;
        }
        withSuppressedModelRecording(() => {
            for (const record of records) {
                const modelDrawing = fontModel
                    .findGlyph?.(record.glyphName)
                    ?.findDrawingById?.(record.layerId);
                const data = record.layerData as Unsafe;
                if (
                    !modelDrawing ||
                    typeof modelDrawing.syncFromEditorDrawingData !== 'function'
                ) {
                    continue;
                }
                modelDrawing.syncFromEditorDrawingData({
                    width: data.width,
                    ...(data.height !== undefined
                        ? { height: data.height }
                        : {}),
                    ...(data.vertWidth !== undefined
                        ? { vertWidth: data.vertWidth }
                        : {}),
                    ...(data.shapes !== undefined
                        ? { shapes: data.shapes }
                        : {}),
                    ...(data.anchors !== undefined
                        ? { anchors: data.anchors }
                        : {}),
                    ...(data.guides !== undefined
                        ? { guides: data.guides }
                        : {}),
                    ...(data.format_specific !== undefined
                        ? { format_specific: data.format_specific }
                        : {})
                });
                modelDrawing.invalidateContentCaches?.();
            }
        });
    }

    /** The model drawings go back to what the documents hold. */
    /**
     * A drawing as its document holds it, decoded to drawing JSON, or null
     * when the document holds no such drawing. For diagnostics: it leaves the stored JSON and the model alone.
     */
    readStoredDrawing(
        glyphName: string,
        drawingId: string
    ): Record<string, unknown> | null {
        const drawingsMap = this._glyphMapForName(glyphName)?.get('layers');
        const drawingMap =
            drawingsMap instanceof Y.Map ? drawingsMap.get(drawingId) : null;
        if (!(drawingMap instanceof Y.Map)) {
            return null;
        }
        // A drawing that breaks an invariant throws here too: diagnostics
        // must show the damage, not hide it.
        return this._normalizeDrawingSnapshot(
            drawingId,
            fromYDrawing(drawingMap),
            undefined,
            false,
            undefined,
            true
        ) as Record<string, unknown>;
    }

    /**
     * Where a model drawing departs from what its document holds, in words,
     * or null when they match (fuzz and e2e diagnostics).
     */
    describeStoredDrawingDrift(
        glyphName: string,
        drawingId: string,
        modelDrawing: unknown
    ): { stored: string; model: string; difference: string | null } {
        const stored = this.readStoredDrawing(glyphName, drawingId);
        return {
            stored: drawingFingerprint(stored),
            model: drawingFingerprint(modelDrawing),
            difference: describeDrawingDifference(
                canonicalDrawing(modelDrawing),
                canonicalDrawing(stored)
            )
        };
    }

    /** The touched drawings of a remote update, as stored after it (collab-trace.ts). */
    private _traceRemoteUpdate(
        kind: string,
        documentId: string,
        entries: ChangeLogEntry[],
        options?: ApplyRemoteUpdateOptions
    ): void {
        const drawings = new Map<string, string>();
        const glyphNames = new Set<string>();
        for (const entry of entries) {
            const path = String(entry.path || '');
            const glyphName = this._deriveGlyphNameFromPath(path);
            if (!glyphName) {
                continue;
            }
            glyphNames.add(glyphName);
            const drawingId = this._deriveDrawingIdFromPath(path);
            if (drawingId) {
                drawings.set(`${glyphName}/${drawingId}`, '');
            }
        }
        const glyphs = Array.isArray((this._fontJson as Unsafe)?.glyphs)
            ? ((this._fontJson as Unsafe).glyphs as Unsafe[])
            : [];
        for (const key of drawings.keys()) {
            const [glyphName, drawingId] = key.split('/');
            drawings.set(
                key,
                drawingFingerprint(
                    glyphs
                        .find((glyph) => glyph?.name === glyphName)
                        ?.layers?.find(
                            (drawing: Unsafe) => drawing?.id === drawingId
                        )
                )
            );
        }
        recordCollabTrace(kind, glyphNames, {
            document: documentId,
            fromCollaborator: !!options?.fromCollaborator,
            fromLinkedWindow: !!options?.fromLinkedWindow,
            paths: [
                ...new Set(
                    entries.map((entry) =>
                        String(entry.path || '')
                            .split(':')
                            .slice(0, 2)
                            .join(':')
                    )
                )
            ],
            stored: Object.fromEntries(drawings)
        });
    }

    /**
     * Write drawings the model shows ahead of the documents into them, and
     * send them. For a collaborator cascade whose stored result never caught
     * up with its sources: two windows recomposed one composite at once,
     * each from a view missing the other's source edit, and the stale write
     * won. Every window that saw both edits writes the same drawing.
     *
     * Outside the undo history: nobody here made this edit. Returns the
     * drawings written; one the documents already match is skipped.
     */
    writeLivePreviewDrawings(
        targets: Array<{ glyphName: string; layerId: string }>
    ): Array<{ glyphName: string; layerId: string }> {
        this._assertLocalWriteAllowed('edit');
        const fontModel = (window as Unsafe).fontManager?.currentFont
            ?.fontModel;
        if (!fontModel || !this._fontJson) {
            return [];
        }
        // Suspend LRU glyph-doc eviction for the batch so waking >64 target
        // glyphs cannot destroy earlier woken docs before their writes land.
        this._glyphEvictionSuspendDepth += 1;
        try {
            // What differs from the documents, by glyph document.
            const pendingWrites = new Map<
                string,
                Array<{
                    target: { glyphName: string; layerId: string };
                    drawingMap: Y.Map<unknown>;
                    record: Record<string, unknown>;
                }>
            >();
            for (const target of targets) {
                const glyphId = this._glyphIdByName.get(target.glyphName);
                const doc = glyphId ? this._wakeGlyphDoc(glyphId) : undefined;
                const drawingMap = (
                    doc?.getMap('glyph').get('layers') as
                        Y.Map<unknown> | undefined
                )?.get(target.layerId);
                const modelDrawing = fontModel
                    .findGlyph?.(target.glyphName)
                    ?.findDrawingById?.(target.layerId);
                if (
                    !glyphId ||
                    !doc ||
                    !(drawingMap instanceof Y.Map) ||
                    !modelDrawing
                ) {
                    continue;
                }
                const record = (
                    typeof modelDrawing.toJSON === 'function'
                        ? modelDrawing.toJSON()
                        : modelDrawing
                ) as Record<string, unknown>;
                if (
                    drawingFingerprint(record) ===
                    drawingFingerprint(fromYDrawing(drawingMap))
                ) {
                    continue;
                }
                const writes = pendingWrites.get(glyphId) ?? [];
                writes.push({ target, drawingMap, record });
                pendingWrites.set(glyphId, writes);
            }
            const written: Array<{ glyphName: string; layerId: string }> = [];
            if (!pendingWrites.size) {
                return written;
            }
            for (const glyphId of pendingWrites.keys()) {
                assertDocumentWritable(
                    this._glyphDocs.get(glyphId)!,
                    glyphDocumentId(glyphId),
                    this._brokenScope
                );
            }
            // One commit, stamped with glyph revisions like any commit: windows
            // that keep no socket for these glyphs learn of the writes from the
            // revision feed, and fetch them. One packet per glyph document.
            this._withGlyphRevisionCatchUp([...pendingWrites.keys()], () => {
                for (const [glyphId, writes] of pendingWrites) {
                    const doc = this._glyphDocs.get(glyphId)!;
                    this._transactOrMarkBroken(
                        doc,
                        glyphDocumentId(glyphId),
                        () => {
                            for (const { drawingMap, record } of writes) {
                                this._replaceDrawingMapContents(
                                    drawingMap,
                                    cloneHistoryValue(record) as Record<
                                        string,
                                        unknown
                                    >
                                );
                            }
                        },
                        LAYOUT_FORWARD_ORIGIN
                    );
                    const entries = writes.map(({ target, record }) =>
                        createLogEntry({
                            timestamp: Date.now(),
                            windowId: this.windowId,
                            windowRoleLabel: this._getWindowRoleLabel(),
                            historyItemId: this._createHistoryItemId(),
                            historyAction: 'change',
                            transactionLabel: 'Settle collaborator cascade',
                            transactionId: null,
                            op: 'set',
                            undoScope: 'layer',
                            path: joinPathWithGlyphSeparator([
                                'glyphs',
                                target.glyphName,
                                'layers',
                                target.layerId
                            ]),
                            oldValue: undefined,
                            newValue: cloneHistoryValue(record),
                            replayOldValue: undefined,
                            replayNewValue: undefined,
                            compileChangeSource: 'remote-cascade-preview',
                            compileEditType: 'anchor'
                        })
                    );
                    // Emitted, not committed: the change log, and so undo, never
                    // holds it.
                    this._emitLocalUpdate(
                        this._takeOutbox(glyphDocumentId(glyphId)),
                        entries,
                        glyphDocumentId(glyphId)
                    );
                }
            });
            // Reads back what the model just wrote.
            this._withGlyphModelRebuild(
                'read-back',
                null,
                () => {
                    for (const writes of pendingWrites.values()) {
                        for (const { target } of writes) {
                            this._patchDrawingFromYDoc(target);
                            written.push(target);
                        }
                    }
                },
                { silent: true }
            );
            return written;
        } finally {
            this._glyphEvictionSuspendDepth -= 1;
            if (this._glyphEvictionSuspendDepth === 0) {
                this._evictIdleLiveGlyphDocs(
                    PatchSyncEngine.MAX_LIVE_GLYPH_DOCS
                );
            }
        }
    }

    /** True when the model shows this drawing other than its document. */
    livePreviewDrawingDiffers(target: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const fontModel = (window as Unsafe).fontManager?.currentFont
            ?.fontModel;
        const glyphId = this._glyphIdByName.get(target.glyphName);
        const doc = glyphId ? this._wakeGlyphDoc(glyphId) : undefined;
        const drawingMap = (
            doc?.getMap('glyph').get('layers') as Y.Map<unknown> | undefined
        )?.get(target.layerId);
        const modelDrawing = fontModel
            ?.findGlyph?.(target.glyphName)
            ?.findDrawingById?.(target.layerId);
        if (!(drawingMap instanceof Y.Map) || !modelDrawing) {
            return false;
        }
        const record =
            typeof modelDrawing.toJSON === 'function'
                ? modelDrawing.toJSON()
                : modelDrawing;
        return (
            drawingFingerprint(record) !==
            drawingFingerprint(fromYDrawing(drawingMap))
        );
    }

    revertLivePreviewDrawings(
        targets: Array<{ glyphName: string; layerId: string }>
    ): void {
        // The Yjs documents are the authority; the stored JSON may share
        // objects with the model drawings the preview just replaced.
        for (const target of targets) {
            this._patchDrawingFromYDoc(target);
        }
        this._syncPatchedDrawingsIntoObjectModel(targets);
    }

    private _syncPatchedDrawingsIntoObjectModel(
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
                const modelDrawing = fontModel
                    .findGlyph?.(scopeHint.glyphName)
                    ?.findDrawingById?.(scopeHint.layerId);
                const storedDrawing = glyphs
                    .find((glyph) => glyph?.name === scopeHint.glyphName)
                    ?.layers?.find(
                        (drawing: Unsafe) => drawing?.id === scopeHint.layerId
                    );
                if (!modelDrawing || !storedDrawing) {
                    continue;
                }

                if (
                    typeof modelDrawing.syncFromEditorDrawingData === 'function'
                ) {
                    modelDrawing.syncFromEditorDrawingData({
                        width: storedDrawing.width,
                        ...(storedDrawing.height !== undefined
                            ? { height: storedDrawing.height }
                            : {}),
                        ...(storedDrawing.vertWidth !== undefined
                            ? { vertWidth: storedDrawing.vertWidth }
                            : {}),
                        ...(storedDrawing.shapes !== undefined
                            ? { shapes: storedDrawing.shapes }
                            : {}),
                        ...(storedDrawing.anchors !== undefined
                            ? { anchors: storedDrawing.anchors }
                            : {}),
                        ...(storedDrawing.guides !== undefined
                            ? { guides: storedDrawing.guides }
                            : {}),
                        ...(storedDrawing.format_specific !== undefined
                            ? { format_specific: storedDrawing.format_specific }
                            : {})
                    });
                    modelDrawing.invalidateContentCaches?.();
                    continue;
                }

                const rawDrawingData = modelDrawing.toJSON?.();
                if (rawDrawingData && typeof rawDrawingData === 'object') {
                    Object.assign(rawDrawingData, storedDrawing);
                }
                modelDrawing.invalidateContentCaches?.();
            }
        });
    }

    private _syncPatchedDrawingTargetsFromYDoc(
        scopeHints: Array<{ glyphName: string; layerId: string }>
    ): void {
        const normalizedScopeHints = normalizeWorkerReplayTargets(scopeHints);
        if (!normalizedScopeHints.length || !this._fontJson) {
            return;
        }

        const previousFingerprintSnapshot =
            this._collectDrawingFingerprintSnapshot(normalizedScopeHints);
        const patchedScopeHints = normalizedScopeHints.filter((scopeHint) =>
            this._patchDrawingFromYDoc(scopeHint)
        );
        if (!patchedScopeHints.length) {
            return;
        }

        this._syncPatchedDrawingsIntoObjectModel(patchedScopeHints);
        this._emitDrawingFingerprintChangedEvents(
            previousFingerprintSnapshot,
            this._collectDrawingFingerprintSnapshot(normalizedScopeHints)
        );
    }

    /** Explicit history wipe: drops every undo and redo target. Rebaseline must not call this implicitly. */
    truncateUndoHistory(): void {
        this._changeLog = [];
        this._historyGlyphNames = null;
        this._lastLocalUpdateLogIndex = 0;
        this._lastBroadcastLogIndex = 0;
        this._notifyChangeLogListeners();
    }

    mergeRemoteUpdates(updates: Uint8Array[]): void {
        if (!updates.length) {
            return;
        }
        this._withGlyphModelRebuild('remote-update', null, () =>
            this._mergeRemoteUpdates(updates)
        );
    }

    private _mergeRemoteUpdates(updates: Uint8Array[]): void {
        if (!updates.length) {
            return;
        }
        this._pushApplyKind(ApplyKind.Remote);
        try {
            for (const update of updates) {
                if (update?.byteLength) {
                    applyUpdateWithIntegrity(
                        this.yDoc,
                        update,
                        FONT_CORE_DOCUMENT_ID,
                        SYSTEM_REMOTE_ORIGIN,
                        this._brokenScope
                    );
                }
            }
            this._rehydrateEntireFontJsonFromYDoc();
        } finally {
            this._popApplyKind();
        }
    }

    private _deriveUndoScope(
        glyphName: string | null,
        drawingId: string | null
    ): UndoScope {
        if (!glyphName) {
            return 'font';
        }
        if (drawingId) {
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

    private _resolveCommitOriginatingDrawing(
        operations: TransactionBufferedOperation[]
    ): { glyphName: string | null; layerId: string | null } {
        let contextSurface: HistoryUndoSurface | null = null;
        let contextGlyphName: string | null = null;
        let contextDrawingId: string | null = null;
        try {
            const context = getUndoRedoContext();
            contextSurface = context.surface;
            contextGlyphName = context.undoGlyphName ?? null;
            contextDrawingId = context.undoDrawingId ?? null;
        } catch {
            contextSurface = null;
        }
        return resolveCommitOriginatingDrawing({
            contextSurface,
            contextGlyphName,
            contextDrawingId,
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

    /**
     * A refused commit wrote nothing to any document; only the model still
     * shows it. Read the model back from the documents and tell the plugin.
     */
    private _rejectLocalCollabSubmit(decision: CollabSubmitDecision): void {
        this._withGlyphModelRebuild('submit-refused', null, () =>
            this._rehydrateEntireFontJsonFromYDoc()
        );
        this._onAfterSync?.();
        const plugin = this._collabSubmitPlugin();
        if (typeof plugin?.notifyCollabSubmitRejected === 'function') {
            plugin.notifyCollabSubmitRejected(decision);
        }
    }

    /** Every room a commit's operations write, in first-write order. */
    private _documentIdsTouchedByOperations(
        operations: TransactionBufferedOperation[]
    ): Set<string> {
        const docsTouched = new Set<string>();
        for (const operation of operations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const documentId = this.documentIdForPath(applyPath);
            docsTouched.add(documentId);
            for (const extraId of this._extraLayoutDocumentIds(applyPath)) {
                this._ensureLayoutDoc(extraId);
                docsTouched.add(extraId);
            }
            if (isLayoutDocumentId(documentId)) {
                this._ensureLayoutDoc(documentId);
            }
            if (operation.op === 'remove' && this._isGlyphRootPath(applyPath)) {
                docsTouched.add(FONT_CORE_DOCUMENT_ID);
            }
        }
        return docsTouched;
    }

    /**
     * The submit limits judged before a commit writes anything: per room,
     * the JSON size of the values it writes, and when that is past the
     * packet limit, the largest single value (an update that large travels
     * as several room transactions, split between values). The room's size
     * counts the values it replaces as gone: the cloud collects them.
     */
    private _estimateCommitSubmitRequests(
        operations: TransactionBufferedOperation[]
    ): CollabSubmitRequest[] {
        const byDocument = new Map<
            string,
            { total: number; leaf: number; replaced: number }
        >();
        for (const operation of operations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const value =
                operation.applyNewValue === undefined
                    ? operation.newValue
                    : operation.applyNewValue;
            const size = byDocument.get(this.documentIdForPath(applyPath)) ?? {
                total: 0,
                leaf: 0,
                replaced: 0
            };
            size.total += jsonByteLength(value) + jsonByteLength(applyPath);
            size.leaf = Math.max(size.leaf, largestLeafByteLength(value));
            size.replaced += jsonByteLength(
                operation.applyOldValue === undefined
                    ? operation.oldValue
                    : operation.applyOldValue
            );
            byDocument.set(this.documentIdForPath(applyPath), size);
        }
        return [...byDocument].map(([documentId, size]) => {
            const doc = this._docForId(documentId);
            const packetBytes =
                size.total < MAX_YJS_PACKET_BYTES ? size.total : size.leaf;
            const measured = measureShardBytesForSubmit({
                lastEncodedBytes:
                    this._lastEncodedShardBytes.get(documentId) || 0,
                packetBytes: size.total,
                encodeFullShard: () =>
                    doc
                        ? Math.max(
                              0,
                              collectedEncodedByteLength(doc) +
                                  size.total -
                                  size.replaced
                          )
                        : size.total
            });
            return {
                documentId,
                packetBytes,
                shardBytes: measured.shardBytes
            };
        });
    }

    /**
     * A throw inside a local write that already wrote leaves its document
     * part written and unsendable: the document is marked broken and the
     * error rethrown. A refusal before anything was written leaves the
     * document whole; it is only rethrown.
     */
    private _transactOrMarkBroken(
        doc: Y.Doc,
        documentId: string,
        write: () => void,
        origin: unknown
    ): void {
        const seen: { transaction: Y.Transaction | null } = {
            transaction: null
        };
        try {
            doc.transact((transaction) => {
                seen.transaction = transaction;
                write();
            }, origin);
        } catch (error) {
            if (
                seen.transaction &&
                transactionWroteSomething(doc, seen.transaction)
            ) {
                this.markDocumentBroken(
                    documentId,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
            throw error;
        }
    }

    private _queueOrCommitOperations(
        operations: TransactionBufferedOperation[],
        label?: string | null,
        skipTransactionFinalizer = false,
        commitImmediately = false
    ): TransactionCommitResult | null {
        const normalizedOperations = operations
            .filter((operation) => operation.path.length > 0)
            .map((operation) => this._normalizeBufferedOperation(operation));
        if (!normalizedOperations.length) {
            return null;
        }

        if (this._txDepth > 0 && !commitImmediately) {
            // Clone values before buffering — the model may mutate while the
            // transaction is still open.
            this._txBufferedOperations.push(
                ...normalizedOperations.map((op) =>
                    this._cloneBufferedOperation(op)
                )
            );
            return null;
        }

        const inOpenTransaction = this._txDepth > 0;
        return this._commitOperations(
            normalizedOperations,
            label ?? this._txLabel ?? null,
            inOpenTransaction ? this._txId : null,
            inOpenTransaction ? this._txHistoryItemId : null,
            inOpenTransaction ? this._txHistoryTarget : undefined,
            inOpenTransaction ? this._txPromptGroupId : undefined,
            inOpenTransaction ? this._txHistorySummary : undefined,
            skipTransactionFinalizer
        );
    }

    private _shouldPersistCloudWalBeforeApply(
        _cloudWalApplyToken?: string | null
    ): boolean {
        // Byte-less prepared WAL rows are gone; durability is one post-apply
        // WAL row with update bytes.
        return false;
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
        const walToken =
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `wal:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        const documentUpdates = documentIds.map((documentId) => {
            const doc = this._docForId(documentId);
            return {
                documentId,
                baseStateVectorBase64: doc
                    ? bytesToBase64(Y.encodeStateVector(doc))
                    : ''
            };
        });
        const glyphIds = this._glyphIdsTouchedByOperations(operations);
        // The prepared row is written before the commit has entries: its
        // envelope names the transaction, the entries come with its packets.
        const envelope: CollaborationMessageEnvelope = {
            schemaVersion: 1 as const,
            transactionId: walToken,
            localSequence: this._nextCollaborationMessageSequence,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'font' as const,
                changedGlyphNames: [],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: historyItemId || walToken,
                historyAction: 'change' as const,
                undoScope: 'font' as const
            },
            source: 'change-bridge',
            label,
            summary: historySummary || '',
            windowId: this.windowId,
            timestamp: Date.now()
        };
        envelope.transactionId = walToken;
        const persistedPrepared =
            (await window.cloudPlugin?.persistPreparedCloudTransaction?.({
                transactionId: walToken,
                documentId: documentIds[0] || FONT_CORE_DOCUMENT_ID,
                operations: operations.map((operation) => ({
                    op: operation.op,
                    path: operation.path,
                    oldValue: operation.oldValue,
                    newValue: operation.newValue,
                    applyPath: operation.applyPath,
                    applyNewValue: operation.applyNewValue,
                    applyOldValue: operation.applyOldValue,
                    applyMode: operation.applyMode
                })),
                documentUpdates,
                collaborationMessage: envelope,
                revisionObligations: glyphIds.length
                    ? [
                          {
                              kind: 'glyph-revision-publication' as const,
                              glyphIds,
                              published: false
                          }
                      ]
                    : [],
                state: 'prepared'
            })) ??
            (await window.cloudPlugin?.persistCloudMutationIntent?.(
                documentIds,
                new TextEncoder().encode(
                    JSON.stringify({
                        documentIds,
                        operationCount: operations.length,
                        paths: operations.map((operation) => operation.path),
                        operations
                    })
                )
            ));
        this._lastCloudCommitDebug = {
            documentIds,
            operationCount: operations.length,
            persisted: persistedPrepared
        };
        pushCollabIntegrityEvent('wal-before-apply', {
            documentIds,
            operationCount: operations.length,
            persisted: persistedPrepared
        });
        if (persistedPrepared === false) {
            console.warn(
                'PatchSyncEngine: cloud write-ahead persist failed; local apply skipped'
            );
            return;
        }
        this._cloudWalApplyTokens.add(walToken);
        try {
            this._commitOperations(
                operations,
                label,
                transactionId,
                historyItemId,
                historyTarget,
                promptGroupId,
                historySummary,
                skipTransactionFinalizer,
                walToken
            );
            await this._cloudEmitPersistChain;
            this._lastCloudCommitDebug = {
                ...this._lastCloudCommitDebug,
                applied: true
            };
        } finally {
            this._cloudWalApplyTokens.delete(walToken);
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
            compileChangeSource: operation.compileChangeSource,
            compileEditType: operation.compileEditType,
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
            compileChangeSource: operation.compileChangeSource,
            compileEditType: operation.compileEditType,
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

    /**
     * One history row for every document this commit touches. Shard packets
     * still go out separately; they are not additional collaboration commits.
     */
    private _appendCommitCollaborationItem(
        entries: ChangeLogEntry[],
        packets: Array<{ documentId: string; update: YjsUpdate }>
    ): void {
        if (!packets.length) {
            return;
        }
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(entries, {
                localSequence: this._nextCollaborationMessageSequence++,
                source: 'change-bridge',
                windowId: this.windowId
            });
        const representative =
            packets.find(
                (packet) => packet.documentId === FONT_CORE_DOCUMENT_ID
            ) ?? packets[0];
        this._appendCollaborationLogItems([
            this._createCollaborationLogItem(
                collaborationMessage,
                representative.update,
                'local',
                this._deriveForwardChangesFromChangeLogEntries(entries)
            )
        ]);
    }

    private _commitOperations(
        operations: TransactionBufferedOperation[],
        label: string | null,
        transactionId: number | null,
        historyItemId?: string | null,
        historyTarget?: TransactionHistoryTarget | null,
        promptGroupId?: string | null,
        historySummary?: string | null,
        skipTransactionFinalizer = false,
        cloudWalApplyToken: string | null = null
    ): TransactionCommitResult | null {
        this._commitDepth += 1;
        try {
            return this._commitOperationsInner(
                operations,
                label,
                transactionId,
                historyItemId,
                historyTarget,
                promptGroupId,
                historySummary,
                skipTransactionFinalizer,
                cloudWalApplyToken
            );
        } finally {
            this._commitDepth -= 1;
        }
    }

    private _commitOperationsInner(
        operations: TransactionBufferedOperation[],
        label: string | null,
        transactionId: number | null,
        historyItemId: string | null | undefined,
        historyTarget: TransactionHistoryTarget | null | undefined,
        promptGroupId: string | null | undefined,
        historySummary: string | null | undefined,
        skipTransactionFinalizer: boolean,
        cloudWalApplyToken: string | null
    ): TransactionCommitResult | null {
        const normalizedOperations = operations.filter(
            (operation) => operation.path.length > 0
        );
        const hasIntents = Object.keys(this._txIntents).length > 0;
        if (!normalizedOperations.length && !hasIntents) {
            return null;
        }
        if (!this._isApplyingRemote && this._readOnlyReason !== null) {
            // Refused before anything is written. The model already shows
            // the edit, so it is read back from the documents first, as a
            // refused collaboration submit is (_rejectLocalCollabSubmit).
            this._withGlyphModelRebuild('read-only-refused', null, () =>
                this._rehydrateEntireFontJsonFromYDoc()
            );
            this._onAfterSync?.();
            this._assertLocalWriteAllowed(label ? `edit “${label}”` : 'edit');
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
                    historyTarget: historyTarget ?? this._txHistoryTarget,
                    intents: this._txIntents
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

        // Snapshot-mode operations carry a full drawing/glyph object and are
        // always material changes, so skip the no-op reduction. Default-mode
        // property changes (e.g. feature code edits) may be no-ops and still
        // need the reduction to filter them out.
        const skipNoOpReduction =
            finalizedOperations.length === 1 &&
            (finalizedOperations[0].applyMode === 'font-snapshot' ||
                finalizedOperations[0].applyMode === 'drawing-snapshot' ||
                finalizedOperations[0].applyMode === 'glyph-snapshot');
        const hasPythonSyntheticOps = finalizedOperations.some(
            (operation) =>
                operation.editSource === 'python' ||
                operation.editSource === 'assistant'
        );
        const effectiveOperations =
            skipNoOpReduction || hasPythonSyntheticOps
                ? finalizedOperations
                : this._reduceToNetChangingOperations(finalizedOperations);
        if (!effectiveOperations.length) {
            return null;
        }

        if (this._shouldPersistCloudWalBeforeApply(cloudWalApplyToken)) {
            this._cloudWalCommitChain = this._cloudWalCommitChain
                .then(() =>
                    this._commitOperationsAfterCloudWal(
                        effectiveOperations,
                        label,
                        transactionId,
                        historyItemId,
                        historyTarget,
                        promptGroupId,
                        historySummary,
                        skipTransactionFinalizer
                    )
                )
                .then(
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
        const originatingDrawing =
            this._resolveCommitOriginatingDrawing(effectiveOperations);
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
                    deriveDrawingId(operation.path)
                ),
                undoSurfaceAffinity,
                path: joinPathWithGlyphSeparator(operation.path),
                oldValue: operation.oldValue,
                newValue: operation.newValue,
                editSource: operation.editSource ?? null,
                compileChangeSource:
                    operation.compileChangeSource ??
                    this._txCompileChangeSource,
                compileEditType:
                    operation.compileEditType !== undefined
                        ? operation.compileEditType
                        : this._txCompileEditType,
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
                originatingGlyphName: originatingDrawing.glyphName,
                originatingLayerId: originatingDrawing.layerId
            });
            changeLogEntries.push(entry);
        }

        const routedOperations =
            this._routeOperationsThroughPendingRenames(effectiveOperations);
        // Permission is decided before anything is written: a refused commit
        // never reaches a document, so it leaves no clock behind unsent.
        if (!this._isApplyingRemote) {
            const decision = this._askCollabSubmitPermission(
                this._estimateCommitSubmitRequests(routedOperations)
            );
            if (!decision.allowed) {
                this._rejectLocalCollabSubmit(decision);
                return null;
            }
        }

        // A write into a glyph without a document throws here, before the
        // change log records a commit no document received.
        this._ensureDocumentsForOperations(routedOperations);
        this._appendChangeLogEntries(changeLogEntries);

        const glyphNameRemaps = routedOperations.flatMap((operation) => {
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

        const docsTouched =
            this._documentIdsTouchedByOperations(routedOperations);
        for (const documentId of docsTouched) {
            assertDocumentWritable(
                this._requireDocForId(documentId),
                documentId,
                this._brokenScope
            );
        }

        const revisionTokensForCommit = this._isApplyingRemote
            ? []
            : this._allocateGlyphRevisionTokens(
                  this._glyphIdsTouchedByOperations(routedOperations)
              );
        const revisionByGlyphId = new Map(
            revisionTokensForCommit.map((token) => [
                token.glyphId,
                token.revision
            ])
        );
        this._pushApplyKind(ApplyKind.ManualEmit);
        try {
            for (const documentId of docsTouched) {
                const doc = this._requireDocForId(documentId);
                const opsForDoc = routedOperations.filter((operation) => {
                    const applyPath = this._toYDocPath(
                        operation.applyPath ?? operation.path
                    );
                    return this.documentIdForPath(applyPath) === documentId;
                });
                const geometryOps = this._dropObsoletePositionWrites(opsForDoc);
                const glyphIdForDoc = glyphIdFromDocumentId(documentId);
                const stampRevision = glyphIdForDoc
                    ? revisionByGlyphId.get(glyphIdForDoc)
                    : undefined;
                this._transactOrMarkBroken(
                    doc,
                    documentId,
                    () => {
                        for (const operation of geometryOps) {
                            this._applyBufferedOperation(operation);
                        }
                        if (stampRevision && glyphIdForDoc) {
                            const sync = doc.getMap(GLYPH_SYNC_MAP_KEY);
                            sync.set(GLYPH_SYNC_REVISION_KEY, stampRevision);
                            const catalog = catalogFromCoreJson(
                                this._fontJson as Record<string, unknown>
                            )?.glyphCatalog;
                            const generation =
                                catalog?.[glyphIdForDoc]?.generation;
                            if (
                                generation != null &&
                                sync.get('generation') !== generation
                            ) {
                                sync.set('generation', generation);
                            }
                        }
                    },
                    this._originForDocument(documentId, scopeInfo.origin)
                );
            }
        } finally {
            this._popApplyKind();
        }

        // Every commit is sent, a commit made while a remote update applies
        // included: each touched room's packet is its queued updates.
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._catalogDeferDepth += 1;
        const persistChainBeforeEmit = this._cloudEmitPersistChain;
        try {
            // Only glyphs that send a packet: a token that never reaches
            // the feed would hold its commit's others back at peers.
            const sentDocumentIds = new Set(
                [...docsTouched].filter((documentId) =>
                    this.hasUnsentLocalUpdates(documentId)
                )
            );
            this._withGlyphRevisionCatchUp(
                this._glyphIdsTouchedByOperations(routedOperations).filter(
                    (glyphId) => sentDocumentIds.has(`glyph:${glyphId}`)
                ),
                () => {
                    const uiPackets: Array<{
                        update: YjsUpdate;
                        entries: ChangeLogEntry[];
                        documentId: string;
                        options: { skipCollaborationLog: true };
                    }> = [];
                    for (const documentId of docsTouched) {
                        const update = this._takeOutbox(documentId);
                        if (isEmptyYjsUpdate(update)) {
                            // A room a whole-value write could reach but
                            // did not.
                            continue;
                        }
                        // A glyph the commit deleted may have left; its
                        // queued updates are sent all the same.
                        const doc = this._docForId(documentId);
                        if (doc) {
                            const measured = measureShardBytesForSubmit({
                                lastEncodedBytes:
                                    this._lastEncodedShardBytes.get(
                                        documentId
                                    ) || 0,
                                packetBytes: update.byteLength,
                                encodeFullShard: () =>
                                    collectedEncodedByteLength(doc)
                            });
                            this._lastEncodedShardBytes.set(
                                documentId,
                                measured.shardBytes
                            );
                        }
                        const docEntries = changeLogEntries.filter(
                            (_entry, index) => {
                                const operation = routedOperations[index];
                                const applyPath = this._toYDocPath(
                                    operation.applyPath ?? operation.path
                                );
                                return (
                                    this.documentIdForPath(applyPath) ===
                                    documentId
                                );
                            }
                        );
                        uiPackets.push({
                            update,
                            // A document that changed with no entries of
                            // its own (an observer or stamp write) is
                            // described whole, never by another
                            // document's paths.
                            entries: docEntries.length
                                ? docEntries
                                : [
                                      this._wholeDocumentEntry(
                                          documentId,
                                          label ?? 'Document update'
                                      )
                                  ],
                            documentId,
                            options: { skipCollaborationLog: true }
                        });
                    }
                    this._appendCommitCollaborationItem(
                        changeLogEntries,
                        uiPackets
                    );
                    this._emitLocalUpdateBatch(uiPackets);
                }
            );
        } finally {
            const persistChainAfterEmit = this._cloudEmitPersistChain;
            const releaseCatalogDefer = (): void => this._releaseCatalogDefer();
            if (persistChainAfterEmit !== persistChainBeforeEmit) {
                persistChainAfterEmit.then(
                    releaseCatalogDefer,
                    releaseCatalogDefer
                );
            } else {
                releaseCatalogDefer();
            }
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
            // The commit reads back what it just wrote.
            this._withGlyphModelRebuild(
                'read-back',
                null,
                () => this._syncRemoteJsonFromYDoc(changeLogEntries),
                { silent: true }
            );
        }

        this._flushDestroyedGlyphDocs();
        this._onDirty?.();

        if (this._liveBurstDrawings.size > 0 && !this._isApplyingRemote) {
            this._finalizeLiveBursts(
                changeLogEntries
                    .map((entry) => deriveDrawingIdFromPath(entry.path))
                    .filter((drawingId): drawingId is string =>
                        Boolean(drawingId)
                    ),
                nextHistoryItemId
            );
        }

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
                        .map((entry) => deriveDrawingIdFromPath(entry.path))
                        .filter((drawingId): drawingId is string =>
                            Boolean(drawingId)
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
        const drawingId = deriveDrawingId(applyPath);

        if (glyphName && drawingId) {
            return [{ glyphName, layerId: drawingId }];
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

        const drawings = Array.isArray((glyphSnapshot as Unsafe).layers)
            ? ((glyphSnapshot as Unsafe).layers as Unsafe[])
            : [];
        return normalizeWorkerReplayTargets(
            drawings.map((drawing) => {
                const snapshotDrawingId =
                    drawing && typeof drawing === 'object'
                        ? String(drawing.id || '')
                        : '';
                return snapshotDrawingId
                    ? {
                          glyphName,
                          layerId: snapshotDrawingId
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
                first: TransactionBufferedOperation;
                last: TransactionBufferedOperation;
                originalValue: unknown;
                finalValue: unknown;
            }
        >();

        for (const operation of operations) {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const pathKey = JSON.stringify(applyPath);
            const finalValue =
                operation.op === 'remove'
                    ? undefined
                    : cloneHistoryValue(
                          operation.applyNewValue === undefined
                              ? operation.newValue
                              : operation.applyNewValue
                      );
            const existing = byApplyPath.get(pathKey);
            if (!existing) {
                byApplyPath.set(pathKey, {
                    first: operation,
                    last: operation,
                    finalValue,
                    originalValue: cloneHistoryValue(
                        operation.applyOldValue === undefined
                            ? operation.oldValue
                            : operation.applyOldValue
                    )
                });
                continue;
            }
            existing.last = operation;
            existing.finalValue = finalValue;
        }

        const collapsed: TransactionBufferedOperation[] = [];
        for (const entry of byApplyPath.values()) {
            if (this._isDeepEqual(entry.originalValue, entry.finalValue)) {
                continue;
            }
            const last = entry.last;
            const first = entry.first;
            const collapsedOp =
                last.op === 'remove'
                    ? ('remove' as const)
                    : first.op === 'add'
                      ? ('add' as const)
                      : last.op;
            collapsed.push({
                ...last,
                op: collapsedOp,
                oldValue: cloneHistoryValue(entry.originalValue),
                newValue:
                    last.op === 'remove'
                        ? last.newValue
                        : cloneHistoryValue(entry.finalValue),
                applyOldValue: cloneHistoryValue(entry.originalValue),
                applyNewValue:
                    last.op === 'remove'
                        ? undefined
                        : cloneHistoryValue(entry.finalValue)
            });
        }
        return collapsed;
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

    /**
     * A complete document-set state is a convergence boundary: every node a
     * drawing's topology names must have its position there. A missing one
     * means an update never arrived; nothing fills it in or deletes around
     * it, the document is refused.
     */
    private _assertGeometryCompleteAfterConvergedState(
        documentId?: string
    ): void {
        const targetDoc = documentId ? this._docForId(documentId) : undefined;
        for (const glyphName of new Set(this._glyphNameById.values())) {
            const glyphMap = this._glyphMapForName(glyphName);
            if (!(glyphMap instanceof Y.Map)) {
                continue;
            }
            if (targetDoc && glyphMap.doc !== targetDoc) {
                continue;
            }
            const drawingsMap = glyphMap.get('layers');
            if (!(drawingsMap instanceof Y.Map)) {
                continue;
            }
            drawingsMap.forEach((drawing, drawingId) => {
                if (!(drawing instanceof Y.Map)) {
                    return;
                }
                try {
                    assertDrawingGeometryComplete(drawing);
                } catch (cause) {
                    const error = new DrawingInvariantError(
                        drawingId,
                        cause instanceof Error ? cause.message : String(cause),
                        `glyph ${glyphName}`
                    );
                    const glyphDocumentId =
                        this.glyphDocumentIdForName(glyphName);
                    if (glyphDocumentId) {
                        this.markDocumentBroken(glyphDocumentId, error);
                    }
                    throw error;
                }
            });
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
            if (operation.op === 'add') {
                this._renewGlyphOrderEntry(String(applyPath[1]));
            }
            return;
        }

        if (
            operation.applyMode === 'drawing-snapshot' &&
            applyPath.length === 4 &&
            applyPath[0] === 'glyphs' &&
            applyPath[2] === 'layers'
        ) {
            this._applyDrawingDelta(
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
        const touchedDrawingKeys = new Set<string>();
        let hasFontScopedChange = false;
        let hasGlyphScopedChange = false;

        for (const operation of operations) {
            const glyphName = deriveGlyphName(operation.path);
            const drawingId = deriveDrawingId(operation.path);
            if (!glyphName) {
                hasFontScopedChange = true;
            }
            if (glyphName) {
                touchedGlyphNames.add(glyphName);
            }
            if (glyphName && drawingId) {
                touchedDrawingKeys.add(
                    getDrawingManagerKey(glyphName, drawingId)
                );
            } else if (glyphName) {
                hasGlyphScopedChange = true;
            }
        }

        if (!hasFontScopedChange && touchedGlyphNames.size === 1) {
            const glyphName = [...touchedGlyphNames][0];
            if (!hasGlyphScopedChange && touchedDrawingKeys.size === 1) {
                const [managerKey] = [...touchedDrawingKeys];
                const [, drawingId] = managerKey.split('@@');
                return {
                    scope: 'layer',
                    origin: this._getEditOrigin(glyphName, drawingId, 'layer'),
                    glyphName,
                    layerId: drawingId
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
            if (applyPath.length > 2) {
                // Only a whole-glyph write creates a glyph; an edit inside
                // one that has no document here is refused.
                if (!this._glyphMapForName(glyphName)) {
                    throw new Error(
                        `[PatchSyncEngine] Refusing to write ${applyPath.join('.')}: glyph ${glyphName} has no document`
                    );
                }
                continue;
            }
            const addedId =
                applyPath.length === 2 &&
                operation.newValue &&
                typeof operation.newValue === 'object'
                    ? (operation.newValue as { id?: unknown }).id
                    : undefined;
            // A glyph added again under a deleted glyph's name brings its own
            // id. Until the deletion's catalog change arrives the name still
            // points at the deleted glyph, whose room peers ignore.
            if (
                this._glyphMapForName(glyphName) &&
                (typeof addedId !== 'string' ||
                    this._glyphIdByName.get(glyphName) === addedId)
            ) {
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

    /**
     * Address operations recorded after an in-transaction rename by the
     * glyph's pre-commit name. The name index only moves to the new names
     * once the commit has been applied, so `glyphs.<newName>…` would
     * otherwise route to a fresh, empty glyph doc. Name sets in one run are
     * simultaneous (swaps record both against the original names).
     */
    private _routeOperationsThroughPendingRenames(
        operations: TransactionBufferedOperation[]
    ): TransactionBufferedOperation[] {
        const liveNameByPendingName = new Map<string, string>();
        let pendingRun: Array<{ liveName: string; newName: string }> = [];
        const flushRun = (): void => {
            for (const { liveName } of pendingRun) {
                for (const [pending, live] of liveNameByPendingName) {
                    if (live === liveName) {
                        liveNameByPendingName.delete(pending);
                    }
                }
            }
            for (const { liveName, newName } of pendingRun) {
                if (newName !== liveName) {
                    liveNameByPendingName.set(newName, liveName);
                }
            }
            pendingRun = [];
        };
        return operations.map((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const isNameSet =
                applyPath.length === 3 &&
                applyPath[0] === 'glyphs' &&
                applyPath[2] === 'name' &&
                operation.op === 'set' &&
                typeof operation.newValue === 'string';
            if (!isNameSet) {
                flushRun();
            }
            if (applyPath[0] !== 'glyphs' || applyPath.length < 2) {
                return operation;
            }
            const pathName = String(applyPath[1]);
            const liveName = liveNameByPendingName.get(pathName) ?? pathName;
            if (isNameSet) {
                pendingRun.push({
                    liveName,
                    newName: String(operation.newValue)
                });
            }
            if (liveName === pathName) {
                return operation;
            }
            return {
                ...operation,
                applyPath: ['glyphs', liveName, ...applyPath.slice(2)]
            };
        });
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
    }> {
        const uniqueIds = [...new Set(glyphIds.filter(Boolean))];
        if (!uniqueIds.length || this._isApplyingRemote) {
            return [];
        }
        // One commit's tokens name its clock range, so peers can wait until
        // the feed has brought all of its glyphs.
        const first = this._glyphRevisionClock + 1;
        const last = this._glyphRevisionClock + uniqueIds.length;
        const range = uniqueIds.length > 1 ? `/${first}-${last}` : '';
        return uniqueIds.map((glyphId) => ({
            glyphId,
            revision: `${this.windowId}:${++this._glyphRevisionClock}${range}`
        }));
    }

    private _stampGlyphCatchUpRevisions(
        tokens: Array<{ glyphId: string; revision: string }>
    ): void {
        for (const { glyphId, revision } of tokens) {
            const doc = this._wakeGlyphDoc(glyphId);
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
                // An unchanged value is not written again (no new item).
                if (
                    generation != null &&
                    sync.get('generation') !== generation
                ) {
                    sync.set('generation', generation);
                }
            }, GLYPH_REVISION_ORIGIN);
        }
    }

    private _withGlyphRevisionCatchUp(
        glyphIds: string[],
        emitLocalGlyphUpdates: () => void
    ): void {
        this._beginCloudCommit();
        const tokens = this._allocateGlyphRevisionTokens(glyphIds);
        // Revision stamps are applied in the same glyph transactions as outline
        // writes when possible; keep an explicit stamp for undo/redo paths.
        this._stampGlyphCatchUpRevisions(tokens);
        // Each glyph's envelope carries its token. The glyph room tells
        // font-core once the write is durable, and font-core pushes it to
        // every window, so peers never fetch a glyph before its bytes land.
        const previous = this._pendingGlyphRevisions;
        this._pendingGlyphRevisions = new Map(
            tokens.map((token) => [token.glyphId, token.revision])
        );
        try {
            emitLocalGlyphUpdates();
        } finally {
            this._pendingGlyphRevisions = previous;
        }
        // This window holds these revisions already; linked windows learn
        // them from the feed listeners.
        if (tokens.length) {
            this.applyGlyphRevisionFeed(tokens, { hold: false, own: true });
            for (const { revision } of tokens) {
                this._noteOwnGlyphRevision(revision);
            }
        }
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

    private _getEditOrigin(
        glyphName: string | null,
        drawingId: string | null,
        scope: UndoScope
    ): string {
        if (scope === 'layer' && glyphName && drawingId) {
            return getDrawingEditOrigin(glyphName, drawingId);
        }
        if (scope === 'glyph') {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
    }

    private _deriveBulkUndoScope(
        targets: Array<{ glyphName: string }>,
        drawingId: string | null
    ): UndoScope {
        const glyphNames = new Set(targets.map((target) => target.glyphName));
        if (glyphNames.size !== 1) {
            return 'font';
        }
        if (drawingId) {
            return 'layer';
        }
        return 'glyph';
    }

    private _getRemoteDrawingSyncScopes(
        remoteEntries?: ChangeLogEntry[]
    ): Array<{ glyphName: string; layerId: string }> | null {
        if (!remoteEntries?.length) {
            return null;
        }

        if (
            remoteEntries.some((entry) => {
                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const drawingId = this._deriveDrawingIdFromPath(entry.path);
                return !!glyphName && !drawingId;
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
                const drawingId = this._deriveDrawingIdFromPath(entry.path);
                return glyphName && drawingId
                    ? [{ glyphName, layerId: drawingId }]
                    : [];
            })
        );

        if (!targets.length) {
            return null;
        }

        return targets;
    }

    private _hasMaterializedDrawingRoot(
        glyphName: string,
        drawingId: string
    ): boolean {
        const glyphMap = this._glyphMapForName(glyphName);
        const drawingsMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const drawingValue =
            drawingsMap instanceof Y.Map
                ? drawingsMap.get(drawingId)
                : undefined;
        if (!(drawingValue instanceof Y.Map)) {
            return false;
        }

        const drawingSnapshot = fromYDrawing(drawingValue);
        if (
            !drawingSnapshot ||
            typeof drawingSnapshot !== 'object' ||
            Array.isArray(drawingSnapshot)
        ) {
            return false;
        }

        const drawingRecord = drawingSnapshot as Record<string, unknown>;
        return (
            typeof drawingRecord.id === 'string' &&
            drawingRecord.id.length > 0 &&
            drawingRecord.id === drawingId
        );
    }

    private _resolveUndoHistoryItem(
        glyphName: string | undefined,
        drawingId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        historyTargetKey?: string | null,
        surface?: HistoryUndoSurface | null
    ): HistoryStackItem | null {
        return resolveHistoryTargetItem(this._changeLog, {
            glyphName: glyphName ?? null,
            layerId: drawingId ?? null,
            historyAction,
            historyTargetKey: historyTargetKey ?? null,
            surface: surface ?? null
        });
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
            const featuresMap = this._featuresYMap();
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

    private _deriveDrawingIdFromPath(path: string): string | null {
        return deriveDrawingIdFromPath(path);
    }

    private _parseEntryPath(path: string): (string | number)[] {
        return this._getPathSegments(path).map((segment) =>
            /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment
        );
    }

    private _applyHistoryItem(
        item: HistoryStackItem,
        direction: 'undo' | 'redo',
        prepared: PreparedHistoryReplay,
        committed: Array<[string, ChangeLogEntry[]]>
    ): WorkerReplayTarget[] {
        const { resettleDerivedDrawings } = prepared;
        this._replayHistoryEntries(prepared, direction, committed);
        const settled = resettleDerivedDrawings
            ? this._resettleDerivedDrawingsAfterOriginReplay(item)
            : this._reflowDependentsAfterReplay(item);
        const recomposed =
            this._recomposeStaleAutomaticDrawingsAfterReplay(item);
        return recomposed.length
            ? normalizeWorkerReplayTargets([...settled, ...recomposed])
            : settled;
    }

    /**
     * The item recorded no dependent composites (none followed the edit then,
     * for example because their automatic alignment was off), but some may
     * follow the replayed glyph now. Recompose them within the replay, so an
     * undo leaves every automatic composite matching its bases, here and for
     * collaborators. Returns nothing when no dependent changed.
     */
    private _reflowDependentsAfterReplay(
        item: HistoryStackItem
    ): WorkerReplayTarget[] {
        if (!this._getResettleFontModel()) {
            return [];
        }
        const originEntries = item.entries.filter(
            (entry) =>
                !isDerivedDrawingChangePath(
                    entry.path,
                    item.originatingGlyphName
                )
        );
        if (deriveEditKindsFromChangeLogEntries(originEntries).size === 0) {
            return [];
        }
        const before = this._historyReplayDependentTargets.length;
        const targets = this._resettleDerivedDrawingsAfterOriginReplay(item);
        return this._historyReplayDependentTargets.length > before
            ? targets
            : [];
    }

    /**
     * A replay restores stored component positions. When it switches
     * automatic alignment back on (or restores a composite whose base
     * anchors moved since), those positions are stale: recompose the
     * replayed automatic drawings, unrecorded, within the same replay.
     */
    private _recomposeStaleAutomaticDrawingsAfterReplay(
        item: HistoryStackItem
    ): WorkerReplayTarget[] {
        const fontModel = this._getResettleFontModel() as Unsafe;
        if (!fontModel) {
            return [];
        }
        const targets = this._collectOriginDrawingTargets(
            item,
            item.entries.filter(
                (entry) =>
                    !isDerivedDrawingChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
            )
        ).filter((target) => target.glyphName && target.layerId);
        if (!targets.length) {
            return [];
        }
        this._syncPatchedDrawingTargetsFromYDoc(targets);
        const recomposed: WorkerReplayTarget[] = [];
        for (const target of targets) {
            const drawing = fontModel
                .findGlyph?.(target.glyphName)
                ?.findDrawingById?.(target.layerId);
            if (!drawing?.isAutomaticAlignedDrawing?.()) {
                continue;
            }
            drawing.invalidateContentCaches?.();
            const changed = this.runWithoutRecording(
                () => drawing.rebuildAutomaticComposition?.() === true
            );
            if (!changed) {
                continue;
            }
            this._applySettledDrawingFromFontJson(
                target.glyphName,
                target.layerId
            );
            recomposed.push(target);
        }
        return recomposed;
    }

    /**
     * Resolve and check everything an undo or redo of `item` writes, before
     * the history moves: the entries it replays, one bucket per document
     * (font-core first), every document resident and writable, and every
     * value one a drawing may hold. Returns null when a document is not
     * held here (the replay is refused, nothing written); throws when one
     * is broken or a value is invalid.
     */
    private _prepareHistoryReplay(
        item: HistoryStackItem,
        direction: 'undo' | 'redo'
    ): PreparedHistoryReplay | null {
        const resettleDerivedDrawings =
            shouldResettleDerivedDrawingsOnHistoryReplay(
                item,
                !!this._getResettleFontModel()
            );
        const orderedEntries = (
            direction === 'undo' ? [...item.entries].reverse() : item.entries
        ).filter(isReplayableHistoryEntry);
        const replayEntries = resettleDerivedDrawings
            ? orderedEntries.filter(
                  (entry) =>
                      !isDerivedDrawingChangePath(
                          entry.path,
                          item.originatingGlyphName
                      )
              )
            : orderedEntries;
        const itemRenames = this._collectGlyphRenamesFromEntries(replayEntries);
        // An undo maps names back before it resolves documents; done here on
        // a copy of the index, which is then restored untouched.
        const nameMaps = this._snapshotGlyphNameMaps();
        const entriesByDocument = new Map<string, ChangeLogEntry[]>();
        const reached = new Set<string>();
        try {
            if (direction === 'undo') {
                this._applyGlyphNameRemapsFromEntries(replayEntries, direction);
            }
            for (const entry of replayEntries) {
                const documentId = this._documentIdForHistoryEntry(
                    entry,
                    itemRenames
                );
                const bucket = entriesByDocument.get(documentId) || [];
                bucket.push(entry);
                entriesByDocument.set(documentId, bucket);
                for (const reachedId of this._documentIdsForHistoryEntry(
                    entry,
                    itemRenames
                )) {
                    reached.add(reachedId);
                }
            }
        } finally {
            this._restoreGlyphNameMaps(nameMaps);
        }
        // Font-core goes first: a drawing restored by undo (say of “Remove
        // station”) must find its station back in font-core.
        const buckets = [...entriesByDocument].sort(
            ([a], [b]) =>
                Number(b === FONT_CORE_DOCUMENT_ID) -
                Number(a === FONT_CORE_DOCUMENT_ID)
        );
        const documentIds = [
            ...new Set([...entriesByDocument.keys(), ...reached])
        ];
        const missing = documentIds.filter(
            (documentId) => !this._docForId(documentId)
        );
        if (missing.length) {
            console.warn(
                `Skipping ${direction}: history item ${item.id} writes ${missing.join(', ')}, which this window does not hold`
            );
            this._announceHistoryReplayProblem({
                kind: 'blocked',
                reason: 'document-not-loaded',
                historyAction: direction,
                historyItemId: item.id,
                documentIds: missing
            });
            return null;
        }
        for (const documentId of documentIds) {
            assertDocumentWritable(
                this._docForId(documentId),
                documentId,
                this._brokenScope
            );
        }
        for (const entry of replayEntries) {
            this._assertHistoryReplayValue(entry, direction);
        }
        return { replayEntries, resettleDerivedDrawings, itemRenames, buckets };
    }

    /**
     * A drawing never loses its id, width or station: a replay value that
     * would delete one is a broken history entry, refused before anything
     * is written.
     */
    private _assertHistoryReplayValue(
        entry: ChangeLogEntry,
        direction: 'undo' | 'redo'
    ): void {
        if (!entry.path || entry.path === 'font') {
            return;
        }
        const path = this._toYDocPath(this._parseEntryPath(entry.path));
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
                String(path[4])
            )
        ) {
            const replayValue = this._getHistoryReplayValue(entry, direction);
            if (replayValue === null || replayValue === undefined) {
                throw new DrawingInvariantError(
                    String(path[3]),
                    `would lose ${String(path[4])} in ${direction}`,
                    `glyph ${String(path[1])}`
                );
            }
        }
    }

    /** The glyph name index, copied, so a replay can put it back. */
    private _snapshotGlyphNameMaps(): GlyphNameMapsSnapshot {
        return {
            idByName: new Map(this._glyphIdByName),
            nameById: new Map(this._glyphNameById),
            retiredIdByName: new Map(this._retiredGlyphIdByName),
            removedNameById: new Map(this._removedGlyphNameById),
            pendingDestroyedIds: new Set(this._pendingDestroyedGlyphIds)
        };
    }

    private _restoreGlyphNameMaps(snapshot: GlyphNameMapsSnapshot): void {
        const refill = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
            target.clear();
            for (const [key, value] of source) target.set(key, value);
        };
        refill(this._glyphIdByName, snapshot.idByName);
        refill(this._glyphNameById, snapshot.nameById);
        refill(this._retiredGlyphIdByName, snapshot.retiredIdByName);
        refill(this._removedGlyphNameById, snapshot.removedNameById);
        this._pendingDestroyedGlyphIds.clear();
        for (const glyphId of snapshot.pendingDestroyedIds) {
            this._pendingDestroyedGlyphIds.add(glyphId);
        }
    }

    /**
     * An undo or redo threw after its checks, part way through its writes.
     * The history does not move: its entry is taken out. The documents it
     * already wrote get the opposite replay, so they hold what they held
     * before; the name index is put back. Everything both wrote is sent now
     * (Yjs keeps every operation, and later edits build on them), described
     * as whole documents since no history entry names it. A document whose
     * own write threw part way was marked broken by `_transactOrMarkBroken`.
     */
    private _abandonHistoryReplay(
        replay: {
            historyAction: 'undo' | 'redo';
            historyItemId: string;
            prepared: PreparedHistoryReplay;
            committed: Array<[string, ChangeLogEntry[]]>;
            nameMaps: GlyphNameMapsSnapshot;
            loggedEntry: ChangeLogEntry | undefined;
            loggedEntryIndex: number;
            baselines: Map<string, Uint8Array>;
            dependentTargets: WorkerReplayTarget[];
        },
        failure: unknown
    ): void {
        const reverse = replay.historyAction === 'undo' ? 'redo' : 'undo';
        const notRolledBack: string[] = [];
        for (const [documentId, entries] of [...replay.committed].reverse()) {
            const doc = this._docForId(documentId);
            if (
                !doc ||
                isDocumentBroken(doc) ||
                this.isDocumentIdBroken(documentId)
            ) {
                notRolledBack.push(documentId);
                continue;
            }
            try {
                this._transactOrMarkBroken(
                    doc,
                    documentId,
                    () => {
                        for (const entry of [...entries].reverse()) {
                            this._applyHistoryReplayEntry(
                                entry,
                                reverse,
                                replay.prepared.itemRenames
                            );
                        }
                    },
                    HISTORY_REPLAY_ORIGIN
                );
            } catch (error) {
                notRolledBack.push(documentId);
                console.error(
                    `Could not take back the ${replay.historyAction} of ${documentId}:`,
                    error
                );
            }
        }
        this._restoreGlyphNameMaps(replay.nameMaps);
        let takenBackHistoryItemId: string | undefined;
        if (
            replay.loggedEntry &&
            this._changeLog[replay.loggedEntryIndex] === replay.loggedEntry
        ) {
            this._removeChangeLogEntriesAt([replay.loggedEntryIndex]);
            takenBackHistoryItemId = replay.loggedEntry.historyItemId;
        }
        try {
            this._syncRemoteJsonFromYDoc(replay.prepared.replayEntries);
            // Derived drawings the replay already rewrote keep that write
            // (it is sent below); the font shows what the documents hold.
            if (replay.dependentTargets.length) {
                this._syncJsonFromYDoc(replay.dependentTargets);
            }
        } catch (error) {
            console.error(
                `Could not refresh the font after a failed ${replay.historyAction}:`,
                error
            );
        }
        if (!this._isApplyingRemote) {
            try {
                this._emitCanonicalLocalUpdatesSince(replay.baselines);
            } catch (error) {
                console.error(
                    `Could not send what a failed ${replay.historyAction} wrote:`,
                    error
                );
            }
        }
        console.error(
            `${replay.historyAction} of history item ${replay.historyItemId} failed; the history did not move`,
            failure
        );
        this._announceHistoryReplayProblem({
            kind: 'failed',
            historyAction: replay.historyAction,
            historyItemId: replay.historyItemId,
            reason:
                failure instanceof Error ? failure.message : String(failure),
            documentIdsNotRolledBack: notRolledBack,
            ...(takenBackHistoryItemId ? { takenBackHistoryItemId } : {})
        });
    }

    /**
     * Take out change-log entries at `indices`. A cursor past a removed
     * entry steps back over it, so the next entry is neither skipped nor
     * sent twice. Listeners hear of it once.
     */
    private _removeChangeLogEntriesAt(indices: number[]): void {
        const sorted = [...new Set(indices)]
            .filter((index) => index >= 0 && index < this._changeLog.length)
            .sort((left, right) => right - left);
        if (!sorted.length) {
            return;
        }
        for (const index of sorted) {
            this._changeLog.splice(index, 1);
            if (this._lastLocalUpdateLogIndex > index) {
                this._lastLocalUpdateLogIndex -= 1;
            }
            if (this._lastBroadcastLogIndex > index) {
                this._lastBroadcastLogIndex -= 1;
            }
        }
        this._notifyChangeLogListeners();
    }

    /**
     * Another window's undo or redo failed and was taken back there; take
     * the entries it relayed for it out of this window's change log too, so
     * every window's history matches. The author holds one control entry
     * with its own history item id (`entryHistoryItemId`); the replay's
     * packets reach this window as entries that carry the replayed item's
     * id instead (the target), one per change and document. Either id
     * matches, with the same action, target and author window; without an
     * entry id, any id does. The newest match is taken with the entries of
     * the same id and author before it, up to the author's previous other
     * entry (another undo or redo of the same target always has a redo or
     * undo between). Returns false when this window holds no such entry
     * (nothing is inferred or removed then).
     */
    takeBackHistoryEntry(takeBack: HistoryEntryTakeBack): boolean {
        // The author names ids as it holds them; this window logged the
        // relayed entries with them namespaced like every relayed entry
        // (`createChangeLogEntriesFromCollaborationMessageEnvelope`): the
        // author's own ids get its window prefix, and an id this window
        // created comes back without its prefix.
        const asLogged = (id: string): string => {
            if (takeBack.windowId === this.windowId) {
                return id;
            }
            const ownPrefix = `${this.windowId}:`;
            return id.startsWith(ownPrefix)
                ? id.slice(ownPrefix.length)
                : `${takeBack.windowId}:${id}`;
        };
        const targetHistoryItemId = asLogged(takeBack.targetHistoryItemId);
        const acceptedIds = takeBack.entryHistoryItemId
            ? new Set([
                  asLogged(takeBack.entryHistoryItemId),
                  targetHistoryItemId
              ])
            : null;
        const matches = (entry: ChangeLogEntry): boolean =>
            entry.historyAction === takeBack.historyAction &&
            entry.targetHistoryItemId === targetHistoryItemId &&
            entry.windowId === takeBack.windowId &&
            (!acceptedIds || acceptedIds.has(entry.historyItemId));
        let newest = -1;
        for (let index = this._changeLog.length - 1; index >= 0; index--) {
            if (matches(this._changeLog[index])) {
                newest = index;
                break;
            }
        }
        if (newest < 0) {
            return false;
        }
        const runId = this._changeLog[newest].historyItemId;
        const indices: number[] = [newest];
        for (let index = newest - 1; index >= 0; index--) {
            const entry = this._changeLog[index];
            if (entry.windowId !== takeBack.windowId) {
                continue;
            }
            if (!matches(entry) || entry.historyItemId !== runId) {
                break;
            }
            indices.push(index);
        }
        this._removeChangeLogEntriesAt(indices);
        return true;
    }

    /** Apply a prepared replay in the given direction, one Yjs transaction per document. */
    private _replayHistoryEntries(
        prepared: PreparedHistoryReplay,
        direction: 'undo' | 'redo',
        committed: Array<[string, ChangeLogEntry[]]>,
        collectDeletedContent = false
    ): void {
        const { replayEntries, itemRenames } = prepared;
        if (direction === 'undo') {
            this._applyGlyphNameRemapsFromEntries(replayEntries, direction);
        }
        for (const [documentId, entries] of prepared.buckets) {
            const doc = this._requireDocForId(documentId);
            assertDocumentWritable(doc, documentId, this._brokenScope);
            const keepGc = doc.gc;
            // Yjs GCs a transaction's deletions at cleanup when doc.gc is set.
            doc.gc = keepGc || collectDeletedContent;
            try {
                this._transactOrMarkBroken(
                    doc,
                    documentId,
                    () => {
                        for (const entry of entries) {
                            this._applyHistoryReplayEntry(
                                entry,
                                direction,
                                itemRenames
                            );
                        }
                    },
                    HISTORY_REPLAY_ORIGIN
                );
            } finally {
                doc.gc = keepGc;
            }
            committed.push([documentId, entries]);
        }
        if (direction === 'redo') {
            this._applyGlyphNameRemapsFromEntries(replayEntries, direction);
        }
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
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
                String(path[4])
            )
        ) {
            // A drawing never loses its id, width or station: undo and redo
            // write the value the entry recorded for that side, whatever the
            // entry's op. A replay value that would delete one is a broken
            // history entry.
            if (replayValue === null || replayValue === undefined) {
                throw new DrawingInvariantError(
                    String(path[3]),
                    `would lose ${String(path[4])} in ${direction}`,
                    `glyph ${String(path[1])}`
                );
            }
            this._setRoutedYPath(path, replayValue);
            return;
        }
        if (this._isDrawingRootPath(path)) {
            if (replayValue === null || replayValue === undefined) {
                this._deleteRoutedYPath(path);
            } else {
                this._applyDrawingDelta(
                    String(path[1]),
                    String(path[3]),
                    replayValue
                );
            }
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

    private _collectOriginDrawingTargets(
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
                layerId: deriveDrawingIdFromPath(entry.path) || ''
            }))
        ]);
    }

    private _getFontJsonDrawing(
        glyphName: string,
        drawingId: string
    ): Record<string, unknown> | null {
        const glyphs = Array.isArray(this._fontJson?.glyphs)
            ? (this._fontJson.glyphs as Unsafe[])
            : [];
        const glyphJson = glyphs.find((glyph) => glyph?.name === glyphName);
        const drawingJson = Array.isArray(glyphJson?.layers)
            ? (glyphJson.layers as Unsafe[]).find(
                  (drawing) => drawing?.id === drawingId
              )
            : null;
        if (!drawingJson || typeof drawingJson !== 'object') {
            return null;
        }
        return drawingJson as Record<string, unknown>;
    }

    private _resettleDerivedDrawingsAfterOriginReplay(
        item: HistoryStackItem
    ): WorkerReplayTarget[] {
        const fontModel = this._getResettleFontModel();
        const originTargets = this._collectOriginDrawingTargets(
            item,
            item.entries.filter(
                (entry) =>
                    !isDerivedDrawingChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
            )
        );
        if (!fontModel) {
            return originTargets;
        }

        if (originTargets.length) {
            this._syncPatchedDrawingTargetsFromYDoc(originTargets);
        }

        const editKinds = deriveEditKindsFromChangeLogEntries(
            item.entries.filter(
                (entry) =>
                    !isDerivedDrawingChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
            )
        );
        if (editKinds.size === 0 || !originTargets.length) {
            return originTargets;
        }

        const sourceTarget = originTargets[0];
        const closure = computeDrawingRecompositionClosure({
            sourceTargets: originTargets,
            editKinds,
            scope: 'all',
            fontModel,
            activeDrawingId: sourceTarget?.layerId ?? item.originatingLayerId,
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
            return !!this._getFontJsonDrawing(target.glyphName, target.layerId);
        });
        for (const target of derivedTargets) {
            const changed = this._applySettledDrawingFromFontJson(
                target.glyphName,
                target.layerId
            );
            if (changed && !historyItemWritesDrawing(item, target)) {
                this._historyReplayDependentTargets.push(target);
            }
        }
        return normalizeWorkerReplayTargets([
            ...originTargets,
            ...derivedTargets
        ]);
    }

    private _applySettledDrawingFromFontJson(
        glyphName: string,
        drawingId: string
    ): boolean {
        const drawingJson = this._getFontJsonDrawing(glyphName, drawingId);
        if (!drawingJson) {
            return false;
        }
        const glyphMap = this._glyphMapForName(glyphName);
        const drawingsMap =
            glyphMap instanceof Y.Map ? glyphMap.get('layers') : null;
        const yDrawingMap =
            drawingsMap instanceof Y.Map ? drawingsMap.get(drawingId) : null;
        if (!(yDrawingMap instanceof Y.Map)) {
            return false;
        }

        const yDrawingJson = fromYDrawing(yDrawingMap) as Record<
            string,
            unknown
        >;
        const delta: Record<string, unknown> = { id: drawingId };
        let hasChanges = false;
        for (const [key, value] of Object.entries(drawingJson)) {
            if (JSON.stringify(value) === JSON.stringify(yDrawingJson?.[key])) {
                continue;
            }
            delta[key] = cloneHistoryValue(value);
            hasChanges = true;
        }
        for (const key of Object.keys(yDrawingJson || {})) {
            if (key === 'id' || key in drawingJson) {
                continue;
            }
            if (key === 'shapes' || key === 'anchors' || key === 'guides') {
                continue;
            }
            delta[key] = null;
            hasChanges = true;
        }
        if (!hasChanges) {
            return false;
        }
        // The JSON can differ from the stored drawing in form only; then the
        // write changes nothing, and the room must not be baselined (a
        // baselined glyph gets a revision stamp, which would go unsent).
        const documentId = this.documentIdForPath(['glyphs', glyphName]);
        const doc = this._docForId(documentId);
        const before = doc ? Y.encodeStateVector(doc) : null;
        const baselined = this._noteHistoryReplayDocument(documentId);
        this._applyDrawingDelta(glyphName, drawingId, delta);
        if (
            doc &&
            before &&
            stateVectorsEqual(before, Y.encodeStateVector(doc))
        ) {
            if (baselined) {
                this._historyReplayBaselines?.delete(documentId);
            }
            return false;
        }
        return true;
    }

    /**
     * Baseline a room the replay is about to write for the first time, so
     * its update is sent. True when this call added the baseline.
     */
    private _noteHistoryReplayDocument(documentId: string): boolean {
        const baselines = this._historyReplayBaselines;
        if (!baselines || baselines.has(documentId)) {
            return false;
        }
        const doc = this._docForId(documentId);
        if (!doc) {
            return false;
        }
        baselines.set(documentId, Y.encodeStateVector(doc));
        return true;
    }

    /**
     * Name the dependent drawings an undo or redo recomposed on its log entry,
     * so their rooms carry entries (and are sent) and collaborators note the
     * change for their own undo guards.
     */
    private _noteDependentTargetsOnHistoryEntry(
        loggedEntryIndex: number,
        dependentTargets: WorkerReplayTarget[]
    ): void {
        const logged = this._changeLog[loggedEntryIndex];
        if (!logged || !dependentTargets.length) {
            return;
        }
        const { semanticChangeLogEntries, ...fields } = logged;
        const dependentEntries = normalizeWorkerReplayTargets(
            dependentTargets
        ).map((target) =>
            normalizeChangeLogEntry({
                ...fields,
                op: 'set' as ChangeOp,
                // Colon form: a glyph name may contain dots (`a.ss01`).
                path: `glyphs.${target.glyphName}:layers.${target.layerId}`,
                oldValue: undefined,
                newValue: undefined,
                workerReplayTargets: [target]
            })
        );
        logged.semanticChangeLogEntries = [
            ...(semanticChangeLogEntries?.length
                ? semanticChangeLogEntries
                : [normalizeChangeLogEntry(fields)]),
            ...dependentEntries
        ];
        logged.workerReplayTargets = normalizeWorkerReplayTargets([
            ...(logged.workerReplayTargets ?? []),
            ...dependentTargets
        ]);
    }

    private _getHistoryReplayValue(
        entry: ChangeLogEntry,
        direction: 'undo' | 'redo'
    ): unknown {
        return historyReplayValue(entry, direction);
    }

    private _cloneReplayValue(value: unknown): unknown {
        return value === undefined ? undefined : cloneHistoryValue(value);
    }

    private _prepareDrawingSnapshotForHistory(
        drawingId: string,
        drawingJson: unknown,
        existingDrawingJson: unknown,
        existingDrawingMap?: Y.Map<unknown> | null
    ): Record<string, unknown> {
        let prepared = this._prepareStorageValue(drawingJson) as Record<
            string,
            unknown
        >;
        if (
            existingDrawingMap instanceof Y.Map &&
            !Object.prototype.hasOwnProperty.call(prepared, 'shapes')
        ) {
            const yShapes = readDrawingGeometry(existingDrawingMap);
            if (yShapes && yShapes.length > 0) {
                prepared = { ...prepared, shapes: yShapes };
            }
        }
        return this._normalizeDrawingSnapshot(
            drawingId,
            prepared,
            existingDrawingJson
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

            const record = omitRestingDrawingRuntimeKeys(
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
            const comparableRecord =
                isPathOrComponent && 'nodes' in storageRecord
                    ? (normalizeValueForYDocWrite(storageRecord) as Record<
                          string,
                          unknown
                      >)
                    : storageRecord;

            return Object.fromEntries(
                Object.entries(comparableRecord).map(([key, item]) => [
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

    private _noteCollaboratorTouches(paths: string[]): void {
        const seq = this._changeLog.length;
        for (const path of new Set(paths)) {
            if (path) {
                this._collaboratorTouches.push({ seq, path });
                const glyphName = drawingSetChangeGlyphName(path);
                if (glyphName) {
                    this._collaboratorDrawingSetTouches.push({
                        seq,
                        glyphName
                    });
                }
            }
        }
        if (this._collaboratorTouches.length > MAX_COLLABORATOR_TOUCHES) {
            this._collaboratorTouches.splice(
                0,
                this._collaboratorTouches.length - MAX_COLLABORATOR_TOUCHES
            );
        }
        if (
            this._collaboratorDrawingSetTouches.length >
            MAX_COLLABORATOR_TOUCHES
        ) {
            this._collaboratorDrawingSetTouches.splice(
                0,
                this._collaboratorDrawingSetTouches.length -
                    MAX_COLLABORATOR_TOUCHES
            );
        }
    }

    private _historyItemOverlapsLaterCollaboratorEdit(
        item: HistoryStackItem
    ): boolean {
        if (!this._collaboratorTouches.length) {
            return false;
        }
        if (
            this._collaboratorTouches[this._collaboratorTouches.length - 1]
                .seq > this._changeLog.length
        ) {
            // The change log was reset; its indexes no longer line up.
            this._collaboratorTouches = [];
            this._collaboratorDrawingSetTouches = [];
            return false;
        }
        const paths = item.entries
            .map((entry) => String(entry.path || ''))
            .filter(Boolean);
        if (
            this._collaboratorTouches.some(
                (touch) =>
                    touch.seq > item.transitionSeq &&
                    paths.some((path) => historyPathsOverlap(path, touch.path))
            )
        ) {
            return true;
        }
        // A drawing a collaborator added, removed or replaced later was made
        // to match this glyph’s drawings as they were then. Replaying a
        // structural edit of the other drawings would change them but not
        // it, and the glyph would no longer interpolate.
        const structurallyChangedGlyphs = new Set(
            item.entries
                .filter(historyEntryChangesInterpolationStructure)
                .map((entry) => historyPathSegments(String(entry.path))[1])
        );
        return (
            structurallyChangedGlyphs.size > 0 &&
            this._collaboratorDrawingSetTouches.some(
                (touch) =>
                    touch.seq > item.transitionSeq &&
                    structurallyChangedGlyphs.has(touch.glyphName)
            )
        );
    }

    private _canReplayHistoryItem(
        item: HistoryStackItem,
        direction: 'undo' | 'redo'
    ): boolean {
        const resettleDerivedDrawings =
            shouldResettleDerivedDrawingsOnHistoryReplay(
                item,
                !!this._getResettleFontModel()
            );
        const entries = item.entries.filter(
            (entry) =>
                isReplayableHistoryEntry(entry) &&
                !(
                    resettleDerivedDrawings &&
                    isDerivedDrawingChangePath(
                        entry.path,
                        item.originatingGlyphName
                    )
                )
        );
        if (!entries.length) {
            return false;
        }

        return entries.every((entry) => {
            const replayValue = this._getHistoryReplayValue(entry, direction);
            // 'add' on undo and 'remove' on redo delete the path; undo of a
            // newly created property (no old value) deletes it too.
            const deletesPath =
                (entry.op === 'add' && direction === 'undo') ||
                (entry.op === 'remove' && direction === 'redo') ||
                (entry.op === 'set' &&
                    direction === 'undo' &&
                    replayValue === undefined);
            if (deletesPath) {
                return true;
            }
            const path = this._toYDocPath(this._parseEntryPath(entry.path));
            if (this._isDrawingRootPath(path) && replayValue == null) {
                return true;
            }
            if (replayValue === undefined) {
                return false;
            }
            if (this._isGlyphRootPath(path) || this._isDrawingRootPath(path)) {
                return !!replayValue && typeof replayValue === 'object';
            }
            return true;
        });
    }

    private _isGlyphRootPath(path: (string | number)[]): boolean {
        return path.length === 2 && path[0] === 'glyphs' && !!path[1];
    }

    private _isDrawingRootPath(path: (string | number)[]): boolean {
        return (
            path.length === 4 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            typeof path[1] === 'string' &&
            typeof path[3] === 'string'
        );
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

    /**
     * Give an added glyph its own glyphOrder entry. Its name can still be
     * listed for a glyph deleted elsewhere, whose delete has not reached
     * this window's order yet; when that delete's removal of the old entry
     * arrives, it must not take the new glyph's name with it. That removal
     * can also land between recording the add and applying it (a cloud
     * commit waits for its WAL write), after the add found the name listed
     * and queued no glyphOrder change; then the name goes back in at the
     * glyph's place in the model.
     */
    private _renewGlyphOrderEntry(glyphName: string): void {
        const glyphOrder = this.fontMap.get('glyphOrder');
        if (!(glyphOrder instanceof Y.Array)) {
            return;
        }
        const names = glyphOrder.toArray().map(String);
        const index = names.indexOf(glyphName);
        if (index >= 0) {
            glyphOrder.delete(index, 1);
            glyphOrder.insert(index, [glyphName]);
            return;
        }
        const modelOrder = this._glyphNamesFromFontJson();
        const modelIndex = modelOrder.indexOf(glyphName);
        if (modelIndex < 0) {
            return;
        }
        let insertAt = names.length;
        for (let before = modelIndex - 1; before >= 0; before -= 1) {
            const at = names.indexOf(modelOrder[before]);
            if (at >= 0) {
                insertAt = at + 1;
                break;
            }
        }
        glyphOrder.insert(insertAt, [glyphName]);
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

    private _replaceDrawingMapContents(
        drawingMap: Y.Map<unknown>,
        nextRecord: Record<string, unknown>
    ): void {
        const existingRecord = fromYDrawing(drawingMap) as Record<
            string,
            unknown
        > | null;
        const sanitizedRecord = toRestingDrawingJson(nextRecord, {
            existing: existingRecord,
            mode: 'replace',
            context: 'Y.Doc write'
        });
        this._assertDrawingInvariants(
            typeof sanitizedRecord.id === 'string' ? sanitizedRecord.id : '',
            sanitizedRecord,
            'Y.Doc write'
        );
        const nextKeys = new Set(Object.keys(sanitizedRecord));
        const indexedStorageKeysToKeep = new Set<string>();
        for (const key of nextKeys) {
            const mapping = INDEXED_MAP_KEYS[key];
            if (mapping) {
                indexedStorageKeysToKeep.add(mapping.byId);
                indexedStorageKeysToKeep.add(mapping.order);
            }
        }

        drawingMap.forEach((_value: unknown, key: string) => {
            if (
                nextKeys.has(key) ||
                indexedStorageKeysToKeep.has(key) ||
                YMAP_INFRASTRUCTURE_KEYS.has(key) ||
                key === 'shapes' ||
                (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
                    key
                )
            ) {
                return;
            }
            if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
                // Emptied, never deleted: the map is created with the
                // drawing so collaborators share it.
                writeDrawingFormatSpecific(drawingMap, undefined);
                return;
            }

            drawingMap.delete(key);
        });

        for (const runtimeKey of RESTING_DRAWING_RUNTIME_KEYS) {
            drawingMap.delete(runtimeKey);
        }

        for (const [key, value] of Object.entries(sanitizedRecord)) {
            if (key === 'shapes' && Array.isArray(value)) {
                writeDrawingGeometry(drawingMap, value, toYType);
                continue;
            }
            if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
                writeDrawingFormatSpecific(drawingMap, value);
                continue;
            }
            const mapping = INDEXED_MAP_KEYS[key];
            if (mapping) {
                drawingMap.delete(key);
                if (Array.isArray(value)) {
                    applyIndexedMapArrayToYMap(drawingMap, key, value);
                    continue;
                }
                if (
                    (key === 'anchors' || key === 'guides') &&
                    (value === null || value === undefined)
                ) {
                    // The keyed maps are created with the drawing and never
                    // deleted: a map created again later races a
                    // collaborator's. Only the entries go.
                    applyIndexedMapArrayToYMap(drawingMap, key, []);
                    continue;
                }
                throw new DrawingInvariantError(
                    typeof sanitizedRecord.id === 'string'
                        ? sanitizedRecord.id
                        : '',
                    `has ${key} that are not a list`,
                    'Y.Doc write'
                );
            }

            this._replaceYMapEntry(drawingMap, key, value);
        }
        // Both callers write a whole drawing (the model's drawing, or a
        // snapshot normalized over the stored one), and Babelfont leaves an
        // empty list out: a drawing without anchors or guides has none. The
        // keyed maps stay, emptied, like an explicit empty list.
        for (const key of ['anchors', 'guides'] as const) {
            if (!Object.prototype.hasOwnProperty.call(sanitizedRecord, key)) {
                applyIndexedMapArrayToYMap(drawingMap, key, []);
            }
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
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            throw new Error(
                `[PatchSyncEngine] Refusing the snapshot of glyph ${glyphName}: its document has no glyph map`
            );
        }
        // A glyph this snapshot creates gets its drawings map now, in the
        // same transaction as its name, so its first packet is whole.
        if (glyphMap.size === 0) {
            createGlyphDrawingsMap(glyphMap);
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
        // Every glyph writer stores a category (Rust always serializes it,
        // and glyphs created in the editor get one). A snapshot is merged
        // over the stored glyph above, so a glyph that still has none lost
        // it; it is refused, never filled in.
        if (typeof glyphJson.category !== 'string' || !glyphJson.category) {
            throw new Error(
                `[PatchSyncEngine] Refusing the snapshot of glyph ${glyphName}: it has no category`
            );
        }
        for (const [gk, gv] of Object.entries(glyphJson)) {
            if (gk === 'layers' && Array.isArray(gv)) {
                // Created with the glyph; any other state is refused.
                const drawingsMap = ensureGlyphDrawingsMap(glyphMap);

                const nextDrawingIds = new Set<string>();
                // Every drawing is normalized and checked before any map is
                // written, so a bad one leaves the glyph as it was.
                const normalizedDrawings = (
                    gv as Record<string, unknown>[]
                ).map((drawingJson) => {
                    const drawingId =
                        typeof drawingJson.id === 'string'
                            ? drawingJson.id
                            : '';
                    if (!drawingId) {
                        throw new DrawingInvariantError(
                            '',
                            'has no id',
                            `glyph snapshot ${glyphName}`
                        );
                    }
                    const existing = drawingsMap.get(drawingId);
                    return {
                        drawingId,
                        existing:
                            existing instanceof Y.Map ? existing : undefined,
                        json: this._normalizeDrawingSnapshot(
                            drawingId,
                            drawingJson,
                            existing instanceof Y.Map
                                ? fromYType(existing)
                                : undefined
                        ) as Record<string, unknown>
                    };
                });
                for (const {
                    drawingId,
                    existing,
                    json
                } of normalizedDrawings) {
                    nextDrawingIds.add(drawingId);
                    if (existing) {
                        // Patch the existing drawing in place so the
                        // snapshot produces minimal Yjs deltas.
                        this._replaceDrawingMapContents(existing, json);
                        continue;
                    }
                    // A new drawing is built whole while detached, then
                    // inserted, so it never exists half-written.
                    drawingsMap.set(drawingId, drawingToYMap(json));
                }

                // Remove drawings that are no longer in the snapshot
                drawingsMap.forEach((_value: unknown, key: string) => {
                    if (!nextDrawingIds.has(key)) {
                        drawingsMap.delete(key);
                    }
                });
                setYPath(glyphMap, ['layerOrder'], Array.from(nextDrawingIds));
                continue;
            }

            this._replaceYMapEntry(glyphMap, gk, gv);
        }

        // Remove glyph-level keys no longer in the snapshot. The drawings
        // map and its order are created once, with the glyph, and never
        // deleted: a snapshot without `layers` leaves the drawings alone.
        const glyphKeys = new Set(Object.keys(glyphJson));
        glyphKeys.add('layers');
        glyphKeys.add('layerOrder');
        glyphMap.forEach((_value: unknown, key: string) => {
            if (!glyphKeys.has(key)) {
                glyphMap.delete(key);
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
            if (this._layoutSetPath([key], value)) {
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
        if (this.roomLayout && !nextKeys.has('features')) {
            this._layoutDeletePath(['features']);
        }
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
        options?: { strictDrawings?: boolean; ignoreExisting?: boolean }
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
            const incomingDrawings = this._coerceGlyphDrawingSnapshots(
                incomingGlyphRecord.layers
            );
            const existingDrawings = this._coerceGlyphDrawingSnapshots(
                existingGlyphRecord.layers
            );
            const existingDrawingsById = new Map(
                existingDrawings
                    .filter(
                        (drawing): drawing is Record<string, unknown> =>
                            !!drawing && typeof drawing === 'object'
                    )
                    .map((drawing) => [String(drawing.id || ''), drawing])
            );

            mergedGlyphRecord.layers = incomingDrawings
                .map((drawing) => {
                    const drawingId =
                        drawing && typeof drawing === 'object'
                            ? String(drawing.id || '')
                            : '';
                    if (!drawingId) {
                        throw new DrawingInvariantError(
                            '',
                            'has no id',
                            'glyph snapshot'
                        );
                    }
                    return this._normalizeDrawingSnapshot(
                        drawingId,
                        drawing,
                        ignoreExisting
                            ? undefined
                            : existingDrawingsById.get(drawingId),
                        !ignoreExisting,
                        undefined,
                        options?.strictDrawings === true
                    );
                })
                .filter(
                    (drawing): drawing is Record<string, unknown> => !!drawing
                );
        }

        return mergedGlyphRecord;
    }

    private _coerceGlyphDrawingSnapshots(
        drawingsSnapshot: unknown
    ): Array<Record<string, unknown>> {
        if (Array.isArray(drawingsSnapshot)) {
            return drawingsSnapshot.filter(
                (drawing): drawing is Record<string, unknown> =>
                    !!drawing &&
                    typeof drawing === 'object' &&
                    !Array.isArray(drawing)
            );
        }

        if (
            drawingsSnapshot &&
            typeof drawingsSnapshot === 'object' &&
            !Array.isArray(drawingsSnapshot)
        ) {
            return Object.entries(drawingsSnapshot as Record<string, unknown>)
                .filter(
                    ([, drawing]) => !!drawing && typeof drawing === 'object'
                )
                .map(([drawingId, drawing]) => {
                    const drawingRecord = cloneHistoryValue(drawing) as Record<
                        string,
                        unknown
                    >;
                    // The key never stands in for a missing id.
                    if (drawingRecord.id !== drawingId) {
                        throw new DrawingInvariantError(
                            drawingId,
                            typeof drawingRecord.id === 'string' &&
                                drawingRecord.id.length
                                ? `carries the id ${drawingRecord.id}`
                                : 'has no id',
                            'glyph drawings'
                        );
                    }
                    return drawingRecord;
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

        const stationNameById = new Map<string, string>();
        const stations = Array.isArray(fontJson.masters)
            ? (fontJson.masters as Unsafe[])
            : [];

        for (const station of stations) {
            if (
                !station ||
                typeof station !== 'object' ||
                Array.isArray(station)
            ) {
                continue;
            }

            const stationId =
                typeof station.id === 'string' && station.id.length
                    ? station.id
                    : '';
            const stationName =
                typeof station.name === 'string'
                    ? station.name
                    : station.name &&
                        typeof station.name === 'object' &&
                        typeof (station.name as Record<string, unknown>)
                            .dflt === 'string'
                      ? String(
                            (station.name as Record<string, unknown>).dflt || ''
                        )
                      : '';

            if (stationId && stationName) {
                stationNameById.set(stationId, stationName);
            }
        }

        const glyphs = Array.isArray(fontJson.glyphs)
            ? (fontJson.glyphs as Unsafe[])
            : [];
        for (const glyph of glyphs) {
            if (!glyph || typeof glyph !== 'object' || Array.isArray(glyph)) {
                continue;
            }

            const drawings = Array.isArray(glyph.layers)
                ? (glyph.layers as Unsafe[])
                : [];
            for (const drawing of drawings) {
                if (
                    !drawing ||
                    typeof drawing !== 'object' ||
                    Array.isArray(drawing)
                ) {
                    continue;
                }

                if (drawing.height === undefined) {
                    delete drawing.height;
                }
                if (drawing.vertWidth === undefined) {
                    delete drawing.vertWidth;
                }
                if (drawing.isInterpolated === false) {
                    delete drawing.isInterpolated;
                }
                if (drawing.name === undefined) {
                    delete drawing.name;
                }

                const station = drawing.master;
                if (
                    !station ||
                    typeof station !== 'object' ||
                    Array.isArray(station) ||
                    station.type !== 'DefaultForMaster' ||
                    typeof station.master !== 'string' ||
                    !station.master.length
                ) {
                    continue;
                }

                const stationName = stationNameById.get(station.master);
                if (
                    typeof drawing.name === 'string' &&
                    (!drawing.name.length ||
                        (stationName && drawing.name === stationName))
                ) {
                    delete drawing.name;
                }
            }
        }
    }

    private _normalizeDrawingStationSnapshot(
        drawingRecord: Record<string, unknown>
    ): void {
        const normalizeStationValue = (
            stationValue: unknown
        ): Record<string, unknown> | null => {
            if (!stationValue || typeof stationValue !== 'object') {
                if (typeof stationValue === 'string' && stationValue.length) {
                    return {
                        type: 'DefaultForMaster',
                        master: stationValue
                    };
                }
                return null;
            }

            if (Array.isArray(stationValue)) {
                return null;
            }

            const stationRecord = cloneHistoryValue(stationValue) as Record<
                string,
                unknown
            >;

            if (stationRecord.type === 'FreeFloating') {
                return { type: 'FreeFloating' };
            }

            if (
                (stationRecord.type === 'DefaultForMaster' ||
                    stationRecord.type === 'AssociatedWithMaster') &&
                typeof stationRecord.master === 'string' &&
                stationRecord.master.length
            ) {
                return {
                    type: stationRecord.type,
                    master: stationRecord.master
                };
            }

            if (
                typeof stationRecord.master === 'string' &&
                stationRecord.master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: stationRecord.master
                };
            }

            if (
                typeof stationRecord.DefaultForMaster === 'string' &&
                stationRecord.DefaultForMaster.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: stationRecord.DefaultForMaster
                };
            }

            if (
                typeof stationRecord.default_for_master === 'string' &&
                stationRecord.default_for_master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: stationRecord.default_for_master
                };
            }

            if (
                typeof stationRecord.AssociatedWithMaster === 'string' &&
                stationRecord.AssociatedWithMaster.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: stationRecord.AssociatedWithMaster
                };
            }

            if (
                typeof stationRecord.associated_with_master === 'string' &&
                stationRecord.associated_with_master.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: stationRecord.associated_with_master
                };
            }

            if ('FreeFloating' in stationRecord) {
                return { type: 'FreeFloating' };
            }

            return null;
        };

        const normalizedStation = normalizeStationValue(drawingRecord.master);

        // A station link the drawing does not carry is never taken from the
        // stored drawing: a whole drawing without one, or a delta that
        // writes a missing or unreadable one, is left as it is and refused
        // by the invariant checks that follow. A delta that does not touch
        // `master` never gets here.
        if (normalizedStation) {
            drawingRecord.master = normalizedStation;
        }
    }

    /**
     * Every drawing has a finite width, a non-empty string id equal to its
     * key, and a station reference (`master`) naming a station by id or
     * marking it a free drawing. A background drawing belongs to the drawing
     * it is behind and does not interpolate: its reference must be there,
     * but imported fonts leave its station id empty. Throws
     * DrawingInvariantError otherwise.
     */
    private _assertDrawingInvariants(
        drawingId: string,
        record: Record<string, unknown>,
        context: string
    ): void {
        if (
            typeof record.width !== 'number' ||
            !Number.isFinite(record.width)
        ) {
            throw new DrawingInvariantError(
                drawingId,
                'has no finite width',
                context
            );
        }
        if (typeof record.id !== 'string' || !record.id.length) {
            throw new DrawingInvariantError(drawingId, 'has no id', context);
        }
        if (record.id !== drawingId) {
            throw new DrawingInvariantError(
                drawingId,
                `carries the id ${record.id}`,
                context
            );
        }
        // One rule with the Y.Doc write gate: a background drawing may leave
        // its station id empty, every other link names its type and station.
        const isBackground = record.is_background === true;
        const violation = describeDrawingStationViolation(record.master, {
            isBackground
        });
        if (violation) {
            throw new DrawingInvariantError(drawingId, violation, context);
        }
        // Whether the station exists is not checked here: it is a fact of
        // font-core, and adding or removing a station reaches font-core and
        // each glyph document in separate packets (undo replays them one
        // document at a time too), so a glyph document can hold a drawing
        // whose station is not there yet, or not any more. Only an entry
        // point that makes a new drawing from this window’s own station
        // list (Glyph.addDrawing) checks it.
    }

    /**
     * `fromStore`: the snapshot is a whole drawing read from its Yjs
     * document (a projection into the model). Every top-level key then comes
     * from it alone: a key the stored drawing no longer has (an undo, redo
     * or remote update deleted it) is gone from the result too, and nothing
     * is taken from `existingDrawingSnapshot`. Runtime-only keys
     * (RESTING_DRAWING_RUNTIME_KEYS) never rest in a drawing either way. A
     * local write's partial JSON still merges with what is stored.
     */
    private _normalizeDrawingSnapshot(
        drawingId: string,
        drawingSnapshot: unknown,
        existingDrawingSnapshot?: unknown,
        preserveMissingKeys = true,
        isExistingFresh?: boolean,
        fromStore = false
    ): unknown {
        if (
            !drawingSnapshot ||
            typeof drawingSnapshot !== 'object' ||
            Array.isArray(drawingSnapshot)
        ) {
            return drawingSnapshot;
        }
        if (fromStore) {
            preserveMissingKeys = false;
            existingDrawingSnapshot = undefined;
        }

        const existingDrawingRecord =
            existingDrawingSnapshot &&
            typeof existingDrawingSnapshot === 'object' &&
            !Array.isArray(existingDrawingSnapshot)
                ? isExistingFresh
                    ? (existingDrawingSnapshot as Record<string, unknown>)
                    : (cloneHistoryValue(existingDrawingSnapshot) as Record<
                          string,
                          unknown
                      >)
                : {};
        const incomingDrawingRecord = cloneHistoryValue(
            drawingSnapshot
        ) as Record<string, unknown>;
        const mergedDrawingRecord = preserveMissingKeys
            ? {
                  ...existingDrawingRecord,
                  ...incomingDrawingRecord
              }
            : { ...incomingDrawingRecord };
        // A drawing's identity comes from the incoming drawing alone, never
        // from an older copy: a snapshot is a whole drawing, and one without
        // its width, id or station is refused below, not patched up.
        for (const key of RESTING_DRAWING_IDENTITY_KEYS as readonly string[]) {
            if (incomingDrawingRecord[key] === undefined) {
                delete mergedDrawingRecord[key];
            }
        }

        this._normalizeDrawingStationSnapshot(mergedDrawingRecord);
        this._assertDrawingInvariants(
            drawingId,
            mergedDrawingRecord,
            'projection'
        );

        const drawingStation = mergedDrawingRecord.master as
            Record<string, unknown> | undefined;
        if (
            drawingStation &&
            typeof drawingStation === 'object' &&
            !Array.isArray(drawingStation) &&
            drawingStation.type === 'DefaultForMaster' &&
            typeof drawingStation.master === 'string' &&
            typeof mergedDrawingRecord.name === 'string'
        ) {
            const stationName = Array.isArray(
                (this._fontJson as Unsafe)?.masters
            )
                ? (((this._fontJson as Unsafe).masters as Unsafe[]).find(
                      (station) => station?.id === drawingStation.master
                  )?.name as string | { dflt?: string } | undefined)
                : undefined;
            const normalizedStationName =
                typeof stationName === 'string'
                    ? stationName
                    : stationName && typeof stationName === 'object'
                      ? String(stationName.dflt || '')
                      : '';
            if (
                !mergedDrawingRecord.name.length ||
                (normalizedStationName &&
                    mergedDrawingRecord.name === normalizedStationName)
            ) {
                delete mergedDrawingRecord.name;
            }
        }

        for (const [key, value] of Object.entries(mergedDrawingRecord)) {
            if (value === undefined) {
                delete mergedDrawingRecord[key];
            }
        }

        const incomingHasShapes = Object.prototype.hasOwnProperty.call(
            incomingDrawingRecord,
            'shapes'
        );
        const existingShapes = existingDrawingRecord.shapes;
        if (
            preserveMissingKeys &&
            !incomingHasShapes &&
            Array.isArray(existingShapes) &&
            existingShapes.length > 0
        ) {
            mergedDrawingRecord.shapes = existingShapes;
        }

        if (mergedDrawingRecord.isInterpolated === false) {
            delete mergedDrawingRecord.isInterpolated;
        }
        // An empty format_specific is the drawing having no format-specific
        // data, as the stored drawing says it (its empty map is read back
        // as no key; see fromYDrawingMap). It is not a missing value.
        const formatSpecific = mergedDrawingRecord[DRAWING_FORMAT_SPECIFIC_KEY];
        if (
            formatSpecific &&
            typeof formatSpecific === 'object' &&
            !Array.isArray(formatSpecific) &&
            Object.keys(formatSpecific).length === 0
        ) {
            delete mergedDrawingRecord[DRAWING_FORMAT_SPECIFIC_KEY];
        }

        return toRestingDrawingJson(mergedDrawingRecord, {
            existing: preserveMissingKeys ? existingDrawingRecord : undefined,
            mode: 'replace',
            context: 'history snapshot'
        });
    }

    /**
     * Apply a sparse drawing delta to the Y.Doc.
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
    private _applyDrawingDelta(
        glyphName: string,
        drawingId: string,
        delta: unknown
    ): void {
        const context = `drawing delta for glyph ${glyphName}`;
        const glyphMap = this._glyphMapForName(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            throw new Error(
                `[PatchSyncEngine] Refusing a ${context}: the glyph has no document`
            );
        }

        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
            throw new DrawingInvariantError(
                drawingId,
                'got a delta that is not an object',
                context
            );
        }

        const deltaRecord = delta as Record<string, unknown>;

        // Empty delta → nothing to apply.
        const deltaKeys = Object.keys(deltaRecord);
        if (deltaKeys.length === 0) {
            return;
        }

        // The drawings map is created with the glyph; a glyph without one
        // is refused.
        const drawingsMap = ensureGlyphDrawingsMap(glyphMap);
        const existingDrawingValue = drawingsMap.get(drawingId);
        const existingDrawingMap =
            existingDrawingValue instanceof Y.Map
                ? existingDrawingValue
                : undefined;

        // Read existing Y.Doc state for station normalization context.
        const existingYDocRecord = existingDrawingMap
            ? (fromYType(existingDrawingMap) as Record<string, unknown> | null)
            : null;

        // Clone the delta — _normalizeDrawingStationSnapshot mutates it. All
        // normalizing happens here, before any map is created or written.
        const workingRecord = toRestingDrawingJson(
            cloneHistoryValue(deltaRecord) as Record<string, unknown>,
            {
                existing: existingYDocRecord,
                mode: 'delta',
                context: 'Y.Doc write'
            }
        ) as Record<string, unknown>;

        // Normalize station if it changed.
        if ('master' in workingRecord) {
            this._normalizeDrawingStationSnapshot(workingRecord);
        }

        // An identity key in a delta is a value to write, never a deletion.
        for (const key of RESTING_DRAWING_IDENTITY_KEYS as readonly string[]) {
            if (!(key in workingRecord)) {
                continue;
            }
            const value = workingRecord[key];
            if (value === null || value === undefined) {
                throw new DrawingInvariantError(
                    drawingId,
                    `would lose ${key}`,
                    context
                );
            }
        }
        if (
            'width' in workingRecord &&
            (typeof workingRecord.width !== 'number' ||
                !Number.isFinite(workingRecord.width))
        ) {
            throw new DrawingInvariantError(
                drawingId,
                'got a width that is not a finite number',
                context
            );
        }
        if ('id' in workingRecord && workingRecord.id !== drawingId) {
            throw new DrawingInvariantError(
                drawingId,
                `got the id ${String(workingRecord.id)}`,
                context
            );
        }

        // The drawing after this delta must hold every identity key: a new
        // drawing is checked whole before its map exists.
        const resultingRecord: Record<string, unknown> = {
            ...(existingYDocRecord ?? {}),
            ...workingRecord
        };
        this._assertDrawingInvariants(drawingId, resultingRecord, context);

        // Strip isInterpolated if set to false in the delta.
        if (workingRecord.isInterpolated === false) {
            workingRecord.isInterpolated = null;
        }

        if (!existingDrawingMap) {
            // A new drawing is built whole while detached, then inserted,
            // so it never exists half-written. A null key is simply absent.
            drawingsMap.set(
                drawingId,
                drawingToYMap(
                    Object.fromEntries(
                        Object.entries(workingRecord).filter(
                            ([, value]) => value !== null && value !== undefined
                        )
                    )
                )
            );
            return;
        }
        const drawingMap = existingDrawingMap;

        for (const runtimeKey of RESTING_DRAWING_RUNTIME_KEYS) {
            drawingMap.delete(runtimeKey);
        }

        // Apply each delta key to the Y.Map.
        for (const [key, value] of Object.entries(workingRecord)) {
            if (value === null || value === undefined) {
                if (key === 'shapes') {
                    writeDrawingGeometry(drawingMap, [], toYType);
                    continue;
                }
                if (key === 'anchors' || key === 'guides') {
                    // The keyed maps are created with the drawing and never
                    // deleted: a map created again by a later first entry
                    // races a collaborator's, and every entry in the map
                    // that loses disappears. Only the entries go.
                    applyIndexedMapArrayToYMap(drawingMap, key, []);
                    continue;
                }
                if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
                    // Emptied, never deleted: the map is created with the
                    // drawing so collaborators share it.
                    writeDrawingFormatSpecific(drawingMap, null);
                    continue;
                }
                if (INDEXED_MAP_KEYS[key]) {
                    const mapping = INDEXED_MAP_KEYS[key]!;
                    drawingMap.delete(mapping.byId);
                    drawingMap.delete(mapping.order);
                } else {
                    drawingMap.delete(key);
                }
            } else {
                // Anchors/guides are stored as indexed maps. Shapes use
                // atomic topology plus packed node positions.
                if (
                    (key === 'anchors' || key === 'guides') &&
                    Array.isArray(value)
                ) {
                    applyIndexedMapArrayToYMap(drawingMap, key, value);
                    continue;
                }
                if (key === 'shapes' && Array.isArray(value)) {
                    writeDrawingGeometry(drawingMap, value, toYType);
                    continue;
                }
                if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
                    writeDrawingFormatSpecific(drawingMap, value);
                    continue;
                }

                this._replaceYMapEntry(drawingMap, key, value);
            }
        }
    }

    private _targetFromHistoryItem(
        item: HistoryStackItem,
        fallbackGlyphName: string | null,
        fallbackDrawingId: string | null
    ): UndoTarget {
        const glyphNames = deriveGlyphNamesFromPaths(item.touchedPaths);
        const drawingIds = deriveDrawingIdsFromPaths(item.touchedPaths);
        if (item.undoScope === 'layer') {
            return {
                glyphName:
                    item.originatingGlyphName ??
                    glyphNames[0] ??
                    fallbackGlyphName,
                layerId:
                    item.originatingLayerId ??
                    drawingIds[0] ??
                    fallbackDrawingId
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

    private _scopeForTarget(target: UndoTarget): UndoScope {
        if (target.glyphName && target.layerId) {
            return 'layer';
        }
        if (target.glyphName) {
            return 'glyph';
        }
        return 'font';
    }

    private _trimChangeLogIfNeeded(): void {
        const MAX_CHANGE_LOG_ENTRIES = 2000;
        if (this._changeLog.length <= MAX_CHANGE_LOG_ENTRIES) {
            return;
        }
        // Only trim entries already emitted and broadcast so pending packet
        // cursors stay intact, and never split a logical historyItemId group.
        const maxTrimmable = Math.min(
            this._lastLocalUpdateLogIndex,
            this._lastBroadcastLogIndex
        );
        const targetTrim = this._changeLog.length - MAX_CHANGE_LOG_ENTRIES;
        let cut = Math.min(targetTrim, maxTrimmable);
        if (cut <= 0) {
            return;
        }
        const boundaryItemId = this._changeLog[cut]?.historyItemId;
        if (boundaryItemId) {
            while (
                cut > 0 &&
                this._changeLog[cut - 1]?.historyItemId === boundaryItemId
            ) {
                cut -= 1;
            }
        }
        if (cut <= 0) {
            return;
        }
        this._changeLog.splice(0, cut);
        this._lastLocalUpdateLogIndex -= cut;
        this._lastBroadcastLogIndex -= cut;
        this._historyGlyphNames = null;
        if (this._collaboratorTouches.length) {
            const shifted: Array<{ seq: number; path: string }> = [];
            for (const touch of this._collaboratorTouches) {
                const nextSeq = touch.seq - cut;
                if (nextSeq >= 0) {
                    shifted.push({ seq: nextSeq, path: touch.path });
                }
            }
            this._collaboratorTouches = shifted;
        }
        if (this._collaboratorDrawingSetTouches.length) {
            const shifted: Array<{ seq: number; glyphName: string }> = [];
            for (const touch of this._collaboratorDrawingSetTouches) {
                const nextSeq = touch.seq - cut;
                if (nextSeq >= 0) {
                    shifted.push({ seq: nextSeq, glyphName: touch.glyphName });
                }
            }
            this._collaboratorDrawingSetTouches = shifted;
        }
    }

    private _appendChangeLogEntry(entry: ChangeLogEntry): void {
        this._changeLog.push(normalizeChangeLogEntry(entry));
        this._trimChangeLogIfNeeded();
        this._notifyChangeLogListeners();
    }

    private _appendChangeLogEntries(entries: ChangeLogEntry[]): void {
        if (!entries.length) {
            return;
        }
        this._changeLog.push(
            ...entries.map((entry) => normalizeChangeLogEntry(entry))
        );
        this._trimChangeLogIfNeeded();
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
        const originating = resolveCollaborationOriginatingDrawing(
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
            ...(message.metadata.allGlyphsChanged === true
                ? { allGlyphsChanged: true as const }
                : undefined),
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
        const MAX_COLLABORATION_LOG_ITEMS = 200;
        if (this._collaborationLog.length > MAX_COLLABORATION_LOG_ITEMS) {
            this._collaborationLog.splice(
                0,
                this._collaborationLog.length - MAX_COLLABORATION_LOG_ITEMS
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
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}
