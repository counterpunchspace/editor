/**
 * Shared cascading drawing recomposition closure.
 *
 * Distinguishes two dependent sets after a visual edit:
 *
 *   recomposeTargets — drawings whose *stored model* must change (automatic
 *     composition rebuild and/or metrics-key inheritance). These may be
 *     written into the authoritative Yjs packet as drawing snapshots.
 *
 *   invalidateTargets — drawings that only need worker/canvas/overview refresh
 *     because they *draw* an edited source (e.g. manual composites). These
 *     must NOT receive model writes; they are stamped only as
 *     `workerReplayTargets` metadata on the Yjs packet.
 *
 *   allTargets — source ∪ recompose ∪ invalidate. Stamp this as
 *     `workerReplayTargets` so local and remote peers refresh the same
 *     compile/cache closure without re-deriving it.
 *
 * Two scopes are supported:
 *
 *   `visible` — Used during live drag for transient visible-only refreshes.
 *               Transitive retain expansion includes hidden intermediates that
 *               reach a visible glyph (same rule as collectComponentDependentGlyphs
 *               with retainGlyphNames).
 *   `all`     — Used for every committed edit (keyboard, drag-end, undo,
 *               redo, remote).  This is the authoritative full closure.
 *
 * Mutation vs persistence:
 *   - Mutation gate: rebuild/metrics only change stored values when they differ.
 *   - Persistence gate: after live drag, automatic/metrics dependents still
 *     enter recomposeTargets even when mutation is a no-op, so Yjs matches
 *     the already-correct model.
 *
 * Drawing identity: every target carries a per-glyph drawing id resolved via
 * designspace matching. Source drawing UUIDs must never be reused as dependent ids.
 *
 * The module is the sole cascade mutator for live and commit — all
 * dependencies are passed explicitly.
 */

import type { WorkerReplayTarget } from './change-log';
import { recordCompileBenchRecomposition } from './compile-bench-probe';
import {
    deriveGlyphNameFromPath,
    getPathSegments,
    isDerivedDrawingChangePath,
    normalizeWorkerReplayTargets
} from './change-log';

// ── Public types ───────────────────────────────────────────────────────────

export type RecompositionEditKind =
    'outline' | 'anchor' | 'sidebearing' | 'component';

export type RecompositionScope = 'visible' | 'all';

export type RecompositionSourceTarget = WorkerReplayTarget & {
    /** Optional human-readable hint for diagnostics. */
    hint?: string;
};

export type RecompositionClosure = {
    /**
     * Source + recompose + invalidate.
     * Stamp as `workerReplayTargets` on the committed Yjs packet metadata.
     */
    allTargets: WorkerReplayTarget[];

    /**
     * Drawings whose stored model changed via automatic composition rebuild
     * and/or metrics-key recomputation (excludes pure invalidate dependents).
     * Use these (plus the source targets) as `changedDrawingTargets`.
     */
    recomposeTargets: WorkerReplayTarget[];

    /**
     * Component-reference dependents that need cache/redraw only.
     * Never write these into Yjs as drawing snapshots from cascade alone.
     */
    invalidateTargets: WorkerReplayTarget[];

    /**
     * Non-source dependents that belong in replay metadata
     * (`recomposeTargets ∪ invalidateTargets`).
     */
    dependentTargets: WorkerReplayTarget[];

    /** Every unique glyph name in the closure (source + dependents). */
    affectedGlyphNames: Set<string>;

    /** Glyphs whose stored model was mutated by rebuild/metrics. */
    recomposeGlyphNames: Set<string>;

    /** Glyphs that need invalidate-only refresh (may overlap recompose). */
    invalidateGlyphNames: Set<string>;
};

/**
 * Minimal font-model interface needed by the closure.
 * Injected explicitly so the closure is testable without the full DOM.
 */
