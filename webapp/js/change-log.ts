/**
 * Change Log — Metadata for undo history entries.
 *
 * Each entry records a single property change (or an add/remove operation)
 * with enough context for the history UI to display, filter, and
 * selectively revert changes.
 */

/** Object types that can appear in change log entries */
export type ChangeObjectType =
    | 'font'
    | 'glyph'
    | 'layer'
    | 'path'
    | 'node'
    | 'component'
    | 'anchor'
    | 'guide'
    | 'axis'
    | 'master'
    | 'instance'
    | 'shape'
    | 'feature'
    | 'class'
    | 'prefix';

export type HistoryTargetType = 'feature' | 'class' | 'prefix';

export type WorkerReplayTarget = {
    glyphName: string;
    layerId: string;
};

/** An atomic glyph-map key rename for worker cache maintenance. */
export type GlyphRename = {
    oldName: string;
    newName: string;
};

/** Operation type */
export type ChangeOp = 'set' | 'add' | 'remove';

/** Logical history action type */
export type HistoryAction = 'change' | 'undo' | 'redo';

/** Undo scope for a logical history item */
export type UndoScope = 'font' | 'glyph' | 'layer';

/** Focused editing surface that owns a Cmd+Z stack */
export type HistoryUndoSurface =
    'canvas' | 'overview' | 'font' | 'feature' | 'automation';

/**
 * Surfaces that may own font-scoped edits made outside Font Info
 * (e.g. text-mode kerning on the Editing View).
 */
export type UndoSurfaceAffinity = 'canvas' | 'overview';

/** Edit sources stamped on Python / Assistant font mutations */
export const AUTOMATION_EDIT_SOURCES = new Set(['python', 'assistant']);

/**
 * True when a history item was produced by Scripts, Konsole, or Assistant
 * Python execution (including assistant prompt-grouped packets).
 */
export function isAutomationSourcedHistoryItem(item: {
    transactionLabel: string | null;
    entries: Array<{
        editSource?: string | null;
        compileChangeSource?: string | null;
        promptGroupId?: string | null;
        transactionLabel?: string | null;
    }>;
}): boolean {
    if (item.transactionLabel === 'Python script') {
        return true;
    }

    return item.entries.some((entry) => {
        if (entry.promptGroupId) {
            return true;
        }
        if (entry.transactionLabel === 'Python script') {
            return true;
        }
        const source = entry.editSource ?? entry.compileChangeSource ?? null;
        return !!source && AUTOMATION_EDIT_SOURCES.has(source);
    });
}

function isAutomationEditSource(
    editSource?: string | null,
    compileChangeSource?: string | null
): boolean {
    const source = editSource ?? compileChangeSource ?? null;
    return !!source && AUTOMATION_EDIT_SOURCES.has(source);
}

/**
 * Font-root paths that the Editing View commonly writes (kerning / kern groups).
 * Used as a headless fallback when no focused undo surface is available.
 */
export function isEditorOwnedFontPath(path: string): boolean {
    if (!path) {
        return false;
    }
    if (path === 'first_kern_groups' || path.startsWith('first_kern_groups.')) {
        return true;
    }
    if (
        path === 'second_kern_groups' ||
        path.startsWith('second_kern_groups.')
    ) {
        return true;
    }
    return /^masters\.[^.]+\.kerning(_rtl)?(\.|$)/.test(path);
}

/**
 * Which non-Font undo surface should own this font-scoped (or mixed) edit.
 * Automation and feature targets stay on their dedicated surfaces.
 */
export function resolveUndoSurfaceAffinity(options: {
    explicit?: UndoSurfaceAffinity | null;
    contextSurface?: HistoryUndoSurface | null;
    editSource?: string | null;
    compileChangeSource?: string | null;
    historyTargetKey?: string | null;
    transactionLabel?: string | null;
    paths?: string[];
}): UndoSurfaceAffinity | null {
    if (options.historyTargetKey) {
        return null;
    }
    if (
        options.transactionLabel === 'Python script' ||
        isAutomationEditSource(options.editSource, options.compileChangeSource)
    ) {
        return null;
    }
    if (options.explicit === 'canvas' || options.explicit === 'overview') {
        return options.explicit;
    }
    if (
        options.contextSurface === 'canvas' ||
        options.contextSurface === 'overview'
    ) {
        return options.contextSurface;
    }
    // Font / feature / automation context: keep affinity unset so those
    // surfaces own the item via their normal matchers.
    if (options.contextSurface) {
        return null;
    }
    const paths = options.paths ?? [];
    if (
        paths.length > 0 &&
        paths.every((path) => isEditorOwnedFontPath(path))
    ) {
        return 'canvas';
    }
    return null;
}

export function deriveOriginatingLayerFromPaths(paths: string[]): {
    glyphName: string | null;
    layerId: string | null;
} {
    for (const path of paths) {
        const glyphName = deriveGlyphNameFromPath(path);
        const layerId = deriveLayerIdFromPath(path);
        if (glyphName && layerId) {
            return { glyphName, layerId };
        }
    }
    return { glyphName: null, layerId: null };
}

function operationPathTouchesLayer(
    path: (string | number)[] | undefined
): boolean {
    return !!path && !!deriveLayerId(path);
}

/**
 * Transaction undo origin: the layer the user edited, not each written
 * cascade/replay target. Canvas context wins for layer-touching commits so
 * dependent snapshots cannot claim ownership. Font-root canvas edits (kerning)
 * leave origin unset.
 */
export function resolveCommitOriginatingLayer(options: {
    contextSurface?: HistoryUndoSurface | null;
    contextGlyphName?: string | null;
    contextLayerId?: string | null;
    operations: Array<{
        originatingGlyphName?: string | null;
        originatingLayerId?: string | null;
        path?: (string | number)[];
        applyPath?: (string | number)[];
    }>;
}): { glyphName: string | null; layerId: string | null } {
    const operations = options.operations ?? [];
    const touchesLayer = operations.some(
        (operation) =>
            operationPathTouchesLayer(operation.applyPath) ||
            operationPathTouchesLayer(operation.path)
    );

    if (
        options.contextSurface === 'canvas' &&
        options.contextGlyphName &&
        options.contextLayerId &&
        touchesLayer
    ) {
        return {
            glyphName: options.contextGlyphName,
            layerId: options.contextLayerId
        };
    }

    for (const operation of operations) {
        if (operation.originatingGlyphName && operation.originatingLayerId) {
            return {
                glyphName: operation.originatingGlyphName,
                layerId: operation.originatingLayerId
            };
        }
    }

    return deriveOriginatingLayerFromPaths(
        operations.map((operation) => {
            const path = operation.applyPath ?? operation.path ?? [];
            return joinPathWithGlyphSeparator(path);
        })
    );
}

