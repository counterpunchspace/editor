/**
 * Outline Editing — Canonical Tests
 *
 * These tests lock down APP.md § Editing Existing Outlines:
 *
 *   - Shift-constrained dragging of smooth off-curve triplets
 *   - Alt-constrained dragging of smooth on-curve points
 *   - Alt-constrained dragging of non-smooth off-curve points
 *   - One-sided smooth eligibility, alignment, and delete-to-line behavior
 *   - Cmd-cut opening/splitting paths and clearing smoothness on duplicated cut nodes
 *   - Cmd drawing taking priority over add-point insertion while path drawing can continue
 *   - Connecting open-path endpoints by cmd drawing or endpoint dragging
 *   - Neighbor-glyph snap candidates always participating in snapping,
 *     ordered by distance from the dragged node's original position
 */

const { Font } = require('../../js/babelfont-model');
const fontManager = require('../../js/font-manager').default;

function activateEditableLayer(canvas, layerData) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.currentGlyphName = 'A';
    canvas.outlineEditor.selectedLayerId = 'layer-1';
    canvas.outlineEditor.glyphStack = 'A@layer-1';
    canvas.outlineEditor.layerData = {
        id: 'layer-1',
        width: 520,
        shapes: [],
        anchors: [],
        guides: [],
        ...layerData
    };
}