export interface FontModelLike {
    findGlyph?: (name: string) => GlyphLike | null | undefined;
    collectComponentDependentGlyphs?: (
        glyphNames: Iterable<string>,
        options?: {
            includeSourceGlyphNames?: boolean;
            retainGlyphNames?: Set<string>;
        }
    ) => Set<string>;
    rebuildAutomaticCompositesForGlyphs?: (
        sourceGlyphNames: Iterable<string>,
        options?: {
            allowedGlyphNames?: Set<string>;
            preferredDrawingId?: string;
            preferredSourceGlyphName?: string;
            preserveGlyphNames?: Set<string>;
        }
    ) => Set<string>;
    recomputeMetricsKeys?: (
        sourceGlyphNames: Set<string>,
        options?: {
            allowedGlyphNames?: Set<string>;
            skipAutomaticCompositeRebuild?: boolean;
            skipInitialAutomaticCompositeRebuild?: boolean;
            preserveGlyphNames?: Set<string>;
        }
    ) => Set<string>;
    /**
     * Glyphs with metrics-key / automatic-offset edges that depend on the
     * source glyphs, whether or not their stored values need updating right
     * now. Used so commit can persist live-already-updated dependents.
     */
    collectMetricsKeyDependentGlyphs?: (
        sourceGlyphNames: Iterable<string>
    ) => Set<string>;
    collectMetricsKeyPrerequisiteGlyphs?: (
        glyphNames: Iterable<string>
    ) => Set<string>;
    invalidateLayoutCachesForGlyphs?: (glyphNames: Set<string>) => void;
}

export interface GlyphLike {
    name?: string;
    findDrawingById?: (drawingId: string) => DrawingLike | null | undefined;
    layers?: Array<{ id?: string }>;
}

export interface DrawingLike {
    id?: string;
    getMatchingDrawingOnGlyph?: (glyphName: string) => DrawingLike | null;
    isAutomaticAlignedDrawing?: () => boolean;
}

/**
 * Optional bridge-like adapter for suppressing model recording during
 * recomputation.
 */
export interface RecordingSuppressor {
    runWithoutRecording?: <T>(fn: () => T) => T;
}

type OperationLike = {
    path?: Array<string | number>;
    applyPath?: Array<string | number>;
    applyMode?: string;
    applyOldValue?: unknown;
    applyNewValue?: unknown;
    oldValue?: unknown;
    newValue?: unknown;
};

function emptyClosure(
    sourceTargets: RecompositionSourceTarget[]
): RecompositionClosure {
    const allTargets = normalizeWorkerReplayTargets(sourceTargets);
    const affectedGlyphNames = new Set(
        sourceTargets.map((t) => t.glyphName).filter(Boolean)
    );
    return {
        allTargets,
        recomposeTargets: [],
        invalidateTargets: [],
        dependentTargets: [],
        affectedGlyphNames,
        recomposeGlyphNames: new Set(),
        invalidateGlyphNames: new Set()
    };
}

function drawingSnapshotTouchesField(
    snapshot: unknown,
    field: string
): boolean {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return false;
    }
    return field in (snapshot as Record<string, unknown>);
}

/**
 * Infer edit kinds from buffered bridge operations so the finalizer does not
 * run a universal outline+anchor+sidebearing+component superset.
 */
export function deriveEditKindsFromOperations(
    operations: OperationLike[]
): Set<RecompositionEditKind> {
    const kinds = new Set<RecompositionEditKind>();

    for (const operation of operations) {
        const path = operation.applyPath ?? operation.path ?? [];
        if (
            path.length === 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'width'
        ) {
            kinds.add('sidebearing');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'anchors'
        ) {
            kinds.add('anchor');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'nodes'
        ) {
            kinds.add('outline');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'shapes'
        ) {
            // Shape ops may be path geometry or component transforms.
            kinds.add('outline');
            kinds.add('component');
            continue;
        }

        if (
            operation.applyMode === 'drawing-snapshot' &&
            path.length === 4 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers'
        ) {
            const oldValue = operation.applyOldValue ?? operation.oldValue;
            const newValue = operation.applyNewValue ?? operation.newValue;
            if (
                drawingSnapshotTouchesField(oldValue, 'width') ||
                drawingSnapshotTouchesField(newValue, 'width')
            ) {
                kinds.add('sidebearing');
            }
            if (
                drawingSnapshotTouchesField(oldValue, 'anchors') ||
                drawingSnapshotTouchesField(newValue, 'anchors')
            ) {
                kinds.add('anchor');
            }
            if (
                drawingSnapshotTouchesField(oldValue, 'shapes') ||
                drawingSnapshotTouchesField(newValue, 'shapes')
            ) {
                kinds.add('outline');
                kinds.add('component');
            }
        }
    }

    return kinds;
}

