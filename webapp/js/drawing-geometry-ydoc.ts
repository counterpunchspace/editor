/**
 * Normalized drawing outline storage for Y.Doc.
 *
 * Coordinates live in `nodePositionsById` as one packed scalar per node.
 * Path grammar lives in one atomic `geometryTopology` string. Nested
 * `shapes[i].nodes` writes are forbidden — they duplicated parent shapes
 * in Rust/Yrs.
 */

import * as Y from 'yjs';
import { recordCollabTrace } from './collab-trace';
import {
    isPlainObject,
    isYMap,
    yArrayToArray,
    yMapForEach,
    yMapGet,
    yMapHas,
    yMapKeys
} from './yjs-prelim';

/**
 * Whether a shared type is new: not yet in a document, or inserted by the
 * transaction that is running now. A child map created next to a new
 * drawing travels in the drawing's own packet, so no collaborator can
 * create a competing one.
 */
export function isYTypeNewInCurrentTransaction(
    type: Y.Map<unknown> | Y.Array<unknown>
): boolean {
    const doc = type.doc;
    if (!doc) {
        return true;
    }
    const item = type._item;
    const transaction = doc._transaction;
    if (!item || !transaction) {
        return false;
    }
    return item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0);
}

/**
 * Permanent collab trace event `drawing-child-map-created-late`: a keyed
 * child map (anchors, guides, node positions, shape data, or any other map)
 * was created inside a drawing that already existed in the document. Two
 * collaborators doing this at once create competing maps, and every entry
 * in the losing one disappears. Drawings created since every child map is
 * made together with the drawing never record it; older drawings and
 * drawings written by the font worker can.
 */
export function recordLateDrawingChildMap(
    drawingMap: Y.Map<unknown>,
    key: string
): void {
    if (isYTypeNewInCurrentTransaction(drawingMap)) {
        return;
    }
    const drawingsMap = drawingMap.parent;
    const glyphMap = drawingsMap?.parent;
    const glyphName =
        glyphMap instanceof Y.Map ? yMapGet(glyphMap, 'name') : undefined;
    const drawingId = drawingMap._item?.parentSub;
    recordCollabTrace(
        'drawing-child-map-created-late',
        typeof glyphName === 'string' ? [glyphName] : [],
        {
            drawing: typeof drawingId === 'string' ? drawingId : null,
            key
        }
    );
}

export function generateStableId(): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const GEOMETRY_TOPOLOGY_VERSION = 1;
export const DRAWING_GEOMETRY_TOPOLOGY_KEY = 'geometryTopology';
export const DRAWING_NODE_POSITIONS_KEY = 'nodePositionsById';
export const DRAWING_SHAPE_DATA_KEY = 'shapeDataById';

const PATH_KIND = 'P';
const COMPONENT_KIND = 'C';
const NODE_TYPES = new Set(['move', 'line', 'curve', 'qcurve', 'offcurve']);

/**
 * A node's stored type. A node always carries its own `nodetype`: one
 * without it is refused, never written as a line.
 */
function requireStoredNodeType(value: unknown, nodeId: string): string {
    if (typeof value !== 'string' || !NODE_TYPES.has(value.toLowerCase())) {
        throw new TypeError(
            value === undefined
                ? `Node ${nodeId} has no nodetype.`
                : `Node ${nodeId} has an invalid nodetype ${JSON.stringify(value)}.`
        );
    }
    return value;
}

export type GeometryTopology = {
    v: number;
    g: number;
    shapes: GeometryShape[];
};

/**
 * A path's closed flag, node ids, node types and smooth flags are all
 * written with it (`splitShapesForYDoc`, the only topology writer), so a
 * stored path without any of them was damaged and is refused on read.
 */
export type PathGeometryShape = {
    id: string;
    k: typeof PATH_KIND;
    c: boolean;
    n: string[];
    t: string[];
    s: boolean[];
};

export type ComponentGeometryShape = {
    id: string;
    k: typeof COMPONENT_KIND;
};

export type GeometryShape = PathGeometryShape | ComponentGeometryShape;

type Unsafe = Record<string, unknown>;

function innerShape(shape: unknown): Unsafe | null {
    if (!isPlainObject(shape)) {
        return null;
    }
    if ('Path' in shape || 'Component' in shape) {
        throw new TypeError(
            'Wrapped shapes are not allowed in drawing geometry.'
        );
    }
    return shape;
}

function isPathShape(shape: Unsafe): boolean {
    return Array.isArray(shape.nodes);
}

