import {
    createLogEntry,
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    deriveObjectInfoFromPath,
    getPathSegments,
    joinPathWithGlyphSeparator,
    normalizeGlyphRenames,
    normalizeWorkerReplayTargets,
    resolveCollaborationOriginatingLayer,
    type ChangeLogEntry,
    type ChangeOp,
    type HistoryAction,
    type HistoryTargetType,
    type UndoScope,
    type UndoSurfaceAffinity,
    type GlyphRename,
    type WorkerReplayTarget
} from './change-log';

type Unsafe = ReturnType<typeof JSON.parse>;

type FontJsonSnapshot = Record<string, Unsafe> | null | undefined;

export type JsonPatchOperation = {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
    path: string;
    from?: string;
    value?: unknown;
};

export type NamedChangeOperation = {
    op: 'add' | 'remove' | 'replace';
    path: string;
    value?: unknown;
};

export type NamedChangePair = {
    forward: NamedChangeOperation;
    inverse: NamedChangeOperation;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

export type SyntheticChangeOperation = {
    op: 'set' | 'add' | 'remove';
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

export type CollaborationChangeDescriptor = {
    path: string;
    op: ChangeOp;
    glyphRenames?: GlyphRename[];
    workerReplayTargets?: WorkerReplayTarget[];
    replayOldValue?: unknown;
    replayNewValue?: unknown;
};

export type CollaborationMessageMetadata = {
    editType: 'font' | 'outline';
    editSource?: string | null;
    compileChangeSource?: string | null;
    compileEditType?: string | null;
    changedGlyphNames: string[];
    changedLayerIds: string[];
    workerReplayTargets: WorkerReplayTarget[];
    transactionDurationMs?: number | null;
    historyItemId: string;
    promptGroupId?: string | null;
    historyAction: HistoryAction;
    targetHistoryItemId?: string | null;
    sourceWindowRoleLabel?: string | null;
    historyTargetType?: HistoryTargetType | null;
    historyTargetKey?: string | null;
    historyTargetLabel?: string | null;
    undoScope: UndoScope;
    undoSurfaceAffinity?: UndoSurfaceAffinity | null;
    originatingGlyphName?: string | null;
    originatingLayerId?: string | null;
};

export interface CollaborationMessageEnvelope {
    schemaVersion: 1;
    transactionId: string;
    localSequence: number;
    roomSequence: number | null;
    baseRevision: string | null;
    changes: CollaborationChangeDescriptor[];
    metadata: CollaborationMessageMetadata;
    source: string;
    label: string | null;
    summary: string;
    windowId: string | null;
    timestamp: number;
}

export type DerivedForwardChange = {
    path: string;
    op: ChangeOp;
    oldValue: unknown;
    newValue: unknown;
    objectType: string;
};

type CreateCollaborationMessageInput = Omit<
    CollaborationMessageEnvelope,
    'schemaVersion'
>;

export function createCollaborationMessageEnvelope(
    input: CreateCollaborationMessageInput
): CollaborationMessageEnvelope {
    return {
        schemaVersion: 1,
        transactionId: input.transactionId,
        localSequence: input.localSequence,
        roomSequence: input.roomSequence,
        baseRevision: input.baseRevision,
        changes: input.changes.map((change) => ({
            ...change,
            workerReplayTargets: change.workerReplayTargets
                ? [...change.workerReplayTargets]
                : undefined
        })),
        metadata: {
            ...input.metadata,
            changedGlyphNames: [...input.metadata.changedGlyphNames],
            changedLayerIds: [...input.metadata.changedLayerIds],
            workerReplayTargets: [...input.metadata.workerReplayTargets]
        },
        source: input.source,
        label: input.label,
        summary: input.summary,
        windowId: input.windowId,
        timestamp: input.timestamp
    };
}

export function createLinkedWindowCatchUpEnvelope(
    documentId: string,
    windowId: string | null
): CollaborationMessageEnvelope {
    return createCollaborationMessageEnvelope({
        transactionId: `catch-up:${documentId}`,
        localSequence: 0,
        roomSequence: null,
        baseRevision: null,
        changes: [],
        metadata: {
            editType: 'font',
            changedGlyphNames: [],
            changedLayerIds: [],
            workerReplayTargets: [],
            historyItemId: `catch-up:${documentId}`,
            historyAction: 'change',
            undoScope: 'font'
        },
        source: 'window-sync.catch-up',
        label: null,
        summary: 'Linked-window document catch-up',
        windowId,
        timestamp: Date.now()
    });
}

export function isCollaborationMessageEnvelope(
    value: unknown
): value is CollaborationMessageEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<CollaborationMessageEnvelope>;
    return (
        candidate.schemaVersion === 1 &&
        typeof candidate.transactionId === 'string' &&
        typeof candidate.localSequence === 'number' &&
        Array.isArray(candidate.changes) &&
        !!candidate.metadata &&
        typeof candidate.summary === 'string' &&
        typeof candidate.timestamp === 'number'
    );
}

function pathToArray(path: string): (string | number)[] {
    return getPathSegments(path).map((segment) => {
        const numeric = Number.parseInt(segment, 10);
        return String(numeric) === segment ? numeric : segment;
    });
}

function getNamedPatchOpForSet(oldValue: unknown): 'add' | 'replace' {
    return oldValue === undefined ? 'add' : 'replace';
}

function buildSummaryFromEntries(entries: ChangeLogEntry[]): string {
    const firstEntry = entries[0];
    if (!firstEntry) {
        return 'Edit';
    }

    if (firstEntry.transactionLabel?.trim()) {
        return firstEntry.transactionLabel;
    }

    if (firstEntry.historyAction === 'undo') {
        return 'Undo';
    }

    if (firstEntry.historyAction === 'redo') {
        return 'Redo';
    }

    if (entries.length === 1) {
        const objectInfo = deriveObjectInfoFromPath(firstEntry.path);
        const objectLabel = objectInfo.objectId
            ? `${objectInfo.objectType} ${objectInfo.objectId}`
            : objectInfo.objectType;
        return `${firstEntry.op} ${objectLabel}`;
    }

    return `${entries.length} changes`;
}

/**
 * Collaboration envelopes are room metadata (64 KiB cap), not a JSON
 * snapshot bus. Glyph/layer apply payloads already travel in the Yjs
 * update; putting them on the envelope makes the room reject the whole
 * live packet (`metadata-limit`), so cloud peers never apply the mutation.
 * Keep only JSON primitives (property edits, labels, revision tokens).
 */
export function collaborationWireReplayValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }
    const valueType = typeof value;
    if (
        valueType === 'string' ||
        valueType === 'number' ||
        valueType === 'boolean'
    ) {
        return value;
    }
    return undefined;
}