function makeOpenTripletLayer({ smooth = true } = {}) {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth },
                    { x: 80, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 100, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 120, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeEligibleToggleLayer() {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth: false },
                    { x: 80, y: 40, nodetype: 'OffCurve', smooth: false },
                    { x: 100, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 120, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeNearAxisSnapToggleLayer() {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 57, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth: false },
                    { x: 80, y: 57, nodetype: 'OffCurve', smooth: false },
                    { x: 100, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 120, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeOneSidedCurveLayer() {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 40, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth: false },
                    { x: 120, y: 60, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeSinglePathFont(nodes, closed = false) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [
            {
                id: 'master-1',
                name: { en: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: new Map()
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [{ nodes, closed }],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Outline Editing Canonical' } },
        note: '',
        date: '2026-03-31',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeFontWithShapes(shapes, anchors = []) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [
            {
                id: 'master-1',
                name: { en: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: new Map()
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes,
                        anchors,
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Outline Editing Canonical' } },
        note: '',
        date: '2026-04-01',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function bindActiveGlyphModel(canvas, font) {
    const glyph = font.findGlyph('A');
    const layer = glyph.findLayerById('layer-1');
    const layerSpy = jest
        .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
        .mockReturnValue(layer);
    const glyphSpy = jest
        .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
        .mockReturnValue(glyph);

    return {
        glyph,
        layer,
        restore() {
            layerSpy.mockRestore();
            glyphSpy.mockRestore();
        }
    };
}

describe('Outline Editing canonical behavior', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        localStorage.setItem('editorNodeSnapping', 'true');
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        window.currentFontModel = null;
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        window.changeBridge = null;
        window.currentFontModel = null;
        canvas.destroy();
    });

    test('shift-constrained smooth off-curve dragging aligns the triplet to an axis', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(
                canvas,
                makeOpenTripletLayer({ smooth: true })
            );
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 4
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 80, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            pointer = { glyphX: 110, glyphY: 100 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            const anchor = nodes[3];
            const draggedHandle = nodes[4];
            const oppositeHandle = nodes[2];
            const horizontalAligned =
                draggedHandle.y === anchor.y && oppositeHandle.y === anchor.y;
            const verticalAligned =
                draggedHandle.x === anchor.x && oppositeHandle.x === anchor.x;

            expect(horizontalAligned || verticalAligned).toBe(true);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt toggling during smooth on-curve dragging freezes the handles and slides only the on-curve point between them', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(
                canvas,
                makeOpenTripletLayer({ smooth: true })
            );
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 3
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 60, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            pointer = { glyphX: 90, glyphY: 90 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].y).toBe(90);
            expect(nodes[2].x).toBe(70);
            expect(nodes[4].x).toBe(110);

            canvas.outlineEditor.setAltKeyPressed(true);
            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].x).toBe(70);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].x).toBe(110);
            expect(nodes[4].y).toBe(90);

            pointer = { glyphX: 95, glyphY: 120 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(95);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].x).toBe(70);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].x).toBe(110);
            expect(nodes[4].y).toBe(90);

            canvas.outlineEditor.setAltKeyPressed(false);
            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(95);
            expect(nodes[3].y).toBe(120);
            expect(nodes[2].x).toBe(70);
            expect(nodes[2].y).toBe(120);
            expect(nodes[4].x).toBe(110);
            expect(nodes[4].y).toBe(120);

            pointer = { glyphX: 100, glyphY: 130 };
            canvas.outlineEditor.onMouseMove({
                clientX: 14,
                clientY: 24,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(100);
            expect(nodes[3].y).toBe(130);
            expect(nodes[2].x).toBe(75);
            expect(nodes[2].y).toBe(130);
            expect(nodes[4].x).toBe(115);
            expect(nodes[4].y).toBe(130);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt toggling during one-sided smooth on-curve dragging freezes the handle and slides only the on-curve point on the fixed axis', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, {
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Move', smooth: false },
                            {
                                x: 40,
                                y: 40,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            { x: 60, y: 60, nodetype: 'QCurve', smooth: true },
                            { x: 120, y: 60, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            });
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 2
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 60, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            pointer = { glyphX: 80, glyphY: 90 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[2].x).toBe(80);
            expect(nodes[2].y).toBe(90);
            const preAltHandle = { x: nodes[1].x, y: nodes[1].y };

            canvas.outlineEditor.setAltKeyPressed(true);
            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[1].x).toBeCloseTo(preAltHandle.x, 5);
            expect(nodes[1].y).toBeCloseTo(preAltHandle.y, 5);

            pointer = { glyphX: 90, glyphY: 140 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[1].x).toBeCloseTo(preAltHandle.x, 5);
            expect(nodes[1].y).toBeCloseTo(preAltHandle.y, 5);
            expect(nodes[2].x).not.toBeCloseTo(80, 5);
            expect(nodes[2].y).not.toBeCloseTo(90, 5);

            const axisVector = {
                x: 120 - preAltHandle.x,
                y: 60 - preAltHandle.y
            };
            const constrainedVector = {
                x: nodes[2].x - preAltHandle.x,
                y: nodes[2].y - preAltHandle.y
            };
            expect(
                constrainedVector.x * axisVector.y -
                    constrainedVector.y * axisVector.x
            ).toBeCloseTo(0, 5);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt toggling during non-smooth on-curve dragging freezes the handles and moves the on-curve point freely', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(
                canvas,
                makeOpenTripletLayer({ smooth: false })
            );
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 3
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 60, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            pointer = { glyphX: 90, glyphY: 90 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].x).toBe(70);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].x).toBe(110);
            expect(nodes[4].y).toBe(90);

            canvas.outlineEditor.setAltKeyPressed(true);
            pointer = { glyphX: 95, glyphY: 120 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(95);
            expect(nodes[3].y).toBe(120);
            expect(nodes[2].x).toBe(70);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].x).toBe(110);
            expect(nodes[4].y).toBe(90);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt toggling during one-sided non-smooth on-curve dragging freezes the handle and moves the on-curve point freely', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, makeOneSidedCurveLayer());
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 3
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 60, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            pointer = { glyphX: 80, glyphY: 90 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(80);
            expect(nodes[3].y).toBe(90);
            const preAltHandle = { x: nodes[2].x, y: nodes[2].y };
            const preAltFarHandle = { x: nodes[1].x, y: nodes[1].y };

            canvas.outlineEditor.setAltKeyPressed(true);
            pointer = { glyphX: 90, glyphY: 140 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(140);
            expect(nodes[2].x).toBe(preAltHandle.x);
            expect(nodes[2].y).toBe(preAltHandle.y);
            expect(nodes[1].x).toBe(preAltFarHandle.x);
            expect(nodes[1].y).toBe(preAltFarHandle.y);
            expect(nodes[4].x).toBe(120);
            expect(nodes[4].y).toBe(60);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('cmd+alt click on a smooth on-curve point starts a slide along the combined curve', () => {
        activateEditableLayer(canvas, makeOpenTripletLayer({ smooth: true }));
        canvas.outlineEditor.selectedPoints = [
            {
                contourIndex: 0,
                nodeIndex: 3
            }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: false,
            altKey: true,
            metaKey: true,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.isSlidingSmoothPointAlongCurve).toBe(true);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(true);
        expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
            'Move point along curve'
        );
    });

    test('alt re-press during non-smooth off-curve dragging returns to the original drag-start direction', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, {
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve', smooth: false },
                            {
                                x: 40,
                                y: 0,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 40,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 120,
                                y: 0,
                                nodetype: 'Curve',
                                smooth: false
                            }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            });
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 40, glyphY: 0 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            pointer = { glyphX: 60, glyphY: 30 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(30);

            canvas.outlineEditor.setAltKeyPressed(true);
            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(0);

            canvas.outlineEditor.setAltKeyPressed(false);
            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(30);

            pointer = { glyphX: 90, glyphY: 50 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.setAltKeyPressed(true);

            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(90);
            expect(draggedNode.y).toBe(0);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('triplet on-curve points can toggle smooth and align the opposite handle to an existing axis', () => {
        activateEditableLayer(canvas, makeEligibleToggleLayer());
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[3].smooth).toBe(true);
        expect(nodes[4].y).toBe(60);
    });

    test('triplet smooth toggling fully snaps to horizontal or vertical when the averaged direction lands within 10 degrees of an axis after previously divergent handles are aligned', () => {
        activateEditableLayer(canvas, makeNearAxisSnapToggleLayer());
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[3].smooth).toBe(true);
        expect(nodes[2].y).toBe(60);
        expect(nodes[4].y).toBe(60);
    });

    test('on-curve points with a curve on only one side can be toggled smooth and align to the straight segment', () => {
        activateEditableLayer(canvas, makeOneSidedCurveLayer());
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[3].smooth).toBe(true);
        expect(nodes[2].y).toBe(60);
    });

    test('open-path endpoints cannot be toggled smooth', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                        { x: 40, y: 20, nodetype: 'OffCurve', smooth: false },
                        { x: 60, y: 0, nodetype: 'Curve', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        expect(canvas.outlineEditor.layerData.shapes[0].nodes[3].smooth).toBe(
            false
        );
    });

    test('moving the straight segment of a one-sided smooth node realigns the remaining handle', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 40, y: 40, nodetype: 'OffCurve', smooth: false },
                        { x: 60, y: 60, nodetype: 'QCurve', smooth: true },
                        { x: 120, y: 60, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 3 }
        ];
        canvas.outlineEditor.applySelectedPointMove(
            canvas.outlineEditor.layerData,
            0,
            60,
            false,
            false
        );

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        const handleVector = {
            x: nodes[2].x - nodes[1].x,
            y: nodes[2].y - nodes[1].y
        };
        const lineVector = {
            x: nodes[3].x - nodes[2].x,
            y: nodes[3].y - nodes[2].y
        };

        expect(
            handleVector.x * lineVector.y - handleVector.y * lineVector.x
        ).toBeCloseTo(0, 5);
        expect(
            handleVector.x * lineVector.x + handleVector.y * lineVector.y
        ).toBeGreaterThan(0);
    });

    test('deleting a handle into a line keeps smooth when the remaining handle stays aligned', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Move', smooth: false },
                { x: 30, y: 0, nodetype: 'OffCurve' },
                { x: 60, y: 0, nodetype: 'QCurve', smooth: true },
                { x: 90, y: 0, nodetype: 'OffCurve' },
                { x: 120, y: 0, nodetype: 'QCurve', smooth: false }
            ],
            false
        );
        const path = font.glyphs[0].layers[0].paths[0];

        expect(path._deleteNode(3)).toBe(true);
        expect(path.nodes.map((node) => node.nodetype)).toEqual([
            'Move',
            'OffCurve',
            'QCurve',
            'Line'
        ]);
        expect(path.nodes[2].smooth).toBe(true);
    });

    test('deleting a handle into a line clears smooth when the remaining handle is misaligned', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Move', smooth: false },
                { x: 30, y: 20, nodetype: 'OffCurve' },
                { x: 60, y: 0, nodetype: 'QCurve', smooth: true },
                { x: 90, y: 0, nodetype: 'OffCurve' },
                { x: 120, y: 0, nodetype: 'QCurve', smooth: false }
            ],
            false
        );
        const path = font.glyphs[0].layers[0].paths[0];

        expect(path._deleteNode(3)).toBe(true);
        expect(path.nodes.map((node) => node.nodetype)).toEqual([
            'Move',
            'OffCurve',
            'QCurve',
            'Line'
        ]);
        expect(path.nodes[2].smooth).toBe(false);
    });

    test('neighbor glyph snap candidates always participate and remain globally sorted by distance from the drag origin', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'leftGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'left-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 70, nodetype: 'Line' },
                                        { x: 20, y: 70, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'activeGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'active-layer',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'rightGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'right-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 120, nodetype: 'Line' },
                                        { x: 40, y: 120, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Outline Snap Canonical' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        font.markDirty = jest.fn();
        font.syncJsonFromModel = jest.fn();
        font.hasUnsavedChanges = false;
        font.fontModel = font;

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(font);
        window.currentFontModel = font;

        activateEditableLayer(canvas, {
            id: 'active-layer',
            width: 400,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 260, y: 0, nodetype: 'Line' },
                        { x: 260, y: 200, nodetype: 'Line' },
                        { x: 100, y: 200, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.textRunEditor.selectedMasterId = 'master-1';
        canvas.textRunEditor.glyphNameBuffer = [
            'leftGlyph',
            'activeGlyph',
            'rightGlyph'
        ];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 300, dx: 0, dy: 0, g: 11 },
            { ax: 400, dx: 0, dy: 0, g: 12 },
            { ax: 320, dx: 0, dy: 0, g: 13 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor._snapDragStartMouseX = 100;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 100, y: 0 };
        canvas.outlineEditor._rebuildSnapCandidateCache();

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(cache.allDragCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ source: 'left', x: -280, y: 10 }),
                expect.objectContaining({ source: 'right', x: 440, y: 30 })
            ])
        );

        for (let index = 1; index < cache.allDragCandidates.length; index++) {
            const previous = cache.allDragCandidates[index - 1];
            const current = cache.allDragCandidates[index];
            const previousDistance = Math.hypot(previous.x - 100, previous.y);
            const currentDistance = Math.hypot(current.x - 100, current.y);
            expect(currentDistance).toBeGreaterThanOrEqual(previousDistance);
        }

        const snapped = canvas.outlineEditor._applySnapToDelta(
            338,
            28,
            438,
            28,
            100,
            0
        );
        expect(snapped.deltaX).toBe(340);
        expect(snapped.deltaY).toBe(30);
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'right' }),
                ySource: expect.objectContaining({ source: 'right' })
            })
        );
    });

    test('skips alignment snapping when Node Snapping is off', () => {
        localStorage.setItem('editorNodeSnapping', 'false');
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [{ x: 100, y: 0, nodetype: 'Line' }],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor._snapDragStartMouseX = 100;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 100, y: 0 };
        canvas.outlineEditor._rebuildSnapCandidateCache();

        const snapped = canvas.outlineEditor._applySnapToDelta(
            338,
            28,
            438,
            28,
            100,
            0
        );
        expect(snapped).toEqual({ deltaX: 338, deltaY: 28 });
        expect(canvas.outlineEditor.activeSnapTarget).toBeNull();
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                snapTarget: null
            })
        );
    });

    test('still snaps to open contour ends when Node Snapping is off', () => {
        localStorage.setItem('editorNodeSnapping', 'false');
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 80, y: 0, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    nodes: [
                        { x: 120, y: 4, nodetype: 'Move' },
                        { x: 200, y: 4, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor._snapDragStartMouseX = 80;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 80, y: 0 };
        canvas.outlineEditor._rebuildSnapCandidateCache();

        const snapped = canvas.outlineEditor._applySnapToDelta(
            38,
            3,
            118,
            3,
            80,
            0
        );
        expect(snapped).toEqual({ deltaX: 40, deltaY: 4 });
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'active', x: 120 }),
                ySource: expect.objectContaining({ source: 'active', y: 4 })
            })
        );
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                snapTarget: expect.objectContaining({
                    snappedX: 120,
                    snappedY: 4
                })
            })
        );
    });

    test('still snaps drawing to open contour ends when Node Snapping is off', () => {
        localStorage.setItem('editorNodeSnapping', 'false');
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 20, y: 30, nodetype: 'Move' },
                        { x: 90, y: 30, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    nodes: [
                        { x: 120, y: 90, nodetype: 'Move' },
                        { x: 160, y: 90, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 118, glyphY: 93 });

        try {
            canvas.outlineEditor.setCommandKeyPressed(true);
            expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
                expect.objectContaining({
                    naturalPos: { x: 118, y: 93 },
                    snapTarget: expect.objectContaining({
                        snappedX: 120,
                        snappedY: 90
                    }),
                    closeTargets: expect.arrayContaining([
                        expect.objectContaining({
                            x: 120,
                            y: 90,
                            role: 'other-end',
                            active: true
                        })
                    ])
                })
            );
        } finally {
            pointerSpy.mockRestore();
        }
    });

    test('alt-constrained smooth on-curve dragging still honors reachable snap candidates', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 70, y: 90, nodetype: 'OffCurve', smooth: false },
                        { x: 90, y: 90, nodetype: 'Curve', smooth: true },
                        { x: 110, y: 90, nodetype: 'OffCurve', smooth: false },
                        { x: 150, y: 90, nodetype: 'Curve', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor.altKeyPressed = true;
        canvas.outlineEditor._snapDragStartMouseX = 90;
        canvas.outlineEditor._snapDragStartMouseY = 90;
        canvas.outlineEditor._snapDragStartNodePos = { x: 90, y: 90 };
        canvas.outlineEditor._smoothOnCurveAltDragConstraint = {
            contourIndex: 0,
            nodeIndex: 2,
            linePointX: 70,
            linePointY: 90,
            directionX: 40,
            directionY: 0
        };
        canvas.outlineEditor._snapCandidateCache = {
            activeOnlyDragCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            allDragCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            debugCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            snapDistFontUnits: 5,
            metricsYValues: []
        };

        const snapped = canvas.outlineEditor._applySnapToDelta(
            28,
            3,
            118,
            93,
            90,
            90
        );

        canvas.outlineEditor.applySelectedPointMove(
            canvas.outlineEditor.layerData,
            snapped.deltaX,
            snapped.deltaY,
            false,
            false,
            118,
            93,
            true
        );

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[2].x).toBe(120);
        expect(nodes[2].y).toBe(90);
        expect(nodes[1].x).toBe(70);
        expect(nodes[1].y).toBe(90);
        expect(nodes[3].x).toBe(110);
        expect(nodes[3].y).toBe(90);
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'active' }),
                ySource: expect.objectContaining({ source: 'active' })
            })
        );
    });

    test('smooth on-curve dragging honors reachable snap candidates without alt', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 70, y: 90, nodetype: 'OffCurve', smooth: false },
                        { x: 90, y: 90, nodetype: 'Curve', smooth: true },
                        { x: 110, y: 90, nodetype: 'OffCurve', smooth: false },
                        { x: 150, y: 90, nodetype: 'Curve', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor.altKeyPressed = false;
        canvas.outlineEditor._snapDragStartMouseX = 90;
        canvas.outlineEditor._snapDragStartMouseY = 90;
        canvas.outlineEditor._snapDragStartNodePos = { x: 90, y: 90 };
        canvas.outlineEditor._smoothOnCurveAltDragConstraint = {
            contourIndex: 0,
            nodeIndex: 2,
            linePointX: 70,
            linePointY: 90,
            directionX: 40,
            directionY: 0
        };
        canvas.outlineEditor._snapCandidateCache = {
            activeOnlyDragCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            allDragCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            debugCandidates: [
                { x: 90, y: 90, source: 'origin' },
                { x: 120, y: 90, source: 'active' }
            ],
            snapDistFontUnits: 5,
            metricsYValues: []
        };

        const snapped = canvas.outlineEditor._applySnapToDelta(
            28,
            3,
            118,
            93,
            90,
            90
        );

        canvas.outlineEditor.applySelectedPointMove(
            canvas.outlineEditor.layerData,
            snapped.deltaX,
            snapped.deltaY,
            false,
            false,
            118,
            93,
            false
        );

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[2].x).toBe(120);
        expect(nodes[2].y).toBe(90);
        expect(nodes[1].x).toBe(100);
        expect(nodes[1].y).toBe(90);
        expect(nodes[3].x).toBe(140);
        expect(nodes[3].y).toBe(90);
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'active' }),
                ySource: expect.objectContaining({ source: 'active' })
            })
        );
    });

    test('live smooth on-curve dragging without alt snaps to candidate nodes instead of raw pointer increments', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, {
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Move', smooth: false },
                            {
                                x: 70,
                                y: 90,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            { x: 90, y: 90, nodetype: 'Curve', smooth: true },
                            {
                                x: 110,
                                y: 90,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            { x: 120, y: 90, nodetype: 'Curve', smooth: false },
                            { x: 160, y: 90, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            });
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 2
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 90, glyphY: 90 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            pointer = { glyphX: 118, glyphY: 93 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[2].x).toBe(120);
            expect(nodes[2].y).toBe(90);
            expect(nodes[1].x).toBe(100);
            expect(nodes[1].y).toBe(90);
            expect(nodes[3].x).toBe(140);
            expect(nodes[3].y).toBe(90);
            expect(canvas.outlineEditor.activeSnapTarget).toEqual(
                expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'active' }),
                    ySource: expect.objectContaining({ source: 'active' })
                })
            );

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('live off-curve dragging without alt snaps to candidate nodes', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, {
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve', smooth: false },
                            {
                                x: 90,
                                y: 90,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 130,
                                y: 90,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 170,
                                y: 90,
                                nodetype: 'Curve',
                                smooth: false
                            }
                        ],
                        closed: false
                    },
                    {
                        nodes: [
                            { x: 120, y: 90, nodetype: 'Line', smooth: false },
                            { x: 160, y: 90, nodetype: 'Line', smooth: false },
                            { x: 160, y: 130, nodetype: 'Line', smooth: false }
                        ],
                        closed: true
                    }
                ],
                anchors: [],
                guides: []
            });
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 90, glyphY: 90 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            pointer = { glyphX: 118, glyphY: 93 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[1].x).toBe(120);
            expect(nodes[1].y).toBe(90);
            expect(canvas.outlineEditor.activeSnapTarget).toEqual(
                expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'active' }),
                    ySource: expect.objectContaining({ source: 'active' })
                })
            );

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('command-path preview and appended points snap to candidate nodes when drawing new points', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 30, nodetype: 'Move' },
                                        { x: 90, y: 30, nodetype: 'Line' }
                                    ],
                                    closed: false
                                },
                                {
                                    nodes: [
                                        { x: 120, y: 90, nodetype: 'Move' },
                                        { x: 160, y: 90, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Command Snap Canonical' } },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const layer = glyph.findLayerById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 118, glyphY: 93 });
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
            start: { x: 90, y: 30 },
            end: { x: 120, y: 90 }
        });
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 118, y: 93 },
                snapTarget: expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'active' }),
                    ySource: expect.objectContaining({ source: 'active' }),
                    snappedX: 120,
                    snappedY: 90
                })
            })
        );

        expect(canvas.outlineEditor.beginCommandPathDrawing()).toBe(true);

        const modelNodes = layer.paths[0].nodes;
        expect(modelNodes[modelNodes.length - 1]).toEqual(
            expect.objectContaining({ x: 120, y: 90, nodetype: 'Line' })
        );

        compileSpy.mockRestore();
        pointerSpy.mockRestore();
    });

    test('cmd-hover exposes node and metric snapping before the first drawing point exists', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 120, y: 40, nodetype: 'Move' },
                        { x: 160, y: 40, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.renderVerticalMetrics = { xHeight: 90 };

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 118, glyphY: 88 });

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toBeNull();
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 118, y: 88 },
                originPos: null,
                snapTarget: expect.objectContaining({
                    ySource: expect.objectContaining({ source: 'metric' }),
                    snappedY: 90
                }),
                closeTargets: expect.arrayContaining([
                    expect.objectContaining({
                        x: 120,
                        y: 40,
                        role: 'other-end'
                    })
                ])
            })
        );

        pointerSpy.mockRestore();
    });

    test('cmd-hover repaints even before a preview line exists so metric snap feedback is visible', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [],
            anchors: [],
            guides: []
        });
        canvas.outlineEditor.renderVerticalMetrics = { xHeight: 90 };

        const renderSpy = jest.spyOn(canvas, 'render');

        canvas.outlineEditor.setCommandKeyPressed(true);
        renderSpy.mockClear();

        canvas.onMouseMoveHover({
            clientX: 10,
            clientY: 20,
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false
        });

        expect(canvas.outlineEditor.shouldRenderCommandPathPreview()).toBe(
            false
        );
        expect(renderSpy).toHaveBeenCalled();

        renderSpy.mockRestore();
    });

    test('cmd-hover snaps to the active glyph edge before the first drawing point exists', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [],
            anchors: [],
            guides: []
        });

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 518, glyphY: 88 });

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 518, y: 88 },
                snapTarget: expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'edge' }),
                    snappedX: 520,
                    snappedY: 88
                })
            })
        );

        pointerSpy.mockRestore();
    });

    test('dragging an existing point snaps to the active glyph edge', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 500, y: 90, nodetype: 'Move', smooth: false },
                        { x: 500, y: 130, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor._snapDragStartMouseX = 500;
        canvas.outlineEditor._snapDragStartMouseY = 90;
        canvas.outlineEditor._snapDragStartNodePos = { x: 500, y: 90 };
        canvas.outlineEditor._snapCandidateCache =
            canvas.outlineEditor._buildSnapCandidateCache({ x: 500, y: 90 });

        const snapped = canvas.outlineEditor._applySnapToDelta(
            18,
            0,
            518,
            90,
            500,
            90
        );

        expect(snapped).toEqual({ deltaX: 20, deltaY: 0 });
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'edge' }),
                snappedX: 520,
                snappedY: 90
            })
        );
    });

    test('dragging an anchor reuses point snap candidates and its origin candidate', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 120, y: 90, nodetype: 'Move', smooth: false },
                        { x: 180, y: 90, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [{ name: 'top', x: 60, y: 60 }],
            guides: []
        });

        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.outlineEditor._snapDragStartMouseX = 60;
        canvas.outlineEditor._snapDragStartMouseY = 60;
        canvas.outlineEditor._snapDragStartNodePos = { x: 60, y: 60 };
        canvas.outlineEditor._snapCandidateCache =
            canvas.outlineEditor._buildSnapCandidateCache({ x: 60, y: 60 });

        const snapped = canvas.outlineEditor._applySnapToDelta(
            58,
            32,
            118,
            92,
            60,
            60
        );

        expect(snapped).toEqual({ deltaX: 60, deltaY: 30 });
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 118, y: 92 },
                originPos: { x: 60, y: 60 },
                debugCandidates: expect.arrayContaining([
                    expect.objectContaining({
                        source: 'origin',
                        x: 60,
                        y: 60
                    })
                ]),
                snapTarget: expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'active' }),
                    ySource: expect.objectContaining({ source: 'active' }),
                    snappedX: 120,
                    snappedY: 90
                })
            })
        );
    });

    test('starting a command path snaps the first point to a vertical metric line', () => {
        const font = makeSinglePathFont([], false);

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const layer = glyph.findLayerById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.renderVerticalMetrics = { xHeight: 90 };
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 54, glyphY: 88 });
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        canvas.outlineEditor.setCommandKeyPressed(true);
        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                snapTarget: expect.objectContaining({
                    ySource: expect.objectContaining({ source: 'metric' }),
                    snappedY: 90
                })
            })
        );

        expect(canvas.outlineEditor.beginCommandPathDrawing()).toBe(true);

        const liveShape = canvas.outlineEditor.layerData.shapes.at(-1);
        expect(liveShape.nodes[0]).toEqual(
            expect.objectContaining({ x: 54, y: 90 })
        );

        const liveLayer = glyph.findLayerById('layer-1');
        expect(liveLayer.paths.at(-1).nodes[0]).toEqual(
            expect.objectContaining({ x: 54, y: 90 })
        );

        compileSpy.mockRestore();
        pointerSpy.mockRestore();
    });

    test('command-path preview includes the drawing origin as a snap candidate after the first point', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Command Origin Canonical' } },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const layer = glyph.findLayerById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );

        let pointer = { glyphX: 90, glyphY: 30 };
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementation(() => pointer);
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        canvas.outlineEditor.setCommandKeyPressed(true);
        expect(canvas.outlineEditor.beginCommandPathDrawing()).toBe(true);

        pointer = { glyphX: 92, glyphY: 32 };

        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 92, y: 32 },
                originPos: { x: 90, y: 30 },
                snapTarget: expect.objectContaining({
                    xSource: expect.objectContaining({ source: 'origin' }),
                    ySource: expect.objectContaining({ source: 'origin' }),
                    snappedX: 90,
                    snappedY: 30
                })
            })
        );

        compileSpy.mockRestore();
        pointerSpy.mockRestore();
    });

    test('command-path preview line hides while cmd-hovering a different non-endpoint point', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Move', smooth: false },
                { x: 90, y: 30, nodetype: 'Line', smooth: false },
                { x: 150, y: 60, nodetype: 'Line', smooth: false }
            ],
            false
        );

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const layer = glyph.findLayerById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 180, glyphY: 90 });

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
            start: { x: 150, y: 60 },
            end: { x: 180, y: 90 }
        });

        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toBeNull();

        canvas.outlineEditor.hoveredPointIndex = null;

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
            start: { x: 150, y: 60 },
            end: { x: 180, y: 90 }
        });

        pointerSpy.mockRestore();
    });

    test('command-path preview line stays visible while cmd-hovering an open endpoint so closing remains prioritized', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 40, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 120, y: 0, nodetype: 'Move', smooth: false },
                    { x: 80, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 1,
            nodeIndex: 1
        };

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 80, glyphY: 0 });

        try {
            canvas.outlineEditor.setCommandKeyPressed(true);

            expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
                start: { x: 40, y: 0 },
                end: { x: 80, y: 0 }
            });
        } finally {
            pointerSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('current command-path endpoint remains a node snap candidate when it sits on a vertical metric line', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 80, y: 90, nodetype: 'Move' },
                                        { x: 120, y: 90, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Command Endpoint Candidate' } },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const layer = glyph.findLayerById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.renderVerticalMetrics = { xHeight: 90 };
        canvas.outlineEditor.activePathDrawingSession = {
            shapeIndex: 0,
            pathIndex: 0,
            edge: 'end',
            startedFromExistingPath: false,
            originNodeIndex: 0,
            segmentCount: 1
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 118, glyphY: 88 });

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getSnapVisualizationState()).toEqual(
            expect.objectContaining({
                naturalPos: { x: 118, y: 88 },
                snapTarget: expect.objectContaining({
                    ySource: expect.objectContaining({ source: 'metric' }),
                    snappedY: 90
                })
            })
        );
        expect(
            canvas.outlineEditor.getSnapVisualizationState()?.snapTarget
                ?.snappedX
        ).not.toBe(120);

        pointerSpy.mockRestore();
    });

    test('cmd-click on a smooth closed-path node opens the path and clears smoothness on both duplicates', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Line', smooth: false },
                { x: 20, y: 30, nodetype: 'OffCurve', smooth: false },
                { x: 40, y: 30, nodetype: 'OffCurve', smooth: false },
                { x: 60, y: 0, nodetype: 'Curve', smooth: true },
                { x: 120, y: 0, nodetype: 'Line', smooth: false }
            ],
            true
        );
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { glyph, layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };

        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(layer.shapes).toHaveLength(1);
            expect(layer.paths[0].closed).toBe(false);
            expect(layer.paths[0].nodes[0]).toEqual(
                expect.objectContaining({
                    x: 60,
                    y: 0,
                    nodetype: 'Move',
                    smooth: false
                })
            );
            expect(
                layer.paths[0].nodes[layer.paths[0].nodes.length - 1]
            ).toEqual(expect.objectContaining({ x: 60, y: 0, smooth: false }));
        } finally {
            compileSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('cmd-click on an already-open path cuts it into two open paths at the clicked point', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 30, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 30, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 0, nodetype: 'Curve', smooth: true },
                    { x: 120, y: 0, nodetype: 'Line', smooth: false },
                    { x: 0, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { glyph, layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(layer.shapes).toHaveLength(2);
            expect(layer.paths[0].closed).toBe(false);
            expect(layer.paths[1].closed).toBe(false);
            expect(
                layer.paths[0].nodes[layer.paths[0].nodes.length - 1]
            ).toEqual(expect.objectContaining({ x: 60, y: 0, smooth: false }));
            expect(layer.paths[1].nodes[0]).toEqual(
                expect.objectContaining({
                    x: 60,
                    y: 0,
                    nodetype: 'Move',
                    smooth: false
                })
            );
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
        } finally {
            modelBinding.restore();
        }
    });

    test('cmd-cut keeps the new endpoint selected and resumes command-path preview', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Line', smooth: false },
                { x: 20, y: 30, nodetype: 'OffCurve', smooth: false },
                { x: 40, y: 30, nodetype: 'OffCurve', smooth: false },
                { x: 60, y: 0, nodetype: 'Curve', smooth: true },
                { x: 120, y: 0, nodetype: 'Line', smooth: false }
            ],
            true
        );
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 90, glyphY: 20 });
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.setCommandKeyPressed(true);

            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(canvas.outlineEditor.selectedPoints).toEqual([
                {
                    contourIndex: 1,
                    nodeIndex: 0
                }
            ]);
            expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
                start: { x: 90, y: 20 },
                end: { x: 90, y: 20 }
            });
            expect(canvas.outlineEditor.beginCommandPathDrawing()).toBe(true);

            canvas.outlineEditor.setCommandKeyPressed(false);
            canvas.outlineEditor.setCommandKeyPressed(true);

            const selectedNode = layer.paths[1].nodes[0];
            expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
                start: { x: selectedNode.x, y: selectedNode.y },
                end: { x: 90, y: 20 }
            });
        } finally {
            compileSpy.mockRestore();
            pointerSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('cmd drawing extends the active path instead of inserting an add-point previewed node', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 40, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 100, y: 0, nodetype: 'Move', smooth: false },
                    { x: 160, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { glyph, layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.activePathDrawingSession = {
            shapeIndex: 0,
            pathIndex: 0,
            edge: 'end',
            startedFromExistingPath: false,
            originNodeIndex: 0,
            segmentCount: 0
        };
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 1,
            pathIndex: 1,
            segmentId: 0,
            t: 0.5,
            point: { x: 130, y: 0 },
            segments: []
        };

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 80, glyphY: 20 });
        const commitSpy = jest.spyOn(
            canvas.outlineEditor,
            'commitHoveredAddPointPreview'
        );
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(commitSpy).not.toHaveBeenCalled();
            expect(layer.paths[0].nodes).toHaveLength(3);
            expect(layer.paths[0].nodes[2]).toEqual(
                expect.objectContaining({ x: 80, y: 20, nodetype: 'Line' })
            );
            expect(layer.paths[1].nodes).toHaveLength(2);
        } finally {
            compileSpy.mockRestore();
            commitSpy.mockRestore();
            pointerSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('cmd drawing extends the active path even when a neighboring glyph is hovered', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 40, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.hoveredGlyphIndex = 1;

        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 560, glyphY: 20 });
        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(layer.paths[0].nodes).toHaveLength(3);
            expect(layer.paths[0].nodes[2]).toEqual(
                expect.objectContaining({ x: 560, y: 20, nodetype: 'Line' })
            );
            expect(canvas.outlineEditor.activePathDrawingSession).toEqual(
                expect.objectContaining({
                    shapeIndex: 0,
                    pathIndex: 0,
                    edge: 'end'
                })
            );
        } finally {
            compileSpy.mockRestore();
            pointerSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('cmd drawing from a selected endpoint connects to another open path endpoint regardless of target direction', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 40, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 120, y: 0, nodetype: 'Move', smooth: false },
                    { x: 80, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { glyph, layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 1,
            nodeIndex: 1
        };

        const compileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(layer.shapes).toHaveLength(1);
            expect(layer.paths[0].closed).toBe(false);
            expect(layer.paths[0].nodes.map((node) => node.x)).toEqual([
                0, 80, 120
            ]);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 1 }
            ]);
        } finally {
            compileSpy.mockRestore();
            modelBinding.restore();
        }
    });

    test('dragging an open endpoint onto another path endpoint connects the two paths and combines the nodes', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 80, y: 0, nodetype: 'Move', smooth: false },
                    { x: 120, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 40, y: 0, nodetype: 'Move', smooth: false },
                    { x: 0, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { glyph, layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData.shapes[0].nodes[0].x = 40;
        canvas.outlineEditor.layerData.shapes[0].nodes[0].y = 0;

        try {
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            canvas.outlineEditor.onMouseUp({});

            expect(layer.shapes).toHaveLength(1);
            expect(layer.paths[0].closed).toBe(false);
            expect(layer.paths[0].nodes.map((node) => node.x)).toEqual([
                120, 40, 0
            ]);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 1 }
            ]);
        } finally {
            modelBinding.restore();
        }
    });

    test('dragging an open curved endpoint onto another curved endpoint smooths the combined node when both handles align', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 100, y: 0, nodetype: 'Move', smooth: false },
                    { x: 120, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: 140, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: 160, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 3 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData.shapes[0].nodes[3].x = 100;
        canvas.outlineEditor.layerData.shapes[0].nodes[3].y = 0;

        try {
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            canvas.outlineEditor.onMouseUp({});

            expect(layer.shapes).toHaveLength(1);
            expect(layer.paths[0].closed).toBe(false);
            expect(layer.paths[0].nodes[3]).toEqual(
                expect.objectContaining({ x: 100, y: 0, smooth: true })
            );
        } finally {
            modelBinding.restore();
        }
    });

    test('dragging an endpoint as part of a multi-point selection still connects open paths', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 80, y: 0, nodetype: 'Move', smooth: false },
                    { x: 120, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 40, y: 0, nodetype: 'Move', smooth: false },
                    { x: 0, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor._dragConnectionSourcePoint = {
            contourIndex: 0,
            nodeIndex: 0
        };
        canvas.outlineEditor.layerData.shapes[0].nodes[0].x = 40;
        canvas.outlineEditor.layerData.shapes[0].nodes[0].y = 0;

        try {
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            canvas.outlineEditor.onMouseUp({});

            expect(layer.shapes).toHaveLength(1);
            expect(layer.paths[0].nodes.map((node) => node.x)).toEqual([
                120, 40, 0
            ]);
        } finally {
            modelBinding.restore();
        }
    });

    test('lifting a coincident open endpoint away and returning it in the same drag closes the contour and restores smoothness when aligned', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 100, y: 0, nodetype: 'Line', smooth: false },
                    { x: 60, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: -20, y: 0, nodetype: 'OffCurve', smooth: false },
                    { x: 0, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor._dragConnectionSourcePoint = {
            contourIndex: 0,
            nodeIndex: 0
        };
        canvas.outlineEditor._dragStartEndpointsCoincident = true;
        canvas.outlineEditor._dragSeparatedFromCoincidentEndpointPair = false;

        try {
            canvas.outlineEditor.layerData.shapes[0].nodes[0].x = 200;
            canvas.outlineEditor.layerData.shapes[0].nodes[0].y = 0;
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            expect(canvas.outlineEditor.isSnappedToCloseOpenPath).toBe(false);

            canvas.outlineEditor.layerData.shapes[0].nodes[0].x = 0;
            canvas.outlineEditor.layerData.shapes[0].nodes[0].y = 0;
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            expect(canvas.outlineEditor.isSnappedToCloseOpenPath).toBe(true);

            canvas.outlineEditor.onMouseUp({});

            expect(layer.paths[0].closed).toBe(true);
            expect(layer.paths[0].nodes[0].x).toBe(0);
            expect(layer.paths[0].nodes[0].y).toBe(0);
            expect(layer.paths[0].nodes[0].smooth).toBe(true);
        } finally {
            modelBinding.restore();
        }
    });

    test('dragging an endpoint connection also connects any other coincident open endpoints in the same sync', () => {
        const font = makeFontWithShapes([
            {
                nodes: [
                    { x: 80, y: 0, nodetype: 'Move', smooth: false },
                    { x: 120, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 40, y: 0, nodetype: 'Move', smooth: false },
                    { x: 0, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 240, y: 0, nodetype: 'Move', smooth: false },
                    { x: 200, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            },
            {
                nodes: [
                    { x: 200, y: 0, nodetype: 'Move', smooth: false },
                    { x: 160, y: 0, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ]);
        window.currentFontModel = font;
        const modelBinding = bindActiveGlyphModel(canvas, font);
        const { layer } = modelBinding;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        activateEditableLayer(
            canvas,
            JSON.parse(JSON.stringify(layer.toJSON()))
        );
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData.shapes[0].nodes[0].x = 40;
        canvas.outlineEditor.layerData.shapes[0].nodes[0].y = 0;

        try {
            canvas.outlineEditor._checkOpenPathEndpointSnap();
            canvas.outlineEditor.onMouseUp({});

            expect(layer.shapes).toHaveLength(2);
            expect(layer.paths[0].nodes.map((node) => node.x)).toEqual([
                120, 40, 0
            ]);
            expect(layer.paths[1].nodes.map((node) => node.x)).toEqual([
                240, 200, 160
            ]);
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
        } finally {
            modelBinding.restore();
        }
    });

    test('drawOutlineEditor marks duplicate node positions with a red circle underline even across separate paths', () => {
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 520, dx: 0, dy: 0, g: 0 }];
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [{ x: 40, y: 0, nodetype: 'Move', smooth: false }],
                    closed: false
                },
                {
                    nodes: [{ x: 40, y: 0, nodetype: 'Move', smooth: false }],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.renderer.ctx.arc.mockClear();
        canvas.renderer.ctx.lineTo.mockClear();
        canvas.renderer.ctx.stroke.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(canvas.renderer.ctx.arc).toHaveBeenCalledWith(
            0,
            0,
            expect.any(Number),
            0,
            Math.PI * 2
        );
        const moveCalls = canvas.renderer.ctx.moveTo.mock.calls;
        const lineCalls = canvas.renderer.ctx.lineTo.mock.calls;
        const drewHorizontalUnderline = moveCalls.some(([moveX, moveY]) =>
            lineCalls.some(
                ([lineX, lineY]) =>
                    moveY === lineY &&
                    Math.abs(moveX + lineX) < 0.001 &&
                    Math.abs(moveX) > 0
            )
        );
        expect(drewHorizontalUnderline).toBe(true);
        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
    });

    test('a snapped curved open endpoint does not keep dragging its attached handle after the endpoint is pinned', () => {
        activateEditableLayer(canvas, {
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 20, y: 30, nodetype: 'OffCurve', smooth: false },
                        { x: 40, y: 30, nodetype: 'OffCurve', smooth: false },
                        { x: 60, y: 0, nodetype: 'Curve', smooth: false }
                    ],
                    closed: false
                },
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Move', smooth: false },
                        { x: 120, y: 30, nodetype: 'OffCurve', smooth: false },
                        { x: 140, y: 30, nodetype: 'OffCurve', smooth: false },
                        { x: 160, y: 0, nodetype: 'Curve', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 3 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.lastGlyphX = null;
        canvas.outlineEditor.lastGlyphY = null;
        canvas.outlineEditor._snapDragStartMouseX = null;
        canvas.outlineEditor._snapDragStartMouseY = null;
        canvas.outlineEditor._snapDragStartNodePos = null;
        canvas.outlineEditor._snapCandidateCache = null;
        canvas.outlineEditor._dragStartEndpointsCoincident = false;

        let pointer = { glyphX: 100, glyphY: 0 };
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementation(() => pointer);
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const propertySpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const saveSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            canvas.outlineEditor._handleDrag({
                clientX: 0,
                clientY: 0,
                shiftKey: false,
                altKey: false
            });

            const snappedHandle = {
                x: canvas.outlineEditor.layerData.shapes[0].nodes[2].x,
                y: canvas.outlineEditor.layerData.shapes[0].nodes[2].y
            };
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[3]).toEqual(
                expect.objectContaining({ x: 100, y: 0 })
            );

            pointer = { glyphX: 104, glyphY: 2 };
            canvas.outlineEditor._handleDrag({
                clientX: 0,
                clientY: 0,
                shiftKey: false,
                altKey: false
            });

            expect(canvas.outlineEditor.layerData.shapes[0].nodes[3]).toEqual(
                expect.objectContaining({ x: 100, y: 0 })
            );
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[2]).toEqual(
                expect.objectContaining(snappedHandle)
            );
        } finally {
            pointerSpy.mockRestore();
            renderSpy.mockRestore();
            propertySpy.mockRestore();
            saveSpy.mockRestore();
        }
    });

    test('restores node and anchor selections through the active layer model', () => {
        const font = makeFontWithShapes(
            [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move', smooth: false },
                        { x: 120, y: 0, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            [{ name: 'top', x: 60, y: 100 }]
        );
        window.currentFontModel = font;
        window.glyphCanvas = canvas;
        const modelBinding = bindActiveGlyphModel(canvas, font);

        try {
            activateEditableLayer(
                canvas,
                JSON.parse(JSON.stringify(modelBinding.layer.toJSON()))
            );
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 1 }
            ];
            canvas.outlineEditor.selectedAnchors = [0];

            const savedSelection = [...modelBinding.layer.selection];
            expect(savedSelection).toHaveLength(2);

            canvas.outlineEditor.selectedPoints = [];
            canvas.outlineEditor.selectedAnchors = [];
            modelBinding.layer.selection = savedSelection;

            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 1 }
            ]);
            expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        } finally {
            modelBinding.restore();
        }
    });
});
