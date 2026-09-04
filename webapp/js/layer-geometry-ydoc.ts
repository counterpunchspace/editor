/**
 * Normalized layer outline storage for Y.Doc.
 *
 * Coordinates live in `nodePositionsById` as one packed scalar per node.
 * Path grammar lives in one atomic `geometryTopology` string. Nested
 * `shapes[i].nodes` writes are forbidden — they duplicated parent shapes
 * in Rust/Yrs.
 */

import * as Y from 'yjs';

function generateStableId(): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const GEOMETRY_TOPOLOGY_VERSION = 1;
export const LAYER_GEOMETRY_TOPOLOGY_KEY = 'geometryTopology';
export const LAYER_NODE_POSITIONS_KEY = 'nodePositionsById';
export const LAYER_SHAPE_DATA_KEY = 'shapeDataById';

const PATH_KIND = 'P';
const COMPONENT_KIND = 'C';
const NODE_TYPES = new Set(['move', 'line', 'curve', 'qcurve', 'offcurve']);

function normalizeNodeType(value: unknown): string {
    return String(value || 'Line');
}

export type GeometryTopology = {
    v: number;
    g: number;
    shapes: GeometryShape[];
};

export type GeometryShape = {
    id: string;
    k: typeof PATH_KIND | typeof COMPONENT_KIND;
    c?: boolean;
    n?: string[];
    t?: string[];
    s?: boolean[];
};

type Unsafe = Record<string, unknown>;