/**
 * Originating layer for collaboration / history display metadata.
 *
 * Only layer-scoped edits invent an origin from paths. Font- and glyph-scoped
 * packets often include many layer paths as structural payloads (add/remove
 * master, glyph paste cascades); those must not become a fake Layer origin.
 */
export function resolveCollaborationOriginatingLayer(
    undoScope: UndoScope,
    entries: Array<{
        path: string;
        originatingGlyphName?: string | null;
        originatingLayerId?: string | null;
    }>
): { glyphName: string | null; layerId: string | null } {
    for (const entry of entries) {
        if (entry.originatingGlyphName && entry.originatingLayerId) {
            return {
                glyphName: entry.originatingGlyphName,
                layerId: entry.originatingLayerId
            };
        }
    }

    if (undoScope !== 'layer') {
        return { glyphName: null, layerId: null };
    }

    return deriveOriginatingLayerFromPaths(entries.map((entry) => entry.path));
}

function collectTouchedLayerIdsForGlyph(
    paths: string[],
    glyphName: string
): Set<string> {
    const layerIds = new Set<string>();
    for (const path of paths) {
        if (deriveGlyphNameFromPath(path) !== glyphName) {
            continue;
        }
        const layerId = deriveLayerIdFromPath(path);
        if (layerId) {
            layerIds.add(layerId);
        }
    }
    return layerIds;
}

/**
 * History row origin subtitle: which undo surface owns this edit.
 * Prefers stamped undoScope over path-inferred layer identity.
 */
export function formatHistoryOriginLabel(options: {
    undoScope: UndoScope;
    undoSurfaceAffinity?: UndoSurfaceAffinity | null;
    historyTargetKey?: string | null;
    historyTargetLabel?: string | null;
    originatingGlyphName?: string | null;
    originatingLayerId?: string | null;
    changePaths?: string[];
    resolveLayerMasterDisplayName?: (
        glyphName: string,
        layerOrMasterId: string
    ) => string;
}): string {
    if (options.historyTargetKey || options.historyTargetLabel) {
        return `Feature · ${options.historyTargetLabel || options.historyTargetKey}`;
    }

    if (options.undoSurfaceAffinity === 'canvas') {
        const layerOriginLabel = formatLayerHistoryOriginLabel(options);
        if (layerOriginLabel) {
            return layerOriginLabel;
        }
        return 'Editing View';
    }

    if (options.undoSurfaceAffinity === 'overview') {
        return 'Overview';
    }

    if (options.undoScope === 'font') {
        return 'Font';
    }

    if (options.undoScope === 'glyph') {
        const layerOriginLabel = formatLayerHistoryOriginLabel(options);
        if (layerOriginLabel) {
            return layerOriginLabel;
        }
        return 'Overview';
    }

    return formatLayerHistoryOriginLabel(options) ?? 'Font';
}

function formatLayerHistoryOriginLabel(options: {
    originatingGlyphName?: string | null;
    originatingLayerId?: string | null;
    changePaths?: string[];
    resolveLayerMasterDisplayName?: (
        glyphName: string,
        layerOrMasterId: string
    ) => string;
}): string | null {
    const pathOrigin = deriveOriginatingLayerFromPaths(
        options.changePaths ?? []
    );
    const originatingGlyph =
        options.originatingGlyphName ?? pathOrigin.glyphName;
    const originatingLayer = options.originatingLayerId ?? pathOrigin.layerId;

    if (!originatingGlyph || !originatingLayer) {
        return null;
    }

    const touchedLayerIds = collectTouchedLayerIdsForGlyph(
        options.changePaths ?? [],
        originatingGlyph
    );
    if (touchedLayerIds.size > 1) {
        return `Layer · ${originatingGlyph}`;
    }

    const layerLabel = options.resolveLayerMasterDisplayName
        ? options.resolveLayerMasterDisplayName(
              originatingGlyph,
              originatingLayer
          )
        : originatingLayer;
    return `Layer · ${originatingGlyph} / ${layerLabel}`;
}

export function normalizeGlyphRenames(
    renames: Iterable<GlyphRename | null | undefined> | null | undefined
): GlyphRename[] {
    if (!renames) return [];

    const normalized = new Map<string, GlyphRename>();
    for (const rename of renames) {
        if (
            !rename?.oldName ||
            !rename.newName ||
            rename.oldName === rename.newName
        ) {
            continue;
        }
        normalized.set(rename.oldName, {
            oldName: rename.oldName,
            newName: rename.newName
        });
    }
    return [...normalized.values()];
}

/**
 * Adapt stored forward renames for undo/redo worker metadata.
 * Undo inverts identity so apply_yjs_update resolves post-undo Y.Doc snapshots.
 */
export function glyphRenamesForHistoryAction(
    renames: Iterable<GlyphRename | null | undefined> | null | undefined,
    historyAction: HistoryAction
): GlyphRename[] {
    const normalized = normalizeGlyphRenames(renames);
    if (historyAction !== 'undo') {
        return normalized;
    }
    return normalizeGlyphRenames(
        normalized.map(({ oldName, newName }) => ({
            oldName: newName,
            newName: oldName
        }))
    );
}
export function getLayerTouchKey(
    glyphName: string | null,
    layerId: string | null
): string | null {
    if (!glyphName || !layerId) {
        return null;
    }
    return `${glyphName}@@${layerId}`;
}

export function normalizeWorkerReplayTargets(
    targets: Iterable<WorkerReplayTarget | null | undefined> | null | undefined
): WorkerReplayTarget[] {
    if (!targets) {
        return [];
    }

    const normalizedTargets = new Map<string, WorkerReplayTarget>();
    for (const target of targets) {
        if (!target?.glyphName || !target?.layerId) {
            continue;
        }

        normalizedTargets.set(
            getLayerTouchKey(target.glyphName, target.layerId)!,
            {
                glyphName: target.glyphName,
                layerId: target.layerId
            }
        );
    }

    return [...normalizedTargets.values()];
}

/**
 * A single entry in the change log.
 */
