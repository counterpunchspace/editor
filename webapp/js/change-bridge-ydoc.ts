/**
 * Y.Doc ↔ JSON synchronization utilities.
 *
 * These pure-ish functions convert between the plain babelfont JSON objects
 * and Yjs shared types (Y.Map / Y.Array). They are the only place that
 * touches the Yjs API directly when reading/writing document data.
 */

import * as Y from 'yjs';
import { generateStableId } from './babelfont-model';
import {
    omitRestingLayerRuntimeKeys,
    RESTING_LAYER_IDENTITY_KEYS,
    RESTING_LAYER_RUNTIME_KEYS,
    toRestingComponentTransform,
    toRestingLayerJson
} from './resting-layer-json';

type Unsafe = ReturnType<typeof JSON.parse>;

// ── helpers ──────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeValueForYDocWrite(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return value;
    }

    const record = omitRestingLayerRuntimeKeys(
        value as Record<string, unknown>
    );

    if ('Path' in record || 'Component' in record) {
        throw new TypeError(
            'Wrapped shapes are not allowed before writing to Y.Doc.'
        );
    }

    if ('nodes' in record) {
        if (!Array.isArray(record.nodes)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        }
        return {
            ...record,
            closed: record.closed === undefined ? false : record.closed
        };
    }

    // Ensure component transforms are normalized for Y.Doc storage
    if ('reference' in record) {
        const normalizedTransform = toRestingComponentTransform(
            record.transform
        );
        const { tcenter: _tcenter, ...recordWithoutTcenter } = record;
        if (
            !isPlainObject(record.transform) ||
            JSON.stringify(record.transform) !==
                JSON.stringify(normalizedTransform) ||
            'tcenter' in record ||
            record !== (value as Record<string, unknown>)
        ) {
            return {
                ...recordWithoutTcenter,
                transform: normalizedTransform
            };
        }
    }

    return record === value ? value : record;
}

function createYContainerForNextSegment(
    nextSegment: string | number
): Y.Map<unknown> | Y.Array<unknown> {
    return typeof nextSegment === 'number' ? new Y.Array() : new Y.Map();
}

// ── JSON → Y.Doc ────────────────────────────────────────────────────

/**
 * Convert a layer object to a Y.Map.
 *
 * Shapes stay an upstream-truthful ordered array so path `nodes` remain compact
 * strings in resting Y.Doc state. Anchors and guides keep the existing indexed
 * map structure because their ids are editor/runtime metadata and this change
 * only migrates path node storage.
 */
function layerToYMap(layerData: Record<string, unknown>): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    layerData = toRestingLayerJson(layerData, {
        mode: 'delta',
        strict: true,
        context: 'Y.Doc write'
    });

    // Non-array fields: set directly via toYType
    for (const [k, v] of Object.entries(layerData)) {
        if (k === 'shapes' || k === 'anchors' || k === 'guides') {
            continue; // handled below
        }
        map.set(k, toYType(v));
    }

    if (Array.isArray(layerData.shapes)) {
        map.set('shapes', toYType(layerData.shapes));
    }

    // anchors → anchorsById + anchorOrder
    if (Array.isArray(layerData.anchors)) {
        const anchorsById = new Y.Map<unknown>();
        const anchorOrder = new Y.Array<unknown>();
        for (const anchor of layerData.anchors) {
            const anchorId = (anchor as any)?.id ?? generateStableId();
            (anchor as any).id = anchorId;
            anchorsById.set(anchorId, toYType(anchor));
            anchorOrder.push([anchorId]);
        }
        map.set('anchorsById', anchorsById);
        map.set('anchorOrder', anchorOrder);
    }

    // guides → guidesById + guideOrder
    if (Array.isArray(layerData.guides)) {
        const guidesById = new Y.Map<unknown>();
        const guideOrder = new Y.Array<unknown>();
        for (const guide of layerData.guides) {
            const guideId = (guide as any)?.id ?? generateStableId();
            (guide as any).id = guideId;
            guidesById.set(guideId, toYType(guide));
            guideOrder.push([guideId]);
        }
        map.set('guidesById', guidesById);
        map.set('guideOrder', guideOrder);
    }

    return map;
}

function restingLayerContextFromYMap(
    layerMap: Y.Map<unknown>
): Record<string, unknown> {
    const existing: Record<string, unknown> = {};
    const width = layerMap.get('width');
    if (typeof width === 'number' && Number.isFinite(width)) {
        existing.width = width;
    }
    const id = layerMap.get('id');
    if (typeof id === 'string' && id.length) {
        existing.id = id;
    }
    const master = layerMap.get('master');
    if (master !== undefined) {
        existing.master = fromYType(master);
    }
    try {
        const shapes = layerMap.get('shapes');
        if (shapes !== undefined) {
            existing.shapes = fromYType(shapes);
        }
    } catch {
        // Corrupt node storage must not block a later delta; identity is enough.
    }
    return existing;
}

/**
 * Glyph layers must be a Y.Map keyed by layer id. Whole-glyph writes that
 * go through generic `toYType` store `layers` as a Y.Array; the next
 * layer delta would otherwise replace that array with an empty map and
 * drop every other master layer.
 */
export function ensureGlyphLayersMap(glyphMap: Y.Map<unknown>): Y.Map<unknown> {
    const existing = glyphMap.get('layers');
    if (isYMap(existing)) {
        return existing;
    }

    const migratedLayers: Array<[string, Record<string, unknown>]> = [];
    if (isYArray(existing)) {
        for (const layerVal of existing.toArray()) {
            const layerJson = fromYType(layerVal);
            if (!isPlainObject(layerJson)) {
                continue;
            }
            const layerId = layerJson.id;
            if (typeof layerId === 'string' && layerId.length) {
                migratedLayers.push([layerId, layerJson]);
            }
        }
    }

    const layersMap = new Y.Map<unknown>();
    glyphMap.set('layers', layersMap);
    for (const [layerId, layerJson] of migratedLayers) {
        layersMap.set(layerId, toYType(layerJson) as Y.Map<unknown>);
    }
    return layersMap;
}