function isComponentShape(shape: Unsafe): boolean {
    return typeof shape.reference === 'string';
}

export function encodePackedXY(x: unknown, y: unknown): string {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
        throw new TypeError('Node coordinates must be finite numbers.');
    }
    return `${nx} ${ny}`;
}

export function decodePackedXY(packed: unknown): { x: number; y: number } {
    if (typeof packed !== 'string') {
        throw new TypeError('Packed node position must be a string.');
    }
    const parts = packed.split(' ');
    if (parts.length !== 2) {
        throw new TypeError('Packed node position must be "x y".');
    }
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError('Packed node position must be finite.');
    }
    return { x, y };
}

export function encodeGeometryTopology(topology: GeometryTopology): string {
    if (topology.v !== GEOMETRY_TOPOLOGY_VERSION) {
        throw new TypeError(`Unknown geometry topology version ${topology.v}.`);
    }
    assertValidTopology(topology);
    return JSON.stringify(topology);
}

export function decodeGeometryTopology(raw: unknown): GeometryTopology {
    if (typeof raw !== 'string') {
        throw new TypeError('geometryTopology must be a JSON string.');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new TypeError('geometryTopology is not valid JSON.');
    }
    if (!isPlainObject(parsed) || parsed.v !== GEOMETRY_TOPOLOGY_VERSION) {
        throw new TypeError('Unknown or missing geometry topology version.');
    }
    if (
        typeof parsed.g !== 'number' ||
        !Number.isSafeInteger(parsed.g) ||
        parsed.g < 0
    ) {
        throw new TypeError('geometryTopology is missing a valid generation.');
    }
    if (!Array.isArray(parsed.shapes)) {
        throw new TypeError('geometryTopology.shapes must be an array.');
    }
    const topology = parsed as GeometryTopology;
    assertValidTopology(topology);
    return topology;
}

function assertValidTopology(topology: GeometryTopology): void {
    if (!Number.isSafeInteger(topology.g) || topology.g < 0) {
        throw new TypeError(
            'geometryTopology generation must be a non-negative integer.'
        );
    }
    const shapeIds = new Set<string>();
    const nodeIds = new Set<string>();
    for (const shape of topology.shapes) {
        if (!shape || typeof shape.id !== 'string' || !shape.id) {
            throw new TypeError('Each geometry shape must have a string id.');
        }
        if (shapeIds.has(shape.id)) {
            throw new TypeError(`Duplicate shape id ${shape.id}.`);
        }
        shapeIds.add(shape.id);
        if (shape.k === PATH_KIND) {
            if (typeof shape.c !== 'boolean') {
                throw new TypeError(
                    `Path ${shape.id} closed flag must be a boolean.`
                );
            }
            if (!Array.isArray(shape.n) || !Array.isArray(shape.t)) {
                throw new TypeError(
                    `Path ${shape.id} is missing node order or types.`
                );
            }
            if (shape.n.length !== shape.t.length) {
                throw new TypeError(
                    `Path ${shape.id} node/type length mismatch.`
                );
            }
            if (!Array.isArray(shape.s)) {
                throw new TypeError(`Path ${shape.id} has no smooth flags.`);
            }
            if (shape.s.length !== shape.n.length) {
                throw new TypeError(
                    `Path ${shape.id} smooth-flag length mismatch.`
                );
            }
            if (
                shape.t.some(
                    (type) =>
                        typeof type !== 'string' ||
                        !NODE_TYPES.has(type.toLowerCase())
                )
            ) {
                throw new TypeError(
                    `Path ${shape.id} contains an invalid node type.`
                );
            }
            if (shape.s.some((smooth) => typeof smooth !== 'boolean')) {
                throw new TypeError(
                    `Path ${shape.id} smooth flags must be booleans.`
                );
            }
            for (const nodeId of shape.n) {
                if (typeof nodeId !== 'string' || !nodeId) {
                    throw new TypeError('Node ids must be non-empty strings.');
                }
                if (nodeIds.has(nodeId)) {
                    throw new TypeError(`Duplicate node id ${nodeId}.`);
                }
                nodeIds.add(nodeId);
            }
        } else if ((shape as { k: unknown }).k !== COMPONENT_KIND) {
            throw new TypeError(
                `Unknown geometry shape kind ${String((shape as { k: unknown }).k)}.`
            );
        }
    }
}