export function deriveEditKindsFromChangeLogEntries(
    entries: Array<{
        path: string;
        oldValue?: unknown;
        newValue?: unknown;
        replayOldValue?: unknown;
        replayNewValue?: unknown;
        compileEditType?: string | null;
    }>
): Set<RecompositionEditKind> {
    const kinds = deriveEditKindsFromOperations(
        entries.map((entry) => {
            const path = getPathSegments(entry.path);
            const isDrawingRoot =
                path.length === 4 &&
                path[0] === 'glyphs' &&
                path[2] === 'layers';
            return {
                path,
                applyMode: isDrawingRoot ? 'drawing-snapshot' : 'default',
                oldValue: entry.replayOldValue ?? entry.oldValue,
                newValue: entry.replayNewValue ?? entry.newValue
            };
        })
    );
    for (const entry of entries) {
        if (entry.compileEditType === 'anchor') {
            kinds.add('anchor');
        }
        if (entry.compileEditType === 'outline') {
            kinds.add('outline');
        }
        if (entry.compileEditType === 'component') {
            kinds.add('component');
        }
    }
    return kinds;
}

export function historyItemHasDerivedDrawingWrites(item: {
    originatingGlyphName?: string | null;
    entries: Array<{ path: string }>;
    workerReplayTargets?: WorkerReplayTarget[] | null;
}): boolean {
    const originatingGlyphName = item.originatingGlyphName ?? null;
    if (!originatingGlyphName) {
        return false;
    }
    for (const entry of item.entries) {
        const glyphName = deriveGlyphNameFromPath(entry.path);
        if (glyphName && glyphName !== originatingGlyphName) {
            return true;
        }
    }
    return (item.workerReplayTargets ?? []).some(
        (target) => target.glyphName !== originatingGlyphName
    );
}

function originEntriesForHistoryItem(item: {
    originatingGlyphName?: string | null;
    entries: Array<{ path: string }>;
}): Array<{ path: string }> {
    return item.entries.filter(
        (entry) =>
            !isDerivedDrawingChangePath(entry.path, item.originatingGlyphName)
    );
}

export function shouldResettleDerivedDrawingsOnHistoryReplay(
    item: {
        originatingGlyphName?: string | null;
        entries: Array<{
            path: string;
            oldValue?: unknown;
            newValue?: unknown;
            replayOldValue?: unknown;
            replayNewValue?: unknown;
            compileEditType?: string | null;
        }>;
        workerReplayTargets?: WorkerReplayTarget[] | null;
    },
    hasFontModel: boolean
): boolean {
    if (!hasFontModel || !historyItemHasDerivedDrawingWrites(item)) {
        return false;
    }
    return (
        deriveEditKindsFromChangeLogEntries(originEntriesForHistoryItem(item))
            .size > 0
    );
}

/**
 * Resolve the matching drawing on a dependent glyph.
 *
 * Drawing IDs are unique per glyph. Prefer same-id lookup only as a fast path;
 * otherwise resolve via designspace location matching from the source drawing.
 * Callers must not pass the source drawing UUID as if it were the dependent's id.
 */
export function resolveDependentDrawingTarget(
    fontModel: FontModelLike,
    glyphName: string,
    activeDrawingId: string | null | undefined,
    sourceDrawing: DrawingLike | null
): WorkerReplayTarget | null {
    const glyph = fontModel.findGlyph?.(glyphName);
    if (!glyph) {
        return null;
    }

    const matchedDrawing =
        (activeDrawingId ? glyph.findDrawingById?.(activeDrawingId) : null) ??
        sourceDrawing?.getMatchingDrawingOnGlyph?.(glyphName) ??
        null;

    if (!matchedDrawing?.id) {
        return null;
    }

    return { glyphName, layerId: matchedDrawing.id };
}

/** @deprecated Use {@link resolveDependentDrawingTarget}. */
function resolveMatchingDrawingTarget(
    fontModel: FontModelLike,
    glyphName: string,
    activeDrawingId: string | null | undefined,
    sourceDrawing: DrawingLike | null
): WorkerReplayTarget | null {
    return resolveDependentDrawingTarget(
        fontModel,
        glyphName,
        activeDrawingId,
        sourceDrawing
    );
}