export interface ChangeLogEntry {
    /** Unique ID for this entry (monotonically increasing) */
    id: number;
    /** Unix timestamp (ms) */
    timestamp: number;
    /** Elapsed wall-clock time for the logical transaction, if measured */
    transactionDurationMs: number | null;
    /** Opaque source window instance identifier */
    windowId: string;
    /** Human-readable source window label */
    windowRoleLabel: string;
    /** Logical history stack item identifier */
    historyItemId: string;
    /** Whether this row is a change or an undo/redo control action */
    historyAction: HistoryAction;
    /** Linked logical history item affected by undo/redo, if known */
    targetHistoryItemId: string | null;
    /** Transaction label, if this change is part of a batch */
    transactionLabel: string | null;
    /** Transaction ID, shared by all entries in the same batch */
    transactionId: number | null;
    /** Operation type */
    op: ChangeOp;
    /** Effective undo scope for this entry */
    undoScope: UndoScope;
    /**
     * Non-Font undo surface that owns this edit when scope alone is wrong
     * (e.g. text-mode kerning → Editing View / canvas).
     */
    undoSurfaceAffinity: UndoSurfaceAffinity | null;
    /** Full dot-delimited path: "glyphs.A.layers.uuid-1.shapes.0.nodes.2.x" */
    path: string;
    /** Value before the change (undefined for "add" ops) */
    oldValue: unknown;
    /** Value after the change (undefined for "remove" ops) */
    newValue: unknown;
    /** Optional replay payload before the change, when labels differ from replay data */
    replayOldValue?: unknown;
    /** Optional replay payload after the change, when labels differ from replay data */
    replayNewValue?: unknown;
    /** Exact producer-side edit source stamped onto the committed packet */
    editSource?: string | null;
    /** Exact compile source stamped onto the committed packet by the producer */
    compileChangeSource?: string | null;
    /** Compile edit type stamped onto the committed packet by the producer */
    compileEditType?: string | null;
    /** Concise assistant-provided description of a grouped prompt. */
    historySummary?: string | null;
    /** Presentation-only key that groups assistant prompt commits in history UI. */
    promptGroupId?: string | null;
    /** Optional features-editor target type for scoped history */
    historyTargetType: HistoryTargetType | null;
    /** Optional stable-enough features-editor target key */
    historyTargetKey: string | null;
    /** Human-readable target label */
    historyTargetLabel: string | null;
    /** Explicit canvas origin for the forward edit, when path alone is ambiguous */
    originatingGlyphName: string | null;
    originatingLayerId: string | null;
    /** Which screen side stayed visually anchored for this edit */
    visualAnchorSide?: 'left' | 'right' | null;
    /** Exact worker cache layer targets needed to replay this edit incrementally */
    workerReplayTargets: WorkerReplayTarget[];
    /** Glyph-map key moves that must preserve cache ordering without a Y.Doc dump. */
    glyphRenames: GlyphRename[];
    /** Original semantic entries represented by an undo/redo control row. */
    semanticChangeLogEntries?: ChangeLogEntry[];
}

let _nextId = 1;

/** Create a new ChangeLogEntry with an auto-incremented id. */
export function createLogEntry(
    fields: Omit<
        ChangeLogEntry,
        | 'id'
        | 'historyItemId'
        | 'historyAction'
        | 'targetHistoryItemId'
        | 'undoScope'
        | 'undoSurfaceAffinity'
        | 'historyTargetType'
        | 'historyTargetKey'
        | 'historyTargetLabel'
        | 'originatingGlyphName'
        | 'originatingLayerId'
        | 'transactionDurationMs'
        | 'editSource'
        | 'workerReplayTargets'
        | 'glyphRenames'
        | 'compileChangeSource'
        | 'compileEditType'
        | 'historySummary'
        | 'promptGroupId'
        | 'semanticChangeLogEntries'
    > & {
        historyItemId?: string;
        historyAction?: HistoryAction;
        targetHistoryItemId?: string | null;
        undoScope?: UndoScope;
        undoSurfaceAffinity?: UndoSurfaceAffinity | null;
        glyphName?: string | null;
        layerId?: string | null;
        objectType?: ChangeObjectType;
        objectId?: string;
        property?: string;
        touchedPaths?: string[];
        touchedGlyphNames?: string[];
        touchedLayerKeys?: string[];
        historyTargetType?: HistoryTargetType | null;
        historyTargetKey?: string | null;
        historyTargetLabel?: string | null;
        originatingGlyphName?: string | null;
        originatingLayerId?: string | null;
        transactionDurationMs?: number | null;
        editSource?: string | null;
        compileChangeSource?: string | null;
        compileEditType?: string | null;
        historySummary?: string | null;
        promptGroupId?: string | null;
        visualAnchorSide?: 'left' | 'right' | null;
        workerReplayTargets?: WorkerReplayTarget[];
        glyphRenames?: GlyphRename[];
        replayOldValue?: unknown;
        replayNewValue?: unknown;
        semanticChangeLogEntries?: ChangeLogEntry[];
    }
): ChangeLogEntry {
    const nextId = _nextId++;
    const glyphName = deriveGlyphNameFromPath(fields.path);
    const layerId = deriveLayerIdFromPath(fields.path);
    return attachDerivedEntryAccessors({
        id: nextId,
        historyItemId: fields.historyItemId ?? `history-item-${nextId}`,
        historyAction: fields.historyAction ?? 'change',
        targetHistoryItemId: fields.targetHistoryItemId ?? null,
        undoScope: fields.undoScope ?? deriveUndoScope(glyphName, layerId),
        undoSurfaceAffinity: fields.undoSurfaceAffinity ?? null,
        timestamp: fields.timestamp,
        transactionDurationMs: fields.transactionDurationMs ?? null,
        windowId: fields.windowId,
        windowRoleLabel: fields.windowRoleLabel,
        transactionLabel: fields.transactionLabel,
        transactionId: fields.transactionId,
        op: fields.op,
        path: fields.path,
        oldValue: fields.oldValue,
        newValue: fields.newValue,
        replayOldValue: fields.replayOldValue,
        replayNewValue: fields.replayNewValue,
        editSource: fields.editSource ?? null,
        compileChangeSource: fields.compileChangeSource ?? null,
        compileEditType: fields.compileEditType ?? null,
        historySummary: fields.historySummary ?? null,
        promptGroupId: fields.promptGroupId ?? null,
        historyTargetType: fields.historyTargetType ?? null,
        historyTargetKey: fields.historyTargetKey ?? null,
        historyTargetLabel: fields.historyTargetLabel ?? null,
        originatingGlyphName: fields.originatingGlyphName ?? null,
        originatingLayerId: fields.originatingLayerId ?? null,
        visualAnchorSide: fields.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            fields.workerReplayTargets
        ),
        glyphRenames: normalizeGlyphRenames(fields.glyphRenames),
        semanticChangeLogEntries: fields.semanticChangeLogEntries ?? undefined
    });
}

export type ChangeLogEntryLike = Omit<
    ChangeLogEntry,
    'windowRoleLabel' | 'historyItemId' | 'historyAction' | 'undoScope'
> & {
    undoScope?: UndoScope | null;
    undoSurfaceAffinity?: UndoSurfaceAffinity | null;
    windowRoleLabel?: string | null;
    historyItemId?: string | null;
    historyAction?: HistoryAction | null;
    targetHistoryItemId?: string | null;
    glyphName?: string | null;
    layerId?: string | null;
    objectType?: ChangeObjectType | null;
    objectId?: string | null;
    property?: string | null;
    touchedPaths?: string[] | null;
    touchedGlyphNames?: string[] | null;
    touchedLayerKeys?: string[] | null;
    historyTargetType?: HistoryTargetType | null;
    historyTargetKey?: string | null;
    historyTargetLabel?: string | null;
    originatingGlyphName?: string | null;
    originatingLayerId?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[] | null;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    semanticChangeLogEntries?: ChangeLogEntryLike[] | null;
};

