/**
 * font-deps shard: UUID-keyed per-edge CRDT. No ranks, packed LWW rows,
 * or stored reverse graph. Glyph shards are authoritative; this is a
 * denormalized projection repaired from converged glyph bodies.
 */

import * as Y from 'yjs';
import {
    catalogFromCoreJson,
    ensureImmutableGlyphId,
    listGlyphRecords
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
            const shapeRecord = asRecord(shape);
            if (!shapeRecord) {
                continue;
            }
            const nested = asRecord(shapeRecord.Component);
            const reference =
                (typeof shapeRecord.reference === 'string' &&
                    shapeRecord.reference) ||
                (typeof nested?.reference === 'string' && nested.reference) ||
                '';
            if (reference) {
                refs.push(reference);
            }
        }
    }
    return refs;
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
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        pushKey(layerRecord.leftMetricsKey);
        pushKey(layerRecord.rightMetricsKey);
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

export function buildFontDepsIndex(
    fontJson: Record<string, unknown>
): FontDepsIndex {
    const glyphs = listGlyphRecords(fontJson);
    const idByName = new Map<string, string>();
    for (const glyph of glyphs) {
        idByName.set(String(glyph.name || ''), ensureImmutableGlyphId(glyph));
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

export function invertForwardEdges(
    edges: Record<string, Record<string, FontDepEdgeKind>>
): Record<string, string[]> {
    const reverse: Record<string, string[]> = {};
    for (const [source, targets] of Object.entries(edges)) {
        for (const target of Object.keys(targets)) {
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

/**
 * Sparse hydration working set:
 * OT(seeds) ∪ reverse*(seeds), then forward-close.
 * Do not GSUB-close the reverse set.
 */
export function computeSparseHydrationSet(options: {
    seedIds: string[];
    layoutIds?: string[];
    edges: Record<string, Record<string, FontDepEdgeKind>>;
}): string[] {
    const reverse = invertForwardEdges(options.edges);
    const reverseClosed = closeSet(options.seedIds, reverse);
    const forwardSeeds = new Set([
        ...options.seedIds,
        ...(options.layoutIds || []),
        ...reverseClosed
    ]);
    return [...closeSet([...forwardSeeds], options.edges)];
}

/**
 * Catalog IDs to hydrate for a UI seed set. Empty seeds means "all catalog".
 * OT/layout IDs are names-or-ids already resolved by the caller.
 */
export function glyphIdsForSparseHydration(options: {
    catalogIds: string[];
    seedIds?: string[];
    layoutIds?: string[];
    edges: Record<string, Record<string, FontDepEdgeKind>>;
}): string[] {
    const catalog = new Set(options.catalogIds);
    const seeds = options.seedIds?.length
        ? options.seedIds
        : options.catalogIds;
    return computeSparseHydrationSet({
        seedIds: seeds,
        layoutIds: options.layoutIds,
        edges: options.edges
    }).filter((id) => catalog.has(id));
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
    const wasm = require('../../wasm-dist/babelfont_fontc_web');
    if (typeof wasm.close_layout_from_fea !== 'function') {
        throw new TypeError('close_layout_from_fea is required');
    }
    const closed = JSON.parse(
        wasm.close_layout_from_fea(
            featureCode,
            JSON.stringify(glyphNames),
            JSON.stringify(seedNames)
        )
    ) as string[];
    if (!Array.isArray(closed)) {
        throw new TypeError('close_layout_from_fea must return a name array');
    }
    return closed;
}

/**
 * close_layout(seeds) from AFDKO feature text + catalog names.
 * OT stays on the user-chosen seeds; never close_layout the reverse set.
 */
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
    const ids: string[] = [];
    for (const name of closed) {
        const id = nameToId.get(name);
        if (id && !options.seedIds.includes(id)) {
            ids.push(id);
        }
    }
    return ids;
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
    // Only the dependency-bearing leaves can change the forward graph. A
    // drag, topology reorder, arbitrary shape data, or plugin JSON must not
    // rebuild this glyph's dependency projection.
    return (
        changedField === 'reference' ||
        changedField === 'leftMetricsKey' ||
        changedField === 'rightMetricsKey'
    );
}
