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
import { flattenKerningMap } from './delete-glyphs-preflight';
import {
    geometryHasNormalizedStorage,
    getNodeIdAt,
    getShapeIdAt,
    LAYER_GEOMETRY_TOPOLOGY_KEY,
    LAYER_NODE_POSITIONS_KEY,
    LAYER_SHAPE_DATA_KEY,
    readLayerGeometry,
    layerGeometryPreviewIsStale,
    writeLayerGeometry,
    writeNodePosition
} from './layer-geometry-ydoc';
import {
    yArrayToArray,
    yMapForEach,
    yMapGet,
    yMapHas,
    yMapKeys
} from './yjs-prelim';

type Unsafe = ReturnType<typeof JSON.parse>;

// ── helpers ──────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Y.Map) &&
        !(v instanceof Y.Array) &&
        !(v instanceof Y.Doc)
    );
}

const MEMBERSHIP_ARRAY_KEYS = new Set(['codepoints']);
const MEMBERSHIP_DICT_KEYS = new Set([
    'first_kern_groups',
    'second_kern_groups',
    'codepointIndex'
]);

function writeMembershipMap(target: Y.Map<unknown>, keys: string[]): void {
    const next = new Set(keys);
    for (const key of yMapKeys(target)) {
        if (!next.has(key)) {
            target.delete(key);
        }
    }
    for (const key of next) {
        if (yMapGet(target, key) !== true) {
            target.set(key, true);
        }
    }
}

function createMembershipMap(keys: string[]): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    writeMembershipMap(map, keys);
    return map;
}

function membershipMapToArray(
    map: Y.Map<unknown>,
    numeric: boolean
): unknown[] {
    const keys = yMapKeys(map);
    if (numeric) {
        return keys
            .map((key) => Number(key))
            .filter((value) => Number.isFinite(value))
            .sort((left, right) => left - right);
    }
    return keys.sort();
}

function ensureMembershipYMap(
    parent: Y.Map<unknown>,
    key: string
): Y.Map<unknown> {
    const existing = yMapGet(parent, key);
    if (isYMap(existing)) {
        return existing;
    }
    const created = new Y.Map<unknown>();
    parent.set(key, created);
    return created;
}

function writeKernGroupsMap(
    target: Y.Map<unknown>,
    record: Record<string, unknown>
): void {
    const nextKeys = new Set(Object.keys(record));
    for (const key of yMapKeys(target)) {
        if (!nextKeys.has(key)) {
            target.delete(key);
        }
    }
    for (const [group, names] of Object.entries(record)) {
        let child = yMapGet(target, group);
        if (!isYMap(child)) {
            child = new Y.Map<unknown>();
            target.set(group, child);
        }
        writeMembershipMap(
            child as Y.Map<unknown>,
            Array.isArray(names) ? names.map(String) : []
        );
    }
}

function kernGroupsFromY(value: unknown): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (!isYMap(value)) {
        return isPlainObject(value)
            ? Object.fromEntries(
                  Object.entries(value).map(([group, names]) => [
                      group,
                      Array.isArray(names) ? names.map(String) : []
                  ])
              )
            : result;
    }
    yMapForEach(value, (groupValue, group) => {
        if (isYMap(groupValue)) {
            result[group] = membershipMapToArray(groupValue, false) as string[];
        } else if (isYArray(groupValue)) {
            result[group] = yArrayToArray(groupValue).map(String);
        }
    });
    return result;
}

function looksLikeKernGroupsMap(value: Y.Map<unknown>): boolean {
    let sawMembership = false;
    let allMembership = true;
    yMapForEach(value, (groupValue) => {
        if (!isYMap(groupValue)) {
            allMembership = false;
            return;
        }
        let childHasEntry = false;
        yMapForEach(groupValue, (item) => {
            childHasEntry = true;
            if (item !== true) {
                allMembership = false;
            }
        });
        if (childHasEntry) {
            sawMembership = true;
        }
    });
    return sawMembership && allMembership;
}

