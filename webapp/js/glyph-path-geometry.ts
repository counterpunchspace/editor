import type { Babelfont } from './babelfont';

type Unsafe = ReturnType<typeof JSON.parse>;

export const IDENTITY_AFFINE = [1, 0, 0, 1, 0, 0] as const;

const REST_OF_THE_WORLD_TRANSFORM_ORDER =
    'RestOfTheWorld' as Babelfont.TransformOrder;
const GLYPHS_TRANSFORM_ORDER = 'Glyphs' as Babelfont.TransformOrder;

function composeTransforms(...transforms: number[][]): number[] {
    return transforms.reduce(
        (acc, transform) => multiplyAffineTransforms(acc, transform),
        createIdentityAffine()
    );
}

function transformNode(node: Unsafe, transform: number[]): Unsafe {
    const transformed = transformPointWithAffine(transform, node.x, node.y);
    return {
        ...node,
        x: transformed.x,
        y: transformed.y
    };
}

export function createIdentityAffine(): [
    number,
    number,
    number,
    number,
    number,
    number
] {
    return [...IDENTITY_AFFINE];
}

export function multiplyAffineTransforms(
    left: number[],
    right: number[]
): [number, number, number, number, number, number] {
    const [a1, b1, c1, d1, tx1, ty1] = left;
    const [a2, b2, c2, d2, tx2, ty2] = right;
    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * tx2 + c1 * ty2 + tx1,
        b1 * tx2 + d1 * ty2 + ty1
    ];
}

export function transformPointWithAffine(
    transform: number[],
    x: number,
    y: number
): { x: number; y: number } {
    return {
        x: transform[0] * x + transform[2] * y + transform[4],
        y: transform[1] * x + transform[3] * y + transform[5]
    };
}

export type GlyphStandInContour = {
    nodes: Array<{ x: number; y: number; nodetype?: string }>;
    closed: boolean;
};

let glyphStandInContours: ((name: string) => GlyphStandInContour[]) | null =
    null;

/** Sample contours used when a component reference has no real outlines. */
export function setGlyphStandInContours(
    provider: (name: string) => GlyphStandInContour[]
): void {
    glyphStandInContours = provider;
}

function boundsFromMinMax(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
} | null {
    if (
        !Number.isFinite(minX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY)
    ) {
        return null;
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY
    };
}

function calculateQuadraticAt(
    p0: number,
    p1: number,
    p2: number,
    t: number
): number {
    const mt = 1 - t;
    return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function calculateCubicAt(
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    t: number
): number {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    return mt2 * mt * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t2 * t * p3;
}

function collectQuadraticExtrema(p0: number, p1: number, p2: number): number[] {
    const denominator = p0 - 2 * p1 + p2;
    if (Math.abs(denominator) < 1e-8) {
        return [];
    }
    const t = (p0 - p1) / denominator;
    return t > 0 && t < 1 ? [t] : [];
}

function collectCubicExtrema(
    p0: number,
    p1: number,
    p2: number,
    p3: number
): number[] {
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = -p0 + p1;

    if (Math.abs(a) < 1e-8) {
        if (Math.abs(b) < 1e-8) {
            return [];
        }
        const t = -c / b;
        return t > 0 && t < 1 ? [t] : [];
    }

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) {
        return [];
    }

    if (discriminant === 0) {
        const t = -b / (2 * a);
        return t > 0 && t < 1 ? [t] : [];
    }

    const root = Math.sqrt(discriminant);
    return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter(
        (t) => t > 0 && t < 1
    );
}

function getGlyphNodeType(node: Babelfont.Node | undefined): string {
    return (node?.nodetype || (node as Unsafe | undefined)?.type || '')
        .toString()
        .toLowerCase();
}

function isOnCurve(node: Babelfont.Node | undefined): boolean {
    const type = getGlyphNodeType(node);
    return (
        type === 'm' ||
        type === 'move' ||
        type === 'l' ||
        type === 'line' ||
        type === 'c' ||
        type === 'curve' ||
        type === 'q' ||
        type === 'qcurve'
    );
}

