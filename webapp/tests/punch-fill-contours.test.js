import { fillPunchFillContoursOnContext } from '../js/punch-fill-contours';

function rectNodes(x0, y0, x1, y1) {
    return [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 }
    ];
}

function buildClosedPath(ctx, nodes) {
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (let index = 1; index < nodes.length; index++) {
        ctx.lineTo(nodes[index].x, nodes[index].y);
    }
    ctx.closePath();
}

function compositeOps(canvas) {
    return canvas
        .getContext('2d')
        .__getEvents()
        .filter((event) => event.type === 'globalCompositeOperation')
        .map((event) => event.props?.value);
}

describe('punch-fill nonzero additives', () => {
    test('unifies mixed-color additives with destination-in before cutters', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        fillPunchFillContoursOnContext(
            ctx,
            [
                {
                    nodes: rectNodes(0, 0, 40, 40),
                    subtract: false,
                    fillStyle: 'path'
                },
                {
                    nodes: rectNodes(10, 10, 20, 20),
                    subtract: false,
                    fillStyle: 'component'
                },
                {
                    nodes: rectNodes(5, 5, 15, 35),
                    subtract: true,
                    fillStyle: 'path'
                }
            ],
            buildClosedPath,
            'cutter'
        );

        const ops = compositeOps(canvas);
        expect(ops).toContain('destination-in');
        expect(ops).toContain('destination-out');
        expect(ops.indexOf('destination-in')).toBeLessThan(
            ops.indexOf('destination-out')
        );
    });

    test('paints later additives after a cutter without a second destination-in', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        fillPunchFillContoursOnContext(
            ctx,
            [
                {
                    nodes: rectNodes(0, 0, 40, 40),
                    subtract: false,
                    fillStyle: 'path'
                },
                {
                    nodes: rectNodes(15, 0, 25, 40),
                    subtract: true,
                    fillStyle: 'path'
                },
                {
                    nodes: rectNodes(10, 10, 20, 20),
                    subtract: false,
                    fillStyle: 'path'
                }
            ],
            buildClosedPath
        );

        expect(
            compositeOps(canvas).filter((value) => value === 'destination-in')
        ).toHaveLength(1);
        expect(compositeOps(canvas)).toContain('destination-out');
    });
});
