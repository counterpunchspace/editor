const { parseSvg } = require('../js/clipboard/svg');
const {
    parseCounterpunchJson,
    glyphsClosedPathToStartFirst
} = require('../js/clipboard/json');
const {
    parseClipboardPayloads,
    classifyClipboardPayloads,
    applyPasteFragment,
    applyPasteGlyphsDocument
} = require('../js/clipboard');

/** Wrap a Counterpunch vendor document in the font-editor clipboard envelope. */
function wireEnvelope(counterpunchItem) {
    return {
        clipboardSchema: 'font-editor-clipboard',
        clipboardSchemaVersion: 1,
        clipboardItems: {
            counterpunch: counterpunchItem
        }
    };
}

describe('clipboard SVG converter', () => {
    test('parses SVG compound path into separate closed contours and flips Y', () => {
        const payload = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 470 508">
  <path d="M235,480c-119,0-205-91-205-226S116,28,235,28s205,91,205,226-86,226-205,226ZM235,508c137,0,235-103,235-254S372,0,235,0,0,103,0,254s98,254,235,254Z"/>
</svg>`;
        const fragment = parseSvg(payload);
        expect(fragment.format).toBe('svg');
        expect(fragment.paths.length).toBe(2);
        expect(fragment.paths[0].closed).toBe(true);
        expect(fragment.paths[1].closed).toBe(true);
        expect(fragment.keepAbsoluteCoords).toBe(false);

        // Closed contours must not keep a duplicate end oncurve on the start.
        for (const path of fragment.paths) {
            const onCurves = path.nodes.filter(
                (node) => node.nodetype !== 'OffCurve'
            );
            expect(onCurves.length).toBeGreaterThan(1);
            const first = onCurves[0];
            const last = onCurves[onCurves.length - 1];
            expect(first.x === last.x && first.y === last.y).toBe(false);
            // Leading oncurve after trailing offcurves should be Curve, not Line.
            expect(path.nodes[0].nodetype).toBe('Curve');
        }

        const allY = fragment.paths.flatMap((path) =>
            path.nodes.map((node) => node.y)
        );
        expect(Math.min(...allY)).toBeCloseTo(0, 5);
        expect(Math.max(...allY)).toBeCloseTo(508, 5);
    });

    test('leaves paths open when SVG has no Z closepath', () => {
        const payload = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10"/></svg>`;
        const fragment = parseSvg(payload);
        expect(fragment.paths).toHaveLength(1);
        expect(fragment.paths[0].closed).toBe(false);
    });

    test('detects SVG from text/plain payloads', () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10Z"/></svg>`;
        const parsed = parseClipboardPayloads([
            { type: 'text/plain', data: svg }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('svg');
        expect(parsed.fragment.paths[0].closed).toBe(true);
    });
});

describe('clipboard paste kind classification', () => {
    test('classifies selection JSON, whole glyphs, and plain text', () => {
        expect(
            classifyClipboardPayloads([
                {
                    type: 'text/plain',
                    data: JSON.stringify(
                        wireEnvelope({
                            version: 1,
                            kind: 'selection',
                            nodeOrder: 'start-first',
                            keepAbsoluteCoords: true,
                            paths: [],
                            components: [],
                            anchors: [{ name: 'top', x: 0, y: 0 }],
                            guides: []
                        })
                    )
                }
            ])
        ).toBe('selection');
        expect(
            classifyClipboardPayloads([
                {
                    type: 'text/plain',
                    data: JSON.stringify(
                        wireEnvelope({
                            version: 1,
                            kind: 'glyphs',
                            nodeOrder: 'start-first',
                            masters: [{ id: 'm0', name: 'Regular' }],
                            glyphs: [
                                {
                                    name: 'A',
                                    leftMetricsKey: null,
                                    rightMetricsKey: null,
                                    layers: [
                                        {
                                            name: 'Regular',
                                            master: {
                                                type: 'DefaultForMaster',
                                                masterIndex: 0
                                            },
                                            width: 500,
                                            paths: [],
                                            components: [],
                                            anchors: [],
                                            guides: []
                                        }
                                    ]
                                }
                            ]
                        })
                    )
                }
            ])
        ).toBe('glyphs');
        expect(
            classifyClipboardPayloads([{ type: 'text/plain', data: 'hello' }])
        ).toBe('text');
        expect(classifyClipboardPayloads([])).toBe('empty');
    });
});

describe('clipboard Counterpunch JSON converter', () => {
    const selectionPayload = {
        version: 1,
        kind: 'selection',
        nodeOrder: 'start-first',
        keepAbsoluteCoords: true,
        paths: [
            {
                closed: true,
                nodes: [
                    { x: 10, y: 20, nodetype: 'Line' },
                    { x: 110, y: 20, nodetype: 'Line' },
                    { x: 110, y: 120, nodetype: 'Curve', smooth: true },
                    { x: 60, y: 140, nodetype: 'OffCurve' },
                    { x: 10, y: 120, nodetype: 'OffCurve' }
                ]
            }
        ],
        components: [
            {
                reference: 'a',
                x: 5,
                y: 6,
                alignment: 1,
                transform: [0.5, 0.1, -0.2, 0.8, 5, 6]
            }
        ],
        anchors: [{ name: 'top', x: 50, y: 200 }],
        guides: [{ name: 'g1', x: 0, y: 100, angle: 0, global: false }]
    };

    test('parses selection JSON', () => {
        const parsed = parseCounterpunchJson(
            JSON.stringify(wireEnvelope(selectionPayload))
        );
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.keepAbsoluteCoords).toBe(true);
        expect(parsed.fragment.paths).toHaveLength(1);
        expect(parsed.fragment.paths[0].nodes).toHaveLength(5);
        expect(parsed.fragment.components[0].reference).toBe('a');
        expect(parsed.fragment.components[0].transform).toEqual([
            0.5, 0.1, -0.2, 0.8, 5, 6
        ]);
        expect(parsed.fragment.anchors[0].name).toBe('top');
        expect(parsed.fragment.guides[0].y).toBe(100);
    });

    test('rotates Glyphs closed-path start node to index 0', () => {
        // Original Glyphs pasteboard order for outer /o (start = last oncurve).
        const glyphsOrder = [
            { x: 422, y: -8, nodetype: 'OffCurve' },
            { x: 520, y: 95, nodetype: 'OffCurve' },
            { x: 520, y: 246, nodetype: 'Curve', smooth: true },
            { x: 520, y: 397, nodetype: 'OffCurve' },
            { x: 422, y: 500, nodetype: 'OffCurve' },
            { x: 285, y: 500, nodetype: 'Curve', smooth: true },
            { x: 148, y: 500, nodetype: 'OffCurve' },
            { x: 50, y: 397, nodetype: 'OffCurve' },
            { x: 50, y: 246, nodetype: 'Curve', smooth: true },
            { x: 50, y: 95, nodetype: 'OffCurve' },
            { x: 148, y: -8, nodetype: 'OffCurve' },
            { x: 285, y: -8, nodetype: 'Curve', smooth: true }
        ];

        expect(glyphsClosedPathToStartFirst(glyphsOrder)[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });

        const parsed = parseCounterpunchJson(
            JSON.stringify(
                wireEnvelope({
                    version: 1,
                    kind: 'selection',
                    keepAbsoluteCoords: true,
                    paths: [{ closed: true, nodes: glyphsOrder }]
                })
            )
        );
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.paths[0].nodes[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });
        expect(parsed.fragment.paths[0].nodes[1]).toMatchObject({
            x: 422,
            y: -8,
            nodetype: 'OffCurve'
        });
    });

    test('prefers Counterpunch JSON over SVG on text/plain', () => {
        const parsed = parseClipboardPayloads([
            {
                type: 'text/plain',
                data: JSON.stringify(wireEnvelope(selectionPayload))
            },
            {
                type: 'image/svg+xml',
                data: `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10Z"/></svg>`
            }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.paths[0].nodes[0].x).toBe(10);
    });

    test('recovers Counterpunch JSON embedded in SVG metadata', () => {
        const { serializePathsToSvg } = require('../js/clipboard/svg');
        const json = JSON.stringify(wireEnvelope(selectionPayload));
        const svg = serializePathsToSvg(selectionPayload.paths, {
            embeddedJson: json
        });
        expect(svg).toContain('counterpunch-clipboard');
        const parsed = parseClipboardPayloads([
            { type: 'text/plain', data: svg }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.paths[0].nodes[0].x).toBe(10);
    });

    test('parses whole-glyph JSON', () => {
        const payload = {
            version: 1,
            kind: 'glyphs',
            nodeOrder: 'start-first',
            masters: [
                { id: 'm0', name: 'Regular' },
                { id: 'm1', name: 'Bold' }
            ],
            glyphs: [
                {
                    name: 'o',
                    leftMetricsKey: '=o',
                    rightMetricsKey: null,
                    layers: [
                        {
                            name: 'Regular',
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 0
                            },
                            width: 500,
                            paths: [
                                {
                                    closed: true,
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ]
                                }
                            ],
                            components: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            name: 'Bold',
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 1
                            },
                            width: 560,
                            paths: [
                                {
                                    closed: true,
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 120, y: 0, nodetype: 'Line' }
                                    ]
                                }
                            ],
                            components: [],
                            anchors: [{ name: 'top', x: 60, y: 700 }],
                            guides: []
                        }
                    ]
                }
            ]
        };
        const parsed = parseCounterpunchJson(
            JSON.stringify(wireEnvelope(payload))
        );
        expect(parsed.kind).toBe('glyphs');
        expect(parsed.document.masters).toHaveLength(2);
        expect(parsed.document.glyphs[0].layers).toHaveLength(2);
        expect(parsed.document.glyphs[0].layers[1].width).toBe(560);
        expect(parsed.document.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            masterIndex: 0
        });
        expect(
            parsed.document.glyphs[0].layers[0].paths[0].nodes[0]
        ).toMatchObject({ x: 0, y: 0 });
    });

    test('rejects whole-glyph JSON without masters metadata', () => {
        const payload = {
            version: 1,
            kind: 'glyphs',
            glyphs: [
                {
                    name: 'o',
                    layers: [
                        {
                            paths: [],
                            components: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        expect(
            parseCounterpunchJson(JSON.stringify(wireEnvelope(payload)))
        ).toBeNull();
    });

    test('rejects legacy bare counterpunch-clipboard root objects', () => {
        expect(
            parseCounterpunchJson(
                JSON.stringify({
                    format: 'counterpunch-clipboard',
                    version: 1,
                    kind: 'selection',
                    paths: [
                        {
                            closed: true,
                            nodes: [{ x: 0, y: 0, nodetype: 'Line' }]
                        }
                    ]
                })
            )
        ).toBeNull();
    });
});

describe('applyPasteFragment', () => {
    function makeDrawing({ linked = true, background = false } = {}) {
        const anchors = [];
        const guides = [];
        const shapes = [];
        const drawing = {
            is_background: background,
            linked,
            width: 600,
            anchors,
            guides,
            shapes,
            paths: [],
            addPath(closed) {
                const path = {
                    closed,
                    nodes: [],
                    set nodes(value) {
                        this._nodes = value;
                    },
                    get nodes() {
                        return this._nodes || [];
                    }
                };
                shapes.push({
                    isPath: () => true,
                    asPath: () => path
                });
                this.paths.push(path);
                return path;
            },
            addComponent(reference, transform) {
                const component = {
                    reference,
                    transform: transform || [1, 0, 0, 1, 0, 0],
                    automaticAlignment: false,
                    anchor: undefined
                };
                shapes.push({
                    isPath: () => false,
                    isComponent: () => true,
                    asComponent: () => component
                });
                this.components = this.components || [];
                this.components.push(component);
                return component;
            },
            addAnchor(x, y, name) {
                const anchor = { name, x, y };
                anchors.push(anchor);
                return anchor;
            },
            addGuide(pos, name) {
                const guide = { pos, name };
                guides.push(guide);
                return guide;
            },
            _getLinkedDrawings() {
                return linked ? this._linked || [] : [];
            }
        };
        return drawing;
    }

    test('fans out paths to linked layers', () => {
        const active = makeDrawing({ linked: true });
        const linked = makeDrawing({ linked: true });
        active._linked = [linked];

        applyPasteFragment(
            {
                format: 'svg',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 100, y: 0, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            },
            {
                activeDrawing: active,
                linkedDrawings: [linked],
                master: null,
                drawingWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        expect(active.paths).toHaveLength(1);
        expect(linked.paths).toHaveLength(1);
        expect(active.paths[0].closed).toBe(true);
    });

    test('centers SVG paste in the layer', () => {
        const active = makeDrawing({ linked: false });
        applyPasteFragment(
            {
                format: 'svg',
                keepAbsoluteCoords: false,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 100, y: 0, nodetype: 'Line' },
                            { x: 100, y: 100, nodetype: 'Line' },
                            { x: 0, y: 100, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            },
            {
                activeDrawing: active,
                linkedDrawings: [],
                master: null,
                drawingWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        const xs = active.paths[0].nodes.map((node) => node.x);
        const ys = active.paths[0].nodes.map((node) => node.y);
        const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
        expect(midX).toBeCloseTo(300, 5);
        expect(midY).toBeCloseTo(300, 5);
    });

    test('keeps absolute coords for Counterpunch JSON selection', () => {
        const active = makeDrawing({ linked: false });
        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 10, y: 20, nodetype: 'Line' },
                            { x: 110, y: 20, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [{ name: 'top', x: 50, y: 200 }],
                guides: []
            },
            {
                activeDrawing: active,
                linkedDrawings: [],
                master: null,
                drawingWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        expect(active.paths[0].nodes[0]).toMatchObject({ x: 10, y: 20 });
        expect(active.anchors[0]).toMatchObject({
            name: 'top',
            x: 50,
            y: 200
        });
    });

    test('updates existing anchor on active layer only', () => {
        const active = makeDrawing({ linked: true });
        const linked = makeDrawing({ linked: true });
        active.addAnchor(1, 2, 'top');
        linked.addAnchor(3, 4, 'top');

        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [],
                components: [],
                anchors: [{ name: 'top', x: 99, y: 88 }],
                guides: []
            },
            {
                activeDrawing: active,
                linkedDrawings: [linked],
                master: null,
                drawingWidth: 600,
                verticalMetrics: null,
                glyphExists: () => true
            }
        );

        expect(active.anchors[0]).toMatchObject({ x: 99, y: 88 });
        expect(linked.anchors[0]).toMatchObject({ x: 3, y: 4 });
    });

    test('preserves component affine transform on paste', () => {
        const active = makeDrawing({ linked: false });
        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [],
                components: [
                    {
                        reference: 'dieresiscomb',
                        x: 100,
                        y: 200,
                        alignment: 0,
                        transform: [0.5, 0.1, -0.2, 0.75, 100, 200],
                        anchor: 'top'
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                activeDrawing: active,
                linkedDrawings: [],
                master: null,
                drawingWidth: 600,
                verticalMetrics: null,
                glyphExists: () => true
            }
        );

        expect(active.components).toHaveLength(1);
        expect(active.components[0].transform).toEqual([
            0.5, 0.1, -0.2, 0.75, 100, 200
        ]);
        expect(active.components[0].automaticAlignment).toBe(false);
        expect(active.components[0].anchor).toBe('top');
    });

    test('pastes components onto a background layer and skips anchors', () => {
        const background = makeDrawing({ linked: false, background: true });
        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [],
                components: [
                    {
                        reference: 'dieresiscomb',
                        x: 10,
                        y: 20,
                        alignment: 1,
                        transform: [1, 0, 0, 1, 10, 20]
                    }
                ],
                anchors: [{ name: 'top', x: 50, y: 200 }],
                guides: []
            },
            {
                activeDrawing: background,
                linkedDrawings: [],
                master: null,
                drawingWidth: 600,
                verticalMetrics: null,
                glyphExists: () => true
            }
        );

        expect(background.components).toHaveLength(1);
        expect(background.components[0].reference).toBe('dieresiscomb');
        expect(background.components[0].automaticAlignment).toBe(false);
        expect(background.anchors).toHaveLength(0);
    });
});

describe('applyReplaceSelectedPaths', () => {
    const {
        applyReplaceSelectedPaths,
        arePastePathsStructurallyCompatible
    } = require('../js/clipboard');

    function makeMutablePath(closed, nodes) {
        return {
            closed,
            _nodes: nodes.map((node) => ({ ...node })),
            get nodes() {
                return this._nodes;
            },
            set nodes(value) {
                this._nodes = value;
            }
        };
    }

    function makeDrawingWithAnchors(anchorList) {
        const anchors = anchorList.map((anchor) => ({ ...anchor }));
        return {
            anchors,
            addAnchor() {
                throw new Error('should not create anchors during replace');
            }
        };
    }

    test('replaces compatible path geometry on the given paths only', () => {
        const path = makeMutablePath(true, [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 10, y: 0, nodetype: 'Line' },
            { x: 10, y: 10, nodetype: 'Line' }
        ]);
        const linkedPath = makeMutablePath(true, [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 10, y: 0, nodetype: 'Line' },
            { x: 10, y: 10, nodetype: 'Line' }
        ]);
        const active = makeDrawingWithAnchors([{ name: 'top', x: 5, y: 20 }]);

        const result = applyReplaceSelectedPaths({
            activeDrawing: active,
            selectedPaths: [path],
            selectedAnchorNames: [],
            fragment: {
                format: 'fontra-json',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 100, y: 200, nodetype: 'Line' },
                            { x: 110, y: 200, nodetype: 'Line' },
                            { x: 110, y: 210, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [{ name: 'top', x: 50, y: 80 }],
                guides: []
            }
        });

        expect(result.error).toBeUndefined();
        expect(result.replacedPathCount).toBe(1);
        expect(result.updatedAnchorCount).toBe(0);
        expect(path.nodes.map((node) => [node.x, node.y])).toEqual([
            [100, 200],
            [110, 200],
            [110, 210]
        ]);
        // Linked sibling path untouched (caller never passes it).
        expect(linkedPath.nodes[0].x).toBe(0);
        // Unselected anchor unchanged.
        expect(active.anchors[0]).toEqual({ name: 'top', x: 5, y: 20 });
    });

    test('updates selected anchors only', () => {
        const path = makeMutablePath(false, [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 1, y: 1, nodetype: 'Line' }
        ]);
        const active = makeDrawingWithAnchors([
            { name: 'top', x: 5, y: 20 },
            { name: 'bottom', x: 5, y: 0 }
        ]);

        const result = applyReplaceSelectedPaths({
            activeDrawing: active,
            selectedPaths: [path],
            selectedAnchorNames: ['top'],
            fragment: {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: false,
                        nodes: [
                            { x: 9, y: 9, nodetype: 'Line' },
                            { x: 8, y: 8, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [
                    { name: 'top', x: 50, y: 80 },
                    { name: 'bottom', x: 50, y: -10 }
                ],
                guides: []
            }
        });

        expect(result.error).toBeUndefined();
        expect(result.updatedAnchorCount).toBe(1);
        expect(active.anchors[0]).toEqual({ name: 'top', x: 50, y: 80 });
        expect(active.anchors[1]).toEqual({ name: 'bottom', x: 5, y: 0 });
    });

    test('rejects incompatible structure or path-count mismatch', () => {
        const path = makeMutablePath(true, [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 10, y: 0, nodetype: 'Line' }
        ]);
        const active = makeDrawingWithAnchors([]);

        expect(
            arePastePathsStructurallyCompatible(path, {
                closed: true,
                nodes: [
                    { nodetype: 'Line' },
                    { nodetype: 'OffCurve' },
                    { nodetype: 'OffCurve' },
                    { nodetype: 'Curve' }
                ]
            })
        ).toBe(false);

        const badStructure = applyReplaceSelectedPaths({
            activeDrawing: active,
            selectedPaths: [path],
            selectedAnchorNames: [],
            fragment: {
                format: 'svg',
                keepAbsoluteCoords: false,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 1, y: 0, nodetype: 'OffCurve' },
                            { x: 2, y: 0, nodetype: 'OffCurve' },
                            { x: 3, y: 0, nodetype: 'Curve' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            }
        });
        expect(badStructure.error).toMatch(/not structurally compatible/);

        const badCount = applyReplaceSelectedPaths({
            activeDrawing: active,
            selectedPaths: [path],
            selectedAnchorNames: [],
            fragment: {
                format: 'svg',
                keepAbsoluteCoords: false,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 10, y: 0, nodetype: 'Line' }
                        ]
                    },
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 10, y: 0, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            }
        });
        expect(badCount.error).toMatch(/Counts must match/);
    });

    test('accepts closed paths with rotated start and preserves local start', () => {
        const path = makeMutablePath(true, [
            { x: 1, y: 1, nodetype: 'OffCurve' },
            { x: 2, y: 2, nodetype: 'OffCurve' },
            { x: 3, y: 3, nodetype: 'Curve' },
            { x: 4, y: 4, nodetype: 'OffCurve' },
            { x: 5, y: 5, nodetype: 'OffCurve' },
            { x: 6, y: 6, nodetype: 'Curve' }
        ]);
        const active = makeDrawingWithAnchors([
            { name: 'top', x: 0, y: 0 },
            { name: 'bottom', x: 0, y: 0 }
        ]);

        // Same contour as clipboard, but starts on a Curve (Fontra-style).
        const result = applyReplaceSelectedPaths({
            activeDrawing: active,
            selectedPaths: [path],
            selectedAnchorNames: [],
            fragment: {
                format: 'fontra-json',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 30, y: 30, nodetype: 'Curve' },
                            { x: 40, y: 40, nodetype: 'OffCurve' },
                            { x: 50, y: 50, nodetype: 'OffCurve' },
                            { x: 60, y: 60, nodetype: 'Curve' },
                            { x: 10, y: 10, nodetype: 'OffCurve' },
                            { x: 20, y: 20, nodetype: 'OffCurve' }
                        ]
                    }
                ],
                components: [{ reference: 'ignored', x: 0, y: 0 }],
                anchors: [
                    { name: 'top', x: 99, y: 99 },
                    { name: 'bottom', x: 88, y: 88 }
                ],
                guides: []
            }
        });

        expect(result.error).toBeUndefined();
        expect(result.replacedPathCount).toBe(1);
        expect(result.updatedAnchorCount).toBe(0);
        // Rotated so local start (OffCurve,OffCurve,Curve…) is preserved.
        expect(
            path.nodes.map((node) => [node.x, node.y, node.nodetype])
        ).toEqual([
            [10, 10, 'OffCurve'],
            [20, 20, 'OffCurve'],
            [30, 30, 'Curve'],
            [40, 40, 'OffCurve'],
            [50, 50, 'OffCurve'],
            [60, 60, 'Curve']
        ]);
        // Clipboard anchors ignored unless selected.
        expect(active.anchors[0]).toEqual({ name: 'top', x: 0, y: 0 });
    });
});