export function createIdentityDecomposedAffine(
    order: Babelfont.TransformOrder = REST_OF_THE_WORLD_TRANSFORM_ORDER
): Babelfont.DecomposedAffine {
    return {
        translation: [0, 0],
        scale: [1, 1],
        rotation: 0,
        skew: [0, 0],
        order
    };
}

export function decomposedAffineToAffine(
    decomposed: Babelfont.DecomposedAffine
): [number, number, number, number, number, number] {
    const translation = decomposed.translation || [0, 0];
    const scale = decomposed.scale || [1, 1];
    const rotation = decomposed.rotation || 0;
    const skew = decomposed.skew || [0, 0];
    const order = decomposed.order || REST_OF_THE_WORLD_TRANSFORM_ORDER;

    const translateMatrix = [1, 0, 0, 1, translation[0], translation[1]];
    const rotateMatrix = [
        Math.cos(rotation),
        Math.sin(rotation),
        -Math.sin(rotation),
        Math.cos(rotation),
        0,
        0
    ];
    const scaleMatrix = [scale[0], 0, 0, scale[1], 0, 0];
    const skewMatrix = [1, Math.tan(skew[1]), Math.tan(skew[0]), 1, 0, 0];

    if (order === GLYPHS_TRANSFORM_ORDER) {
        return composeTransforms(
            translateMatrix,
            skewMatrix,
            rotateMatrix,
            scaleMatrix
        ) as [number, number, number, number, number, number];
    }

    return composeTransforms(
        translateMatrix,
        rotateMatrix,
        scaleMatrix,
        skewMatrix
    ) as [number, number, number, number, number, number];
}

export function normalizeAffineTransform(
    transformRaw: unknown
): [number, number, number, number, number, number] {
    if (!transformRaw) {
        return createIdentityAffine();
    }

    if (Array.isArray(transformRaw) && transformRaw.length >= 6) {
        return [
            Number(transformRaw[0]) || 1,
            Number(transformRaw[1]) || 0,
            Number(transformRaw[2]) || 0,
            Number(transformRaw[3]) || 1,
            Number(transformRaw[4]) || 0,
            Number(transformRaw[5]) || 0
        ];
    }

    if (
        typeof transformRaw === 'object' &&
        ('translation' in transformRaw ||
            'scale' in transformRaw ||
            'rotation' in transformRaw ||
            'skew' in transformRaw)
    ) {
        return decomposedAffineToAffine(
            transformRaw as Babelfont.DecomposedAffine
        );
    }

    if (
        typeof transformRaw === 'object' &&
        ['a', 'b', 'c', 'd', 'e', 'f'].every((key) => key in transformRaw)
    ) {
        const affine = transformRaw as Record<string, unknown>;
        return [
            Number(affine.a) || 1,
            Number(affine.b) || 0,
            Number(affine.c) || 0,
            Number(affine.d) || 1,
            Number(affine.e) || 0,
            Number(affine.f) || 0
        ];
    }

    if (
        typeof transformRaw === 'object' &&
        ['xx', 'yx', 'xy', 'yy', 'x0', 'y0'].every((key) => key in transformRaw)
    ) {
        const affine = transformRaw as Record<string, unknown>;
        return [
            Number(affine.xx) || 1,
            Number(affine.yx) || 0,
            Number(affine.xy) || 0,
            Number(affine.yy) || 1,
            Number(affine.x0) || 0,
            Number(affine.y0) || 0
        ];
    }

    const coeffs =
        typeof transformRaw === 'object'
            ? (transformRaw as Record<string, unknown>).coeffs
            : undefined;
    if (Array.isArray(coeffs) && coeffs.length >= 6) {
        return [
            Number(coeffs[0]) || 1,
            Number(coeffs[1]) || 0,
            Number(coeffs[2]) || 0,
            Number(coeffs[3]) || 1,
            Number(coeffs[4]) || 0,
            Number(coeffs[5]) || 0
        ];
    }

    return createIdentityAffine();
}

