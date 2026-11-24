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
    describeDrawingStationViolation,
    describeRestingDrawingViolation,
    omitRestingDrawingRuntimeKeys,
    RESTING_DRAWING_IDENTITY_KEYS,
    RESTING_DRAWING_RUNTIME_KEYS,
    RestingDrawingWriteError,
    toRestingComponentTransform,
    toRestingDrawingJson
} from './resting-drawing-json';
import { flattenKerningMap } from './delete-glyphs-preflight';
import { recordCollabTrace } from './collab-trace';
import {
    geometryHasNormalizedStorage,
    getNodeIdAt,
    getShapeIdAt,
    DRAWING_GEOMETRY_TOPOLOGY_KEY,
    DRAWING_NODE_POSITIONS_KEY,
    DRAWING_SHAPE_DATA_KEY,
    isYTypeNewInCurrentTransaction,
    readDrawingGeometry,
    recordLateDrawingChildMap,
    writeDrawingGeometry,
    writeNodePosition
} from './drawing-geometry-ydoc';
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
    if (tag === undefined || code === undefined) {
        // A feature without its tag or code is refused, never written as
        // an empty one.
        throw new RestingDrawingWriteError(
            `a feature written to the document has no ${tag === undefined ? 'tag' : 'code'}`,
            'Y.Doc write'
        );
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

    const record = omitRestingDrawingRuntimeKeys(
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
        // A path without a boolean closed flag is refused, never read as
        // closed or open.
        if (typeof record.closed !== 'boolean') {
            throw new TypeError('Y.Doc paths must have a boolean closed flag.');
        }
        return record === value ? value : record;
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

function coerceNumericPath(path: (string | number)[]): (string | number)[] {
    return path.map((seg) =>
        typeof seg === 'string' && /^\d+$/.test(seg)
            ? Number.parseInt(seg, 10)
            : seg
    );
}

// ── JSON → Y.Doc ────────────────────────────────────────────────────

/**
 * Convert a drawing object to a Y.Map.
 *
 * Shapes stay an upstream-truthful ordered array so path `nodes` remain compact
 * strings in resting Y.Doc state. Anchors and guides keep the existing indexed
 * map structure because their ids are editor/runtime metadata and this change
 * only migrates path node storage.
 */
export function drawingToYMap(
    drawingData: Record<string, unknown>
): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    // A drawing map is created once, from a whole drawing: it must carry
    // its own finite width, id and station link.
    drawingData = toRestingDrawingJson(drawingData, {
        context: 'Y.Doc write'
    });

    // Non-array fields: set directly via toYType
    for (const [k, v] of Object.entries(drawingData)) {
        if (
            k === 'shapes' ||
            k === 'anchors' ||
            k === 'guides' ||
            k === DRAWING_FORMAT_SPECIFIC_KEY
        ) {
            continue; // handled below
        }
        map.set(k, toYType(v));
    }

    // `format_specific` is a keyed map like the others below: it is created
    // with the drawing even when empty, so two collaborators writing its
    // first entry (such as the former-free-drawing marker) write into one
    // map instead of creating competing ones. An empty map is read back as
    // no `format_specific` (see `fromYDrawingMap`).
    map.set(
        DRAWING_FORMAT_SPECIFIC_KEY,
        formatSpecificToYMap(drawingData[DRAWING_FORMAT_SPECIFIC_KEY])
    );

    // Every keyed child map is created here, together with the drawing,
    // even when it starts empty: a map created later by the first entry
    // races a collaborator's first entry, and every entry in the map that
    // loses disappears. The geometry maps come with the topology.
    writeDrawingGeometry(
        map,
        Array.isArray(drawingData.shapes) ? drawingData.shapes : [],
        toYType
    );

    // anchors → anchorsById + anchorOrder, guides → guidesById + guideOrder
    for (const arrayKey of ['anchors', 'guides'] as const) {
        const mapping = INDEXED_MAP_KEYS[arrayKey]!;
        const byId = new Y.Map<unknown>();
        const order = new Y.Array<unknown>();
        const items = drawingData[arrayKey];
        const seenIds = new Set<string>();
        if (Array.isArray(items)) {
            for (const item of items) {
                if (!isPlainObject(item)) {
                    throw new RestingDrawingWriteError(
                        `an entry of ${arrayKey} is not a plain object`,
                        'Y.Doc write'
                    );
                }
                const itemId =
                    typeof item.id === 'string' && item.id
                        ? item.id
                        : generateStableId();
                if (seenIds.has(itemId)) {
                    // Two entries with one id would leave the order
                    // listing it twice for one entry.
                    throw new RestingDrawingWriteError(
                        `${arrayKey} entry “${itemId}” appears twice`,
                        'Y.Doc write'
                    );
                }
                seenIds.add(itemId);
                item.id = itemId;
                byId.set(itemId, toYType(item));
                order.push([itemId]);
            }
        }
        map.set(mapping.byId, byId);
        map.set(mapping.order, order);
    }

    return map;
}

/** The drawing key holding format-specific data, a keyed child map. */
export const DRAWING_FORMAT_SPECIFIC_KEY = 'format_specific';

/**
 * A new drawing's `format_specific` map. A drawing without format-specific
 * data (absent or null) gets an empty map; anything else that is not a
 * plain object is refused.
 */
function formatSpecificToYMap(value: unknown): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    if (value === undefined || value === null) {
        return map;
    }
    if (!isPlainObject(value)) {
        throw new RestingDrawingWriteError(
            'drawing format_specific is not a plain object',
            'Y.Doc write'
        );
    }
    for (const [key, entry] of Object.entries(value)) {
        map.set(key, toYType(entry));
    }
    return map;
}

/**
 * Write a stored drawing's `format_specific`. The map is created with the
 * drawing and is never deleted or replaced: absent or null empties it, and
 * a plain object replaces its entries in place. A map created again by a
 * later write would race a collaborator's, and every entry in the map that
 * loses disappears. A drawing stored before every drawing got the map gets
 * it here, and that is recorded. A value that is not a plain object, or a
 * stored `format_specific` that is not a map, is refused.
 */
export function writeDrawingFormatSpecific(
    drawingMap: Y.Map<unknown>,
    value: unknown
): void {
    const existing = yMapGet(drawingMap, DRAWING_FORMAT_SPECIFIC_KEY);
    if (existing !== undefined && !isYMap(existing)) {
        throw new MissingDrawingError(
            'The format_specific of this drawing is damaged in the document: it is not a map.'
        );
    }
    if (value === undefined || value === null) {
        if (isYMap(existing)) {
            for (const key of yMapKeys(existing)) {
                existing.delete(key);
            }
        }
        return;
    }
    if (!isPlainObject(value)) {
        throw new RestingDrawingWriteError(
            'drawing format_specific is not a plain object',
            'Y.Doc write'
        );
    }
    if (isYMap(existing)) {
        replaceYMapContents(existing, value);
        return;
    }
    recordLateDrawingChildMap(drawingMap, DRAWING_FORMAT_SPECIFIC_KEY);
    drawingMap.set(DRAWING_FORMAT_SPECIFIC_KEY, formatSpecificToYMap(value));
}

/**
 * Thrown when a write addresses a glyph or drawing that the document does
 * not hold. Nothing creates a stand-in for it: a stub drawing would carry
 * no width, station or outline, and a second container created next to a
 * collaborator's would hide theirs.
 */
export class MissingDrawingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MissingDrawingError';
    }
}

/**
 * Return a glyph's drawings map. Glyph drawings must be a Y.Map keyed by
 * drawing id, created together with the glyph (`fillGlyphYMap`,
 * `createGlyphDrawingsMap`). Any other state is refused: creating the map
 * here would race a collaborator's and hide every drawing in theirs, and a
 * Y.Array is a layout nothing may write any more.
 */
export function ensureGlyphDrawingsMap(
    glyphMap: Y.Map<unknown>
): Y.Map<unknown> {
    const existing = glyphMap.get('layers');
    if (isYMap(existing)) {
        return existing;
    }
    const glyphName = yMapGet(glyphMap, 'name');
    const label = typeof glyphName === 'string' ? ` of “${glyphName}”` : '';
    if (existing === undefined) {
        throw new MissingDrawingError(
            `The drawings${label} are missing from the document. Drawings are only created together with their glyph.`
        );
    }
    throw new MissingDrawingError(
        `The drawings${label} are not stored as a map keyed by drawing id.`
    );
}

/**
 * Create the drawings map of a glyph that is being created. Refuses when
 * the glyph already has one.
 */
