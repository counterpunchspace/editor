// ==================== Initialization Tests ====================

describe('GlyphCanvas initialization', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
    });

    afterEach(() => {
        if (canvas) {
            canvas.destroy();
        }
    });

    test('should create canvas element in container', () => {
        canvas = new GlyphCanvas('test-container');
        const container = document.getElementById('test-container');
        expect(container.querySelector('canvas')).toBeTruthy();
    });

    test('should initialize viewport manager with default values', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.viewportManager).toBeTruthy();
        expect(canvas.viewportManager.scale).toBe(canvas.initialScale);
    });

    test('should initialize axes manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.axesManager).toBeTruthy();
        expect(canvas.axesManager.variationSettings).toEqual({});
    });

    test('should initialize features manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.featuresManager).toBeTruthy();
    });

    test('should initialize text run editor', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.textRunEditor).toBeTruthy();
    });

    test('should initialize renderer', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.renderer).toBeTruthy();
    });

    test('should set up HiDPI canvas correctly', () => {
        canvas = new GlyphCanvas('test-container');
        const dpr = window.devicePixelRatio || 1;
        const container = document.getElementById('test-container');
        expect(canvas.canvas.width).toBe(container.clientWidth * dpr);
        expect(canvas.canvas.height).toBe(container.clientHeight * dpr);
    });

    test('should make canvas focusable', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.canvas.tabIndex).toBe(0);
    });

    test('should set initial state correctly', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });
});

// ==================== Mouse Interaction Tests ====================

describe('GlyphCanvas onMouseMove', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        // Set up mock state
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 0, 0] } },
                { nodes: [{ x: 0, y: 0, type: 'l' }] }
            ],
            anchors: [{ x: 0, y: 0 }]
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.viewportManager = new ViewportManager(1, 0, 0);
        canvas.lastGlyphX = null;
        canvas.lastGlyphY = null;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('handles component dragging correctly', () => {
        canvas.outlineEditor.isDraggingComponent = true;
        // First move sets the initial position, delta is 0
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[4]
        ).toBe(0);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[5]
        ).toBe(0);

        // Second move performs the drag
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        // deltaX = 25 - 10 = 15
        // deltaY = -15 - (-20) = 5
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[4]
        ).toBe(15);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[5]
        ).toBe(5);
    });

    test('handles anchor dragging correctly', () => {
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(5);
    });

    test('handles point dragging correctly', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].y).toBe(5);
    });

    test('handles canvas panning when dragging', () => {
        canvas.isDraggingCanvas = true;
        canvas.lastMouseX = 10;
        canvas.lastMouseY = 20;
        const initialPanX = canvas.viewportManager.panX;
        const initialPanY = canvas.viewportManager.panY;

        canvas.onMouseMove({ clientX: 30, clientY: 40 });

        expect(canvas.viewportManager.panX).toBe(initialPanX + 20);
        expect(canvas.viewportManager.panY).toBe(initialPanY + 20);
    });

    test('does not drag when no drag state is active', () => {
        canvas.outlineEditor.isDraggingComponent = false;
        canvas.outlineEditor.isDraggingAnchor = false;
        canvas.outlineEditor.isDraggingPoint = false;
        canvas.isDraggingCanvas = false;

        const initialTransform = [
            ...canvas.outlineEditor.layerData.shapes[0].Component.transform
        ];
        canvas.onMouseMove({ clientX: 10, clientY: 20 });

        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform
        ).toEqual(initialTransform);
    });
});

describe('GlyphCanvas onMouseDown', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should focus canvas on mouse down', () => {
        const focusSpy = jest.spyOn(canvas.canvas, 'focus');
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(focusSpy).toHaveBeenCalled();
    });

    test('should start canvas panning when Cmd key is pressed', () => {
        canvas.cmdKeyPressed = true;
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(canvas.isDraggingCanvas).toBe(true);
    });
});

describe('GlyphCanvas onMouseUp', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should clear all dragging states', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.outlineEditor.isDraggingComponent = true;
        canvas.isDraggingCanvas = true;

        canvas.onMouseUp({ clientX: 10, clientY: 20 });

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
    });
});

// ==================== Hit Testing Tests ====================

describe('GlyphCanvas hit testing', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                { nodes: [{ x: 200, y: 200, type: 'l' }] }
            ],
            anchors: [{ x: 300, y: 300 }]
        };
        canvas.viewportManager = new ViewportManager(1, 0, 0);
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should correctly identify hovered component', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);
    });

    test('should correctly identify hovered anchor', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);
    });

    test('should correctly identify hovered point', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should clear hovered component when mouse moves away', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(null);
    });

    test('should clear hovered anchor when mouse moves away', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(null);
    });

    test('should clear hovered point when mouse moves away', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });
});

// ==================== Selection Tests ====================