/**
 * Deep-merge a flat layer JSON into an existing layer Y.Map in a Y.Doc.
 * Keeps shapes as an atomic ordered array, while anchors and guides use
 * indexed maps. A shape is an untagged Rust enum, so retaining fields from a
 * previous shape can create an invalid hybrid representation in the worker
 * subset cache.
 * Used by the worker cache path so undo/redo and receiver refresh produce
 * granular deltas, not whole-layer replaces.
 *
 * If the layer Y.Map doesn't exist yet, creates it from the flat JSON.
 */
export function applyLayerDelta(
    fontMap: Y.Map<unknown>,
    glyphName: string,
    layerId: string,
    layerData: Record<string, unknown>
): void {
    const glyphsMap = fontMap.get('glyphs');
    const glyphMap = isYMap(glyphsMap)
        ? glyphsMap.get(glyphName)
        : fontMap.get('layers') !== undefined ||
            fontMap.get('name') === glyphName
          ? fontMap
          : null;
    if (!isYMap(glyphMap)) return;
    const layersMapTyped = ensureGlyphLayersMap(glyphMap);
    let layerMap = layersMapTyped.get(layerId);
    const existingLayerJson = isYMap(layerMap)
        ? restingLayerContextFromYMap(layerMap)
        : null;
    const sanitizedLayerData = toRestingLayerJson(layerData, {
        existing: existingLayerJson,
        mode: isYMap(layerMap) ? 'delta' : 'replace',
        context: 'Y.Doc write'
    });
    if (!isYMap(layerMap)) {
        // Layer doesn't exist — create from flat JSON
        layersMapTyped.set(layerId, layerToYMap(sanitizedLayerData));
        return;
    }

    const normalizedLayerData = normalizeValueForYDocWrite(
        sanitizedLayerData
    ) as Record<string, unknown>;

    for (const runtimeKey of RESTING_LAYER_RUNTIME_KEYS) {
        layerMap.delete(runtimeKey);
    }

    // Deep-merge each key
    for (const [key, value] of Object.entries(normalizedLayerData)) {
        if (value === null || value === undefined) {
            if (
                (RESTING_LAYER_IDENTITY_KEYS as readonly string[]).includes(key)
            ) {
                continue;
            }
            layerMap.delete(key);
        } else if (key === 'shapes' && Array.isArray(value)) {
            layerMap.set(key, toYType(value));
        } else if (
            (key === 'anchors' || key === 'guides') &&
            Array.isArray(value)
        ) {
            applyIndexedMapArray(layerMap, key, value);
        } else {
            const existing = layerMap.get(key);
            if (isYMap(existing) && isPlainObject(value)) {
                mergeYMapContents(existing, value as Record<string, unknown>);
            } else {
                layerMap.set(key, toYType(value));
            }
        }
    }
}

/**
 * Deep-merge a flat array into the indexed-map structure (*ById+*Order)
 * on a Y.Map. Each element is deep-merged by stable id; only changed
 elements produce Yjs operations.
 */
export function applyIndexedMapArray(
    layerMap: Y.Map<unknown>,
    arrayKey: string,
    nextArray: unknown[]
): void {
    const byIdMap = ensureIndexedMap(layerMap, arrayKey);
    if (!byIdMap) return;
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const orderArr = layerMap.get(mapping.order);
    if (!isYArray(orderArr)) return;

    const currentOrder: string[] = orderArr.toArray() as string[];
    const nextIds: string[] = [];
    const seenIds = new Set<string>();

    for (const item of nextArray) {
        // Reject wrapped shapes
        if (
            item &&
            typeof item === 'object' &&
            ('Path' in item || 'Component' in item)
        ) {
            throw new TypeError(
                'Wrapped shapes are not allowed before writing to Y.Doc.'
            );
        }
        const inner = item;
        const id = (inner as any)?.id ?? generateStableId();
        (inner as any).id = id;
        nextIds.push(id);
        seenIds.add(id);

        const existing = byIdMap.get(id);
        if (isYMap(existing)) {
            mergeYMapContents(existing, inner as Record<string, unknown>);
        } else {
            byIdMap.set(id, toYType(inner));
        }
    }

    // Remove ids no longer present
    for (const oldId of currentOrder) {
        if (!seenIds.has(oldId)) {
            byIdMap.delete(oldId);
        }
    }

    // Update order array if it changed
    const orderChanged =
        currentOrder.length !== nextIds.length ||
        currentOrder.some((id, idx) => id !== nextIds[idx]);
    if (orderChanged) {
        if (orderArr.length > 0) {
            orderArr.delete(0, orderArr.length);
        }
        if (nextIds.length > 0) {
            orderArr.insert(0, nextIds);
        }
    }
}

/**
 * Recursively deep-merge a plain object into an existing Y.Map.
 * Preserves nested Y.Map/Y.Array containers where possible.
 * Indexed-map aware: handles `anchors`/`guides` arrays
 * via `applyIndexedMapArray` instead of replacing the *ById structure.
 */
function mergeYMapContents(
    targetMap: Y.Map<unknown>,
    nextRecord: Record<string, unknown>
): void {
    const normalizedRecord = normalizeValueForYDocWrite(nextRecord) as Record<
        string,
        unknown
    >;

    // Additive merge: only update keys present in nextRecord.
    // Do NOT delete absent keys — the Y.Map may have infrastructure keys
    // (kind, *ById, *Order) that aren't in the flat JSON.
    for (const [key, value] of Object.entries(normalizedRecord)) {
        const current = targetMap.get(key);
        if ((key === 'anchors' || key === 'guides') && Array.isArray(value)) {
            // Indexed-map array — use applyIndexedMapArray
            applyIndexedMapArray(targetMap, key, value);
        } else if (key === 'nodes' && !Array.isArray(value)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        } else if (isYMap(current) && isPlainObject(value)) {
            mergeYMapContents(current, value as Record<string, unknown>);
        } else {
            // Only set if different (avoid spurious Yjs ops for same primitives)
            const currentVal = targetMap.get(key);
            if (currentVal !== value) {
                targetMap.set(key, toYType(value));
            }
        }
    }
}