export function affineToDecomposedAffine(
    affine: number[],
    order: Babelfont.TransformOrder = REST_OF_THE_WORLD_TRANSFORM_ORDER
): Babelfont.DecomposedAffine {
    const [rawA, rawB, rawC, rawD, rawTx, rawTy] = [
        Number(affine[0]) || 0,
        Number(affine[1]) || 0,
        Number(affine[2]) || 0,
        Number(affine[3]) || 0,
        Number(affine[4]) || 0,
        Number(affine[5]) || 0
    ];

    let a = rawA;
    let b = rawB;
    const c = rawC;
    const d = rawD;
    const sxSign = a === 0 ? 1 : Math.sign(a);

    if (sxSign < 0) {
        a *= sxSign;
        b *= sxSign;
    }

    const delta = a * d - b * c;
    let rotation = 0;
    let scale: [number, number] = [0, 0];
    let skew: [number, number] = [0, 0];

    if (a !== 0 || b !== 0) {
        const r = Math.hypot(a, b);
        rotation = delta >= 0 ? Math.atan2(-b, a) : Math.atan2(b, a);
        scale = [r * sxSign, delta / r];
        skew = [Math.atan((a * c + b * d) / (r * r)) * sxSign, 0];
    } else if (c !== 0 || d !== 0) {
        const s = Math.hypot(c, d);
        rotation = delta >= 0 ? Math.atan2(c, d) : Math.atan2(-c, d);
        scale = [delta / s, s];
    }

    return {
        translation: [rawTx, rawTy],
        scale,
        rotation,
        skew,
        order
    };
}

export function buildGlyphPathFromNodes(
    nodes: Babelfont.Node[],
    target: CanvasRenderingContext2D | Path2D
): number {
    if (!nodes || nodes.length === 0) {
        return -1;
    }

    let startIdx = 0;
    for (let index = 0; index < nodes.length; index++) {
        if (nodes[index].nodetype === 'Move') {
            startIdx = index;
            break;
        }
    }

    for (let index = 0; index < nodes.length; index++) {
        const type = nodes[index].nodetype;
        if (
            startIdx === 0 &&
            (type === 'Curve' || type === 'QCurve' || type === 'Line')
        ) {
            startIdx = index;
            break;
        }
    }

    if (!isOnCurve(nodes[startIdx])) {
        for (let index = 0; index < nodes.length; index++) {
            if (isOnCurve(nodes[index])) {
                startIdx = index;
                break;
            }
        }
    }

    const contour = nodes
        .slice(startIdx)
        .concat(nodes.slice(0, startIdx)) as Babelfont.Node[];
    if (contour.length === 0) {
        return -1;
    }

    const { x: startX, y: startY } = contour[0];
    target.moveTo(startX, startY);

    let currentIndex = 0;
    let guard = 0;
    const guardLimit = contour.length * 4;

    while (guard < guardLimit) {
        guard += 1;

        const current = contour[currentIndex];
        if (!isOnCurve(current)) {
            currentIndex = (currentIndex + 1) % contour.length;
            if (currentIndex === 0) {
                break;
            }
            continue;
        }

        let nextIndex = (currentIndex + 1) % contour.length;
        const controls: Babelfont.Node[] = [];

        while (nextIndex !== currentIndex) {
            const candidate = contour[nextIndex];
            if (!candidate) {
                break;
            }
            if (candidate.nodetype === 'OffCurve') {
                controls.push(candidate);
                nextIndex = (nextIndex + 1) % contour.length;
                continue;
            }
            break;
        }

        if (nextIndex === currentIndex) {
            break;
        }

        const end = contour[nextIndex];
        if (!end) {
            break;
        }

        if (controls.length === 0) {
            if (end.nodetype !== 'Move') {
                target.lineTo(end.x, end.y);
            }
        } else if (controls.length >= 2 && end.nodetype === 'Curve') {
            const c1 = controls[0];
            const c2 = controls[1];
            target.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        } else {
            for (let index = 0; index < controls.length; index += 1) {
                const control = controls[index];
                const isLastControl = index === controls.length - 1;
                const segmentEnd = isLastControl
                    ? { x: end.x, y: end.y }
                    : {
                          x: (controls[index].x + controls[index + 1].x) / 2,
                          y: (controls[index].y + controls[index + 1].y) / 2
                      };

                target.quadraticCurveTo(
                    control.x,
                    control.y,
                    segmentEnd.x,
                    segmentEnd.y
                );
            }
        }

        currentIndex = nextIndex;
        if (currentIndex === 0) {
            break;
        }
    }

    return startIdx;
}

