import {
    collectOverviewPunchFillContours,
    fastGlyphTileRenderer
} from '../js/glyph-tile-renderer-fast';
import { rememberPlaceholderDrawing } from '../js/language-packs/placeholder-outlines';

function rect(x0, y0, x1, y1, extra = {}) {
    return {
        closed: true,
        nodes: [
            { x: x0, y: y0, nodetype: 'Line' },
            { x: x1, y: y0, nodetype: 'Line' },
            { x: x1, y: y1, nodetype: 'Line' },
            { x: x0, y: y1, nodetype: 'Line' }
        ],
        ...extra
    };
}

describe('overview tile punch-out', () => {
    test('collects subtraction cutters in shape order including components', () => {
        const contours = collectOverviewPunchFillContours(
            [
                rect(0, 0, 400, 700),
                {
                    ...rect(80, 80, 200, 200),
                    format_specific: { 'fip001-boolean': 'subtraction' }
                },
                {
                    reference: 'dot',
                    transform: [1, 0, 0, 1, 10, 0],
                    layerData: {
                        shapes: [rect(0, 0, 50, 50)]
                    }
                }
            ],
            [1, 0, 0, 1, 0, 0],
            'path',
            () => 'component'
        );

        expect(contours.map((contour) => contour.subtract)).toEqual([
            false,
            true,
            false
        ]);
        expect(contours[0].fillStyle).toBe('path');
        expect(contours[1].fillStyle).toBe('path');
        expect(contours[2].fillStyle).toBe('component');
        expect(contours[2].nodes[0].x).toBe(10);
    });

    test('an empty component uses the placeholder drawing as component fill', () => {
        const previous = window.currentFontModel;
        window.currentFontModel = {
            upm: 1000,
            findGlyph(name) {
                if (name === 'base') {
                    return { layers: [{ paths: [] }] };
                }
                return null;
            }
        };
        rememberPlaceholderDrawing('base', {
            upm: 1000,
            width: 100,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 100, y: 80, nodetype: 'Line' }
                    ]
                }
            ],
            anchors: []
        });

        const contours = collectOverviewPunchFillContours(
            [
                {
                    reference: 'base',
                    transform: [1, 0, 0, 1, 20, 5]
                }
            ],
            [1, 0, 0, 1, 0, 0],
            'path',
            () => 'component'
        );

        window.currentFontModel = previous;
        expect(contours).toHaveLength(1);
        expect(contours[0].fillStyle).toBe('component');
        expect(contours[0].subtract).toBe(false);
        expect(contours[0].nodes[0]).toMatchObject({ x: 20, y: 5 });
        expect(contours[0].nodes[1]).toMatchObject({ x: 120, y: 5 });
    });

    test('renderToCanvas punches cutters with destination-out', () => {
        const canvas = fastGlyphTileRenderer.renderToCanvas(
            {
                name: 'A',
                width: 400,
                shapes: [
                    rect(0, 0, 400, 700),
                    {
                        ...rect(80, 80, 200, 200),
                        format_specific: { 'fip001-boolean': 'subtraction' }
                    }
                ]
            },
            { upm: 1000, ascender: 800, descender: -200 },
            64,
            80
        );
        const events = canvas.getContext('2d').__getEvents();
        expect(
            events.some(
                (event) =>
                    event.type === 'globalCompositeOperation' &&
                    event.props?.value === 'destination-out'
            )
        ).toBe(true);
        expect(
            events.some(
                (event) =>
                    event.type === 'globalCompositeOperation' &&
                    event.props?.value === 'destination-in'
            )
        ).toBe(true);
    });

    test('unifies path and component fills before punching a cutter', () => {
        const canvas = fastGlyphTileRenderer.renderToCanvas(
            {
                name: 'A',
                width: 400,
                shapes: [
                    rect(0, 0, 400, 700),
                    {
                        reference: 'dot',
                        transform: [1, 0, 0, 1, 80, 80],
                        layerData: {
                            shapes: [rect(0, 0, 40, 40)]
                        }
                    },
                    {
                        ...rect(200, 100, 280, 400),
                        format_specific: { 'fip001-boolean': 'subtraction' }
                    }
                ]
            },
            { upm: 1000, ascender: 800, descender: -200 },
            64,
            80
        );
        const ops = canvas
            .getContext('2d')
            .__getEvents()
            .filter((event) => event.type === 'globalCompositeOperation')
            .map((event) => event.props?.value);
        expect(ops[0]).toBe('destination-in');
        expect(ops).toContain('destination-out');
    });
});