/**
 * Convert a plain JS value into a Y.Map, Y.Array, or primitive suitable
 * for insertion into a Y.Doc.
 *
 * Babelfont-aware: Path objects store node arrays; Layer
 * objects keep glyph/layer structure while storing shapes as plain ordered
 * arrays and anchors/guides as indexed maps.
 */
export function toYType(value: unknown): unknown {
    if (Array.isArray(value)) {
        const arr = new Y.Array();
        const items = value.map(toYType);
        arr.push(items);
        return arr;
    }
    if (isPlainObject(value)) {
        const normalizedValue = normalizeValueForYDocWrite(value) as Record<
            string,
            unknown
        >;
        const map = new Y.Map();

        if ('nodetype' in normalizedValue) {
            const { id: _id, ...nodeWithoutId } = normalizedValue;
            for (const [key, item] of Object.entries(nodeWithoutId)) {
                map.set(key, toYType(item));
            }
            return map;
        }

        // Check if this is a Layer (has shapes array) → indexed-map for shapes/anchors/guides
        if (
            'shapes' in normalizedValue &&
            Array.isArray(normalizedValue.shapes)
        ) {
            return layerToYMap(normalizedValue);
        }

        for (const [k, v] of Object.entries(normalizedValue)) {
            map.set(k, toYType(v));
        }
        return map;
    }
    // primitives (string, number, boolean, null) are stored as-is
    return value;
}

/**
 * Fill a glyph Y.Map using the live editor conventions: `layers` is a Y.Map
 * keyed by layer id, `layerOrder` is the display order.
 */
export function fillGlyphYMap(
    glyphJson: Record<string, unknown>,
    glyphMap: Y.Map<unknown>
): void {
    for (const [gk, gv] of Object.entries(glyphJson)) {
        if (gk === 'layers' && Array.isArray(gv)) {
            const layersMap = new Y.Map();
            const layerOrder = new Y.Array<unknown>();
            for (const layerJson of gv as Record<string, unknown>[]) {
                const layerId = (layerJson.id as string) || crypto.randomUUID();
                layersMap.set(layerId, toYType(layerJson) as Y.Map<unknown>);
                layerOrder.push([layerId]);
            }
            glyphMap.set('layers', layersMap);
            glyphMap.set('layerOrder', layerOrder);
        } else if (
            gk === 'layers' &&
            gv &&
            typeof gv === 'object' &&
            !Array.isArray(gv)
        ) {
            const layersMap = new Y.Map();
            const layerOrder = new Y.Array<unknown>();
            for (const [layerKey, layerValue] of Object.entries(
                gv as Record<string, unknown>
            )) {
                if (
                    !layerValue ||
                    typeof layerValue !== 'object' ||
                    Array.isArray(layerValue)
                ) {
                    continue;
                }
                const layerJson = layerValue as Record<string, unknown>;
                const layerId =
                    typeof layerJson.id === 'string' && layerJson.id
                        ? layerJson.id
                        : layerKey;
                if (typeof layerJson.id !== 'string' || !layerJson.id) {
                    layerJson.id = layerId;
                }
                layersMap.set(layerId, toYType(layerJson) as Y.Map<unknown>);
                layerOrder.push([layerId]);
            }
            glyphMap.set('layers', layersMap);
            glyphMap.set('layerOrder', layerOrder);
        } else {
            glyphMap.set(gk, toYType(gv));
        }
    }
}

/**
 * Populate font-core: every non-glyph field, plus `glyphOrder`.
 * Outline bodies belong in per-glyph Y.Docs, not here.
 */
export function jsonToCoreFontMap(
    json: Record<string, unknown>,
    fontMap: Y.Map<unknown>
): void {
    const glyphNames = Array.isArray(json.glyphs)
        ? (json.glyphs as Record<string, unknown>[])
              .map((glyph) =>
                  typeof glyph?.name === 'string' ? glyph.name : ''
              )
              .filter((name) => name.length > 0)
        : json.glyphs &&
            typeof json.glyphs === 'object' &&
            !Array.isArray(json.glyphs)
          ? Object.values(json.glyphs as Record<string, unknown>)
                .map((glyph) =>
                    glyph &&
                    typeof glyph === 'object' &&
                    typeof (glyph as Record<string, unknown>).name === 'string'
                        ? String((glyph as Record<string, unknown>).name)
                        : ''
                )
                .filter((name) => name.length > 0)
          : Array.isArray(json.glyphOrder)
            ? (json.glyphOrder as unknown[]).map(String)
            : [];
    for (const [key, value] of Object.entries(json)) {
        if (key === 'glyphs') {
            continue;
        }
        fontMap.set(key, toYType(value));
    }
    const glyphOrder = new Y.Array<unknown>();
    glyphOrder.push(glyphNames);
    fontMap.set('glyphOrder', glyphOrder);
}

/**
 * Populate a Y.Map from a babelfont Font JSON object.
 *
 * Glyphs are stored as a Y.Map keyed by glyph name (not an array).
 * Within each glyph, layers are stored as a Y.Map keyed by layer id.
 * Everything else follows the normal JSON→Y.Type mapping.
 */
export function jsonToYDoc(
    json: Record<string, unknown>,
    fontMap: Y.Map<unknown>
): void {
    for (const [key, value] of Object.entries(json)) {
        if (key === 'glyphs' && Array.isArray(value)) {
            // Glyphs → Y.Map keyed by name
            const glyphsMap = new Y.Map();
            const glyphOrder = new Y.Array<unknown>();
            for (const glyphJson of value as Record<string, unknown>[]) {
                const name = glyphJson.name as string;
                const glyphMap = new Y.Map();
                fillGlyphYMap(glyphJson, glyphMap);
                glyphsMap.set(name, glyphMap);
                glyphOrder.push([name]);
            }
            fontMap.set('glyphs', glyphsMap);
            fontMap.set('glyphOrder', glyphOrder);
        } else {
            fontMap.set(key, toYType(value));
        }
    }
}