function isPlainObject(value: unknown): value is Unsafe {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function innerShape(shape: unknown): Unsafe | null {
    if (!isPlainObject(shape)) {
        return null;
    }
    if ('Path' in shape || 'Component' in shape) {
        throw new TypeError(
            'Wrapped shapes are not allowed in layer geometry.'
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
            if (shape.s && shape.s.length !== shape.n.length) {
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
            if (shape.s?.some((smooth) => typeof smooth !== 'boolean')) {
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
        } else if (shape.k !== COMPONENT_KIND) {
            throw new TypeError(`Unknown geometry shape kind ${shape.k}.`);
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
            throw new TypeError('Layer shapes must be objects.');
        }
        const id =
            typeof shape.id === 'string' && shape.id
                ? shape.id
                : generateStableId();
        shape.id = id;

        if (isPathShape(shape)) {
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
                types.push(normalizeNodeType(node.nodetype));
                smooth.push(node.smooth === true);
                positions[nodeId] = encodePackedXY(node.x, node.y);
            }
            topology.shapes.push({
                id,
                k: PATH_KIND,
                c: shape.closed !== false,
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
        const data = isPlainObject(shapeData[entry.id])
            ? { ...(shapeData[entry.id] as Unsafe) }
            : {};
        if (entry.k === PATH_KIND) {
            const nodes = (entry.n || []).map((nodeId, index) => {
                const packed = positions[nodeId];
                if (packed === undefined) {
                    throw new TypeError(`Missing position for node ${nodeId}.`);
                }
                const { x, y } = decodePackedXY(packed);
                return {
                    id: nodeId,
                    x,
                    y,
                    nodetype: entry.t?.[index] || 'Line',
                    smooth: entry.s?.[index] === true
                };
            });
            shapes.push({
                ...data,
                id: entry.id,
                closed: entry.c !== false,
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

function isYMap(value: unknown): value is Y.Map<unknown> {
    return value instanceof Y.Map;
}

function yValueToJson(value: unknown): unknown {
    if (value instanceof Y.Map) {
        const obj: Record<string, unknown> = {};
        value.forEach((entry, key) => {
            obj[key] = yValueToJson(entry);
        });
        return obj;
    }
    if (value instanceof Y.Array) {
        return value.toArray().map(yValueToJson);
    }
    return value;
}

function ensureChildMap(layerMap: Y.Map<unknown>, key: string): Y.Map<unknown> {
    if (!layerMap.doc) {
        const created = new Y.Map<unknown>();
        layerMap.set(key, created);
        return created;
    }
    const existing = layerMap.get(key);
    if (isYMap(existing)) {
        return existing;
    }
    const created = new Y.Map<unknown>();
    layerMap.set(key, created);
    return created;
}

export function writeLayerGeometry(
    layerMap: Y.Map<unknown>,
    shapes: unknown[],
    toYType: (value: unknown) => unknown = (value) => value
): void {
    // Public callers (external imports, Python, tests) do not necessarily
    // hold a transaction. Nested transactions join an existing one in Yjs.
    if (layerMap.doc) {
        layerMap.doc.transact(() => {
            writeLayerGeometryInTransaction(layerMap, shapes, toYType);
        });
        return;
    }
    writeLayerGeometryInTransaction(layerMap, shapes, toYType);
}

function writeLayerGeometryInTransaction(
    layerMap: Y.Map<unknown>,
    shapes: unknown[],
    toYType: (value: unknown) => unknown
): void {
    const { topology, positions, shapeData } = splitShapesForYDoc(shapes);
    const previousTopologyRaw = layerMap.get(LAYER_GEOMETRY_TOPOLOGY_KEY);
    let previousTopology: GeometryTopology | null = null;
    if (previousTopologyRaw !== undefined) {
        previousTopology = decodeGeometryTopology(previousTopologyRaw);
    }
    const topologyChanged =
        !previousTopology ||
        JSON.stringify(previousTopology.shapes) !==
            JSON.stringify(topology.shapes);
    const previouslyReferencedNodes = new Set(
        previousTopology?.shapes.flatMap((shape) => shape.n || []) || []
    );
    topology.g = topologyChanged
        ? (previousTopology?.g ?? 0) + 1
        : previousTopology!.g;
    if (layerMap.doc && layerMap.has('shapes')) {
        layerMap.delete('shapes');
    }
    const encodedTopology = encodeGeometryTopology(topology);
    if (layerMap.get(LAYER_GEOMETRY_TOPOLOGY_KEY) !== encodedTopology) {
        layerMap.set(LAYER_GEOMETRY_TOPOLOGY_KEY, encodedTopology);
    }

    const positionMap = ensureChildMap(layerMap, LAYER_NODE_POSITIONS_KEY);
    for (const [key, value] of Object.entries(positions)) {
        // Reintroducing a node must restore its coordinate after converged
        // orphan cleanup. Existing nodes retain a concurrent drag's LWW pair.
        if (
            positionMap.get(key) !== value ||
            (topologyChanged && !previouslyReferencedNodes.has(key))
        ) {
            positionMap.set(key, value);
        }
    }

    const shapeDataMap = ensureChildMap(layerMap, LAYER_SHAPE_DATA_KEY);
    for (const [key, value] of Object.entries(shapeData)) {
        const current = shapeDataMap.get(key);
        if (JSON.stringify(yValueToJson(current)) === JSON.stringify(value)) {
            continue;
        }
        shapeDataMap.set(key, toYType(value));
    }

    // Do not delete positions here. A just-removed node can be retained by a
    // concurrently winning topology; it is an ignored orphan until the
    // explicit, idempotent repair pass runs after convergence.
}

export function repairLayerGeometryOrphans(layerMap: Y.Map<unknown>): void {
    if (!layerMap.has(LAYER_GEOMETRY_TOPOLOGY_KEY)) {
        return;
    }
    const topology = decodeGeometryTopology(
        layerMap.get(LAYER_GEOMETRY_TOPOLOGY_KEY)
    );
    const referencedNodes = new Set<string>();
    const referencedShapes = new Set<string>();
    for (const shape of topology.shapes) {
        referencedShapes.add(shape.id);
        for (const nodeId of shape.n || []) {
            referencedNodes.add(nodeId);
        }
    }
    const positionMap = layerMap.get(LAYER_NODE_POSITIONS_KEY);
    if (isYMap(positionMap)) {
        for (const key of Array.from(positionMap.keys())) {
            if (!referencedNodes.has(key)) {
                positionMap.delete(key);
            }
        }
    }
    const shapeDataMap = layerMap.get(LAYER_SHAPE_DATA_KEY);
    if (isYMap(shapeDataMap)) {
        for (const key of Array.from(shapeDataMap.keys())) {
            if (!referencedShapes.has(key)) {
                shapeDataMap.delete(key);
            }
        }
    }
}

export function readLayerGeometry(layerMap: Y.Map<unknown>): Unsafe[] | null {
    const rawTopology = layerMap.get(LAYER_GEOMETRY_TOPOLOGY_KEY);
    if (rawTopology === undefined) {
        return null;
    }
    const topology = decodeGeometryTopology(rawTopology);
    const positionsRaw = layerMap.get(LAYER_NODE_POSITIONS_KEY);
    const shapeDataRaw = layerMap.get(LAYER_SHAPE_DATA_KEY);
    const positions: Record<string, unknown> = {};
    if (isYMap(positionsRaw)) {
        positionsRaw.forEach((value, key) => {
            positions[key] = value;
        });
    }
    const shapeData: Record<string, unknown> = {};
    if (isYMap(shapeDataRaw)) {
        shapeDataRaw.forEach((value, key) => {
            shapeData[key] = yValueToJson(value);
        });
    }
    return reconstructShapesFromGeometry(topology, positions, shapeData);
}

export function writeNodePosition(
    layerMap: Y.Map<unknown>,
    nodeId: string,
    x: number,
    y: number
): void {
    const positionMap = ensureChildMap(layerMap, LAYER_NODE_POSITIONS_KEY);
    positionMap.set(nodeId, encodePackedXY(x, y));
}

export function geometryHasNormalizedStorage(
    layerMap: Y.Map<unknown>
): boolean {
    return layerMap.has(LAYER_GEOMETRY_TOPOLOGY_KEY);
}

export function getLayerTopology(layerMap: Y.Map<unknown>): GeometryTopology {
    return decodeGeometryTopology(layerMap.get(LAYER_GEOMETRY_TOPOLOGY_KEY));
}

export function getShapeIdAt(
    layerMap: Y.Map<unknown>,
    shapeIndex: number
): string {
    const shape = getLayerTopology(layerMap).shapes[shapeIndex];
    if (!shape) {
        throw new RangeError(`Shape index ${shapeIndex} is out of range.`);
    }
    return shape.id;
}

export function getNodeIdAt(
    layerMap: Y.Map<unknown>,
    shapeIndex: number,
    nodeIndex: number
): string {
    const shape = getLayerTopology(layerMap).shapes[shapeIndex];
    const nodeId = shape?.n?.[nodeIndex];
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
            String(previous.nodetype || 'Line') ===
                String(next.nodetype || 'Line') &&
            (previous.smooth === true) === (next.smooth === true)
        );
    });
}