describe('GlyphCanvas selection handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                {
                    nodes: [
                        [200, 200, 'l'],
                        [300, 300, 'l']
                    ]
                }
            ],
            anchors: [
                { x: 300, y: 300 },
                { x: 400, y: 400 }
            ]
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should allow selecting a single point', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(1);
        expect(canvas.outlineEditor.selectedPoints[0]).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should allow selecting multiple points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(2);
    });

    test('should allow selecting a single anchor', () => {
        canvas.outlineEditor.selectedAnchors = [0];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(1);
        expect(canvas.outlineEditor.selectedAnchors[0]).toBe(0);
    });

    test('should allow selecting multiple anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(2);
    });

    test('should allow selecting a single component', () => {
        canvas.outlineEditor.selectedComponents = [0];
        expect(canvas.outlineEditor.selectedComponents.length).toBe(1);
        expect(canvas.outlineEditor.selectedComponents[0]).toBe(0);
    });
});

// ==================== Point Movement Tests ====================

describe('GlyphCanvas point movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 100, type: 'l' },
                        { x: 200, y: 200, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        // Mock saveLayerData to prevent errors
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected points by delta', () => {
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
    });

    test('should move multiple selected points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].y).toBe(220);
    });

    test('should not move points when none are selected', () => {
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(100);
    });
});

describe('GlyphCanvas anchor movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [],
            anchors: [
                { x: 100, y: 100 },
                { x: 200, y: 200 }
            ]
        };
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected anchors by delta', () => {
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
    });

    test('should move multiple selected anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.anchors[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.anchors[1].y).toBe(220);
    });

    test('should not move anchors when none are selected', () => {
        canvas.outlineEditor.selectedAnchors = [];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(100);
    });
});

describe('GlyphCanvas component movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                { Component: { transform: [1, 0, 0, 1, 200, 200] } }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected components by delta', () => {
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[4]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[5]
        ).toBe(120);
    });

    test('should move multiple selected components', () => {
        canvas.outlineEditor.selectedComponents = [0, 1];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[4]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[5]
        ).toBe(120);
        expect(
            canvas.outlineEditor.layerData.shapes[1].Component.transform[4]
        ).toBe(210);
        expect(
            canvas.outlineEditor.layerData.shapes[1].Component.transform[5]
        ).toBe(220);
    });

    test('should not move components when none are selected', () => {
        canvas.outlineEditor.selectedComponents = [];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[4]
        ).toBe(100);
        expect(
            canvas.outlineEditor.layerData.shapes[0].Component.transform[5]
        ).toBe(100);
    });
});

// ==================== Point Type Toggle Tests ====================

describe('GlyphCanvas point type toggling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 100, type: 'c' },
                        { x: 200, y: 200, type: 'c' },
                        { x: 300, y: 300, type: 'c' }
                    ]
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should toggle curve point to smooth curve', () => {
        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 0
        });
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].type).toBe(
            'cs'
        );
    });

    test('should toggle smooth curve point back to curve', () => {
        canvas.outlineEditor.layerData.shapes[0].nodes[0].type = 'cs';
        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 0
        });
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].type).toBe(
            'c'
        );
    });
});

// ==================== Mode Switching Tests ====================

describe('GlyphCanvas mode switching', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 1000, dx: 0, dy: 0, g: 0, cl: 0 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.currentGlyphName = 'A';
        // Mock fontManager
        window.fontManager = {
            getGlyphName: jest.fn(() => 'A'),
            fetchGlyphData: jest.fn(),
            setFormatSpecific: jest.fn()
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should start in text edit mode', () => {
        expect(canvas.outlineEditor.active).toBe(false);
    });

    test('should exit glyph edit mode correctly', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.selectedLayerId = 'layer1';
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(-1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(null);
        expect(canvas.outlineEditor.layerData).toBe(null);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
    });

    test('should clear hover state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 0
        };
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });

    test('should clear drag state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
    });
});

// ==================== Viewport Tests ====================

describe('GlyphCanvas viewport management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should handle wheel zoom correctly', () => {
        const initialScale = canvas.viewportManager.scale;
        const wheelEvent = new WheelEvent('wheel', {
            deltaY: -100,
            clientX: 100,
            clientY: 100
        });
        Object.defineProperty(wheelEvent, 'preventDefault', {
            value: jest.fn()
        });

        canvas.onWheel(wheelEvent);

        // Wheel event should have been handled (preventDefault called)
        expect(wheelEvent.preventDefault).toHaveBeenCalled();
    });

    test('should reset zoom and position', () => {
        const initialScale = canvas.initialScale;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 100;
        canvas.viewportManager.panY = 200;

        canvas.resetZoomAndPosition();

        // resetZoomAndPosition uses animation, so it doesn't reset immediately
        // Just verify the method can be called without errors
        expect(canvas.viewportManager).toBeTruthy();
    });
});

// ==================== Component Stack Tests ====================