describe('clipboard Counterpunch JSON serializer', () => {
    const {
        buildSelectionClipboardDocument,
        buildGlyphsClipboardDocument,
        serializeComponentForClipboard,
        serializePathForClipboard,
        stringifyClipboardDocument
    } = require('../js/clipboard/serialize');

    test('serializes selection with start-first node order', () => {
        const document = buildSelectionClipboardDocument({
            glyphName: 'o',
            layerId: 'layer-1',
            paths: [
                serializePathForClipboard({
                    closed: true,
                    nodes: [
                        { x: 285, y: -8, nodetype: 'Curve', smooth: true },
                        { x: 422, y: -8, nodetype: 'OffCurve' }
                    ]
                })
            ],
            components: [
                serializeComponentForClipboard({
                    reference: 'dieresiscomb',
                    transform: { translation: [10, 20], scale: [0.5, 0.5] },
                    automaticAlignment: false
                })
            ],
            anchors: [{ name: 'top', x: 1, y: 2 }],
            guides: []
        });

        expect(document.nodeOrder).toBe('start-first');
        expect(document.kind).toBe('selection');
        expect(document.paths[0].nodes[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });
        expect(document.components[0].transform[4]).toBeCloseTo(10, 5);
        expect(document.components[0].transform[5]).toBeCloseTo(20, 5);
        expect(document.components[0].transform[0]).toBeCloseTo(0.5, 5);

        const roundTrip = parseCounterpunchJson(
            stringifyClipboardDocument(document)
        );
        expect(roundTrip.kind).toBe('selection');
        expect(roundTrip.fragment.paths[0].nodes[0].x).toBe(285);
    });

    test('serializes whole-glyph documents', () => {
        const document = buildGlyphsClipboardDocument(
            [
                {
                    name: 'a',
                    layers: [
                        {
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 0
                            },
                            width: 500,
                            paths: [],
                            components: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            [{ id: 'm0', name: 'Regular' }]
        );
        expect(document.kind).toBe('glyphs');
        expect(document.version).toBe(1);
        expect(document.nodeOrder).toBe('start-first');
        expect(document.masters).toEqual([{ id: 'm0', name: 'Regular' }]);
        expect(document.glyphs[0].name).toBe('a');
    });
});

describe('clipboard write helpers', () => {
    const {
        writeClipboardDocumentAsync,
        writeClipboardDocumentToDataTransfer
    } = require('../js/clipboard');

    test('sync DataTransfer write puts JSON on text/plain', () => {
        const stored = {};
        const clipboardData = {
            setData(type, data) {
                stored[type] = data;
            }
        };
        const document = {
            version: 1,
            kind: 'selection',
            nodeOrder: 'start-first',
            keepAbsoluteCoords: true,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 10, y: 0, nodetype: 'Line' },
                        { x: 10, y: 10, nodetype: 'Line' }
                    ]
                }
            ],
            components: [],
            anchors: [],
            guides: []
        };
        writeClipboardDocumentToDataTransfer(
            clipboardData,
            document,
            document.paths
        );
        expect(stored['text/plain']).toContain(
            '"clipboardSchema": "font-editor-clipboard"'
        );
        expect(stored['text/plain']).toContain('"counterpunch"');
        expect(stored['text/plain']).not.toContain(
            '"format": "counterpunch-clipboard"'
        );
        expect(stored['image/svg+xml']).toContain('<svg');
    });

    test('async write publishes image/svg+xml ClipboardItem', async () => {
        const writes = [];
        const OriginalClipboardItem = global.ClipboardItem;
        global.ClipboardItem = class {
            constructor(items) {
                this.items = items;
            }
            static supports() {
                return true;
            }
        };
        Object.defineProperty(global.navigator, 'clipboard', {
            configurable: true,
            value: {
                write: async (items) => {
                    writes.push(items);
                }
            }
        });

        const document = {
            version: 1,
            kind: 'selection',
            nodeOrder: 'start-first',
            keepAbsoluteCoords: true,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 10, y: 0, nodetype: 'Line' },
                        { x: 10, y: 10, nodetype: 'Line' }
                    ]
                }
            ],
            components: [],
            anchors: [],
            guides: []
        };

        const ok = await writeClipboardDocumentAsync(document, document.paths);
        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0][0].items['image/svg+xml']).toBeInstanceOf(Blob);
        expect(writes[0][0].items['text/plain']).toBeInstanceOf(Blob);
        expect(writes[0][0].items['web fontra/json-clipboard']).toBeInstanceOf(
            Blob
        );

        global.ClipboardItem = OriginalClipboardItem;
    });

    test('async write still publishes Fontra when full custom set fails', async () => {
        const writes = [];
        const OriginalClipboardItem = global.ClipboardItem;
        global.ClipboardItem = class {
            constructor(items) {
                this.items = items;
            }
            static supports() {
                return true;
            }
        };
        Object.defineProperty(global.navigator, 'clipboard', {
            configurable: true,
            value: {
                write: async (items) => {
                    const map = items[0].items;
                    if (
                        map['web application/x-counterpunch-clipboard'] &&
                        map['web fontra/json-clipboard']
                    ) {
                        throw new Error('reject full custom');
                    }
                    writes.push(items);
                }
            }
        });

        const document = {
            version: 1,
            kind: 'selection',
            nodeOrder: 'start-first',
            keepAbsoluteCoords: true,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 10, y: 0, nodetype: 'Line' },
                        { x: 10, y: 10, nodetype: 'Line' }
                    ]
                }
            ],
            components: [],
            anchors: [],
            guides: []
        };

        const ok = await writeClipboardDocumentAsync(document, document.paths);
        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0][0].items['web fontra/json-clipboard']).toBeInstanceOf(
            Blob
        );
        expect(
            writes[0][0].items['web application/x-counterpunch-clipboard']
        ).toBeUndefined();

        global.ClipboardItem = OriginalClipboardItem;
    });
});