function featureEntryRecord(
    item: unknown,
    byIdMap: Y.Map<unknown>,
    usedIds: Set<string>
): Record<string, unknown> {
    const tag = Array.isArray(item)
        ? item[0]
        : isPlainObject(item)
          ? item.tag
          : undefined;
    const code = Array.isArray(item)
        ? item[1]
        : isPlainObject(item)
          ? item.code
          : undefined;
    let id = isPlainObject(item) && typeof item.id === 'string' ? item.id : '';
    if (!id) {
        yMapForEach(byIdMap, (entry, existingId) => {
            if (id || usedIds.has(existingId) || !isYMap(entry)) {
                return;
            }
            if (yMapGet(entry, 'tag') === tag) {
                id = existingId;
            }
        });
    }
    if (!id) {
        id = generateStableId();
    }
    return { id, tag, code };
}

function featureTupleField(
    map: Y.Map<unknown>,
    seg: string | number
): 'tag' | 'code' | null {
    if (!yMapHas(map, 'tag') || !yMapHas(map, 'code')) {
        return null;
    }
    if (seg === 0 || seg === 'tag') {
        return 'tag';
    }
    if (seg === 1 || seg === 'code') {
        return 'code';
    }
    return null;
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

function isNumericPathSegment(seg: string | number): boolean {
    return typeof seg === 'number'
        ? Number.isInteger(seg)
        : typeof seg === 'string' && /^\d+$/.test(seg);
}

function pathSegmentIndex(seg: string | number): number {
    return typeof seg === 'number' ? seg : Number(seg);
}

function createYContainerForNextSegment(
    nextSegment: string | number
): Y.Map<unknown> | Y.Array<unknown> {
    return isNumericPathSegment(nextSegment) ? new Y.Array() : new Y.Map();
}

function coerceNumericPath(path: (string | number)[]): (string | number)[] {
    return path.map((seg) =>
        typeof seg === 'string' && /^\d+$/.test(seg)
            ? Number.parseInt(seg, 10)
            : seg
    );
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
        writeLayerGeometry(map, layerData.shapes, toYType);
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
    const width = yMapGet(layerMap, 'width');
    if (typeof width === 'number' && Number.isFinite(width)) {
        existing.width = width;
    }
    const id = yMapGet(layerMap, 'id');
    if (typeof id === 'string' && id.length) {
        existing.id = id;
    }
    const master = yMapGet(layerMap, 'master');
    if (master !== undefined) {
        existing.master = fromYType(master);
    }
    try {
        const shapes = yMapGet(layerMap, 'shapes');
        if (shapes !== undefined) {
            existing.shapes = fromYType(shapes);
        } else if (geometryHasNormalizedStorage(layerMap)) {
            existing.shapes = readLayerGeometry(layerMap);
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
            writeLayerGeometry(layerMap, value, toYType);
        } else if (
            (key === 'anchors' || key === 'guides') &&
            Array.isArray(value)
        ) {
            applyIndexedMapArray(layerMap, key, value);
        } else {
            const existing = layerMap.get(key);
            if (isYMap(existing) && isPlainObject(value)) {
                replaceYMapContents(existing, value as Record<string, unknown>);
            } else {
                layerMap.set(key, toYType(value));
            }
        }
    }
}

/**
 * Deep-merge a flat array into the indexed-map structure (*ById+*Order)
 * on a Y.Map. Each element is deep-merged by stable id; only changed
 * elements produce Yjs operations.
 */
export function applyIndexedMapArray(
    layerMap: Y.Map<unknown>,
    arrayKey: string,
    nextArray: unknown[]
): void {
    const byIdMap = ensureIndexedMap(layerMap, arrayKey);
    if (!byIdMap) return;
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const orderArr = yMapGet(layerMap, mapping.order);
    const orderIntegrated = isYArray(orderArr) && Boolean(orderArr.doc);
    const currentOrder: string[] = orderIntegrated
        ? (orderArr.toArray() as string[])
        : [];
    const nextIds: string[] = [];
    const seenIds = new Set<string>();

    for (const item of nextArray) {
        if (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            ('Path' in item || 'Component' in item)
        ) {
            throw new TypeError(
                'Wrapped shapes are not allowed before writing to Y.Doc.'
            );
        }
        const inner =
            arrayKey === 'features'
                ? featureEntryRecord(item, byIdMap, seenIds)
                : item;
        const id = (inner as { id?: string })?.id ?? generateStableId();
        if (isPlainObject(inner)) {
            (inner as Record<string, unknown>).id = id;
        }
        nextIds.push(id);
        seenIds.add(id);

        const existing = yMapGet(byIdMap, id);
        if (isYMap(existing) && isPlainObject(inner)) {
            replaceYMapContents(existing, inner as Record<string, unknown>);
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
        if (orderIntegrated && isYArray(orderArr)) {
            // Keep stable IDs in place when an ordered collection changes.
            // A whole-array replacement turns a one-entry insertion or
            // removal into a packet containing every surviving ID.
            diffYArrayOrder(orderArr, nextIds);
        } else {
            const nextOrder = new Y.Array<unknown>();
            if (nextIds.length > 0) {
                nextOrder.insert(0, nextIds);
            }
            layerMap.set(mapping.order, nextOrder);
        }
    }
}

const YMAP_INFRASTRUCTURE_KEYS = new Set([
    'kind',
    'anchorsById',
    'anchorOrder',
    'guidesById',
    'guideOrder',
    'featuresById',
    'featureOrder',
    'shapesById',
    'shapeOrder',
    LAYER_GEOMETRY_TOPOLOGY_KEY,
    LAYER_NODE_POSITIONS_KEY,
    LAYER_SHAPE_DATA_KEY
]);

/**
 * Recursively replace a plain object into an existing Y.Map.
 * Deletes keys absent from nextRecord except Y.Doc infrastructure keys.
 */
export function replaceYMapContents(
    targetMap: Y.Map<unknown>,
    nextRecord: Record<string, unknown>
): void {
    replaceYMapContentsInternal(targetMap, nextRecord);
}

function replaceYMapContentsInternal(
    targetMap: Y.Map<unknown>,
    nextRecord: Record<string, unknown>
): void {
    const normalizedRecord = normalizeValueForYDocWrite(nextRecord) as Record<
        string,
        unknown
    >;

    const nextKeys = new Set(Object.keys(normalizedRecord));
    for (const key of yMapKeys(targetMap)) {
        if (
            !nextKeys.has(key) &&
            !YMAP_INFRASTRUCTURE_KEYS.has(key) &&
            !(RESTING_LAYER_IDENTITY_KEYS as readonly string[]).includes(key)
        ) {
            targetMap.delete(key);
        }
    }

    for (const [key, value] of Object.entries(normalizedRecord)) {
        const current = yMapGet(targetMap, key);
        if (
            (key === 'anchors' || key === 'guides' || key === 'features') &&
            Array.isArray(value)
        ) {
            applyIndexedMapArray(targetMap, key, value);
        } else if (MEMBERSHIP_ARRAY_KEYS.has(key) && Array.isArray(value)) {
            writeMembershipMap(
                ensureMembershipYMap(targetMap, key),
                value.map(String)
            );
        } else if (MEMBERSHIP_DICT_KEYS.has(key) && isPlainObject(value)) {
            writeKernGroupsMap(
                ensureMembershipYMap(targetMap, key),
                value as Record<string, unknown>
            );
        } else if (key === 'shapes' && Array.isArray(value)) {
            writeLayerGeometry(targetMap, value, toYType);
        } else if (key === 'nodes' && !Array.isArray(value)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        } else if (isYMap(current) && isPlainObject(value)) {
            replaceYMapContentsInternal(
                current,
                value as Record<string, unknown>
            );
        } else if (isYArray(current) && Array.isArray(value)) {
            diffYArray(current, value);
        } else {
            const currentVal = yMapGet(targetMap, key);
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
    if (value instanceof Y.Map || value instanceof Y.Array) {
        return toYType(fromYType(value));
    }
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

        if (
            Array.isArray(normalizedValue.features) &&
            (normalizedValue.classes !== undefined ||
                normalizedValue.prefixes !== undefined)
        ) {
            for (const [k, v] of Object.entries(normalizedValue)) {
                if (k === 'features' && Array.isArray(v)) {
                    applyIndexedMapArray(map, 'features', v);
                } else {
                    map.set(k, toYType(v));
                }
            }
            return map;
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
        } else if (gk === 'codepoints' && Array.isArray(gv)) {
            glyphMap.set('codepoints', createMembershipMap(gv.map(String)));
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
        if (key === 'glyphs' || key === 'fontDeps') {
            continue;
        }
        if (key === 'format_specific' && isPlainObject(value)) {
            const cloned = { ...value };
            delete cloned['com.counterpunch.cloud'];
            if (Object.keys(cloned).length) {
                fontMap.set(key, toYType(cloned));
            }
            continue;
        }
        if (key === 'masters' && Array.isArray(value)) {
            fontMap.set(
                key,
                toYType(
                    value.map((master) => {
                        if (!isPlainObject(master)) {
                            return master;
                        }
                        return {
                            ...master,
                            kerning: flattenKerningMap(master.kerning),
                            kerning_rtl: flattenKerningMap(master.kerning_rtl)
                        };
                    })
                )
            );
            continue;
        }
        if (MEMBERSHIP_DICT_KEYS.has(key) && isPlainObject(value)) {
            const groups = new Y.Map<unknown>();
            writeKernGroupsMap(groups, value as Record<string, unknown>);
            fontMap.set(key, groups);
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
        } else if (key === 'masters' && Array.isArray(value)) {
            fontMap.set(
                key,
                toYType(
                    value.map((master) => {
                        if (!isPlainObject(master)) {
                            return master;
                        }
                        return {
                            ...master,
                            kerning: flattenKerningMap(master.kerning),
                            kerning_rtl: flattenKerningMap(master.kerning_rtl)
                        };
                    })
                )
            );
        } else if (MEMBERSHIP_DICT_KEYS.has(key) && isPlainObject(value)) {
            const groups = new Y.Map<unknown>();
            writeKernGroupsMap(groups, value as Record<string, unknown>);
            fontMap.set(key, groups);
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
        if (key === 'codepoints' && isYMap(value)) {
            glyphJson[key] = membershipMapToArray(value, true);
        } else if (key !== 'layers' && key !== 'layerOrder') {
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

        if (yMapGet(value, 'layers') instanceof Y.Map) {
            return fromYGlyphMap(value);
        }

        if (looksLikeKernGroupsMap(value)) {
            return kernGroupsFromY(value);
        }

        // Check for indexed-map structure (any *ById key indicates a layer)
        if (
            geometryHasNormalizedStorage(value) ||
            (yMapHas(value, 'anchorsById') &&
                yMapGet(value, 'anchorsById') instanceof Y.Map) ||
            (yMapHas(value, 'guidesById') &&
                yMapGet(value, 'guidesById') instanceof Y.Map)
        ) {
            return fromYLayerMap(value);
        }

        yMapForEach(value, (v: unknown, k: string) => {
            if (k === 'featuresById' || k === 'featureOrder') {
                return;
            }
            if (MEMBERSHIP_DICT_KEYS.has(k)) {
                obj[k] = kernGroupsFromY(v);
                return;
            }
            obj[k] = fromYType(v);
        });
        if (
            yMapHas(value, 'featuresById') &&
            isYMap(yMapGet(value, 'featuresById'))
        ) {
            const byId = yMapGet(value, 'featuresById');
            const order = yMapGet(value, 'featureOrder');
            if (isYMap(byId) && isYArray(order)) {
                const features: unknown[] = [];
                for (const id of yArrayToArray(order) as string[]) {
                    const entry = yMapGet(byId, id);
                    if (entry === undefined) {
                        continue;
                    }
                    const record = fromYType(entry) as Record<string, unknown>;
                    features.push([record.tag, record.code]);
                }
                obj.features = features;
            }
        }
        return obj;
    }
    if (value instanceof Y.Array) {
        return yArrayToArray(value).map((v) => fromYType(v));
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
            k !== 'guides' &&
            k !== LAYER_GEOMETRY_TOPOLOGY_KEY &&
            k !== LAYER_NODE_POSITIONS_KEY &&
            k !== LAYER_SHAPE_DATA_KEY
        ) {
            obj[k] = fromYType(v);
        }
    });

    try {
        const normalizedShapes = geometryHasNormalizedStorage(layerMap)
            ? readLayerGeometry(layerMap)
            : null;
        if (normalizedShapes) {
            obj.shapes = normalizedShapes;
            if (layerGeometryPreviewIsStale(normalizedShapes)) {
                obj._geometryCoherent = false;
                obj._geometryPreviewStale = true;
            } else {
                obj._geometryCoherent = true;
                obj._geometryPreviewStale = false;
            }
        } else {
            const shapes = layerMap.get('shapes');
            if (shapes instanceof Y.Array) {
                obj.shapes = fromYType(shapes);
            }
        }
    } catch {
        obj._geometryCoherent = false;
        obj._geometryPreviewStale = true;
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
        } else if (MEMBERSHIP_DICT_KEYS.has(key)) {
            result[key] = kernGroupsFromY(value);
        } else if (key !== 'glyphOrder') {
            result[key] = fromYType(value);
        }
    });

    return result;
}

/**
 * Worker seed of a cloud core shard has no `glyphs` map (bodies live in
 * glyph documents). babelfont::Font still requires the field. Inject an
 * empty map into a *copy* of the update so the live CRDT is unchanged.
 */
export function ensureCoreUpdateHasGlyphsMap(update: Uint8Array): Uint8Array {
    if (!update?.byteLength) {
        return update;
    }
    const doc = new Y.Doc({ gc: false });
    try {
        Y.applyUpdate(doc, update);
        const font = doc.getMap('font');
        const glyphs = font.get('glyphs');
        if (!(glyphs instanceof Y.Map)) {
            font.set('glyphs', new Y.Map());
        }
        return Y.encodeStateAsUpdate(doc);
    } finally {
        doc.destroy();
    }
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
    path = coerceNumericPath(path);
    let current: unknown = root;
    let i = 0;

    while (i < path.length) {
        const seg = path[i];
        if (current instanceof Y.Map) {
            const segStr = String(seg);

            if (segStr === 'shapes' && geometryHasNormalizedStorage(current)) {
                try {
                    current = readLayerGeometry(current) || [];
                } catch {
                    return undefined;
                }
                i += 1;
                continue;
            }

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
                    if (
                        i >= path.length &&
                        segStr === 'features' &&
                        isYMap(current)
                    ) {
                        const record = fromYType(current) as Record<
                            string,
                            unknown
                        >;
                        return [record.tag, record.code];
                    }
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
                                const record = fromYType(entry) as Record<
                                    string,
                                    unknown
                                >;
                                if (segStr === 'features') {
                                    result.push([record.tag, record.code]);
                                } else {
                                    result.push(record);
                                }
                            }
                        }
                        return result;
                    }
                }
            }

            if (
                current.has('tag') &&
                current.has('code') &&
                (seg === 0 || seg === 1 || seg === 'tag' || seg === 'code')
            ) {
                const field = seg === 0 || seg === 'tag' ? 'tag' : 'code';
                current = current.get(field);
            } else {
                current = current.get(segStr);
            }
        } else if (current instanceof Y.Array) {
            current = current.get(Number(seg));
        } else if (Array.isArray(current)) {
            current = current[Number(seg)];
        } else if (isPlainObject(current)) {
            current = current[String(seg)];
        } else {
            return undefined;
        }
        if (current === undefined) return undefined;
        i += 1;
    }
    if (isYMap(current) && path.length > 0) {
        const last = path[path.length - 1];
        if (
            current.has('featuresById') &&
            isYMap(current.get('featuresById'))
        ) {
            return fromYType(current);
        }
        if (last === 'codepoints') {
            return membershipMapToArray(current, true);
        }
        if (MEMBERSHIP_DICT_KEYS.has(String(last))) {
            return kernGroupsFromY(current);
        }
        const parentKey = path[path.length - 2];
        if (
            MEMBERSHIP_DICT_KEYS.has(String(parentKey)) &&
            typeof last === 'string'
        ) {
            return membershipMapToArray(current, false);
        }
    }
    return current;
}