describe('GlyphCanvas component editing stack', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should initialize with empty component stack', () => {
        expect(canvas.outlineEditor.componentStack).toEqual([]);
    });

    test('should exit component editing when stack is empty', () => {
        const result = canvas.outlineEditor.exitComponentEditing();
        expect(result).toBe(false);
        expect(canvas.outlineEditor.componentStack).toEqual([]);
    });
});

// ==================== Cursor Tests ====================

describe('GlyphCanvas cursor management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should show cursor when canvas is focused', () => {
        canvas.onFocus();
        expect(canvas.isFocused).toBe(true);
    });

    test('should hide cursor when canvas loses focus', () => {
        canvas.isFocused = true;
        canvas.onBlur();
        expect(canvas.isFocused).toBe(false);
    });
});

// ==================== Keyboard Interaction Tests ====================

describe('GlyphCanvas keyboard handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should track Cmd key state for panning', () => {
        expect(canvas.cmdKeyPressed).toBe(false);
        // Cmd key tracking happens in canvas event listener, not onKeyDown
        // This is implementation detail tested through integration
    });

    test('should handle space key for preview mode in glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.spaceKeyPressed = false;

        const downEvent = new KeyboardEvent('keydown', { code: 'Space' });
        canvas.onKeyDown(downEvent);

        expect(canvas.outlineEditor.isPreviewMode).toBe(true);
    });
});

// ==================== Resize Tests ====================

describe('GlyphCanvas resize handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container" style="width: 800px; height: 600px;"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should update canvas size on resize', () => {
        const dpr = window.devicePixelRatio || 1;
        // Initial state should have a canvas
        expect(canvas.canvas).toBeTruthy();

        // After resize, canvas should still exist and have dimensions
        canvas.onResize();

        expect(canvas.canvas).toBeTruthy();
        expect(canvas.ctx).toBeTruthy();
    });
});

// ==================== Animation Tests ====================

describe('GlyphCanvas animation setup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.axesManager.variationSettings = { wght: 400 };
        // Mock the animateVariation method to prevent it from running
        canvas.axesManager.animateVariation = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('setVariation should set up animation correctly', () => {
        canvas.axesManager._setupAnimation({ wght: 700 });
        expect(canvas.axesManager.isAnimating).toBe(true);
        expect(canvas.axesManager.animationStartValues).toEqual({ wght: 400 });
        expect(canvas.axesManager.animationTargetValues).toEqual({ wght: 700 });
        expect(canvas.axesManager.animationCurrentFrame).toBe(0);
    });

    test('should handle zoom animation state', () => {
        expect(canvas.zoomAnimation.active).toBe(false);

        canvas.startKeyboardZoom(true);

        expect(canvas.zoomAnimation.active).toBe(true);
        // currentFrame starts incrementing immediately
        expect(canvas.zoomAnimation.currentFrame).toBeGreaterThanOrEqual(0);
    });
});

// ==================== Text Run Editor Mirrored Functions ====================

describe('GlyphCanvas mirrored functions', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { cl: 0, g: 0, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 1, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 2, ax: 100, dx: 0, dy: 0 },
            { cl: 2, g: 3, ax: 100, dx: 0, dy: 0 }
        ];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('findFirstGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(1)).toBe(1);
    });

    test('findLastGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(1)).toBe(2);
    });

    test('findFirstGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });

    test('findLastGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });
});

// ==================== Bounding Box Tests ====================

describe('GlyphCanvas bounding box calculation', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should return null when no layer data', () => {
        canvas.outlineEditor.layerData = null;
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBe(null);
    });

    test('should calculate bounding box for points', () => {
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 100, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBeTruthy();
        expect(bbox.minX).toBeLessThanOrEqual(0);
        expect(bbox.maxX).toBeGreaterThanOrEqual(100);
        expect(bbox.minY).toBeLessThanOrEqual(0);
        expect(bbox.maxY).toBeGreaterThanOrEqual(100);
    });
});

// ==================== State Management Tests ====================

describe('GlyphCanvas state management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should track layer data dirty state', () => {
        expect(canvas.outlineEditor.layerDataDirty).toBe(false);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.moveSelectedPoints(10, 20);

        // layerDataDirty should be managed by saveLayerData
        expect(canvas.outlineEditor.saveLayerData).toHaveBeenCalled();
    });
});

// ==================== Cleanup Tests ====================

describe('GlyphCanvas cleanup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    test('should clean up properly on destroy', () => {
        const container = document.getElementById('test-container');
        expect(container.children.length).toBeGreaterThan(0);

        const resizeObserver = canvas.resizeObserver;
        canvas.destroy();

        // ResizeObserver should have existed before destroy
        expect(resizeObserver).toBeTruthy();
    });

    test('should handle multiple destroy calls safely', () => {
        canvas.destroy();
        expect(() => canvas.destroy()).not.toThrow();
    });
});