export function calculateGlyphPathBounds(pathData: {
    nodes?: Unsafe[];
    closed?: boolean;
}): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
} | null {
    if (!pathData?.nodes) {
        return null;
    }

    const nodes = pathData.nodes as Babelfont.Node[];
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return null;
    }

    const onCurveIndices = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => isOnCurve(node));
    if (onCurveIndices.length === 0) {
        return null;
    }

    const segmentCount =
        pathData.closed === false
            ? onCurveIndices.length - 1
            : onCurveIndices.length;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const includePoint = (x: number, y: number) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const current = onCurveIndices[segmentIndex];
        const next = onCurveIndices[(segmentIndex + 1) % onCurveIndices.length];
        if (
            !next ||
            (!pathData.closed && segmentIndex === onCurveIndices.length - 1)
        ) {
            continue;
        }

        const controls: Babelfont.Node[] = [];
        let cursor = (current.index + 1) % nodes.length;
        while (cursor !== next.index) {
            const node = nodes[cursor];
            if (node) {
                controls.push(node);
            }
            cursor = (cursor + 1) % nodes.length;
            if (!pathData.closed && cursor === 0) {
                break;
            }
        }

        if (controls.length === 0) {
            includePoint(current.node.x, current.node.y);
            includePoint(next.node.x, next.node.y);
            continue;
        }

        const nextNodeType = getGlyphNodeType(next.node);
        if (
            controls.length >= 2 &&
            (nextNodeType === 'c' || nextNodeType === 'curve')
        ) {
            const p0 = current.node;
            const p1 = controls[0];
            const p2 = controls[1];
            const p3 = next.node;
            includePoint(p0.x, p0.y);
            includePoint(p3.x, p3.y);
            for (const t of collectCubicExtrema(p0.x, p1.x, p2.x, p3.x)) {
                includePoint(
                    calculateCubicAt(p0.x, p1.x, p2.x, p3.x, t),
                    calculateCubicAt(p0.y, p1.y, p2.y, p3.y, t)
                );
            }
            for (const t of collectCubicExtrema(p0.y, p1.y, p2.y, p3.y)) {
                includePoint(
                    calculateCubicAt(p0.x, p1.x, p2.x, p3.x, t),
                    calculateCubicAt(p0.y, p1.y, p2.y, p3.y, t)
                );
            }
            continue;
        }

        const quadraticEndpoints = [current.node, ...controls, next.node];
        for (let index = 0; index < controls.length; index += 1) {
            const control = controls[index];
            const isLastControl = index === controls.length - 1;
            const segmentEnd = isLastControl
                ? { x: next.node.x, y: next.node.y }
                : {
                      x:
                          (quadraticEndpoints[index + 1].x +
                              quadraticEndpoints[index + 2].x) /
                          2,
                      y:
                          (quadraticEndpoints[index + 1].y +
                              quadraticEndpoints[index + 2].y) /
                          2
                  };
            const segmentStart =
                index === 0
                    ? { x: current.node.x, y: current.node.y }
                    : {
                          x: (quadraticEndpoints[index].x + control.x) / 2,
                          y: (quadraticEndpoints[index].y + control.y) / 2
                      };

            includePoint(segmentStart.x, segmentStart.y);
            includePoint(segmentEnd.x, segmentEnd.y);
            for (const t of collectQuadraticExtrema(
                segmentStart.x,
                control.x,
                segmentEnd.x
            )) {
                includePoint(
                    calculateQuadraticAt(
                        segmentStart.x,
                        control.x,
                        segmentEnd.x,
                        t
                    ),
                    calculateQuadraticAt(
                        segmentStart.y,
                        control.y,
                        segmentEnd.y,
                        t
                    )
                );
            }
            for (const t of collectQuadraticExtrema(
                segmentStart.y,
                control.y,
                segmentEnd.y
            )) {
                includePoint(
                    calculateQuadraticAt(
                        segmentStart.x,
                        control.x,
                        segmentEnd.x,
                        t
                    ),
                    calculateQuadraticAt(
                        segmentStart.y,
                        control.y,
                        segmentEnd.y,
                        t
                    )
                );
            }
        }
    }

    if (!Number.isFinite(minX)) {
        for (const { node } of onCurveIndices) {
            includePoint(node.x, node.y);
        }
    }

    return boundsFromMinMax(minX, minY, maxX, maxY);
}