function getOrderedMapEntries(
    map: Y.Map<unknown>,
    orderValue: unknown
): Array<[string, unknown]> {
    const entries: Array<[string, unknown]> = [];
    const included = new Set<string>();

    if (orderValue instanceof Y.Array) {
        for (const value of orderValue.toArray()) {
            const id = String(value);
            const entry = map.get(id);
            if (entry !== undefined) {
                entries.push([id, entry]);
                included.add(id);
            }
        }
    }

    map.forEach((entry: unknown, id: string) => {
        if (!included.has(id)) {
            entries.push([id, entry]);
        }
    });

    return entries;
}

function fromYGlyphMap(glyphMap: Y.Map<unknown>): Record<string, unknown> {
    const glyphJson: Record<string, unknown> = {};

    glyphMap.forEach((value: unknown, key: string) => {
        if (key !== 'layers' && key !== 'layerOrder') {
            glyphJson[key] = fromYType(value);
        }
    });

    const layersMap = glyphMap.get('layers');
    if (layersMap instanceof Y.Map) {
        const layers: Record<string, unknown>[] = [];
        for (const [layerId, layerValue] of getOrderedMapEntries(
            layersMap,
            glyphMap.get('layerOrder')
        )) {
            const layerJson = fromYType(layerValue);
            const layerRecord =
                layerJson &&
                typeof layerJson === 'object' &&
                !Array.isArray(layerJson)
                    ? (layerJson as Record<string, unknown>)
                    : {};
            if (typeof layerRecord.id !== 'string' || !layerRecord.id.length) {
                layerRecord.id = layerId;
            }
            layers.push(layerRecord);
        }
        glyphJson.layers = layers;
    }

    return glyphJson;
}

// ── Y.Doc → JSON ────────────────────────────────────────────────────

/**
 * Convert a Yjs shared type back into a plain JS value.
 */
export function fromYType(value: unknown): unknown {
    if (value instanceof Y.Text) {
        throw new TypeError(
            'Y.Text values are not supported in the font Y.Doc.'
        );
    }
    if (value instanceof Y.Map) {
        const obj: Record<string, unknown> = {};

        if (value.get('layers') instanceof Y.Map) {
            return fromYGlyphMap(value);
        }

        // Check for indexed-map structure (any *ById key indicates a layer)
        if (
            (value.has('anchorsById') &&
                value.get('anchorsById') instanceof Y.Map) ||
            (value.has('guidesById') &&
                value.get('guidesById') instanceof Y.Map)
        ) {
            return fromYLayerMap(value);
        }

        value.forEach((v: unknown, k: string) => {
            obj[k] = fromYType(v);
        });
        return obj;
    }
    if (value instanceof Y.Array) {
        const arr: unknown[] = [];
        value.forEach((v: unknown) => {
            arr.push(fromYType(v));
        });
        return arr;
    }
    return value;
}

/**
 * Reverse `layerToYMap`: read a layer Y.Map back into a flat layer object with
 * ordered `shapes` plus indexed-map-backed `anchors`/`guides` arrays.
 */
function fromYLayerMap(layerMap: Y.Map<unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    // Non-indexed-map keys
    layerMap.forEach((v: unknown, k: string) => {
        if (
            k !== 'anchorsById' &&
            k !== 'anchorOrder' &&
            k !== 'guidesById' &&
            k !== 'guideOrder' &&
            k !== 'shapes' &&
            k !== 'anchors' &&
            k !== 'guides'
        ) {
            obj[k] = fromYType(v);
        }
    });

    const shapes = layerMap.get('shapes');
    if (shapes instanceof Y.Array) {
        obj.shapes = fromYType(shapes);
    }

    // anchorsById + anchorOrder → anchors array
    const anchorsById = layerMap.get('anchorsById');
    const anchorOrder = layerMap.get('anchorOrder');
    if (anchorsById instanceof Y.Map) {
        const orderedIds: string[] =
            anchorOrder instanceof Y.Array
                ? (anchorOrder.toArray() as string[])
                : [];
        const anchors: unknown[] = [];
        for (const anchorId of orderedIds) {
            const anchorVal = (anchorsById as Y.Map<unknown>).get(anchorId);
            if (anchorVal === undefined) {
                throw new Error(
                    `Indexed-map integrity error: anchorOrder references missing anchor id ${anchorId}.`
                );
            }
            const anchorObj = fromYType(anchorVal) as Record<string, unknown>;
            if (anchorObj && typeof anchorObj === 'object' && !anchorObj.id) {
                anchorObj.id = anchorId;
            }
            anchors.push(anchorObj);
        }
        obj.anchors = anchors;
    }

    // guidesById + guideOrder → guides array
    const guidesById = layerMap.get('guidesById');
    const guideOrder = layerMap.get('guideOrder');
    if (guidesById instanceof Y.Map) {
        const orderedIds: string[] =
            guideOrder instanceof Y.Array
                ? (guideOrder.toArray() as string[])
                : [];
        const guides: unknown[] = [];
        for (const guideId of orderedIds) {
            const guideVal = (guidesById as Y.Map<unknown>).get(guideId);
            if (guideVal === undefined) {
                throw new Error(
                    `Indexed-map integrity error: guideOrder references missing guide id ${guideId}.`
                );
            }
            guides.push(fromYType(guideVal));
        }
        obj.guides = guides;
    }

    return obj;
}

/**
 * Extract the full babelfont Font JSON from a Y.Doc fontMap.
 *
 * Reverses the keyed-map structure for glyphs and layers back into arrays.
 *
 * Reserved for explicit bootstrap/test snapshots. Steady-state editor,
 * cloud-save, and synchronization paths must use their scoped bridge APIs.
 */