export interface HistoryStackItem {
    id: string;
    entries: ChangeLogEntry[];
    timestamp: number;
    transactionDurationMs: number | null;
    windowRoleLabel: string;
    transactionLabel: string | null;
    historySummary: string | null;
    undoScope: UndoScope;
    /** Non-Font surface that owns this item when present. */
    undoSurfaceAffinity: UndoSurfaceAffinity | null;
    touchedPaths: string[];
    isActive: boolean;
    lastAction: HistoryAction;
    historyTargetKeys: string[];
    workerReplayTargets: WorkerReplayTarget[];
    /** Glyph/layer where the forward edit started; canvas undo also includes other written layers of this glyph. */
    originatingGlyphName: string | null;
    originatingLayerId: string | null;
}

const FONT_SCOPE_KEY = '__font__';

function getGlyphScopeKey(glyphName: string | null): string {
    return glyphName ?? FONT_SCOPE_KEY;
}

export function isDerivedLayerChangePath(
    path: string,
    originatingGlyphName: string | null | undefined
): boolean {
    if (!originatingGlyphName) {
        return false;
    }
    const glyphName = deriveGlyphNameFromPath(path);
    return !!glyphName && glyphName !== originatingGlyphName;
}

function getLayerScopeKey(
    glyphName: string | null,
    layerId: string | null
): string | null {
    return getLayerTouchKey(glyphName, layerId);
}

/**
 * Join path segments using a deterministic glyph-name separator.
 *
 * The glyph name (path[1]) is separated from the rest of the path by ':'
 * so that downstream parsing can extract the glyph name in O(1) without
 * consulting a glyph-name list.  All other segments use '.'.
 *
 * Only applies ':' when path[0] is 'glyphs' — all other path roots
 * (axes, masters, features, etc.) use plain dot-joining.
 */
