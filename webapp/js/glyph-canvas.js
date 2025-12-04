// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

class GlyphCanvas {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`Container ${containerId} not found`);
            return;
        }

        // Canvas and context
        this.canvas = null;
        this.ctx = null;

        // Transformation state
        this.panX = 0;
        this.panY = 0;
        this.scale = 1.0;
        this.initialScale = 0.2; // Start zoomed out to see glyphs better

        // Text buffer and shaping
        this.textBuffer = localStorage.getItem('glyphCanvasTextBuffer') || "Hamburgevons";
        this.shapedGlyphs = [];
        this.currentFont = null;
        this.fontBlob = null;
        this.opentypeFont = null; // For glyph path extraction
        this.variationSettings = {}; // Store variable axis values
        this.featureSettings = {}; // Store OpenType feature on/off states
        this.defaultFeatureSettings = {}; // Store default states for reset
        this.sourceGlyphNames = {}; // Map of GID to glyph names from source font

        // Bidirectional text support
        this.bidi = null; // Will be initialized with UnicodeBidi instance
        this.bidiRuns = []; // Store bidirectional runs for rendering

        // Cursor state
        this.cursorPosition = 0; // Logical position in textBuffer (0 = before first char)
        this.cursorVisible = true;
        this.cursorBlinkInterval = null;
        this.cursorX = 0; // Visual X position for rendering
        this.clusterMap = []; // Maps logical char positions to visual glyph info
        this.embeddingLevels = null; // BiDi embedding levels for cursor logic

        // Selection state
        this.selectionStart = null; // Start of selection (null = no selection)
        this.selectionEnd = null;   // End of selection

        // Animation state
        this.animationFrames = parseInt(localStorage.getItem('animationFrames') || '10', 10);
        this.isAnimating = false;
        this.animationStartValues = {};
        this.animationTargetValues = {};
        this.animationCurrentFrame = 0;

        // Focus state for background color
        this.isFocused = false;

        // Mouse interaction
        this.mouseX = 0;
        this.mouseY = 0;
        this.hoveredGlyphIndex = -1; // Index of glyph being hovered
        this.glyphBounds = []; // Store bounding boxes for hit testing

        // Selected glyph (glyph after cursor in logical order)
        this.selectedGlyphIndex = -1;

        // Edit mode: false = text edit mode, true = glyph edit mode
        this.isGlyphEditMode = false;

        // Font data and selected layer for layer switching
        this.fontData = null;
        this.selectedLayerId = null;
        this.previousSelectedLayerId = null; // For restoring on Escape
        this.previousVariationSettings = null; // For restoring on Escape

        // Outline editor state
        this.layerData = null; // Cached layer data with shapes
        this.selectedPoints = []; // Array of {contourIndex, nodeIndex} for selected points
        this.hoveredPointIndex = null; // {contourIndex, nodeIndex} for hovered point
        this.selectedAnchors = []; // Array of anchor indices for selected anchors
        this.hoveredAnchorIndex = null; // Index for hovered anchor
        this.selectedComponents = []; // Array of component indices for selected components
        this.hoveredComponentIndex = null; // Index for hovered component
        this.isDraggingPoint = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        this.layerDataDirty = false; // Track if layer data needs saving
        this.isPreviewMode = false; // Preview mode hides outline editor
        this.isSliderActive = false; // Track if user is currently interacting with slider

        // Component recursion state
        this.componentStack = []; // Stack of {componentIndex, transform, layerData, glyphName} for nested editing
        this.editingComponentIndex = null; // Index of component being edited (null = editing main glyph)

        // HarfBuzz instance and objects
        this.hb = null;
        this.hbFont = null;
        this.hbFace = null;
        this.hbBlob = null;

        // Text change debouncing for font recompilation
        this.textChangeDebounceTimer = null;
        this.textChangeDebounceDelay = 1000; // 1 second delay

        // Mouse interaction
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Resize observer
        this.resizeObserver = null;

        // HarfBuzz instance
        this.hb = null;
        this.hbFont = null;
        this.hbBlob = null;

        // Initialize
        this.init();
    }

    init() {
        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.cursor = 'default';
        this.canvas.style.outline = 'none'; // Remove focus outline
        this.canvas.tabIndex = 0; // Make canvas focusable
        this.container.appendChild(this.canvas);

        // Get context
        this.ctx = this.canvas.getContext('2d');

        // Set up HiDPI canvas
        this.setupHiDPI();

        // Set initial scale and position
        this.scale = this.initialScale;

        // Center the view
        const rect = this.canvas.getBoundingClientRect();
        this.panX = rect.width / 4;  // Start a bit to the left
        this.panY = rect.height / 2; // Center vertically

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();

        // Initialize BiDi support
        if (typeof bidi_js !== 'undefined') {
            this.bidi = bidi_js(); // It's a factory function
            console.log('bidi-js support initialized', this.bidi);
        } else {
            console.warn('bidi-js not loaded - bidirectional text may not render correctly');
        }

        // Load HarfBuzz
        this.loadHarfBuzz();
    }

    setupHiDPI() {
        const dpr = window.devicePixelRatio || 1;

        // Get the container size (not the canvas bounding rect, which might be stale)
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        // Set the canvas size in actual pixels (accounting for DPR)
        this.canvas.width = containerWidth * dpr;
        this.canvas.height = containerHeight * dpr;

        // Set CSS size to match container
        this.canvas.style.width = containerWidth + 'px';
        this.canvas.style.height = containerHeight + 'px';

        // Get context again and scale for DPR
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);
    }

    setupEventListeners() {
        // Mouse events for panning
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));

        // Wheel event for zooming
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

        // Mouse move for hover detection
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMoveHover(e));

        // Keyboard events for cursor and text input
        this.canvas.addEventListener('keydown', (e) => this.onKeyDown(e));
        this.canvas.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isGlyphEditMode) {
                // Check if editor view is focused
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused = editorView && editorView.classList.contains('focused');

                if (!isEditorFocused) {
                    return; // Don't handle Escape if editor view is not focused
                }

                e.preventDefault();

                // Priority 1: If we have a saved previous state from slider interaction, restore it first
                // (This takes precedence over exiting component editing)
                if (this.previousSelectedLayerId !== null && this.previousVariationSettings !== null) {
                    // Restore previous layer selection and axis values
                    this.selectedLayerId = this.previousSelectedLayerId;

                    // Restore axis values with animation
                    if (this.isAnimating) {
                        this.isAnimating = false;
                    }
                    this.animationStartValues = { ...this.variationSettings };
                    this.animationTargetValues = { ...this.previousVariationSettings };
                    this.animationCurrentFrame = 0;
                    this.isAnimating = true;
                    this.animateVariation();

                    // Update layer selection UI
                    this.updateLayerSelection();

                    // Clear previous state
                    this.previousSelectedLayerId = null;
                    this.previousVariationSettings = null;

                    // Return focus to canvas
                    this.canvas.focus();
                    return;
                }

                // Priority 2: Check if we're in component editing mode
                if (this.componentStack.length > 0) {
                    // Exit one level of component editing
                    this.exitComponentEditing();
                    return;
                }

                // Priority 3: No previous state and not in component - just exit edit mode
                this.exitGlyphEditMode();
            }
        });

        // Focus/blur for cursor blinking
        this.canvas.addEventListener('focus', () => this.onFocus());
        this.canvas.addEventListener('blur', () => this.onBlur());

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Container resize (for when view dividers are moved)
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        // Sidebar click handlers to restore canvas focus in editor mode
        this.setupSidebarFocusHandlers();
    }

    setupSidebarFocusHandlers() {
        // Add event listeners to both sidebars to restore canvas focus when clicked in editor mode
        const leftSidebar = document.getElementById('glyph-properties-sidebar');
        const rightSidebar = document.getElementById('glyph-editor-sidebar');

        const restoreFocus = (e) => {
            // Only restore focus when in editor mode
            if (this.isGlyphEditMode) {
                // Use setTimeout to allow the click event to complete first
                // (e.g., slider interaction, button click)
                setTimeout(() => {
                    this.canvas.focus();
                }, 0);
            }
        };

        if (leftSidebar) {
            leftSidebar.addEventListener('mousedown', restoreFocus);
        }

        if (rightSidebar) {
            rightSidebar.addEventListener('mousedown', restoreFocus);
        }
    }

    onMouseDown(e) {
        // Focus the canvas when clicked
        this.canvas.focus();

        // Check for double-click
        if (e.detail === 2) {
            console.log('Double-click detected. isGlyphEditMode:', this.isGlyphEditMode, 'selectedLayerId:', this.selectedLayerId, 'hoveredComponentIndex:', this.hoveredComponentIndex);
            // In outline editor mode with layer selected
            if (this.isGlyphEditMode && this.selectedLayerId && this.layerData) {
                // Double-click on component - enter component editing (without selecting it)
                if (this.hoveredComponentIndex !== null) {
                    console.log('Entering component editing for index:', this.hoveredComponentIndex);
                    // Clear component selection before entering
                    this.selectedComponents = [];
                    this.enterComponentEditing(this.hoveredComponentIndex);
                    return;
                }
                // Double-click on point - toggle smooth for all selected points
                if (this.hoveredPointIndex) {
                    if (this.selectedPoints.length > 0) {
                        // Toggle smooth for all selected points
                        for (const point of this.selectedPoints) {
                            this.togglePointSmooth(point);
                        }
                    } else {
                        this.togglePointSmooth(this.hoveredPointIndex);
                    }
                    return;
                }
                // Double-click on other glyph - switch to that glyph
                if (this.hoveredGlyphIndex >= 0 && this.hoveredGlyphIndex !== this.selectedGlyphIndex) {
                    this.selectGlyphByIndex(this.hoveredGlyphIndex);
                    return;
                }
            }

            // Double-click on glyph - select glyph (when not in edit mode)
            if (!this.isGlyphEditMode && this.hoveredGlyphIndex >= 0) {
                this.selectGlyphByIndex(this.hoveredGlyphIndex);
                return;
            }
        }

        // In outline editor mode with layer selected (but not in preview mode)
        if (this.isGlyphEditMode && this.selectedLayerId && this.layerData && !this.isPreviewMode) {
            // Check if clicking on a component first (components take priority)
            if (this.hoveredComponentIndex !== null) {
                if (e.shiftKey) {
                    // Shift-click: add to or remove from selection (keep points and anchors for mixed selection)
                    const existingIndex = this.selectedComponents.indexOf(this.hoveredComponentIndex);
                    if (existingIndex >= 0) {
                        this.selectedComponents.splice(existingIndex, 1);
                    } else {
                        this.selectedComponents.push(this.hoveredComponentIndex);
                    }
                    this.render();
                } else {
                    const isInSelection = this.selectedComponents.includes(this.hoveredComponentIndex);

                    if (!isInSelection) {
                        this.selectedComponents = [this.hoveredComponentIndex];
                        this.selectedPoints = [];
                        this.selectedAnchors = [];
                    }
                    // If already in selection, keep all selected components, points, and anchors

                    this.isDraggingComponent = true;
                    this.lastMouseX = e.clientX;
                    this.lastMouseY = e.clientY;
                    this.lastGlyphX = null;
                    this.lastGlyphY = null;
                    this.render();
                }
                return;
            }

            // Check if clicking on an anchor (anchors take priority over points)
            if (this.hoveredAnchorIndex !== null) {
                if (e.shiftKey) {
                    // Shift-click: add to or remove from selection (keep points selected for mixed selection)
                    const existingIndex = this.selectedAnchors.indexOf(this.hoveredAnchorIndex);
                    if (existingIndex >= 0) {
                        // Remove from selection
                        this.selectedAnchors.splice(existingIndex, 1);
                    } else {
                        // Add to selection
                        this.selectedAnchors.push(this.hoveredAnchorIndex);
                    }
                    this.render();
                } else {
                    // Check if clicked anchor is already in selection
                    const isInSelection = this.selectedAnchors.includes(this.hoveredAnchorIndex);

                    if (!isInSelection) {
                        // Regular click on unselected anchor: select only this anchor, clear points
                        this.selectedAnchors = [this.hoveredAnchorIndex];
                        this.selectedPoints = []; // Clear point selection
                    }
                    // If already in selection, keep all selected anchors and points

                    // Start dragging (all selected anchors and points)
                    this.isDraggingAnchor = true;
                    this.lastMouseX = e.clientX;
                    this.lastMouseY = e.clientY;
                    this.lastGlyphX = null; // Reset for delta calculation
                    this.lastGlyphY = null;
                    this.render();
                }
                return; // Don't start canvas panning
            }

            // Check if clicking on a point
            if (this.hoveredPointIndex) {
                if (e.shiftKey) {
                    // Shift-click: add to or remove from selection (keep anchors selected for mixed selection)
                    const existingIndex = this.selectedPoints.findIndex(p =>
                        p.contourIndex === this.hoveredPointIndex.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex.nodeIndex
                    );
                    if (existingIndex >= 0) {
                        // Remove from selection
                        this.selectedPoints.splice(existingIndex, 1);
                    } else {
                        // Add to selection
                        this.selectedPoints.push({ ...this.hoveredPointIndex });
                    }
                    this.render();
                } else {
                    // Check if clicked point is already in selection
                    const isInSelection = this.selectedPoints.some(p =>
                        p.contourIndex === this.hoveredPointIndex.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex.nodeIndex
                    );

                    if (!isInSelection) {
                        // Regular click on unselected point: select only this point, clear anchors
                        this.selectedPoints = [{ ...this.hoveredPointIndex }];
                        this.selectedAnchors = []; // Clear anchor selection
                    }
                    // If already in selection, keep all selected points and anchors

                    // Start dragging (all selected points and anchors)
                    this.isDraggingPoint = true;
                    this.lastMouseX = e.clientX;
                    this.lastMouseY = e.clientY;
                    this.lastGlyphX = null; // Reset for delta calculation
                    this.lastGlyphY = null;
                    this.render();
                }
                return; // Don't start canvas panning
            } else if (!e.shiftKey) {
                // Clicked on empty space without shift: clear selection
                this.selectedPoints = [];
                this.selectedAnchors = [];
                this.selectedComponents = [];
                this.render();
            }
        }

        // Check if clicking on text to position cursor (only in text edit mode, not on double-click or glyph)
        // Skip if hovering over a glyph since that might be a double-click to enter edit mode
        if (!this.isGlyphEditMode && !e.shiftKey && !e.ctrlKey && !e.metaKey && this.hoveredGlyphIndex < 0) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.clearSelection();
                this.cursorPosition = clickedPos;
                this.updateCursorVisualPosition();
                this.render();
                // Keep text cursor
                this.canvas.style.cursor = 'text';
                return; // Don't start dragging if clicking on text
            }
        }

        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    }

    onMouseMove(e) {
        // Handle component dragging in outline editor (takes priority)
        if (this.isDraggingComponent && this.selectedComponents.length > 0 && this.layerData) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const transform = this.getTransformMatrix();
            const det = transform.a * transform.d - transform.b * transform.c;
            let glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
            let glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

            let xPosition = 0;
            for (let i = 0; i < this.selectedGlyphIndex; i++) {
                xPosition += (this.shapedGlyphs[i].ax || 0);
            }
            const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            glyphX -= (xPosition + xOffset);
            glyphY -= yOffset;

            const deltaX = Math.round(glyphX) - Math.round(this.lastGlyphX || glyphX);
            const deltaY = Math.round(glyphY) - Math.round(this.lastGlyphY || glyphY);

            this.lastGlyphX = glyphX;
            this.lastGlyphY = glyphY;

            // Update all selected components' transforms
            for (const compIndex of this.selectedComponents) {
                const shape = this.layerData.shapes[compIndex];
                if (shape && shape.Component) {
                    if (!shape.Component.transform) {
                        // Initialize transform if it doesn't exist
                        shape.Component.transform = [1, 0, 0, 1, 0, 0];
                    }

                    // Update translation part of transform (always array format)
                    if (Array.isArray(shape.Component.transform)) {
                        shape.Component.transform[4] += deltaX;
                        shape.Component.transform[5] += deltaY;
                    }
                }
            }

            // Also update any selected points (mixed selection)
            for (const point of this.selectedPoints) {
                const { contourIndex, nodeIndex } = point;
                if (this.layerData.shapes[contourIndex] && this.layerData.shapes[contourIndex].nodes[nodeIndex]) {
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][0] += deltaX;
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][1] += deltaY;
                }
            }

            // Also update any selected anchors (mixed selection)
            for (const anchorIndex of this.selectedAnchors) {
                const anchor = this.layerData.anchors[anchorIndex];
                if (anchor) {
                    anchor.x += deltaX;
                    anchor.y += deltaY;
                }
            }

            this.saveLayerData();
            this.render();
            return;
        }

        // Handle anchor dragging in outline editor
        if (this.isDraggingAnchor && this.selectedAnchors.length > 0 && this.layerData) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Transform to glyph space
            const transform = this.getTransformMatrix();
            const det = transform.a * transform.d - transform.b * transform.c;
            let glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
            let glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

            // Adjust for selected glyph position
            let xPosition = 0;
            for (let i = 0; i < this.selectedGlyphIndex; i++) {
                xPosition += (this.shapedGlyphs[i].ax || 0);
            }
            const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            glyphX -= (xPosition + xOffset);
            glyphY -= yOffset;

            // Calculate delta from last position
            const deltaX = Math.round(glyphX) - Math.round(this.lastGlyphX || glyphX);
            const deltaY = Math.round(glyphY) - Math.round(this.lastGlyphY || glyphY);

            this.lastGlyphX = glyphX;
            this.lastGlyphY = glyphY;

            // Update all selected anchors
            for (const anchorIndex of this.selectedAnchors) {
                const anchor = this.layerData.anchors[anchorIndex];
                if (anchor) {
                    anchor.x += deltaX;
                    anchor.y += deltaY;
                }
            }

            // Also update any selected points (mixed selection)
            for (const point of this.selectedPoints) {
                const { contourIndex, nodeIndex } = point;
                if (this.layerData.shapes[contourIndex] && this.layerData.shapes[contourIndex].nodes[nodeIndex]) {
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][0] += deltaX;
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][1] += deltaY;
                }
            }

            // Also update any selected components (mixed selection)
            for (const compIndex of this.selectedComponents) {
                const shape = this.layerData.shapes[compIndex];
                if (shape && shape.Component && shape.Component.transform) {
                    if (!Array.isArray(shape.Component.transform)) {
                        shape.Component.transform = [1, 0, 0, 1, 0, 0];
                    }
                    shape.Component.transform[4] += deltaX;
                    shape.Component.transform[5] += deltaY;
                }
            }

            // Save to Python immediately (non-blocking)
            this.saveLayerData();

            this.render();
            return; // Don't do canvas panning while dragging anchor
        }

        // Handle point dragging in outline editor (takes priority over canvas panning)
        if (this.isDraggingPoint && this.selectedPoints.length > 0 && this.layerData) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Transform to glyph space
            const transform = this.getTransformMatrix();
            const det = transform.a * transform.d - transform.b * transform.c;
            let glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
            let glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

            // Adjust for selected glyph position
            let xPosition = 0;
            for (let i = 0; i < this.selectedGlyphIndex; i++) {
                xPosition += (this.shapedGlyphs[i].ax || 0);
            }
            const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            glyphX -= (xPosition + xOffset);
            glyphY -= yOffset;

            // Calculate delta from last position
            const deltaX = Math.round(glyphX) - Math.round(this.lastGlyphX || glyphX);
            const deltaY = Math.round(glyphY) - Math.round(this.lastGlyphY || glyphY);

            this.lastGlyphX = glyphX;
            this.lastGlyphY = glyphY;

            // Update all selected points
            for (const point of this.selectedPoints) {
                const { contourIndex, nodeIndex } = point;
                if (this.layerData.shapes[contourIndex] && this.layerData.shapes[contourIndex].nodes[nodeIndex]) {
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][0] += deltaX;
                    this.layerData.shapes[contourIndex].nodes[nodeIndex][1] += deltaY;
                }
            }

            // Also update any selected anchors (mixed selection)
            for (const anchorIndex of this.selectedAnchors) {
                const anchor = this.layerData.anchors[anchorIndex];
                if (anchor) {
                    anchor.x += deltaX;
                    anchor.y += deltaY;
                }
            }

            // Also update any selected components (mixed selection)
            for (const compIndex of this.selectedComponents) {
                const shape = this.layerData.shapes[compIndex];
                if (shape && shape.Component && shape.Component.transform) {
                    if (!Array.isArray(shape.Component.transform)) {
                        shape.Component.transform = [1, 0, 0, 1, 0, 0];
                    }
                    shape.Component.transform[4] += deltaX;
                    shape.Component.transform[5] += deltaY;
                }
            }

            // Save to Python immediately (non-blocking)
            // This lets the auto-compile system detect changes
            this.saveLayerData();

            this.render();
            return; // Don't do canvas panning while dragging point
        }

        // Canvas panning (only when not dragging a point)
        if (!this.isDragging) return;

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;

        this.panX += dx;
        this.panY += dy;

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        this.render();
    }

    onMouseUp(e) {
        this.isDragging = false;
        this.isDraggingPoint = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        // Update cursor based on current mouse position
        this.updateCursorStyle(e);
    }

    onWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Calculate zoom
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = this.scale * zoomFactor;

        // Limit zoom range
        if (newScale < 0.01 || newScale > 100) return;

        // Adjust pan to zoom toward mouse position
        this.panX = mouseX - (mouseX - this.panX) * zoomFactor;
        this.panY = mouseY - (mouseY - this.panY) * zoomFactor;

        this.scale = newScale;
        this.render();
    }

    onMouseMoveHover(e) {
        if (this.isDragging || this.isDraggingPoint || this.isDraggingAnchor) return; // Don't detect hover while dragging

        const rect = this.canvas.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = this.mouseX * this.canvas.width / rect.width;
        this.mouseCanvasY = this.mouseY * this.canvas.height / rect.height;

        // In outline editor mode, check for hovered components, anchors and points first (unless in preview mode), then other glyphs
        if (this.isGlyphEditMode && this.selectedLayerId && this.layerData && !this.isPreviewMode) {
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
            // Also check for hovering over other glyphs (for switching)
            this.updateHoveredGlyph();
        } else {
            // Check which glyph is being hovered
            this.updateHoveredGlyph();
        }

        // Update cursor style based on position (after updating hover states)
        this.updateCursorStyle(e);
    }

    updateCursorStyle(e) {
        // Update cursor style based on mouse position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // In outline editing mode, use pointer for components/points/anchors, grab for panning (NO text cursor)
        // In preview mode, always show grab cursor
        if (this.isGlyphEditMode) {
            if (this.isPreviewMode || !this.selectedLayerId || !this.layerData) {
                this.canvas.style.cursor = 'grab';
            } else if (this.hoveredComponentIndex !== null || this.hoveredPointIndex || this.hoveredAnchorIndex !== null) {
                this.canvas.style.cursor = 'pointer';
            } else {
                this.canvas.style.cursor = 'grab';
            }
            return;
        }

        // Transform mouse coordinates to glyph space to check if over text area
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        // Check if hovering within cursor height range (same as click detection)
        if (glyphY <= 1000 && glyphY >= -300) {
            this.canvas.style.cursor = 'text';
        } else {
            this.canvas.style.cursor = 'grab';
        }
    }

    updateHoveredGlyph() {
        // Use HiDPI-scaled mouse coordinates for hit testing
        const mouseX = this.mouseCanvasX || this.mouseX;
        const mouseY = this.mouseCanvasY || this.mouseY;

        // Transform mouse coordinates to glyph space
        const transform = this.getTransformMatrix();

        // Inverse transform to get glyph-space coordinates
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        let foundIndex = -1;

        // Check each glyph using path hit testing
        let xPosition = 0;
        for (let i = 0; i < this.shapedGlyphs.length; i++) {
            const glyph = this.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Check if point is within this glyph's path
            try {
                const glyphData = this.hbFont.glyphToPath(glyphId);
                if (glyphData) {
                    const path = new Path2D(glyphData);

                    // Create a temporary context for hit testing with proper transform
                    this.ctx.save();

                    // Apply the same transform as rendering
                    this.ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
                    this.ctx.translate(x, y);

                    // Test if mouse point is in path (in canvas coordinates)
                    if (this.ctx.isPointInPath(path, this.mouseX, this.mouseY)) {
                        foundIndex = i;
                        this.ctx.restore();
                        break;
                    }

                    this.ctx.restore();
                }
            } catch (error) {
                // Skip this glyph if path extraction fails
            }

            xPosition += xAdvance;
        }

        if (foundIndex !== this.hoveredGlyphIndex) {
            this.hoveredGlyphIndex = foundIndex;
            this.render();
        }
    }

    updateHoveredComponent() {
        // Check which component is being hovered in outline editor mode
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        const mouseX = this.mouseX;
        const mouseY = this.mouseY;
        const transform = this.getTransformMatrix();

        // Calculate glyph offset for selected glyph
        let xPosition = 0;
        for (let i = 0; i < this.selectedGlyphIndex; i++) {
            xPosition += (this.shapedGlyphs[i].ax || 0);
        }
        const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;

        const hitRadius = 20 / this.scale; // Larger hit radius for origin marker
        let foundComponentIndex = null;

        // Transform mouse to component local space
        const { glyphX, glyphY } = this.transformMouseToComponentSpace(mouseX, mouseY);
        console.log(`updateHoveredComponent: mouseX=${mouseX}, mouseY=${mouseY}, glyphX=${glyphX}, glyphY=${glyphY}, componentStack.length=${this.componentStack.length}`);

        this.layerData.shapes.forEach((shape, index) => {
            if (shape.Component) {
                // This is a component - check if hovering near its origin OR inside its outline
                let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
                if (shape.Component.transform && Array.isArray(shape.Component.transform)) {
                    a = shape.Component.transform[0] || 1;
                    b = shape.Component.transform[1] || 0;
                    c = shape.Component.transform[2] || 0;
                    d = shape.Component.transform[3] || 1;
                    tx = shape.Component.transform[4] || 0;
                    ty = shape.Component.transform[5] || 0;
                }

                // Check distance to origin marker first
                const dist = Math.sqrt((tx - glyphX) ** 2 + (ty - glyphY) ** 2);
                if (dist <= hitRadius) {
                    foundComponentIndex = index;
                    return;
                }

                // Check if inside component outline (including nested components)
                if (shape.Component.layerData && shape.Component.layerData.shapes) {
                    console.log(`Checking component ${index}, componentStack.length=${this.componentStack.length}, outer transform=[${a},${b},${c},${d},${tx},${ty}]`);
                    if (this.componentStack.length > 0) {
                        console.log(`ComponentStack[0].transform:`, this.componentStack[0].transform);
                        console.log(`Accumulated transform:`, this.getAccumulatedTransform());
                    }


                    const checkShapesRecursive = (shapes, parentTransform = [1, 0, 0, 1, 0, 0], depth = 0) => {
                        for (const componentShape of shapes) {
                            // Handle nested components recursively
                            if (componentShape.Component) {
                                const nestedTransform = componentShape.Component.transform || [1, 0, 0, 1, 0, 0];
                                console.log(`  ${'  '.repeat(depth)}Nested component at depth ${depth}, transform=[${nestedTransform}]`);
                                // Multiply parent transform with nested transform
                                const combinedTransform = [
                                    parentTransform[0] * nestedTransform[0] + parentTransform[2] * nestedTransform[1],
                                    parentTransform[1] * nestedTransform[0] + parentTransform[3] * nestedTransform[1],
                                    parentTransform[0] * nestedTransform[2] + parentTransform[2] * nestedTransform[3],
                                    parentTransform[1] * nestedTransform[2] + parentTransform[3] * nestedTransform[3],
                                    parentTransform[0] * nestedTransform[4] + parentTransform[2] * nestedTransform[5] + parentTransform[4],
                                    parentTransform[1] * nestedTransform[4] + parentTransform[3] * nestedTransform[5] + parentTransform[5]
                                ];
                                console.log(`  ${'  '.repeat(depth)}Combined transform=[${combinedTransform}]`);

                                if (componentShape.Component.layerData && componentShape.Component.layerData.shapes) {
                                    if (checkShapesRecursive(componentShape.Component.layerData.shapes, combinedTransform, depth + 1)) {
                                        return true;
                                    }
                                }
                                continue;
                            }

                            // Handle outline shapes
                            if (componentShape.nodes && componentShape.nodes.length > 0) {
                                console.log(`  ${'  '.repeat(depth)}Outline shape at depth ${depth}, parentTransform=[${parentTransform}]`);
                                console.log(`  ${'  '.repeat(depth)}First node: [${componentShape.nodes[0]}]`);
                                const path = new Path2D();

                                // Build the path using the shared helper method
                                this.buildPathFromNodes(componentShape.nodes, path);
                                path.closePath();

                                // Apply transform to canvas for hit testing
                                this.ctx.save();

                                // When inside a component, glyphX/glyphY are already in component local space
                                // (inverse transformed), so we need identity base transform
                                // When at main level, mouseX/mouseY are in canvas space, so use full view transform
                                if (this.componentStack.length === 0) {
                                    this.ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
                                    this.ctx.translate(xPosition + xOffset, yOffset);
                                    console.log(`  ${'  '.repeat(depth)}Canvas setup: base transform + translate(${xPosition + xOffset}, ${yOffset})`);
                                } else {
                                    // Identity transform - glyphX/glyphY are already in the right space
                                    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
                                    console.log(`  ${'  '.repeat(depth)}Canvas setup: identity (glyphX/Y already transformed)`);
                                }

                                // Apply the component's own transform
                                this.ctx.transform(a, b, c, d, tx, ty);
                                console.log(`  ${'  '.repeat(depth)}Applied component transform: [${a},${b},${c},${d},${tx},${ty}]`);
                                console.log(`  ${'  '.repeat(depth)}After component transform, canvas would place outline at: x=${78 + tx}, y=${631 + ty} (for first node [78,631])`);

                                // Apply accumulated transforms from nested components within this component
                                this.ctx.transform(
                                    parentTransform[0], parentTransform[1],
                                    parentTransform[2], parentTransform[3],
                                    parentTransform[4], parentTransform[5]
                                );
                                console.log(`  ${'  '.repeat(depth)}Applied nested transform: [${parentTransform}]`);

                                // Test if mouse point is in path
                                // At main level: use mouseX, mouseY (canvas coordinates)
                                // Inside component: use glyphX, glyphY (component local coordinates)
                                const testX = this.componentStack.length === 0 ? mouseX : glyphX;
                                const testY = this.componentStack.length === 0 ? mouseY : glyphY;
                                const isInPath = this.ctx.isPointInPath(path, testX, testY);
                                console.log(`  ${'  '.repeat(depth)}Hit test at (${testX}, ${testY}): ${isInPath}`);
                                this.ctx.restore(); if (isInPath) {
                                    return true;
                                }
                            }
                        }
                        return false;
                    };

                    if (checkShapesRecursive(shape.Component.layerData.shapes)) {
                        foundComponentIndex = index;
                        return;
                    }
                }
            }
        });

        if (foundComponentIndex !== this.hoveredComponentIndex) {
            this.hoveredComponentIndex = foundComponentIndex;
            this.render();
        }
    }

    updateHoveredAnchor() {
        // Check which anchor is being hovered in outline editor mode
        if (!this.layerData || !this.layerData.anchors) {
            return;
        }

        // Transform mouse coordinates to component local space
        const { glyphX, glyphY } = this.transformMouseToComponentSpace(this.mouseX, this.mouseY);

        // Check each anchor
        const hitRadius = 10 / this.scale; // 10 pixels in screen space
        let foundAnchorIndex = null;

        this.layerData.anchors.forEach((anchor, index) => {
            const dist = Math.sqrt((anchor.x - glyphX) ** 2 + (anchor.y - glyphY) ** 2);
            if (dist <= hitRadius) {
                foundAnchorIndex = index;
            }
        });

        if (foundAnchorIndex !== this.hoveredAnchorIndex) {
            this.hoveredAnchorIndex = foundAnchorIndex;
            this.render();
        }
    }

    updateHoveredPoint() {
        // Check which point is being hovered in outline editor mode
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        // Transform mouse coordinates to component local space
        const { glyphX, glyphY } = this.transformMouseToComponentSpace(this.mouseX, this.mouseY);

        // Check each point in each contour
        const hitRadius = 10 / this.scale; // 10 pixels in screen space
        let foundPoint = null;

        this.layerData.shapes.forEach((shape, contourIndex) => {
            // Parse nodes if not already done
            if (!shape.nodes && shape.Path && shape.Path.nodes) {
                const nodesString = shape.Path.nodes;
                const parts = nodesString.trim().split(/\s+/);
                shape.nodes = [];
                for (let i = 0; i < parts.length; i += 3) {
                    if (i + 2 < parts.length) {
                        shape.nodes.push([parseFloat(parts[i]), parseFloat(parts[i + 1]), parts[i + 2]]);
                    }
                }
            }

            if (shape.ref || !shape.nodes) return;

            shape.nodes.forEach((node, nodeIndex) => {
                const [x, y] = node;
                const dist = Math.sqrt((x - glyphX) ** 2 + (y - glyphY) ** 2);

                if (dist <= hitRadius) {
                    foundPoint = { contourIndex, nodeIndex };
                }
            });
        });

        if (JSON.stringify(foundPoint) !== JSON.stringify(this.hoveredPointIndex)) {
            this.hoveredPointIndex = foundPoint;
            this.render();
        }
    }

    moveSelectedPoints(deltaX, deltaY) {
        // Move all selected points by the given delta
        if (!this.layerData || !this.layerData.shapes || this.selectedPoints.length === 0) {
            return;
        }

        for (const point of this.selectedPoints) {
            const { contourIndex, nodeIndex } = point;
            const shape = this.layerData.shapes[contourIndex];
            if (shape && shape.nodes && shape.nodes[nodeIndex]) {
                shape.nodes[nodeIndex][0] += deltaX;
                shape.nodes[nodeIndex][1] += deltaY;
            }
        }

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.render();
    }

    moveSelectedAnchors(deltaX, deltaY) {
        // Move all selected anchors by the given delta
        if (!this.layerData || !this.layerData.anchors || this.selectedAnchors.length === 0) {
            return;
        }

        for (const anchorIndex of this.selectedAnchors) {
            const anchor = this.layerData.anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.render();
    }

    moveSelectedComponents(deltaX, deltaY) {
        // Move all selected components by the given delta
        if (!this.layerData || !this.layerData.shapes || this.selectedComponents.length === 0) {
            return;
        }

        for (const compIndex of this.selectedComponents) {
            const shape = this.layerData.shapes[compIndex];
            if (shape && shape.Component) {
                if (!shape.Component.transform) {
                    // Initialize transform if it doesn't exist
                    shape.Component.transform = [1, 0, 0, 1, 0, 0];
                }
                if (Array.isArray(shape.Component.transform)) {
                    shape.Component.transform[4] += deltaX;
                    shape.Component.transform[5] += deltaY;
                }
            }
        }

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.render();
    }

    togglePointSmooth(pointIndex) {
        // Toggle smooth state of a point
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        const { contourIndex, nodeIndex } = pointIndex;
        const shape = this.layerData.shapes[contourIndex];

        if (!shape || !shape.nodes || !shape.nodes[nodeIndex]) {
            return;
        }

        const node = shape.nodes[nodeIndex];
        const [x, y, type] = node;

        // Toggle smooth state based on current type
        let newType = type;

        if (type === 'c') {
            newType = 'cs'; // on-curve -> smooth on-curve
        } else if (type === 'cs') {
            newType = 'c'; // smooth on-curve -> on-curve
        } else if (type === 'l') {
            newType = 'ls'; // line -> smooth line
        } else if (type === 'ls') {
            newType = 'l'; // smooth line -> line
        } else if (type === 'o') {
            newType = 'os'; // off-curve -> smooth off-curve
        } else if (type === 'os') {
            newType = 'o'; // smooth off-curve -> off-curve
        }

        node[2] = newType;

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.render();

        console.log(`Toggled point smooth: ${type} -> ${newType}`);
    }

    onResize() {
        this.setupHiDPI();
        this.render();
    }

    getTransformMatrix() {
        // Return a transformation matrix for converting font coordinates to canvas coordinates
        return {
            a: this.scale,
            b: 0,
            c: 0,
            d: -this.scale, // Flip Y axis (font coordinates have Y going up)
            e: this.panX,
            f: this.panY
        };
    }

    async loadHarfBuzz() {
        try {
            // Wait for createHarfBuzz to be available
            if (typeof createHarfBuzz === 'undefined') {
                console.log('Waiting for HarfBuzz to load...');
                await new Promise((resolve, reject) => {
                    let attempts = 0;
                    const check = () => {
                        if (typeof createHarfBuzz !== 'undefined') {
                            resolve();
                        } else if (attempts < 100) {
                            attempts++;
                            setTimeout(check, 100);
                        } else {
                            reject(new Error('HarfBuzz did not load'));
                        }
                    };
                    check();
                });
            }

            // Initialize HarfBuzz
            console.log('Initializing HarfBuzz WASM...');
            const hbModule = await createHarfBuzz();
            this.hb = hbjs(hbModule);
            console.log('HarfBuzz initialized successfully');

            // If we have a font loaded, shape it
            if (this.fontBlob) {
                this.shapeText();
            }
        } catch (error) {
            console.error('Error loading HarfBuzz:', error);
            console.log('Text shaping will not be available. Glyphs will be displayed as placeholder boxes.');
        }
    }

    setFont(fontArrayBuffer) {
        if (!fontArrayBuffer) {
            console.error('No font data provided');
            return;
        }

        try {
            // Store current variation settings to restore after font reload
            const previousVariationSettings = { ...this.variationSettings };

            // Store font blob
            this.fontBlob = fontArrayBuffer;

            // Parse with opentype.js for glyph path extraction
            if (window.opentype) {
                this.opentypeFont = opentype.parse(fontArrayBuffer);
                console.log('Font parsed with opentype.js:', this.opentypeFont.names.fontFamily.en);
            }

            // Clean up old HarfBuzz font
            if (this.hbFont) {
                this.hbFont.destroy();
                this.hbFont = null;
            }
            if (this.hbFace) {
                this.hbFace.destroy();
                this.hbFace = null;
            }
            if (this.hbBlob) {
                this.hbBlob.destroy();
                this.hbBlob = null;
            }

            // Create HarfBuzz blob, face, and font if HarfBuzz is loaded
            if (this.hb) {
                const uint8Array = new Uint8Array(fontArrayBuffer);
                this.hbBlob = this.hb.createBlob(uint8Array);
                this.hbFace = this.hb.createFace(this.hbBlob, 0); // 0 = first face
                this.hbFont = this.hb.createFont(this.hbFace);

                console.log('Font loaded into HarfBuzz');

                // Restore previous variation settings before updating UI
                // This ensures the sliders show the previous values
                this.variationSettings = previousVariationSettings;

                // Update axes UI (will restore slider positions from variationSettings)
                this.updateAxesUI();

                // Update features UI (async, then shape text)
                this.updateFeaturesUI().then(() => {
                    // Shape text with new font after features are initialized
                    this.shapeText();
                });
            }
        } catch (error) {
            console.error('Error setting font:', error);
        }
    }

    setTextBuffer(text) {
        this.textBuffer = text || "";

        // Save to localStorage
        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn('Failed to save text buffer to localStorage:', e);
        }

        // Trigger font recompilation (debounced)
        this.onTextChange();

        this.shapeText();
    }

    setVariation(axisTag, value) {
        const previousValue = this.variationSettings[axisTag] !== undefined
            ? this.variationSettings[axisTag]
            : this.getVariationAxes().find(a => a.tag === axisTag)?.defaultValue || 0;

        // Cancel any ongoing animation
        if (this.isAnimating) {
            this.isAnimating = false;
        }

        // Set up animation
        this.animationStartValues = { ...this.variationSettings };
        this.animationTargetValues = { ...this.variationSettings, [axisTag]: value };
        this.animationCurrentFrame = 0;
        this.isAnimating = true;

        // Start animation loop
        this.animateVariation();
    }

    async animateVariation() {
        if (!this.isAnimating) return;

        this.animationCurrentFrame++;
        const progress = Math.min(this.animationCurrentFrame / this.animationFrames, 1.0);

        // Ease-out cubic for smoother animation
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        // Interpolate all axes
        for (const axisTag in this.animationTargetValues) {
            const startValue = this.animationStartValues[axisTag] || this.animationTargetValues[axisTag];
            const targetValue = this.animationTargetValues[axisTag];
            this.variationSettings[axisTag] = startValue + (targetValue - startValue) * easedProgress;
        }

        // Update sliders during animation
        this.updateAxisSliders();

        this.shapeText();

        if (progress < 1.0) {
            requestAnimationFrame(() => this.animateVariation());
        } else {
            // Ensure we end exactly at target values
            this.variationSettings = { ...this.animationTargetValues };
            this.isAnimating = false;
            this.updateAxisSliders(); // Update slider UI to match final values

            // Check if new variation settings match any layer
            if (this.isGlyphEditMode && this.fontData) {
                await this.autoSelectMatchingLayer();
            }

            this.shapeText();

            // Restore focus to canvas after animation completes (for text editing mode)
            if (!this.isGlyphEditMode) {
                setTimeout(() => this.canvas.focus(), 0);
            }
        }
    }

    getVariationAxes() {
        if (!this.opentypeFont || !this.opentypeFont.tables.fvar) {
            return [];
        }
        return this.opentypeFont.tables.fvar.axes || [];
    }

    async selectGlyphByIndex(glyphIndex) {
        // Select a glyph by its index in the shaped glyphs array

        // If we're in nested component mode, exit all levels first
        // Skip UI updates during batch exit to avoid duplicate layer interfaces
        while (this.componentStack.length > 0) {
            this.exitComponentEditing(true); // Skip UI updates
        }

        if (glyphIndex >= 0 && glyphIndex < this.shapedGlyphs.length) {
            this.selectedGlyphIndex = glyphIndex;
            this.isGlyphEditMode = true;

            // Set logical cursor position to the start of this glyph's cluster
            const glyph = this.shapedGlyphs[glyphIndex];
            const clusterPos = glyph.cl || 0;
            this.cursorPosition = clusterPos;
            this.updateCursorVisualPosition();

            console.log(`Entered glyph edit mode - selected glyph at index ${this.selectedGlyphIndex}, cluster position ${clusterPos}`);
        } else {
            this.selectedGlyphIndex = -1;
            this.isGlyphEditMode = false;
            console.log(`Deselected glyph`);
        }

        // Update breadcrumb (will hide it since componentStack is now empty)
        this.updateComponentBreadcrumb();

        // Fetch glyph data and update UI before rendering
        await this.updatePropertiesUI();

        // Now render with the loaded data
        this.render();

        // Perform mouse hit detection for objects at current mouse position
        if (this.isGlyphEditMode && this.selectedLayerId && this.layerData) {
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
        }
    }

    async enterGlyphEditModeAtCursor() {
        // Enter glyph edit mode for the glyph at the current cursor position
        if (this.isGlyphEditMode || !this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        // Find the glyph at the cursor position
        const targetPosition = this.cursorPosition;
        const isRTL = this.isPositionRTL(targetPosition);

        console.log(`Looking for glyph at cursor position ${targetPosition}, isRTL: ${isRTL}`);

        // First, try to find a cluster that starts at this position
        let glyphIndex = -1;
        if (isRTL) {
            glyphIndex = this.findLastGlyphAtClusterPosition(targetPosition);
        } else {
            glyphIndex = this.findFirstGlyphAtClusterPosition(targetPosition);
        }

        // If no cluster starts at this position, find the glyph by logical position within its cluster
        if (glyphIndex < 0) {
            for (let i = 0; i < this.shapedGlyphs.length; i++) {
                const glyphInfo = this.isGlyphFromTypedCharacter(i);
                if (glyphInfo.isTyped && glyphInfo.logicalPosition === targetPosition) {
                    glyphIndex = i;
                    console.log(`Found glyph ${i} at logical position ${targetPosition} within its cluster`);
                    break;
                }
            }
        }

        if (glyphIndex >= 0) {
            console.log(`Entering glyph edit mode at cursor position ${targetPosition}, glyph index ${glyphIndex}`);
            await this.selectGlyphByIndex(glyphIndex);
        } else {
            console.log(`No glyph found at cursor position ${targetPosition}`);
        }
    }

    exitGlyphEditMode() {
        // Exit glyph edit mode and return to text edit mode

        // Determine cursor position based on whether glyph was typed or shaped
        const savedGlyphIndex = this.selectedGlyphIndex;

        const glyph = this.shapedGlyphs[savedGlyphIndex];
        console.log('[v2024-12-01-FIX] exitGlyphEditMode CALLED - selectedGlyphIndex:', this.selectedGlyphIndex, 'shapedGlyphs.length:', this.shapedGlyphs.length, 'glyph:', glyph);

        // Update cursor position to before the edited glyph
        if (savedGlyphIndex >= 0 && savedGlyphIndex < this.shapedGlyphs.length) {
            const glyphInfo = this.isGlyphFromTypedCharacter(savedGlyphIndex);
            const clusterStart = glyph.cl || 0;
            const isRTL = this.isPositionRTL(clusterStart);

            console.log('Exit glyph edit mode [v2024-12-01-FIX] - glyphInfo:', glyphInfo, 'clusterStart:', clusterStart, 'isRTL:', isRTL);

            if (glyphInfo.isTyped) {
                // For typed characters, check if it's the base glyph or a vowel mark
                const isBaseGlyph = (glyphInfo.logicalPosition === clusterStart);

                if (isBaseGlyph) {
                    // Base glyph (first character in cluster): position at cluster start
                    this.cursorPosition = clusterStart;
                    console.log('Base glyph - set cursor position at cluster start:', this.cursorPosition);
                } else {
                    // Other characters in cluster: position at their logical position
                    this.cursorPosition = glyphInfo.logicalPosition;
                    console.log('Non-base character - set cursor position at logical position:', this.cursorPosition);
                }
            } else {
                // For shaped glyphs, position cursor at the cluster start
                this.cursorPosition = clusterStart;
                console.log('Shaped glyph - set cursor position at cluster start:', this.cursorPosition);
            }
            this.updateCursorVisualPosition();
        }

        this.isGlyphEditMode = false;
        this.selectedGlyphIndex = -1;
        this.selectedLayerId = null;

        // Clear outline editor state
        this.layerData = null;
        this.selectedPoints = [];
        this.hoveredPointIndex = null;
        this.isDraggingPoint = false;
        this.layerDataDirty = false;

        console.log(`Exited glyph edit mode - returned to text edit mode`);
        this.updatePropertiesUI();
        this.render();
    }

    async navigateToNextGlyphLogical() {
        // Navigate to the next glyph in logical order (forward in text)
        if (!this.isGlyphEditMode || this.componentStack.length > 0) {
            return; // Only works in top-level glyph edit mode
        }

        // Get current glyph's cluster position
        if (this.selectedGlyphIndex >= 0 && this.selectedGlyphIndex < this.shapedGlyphs.length) {
            const currentGlyph = this.shapedGlyphs[this.selectedGlyphIndex];
            const currentClusterPos = currentGlyph.cl || 0;
            const isCurrentRTL = this.isPositionRTL(currentClusterPos);

            // First, try to find another glyph at the SAME cluster position
            // For RTL: move backward in visual buffer (earlier glyphs are visually later)
            // For LTR: move forward in visual buffer
            if (isCurrentRTL) {
                // RTL: check earlier indices (visually they come after)
                for (let i = this.selectedGlyphIndex - 1; i >= 0; i--) {
                    const glyph = this.shapedGlyphs[i];
                    if ((glyph.cl || 0) === currentClusterPos) {
                        console.log(`Navigating to next glyph in RTL cluster ${currentClusterPos}: index ${i}`);
                        await this.selectGlyphByIndex(i);
                        return;
                    }
                }
            } else {
                // LTR: check later indices
                for (let i = this.selectedGlyphIndex + 1; i < this.shapedGlyphs.length; i++) {
                    const glyph = this.shapedGlyphs[i];
                    if ((glyph.cl || 0) === currentClusterPos) {
                        console.log(`Navigating to next glyph in LTR cluster ${currentClusterPos}: index ${i}`);
                        await this.selectGlyphByIndex(i);
                        return;
                    }
                }
            }

            // No more glyphs at current cluster, move to next cluster position logically
            let nextPosition = currentClusterPos + 1;

            // Find next cluster position that has a glyph
            while (nextPosition <= this.textBuffer.length) {
                const isNextRTL = this.isPositionRTL(nextPosition);
                // For RTL clusters, start with the last glyph (visually first)
                // For LTR clusters, start with the first glyph
                const glyphIndex = isNextRTL
                    ? this.findLastGlyphAtClusterPosition(nextPosition)
                    : this.findFirstGlyphAtClusterPosition(nextPosition);
                if (glyphIndex >= 0) {
                    console.log(`Navigating from cluster ${currentClusterPos} to ${nextPosition} (glyph ${glyphIndex})`);
                    await this.selectGlyphByIndex(glyphIndex);
                    return;
                }
                nextPosition++;
            }

            console.log('Already at last glyph in logical order');
        }
    }

    async navigateToPreviousGlyphLogical() {
        // Navigate to the previous glyph in logical order (backward in text)
        if (!this.isGlyphEditMode || this.componentStack.length > 0) {
            return; // Only works in top-level glyph edit mode
        }

        // Get current glyph's cluster position
        if (this.selectedGlyphIndex >= 0 && this.selectedGlyphIndex < this.shapedGlyphs.length) {
            const currentGlyph = this.shapedGlyphs[this.selectedGlyphIndex];
            const currentClusterPos = currentGlyph.cl || 0;
            const isCurrentRTL = this.isPositionRTL(currentClusterPos);

            // First, try to find another glyph at the SAME cluster position
            // For RTL: move forward in visual buffer (later glyphs are visually earlier)
            // For LTR: move backward in visual buffer
            if (isCurrentRTL) {
                // RTL: check later indices (visually they come before)
                for (let i = this.selectedGlyphIndex + 1; i < this.shapedGlyphs.length; i++) {
                    const glyph = this.shapedGlyphs[i];
                    if ((glyph.cl || 0) === currentClusterPos) {
                        console.log(`Navigating to previous glyph in RTL cluster ${currentClusterPos}: index ${i}`);
                        await this.selectGlyphByIndex(i);
                        return;
                    }
                }
            } else {
                // LTR: check earlier indices
                for (let i = this.selectedGlyphIndex - 1; i >= 0; i--) {
                    const glyph = this.shapedGlyphs[i];
                    if ((glyph.cl || 0) === currentClusterPos) {
                        console.log(`Navigating to previous glyph in LTR cluster ${currentClusterPos}: index ${i}`);
                        await this.selectGlyphByIndex(i);
                        return;
                    }
                }
            }

            // No more glyphs at current cluster, move to previous cluster position logically
            let prevPosition = currentClusterPos - 1;

            // Find previous cluster position that has a glyph
            while (prevPosition >= 0) {
                const isPrevRTL = this.isPositionRTL(prevPosition);
                // For RTL clusters, start with the first glyph (visually last)
                // For LTR clusters, start with the last glyph
                const glyphIndex = isPrevRTL
                    ? this.findFirstGlyphAtClusterPosition(prevPosition)
                    : this.findLastGlyphAtClusterPosition(prevPosition);
                if (glyphIndex >= 0) {
                    console.log(`Navigating from cluster ${currentClusterPos} to ${prevPosition} (glyph ${glyphIndex})`);
                    await this.selectGlyphByIndex(glyphIndex);
                    return;
                }
                prevPosition--;
            }

            console.log('Already at first glyph in logical order');
        }
    }

    findFirstGlyphAtClusterPosition(clusterPos) {
        // Find the first visual glyph index that corresponds to a logical cluster position
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return -1;
        }

        for (let i = 0; i < this.shapedGlyphs.length; i++) {
            const glyph = this.shapedGlyphs[i];
            if ((glyph.cl || 0) === clusterPos) {
                return i;
            }
        }

        return -1;
    }

    findLastGlyphAtClusterPosition(clusterPos) {
        // Find the last visual glyph index that corresponds to a logical cluster position
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return -1;
        }

        for (let i = this.shapedGlyphs.length - 1; i >= 0; i--) {
            const glyph = this.shapedGlyphs[i];
            if ((glyph.cl || 0) === clusterPos) {
                return i;
            }
        }

        return -1;
    }

    async fetchGlyphData() {
        // Fetch glyph and font data from Python
        if (!window.pyodide || this.selectedGlyphIndex < 0) {
            return null;
        }

        try {
            const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from font manager (source font) instead of compiled font
            if (window.fontManager && window.fontManager.babelfontData) {
                glyphName = window.fontManager.getGlyphName(glyphId);
            } else if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                // Fallback to compiled font name (will be production name like glyph00001)
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
            }

            // Fetch glyph and font data from Python
            const dataJson = await window.pyodide.runPythonAsync(`
import json

result = None
try:
    current_font = CurrentFont()
    if current_font and hasattr(current_font, 'glyphs'):
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Get master IDs for filtering
            master_ids = set(m.id for m in current_font.masters)
            
            # Get foreground layers (filter out background layers and non-master layers)
            layers_data = []
            for layer in glyph.layers:
                if not layer.is_background:
                    # For master layers, _master is None and the layer.id IS the master ID
                    # For alternate/intermediate layers, _master points to the parent master
                    master_id = layer._master if layer._master else layer.id
                    
                    # Only include layers whose master ID exists in the masters list
                    if master_id in master_ids:
                        layer_info = {
                            'id': layer.id,
                            'name': layer.name or 'Default',
                            '_master': master_id,
                            'location': layer.location
                        }
                        layers_data.append(layer_info)
            
            # Get masters data with userspace locations
            masters_data = []
            for master in current_font.masters:
                # Convert design space location to user space
                userspace_location = current_font.map_backward(master.location)
                masters_data.append({
                    'id': master.id,
                    'name': master.name,
                    'location': userspace_location
                })
            
            # Get axes order (list of axis tags in definition order)
            axes_order = [axis.tag for axis in current_font.axes]
            
            result = {
                'glyphName': glyph.name,
                'layers': layers_data,
                'masters': masters_data,
                'axesOrder': axes_order
            }
except Exception as e:
    print(f"Error fetching glyph data: {e}")
    result = None

json.dumps(result)
`);

            return JSON.parse(dataJson);
        } catch (error) {
            console.error('Error fetching glyph data from Python:', error);
            return null;
        }
    }

    async displayLayersList() {
        // Fetch and display layers list
        this.fontData = await this.fetchGlyphData();

        if (!this.fontData || !this.fontData.layers || this.fontData.layers.length === 0) {
            return;
        }

        // Add layers section title
        const layersTitle = document.createElement('div');
        layersTitle.className = 'editor-section-title';
        layersTitle.textContent = 'Foreground Layers';
        this.propertiesSection.appendChild(layersTitle);

        // Sort layers by master order (order in which masters are defined in font.masters)
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(m => m.id === a._master);
            const masterIndexB = this.fontData.masters.findIndex(m => m.id === b._master);

            // If master not found, put at end
            const posA = masterIndexA === -1 ? this.fontData.masters.length : masterIndexA;
            const posB = masterIndexB === -1 ? this.fontData.masters.length : masterIndexB;

            return posA - posB;
        });

        // Create layers list
        const layersList = document.createElement('div');
        layersList.className = 'editor-layers-list';

        for (const layer of sortedLayers) {
            const layerItem = document.createElement('div');
            layerItem.className = 'editor-layer-item';
            if (this.selectedLayerId === layer.id) {
                layerItem.classList.add('selected');
            }
            layerItem.setAttribute('data-layer-id', layer.id); // Add data attribute for selection updates

            // Find the master for this layer
            const master = this.fontData.masters.find(m => m.id === layer._master);

            // Format axis values for display (e.g., "wght:400, wdth:100")
            // Display axes in the order they are defined in font.axes
            let axisValues = '';
            if (master && master.location) {
                // Sort axis tags according to font.axes order
                const axesOrder = this.fontData.axesOrder || Object.keys(master.location).sort();
                const locationParts = axesOrder
                    .filter(tag => tag in master.location)
                    .map(tag => `${tag}:${Math.round(master.location[tag])}`)
                    .join(', ');
                axisValues = locationParts;
            }

            layerItem.textContent = axisValues || layer.name || 'Default';

            // Click handler
            layerItem.addEventListener('click', () => {
                this.selectLayer(layer);
            });

            layersList.appendChild(layerItem);
        }

        this.propertiesSection.appendChild(layersList);

        // Auto-select layer if current axis values match a layer's master location
        await this.autoSelectMatchingLayer();
    }

    async autoSelectMatchingLayer() {
        // Check if current variation settings match any layer's master location
        if (!this.fontData || !this.fontData.layers || !this.fontData.masters) {
            return;
        }

        // Get current axis tags and values
        const currentLocation = { ...this.variationSettings };

        // Check each layer to find a match
        for (const layer of this.fontData.layers) {
            const master = this.fontData.masters.find(m => m.id === layer._master);
            if (!master || !master.location) {
                continue;
            }

            // Check if all axis values match exactly
            let allMatch = true;
            for (const [tag, value] of Object.entries(master.location)) {
                if ((currentLocation[tag] || 0) !== value) {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch) {
                // Found a matching layer - select it
                this.selectedLayerId = layer.id;

                // Clear previous state since we're now on a layer location
                // This prevents Escape from trying to restore, allowing it to exit components instead
                this.previousSelectedLayerId = null;
                this.previousVariationSettings = null;

                // Only fetch layer data if we're not currently editing a component
                // If editing a component, the layer switch will be handled by refreshComponentStack
                if (this.componentStack.length === 0) {
                    await this.fetchLayerData(); // Fetch layer data for outline editor

                    // Perform mouse hit detection after layer data is loaded
                    this.updateHoveredComponent();
                    this.updateHoveredAnchor();
                    this.updateHoveredPoint();
                }
                this.updateLayerSelection();
                console.log(`Auto-selected layer: ${layer.name || 'Default'} (${layer.id})`);
                return;
            }
        }

        // No matching layer found - deselect current layer
        if (this.selectedLayerId !== null) {
            this.selectedLayerId = null;
            this.layerData = null; // Clear layer data when deselecting
            this.selectedPointIndex = null;
            this.hoveredPointIndex = null;
            this.updateLayerSelection();
            console.log('No matching layer - deselected');
        }
    }

    async selectLayer(layer) {
        // Select a layer and update axis sliders to match its master location
        // Clear previous state when explicitly selecting a layer
        this.previousSelectedLayerId = null;
        this.previousVariationSettings = null;

        this.selectedLayerId = layer.id;
        console.log(`Selected layer: ${layer.name} (ID: ${layer.id})`);
        console.log('Layer data:', layer);
        console.log('Available masters:', this.fontData.masters);

        // Fetch layer data now, whether editing component or not
        // This ensures new outlines load before animation starts
        await this.fetchLayerData();

        // Perform mouse hit detection after layer data is loaded
        this.updateHoveredComponent();
        this.updateHoveredAnchor();
        this.updateHoveredPoint();

        // Find the master for this layer
        const master = this.fontData.masters.find(m => m.id === layer._master);
        if (!master || !master.location) {
            console.warn('No master location found for layer', {
                layer_master: layer._master,
                available_master_ids: this.fontData.masters.map(m => m.id),
                master_found: master
            });
            return;
        }

        console.log(`Setting axis values to master location:`, master.location);

        // Cancel any ongoing animation
        if (this.isAnimating) {
            this.isAnimating = false;
        }

        // Set up animation to all axes at once
        this.animationStartValues = { ...this.variationSettings };
        this.animationTargetValues = { ...this.variationSettings };

        // Update target values for all axes in the master location
        for (const [axisTag, value] of Object.entries(master.location)) {
            this.animationTargetValues[axisTag] = value;
        }

        // Start animation
        this.animationCurrentFrame = 0;
        this.isAnimating = true;
        this.animateVariation();

        // Update the visual selection highlight for layers without rebuilding the entire UI
        this.updateLayerSelection();
    }

    updateLayerSelection() {
        // Update the visual selection highlight for layer items without rebuilding
        if (!this.propertiesSection) return;

        // Find all layer items and update their selected class
        const layerItems = this.propertiesSection.querySelectorAll('[data-layer-id]');
        layerItems.forEach(item => {
            const layerId = item.getAttribute('data-layer-id');
            if (layerId === this.selectedLayerId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async cycleLayers(moveUp) {
        // Cycle through layers with Cmd+Up (previous) or Cmd+Down (next)
        if (!this.fontData || !this.fontData.layers || this.fontData.layers.length === 0) {
            return;
        }

        // Get sorted layers (same as in displayLayersList)
        // Sort layers by master order (order in which masters are defined in font.masters)
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(m => m.id === a._master);
            const masterIndexB = this.fontData.masters.findIndex(m => m.id === b._master);

            // If master not found, put at end
            const posA = masterIndexA === -1 ? this.fontData.masters.length : masterIndexA;
            const posB = masterIndexB === -1 ? this.fontData.masters.length : masterIndexB;

            return posA - posB;
        });

        // Find current layer index
        const currentIndex = sortedLayers.findIndex(layer => layer.id === this.selectedLayerId);
        if (currentIndex === -1) {
            // No layer selected, select first layer
            await this.selectLayer(sortedLayers[0]);
            return;
        }

        // Calculate next index (with wrapping)
        let nextIndex;
        if (moveUp) {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) {
                nextIndex = sortedLayers.length - 1; // Wrap to last
            }
        } else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= sortedLayers.length) {
                nextIndex = 0; // Wrap to first
            }
        }

        // Select the next layer
        await this.selectLayer(sortedLayers[nextIndex]);
    }

    async fetchLayerData() {
        // If we're editing a component, refresh the component's layer data for the new layer
        if (this.componentStack.length > 0) {
            console.log('Refreshing component layer data for new layer');
            await this.refreshComponentStack();
            return;
        }

        // Fetch full layer data including shapes using to_dict()
        if (!window.pyodide || !this.selectedLayerId) {
            this.layerData = null;
            return;
        }

        try {
            const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from font manager (source font) instead of compiled font
            if (window.fontManager && window.fontManager.babelfontData) {
                glyphName = window.fontManager.getGlyphName(glyphId);
                console.log(`🔍 Fetching layer data for glyph: "${glyphName}" (GID ${glyphId}), layer: ${this.selectedLayerId}`);
            } else if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                // Fallback to compiled font name (will be production name like glyph00001)
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
                console.log(`🔍 Fetching layer data for glyph: "${glyphName}" (GID ${glyphId}, production name), layer: ${this.selectedLayerId}`);
            }

            const dataJson = await window.pyodide.runPythonAsync(`
import json

# Get current font once at the top level
current_font = CurrentFont()
if not current_font or not hasattr(current_font, 'glyphs'):
    result = None
else:
    def fetch_component_recursive(font, glyph_name, layer_id, visited=None):
        """Recursively fetch component data including nested components"""
        if visited is None:
            visited = set()
        
        if glyph_name in visited:
            print(f"Warning: Circular component reference detected for {glyph_name}")
            return None
        
        visited.add(glyph_name)
        
        if not font or not hasattr(font, 'glyphs'):
            return None
        
        glyph = font.glyphs.get(glyph_name)
        if not glyph:
            return None
        
        # Find the layer by ID
        layer = None
        for l in glyph.layers:
            if l.id == layer_id:
                layer = l
                break
        
        if not layer:
            return None
        
        # Serialize the layer
        result = layer.to_dict()
        
        # Recursively fetch nested component data
        if result and 'shapes' in result:
            for shape in result['shapes']:
                if 'Component' in shape and 'reference' in shape['Component']:
                    ref_name = shape['Component']['reference']
                    # Fetch nested component data
                    nested_data = fetch_component_recursive(font, ref_name, layer_id, visited.copy())
                    if nested_data:
                        shape['Component']['layerData'] = nested_data
        
        return result

    result = None
    try:
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Find the layer by ID
            layer = None
            for l in glyph.layers:
                if l.id == '${this.selectedLayerId}':
                    layer = l
                    break
            
            if layer:
                # Use to_dict() to serialize the layer
                result = layer.to_dict()
                
                # Recursively fetch component layer data
                if result and 'shapes' in result:
                    for shape in result['shapes']:
                        if 'Component' in shape and 'reference' in shape['Component']:
                            ref_name = shape['Component']['reference']
                            nested_data = fetch_component_recursive(current_font, ref_name, '${this.selectedLayerId}')
                            if nested_data:
                                shape['Component']['layerData'] = nested_data
    except Exception as e:
        print(f"Error fetching layer data: {e}")
        import traceback
        traceback.print_exc()
        result = None

json.dumps(result)
`);

            this.layerData = JSON.parse(dataJson);

            // Recursively parse component layer data nodes strings into arrays
            const parseComponentNodes = (shapes) => {
                if (!shapes) return;

                shapes.forEach(shape => {
                    // Parse nodes in Path shapes
                    if (shape.Path && shape.Path.nodes) {
                        const nodesStr = shape.Path.nodes.trim();
                        const tokens = nodesStr.split(/\s+/);
                        const nodesArray = [];

                        for (let i = 0; i + 2 < tokens.length; i += 3) {
                            nodesArray.push([
                                parseFloat(tokens[i]),
                                parseFloat(tokens[i + 1]),
                                tokens[i + 2]
                            ]);
                        }

                        shape.nodes = nodesArray;
                    }

                    // Recursively parse nested component data
                    if (shape.Component && shape.Component.layerData && shape.Component.layerData.shapes) {
                        parseComponentNodes(shape.Component.layerData.shapes);
                    }
                });
            };

            if (this.layerData && this.layerData.shapes) {
                parseComponentNodes(this.layerData.shapes);
            }

            console.log('Fetched layer data:', this.layerData);
            this.render();
        } catch (error) {
            console.error('Error fetching layer data from Python:', error);
            this.layerData = null;
        }
    }

    async fetchComponentLayerData(componentGlyphName) {
        // Fetch layer data for a specific component glyph, including nested components
        if (!window.pyodide || !this.selectedLayerId) {
            return null;
        }

        try {
            const dataJson = await window.pyodide.runPythonAsync(`
import json

def fetch_component_recursive(glyph_name, layer_id, visited=None):
    """Recursively fetch component data including nested components"""
    if visited is None:
        visited = set()
    
    if glyph_name in visited:
        print(f"Warning: Circular component reference detected for {glyph_name}")
        return None
    
    visited.add(glyph_name)
    
    current_font = CurrentFont()
    if not current_font or not hasattr(current_font, 'glyphs'):
        return None
    
    glyph = current_font.glyphs.get(glyph_name)
    if not glyph:
        return None
    
    # Find the layer by ID
    layer = None
    for l in glyph.layers:
        if l.id == layer_id:
            layer = l
            break
    
    if not layer:
        return None
    
    # Serialize the layer
    result = layer.to_dict()
    
    # Recursively fetch nested component data
    if result and 'shapes' in result:
        for shape in result['shapes']:
            if 'Component' in shape and 'reference' in shape['Component']:
                ref_name = shape['Component']['reference']
                # Fetch nested component data
                nested_data = fetch_component_recursive(ref_name, layer_id, visited.copy())
                if nested_data:
                    shape['Component']['layerData'] = nested_data
    
    return result

result = None
try:
    result = fetch_component_recursive('${componentGlyphName}', '${this.selectedLayerId}')
except Exception as e:
    print(f"Error fetching component layer data: {e}")
    import traceback
    traceback.print_exc()
    result = None

json.dumps(result)
`);

            return JSON.parse(dataJson);
        } catch (error) {
            console.error('Error fetching component layer data from Python:', error);
            return null;
        }
    }

    async saveLayerData() {
        // Save layer data back to Python using from_dict()
        if (!window.pyodide || !this.selectedLayerId || !this.layerData) {
            return;
        }

        try {
            // Determine which glyph to save to
            let glyphName;

            if (this.componentStack.length > 0) {
                // We're editing a component - save to the component's glyph
                // Get the component reference from the parent layer
                const parentState = this.componentStack[this.componentStack.length - 1];
                const componentShape = parentState.layerData.shapes[this.editingComponentIndex];
                glyphName = componentShape.Component.reference;
            } else {
                // We're editing the main glyph
                const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
                glyphName = `GID ${glyphId}`;

                // Get glyph name from font manager (source font) instead of compiled font
                if (window.fontManager && window.fontManager.babelfontData) {
                    glyphName = window.fontManager.getGlyphName(glyphId);
                } else if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                    // Fallback to compiled font name (will be production name like glyph00001)
                    const glyph = this.opentypeFont.glyphs.get(glyphId);
                    if (glyph.name) {
                        glyphName = glyph.name;
                    }
                }
            }

            // Convert nodes array back to string format for Python
            const layerDataCopy = JSON.parse(JSON.stringify(this.layerData));
            if (layerDataCopy.shapes) {
                layerDataCopy.shapes.forEach(shape => {
                    if (shape.nodes && Array.isArray(shape.nodes)) {
                        // Convert array back to string: [[x, y, type], ...] -> "x y type x y type ..."
                        const nodesString = shape.nodes.map(node => `${node[0]} ${node[1]} ${node[2]}`).join(' ');
                        // Store in Path.nodes format
                        if (!shape.Path) {
                            shape.Path = {};
                        }
                        shape.Path.nodes = nodesString;
                        shape.Path.closed = true; // Assume closed for now
                        delete shape.nodes; // Remove the parsed array
                    }
                });
            }

            const layerDataJson = JSON.stringify(layerDataCopy);

            await window.pyodide.runPythonAsync(`
import json

try:
    current_font = CurrentFont()
    if current_font and hasattr(current_font, 'glyphs'):
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Find the layer by ID
            layer = None
            for l in glyph.layers:
                if l.id == '${this.selectedLayerId}':
                    layer = l
                    break
            
            if layer:
                # Parse the JSON data
                layer_dict = json.loads('''${layerDataJson}''')
                
                # Update the layer's _data dictionary directly
                # from_dict() is a classmethod that creates a NEW object,
                # so we need to update the existing layer's internal data
                layer._data.update(layer_dict)
                
                # Mark layer and parent glyph as dirty to trigger recompilation
                if hasattr(layer, 'mark_dirty'):
                    layer.mark_dirty()
                
                # Also mark glyph dirty
                if glyph and hasattr(glyph, 'mark_dirty'):
                    glyph.mark_dirty()
                
except Exception as e:
    print(f"Error saving layer data: {e}")
    import traceback
    traceback.print_exc()
`);

            console.log('Layer data saved successfully');
        } catch (error) {
            console.error('Error saving layer data to Python:', error);
        }
    }

    async enterComponentEditing(componentIndex, skipUIUpdate = false) {
        // Enter editing mode for a component
        // skipUIUpdate: if true, skip UI updates (useful when rebuilding component stack)
        if (!this.layerData || !this.layerData.shapes[componentIndex]) {
            return;
        }

        const componentShape = this.layerData.shapes[componentIndex];
        if (!componentShape.Component || !componentShape.Component.reference) {
            console.log('Component has no reference');
            return;
        }

        // Fetch the component's layer data
        const componentLayerData = await this.fetchComponentLayerData(componentShape.Component.reference);
        if (!componentLayerData) {
            console.error('Failed to fetch component layer data for:', componentShape.Component.reference);
            return;
        }

        console.log('Fetched component layer data:', componentLayerData);

        // Recursively parse nodes in component layer data (including nested components)
        const parseComponentNodes = (shapes) => {
            if (!shapes) return;

            shapes.forEach(shape => {
                // Parse nodes in Path shapes
                if (shape.Path && shape.Path.nodes) {
                    const nodesStr = shape.Path.nodes.trim();
                    const tokens = nodesStr.split(/\s+/);
                    const nodesArray = [];

                    for (let i = 0; i + 2 < tokens.length; i += 3) {
                        nodesArray.push([
                            parseFloat(tokens[i]),
                            parseFloat(tokens[i + 1]),
                            tokens[i + 2]
                        ]);
                    }

                    shape.nodes = nodesArray;
                    console.log('Parsed shape nodes:', nodesArray.length, 'nodes');
                }

                // Recursively parse nested component data
                if (shape.Component && shape.Component.layerData && shape.Component.layerData.shapes) {
                    parseComponentNodes(shape.Component.layerData.shapes);
                }
            });
        };

        if (componentLayerData.shapes) {
            parseComponentNodes(componentLayerData.shapes);
        }

        console.log('About to set layerData to component data. Current shapes:', this.layerData?.shapes?.length, '-> New shapes:', componentLayerData.shapes?.length);

        // Get component transform
        const transform = componentShape.Component.transform || [1, 0, 0, 1, 0, 0];

        // Get current glyph name (for breadcrumb trail)
        // This is the name of the context we're currently in (before entering the new component)
        let currentGlyphName;
        if (this.componentStack.length > 0) {
            // We're already in a component, so get its reference name
            // Use the componentIndex stored in the parent state (not this.editingComponentIndex)
            const parentState = this.componentStack[this.componentStack.length - 1];
            if (parentState && parentState.layerData && parentState.layerData.shapes &&
                parentState.componentIndex !== null && parentState.componentIndex !== undefined) {
                const currentComponent = parentState.layerData.shapes[parentState.componentIndex];
                if (currentComponent && currentComponent.Component) {
                    currentGlyphName = currentComponent.Component.reference;
                }
            }
            // Fallback if we can't get the component name
            if (!currentGlyphName) {
                currentGlyphName = 'Unknown';
            }
        } else {
            // We're at the top level - get main glyph name
            const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
            currentGlyphName = `GID ${glyphId}`;
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    currentGlyphName = glyph.name;
                }
            }
        }

        // Push current state onto stack (before changing this.layerData)
        // Store the component we're about to enter (componentIndex), not the old editingComponentIndex
        this.componentStack.push({
            componentIndex: componentIndex,
            transform: this.getAccumulatedTransform(),
            layerData: this.layerData,
            selectedPoints: this.selectedPoints,
            selectedAnchors: this.selectedAnchors,
            selectedComponents: this.selectedComponents,
            glyphName: currentGlyphName
        });

        console.log(`Pushed to stack. Stack depth: ${this.componentStack.length}, storing glyphName: ${currentGlyphName}`);

        // Set the component as the current editing context
        this.editingComponentIndex = componentIndex;
        this.layerData = componentLayerData;

        console.log('Set layerData to component. this.layerData.shapes.length:', this.layerData?.shapes?.length);

        // Clear selections
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;

        console.log(`Entered component editing: ${componentShape.Component.reference}, stack depth: ${this.componentStack.length}`);

        if (!skipUIUpdate) {
            this.updateComponentBreadcrumb();
            this.updatePropertiesUI();
            this.render();

            // Re-check mouse position to detect components/points/anchors at current location
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
        }
    }

    async refreshComponentStack() {
        // Refresh all component layer data in the stack for the current layer
        // This is called when switching layers while editing a nested component

        if (this.componentStack.length === 0) {
            return;
        }

        console.log('Refreshing component stack for new layer, stack depth:', this.componentStack.length);

        // Save the path of component indices from the stack
        const componentPath = [];
        for (let i = 0; i < this.componentStack.length; i++) {
            componentPath.push(this.componentStack[i].componentIndex);
        }

        // Clear the stack and editing state
        this.componentStack = [];
        this.editingComponentIndex = null;
        this.layerData = null;

        // Fetch root layer data (bypassing the component check since stack is now empty)
        try {
            // Fetch full root layer data including shapes
            if (!window.pyodide || !this.selectedLayerId) {
                this.layerData = null;
                return;
            }

            const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from compiled font
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
            }

            const dataJson = await window.pyodide.runPythonAsync(`
import json

def fetch_component_recursive(glyph_name, layer_id, visited=None):
    """Recursively fetch component data including nested components"""
    if visited is None:
        visited = set()
    
    if glyph_name in visited:
        print(f"Warning: Circular component reference detected for {glyph_name}")
        return None
    
    visited.add(glyph_name)
    
    current_font = CurrentFont()
    if not current_font or not hasattr(current_font, 'glyphs'):
        return None
    
    glyph = current_font.glyphs.get(glyph_name)
    if not glyph:
        return None
    
    # Find the layer by ID
    layer = None
    for l in glyph.layers:
        if l.id == layer_id:
            layer = l
            break
    
    if not layer:
        return None
    
    # Serialize the layer
    result = layer.to_dict()
    
    # Recursively fetch nested component data
    if result and 'shapes' in result:
        for shape in result['shapes']:
            if 'Component' in shape and 'reference' in shape['Component']:
                ref_name = shape['Component']['reference']
                # Fetch nested component data
                nested_data = fetch_component_recursive(ref_name, layer_id, visited.copy())
                if nested_data:
                    shape['Component']['layerData'] = nested_data
    
    return result

result = None
try:
    result = fetch_component_recursive('${glyphName}', '${this.selectedLayerId}')
except Exception as e:
    print(f"Error fetching layer data: {e}")
    import traceback
    traceback.print_exc()
    result = None

json.dumps(result)
`);

            this.layerData = JSON.parse(dataJson);
            console.log('Fetched root layer data with', this.layerData?.shapes?.length || 0, 'shapes');

            // Re-enter each component level without UI updates
            for (const componentIndex of componentPath) {
                if (!this.layerData || !this.layerData.shapes[componentIndex]) {
                    console.error('Failed to refresh component stack - component not found at index', componentIndex);
                    break;
                }

                await this.enterComponentEditing(componentIndex, true); // Skip UI updates
            }

            console.log('Component stack refreshed, new depth:', this.componentStack.length);

            // Update UI once at the end
            this.updateComponentBreadcrumb();
            await this.updatePropertiesUI();
            this.render();
        } catch (error) {
            console.error('Error refreshing component stack:', error);
        }
    }

    exitComponentEditing(skipUIUpdate = false) {
        // Exit current component editing level
        // skipUIUpdate: if true, skip UI updates (useful when exiting multiple levels)
        if (this.componentStack.length === 0) {
            return false; // No component stack to exit from
        }

        const previousState = this.componentStack.pop();

        // Restore previous state
        this.editingComponentIndex = previousState.componentIndex;
        this.layerData = previousState.layerData;
        this.selectedPoints = previousState.selectedPoints || [];
        this.selectedAnchors = previousState.selectedAnchors || [];
        this.selectedComponents = previousState.selectedComponents || [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;

        console.log(`Exited component editing, stack depth: ${this.componentStack.length}`);

        if (!skipUIUpdate) {
            this.updateComponentBreadcrumb();
            this.updatePropertiesUI();
            this.render();

            // Re-check mouse position to detect components/points/anchors at current location
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
        }

        return true;
    }

    updateComponentBreadcrumb() {
        // This function now just calls updateEditorTitleBar
        // Keeping it for backward compatibility with existing calls
        this.updateEditorTitleBar();
    }

    updateEditorTitleBar() {
        // Update the editor title bar with glyph name and breadcrumb
        const editorView = document.getElementById('view-editor');
        if (!editorView) return;

        const titleBar = editorView.querySelector('.view-title-bar');
        if (!titleBar) return;

        const titleLeft = titleBar.querySelector('.view-title-left');
        if (!titleLeft) return;

        // Find or create the glyph name element
        let glyphNameElement = titleBar.querySelector('.editor-glyph-name');
        if (!glyphNameElement) {
            glyphNameElement = document.createElement('span');
            glyphNameElement.className = 'editor-glyph-name';
            glyphNameElement.style.cssText = `
                margin-left: 12px;
                margin-top: -2px;
                font-family: var(--font-mono);
                font-size: 13px;
                color: var(--text-secondary);
                display: flex;
                align-items: center;
                gap: 6px;
            `;
            titleLeft.appendChild(glyphNameElement);
        }

        // Clear existing content
        glyphNameElement.innerHTML = '';

        // If not in edit mode, hide the glyph name
        if (!this.isGlyphEditMode || this.selectedGlyphIndex < 0 || this.selectedGlyphIndex >= this.shapedGlyphs.length) {
            glyphNameElement.style.display = 'none';
            return;
        }

        glyphNameElement.style.display = 'flex';

        // Get the main glyph name
        const glyphId = this.shapedGlyphs[this.selectedGlyphIndex].g;
        let mainGlyphName = `GID ${glyphId}`;
        if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
            const glyph = this.opentypeFont.glyphs.get(glyphId);
            if (glyph.name) {
                mainGlyphName = glyph.name;
            }
        }

        // Build breadcrumb trail
        const trail = [];

        if (this.componentStack.length > 0) {
            // Add main glyph name as first item in trail
            trail.push(mainGlyphName);

            // Add each level from the stack (skip the first one if it matches main glyph)
            for (let i = 0; i < this.componentStack.length; i++) {
                const level = this.componentStack[i];
                // Only add if different from main glyph name
                if (level.glyphName !== mainGlyphName) {
                    trail.push(level.glyphName);
                }
            }

            // Add current component (the one we're currently editing)
            // Get this from the last stack entry's stored componentIndex
            if (this.componentStack.length > 0) {
                const currentState = this.componentStack[this.componentStack.length - 1];
                if (currentState && currentState.layerData && currentState.layerData.shapes &&
                    currentState.componentIndex !== null && currentState.componentIndex !== undefined) {
                    const currentComponent = currentState.layerData.shapes[currentState.componentIndex];
                    if (currentComponent && currentComponent.Component) {
                        trail.push(currentComponent.Component.reference);
                    }
                }
            }
        }

        // If we have a breadcrumb trail (in component editing mode), show it
        if (trail.length > 0) {
            // Add breadcrumb trail as clickable text
            trail.forEach((componentName, index) => {
                if (index > 0) {
                    const arrow = document.createElement('span');
                    arrow.className = 'material-symbols-outlined';
                    arrow.textContent = 'chevron_right';
                    arrow.style.cssText = 'opacity: 0.5; font-size: 16px;';
                    glyphNameElement.appendChild(arrow);
                }

                const item = document.createElement('span');
                item.textContent = componentName;
                item.style.cssText = `
                    cursor: pointer;
                    transition: opacity 0.15s;
                `;

                // Current level is highlighted
                if (index === trail.length - 1) {
                    item.style.fontWeight = '500';
                    item.style.color = 'var(--text-primary)';

                    // Add pop animation to last item for user attention
                    item.style.animation = 'none';
                    // Force reflow to restart animation
                    void item.offsetWidth;
                    item.style.animation = 'breadcrumb-pop 0.3s ease-out';
                } else {
                    item.style.opacity = '0.7';
                    item.style.color = 'var(--text-secondary)';
                }

                // Hover effect
                item.addEventListener('mouseenter', () => {
                    if (index < trail.length - 1) {
                        item.style.opacity = '1';
                    }
                });
                item.addEventListener('mouseleave', () => {
                    if (index < trail.length - 1) {
                        item.style.opacity = '0.7';
                    }
                });

                // Click to navigate to that level
                item.addEventListener('click', () => {
                    const levelsToExit = trail.length - 1 - index;
                    // Skip UI updates during batch exit to avoid duplicate layer interfaces
                    for (let i = 0; i < levelsToExit; i++) {
                        this.exitComponentEditing(true); // Skip UI updates
                    }
                    // Update UI once after all exits
                    if (levelsToExit > 0) {
                        this.updateComponentBreadcrumb();
                        this.updatePropertiesUI();
                        this.render();
                    }
                });

                glyphNameElement.appendChild(item);
            });
        } else {
            // Not in component editing - just show main glyph name
            const mainNameSpan = document.createElement('span');
            mainNameSpan.textContent = mainGlyphName;
            mainNameSpan.style.cssText = `
                color: var(--text-primary);
                font-weight: 500;
            `;

            // Add pop animation for user attention
            mainNameSpan.style.animation = 'none';
            // Force reflow to restart animation
            void mainNameSpan.offsetWidth;
            mainNameSpan.style.animation = 'breadcrumb-pop 0.3s ease-out';

            glyphNameElement.appendChild(mainNameSpan);
        }
    }

    getAccumulatedTransform() {
        // Get the accumulated transform matrix from all component levels
        let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;

        // Apply transforms from all components in the stack
        // The stack now contains all the components we've entered (level 0, 1, 2, etc.)
        for (const level of this.componentStack) {
            if (level.componentIndex !== null && level.layerData && level.layerData.shapes[level.componentIndex]) {
                const comp = level.layerData.shapes[level.componentIndex].Component;
                if (comp && comp.transform) {
                    const t = comp.transform;
                    // Multiply transforms: new = current * level
                    const newA = a * t[0] + c * t[1];
                    const newB = b * t[0] + d * t[1];
                    const newC = a * t[2] + c * t[3];
                    const newD = b * t[2] + d * t[3];
                    const newTx = a * t[4] + c * t[5] + tx;
                    const newTy = b * t[4] + d * t[5] + ty;
                    a = newA; b = newB; c = newC; d = newD; tx = newTx; ty = newTy;
                }
            }
        }

        return [a, b, c, d, tx, ty];
    }

    transformMouseToComponentSpace(mouseX, mouseY) {
        // Transform mouse coordinates from canvas to component local space
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;
        let glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        let glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        // Adjust for selected glyph position
        let xPosition = 0;
        for (let i = 0; i < this.selectedGlyphIndex; i++) {
            xPosition += (this.shapedGlyphs[i].ax || 0);
        }
        const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        glyphX -= (xPosition + xOffset);
        glyphY -= yOffset;

        // Apply inverse component transform if editing a component
        if (this.componentStack.length > 0) {
            const glyphXBeforeInverse = glyphX;
            const glyphYBeforeInverse = glyphY;
            const compTransform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = compTransform;
            const det = a * d - b * c;

            if (Math.abs(det) > 0.0001) {
                // Inverse transform: (x', y') = inverse(T) * (x - tx, y - ty)
                const localX = glyphX - tx;
                const localY = glyphY - ty;
                glyphX = (d * localX - c * localY) / det;
                glyphY = (a * localY - b * localX) / det;
            }
            console.log(`transformMouseToComponentSpace: before inverse=(${glyphXBeforeInverse}, ${glyphYBeforeInverse}), after inverse=(${glyphX}, ${glyphY}), accumulated transform=[${compTransform}]`);
        }

        return { glyphX, glyphY };
    }

    updateAxisSliders() {
        // Update axis slider positions to match current variationSettings
        if (!this.axesSection) return;

        // Update all sliders
        const sliders = this.axesSection.querySelectorAll('input[data-axis-tag]');
        sliders.forEach(slider => {
            const axisTag = slider.getAttribute('data-axis-tag');
            if (this.variationSettings[axisTag] !== undefined) {
                slider.value = this.variationSettings[axisTag];
            }
        });

        // Update all value labels
        const valueLabels = this.axesSection.querySelectorAll('span[data-axis-tag]');
        valueLabels.forEach(label => {
            const axisTag = label.getAttribute('data-axis-tag');
            if (this.variationSettings[axisTag] !== undefined) {
                label.textContent = this.variationSettings[axisTag].toFixed(0);
            }
        });
    }

    async updatePropertiesUI() {
        if (!this.propertiesSection) return;

        // Clear existing content
        this.propertiesSection.innerHTML = '';

        // Update editor title bar with glyph name
        this.updateEditorTitleBar();

        // Don't show properties if not in glyph edit mode
        if (!this.isGlyphEditMode) {
            return;
        }

        if (this.selectedGlyphIndex >= 0 && this.selectedGlyphIndex < this.shapedGlyphs.length) {
            // Display layers section (await to ensure data is loaded)
            await this.displayLayersList();
        } else {
            // No glyph selected
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'editor-empty-message';
            emptyMessage.textContent = 'No glyph selected';
            this.propertiesSection.appendChild(emptyMessage);
        }
    }

    updateAxesUI() {
        if (!this.axesSection) return;

        // Clear existing axes
        this.axesSection.innerHTML = '';

        const axes = this.getVariationAxes();

        if (axes.length === 0) {
            return; // No variable axes
        }

        // Add section title
        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'Variable Axes';
        this.axesSection.appendChild(title);

        // Create slider for each axis
        axes.forEach(axis => {
            const axisContainer = document.createElement('div');
            axisContainer.className = 'editor-axis-container';

            // Label row (axis name and value)
            const labelRow = document.createElement('div');
            labelRow.className = 'editor-axis-label-row';

            const axisLabel = document.createElement('span');
            axisLabel.className = 'editor-axis-name';
            axisLabel.textContent = axis.name.en || axis.tag;

            const valueLabel = document.createElement('span');
            valueLabel.className = 'editor-axis-value';
            valueLabel.textContent = axis.defaultValue.toFixed(0);
            valueLabel.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates

            labelRow.appendChild(axisLabel);
            labelRow.appendChild(valueLabel);

            // Slider
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'editor-axis-slider';
            slider.min = axis.minValue;
            slider.max = axis.maxValue;
            slider.step = 1;
            slider.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates

            // Restore previous value if it exists, otherwise use default
            const initialValue = this.variationSettings[axis.tag] !== undefined
                ? this.variationSettings[axis.tag]
                : axis.defaultValue;

            slider.value = initialValue;
            valueLabel.textContent = initialValue.toFixed(0);

            // Initialize variation setting
            this.variationSettings[axis.tag] = initialValue;

            // Enter preview mode on mousedown
            slider.addEventListener('mousedown', () => {
                if (this.isGlyphEditMode) {
                    this.isPreviewMode = true;
                    this.isSliderActive = true;
                    this.render();
                }
            });

            // Exit preview mode and restore focus on mouseup
            slider.addEventListener('mouseup', () => {
                this.isSliderActive = false;
                if (this.isGlyphEditMode) {
                    this.isPreviewMode = false;
                    this.render();
                    // Restore focus to canvas
                    setTimeout(() => this.canvas.focus(), 0);
                } else {
                    // In text editing mode, restore focus to canvas
                    setTimeout(() => this.canvas.focus(), 0);
                }
            });

            // Update on change
            slider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                valueLabel.textContent = value.toFixed(0);

                // Save current state before manual adjustment (only once per manual session)
                if (this.selectedLayerId !== null && this.previousSelectedLayerId === null) {
                    this.previousSelectedLayerId = this.selectedLayerId;
                    this.previousVariationSettings = { ...this.variationSettings };
                    this.selectedLayerId = null; // Deselect layer
                    this.updateLayerSelection(); // Update UI
                }

                this.setVariation(axis.tag, value);
            });

            axisContainer.appendChild(labelRow);
            axisContainer.appendChild(slider);
            this.axesSection.appendChild(axisContainer);
        });

        console.log(`Created ${axes.length} variable axis sliders`);

        // Global mouseup handler to exit preview mode if slider was active
        // This catches cases where mouse is released outside the slider element
        document.addEventListener('mouseup', () => {
            if (this.isSliderActive) {
                this.isSliderActive = false;
                if (this.isGlyphEditMode && this.isPreviewMode) {
                    this.isPreviewMode = false;
                    this.render();
                }
            }
        });
    }

    async getDiscretionaryFeatures() {
        // Get discretionary features from the compiled font
        if (!this.opentypeFont || !this.opentypeFont.tables.gsub) {
            return [];
        }

        const gsub = this.opentypeFont.tables.gsub;
        if (!gsub.features) return [];

        // Get feature info from Python
        let featureInfo = null;
        try {
            const pyResult = await window.pyodide.runPythonAsync(`GetOpentypeFeatureInfo()`);
            featureInfo = pyResult.toJs();
        } catch (error) {
            console.error('Error getting feature info from Python:', error);
            return [];
        }

        const defaultOnFeatures = new Set(featureInfo.get('default_on'));
        const defaultOffFeatures = new Set(featureInfo.get('default_off'));
        const allDiscretionary = new Set([...defaultOnFeatures, ...defaultOffFeatures]);
        const descriptions = featureInfo.get('descriptions');

        // Get features present in the font (deduplicate using Set)
        const fontFeatures = [...new Set(gsub.features.map(f => f.tag))];
        const discretionaryInFont = fontFeatures.filter(tag => allDiscretionary.has(tag));

        // Build feature list with metadata
        return discretionaryInFont.map(tag => ({
            tag: tag,
            defaultOn: defaultOnFeatures.has(tag),
            description: descriptions.get(tag) || tag
        }));
    }

    async updateFeaturesUI() {
        if (!this.featuresSection) return;

        // Clear existing features
        this.featuresSection.innerHTML = '';

        const features = await this.getDiscretionaryFeatures();

        if (features.length === 0) {
            return; // No discretionary features
        }

        // Add section header with reset button
        const headerRow = document.createElement('div');
        headerRow.className = 'editor-section-header';
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        headerRow.style.marginBottom = '8px';

        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'OpenType Features';
        title.style.margin = '0';

        const resetButton = document.createElement('button');
        resetButton.className = 'feature-reset-button';
        resetButton.textContent = 'Reset';
        resetButton.style.fontSize = '11px';
        resetButton.style.padding = '2px 8px';
        resetButton.style.cursor = 'pointer';
        resetButton.style.opacity = '0.5';
        resetButton.style.pointerEvents = 'none';
        resetButton.disabled = true;

        resetButton.addEventListener('click', () => {
            this.resetFeaturesToDefaults();
        });

        headerRow.appendChild(title);
        headerRow.appendChild(resetButton);
        this.featuresSection.appendChild(headerRow);

        // Store reset button reference
        this.featureResetButton = resetButton;

        // Initialize default states and current states
        features.forEach(feature => {
            this.defaultFeatureSettings[feature.tag] = feature.defaultOn;
            if (this.featureSettings[feature.tag] === undefined) {
                this.featureSettings[feature.tag] = feature.defaultOn;
            }
        });

        // Create button for each feature (no separate scrollable container)
        features.forEach(feature => {
            const featureRow = document.createElement('div');
            featureRow.className = 'editor-feature-row';
            featureRow.style.display = 'flex';
            featureRow.style.alignItems = 'center';
            featureRow.style.gap = '8px';
            featureRow.style.fontSize = '12px';
            featureRow.style.padding = '2px 0';

            const tagButton = document.createElement('button');
            tagButton.className = 'editor-feature-tag-button';
            tagButton.setAttribute('data-feature-tag', feature.tag);
            tagButton.textContent = feature.tag;

            // Set initial state
            const isEnabled = this.featureSettings[feature.tag];
            tagButton.classList.toggle('enabled', isEnabled);

            tagButton.addEventListener('click', () => {
                this.featureSettings[feature.tag] = !this.featureSettings[feature.tag];
                tagButton.classList.toggle('enabled', this.featureSettings[feature.tag]);
                this.updateFeatureResetButton();
                this.shapeText(); // Re-shape text with new features
            });

            const descSpan = document.createElement('span');
            descSpan.className = 'editor-feature-description';
            descSpan.style.opacity = '0.7';
            descSpan.style.fontSize = '11px';
            descSpan.style.flex = '1';
            // Extract just the feature name (before the dash)
            const shortDesc = feature.description.split(' - ')[0];
            descSpan.textContent = shortDesc;

            featureRow.appendChild(tagButton);
            featureRow.appendChild(descSpan);
            this.featuresSection.appendChild(featureRow);
        });

        this.updateFeatureResetButton();

        console.log(`Created ${features.length} feature buttons`);
    }

    updateFeatureResetButton() {
        if (!this.featureResetButton) return;

        // Check if any feature is not in default state
        const isNonDefault = Object.keys(this.featureSettings).some(tag => {
            return this.featureSettings[tag] !== this.defaultFeatureSettings[tag];
        });

        if (isNonDefault) {
            this.featureResetButton.style.opacity = '1';
            this.featureResetButton.style.pointerEvents = 'auto';
            this.featureResetButton.disabled = false;
        } else {
            this.featureResetButton.style.opacity = '0.5';
            this.featureResetButton.style.pointerEvents = 'none';
            this.featureResetButton.disabled = true;
        }
    }

    resetFeaturesToDefaults() {
        // Reset all features to their default states
        Object.keys(this.defaultFeatureSettings).forEach(tag => {
            this.featureSettings[tag] = this.defaultFeatureSettings[tag];
        });

        // Update buttons
        if (this.featuresSection) {
            const buttons = this.featuresSection.querySelectorAll('button[data-feature-tag]');
            buttons.forEach(button => {
                const tag = button.getAttribute('data-feature-tag');
                const isEnabled = this.defaultFeatureSettings[tag];
                button.classList.toggle('enabled', isEnabled);
            });
        }

        this.updateFeatureResetButton();
        this.shapeText(); // Re-shape text with default features
    }

    getHarfBuzzFeatures() {
        // Build HarfBuzz feature string from feature settings
        // Format: "liga=1,dlig=0,kern=1" or undefined if no features
        const featureParts = [];

        for (const [tag, enabled] of Object.entries(this.featureSettings)) {
            featureParts.push(`${tag}=${enabled ? 1 : 0}`);
        }

        // Return undefined if no features (allows HarfBuzz to use defaults)
        return featureParts.length > 0 ? featureParts.join(',') : undefined;
    }

    onTextChange() {
        // Debounce font recompilation when text changes
        if (this.textChangeDebounceTimer) {
            clearTimeout(this.textChangeDebounceTimer);
        }

        this.textChangeDebounceTimer = setTimeout(() => {
            if (window.fontManager && window.fontManager.isReady()) {
                console.log('🔄 Text changed, recompiling editing font...');
                window.fontManager.compileEditingFont(this.textBuffer, this.featureSettings)
                    .catch(error => {
                        console.error('Failed to recompile editing font:', error);
                    });
            }
        }, this.textChangeDebounceDelay);
    }

    // Helper to save text buffer and trigger recompilation
    saveTextBuffer() {
        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn('Failed to save text buffer to localStorage:', e);
        }

        // Trigger font recompilation (debounced)
        this.onTextChange();
    }

    shapeText() {
        if (!this.hb || !this.hbFont || !this.textBuffer) {
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.render();
            return;
        }

        try {
            // Apply variation settings if any
            if (Object.keys(this.variationSettings).length > 0) {
                this.hbFont.setVariations(this.variationSettings);
            }

            // Use BiDi algorithm if available, otherwise fallback to simple shaping
            if (this.bidi) {
                this.shapeTextWithBidi();
            } else {
                this.shapeTextSimple();
            }

            console.log('Shaped glyphs:', this.shapedGlyphs);
            if (this.bidiRuns.length > 0) {
                console.log('BiDi runs:', this.bidiRuns);
            }

            // Render the result
            this.render();
        } catch (error) {
            console.error('Error shaping text:', error);
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.render();
        }
    }

    shapeTextSimple() {
        // Simple shaping without BiDi support (old behavior)
        const buffer = this.hb.createBuffer();
        buffer.addText(this.textBuffer);
        buffer.guessSegmentProperties();

        // Shape the text with features
        const features = this.getHarfBuzzFeatures();
        if (features) {
            this.hb.shape(this.hbFont, buffer, features);
        } else {
            this.hb.shape(this.hbFont, buffer);
        }

        // Get glyph information
        this.shapedGlyphs = buffer.json();
        this.bidiRuns = [];

        // Clean up
        buffer.destroy();

        // Build cluster map for cursor positioning
        this.buildClusterMap();
        this.updateCursorVisualPosition();
    }

    shapeTextWithBidi() {
        // Get embedding levels from bidi-js
        const embedLevels = this.bidi.getEmbeddingLevels(this.textBuffer);
        this.embeddingLevels = embedLevels; // Store for cursor logic
        console.log('Embedding levels:', embedLevels);

        // First, shape the text in LOGICAL order with proper direction per run
        // Split into runs by embedding level
        const runs = [];
        let currentLevel = embedLevels.levels[0];
        let runStart = 0;

        for (let i = 1; i <= this.textBuffer.length; i++) {
            if (i === this.textBuffer.length || embedLevels.levels[i] !== currentLevel) {
                const runText = this.textBuffer.substring(runStart, i);
                const direction = currentLevel % 2 === 0 ? 'ltr' : 'rtl';
                runs.push({
                    text: runText,
                    level: currentLevel,
                    direction: direction,
                    start: runStart,
                    end: i
                });
                if (i < this.textBuffer.length) {
                    currentLevel = embedLevels.levels[i];
                    runStart = i;
                }
            }
        }

        console.log('Logical runs:', runs.map(r => `${r.direction}:${r.level}:"${r.text}"`));

        // Shape each run with HarfBuzz in its logical direction
        const features = this.getHarfBuzzFeatures();
        const shapedRuns = [];
        for (const run of runs) {
            const buffer = this.hb.createBuffer();
            buffer.addText(run.text);
            buffer.setDirection(run.direction);
            buffer.guessSegmentProperties();

            if (features) {
                this.hb.shape(this.hbFont, buffer, features);
            } else {
                this.hb.shape(this.hbFont, buffer);
            }
            const glyphs = buffer.json();
            buffer.destroy();

            // Adjust cluster values to be relative to the full string, not the run
            for (const glyph of glyphs) {
                glyph.cl = (glyph.cl || 0) + run.start;
            }

            shapedRuns.push({
                ...run,
                glyphs: glyphs
            });
        }

        // Now reorder the runs using bidi-js
        const reorderedIndices = this.bidi.getReorderedIndices(this.textBuffer, embedLevels);

        // For each run, create a map from logical position to glyphs
        const logicalPosToGlyphs = new Map();
        for (const run of shapedRuns) {
            // Group glyphs by their cluster value within this run
            for (const glyph of run.glyphs) {
                const clusterPos = glyph.cl || 0;
                if (!logicalPosToGlyphs.has(clusterPos)) {
                    logicalPosToGlyphs.set(clusterPos, []);
                }
                logicalPosToGlyphs.get(clusterPos).push(glyph);
            }
        }

        // Build visual glyph order by following reordered character indices
        // Track which clusters we've already added to avoid duplicates
        const addedClusters = new Set();
        const allGlyphs = [];

        for (const charIdx of reorderedIndices) {
            // Find the cluster that contains this character position
            // by looking for glyphs with cluster values <= charIdx
            let clusterStart = charIdx;

            // Find the actual cluster start for this character
            for (const [clusterPos, glyphs] of logicalPosToGlyphs) {
                if (clusterPos <= charIdx) {
                    // Check if this cluster might contain our character
                    // by finding the next cluster position
                    let nextClusterPos = this.textBuffer.length;
                    for (const [otherPos, _] of logicalPosToGlyphs) {
                        if (otherPos > clusterPos && otherPos < nextClusterPos) {
                            nextClusterPos = otherPos;
                        }
                    }

                    if (charIdx >= clusterPos && charIdx < nextClusterPos) {
                        clusterStart = clusterPos;
                        break;
                    }
                }
            }

            // Add glyphs for this cluster if we haven't already
            if (!addedClusters.has(clusterStart) && logicalPosToGlyphs.has(clusterStart)) {
                const glyphs = logicalPosToGlyphs.get(clusterStart);
                allGlyphs.push(...glyphs);
                addedClusters.add(clusterStart);
            }
        }

        this.shapedGlyphs = allGlyphs;
        this.bidiRuns = shapedRuns;

        // Build cluster map for cursor positioning
        this.buildClusterMap();
        this.updateCursorVisualPosition();

        console.log('Final shaped glyphs:', this.shapedGlyphs.length);
    }

    render() {
        if (!this.ctx || !this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Clear canvas
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Fill background (different color based on focus state)
        // Get computed CSS variable values
        const computedStyle = getComputedStyle(document.documentElement);

        // Check if the editor view has the 'focused' class
        const editorView = document.querySelector('#view-editor');
        const isViewFocused = editorView && editorView.classList.contains('focused');

        if (isViewFocused) {
            // Active/focused background (same as .view.focused)
            this.ctx.fillStyle = computedStyle.getPropertyValue('--bg-active').trim();
        } else {
            // Inactive background (same as .view)
            this.ctx.fillStyle = computedStyle.getPropertyValue('--bg-secondary').trim();
        }
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();

        // Apply transformation
        const transform = this.getTransformMatrix();
        this.ctx.save();
        this.ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);

        // Draw coordinate system (optional, for debugging)
        this.drawCoordinateSystem();

        // Draw baseline
        this.drawBaseline();

        // Draw selection highlight
        this.drawSelection();

        // Draw shaped glyphs
        this.drawShapedGlyphs();

        // Draw outline editor (when layer is selected)
        this.drawOutlineEditor();

        // Draw cursor
        this.drawCursor();

        // Draw glyph name tooltip (still in transformed space)
        this.drawGlyphTooltip();

        this.ctx.restore();

        // Draw UI overlay (zoom level, etc.)
        this.drawUIOverlay();
    }

    drawCoordinateSystem() {
        const rect = this.canvas.getBoundingClientRect();
        const invScale = 1 / this.scale;

        this.ctx.strokeStyle = 'rgba(255, 255, 0, 0.3)';
        this.ctx.lineWidth = 1 * invScale;

        // Draw X axis
        this.ctx.beginPath();
        this.ctx.moveTo(-10000, 0);
        this.ctx.lineTo(10000, 0);
        this.ctx.stroke();

        // Draw Y axis
        this.ctx.beginPath();
        this.ctx.moveTo(0, -10000);
        this.ctx.lineTo(0, 10000);
        this.ctx.stroke();
    }

    drawBaseline() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) return;

        const invScale = 1 / this.scale;

        // Calculate total advance width
        let totalAdvance = 0;
        for (const glyph of this.shapedGlyphs) {
            totalAdvance += (glyph.ax || 0);
        }

        this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
        this.ctx.lineWidth = 1 * invScale;

        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(totalAdvance, 0);
        this.ctx.stroke();
    }

    drawShapedGlyphs() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        if (!this.hbFont) {
            return;
        }

        const invScale = 1 / this.scale;
        let xPosition = 0;

        // Clear glyph bounds for hit testing
        this.glyphBounds = [];

        // Use black on white or white on black based on theme
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        this.shapedGlyphs.forEach((glyph, glyphIndex) => {
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;
            const yAdvance = glyph.ay || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Store bounds for hit testing (approximate with advance width)
            this.glyphBounds.push({
                x: x,
                y: y,
                width: xAdvance,
                height: 1000 // Font units height approximation
            });

            // Set color based on hover, selection state, and edit mode
            const isHovered = glyphIndex === this.hoveredGlyphIndex;
            const isSelected = glyphIndex === this.selectedGlyphIndex;

            // In outline editor, render the selected glyph with very faint background color
            // so the outline editor shapes are visible on top
            if (isSelected && this.selectedLayerId && this.layerData && !this.isPreviewMode) {
                // Render with faint background color instead of skipping
                this.ctx.fillStyle = colors.GLYPH_BACKGROUND_IN_EDITOR;
            } else if (this.isGlyphEditMode && !this.isPreviewMode) {
                // Glyph edit mode (not preview): active glyph in solid color, others dimmed
                if (isSelected) {
                    this.ctx.fillStyle = colors.GLYPH_ACTIVE_IN_EDITOR;
                } else if (isHovered) {
                    // Hovered inactive glyph - darker than normal inactive
                    this.ctx.fillStyle = colors.GLYPH_HOVERED_IN_EDITOR;
                } else {
                    // Dim other glyphs
                    this.ctx.fillStyle = colors.GLYPH_INACTIVE_IN_EDITOR;
                }
            } else if (this.isGlyphEditMode && this.isPreviewMode) {
                // Preview mode: all glyphs in normal color
                this.ctx.fillStyle = colors.GLYPH_NORMAL;
            } else {
                // Text edit mode: normal coloring
                if (isHovered) {
                    this.ctx.fillStyle = colors.GLYPH_HOVERED;
                } else if (isSelected) {
                    this.ctx.fillStyle = colors.GLYPH_SELECTED;
                } else {
                    this.ctx.fillStyle = colors.GLYPH_NORMAL;
                }
            }

            // Get glyph outline from HarfBuzz (supports variations)
            const glyphData = this.hbFont.glyphToPath(glyphId);

            if (glyphData) {
                this.ctx.save();
                this.ctx.translate(x, y);

                // Draw the path from HarfBuzz data
                // No need to flip Y here - the main transform matrix already flips Y
                this.ctx.beginPath();

                // Parse the SVG path data
                const path = new Path2D(glyphData);

                this.ctx.fill(path);

                this.ctx.restore();
            }

            xPosition += xAdvance;
        });
    }

    buildPathFromNodes(nodes, pathTarget = null) {
        // Build a canvas path from a nodes array
        // pathTarget: if provided (Path2D object), draws to it; otherwise draws to this.ctx
        // Returns the startIdx for use in drawing direction arrows
        if (!nodes || nodes.length === 0) {
            return -1;
        }

        // Use the provided path target or default to canvas context
        const target = pathTarget || this.ctx;

        // Find first on-curve point to start
        let startIdx = 0;
        for (let i = 0; i < nodes.length; i++) {
            const [, , type] = nodes[i];
            if (type === 'c' || type === 'cs' || type === 'l' || type === 'ls') {
                startIdx = i;
                break;
            }
        }

        const [startX, startY] = nodes[startIdx];
        target.moveTo(startX, startY);

        // Draw contour by looking ahead for control points
        let i = 0;
        while (i < nodes.length) {
            const idx = (startIdx + i) % nodes.length;
            const nextIdx = (startIdx + i + 1) % nodes.length;
            const next2Idx = (startIdx + i + 2) % nodes.length;
            const next3Idx = (startIdx + i + 3) % nodes.length;

            const [, , type] = nodes[idx];
            const [next1X, next1Y, next1Type] = nodes[nextIdx];

            if (type === 'l' || type === 'ls' || type === 'c' || type === 'cs') {
                // We're at an on-curve point, look ahead for next segment
                if (next1Type === 'o' || next1Type === 'os') {
                    // Next is off-curve - check if cubic (two consecutive off-curve)
                    const [next2X, next2Y, next2Type] = nodes[next2Idx];
                    const [next3X, next3Y] = nodes[next3Idx];

                    if (next2Type === 'o' || next2Type === 'os') {
                        // Cubic bezier: two off-curve control points + on-curve endpoint
                        target.bezierCurveTo(next1X, next1Y, next2X, next2Y, next3X, next3Y);
                        i += 3; // Skip the two control points and endpoint
                    } else {
                        // Single off-curve - shouldn't happen with cubic, just draw line
                        target.lineTo(next2X, next2Y);
                        i += 2;
                    }
                } else if (next1Type === 'l' || next1Type === 'ls' || next1Type === 'c' || next1Type === 'cs') {
                    // Next is on-curve - draw line
                    target.lineTo(next1X, next1Y);
                    i++;
                } else {
                    // Skip quadratic
                    i++;
                }
            } else {
                // Skip off-curve or quadratic points (should be handled by looking ahead)
                i++;
            }
        }

        return startIdx;
    }

    drawGlyphTooltip() {
        // Draw glyph name tooltip on hover (in font coordinate space)
        // Don't show tooltip for the selected glyph in glyph edit mode
        if (this.hoveredGlyphIndex >= 0 && this.hoveredGlyphIndex < this.shapedGlyphs.length) {
            // Skip tooltip for selected glyph in glyph edit mode
            if (this.isGlyphEditMode && this.hoveredGlyphIndex === this.selectedGlyphIndex) {
                return;
            }

            const glyphId = this.shapedGlyphs[this.hoveredGlyphIndex].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from compiled font via OpenType.js
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
            }

            // Get glyph position and advance from shaped data
            const shapedGlyph = this.shapedGlyphs[this.hoveredGlyphIndex];
            const glyphBounds = this.glyphBounds[this.hoveredGlyphIndex];
            const glyphWidth = shapedGlyph.ax || 0;
            const glyphYOffset = shapedGlyph.dy || 0; // Y offset from HarfBuzz shaping

            // Get glyph bounding box to find bottom edge
            let glyphYMin = 0;
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                const bbox = glyph.getBoundingBox();
                glyphYMin = bbox.y1; // y1 is the minimum Y (bottom edge)
            }

            // Position tooltip centered under the glyph
            // In font coordinates: Y increases upward, so negative Y is below baseline
            // Note: glyphBounds.x already includes dx offset from HarfBuzz
            const tooltipX = glyphBounds.x + (glyphWidth / 2);
            const tooltipY = glyphYOffset + glyphYMin - 100; // 100 units below bottom of bounding box, including HB Y offset

            const invScale = 1 / this.scale;
            const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';

            // Save context to flip text right-side up
            this.ctx.save();
            this.ctx.translate(tooltipX, tooltipY);
            this.ctx.scale(1, -1); // Flip Y to make text right-side up

            // Font size and metrics (scaled to remain constant regardless of zoom)
            const fontSize = 16 * invScale;
            this.ctx.font = `${fontSize}px IBM Plex Mono`;
            const metrics = this.ctx.measureText(glyphName);
            const padding = 10 * invScale;
            const bgWidth = metrics.width + padding * 2;
            const bgHeight = fontSize * 1.8;

            // Center horizontally around origin
            const bgX = -bgWidth / 2;
            const bgY = 0; // Top of box at origin

            // Draw background
            this.ctx.fillStyle = isDarkTheme ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.95)';
            this.ctx.fillRect(bgX, bgY, bgWidth, bgHeight);

            // Draw border
            this.ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
            this.ctx.lineWidth = 2 * invScale;
            this.ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

            // Draw text
            this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.9)';
            this.ctx.fillText(glyphName, bgX + padding, bgY + fontSize * 0.85 + padding / 2 + 4);

            this.ctx.restore();
        }
    }

    drawOutlineEditor() {
        // Validate APP_SETTINGS is available
        if (typeof APP_SETTINGS === 'undefined' || !APP_SETTINGS.OUTLINE_EDITOR) {
            console.error('APP_SETTINGS not available in drawOutlineEditor!');
            return;
        }

        // Draw outline editor when a layer is selected (skip in preview mode)
        if (!this.selectedLayerId || !this.layerData || !this.layerData.shapes || this.isPreviewMode) {
            return;
        }

        // Get the position of the selected glyph
        if (this.selectedGlyphIndex < 0 || this.selectedGlyphIndex >= this.shapedGlyphs.length) {
            return;
        }

        let xPosition = 0;
        for (let i = 0; i < this.selectedGlyphIndex; i++) {
            xPosition += (this.shapedGlyphs[i].ax || 0);
        }

        const glyph = this.shapedGlyphs[this.selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const x = xPosition + xOffset;
        const y = yOffset;

        this.ctx.save();
        this.ctx.translate(x, y);

        // Apply accumulated component transform if editing a component
        // This positions the editor at the component's location in the parent
        if (this.componentStack.length > 0) {
            const transform = this.getAccumulatedTransform();
            console.log(`drawOutlineEditor: componentStack.length=${this.componentStack.length}, accumulated transform=[${transform}]`);
            this.ctx.transform(transform[0], transform[1], transform[2], transform[3], transform[4], transform[5]);
        }

        const invScale = 1 / this.scale;
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';

        // Draw parent glyph outlines in background if editing a component
        if (this.componentStack.length > 0) {
            this.ctx.save();

            // Apply inverse transform to draw parent in original (untransformed) position
            const compTransform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = compTransform;
            const det = a * d - b * c;

            if (Math.abs(det) > 0.0001) {
                // Apply inverse transform to cancel out component transform
                const invA = d / det;
                const invB = -b / det;
                const invC = -c / det;
                const invD = a / det;
                const invTx = (c * ty - d * tx) / det;
                const invTy = (b * tx - a * ty) / det;
                this.ctx.transform(invA, invB, invC, invD, invTx, invTy);
            }

            // Draw the compiled HarfBuzz outline of the parent glyph
            const glyphIndex = this.selectedGlyphIndex;
            if (glyphIndex >= 0 && glyphIndex < this.shapedGlyphs.length && this.hbFont) {
                const shapedGlyph = this.shapedGlyphs[glyphIndex];
                const glyphId = shapedGlyph.g;

                try {
                    // Get glyph outline from HarfBuzz
                    const glyphData = this.hbFont.glyphToPath(glyphId);

                    if (glyphData) {
                        this.ctx.beginPath();
                        const path = new Path2D(glyphData);
                        this.ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
                        this.ctx.lineWidth = 1 * invScale;
                        this.ctx.stroke(path);
                    }
                } catch (error) {
                    console.error('Failed to draw parent glyph:', error);
                }
            }

            this.ctx.restore(); // Restore to component-transformed state
        }

        // Draw 1-unit grid at high zoom levels
        if (this.scale >= APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_GRID) {
            // Get glyph bounds from layer data (if available)
            let minX = -100, maxX = 700, minY = -200, maxY = 1000; // Default bounds

            if (this.layerData && this.layerData.shapes) {
                // Calculate bounds from all contours
                this.layerData.shapes.forEach(shape => {
                    if (shape.nodes && shape.nodes.length > 0) {
                        shape.nodes.forEach(([x, y]) => {
                            minX = Math.min(minX, x);
                            maxX = Math.max(maxX, x);
                            minY = Math.min(minY, y);
                            maxY = Math.max(maxY, y);
                        });
                    }
                });
                // Add padding
                minX = Math.floor(minX - 50);
                maxX = Math.ceil(maxX + 50);
                minY = Math.floor(minY - 50);
                maxY = Math.ceil(maxY + 50);
            }

            // Draw vertical lines (every 1 unit)
            const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
            this.ctx.strokeStyle = colors.GRID;
            this.ctx.lineWidth = 1 * invScale;
            this.ctx.beginPath();
            for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
                this.ctx.moveTo(x, minY);
                this.ctx.lineTo(x, maxY);
            }

            // Draw horizontal lines (every 1 unit)
            for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
                this.ctx.moveTo(minX, y);
                this.ctx.lineTo(maxX, y);
            }
            this.ctx.stroke();
        }

        // Draw each shape (contour or component)
        console.log('Drawing shapes. Component stack depth:', this.componentStack.length, 'layerData.shapes.length:', this.layerData?.shapes?.length);
        this.layerData.shapes.forEach((shape, contourIndex) => {
            console.log('Drawing shape', contourIndex, ':', shape.Component ? 'Component' : 'Path', shape.Component ? `ref=${shape.Component.reference}` : `nodes=${shape.nodes?.length || 0}`);
            if (shape.ref) {
                // Component - will be drawn separately as markers
                return;
            }

            // Handle Path object from to_dict() - nodes might be in shape.Path.nodes
            let nodes = shape.nodes;
            if (!nodes && shape.Path && shape.Path.nodes) {
                // Nodes are in a string format from to_dict() - parse them
                const nodesString = shape.Path.nodes;

                // Parse string format: "x y type x y type ..."
                const parts = nodesString.trim().split(/\s+/);
                nodes = [];
                for (let i = 0; i < parts.length; i += 3) {
                    if (i + 2 < parts.length) {
                        const x = parseFloat(parts[i]);
                        const y = parseFloat(parts[i + 1]);
                        const type = parts[i + 2];
                        nodes.push([x, y, type]);
                    }
                }

                // Cache parsed nodes back to shape for reuse
                shape.nodes = nodes;
            }

            if (!nodes || nodes.length === 0) {
                return;
            }

            // Draw the outline path
            this.ctx.beginPath();
            this.ctx.strokeStyle = isDarkTheme ? '#ffffff' : '#000000';
            this.ctx.lineWidth = APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_STROKE_WIDTH * invScale;

            // Build the path using the helper method
            const startIdx = this.buildPathFromNodes(nodes);

            this.ctx.closePath();
            this.ctx.stroke();

            // Skip drawing direction arrow and handles if zoom is under minimum threshold
            const minZoomForHandles = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
            if (this.scale >= minZoomForHandles) {
                // Draw direction arrow from the first node
                if (nodes.length > 1) {
                    const [firstX, firstY] = nodes[startIdx];
                    const nextIdx = (startIdx + 1) % nodes.length;
                    const [nextX, nextY] = nodes[nextIdx];

                    // Calculate direction vector from first node to next
                    const dx = nextX - firstX;
                    const dy = nextY - firstY;
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance > 0) {
                        // Normalize direction
                        const ndx = dx / distance;
                        const ndy = dy / distance;

                        // Calculate arrow size based on node size (same scaling as nodes, but slightly bigger)
                        const nodeSizeMax = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MAX_ZOOM;
                        const nodeSizeMin = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MIN_ZOOM;
                        const nodeInterpolationMin = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MIN;
                        const nodeInterpolationMax = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MAX;

                        let baseSize;
                        if (this.scale >= nodeInterpolationMax) {
                            baseSize = nodeSizeMax * invScale;
                        } else {
                            const zoomFactor = (this.scale - nodeInterpolationMin) /
                                (nodeInterpolationMax - nodeInterpolationMin);
                            baseSize = (nodeSizeMin + (nodeSizeMax - nodeSizeMin) * zoomFactor) * invScale;
                        }

                        // Arrow is slightly bigger than nodes
                        const arrowLength = baseSize * 4.5;
                        const arrowWidth = baseSize * 2.5;

                        // Arrow tip position starts at the first node and extends outward
                        const tipX = firstX + ndx * arrowLength;
                        const tipY = firstY + ndy * arrowLength;

                        // Arrow base is at the first node
                        const baseX = firstX;
                        const baseY = firstY;

                        // Arrow wings (perpendicular offsets)
                        const perpX = -ndy * arrowWidth;
                        const perpY = ndx * arrowWidth;

                        // Draw arrow
                        this.ctx.beginPath();
                        this.ctx.moveTo(tipX, tipY);
                        this.ctx.lineTo(baseX + perpX, baseY + perpY);
                        this.ctx.lineTo(baseX - perpX, baseY - perpY);
                        this.ctx.closePath();

                        this.ctx.fillStyle = isDarkTheme ? 'rgba(0, 255, 255, 0.8)' : 'rgba(0, 150, 150, 0.8)';
                        this.ctx.fill();
                        this.ctx.strokeStyle = isDarkTheme ? 'rgba(0, 255, 255, 1)' : 'rgba(0, 100, 100, 1)';
                        this.ctx.lineWidth = 1 * invScale;
                        this.ctx.stroke();
                    }
                }

                // Draw control point handle lines (from off-curve to adjacent on-curve points)
                this.ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)';
                this.ctx.lineWidth = 1 * invScale;

                nodes.forEach((node, nodeIndex) => {
                    const [x, y, type] = node;

                    // Only draw lines from off-curve points
                    if (type === 'o' || type === 'os') {
                        // Check if this is the first or second control point in a cubic bezier pair
                        let prevIdx = nodeIndex - 1;
                        if (prevIdx < 0) prevIdx = nodes.length - 1;
                        const [, , prevType] = nodes[prevIdx];

                        let nextIdx = nodeIndex + 1;
                        if (nextIdx >= nodes.length) nextIdx = 0;
                        const [, , nextType] = nodes[nextIdx];

                        const isPrevOffCurve = prevType === 'o' || prevType === 'os';
                        const isNextOffCurve = nextType === 'o' || nextType === 'os';

                        if (isPrevOffCurve) {
                            // This is the second control point - connect to NEXT on-curve point
                            let targetIdx = nextIdx;
                            // Skip the other off-curve point if needed
                            if (isNextOffCurve) {
                                targetIdx++;
                                if (targetIdx >= nodes.length) targetIdx = 0;
                            }

                            const [targetX, targetY, targetType] = nodes[targetIdx];
                            if (targetType === 'c' || targetType === 'cs' || targetType === 'l' || targetType === 'ls') {
                                this.ctx.beginPath();
                                this.ctx.moveTo(x, y);
                                this.ctx.lineTo(targetX, targetY);
                                this.ctx.stroke();
                            }
                        } else {
                            // This is the first control point - connect to PREVIOUS on-curve point
                            let targetIdx = prevIdx;

                            const [targetX, targetY, targetType] = nodes[targetIdx];
                            if (targetType === 'c' || targetType === 'cs' || targetType === 'l' || targetType === 'ls') {
                                this.ctx.beginPath();
                                this.ctx.moveTo(x, y);
                                this.ctx.lineTo(targetX, targetY);
                                this.ctx.stroke();
                            }
                        }
                    }
                });
            }

            // Draw nodes (points)
            // Nodes are drawn at the same zoom threshold as handles
            if (this.scale < minZoomForHandles) {
                return;
            }

            shape.nodes.forEach((node, nodeIndex) => {
                const [x, y, type] = node;
                const isHovered = this.hoveredPointIndex &&
                    this.hoveredPointIndex.contourIndex === contourIndex &&
                    this.hoveredPointIndex.nodeIndex === nodeIndex;
                const isSelected = this.selectedPoints.some(p =>
                    p.contourIndex === contourIndex && p.nodeIndex === nodeIndex
                );

                // Skip quadratic bezier points for now
                if (type === 'q' || type === 'qs') {
                    return;
                }

                // Calculate point size based on zoom level
                const nodeSizeMax = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MAX_ZOOM;
                const nodeSizeMin = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MIN_ZOOM;
                const nodeInterpolationMin = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MIN;
                const nodeInterpolationMax = APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MAX;

                let pointSize;
                if (this.scale >= nodeInterpolationMax) {
                    pointSize = nodeSizeMax * invScale;
                } else {
                    // Interpolate between min and max size
                    const zoomFactor = (this.scale - nodeInterpolationMin) /
                        (nodeInterpolationMax - nodeInterpolationMin);
                    pointSize = (nodeSizeMin + (nodeSizeMax - nodeSizeMin) * zoomFactor) * invScale;
                } if (type === 'o' || type === 'os') {
                    // Off-curve point (cubic bezier control point) - draw as circle
                    const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, pointSize, 0, Math.PI * 2);
                    this.ctx.fillStyle = isSelected ? colors.CONTROL_POINT_SELECTED : (isHovered ? colors.CONTROL_POINT_HOVERED : colors.CONTROL_POINT_NORMAL);
                    this.ctx.fill();
                    this.ctx.strokeStyle = colors.CONTROL_POINT_STROKE;
                    this.ctx.lineWidth = 1 * invScale;
                    this.ctx.stroke();
                } else {
                    // On-curve point - draw as square
                    const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    this.ctx.fillStyle = isSelected ? colors.NODE_SELECTED : (isHovered ? colors.NODE_HOVERED : colors.NODE_NORMAL);
                    this.ctx.fillRect(x - pointSize, y - pointSize, pointSize * 2, pointSize * 2);
                    this.ctx.strokeStyle = colors.NODE_STROKE;
                    this.ctx.lineWidth = 1 * invScale;
                    this.ctx.strokeRect(x - pointSize, y - pointSize, pointSize * 2, pointSize * 2);
                }

                // Draw smooth indicator for smooth nodes
                if (type === 'cs' || type === 'os' || type === 'ls') {
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, pointSize * 0.4, 0, Math.PI * 2);
                    this.ctx.fillStyle = isDarkTheme ? '#ffffff' : '#000000';
                    this.ctx.fill();
                }
            });
        });

        // Draw components
        this.layerData.shapes.forEach((shape, index) => {
            if (!shape.Component) {
                return; // Not a component
            }

            console.log(`Component ${index}: reference="${shape.Component.reference}", has layerData=${!!shape.Component.layerData}, shapes=${shape.Component.layerData?.shapes?.length || 0}`);

            const isHovered = this.hoveredComponentIndex === index;
            const isSelected = this.selectedComponents.includes(index);

            // Get full transform matrix [a, b, c, d, tx, ty]
            let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
            if (shape.Component.transform && Array.isArray(shape.Component.transform)) {
                a = shape.Component.transform[0] || 1;
                b = shape.Component.transform[1] || 0;
                c = shape.Component.transform[2] || 0;
                d = shape.Component.transform[3] || 1;
                tx = shape.Component.transform[4] || 0;
                ty = shape.Component.transform[5] || 0;
            }

            this.ctx.save();

            // Apply component transform
            this.ctx.transform(a, b, c, d, tx, ty);

            // Draw the component's outline shapes if they were fetched
            if (shape.Component.layerData && shape.Component.layerData.shapes) {
                // Recursively render all shapes in the component (including nested components)
                const renderComponentShapes = (shapes, transform = [1, 0, 0, 1, 0, 0]) => {
                    shapes.forEach(componentShape => {
                        // Handle nested components
                        if (componentShape.Component) {
                            // Save context for nested component transform
                            this.ctx.save();

                            // Apply nested component's transform
                            if (componentShape.Component.transform && Array.isArray(componentShape.Component.transform)) {
                                const t = componentShape.Component.transform;
                                this.ctx.transform(t[0] || 1, t[1] || 0, t[2] || 0, t[3] || 1, t[4] || 0, t[5] || 0);
                            }

                            // Recursively render nested component's shapes
                            if (componentShape.Component.layerData && componentShape.Component.layerData.shapes) {
                                renderComponentShapes(componentShape.Component.layerData.shapes);
                            }

                            this.ctx.restore();
                            return;
                        }

                        // Handle outline shapes (with nodes)
                        if (componentShape.nodes && componentShape.nodes.length > 0) {
                            this.ctx.beginPath();

                            // Build the path using the helper method
                            this.buildPathFromNodes(componentShape.nodes);

                            this.ctx.closePath();

                            // Fill with semi-transparent color
                            const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                            this.ctx.fillStyle = isSelected ? colors.COMPONENT_FILL_SELECTED : (isHovered ? colors.COMPONENT_FILL_HOVERED : colors.COMPONENT_FILL_NORMAL);
                            this.ctx.fill();

                            // Stroke the outline
                            this.ctx.strokeStyle = isSelected ? colors.COMPONENT_SELECTED : (isHovered ? colors.COMPONENT_HOVERED : colors.COMPONENT_NORMAL);
                            this.ctx.lineWidth = 1 * invScale;
                            this.ctx.stroke();
                        }
                    });
                };

                // Start recursive rendering
                renderComponentShapes(shape.Component.layerData.shapes);
            }

            // Draw component reference marker at origin
            // Skip drawing markers if zoom is under minimum threshold
            const minZoomForHandles = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
            if (this.scale < minZoomForHandles) {
                this.ctx.restore();
                return;
            }

            const markerSize = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_MARKER_SIZE * invScale;            // Draw cross marker
            const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
            this.ctx.strokeStyle = isSelected ? colors.COMPONENT_SELECTED : (isHovered ? colors.COMPONENT_HOVERED : colors.COMPONENT_NORMAL);
            this.ctx.lineWidth = 2 * invScale;
            this.ctx.beginPath();
            this.ctx.moveTo(-markerSize, 0);
            this.ctx.lineTo(markerSize, 0);
            this.ctx.moveTo(0, -markerSize);
            this.ctx.lineTo(0, markerSize);
            this.ctx.stroke();

            // Draw circle around cross
            this.ctx.beginPath();
            this.ctx.arc(0, 0, markerSize, 0, Math.PI * 2);
            this.ctx.stroke();

            // Draw component reference name
            const fontSize = 12 * invScale;
            this.ctx.save();
            this.ctx.scale(1, -1); // Flip Y axis
            this.ctx.font = `${fontSize}px monospace`;
            this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.8)';
            this.ctx.fillText(shape.Component.reference || 'component', markerSize * 1.5, markerSize);
            this.ctx.restore();

            this.ctx.restore();
        });

        // Draw anchors
        // Skip drawing anchors if zoom is under minimum threshold
        const minZoomForHandles = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
        const minZoomForLabels = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_ANCHOR_LABELS;

        if (this.scale >= minZoomForHandles && this.layerData.anchors && this.layerData.anchors.length > 0) {
            // Calculate anchor size based on zoom level
            const anchorSizeMax = APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MAX_ZOOM;
            const anchorSizeMin = APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MIN_ZOOM;
            const anchorInterpolationMin = APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MIN;
            const anchorInterpolationMax = APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MAX;

            let anchorSize;
            if (this.scale >= anchorInterpolationMax) {
                anchorSize = anchorSizeMax * invScale;
            } else {
                // Interpolate between min and max size
                const zoomFactor = (this.scale - anchorInterpolationMin) /
                    (anchorInterpolationMax - anchorInterpolationMin);
                anchorSize = (anchorSizeMin + (anchorSizeMax - anchorSizeMin) * zoomFactor) * invScale;
            } const fontSize = 12 * invScale;

            this.layerData.anchors.forEach((anchor, index) => {
                const { x, y, name } = anchor;
                const isHovered = this.hoveredAnchorIndex === index;
                const isSelected = this.selectedAnchors.includes(index);

                // Draw anchor as diamond
                this.ctx.save();
                this.ctx.translate(x, y);
                this.ctx.rotate(Math.PI / 4); // Rotate 45 degrees to make diamond

                const colors = isDarkTheme ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                this.ctx.fillStyle = isSelected ? colors.ANCHOR_SELECTED : (isHovered ? colors.ANCHOR_HOVERED : colors.ANCHOR_NORMAL);
                this.ctx.fillRect(-anchorSize, -anchorSize, anchorSize * 2, anchorSize * 2);
                this.ctx.strokeStyle = colors.ANCHOR_STROKE;
                this.ctx.lineWidth = 1 * invScale;
                this.ctx.strokeRect(-anchorSize, -anchorSize, anchorSize * 2, anchorSize * 2);

                this.ctx.restore();

                // Draw anchor name only above minimum zoom threshold
                if (name && this.scale > minZoomForLabels) {
                    this.ctx.save();
                    this.ctx.translate(x, y);
                    this.ctx.scale(1, -1); // Flip Y axis to fix upside-down text
                    this.ctx.font = `${fontSize}px monospace`;
                    this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.8)';
                    this.ctx.fillText(name, anchorSize * 1.5, anchorSize);
                    this.ctx.restore();
                }
            });
        }

        this.ctx.restore();
    }

    drawUIOverlay() {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);

        const rect = this.canvas.getBoundingClientRect();

        // Use contrasting color based on theme
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.7)';
        this.ctx.font = '12px monospace';

        // Draw zoom level
        const zoomText = `Zoom: ${(this.scale * 100).toFixed(1)}%`;
        this.ctx.fillText(zoomText, 10, rect.height - 10);

        // Draw pan position
        const panText = `Pan: (${Math.round(this.panX)}, ${Math.round(this.panY)})`;
        this.ctx.fillText(panText, 10, rect.height - 25);

        // Draw text buffer info
        if (this.textBuffer) {
            const textInfo = `Text: "${this.textBuffer}" (${this.shapedGlyphs.length} glyphs)`;
            this.ctx.fillText(textInfo, 10, 20);
        }

        this.ctx.restore();
    }

    destroy() {
        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Clean up HarfBuzz resources
        if (this.hbFont) {
            this.hbFont.destroy();
            this.hbFont = null;
        }
        if (this.hbFace) {
            this.hbFace.destroy();
            this.hbFace = null;
        }
        if (this.hbBlob) {
            this.hbBlob.destroy();
            this.hbBlob = null;
        }

        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    // ==================== Cursor Methods ====================

    onFocus() {
        this.isFocused = true;
        this.cursorVisible = true;
        this.render();
    }

    onBlur() {
        this.isFocused = false;
        this.render();
    }

    onKeyUp(e) {
        // Handle space bar release to exit preview mode
        if (e.code === 'Space' && this.isGlyphEditMode) {
            this.isPreviewMode = false;
            this.render();
        }
    }

    onKeyDown(e) {
        // Handle space bar press to enter preview mode
        if (e.code === 'Space' && this.isGlyphEditMode) {
            e.preventDefault();
            this.isPreviewMode = true;
            this.render();
            return;
        }

        // Handle Cmd+Enter to enter glyph edit mode at cursor position (text editing mode only)
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.isGlyphEditMode) {
            e.preventDefault();
            this.enterGlyphEditModeAtCursor();
            return;
        }

        // Handle cursor navigation and text editing
        // Note: Escape key is handled globally in constructor for better focus handling

        // Handle Cmd+Up/Down to cycle through layers when outline editor is active
        if ((e.metaKey || e.ctrlKey) && this.isGlyphEditMode && this.selectedLayerId && this.fontData && this.fontData.layers) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.cycleLayers(e.key === 'ArrowUp');
                return;
            }
        }

        // Handle Cmd+Left/Right to navigate through glyphs in logical order
        // Only when in glyph edit mode but NOT in nested component mode
        if ((e.metaKey || e.ctrlKey) && this.isGlyphEditMode && this.componentStack.length === 0) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.navigateToPreviousGlyphLogical();
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.navigateToNextGlyphLogical();
                return;
            }
        }

        // Handle arrow keys for point/anchor/component movement in glyph edit mode
        if (this.isGlyphEditMode && this.selectedLayerId && (this.selectedPoints.length > 0 || this.selectedAnchors.length > 0 || this.selectedComponents.length > 0)) {
            const multiplier = e.shiftKey ? 10 : 1;
            let moved = false;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(-multiplier, 0);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(-multiplier, 0);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(-multiplier, 0);
                }
                moved = true;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(multiplier, 0);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(multiplier, 0);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(multiplier, 0);
                }
                moved = true;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(0, multiplier);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(0, multiplier);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(0, multiplier);
                }
                moved = true;
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(0, -multiplier);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(0, -multiplier);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(0, -multiplier);
                }
                moved = true;
            }

            if (moved) {
                return;
            }
        }

        // Prevent all other text editing and cursor movement in glyph edit mode
        if (this.isGlyphEditMode) {
            e.preventDefault();
            return;
        }

        // Cmd+0 / Ctrl+0 - Reset zoom and position
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault();
            this.resetZoomAndPosition();
            return;
        }

        // Cmd+A / Ctrl+A - Select All
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            this.selectAll();
            return;
        }

        // Cmd+C / Ctrl+C - Copy
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            e.preventDefault();
            this.copySelection();
            return;
        }

        // Cmd+X / Ctrl+X - Cut
        if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
            e.preventDefault();
            this.cutSelection();
            return;
        }

        // Cmd+V / Ctrl+V - Paste
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
            e.preventDefault();
            this.paste();
            return;
        }

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorLeftWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorLeft();
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorRightWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorRight();
            }
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            this.deleteBackward();
        } else if (e.key === 'Delete') {
            e.preventDefault();
            this.deleteForward();
        } else if (e.key === 'Home') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveToStartWithSelection();
            } else {
                this.clearSelection();
                this.cursorPosition = 0;
                this.updateCursorVisualPosition();
                this.panToCursor();
                this.render();
            }
        } else if (e.key === 'End') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveToEndWithSelection();
            } else {
                this.clearSelection();
                this.cursorPosition = this.textBuffer.length;
                this.updateCursorVisualPosition();
                this.panToCursor();
                this.render();
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            // Regular character input
            e.preventDefault();
            this.insertText(e.key);
        }
    }

    moveCursorLeft() {
        console.log('=== Move Cursor Left ===');
        this.logCursorState();

        // Left arrow = backward in logical order (decrease position)
        this.moveCursorLogicalBackward();
        this.panToCursor();
        this.render();
    }

    moveCursorRight() {
        console.log('=== Move Cursor Right ===');
        this.logCursorState();

        // Right arrow = forward in logical order (increase position)
        this.moveCursorLogicalForward();
        this.panToCursor();
        this.render();
    }

    moveCursorLogicalBackward() {
        if (this.cursorPosition > 0) {
            this.cursorPosition--;
            console.log('Moved to logical position:', this.cursorPosition);
            this.updateCursorVisualPosition();
        }
    }

    moveCursorLogicalForward() {
        if (this.cursorPosition < this.textBuffer.length) {
            this.cursorPosition++;
            console.log('Moved to logical position:', this.cursorPosition);
            this.updateCursorVisualPosition();
        }
    }

    isPositionRTL(pos) {
        // Check if a logical position is in an RTL context
        if (!this.embeddingLevels || !this.embeddingLevels.levels) {
            return false;
        }

        if (pos < 0 || pos >= this.embeddingLevels.levels.length) {
            return false;
        }

        // Odd levels are RTL
        return this.embeddingLevels.levels[pos] % 2 === 1;
    }

    isGlyphFromTypedCharacter(glyphIndex) {
        // Determine if a glyph corresponds to a typed character or is a result of shaping
        // Returns: { isTyped: boolean, logicalPosition: number }

        if (glyphIndex < 0 || glyphIndex >= this.shapedGlyphs.length) {
            return { isTyped: false, logicalPosition: -1 };
        }

        const glyph = this.shapedGlyphs[glyphIndex];
        const clusterValue = glyph.cl || 0;

        // Check if there's a character at this cluster position in the original text buffer
        // If clusterValue points to a valid position in textBuffer, it's typed
        // If clusterValue points beyond or the glyph is additional (like a ligature component),
        // it's shaped

        // Get all glyphs in this cluster
        const glyphsInCluster = this.shapedGlyphs.filter(g => (g.cl || 0) === clusterValue);

        // Count how many characters this cluster represents
        // Find the next cluster value to determine the range
        let nextClusterValue = this.textBuffer.length;
        for (const g of this.shapedGlyphs) {
            const cl = g.cl || 0;
            if (cl > clusterValue && cl < nextClusterValue) {
                nextClusterValue = cl;
            }
        }

        const characterCount = nextClusterValue - clusterValue;
        const glyphCount = glyphsInCluster.length;

        // Find which position this glyph is within the cluster
        const positionInCluster = glyphsInCluster.findIndex(g =>
            this.shapedGlyphs.indexOf(g) === glyphIndex
        );

        console.log(`Glyph ${glyphIndex}: cluster=${clusterValue}, pos in cluster=${positionInCluster}, chars=${characterCount}, glyphs=${glyphCount}`);

        // If this glyph's position in the cluster is less than the character count,
        // it corresponds to a typed character
        const isTyped = positionInCluster < characterCount;

        // The logical position depends on direction
        // For RTL, the visual buffer order is reversed from logical order
        let logicalPosition;
        if (isTyped) {
            const isRTL = this.isPositionRTL(clusterValue);
            if (isRTL) {
                // RTL: reverse the position within the cluster
                // Visual position 0 -> logical position (clusterValue + characterCount - 1)
                // Visual position 1 -> logical position (clusterValue + characterCount - 2)
                logicalPosition = clusterValue + (characterCount - 1 - positionInCluster);
                console.log(`  RTL: visual pos ${positionInCluster} -> logical pos ${logicalPosition} (cluster ${clusterValue}, ${characterCount} chars)`);
            } else {
                // LTR: position is straightforward
                logicalPosition = clusterValue + positionInCluster;
                console.log(`  LTR: visual pos ${positionInCluster} -> logical pos ${logicalPosition}`);
            }
        } else {
            logicalPosition = clusterValue;
        }

        return { isTyped, logicalPosition };
    }

    getRunAtPosition(pos) {
        // Find which BiDi run contains this logical position
        if (!this.bidiRuns || this.bidiRuns.length === 0) {
            return null;
        }

        for (const run of this.bidiRuns) {
            if (pos >= run.start && pos < run.end) {
                console.log(`Position ${pos} is in ${run.direction} run [${run.start}-${run.end}]: "${run.text}"`);
                return run;
            }
        }

        // If at the very end, return the last run
        if (pos === this.textBuffer.length && this.bidiRuns.length > 0) {
            const lastRun = this.bidiRuns[this.bidiRuns.length - 1];
            console.log(`Position ${pos} is at end of ${lastRun.direction} run [${lastRun.start}-${lastRun.end}]: "${lastRun.text}"`);
            return lastRun;
        }

        console.log(`Position ${pos} is not in any run`);
        return null;
    }

    logCursorState() {
        console.log('=== Cursor State ===');
        console.log('Logical position:', this.cursorPosition);
        console.log('Visual X:', this.cursorX);
        console.log('Text buffer:', this.textBuffer);
        const run = this.getRunAtPosition(this.cursorPosition);
        if (run) {
            console.log('Current run:', run.direction, `[${run.start}-${run.end}]`, `"${run.text}"`);
        }
        console.log('==================');
    }

    // ==================== Selection Methods ====================

    clearSelection() {
        this.selectionStart = null;
        this.selectionEnd = null;
    }

    hasSelection() {
        return this.selectionStart !== null && this.selectionEnd !== null && this.selectionStart !== this.selectionEnd;
    }

    getSelectionRange() {
        if (!this.hasSelection()) {
            return { start: this.cursorPosition, end: this.cursorPosition };
        }
        return {
            start: Math.min(this.selectionStart, this.selectionEnd),
            end: Math.max(this.selectionStart, this.selectionEnd)
        };
    }

    selectAll() {
        this.selectionStart = 0;
        this.selectionEnd = this.textBuffer.length;
        this.cursorPosition = this.textBuffer.length;
        console.log('Selected all:', `"${this.textBuffer.slice(0, this.textBuffer.length)}"`, `[${this.selectionStart}-${this.selectionEnd}]`);
        this.updateCursorVisualPosition();
        this.panToCursor();
        this.render();
    }

    moveCursorLeftWithSelection() {
        // Start selection if none exists
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }

        // Move cursor
        this.moveCursorLogicalBackward();

        // Update selection end
        this.selectionEnd = this.cursorPosition;

        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }

        this.panToCursor();
        this.render();
    }

    moveCursorRightWithSelection() {
        // Start selection if none exists
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }

        // Move cursor
        this.moveCursorLogicalForward();

        // Update selection end
        this.selectionEnd = this.cursorPosition;

        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }

        this.panToCursor();
        this.render();
    }

    moveToStartWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = 0;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }
        this.updateCursorVisualPosition();
        this.panToCursor();
        this.render();
    }

    moveToEndWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = this.textBuffer.length;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }
        this.updateCursorVisualPosition();
        this.panToCursor();
        this.render();
    }

    // ==================== Clipboard Methods ====================

    async copySelection() {
        if (!this.hasSelection()) {
            return;
        }

        const range = this.getSelectionRange();
        const selectedText = this.textBuffer.slice(range.start, range.end);

        try {
            await navigator.clipboard.writeText(selectedText);
            console.log('Copied to clipboard:', `"${selectedText}"`);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    }

    async cutSelection() {
        if (!this.hasSelection()) {
            return;
        }

        // Copy first
        await this.copySelection();

        // Then delete
        const range = this.getSelectionRange();
        console.log('Cutting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
        this.cursorPosition = range.start;
        this.clearSelection();

        console.log('New cursor position:', this.cursorPosition);
        console.log('New text:', this.textBuffer);

        // Save to localStorage and trigger recompilation
        this.saveTextBuffer();

        // Reshape and render
        this.shapeText();
        this.updateCursorVisualPosition();
        this.panToCursor();

        // If text is now empty, reset cursor to origin
        if (this.textBuffer.length === 0) {
            this.cursorPosition = 0;
            this.cursorX = 0;
        }

        this.render();
    }

    async paste() {
        try {
            const text = await navigator.clipboard.readText();
            console.log('Pasting from clipboard:', `"${text}"`);

            // insertText already handles replacing selection
            this.insertText(text);
        } catch (err) {
            console.error('Failed to paste from clipboard:', err);
        }
    }

    insertText(text) {
        // If there's a selection, delete it first
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();
        }

        // Insert text at cursor position
        this.textBuffer = this.textBuffer.slice(0, this.cursorPosition) +
            text +
            this.textBuffer.slice(this.cursorPosition);
        this.cursorPosition += text.length;

        // Save to localStorage and trigger recompilation
        this.saveTextBuffer();

        // Reshape and render
        this.shapeText();
        this.updateCursorVisualPosition();
        this.panToCursor();
        this.render();
    }

    deleteBackward() {
        console.log('=== Delete Backward (Backspace) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Deleting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage and trigger recompilation
            this.saveTextBuffer();

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();
            this.panToCursor();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        } else if (this.cursorPosition > 0) {
            // Backspace always deletes the character BEFORE cursor (position - 1)
            console.log('Deleting char at position', this.cursorPosition - 1, ':', this.textBuffer[this.cursorPosition - 1]);
            this.textBuffer = this.textBuffer.slice(0, this.cursorPosition - 1) +
                this.textBuffer.slice(this.cursorPosition);
            this.cursorPosition--;

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage and trigger recompilation
            this.saveTextBuffer();

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();
            this.panToCursor();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        }
    }

    deleteForward() {
        console.log('=== Delete Forward (Delete key) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Deleting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage and trigger recompilation
            this.saveTextBuffer();

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();
            this.panToCursor();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        } else if (this.cursorPosition < this.textBuffer.length) {
            // Delete key always deletes the character AT cursor (position)
            console.log('Deleting char at position', this.cursorPosition, ':', this.textBuffer[this.cursorPosition]);
            this.textBuffer = this.textBuffer.slice(0, this.cursorPosition) +
                this.textBuffer.slice(this.cursorPosition + 1);

            // Cursor stays at same logical position
            // But we need to ensure it doesn't exceed text length
            if (this.cursorPosition > this.textBuffer.length) {
                this.cursorPosition = this.textBuffer.length;
            }

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage and trigger recompilation
            this.saveTextBuffer();

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();
            this.panToCursor();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        }
    }

    findClusterAt(logicalPos) {
        // Find the cluster (glyph + its character range) at a logical position
        if (!this.clusterMap || this.clusterMap.length === 0) {
            return null;
        }

        // Find cluster that contains this logical position
        for (const cluster of this.clusterMap) {
            if (logicalPos >= cluster.start && logicalPos < cluster.end) {
                return cluster;
            }
        }

        return null;
    }

    buildClusterMap() {
        // Build a map from logical character positions to visual glyphs
        // Group glyphs by cluster to handle multi-glyph clusters correctly
        this.clusterMap = [];

        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        console.log('=== Building Cluster Map ===');
        console.log('Text buffer:', this.textBuffer);
        console.log('Shaped glyphs count:', this.shapedGlyphs.length);

        // First pass: collect all unique cluster values to determine proper boundaries
        const clusterValues = new Set();
        for (const glyph of this.shapedGlyphs) {
            clusterValues.add(glyph.cl || 0);
        }
        const sortedClusters = Array.from(clusterValues).sort((a, b) => a - b);

        // Create a map from cluster start to cluster end
        const clusterBounds = new Map();
        for (let i = 0; i < sortedClusters.length; i++) {
            const start = sortedClusters[i];
            const end = i < sortedClusters.length - 1 ? sortedClusters[i + 1] : this.textBuffer.length;
            clusterBounds.set(start, end);
        }

        // Group consecutive glyphs with the same cluster value
        let xPosition = 0;
        let i = 0;

        while (i < this.shapedGlyphs.length) {
            const glyph = this.shapedGlyphs[i];
            const clusterStart = glyph.cl || 0;

            // Find all glyphs that belong to this cluster
            let clusterWidth = 0;
            let j = i;
            while (j < this.shapedGlyphs.length && (this.shapedGlyphs[j].cl || 0) === clusterStart) {
                clusterWidth += this.shapedGlyphs[j].ax || 0;
                j++;
            }

            // Get the proper cluster end from our bounds map
            const clusterEnd = clusterBounds.get(clusterStart) || (clusterStart + 1);

            // Determine the RTL status based on the cluster start position
            const isRTL = this.isPositionRTL(clusterStart);

            console.log(`Cluster [${clusterStart}-${clusterEnd}): ${j - i} glyphs, x=${xPosition.toFixed(0)}, width=${clusterWidth.toFixed(0)}, RTL=${isRTL}`);

            this.clusterMap.push({
                glyphIndex: i,
                glyphCount: j - i,
                start: clusterStart,
                end: clusterEnd,
                x: xPosition,
                width: clusterWidth,
                isRTL: isRTL
            });

            xPosition += clusterWidth;
            i = j; // Move to next cluster
        }

        console.log('===========================');
    }

    updateCursorVisualPosition() {
        // Calculate the visual X position of the cursor based on logical position
        console.log('updateCursorVisualPosition: cursor at logical position', this.cursorPosition);
        this.cursorX = 0;

        if (!this.clusterMap || this.clusterMap.length === 0) {
            console.log('No cluster map');
            return;
        }

        // Get glyph names for each cluster for debugging
        const clusterWithNames = this.clusterMap.map(c => {
            const glyphNames = [];
            for (let i = 0; i < c.glyphCount; i++) {
                const glyph = this.shapedGlyphs[c.glyphIndex + i];
                if (!glyph) {
                    console.warn('Missing glyph at index', c.glyphIndex + i);
                    continue;
                }
                const glyphId = glyph.g;
                let glyphName = `GID${glyphId}`;

                // Get glyph name from font manager (source font) instead of compiled font
                if (window.fontManager && window.fontManager.babelfontData) {
                    glyphName = window.fontManager.getGlyphName(glyphId);
                } else if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                    glyphName = this.opentypeFont.glyphs.get(glyphId).name || glyphName;
                }
                glyphNames.push(glyphName);
            }
            return `[${c.start}-${c.end}) @ x=${c.x.toFixed(0)}, RTL=${c.isRTL}, glyphs=[${glyphNames.join(', ')}]`;
        });
        console.log('Cluster map:', clusterWithNames);

        // Find the cluster that contains or is adjacent to this position
        // Priority: Check if position is the START of a cluster FIRST (more important than END)
        let found = false;

        // First pass: Check if this position is at the START of any cluster
        for (const cluster of this.clusterMap) {
            if (this.cursorPosition === cluster.start) {
                console.log(`Position ${this.cursorPosition} is at START of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                if (cluster.isRTL) {
                    // RTL: cursor before first char = right edge
                    this.cursorX = cluster.x + cluster.width;
                    console.log('RTL cluster start -> right edge x =', this.cursorX);
                } else {
                    // LTR: cursor before first char = left edge
                    this.cursorX = cluster.x;
                    console.log('LTR cluster start -> left edge x =', this.cursorX);
                }
                found = true;
                break;
            }
        }

        // Second pass: Check if this position is at the END of any cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (this.cursorPosition === cluster.end && this.cursorPosition > cluster.start) {
                    console.log(`Position ${this.cursorPosition} is at END of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                    if (cluster.isRTL) {
                        // RTL: cursor after last char = left edge
                        this.cursorX = cluster.x;
                        console.log('RTL cluster end -> left edge x =', this.cursorX);
                    } else {
                        // LTR: cursor after last char = right edge
                        this.cursorX = cluster.x + cluster.width;
                        console.log('LTR cluster end -> right edge x =', this.cursorX);
                    }
                    found = true;
                    break;
                }
            }
        }

        // Third pass: Check if position is INSIDE a cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (this.cursorPosition > cluster.start && this.cursorPosition < cluster.end) {
                    console.log(`Position ${this.cursorPosition} is INSIDE cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                    // Inside a cluster - interpolate
                    const progress = (this.cursorPosition - cluster.start) / (cluster.end - cluster.start);
                    if (cluster.isRTL) {
                        // RTL: interpolate from right to left
                        this.cursorX = cluster.x + cluster.width * (1 - progress);
                        console.log('RTL inside cluster, progress', progress.toFixed(2), '-> x =', this.cursorX);
                    } else {
                        // LTR: interpolate from left to right
                        this.cursorX = cluster.x + cluster.width * progress;
                        console.log('LTR inside cluster, progress', progress.toFixed(2), '-> x =', this.cursorX);
                    }
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            console.warn('Could not find visual position for logical position', this.cursorPosition);
        }
    }

    getClickedCursorPosition(e) {
        // Convert click position to cursor position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        // Check if clicking within cursor height range (same as cursor drawing)
        // Cursor goes from 1000 (top) to -300 (bottom)
        if (glyphY > 1000 || glyphY < -300) {
            return null; // Clicked outside cursor height - allow panning
        }

        if (!this.clusterMap || this.clusterMap.length === 0) {
            return 0;
        }

        // Find closest cursor position accounting for RTL
        let closestPos = 0;
        let closestDist = Infinity;

        // Check each cluster
        for (const cluster of this.clusterMap) {
            if (cluster.isRTL) {
                // RTL: start position is at RIGHT edge, end position is at LEFT edge
                const rightEdge = cluster.x + cluster.width;
                const leftEdge = cluster.x;

                // Distance to start position (right edge)
                const distStart = Math.abs(glyphX - rightEdge);
                if (distStart < closestDist) {
                    closestDist = distStart;
                    closestPos = cluster.start;
                }

                // Distance to end position (left edge)
                const distEnd = Math.abs(glyphX - leftEdge);
                if (distEnd < closestDist) {
                    closestDist = distEnd;
                    closestPos = cluster.end;
                }

                // Intermediate positions if multi-character cluster
                if (cluster.end - cluster.start > 1) {
                    for (let i = cluster.start + 1; i < cluster.end; i++) {
                        const progress = (i - cluster.start) / (cluster.end - cluster.start);
                        // RTL: interpolate from right to left
                        const intermediateX = rightEdge - cluster.width * progress;
                        const distIntermediate = Math.abs(glyphX - intermediateX);
                        if (distIntermediate < closestDist) {
                            closestDist = distIntermediate;
                            closestPos = i;
                        }
                    }
                }
            } else {
                // LTR: start position is at LEFT edge, end position is at RIGHT edge
                const leftEdge = cluster.x;
                const rightEdge = cluster.x + cluster.width;

                // Distance to start position (left edge)
                const distStart = Math.abs(glyphX - leftEdge);
                if (distStart < closestDist) {
                    closestDist = distStart;
                    closestPos = cluster.start;
                }

                // Distance to end position (right edge)
                const distEnd = Math.abs(glyphX - rightEdge);
                if (distEnd < closestDist) {
                    closestDist = distEnd;
                    closestPos = cluster.end;
                }

                // Intermediate positions if multi-character cluster
                if (cluster.end - cluster.start > 1) {
                    for (let i = cluster.start + 1; i < cluster.end; i++) {
                        const progress = (i - cluster.start) / (cluster.end - cluster.start);
                        // LTR: interpolate from left to right
                        const intermediateX = leftEdge + cluster.width * progress;
                        const distIntermediate = Math.abs(glyphX - intermediateX);
                        if (distIntermediate < closestDist) {
                            closestDist = distIntermediate;
                            closestPos = i;
                        }
                    }
                }
            }
        }

        // Ensure we don't return a position beyond the text length
        if (closestPos > this.textBuffer.length) {
            closestPos = this.textBuffer.length;
        }

        // If the closest position is too far away from the click, return null (allow panning)
        // This prevents clicking in empty space where text used to be
        const maxDistance = 500; // Maximum distance in font units to consider a valid click
        if (closestDist > maxDistance) {
            return null;
        }

        return closestPos;
    }

    drawSelection() {
        // Draw selection highlight
        if (!this.hasSelection() || !this.clusterMap || this.clusterMap.length === 0) {
            return;
        }

        const range = this.getSelectionRange();
        const invScale = 1 / this.scale;

        console.log('=== Drawing Selection ===');
        console.log('Selection range:', range);
        console.log('Text:', `"${this.textBuffer.slice(range.start, range.end)}"`);

        // Draw selection highlight for each cluster in range
        this.ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';

        for (const cluster of this.clusterMap) {
            // Check if this cluster overlaps with selection
            const clusterStart = cluster.start;
            const clusterEnd = cluster.end;

            // Skip if cluster is completely outside selection
            if (clusterEnd <= range.start || clusterStart >= range.end) {
                continue;
            }

            console.log(`Drawing selection for cluster [${clusterStart}-${clusterEnd}), RTL=${cluster.isRTL}, x=${cluster.x.toFixed(0)}, width=${cluster.width.toFixed(0)}`);

            // Calculate which part of the cluster is selected
            // Use the actual overlap, not interpolated positions
            const selStart = Math.max(range.start, clusterStart);
            const selEnd = Math.min(range.end, clusterEnd);

            console.log(`  Selection overlap: [${selStart}-${selEnd})`);

            // Check if we're selecting the entire cluster or just part of it
            const isFullySelected = (selStart === clusterStart && selEnd === clusterEnd);
            const isPartiallySelected = !isFullySelected;

            // Calculate visual position and width for selected portion
            let highlightX, highlightWidth;

            if (isFullySelected) {
                // Entire cluster is selected - draw full width
                highlightX = cluster.x;
                highlightWidth = cluster.width;
                console.log(`  Full cluster selected: x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
            } else if (cluster.isRTL) {
                // RTL: right edge is start, left edge is end
                const rightEdge = cluster.x + cluster.width;
                const leftEdge = cluster.x;

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress = (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress = (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    const startX = rightEdge - cluster.width * startProgress;
                    const endX = rightEdge - cluster.width * endProgress;

                    highlightX = Math.min(startX, endX);
                    highlightWidth = Math.abs(startX - endX);
                    console.log(`  RTL partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(`  RTL partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                }
            } else {
                // LTR: left edge is start, right edge is end

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress = (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress = (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    highlightX = cluster.x + cluster.width * startProgress;
                    highlightWidth = cluster.width * (endProgress - startProgress);
                    console.log(`  LTR partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(`  LTR partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                }
            }

            // Draw highlight rectangle
            this.ctx.fillRect(highlightX, -300, highlightWidth, 1300);
        }

        console.log('========================');
    }

    isCursorVisible() {
        // Check if cursor is within the visible viewport
        const rect = this.canvas.getBoundingClientRect();

        // Transform cursor position from font space to screen space
        const screenX = this.cursorX * this.scale + this.panX;

        // Define margin from edges (in screen pixels)
        const margin = 100;

        // Check if cursor is within visible bounds with margin
        return screenX >= margin && screenX <= rect.width - margin;
    }

    panToCursor() {
        // Pan viewport to show cursor with smooth animation
        if (this.isCursorVisible()) {
            return; // Cursor is already visible
        }

        const rect = this.canvas.getBoundingClientRect();
        const margin = 100; // Same margin as visibility check

        // Calculate target panX to center cursor with margin
        const screenX = this.cursorX * this.scale + this.panX;

        let targetPanX;
        if (screenX < margin) {
            // Cursor is off left edge - position it at left margin
            targetPanX = margin - this.cursorX * this.scale;
        } else {
            // Cursor is off right edge - position it at right margin
            targetPanX = (rect.width - margin) - this.cursorX * this.scale;
        }

        // Start animation
        this.animatePan(targetPanX, this.panY);
    }

    resetZoomAndPosition() {
        // Reset zoom to initial scale and position to origin with animation
        const rect = this.canvas.getBoundingClientRect();
        const targetScale = this.initialScale;
        const targetPanX = rect.width / 4;  // Same as initial position
        const targetPanY = rect.height / 2; // Same as initial position

        this.animateZoomAndPan(targetScale, targetPanX, targetPanY);
    }

    animateZoomAndPan(targetScale, targetPanX, targetPanY) {
        // Animate zoom and pan together
        const startScale = this.scale;
        const startPanX = this.panX;
        const startPanY = this.panY;
        const frames = 10;
        let currentFrame = 0;

        const animate = () => {
            currentFrame++;
            const progress = Math.min(currentFrame / frames, 1.0);

            // Ease-out cubic for smooth deceleration
            const easedProgress = 1 - Math.pow(1 - progress, 3);

            // Interpolate scale and pan values
            this.scale = startScale + (targetScale - startScale) * easedProgress;
            this.panX = startPanX + (targetPanX - startPanX) * easedProgress;
            this.panY = startPanY + (targetPanY - startPanY) * easedProgress;

            this.render();

            if (progress < 1.0) {
                requestAnimationFrame(animate);
            } else {
                // Ensure we end exactly at target
                this.scale = targetScale;
                this.panX = targetPanX;
                this.panY = targetPanY;
                this.render();
            }
        };

        animate();
    }

    animatePan(targetPanX, targetPanY) {
        // Set up animation state
        const startPanX = this.panX;
        const startPanY = this.panY;
        const frames = 10;
        let currentFrame = 0;

        const animate = () => {
            currentFrame++;
            const progress = Math.min(currentFrame / frames, 1.0);

            // Ease-out cubic for smooth deceleration
            const easedProgress = 1 - Math.pow(1 - progress, 3);

            // Interpolate pan values
            this.panX = startPanX + (targetPanX - startPanX) * easedProgress;
            this.panY = startPanY + (targetPanY - startPanY) * easedProgress;

            this.render();

            if (progress < 1.0) {
                requestAnimationFrame(animate);
            } else {
                // Ensure we end exactly at target
                this.panX = targetPanX;
                this.panY = targetPanY;
                this.render();
            }
        };

        animate();
    }

    drawCursor() {
        // Draw the text cursor at the current position
        // Don't draw cursor in glyph edit mode
        if (!this.cursorVisible || this.isGlyphEditMode) {
            return;
        }

        const invScale = 1 / this.scale;

        console.log(`Drawing cursor at x=${this.cursorX.toFixed(0)} for logical position ${this.cursorPosition}`);

        // Draw cursor line - dimmed when not focused, bright when focused
        const opacity = this.isFocused ? 0.8 : 0.3;

        // Use dark cursor for light theme, white cursor for dark theme
        const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';
        const cursorColor = isLightTheme ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`;

        this.ctx.strokeStyle = cursorColor;
        this.ctx.lineWidth = 2 * invScale;
        this.ctx.beginPath();
        this.ctx.moveTo(this.cursorX, 1000); // Top (above cap height, positive Y is up in font space)
        this.ctx.lineTo(this.cursorX, -300);   // Bottom (below baseline, negative Y is down)
        this.ctx.stroke();
    }
}

// Initialize when document is ready
document.addEventListener('DOMContentLoaded', () => {
    // Wait for the editor view to be ready
    const initCanvas = () => {
        const editorContent = document.querySelector('#view-editor .view-content');
        if (editorContent) {
            // Create main container with flexbox layout
            const mainContainer = document.createElement('div');
            mainContainer.style.display = 'flex';
            mainContainer.style.width = '100%';
            mainContainer.style.height = '100%';
            mainContainer.style.overflow = 'hidden';

            // Create left sidebar for glyph properties
            const leftSidebar = document.createElement('div');
            leftSidebar.id = 'glyph-properties-sidebar';
            leftSidebar.style.width = '200px';
            leftSidebar.style.minWidth = '200px';
            leftSidebar.style.height = '100%';
            leftSidebar.style.backgroundColor = 'var(--bg-editor-sidebar)';
            leftSidebar.style.borderRight = '1px solid var(--border-primary)';
            leftSidebar.style.padding = '12px';
            leftSidebar.style.overflowY = 'auto';
            leftSidebar.style.display = 'flex';
            leftSidebar.style.flexDirection = 'column';
            leftSidebar.style.gap = '12px';

            // Create right sidebar for axes
            const rightSidebar = document.createElement('div');
            rightSidebar.id = 'glyph-editor-sidebar';
            rightSidebar.style.width = '200px';
            rightSidebar.style.minWidth = '200px';
            rightSidebar.style.height = '100%';
            rightSidebar.style.backgroundColor = 'var(--bg-editor-sidebar)';
            rightSidebar.style.borderLeft = '1px solid var(--border-primary)';
            rightSidebar.style.padding = '12px';
            rightSidebar.style.overflowY = 'auto';
            rightSidebar.style.display = 'flex';
            rightSidebar.style.flexDirection = 'column';
            rightSidebar.style.gap = '12px';

            // Create canvas container
            const canvasContainer = document.createElement('div');
            canvasContainer.id = 'glyph-canvas-container';
            canvasContainer.style.flex = '1';
            canvasContainer.style.height = '100%';
            canvasContainer.style.position = 'relative';

            // Assemble layout (left sidebar, canvas, right sidebar)
            mainContainer.appendChild(leftSidebar);
            mainContainer.appendChild(canvasContainer);
            mainContainer.appendChild(rightSidebar);
            editorContent.appendChild(mainContainer);

            // Initialize canvas
            window.glyphCanvas = new GlyphCanvas('glyph-canvas-container');

            // Create glyph properties container (initially empty)
            const propertiesSection = document.createElement('div');
            propertiesSection.id = 'glyph-properties-section';
            propertiesSection.style.display = 'flex';
            propertiesSection.style.flexDirection = 'column';
            propertiesSection.style.gap = '10px';
            leftSidebar.appendChild(propertiesSection);

            // Create variable axes container (initially empty)
            const axesSection = document.createElement('div');
            axesSection.id = 'glyph-axes-section';
            axesSection.style.display = 'flex';
            axesSection.style.flexDirection = 'column';
            axesSection.style.gap = '10px';
            rightSidebar.appendChild(axesSection);

            // Create OpenType features container (initially empty)
            const featuresSection = document.createElement('div');
            featuresSection.id = 'glyph-features-section';
            featuresSection.style.display = 'flex';
            featuresSection.style.flexDirection = 'column';
            featuresSection.style.gap = '2px';
            featuresSection.style.marginTop = '10px';
            rightSidebar.appendChild(featuresSection);

            // Store reference to sidebars for later updates
            window.glyphCanvas.leftSidebar = leftSidebar;
            window.glyphCanvas.propertiesSection = propertiesSection;
            window.glyphCanvas.rightSidebar = rightSidebar;
            window.glyphCanvas.axesSection = axesSection;
            window.glyphCanvas.featuresSection = featuresSection;

            // Observe when the editor view gains/loses focus (via 'focused' class)
            const editorView = document.querySelector('#view-editor');
            if (editorView) {
                const updateSidebarStyles = () => {
                    const isFocused = editorView.classList.contains('focused');
                    const bgColor = isFocused ? 'var(--bg-editor-sidebar)' : 'var(--bg-secondary)';
                    leftSidebar.style.backgroundColor = bgColor;
                    rightSidebar.style.backgroundColor = bgColor;
                };

                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                            // Update sidebar styles when focus changes
                            updateSidebarStyles();
                            // Render when focused class changes
                            window.glyphCanvas.render();
                        }
                    });
                });
                observer.observe(editorView, { attributes: true, attributeFilter: ['class'] });

                // Set initial state
                updateSidebarStyles();
            }

            // Listen for font compilation events
            setupFontLoadingListener();

            console.log('Glyph canvas initialized');
        } else {
            setTimeout(initCanvas, 100);
        }
    };

    initCanvas();
});

// Set up listener for compiled fonts
function setupFontLoadingListener() {
    console.log('🔧 Setting up font loading listeners...');

    // Listen for editing font compiled by font manager (primary)
    window.addEventListener('editingFontCompiled', async (e) => {
        console.log('✅ Editing font compiled event received');
        console.log('   Event detail:', e.detail);
        console.log('   Canvas exists:', !!window.glyphCanvas);
        if (window.glyphCanvas && e.detail && e.detail.fontBytes) {
            console.log('   Loading editing font into canvas...');
            const arrayBuffer = e.detail.fontBytes.buffer.slice(
                e.detail.fontBytes.byteOffset,
                e.detail.fontBytes.byteOffset + e.detail.fontBytes.byteLength
            );
            window.glyphCanvas.setFont(arrayBuffer);
            console.log('   ✅ Editing font loaded into canvas');
        } else {
            console.warn('   ⚠️ Cannot load font - missing canvas or fontBytes');
        }
    });

    // Legacy: Custom event when font is compiled via compile button
    window.addEventListener('fontCompiled', async (e) => {
        console.log('Font compiled event received (legacy)');
        if (window.glyphCanvas && e.detail && e.detail.ttfBytes) {
            const arrayBuffer = e.detail.ttfBytes.buffer.slice(
                e.detail.ttfBytes.byteOffset,
                e.detail.ttfBytes.byteOffset + e.detail.ttfBytes.byteLength
            );
            window.glyphCanvas.setFont(arrayBuffer);
        }
    });

    // Also check for fonts loaded from file system
    window.addEventListener('fontLoaded', async (e) => {
        console.log('Font loaded event received');
        if (window.glyphCanvas && window.pyodide) {
            try {
                // Try to find a compiled TTF in the file system
                const result = await window.pyodide.runPythonAsync(`
import os
import glob

# Look for TTF files in the current directory and subdirectories
ttf_files = []
for root, dirs, files in os.walk('.'):
    for file in files:
        if file.endswith('.ttf'):
            ttf_files.append(os.path.join(root, file))

# Use the most recently modified TTF
if ttf_files:
    ttf_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    ttf_files[0]
else:
    None
                `);

                if (result) {
                    console.log('Found TTF file:', result);
                    const fontBytes = window.pyodide.FS.readFile(result);
                    const arrayBuffer = fontBytes.buffer.slice(
                        fontBytes.byteOffset,
                        fontBytes.byteOffset + fontBytes.byteLength
                    );
                    window.glyphCanvas.setFont(arrayBuffer);
                }
            } catch (error) {
                console.error('Error loading font from file system:', error);
            }
        }
    });
}


// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GlyphCanvas;
}
