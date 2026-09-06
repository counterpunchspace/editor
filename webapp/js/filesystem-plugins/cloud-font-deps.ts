/**
 * font-deps shard: UUID-keyed per-edge CRDT. No ranks, packed LWW rows,
 * or stored reverse graph. Glyph shards are authoritative; this is a
 * denormalized projection repaired from converged glyph bodies.
 */

import * as Y from 'yjs';
import {
    catalogFromCoreJson,
    ensureImmutableGlyphId,
    listGlyphRecords,
    liveCatalogGlyphIds
} from './cloud-glyph-catalog';

export type FontDepEdgeKind = 'component' | 'metrics-key' | 'both';

export type FontDepsIndex = {
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    sourceRevision: Record<string, string>;
};

function ensureChildMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
    const existing = parent.get(key);
    if (existing instanceof Y.Map) {
        return existing;
    }
    const created = new Y.Map<unknown>();
    parent.set(key, created);
    return created;
}

const METRICS_KEY_SUFFIX = /^[@+\-*/]/;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function mergeEdgeKind(
    left: FontDepEdgeKind | undefined,
    right: FontDepEdgeKind
): FontDepEdgeKind {
    if (!left || left === right) {
        return right;
    }
    return 'both';
}

function collectShapeReferences(glyph: Record<string, unknown>): string[] {
    const refs: string[] = [];
    const visitShape = (shape: unknown) => {
        const shapeRecord = asRecord(shape);
        if (!shapeRecord) {
            return;
        }
        const nested = asRecord(shapeRecord.Component);
        const data = asRecord(shapeRecord.data);
        const reference =
            (typeof shapeRecord.reference === 'string' &&
                shapeRecord.reference) ||
            (typeof nested?.reference === 'string' && nested.reference) ||
            (typeof data?.reference === 'string' && data.reference) ||
            '';
        if (reference) {
            refs.push(reference);
        }
        const nestedShapes = Array.isArray(shapeRecord.shapes)
            ? shapeRecord.shapes
            : [];
        for (const child of nestedShapes) {
            visitShape(child);
        }
    };
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        const shapes = Array.isArray(layerRecord.shapes)
            ? layerRecord.shapes
            : [];
        for (const shape of shapes) {
            visitShape(shape);
        }
    }
    return refs;
}

function pushFormatSpecificMetricKeys(
    record: Record<string, unknown> | null,
    pushKey: (value: unknown) => void
): void {
    const format = asRecord(record?.format_specific);
    if (!format) {
        return;
    }
    pushKey(format.metric_left);
    pushKey(format.metric_right);
    pushKey(format.metric_width);
}

function collectMetricsKeyStrings(glyph: Record<string, unknown>): string[] {
    const keys: string[] = [];
    const pushKey = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            keys.push(value);
        }
    };
    pushKey(glyph.leftMetricsKey);
    pushKey(glyph.rightMetricsKey);
    pushKey(glyph.widthMetricsKey);
    pushFormatSpecificMetricKeys(glyph, pushKey);
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        pushKey(layerRecord.leftMetricsKey);
        pushKey(layerRecord.rightMetricsKey);
        pushKey(layerRecord.widthMetricsKey);
        pushFormatSpecificMetricKeys(layerRecord, pushKey);
    }
    return keys;
}

/**
 * Parse a metrics-key string against longest-first glyph names.
 * Matches the live editor grammar (`=H`, `=|H+10`, `==a@-20`).
 */
export function parseMetricsKeyReferencedNames(
    rawKey: string,
    namesByLength: string[]
): string[] {
    let input = rawKey.trim();
    if (!input) {
        return [];
    }
    if (input.startsWith('==')) {
        input = input.slice(1);
    }
    if (isFiniteNumberText(input) || /^=[+-]?\d+(?:\.\d+)?$/.test(input)) {
        return [];
    }
    let body = input.startsWith('=') ? input.slice(1) : input;
    if (body.startsWith('|')) {
        body = body.slice(1);
    }
    if (!body) {
        return [];
    }
    for (const glyphName of namesByLength) {
        if (!glyphName) {
            continue;
        }
        if (body === glyphName) {
            return [glyphName];
        }
        if (
            body.startsWith(glyphName) &&
            METRICS_KEY_SUFFIX.test(body.slice(glyphName.length))
        ) {
            return [glyphName];
        }
    }
    return [];
}

function isFiniteNumberText(value: string): boolean {
    return /^-?\d+(?:\.\d+)?$/.test(value);
}

export function catalogEntriesForDepsParse(
    fontJson: Record<string, unknown>
): Array<{ glyphId: string; name: string; componentIds?: string[] }> {
    const owned = catalogFromCoreJson(fontJson);
    if (owned) {
        return Object.values(owned.glyphCatalog)
            .filter(
                (entry) =>
                    Boolean(entry.glyphId) &&
                    Boolean(entry.name) &&
                    entry.deleted !== true
            )
            .map((entry) => ({
                glyphId: entry.glyphId,
                name: entry.name,
                ...(Array.isArray(entry.componentIds) &&
                entry.componentIds.length
                    ? { componentIds: entry.componentIds }
                    : {})
            }));
    }
    return listGlyphRecords(fontJson)
        .map((glyph) => ({
            glyphId: ensureImmutableGlyphId(glyph),
            name: String(glyph.name || '')
        }))
        .filter((entry) => entry.name);
}