function haveMatchingReplayTargets(
    left: WorkerReplayTarget[] | undefined,
    right: WorkerReplayTarget[] | undefined
): boolean {
    const normalizedLeft = normalizeWorkerReplayTargets(left);
    const normalizedRight = normalizeWorkerReplayTargets(right);

    if (normalizedLeft.length !== normalizedRight.length) {
        return false;
    }

    return normalizedLeft.every(
        (target, index) =>
            target.glyphName === normalizedRight[index]?.glyphName &&
            target.layerId === normalizedRight[index]?.layerId
    );
}

export function createCollaborationMessageEnvelopeFromChangeLogEntries(
    entries: ChangeLogEntry[],
    options: {
        localSequence: number;
        source: string;
        baseRevision?: string | null;
        windowId?: string | null;
    }
): CollaborationMessageEnvelope | null {
    if (!entries.length) {
        return null;
    }

    const changedGlyphNames = [
        ...new Set(
            entries
                .map((entry) => deriveGlyphNameFromPath(entry.path))
                .filter((glyphName): glyphName is string => !!glyphName)
        )
    ];
    const changedLayerIds = [
        ...new Set(
            entries
                .map((entry) => deriveLayerIdFromPath(entry.path))
                .filter((layerId): layerId is string => !!layerId)
        )
    ];
    const workerReplayTargets = normalizeWorkerReplayTargets(
        entries.flatMap((entry) => entry.workerReplayTargets)
    );

    return createCollaborationMessageEnvelope({
        transactionId:
            entries[0].transactionId !== null &&
            entries[0].transactionId !== undefined
                ? String(entries[0].transactionId)
                : `history-${entries[0].historyItemId}`,
        localSequence: options.localSequence,
        roomSequence: null,
        baseRevision: options.baseRevision ?? null,
        changes: entries.map((entry) => {
            const entryReplayTargets = normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            );

            return {
                path: entry.path,
                op: entry.op,
                glyphRenames: entry.glyphRenames.length
                    ? entry.glyphRenames
                    : undefined,
                replayOldValue: collaborationWireReplayValue(
                    entry.replayOldValue
                ),
                replayNewValue: collaborationWireReplayValue(
                    entry.replayNewValue
                ),
                workerReplayTargets: haveMatchingReplayTargets(
                    entryReplayTargets,
                    workerReplayTargets
                )
                    ? undefined
                    : entryReplayTargets
            };
        }),
        metadata: {
            editType: workerReplayTargets.length ? 'outline' : 'font',
            editSource: entries[0].editSource ?? null,
            compileChangeSource: entries[0].compileChangeSource ?? null,
            compileEditType: entries[0].compileEditType ?? null,
            changedGlyphNames,
            changedLayerIds,
            workerReplayTargets,
            transactionDurationMs: entries[0].transactionDurationMs,
            historyItemId: entries[0].historyItemId,
            promptGroupId: entries[0].promptGroupId ?? null,
            historyAction: entries[0].historyAction,
            targetHistoryItemId: entries[0].targetHistoryItemId,
            sourceWindowRoleLabel: entries[0].windowRoleLabel,
            historyTargetType: entries[0].historyTargetType,
            historyTargetKey: entries[0].historyTargetKey,
            historyTargetLabel: entries[0].historyTargetLabel,
            undoScope: entries[0].undoScope,
            undoSurfaceAffinity: entries[0].undoSurfaceAffinity ?? null,
            ...(() => {
                const origin = resolveCollaborationOriginatingLayer(
                    entries[0].undoScope,
                    entries
                );
                return {
                    originatingGlyphName: origin.glyphName,
                    originatingLayerId: origin.layerId
                };
            })()
        },
        source: options.source,
        label: entries[0].transactionLabel,
        summary: entries[0].historySummary ?? buildSummaryFromEntries(entries),
        windowId: options.windowId ?? entries[0].windowId ?? null,
        timestamp: entries[0].timestamp
    });
}