/**
 * Mapping from array key names to their indexed-map counterparts.
 * When a Y.Map has `shapesById`+`shapeOrder` instead of `shapes`, etc.
 */
const INDEXED_MAP_KEYS: Record<string, { byId: string; order: string }> = {
    anchors: { byId: 'anchorsById', order: 'anchorOrder' },
    guides: { byId: 'guidesById', order: 'guideOrder' },
    features: { byId: 'featuresById', order: 'featureOrder' }
};

export { INDEXED_MAP_KEYS };

/**
 * Replace indexed-map numeric lookups with stable ids so a concurrent
 * insert cannot retarget a committed leaf write.
 */
export function stabilizeIndexedMapPath(
    root: Y.Map<unknown>,
    path: (string | number)[]
): (string | number)[] {
    const next = [...path];
    let current: unknown = root;
    let i = 0;
    while (i < next.length && current instanceof Y.Map) {
        const seg = next[i];
        const segStr = String(seg);
        const mapping = INDEXED_MAP_KEYS[segStr];
        if (mapping && typeof next[i + 1] === 'number') {
            const order = current.get(mapping.order);
            const byId = current.get(mapping.byId);
            if (isYArray(order) && isYMap(byId)) {
                const id = order.get(next[i + 1] as number);
                if (typeof id === 'string' && byId.has(id)) {
                    next[i + 1] = id;
                    current = byId.get(id);
                    i += 2;
                    continue;
                }
            }
        }
        current = current.get(segStr);
        i += 1;
    }
    return next;
}