describe('clipboard SVG serializer', () => {
    const {
        serializePathsToSvg,
        parseSvg,
        extractCounterpunchJsonFromSvg
    } = require('../js/clipboard/svg');

    test('round-trips a closed cubic path through SVG export', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="100"');
        expect(svg).toContain('height="100"');
        expect(svg).toContain('viewBox="0 0 100 100"');
        expect(svg).not.toContain('<rect');
        expect(svg).toContain('<path d="');
        expect(svg).toContain('Z');

        const parsed = parseSvg(svg);
        expect(parsed.paths).toHaveLength(1);
        expect(parsed.paths[0].closed).toBe(true);
        // Y flip on export + ingest returns equivalent bounds height.
        const ys = parsed.paths[0].nodes.map((node) => node.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 5);
    });

    test('exports nested o contours as one compound path', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 285, y: -8, nodetype: 'Curve', smooth: true },
                    { x: 422, y: -8, nodetype: 'OffCurve' },
                    { x: 520, y: 95, nodetype: 'OffCurve' },
                    { x: 520, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 520, y: 397, nodetype: 'OffCurve' },
                    { x: 422, y: 500, nodetype: 'OffCurve' },
                    { x: 285, y: 500, nodetype: 'Curve', smooth: true },
                    { x: 148, y: 500, nodetype: 'OffCurve' },
                    { x: 50, y: 397, nodetype: 'OffCurve' },
                    { x: 50, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 50, y: 95, nodetype: 'OffCurve' },
                    { x: 148, y: -8, nodetype: 'OffCurve' }
                ]
            },
            {
                closed: true,
                nodes: [
                    { x: 285, y: 20, nodetype: 'Curve', smooth: true },
                    { x: 404, y: 20, nodetype: 'OffCurve' },
                    { x: 490, y: 111, nodetype: 'OffCurve' },
                    { x: 490, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 490, y: 381, nodetype: 'OffCurve' },
                    { x: 404, y: 472, nodetype: 'OffCurve' },
                    { x: 285, y: 472, nodetype: 'Curve', smooth: true },
                    { x: 166, y: 472, nodetype: 'OffCurve' },
                    { x: 80, y: 381, nodetype: 'OffCurve' },
                    { x: 80, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 80, y: 111, nodetype: 'OffCurve' },
                    { x: 166, y: 20, nodetype: 'OffCurve' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect(svg).toContain('width="470"');
        expect(svg).toContain('height="508"');
        expect(svg).toContain('viewBox="0 0 470 508"');
        expect(svg).not.toContain('<rect');
        const pathTags = svg.match(/<path\b/g) || [];
        expect(pathTags).toHaveLength(1);
        // Outer then inner subpaths in one d attribute.
        expect((svg.match(/M/g) || []).length).toBe(2);
        expect(svg).toContain('Z');
        // Round-trip still splits compound SVG into separate contours.
        expect(parseSvg(svg).paths).toHaveLength(2);
    });

    test('keeps non-nested shapes as separate path elements', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 10, y: 0, nodetype: 'Line' },
                    { x: 10, y: 10, nodetype: 'Line' },
                    { x: 0, y: 10, nodetype: 'Line' }
                ]
            },
            {
                closed: true,
                nodes: [
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 110, y: 0, nodetype: 'Line' },
                    { x: 110, y: 10, nodetype: 'Line' },
                    { x: 100, y: 10, nodetype: 'Line' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect((svg.match(/<path\b/g) || []).length).toBe(2);
    });

    test('embeds and extracts Counterpunch JSON in SVG metadata', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 10, y: 0, nodetype: 'Line' },
                    { x: 10, y: 10, nodetype: 'Line' }
                ]
            }
        ];
        const json = JSON.stringify({
            kind: 'selection'
        });
        const svg = serializePathsToSvg(paths, { embeddedJson: json });
        expect(extractCounterpunchJsonFromSvg(svg)).toBe(json);
        expect(parseSvg(svg).paths).toHaveLength(1);
    });
});