export function createCollaborationMessageEnvelopesFromChangeLogEntries(
    entries: ChangeLogEntry[],
    options: {
        startingLocalSequence: number;
        source: string;
        baseRevision?: string | null;
        windowId?: string | null;
    }
): CollaborationMessageEnvelope[] {
    if (!entries.length) {
        return [];
    }

    const groups: ChangeLogEntry[][] = [];
    for (const entry of entries) {
        const lastGroup = groups[groups.length - 1];
        if (!lastGroup) {
            groups.push([entry]);
            continue;
        }

        const lastEntry = lastGroup[lastGroup.length - 1];
        const sameHistoryItem =
            lastEntry.historyItemId === entry.historyItemId &&
            lastEntry.historyAction === entry.historyAction &&
            lastEntry.targetHistoryItemId === entry.targetHistoryItemId;
        if (sameHistoryItem) {
            lastGroup.push(entry);
        } else {
            groups.push([entry]);
        }
    }

    return groups
        .map((group, index) =>
            createCollaborationMessageEnvelopeFromChangeLogEntries(group, {
                localSequence: options.startingLocalSequence + index,
                source: options.source,
                baseRevision: options.baseRevision,
                windowId: options.windowId
            })
        )
        .filter(
            (envelope): envelope is CollaborationMessageEnvelope => !!envelope
        );
}