export function splitShapesForYDoc(shapes: unknown[]): {
    topology: GeometryTopology;
    positions: Record<string, string>;
    shapeData: Record<string, Unsafe>;
} {
    const topology: GeometryTopology = {
        v: GEOMETRY_TOPOLOGY_VERSION,
        g: 0,
        shapes: []
    };
    const positions: Record<string, string> = {};
    const shapeData: Record<string, Unsafe> = {};

    for (const rawShape of shapes) {
        const shape = innerShape(rawShape);
        if (!shape) {
            throw new TypeError('Drawing shapes must be objects.');
        }
        const id =
            typeof shape.id === 'string' && shape.id
                ? shape.id
                : generateStableId();
        shape.id = id;

        if (isPathShape(shape)) {
            // A path without a boolean closed flag is refused, never read
            // as closed or open (as the font worker refuses it too).
            if (typeof shape.closed !== 'boolean') {
                throw new TypeError(`Path ${id} has no closed flag.`);
            }
            const closed = shape.closed;
            const nodes = shape.nodes as Unsafe[];
            const nodeIds: string[] = [];
            const types: string[] = [];
            const smooth: boolean[] = [];
            for (const node of nodes) {
                if (!isPlainObject(node)) {
                    throw new TypeError('Path nodes must be objects.');
                }
                const nodeId =
                    typeof node.id === 'string' && node.id
                        ? node.id
                        : generateStableId();
                node.id = nodeId;
                nodeIds.push(nodeId);
                types.push(requireStoredNodeType(node.nodetype, nodeId));
                smooth.push(node.smooth === true);
                positions[nodeId] = encodePackedXY(node.x, node.y);
            }
            topology.shapes.push({
                id,
                k: PATH_KIND,
                c: closed,
                n: nodeIds,
                t: types,
                s: smooth
            });
            const { id: _id, nodes: _nodes, closed: _closed, ...rest } = shape;
            shapeData[id] = rest;
        } else if (isComponentShape(shape)) {
            topology.shapes.push({ id, k: COMPONENT_KIND });
            const { id: _id, ...rest } = shape;
            shapeData[id] = rest;
        } else {
            throw new TypeError(
                'Shape must be a path with nodes or a component with reference.'
            );
        }
    }

    return { topology, positions, shapeData };
}

export function reconstructShapesFromGeometry(
    topology: GeometryTopology,
    positions: Record<string, unknown>,
    shapeData: Record<string, unknown>
): Unsafe[] {
    assertValidTopology(topology);
    const shapes: Unsafe[] = [];
    for (const entry of topology.shapes) {
        // Every writer stores each shape's data, a path's too (an empty
        // map when it has nothing besides its nodes). A missing entry was
        // lost and is never read as empty.
        const storedData = shapeData[entry.id];
        if (!isPlainObject(storedData)) {
            throw new DrawingGeometryIntegrityError(
                storedData === undefined
                    ? `Missing data for ${entry.k === PATH_KIND ? 'path' : 'component'} ${entry.id}.`
                    : `The data of shape ${entry.id} is not a map.`
            );
        }
        const data: Unsafe = { ...storedData };
        if (entry.k === PATH_KIND) {
            // `assertValidTopology` refused a path without a type and a
            // smooth flag for every node, or without a closed flag: these
            // are read as stored, never filled in.
            const nodes = entry.n.map((nodeId, index) => {
                const packed = positions[nodeId];
                if (packed === undefined) {
                    throw new TypeError(`Missing position for node ${nodeId}.`);
                }
                const { x, y } = decodePackedXY(packed);
                return {
                    id: nodeId,
                    x,
                    y,
                    nodetype: entry.t[index],
                    smooth: entry.s[index]
                };
            });
            shapes.push({
                ...data,
                id: entry.id,
                closed: entry.c,
                nodes
            });
        } else {
            if (typeof data.reference !== 'string' || !data.reference) {
                throw new TypeError(
                    `Component ${entry.id} is missing a valid reference.`
                );
            }
            shapes.push({
                ...data,
                id: entry.id
            });
        }
    }
    return shapes;
}

function yValueToJson(value: unknown): unknown {
    if (value instanceof Y.Map) {
        const obj: Record<string, unknown> = {};
        yMapForEach(value, (entry, key) => {
            obj[key] = yValueToJson(entry);
        });
        return obj;
    }
    if (value instanceof Y.Array) {
        return yArrayToArray(value).map(yValueToJson);
    }
    return value;
}

/**
 * Return a geometry child map. It is created only together with the
 * drawing's first geometry (`mayCreate`); afterwards a missing one is an
 * error, because a second map created next to a collaborator's would hide
 * every position in theirs.
 */