export function yDocToJson(fontMap: Y.Map<unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    fontMap.forEach((value: unknown, key: string) => {
        if (key === 'glyphs' && value instanceof Y.Map) {
            // Glyphs Y.Map → array
            const glyphs: Record<string, unknown>[] = [];
            for (const [glyphName, glyphValue] of getOrderedMapEntries(
                value as Y.Map<unknown>,
                fontMap.get('glyphOrder')
            )) {
                if (!(glyphValue instanceof Y.Map)) {
                    continue;
                }
                const glyphJson = fromYGlyphMap(glyphValue);
                if (
                    typeof glyphJson.name !== 'string' ||
                    !glyphJson.name.length
                ) {
                    glyphJson.name = glyphName;
                }
                glyphs.push(glyphJson);
            }
            result['glyphs'] = glyphs;
        } else if (key !== 'glyphOrder') {
            result[key] = fromYType(value);
        }
    });

    return result;
}

// ── Deep path access on Y.Doc ───────────────────────────────────────

/**
 * Resolve a path through the Y.Doc tree.
 * Returns the Y.Map / Y.Array / primitive at the given path, or undefined.
 *
 * Path segments are strings (map keys) or numbers (array indices).
 */
export function getYPath(
    root: Y.Map<unknown>,
    path: (string | number)[]
): unknown {
    let current: unknown = root;
    let i = 0;

    while (i < path.length) {
        const seg = path[i];
        if (current instanceof Y.Map) {
            const segStr = String(seg);

            // Check for indexed-map structure
            if (
                typeof seg === 'string' &&
                INDEXED_MAP_KEYS[segStr] &&
                getIndexedByIdMap(current, segStr)
            ) {
                const nextSeg = path[i + 1];
                if (typeof nextSeg === 'number') {
                    current = navigateIndexedMap(current, segStr, nextSeg);
                    i += 2;
                    if (current === null || current === undefined)
                        return undefined;
                    continue;
                } else if (typeof nextSeg === 'string') {
                    const byIdMap = getIndexedByIdMap(current, segStr)!;
                    current = byIdMap.get(nextSeg);
                    i += 2;
                    if (current === undefined) return undefined;
                    continue;
                } else {
                    // Terminal indexed-map key (no next segment):
                    // reconstruct the array from *ById + *Order
                    const mapping = INDEXED_MAP_KEYS[segStr]!;
                    const byId = current.get(mapping.byId);
                    const order = current.get(mapping.order);
                    if (isYMap(byId) && isYArray(order)) {
                        const ids = order.toArray() as string[];
                        const result: unknown[] = [];
                        for (const id of ids) {
                            const entry = byId.get(id);
                            if (entry !== undefined) {
                                result.push(fromYType(entry));
                            }
                        }
                        return result;
                    }
                }
            }

            current = current.get(segStr);
        } else if (current instanceof Y.Array) {
            current = current.get(Number(seg));
        } else {
            return undefined;
        }
        if (current === undefined) return undefined;
        i += 1;
    }
    return current;
}

/**
 * Mapping from array key names to their indexed-map counterparts.
 * When a Y.Map has `shapesById`+`shapeOrder` instead of `shapes`, etc.
 */
const INDEXED_MAP_KEYS: Record<string, { byId: string; order: string }> = {
    anchors: { byId: 'anchorsById', order: 'anchorOrder' },
    guides: { byId: 'guidesById', order: 'guideOrder' }
};

export { INDEXED_MAP_KEYS };

/**
 * Reverse mapping from *Order key to array key.
 * Used by `setYPath` to detect when a path targets an order array
 * and apply a minimal diff instead of a full replace.
 */
const ORDER_KEYS: Record<string, string> = {
    shapeOrder: 'shapes',
    anchorOrder: 'anchors',
    guideOrder: 'guides',
    glyphOrder: 'glyphs',
    layerOrder: 'layers'
};

const COLLECTION_ORDER_KEYS = new Set(['glyphOrder', 'layerOrder']);

function replaceYArrayOrder(
    orderArr: Y.Array<unknown>,
    nextOrder: string[]
): void {
    if (orderArr.length > 0) {
        orderArr.delete(0, orderArr.length);
    }
    if (nextOrder.length > 0) {
        orderArr.insert(0, nextOrder);
    }
}

/**
 * Apply a minimal diff to a `Y.Array<string>` order array.
 *
 * Computes the longest common subsequence (LCS) between the current
 * and next order, then applies only the necessary delete+insert
 * operations. This keeps Yjs deltas small for reorder operations
 * (set start point, reverse direction) where only the id sequence
 * changes — zero node-data writes.
 *
 * For a 20-node contour rotation, the delta is ~N id references
 * instead of a whole-glyph snapshot.
 */