/**
 * Reverse mapping from *Order key to array key.
 * Used by `setYPath` to detect when a path targets an order array
 * and apply a minimal diff instead of a full replace.
 */
const ORDER_KEYS: Record<string, string> = {
    shapeOrder: 'shapes',
    anchorOrder: 'anchors',
    guideOrder: 'guides',
    featureOrder: 'features',
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

function isYMap(v: unknown): v is Y.Map<unknown> {
    return (
        !!v &&
        typeof (v as any).get === 'function' &&
        typeof (v as any).forEach === 'function' &&
        typeof (v as any).set === 'function' &&
        typeof (v as any).insert !== 'function'
    );
}

function isYArray(v: unknown): v is Y.Array<unknown> {
    return (
        !!v &&
        typeof (v as any).insert === 'function' &&
        typeof (v as any).push === 'function' &&
        typeof (v as any).toArray === 'function'
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
    let byId = yMapGet(map, mapping.byId);
    let order = yMapGet(map, mapping.order);
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

function locateLayerMap(
    root: Y.Map<unknown>,
    path: (string | number)[],
    createMissing = false
): { layerMap: Y.Map<unknown>; rest: (string | number)[] } | null {
    let current: unknown = root;
    for (let i = 0; i < path.length; i++) {
        if (!isYMap(current)) {
            return null;
        }
        if (String(path[i]) === 'layers' && i + 1 < path.length) {
            const layersMap = ensureGlyphLayersMap(current);
            const layerId = String(path[i + 1]);
            let layer = layersMap.get(layerId);
            if (!isYMap(layer)) {
                if (!createMissing) {
                    return null;
                }
                const created = new Y.Map<unknown>();
                created.set('id', layerId);
                layersMap.set(layerId, created);
                layer = created;
            }
            if (!isYMap(layer)) {
                return null;
            }
            return {
                layerMap: layer,
                rest: path.slice(i + 2)
            };
        }
        const next = current.get(String(path[i]));
        if (!isYMap(next)) {
            if (!createMissing || next !== undefined) {
                return null;
            }
            const created = new Y.Map<unknown>();
            current.set(String(path[i]), created);
            current = created;
            continue;
        }
        current = next;
    }
    return null;
}

function deleteNormalizedShapePath(
    layerMap: Y.Map<unknown>,
    rest: (string | number)[]
): boolean {
    if (rest[0] !== 'shapes' || rest.length !== 2) {
        return false;
    }
    if (!geometryHasNormalizedStorage(layerMap)) {
        return false;
    }
    const shapes = readLayerGeometry(layerMap);
    if (!shapes) {
        return false;
    }
    const shapeIndex = Number(rest[1]);
    if (
        !Number.isInteger(shapeIndex) ||
        shapeIndex < 0 ||
        shapeIndex >= shapes.length
    ) {
        return false;
    }
    shapes.splice(shapeIndex, 1);
    writeLayerGeometry(layerMap, shapes, toYType);
    return true;
}

function writeNormalizedShapePath(
    layerMap: Y.Map<unknown>,
    rest: (string | number)[],
    value: unknown
): boolean {
    if (rest[0] !== 'shapes') {
        if (rest[0] === LAYER_NODE_POSITIONS_KEY && rest.length === 2) {
            const packed = typeof value === 'string' ? value : String(value);
            let positionMap = layerMap.get(LAYER_NODE_POSITIONS_KEY);
            if (!isYMap(positionMap)) {
                positionMap = new Y.Map<unknown>();
                layerMap.set(LAYER_NODE_POSITIONS_KEY, positionMap);
            }
            if (!isYMap(positionMap)) {
                return false;
            }
            positionMap.set(String(rest[1]), packed);
            return true;
        }
        return false;
    }
    if (!geometryHasNormalizedStorage(layerMap) && rest.length > 1) {
        const shapeIndex = Number(rest[1]);
        if (!Number.isInteger(shapeIndex) || shapeIndex < 0) {
            return false;
        }
        const bootstrap: unknown[] = [];
        for (let index = 0; index <= shapeIndex; index++) {
            bootstrap.push({
                closed: true,
                nodes: [{ x: 0, y: 0, nodetype: 'Line', smooth: false }]
            });
        }
        writeLayerGeometry(layerMap, bootstrap, toYType);
    }
    if (!geometryHasNormalizedStorage(layerMap) && rest.length === 1) {
        if (Array.isArray(value)) {
            writeLayerGeometry(layerMap, value as unknown[], toYType);
            return true;
        }
        return false;
    }

    const shapes = readLayerGeometry(layerMap);
    if (!shapes) {
        if (Array.isArray(value) && rest.length === 1) {
            writeLayerGeometry(layerMap, value as unknown[], toYType);
            return true;
        }
        return false;
    }

    if (rest.length === 1) {
        if (!Array.isArray(value)) {
            throw new TypeError('Layer shapes must be an array.');
        }
        writeLayerGeometry(layerMap, value as unknown[], toYType);
        return true;
    }

    const shapeIndex = Number(rest[1]);
    if (rest.length === 2) {
        shapes[shapeIndex] = value as Record<string, unknown>;
        writeLayerGeometry(layerMap, shapes, toYType);
        return true;
    }

    if (rest[2] === 'nodes') {
        const shape = shapes[shapeIndex] as Record<string, unknown>;
        if (rest.length === 3) {
            shape.nodes = value;
            writeLayerGeometry(layerMap, shapes, toYType);
            return true;
        }
        const nodeIndex = Number(rest[3]);
        const nodes = Array.isArray(shape.nodes)
            ? (shape.nodes as Record<string, unknown>[])
            : [];
        if (rest.length === 4) {
            nodes[nodeIndex] = value as Record<string, unknown>;
            shape.nodes = nodes;
            writeLayerGeometry(layerMap, shapes, toYType);
            return true;
        }
        const property = String(rest[4]);
        if (property === 'x' || property === 'y') {
            const nodeId = getNodeIdAt(layerMap, shapeIndex, nodeIndex);
            const node = (nodes[nodeIndex] || {}) as Record<string, unknown>;
            const nextX = property === 'x' ? Number(value) : Number(node.x);
            const nextY = property === 'y' ? Number(value) : Number(node.y);
            writeNodePosition(layerMap, nodeId, nextX, nextY);
            return true;
        }
        const node = {
            ...((nodes[nodeIndex] as Record<string, unknown>) || {}),
            [property]: value
        };
        nodes[nodeIndex] = node;
        shape.nodes = nodes;
        writeLayerGeometry(layerMap, shapes, toYType);
        return true;
    }

    const shape = {
        ...((shapes[shapeIndex] as Record<string, unknown>) || {})
    };
    setDeepValue(shape, rest.slice(2), value);
    shapes[shapeIndex] = shape;
    writeLayerGeometry(layerMap, shapes, toYType);
    return true;
}

function setDeepValue(
    root: Record<string, unknown>,
    path: (string | number)[],
    value: unknown
): void {
    let cursor: unknown = root;
    for (let i = 0; i < path.length - 1; i++) {
        const key = isNumericPathSegment(path[i])
            ? pathSegmentIndex(path[i])
            : String(path[i]);
        const nextIsIndex = isNumericPathSegment(path[i + 1]);
        const parent = cursor as Record<string | number, unknown>;
        const existing = parent[key];
        if (existing == null || typeof existing !== 'object') {
            parent[key] = nextIsIndex ? [] : {};
        } else if (nextIsIndex && !Array.isArray(existing)) {
            parent[key] = [];
        }
        cursor = parent[key];
    }
    const last = path[path.length - 1];
    const lastKey = isNumericPathSegment(last)
        ? pathSegmentIndex(last)
        : String(last);
    (cursor as Record<string | number, unknown>)[lastKey] = value;
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
    path = coerceNumericPath(path);

    const located = locateLayerMap(root, path, true);
    if (
        located &&
        writeNormalizedShapePath(located.layerMap, located.rest, value)
    ) {
        return;
    }

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
                // Font.features is a container map; only the nested
                // `features.features` list is an indexed map. Do not
                // create featuresById on the font root.
                const existingById = getIndexedByIdMap(current, segStr);
                const byIdMap =
                    existingById ||
                    (segStr === 'features'
                        ? null
                        : ensureIndexedMap(current, segStr));
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

            const featureField = featureTupleField(current, seg);
            if (featureField) {
                next = current.get(featureField);
                if (next === undefined) {
                    return;
                }
                current = next;
                i += 1;
                continue;
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
        throw new TypeError(
            'Nested nodes arrays are not a Y.Doc authority. Write geometryTopology and nodePositionsById.'
        );
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
        lastSegStr === 'codepoints' &&
        Array.isArray(value)
    ) {
        writeMembershipMap(
            ensureMembershipYMap(current, 'codepoints'),
            value.map(String)
        );
        return;
    }

    if (
        current instanceof Y.Map &&
        MEMBERSHIP_DICT_KEYS.has(lastSegStr) &&
        isPlainObject(value)
    ) {
        writeKernGroupsMap(
            ensureMembershipYMap(current, lastSegStr),
            value as Record<string, unknown>
        );
        return;
    }

    if (
        current instanceof Y.Map &&
        Array.isArray(value) &&
        path.length >= 2 &&
        MEMBERSHIP_DICT_KEYS.has(String(path[path.length - 2]))
    ) {
        writeMembershipMap(
            ensureMembershipYMap(current, lastSegStr),
            value.map(String)
        );
        return;
    }

    if (
        current instanceof Y.Map &&
        typeof lastSeg === 'number' &&
        path.length >= 3 &&
        MEMBERSHIP_DICT_KEYS.has(String(path[path.length - 3]))
    ) {
        const names = membershipMapToArray(current, false).map(String);
        const next = [...names];
        if (lastSeg < next.length) {
            next[lastSeg] = String(value);
        } else if (lastSeg === next.length) {
            next.push(String(value));
        }
        writeMembershipMap(current, next);
        return;
    }

    const featureField = isYMap(current)
        ? featureTupleField(current, lastSeg)
        : null;
    if (current instanceof Y.Map && featureField) {
        const existing = current.get(featureField);
        if (isYMap(existing) && isPlainObject(value)) {
            replaceYMapContents(existing, value as Record<string, unknown>);
            return;
        }
        current.set(featureField, toYType(value));
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
        const existing = current.get(lastSegStr);
        if (isYArray(existing) && Array.isArray(value)) {
            diffYArray(existing, value);
            return;
        }
        if (isYMap(existing) && isPlainObject(value)) {
            replaceYMapContents(existing, value as Record<string, unknown>);
            return;
        }
        current.set(lastSegStr, yValue);
    } else if (current instanceof Y.Array) {
        const idx = pathSegmentIndex(lastSeg);
        if (idx === current.length) {
            current.insert(idx, [yValue]);
        } else if (idx >= 0 && idx < current.length) {
            const existing = current.get(idx);
            if (isYArray(existing) && Array.isArray(value)) {
                diffYArray(existing, value);
                return;
            }
            if (isYMap(existing) && isPlainObject(value)) {
                replaceYMapContents(existing, value as Record<string, unknown>);
                return;
            }
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
    path = coerceNumericPath(path);

    const located = locateLayerMap(root, path, false);
    if (located && deleteNormalizedShapePath(located.layerMap, located.rest)) {
        return;
    }

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