export function calculateGlyphShapeBounds(
    shapes: Unsafe[] | undefined,
    parentTransform: number[] = IDENTITY_AFFINE as unknown as number[]
): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
} | null {
    if (!Array.isArray(shapes) || shapes.length === 0) {
        return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const includeBounds = (
        bounds:
            | {
                  minX: number;
                  minY: number;
                  maxX: number;
                  maxY: number;
              }
            | null
            | undefined
    ) => {
        if (!bounds) {
            return;
        }
        minX = Math.min(minX, bounds.minX);
        minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX);
        maxY = Math.max(maxY, bounds.maxY);
    };

    for (const shape of shapes) {
        if (!shape || typeof shape !== 'object') {
            continue;
        }

        const pathData =
            'nodes' in shape
                ? shape
                : 'Path' in shape && shape.Path
                  ? shape.Path
                  : 'Contour' in shape && shape.Contour
                    ? shape.Contour
                    : null;

        if (pathData?.nodes) {
            const nodes = pathData.nodes as Babelfont.Node[];
            if (Array.isArray(nodes) && nodes.length > 0) {
                const transformedNodes = nodes.map((node: Unsafe) =>
                    transformNode(node, parentTransform)
                );
                includeBounds(
                    calculateGlyphPathBounds({
                        nodes: transformedNodes,
                        closed: pathData.closed
                    })
                );
            }
            continue;
        }

        const componentData =
            'reference' in shape
                ? shape
                : 'Component' in shape && shape.Component
                  ? shape.Component
                  : null;

        if (!componentData) {
            continue;
        }

        const reference =
            typeof componentData.reference === 'string'
                ? componentData.reference
                : '';
        const nestedShapes = componentData.layerData?.shapes as
            Unsafe[] | undefined;
        const componentTransform = Array.isArray(componentData.transform)
            ? normalizeAffineTransform(componentData.transform)
            : normalizeAffineTransform(
                  componentData.transform || createIdentityDecomposedAffine()
              );
        const composed = composeTransforms(parentTransform, componentTransform);
        const nestedBounds =
            Array.isArray(nestedShapes) && nestedShapes.length
                ? calculateGlyphShapeBounds(nestedShapes, composed)
                : null;
        if (nestedBounds) {
            includeBounds(nestedBounds);
            continue;
        }
        const standIn = reference ? glyphStandInContours?.(reference) : null;
        if (!standIn?.length) {
            continue;
        }
        for (const contour of standIn) {
            if (!contour.nodes?.length) {
                continue;
            }
            includeBounds(
                calculateGlyphPathBounds({
                    nodes: contour.nodes.map((node) =>
                        transformNode(node, composed)
                    ),
                    closed: contour.closed
                })
            );
        }
    }

    return boundsFromMinMax(minX, minY, maxX, maxY);
}