export function createChangeLogEntriesFromCollaborationMessageEnvelope(
    envelope: CollaborationMessageEnvelope,
    options: {
        windowRoleLabel: string;
    }
): ChangeLogEntry[] {
    const historyItemPrefix = envelope.windowId ?? 'remote';
    const namespacedHistoryItemId = `${historyItemPrefix}:${envelope.metadata.historyItemId}`;
    const namespacedTargetHistoryItemId = envelope.metadata.targetHistoryItemId
        ? `${historyItemPrefix}:${envelope.metadata.targetHistoryItemId}`
        : null;

    return envelope.changes.map((change) =>
        createLogEntry({
            timestamp: envelope.timestamp,
            windowId: envelope.windowId ?? 'remote',
            windowRoleLabel:
                envelope.metadata.sourceWindowRoleLabel ??
                options.windowRoleLabel,
            transactionDurationMs:
                envelope.metadata.transactionDurationMs ?? null,
            historyItemId: namespacedHistoryItemId,
            promptGroupId: envelope.metadata.promptGroupId ?? null,
            historyAction: envelope.metadata.historyAction,
            targetHistoryItemId: namespacedTargetHistoryItemId,
            transactionLabel: envelope.label,
            transactionId: Number.isFinite(Number(envelope.transactionId))
                ? Number(envelope.transactionId)
                : null,
            op: change.op,
            undoScope: envelope.metadata.undoScope,
            path: change.path,
            oldValue: undefined,
            newValue: undefined,
            editSource: envelope.metadata.editSource ?? null,
            compileChangeSource: envelope.metadata.compileChangeSource ?? null,
            compileEditType: envelope.metadata.compileEditType ?? null,
            replayOldValue: change.replayOldValue,
            replayNewValue: change.replayNewValue,
            glyphRenames: normalizeGlyphRenames(change.glyphRenames),
            workerReplayTargets: normalizeWorkerReplayTargets(
                change.workerReplayTargets?.length
                    ? change.workerReplayTargets
                    : envelope.metadata.workerReplayTargets
            ),
            historyTargetType: envelope.metadata.historyTargetType ?? null,
            historyTargetKey: envelope.metadata.historyTargetKey ?? null,
            historyTargetLabel: envelope.metadata.historyTargetLabel ?? null,
            undoSurfaceAffinity: envelope.metadata.undoSurfaceAffinity ?? null,
            originatingGlyphName:
                envelope.metadata.originatingGlyphName ?? null,
            originatingLayerId: envelope.metadata.originatingLayerId ?? null
        })
    );
}

export function createSyntheticChangeOperationsFromNamedChangePairs(
    patches: NamedChangePair[],
    fallbackWorkerReplayTargets?: WorkerReplayTarget[]
): SyntheticChangeOperation[] {
    return patches.map((patch) => ({
        op:
            patch.forward.op === 'replace'
                ? 'set'
                : patch.forward.op === 'add'
                  ? 'add'
                  : 'remove',
        path: pathToArray(patch.forward.path),
        oldValue:
            patch.inverse.op === 'remove' ? undefined : patch.inverse.value,
        newValue:
            patch.forward.op === 'remove' ? undefined : patch.forward.value,
        replayOldValue:
            patch.replayOldValue === undefined
                ? patch.inverse.op === 'remove'
                    ? undefined
                    : patch.inverse.value
                : patch.replayOldValue,
        replayNewValue:
            patch.replayNewValue === undefined
                ? patch.forward.op === 'remove'
                    ? undefined
                    : patch.forward.value
                : patch.replayNewValue,
        visualAnchorSide: patch.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            patch.workerReplayTargets?.length
                ? patch.workerReplayTargets
                : fallbackWorkerReplayTargets
        )
    }));
}

function fromJsonPointerPath(
    pointerPath: string,
    fontJson?: FontJsonSnapshot
): string {
    if (!pointerPath || pointerPath === '/') {
        return '';
    }

    const segments = pointerPath
        .split('/')
        .slice(1)
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

    if (segments[0] === 'glyphs' && segments.length >= 2) {
        const glyphIndex = Number.parseInt(String(segments[1]), 10);
        const glyphs = Array.isArray(fontJson?.glyphs)
            ? (fontJson.glyphs as Unsafe[])
            : null;
        const glyph = Number.isFinite(glyphIndex) ? glyphs?.[glyphIndex] : null;
        if (
            glyph &&
            typeof glyph === 'object' &&
            typeof glyph.name === 'string'
        ) {
            segments[1] = glyph.name;

            if (segments[2] === 'layers' && segments.length >= 4) {
                const layerIndex = Number.parseInt(String(segments[3]), 10);
                const layers = Array.isArray(glyph.layers)
                    ? (glyph.layers as Unsafe[])
                    : null;
                const layer = Number.isFinite(layerIndex)
                    ? layers?.[layerIndex]
                    : null;
                if (
                    layer &&
                    typeof layer === 'object' &&
                    typeof layer.id === 'string'
                ) {
                    segments[3] = layer.id;
                }
            }
        }
    }

    return joinPathWithGlyphSeparator(segments);
}

