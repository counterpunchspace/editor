import type { Glyph } from '../babelfont-model';
import type { QaLabel } from './auto-qa-matcher';

type Point = { x: number; y: number };

type Contour = {
    points: Point[];
    area: number;
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
};

/**
 * Twice the signed area of the control polygon. Positive is
 * counter-clockwise in the y-up font coordinate system. Off-curves are
 * included so a contour with only two on-curves still has an area.
 */
function signedArea(points: Point[]): number {
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        area += a.x * b.y - b.x * a.y;
    }
    return area;
}

function containsPoint(polygon: Point[], point: Point): boolean {
    let inside = false;
    for (
        let index = 0, previous = polygon.length - 1;
        index < polygon.length;
        previous = index++
    ) {
        const a = polygon[index];
        const b = polygon[previous];
        if (
            a.y > point.y !== b.y > point.y &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        ) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * A contour is nested in another only when all its points lie inside it.
 * Overlapping strokes, which share only some points, are not nested.
 */
function isNestedIn(inner: Contour, outer: Contour): boolean {
    // the bounding-box test rejects most pairs before any point test
    return (
        inner.xMin >= outer.xMin &&
        inner.xMax <= outer.xMax &&
        inner.yMin >= outer.yMin &&
        inner.yMax <= outer.yMax &&
        Math.abs(inner.area) < Math.abs(outer.area) &&
        inner.points.every((point) => containsPoint(outer.points, point))
    );
}

function toContour(path: { nodes: Point[] }): Contour | null {
    const points = path.nodes.map((node) => ({ x: node.x, y: node.y }));
    const area = signedArea(points);
    if (area === 0) {
        return null;
    }
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (const { x, y } of points) {
        xMin = Math.min(xMin, x);
        yMin = Math.min(yMin, y);
        xMax = Math.max(xMax, x);
        yMax = Math.max(yMax, y);
    }
    return { points, area, xMin, yMin, xMax, yMax };
}

/**
 * Count the closed contours in one drawing that run the wrong way. Outer
 * contours (even nesting depth) must run counter-clockwise, counters (odd
 * depth) clockwise, whatever the curve type. Counting stops at `limit`.
 */
export function countWrongDirectionContours(
    paths: { closed: boolean; nodes: Point[] }[],
    limit: number = Infinity
): number {
    const contours: Contour[] = [];
    for (const path of paths) {
        if (!path.closed || path.nodes.length < 3) {
            continue;
        }
        const contour = toContour(path);
        if (contour) {
            contours.push(contour);
        }
    }
    let wrong = 0;
    for (const contour of contours) {
        let depth = 0;
        for (const other of contours) {
            if (other !== contour && isNestedIn(contour, other)) {
                depth++;
            }
        }
        const counterClockwise = contour.area > 0;
        if (counterClockwise !== (depth % 2 === 0) && ++wrong >= limit) {
            break;
        }
    }
    return wrong;
}

function foregroundDrawings(glyph: Glyph) {
    // Background drawings are references and are not compiled
    return (glyph.drawings || []).filter((drawing) => !drawing.is_background);
}

/** Whether any foreground drawing has a contour running the wrong way. */
export function hasWrongContourDirection(glyph: Glyph): boolean {
    return foregroundDrawings(glyph).some(
        (drawing) => countWrongDirectionContours(drawing.paths, 1) > 0
    );
}

/**
 * One label when any foreground drawing of the glyph has a contour that
 * runs against the Counterpunch convention.
 */
export function contourDirectionLabels(glyph: Glyph): QaLabel[] {
    let contourCount = 0;
    let drawingCount = 0;
    for (const drawing of foregroundDrawings(glyph)) {
        const wrong = countWrongDirectionContours(drawing.paths);
        if (wrong > 0) {
            contourCount += wrong;
            drawingCount++;
        }
    }
    if (contourCount === 0) {
        return [];
    }
    return [
        {
            glyph_name: glyph.name || '',
            identity: glyph.name || '',
            kind: 'wrong_contour_direction',
            missing: 'contour_direction',
            displayName: '',
            // n counts the wrong contours, k the drawings they are in
            n: contourCount,
            k: drawingCount,
            confidence: 1
        }
    ];
}