function diffYArrayOrder(
    orderArr: Y.Array<unknown>,
    nextOrder: string[]
): void {
    const currentOrder = orderArr.toArray() as string[];

    // Fast path: identical
    if (
        currentOrder.length === nextOrder.length &&
        currentOrder.every((id, idx) => id === nextOrder[idx])
    ) {
        return;
    }

    // Fast path: empty current → just insert
    if (currentOrder.length === 0) {
        if (nextOrder.length > 0) {
            orderArr.insert(0, nextOrder);
        }
        return;
    }

    // Fast path: empty next → just delete all
    if (nextOrder.length === 0) {
        orderArr.delete(0, currentOrder.length);
        return;
    }

    // Compute LCS DP table
    const m = currentOrder.length;
    const n = nextOrder.length;
    const dp: Uint16Array[] = Array.from(
        { length: m + 1 },
        () => new Uint16Array(n + 1)
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (currentOrder[i - 1] === nextOrder[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack: collect edit operations in forward order
    type EditOp =
        { type: 'keep' } | { type: 'delete' } | { type: 'insert'; id: string };
    const ops: EditOp[] = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && currentOrder[i - 1] === nextOrder[j - 1]) {
            ops.push({ type: 'keep' });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.push({ type: 'insert', id: nextOrder[j - 1] });
            j--;
        } else {
            ops.push({ type: 'delete' });
            i--;
        }
    }
    ops.reverse();

    // Apply operations using a cursor into the Y.Array.
    // - keep: advance cursor
    // - delete: delete at cursor (next element shifts down, cursor stays)
    // - insert: insert at cursor, advance cursor
    let cursor = 0;
    for (const op of ops) {
        if (op.type === 'keep') {
            cursor++;
        } else if (op.type === 'delete') {
            orderArr.delete(cursor, 1);
        } else {
            orderArr.insert(cursor, [op.id]);
            cursor++;
        }
    }
}

/**
 * Apply a minimal LCS-based diff to a generic `Y.Array`.
 *
 * Unlike `diffYArrayOrder` (which compares string ids), this function
 * compares elements by JSON serialization, making it suitable for
 * arrays of objects (e.g. `features.features` [tag, code] pairs) and
 * arrays of primitives (e.g. `codepoints` numbers, kern-group names).
 *
 * Used by `_replaceYArrayContents` to avoid full teardown+rebuild
 * when the array length changes.
 */
export function diffYArray(arr: Y.Array<unknown>, nextValues: unknown[]): void {
    const current = arr.toArray();

    // Fast path: identical
    if (
        current.length === nextValues.length &&
        current.every(
            (v, i) => JSON.stringify(v) === JSON.stringify(nextValues[i])
        )
    ) {
        return;
    }

    // Fast path: empty current
    if (current.length === 0) {
        if (nextValues.length > 0) {
            arr.insert(
                0,
                nextValues.map((v) => toYType(v))
            );
        }
        return;
    }

    // Fast path: empty next
    if (nextValues.length === 0) {
        arr.delete(0, current.length);
        return;
    }

    // Compute LCS using JSON-string comparison
    const serialize = (v: unknown) => JSON.stringify(v);
    const currentSer = current.map(serialize);
    const nextSer = nextValues.map(serialize);

    const m = currentSer.length;
    const n = nextSer.length;
    const dp: Uint16Array[] = Array.from(
        { length: m + 1 },
        () => new Uint16Array(n + 1)
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (currentSer[i - 1] === nextSer[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to collect edit operations
    type EditOp =
        | { type: 'keep' }
        | { type: 'delete' }
        | { type: 'insert'; value: unknown };
    const ops: EditOp[] = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && currentSer[i - 1] === nextSer[j - 1]) {
            ops.push({ type: 'keep' });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.push({ type: 'insert', value: nextValues[j - 1] });
            j--;
        } else {
            ops.push({ type: 'delete' });
            i--;
        }
    }
    ops.reverse();

    // Apply operations using a cursor
    let cursor = 0;
    for (const op of ops) {
        if (op.type === 'keep') {
            cursor++;
        } else if (op.type === 'delete') {
            arr.delete(cursor, 1);
        } else {
            arr.insert(cursor, [toYType(op.value)]);
            cursor++;
        }
    }
}

/** Duck-type check for Y.Map (avoids instanceof issues across module boundaries) */
function isYMap(v: unknown): v is Y.Map<unknown> {
    return (
        !!v &&
        typeof (v as any).get === 'function' &&
        typeof (v as any).forEach === 'function' &&
        typeof (v as any).set === 'function'
    );
}

/** Duck-type check for Y.Array */
function isYArray(v: unknown): v is Y.Array<unknown> {
    return (
        !!v &&
        typeof (v as any).get === 'function' &&
        typeof (v as any).length === 'number' &&
        typeof (v as any).push === 'function'
    );
}

/**
 * If `map` has an indexed-map structure for `arrayKey` (e.g. `shapesById`+
 * `shapeOrder` when `arrayKey` is `shapes`), return the `*ById` Y.Map.
 * Otherwise return null.
 */
function getIndexedByIdMap(
    map: Y.Map<unknown>,
    arrayKey: string
): Y.Map<unknown> | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) return null;
    const byId = map.get(mapping.byId);
    return isYMap(byId) ? byId : null;
}

/**
 * Ensure `map` has the indexed-map structure for `arrayKey`.
 * Creates `*ById` Y.Map and `*Order` Y.Array if they don't exist.
 * Returns the `*ById` Y.Map.
 */
function ensureIndexedMap(
    map: Y.Map<unknown>,
    arrayKey: string
): Y.Map<unknown> | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) return null;
    let byId = map.get(mapping.byId);
    let order = map.get(mapping.order);
    if (!isYMap(byId)) {
        byId = new Y.Map<unknown>();
        map.set(mapping.byId, byId);
    }
    if (!isYArray(order)) {
        order = new Y.Array<unknown>();
        map.set(mapping.order, order);
    }
    return byId as Y.Map<unknown>;
}

/**
 * If `map` has an indexed-map structure for `arrayKey`, look up the id at
 * `index` in the `*Order` Y.Array and return the corresponding Y.Map entry
 * from `*ById`. Returns null if not an indexed-map or index out of range.
 */
function navigateIndexedMap(
    map: Y.Map<unknown>,
    arrayKey: string,
    index: number
): Y.Map<unknown> | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) return null;
    const byId = map.get(mapping.byId);
    const order = map.get(mapping.order);
    if (!isYMap(byId) || !isYArray(order)) return null;
    if (index < 0 || index >= order.length) return null;
    const id = order.get(index);
    if (typeof id !== 'string') return null;
    const entry = byId.get(id);
    return isYMap(entry) ? entry : null;
}