function ensureChildMap(
    drawingMap: Y.Map<unknown>,
    key: string,
    mayCreate: boolean
): Y.Map<unknown> {
    const existing = yMapGet(drawingMap, key);
    if (isYMap(existing)) {
        return existing;
    }
    if (!mayCreate) {
        throw new DrawingGeometryIntegrityError(
            `The drawing’s geometry has no ${key} map.`
        );
    }
    // A drawing gets its geometry maps when it is created. Only a drawing
    // stored before that, or written by the font worker without them,
    // gets them here, and that is recorded.
    recordLateDrawingChildMap(drawingMap, key);
    const created = new Y.Map<unknown>();
    drawingMap.set(key, created);
    return created;
}

/**
 * Thrown when a drawing’s normalized geometry is incomplete: a node without
 * a position, a component without its data, or a missing geometry map.
 * Nothing is repaired or deleted.
 */
export class DrawingGeometryIntegrityError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = 'DrawingGeometryIntegrityError';
    }
}

/**
 * A geometry child map of a drawing that has a topology. Both maps are
 * created with the drawing's first topology, even one without shapes, so
 * a missing one was lost; it is never read as empty.
 */
function requireGeometryChildMap(
    drawingMap: Y.Map<unknown>,
    key: string
): Y.Map<unknown> {
    const childMap = yMapGet(drawingMap, key);
    if (!isYMap(childMap)) {
        throw new DrawingGeometryIntegrityError(
            childMap === undefined
                ? `The drawing’s geometry has no ${key} map.`
                : `The drawing’s ${key} is not a map.`
        );
    }
    return childMap;
}

export function writeDrawingGeometry(
    drawingMap: Y.Map<unknown>,
    shapes: unknown[],
    toYType: (value: unknown) => unknown = (value) => value
): void {
    // Public callers (external imports, Python, tests) do not necessarily
    // hold a transaction. Nested transactions join an existing one in Yjs.
    if (drawingMap.doc) {
        drawingMap.doc.transact(() => {
            writeDrawingGeometryInTransaction(drawingMap, shapes, toYType);
        });
        return;
    }
    writeDrawingGeometryInTransaction(drawingMap, shapes, toYType);
}

function writeDrawingGeometryInTransaction(
    drawingMap: Y.Map<unknown>,
    shapes: unknown[],
    toYType: (value: unknown) => unknown
): void {
    const { topology, positions, shapeData } = splitShapesForYDoc(shapes);
    const previousTopologyRaw = yMapGet(
        drawingMap,
        DRAWING_GEOMETRY_TOPOLOGY_KEY
    );
    let previousTopology: GeometryTopology | null = null;
    if (previousTopologyRaw !== undefined) {
        previousTopology = decodeGeometryTopology(previousTopologyRaw);
    }
    const topologyChanged =
        !previousTopology ||
        JSON.stringify(previousTopology.shapes) !==
            JSON.stringify(topology.shapes);
    topology.g = topologyChanged
        ? (previousTopology?.g ?? 0) + 1
        : previousTopology!.g;
    if (drawingMap.doc && yMapHas(drawingMap, 'shapes')) {
        drawingMap.delete('shapes');
    }
    const encodedTopology = encodeGeometryTopology(topology);
    if (
        yMapGet(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY) !== encodedTopology
    ) {
        drawingMap.set(DRAWING_GEOMETRY_TOPOLOGY_KEY, encodedTopology);
    }

    const positionMap = ensureChildMap(
        drawingMap,
        DRAWING_NODE_POSITIONS_KEY,
        !previousTopology
    );
    for (const [key, value] of Object.entries(positions)) {
        // An equal position is not written again: each rewrite deletes the
        // stored item, and a receiver that misses this packet would lose
        // the coordinate to that deletion. Positions are never deleted, so
        // a node that comes back still has its own.
        if (yMapGet(positionMap, key) !== value) {
            positionMap.set(key, value);
        }
    }

    const shapeDataMap = ensureChildMap(
        drawingMap,
        DRAWING_SHAPE_DATA_KEY,
        !previousTopology
    );
    for (const [key, value] of Object.entries(shapeData)) {
        const current = yMapGet(shapeDataMap, key);
        if (JSON.stringify(yValueToJson(current)) === JSON.stringify(value)) {
            continue;
        }
        shapeDataMap.set(key, toYType(value));
    }

    // Positions of removed nodes are never deleted: a concurrent topology
    // may still reference them, and deleting one loses a collaborator's
    // coordinate.
}

/**
 * Assert that a drawing's normalized geometry is complete: every node the
 * topology references has a position, and every component has its data.
 * Positions no longer referenced are left alone; they are not an error and
 * deleting them would lose a collaborator's coordinate. Throws
 * `DrawingGeometryIntegrityError`; nothing is repaired.
 */
