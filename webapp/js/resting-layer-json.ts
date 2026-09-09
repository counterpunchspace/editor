/**
 * Resting-layer JSON codec.
 *
 * Only Layer.toJSON()-shaped data may enter Y.Doc, history replay, or model
 * writeback. Compile-facing (toCompileJSON) and interpolator/canvas payloads
 * must be converted here or refused.
 */

import type { Babelfont } from './babelfont';
import { affineToDecomposedAffine } from './glyph-path-geometry';
import { Logger } from './logger';

const console = new Logger('RestingLayerJson');

type PlainObject = Record<string, unknown>;

export const RESTING_LAYER_RUNTIME_KEYS = [
    '_interpolationRequestId',
    '__preferExactComponentTransforms',
    '_interpolationLocation',
    '_verticalMetrics',
    'isInterpolated',
    'layerData',
    '_geometryCoherent',
    '_geometryPreviewStale'
] as const;

export const RESTING_LAYER_IDENTITY_KEYS = ['id', 'width', 'master'] as const;

const SHAPE_RUNTIME_KEYS = ['isInterpolated', 'layerData'] as const;

function isPlainObject(value: unknown): value is PlainObject {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function omitRestingLayerRuntimeKeys(record: PlainObject): PlainObject {
    if (!RESTING_LAYER_RUNTIME_KEYS.some((key) => key in record)) {
        return record;
    }
    const next = { ...record };
    for (const key of RESTING_LAYER_RUNTIME_KEYS) {
        delete next[key];
    }
    return next;
}

/** Drop interpolator request ids from an exact (editable) canvas working copy. */
export function stripInterpolatorRequestId(value: unknown): void {
    if (!isPlainObject(value)) {
        return;
    }
    delete value._interpolationRequestId;
}

function omitShapeRuntimeKeys(record: PlainObject): PlainObject {
    const next = omitRestingLayerRuntimeKeys(record);
    if (!SHAPE_RUNTIME_KEYS.some((key) => key in next)) {
        return next;
    }
    const stripped = { ...next };
    for (const key of SHAPE_RUNTIME_KEYS) {
        delete stripped[key];
    }
    return stripped;
}

export function toRestingComponentTransform(
    transform: unknown
): Babelfont.DecomposedAffine {
    if (Array.isArray(transform)) {
        return affineToDecomposedAffine(transform.map(Number));
    }

    if (!transform || typeof transform !== 'object') {
        return {
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld' as Babelfont.TransformOrder
        };
    }

    const record = transform as PlainObject;
    const translation = Array.isArray(record.translation)
        ? [
              Number(record.translation[0]) || 0,
              Number(record.translation[1]) || 0
          ]
        : [0, 0];
    const scale = Array.isArray(record.scale)
        ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
        : [1, 1];
    const rawSkew = Array.isArray(record.skew)
        ? record.skew
        : [record.skew ?? 0, 0];

    return {
        translation: translation as [number, number],
        rotation: Number(record.rotation) || 0,
        scale: scale as [number, number],
        skew: [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0] as [
            number,
            number
        ],
        order:
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? (record.order as Babelfont.TransformOrder)
                : ('RestOfTheWorld' as Babelfont.TransformOrder)
    };
}

function unwrapShapeCandidate(
    shape: unknown,
    allowWrapped: boolean,
    context: string
): PlainObject | null {
    if (!isPlainObject(shape)) {
        return null;
    }
    if ('Path' in shape || 'Component' in shape) {
        if (!allowWrapped) {
            throw new TypeError(
                `Wrapped shapes are not allowed before ${context}.`
            );
        }
        if ('Path' in shape && isPlainObject(shape.Path)) {
            return shape.Path;
        }
        if ('Component' in shape && isPlainObject(shape.Component)) {
            return shape.Component;
        }
        return null;
    }
    return shape;
}

export type RestingShapeOptions = {
    strict?: boolean;
    allowWrapped?: boolean;
    context?: string;
};

export function toRestingShapeJson(
    shape: unknown,
    options: RestingShapeOptions = {}
): PlainObject | null {
    const context = options.context ?? 'Y.Doc write';
    const candidate = unwrapShapeCandidate(
        shape,
        options.allowWrapped === true,
        context
    );
    if (!candidate) {
        if (options.strict !== false) {
            throw new TypeError(`Unrecognized shape before ${context}.`);
        }
        return null;
    }

    const record = omitShapeRuntimeKeys(candidate);
    const { tcenter: _tcenter, ...withoutTcenter } = record;

    if ('nodes' in withoutTcenter) {
        if (!Array.isArray(withoutTcenter.nodes)) {
            throw new TypeError(
                context === 'Y.Doc write'
                    ? 'Y.Doc path nodes must be arrays.'
                    : `Path shape nodes must be an array before ${context}.`
            );
        }
        return {
            ...withoutTcenter,
            nodes: withoutTcenter.nodes,
            closed:
                withoutTcenter.closed === undefined
                    ? false
                    : withoutTcenter.closed
        };
    }

    if ('reference' in withoutTcenter) {
        if (typeof withoutTcenter.reference !== 'string') {
            throw new TypeError(
                `Component shapes must have a string reference before ${context}.`
            );
        }
        return {
            ...withoutTcenter,
            reference: withoutTcenter.reference,
            transform: toRestingComponentTransform(withoutTcenter.transform)
        };
    }

    if (options.strict !== false) {
        throw new TypeError(
            `Unrecognized shape is not a Path or Component before ${context}.`
        );
    }
    return null;
}

function sanitizeShapes(
    shapes: unknown,
    existingShapes: unknown,
    options: RestingShapeOptions
): unknown[] | undefined {
    if (!Array.isArray(shapes)) {
        return undefined;
    }

    const sanitized: PlainObject[] = [];
    let dropped = 0;
    for (const shape of shapes) {
        try {
            const next = toRestingShapeJson(shape, options);
            if (next) {
                sanitized.push(next);
            } else {
                dropped += 1;
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (
                options.strict === true ||
                message.includes('nodes must be an array') ||
                message.includes('Y.Doc path nodes must be arrays')
            ) {
                throw error;
            }
            dropped += 1;
            console.warn('Dropped invalid resting shape', error);
        }
    }

    if (
        sanitized.length === 0 &&
        dropped > 0 &&
        Array.isArray(existingShapes) &&
        existingShapes.length > 0
    ) {
        const recovered = existingShapes
            .map((shape) =>
                toRestingShapeJson(shape, {
                    ...options,
                    strict: false
                })
            )
            .filter((shape): shape is PlainObject => !!shape);
        if (recovered.length) {
            console.warn(
                'Keeping existing shapes; incoming shapes were not Path or Component'
            );
            return recovered;
        }
    }

    return sanitized;
}

/**
 * Copy resting path/component geometry onto an editor working copy
 * without replacing the editor shape objects. Nested `layerData` and
 * interpolator flags stay on the canvas copy.
 */
export function applyRestingShapeGeometryToEditorLayer(
    editorLayer: unknown,
    restingLayer: unknown
): void {
    if (!isPlainObject(editorLayer) || !isPlainObject(restingLayer)) {
        return;
    }
    const editorShapes = editorLayer.shapes;
    const restingShapes = restingLayer.shapes;
    if (!Array.isArray(editorShapes) || !Array.isArray(restingShapes)) {
        return;
    }

    const count = Math.min(editorShapes.length, restingShapes.length);
    for (let index = 0; index < count; index++) {
        const editorShape = editorShapes[index];
        const restingShape = restingShapes[index];
        if (!isPlainObject(editorShape) || !isPlainObject(restingShape)) {
            continue;
        }

        if ('reference' in editorShape && 'reference' in restingShape) {
            editorShape.reference = restingShape.reference;
            if (restingShape.transform !== undefined) {
                editorShape.transform = toRestingComponentTransform(
                    restingShape.transform
                );
            }
            if ('alignment' in restingShape) {
                editorShape.alignment = restingShape.alignment;
            }
            if ('anchor' in restingShape) {
                editorShape.anchor = restingShape.anchor;
            }
            continue;
        }

        if ('nodes' in editorShape && 'nodes' in restingShape) {
            editorShape.nodes = restingShape.nodes;
            if (restingShape.closed !== undefined) {
                editorShape.closed = restingShape.closed;
            }
            if ('format_specific' in restingShape) {
                editorShape.format_specific = restingShape.format_specific;
            }
        }
    }
}

export type RestingLayerWriteOptions = {
    existing?: unknown;
    mode?: 'delta' | 'replace';
    allowWrapped?: boolean;
    context?: string;
    strict?: boolean;
};

export function toRestingLayerJson(
    layerData: unknown,
    options: RestingLayerWriteOptions = {}
): PlainObject {
    if (!isPlainObject(layerData)) {
        throw new TypeError('Resting layer JSON must be a plain object.');
    }

    const existing = isPlainObject(options.existing) ? options.existing : null;
    const incoming = omitRestingLayerRuntimeKeys(layerData);
    const context = options.context ?? 'Y.Doc write';
    const shapeOptions: RestingShapeOptions = {
        allowWrapped: options.allowWrapped,
        context,
        strict: options.strict === true
    };

    const next: PlainObject = { ...incoming };
    if (Array.isArray(incoming.shapes)) {
        const sanitized = sanitizeShapes(
            incoming.shapes,
            existing?.shapes,
            shapeOptions
        );
        if (sanitized === undefined) {
            delete next.shapes;
        } else {
            next.shapes = sanitized;
        }
    }

    if (options.mode === 'replace' && existing) {
        for (const key of RESTING_LAYER_IDENTITY_KEYS) {
            if (!(key in incoming) && key in existing) {
                next[key] = existing[key];
            }
        }
        if (!Array.isArray(incoming.shapes) && Array.isArray(existing.shapes)) {
            next.shapes = sanitizeShapes(
                existing.shapes,
                existing.shapes,
                shapeOptions
            );
        }
    }

    return next;
}

export function describeRestingLayerViolation(
    layerData: unknown
): string | null {
    if (!isPlainObject(layerData)) {
        return 'layer is not a plain object';
    }
    if (RESTING_LAYER_RUNTIME_KEYS.some((key) => key in layerData)) {
        return 'layer contains interpolator/runtime keys';
    }
    if (
        'width' in layerData &&
        (typeof layerData.width !== 'number' ||
            !Number.isFinite(layerData.width))
    ) {
        return 'layer width is not a finite number';
    }
    if (!Array.isArray(layerData.shapes)) {
        return null;
    }
    for (let index = 0; index < layerData.shapes.length; index++) {
        const shape = layerData.shapes[index];
        if (!isPlainObject(shape)) {
            return `shapes[${index}] is not an object`;
        }
        if ('Path' in shape || 'Component' in shape) {
            return `shapes[${index}] is a wrapped Path/Component`;
        }
        if ('nodes' in shape) {
            if (!Array.isArray(shape.nodes)) {
                return `shapes[${index}] path nodes are not an array`;
            }
            continue;
        }
        if ('reference' in shape) {
            if (typeof shape.reference !== 'string') {
                return `shapes[${index}] component reference is not a string`;
            }
            if (Array.isArray(shape.transform)) {
                return `shapes[${index}] component transform is an affine array`;
            }
            continue;
        }
        return `shapes[${index}] is not a Path or Component`;
    }
    return null;
}