function encodePathSegment(segment: string | number): string {
    return String(segment).replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

function encodePathTail(segments: (string | number)[]): string {
    return segments.map(encodePathSegment).join('.');
}

/** Split on dots that are not escaped by a preceding backslash. */
function decodePathTail(tail: string): string[] {
    if (!tail) {
        return [];
    }
    const segments: string[] = [];
    let current = '';
    for (let index = 0; index < tail.length; index++) {
        const char = tail[index];
        if (char === '\\' && index + 1 < tail.length) {
            current += tail[index + 1];
            index++;
            continue;
        }
        if (char === '.') {
            segments.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    segments.push(current);
    return segments;
}

export function joinPathWithGlyphSeparator(path: (string | number)[]): string {
    if (path.length === 0) return '';
    if (path[0] !== 'glyphs') return path.join('.');
    if (path.length === 1) return 'glyphs';
    // Glyph-root add/remove paths must terminate the name with ':' so dotted
    // names like fourFarsi-ar.locl round-trip through getPathSegments.
    if (path.length === 2) {
        return `${path[0]}.${path[1]}:`;
    }
    // Glyph-level fields are not layer ids. A trailing colon here makes
    // format_specific.metric_left look like a layer named metric_left.
    if (path[2] !== 'layers') {
        return `${path[0]}.${path[1]}:${encodePathTail(path.slice(2))}`;
    }
    // Separator after glyph name
    let result = path[0] + '.' + path[1] + ':' + path[2];
    if (path.length <= 3) return result;
    // Separator after layer ID (path[3]). Later segments may contain dots
    // (Glyphs metrics-key names), so those dots are escaped.
    result += '.' + path[3] + ':' + encodePathTail(path.slice(4));
    return result;
}

/**
 * Split a change-path string that uses ':' as the separator at glyph-name
 * and layer-ID boundaries.
 *
 * Format: glyphs.{glyphName}:layers.{layerId}:shapes.0.nodes.2.x
 * (glyph names and layer IDs may contain dots — ':' is unambiguous.)
 */
function splitGlyphPath(path: string): string[] | null {
    if (!path.startsWith('glyphs.')) {
        return null;
    }

    const rest = path.slice('glyphs.'.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx < 0) {
        // Legacy path without ':' — fall back to dot-splitting.
        return path.split('.');
    }

    const glyphName = rest.slice(0, colonIdx);
    const afterGlyph = rest.slice(colonIdx + 1);
    if (!afterGlyph) return ['glyphs', glyphName];

    // Split layer-id boundary: layers.{layerId}:rest
    const secondColonIdx = afterGlyph.indexOf(':');
    if (secondColonIdx < 0) {
        // No layer separator — remainder is a glyph-level field path.
        return ['glyphs', glyphName, ...decodePathTail(afterGlyph)];
    }

    const layerPart = afterGlyph.slice(0, secondColonIdx); // "layers.layer.regular.v1"
    const afterLayer = afterGlyph.slice(secondColonIdx + 1); // "shapes.0.nodes.2.x"

    const layerSegments = layerPart.split('.');
    // layerSegments[0] should be "layers", the rest is the layer ID
    const layerId = layerSegments.slice(1).join('.');

    const segments = ['glyphs', glyphName, 'layers', layerId];
    if (!afterLayer) return segments;

    return [...segments, ...decodePathTail(afterLayer)];
}

export function getPathSegments(path: string): string[] {
    if (!path || path === 'font') {
        return [];
    }

    return splitGlyphPath(path) || path.split('.');
}

function derivePropertyFromPath(path: string): string {
    const segments = getPathSegments(path);
    if (!segments.length) {
        return '';
    }

    const lastSegment = segments[segments.length - 1];
    if (typeof lastSegment !== 'string') {
        return '';
    }

    const fullObject = deriveObjectInfo(segments);
    const parentObject = deriveObjectInfo(segments.slice(0, -1));
    if (
        fullObject.objectType !== parentObject.objectType ||
        fullObject.objectId !== parentObject.objectId
    ) {
        return '';
    }

    return lastSegment;
}

function attachDerivedEntryAccessors(entry: ChangeLogEntry): ChangeLogEntry {
    Object.defineProperties(entry, {
        glyphName: {
            configurable: true,
            enumerable: false,
            get: () => deriveGlyphNameFromPath(entry.path)
        },
        layerId: {
            configurable: true,
            enumerable: false,
            get: () => deriveLayerIdFromPath(entry.path)
        },
        objectType: {
            configurable: true,
            enumerable: false,
            get: () => deriveObjectInfoFromPath(entry.path).objectType
        },
        objectId: {
            configurable: true,
            enumerable: false,
            get: () => deriveObjectInfoFromPath(entry.path).objectId
        },
        property: {
            configurable: true,
            enumerable: false,
            get: () => derivePropertyFromPath(entry.path)
        },
        touchedPaths: {
            configurable: true,
            enumerable: false,
            get: () => [entry.path]
        },
        touchedGlyphNames: {
            configurable: true,
            enumerable: false,
            get: () => deriveGlyphNamesFromPaths([entry.path])
        },
        touchedLayerKeys: {
            configurable: true,
            enumerable: false,
            get: () => deriveLayerTouchKeysFromPaths([entry.path])
        }
    });

    return entry;
}

function normalizeHistoryAction(
    historyAction: HistoryAction | null | undefined
): HistoryAction {
    if (
        historyAction === 'change' ||
        historyAction === 'undo' ||
        historyAction === 'redo'
    ) {
        return historyAction;
    }
    return 'change';
}

function normalizeHistoryItemId(
    historyItemId: string | null | undefined,
    entryId: number
): string {
    if (historyItemId?.trim()) {
        return historyItemId.trim();
    }
    return `history-item-${entryId}`;
}

function getStack(map: Map<string, string[]>, scopeKey: string): string[] {
    let stack = map.get(scopeKey);
    if (!stack) {
        stack = [];
        map.set(scopeKey, stack);
    }
    return stack;
}

function removeFromStack(stack: string[], itemId: string): void {
    const index = stack.lastIndexOf(itemId);
    if (index >= 0) {
        stack.splice(index, 1);
    }
}

function deriveUndoScope(
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

function deriveHistoryItemUndoScope(
    entries: ChangeLogEntry[],
    glyphNames: Set<string>,
    layerIds: Set<string>
): UndoScope {
    if (entries.some((entry) => entry.undoScope === 'font')) {
        return 'font';
    }
    if (glyphNames.size === 0) {
        return 'font';
    }
    if (glyphNames.size > 1) {
        return 'font';
    }
    if (entries.some((entry) => entry.undoScope === 'glyph')) {
        return 'glyph';
    }
    if (layerIds.size !== 1) {
        return 'glyph';
    }
    return 'layer';
}

/**
 * True for font-root edits (masters, axes, names, …). Layer paths under
 * `glyphs.*` are not structural even when the history item is font-scoped
 * for undo (e.g. sidebearing cascades).
 */
function isFontStructuralChangePath(path: string): boolean {
    return (
        typeof path === 'string' &&
        path.length > 0 &&
        !path.startsWith('glyphs.')
    );
}

function historyItemHasFontStructuralPath(entries: ChangeLogEntry[]): boolean {
    return entries.some((entry) => isFontStructuralChangePath(entry.path));
}

function stripMutableHistoryItem(
    item: MutableHistoryStackItem
): HistoryStackItem {
    // Materialize the user-visible array views once here, after every
    // entry for this item has been folded into the underlying Set/Map.
    // Materializing inside the per-entry loop in `computeHistoryState`
    // is O(N²) per item: each new path / target key / replay target
    // would re-spread the entire collection. For anchor cascades that
    // attach 30-50 replay targets per entry to history items spanning
    // 40+ entries, this dominated commit time and produced the long
    // freeze observed when switching outline→anchor→outline. See
    // COMPILATION_EDIT_POLICY.md.
    item.touchedPaths = [...item.touchedPathSet];
    item.historyTargetKeys = [...item.historyTargetKeySet];
    item.workerReplayTargets = [...item.workerReplayTargetMap.values()];

    const {
        glyphNameSet: _glyphNameSet,
        layerIdSet: _layerIdSet,
        touchedPathSet: _touchedPathSet,
        touchedLayerKeySet: _touchedLayerKeySet,
        scopeKeys: _scopeKeys,
        historyTargetKeySet: _historyTargetKeySet,
        workerReplayTargetMap: _workerReplayTargetMap,
        ...historyItem
    } = item;
    return historyItem;
}

type MutableHistoryStackItem = HistoryStackItem & {
    glyphNameSet: Set<string>;
    layerIdSet: Set<string>;
    touchedPathSet: Set<string>;
    touchedLayerKeySet: Set<string>;
    scopeKeys: Set<string>;
    historyTargetKeySet: Set<string>;
    workerReplayTargetMap: Map<string, WorkerReplayTarget>;
};

type HistoryState = {
    orderedItemIds: string[];
    itemsById: Map<string, MutableHistoryStackItem>;
    activeByScope: Map<string, string[]>;
    undoneByScope: Map<string, string[]>;
};

function makeEmptyHistoryState(): HistoryState {
    return {
        orderedItemIds: [],
        itemsById: new Map<string, MutableHistoryStackItem>(),
        activeByScope: new Map<string, string[]>(),
        undoneByScope: new Map<string, string[]>()
    };
}

function processHistoryEntry(entry: ChangeLogEntry, state: HistoryState): void {
    const { orderedItemIds, itemsById, activeByScope, undoneByScope } = state;

    const ensureItem = (entry: ChangeLogEntry): MutableHistoryStackItem => {
        let item = itemsById.get(entry.historyItemId);
        if (!item) {
            item = {
                id: entry.historyItemId,
                entries: [],
                timestamp: entry.timestamp,
                transactionDurationMs: entry.transactionDurationMs ?? null,
                windowRoleLabel: entry.windowRoleLabel,
                transactionLabel: entry.transactionLabel,
                historySummary: entry.historySummary ?? null,
                undoScope: entry.undoScope,
                undoSurfaceAffinity: entry.undoSurfaceAffinity ?? null,
                touchedPaths: [],
                glyphNameSet: new Set<string>(),
                layerIdSet: new Set<string>(),
                touchedPathSet: new Set<string>(),
                touchedLayerKeySet: new Set<string>(),
                scopeKeys: new Set<string>(),
                historyTargetKeySet: new Set<string>(),
                workerReplayTargetMap: new Map<string, WorkerReplayTarget>(),
                isActive: true,
                lastAction: 'change',
                historyTargetKeys: [],
                workerReplayTargets: [],
                originatingGlyphName: null,
                originatingLayerId: null
            };
            itemsById.set(entry.historyItemId, item);
            orderedItemIds.push(entry.historyItemId);
        }
        return item;
    };

    const entryGlyphName = deriveGlyphNameFromPath(entry.path);
    const entryLayerId = deriveLayerIdFromPath(entry.path);
    const glyphScopeKey = getGlyphScopeKey(entryGlyphName);

    if (entry.historyAction === 'change') {
        const item = ensureItem(entry);
        item.entries.push(entry);
        item.timestamp = entry.timestamp;
        item.transactionDurationMs =
            entry.transactionDurationMs ?? item.transactionDurationMs;
        item.windowRoleLabel = entry.windowRoleLabel;
        item.transactionLabel = entry.transactionLabel;
        item.historySummary = entry.historySummary ?? item.historySummary;
        item.isActive = true;
        item.lastAction = 'change';
        if (
            !item.undoSurfaceAffinity &&
            (entry.undoSurfaceAffinity === 'canvas' ||
                entry.undoSurfaceAffinity === 'overview')
        ) {
            item.undoSurfaceAffinity = entry.undoSurfaceAffinity;
        }
        if (entryGlyphName && !item.glyphNameSet.has(entryGlyphName)) {
            item.glyphNameSet.add(entryGlyphName);
        }
        if (entryLayerId && !item.layerIdSet.has(entryLayerId)) {
            item.layerIdSet.add(entryLayerId);
        }
        if (
            !item.originatingGlyphName &&
            !item.originatingLayerId &&
            entry.originatingGlyphName &&
            entry.originatingLayerId
        ) {
            item.originatingGlyphName = entry.originatingGlyphName;
            item.originatingLayerId = entry.originatingLayerId;
        }
        if (
            !item.originatingGlyphName &&
            !item.originatingLayerId &&
            entryGlyphName &&
            entryLayerId
        ) {
            // First layer path in the transaction is the edit origin (cascades
            // append dependents after the source write).
            item.originatingGlyphName = entryGlyphName;
            item.originatingLayerId = entryLayerId;
        }
        if (!item.touchedPathSet.has(entry.path)) {
            item.touchedPathSet.add(entry.path);
        }
        const touchedLayerKey = getLayerTouchKey(entryGlyphName, entryLayerId);
        if (touchedLayerKey && !item.touchedLayerKeySet.has(touchedLayerKey)) {
            item.touchedLayerKeySet.add(touchedLayerKey);
        }
        if (
            entry.historyTargetKey &&
            !item.historyTargetKeySet.has(entry.historyTargetKey)
        ) {
            item.historyTargetKeySet.add(entry.historyTargetKey);
        }
        for (const target of normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        )) {
            const targetKey = getLayerTouchKey(
                target.glyphName,
                target.layerId
            );
            if (targetKey && !item.workerReplayTargetMap.has(targetKey)) {
                item.workerReplayTargetMap.set(targetKey, target);
            }
        }
        item.undoScope = deriveHistoryItemUndoScope(
            item.entries,
            item.glyphNameSet,
            item.layerIdSet
        );
        // Master add/remove (and similar) mix a font-root write with many
        // glyph layer paths. Keep them on the Font undo surface — do not
        // attribute the transaction to the first touched layer, or History
        // labels them "Layer" and Font-context undo cannot reach them.
        if (historyItemHasFontStructuralPath(item.entries)) {
            item.originatingGlyphName = null;
            item.originatingLayerId = null;
        }

        if (!item.scopeKeys.has(glyphScopeKey)) {
            item.scopeKeys.add(glyphScopeKey);
            getStack(activeByScope, glyphScopeKey).push(item.id);
        }

        const layerScopeKey = getLayerScopeKey(entryGlyphName, entryLayerId);
        if (
            layerScopeKey &&
            !item.scopeKeys.has(layerScopeKey) &&
            !historyItemHasFontStructuralPath(item.entries)
        ) {
            item.scopeKeys.add(layerScopeKey);
            getStack(activeByScope, layerScopeKey).push(item.id);
        }

        getStack(undoneByScope, glyphScopeKey).length = 0;
        if (layerScopeKey && !historyItemHasFontStructuralPath(item.entries)) {
            getStack(undoneByScope, layerScopeKey).length = 0;
        }
        return;
    }

    const sourceMap =
        entry.historyAction === 'undo' ? activeByScope : undoneByScope;
    const targetMap =
        entry.historyAction === 'undo' ? undoneByScope : activeByScope;
    const sourceStack = getStack(sourceMap, glyphScopeKey);
    const targetStack = getStack(targetMap, glyphScopeKey);
    const targetItemId =
        entry.targetHistoryItemId ?? sourceStack[sourceStack.length - 1];

    if (!targetItemId) {
        return;
    }

    const item = itemsById.get(targetItemId);
    if (item) {
        const itemScopeKeys =
            item.scopeKeys.size > 0 ? [...item.scopeKeys] : [glyphScopeKey];
        for (const scopeKey of itemScopeKeys) {
            removeFromStack(getStack(sourceMap, scopeKey), targetItemId);
            getStack(targetMap, scopeKey).push(targetItemId);
        }
        item.isActive = entry.historyAction === 'redo';
        item.lastAction = entry.historyAction;
        item.timestamp = entry.timestamp;
    } else {
        removeFromStack(sourceStack, targetItemId);
        targetStack.push(targetItemId);
    }
}

/**
 * Cache of computed history state, keyed by the change-log array reference.
 * Because `_changeLog` is append-only between resets (see change-bridge.ts),
 * we can incrementally fold only the new tail entries into the cached state
 * on subsequent calls. Resetting `_changeLog` reassigns the array and the
 * WeakMap entry naturally falls out, forcing a fresh computation.
 *
 * Without this cache, every history-view re-render walks the entire change
 * log from scratch (O(N) per render). On long sessions with anchor cascades,
 * this dominated commit time and produced the long freeze observed when
 * switching outline\u2192anchor\u2192outline. See COMPILATION_EDIT_POLICY.md.
 */
const historyStateCache = new WeakMap<
    ChangeLogEntry[],
    { processedLength: number; state: HistoryState }
>();

export function invalidateHistoryStateCache(entries: ChangeLogEntry[]): void {
    historyStateCache.delete(entries);
}

function computeHistoryState(entries: ChangeLogEntry[]): HistoryState {
    let cached = historyStateCache.get(entries);
    if (!cached || cached.processedLength > entries.length) {
        cached = { processedLength: 0, state: makeEmptyHistoryState() };
        historyStateCache.set(entries, cached);
    }
    for (let i = cached.processedLength; i < entries.length; i++) {
        processHistoryEntry(entries[i], cached.state);
    }
    cached.processedLength = entries.length;
    return cached.state;
}

export function resolveHistoryTargetItemId(
    entries: ChangeLogEntry[],
    glyphName: string | null | undefined,
    historyAction: 'undo' | 'redo',
    layerId?: string | null
): string | null {
    return (
        resolveHistoryTargetItem(entries, {
            glyphName,
            layerId,
            historyAction
        })?.id ?? null
    );
}

export function resolveHistoryTargetItem(
    entries: ChangeLogEntry[],
    options: {
        glyphName?: string | null;
        layerId?: string | null;
        historyAction: 'undo' | 'redo';
        historyTargetKey?: string | null;
        surface?: HistoryUndoSurface | null;
    }
): HistoryStackItem | null {
    const glyphName = options.glyphName ?? null;
    const layerId = options.layerId ?? null;
    const historyTargetKey = options.historyTargetKey ?? null;

    const visibleItems = buildHistoryStackItems(entries, {
        glyphName,
        layerId,
        includeUndone: true,
        historyTargetKey,
        surface: options.surface ?? null
    }).filter((item) =>
        options.historyAction === 'undo' ? item.isActive : !item.isActive
    );

    return visibleItems.length ? visibleItems[visibleItems.length - 1] : null;
}

/**
 * History item ids that belong to the current surface’s undo/redo stack.
 * Includes inactive (undone) items so redo targets stay bright in History.
 * `nextUndoHistoryItemId` is still the newest *active* Cmd+Z target.
 */
export function getUndoReachabilityForContext(
    entries: ChangeLogEntry[],
    options: {
        glyphName?: string | null;
        layerId?: string | null;
        historyTargetKey?: string | null;
        surface?: HistoryUndoSurface | null;
    } = {}
): {
    reachableHistoryItemIds: Set<string>;
    nextUndoHistoryItemId: string | null;
} {
    const filterOptions = {
        glyphName: options.glyphName ?? null,
        layerId: options.layerId ?? null,
        historyTargetKey: options.historyTargetKey ?? null,
        surface: options.surface ?? null
    };

    const surfaceItems = buildHistoryStackItems(entries, {
        ...filterOptions,
        includeUndone: true
    });
    const activeItems = surfaceItems.filter((item) => item.isActive);

    return {
        reachableHistoryItemIds: new Set(surfaceItems.map((item) => item.id)),
        nextUndoHistoryItemId: activeItems.length
            ? activeItems[activeItems.length - 1].id
            : null
    };
}

function inferHistoryUndoSurface(options: {
    glyphName?: string | null;
    layerId?: string | null;
    historyTargetKey?: string | null;
    surface?: HistoryUndoSurface | null;
}): HistoryUndoSurface | null {
    if (options.surface) {
        return options.surface;
    }
    if (options.historyTargetKey) {
        return 'feature';
    }
    if (options.glyphName && options.layerId) {
        return 'canvas';
    }
    if (options.glyphName) {
        return 'overview';
    }
    // No surface / glyph / layer / feature key → unfiltered list (tests, dumps).
    return null;
}

/**
 * Canvas Cmd+Z includes every layer of the originating glyph that this item
 * actually wrote. Dependent glyphs in the same packet stay off that stack.
 * Editing View font-root edits (kerning, master guides, …) join via
 * `undoSurfaceAffinity === 'canvas'` only when the item has no originating
 * layer — affinity must not make a layer-origin packet global.
 */
function historyItemTouchesCanvasLayer(
    item: MutableHistoryStackItem,
    glyphName: string,
    layerId: string
): boolean {
    if (item.originatingGlyphName !== glyphName) {
        return false;
    }
    if (item.originatingLayerId === layerId) {
        return true;
    }
    const touchKey = getLayerTouchKey(glyphName, layerId);
    return !!touchKey && item.touchedLayerKeySet.has(touchKey);
}

function historyItemMatchesCanvasSurface(
    item: MutableHistoryStackItem,
    glyphName: string | null,
    layerId: string | null
): boolean {
    if (item.originatingGlyphName) {
        if (glyphName && layerId) {
            return historyItemTouchesCanvasLayer(item, glyphName, layerId);
        }
        // Text mode (no layer): still reach layer-origin edits for the caret glyph.
        return (
            !!glyphName &&
            item.originatingGlyphName === glyphName &&
            !!item.originatingLayerId
        );
    }
    if (item.undoSurfaceAffinity === 'canvas') {
        return true;
    }
    if (glyphName && layerId) {
        return historyItemTouchesCanvasLayer(item, glyphName, layerId);
    }
    return false;
}

function historyItemMatchesSurface(
    item: MutableHistoryStackItem,
    surface: HistoryUndoSurface,
    options: {
        glyphName?: string | null;
        layerId?: string | null;
        historyTargetKey?: string | null;
    }
): boolean {
    const glyphName = options.glyphName ?? null;
    const layerId = options.layerId ?? null;
    const historyTargetKey = options.historyTargetKey ?? null;

    switch (surface) {
        case 'canvas': {
            return historyItemMatchesCanvasSurface(item, glyphName, layerId);
        }
        case 'overview': {
            if (item.undoSurfaceAffinity === 'overview') {
                return true;
            }
            if (item.undoSurfaceAffinity === 'canvas') {
                return false;
            }
            if (item.originatingLayerId) {
                return false;
            }
            if (item.historyTargetKeySet.size > 0) {
                return false;
            }
            return item.glyphNameSet.size > 0 || item.undoScope === 'glyph';
        }
        case 'font': {
            if (
                item.undoSurfaceAffinity === 'canvas' ||
                item.undoSurfaceAffinity === 'overview'
            ) {
                return false;
            }
            if (item.historyTargetKeySet.size > 0) {
                return false;
            }
            if (item.originatingLayerId) {
                return false;
            }
            // Master add/remove (and similar) rewrite glyph layers but are
            // font-structural transactions — keep them on the Font surface.
            if (historyItemHasFontStructuralPath(item.entries)) {
                return item.undoScope === 'font';
            }
            if (item.glyphNameSet.size > 0 || item.undoScope === 'glyph') {
                return false;
            }
            return item.undoScope === 'font';
        }
        case 'feature': {
            if (!historyTargetKey) {
                return false;
            }
            return item.historyTargetKeySet.has(historyTargetKey);
        }
        case 'automation':
            return isAutomationSourcedHistoryItem(item);
        default:
            return false;
    }
}

export function buildHistoryStackItems(
    entries: ChangeLogEntry[],
    options?: {
        glyphName?: string | null;
        layerId?: string | null;
        includeUndone?: boolean;
        historyTargetKey?: string | null;
        surface?: HistoryUndoSurface | null;
    }
): HistoryStackItem[] {
    const includeUndone = options?.includeUndone ?? false;
    const surface = inferHistoryUndoSurface({
        glyphName: options?.glyphName,
        layerId: options?.layerId,
        historyTargetKey: options?.historyTargetKey,
        surface: options?.surface
    });
    const state = computeHistoryState(entries);

    return state.orderedItemIds
        .map((itemId) => state.itemsById.get(itemId))
        .filter((item): item is MutableHistoryStackItem => !!item)
        .filter((item) => {
            if (
                surface &&
                !historyItemMatchesSurface(item, surface, {
                    glyphName: options?.glyphName,
                    layerId: options?.layerId,
                    historyTargetKey: options?.historyTargetKey
                })
            ) {
                return false;
            }
            if (!includeUndone && !item.isActive) {
                return false;
            }
            return true;
        })
        .map((item) => stripMutableHistoryItem(item));
}

export function normalizeWindowRoleLabel(
    windowRoleLabel: string | null | undefined,
    windowId: string
): string {
    if (windowRoleLabel?.trim()) {
        return windowRoleLabel.trim();
    }

    if (/^(main|primary)$/i.test(windowId)) {
        return 'Main';
    }

    const linkedMatch = windowId.match(
        /^(?:linked|secondary|remote)[- ]?(\d+)$/i
    );
    if (linkedMatch) {
        return `Linked ${linkedMatch[1]}`;
    }

    return 'Window';
}

/** Reset the ID counter (for tests). */
export function resetLogCounter(): void {
    _nextId = 1;
}

/**
 * Derive objectType and objectId from a path array.
 *
 * Path examples:
 *   ["glyphs", "A", "layers", "uuid", "shapes", 0, "nodes", 2, "x"]
 *   ["axes", 0, "tag"]
 *   ["upm"]
 */
export function deriveObjectInfo(path: (string | number)[]): {
    objectType: ChangeObjectType;
    objectId: string;
} {
    if (path.length === 0) return { objectType: 'font', objectId: '' };

    const first = path[0];

    if (first === 'glyphs' && path.length >= 2) {
        const glyphName = String(path[1]);
        if (path.length === 2)
            return { objectType: 'glyph', objectId: glyphName };
        if (path.length >= 4 && path[2] === 'layers') {
            const layerId = String(path[3]);
            if (path.length === 4)
                return { objectType: 'layer', objectId: layerId };
            if (path.length >= 6 && path[4] === 'shapes') {
                const shapeIdx = String(path[5]);
                if (path.length === 6)
                    return { objectType: 'shape', objectId: shapeIdx };
                if (path.length >= 8 && path[6] === 'nodes')
                    return {
                        objectType: 'node',
                        objectId: `${glyphName}/${layerId}/shape${shapeIdx}/node${path[7]}`
                    };
                // It might be a component or path sub-property
                return { objectType: 'shape', objectId: shapeIdx };
            }
            if (path.length >= 6 && path[4] === 'anchors')
                return {
                    objectType: 'anchor',
                    objectId: `${glyphName}/${layerId}/anchor${path[5]}`
                };
            if (path.length >= 6 && path[4] === 'guides')
                return {
                    objectType: 'guide',
                    objectId: `${glyphName}/${layerId}/guide${path[5]}`
                };
            return { objectType: 'layer', objectId: layerId };
        }
        return { objectType: 'glyph', objectId: glyphName };
    }

    if (first === 'axes' && path.length >= 2)
        return { objectType: 'axis', objectId: String(path[1]) };
    if (first === 'masters' && path.length >= 2)
        return { objectType: 'master', objectId: String(path[1]) };
    if (first === 'instances' && path.length >= 2)
        return { objectType: 'instance', objectId: String(path[1]) };
    if (first === 'features' && path.length >= 2) {
        if (path[1] === 'prefixes' && path.length >= 3) {
            return { objectType: 'prefix', objectId: String(path[2]) };
        }
        if (path[1] === 'classes' && path.length >= 3) {
            return { objectType: 'class', objectId: String(path[2]) };
        }
        if (path[1] === 'features' && path.length >= 3) {
            return { objectType: 'feature', objectId: String(path[2]) };
        }
    }

    return { objectType: 'font', objectId: '' };
}

export function deriveGlyphName(path: (string | number)[]): string | null {
    if (path[0] === 'glyphs' && typeof path[1] === 'string') {
        return path[1];
    }
    return null;
}

export function deriveLayerId(path: (string | number)[]): string | null {
    if (
        path[0] === 'glyphs' &&
        path[2] === 'layers' &&
        typeof path[3] === 'string'
    ) {
        return path[3];
    }
    return null;
}

export function deriveGlyphNameFromPath(path: string): string | null {
    if (!path) {
        return null;
    }
    return deriveGlyphName(getPathSegments(path));
}

export function deriveLayerIdFromPath(path: string): string | null {
    if (!path) {
        return null;
    }
    return deriveLayerId(getPathSegments(path));
}

export function deriveObjectInfoFromPath(path: string): {
    objectType: ChangeObjectType;
    objectId: string;
} {
    return deriveObjectInfo(getPathSegments(path));
}

export function deriveGlyphNamesFromPaths(paths: string[]): string[] {
    const glyphNames = new Set<string>();
    for (const path of paths) {
        const glyphName = deriveGlyphNameFromPath(path);
        if (glyphName) {
            glyphNames.add(glyphName);
        }
    }
    return [...glyphNames];
}

export function deriveLayerIdsFromPaths(paths: string[]): string[] {
    const layerIds = new Set<string>();
    for (const path of paths) {
        const layerId = deriveLayerIdFromPath(path);
        if (layerId) {
            layerIds.add(layerId);
        }
    }
    return [...layerIds];
}

export function deriveLayerTouchKeysFromPaths(paths: string[]): string[] {
    const layerKeys = new Set<string>();
    for (const path of paths) {
        const glyphName = deriveGlyphNameFromPath(path);
        const layerId = deriveLayerIdFromPath(path);
        const layerKey = getLayerTouchKey(glyphName, layerId);
        if (layerKey) {
            layerKeys.add(layerKey);
        }
    }
    return [...layerKeys];
}

export function normalizeChangeLogEntry(
    entry: ChangeLogEntryLike
): ChangeLogEntry {
    const glyphName = deriveGlyphNameFromPath(entry.path);
    const layerId = deriveLayerIdFromPath(entry.path);
    return attachDerivedEntryAccessors({
        id: entry.id,
        timestamp: entry.timestamp,
        transactionDurationMs: entry.transactionDurationMs ?? null,
        windowId: entry.windowId,
        transactionLabel: entry.transactionLabel,
        transactionId: entry.transactionId,
        op: entry.op,
        path: entry.path,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        replayOldValue: entry.replayOldValue,
        replayNewValue: entry.replayNewValue,
        editSource: entry.editSource ?? null,
        compileChangeSource: entry.compileChangeSource ?? null,
        compileEditType: entry.compileEditType ?? null,
        historySummary: entry.historySummary ?? null,
        promptGroupId: entry.promptGroupId ?? null,
        historyItemId: normalizeHistoryItemId(entry.historyItemId, entry.id),
        historyAction: normalizeHistoryAction(entry.historyAction),
        undoScope: entry.undoScope ?? deriveUndoScope(glyphName, layerId),
        undoSurfaceAffinity:
            entry.undoSurfaceAffinity === 'canvas' ||
            entry.undoSurfaceAffinity === 'overview'
                ? entry.undoSurfaceAffinity
                : null,
        targetHistoryItemId: entry.targetHistoryItemId ?? null,
        historyTargetType: entry.historyTargetType ?? null,
        historyTargetKey: entry.historyTargetKey ?? null,
        historyTargetLabel: entry.historyTargetLabel ?? null,
        originatingGlyphName: entry.originatingGlyphName ?? null,
        originatingLayerId: entry.originatingLayerId ?? null,
        visualAnchorSide: entry.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        ),
        glyphRenames: normalizeGlyphRenames(entry.glyphRenames),
        semanticChangeLogEntries: entry.semanticChangeLogEntries?.map(
            (semanticEntry) => normalizeChangeLogEntry(semanticEntry)
        ),
        windowRoleLabel: normalizeWindowRoleLabel(
            entry.windowRoleLabel,
            entry.windowId
        )
    });
}