export function buildFontDepsIndex(
    fontJson: Record<string, unknown>
): FontDepsIndex {
    const glyphs = listGlyphRecords(fontJson);
    const idByName = new Map<string, string>();
    for (const entry of catalogEntriesForDepsParse(fontJson)) {
        idByName.set(entry.name, entry.glyphId);
    }
    for (const glyph of glyphs) {
        const name = String(glyph.name || '');
        if (name) {
            idByName.set(name, ensureImmutableGlyphId(glyph));
        }
    }
    const namesByLength = [...idByName.keys()].sort(
        (left, right) => right.length - left.length
    );
    const edges: Record<string, Record<string, FontDepEdgeKind>> = {};
    const sourceRevision: Record<string, string> = {};

    for (const glyph of glyphs) {
        const glyphId = ensureImmutableGlyphId(glyph);
        const targets: Record<string, FontDepEdgeKind> = {};
        for (const name of collectShapeReferences(glyph)) {
            const id = idByName.get(name);
            if (id && id !== glyphId) {
                targets[id] = mergeEdgeKind(targets[id], 'component');
            }
        }
        for (const key of collectMetricsKeyStrings(glyph)) {
            for (const name of parseMetricsKeyReferencedNames(
                key,
                namesByLength
            )) {
                const id = idByName.get(name);
                if (id && id !== glyphId) {
                    targets[id] = mergeEdgeKind(targets[id], 'metrics-key');
                }
            }
        }
        if (Object.keys(targets).length) {
            edges[glyphId] = targets;
        }
        // Bootstrap snapshots have no shard revision yet. Keep this
        // deterministic; a random token would falsely mark every source stale
        // on the next repair pass.
        sourceRevision[glyphId] = String(glyph.latestGlyphRevision || '0');
    }
    return { edges, sourceRevision };
}