/**
 * Set a value at a deep path in a Y.Doc tree.
 * Creates intermediate Y.Maps or Y.Arrays according to the next path segment.
 * The final segment determines where the value is written.
 *
 * Indexed-map aware: when a path segment is `shapes`/`nodes`/`anchors`/`guides`
 * and the current Y.Map has the corresponding `*ById`+`*Order` structure,
 * the next numeric segment is translated to an id via `*Order` and navigation
 * continues through `*ById`.
 */
export function setYPath(
    root: Y.Map<unknown>,
    path: (string | number)[],
    value: unknown
): void {
    if (path.length === 0) return;

    const nodesSegmentIndex = path.lastIndexOf('nodes');
    if (
        nodesSegmentIndex >= 0 &&
        nodesSegmentIndex === path.length - 3 &&
        typeof path[nodesSegmentIndex + 1] === 'number' &&
        typeof path[nodesSegmentIndex + 2] === 'string'
    ) {
        const nodesPath = path.slice(0, nodesSegmentIndex + 1);
        const nodeIndex = Number(path[nodesSegmentIndex + 1]);
        const property = String(path[nodesSegmentIndex + 2]);
        const existingNodes = getYPath(root, nodesPath);
        const nodes =
            existingNodes === undefined ? [] : fromYType(existingNodes);
        if (!Array.isArray(nodes)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        }
        while (nodes.length <= nodeIndex) {
            nodes.push({ x: 0, y: 0, nodetype: 'Line', smooth: false });
        }
        nodes[nodeIndex][property] = value;
        setYPath(root, nodesPath, nodes);
        return;
    }

    let current: unknown = root;
    let i = 0;
    // Navigate to the parent of the target
    while (i < path.length - 1) {
        const seg = path[i];
        let next: unknown;

        if (current instanceof Y.Map) {
            const segStr = String(seg);

            // Check for indexed-map keys (shapes/anchors/guides)
            // Always use the indexed-map structure for these keys,
            // creating it if it doesn't exist yet.
            if (typeof seg === 'string' && INDEXED_MAP_KEYS[segStr]) {
                // Ensure the indexed-map structure exists
                const byIdMap = ensureIndexedMap(current, segStr);
                if (byIdMap) {
                    // Next segment should be the index/id
                    const nextSeg = path[i + 1];
                    if (typeof nextSeg === 'number') {
                        // Index-based access: translate via *Order
                        next = navigateIndexedMap(current, segStr, nextSeg);
                        if (next === undefined || next === null) {
                            // Index out of range — need to create a new element.
                            const mapping = INDEXED_MAP_KEYS[segStr]!;
                            const orderArr = current.get(mapping.order);
                            if (isYArray(orderArr)) {
                                const insertIdx = Math.min(
                                    nextSeg,
                                    orderArr.length
                                );
                                // Check if this is a leaf (arrayKey+index is the last pair)
                                const isLeaf = i + 2 >= path.length;
                                if (isLeaf) {
                                    // The value IS the element being added
                                    const inner =
                                        (value as any)?.Path ??
                                        (value as any)?.Component ??
                                        value;
                                    const id =
                                        (inner as any)?.id ??
                                        generateStableId();
                                    (inner as any).id = id;
                                    byIdMap.set(id, toYType(inner));
                                    orderArr.insert(insertIdx, [id]);
                                    return; // value already written
                                } else {
                                    // Intermediate path — create an empty element
                                    // and continue navigation through it
                                    const newElement = new Y.Map<unknown>();
                                    const newId = generateStableId();
                                    byIdMap.set(newId, newElement);
                                    orderArr.insert(insertIdx, [newId]);
                                    current = newElement;
                                    i += 2;
                                    continue;
                                }
                            }
                            return;
                        }
                        current = next; // move to the found element
                        i += 2; // consume both segments
                        continue;
                    } else if (typeof nextSeg === 'string') {
                        // Id-based access: navigate directly via *ById
                        next = byIdMap.get(nextSeg);
                        if (next === undefined) {
                            return; // id not found
                        }
                        current = next;
                        i += 2;
                        continue;
                    }
                }
            }

            // Normal Y.Map navigation
            next = current.get(segStr);
            if (next === undefined) {
                const newContainer = createYContainerForNextSegment(
                    path[i + 1]
                );
                current.set(segStr, newContainer);
                next = newContainer;
            }
        } else if (current instanceof Y.Array) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx > current.length) {
                return;
            }

            next = idx < current.length ? current.get(idx) : undefined;
            if (next === undefined) {
                const newContainer = createYContainerForNextSegment(
                    path[i + 1]
                );
                if (idx === current.length) {
                    current.insert(idx, [newContainer]);
                } else {
                    current.delete(idx, 1);
                    current.insert(idx, [newContainer]);
                }
                next = newContainer;
            }
        } else {
            return; // Can't navigate further
        }
        current = next;
        i += 1;
    }

    const lastSeg = path[path.length - 1];
    const lastSegStr = String(lastSeg);

    if (current instanceof Y.Map && lastSegStr === 'nodes') {
        if (!Array.isArray(value)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        }
        current.set(lastSegStr, toYType(value));
        return;
    }

    // Special case: when setting a *Order key (shapeOrder, anchorOrder,
    // guideOrder) on a Y.Map that already has the order
    // array, apply a minimal LCS-based diff instead of replacing the
    // whole Y.Array. This is the key to granular reorder operations
    // (set start point, reverse direction) — the Yjs delta contains
    // only the changed id references, not a full array replacement.
    if (current instanceof Y.Map && lastSegStr in ORDER_KEYS) {
        const existingOrder = current.get(lastSegStr);
        if (isYArray(existingOrder)) {
            const nextIds = Array.isArray(value)
                ? (value as unknown[]).map(String)
                : [];
            if (COLLECTION_ORDER_KEYS.has(lastSegStr)) {
                replaceYArrayOrder(existingOrder, nextIds);
                return;
            }
            diffYArrayOrder(existingOrder, nextIds);
            return;
        }
        // No existing order array — create one from the value.
        // Falls through to the generic set below.
    }

    // Special case: when setting an indexed-map array key (shapes, anchors,
    // guides) as the terminal segment on a Y.Map,
    // update the *ById+*Order structure instead of setting a flat
    // key. This handles layer-level shape/anchor/guide replacements
    // and path-level node replacements that arrive as whole-array
    // set operations (e.g. from the lsb setter).
    if (
        current instanceof Y.Map &&
        INDEXED_MAP_KEYS[lastSegStr] &&
        Array.isArray(value)
    ) {
        applyIndexedMapArray(current, lastSegStr, value as unknown[]);
        return;
    }

    if (
        current instanceof Y.Map &&
        path.length === 4 &&
        path[0] === 'glyphs' &&
        path[2] === 'layers' &&
        isPlainObject(value)
    ) {
        const existingLayer = current.get(lastSegStr);
        if (isYMap(existingLayer)) {
            applyLayerDelta(
                root,
                String(path[1]),
                lastSegStr,
                value as Record<string, unknown>
            );
            return;
        }
    }

    const yValue = toYType(value);
    if (current instanceof Y.Map) {
        current.set(lastSegStr, yValue);
    } else if (current instanceof Y.Array) {
        const idx = Number(lastSeg);
        if (idx === current.length) {
            current.insert(idx, [yValue]);
        } else if (idx >= 0 && idx < current.length) {
            current.delete(idx, 1);
            current.insert(idx, [yValue]);
        }
    }
}

