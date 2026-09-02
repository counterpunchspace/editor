export type PunchFillContour = {
    nodes: Array<{ x: number; y: number }>;
    subtract: boolean;
    fillStyle: string;
};

export type PunchFillPathBuilder = (
    ctx: CanvasRenderingContext2D,
    nodes: PunchFillContour['nodes']
) => void;

function addClosedContours(
    ctx: CanvasRenderingContext2D,
    contours: PunchFillContour[],
    buildClosedPath: PunchFillPathBuilder
): void {
    ctx.beginPath();
    for (const contour of contours) {
        buildClosedPath(ctx, contour.nodes);
    }
}

function paintContourFills(
    ctx: CanvasRenderingContext2D,
    contours: PunchFillContour[],
    buildClosedPath: PunchFillPathBuilder
): void {
    for (const contour of contours) {
        ctx.beginPath();
        buildClosedPath(ctx, contour.nodes);
        ctx.fillStyle = contour.fillStyle;
        ctx.fill('nonzero');
    }
}

function punchCoverage(
    ctx: CanvasRenderingContext2D,
    nodes: PunchFillContour['nodes'],
    buildClosedPath: PunchFillPathBuilder
): void {
    ctx.beginPath();
    buildClosedPath(ctx, nodes);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fill('nonzero');
    ctx.restore();
}

/**
 * Paint additive contours as one NonZero compound (direction punches
 * counters, including across path/component fill colors), then apply
 * subtraction cutters in shape order.
 */
export function fillPunchFillContoursOnContext(
    ctx: CanvasRenderingContext2D,
    contours: PunchFillContour[],
    buildClosedPath: PunchFillPathBuilder,
    subtractionFillStyle?: string | null
): void {
    if (!contours.length) {
        return;
    }

    const additives = contours.filter((contour) => !contour.subtract);
    paintContourFills(ctx, additives, buildClosedPath);
    if (additives.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-in';
        addClosedContours(ctx, additives, buildClosedPath);
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fill('nonzero');
        ctx.restore();
    }

    for (let index = 0; index < contours.length; index++) {
        const contour = contours[index];
        if (!contour.subtract) {
            continue;
        }
        punchCoverage(ctx, contour.nodes, buildClosedPath);
        if (subtractionFillStyle) {
            ctx.beginPath();
            buildClosedPath(ctx, contour.nodes);
            ctx.fillStyle = subtractionFillStyle;
            ctx.fill('nonzero');
        }
        const laterAdditives = contours
            .slice(index + 1)
            .filter((item) => !item.subtract);
        if (!laterAdditives.length) {
            continue;
        }
        ctx.save();
        ctx.beginPath();
        buildClosedPath(ctx, contour.nodes);
        ctx.clip();
        if (additives.length) {
            addClosedContours(ctx, additives, buildClosedPath);
            ctx.clip('nonzero');
        }
        paintContourFills(ctx, laterAdditives, buildClosedPath);
        ctx.restore();
    }
}