export function createGlyphDrawingsMap(
    glyphMap: Y.Map<unknown>
): Y.Map<unknown> {
    if (glyphMap.get('layers') !== undefined) {
        throw new MissingDrawingError(
            'This glyph already has drawings; they are created only once, with the glyph.'
        );
    }
    const drawingsMap = new Y.Map<unknown>();
    glyphMap.set('layers', drawingsMap);
    if (glyphMap.get('layerOrder') === undefined) {
        glyphMap.set('layerOrder', new Y.Array<unknown>());
    }
    return drawingsMap;
}

/**
 * Deep-merge a flat drawing JSON into an existing drawing Y.Map in a Y.Doc.
 * Keeps shapes as an atomic ordered array, while anchors and guides use
 * indexed maps. A shape is an untagged Rust enum, so retaining fields from a
 * previous shape can create an invalid hybrid representation in the worker
 * subset cache.
 * Used by the worker cache path so undo/redo and receiver refresh produce
 * granular deltas, not whole-drawing replaces.
 *
 * If the drawing Y.Map doesn't exist yet, creates it from the flat JSON.
 */
export function applyDrawingDelta(
    fontMap: Y.Map<unknown>,
    glyphName: string,
    drawingId: string,
    drawingData: Record<string, unknown>
): void {
    const glyphsMap = fontMap.get('glyphs');
    const glyphMap = isYMap(glyphsMap)
        ? glyphsMap.get(glyphName)
        : fontMap.get('layers') !== undefined ||
            fontMap.get('name') === glyphName
          ? fontMap
          : null;
    if (!isYMap(glyphMap)) {
        throw new MissingDrawingError(
            `Glyph “${glyphName}” is missing from the document; its drawing “${drawingId}” cannot be written.`
        );
    }
    const drawingsMapTyped = ensureGlyphDrawingsMap(glyphMap);
    const drawingMap = drawingsMapTyped.get(drawingId);
    if (!isYMap(drawingMap)) {
        // A new drawing: it must be whole (drawingToYMap validates it).
        if (drawingData.id !== undefined && drawingData.id !== drawingId) {
            throw new RestingDrawingWriteError(
                `drawing id “${String(drawingData.id)}” does not match its key “${drawingId}”`,
                'Y.Doc write'
            );
        }
        drawingsMapTyped.set(drawingId, drawingToYMap(drawingData));
        return;
    }
    const sanitizedDrawingData = toRestingDrawingJson(drawingData, {
        existing: { is_background: drawingMap.get('is_background') },
        mode: 'delta',
        context: 'Y.Doc write'
    });
    if (
        sanitizedDrawingData.id !== undefined &&
        sanitizedDrawingData.id !== drawingId
    ) {
        throw new RestingDrawingWriteError(
            `drawing id “${String(sanitizedDrawingData.id)}” does not match its key “${drawingId}”`,
            'Y.Doc write'
        );
    }

    const normalizedDrawingData = normalizeValueForYDocWrite(
        sanitizedDrawingData
    ) as Record<string, unknown>;

    for (const runtimeKey of RESTING_DRAWING_RUNTIME_KEYS) {
        drawingMap.delete(runtimeKey);
    }

    // Deep-merge each key
    for (const [key, value] of Object.entries(normalizedDrawingData)) {
        if (value === null || value === undefined) {
            if (
                (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
                    key
                )
            ) {
                continue;
            }
            if (key === 'shapes') {
                writeDrawingGeometry(drawingMap, [], toYType);
                continue;
            }
            if (key === 'anchors' || key === 'guides') {
                // The keyed maps stay; only their entries go.
                applyIndexedMapArray(drawingMap, key, []);
                continue;
            }
            if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
                writeDrawingFormatSpecific(drawingMap, null);
                continue;
            }
            drawingMap.delete(key);
        } else if (key === DRAWING_FORMAT_SPECIFIC_KEY) {
            writeDrawingFormatSpecific(drawingMap, value);
        } else if (key === 'shapes' && Array.isArray(value)) {
            writeDrawingGeometry(drawingMap, value, toYType);
        } else if (
            (key === 'anchors' || key === 'guides') &&
            Array.isArray(value)
        ) {
            applyIndexedMapArray(drawingMap, key, value);
        } else {
            const existing = drawingMap.get(key);
            if (isYMap(existing) && isPlainObject(value)) {
                replaceYMapContents(existing, value as Record<string, unknown>);
            } else if (isYArray(existing) && Array.isArray(value)) {
                diffYArray(existing, value);
            } else if (existing === value) {
                // An equal value is not written again: each rewrite makes a
                // new item and deletes the old one, and a receiver that
                // misses this packet would lose the key to that deletion.
                continue;
            } else {
                drawingMap.set(key, toYType(value));
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
    drawingMap: Y.Map<unknown>,
    arrayKey: string,
    nextArray: unknown[]
): void {
    const byIdMap = ensureIndexedMap(drawingMap, arrayKey, true);
    if (!byIdMap) return;
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const orderArr = yMapGet(drawingMap, mapping.order);
    const orderIntegrated = isYArray(orderArr) && Boolean(orderArr.doc);
    if (orderIntegrated && isYArray(orderArr)) {
        tidyKeyedPairOrder(byIdMap, orderArr, arrayKey);
    }
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
        if (seenIds.has(id)) {
            throw new RestingDrawingWriteError(
                `${arrayKey} entry “${id}” appears twice in the written list`,
                'Y.Doc write'
            );
        }
        if (isPlainObject(inner)) {
            (inner as Record<string, unknown>).id = id;
        }
        nextIds.push(id);
        seenIds.add(id);

        const existing = yMapGet(byIdMap, id);
        if (existing === undefined) {
            byIdMap.set(id, toYType(inner));
        } else if (isYMap(existing) && isPlainObject(inner)) {
            // An existing entry changes field by field, never by a new
            // map: a collaborator deleting it at the same time would
            // leave the new map behind without its place in the order.
            replaceYMapContents(existing, inner as Record<string, unknown>);
        } else {
            throw new RestingDrawingWriteError(
                `${arrayKey} entry “${id}” is not a map in the document or in the written list`,
                'Y.Doc write'
            );
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
            drawingMap.set(mapping.order, nextOrder);
        }
    }
}

export const YMAP_INFRASTRUCTURE_KEYS = new Set([
    'kind',
    'anchorsById',
    'anchorOrder',
    'guidesById',
    'guideOrder',
    'featuresById',
    'featureOrder',
    DRAWING_GEOMETRY_TOPOLOGY_KEY,
    DRAWING_NODE_POSITIONS_KEY,
    DRAWING_SHAPE_DATA_KEY
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
    const targetIsDrawing = isDrawingYMap(targetMap);
    for (const key of yMapKeys(targetMap)) {
        if (
            !nextKeys.has(key) &&
            !YMAP_INFRASTRUCTURE_KEYS.has(key) &&
            !(RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(key)
        ) {
            if (targetIsDrawing && key === DRAWING_FORMAT_SPECIFIC_KEY) {
                // Emptied, never deleted (see writeDrawingFormatSpecific).
                writeDrawingFormatSpecific(targetMap, undefined);
                continue;
            }
            targetMap.delete(key);
        }
    }

    for (const [key, value] of Object.entries(normalizedRecord)) {
        if (value === undefined && key === 'code') {
            continue;
        }
        if (targetIsDrawing && key === DRAWING_FORMAT_SPECIFIC_KEY) {
            writeDrawingFormatSpecific(targetMap, value);
            continue;
        }
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
            writeDrawingGeometry(targetMap, value, toYType);
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
 * Babelfont-aware: Path objects store node arrays; Drawing
 * objects keep glyph/drawing structure while storing shapes as plain ordered
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

        // Check if this is a Drawing (has shapes array) → indexed-map for shapes/anchors/guides
        if (
            'shapes' in normalizedValue &&
            Array.isArray(normalizedValue.shapes)
        ) {
            return drawingToYMap(normalizedValue);
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
 * keyed by drawing id, `layerOrder` is the display order.
 */
export function fillGlyphYMap(
    glyphJson: Record<string, unknown>,
    glyphMap: Y.Map<unknown>
): void {
    for (const [gk, gv] of Object.entries(glyphJson)) {
        if (gk === 'layers' && Array.isArray(gv)) {
            const drawingsMap = new Y.Map();
            const drawingOrder = new Y.Array<unknown>();
            for (const drawingJson of gv as Record<string, unknown>[]) {
                const drawingId = drawingJson?.id;
                if (typeof drawingId !== 'string' || !drawingId.length) {
                    throw new RestingDrawingWriteError(
                        'drawing id is not a non-empty string',
                        'glyph creation'
                    );
                }
                drawingsMap.set(drawingId, drawingToYMap(drawingJson));
                drawingOrder.push([drawingId]);
            }
            glyphMap.set('layers', drawingsMap);
            glyphMap.set('layerOrder', drawingOrder);
        } else if (
            gk === 'layers' &&
            gv &&
            typeof gv === 'object' &&
            !Array.isArray(gv)
        ) {
            const drawingsMap = new Y.Map();
            const drawingOrder = new Y.Array<unknown>();
            for (const [drawingKey, drawingValue] of Object.entries(
                gv as Record<string, unknown>
            )) {
                if (!isPlainObject(drawingValue)) {
                    throw new RestingDrawingWriteError(
                        `drawing “${drawingKey}” is not a plain object`,
                        'glyph creation'
                    );
                }
                const drawingJson = drawingValue;
                if (drawingJson.id !== drawingKey) {
                    throw new RestingDrawingWriteError(
                        `drawing id “${String(drawingJson.id)}” does not match its key “${drawingKey}”`,
                        'glyph creation'
                    );
                }
                drawingsMap.set(drawingKey, drawingToYMap(drawingJson));
                drawingOrder.push([drawingKey]);
            }
            glyphMap.set('layers', drawingsMap);
            glyphMap.set('layerOrder', drawingOrder);
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
                    value.map((station) => {
                        if (!isPlainObject(station)) {
                            return station;
                        }
                        return {
                            ...station,
                            kerning: flattenKerningMap(station.kerning),
                            kerning_rtl: flattenKerningMap(station.kerning_rtl)
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
 * Within each glyph, drawings are stored as a Y.Map keyed by drawing id.
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
                    value.map((station) => {
                        if (!isPlainObject(station)) {
                            return station;
                        }
                        return {
                            ...station,
                            kerning: flattenKerningMap(station.kerning),
                            kerning_rtl: flattenKerningMap(station.kerning_rtl)
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

    const drawingsMap = glyphMap.get('layers');
    if (drawingsMap instanceof Y.Map) {
        const drawings: Record<string, unknown>[] = [];
        for (const [drawingId, drawingValue] of getOrderedMapEntries(
            drawingsMap,
            glyphMap.get('layerOrder')
        )) {
            const drawingJson = fromYType(drawingValue);
            if (!isPlainObject(drawingJson)) {
                throw new MissingDrawingError(
                    `Drawing “${drawingId}” is not a map in the document.`
                );
            }
            // The id is never filled in from the map key: a drawing without
            // its own id lost it, and that must surface.
            if (drawingJson.id !== drawingId) {
                throw new MissingDrawingError(
                    `Drawing “${drawingId}” has ${
                        typeof drawingJson.id === 'string' && drawingJson.id
                            ? `the id “${drawingJson.id}”`
                            : 'no id'
                    } in the document.`
                );
            }
            drawings.push(drawingJson);
        }
        glyphJson.layers = drawings;
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

        // Check for indexed-map structure (any *ById key indicates a drawing)
        if (
            geometryHasNormalizedStorage(value) ||
            (yMapHas(value, 'anchorsById') &&
                yMapGet(value, 'anchorsById') instanceof Y.Map) ||
            (yMapHas(value, 'guidesById') &&
                yMapGet(value, 'guidesById') instanceof Y.Map)
        ) {
            return fromYDrawingMap(value);
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
            if (!isYMap(byId) || !isYArray(order)) {
                // One half of the pair without the other lost the rest.
                throw new MissingDrawingError(
                    'The features are damaged in the document: featureOrder is missing or not a list.'
                );
            }
            const features: unknown[] = [];
            for (const id of readIndexedPairIds(byId, order, 'features')) {
                const entry = yMapGet(byId, id);
                if (!isYMap(entry)) {
                    throw new MissingDrawingError(
                        `The features are damaged in the document: feature ${id} is not a map.`
                    );
                }
                // A feature without its tag or code lost it; it is never
                // read as an empty one.
                for (const field of ['tag', 'code'] as const) {
                    if (yMapGet(entry, field) === undefined) {
                        throw new MissingDrawingError(
                            `The features are damaged in the document: feature ${id} has no ${field}.`
                        );
                    }
                }
                features.push([
                    fromYType(yMapGet(entry, 'tag')),
                    fromYType(yMapGet(entry, 'code'))
                ]);
            }
            obj.features = features;
        }
        if (isDrawingYMap(value)) {
            readBabelfontDrawingStation(obj);
        }
        return obj;
    }
    if (value instanceof Y.Array) {
        return yArrayToArray(value).map((v) => fromYType(v));
    }
    return value;
}

/**
 * A stored drawing without a `master` key is free-floating: Babelfont
 * leaves out its default link, FreeFloating, and documents uploaded
 * before every import wrote it explicitly hold their free drawings so (a
 * UFO `public.background` layer from a designspace, for one). This reads
 * that encoding; nothing is filled in. A `master` that is present stays
 * as it is, and readers refuse it when it is malformed.
 */
function readBabelfontDrawingStation(drawing: Record<string, unknown>): void {
    if (!('master' in drawing)) {
        drawing.master = { type: 'FreeFloating' };
    }
}

/**
 * Reverse `drawingToYMap`: read a drawing Y.Map back into a flat drawing object with
 * ordered `shapes` plus indexed-map-backed `anchors`/`guides` arrays.
 */
function fromYDrawingMap(drawingMap: Y.Map<unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    // Non-indexed-map keys
    drawingMap.forEach((v: unknown, k: string) => {
        if (
            k !== 'anchorsById' &&
            k !== 'anchorOrder' &&
            k !== 'guidesById' &&
            k !== 'guideOrder' &&
            k !== 'shapes' &&
            k !== 'anchors' &&
            k !== 'guides' &&
            k !== DRAWING_GEOMETRY_TOPOLOGY_KEY &&
            k !== DRAWING_NODE_POSITIONS_KEY &&
            k !== DRAWING_SHAPE_DATA_KEY
        ) {
            // Every drawing holds a `format_specific` map from its creation
            // so collaborators share one map (drawingToYMap). An empty map
            // is not a missing value: it is the drawing having no
            // format-specific data, which drawing JSON writes by leaving the
            // key out (Babelfont does not serialize an empty one either).
            // Reading it as `{}` would change every snapshot and export of a
            // drawing that never had any.
            if (
                k === DRAWING_FORMAT_SPECIFIC_KEY &&
                v instanceof Y.Map &&
                v.size === 0
            ) {
                return;
            }
            obj[k] = fromYType(v);
        }
    });

    const readShapesArray = (): unknown[] | undefined => {
        const shapes = drawingMap.get('shapes');
        if (shapes instanceof Y.Array) {
            return fromYType(shapes) as unknown[];
        }
        return undefined;
    };
    // Unreadable geometry throws; it is never replaced by the legacy
    // shapes array, which may be stale.
    const normalizedShapes = geometryHasNormalizedStorage(drawingMap)
        ? readDrawingGeometry(drawingMap)
        : null;
    if (normalizedShapes && normalizedShapes.length > 0) {
        obj.shapes = normalizedShapes;
    } else {
        const shapes = readShapesArray();
        if (shapes && shapes.length > 0) {
            obj.shapes = shapes;
        } else if (normalizedShapes) {
            obj.shapes = normalizedShapes;
        } else if (shapes) {
            obj.shapes = shapes;
        }
    }

    // anchorsById + anchorOrder → anchors array
    const anchorOrder = readIndexedMapOrder(drawingMap, 'anchors');
    if (anchorOrder) {
        const anchors: unknown[] = [];
        for (const anchorId of anchorOrder.ids) {
            const anchorVal = anchorOrder.byId.get(anchorId);
            if (anchorVal === undefined) {
                throw new MissingDrawingError(
                    `Indexed-map integrity error: anchorOrder references missing anchor id ${anchorId}.`
                );
            }
            const anchorObj = fromYType(anchorVal);
            // Every writer stores the anchor's id inside the anchor; one
            // without it lost it, and it is never taken from the key.
            if (!isPlainObject(anchorObj) || anchorObj.id !== anchorId) {
                throw new MissingDrawingError(
                    `Anchor “${anchorId}” has ${
                        isPlainObject(anchorObj) &&
                        typeof anchorObj.id === 'string' &&
                        anchorObj.id
                            ? `the id “${anchorObj.id}”`
                            : 'no id'
                    } in the document.`
                );
            }
            anchors.push(anchorObj);
        }
        obj.anchors = anchors;
    } else {
        const flatAnchors = readFlatDrawingList(drawingMap, 'anchors');
        if (flatAnchors) {
            obj.anchors = flatAnchors;
        }
    }

    // guidesById + guideOrder → guides array
    const guideOrder = readIndexedMapOrder(drawingMap, 'guides');
    if (guideOrder) {
        const guides: unknown[] = [];
        for (const guideId of guideOrder.ids) {
            const guideVal = guideOrder.byId.get(guideId);
            if (guideVal === undefined) {
                throw new MissingDrawingError(
                    `Indexed-map integrity error: guideOrder references missing guide id ${guideId}.`
                );
            }
            guides.push(fromYType(guideVal));
        }
        obj.guides = guides;
    } else {
        const flatGuides = readFlatDrawingList(drawingMap, 'guides');
        if (flatGuides) {
            obj.guides = flatGuides;
        }
    }

    if (isDrawingYMap(drawingMap)) {
        readBabelfontDrawingStation(obj);
    }
    return obj;
}

/**
 * The flat `anchors` or `guides` list of a drawing that has no keyed pair
 * for them: an older font worker wrote drawings that way. The list is the
 * stored value and is read as it is; skipping it would drop every entry.
 * Null when the drawing has no such list.
 */
function readFlatDrawingList(
    drawingMap: Y.Map<unknown>,
    arrayKey: 'anchors' | 'guides'
): unknown[] | null {
    const flat = drawingMap.get(arrayKey);
    if (flat === undefined) {
        return null;
    }
    if (!(flat instanceof Y.Array) && !Array.isArray(flat)) {
        throw new MissingDrawingError(
            `The ${arrayKey} are damaged in the document: the flat ${arrayKey} entry is not a list.`
        );
    }
    return fromYType(flat) as unknown[];
}

/**
 * The `*ById` map and `*Order` ids of a drawing's anchors or guides, or
 * null when the drawing has neither (a drawing stored before every drawing
 * got them). One without the other is damage and throws; a missing order
 * is never read as empty.
 */
function readIndexedMapOrder(
    drawingMap: Y.Map<unknown>,
    arrayKey: 'anchors' | 'guides'
): { byId: Y.Map<unknown>; ids: string[] } | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const byId = drawingMap.get(mapping.byId);
    const order = drawingMap.get(mapping.order);
    if (byId === undefined && order === undefined) {
        return null;
    }
    if (!(byId instanceof Y.Map) || !(order instanceof Y.Array)) {
        throw new MissingDrawingError(
            `The ${arrayKey} are damaged in the document: ${
                byId instanceof Y.Map ? mapping.order : mapping.byId
            } is missing or not a ${byId instanceof Y.Map ? 'list' : 'map'}.`
        );
    }
    return { byId, ids: readIndexedPairIds(byId, order, arrayKey) };
}

/**
 * The glyph a keyed pair belongs to, for the collab trace: the owner of
 * the pair is a drawing (its parent the drawings map, then the glyph) or
 * the font's features map, which has none.
 */
function keyedPairGlyphNames(order: Y.Array<unknown>): string[] {
    const owner = order.parent;
    const glyphMap = owner?.parent?.parent;
    const name = glyphMap instanceof Y.Map ? yMapGet(glyphMap, 'name') : null;
    return typeof name === 'string' ? [name] : [];
}

/** What reading a keyed pair found in its order. */
type KeyedPairOrder = {
    /** The ids in order: each once, each with its entry. */
    ids: string[];
    /** Ids the order lists whose entry a collaborator deleted. */
    deleted: string[];
    /** Ids the order lists more than once. */
    repeated: string[];
};

/**
 * Read a keyed pair's order against its entries.
 *
 * Two states come from normal concurrent editing and are resolved here,
 * the same way on every client:
 * - An id whose entry is gone. Moving an entry deletes its id from the
 *   order and inserts it again elsewhere (`diffYArrayOrder`), so a
 *   collaborator deleting the entry at the same time deletes only the old
 *   place; the new one remains. The delete wins: the id is skipped.
 * - An id listed twice: two collaborators moved the same entry at once.
 *   It is read once, at its first place.
 * The next write of the pair drops both (`tidyKeyedPairOrder`).
 *
 * An entry the order does not list is damage and throws. Every writer
 * adds an entry together with a new place in the order, and re-adding an
 * entry whose id the order still lists gives it a new place too
 * (`tidyKeyedPairOrder` runs first), so no interleaving of writers leaves
 * one; reading past it would hide the entry. A value that is not an id
 * throws as well.
 */
function readKeyedPairOrder(
    byId: Y.Map<unknown>,
    order: Y.Array<unknown>,
    arrayKey: string
): KeyedPairOrder {
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const entryName = arrayKey.replace(/s$/, '');
    const ids: string[] = [];
    const deleted: string[] = [];
    const repeated: string[] = [];
    const listed = new Set<string>();
    for (const id of order.toArray()) {
        if (typeof id !== 'string') {
            throw new MissingDrawingError(
                `The ${arrayKey} are damaged in the document: ${mapping.order} holds a value that is not an id.`
            );
        }
        if (listed.has(id)) {
            repeated.push(id);
            continue;
        }
        listed.add(id);
        if (yMapGet(byId, id) === undefined) {
            deleted.push(id);
            continue;
        }
        ids.push(id);
    }
    for (const id of yMapKeys(byId)) {
        if (!listed.has(id)) {
            throw new MissingDrawingError(
                `Indexed-map integrity error: ${mapping.byId} holds ${entryName} id ${id}, which ${mapping.order} does not list.`
            );
        }
    }
    return { ids, deleted, repeated };
}

/**
 * The ids of a keyed pair (`*ById` and `*Order`) in order, each once and
 * each with its entry; see `readKeyedPairOrder` for what is skipped and
 * what throws `MissingDrawingError`.
 *
 * Permanent collab trace event `keyed-pair-order-skipped`: a read skipped
 * ids whose entry a collaborator deleted (`deleted`), or repeated ids
 * (`repeated`), in the pair's order (`order`).
 */
export function readIndexedPairIds(
    byId: Y.Map<unknown>,
    order: Y.Array<unknown>,
    arrayKey: string
): string[] {
    const read = readKeyedPairOrder(byId, order, arrayKey);
    if (read.deleted.length > 0 || read.repeated.length > 0) {
        recordCollabTrace(
            'keyed-pair-order-skipped',
            keyedPairGlyphNames(order),
            {
                order: INDEXED_MAP_KEYS[arrayKey]!.order,
                deleted: read.deleted,
                repeated: read.repeated
            }
        );
    }
    return read.ids;
}

/**
 * Before a write of a keyed pair, drop from its order every id whose entry
 * is gone and every repeated id (keeping its first place), so that the
 * order lists each entry once and nothing else. A list index then means
 * the same entry in the order as in what readers return, and an entry
 * the write adds again gets a new place in the order: a collaborator
 * dropping the stale place at the same time cannot unlist it. Changes
 * nothing when the order is already clean.
 *
 * Permanent collab trace event `keyed-pair-order-tidied`: a write dropped
 * the ids `deleted` (entry gone) and the repeats `repeated` from the
 * pair's order (`order`).
 */
function tidyKeyedPairOrder(
    byId: Y.Map<unknown>,
    order: Y.Array<unknown>,
    arrayKey: string
): void {
    const read = readKeyedPairOrder(byId, order, arrayKey);
    if (read.deleted.length === 0 && read.repeated.length === 0) {
        return;
    }
    const seen = new Set<string>();
    const drop: number[] = [];
    order.toArray().forEach((id, index) => {
        const key = id as string;
        if (seen.has(key) || yMapGet(byId, key) === undefined) {
            drop.push(index);
        }
        seen.add(key);
    });
    for (let index = drop.length - 1; index >= 0; index -= 1) {
        order.delete(drop[index]!, 1);
    }
    recordCollabTrace('keyed-pair-order-tidied', keyedPairGlyphNames(order), {
        order: INDEXED_MAP_KEYS[arrayKey]!.order,
        deleted: read.deleted,
        repeated: read.repeated
    });
}

/**
 * `tidyKeyedPairOrder` for the pair `arrayKey` of `owner`, when the owner
 * holds both halves.
 */
function tidyKeyedPairOf(owner: Y.Map<unknown>, arrayKey: string): void {
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) {
        return;
    }
    const byId = owner.get(mapping.byId);
    const order = owner.get(mapping.order);
    if (isYMap(byId) && isYArray(order) && order.doc) {
        tidyKeyedPairOrder(byId, order, arrayKey);
    }
}

/**
 * The id at `index` of a keyed pair as readers list it, or undefined past
 * the end.
 */
function keyedPairIdAt(
    byId: Y.Map<unknown>,
    order: Y.Array<unknown>,
    arrayKey: string,
    index: number
): string | undefined {
    return readKeyedPairOrder(byId, order, arrayKey).ids[index];
}

/**
 * Extract the full babelfont Font JSON from a Y.Doc fontMap.
 *
 * Reverses the keyed-map structure for glyphs and drawings back into arrays.
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
                current = readDrawingGeometry(current) || [];
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
                        const result: unknown[] = [];
                        for (const id of readIndexedPairIds(
                            byId,
                            order,
                            segStr
                        )) {
                            const record = fromYType(byId.get(id)) as Record<
                                string,
                                unknown
                            >;
                            if (segStr === 'features') {
                                result.push([record.tag, record.code]);
                            } else {
                                result.push(record);
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
                const id = keyedPairIdAt(
                    byId,
                    order,
                    segStr,
                    next[i + 1] as number
                );
                if (id !== undefined) {
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
    arrayKey: string,
    replacesWholeList = false
): Y.Map<unknown> | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) return null;
    const byId = yMapGet(map, mapping.byId);
    const order = yMapGet(map, mapping.order);
    if (isYMap(byId) && isYArray(order)) {
        return byId;
    }
    if (byId !== undefined || order !== undefined) {
        // One half without the other lost the rest; it is not rebuilt.
        throw new MissingDrawingError(
            `The ${arrayKey} are damaged in the document: ${
                isYMap(byId) ? mapping.order : mapping.byId
            } is missing or not a ${isYMap(byId) ? 'list' : 'map'}.`
        );
    }
    const inDrawing =
        (arrayKey === 'anchors' || arrayKey === 'guides') && isDrawingYMap(map);
    if (inDrawing) {
        // A drawing written by an older font worker stores its anchors or
        // guides as a flat list, and readers take that list while the
        // drawing has no keyed pair. A pair created next to it would hide
        // every entry in it, so only a write of the whole list (which
        // supersedes the flat one) may create the pair, and the flat list
        // goes in the same transaction.
        if (yMapGet(map, arrayKey) !== undefined) {
            if (!replacesWholeList) {
                throw new MissingDrawingError(
                    `The ${arrayKey} of this drawing are stored as a flat list; only a write of the whole list may change them.`
                );
            }
            map.delete(arrayKey);
        }
        // Drawings get both maps when they are created (drawingToYMap). A
        // drawing stored before that, or written by the font worker, gets
        // them on its first entry; two collaborators doing that at once
        // create competing maps, so it is recorded.
        recordLateDrawingChildMap(map, mapping.byId);
    }
    const createdById = new Y.Map<unknown>();
    map.set(mapping.byId, createdById);
    map.set(mapping.order, new Y.Array<unknown>());
    return createdById;
}

/**
 * Whether a map is a drawing: an entry of a glyph's `layers` map.
 */
function isDrawingYMap(map: Y.Map<unknown>): boolean {
    const parent = map.parent;
    return parent instanceof Y.Map && parent._item?.parentSub === 'layers';
}

/**
 * The anchors or guides a drawing key belongs to, for each half of their
 * keyed pair.
 */
const DRAWING_INDEXED_PAIR_KEYS: Readonly<
    Record<string, 'anchors' | 'guides'>
> = {
    anchorsById: 'anchors',
    anchorOrder: 'anchors',
    guidesById: 'guides',
    guideOrder: 'guides'
};

/**
 * The list a `*ById` map holds the entries of (`anchors`, `guides`,
 * `features`), or null when `map` is not the `*ById` half of a keyed pair.
 */
function indexedPairOfByIdMap(map: Y.Map<unknown>): string | null {
    const key = map._item?.parentSub;
    if (typeof key !== 'string' || !(map.parent instanceof Y.Map)) {
        return null;
    }
    for (const [arrayKey, mapping] of Object.entries(INDEXED_MAP_KEYS)) {
        if (mapping.byId === key) {
            return arrayKey;
        }
    }
    return null;
}

/**
 * A write of a keyed pair's order alone may only reorder the ids it holds:
 * an id it adds would have no entry, and an id it drops would leave an
 * entry the order does not list. Entries are added and removed through
 * the list path, which changes both halves.
 */
function assertOrderWriteOnlyReorders(
    owner: Y.Map<unknown>,
    orderKey: string,
    nextIds: string[]
): void {
    const arrayKey = ORDER_KEYS[orderKey]!;
    const mapping = INDEXED_MAP_KEYS[arrayKey];
    if (!mapping) {
        return;
    }
    const byId = yMapGet(owner, mapping.byId);
    if (!isYMap(byId)) {
        throw new MissingDrawingError(
            `The ${arrayKey} are damaged in the document: ${mapping.byId} is missing or not a map.`
        );
    }
    const stored = new Set(yMapKeys(byId));
    const next = new Set(nextIds);
    const added = [...next].filter((id) => !stored.has(id));
    const dropped = [...stored].filter((id) => !next.has(id));
    if (added.length || dropped.length) {
        throw new MissingDrawingError(
            `Cannot write ${orderKey}: an order write may only reorder the ${arrayKey} (${
                added.length ? `adds ${added.join(', ')}` : ''
            }${added.length && dropped.length ? '; ' : ''}${
                dropped.length ? `drops ${dropped.join(', ')}` : ''
            }).`
        );
    }
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
    if (index < 0) return null;
    const id = keyedPairIdAt(byId, order, arrayKey, index);
    if (id === undefined) return null;
    const entry = byId.get(id);
    return isYMap(entry) ? entry : null;
}

/**
 * The entry at `index` of a keyed pair, or null when the index is past the
 * end of the order (a write there adds an entry). An id the order lists
 * without its entry is damage and throws; it is never read as a free slot.
 */
function indexedEntryAt(
    map: Y.Map<unknown>,
    arrayKey: string,
    index: number,
    path: (string | number)[]
): Y.Map<unknown> | null {
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const byId = map.get(mapping.byId);
    const order = map.get(mapping.order);
    if (!isYMap(byId) || !isYArray(order)) {
        throw new MissingDrawingError(
            `Cannot write ${path.join('.')}: the ${arrayKey} are damaged in the document.`
        );
    }
    if (!Number.isInteger(index) || index < 0) {
        throw new MissingDrawingError(
            `Cannot write ${path.join('.')}: ${index} is not an entry of ${arrayKey}.`
        );
    }
    if (index >= order.length) {
        return null;
    }
    const id = order.get(index);
    const entry = typeof id === 'string' ? byId.get(id) : undefined;
    if (!isYMap(entry)) {
        throw new MissingDrawingError(
            `The ${arrayKey} are damaged in the document: ${mapping.order} lists ${String(id)} at ${index}, and ${mapping.byId} holds no entry for it.`
        );
    }
    return entry;
}

/**
 * The fields of a whole anchor, guide or feature written to an existing
 * entry whose id is `id`. A feature may come as its `[tag, code]` pair;
 * its id is the entry's. An anchor or guide carries its own id.
 */
function indexedEntryFields(
    arrayKey: string,
    id: string,
    value: unknown,
    path: (string | number)[]
): Record<string, unknown> {
    if (arrayKey === 'features') {
        const tag = Array.isArray(value)
            ? value[0]
            : isPlainObject(value)
              ? value.tag
              : undefined;
        const code = Array.isArray(value)
            ? value[1]
            : isPlainObject(value)
              ? value.code
              : undefined;
        if (tag === undefined || code === undefined) {
            throw new RestingDrawingWriteError(
                `the feature written to ${path.join('.')} has no ${tag === undefined ? 'tag' : 'code'}`,
                'Y.Doc write'
            );
        }
        if (isPlainObject(value) && value.id !== undefined && value.id !== id) {
            throw new RestingDrawingWriteError(
                `the feature written to ${path.join('.')} has id “${String(value.id)}”, not “${id}”`,
                'Y.Doc write'
            );
        }
        return { id, tag, code };
    }
    if (!isPlainObject(value) || value.id !== id) {
        throw new RestingDrawingWriteError(
            `${arrayKey} entry “${id}” must be written as a map whose id is “${id}”`,
            'Y.Doc write'
        );
    }
    return value;
}

/**
 * A whole entry added past the end of a keyed pair. A feature may come as
 * its `[tag, code]` pair and must carry both. An anchor or guide must
 * carry its own id, and an id the pair already holds is refused: adding it
 * again would list one entry twice in the order.
 */
function indexedEntryToAdd(
    arrayKey: string,
    byIdMap: Y.Map<unknown>,
    value: unknown,
    path: (string | number)[]
): Record<string, unknown> & { id: string } {
    if (arrayKey === 'features') {
        // A new feature keeps an id it carries; it is never matched to an
        // existing entry by its tag.
        const record = featureEntryRecord(
            value,
            new Y.Map<unknown>(),
            new Set()
        );
        const id = String(record.id);
        if (byIdMap.get(id) !== undefined) {
            throw new MissingDrawingError(
                `Cannot write ${path.join('.')}: features entry “${id}” is already in the list.`
            );
        }
        return { ...record, id };
    }
    const wrapped = isPlainObject(value)
        ? (value.Path ?? value.Component)
        : undefined;
    const inner = wrapped ?? value;
    if (!isPlainObject(inner)) {
        throw new RestingDrawingWriteError(
            `the ${arrayKey} entry written to ${path.join('.')} is not a map`,
            'Y.Doc write'
        );
    }
    const id = typeof inner.id === 'string' && inner.id ? inner.id : undefined;
    if (id === undefined) {
        if (arrayKey === 'anchors' || arrayKey === 'guides') {
            throw new RestingDrawingWriteError(
                `the ${arrayKey} entry written to ${path.join('.')} has no id`,
                'Y.Doc write'
            );
        }
        const generated = generateStableId();
        inner.id = generated;
        return { ...inner, id: generated };
    }
    if (byIdMap.get(id) !== undefined) {
        throw new MissingDrawingError(
            `Cannot write ${path.join('.')}: ${arrayKey} entry “${id}” is already in the list.`
        );
    }
    return { ...inner, id };
}

/**
 * Write a whole anchor, guide or feature to its existing entry. The
 * entry's fields change inside its map; the map is never replaced, so a
 * collaborator deleting the entry at the same time deletes it with its
 * place in the order, and no entry is left that the order does not list.
 */
function writeIndexedEntryInPlace(
    entry: Y.Map<unknown>,
    arrayKey: string,
    id: string,
    value: unknown,
    path: (string | number)[]
): void {
    replaceYMapContents(entry, indexedEntryFields(arrayKey, id, value, path));
}

/**
 * A whole anchor, guide or feature written at an index the order holds.
 * The same id there edits that entry in place. An id the pair does not
 * hold yet is a new entry inserted at that index, with its id in the
 * order (an add replayed by undo or redo). An anchor or guide without an
 * id, or one whose id sits elsewhere in the list, is refused: the write
 * does not say which entry it means.
 */
function writeIndexedEntryAtIndex(
    map: Y.Map<unknown>,
    arrayKey: string,
    index: number,
    entry: Y.Map<unknown>,
    value: unknown,
    path: (string | number)[]
): void {
    const mapping = INDEXED_MAP_KEYS[arrayKey]!;
    const byId = map.get(mapping.byId) as Y.Map<unknown>;
    const order = map.get(mapping.order) as Y.Array<unknown>;
    const storedId = order.get(index) as string;
    const nextId =
        isPlainObject(value) && typeof value.id === 'string'
            ? value.id
            : undefined;
    if (nextId === undefined || nextId === storedId) {
        if (nextId === undefined && arrayKey !== 'features') {
            throw new RestingDrawingWriteError(
                `the ${arrayKey} entry written to ${path.join('.')} has no id`,
                'Y.Doc write'
            );
        }
        writeIndexedEntryInPlace(entry, arrayKey, storedId, value, path);
        return;
    }
    if (byId.get(nextId) !== undefined) {
        throw new MissingDrawingError(
            `Cannot write ${path.join('.')}: ${arrayKey} entry “${nextId}” is stored at another place in the list.`
        );
    }
    const fields = indexedEntryFields(arrayKey, nextId, value, path);
    byId.set(nextId, toYType(fields));
    order.insert(index, [nextId]);
}

/**
 * Find the drawing map a path addresses (`…/layers/<id>/…`).
 *
 * Nothing is ever created here. With `forWrite`, a path through a glyph or
 * drawings map the document does not hold throws, and so does a path into
 * a drawing that does not exist: a missing drawing is an error, never a
 * stub. A write of the whole drawing (`…/layers/<id>`) to a new id returns
 * null so the caller can create it from the whole value.
 */
function locateDrawingMap(
    root: Y.Map<unknown>,
    path: (string | number)[],
    forWrite = false
): { drawingMap: Y.Map<unknown>; rest: (string | number)[] } | null {
    const layersIndex = path.findIndex(
        (seg, index) => String(seg) === 'layers' && index + 1 < path.length
    );
    if (layersIndex < 0) {
        return null;
    }
    const missing = (what: string): null => {
        if (forWrite) {
            throw new MissingDrawingError(
                `Cannot write ${path.join('.')}: ${what} is missing from the document.`
            );
        }
        return null;
    };
    let current: unknown = root;
    for (let i = 0; i < layersIndex; i++) {
        if (!isYMap(current)) {
            return missing(path.slice(0, i).join('.') || 'the root');
        }
        current = current.get(String(path[i]));
    }
    if (!isYMap(current)) {
        return missing(path.slice(0, layersIndex).join('.'));
    }
    const drawingsMap = current.get('layers');
    if (!isYMap(drawingsMap)) {
        return missing(path.slice(0, layersIndex + 1).join('.'));
    }
    const drawingId = String(path[layersIndex + 1]);
    const drawing = drawingsMap.get(drawingId);
    const rest = path.slice(layersIndex + 2);
    if (!isYMap(drawing)) {
        if (drawing !== undefined || rest.length > 0) {
            return missing(`drawing “${drawingId}”`);
        }
        return null;
    }
    return { drawingMap: drawing, rest };
}

/**
 * Refuse a single-key write of a drawing identity key with an invalid
 * value. Returns true when the stored value already equals `value`, so the
 * write can be skipped.
 */
function checkDrawingIdentityLeafWrite(
    drawingMap: Y.Map<unknown>,
    drawingId: string,
    key: string,
    value: unknown
): boolean {
    let violation: string | null = null;
    if (key === 'width') {
        violation = describeRestingDrawingViolation(
            { width: value },
            { requireIdentity: false }
        );
    } else if (key === 'master') {
        violation = describeDrawingStationViolation(value, {
            isBackground: drawingMap.get('is_background') === true
        });
    } else if (key === 'id' && value !== drawingId) {
        violation = `drawing id “${String(value)}” does not match its key “${drawingId}”`;
    }
    if (violation) {
        throw new RestingDrawingWriteError(violation, 'Y.Doc write');
    }
    const stored = drawingMap.get(key);
    return !isYMap(stored) && !isYArray(stored) && stored === value;
}

function deleteNormalizedShapePath(
    drawingMap: Y.Map<unknown>,
    rest: (string | number)[]
): boolean {
    if (rest[0] !== 'shapes' || rest.length !== 2) {
        return false;
    }
    if (!geometryHasNormalizedStorage(drawingMap)) {
        return false;
    }
    const shapes = readDrawingGeometry(drawingMap);
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
    writeDrawingGeometry(drawingMap, shapes, toYType);
    return true;
}

function writeNormalizedShapePath(
    drawingMap: Y.Map<unknown>,
    rest: (string | number)[],
    value: unknown
): boolean {
    if (rest[0] !== 'shapes') {
        if (rest[0] === DRAWING_NODE_POSITIONS_KEY && rest.length === 2) {
            const packed = typeof value === 'string' ? value : String(value);
            const positionMap = drawingMap.get(DRAWING_NODE_POSITIONS_KEY);
            if (!isYMap(positionMap)) {
                // The positions map is created with the drawing's geometry.
                // A second one created here would hide a collaborator's.
                throw new MissingDrawingError(
                    'Cannot write a node position: the drawing has no node positions map.'
                );
            }
            if (positionMap.get(String(rest[1])) === packed) {
                return true;
            }
            positionMap.set(String(rest[1]), packed);
            return true;
        }
        return false;
    }
    if (!geometryHasNormalizedStorage(drawingMap) && rest.length > 1) {
        // No placeholder shapes are invented to hold this write.
        throw new MissingDrawingError(
            `Cannot write shapes.${rest.slice(1).join('.')}: the drawing has no shapes.`
        );
    }
    if (!geometryHasNormalizedStorage(drawingMap) && rest.length === 1) {
        if (Array.isArray(value)) {
            writeDrawingGeometry(drawingMap, value as unknown[], toYType);
            return true;
        }
        return false;
    }

    const shapes = readDrawingGeometry(drawingMap);
    if (!shapes) {
        if (Array.isArray(value) && rest.length === 1) {
            writeDrawingGeometry(drawingMap, value as unknown[], toYType);
            return true;
        }
        return false;
    }

    if (rest.length === 1) {
        if (!Array.isArray(value)) {
            throw new TypeError('Drawing shapes must be an array.');
        }
        writeDrawingGeometry(drawingMap, value as unknown[], toYType);
        return true;
    }

    const shapeIndex = Number(rest[1]);
    if (
        !Number.isInteger(shapeIndex) ||
        shapeIndex < 0 ||
        shapeIndex > shapes.length ||
        (rest.length > 2 && shapeIndex === shapes.length)
    ) {
        throw new MissingDrawingError(
            `Cannot write shapes.${rest.slice(1).join('.')}: the drawing has no shape ${String(rest[1])}.`
        );
    }
    if (rest.length === 2) {
        shapes[shapeIndex] = value as Record<string, unknown>;
        writeDrawingGeometry(drawingMap, shapes, toYType);
        return true;
    }

    if (rest[2] === 'nodes') {
        const shape = shapes[shapeIndex] as Record<string, unknown>;
        if (rest.length === 3) {
            shape.nodes = value;
            writeDrawingGeometry(drawingMap, shapes, toYType);
            return true;
        }
        const nodeIndex = Number(rest[3]);
        if (!Array.isArray(shape.nodes)) {
            throw new MissingDrawingError(
                `Cannot write shapes.${rest.slice(1).join('.')}: shape ${shapeIndex} is not a path.`
            );
        }
        const nodes = shape.nodes as Record<string, unknown>[];
        if (
            !Number.isInteger(nodeIndex) ||
            nodeIndex < 0 ||
            nodeIndex > nodes.length ||
            (rest.length > 4 && nodeIndex === nodes.length)
        ) {
            throw new MissingDrawingError(
                `Cannot write shapes.${rest.slice(1).join('.')}: the path has no node ${String(rest[3])}.`
            );
        }
        if (rest.length === 4) {
            nodes[nodeIndex] = value as Record<string, unknown>;
            shape.nodes = nodes;
            writeDrawingGeometry(drawingMap, shapes, toYType);
            return true;
        }
        const property = String(rest[4]);
        if (property === 'x' || property === 'y') {
            const nodeId = getNodeIdAt(drawingMap, shapeIndex, nodeIndex);
            const node = nodes[nodeIndex];
            const nextX = property === 'x' ? Number(value) : Number(node.x);
            const nextY = property === 'y' ? Number(value) : Number(node.y);
            writeNodePosition(drawingMap, nodeId, nextX, nextY);
            return true;
        }
        const node = {
            ...nodes[nodeIndex],
            [property]: value
        };
        nodes[nodeIndex] = node;
        shape.nodes = nodes;
        writeDrawingGeometry(drawingMap, shapes, toYType);
        return true;
    }

    const shape = {
        ...(shapes[shapeIndex] as Record<string, unknown>)
    };
    setDeepValue(shape, rest.slice(2), value);
    shapes[shapeIndex] = shape;
    writeDrawingGeometry(drawingMap, shapes, toYType);
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

    const located = locateDrawingMap(root, path, true);
    if (located && located.rest.length === 1) {
        const key = String(located.rest[0]);
        if (
            (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
                key
            ) &&
            checkDrawingIdentityLeafWrite(
                located.drawingMap,
                String(path[path.length - 2]),
                key,
                value
            )
        ) {
            return;
        }
    }
    if (
        located &&
        writeNormalizedShapePath(located.drawingMap, located.rest, value)
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
            existingNodes === undefined ? undefined : fromYType(existingNodes);
        if (!Array.isArray(nodes)) {
            throw new TypeError('Y.Doc path nodes must be arrays.');
        }
        // No placeholder nodes are invented to hold this write.
        if (!Number.isInteger(nodeIndex) || nodeIndex >= nodes.length) {
            throw new MissingDrawingError(
                `Cannot write ${path.join('.')}: the path has no node ${nodeIndex}.`
            );
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
                // Station guides are a flat Y.Array. Creating guidesById
                // here discards that array and turns each pos.x / pos.y
                // write into a new guide.
                const existingById = getIndexedByIdMap(current, segStr);
                const flatArray = current.get(segStr);
                if (!existingById && isYArray(flatArray)) {
                    next = flatArray;
                    current = next;
                    i += 1;
                    continue;
                }
                // Font.features is a container map; only the nested
                // `features.features` list is an indexed map. Do not
                // create featuresById on the font root.
                const byIdMap =
                    existingById ||
                    (segStr === 'features'
                        ? null
                        : ensureIndexedMap(current, segStr));
                if (byIdMap) {
                    // Next segment should be the index/id
                    const nextSeg = path[i + 1];
                    // The pair addresses the entry itself: the value is
                    // the whole entry.
                    const entryIsTarget = i + 2 >= path.length;
                    if (typeof nextSeg === 'number') {
                        // Index-based access: translate via *Order, after
                        // dropping ids a collaborator's delete left behind,
                        // so the index means what readers list there.
                        tidyKeyedPairOf(current, segStr);
                        const entryAtIndex = indexedEntryAt(
                            current,
                            segStr,
                            nextSeg,
                            path
                        );
                        next = entryAtIndex;
                        if (entryAtIndex && entryIsTarget) {
                            writeIndexedEntryAtIndex(
                                current,
                                segStr,
                                nextSeg,
                                entryAtIndex,
                                value,
                                path
                            );
                            return;
                        }
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
                                    const added = indexedEntryToAdd(
                                        segStr,
                                        byIdMap,
                                        value,
                                        path
                                    );
                                    byIdMap.set(added.id, toYType(added));
                                    orderArr.insert(insertIdx, [added.id]);
                                    return; // value already written
                                }
                                // A write into an element that does not
                                // exist would create a stub element.
                                throw new MissingDrawingError(
                                    `Cannot write ${path.join('.')}: ${segStr} has no entry ${nextSeg}.`
                                );
                            }
                            throw new MissingDrawingError(
                                `Cannot write ${path.join('.')}: ${segStr} has no order.`
                            );
                        }
                        current = next; // move to the found element
                        i += 2; // consume both segments
                        continue;
                    } else if (typeof nextSeg === 'string') {
                        // Id-based access: navigate directly via *ById
                        next = byIdMap.get(nextSeg);
                        if (next === undefined) {
                            throw new MissingDrawingError(
                                `Cannot write ${path.join('.')}: ${segStr} has no entry “${nextSeg}”.`
                            );
                        }
                        if (entryIsTarget) {
                            if (!isYMap(next)) {
                                throw new MissingDrawingError(
                                    `The ${segStr} are damaged in the document: entry “${nextSeg}” is not a map.`
                                );
                            }
                            writeIndexedEntryInPlace(
                                next,
                                segStr,
                                nextSeg,
                                value,
                                path
                            );
                            return;
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
                    // The write is refused, never dropped.
                    throw new MissingDrawingError(
                        `Cannot write ${path.join('.')}: the feature has no ${featureField}.`
                    );
                }
                current = next;
                i += 1;
                continue;
            }

            // Normal Y.Map navigation. A missing container below a map is a
            // map: a numeric next segment is a key there (a codepoint, a
            // glyph named “1”), never an array index.
            next = current.get(segStr);
            if (
                next === undefined &&
                located &&
                current === located.drawingMap &&
                DRAWING_INDEXED_PAIR_KEYS[segStr]
            ) {
                if (
                    INDEXED_MAP_KEYS[DRAWING_INDEXED_PAIR_KEYS[segStr]]!
                        .byId === segStr
                ) {
                    // A write into an entry of a map that does not exist
                    // yet: the entry would have no id in the order. Refused
                    // before anything is created.
                    throw new MissingDrawingError(
                        `Cannot write ${path.join('.')}: ${segStr} has no entry “${String(path[i + 1])}”.`
                    );
                }
                // Half of the anchors' or guides' keyed pair: both halves
                // are created together, never one alone.
                ensureIndexedMap(current, DRAWING_INDEXED_PAIR_KEYS[segStr]);
                next = current.get(segStr);
            }
            if (next === undefined && indexedPairOfByIdMap(current)) {
                // An entry created here would have no id in the order: it
                // is added only together with its id.
                throw new MissingDrawingError(
                    `Cannot write ${path.join('.')}: ${String(path[i - 1])} has no entry “${segStr}”.`
                );
            }
            if (next === undefined) {
                if (located && !isYTypeNewInCurrentTransaction(current)) {
                    // A child map created lazily inside a stored drawing
                    // races a collaborator's; recorded, never hidden.
                    recordLateDrawingChildMap(
                        located.drawingMap,
                        path
                            .slice(path.length - located.rest.length, i + 1)
                            .join('.')
                    );
                }
                const newContainer = new Y.Map<unknown>();
                current.set(segStr, newContainer);
                next = newContainer;
            }
        } else if (current instanceof Y.Array) {
            // A write into an element that does not exist is refused: an
            // element created here would be a stub, and a write dropped
            // here would lose the edit.
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
                throw new MissingDrawingError(
                    `Cannot write ${path.join('.')}: ${path
                        .slice(0, i)
                        .join('.')} has no entry ${String(seg)}.`
                );
            }
            next = current.get(idx);
        } else {
            throw new TypeError(
                `Cannot write ${path.join('.')}: ${path
                    .slice(0, i)
                    .join('.')} is a value, not a container.`
            );
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
    if (
        current instanceof Y.Map &&
        located &&
        current === located.drawingMap &&
        DRAWING_INDEXED_PAIR_KEYS[lastSegStr] &&
        current.get(lastSegStr) === undefined
    ) {
        // A write of one half of the anchors' or guides' keyed pair: both
        // halves are created together, never one alone.
        ensureIndexedMap(current, DRAWING_INDEXED_PAIR_KEYS[lastSegStr]);
    }

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
            tidyKeyedPairOf(current, ORDER_KEYS[lastSegStr]!);
            assertOrderWriteOnlyReorders(current, lastSegStr, nextIds);
            diffYArrayOrder(existingOrder, nextIds);
            return;
        }
        // No existing order array — create one from the value.
        // Falls through to the generic set below.
    }

    // Special case: when setting an indexed-map array key (shapes, anchors,
    // guides) as the terminal segment on a Y.Map,
    // update the *ById+*Order structure instead of setting a flat
    // key. This handles drawing-level shape/anchor/guide replacements
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
        const existingDrawing = current.get(lastSegStr);
        if (isYMap(existingDrawing)) {
            applyDrawingDelta(
                root,
                String(path[1]),
                lastSegStr,
                value as Record<string, unknown>
            );
            return;
        }
    }

    // A whole-drawing write (`…/layers/<id>`). A new drawing is created
    // from the whole value, which must carry its own width, id and station
    // link; a replace may not write invalid identity values.
    if (
        current instanceof Y.Map &&
        path.length >= 2 &&
        String(path[path.length - 2]) === 'layers'
    ) {
        if (!isPlainObject(value)) {
            throw new RestingDrawingWriteError(
                'drawing is not a plain object',
                'Y.Doc write'
            );
        }
        const existingDrawing = current.get(lastSegStr);
        if (!isYMap(existingDrawing)) {
            if (value.id !== lastSegStr) {
                throw new RestingDrawingWriteError(
                    `drawing id “${String(value.id)}” does not match its key “${lastSegStr}”`,
                    'Y.Doc write'
                );
            }
            current.set(lastSegStr, drawingToYMap(value));
            return;
        }
        const violation = describeRestingDrawingViolation(
            omitRestingDrawingRuntimeKeys(value),
            {
                requireIdentity: false,
                isBackground:
                    'is_background' in value
                        ? value.is_background === true
                        : existingDrawing.get('is_background') === true
            }
        );
        if (violation) {
            throw new RestingDrawingWriteError(violation, 'Y.Doc write');
        }
    }

    if (
        current instanceof Y.Map &&
        path.length >= 2 &&
        (path[path.length - 2] === 'anchorsById' ||
            path[path.length - 2] === 'guidesById') &&
        (!isPlainObject(value) || value.id !== lastSegStr)
    ) {
        // An anchor or guide stores its own id; it is never read from the key.
        throw new RestingDrawingWriteError(
            `${String(path[path.length - 2])} entry “${lastSegStr}” must be a map whose id is “${lastSegStr}”`,
            'Y.Doc write'
        );
    }
    if (
        current instanceof Y.Map &&
        indexedPairOfByIdMap(current) &&
        current.get(lastSegStr) === undefined
    ) {
        // A new entry is added only together with its id in the order
        // (through the list path), never into the map alone.
        throw new MissingDrawingError(
            `Cannot write ${path.join('.')}: a new ${indexedPairOfByIdMap(current)} entry is added with its place in the order, not into ${String(path[path.length - 2])} alone.`
        );
    }

    if (
        current instanceof Y.Map &&
        located &&
        current === located.drawingMap &&
        lastSegStr === DRAWING_FORMAT_SPECIFIC_KEY
    ) {
        writeDrawingFormatSpecific(current, value);
        return;
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
        if (!isYMap(existing) && !isYArray(existing) && existing === value) {
            // An equal leaf is not written again (see applyDrawingDelta).
            return;
        }
        current.set(lastSegStr, yValue);
    } else if (current instanceof Y.Array) {
        const idx = pathSegmentIndex(lastSeg);
        if (!Number.isInteger(idx) || idx < 0 || idx > current.length) {
            throw new MissingDrawingError(
                `Cannot write ${path.join('.')}: index ${String(lastSeg)} is outside the list.`
            );
        }
        if (idx === current.length) {
            current.insert(idx, [yValue]);
        } else {
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
    } else {
        throw new TypeError(
            `Cannot write ${path.join('.')}: ${path
                .slice(0, -1)
                .join('.')} is a value, not a container.`
        );
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

    const located = locateDrawingMap(root, path, false);
    if (
        located &&
        located.rest.length === 1 &&
        (RESTING_DRAWING_IDENTITY_KEYS as readonly string[]).includes(
            String(located.rest[0])
        )
    ) {
        // A drawing never loses its width, id or station link.
        throw new RestingDrawingWriteError(
            `drawing ${String(located.rest[0])} may not be deleted`,
            'Y.Doc delete'
        );
    }
    if (
        located &&
        located.rest.length === 1 &&
        String(located.rest[0]) === DRAWING_FORMAT_SPECIFIC_KEY
    ) {
        // Emptied, never deleted (see writeDrawingFormatSpecific).
        writeDrawingFormatSpecific(located.drawingMap, undefined);
        return;
    }
    if (
        located &&
        deleteNormalizedShapePath(located.drawingMap, located.rest)
    ) {
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
                    // The index means what readers list there.
                    tidyKeyedPairOrder(byId, order, secondLastSeg);
                    const idx = lastSeg;
                    if (idx < 0 || idx >= order.length) return;
                    const id = order.get(idx);
                    if (typeof id !== 'string') {
                        throw new MissingDrawingError(
                            `The ${secondLastSeg} are damaged in the document: ${mapping.order} holds a value that is not an id.`
                        );
                    }
                    // Every place the order lists the id goes with the
                    // entry (two collaborators moving it at once list it
                    // twice); one left behind would name a missing entry.
                    const ids = order.toArray();
                    for (let index = ids.length - 1; index >= 0; index -= 1) {
                        if (ids[index] === id) {
                            order.delete(index, 1);
                        }
                    }
                    byId.delete(id);
                    return;
                }
                // Indexed-map structure doesn't exist (e.g. Master.guides
                // stored as flat Y.Array). Fall through to generic deletion.
            }
        }
    }

    // An entry of a keyed pair addressed through one half (`…/anchorsById/
    // <id>` or `…/anchorOrder/<index>`) is removed from both halves in one
    // go: removing it from one alone would leave an id without its entry,
    // or an entry the order does not list.
    if (path.length >= 2) {
        const pairKey = String(path[path.length - 2]);
        const lastSeg = path[path.length - 1];
        const pair = Object.entries(INDEXED_MAP_KEYS).find(
            ([, mapping]) =>
                mapping.byId === pairKey || mapping.order === pairKey
        );
        if (pair) {
            const [arrayKey, mapping] = pair;
            const parentPath = path.slice(0, -2);
            const parent =
                parentPath.length > 0 ? getYPath(root, parentPath) : root;
            if (!(parent instanceof Y.Map)) {
                return;
            }
            const byId = parent.get(mapping.byId);
            const order = parent.get(mapping.order);
            if (!isYMap(byId) || !isYArray(order)) {
                throw new MissingDrawingError(
                    `The ${arrayKey} are damaged in the document: ${
                        isYMap(byId) ? mapping.order : mapping.byId
                    } is missing or not a ${isYMap(byId) ? 'list' : 'map'}.`
                );
            }
            tidyKeyedPairOrder(byId, order, arrayKey);
            let id: unknown;
            if (pairKey === mapping.order) {
                const idx = Number(lastSeg);
                if (!Number.isInteger(idx) || idx < 0 || idx >= order.length) {
                    return;
                }
                id = order.get(idx);
            } else {
                id = String(lastSeg);
            }
            if (typeof id !== 'string') {
                throw new MissingDrawingError(
                    `The ${arrayKey} are damaged in the document: ${mapping.order} holds a value that is not an id.`
                );
            }
            const ids = order.toArray();
            for (let index = ids.length - 1; index >= 0; index -= 1) {
                if (ids[index] === id) {
                    order.delete(index, 1);
                }
            }
            byId.delete(id);
            return;
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
                    if (
                        (lastSegStr === 'anchors' || lastSegStr === 'guides') &&
                        isDrawingYMap(parent)
                    ) {
                        // A drawing's keyed maps are created with it and
                        // never deleted: a map created again by a later
                        // first entry races a collaborator's. Only the
                        // entries go.
                        applyIndexedMapArray(parent, lastSegStr, []);
                        return;
                    }
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