/** Rebuild one authoritative source using the lean core catalog for names. */
export function buildFontDepsForGlyph(
    glyph: Record<string, unknown>,
    catalog: Array<{ glyphId: string; name: string }>
): Record<string, FontDepEdgeKind> {
    const idByName = new Map(
        catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const sourceId = ensureImmutableGlyphId(glyph);
    const namesByLength = [...idByName.keys()].sort(
        (left, right) => right.length - left.length
    );
    const targets: Record<string, FontDepEdgeKind> = {};
    for (const name of collectShapeReferences(glyph)) {
        const id = idByName.get(name);
        if (id && id !== sourceId) {
            targets[id] = mergeEdgeKind(targets[id], 'component');
        }
    }
    for (const key of collectMetricsKeyStrings(glyph)) {
        for (const name of parseMetricsKeyReferencedNames(key, namesByLength)) {
            const id = idByName.get(name);
            if (id && id !== sourceId) {
                targets[id] = mergeEdgeKind(targets[id], 'metrics-key');
            }
        }
    }
    return targets;
}

export function writeFontDepsYMap(
    depsMap: Y.Map<unknown>,
    index: FontDepsIndex
): void {
    const edgesMap = ensureChildMap(depsMap, 'edges');
    const revisionMap = ensureChildMap(depsMap, 'sourceRevision');
    replaceNestedEdgeMaps(edgesMap, index.edges);
    replaceScalarMap(revisionMap, index.sourceRevision);
}

export function patchSourceEdges(
    depsMap: Y.Map<unknown>,
    sourceId: string,
    nextEdges: Record<string, FontDepEdgeKind>,
    revision: string
): void {
    const edgesMap = ensureChildMap(depsMap, 'edges');
    const revisionMap = ensureChildMap(depsMap, 'sourceRevision');
    const keys = Object.keys(nextEdges);
    if (!keys.length) {
        edgesMap.delete(sourceId);
    } else {
        const sourceMap = ensureChildMap(edgesMap, sourceId);
        replaceScalarMap(sourceMap, nextEdges);
    }
    revisionMap.set(sourceId, revision);
}

export function readFontDepsIndex(depsMap: Y.Map<unknown>): FontDepsIndex {
    const edges: Record<string, Record<string, FontDepEdgeKind>> = {};
    const sourceRevision: Record<string, string> = {};
    const edgesMap = depsMap.get('edges');
    if (edgesMap instanceof Y.Map) {
        edgesMap.forEach((value, sourceId) => {
            if (!(value instanceof Y.Map)) {
                return;
            }
            const targets: Record<string, FontDepEdgeKind> = {};
            value.forEach((kind, targetId) => {
                if (
                    kind === 'component' ||
                    kind === 'metrics-key' ||
                    kind === 'both'
                ) {
                    targets[targetId] = kind;
                }
            });
            if (Object.keys(targets).length) {
                edges[sourceId] = targets;
            }
        });
    }
    const revisionMap = depsMap.get('sourceRevision');
    if (revisionMap instanceof Y.Map) {
        revisionMap.forEach((value, sourceId) => {
            if (typeof value === 'string' && value) {
                sourceRevision[sourceId] = value;
            }
        });
    }
    return { edges, sourceRevision };
}

/**
 * Directed forward close over component references stored on glyph bodies.
 * Walks every hop: `edieresis` → `dieresiscomb` → `dotaccentcomb`.
 * Glyphs whose bodies are not in `glyphs` still enter the set (so they can
 * be fetched) but cannot expose a further hop until a later pass.
 */
export function closeForwardComponentIds(options: {
    glyphs: Array<Record<string, unknown>>;
    catalog: Array<{ glyphId: string; name: string }>;
    seedIds: string[];
}): string[] {
    const idByName = new Map(
        options.catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const nameById = new Map(
        options.catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const glyphById = new Map<string, Record<string, unknown>>();
    const glyphByName = new Map<string, Record<string, unknown>>();
    for (const glyph of options.glyphs) {
        const id = ensureImmutableGlyphId(glyph);
        const name = String(glyph.name || '');
        if (id) {
            glyphById.set(id, glyph);
        }
        if (name) {
            glyphByName.set(name, glyph);
        }
    }
    const closed = new Set(options.seedIds.filter(Boolean));
    const queue = [...closed];
    while (queue.length) {
        const current = queue.pop()!;
        const glyph =
            glyphById.get(current) ||
            glyphByName.get(nameById.get(current) || '');
        if (!glyph) {
            continue;
        }
        for (const name of collectShapeReferences(glyph)) {
            const targetId = idByName.get(name);
            if (!targetId || closed.has(targetId)) {
                continue;
            }
            closed.add(targetId);
            queue.push(targetId);
        }
    }
    return [...closed];
}

/**
 * Glyph names that reverse* from the seeds over font-deps. Composites such as
 * `adieresis` live as sources (`adieresis → a`), so cmap seed `a` only finds
 * them by inverting this graph — not by walking loaded glyph bodies.
 */
export function closeReverseComponentNamesFromDeps(options: {
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    seedNames: string[];
    catalog: Array<{ glyphId: string; name: string }>;
}): string[] {
    const nameToId = new Map(
        options.catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const idToName = new Map(
        options.catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const seedNameSet = new Set(options.seedNames);
    const seedIds = [
        ...new Set(
            options.seedNames
                .map((name) => nameToId.get(name))
                .filter((id): id is string => Boolean(id))
        )
    ];
    if (!seedIds.length) {
        return [];
    }
    const edges = mergeHydrationEdges(options.edges, options.catalog);
    const working = closeSet(seedIds, invertForwardEdges(edges, 'component'));
    const bases = encodedBaseGlyphIds({
        seedIds,
        edges,
        catalog: options.catalog
    });
    const dependents = closeSet(bases, invertForwardEdges(edges, 'component'));
    return [...new Set([...working, ...dependents])]
        .map((id) => idToName.get(id))
        .filter((name): name is string => typeof name === 'string')
        .filter((name) => !seedNameSet.has(name));
}

export function closeComponentNamesFromFontJson(options: {
    fontJson: Record<string, unknown>;
    seedNames: string[];
}): string[] {
    const catalog = catalogEntriesForDepsParse(options.fontJson);
    const nameToId = new Map(
        catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const idToName = new Map(
        catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const seedIds = [
        ...new Set(
            options.seedNames
                .map((name) => nameToId.get(name))
                .filter((id): id is string => Boolean(id))
        )
    ];
    if (!seedIds.length) {
        return [];
    }
    const seedNameSet = new Set(options.seedNames);
    return closeForwardComponentIds({
        glyphs: listGlyphRecords(options.fontJson),
        catalog,
        seedIds
    })
        .map((id) => idToName.get(id))
        .filter((name): name is string => typeof name === 'string')
        .filter((name) => !seedNameSet.has(name));
}

export function expandSparsePlanWithLoadedComponents(options: {
    plan: SparseHydrationPlan;
    glyphs: Array<Record<string, unknown>>;
    catalog: Array<{ glyphId: string; name: string }>;
    catalogIds: string[];
    loadedIds: Iterable<string>;
}): SparseHydrationPlan {
    const catalogIdSet = new Set(options.catalogIds);
    const loaded = new Set(options.loadedIds);
    const workingSet = new Set(options.plan.workingIds);
    const componentIds = closeForwardComponentIds({
        glyphs: options.glyphs,
        catalog: options.catalog,
        seedIds: options.plan.workingIds
    }).filter((id) => catalogIdSet.has(id));
    for (const id of componentIds) {
        workingSet.add(id);
    }
    const workingIds = [...workingSet];
    const hiddenIds = options.plan.hiddenIds.filter(
        (id) => !workingSet.has(id)
    );
    const loadIds = [...new Set([...workingIds, ...hiddenIds])];
    return {
        workingIds,
        hiddenIds,
        loadIds,
        missingIds: loadIds.filter((id) => !loaded.has(id))
    };
}

export function mergeFontDepEdges(
    base: Record<string, Record<string, FontDepEdgeKind>>,
    extra: Record<string, Record<string, FontDepEdgeKind>>
): Record<string, Record<string, FontDepEdgeKind>> {
    const merged: Record<string, Record<string, FontDepEdgeKind>> = {};
    for (const source of [base, extra]) {
        for (const [glyphId, targets] of Object.entries(source)) {
            merged[glyphId] = { ...(merged[glyphId] || {}), ...targets };
        }
    }
    return merged;
}

function isLikelyMarkGlyphName(name: string): boolean {
    return (
        /(?:^|[._-])(?:comb|mark)(?:$|[._-])/i.test(name) || /comb$/i.test(name)
    );
}

function componentTargetIds(
    edges: Record<string, Record<string, FontDepEdgeKind>>,
    sourceId: string
): string[] {
    const targets = edges[sourceId];
    if (!targets) {
        return [];
    }
    return Object.entries(targets)
        .filter(([, kind]) => kind === 'component' || kind === 'both')
        .map(([targetId]) => targetId);
}

type HydrationCatalogEntry = {
    glyphId: string;
    name: string;
    componentIds?: string[];
};

function componentEdgesFromCatalogIds(
    catalog: HydrationCatalogEntry[]
): Record<string, Record<string, FontDepEdgeKind>> {
    const edges: Record<string, Record<string, FontDepEdgeKind>> = {};
    for (const entry of catalog) {
        if (!Array.isArray(entry.componentIds) || !entry.componentIds.length) {
            continue;
        }
        const targets: Record<string, FontDepEdgeKind> = {};
        for (const targetId of entry.componentIds) {
            if (targetId && targetId !== entry.glyphId) {
                targets[targetId] = 'component';
            }
        }
        if (Object.keys(targets).length) {
            edges[entry.glyphId] = targets;
        }
    }
    return edges;
}

function mergeHydrationEdges(
    depsEdges: Record<string, Record<string, FontDepEdgeKind>>,
    catalog?: HydrationCatalogEntry[]
): Record<string, Record<string, FontDepEdgeKind>> {
    return mergeFontDepEdges(
        depsEdges,
        componentEdgesFromCatalogIds(catalog || [])
    );
}

/**
 * Encoded base glyphs for a sparse seed. A simple glyph (`a`) is its own
 * base. A composite contributes its non-mark components from the
 * component graph (`adieresis` → `a`) so reverse-close can reach the
 * rest of that family.
 */
export function encodedBaseGlyphIds(options: {
    seedIds: string[];
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    catalog?: Array<{ glyphId: string; name: string }>;
}): string[] {
    const bases = new Set(options.seedIds.filter(Boolean));
    const idToName = new Map(
        (options.catalog || []).map((entry) => [entry.glyphId, entry.name])
    );
    for (const seedId of [...bases]) {
        for (const componentId of componentTargetIds(options.edges, seedId)) {
            if (!isLikelyMarkGlyphName(idToName.get(componentId) || '')) {
                bases.add(componentId);
            }
        }
    }
    return [...bases];
}

function edgeHasKind(
    kind: FontDepEdgeKind,
    wanted: 'component' | 'metrics-key'
): boolean {
    return kind === wanted || kind === 'both';
}

export function invertForwardEdges(
    edges: Record<string, Record<string, FontDepEdgeKind>>,
    kind?: 'component' | 'metrics-key'
): Record<string, string[]> {
    const reverse: Record<string, string[]> = {};
    for (const [source, targets] of Object.entries(edges)) {
        for (const [target, edgeKind] of Object.entries(targets)) {
            if (kind && !edgeHasKind(edgeKind, kind)) {
                continue;
            }
            if (!reverse[target]) {
                reverse[target] = [];
            }
            if (!reverse[target].includes(source)) {
                reverse[target].push(source);
            }
        }
    }
    return reverse;
}

function forwardAdjacencyOfKind(
    edges: Record<string, Record<string, FontDepEdgeKind>>,
    kind: 'component' | 'metrics-key'
): Record<string, string[]> {
    const adjacency: Record<string, string[]> = {};
    for (const [source, targets] of Object.entries(edges)) {
        for (const [target, edgeKind] of Object.entries(targets)) {
            if (!edgeHasKind(edgeKind, kind)) {
                continue;
            }
            if (!adjacency[source]) {
                adjacency[source] = [];
            }
            if (!adjacency[source].includes(target)) {
                adjacency[source].push(target);
            }
        }
    }
    return adjacency;
}

function closeSet(
    seeds: string[],
    adjacency: Record<string, string[] | Record<string, FontDepEdgeKind>>
): Set<string> {
    const closed = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
        const current = queue.pop()!;
        const neighbors = adjacency[current];
        if (!neighbors) {
            continue;
        }
        const ids = Array.isArray(neighbors)
            ? neighbors
            : Object.keys(neighbors);
        for (const id of ids) {
            if (!closed.has(id)) {
                closed.add(id);
                queue.push(id);
            }
        }
    }
    return closed;
}

export type SparseHydrationPartition = {
    workingIds: string[];
    hiddenIds: string[];
    loadIds: string[];
};

export type SparseHydrationPlan = SparseHydrationPartition & {
    missingIds: string[];
};

/**
 * Directed sparse close.
 *
 * Working: requested seeds ∪ prior working ∪ layout alts ∪ encoded
 * bases of those, reverse* over component edges from font-deps and
 * catalog `componentIds`, then forward* so nested parts are working.
 * Layout alts come from feature code, not from glyph names.
 *
 * Hidden: metrics-key sources of working (`n`, `l`) ∪ glyphs that
 * inherit sidebearings from working (`a.wide` keyed to `a`) ∪ those
 * inheritors' nested components, minus working. Do not reverse
 * metrics-key or component from hidden sources (`h`/`ntilde` from `n`).
 * Do not GSUB-close the reverse set. Do not infer from glyph names.
 */
export function computeSparseHydrationPartition(options: {
    seedIds: string[];
    layoutIds?: string[];
    previousWorkingIds?: string[];
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    catalog?: Array<{ glyphId: string; name: string }>;
}): SparseHydrationPartition {
    const edges = mergeHydrationEdges(options.edges, options.catalog);
    const workingSeeds = encodedBaseGlyphIds({
        seedIds: [
            ...new Set([
                ...(options.previousWorkingIds || []),
                ...options.seedIds,
                ...(options.layoutIds || [])
            ])
        ],
        edges,
        catalog: options.catalog
    });
    const reverseWorking = closeSet(
        workingSeeds,
        invertForwardEdges(edges, 'component')
    );
    const working = closeSet(
        [...reverseWorking],
        forwardAdjacencyOfKind(edges, 'component')
    );
    const metricsPool = closeSet(
        [...working],
        forwardAdjacencyOfKind(options.edges, 'metrics-key')
    );
    const reverseMetrics = invertForwardEdges(options.edges, 'metrics-key');
    const metricsInheritors = new Set<string>();
    for (const id of working) {
        for (const inheritor of reverseMetrics[id] || []) {
            metricsInheritors.add(inheritor);
        }
    }
    const inheritorParts = closeSet(
        [...metricsInheritors].filter((id) => !working.has(id)),
        forwardAdjacencyOfKind(edges, 'component')
    );
    const hidden = [
        ...new Set([...metricsPool, ...metricsInheritors, ...inheritorParts])
    ].filter((id) => !working.has(id));
    const workingIds = [...working];
    return {
        workingIds,
        hiddenIds: hidden,
        loadIds: [...workingIds, ...hidden]
    };
}

export function planSparseHydration(options: {
    seedIds: string[];
    layoutIds?: string[];
    previousWorkingIds?: string[];
    catalogIds: string[];
    loadedIds?: Iterable<string>;
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    catalog?: Array<{ glyphId: string; name: string }>;
}): SparseHydrationPlan {
    const catalog = new Set(options.catalogIds);
    const hasSeeds =
        options.seedIds.length > 0 ||
        (options.layoutIds || []).length > 0 ||
        (options.previousWorkingIds || []).length > 0;
    if (!hasSeeds) {
        return {
            workingIds: [],
            hiddenIds: [],
            loadIds: [],
            missingIds: []
        };
    }
    const partition = computeSparseHydrationPartition({
        seedIds: options.seedIds,
        layoutIds: options.layoutIds,
        previousWorkingIds: options.previousWorkingIds,
        edges: options.edges,
        catalog: options.catalog
    });
    const workingIds = partition.workingIds.filter((id) => catalog.has(id));
    const hiddenIds = partition.hiddenIds.filter((id) => catalog.has(id));
    const loadIds = [...new Set([...workingIds, ...hiddenIds])];
    const loaded = new Set(options.loadedIds || []);
    return {
        workingIds,
        hiddenIds,
        loadIds,
        missingIds: loadIds.filter((id) => !loaded.has(id))
    };
}

/**
 * IDs that must be resident (working ∪ hidden). Prefer
 * `computeSparseHydrationPartition` / `planSparseHydration` when the caller
 * needs the working/hidden split.
 */
export function computeSparseHydrationSet(options: {
    seedIds: string[];
    layoutIds?: string[];
    previousWorkingIds?: string[];
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    catalog?: Array<{ glyphId: string; name: string }>;
}): string[] {
    return computeSparseHydrationPartition(options).loadIds;
}

/**
 * When every live catalog glyph body is present, replace the denormalized
 * projection with a full rebuild so reverse dependents survive sparse seed.
 */
export function writeCompleteFontDepsIfLoaded(
    depsMap: Y.Map<unknown>,
    fontJson: Record<string, unknown>
): boolean {
    const glyphs = listGlyphRecords(fontJson);
    const owned = catalogFromCoreJson(fontJson);
    if (!owned || !glyphs.length) {
        return false;
    }
    const liveIds = liveCatalogGlyphIds(owned.glyphCatalog);
    const loadedIds = new Set(
        glyphs.map((glyph) => ensureImmutableGlyphId(glyph)).filter(Boolean)
    );
    if (liveIds.some((glyphId) => !loadedIds.has(glyphId))) {
        return false;
    }
    writeFontDepsYMap(depsMap, buildFontDepsIndex(fontJson));
    return true;
}

/**
 * Catalog IDs to hydrate for a UI seed set. Empty seeds load nothing.
 * OT/layout IDs are names-or-ids already resolved by the caller.
 */
export function glyphIdsForSparseHydration(options: {
    catalogIds: string[];
    seedIds?: string[];
    layoutIds?: string[];
    previousWorkingIds?: string[];
    loadedIds?: Iterable<string>;
    edges: Record<string, Record<string, FontDepEdgeKind>>;
    catalog?: Array<{ glyphId: string; name: string }>;
}): string[] {
    return planSparseHydration({
        catalogIds: options.catalogIds,
        seedIds: options.seedIds || [],
        layoutIds: options.layoutIds,
        previousWorkingIds: options.previousWorkingIds,
        loadedIds: options.loadedIds,
        edges: options.edges,
        catalog: options.catalog
    }).loadIds;
}

const DEPS_WORKING_KEY = 'working';

export function readWorkingGlyphIds(depsMap: Y.Map<unknown>): string[] {
    const working = depsMap.get(DEPS_WORKING_KEY);
    if (!(working instanceof Y.Map) || working.size === 0) {
        return [];
    }
    const ids: string[] = [];
    working.forEach((value, glyphId) => {
        if (value === '1' && glyphId) {
            ids.push(glyphId);
        }
    });
    return ids;
}

export function writeWorkingGlyphIds(
    depsMap: Y.Map<unknown>,
    glyphIds: string[]
): void {
    replaceScalarMap(
        ensureChildMap(depsMap, DEPS_WORKING_KEY),
        Object.fromEntries(
            [...new Set(glyphIds.filter(Boolean))].map((id) => [id, '1'])
        )
    );
}

/**
 * Substitution targets of the requested seeds (`sub a by a.ss03`), not the
 * rest of the lookup (`g`, `l`, `y` in the same ss03/ss04 feature).
 */
export function layoutSubstitutionIdsFromFeatureCode(options: {
    featureCode: string;
    seedIds: string[];
    catalog: Array<{ glyphId: string; name: string }>;
}): string[] {
    return closeLayoutSubstitutionsFromFeatureCode(options);
}

/**
 * Reachability close over GSUB `sub`/`rsub` rules: 1:1 class rules,
 * multi-glyph ccmp decompositions, and init/medi/fina. A rule fires only
 * when every input slot already has a seed (no ligature-partner spill
 * from `ordn` / `sub N o period by numero`).
 */
export function closeLayoutSubstitutionsFromFeatureCode(options: {
    featureCode: string;
    seedIds: string[];
    catalog: Array<{ glyphId: string; name: string }>;
}): string[] {
    const nameToId = new Map(
        options.catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const idToName = new Map(
        options.catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const catalogNames = new Set(
        options.catalog.map((entry) => entry.name).filter(Boolean)
    );
    const seedNames = [
        ...new Set(
            options.seedIds
                .map((id) => idToName.get(id))
                .filter((name): name is string => Boolean(name))
        )
    ];
    if (!seedNames.length || !options.featureCode) {
        return [];
    }
    const closedNames = closeSubstitutionNames(
        options.featureCode,
        seedNames,
        catalogNames
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of closedNames) {
        if (seedNames.includes(name)) {
            continue;
        }
        const id = nameToId.get(name);
        if (!id || options.seedIds.includes(id) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

type SubstitutionRule = {
    inputs: string[][];
    outputs: string[][];
};

function stripFeaComments(featureCode: string): string {
    return featureCode.replace(/#[^\n]*/g, ' ');
}

function parseFeaClasses(
    featureCode: string,
    catalogNames: Set<string>
): Map<string, string[]> {
    const classes = new Map<string, string[]>();
    const pattern = /@([A-Za-z0-9._-]+)\s*=\s*\[([^\]]*)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(featureCode))) {
        const members = tokenizeFeaGlyphList(match[2], classes, catalogNames);
        classes.set(match[1], members.flat());
    }
    return classes;
}

function tokenizeFeaGlyphList(
    raw: string,
    classes: Map<string, string[]>,
    catalogNames: Set<string>
): string[][] {
    const sequence: string[][] = [];
    const tokens = raw.match(/@?[A-Za-z0-9._-]+/g) || [];
    for (let token of tokens) {
        if (token.endsWith("'")) {
            token = token.slice(0, -1);
        }
        if (token.startsWith('@')) {
            const members = classes.get(token.slice(1));
            if (members?.length) {
                sequence.push([...members]);
            }
            continue;
        }
        if (catalogNames.has(token)) {
            sequence.push([token]);
        }
    }
    return sequence;
}

function parseBracketGroups(side: string): string[] {
    const groups: string[] = [];
    let rest = side;
    while (rest.length) {
        const start = rest.indexOf('[');
        if (start < 0) {
            if (rest.trim()) {
                groups.push(rest);
            }
            break;
        }
        if (start > 0) {
            groups.push(rest.slice(0, start));
        }
        const end = rest.indexOf(']', start);
        if (end < 0) {
            groups.push(rest.slice(start));
            break;
        }
        groups.push(rest.slice(start, end + 1));
        rest = rest.slice(end + 1);
    }
    return groups;
}

function parseFeaSubstitutionSide(
    side: string,
    classes: Map<string, string[]>,
    catalogNames: Set<string>
): string[][] {
    const sequence: string[][] = [];
    for (const group of parseBracketGroups(side)) {
        const trimmed = group.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            const alts = tokenizeFeaGlyphList(
                trimmed.slice(1, -1),
                classes,
                catalogNames
            ).flat();
            if (alts.length) {
                sequence.push(alts);
            }
            continue;
        }
        sequence.push(...tokenizeFeaGlyphList(trimmed, classes, catalogNames));
    }
    return sequence;
}

function parseFeaSubstitutionRules(
    featureCode: string,
    catalogNames: Set<string>
): SubstitutionRule[] {
    const stripped = stripFeaComments(featureCode);
    const classes = parseFeaClasses(stripped, catalogNames);
    const rules: SubstitutionRule[] = [];
    const pattern =
        /(ignore\s+)?(?:reversesub|rsub|substitute|sub)\s+([^;]+);/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped))) {
        if (match[1]) {
            continue;
        }
        const clause = match[2];
        const split = clause.split(/\s+by\s+/i);
        if (split.length !== 2) {
            continue;
        }
        const inputs = parseFeaSubstitutionSide(
            split[0],
            classes,
            catalogNames
        );
        const outputs = parseFeaSubstitutionSide(
            split[1],
            classes,
            catalogNames
        );
        if (!inputs.length || !outputs.length) {
            continue;
        }
        rules.push({ inputs, outputs });
    }
    return rules;
}

function ruleOutputsForClosedSet(
    rule: SubstitutionRule,
    closed: Set<string>
): string[] {
    const triggered = rule.inputs.every((alts) =>
        alts.some((name) => closed.has(name))
    );
    if (!triggered) {
        return [];
    }
    if (
        rule.inputs.length === 1 &&
        rule.outputs.length === 1 &&
        rule.inputs[0].length === rule.outputs[0].length &&
        rule.inputs[0].length > 1
    ) {
        const added: string[] = [];
        for (let index = 0; index < rule.inputs[0].length; index++) {
            if (closed.has(rule.inputs[0][index])) {
                added.push(rule.outputs[0][index]);
            }
        }
        return added;
    }
    return rule.outputs.flat();
}

function closeSubstitutionNames(
    featureCode: string,
    seedNames: string[],
    catalogNames: Set<string>
): Set<string> {
    const closed = new Set(seedNames);
    const rules = parseFeaSubstitutionRules(featureCode, catalogNames);
    let grew = true;
    while (grew) {
        grew = false;
        for (const rule of rules) {
            const added = ruleOutputsForClosedSet(rule, closed);
            for (const name of added) {
                if (!closed.has(name) && catalogNames.has(name)) {
                    closed.add(name);
                    grew = true;
                }
            }
        }
    }
    return closed;
}

export type CloseLayoutFromFea = (
    featureCode: string,
    glyphNames: string[],
    seedNames: string[]
) => string[];

function defaultCloseLayoutFromFea(
    featureCode: string,
    glyphNames: string[],
    seedNames: string[]
): string[] {
    try {
        const wasm = require('../../wasm-dist/babelfont_fontc_web');
        if (typeof wasm.close_layout_from_fea === 'function') {
            const closed = JSON.parse(
                wasm.close_layout_from_fea(
                    featureCode,
                    JSON.stringify(glyphNames),
                    JSON.stringify(seedNames)
                )
            ) as string[];
            if (Array.isArray(closed)) {
                return closed;
            }
        }
    } catch {
        // Node tests and incomplete WASM builds fall back to the JS walker.
    }
    return [
        ...closeSubstitutionNames(featureCode, seedNames, new Set(glyphNames))
    ];
}

/**
 * close_layout(seeds) from AFDKO feature text + catalog names.
 * OT stays on the user-chosen seeds; never close_layout the reverse set.
 */
function feaBlockCode(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    const record = asRecord(value);
    if (typeof record?.code === 'string') {
        return record.code;
    }
    return '';
}

/**
 * AFDKO text from babelfont `features`. Y.Doc snapshots store
 * `features.features` as `[tag, codeString]` (see `fromYType`); on-disk JSON
 * uses `[tag, { code }]`.
 */
export function afdkoFeatureCodeFromFontJson(
    fontJson: Record<string, unknown>
): string {
    const features = fontJson.features;
    if (typeof features === 'string') {
        return features;
    }
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
        return '';
    }
    const record = features as {
        classes?: Record<string, unknown>;
        prefixes?: Record<string, unknown>;
        features?: unknown[];
    };
    const parts: string[] = [];
    for (const [className, classData] of Object.entries(record.classes || {})) {
        parts.push(`@${className} = [${feaBlockCode(classData)}];\n`);
    }
    for (const [prefixName, prefix] of Object.entries(record.prefixes || {})) {
        if (prefixName !== 'anonymous') {
            parts.push(`# Prefix: ${prefixName}\n`);
        }
        const prefixCode = feaBlockCode(prefix);
        if (prefixCode) {
            parts.push(prefixCode);
        }
        parts.push('\n');
    }
    const featureEntries = Array.isArray(record.features)
        ? record.features
        : [];
    for (const entry of featureEntries) {
        const tag = Array.isArray(entry)
            ? entry[0]
            : typeof asRecord(entry)?.tag === 'string'
              ? asRecord(entry)?.tag
              : '';
        const code = Array.isArray(entry)
            ? feaBlockCode(entry[1])
            : feaBlockCode(entry);
        if (typeof tag !== 'string' || !tag) {
            continue;
        }
        parts.push(`feature ${tag} {\n${code}\n} ${tag};\n`);
    }
    return parts.join('');
}

const LAYOUT_CLOSE_CACHE_LIMIT = 32;
const layoutCloseCache = new Map<string, string[]>();

function hashLayoutCloseKey(featureCode: string, seedNames: string[]): string {
    let hash = 2166136261;
    const key = `${featureCode.length}:${featureCode}:${seedNames.slice().sort().join('\0')}`;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function layoutGlyphIdsFromFeatureCode(options: {
    featureCode: string;
    seedIds: string[];
    catalog: Array<{ glyphId: string; name: string }>;
    closeLayoutFromFea?: CloseLayoutFromFea | null;
}): string[] {
    const nameToId = new Map(
        options.catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const idToName = new Map(
        options.catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const seedNameList = [
        ...new Set(
            options.seedIds
                .map((id) => idToName.get(id))
                .filter((name): name is string => Boolean(name))
        )
    ];
    if (!seedNameList.length || !options.featureCode) {
        return [];
    }

    const canCache = options.closeLayoutFromFea === undefined;
    const cacheKey = canCache
        ? hashLayoutCloseKey(options.featureCode, seedNameList)
        : '';
    if (canCache) {
        const hit = layoutCloseCache.get(cacheKey);
        if (hit) {
            return hit.slice();
        }
    }

    const closeLayout =
        options.closeLayoutFromFea === undefined
            ? defaultCloseLayoutFromFea
            : options.closeLayoutFromFea;
    if (!closeLayout) {
        throw new TypeError('close_layout_from_fea is required');
    }
    const closed = closeLayout(
        options.featureCode,
        [...nameToId.keys()],
        seedNameList
    );
    const closedNames = new Set(
        Array.isArray(closed)
            ? closed.filter((name) => typeof name === 'string')
            : []
    );
    const ids: string[] = [];
    for (const name of closedNames) {
        const id = nameToId.get(name);
        if (id && !options.seedIds.includes(id)) {
            ids.push(id);
        }
    }
    if (canCache) {
        layoutCloseCache.set(cacheKey, ids);
        if (layoutCloseCache.size > LAYOUT_CLOSE_CACHE_LIMIT) {
            const oldest = layoutCloseCache.keys().next().value;
            if (oldest !== undefined) {
                layoutCloseCache.delete(oldest);
            }
        }
    }
    return ids;
}

/**
 * Catalog glyph IDs encoded by `text=` characters (Unicode cmap), in first
 * appearance order. Unmapped codepoints are skipped.
 */
export function seedGlyphIdsFromText(
    fontJson: Record<string, unknown>,
    text: string
): string[] {
    if (!text) {
        return [];
    }
    const owned = catalogFromCoreJson(fontJson);
    if (!owned) {
        return [];
    }
    const liveIds = new Set(liveCatalogGlyphIds(owned.glyphCatalog));
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const codepoint of codepointsFromText(text)) {
        const members = owned.codepointIndex[String(codepoint)] || [];
        for (const glyphId of members) {
            if (!liveIds.has(glyphId) || seen.has(glyphId)) {
                continue;
            }
            seen.add(glyphId);
            ids.push(glyphId);
        }
    }
    return ids;
}

function codepointsFromText(text: string): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    const pushText = (value: string) => {
        for (const character of value) {
            const codepoint = character.codePointAt(0);
            if (codepoint === undefined || seen.has(codepoint)) {
                continue;
            }
            seen.add(codepoint);
            out.push(codepoint);
        }
    };
    pushText(text);
    pushText(text.normalize('NFC'));
    pushText(text.normalize('NFD'));
    return out;
}

export function resolveHydrationSeeds(options: {
    fontJson: Record<string, unknown>;
    text?: string;
    glyphNames?: string[];
}): { seedIds: string[]; layoutIds: string[] } {
    const catalog = catalogEntriesForDepsParse(options.fontJson);
    const nameToId = new Map(
        catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const fromText = options.text
        ? seedGlyphIdsFromText(options.fontJson, options.text)
        : [];
    const fromNames = [
        ...new Set(
            (options.glyphNames || [])
                .map((name) => nameToId.get(name))
                .filter((id): id is string => Boolean(id))
        )
    ];
    const seedIds = [...new Set([...fromText, ...fromNames])];
    if (!seedIds.length) {
        return { seedIds, layoutIds: [] };
    }
    return {
        seedIds,
        layoutIds: layoutGlyphIdsFromFeatureCode({
            featureCode: afdkoFeatureCodeFromFontJson(options.fontJson),
            seedIds,
            catalog
        })
    };
}

export function sparseHydrationSeedsFromText(
    fontJson: Record<string, unknown>,
    text: string
): { seedIds: string[]; layoutIds: string[] } {
    return resolveHydrationSeeds({ fontJson, text });
}

export function layoutSubstitutionNamesFromSeeds(options: {
    fontJson: Record<string, unknown>;
    seedNames: string[];
}): string[] {
    const catalog = catalogEntriesForDepsParse(options.fontJson);
    const nameToId = new Map(
        catalog.map((entry) => [entry.name, entry.glyphId])
    );
    const idToName = new Map(
        catalog.map((entry) => [entry.glyphId, entry.name])
    );
    const seedIds = [
        ...new Set(
            options.seedNames
                .map((name) => nameToId.get(name))
                .filter((id): id is string => Boolean(id))
        )
    ];
    if (!seedIds.length) {
        return [];
    }
    return layoutGlyphIdsFromFeatureCode({
        featureCode: afdkoFeatureCodeFromFontJson(options.fontJson),
        seedIds,
        catalog
    })
        .map((id) => idToName.get(id))
        .filter((name): name is string => Boolean(name));
}

export function seedGlyphIdsFromCoreJson(
    coreJson: Record<string, unknown>,
    preferredNames: string[] = []
): string[] {
    const owned = catalogFromCoreJson(coreJson);
    const catalog = owned ? Object.values(owned.glyphCatalog) : [];
    const nameToId = new Map<string, string>();
    const ids: string[] = [];
    for (const entry of catalog) {
        const id = entry.glyphId;
        const name = entry.name;
        if (!id) {
            continue;
        }
        ids.push(id);
        if (name) {
            nameToId.set(name, id);
        }
    }
    for (const name of preferredNames) {
        const id = nameToId.get(name);
        if (id) {
            return [id];
        }
    }
    const order = Array.isArray(coreJson.glyphOrder)
        ? coreJson.glyphOrder.map(String)
        : [];
    for (const name of order) {
        const id = nameToId.get(name);
        if (id) {
            return [id];
        }
    }
    return ids.slice(0, 1);
}

export function countYDocItems(doc: Y.Doc): number {
    let count = 0;
    doc.store.clients.forEach((structs) => {
        count += structs.length;
    });
    return count;
}

function replaceScalarMap(
    target: Y.Map<unknown>,
    next: Record<string, string>
): void {
    const nextKeys = new Set(Object.keys(next));
    for (const key of Array.from(target.keys())) {
        if (!nextKeys.has(key)) {
            target.delete(key);
        }
    }
    for (const [key, value] of Object.entries(next)) {
        if (target.get(key) !== value) {
            target.set(key, value);
        }
    }
}

function replaceNestedEdgeMaps(
    target: Y.Map<unknown>,
    next: Record<string, Record<string, FontDepEdgeKind>>
): void {
    const nextKeys = new Set(Object.keys(next));
    for (const key of Array.from(target.keys())) {
        if (!nextKeys.has(key)) {
            target.delete(key);
        }
    }
    for (const [sourceId, targets] of Object.entries(next)) {
        const sourceMap = ensureChildMap(target, sourceId);
        replaceScalarMap(sourceMap, targets);
    }
}

export function depsNeedUpdate(path: Array<string | number>): boolean {
    if (path[0] !== 'glyphs') {
        return false;
    }
    const changedField = String(path[path.length - 1] ?? '');
    // Only dependency-bearing leaves, plus whole-shape add/remove at a
    // `shapes` index. A drag, topology reorder, or plugin JSON must not
    // rebuild this glyph's dependency projection.
    if (
        changedField === 'reference' ||
        changedField === 'leftMetricsKey' ||
        changedField === 'rightMetricsKey' ||
        changedField === 'widthMetricsKey' ||
        changedField === 'metric_left' ||
        changedField === 'metric_right' ||
        changedField === 'metric_width'
    ) {
        return true;
    }
    const shapesAt = path.lastIndexOf('shapes');
    return (
        shapesAt >= 0 &&
        path.length === shapesAt + 2 &&
        /^\d+$/.test(String(path[shapesAt + 1] ?? ''))
    );
}