function buildTargetsForGlyphNames(
    fontModel: FontModelLike,
    glyphNames: Iterable<string>,
    sourceGlyphNames: Set<string>,
    activeDrawingId: string | null | undefined,
    sourceDrawing: DrawingLike | null
): WorkerReplayTarget[] {
    const targets: WorkerReplayTarget[] = [];
    for (const glyphName of glyphNames) {
        if (sourceGlyphNames.has(glyphName)) {
            continue;
        }
        const target = resolveMatchingDrawingTarget(
            fontModel,
            glyphName,
            activeDrawingId,
            sourceDrawing
        );
        if (target) {
            targets.push(target);
        }
    }
    return normalizeWorkerReplayTargets(targets);
}

/**
 * Among component-reference candidates, keep only glyphs whose matching
 * drawing is fully automatic-aligned (eligible for model recomposition /
 * Yjs persistence).
 */
function collectAutomaticAlignedDependentGlyphNames(
    fontModel: FontModelLike,
    candidateGlyphNames: Iterable<string>,
    activeDrawingId: string | null | undefined,
    sourceDrawing: DrawingLike | null
): Set<string> {
    const automaticGlyphNames = new Set<string>();
    for (const glyphName of candidateGlyphNames) {
        const target = resolveMatchingDrawingTarget(
            fontModel,
            glyphName,
            activeDrawingId,
            sourceDrawing
        );
        if (!target) {
            continue;
        }
        const drawing = fontModel
            .findGlyph?.(glyphName)
            ?.findDrawingById?.(target.layerId);
        if (drawing?.isAutomaticAlignedDrawing?.()) {
            automaticGlyphNames.add(glyphName);
        }
    }
    return automaticGlyphNames;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the full recomposition closure for a visual edit.
 *
 * @param options.sourceTargets   The directly edited glyph/drawing pairs.
 * @param options.editKinds       Active edit kinds (outline, anchor, etc.).
 *                                Mixed selections produce a union.
 * @param options.scope           `'visible'` for live drag;
 *                                `'all'` for committed edits.
 * @param options.fontModel       Font model with the required methods.
 * @param options.activeDrawingId The active editing drawing (at a station).
 * @param options.sourceGlyphName Optional source glyph for matching-drawing
 *                                lookups on dependents.
 * @param options.suppressor      Optional bridge-like object whose
 *                                `runWithoutRecording` wraps model mutations.
 * @param options.visibleGlyphNames Glyph names considered visible.  Used only
 *                                when scope is `'visible'` to limit dependents.
 * @param options.preserveGlyphNames Glyphs whose drawings stay as they are
 *                                (a collaborator’s stored drawings): only
 *                                what depends on them is recomposed.
 */
// Memoize visible-scope dependency topology across consecutive live-drag
// frames of the same font revision + source glyph + visible set.
let visibleTopologyCacheKey = '';
let visibleTopologyCacheModel: WeakRef<FontModelLike> | null = null;
let visibleTopologyCacheResult: {
    invalidateGlyphNames: Set<string>;
    visibleMetricsPrerequisites: Set<string>;
} | null = null;

export function computeDrawingRecompositionClosure(options: {
    sourceTargets: RecompositionSourceTarget[];
    editKinds: Set<RecompositionEditKind>;
    scope: RecompositionScope;
    fontModel: FontModelLike;
    activeDrawingId?: string | null;
    sourceGlyphName?: string | null;
    suppressor?: RecordingSuppressor | null;
    visibleGlyphNames?: Iterable<string>;
    preserveGlyphNames?: Set<string>;
}): RecompositionClosure {
    const startedAt = performance.now();
    const finish = (closure: RecompositionClosure): RecompositionClosure => {
        recordCompileBenchRecomposition(
            'closure',
            performance.now() - startedAt,
            { glyphCount: closure.affectedGlyphNames.size }
        );
        return closure;
    };

    const {
        sourceTargets,
        editKinds,
        scope,
        fontModel,
        activeDrawingId,
        sourceGlyphName,
        suppressor,
        visibleGlyphNames,
        preserveGlyphNames
    } = options;

    if (!fontModel) {
        return finish(emptyClosure(sourceTargets));
    }

    const sourceGlyphNames = new Set(
        sourceTargets.map((t) => t.glyphName).filter((n): n is string => !!n)
    );
    const recomposeGlyphNames = new Set<string>();
    const invalidateGlyphNames = new Set<string>();

    const visibleSet =
        scope === 'visible' && visibleGlyphNames
            ? new Set(visibleGlyphNames)
            : null;

    const wrap = <T>(fn: () => T): T => {
        if (suppressor?.runWithoutRecording) {
            return suppressor.runWithoutRecording(fn);
        }
        return fn();
    };

    const touchesGeometry =
        editKinds.has('outline') ||
        editKinds.has('anchor') ||
        editKinds.has('sidebearing') ||
        editKinds.has('component');
    const needsMetricsPropagation =
        editKinds.has('sidebearing') ||
        editKinds.has('outline') ||
        editKinds.has('component');

    // ── Invalidate-only: all component-reference dependents ─────────────
    // Manual and automatic composites that *draw* the edited source need
    // cache/redraw refresh, but only automatic/metrics edges may mutate
    // stored drawing data (handled below). Visible scope expands intermediates
    // that reach a retained visible glyph.
    const fontChangeVersion =
        typeof window !== 'undefined'
            ? (window.fontManager?.currentFont?.changeVersion ?? -1)
            : -1;
    const canUseVisibleTopologyCache =
        scope === 'visible' &&
        !!visibleSet &&
        fontChangeVersion >= 0 &&
        touchesGeometry;
    const visibleCacheKey = canUseVisibleTopologyCache
        ? `${fontChangeVersion}\0${[...sourceGlyphNames].sort().join(',')}\0${[...visibleSet!].sort().join(',')}`
        : '';
    const cachedTopology =
        canUseVisibleTopologyCache &&
        visibleTopologyCacheKey === visibleCacheKey &&
        visibleTopologyCacheModel?.deref() === fontModel
            ? visibleTopologyCacheResult
            : null;

    let visibleMetricsPrerequisites: Set<string>;
    if (cachedTopology) {
        for (const depGlyphName of cachedTopology.invalidateGlyphNames) {
            invalidateGlyphNames.add(depGlyphName);
        }
        visibleMetricsPrerequisites =
            cachedTopology.visibleMetricsPrerequisites;
    } else {
        if (
            touchesGeometry &&
            typeof fontModel.collectComponentDependentGlyphs === 'function'
        ) {
            const collected = wrap(() =>
                fontModel.collectComponentDependentGlyphs!(sourceGlyphNames, {
                    ...(scope === 'visible' && visibleSet
                        ? { retainGlyphNames: visibleSet }
                        : {})
                })
            );
            for (const depGlyphName of collected) {
                if (!sourceGlyphNames.has(depGlyphName)) {
                    invalidateGlyphNames.add(depGlyphName);
                }
            }
        }

        // Allowed set for live mutation:
        // - component retain expansion (hidden intermediates → visible)
        // - all currently visible glyphs (so metrics-key dependents like `n`
        //   that reference the source without being component users still update)
        visibleMetricsPrerequisites =
            scope === 'visible' &&
            visibleSet &&
            typeof fontModel.collectMetricsKeyPrerequisiteGlyphs === 'function'
                ? wrap(() =>
                      fontModel.collectMetricsKeyPrerequisiteGlyphs!(visibleSet)
                  )
                : new Set<string>();

        if (canUseVisibleTopologyCache) {
            visibleTopologyCacheKey = visibleCacheKey;
            visibleTopologyCacheModel = new WeakRef(fontModel);
            visibleTopologyCacheResult = {
                invalidateGlyphNames: new Set(invalidateGlyphNames),
                visibleMetricsPrerequisites: new Set(
                    visibleMetricsPrerequisites
                )
            };
        }
    }

    const allowedGlyphNames =
        scope === 'visible' && visibleSet
            ? new Set([
                  ...sourceGlyphNames,
                  ...invalidateGlyphNames,
                  ...visibleSet,
                  // Visible keyed glyphs require their hidden metric sources
                  // to settle too; otherwise live and all-scope commit passes
                  // resolve the same key chain against different values.
                  ...visibleMetricsPrerequisites
              ])
            : null;

    // Invalidate only source ∪ component dependents (plus hidden metric
    // prerequisites that feed visible keyed glyphs). Do not walk every
    // currently visible glyph's layout cache on each live tick.
    const layoutInvalidationGlyphNames = new Set<string>([
        ...sourceGlyphNames,
        ...invalidateGlyphNames,
        ...visibleMetricsPrerequisites
    ]);

    // ── Model recomposition: automatic composites ───────────────────────
    // rebuildAutomaticCompositesForGlyphs already gates on
    // isAutomaticAlignedDrawing() and returns only glyphs whose stored
    // placement/width actually changed.
    if (
        touchesGeometry &&
        typeof fontModel.rebuildAutomaticCompositesForGlyphs === 'function'
    ) {
        const preferredTarget = sourceTargets[0] ?? null;
        const affectedComposites: Set<string> = wrap(() => {
            if (
                layoutInvalidationGlyphNames.size > 0 &&
                typeof fontModel.invalidateLayoutCachesForGlyphs === 'function'
            ) {
                fontModel.invalidateLayoutCachesForGlyphs(
                    layoutInvalidationGlyphNames
                );
            }

            return fontModel.rebuildAutomaticCompositesForGlyphs!(
                sourceGlyphNames,
                {
                    ...(allowedGlyphNames ? { allowedGlyphNames } : {}),
                    ...(preserveGlyphNames ? { preserveGlyphNames } : {}),
                    ...(preferredTarget?.layerId
                        ? {
                              preferredDrawingId: preferredTarget.layerId,
                              preferredSourceGlyphName:
                                  preferredTarget.glyphName
                          }
                        : {})
                }
            );
        });

        for (const glyphName of affectedComposites) {
            recomposeGlyphNames.add(glyphName);
        }
    }

    // ── Model recomposition: metrics-key + automatic-offset dependents ──
    // Outline edits are included because moving the visual edge of a keyed
    // source glyph must refresh inherited sidebearings. Anchor-only edits
    // do not drive metrics-key inheritance. Automatic drawings are mutated only
    // via rebuild above — never via metrics translate/bake.
    if (
        needsMetricsPropagation &&
        typeof fontModel.recomputeMetricsKeys === 'function'
    ) {
        const metricsDeps = wrap(() =>
            fontModel.recomputeMetricsKeys!(sourceGlyphNames, {
                ...(allowedGlyphNames ? { allowedGlyphNames } : {}),
                ...(preserveGlyphNames ? { preserveGlyphNames } : {}),
                // The closure already performed the initial source-component
                // rebuild above. Keep that work single-pass, but allow the
                // metrics queue to rebuild automatic dependents after a keyed
                // glyph changes (l -> n -> a -> adieresis).
                skipInitialAutomaticCompositeRebuild: true
            })
        );
        for (const depGlyphName of metricsDeps) {
            recomposeGlyphNames.add(depGlyphName);
        }
    }

    const sourceDrawing =
        sourceGlyphName && activeDrawingId
            ? (fontModel
                  .findGlyph?.(sourceGlyphName)
                  ?.findDrawingById?.(activeDrawingId) ?? null)
            : null;

    // Persist transitive metrics-key dependents and automatic composites on
    // commit (`scope === 'all'`) even when the rebuild/metrics pass is a no-op
    // because live drag already converged `fontModel`. Run metrics-key
    // dependents FIRST so automatic composites of multi-hop keyed glyphs
    // (e.g. `l -> n -> a -> adieresis`) are always included in the persistence
    // closure. Live drag (`scope === 'visible'`) only needs drawings that
    // actually mutated on that frame, keeping preview overlays lean.
    if (
        scope === 'all' &&
        (editKinds.has('sidebearing') ||
            editKinds.has('outline') ||
            editKinds.has('component')) &&
        typeof fontModel.collectMetricsKeyDependentGlyphs === 'function'
    ) {
        for (const glyphName of fontModel.collectMetricsKeyDependentGlyphs(
            sourceGlyphNames
        )) {
            if (allowedGlyphNames && !allowedGlyphNames.has(glyphName)) {
                continue;
            }
            recomposeGlyphNames.add(glyphName);
        }
    }
    const shouldPersistAutomaticDependents =
        scope === 'all' &&
        (editKinds.has('sidebearing') ||
            editKinds.has('outline') ||
            editKinds.has('component') ||
            editKinds.has('anchor') ||
            [...recomposeGlyphNames].some(
                (glyphName) => !sourceGlyphNames.has(glyphName)
            ));
    if (shouldPersistAutomaticDependents) {
        const automaticCandidateSeed = new Set<string>([
            ...sourceGlyphNames,
            ...invalidateGlyphNames,
            ...recomposeGlyphNames
        ]);
        const automaticCandidates = new Set<string>([
            ...invalidateGlyphNames,
            ...recomposeGlyphNames
        ]);
        if (typeof fontModel.collectComponentDependentGlyphs === 'function') {
            for (const depGlyphName of fontModel.collectComponentDependentGlyphs(
                automaticCandidateSeed
            )) {
                if (!sourceGlyphNames.has(depGlyphName)) {
                    automaticCandidates.add(depGlyphName);
                }
            }
        }
        for (const glyphName of collectAutomaticAlignedDependentGlyphNames(
            fontModel,
            automaticCandidates,
            activeDrawingId,
            sourceDrawing
        )) {
            if (allowedGlyphNames && !allowedGlyphNames.has(glyphName)) {
                continue;
            }
            recomposeGlyphNames.add(glyphName);
        }
    }

    const recomposeTargets = buildTargetsForGlyphNames(
        fontModel,
        recomposeGlyphNames,
        sourceGlyphNames,
        activeDrawingId,
        sourceDrawing
    );
    const invalidateOnlyGlyphNames = new Set(
        [...invalidateGlyphNames].filter(
            (glyphName) => !recomposeGlyphNames.has(glyphName)
        )
    );
    const invalidateTargets = buildTargetsForGlyphNames(
        fontModel,
        invalidateOnlyGlyphNames,
        sourceGlyphNames,
        activeDrawingId,
        sourceDrawing
    );
    const dependentTargets = normalizeWorkerReplayTargets([
        ...recomposeTargets,
        ...invalidateTargets
    ]);
    const allTargets = normalizeWorkerReplayTargets([
        ...sourceTargets,
        ...dependentTargets
    ]);

    const affectedGlyphNames = new Set<string>([
        ...sourceGlyphNames,
        ...recomposeGlyphNames,
        ...invalidateGlyphNames
    ]);

    return finish({
        allTargets,
        recomposeTargets,
        invalidateTargets,
        dependentTargets,
        affectedGlyphNames,
        recomposeGlyphNames,
        invalidateGlyphNames
    });
}

/**
 * Convenience shortcut: derive the set of edit kinds from a drag type and
 * optional selection-state flags.  This ensures every drag-end path produces
 * the same union closure as a keyboard edit with the same selection.
 */
export function deriveEditKindsFromDrag(
    dragType: string | null,
    hasGeometryInSelection: boolean,
    hasAnchorsInSelection: boolean,
    hasComponentsInSelection: boolean
): Set<RecompositionEditKind> {
    const kinds = new Set<RecompositionEditKind>();

    switch (dragType) {
        case 'point':
            kinds.add('outline');
            break;
        case 'anchor':
            kinds.add('anchor');
            break;
        case 'component':
            kinds.add('component');
            break;
        case 'sidebearing':
            kinds.add('sidebearing');
            break;
        case 'transform':
            if (hasGeometryInSelection) kinds.add('outline');
            if (hasAnchorsInSelection) kinds.add('anchor');
            if (hasComponentsInSelection) kinds.add('component');
            break;
        default:
            // Fallback: add only outline as a safe default.
            kinds.add('outline');
            break;
    }

    if (kinds.size === 0) {
        kinds.add('outline');
    }

    return kinds;
}

/**
 * Resolve Yjs drawing-sync targets from a closure result.
 * Replay stays wide; changed-drawing snapshots stay lean (source + recompose).
 */
export function resolveDrawingSyncTargetsFromClosure(
    closure: RecompositionClosure,
    sourceTargets: WorkerReplayTarget[],
    previouslyRecomposedTargets: WorkerReplayTarget[] = []
): {
    changedDrawingTargets: WorkerReplayTarget[];
    workerReplayTargets: WorkerReplayTarget[];
} {
    const normalizedSource = normalizeWorkerReplayTargets(sourceTargets);
    return {
        changedDrawingTargets: normalizeWorkerReplayTargets([
            ...normalizedSource,
            // Live drag may already have converged visible descendants before
            // the all-scope commit closure runs. A no-op final pass must still
            // snapshot those drawings into Yjs; otherwise the worker retains
            // their pre-drag state and the full commit reshape rolls them back.
            ...previouslyRecomposedTargets,
            ...closure.recomposeTargets
        ]),
        workerReplayTargets: normalizeWorkerReplayTargets([
            ...previouslyRecomposedTargets,
            ...(closure.allTargets.length > 0
                ? closure.allTargets
                : normalizedSource)
        ])
    };
}