describe('applyPasteGlyphsDocument', () => {
    function makeDrawing(stationId) {
        const anchors = [];
        const guides = [];
        const shapes = [];
        return {
            is_background: false,
            width: 400,
            leftMetricsKey: null,
            rightMetricsKey: null,
            station: stationId
                ? { type: 'DefaultForMaster', master: stationId }
                : undefined,
            location: undefined,
            format_specific: undefined,
            anchors,
            guides,
            shapes,
            paths: [],
            getStation() {
                return null;
            },
            addPath(closed) {
                const path = {
                    closed,
                    nodes: [],
                    set nodes(value) {
                        this._nodes = value;
                    },
                    get nodes() {
                        return this._nodes || [];
                    }
                };
                shapes.push({
                    isPath: () => true,
                    asPath: () => path
                });
                this.paths.push(path);
                return path;
            },
            addComponent(reference, transform) {
                const component = {
                    reference,
                    transform: transform || [1, 0, 0, 1, 0, 0],
                    automaticAlignment: false,
                    anchor: undefined
                };
                shapes.push({
                    isPath: () => false,
                    isComponent: () => true,
                    asComponent: () => component
                });
                this.components = this.components || [];
                this.components.push(component);
                return component;
            },
            addAnchor(x, y, name) {
                const anchor = { name, x, y };
                anchors.push(anchor);
                return anchor;
            },
            addGuide(pos, name) {
                const guide = { pos, name };
                guides.push(guide);
                return guide;
            }
        };
    }

    function makeFont(stationCount, existingNames = [], axisKeys = []) {
        const glyphOrder = [...existingNames];
        const glyphStore = new Map();
        for (const name of existingNames) {
            glyphStore.set(name, { name, drawings: [] });
        }
        const stations = Array.from({ length: stationCount }, (_, index) => ({
            id: `master-${index}`
        }));
        const axes = axisKeys.map((key) =>
            key.length === 4 ? { id: key, tag: key } : { id: key, tag: 'wght' }
        );
        return {
            stations,
            axes,
            glyphOrder,
            findGlyph(name) {
                return glyphStore.get(name);
            },
            allocateUniqueGlyphName(baseName) {
                if (!glyphStore.has(baseName)) {
                    return baseName;
                }
                let index = 1;
                while (index < 10000) {
                    const candidate = `${baseName}.${String(index).padStart(3, '0')}`;
                    if (!glyphStore.has(candidate)) {
                        return candidate;
                    }
                    index += 1;
                }
                throw new Error(
                    `Could not allocate a unique name for "${baseName}"`
                );
            },
            findInsertIndexAfterName(baseName) {
                let name = String(baseName || '').trim();
                while (/\.\d{3,}$/.test(name)) {
                    name = name.replace(/\.\d{3,}$/, '');
                }
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const numbered = new RegExp(`^${escaped}\\.\\d{3,}$`);
                let lastIndex = -1;
                for (let index = 0; index < glyphOrder.length; index++) {
                    const glyphName = glyphOrder[index];
                    if (glyphName === name || numbered.test(glyphName)) {
                        lastIndex = index;
                    }
                }
                return lastIndex >= 0 ? lastIndex + 1 : glyphOrder.length;
            },
            addGlyph(name, _category = 'Base', options = {}) {
                const drawings = stations.map((station) =>
                    makeDrawing(station.id)
                );
                const glyph = {
                    name,
                    leftMetricsKey: null,
                    rightMetricsKey: null,
                    drawings,
                    addDrawing(width, station) {
                        const drawing = makeDrawing();
                        drawing.width = width;
                        drawing.station = station;
                        drawings.push(drawing);
                        return drawing;
                    }
                };
                const insertIndex =
                    typeof options.insertIndex === 'number'
                        ? options.insertIndex
                        : glyphOrder.length;
                glyphOrder.splice(insertIndex, 0, name);
                glyphStore.set(name, glyph);
                return glyph;
            }
        };
    }

    function stationsMeta(count) {
        return Array.from({ length: count }, (_, index) => ({
            id: `source-master-${index}`,
            name: `Master ${index}`
        }));
    }

    test('creates new glyphs matched by masterIndex', () => {
        const font = makeFont(2);

        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(2),
                glyphs: [
                    {
                        name: 'o',
                        leftMetricsKey: '=H',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 10, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 1
                                },
                                width: 560,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 20, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [{ name: 'top', x: 30, y: 700 }],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['o']);
        const glyph = font.findGlyph('o');
        expect(glyph.leftMetricsKey).toBe('=H');
        expect(glyph.drawings[0].width).toBe(500);
        expect(glyph.drawings[1].width).toBe(560);
        expect(glyph.drawings[0].paths).toHaveLength(1);
        expect(glyph.drawings[1].paths).toHaveLength(1);
        expect(glyph.drawings[1].anchors[0]).toMatchObject({
            name: 'top',
            x: 30,
            y: 700
        });
    });

    test('inserts after existing namesake / .NNN siblings', () => {
        const font = makeFont(1, ['a', 'o', 'o.001', 'p']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 10, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['o.002']);
        expect(font.glyphOrder).toEqual(['a', 'o', 'o.001', 'o.002', 'p']);
        expect(font.findGlyph('o.002').drawings[0].paths).toHaveLength(1);
    });

    test('pastes layer copies as AssociatedWithMaster without location', () => {
        const font = makeFont(1);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'AssociatedWithMaster',
                                    masterIndex: 0
                                },
                                width: 510,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 1, y: 1, nodetype: 'Line' },
                                            { x: 2, y: 2, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        const glyph = font.findGlyph('o');
        expect(glyph.drawings).toHaveLength(2);
        expect(glyph.drawings[1].station).toEqual({
            type: 'AssociatedWithMaster',
            master: 'master-0'
        });
        expect(glyph.drawings[1].location).toBeUndefined();
        expect(glyph.drawings[1].paths).toHaveLength(1);
    });

    test('skips braces when axis keys are missing and warns', () => {
        const font = makeFont(1, [], ['wght']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'AssociatedWithMaster',
                                    masterIndex: 0
                                },
                                location: { missingAxis: 500 },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 1, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        expect(result.warnings[0]).toMatch(/Skipped 1 free drawing/);
        expect(font.findGlyph('o').drawings).toHaveLength(1);
    });

    test('allocates .001 when the glyph name already exists', () => {
        const font = makeFont(1, ['a']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(1),
                glyphs: [
                    {
                        name: 'a',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 480,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['a.001']);
        expect(font.findGlyph('a.001').drawings[0].width).toBe(480);
    });

    test('refuses paste when master counts differ', () => {
        const font = makeFont(1);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 1,
                masters: stationsMeta(2),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toMatch(/Clipboard has 2 stations, font has 1/);
        expect(font.findGlyph('o')).toBeUndefined();
    });
});

describe('clipboard internal round-trips', () => {
    const {
        Font,
        withSuppressedModelRecording
    } = require('../js/babelfont-model');
    const {
        buildGlyphsClipboardDocument,
        buildSelectionClipboardDocument,
        serializeAnchorForClipboard,
        serializeComponentForClipboard,
        serializeFontStationsForClipboard,
        serializeGlyphForClipboard,
        serializeGuideForClipboard,
        serializePathForClipboard,
        stringifyClipboardDocument
    } = require('../js/clipboard/serialize');

    function makeBoxNodes(minX, minY, maxX, maxY) {
        return [
            { x: minX, y: minY, nodetype: 'Line' },
            { x: maxX, y: minY, nodetype: 'Line' },
            { x: maxX, y: maxY, nodetype: 'Line' },
            { x: minX, y: maxY, nodetype: 'Line' }
        ];
    }

    function makeRoundTripFontData() {
        return {
            upm: 1000,
            version: [1, 0],
            note: '',
            date: '2024-01-01',
            names: { familyName: 'ClipboardRoundTrip' },
            custom_ot_values: [],
            features: { classes: {}, prefixes: {}, features: [] },
            axes: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'dot',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-dot',
                            width: 100,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    closed: true,
                                    nodes: makeBoxNodes(10, 10, 40, 40)
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'a',
                    category: 'Base',
                    exported: true,
                    leftMetricsKey: '=H',
                    rightMetricsKey: '=H',
                    layers: [
                        {
                            id: 'layer-a',
                            width: 520,
                            leftMetricsKey: '=H',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    closed: true,
                                    nodes: makeBoxNodes(40, 0, 460, 700)
                                }
                            ],
                            anchors: [{ name: 'top', x: 250, y: 720 }],
                            guides: [
                                {
                                    name: 'mid',
                                    pos: { x: 0, y: 350, angle: 0 }
                                }
                            ]
                        }
                    ]
                },
                {
                    name: 'b',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-b',
                            width: 480,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    closed: true,
                                    nodes: makeBoxNodes(30, 0, 420, 700)
                                },
                                {
                                    reference: 'dot',
                                    transform: [1, 0, 0, 1, 200, 500]
                                }
                            ],
                            anchors: [{ name: 'bottom', x: 240, y: 0 }],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'c',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-c',
                            width: 450,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    closed: false,
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Line' },
                                        { x: 400, y: 50, nodetype: 'Line' },
                                        {
                                            x: 400,
                                            y: 600,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 300,
                                            y: 650,
                                            nodetype: 'OffCurve'
                                        },
                                        { x: 100, y: 650, nodetype: 'OffCurve' }
                                    ]
                                }
                            ],
                            anchors: [],
                            guides: [
                                {
                                    name: 'slant',
                                    pos: { x: 100, y: 0, angle: 90 }
                                }
                            ]
                        }
                    ]
                }
            ]
        };
    }

    function glyphContentSnapshot(glyph) {
        const serialized = serializeGlyphForClipboard(glyph);
        return {
            name: serialized.name,
            leftMetricsKey: serialized.leftMetricsKey ?? null,
            rightMetricsKey: serialized.rightMetricsKey ?? null,
            layers: serialized.layers.map((drawing) => {
                const { layerId: _drawingId, ...rest } = drawing;
                return rest;
            }),
            featureVariations: serialized.featureVariations || []
        };
    }

    function selectionContentSnapshot(document) {
        return {
            kind: document.kind,
            keepAbsoluteCoords: document.keepAbsoluteCoords,
            paths: document.paths,
            components: document.components,
            anchors: document.anchors,
            guides: document.guides
        };
    }

    function buildSelectionFromDrawing(drawing, glyphName) {
        return buildSelectionClipboardDocument({
            glyphName,
            layerId: drawing.id ?? null,
            paths: (drawing.paths || []).map((path) =>
                serializePathForClipboard(path)
            ),
            components: (drawing.components || []).map((component) =>
                serializeComponentForClipboard(component)
            ),
            anchors: (drawing.anchors || [])
                .filter((anchor) => !!anchor.name)
                .map((anchor) => serializeAnchorForClipboard(anchor)),
            guides: (drawing.guides || []).map((guide) =>
                serializeGuideForClipboard(guide, false)
            )
        });
    }

    function clearDrawingObjects(drawing) {
        while ((drawing.shapes || []).length > 0) {
            drawing.removeShape(0);
        }
        while ((drawing.anchors || []).length > 0) {
            drawing.removeAnchor(0);
        }
        while ((drawing.guides || []).length > 0) {
            drawing.removeGuide(0);
        }
    }

    test('copy three glyphs, delete them, paste JSON back identically', () => {
        const font = Font.fromData(makeRoundTripFontData());
        const names = ['a', 'b', 'c'];
        const before = names.map((name) =>
            glyphContentSnapshot(font.findGlyph(name))
        );

        const document = buildGlyphsClipboardDocument(
            names.map((name) =>
                serializeGlyphForClipboard(font.findGlyph(name))
            ),
            serializeFontStationsForClipboard(font)
        );
        expect(document).not.toBeNull();

        const parsed = parseCounterpunchJson(
            stringifyClipboardDocument(document)
        );
        expect(parsed.kind).toBe('glyphs');

        font.deleteGlyphs(names);
        for (const name of names) {
            expect(font.findGlyph(name)).toBeUndefined();
        }
        expect(font.findGlyph('dot')).toBeDefined();

        const result = withSuppressedModelRecording(() =>
            applyPasteGlyphsDocument(parsed.document, {
                font,
                glyphExists: (name) => !!font.findGlyph(name)
            })
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(names);

        const after = names.map((name) =>
            glyphContentSnapshot(font.findGlyph(name))
        );
        expect(after).toEqual(before);
    });

    test('copy layer objects, clear the layer, paste JSON back identically', () => {
        const font = Font.fromData(makeRoundTripFontData());
        const glyph = font.findGlyph('b');
        const drawing = glyph.drawings[0];

        const document = buildSelectionFromDrawing(drawing, glyph.name);
        expect(document).not.toBeNull();
        const before = selectionContentSnapshot(document);

        const parsed = parseCounterpunchJson(
            stringifyClipboardDocument(document)
        );
        expect(parsed.kind).toBe('selection');

        clearDrawingObjects(drawing);
        expect(drawing.paths).toHaveLength(0);
        expect(drawing.components).toHaveLength(0);
        expect(drawing.anchors).toHaveLength(0);
        expect(drawing.guides).toHaveLength(0);

        const result = withSuppressedModelRecording(() =>
            applyPasteFragment(parsed.fragment, {
                activeDrawing: drawing,
                linkedDrawings: [],
                master: drawing.getStation?.() ?? null,
                drawingWidth: drawing.width,
                verticalMetrics: null,
                glyphExists: (name) => !!font.findGlyph(name)
            })
        );

        expect(result.skippedComponents).toEqual([]);
        expect(result.addedPathCount).toBe(before.paths.length);
        expect(result.addedComponentCount).toBe(before.components.length);
        expect(result.addedAnchorCount).toBe(before.anchors.length);
        expect(result.addedGuideCount).toBe(before.guides.length);

        const after = selectionContentSnapshot(
            buildSelectionFromDrawing(drawing, glyph.name)
        );
        expect(after).toEqual(before);
    });

    test('round-trips format_specific for every copied layer object', () => {
        const font = Font.fromData(makeRoundTripFontData());
        const glyph = font.findGlyph('b');
        const drawing = glyph.drawings[0];
        drawing.paths[0].format_specific = { 'com.example.path': 'path-data' };
        drawing.components[0].format_specific = {
            'com.example.component': 'component-data'
        };
        drawing.anchors[0].format_specific = {
            'com.example.anchor': 'anchor-data'
        };
        drawing.addGuide({ x: 0, y: 300, angle: 0 }, 'guide').format_specific =
            {
                'com.example.guide': 'guide-data'
            };

        const document = buildSelectionFromDrawing(drawing, glyph.name);
        const parsed = parseCounterpunchJson(
            stringifyClipboardDocument(document)
        );
        expect(parsed.kind).toBe('selection');
        const fragment = parsed.fragment;
        expect(fragment.paths[0].format_specific).toEqual({
            'com.example.path': 'path-data'
        });
        expect(fragment.components[0].format_specific).toEqual({
            'com.example.component': 'component-data'
        });
        expect(fragment.anchors[0].format_specific).toEqual({
            'com.example.anchor': 'anchor-data'
        });
        expect(fragment.guides[0].format_specific).toEqual({
            'com.example.guide': 'guide-data'
        });

        clearDrawingObjects(drawing);
        withSuppressedModelRecording(() =>
            applyPasteFragment(fragment, {
                activeDrawing: drawing,
                linkedDrawings: [],
                master: drawing.getStation?.() ?? null,
                drawingWidth: drawing.width,
                verticalMetrics: null,
                glyphExists: (name) => !!font.findGlyph(name)
            })
        );

        expect(drawing.paths[0].format_specific).toEqual({
            'com.example.path': 'path-data'
        });
        expect(drawing.components[0].format_specific).toEqual({
            'com.example.component': 'component-data'
        });
        expect(drawing.anchors[0].format_specific).toEqual({
            'com.example.anchor': 'anchor-data'
        });
        expect(drawing.guides[0].format_specific).toEqual({
            'com.example.guide': 'guide-data'
        });
    });
});

