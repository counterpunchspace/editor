describe('GlyphCanvas onMouseMove', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        // Set up mock state
        canvas.selectedGlyphIndex = 0;
        canvas.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 0, 0] } },
                { nodes: [[0, 0, 'l']] }
            ],
            anchors: [{ x: 0, y: 0 }]
        };
        canvas.selectedComponents = [0];
        canvas.selectedPoints = [{ contourIndex: 1, nodeIndex: 0 }];
        canvas.selectedAnchors = [0];
        canvas.viewportManager = new ViewportManager(1, 0, 0);
        canvas.lastGlyphX = null;
        canvas.lastGlyphY = null;
    });

    test('handles component dragging correctly', () => {
        canvas.isDraggingComponent = true;
        // First move sets the initial position, delta is 0
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        expect(canvas.layerData.shapes[0].Component.transform[4]).toBe(0);
        expect(canvas.layerData.shapes[0].Component.transform[5]).toBe(0);

        // Second move performs the drag
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        // deltaX = 25 - 10 = 15
        // deltaY = -15 - (-20) = 5
        expect(canvas.layerData.shapes[0].Component.transform[4]).toBe(15);
        expect(canvas.layerData.shapes[0].Component.transform[5]).toBe(5);
    });

    test('handles anchor dragging correctly', () => {
        canvas.isDraggingAnchor = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.layerData.anchors[0].x).toBe(15);
        expect(canvas.layerData.anchors[0].y).toBe(5);
    });

    test('handles point dragging correctly', () => {
        canvas.isDraggingPoint = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.layerData.shapes[1].nodes[0][0]).toBe(15);
        expect(canvas.layerData.shapes[1].nodes[0][1]).toBe(5);
    });
});

describe('GlyphCanvas hit testing', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                { nodes: [[200, 200, 'l']] }
            ],
            anchors: [{ x: 300, y: 300 }]
        };
        canvas.viewportManager = new ViewportManager(1, 0, 0);
    });

    test('should correctly identify hovered component', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.updateHoveredComponent();
        expect(canvas.hoveredComponentIndex).toBe(0);
    });

    test('should correctly identify hovered anchor', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.updateHoveredAnchor();
        expect(canvas.hoveredAnchorIndex).toBe(0);
    });

    test('should correctly identify hovered point', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.updateHoveredPoint();
        expect(canvas.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });
});

describe('GlyphCanvas animation setup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.axesManager.variationSettings = { wght: 400 };
        // Mock the animateVariation method to prevent it from running
        canvas.axesManager.animateVariation = jest.fn();
    });

    test('setVariation should set up animation correctly', () => {
        canvas.axesManager.setVariation('wght', 700);
        expect(canvas.axesManager.isAnimating).toBe(true);
        expect(canvas.axesManager.animationStartValues).toEqual({ wght: 400 });
        expect(canvas.axesManager.animationTargetValues).toEqual({ wght: 700 });
        expect(canvas.axesManager.animationCurrentFrame).toBe(0);
        expect(canvas.axesManager.animateVariation).toHaveBeenCalled();
    });
});

describe('GlyphCanvas mirrored functions', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { cl: 0, g: 0 },
            { cl: 1, g: 1 },
            { cl: 1, g: 2 },
            { cl: 2, g: 3 }
        ];
    });

    test('findFirstGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(1)).toBe(1);
    });

    test('findLastGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(1)).toBe(2);
    });
});