export function assertDrawingGeometryComplete(
    drawingMap: Y.Map<unknown>
): void {
    if (!yMapHas(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY)) {
        return;
    }
    const topology = decodeGeometryTopology(
        yMapGet(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY)
    );
    const positionMap = requireGeometryChildMap(
        drawingMap,
        DRAWING_NODE_POSITIONS_KEY
    );
    const shapeDataMap = requireGeometryChildMap(
        drawingMap,
        DRAWING_SHAPE_DATA_KEY
    );
    for (const shape of topology.shapes) {
        if (yMapGet(shapeDataMap, shape.id) === undefined) {
            throw new DrawingGeometryIntegrityError(
                `Missing data for ${shape.k === PATH_KIND ? 'path' : 'component'} ${shape.id}.`
            );
        }
        if (shape.k === PATH_KIND) {
            for (const nodeId of shape.n) {
                if (yMapGet(positionMap, nodeId) === undefined) {
                    throw new DrawingGeometryIntegrityError(
                        `Missing position for node ${nodeId}.`
                    );
                }
            }
        }
    }
}

export function readDrawingGeometry(
    drawingMap: Y.Map<unknown>
): Unsafe[] | null {
    const rawTopology = yMapGet(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY);
    if (rawTopology === undefined) {
        return null;
    }
    const topology = decodeGeometryTopology(rawTopology);
    const positionsMap = requireGeometryChildMap(
        drawingMap,
        DRAWING_NODE_POSITIONS_KEY
    );
    const shapeDataMap = requireGeometryChildMap(
        drawingMap,
        DRAWING_SHAPE_DATA_KEY
    );
    const positions: Record<string, unknown> = {};
    yMapForEach(positionsMap, (value, key) => {
        positions[key] = value;
    });
    const shapeData: Record<string, unknown> = {};
    yMapForEach(shapeDataMap, (value, key) => {
        shapeData[key] = yValueToJson(value);
    });
    return reconstructShapesFromGeometry(topology, positions, shapeData);
}

export function writeNodePosition(
    drawingMap: Y.Map<unknown>,
    nodeId: string,
    x: number,
    y: number
): void {
    const positionMap = ensureChildMap(
        drawingMap,
        DRAWING_NODE_POSITIONS_KEY,
        false
    );
    const packed = encodePackedXY(x, y);
    if (yMapGet(positionMap, nodeId) === packed) {
        return;
    }
    positionMap.set(nodeId, packed);
}

export function geometryHasNormalizedStorage(
    drawingMap: Y.Map<unknown>
): boolean {
    return yMapHas(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY);
}

export function getDrawingTopology(
    drawingMap: Y.Map<unknown>
): GeometryTopology {
    return decodeGeometryTopology(
        yMapGet(drawingMap, DRAWING_GEOMETRY_TOPOLOGY_KEY)
    );
}

export function getShapeIdAt(
    drawingMap: Y.Map<unknown>,
    shapeIndex: number
): string {
    const shape = getDrawingTopology(drawingMap).shapes[shapeIndex];
    if (!shape) {
        throw new RangeError(`Shape index ${shapeIndex} is out of range.`);
    }
    return shape.id;
}

export function getNodeIdAt(
    drawingMap: Y.Map<unknown>,
    shapeIndex: number,
    nodeIndex: number
): string {
    const shape = getDrawingTopology(drawingMap).shapes[shapeIndex];
    const nodeId = shape?.k === PATH_KIND ? shape.n[nodeIndex] : undefined;
    if (!nodeId) {
        throw new RangeError(
            `Node index ${nodeIndex} is out of range for shape ${shapeIndex}.`
        );
    }
    return nodeId;
}

export function topologyEqualsForNodes(
    previousNodes: unknown[],
    nextNodes: unknown[]
): boolean {
    if (previousNodes.length !== nextNodes.length) {
        return false;
    }
    return previousNodes.every((node, index) => {
        const previous = isPlainObject(node) ? node : null;
        const next = isPlainObject(nextNodes[index]) ? nextNodes[index] : null;
        if (!previous || !next) {
            return false;
        }
        return (
            previous.id === next.id &&
            // A node without its type is never compared as a line: the
            // write then goes through the topology, which refuses it.
            typeof next.nodetype === 'string' &&
            previous.nodetype === next.nodetype &&
            (previous.smooth === true) === (next.smooth === true)
        );
    });
}