/**
 * Delete a key/index at a deep path in a Y.Doc tree.
 * Indexed-map aware: when the path ends with `[arrayKey, index]`
 * (e.g. `['shapes', 0]`), deletes from `*ById` + `*Order`.
 */
export function deleteYPath(
    root: Y.Map<unknown>,
    path: (string | number)[]
): void {
    if (path.length === 0) return;

    // Check if the last two segments are [indexedMapKey, index]
    if (path.length >= 2) {
        const secondLastSeg = path[path.length - 2];
        const lastSeg = path[path.length - 1];
        if (
            typeof secondLastSeg === 'string' &&
            INDEXED_MAP_KEYS[secondLastSeg] &&
            typeof lastSeg === 'number'
        ) {
            // Indexed-map deletion: find parent, get id at index, delete from *ById + *Order
            const parentPath = path.slice(0, -2);
            const parent =
                parentPath.length > 0 ? getYPath(root, parentPath) : root;
            if (parent instanceof Y.Map) {
                const mapping = INDEXED_MAP_KEYS[secondLastSeg]!;
                const byId = parent.get(mapping.byId);
                const order = parent.get(mapping.order);
                if (byId instanceof Y.Map && order instanceof Y.Array) {
                    const idx = lastSeg;
                    if (idx < 0 || idx >= order.length) return;
                    const id = order.get(idx);
                    if (typeof id === 'string') {
                        byId.delete(id);
                    }
                    order.delete(idx, 1);
                    return;
                }
                // Indexed-map structure doesn't exist (e.g. Master.guides
                // stored as flat Y.Array). Fall through to generic deletion.
            }
        }
    }

    // Terminal indexed-map key deletion: when the last segment is an
    // indexed-map key (shapes/anchors/guides) and the parent
    // Y.Map has the *ById+*Order structure, DELETE both keys so that
    // downstream readers (fromYType, _syncJsonFromYDoc) see the data
    // as absent (not empty). This preserves the merge semantics where
    // a missing Y.Doc key means "keep the existing JSON value".
    if (path.length >= 1) {
        const lastSegStr = String(path[path.length - 1]);
        if (INDEXED_MAP_KEYS[lastSegStr]) {
            const parentPath = path.slice(0, -1);
            const parent =
                parentPath.length > 0 ? getYPath(root, parentPath) : root;
            if (parent instanceof Y.Map) {
                const mapping = INDEXED_MAP_KEYS[lastSegStr]!;
                const byId = parent.get(mapping.byId);
                const order = parent.get(mapping.order);
                if (byId instanceof Y.Map && order instanceof Y.Array) {
                    parent.delete(mapping.byId);
                    parent.delete(mapping.order);
                    return;
                }
                // No indexed-map structure — fall through to generic.
            }
        }
    }

    const parent = path.length > 1 ? getYPath(root, path.slice(0, -1)) : root;
    const lastSeg = path[path.length - 1];

    if (parent instanceof Y.Map) {
        parent.delete(String(lastSeg));
    } else if (parent instanceof Y.Array) {
        const idx = Number(lastSeg);
        if (idx >= 0 && idx < parent.length) {
            parent.delete(idx, 1);
        }
    }
}

// ── Apply Y.Doc change back to plain JSON ───────────────────────────

/**
 * Set a value at a deep path in a plain JS object tree.
 * Creates intermediate objects/arrays as needed.
 */
export function setJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[],
    value: unknown
): void {
    if (path.length === 0) return;
    let current: Unsafe = root;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        if (current[seg] === undefined || current[seg] === null) {
            // Guess whether to create object or array based on next segment type
            const nextSeg = path[i + 1];
            current[seg] = typeof nextSeg === 'number' ? [] : {};
        }
        current = current[seg];
    }
    const lastSeg = path[path.length - 1];
    current[lastSeg] = value;
}

/**
 * Delete a key/index at a deep path in a plain JS object tree.
 */
export function deleteJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[]
): void {
    if (path.length === 0) return;
    let current: Unsafe = root;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        current = current[seg];
        if (current === undefined || current === null) return;
    }
    const lastSeg = path[path.length - 1];
    if (Array.isArray(current) && typeof lastSeg === 'number') {
        current.splice(lastSeg, 1);
    } else if (typeof current === 'object' && current !== null) {
        delete current[lastSeg];
    }
}

/**
 * Read a value at a deep path in a plain JS object tree.
 */
export function getJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[]
): unknown {
    let current: Unsafe = root;
    for (const seg of path) {
        if (current === undefined || current === null) return undefined;
        current = current[seg];
    }
    return current;
}