describe('Fontra clipboard tagged MIME', () => {
    const {
        parseFontraClipboard,
        stringifyFontraClipboardDocument,
        FONTRA_CLIPBOARD_MIME
    } = require('../js/clipboard/fontra');
    const {
        parseClipboardPayloads,
        buildSelectionClipboardDocument,
        buildGlyphsClipboardDocument
    } = require('../js/clipboard');

    test('parses fontra-layer-glyphs with transformed component', () => {
        const payload = {
            type: 'fontra-layer-glyphs',
            data: {
                layerGlyphs: [
                    {
                        layerName: 'layer-1',
                        location: {},
                        glyph: {
                            xAdvance: 572,
                            path: {
                                coordinates: [0, 0, 10, 0, 10, 10],
                                pointTypes: [8, 2, 8],
                                contourInfo: [{ endPoint: 2, isClosed: false }]
                            },
                            components: [
                                {
                                    name: 'dieresis',
                                    transformation: {
                                        translateX: 0.5,
                                        translateY: -11,
                                        rotation: 0,
                                        scaleX: 1.75,
                                        scaleY: 1,
                                        skewX: 0,
                                        skewY: 0,
                                        tCenterX: 0,
                                        tCenterY: 0
                                    },
                                    location: {},
                                    customData: {}
                                }
                            ],
                            anchors: [{ name: 'top', x: 100, y: 500 }],
                            guidelines: [
                                {
                                    x: -10,
                                    y: 200,
                                    angle: 0,
                                    locked: false,
                                    name: 'local'
                                }
                            ]
                        }
                    }
                ],
                glyphName: 'o',
                codePoints: [111]
            }
        };
        const parsed = parseClipboardPayloads([
            {
                type: 'web fontra/json-clipboard',
                data: JSON.stringify(payload)
            }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('fontra-json');
        expect(parsed.fragment.keepAbsoluteCoords).toBe(true);
        expect(parsed.fragment.components[0]).toMatchObject({
            reference: 'dieresis'
        });
        expect(parsed.fragment.components[0].transform[0]).toBeCloseTo(1.75, 5);
        expect(parsed.fragment.components[0].transform[4]).toBeCloseTo(0.5, 5);
        expect(parsed.fragment.components[0].transform[5]).toBeCloseTo(-11, 5);
        expect(parsed.fragment.anchors[0]).toEqual({
            name: 'top',
            x: 100,
            y: 500
        });
        expect(parsed.fragment.guides[0].name).toBe('local');
    });

    test('ignores Fontra JSON on text/plain', () => {
        const payload = {
            type: 'fontra-layer-glyphs',
            data: {
                layerGlyphs: [
                    {
                        layerName: 'layer-1',
                        location: {},
                        glyph: {
                            xAdvance: 100,
                            path: {
                                coordinates: [0, 0, 10, 0],
                                pointTypes: [0, 0],
                                contourInfo: [{ endPoint: 1, isClosed: false }]
                            },
                            components: [],
                            anchors: [],
                            guidelines: []
                        }
                    }
                ],
                glyphName: 'a',
                codePoints: []
            }
        };
        const parsed = parseClipboardPayloads([
            { type: 'text/plain', data: JSON.stringify(payload) }
        ]);
        expect(parsed).toBeNull();
    });

    test('parses fontra-glyph-array into whole-glyph document', () => {
        const payload = {
            type: 'fontra-glyph-array',
            data: {
                glyphs: [
                    {
                        codePoints: [111],
                        variableGlyph: {
                            name: 'o',
                            axes: [],
                            sources: [
                                {
                                    name: '',
                                    locationBase: 'm0',
                                    location: {},
                                    layerName: 'm0',
                                    inactive: false,
                                    customData: {}
                                },
                                {
                                    name: '',
                                    locationBase: 'm1',
                                    location: {},
                                    layerName: 'm1',
                                    inactive: false,
                                    customData: {}
                                }
                            ],
                            layers: {
                                m0: {
                                    glyph: {
                                        xAdvance: 570,
                                        path: {
                                            coordinates: [0, 0, 10, 0, 10, 10],
                                            pointTypes: [0, 0, 0],
                                            contourInfo: [
                                                {
                                                    endPoint: 2,
                                                    isClosed: true
                                                }
                                            ]
                                        },
                                        components: [],
                                        anchors: [],
                                        guidelines: []
                                    },
                                    customData: {}
                                },
                                m1: {
                                    glyph: {
                                        xAdvance: 600,
                                        path: {
                                            coordinates: [0, 0, 20, 0, 20, 20],
                                            pointTypes: [0, 0, 0],
                                            contourInfo: [
                                                {
                                                    endPoint: 2,
                                                    isClosed: true
                                                }
                                            ]
                                        },
                                        components: [],
                                        anchors: [],
                                        guidelines: []
                                    },
                                    customData: {}
                                }
                            },
                            customData: {}
                        }
                    }
                ],
                sourceLocations: {
                    m0: { Weight: 30 },
                    m1: { Weight: 135 }
                },
                backgroundImageData: {}
            }
        };
        const parsed = parseClipboardPayloads([
            {
                type: FONTRA_CLIPBOARD_MIME,
                data: JSON.stringify(payload)
            }
        ]);
        expect(parsed.kind).toBe('glyphs');
        expect(parsed.document.masters).toHaveLength(2);
        expect(parsed.document.masters[0].location.Weight).toBe(30);
        expect(parsed.document.glyphs).toHaveLength(1);
        expect(parsed.document.glyphs[0].name).toBe('o');
        expect(parsed.document.glyphs[0].layers).toHaveLength(2);
        expect(parsed.document.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            masterIndex: 0
        });
        expect(parsed.document.glyphs[0].layers[0].width).toBe(570);
    });

    test('round-trips selection through Fontra tagged serialize/parse', () => {
        const selection = buildSelectionClipboardDocument({
            glyphName: 'o',
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line', smooth: true },
                        { x: 10, y: 0, nodetype: 'OffCurve' },
                        { x: 10, y: 10, nodetype: 'OffCurve' },
                        { x: 0, y: 10, nodetype: 'Curve', smooth: true }
                    ]
                }
            ],
            components: [
                {
                    reference: 'macroncomb',
                    x: 12,
                    y: 0,
                    transform: [1, 0, 0, 1, 12, 0]
                }
            ],
            anchors: [{ name: 'top', x: 50, y: 500 }],
            guides: [{ name: 'g', x: 0, y: 100, angle: 0, global: false }]
        });
        expect(selection).not.toBeNull();
        const json = stringifyFontraClipboardDocument(selection, {
            layerId: 'L1',
            layerWidth: 500,
            codePoints: [111]
        });
        const parsed = parseFontraClipboard(json);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.components[0].reference).toBe('macroncomb');
        expect(parsed.fragment.anchors[0].name).toBe('top');
        expect(parsed.fragment.paths[0].closed).toBe(true);
    });

    test('round-trips glyphs through Fontra tagged serialize/parse', () => {
        const document = buildGlyphsClipboardDocument(
            [
                {
                    name: 'o',
                    layers: [
                        {
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 0
                            },
                            width: 570,
                            paths: [
                                {
                                    closed: false,
                                    nodes: [
                                        { x: 1, y: 2, nodetype: 'Line' },
                                        { x: 3, y: 4, nodetype: 'Line' }
                                    ]
                                }
                            ],
                            components: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            [{ id: 'm0', name: 'Light', location: { wght: 30 } }]
        );
        expect(document).not.toBeNull();
        const json = stringifyFontraClipboardDocument(document, {
            glyphCodePoints: { o: [111] },
            axisNameByKey: { wght: 'Weight', Weight: 'Weight' }
        });
        const raw = JSON.parse(json);
        expect(raw.type).toBe('fontra-glyph-array');
        // Fontra sourceLocations use axis names, not OT tags.
        expect(raw.data.sourceLocations.m0).toEqual({ Weight: 30 });
        expect(raw.data.glyphs[0].variableGlyph.sources[0]).toMatchObject({
            name: '',
            locationBase: 'm0',
            location: {},
            layerName: 'm0'
        });
        const parsed = parseFontraClipboard(json);
        expect(parsed.kind).toBe('glyphs');
        expect(parsed.document.glyphs[0].name).toBe('o');
        expect(parsed.document.masters[0].id).toBe('m0');
        expect(parsed.document.glyphs[0].layers[0].width).toBe(570);
    });

    test('async ClipboardItem read prefers Fontra over sync SVG', async () => {
        const {
            mergeClipboardPayloads,
            isTaggedStructuredClipboard,
            readClipboardPayloadsAsync
        } = require('../js/clipboard');

        const fontraPayload = {
            type: 'fontra-layer-glyphs',
            data: {
                layerGlyphs: [
                    {
                        layerName: 'layer-1',
                        location: {},
                        glyph: {
                            xAdvance: 100,
                            path: {
                                coordinates: [0, 0, 10, 0, 10, 10],
                                pointTypes: [0, 0, 0],
                                contourInfo: [{ endPoint: 2, isClosed: true }]
                            },
                            components: [],
                            anchors: [{ name: 'top', x: 5, y: 20 }],
                            guidelines: []
                        }
                    }
                ],
                glyphName: 'a',
                codePoints: []
            }
        };
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0"/></svg>';

        Object.defineProperty(global.navigator, 'clipboard', {
            configurable: true,
            value: {
                read: async () => [
                    {
                        types: ['web fontra/json-clipboard', 'image/svg+xml'],
                        getType: async (type) => ({
                            text: async () =>
                                type.startsWith('web fontra')
                                    ? JSON.stringify(fontraPayload)
                                    : svg
                        })
                    }
                ]
            }
        });

        const asyncPayloads = await readClipboardPayloadsAsync();
        const merged = mergeClipboardPayloads(asyncPayloads, [
            { type: 'image/svg+xml', data: svg }
        ]);
        const parsed = parseClipboardPayloads(merged);
        expect(isTaggedStructuredClipboard(parsed)).toBe(true);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('fontra-json');
        expect(parsed.fragment.anchors[0].name).toBe('top');
    });
});
