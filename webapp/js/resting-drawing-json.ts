/**
 * Resting-drawing JSON codec.
 *
 * Only Drawing.toJSON()-shaped data may enter Y.Doc, history replay, or model
 * writeback. Compile-facing (toCompileJSON) and interpolator/canvas payloads
 * must be converted here or refused.
 */

import type { Babelfont } from './babelfont';
import { affineToDecomposedAffine } from './glyph-path-geometry';
type PlainObject = Record<string, unknown>;

export const RESTING_DRAWING_RUNTIME_KEYS = [
    '_interpolationRequestId',
    '__preferExactComponentTransforms',
    '_interpolationLocation',
    '_verticalMetrics',
    'isInterpolated',
    'layerData',
    '_geometryCoherent',
    '_geometryPreviewStale'
] as const;

export const RESTING_DRAWING_IDENTITY_KEYS = ['id', 'width', 'master'] as const;

const SHAPE_RUNTIME_KEYS = ['isInterpolated', 'layerData'] as const;

function isPlainObject(value: unknown): value is PlainObject {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function omitRestingDrawingRuntimeKeys(
    record: PlainObject
): PlainObject {
    if (!RESTING_DRAWING_RUNTIME_KEYS.some((key) => key in record)) {
        return record;
    }
    const next = { ...record };
    for (const key of RESTING_DRAWING_RUNTIME_KEYS) {
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
    const next = omitRestingDrawingRuntimeKeys(record);
    if (!SHAPE_RUNTIME_KEYS.some((key) => key in next)) {
        return next;
    }
    const stripped = { ...next };
    for (const key of SHAPE_RUNTIME_KEYS) {
        delete stripped[key];
    }
    return stripped;
}

/**
 * Read one component transform number. An absent value takes Babelfont’s
 * identity default; a present value that is not a finite number is refused,
 * never replaced (a scale of 0 stays 0).
 */
function transformNumber(
    value: unknown,
    identity: number,
    label: string
): number {
    if (value === undefined || value === null) {
        return identity;
    }
    const number = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || !Number.isFinite(number)) {
        throw new TypeError(
            `Component transform ${label} must be a finite number, not “${String(value)}”.`
        );
    }
    return number;
}

export function toRestingComponentTransform(
    transform: unknown
): Babelfont.DecomposedAffine {
    if (Array.isArray(transform)) {
        return affineToDecomposedAffine(
            transform.map((value, index) =>
                transformNumber(
                    value,
                    index === 0 || index === 3 ? 1 : 0,
                    `[${index}]`
                )
            )
        );
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
              transformNumber(record.translation[0], 0, 'translation x'),
              transformNumber(record.translation[1], 0, 'translation y')
          ]
        : [0, 0];
    const scale = Array.isArray(record.scale)
        ? [
              transformNumber(record.scale[0], 1, 'scale x'),
              transformNumber(record.scale[1], 1, 'scale y')
          ]
        : [1, 1];
    const rawSkew = Array.isArray(record.skew)
        ? record.skew
        : [record.skew ?? 0, 0];

    if (
        record.order !== undefined &&
        record.order !== null &&
        record.order !== 'Glyphs' &&
        record.order !== 'RestOfTheWorld'
    ) {
        throw new TypeError(
            `Component transform order “${String(record.order)}” is unknown.`
        );
    }

    return {
        translation: translation as [number, number],
        rotation: transformNumber(record.rotation, 0, 'rotation'),
        scale: scale as [number, number],
        skew: [
            transformNumber(rawSkew[0], 0, 'skew x'),
            transformNumber(rawSkew[1], 0, 'skew y')
        ] as [number, number],
        order:
            record.order === 'Glyphs'
                ? ('Glyphs' as Babelfont.TransformOrder)
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
        // A path without a boolean closed flag is refused, never read as
        // open or closed.
        if (typeof withoutTcenter.closed !== 'boolean') {
            throw new TypeError(
                context === 'Y.Doc write'
                    ? 'Y.Doc paths must have a boolean closed flag.'
                    : `Path shape has no closed flag before ${context}.`
            );
        }
        return {
            ...withoutTcenter,
            nodes: withoutTcenter.nodes,
            closed: withoutTcenter.closed
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
    options: RestingShapeOptions
): unknown[] | undefined {
    if (!Array.isArray(shapes)) {
        return undefined;
    }

    // Every incoming shape must convert. A shape that is not a Path or
    // Component is refused, never dropped and never swapped for the shapes
    // already stored: either would lose or invent outline data.
    return shapes.map((shape, index) => {
        const next = toRestingShapeJson(shape, { ...options, strict: true });
        if (!next) {
            throw new TypeError(
                `shapes[${index}] is not a Path or Component before ${
                    options.context ?? 'Y.Doc write'
                }.`
            );
        }
        return next;
    });
}

/**
 * Copy resting path/component geometry onto an editor working copy
 * without replacing the editor shape objects. Nested `layerData` and
 * interpolator flags stay on the canvas copy.
 */
export function applyRestingShapeGeometryToEditorDrawing(
    editorDrawing: unknown,
    restingDrawing: unknown
): void {
    if (!isPlainObject(editorDrawing) || !isPlainObject(restingDrawing)) {
        return;
    }
    const editorShapes = editorDrawing.shapes;
    const restingShapes = restingDrawing.shapes;
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
            // A resting path always carries a boolean closed flag; one
            // without it is refused, never left at the editor's old value.
            if (typeof restingShape.closed !== 'boolean') {
                throw new TypeError(
                    `shapes[${index}] has no closed flag to copy to the editor drawing.`
                );
            }
            editorShape.nodes = restingShape.nodes;
            editorShape.closed = restingShape.closed;
            if ('format_specific' in restingShape) {
                editorShape.format_specific = restingShape.format_specific;
            }
        }
    }
}

export type RestingDrawingWriteOptions = {
    existing?: unknown;
    mode?: 'delta' | 'replace';
    allowWrapped?: boolean;
    context?: string;
    strict?: boolean;
};

/**
 * Thrown when a drawing write would store a drawing without a finite width,
 * a non-empty id or a station link, or with shapes that are not resting
 * Path/Component JSON. Nothing is written; no value is filled in.
 */
export class RestingDrawingWriteError extends TypeError {
    readonly violation: string;
    constructor(violation: string, context: string) {
        super(`Refused ${context}: ${violation}.`);
        this.name = 'RestingDrawingWriteError';
        this.violation = violation;
    }
}

/**
 * Convert drawing data to resting JSON before it enters the Y.Doc, history
 * replay or model writeback.
 *
 * `delta` mode accepts a partial drawing, but any identity key it carries
 * (`id`, `width`, `master`) must be valid. Every other mode describes a
 * whole drawing, which must carry all three itself: they are never copied
 * from `existing`. A `replace` must also carry its `shapes` list (empty for
 * a drawing without any); nothing is taken from `existing`, which only
 * says whether the drawing is a background drawing.
 */
export function toRestingDrawingJson(
    drawingData: unknown,
    options: RestingDrawingWriteOptions = {}
): PlainObject {
    if (!isPlainObject(drawingData)) {
        throw new TypeError('Resting drawing JSON must be a plain object.');
    }

    const existing = isPlainObject(options.existing) ? options.existing : null;
    const incoming = omitRestingDrawingRuntimeKeys(drawingData);
    const context = options.context ?? 'Y.Doc write';
    const shapeOptions: RestingShapeOptions = {
        allowWrapped: options.allowWrapped,
        context,
        strict: true
    };

    const next: PlainObject = { ...incoming };
    // An identity key spread in as `undefined` writes nothing.
    for (const key of RESTING_DRAWING_IDENTITY_KEYS) {
        if (key in next && next[key] === undefined) {
            delete next[key];
        }
    }
    if (incoming.shapes === undefined) {
        delete next.shapes;
    } else if (incoming.shapes !== null) {
        // A null `shapes` in a delta clears the outline; anything else
        // that is not an array is refused.
        const sanitized = sanitizeShapes(incoming.shapes, shapeOptions);
        if (sanitized === undefined) {
            throw new RestingDrawingWriteError(
                'drawing shapes are not an array',
                context
            );
        }
        next.shapes = sanitized;
    }

    if (options.mode === 'replace' && !Array.isArray(incoming.shapes)) {
        // A replace writes the whole drawing, its outline too. One without
        // its shapes is refused; the stored shapes are never kept in their
        // place. (Drawing.toJSON and serializeDrawingForStorage always
        // write `shapes`, an empty list for a drawing without any.)
        throw new RestingDrawingWriteError(
            incoming.shapes === undefined
                ? 'a whole drawing replace carries no shapes'
                : 'drawing shapes are not an array',
            context
        );
    }

    const isBackground =
        'is_background' in next
            ? next.is_background === true
            : existing?.is_background === true;
    const violation = describeRestingDrawingViolation(next, {
        requireIdentity: options.mode !== 'delta',
        isBackground
    });
    if (violation) {
        throw new RestingDrawingWriteError(violation, context);
    }

    return next;
}

/**
 * Describe why a drawing's station link is not a valid Babelfont layer type,
 * or return null when it is. Background drawings are the one exception to
 * naming a station: Babelfont writes theirs as `DefaultForMaster` with an
 * empty station id, and they belong to their foreground drawing through
 * `background_layer_id` instead.
 */
export function describeDrawingStationViolation(
    station: unknown,
    options: { isBackground?: boolean } = {}
): string | null {
    if (!isPlainObject(station)) {
        return 'drawing master is not a station link';
    }
    if (station.type === 'FreeFloating') {
        return null;
    }
    if (
        station.type !== 'DefaultForMaster' &&
        station.type !== 'AssociatedWithMaster'
    ) {
        return `drawing master has no known type (${JSON.stringify(station)})`;
    }
    if (
        typeof station.master !== 'string' ||
        (!station.master.length && options.isBackground !== true)
    ) {
        return `drawing master names no station (${JSON.stringify(station)})`;
    }
    return null;
}

/**
 * Describe why drawing data may not rest in the Y.Doc, or return null.
 *
 * By default the drawing must be whole: `width`, `id` and `master` are
 * required. With `requireIdentity: false` (a partial delta) each of them
 * may be absent, but any that is present must be valid.
 */
export function describeRestingDrawingViolation(
    drawingData: unknown,
    options: { requireIdentity?: boolean; isBackground?: boolean } = {}
): string | null {
    if (!isPlainObject(drawingData)) {
        return 'drawing is not a plain object';
    }
    if (RESTING_DRAWING_RUNTIME_KEYS.some((key) => key in drawingData)) {
        return 'drawing contains interpolator/runtime keys';
    }
    const requireIdentity = options.requireIdentity !== false;
    if (requireIdentity || 'width' in drawingData) {
        if (!('width' in drawingData)) {
            return 'drawing has no width';
        }
        if (
            typeof drawingData.width !== 'number' ||
            !Number.isFinite(drawingData.width)
        ) {
            return 'drawing width is not a finite number';
        }
    }
    if (requireIdentity || 'id' in drawingData) {
        if (typeof drawingData.id !== 'string' || !drawingData.id.length) {
            return 'drawing id is not a non-empty string';
        }
    }
    if (requireIdentity || 'master' in drawingData) {
        const stationViolation = describeDrawingStationViolation(
            drawingData.master,
            {
                isBackground:
                    options.isBackground ?? drawingData.is_background === true
            }
        );
        if (stationViolation) {
            return stationViolation;
        }
    }
    if (!Array.isArray(drawingData.shapes)) {
        return null;
    }
    for (let index = 0; index < drawingData.shapes.length; index++) {
        const shape = drawingData.shapes[index];
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