export function createNamedChangePairFromJsonPatchPair(
    forwardPatch: JsonPatchOperation,
    inversePatch: JsonPatchOperation | undefined,
    options: {
        forwardSnapshot?: FontJsonSnapshot;
        inverseSnapshot?: FontJsonSnapshot;
        replayOldValue?: unknown;
        replayNewValue?: unknown;
        visualAnchorSide?: 'left' | 'right' | null;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): NamedChangePair {
    return {
        forward: {
            op: forwardPatch.op as NamedChangeOperation['op'],
            path: fromJsonPointerPath(
                forwardPatch.path,
                options.forwardSnapshot
            ),
            value: forwardPatch.value
        },
        inverse: {
            op: (inversePatch?.op ?? 'remove') as NamedChangeOperation['op'],
            path: fromJsonPointerPath(
                inversePatch?.path ?? forwardPatch.path,
                options.inverseSnapshot
            ),
            value: inversePatch?.value
        },
        replayOldValue: options.replayOldValue,
        replayNewValue: options.replayNewValue,
        visualAnchorSide: options.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            options.workerReplayTargets
        )
    };
}

export function createNamedChangePairFromEntry(
    entry: ChangeLogEntry
): NamedChangePair {
    const forwardValue =
        entry.replayNewValue === undefined
            ? entry.newValue
            : entry.replayNewValue;
    const inverseValue =
        entry.replayOldValue === undefined
            ? entry.oldValue
            : entry.replayOldValue;

    if (entry.op === 'add') {
        return {
            forward: {
                op: 'add',
                path: entry.path,
                value: entry.newValue
            },
            inverse: {
                op: 'remove',
                path: entry.path
            },
            replayOldValue: entry.replayOldValue,
            replayNewValue: entry.replayNewValue,
            visualAnchorSide: entry.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            )
        };
    }

    if (entry.op === 'remove') {
        return {
            forward: {
                op: 'remove',
                path: entry.path
            },
            inverse: {
                op: 'add',
                path: entry.path,
                value: entry.oldValue
            },
            replayOldValue: entry.replayOldValue,
            replayNewValue: entry.replayNewValue,
            visualAnchorSide: entry.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            )
        };
    }

    return {
        forward: {
            op: getNamedPatchOpForSet(inverseValue),
            path: entry.path,
            value: forwardValue
        },
        inverse: {
            op: inverseValue === undefined ? 'remove' : 'replace',
            path: entry.path,
            value: inverseValue
        },
        replayOldValue: entry.replayOldValue,
        replayNewValue: entry.replayNewValue,
        visualAnchorSide: entry.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        )
    };
}

function getJsonValueAtPath(value: unknown, path: string): unknown {
    const segments = getPathSegments(path);
    if (!segments.length) {
        return value;
    }

    let current = value as Unsafe;
    for (const segment of segments) {
        if (current === undefined || current === null) {
            return undefined;
        }

        if (Array.isArray(current)) {
            const index = Number.parseInt(segment, 10);
            current = current[index] as Unsafe;
            continue;
        }

        if (typeof current !== 'object') {
            return undefined;
        }

        current = current[segment] as Unsafe;
    }

    return current;
}

export function deriveForwardChangesFromSnapshots(
    envelope: CollaborationMessageEnvelope,
    beforeValue: unknown,
    afterValue: unknown
): DerivedForwardChange[] {
    return envelope.changes.map((change) => ({
        path: change.path,
        op: change.op,
        oldValue: cloneValue(getJsonValueAtPath(beforeValue, change.path)),
        newValue: cloneValue(getJsonValueAtPath(afterValue, change.path)),
        objectType: deriveObjectInfoFromPath(change.path).objectType
    }));
}

export function collaborationMessageKey(
    envelope: CollaborationMessageEnvelope
): string {
    return [
        envelope.windowId ?? '',
        envelope.transactionId,
        String(envelope.timestamp),
        String(envelope.localSequence),
        envelope.metadata.historyAction,
        envelope.metadata.historyItemId
    ].join(':');
}

function cloneValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }

    return JSON.parse(JSON.stringify(value)) as T;
}
