// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

let AxesManager = require('./glyph-canvas/variations.js').AxesManager;
let FeaturesManager = require('./glyph-canvas/features').FeaturesManager;
let TextRunEditor = require('./glyph-canvas/textrun.js').TextRunEditor;
let ViewportManager = require('./glyph-canvas/viewport.js').ViewportManager;
let GlyphCanvasRenderer =
    require('./glyph-canvas/renderer').GlyphCanvasRenderer;
class GlyphCanvas {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(
                '[GlyphCanvas]',
                `Container ${containerId} not found`
            );
            return;
        }

        // Canvas and context
        this.canvas = null;
        this.ctx = null;

        this.axesManager = new AxesManager();
        this.featuresManager = new FeaturesManager();
        this.textRunEditor = new TextRunEditor(
            this.featuresManager,
            this.axesManager
        );
        this.renderer = null; // Will be filled in init()

        // Transformation state
        this.initialScale = 0.2; // Zoomed out to see glyphs better
        this.viewportManager = null; // Loaded in init() when we have a client rect

        // Text buffer and shaping
        this.currentFont = null;
        this.fontBlob = null;
        this.opentypeFont = null; // For glyph path extraction
        this.sourceGlyphNames = {}; // Map of GID to glyph names from source font

        // Focus state for background color
        this.isFocused = false;

        // Mouse interaction
        this.mouseX = 0;
        this.mouseY = 0;
        this.hoveredGlyphIndex = -1; // Index of glyph being hovered
        this.glyphBounds = []; // Store bounding boxes for hit testing

        // Edit mode: false = text edit mode, true = glyph edit mode
        this.isGlyphEditMode = false;

        // Font data and selected layer for layer switching
        this.fontData = null;
        this.selectedLayerId = null;
        this.previousSelectedLayerId = null; // For restoring on Escape
        this.previousVariationSettings = null; // For restoring on Escape

        // Outline editor state
        this.layerData = null; // Cached layer data with shapes
        this.currentGlyphName = null; // Name of currently edited glyph for interpolation
        this.selectedPoints = []; // Array of {contourIndex, nodeIndex} for selected points
        this.hoveredPointIndex = null; // {contourIndex, nodeIndex} for hovered point
        this.selectedAnchors = []; // Array of anchor indices for selected anchors
        this.hoveredAnchorIndex = null; // Index for hovered anchor
        this.selectedComponents = []; // Array of component indices for selected components
        this.hoveredComponentIndex = null; // Index for hovered component
        this.layerDataDirty = false; // Track if layer data needs saving
        this.isPreviewMode = false; // Preview mode hides outline editor
        this.isSliderActive = false; // Track if user is currently interacting with slider
        this.isInterpolating = false; // Track if currently showing interpolated data
        this.isLayerSwitchAnimating = false; // Track if animating during layer switch
        this.targetLayerData = null; // Store target layer data during animation

        // Component recursion state
        this.componentStack = []; // Stack of {componentIndex, transform, layerData, glyphName} for nested editing
        this.editingComponentIndex = null; // Index of component being edited (null = editing main glyph)

        // Glyph selection sequence tracking to prevent race conditions
        this.glyphSelectionSequence = 0;

        // Text change debouncing for font recompilation
        this.textChangeDebounceTimer = null;
        this.textChangeDebounceDelay = 1000; // 1 second delay

        // Resize observer
        this.resizeObserver = null;

        // Nodes which will be filled in layer
        this.propertiesSection = null;

        // Keyboard zoom animation state
        this.zoomAnimation = {
            active: false,
            currentFrame: 0,
            totalFrames: 0,
            startScale: 0,
            endScale: 0,
            centerX: 0,
            centerY: 0
        };

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

        // Set up HiDPI canvas
        this.setupHiDPI();

        // Set initial scale and position
        const rect = this.canvas.getBoundingClientRect();
        this.viewportManager = new ViewportManager(
            this.initialScale,
            rect.width / 4, // Start a bit to the left
            rect.height / 2 // Center vertically
        );
        this.renderer = new GlyphCanvasRenderer(
            this.canvas,
            this,
            this.viewportManager,
            this.textRunEditor
        );

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();

        this.textRunEditor.init();
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
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), {
            passive: false
        });

        // Mouse move for hover detection
        this.canvas.addEventListener('mousemove', (e) =>
            this.onMouseMoveHover(e)
        );

        // Keyboard events for cursor and text input
        this.canvas.addEventListener('keydown', (e) => {
            console.log(
                '[GlyphCanvas]',
                'keydown:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'cmdKeyPressed:',
                this.cmdKeyPressed,
                'spaceKeyPressed:',
                this.spaceKeyPressed
            );
            // Track Cmd key for panning
            if (e.metaKey || e.key === 'Meta') {
                this.cmdKeyPressed = true;
                this.updateCursorStyle(e);
            }
            // Track Space key for preview mode
            if (e.code === 'Space') {
                this.spaceKeyPressed = true;
            }
            this.onKeyDown(e);
        });
        this.canvas.addEventListener('keyup', (e) => {
            console.log(
                '[GlyphCanvas]',
                'keyup:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.spaceKeyPressed,
                'cmdKeyPressed:',
                this.cmdKeyPressed,
                'isPreviewMode:',
                this.isPreviewMode
            );

            // Track Cmd key release
            if (e.key === 'Meta') {
                console.log('[GlyphCanvas]', '  -> Releasing Cmd key');
                this.cmdKeyPressed = false;
                // Stop panning if it was active
                if (this.isDraggingCanvas) {
                    this.isDraggingCanvas = false;
                }
                // Exit preview mode when Cmd is released if we're in preview mode
                // This handles the case where Space keyup doesn't fire due to browser/OS issues
                if (this.isPreviewMode && this.isGlyphEditMode) {
                    console.log(
                        '[GlyphCanvas]',
                        '  -> Exiting preview mode on Cmd release'
                    );
                    this.isPreviewMode = false;
                    this.spaceKeyPressed = false; // Also reset Space state since keyup might not fire
                    // Schedule the state update and render in the next frame to batch everything
                    // Re-enter preview if Space was pressed again (key repeat)
                    if (this.spaceKeyPressed) {
                        this.isPreviewMode = true;
                        console.log(
                            '[GlyphCanvas]',
                            '  -> Re-entering preview mode due to Space key still pressed'
                        );
                    }
                    this.render();
                }
                this.updateCursorStyle(e);
            }

            // Track Space key release
            if (e.code === 'Space') {
                console.log('[GlyphCanvas]', '  -> Releasing Space key');
                this.spaceKeyPressed = false;
            }

            // Call onKeyUp to handle Space release (exits preview mode)
            this.onKeyUp(e);
        });

        // Reset key states when window loses focus (e.g., Cmd+Tab to switch apps)
        window.addEventListener('blur', () => {
            this.cmdKeyPressed = false;
            this.spaceKeyPressed = false;
            this.isDraggingCanvas = false;
            this.isDraggingPoint = false;
            this.isDraggingAnchor = false;
            this.isDraggingComponent = false;
            // Exit preview mode if active
            if (this.isPreviewMode) {
                this.isPreviewMode = false;
                this.render();
            }
            if (this.canvas) {
                this.canvas.style.cursor = this.isGlyphEditMode
                    ? 'default'
                    : 'text';
            }
        });

        // Also reset when canvas loses focus
        this.canvas.addEventListener('blur', () => {
            this.cmdKeyPressed = false;
            this.spaceKeyPressed = false;
            this.isDraggingCanvas = false;
            // Don't exit preview mode when canvas loses focus to sidebar elements
            // (e.g., clicking sliders). Preview mode will be managed by slider events.
            // Only exit preview mode on true blur events (window blur, etc.)
        });

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isGlyphEditMode) {
                // Check if editor view is focused
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    editorView && editorView.classList.contains('focused');

                if (!isEditorFocused) {
                    return; // Don't handle Escape if editor view is not focused
                }

                e.preventDefault();

                console.log(
                    '[GlyphCanvas]',
                    'Escape pressed. Previous state:',
                    {
                        layerId: this.previousSelectedLayerId,
                        settings: this.previousVariationSettings,
                        componentStackDepth: this.componentStack.length
                    }
                );

                // Priority 1: If we have a saved previous state from slider interaction, restore it first
                // (This takes precedence over exiting component editing)
                // However, if the previous layer is the same as the current layer, skip restoration
                if (
                    this.previousSelectedLayerId !== null &&
                    this.previousVariationSettings !== null
                ) {
                    // Check if we're already on the previous layer
                    if (this.previousSelectedLayerId === this.selectedLayerId) {
                        console.log(
                            '[GlyphCanvas]',
                            'Already on previous layer, clearing state and continuing to exit'
                        );
                        this.previousSelectedLayerId = null;
                        this.previousVariationSettings = null;
                        // Don't return - fall through to exit component or edit mode
                    } else {
                        console.log(
                            '[GlyphCanvas]',
                            'Restoring previous layer state'
                        );
                        // Restore previous layer selection and axis values
                        this.selectedLayerId = this.previousSelectedLayerId;

                        // Fetch layer data for the restored layer
                        this.fetchLayerData().then(() => {
                            // Update layer selection UI
                            this.updateLayerSelection();

                            // Render with restored layer data
                            this.render();
                        });

                        // Restore axis values with animation
                        this.axesManager._setupAnimation({
                            ...this.previousVariationSettings
                        });

                        // Clear previous state
                        this.previousSelectedLayerId = null;
                        this.previousVariationSettings = null;

                        // Return focus to canvas
                        this.canvas.focus();
                        return;
                    }
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
        this.setupAxesManagerEventHandlers();
        this.featuresManager.on('change', () => {
            this.textRunEditor.shapeText();
        });
        this.setupTextEditorEventHandlers();
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
    setupAxesManagerEventHandlers() {
        this.axesManager.on('sliderMouseDown', () => {
            if (this.isGlyphEditMode) {
                // Remember if preview was already on (from keyboard toggle)
                this.previewModeBeforeSlider = this.isPreviewMode;

                // Set interpolating flag (don't change preview mode)
                this.isInterpolating = true;

                // If not in preview mode, mark current layer data as interpolated and render
                // to show monochrome visual feedback immediately
                if (!this.isPreviewMode && this.layerData) {
                    this.layerData.isInterpolated = true;
                    this.render();
                }
            }
        });
        this.axesManager.on('sliderMouseUp', async () => {
            if (this.isGlyphEditMode && this.isPreviewMode) {
                // Only exit preview mode if we entered it via slider
                // If it was already on (from keyboard), keep it on
                const shouldExitPreview = !this.previewModeBeforeSlider;

                if (shouldExitPreview) {
                    this.isPreviewMode = false;
                }

                // Check if we're on an exact layer (do this before clearing isInterpolating)
                await this.autoSelectMatchingLayer();

                // Now clear interpolating flag
                this.isInterpolating = false;

                // If we landed on an exact layer, update the saved state to this new layer
                // so Escape will return here, not to the original layer
                if (this.selectedLayerId) {
                    this.previousSelectedLayerId = this.selectedLayerId;
                    this.previousVariationSettings = {
                        ...this.axesManager.variationSettings
                    };
                    console.log(
                        '[GlyphCanvas]',
                        'Updated previous state to new layer:',
                        {
                            layerId: this.previousSelectedLayerId,
                            settings: this.previousVariationSettings
                        }
                    );
                    await this.fetchLayerData();
                } else if (this.layerData && this.layerData.isInterpolated) {
                    // No exact layer match - keep interpolated data
                    // Only restore if shapes are empty/missing
                    if (
                        !this.layerData.shapes ||
                        this.layerData.shapes.length === 0
                    ) {
                        await LayerDataNormalizer.restoreExactLayer(this);
                    }
                }

                // Always render to update colors after clearing isInterpolating flag
                this.render();
            } else if (this.isGlyphEditMode) {
                this.isPreviewMode = false;

                // Check if we're on an exact layer (do this before clearing isInterpolating)
                await this.autoSelectMatchingLayer();

                // Now clear interpolating flag
                this.isInterpolating = false;

                // If we landed on an exact layer, update the saved state to this new layer
                // so Escape will return here, not to the original layer
                if (this.selectedLayerId) {
                    this.previousSelectedLayerId = this.selectedLayerId;
                    this.previousVariationSettings = {
                        ...this.axesManager.variationSettings
                    };
                    console.log(
                        '[GlyphCanvas]',
                        'Updated previous state to new layer:',
                        {
                            layerId: this.previousSelectedLayerId,
                            settings: this.previousVariationSettings
                        }
                    );
                    await this.fetchLayerData();
                }

                // If no exact layer match, keep showing interpolated data

                this.render();
                // Restore focus to canvas
                setTimeout(() => this.canvas.focus(), 0);
            } else {
                // In text editing mode, restore focus to canvas
                setTimeout(() => this.canvas.focus(), 0);
            }
        });
        this.axesManager.on('animationInProgress', () => {
            this.textRunEditor.shapeText();

            // Interpolate during slider dragging OR layer switch animation
            // But NOT after layer switch animation has ended
            if (this.isGlyphEditMode && this.currentGlyphName) {
                if (this.isInterpolating) {
                    // Slider being dragged
                    this.interpolateCurrentGlyph();
                } else if (this.isLayerSwitchAnimating) {
                    // Layer switch animation in progress - interpolate at current animated position
                    this.interpolateCurrentGlyph();
                }
                // If neither flag is set, don't interpolate (normal axis animation without layer switch)
            }
        });
        this.axesManager.on('animationComplete', async () => {
            // Skip layer matching during manual slider interpolation
            // It will be handled properly in sliderMouseUp
            if (this.isInterpolating) {
                this.textRunEditor.shapeText();
                return;
            }

            // If we were animating a layer switch, restore the target layer data
            if (this.isLayerSwitchAnimating) {
                this.isLayerSwitchAnimating = false;
                if (this.targetLayerData) {
                    console.log(
                        '[GlyphCanvas]',
                        'Before restore - layerData.isInterpolated:',
                        this.layerData?.isInterpolated
                    );
                    console.log(
                        '[GlyphCanvas]',
                        'Before restore - targetLayerData.isInterpolated:',
                        this.targetLayerData?.isInterpolated
                    );
                    this.layerData = this.targetLayerData;
                    this.targetLayerData = null;
                    // Clear interpolated flag to restore editing mode
                    if (this.layerData) {
                        this.layerData.isInterpolated = false;
                        // Also clear on shapes
                        if (this.layerData.shapes) {
                            this.layerData.shapes.forEach((shape) => {
                                if (shape.isInterpolated !== undefined) {
                                    shape.isInterpolated = false;
                                }
                            });
                        }
                    }
                    console.log(
                        '[GlyphCanvas]',
                        'After restore - layerData.isInterpolated:',
                        this.layerData?.isInterpolated
                    );
                    console.log(
                        '[GlyphCanvas]',
                        'Layer switch animation complete, restored target layer for editing'
                    );

                    // Now check if we're on an exact layer match to update selectedLayerId
                    await this.autoSelectMatchingLayer();

                    if (this.isGlyphEditMode) {
                        this.render();
                    }
                }
                this.textRunEditor.shapeText();
                return;
            }

            // Check if new variation settings match any layer
            if (this.isGlyphEditMode && this.fontData) {
                await this.autoSelectMatchingLayer();

                // If no exact layer match, keep interpolated data visible
                if (
                    this.selectedLayerId === null &&
                    this.layerData &&
                    this.layerData.isInterpolated
                ) {
                    // Keep showing interpolated data
                    console.log(
                        '[GlyphCanvas]',
                        'Animation complete: showing interpolated glyph'
                    );
                }
            }

            this.textRunEditor.shapeText();

            // Restore focus to canvas after animation completes (for text editing mode)
            if (!this.isGlyphEditMode) {
                setTimeout(() => this.canvas.focus(), 0);
            }
        });
        this.axesManager.on('onSliderChange', (axisTag, value) => {
            // Save current state before manual adjustment (only once per manual session)
            if (
                this.selectedLayerId !== null &&
                this.previousSelectedLayerId === null
            ) {
                this.previousSelectedLayerId = this.selectedLayerId;
                this.previousVariationSettings = {
                    ...this.axesManager.variationSettings
                };
                console.log(
                    '[GlyphCanvas]',
                    'Saved previous state for Escape:',
                    {
                        layerId: this.previousSelectedLayerId,
                        settings: this.previousVariationSettings
                    }
                );
                this.selectedLayerId = null; // Deselect layer
                // Don't update layer selection UI during interpolation to avoid triggering render
                if (!this.isInterpolating) {
                    this.updateLayerSelection();
                }
            }

            // Real-time interpolation during slider movement
            // Skip interpolation if in preview mode (HarfBuzz handles interpolation)
            if (
                this.isGlyphEditMode &&
                this.isInterpolating &&
                !this.isPreviewMode &&
                this.currentGlyphName
            ) {
                this.interpolateCurrentGlyph();
            }
        });
    }

    setupTextEditorEventHandlers() {
        this.textRunEditor.on('cursormoved', () => {
            this.panToCursor();
            this.render();
        });
        this.textRunEditor.on('textchanged', () => {
            this.onTextChange();
        });
        this.textRunEditor.on('render', () => {
            this.render();
        });
        this.textRunEditor.on('exitcomponentediting', () => {
            // If we're in nested component mode, exit all levels first
            // Skip UI updates during batch exit to avoid duplicate layer interfaces
            while (this.componentStack.length > 0) {
                this.exitComponentEditing(true); // Skip UI updates
            }
        });
        this.textRunEditor.on(
            'glyphselected',
            async (ix, previousIndex, fromKeyboard = false) => {
                const wasInEditMode = this.isGlyphEditMode;

                // Increment sequence counter to track this selection
                this.glyphSelectionSequence++;
                const currentSequence = this.glyphSelectionSequence;

                // Save the previous glyph's vertical bounds BEFORE clearing layer data
                if (
                    wasInEditMode &&
                    previousIndex >= 0 &&
                    previousIndex !== ix &&
                    this.layerData
                ) {
                    try {
                        const prevBounds = this.calculateGlyphBoundingBox();
                        if (
                            prevBounds &&
                            previousIndex <
                                this.textRunEditor.shapedGlyphs.length
                        ) {
                            const prevPos =
                                this.textRunEditor._getGlyphPosition(
                                    previousIndex
                                );
                            const fontSpaceMinY =
                                prevPos.yOffset + prevBounds.minY;
                            const fontSpaceMaxY =
                                prevPos.yOffset + prevBounds.maxY;

                            // Update accumulated vertical bounds with previous glyph
                            if (
                                !this.viewportManager.accumulatedVerticalBounds
                            ) {
                                this.viewportManager.accumulatedVerticalBounds =
                                    {
                                        minY: fontSpaceMinY,
                                        maxY: fontSpaceMaxY
                                    };
                            } else {
                                this.viewportManager.accumulatedVerticalBounds.minY =
                                    Math.min(
                                        this.viewportManager
                                            .accumulatedVerticalBounds.minY,
                                        fontSpaceMinY
                                    );
                                this.viewportManager.accumulatedVerticalBounds.maxY =
                                    Math.max(
                                        this.viewportManager
                                            .accumulatedVerticalBounds.maxY,
                                        fontSpaceMaxY
                                    );
                            }
                            console.log(
                                '[GlyphCanvas]',
                                'Saved previous glyph vertical bounds:',
                                {
                                    fontSpaceMinY,
                                    fontSpaceMaxY
                                }
                            );
                        }
                    } catch (error) {
                        console.warn(
                            '[GlyphCanvas]',
                            'Could not save previous glyph bounds:',
                            error
                        );
                    }
                }

                // Clear layer data immediately to prevent rendering stale outlines
                this.layerData = null;

                if (ix != -1) {
                    this.isGlyphEditMode = true;
                }
                // Update breadcrumb (will hide it since componentStack is now empty)
                this.updateComponentBreadcrumb();

                // Fetch glyph data and update UI before rendering
                await this.updatePropertiesUI();

                // Check if this selection is still current (not superseded by a newer one)
                if (currentSequence !== this.glyphSelectionSequence) {
                    console.log(
                        '[GlyphCanvas]',
                        'Glyph selection superseded, skipping render/pan for sequence',
                        currentSequence
                    );
                    return;
                }

                // Now render with the loaded data
                this.render();

                // Pan to glyph only if navigating via keyboard (not mouse double-click)
                if (
                    fromKeyboard &&
                    wasInEditMode &&
                    ix >= 0 &&
                    previousIndex !== ix
                ) {
                    // Layer data should be loaded now after updatePropertiesUI completes
                    this.panToGlyph(ix);
                }

                // Perform mouse hit detection for objects at current mouse position
                if (
                    this.isGlyphEditMode &&
                    this.selectedLayerId &&
                    this.layerData
                ) {
                    this.updateHoveredComponent();
                    this.updateHoveredAnchor();
                    this.updateHoveredPoint();
                }
            }
        );
    }

    onMouseDown(e) {
        // Focus the canvas when clicked
        this.canvas.focus();

        // Priority: If Cmd key is pressed, start canvas panning immediately
        if (this.cmdKeyPressed) {
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }

        // Check for double-click
        if (e.detail === 2) {
            console.log(
                '[GlyphCanvas]',
                'Double-click detected. isGlyphEditMode:',
                this.isGlyphEditMode,
                'selectedLayerId:',
                this.selectedLayerId,
                'hoveredComponentIndex:',
                this.hoveredComponentIndex
            );
            // In outline editor mode with layer selected
            if (
                this.isGlyphEditMode &&
                this.selectedLayerId &&
                this.layerData
            ) {
                // Double-click on component - enter component editing (without selecting it)
                if (this.hoveredComponentIndex !== null) {
                    console.log(
                        '[GlyphCanvas]',
                        'Entering component editing for index:',
                        this.hoveredComponentIndex
                    );
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
                if (
                    this.hoveredGlyphIndex >= 0 &&
                    this.hoveredGlyphIndex !==
                        this.textRunEditor.selectedGlyphIndex
                ) {
                    this.textRunEditor.selectGlyphByIndex(
                        this.hoveredGlyphIndex
                    );
                    return;
                }
            }

            // Double-click on glyph - select glyph (when not in edit mode)
            if (!this.isGlyphEditMode && this.hoveredGlyphIndex >= 0) {
                this.textRunEditor.selectGlyphByIndex(this.hoveredGlyphIndex);
                return;
            }
        }

        // In outline editor mode with layer selected (but not in preview mode)
        if (
            this.isGlyphEditMode &&
            this.selectedLayerId &&
            this.layerData &&
            !this.isPreviewMode
        ) {
            // Check if clicking on a component first (components take priority)
            if (this.hoveredComponentIndex !== null) {
                if (e.shiftKey) {
                    // Shift-click: add to or remove from selection (keep points and anchors for mixed selection)
                    const existingIndex = this.selectedComponents.indexOf(
                        this.hoveredComponentIndex
                    );
                    if (existingIndex >= 0) {
                        this.selectedComponents.splice(existingIndex, 1);
                    } else {
                        this.selectedComponents.push(
                            this.hoveredComponentIndex
                        );
                    }
                    this.render();
                } else {
                    const isInSelection = this.selectedComponents.includes(
                        this.hoveredComponentIndex
                    );

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
                    const existingIndex = this.selectedAnchors.indexOf(
                        this.hoveredAnchorIndex
                    );
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
                    const isInSelection = this.selectedAnchors.includes(
                        this.hoveredAnchorIndex
                    );

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
                    const existingIndex = this.selectedPoints.findIndex(
                        (p) =>
                            p.contourIndex ===
                                this.hoveredPointIndex.contourIndex &&
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
                    const isInSelection = this.selectedPoints.some(
                        (p) =>
                            p.contourIndex ===
                                this.hoveredPointIndex.contourIndex &&
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
        if (
            !this.isGlyphEditMode &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            this.hoveredGlyphIndex < 0
        ) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.textRunEditor.clearSelection();
                this.textRunEditor.cursorPosition = clickedPos;
                this.textRunEditor.updateCursorVisualPosition();
                this.render();
                // Keep text cursor
                this.canvas.style.cursor = 'text';
                return; // Don't start dragging if clicking on text
            }
        }

        // Start canvas panning when Cmd key is pressed
        if (this.cmdKeyPressed) {
            console.log(
                '[GlyphCanvas]',
                'Starting canvas panning, cmdKeyPressed:',
                this.cmdKeyPressed
            );
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
        } else {
            console.log(
                '[GlyphCanvas]',
                'Not starting panning, cmdKeyPressed:',
                this.cmdKeyPressed
            );
        }
    }

    onMouseMove(e) {
        // Handle component, anchor, or point dragging in outline editor
        if (
            (this.isDraggingComponent && this.selectedComponents.length > 0) ||
            (this.isDraggingAnchor && this.selectedAnchors.length > 0) ||
            (this.isDraggingPoint && this.selectedPoints.length > 0)
        ) {
            if (this.layerData) {
                this._handleDrag(e);
            }
            return;
        }

        // Handle canvas panning
        if (this.isDraggingCanvas) {
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;

            this.viewportManager.pan(deltaX, deltaY);
            this.render();

            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }
    }

    _handleDrag(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        const { glyphX, glyphY } =
            this.viewportManager.getGlyphLocalCoordinates(
                mouseX,
                mouseY,
                this.textRunEditor.shapedGlyphs,
                this.textRunEditor.selectedGlyphIndex
            );

        // Calculate delta from last position
        const deltaX =
            Math.round(glyphX) - Math.round(this.lastGlyphX || glyphX);
        const deltaY =
            Math.round(glyphY) - Math.round(this.lastGlyphY || glyphY);

        this.lastGlyphX = glyphX;
        this.lastGlyphY = glyphY;

        // Update all selected items
        this._updateDraggedComponents(deltaX, deltaY);
        this._updateDraggedPoints(deltaX, deltaY);
        this._updateDraggedAnchors(deltaX, deltaY);

        // Save to Python immediately (non-blocking)
        this.saveLayerData();

        this.render();
    }

    _updateDraggedPoints(deltaX, deltaY) {
        for (const point of this.selectedPoints) {
            const { contourIndex, nodeIndex } = point;
            if (
                this.layerData.shapes[contourIndex] &&
                this.layerData.shapes[contourIndex].nodes[nodeIndex]
            ) {
                this.layerData.shapes[contourIndex].nodes[nodeIndex][0] +=
                    deltaX;
                this.layerData.shapes[contourIndex].nodes[nodeIndex][1] +=
                    deltaY;
            }
        }
    }

    _updateDraggedAnchors(deltaX, deltaY) {
        for (const anchorIndex of this.selectedAnchors) {
            const anchor = this.layerData.anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }
    }

    _updateDraggedComponents(deltaX, deltaY) {
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
    }

    onMouseUp(e) {
        this.isDraggingPoint = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        this.isDraggingCanvas = false;

        // Update cursor based on current mouse position and Cmd key state
        this.updateCursorStyle(e);
    }

    onWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        this.viewportManager.handleWheel(e, rect, this.render.bind(this));
    }

    onMouseMoveHover(e) {
        if (
            this.isDraggingPoint ||
            this.isDraggingAnchor ||
            this.isDraggingComponent
        )
            return; // Don't detect hover while dragging

        const rect = this.canvas.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = (this.mouseX * this.canvas.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas.height) / rect.height;

        // In outline editor mode, check for hovered components, anchors and points first (unless in preview mode), then other glyphs
        if (
            this.isGlyphEditMode &&
            this.selectedLayerId &&
            this.layerData &&
            !this.isPreviewMode
        ) {
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
        // Cmd key pressed = always show grab cursor for panning
        if (this.cmdKeyPressed) {
            this.canvas.style.cursor = this.isDraggingCanvas
                ? 'grabbing'
                : 'grab';
            return;
        }

        // In outline editing mode, use pointer for interactive elements
        if (this.isGlyphEditMode) {
            if (
                this.selectedLayerId &&
                this.layerData &&
                !this.isPreviewMode &&
                (this.hoveredComponentIndex !== null ||
                    this.hoveredPointIndex ||
                    this.hoveredAnchorIndex !== null)
            ) {
                this.canvas.style.cursor = 'pointer';
            } else {
                this.canvas.style.cursor = 'default';
            }
            return;
        }

        // In text mode, show text cursor
        this.canvas.style.cursor = 'text';
    }

    updateHoveredGlyph() {
        // Use HiDPI-scaled mouse coordinates for hit testing
        const mouseX = this.mouseCanvasX || this.mouseX;
        const mouseY = this.mouseCanvasY || this.mouseY;

        // Transform mouse coordinates to glyph space
        const { x: glyphX, y: glyphY } =
            this.viewportManager.getFontSpaceCoordinates(mouseX, mouseY);

        let foundIndex = -1;

        // Check each glyph using path hit testing
        let xPosition = 0;
        for (let i = 0; i < this.textRunEditor.shapedGlyphs.length; i++) {
            const glyph = this.textRunEditor.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Check if point is within this glyph's path
            try {
                const glyphData =
                    this.textRunEditor.hbFont.glyphToPath(glyphId);
                if (glyphData) {
                    const path = new Path2D(glyphData);

                    // Create a temporary context for hit testing with proper transform
                    this.ctx.save();

                    // Apply the same transform as rendering
                    const transform = this.viewportManager.getTransformMatrix();
                    this.ctx.setTransform(
                        transform.a,
                        transform.b,
                        transform.c,
                        transform.d,
                        transform.e,
                        transform.f
                    );
                    this.ctx.translate(x, y);

                    // Test if mouse point is in path (in canvas coordinates)
                    if (
                        this.ctx.isPointInPath(path, this.mouseX, this.mouseY)
                    ) {
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

    _findHoveredItem(items, getCoords, getValue, hitRadius = 10) {
        if (!this.layerData || !items) {
            return null;
        }
        const { glyphX, glyphY } = this.transformMouseToComponentSpace(
            this.mouseX,
            this.mouseY
        );
        const scaledHitRadius = hitRadius / this.viewportManager.scale;

        // Iterate backwards to find the top-most item
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const coords = getCoords(item);
            if (coords) {
                const dist = Math.sqrt(
                    (coords.x - glyphX) ** 2 + (coords.y - glyphY) ** 2
                );
                if (dist <= scaledHitRadius) {
                    return getValue(item);
                }
            }
        }
        return null;
    }

    updateHoveredComponent() {
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        // First, check for hovering near component origins, which take priority.
        const components = this.layerData.shapes
            .map((shape, index) => ({ shape, index }))
            .filter((item) => item.shape.Component);

        const getComponentOrigin = (item) => {
            const transform = item.shape.Component.transform || [
                1, 0, 0, 1, 0, 0
            ];
            return { x: transform[4] || 0, y: transform[5] || 0 };
        };

        let foundComponentIndex = this._findHoveredItem(
            components,
            getComponentOrigin,
            (item) => item.index,
            20 // Larger hit radius for origin marker
        );

        // If no origin was hovered, proceed with path-based hit testing.
        if (foundComponentIndex === null) {
            const { glyphX, glyphY } = this.transformMouseToComponentSpace(
                this.mouseX,
                this.mouseY
            );

            for (let index = 0; index < this.layerData.shapes.length; index++) {
                const shape = this.layerData.shapes[index];
                if (
                    shape.Component &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    if (
                        this._isPointInComponent(
                            shape,
                            glyphX,
                            glyphY,
                            this.mouseX,
                            this.mouseY
                        )
                    ) {
                        foundComponentIndex = index;
                    }
                }
            }
        }

        if (foundComponentIndex !== this.hoveredComponentIndex) {
            this.hoveredComponentIndex = foundComponentIndex;
            this.render();
        }
    }

    _isPointInComponent(shape, glyphX, glyphY, mouseX, mouseY) {
        const { xPosition, xOffset, yOffset } =
            this.textRunEditor._getGlyphPosition(
                this.textRunEditor.selectedGlyphIndex
            );
        const transform = shape.Component.transform || [1, 0, 0, 1, 0, 0];

        const checkShapesRecursive = (
            shapes,
            parentTransform = [1, 0, 0, 1, 0, 0]
        ) => {
            for (const componentShape of shapes) {
                if (componentShape.Component) {
                    const nestedTransform = componentShape.Component
                        .transform || [1, 0, 0, 1, 0, 0];
                    const combinedTransform = [
                        parentTransform[0] * nestedTransform[0] +
                            parentTransform[2] * nestedTransform[1],
                        parentTransform[1] * nestedTransform[0] +
                            parentTransform[3] * nestedTransform[1],
                        parentTransform[0] * nestedTransform[2] +
                            parentTransform[2] * nestedTransform[3],
                        parentTransform[1] * nestedTransform[2] +
                            parentTransform[3] * nestedTransform[3],
                        parentTransform[0] * nestedTransform[4] +
                            parentTransform[2] * nestedTransform[5] +
                            parentTransform[4],
                        parentTransform[1] * nestedTransform[4] +
                            parentTransform[3] * nestedTransform[5] +
                            parentTransform[5]
                    ];

                    if (
                        componentShape.Component.layerData &&
                        componentShape.Component.layerData.shapes &&
                        checkShapesRecursive(
                            componentShape.Component.layerData.shapes,
                            combinedTransform
                        )
                    ) {
                        return true;
                    }
                    continue;
                }

                if (componentShape.nodes && componentShape.nodes.length > 0) {
                    const path = new Path2D();
                    this.renderer.buildPathFromNodes(
                        componentShape.nodes,
                        path
                    );
                    path.closePath();

                    this.ctx.save();
                    // Always use identity transform since glyphX/glyphY are already
                    // in glyph-local space (xPosition has been subtracted)
                    this.ctx.setTransform(1, 0, 0, 1, 0, 0);

                    this.ctx.transform(
                        transform[0],
                        transform[1],
                        transform[2],
                        transform[3],
                        transform[4],
                        transform[5]
                    );
                    this.ctx.transform(
                        parentTransform[0],
                        parentTransform[1],
                        parentTransform[2],
                        parentTransform[3],
                        parentTransform[4],
                        parentTransform[5]
                    );

                    // Always use glyphX/glyphY which are in glyph-local space
                    const isInPath = this.ctx.isPointInPath(
                        path,
                        glyphX,
                        glyphY
                    );

                    this.ctx.restore();
                    if (isInPath) return true;
                }
            }
            return false;
        };

        return checkShapesRecursive(shape.Component.layerData.shapes);
    }

    updateHoveredAnchor() {
        if (!this.layerData || !this.layerData.anchors) {
            return;
        }

        const foundAnchorIndex = this._findHoveredItem(
            this.layerData.anchors.map((anchor, index) => ({
                ...anchor,
                index
            })),
            (item) => ({ x: item.x, y: item.y }),
            (item) => item.index
        );

        if (foundAnchorIndex !== this.hoveredAnchorIndex) {
            this.hoveredAnchorIndex = foundAnchorIndex;
            this.render();
        }
    }

    updateHoveredPoint() {
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        const points = this.layerData.shapes.flatMap((shape, contourIndex) => {
            if (shape.ref || !shape.nodes) return [];
            return shape.nodes.map((node, nodeIndex) => ({
                node,
                contourIndex,
                nodeIndex
            }));
        });

        const foundPoint = this._findHoveredItem(
            points,
            (item) => ({ x: item.node[0], y: item.node[1] }),
            (item) => ({
                contourIndex: item.contourIndex,
                nodeIndex: item.nodeIndex
            })
        );

        if (
            JSON.stringify(foundPoint) !==
            JSON.stringify(this.hoveredPointIndex)
        ) {
            this.hoveredPointIndex = foundPoint;
            this.render();
        }
    }

    moveSelectedPoints(deltaX, deltaY) {
        // Move all selected points by the given delta
        if (
            !this.layerData ||
            !this.layerData.shapes ||
            this.selectedPoints.length === 0
        ) {
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
        if (
            !this.layerData ||
            !this.layerData.anchors ||
            this.selectedAnchors.length === 0
        ) {
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
        if (
            !this.layerData ||
            !this.layerData.shapes ||
            this.selectedComponents.length === 0
        ) {
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

        console.log(
            '[GlyphCanvas]',
            `Toggled point smooth: ${type} -> ${newType}`
        );
    }

    onResize() {
        this.setupHiDPI();
        this.render();
    }

    setFont(fontArrayBuffer) {
        if (!fontArrayBuffer) {
            console.error('[GlyphCanvas]', 'No font data provided');
            return;
        }

        try {
            // Store current variation settings to restore after font reload
            const previousVariationSettings = {
                ...this.axesManager.variationSettings
            };

            // Parse with opentype.js for glyph path extraction
            if (window.opentype) {
                this.opentypeFont = window.opentype.parse(fontArrayBuffer);
                this.axesManager.opentypeFont = this.opentypeFont;
                this.featuresManager.opentypeFont = this.opentypeFont;
                this.textRunEditor.opentypeFont = this.opentypeFont;
                console.log(
                    '[GlyphCanvas]',
                    'Font parsed with opentype.js:',
                    this.opentypeFont.names.fontFamily.en
                );
            }

            // Create HarfBuzz blob, face, and font if HarfBuzz is loaded
            this.textRunEditor
                .setFont(new Uint8Array(fontArrayBuffer))
                .then((hbFont) => {
                    // Restore previous variation settings before updating UI
                    // This ensures the sliders show the previous values
                    this.axesManager.variationSettings =
                        previousVariationSettings;

                    // Update axes UI (will restore slider positions from variationSettings)
                    this.axesManager.updateAxesUI();
                    console.log(
                        '[GlyphCanvas]',
                        'Updated axes UI after font load'
                    );

                    // Update features UI (async, then shape text)
                    this.featuresManager.updateFeaturesUI().then(() => {
                        // Shape text with new font after features are initialized
                        this.textRunEditor.shapeText();
                    });
                });
        } catch (error) {
            console.error('[GlyphCanvas]', 'Error setting font:', error);
        }
    }

    async enterGlyphEditModeAtCursor() {
        // Enter glyph edit mode for the glyph at the current cursor position
        if (this.isGlyphEditMode) return;
        let glyphIndex = this.textRunEditor.getGlyphIndexAtCursorPosition();

        if (glyphIndex >= 0) {
            console.log(
                '[GlyphCanvas]',
                `Entering glyph edit mode at cursor position ${this.textRunEditor.cursorPosition}, glyph index ${glyphIndex}`
            );
            await this.textRunEditor.selectGlyphByIndex(glyphIndex);
        } else {
            console.log(
                '[GlyphCanvas]',
                `No glyph found at cursor position ${this.textRunEditor.cursorPosition}`
            );
        }
    }

    exitGlyphEditMode() {
        // Exit glyph edit mode and return to text edit mode

        // Determine cursor position based on whether glyph was typed or shaped
        const savedGlyphIndex = this.textRunEditor.selectedGlyphIndex;

        const glyph = this.textRunEditor.shapedGlyphs[savedGlyphIndex];
        console.log(
            '[GlyphCanvas]',
            '[v2024-12-01-FIX] exitGlyphEditMode CALLED - selectedGlyphIndex:',
            this.textRunEditor.selectedGlyphIndex,
            'shapedGlyphs.length:',
            this.textRunEditor.shapedGlyphs.length,
            'glyph:',
            glyph
        );

        // Update cursor position to before the edited glyph
        if (
            savedGlyphIndex >= 0 &&
            savedGlyphIndex < this.textRunEditor.shapedGlyphs.length
        ) {
            const glyphInfo =
                this.textRunEditor.isGlyphFromTypedCharacter(savedGlyphIndex);
            const clusterStart = glyph.cl || 0;
            const isRTL = this.textRunEditor.isPositionRTL(clusterStart);

            console.log(
                '[GlyphCanvas]',
                'Exit glyph edit mode [v2024-12-01-FIX] - glyphInfo:',
                glyphInfo,
                'clusterStart:',
                clusterStart,
                'isRTL:',
                isRTL
            );

            if (glyphInfo.isTyped) {
                // For typed characters, position cursor at the character's logical position
                // (which is the space before the character, where we entered from)
                this.textRunEditor.cursorPosition = glyphInfo.logicalPosition;
                console.log(
                    '[GlyphCanvas]',
                    'Typed character - set cursor position at logical position:',
                    this.textRunEditor.cursorPosition
                );
            } else {
                // For shaped glyphs, position cursor at the cluster start
                this.textRunEditor.cursorPosition = clusterStart;
                console.log(
                    '[GlyphCanvas]',
                    'Shaped glyph - set cursor position at cluster start:',
                    this.textRunEditor.cursorPosition
                );
            }
            this.textRunEditor.updateCursorVisualPosition();
        }

        this.isGlyphEditMode = false;
        this.textRunEditor.selectedGlyphIndex = -1;
        this.selectedLayerId = null;

        // Clear outline editor state
        this.layerData = null;
        this.selectedPoints = [];
        this.hoveredPointIndex = null;
        this.isDraggingPoint = false;
        this.layerDataDirty = false;

        console.log(
            '[GlyphCanvas]',
            `Exited glyph edit mode - returned to text edit mode`
        );
        this.updatePropertiesUI();
        this.render();
    }

    async displayLayersList() {
        // Fetch and display layers list
        this.fontData = await window.fontManager.fetchGlyphData(
            this.getCurrentGlyphName()
        );

        if (
            !this.fontData ||
            !this.fontData.layers ||
            this.fontData.layers.length === 0
        ) {
            return;
        }

        // Store glyph name for interpolation (needed even when not on a layer)
        if (this.fontData.glyphName) {
            this.currentGlyphName = this.fontData.glyphName;
            console.log(
                '[GlyphCanvas]',
                'Set currentGlyphName from fontData:',
                this.currentGlyphName
            );
        }

        // Add layers section title
        const layersTitle = document.createElement('div');
        layersTitle.className = 'editor-section-title';
        layersTitle.textContent = 'Foreground Layers';
        this.propertiesSection.appendChild(layersTitle);

        // Sort layers by master order (order in which masters are defined in font.masters)
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(
                (m) => m.id === a._master
            );
            const masterIndexB = this.fontData.masters.findIndex(
                (m) => m.id === b._master
            );

            // If master not found, put at end
            const posA =
                masterIndexA === -1
                    ? this.fontData.masters.length
                    : masterIndexA;
            const posB =
                masterIndexB === -1
                    ? this.fontData.masters.length
                    : masterIndexB;

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
            const master = this.fontData.masters.find(
                (m) => m.id === layer._master
            );

            // Format axis values for display (e.g., "wght:400, wdth:100")
            // Display axes in the order they are defined in font.axes
            let axisValues = '';
            if (master && master.location) {
                // Sort axis tags according to font.axes order
                const axesOrder =
                    this.fontData.axesOrder ||
                    Object.keys(master.location).sort();
                const locationParts = axesOrder
                    .filter((tag) => tag in master.location)
                    .map((tag) => `${tag}:${Math.round(master.location[tag])}`)
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
        const currentLocation = { ...this.axesManager.variationSettings };

        // Check each layer to find a match
        for (const layer of this.fontData.layers) {
            const master = this.fontData.masters.find(
                (m) => m.id === layer._master
            );
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

                // Don't clear previous state during slider use - allow Escape to restore
                // Only clear when explicitly selecting a layer or on initial load
                // We can detect slider use by checking if previousSelectedLayerId is set
                if (this.previousSelectedLayerId === null) {
                    // Not during slider use - this is a direct layer selection or initial load
                    // Clear previous state to allow Escape to exit components instead
                    this.previousVariationSettings = null;
                    console.log(
                        '[GlyphCanvas]',
                        'Cleared previous state (not during slider use)'
                    );
                } else {
                    console.log(
                        '[GlyphCanvas]',
                        'Keeping previous state (during slider use)'
                    );
                }

                // Only fetch layer data if we're not currently interpolating
                // During interpolation, the next interpolateCurrentGlyph() call will handle the data
                if (!this.isInterpolating) {
                    // Only fetch layer data if we're not currently editing a component
                    // If editing a component, the layer switch will be handled by refreshComponentStack
                    if (this.componentStack.length === 0) {
                        await this.fetchLayerData(); // Fetch layer data for outline editor

                        // Perform mouse hit detection after layer data is loaded
                        this.updateHoveredComponent();
                        this.updateHoveredAnchor();
                        this.updateHoveredPoint();

                        // Render to display the new outlines
                        if (this.isGlyphEditMode) {
                            this.render();
                        }
                    }
                } else {
                    // During interpolation (sliderMouseUp), we still need to render
                    // to update colors after isInterpolated flag is cleared
                    // Clear the isInterpolated flag since we're on an exact layer now
                    if (this.layerData) {
                        this.layerData.isInterpolated = false;
                    }
                    if (this.isGlyphEditMode) {
                        this.render();
                    }
                }
                this.updateLayerSelection();
                console.log(
                    '[GlyphCanvas]',
                    `Auto-selected layer: ${layer.name || 'Default'} (${layer.id})`
                );
                return;
            }
        }

        // No matching layer found - deselect current layer
        if (this.selectedLayerId !== null) {
            this.selectedLayerId = null;
            // Don't clear layer data during interpolation - keep showing interpolated data
            if (!this.isInterpolating) {
                this.layerData = null; // Clear layer data when deselecting
            }
            this.selectedPointIndex = null;
            this.hoveredPointIndex = null;
            this.updateLayerSelection();
            console.log('[GlyphCanvas]', 'No matching layer - deselected');
        }

        // If we're in glyph edit mode and not on a layer, interpolate at current position
        if (
            this.isGlyphEditMode &&
            this.selectedLayerId === null &&
            this.currentGlyphName
        ) {
            console.log(
                '[GlyphCanvas]',
                'Interpolating at current position after entering edit mode'
            );
            await this.interpolateCurrentGlyph(true); // force=true to bypass guard
        }
    }

    async selectLayer(layer) {
        // Select a layer and update axis sliders to match its master location
        // Clear previous state when explicitly selecting a layer
        this.previousSelectedLayerId = null;
        this.previousVariationSettings = null;

        this.selectedLayerId = layer.id;

        // Immediately clear interpolated flag on existing data
        // to prevent rendering with monochrome colors
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }

        console.log(
            '[GlyphCanvas]',
            `Selected layer: ${layer.name} (ID: ${layer.id})`
        );
        console.log('[GlyphCanvas]', 'Layer data:', layer);
        console.log(
            '[GlyphCanvas]',
            'Available masters:',
            this.fontData.masters
        );

        // Fetch layer data now and store as target for animation
        // This ensures new outlines are ready before animation starts
        await this.fetchLayerData();

        // If we're in edit mode, set up animation state
        if (this.isGlyphEditMode && this.layerData) {
            console.log(
                '[GlyphCanvas]',
                'Before copy - layerData.isInterpolated:',
                this.layerData.isInterpolated
            );
            // Make a deep copy of the target layer data so it doesn't get overwritten during animation
            this.targetLayerData = JSON.parse(JSON.stringify(this.layerData));
            // Also store the layer ID for validation
            this.targetLayerData.layerId = this.layerData.layerId;
            console.log(
                '[GlyphCanvas]',
                'After copy - targetLayerData.isInterpolated:',
                this.targetLayerData.isInterpolated
            );
            this.isLayerSwitchAnimating = true;
            console.log(
                '[GlyphCanvas]',
                'Starting layer switch animation with stored target layer'
            );
        }

        // Perform mouse hit detection after layer data is loaded
        this.updateHoveredComponent();
        this.updateHoveredAnchor();
        this.updateHoveredPoint();

        // Find the master for this layer
        const master = this.fontData.masters.find(
            (m) => m.id === layer._master
        );
        if (!master || !master.location) {
            console.warn(
                '[GlyphCanvas]',
                'No master location found for layer',
                {
                    layer_master: layer._master,
                    available_master_ids: this.fontData.masters.map(
                        (m) => m.id
                    ),
                    master_found: master
                }
            );
            return;
        }

        console.log(
            '[GlyphCanvas]',
            `Setting axis values to master location:`,
            master.location
        );

        // Set up animation to all axes at once
        const newSettings = {};
        for (const [axisTag, value] of Object.entries(master.location)) {
            newSettings[axisTag] = value;
        }
        this.axesManager._setupAnimation(newSettings);

        // Update the visual selection highlight for layers without rebuilding the entire UI
        this.updateLayerSelection();
    }

    updateLayerSelection() {
        // Update the visual selection highlight for layer items without rebuilding
        if (!this.propertiesSection) return;

        // Find all layer items and update their selected class
        const layerItems =
            this.propertiesSection.querySelectorAll('[data-layer-id]');
        layerItems.forEach((item) => {
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
        if (
            !this.fontData ||
            !this.fontData.layers ||
            this.fontData.layers.length === 0
        ) {
            return;
        }

        // Get sorted layers (same as in displayLayersList)
        // Sort layers by master order (order in which masters are defined in font.masters)
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(
                (m) => m.id === a._master
            );
            const masterIndexB = this.fontData.masters.findIndex(
                (m) => m.id === b._master
            );

            // If master not found, put at end
            const posA =
                masterIndexA === -1
                    ? this.fontData.masters.length
                    : masterIndexA;
            const posB =
                masterIndexB === -1
                    ? this.fontData.masters.length
                    : masterIndexB;

            return posA - posB;
        });

        // Find current layer index
        const currentIndex = sortedLayers.findIndex(
            (layer) => layer.id === this.selectedLayerId
        );
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
            console.log(
                '[GlyphCanvas]',
                'Refreshing component layer data for new layer'
            );
            await this.refreshComponentStack();
            return;
        }

        // Fetch full layer data including shapes using to_dict()
        if (!window.pyodide || !this.selectedLayerId) {
            this.layerData = null;
            return;
        }

        try {
            const glyphId =
                this.textRunEditor.shapedGlyphs[
                    this.textRunEditor.selectedGlyphIndex
                ].g;
            let glyphName = this.getCurrentGlyphName();
            console.log(
                '[GlyphCanvas]',
                `🔍 Fetching layer data for glyph: "${glyphName}" (GID ${glyphId}, production name), layer: ${this.selectedLayerId}`
            );

            this.layerData = await window.fontManager.fetchLayerData(
                glyphName,
                this.selectedLayerId
            );

            // Clear isInterpolated flag since we're loading actual layer data
            if (this.layerData) {
                this.layerData.isInterpolated = false;
            }
            this.currentGlyphName = glyphName; // Store for interpolation

            // Recursively parse component layer data nodes strings into arrays
            const parseComponentNodes = (shapes) => {
                if (!shapes) return;

                shapes.forEach((shape) => {
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
                    if (
                        shape.Component &&
                        shape.Component.layerData &&
                        shape.Component.layerData.shapes
                    ) {
                        parseComponentNodes(shape.Component.layerData.shapes);
                    }
                });
            };

            if (this.layerData && this.layerData.shapes) {
                parseComponentNodes(this.layerData.shapes);
            }

            console.log('[GlyphCanvas]', 'Fetched layer data:', this.layerData);
            this.render();
        } catch (error) {
            console.error(
                '[GlyphCanvas]',
                'Error fetching layer data from Python:',
                error
            );
            this.layerData = null;
        }
    }

    async interpolateCurrentGlyph(force = false) {
        // Interpolate the current glyph at current variation settings
        if (!this.currentGlyphName || !window.fontInterpolation) {
            console.log('[GlyphCanvas]', 'Skipping interpolation:', {
                hasGlyphName: !!this.currentGlyphName,
                hasFontInterpolation: !!window.fontInterpolation
            });
            return;
        }

        // Don't interpolate if we just finished a layer switch animation
        // The target layer data has already been restored
        // Unless force=true (e.g., entering edit mode at interpolated position)
        if (!force && !this.isInterpolating && !this.isLayerSwitchAnimating) {
            console.log(
                '[GlyphCanvas]',
                'Skipping interpolation - not in active interpolation state'
            );
            return;
        }

        try {
            const location = this.axesManager.variationSettings;
            console.log(
                '[GlyphCanvas]',
                `🔄 Interpolating glyph "${this.currentGlyphName}" at location:`,
                JSON.stringify(location)
            );

            const interpolatedLayer =
                await window.fontInterpolation.interpolateGlyph(
                    this.currentGlyphName,
                    location
                );

            console.log(
                '[GlyphCanvas]',
                `📦 Received interpolated layer:`,
                interpolatedLayer
            );

            // Apply interpolated data using normalizer
            console.log(
                '[GlyphCanvas]',
                'Calling LayerDataNormalizer.applyInterpolatedLayer...'
            );
            LayerDataNormalizer.applyInterpolatedLayer(
                this,
                interpolatedLayer,
                location
            );

            // Render with the new interpolated data
            this.render();

            console.log(
                '[GlyphCanvas]',
                `✅ Applied interpolated layer for "${this.currentGlyphName}"`
            );
        } catch (error) {
            // Silently ignore cancellation errors
            if (error.message && error.message.includes('cancelled')) {
                console.log(
                    '[GlyphCanvas]',
                    '🚫 Interpolation cancelled (newer request pending)'
                );
                return;
            }

            console.warn(
                '[GlyphCanvas]',
                `⚠️ Interpolation failed for "${this.currentGlyphName}":`,
                error
            );
            // On error, keep showing whatever data we have
        }
    }

    getCurrentGlyphName() {
        // We're editing the main glyph
        const glyphId = this.textRunEditor.selectedGlyph?.g;
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
        return glyphName;
    }

    async saveLayerData() {
        // Save layer data back to Python using from_dict()
        if (!window.pyodide || !this.layerData) {
            return;
        }

        // Don't save interpolated data - it's not editable and has no layer ID
        if (this.layerData.isInterpolated) {
            console.warn(
                '[GlyphCanvas]',
                'Cannot save interpolated layer data - not on an exact layer location'
            );
            return;
        }

        if (!this.selectedLayerId) {
            console.warn('[GlyphCanvas]', 'No layer selected - cannot save');
            return;
        }

        try {
            // Determine which glyph to save to
            let glyphName;

            if (this.componentStack.length > 0) {
                // We're editing a component - save to the component's glyph
                // Get the component reference from the parent layer
                const parentState =
                    this.componentStack[this.componentStack.length - 1];
                const componentShape =
                    parentState.layerData.shapes[this.editingComponentIndex];
                glyphName = componentShape.Component.reference;
            } else {
                glyphName = this.getCurrentGlyphName();
            }

            await window.fontManager.saveLayerData(
                glyphName,
                this.selectedLayerId,
                this.layerData
            );

            console.log('[GlyphCanvas]', 'Layer data saved successfully');
        } catch (error) {
            console.error(
                '[GlyphCanvas]',
                'Error saving layer data to Python:',
                error
            );
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
            console.log('[GlyphCanvas]', 'Component has no reference');
            return;
        }

        // Fetch the component's layer data
        const componentLayerData =
            await window.fontManager.fetchComponentLayerData(
                componentShape.Component.reference,
                this.selectedLayerId
            );
        if (!componentLayerData) {
            console.error(
                '[GlyphCanvas]',
                'Failed to fetch component layer data for:',
                componentShape.Component.reference
            );
            return;
        }

        console.log(
            '[GlyphCanvas]',
            'Fetched component layer data:',
            componentLayerData
        );

        // Recursively parse nodes in component layer data (including nested components)
        const parseComponentNodes = (shapes) => {
            if (!shapes) return;

            shapes.forEach((shape) => {
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
                    console.log(
                        '[GlyphCanvas]',
                        'Parsed shape nodes:',
                        nodesArray.length,
                        'nodes'
                    );
                }

                // Recursively parse nested component data
                if (
                    shape.Component &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    parseComponentNodes(shape.Component.layerData.shapes);
                }
            });
        };

        if (componentLayerData.shapes) {
            parseComponentNodes(componentLayerData.shapes);
        }

        console.log(
            '[GlyphCanvas]',
            'About to set layerData to component data. Current shapes:',
            this.layerData?.shapes?.length,
            '-> New shapes:',
            componentLayerData.shapes?.length
        );

        // Get component transform
        const transform = componentShape.Component.transform || [
            1, 0, 0, 1, 0, 0
        ];

        // Get current glyph name (for breadcrumb trail)
        // This is the name of the context we're currently in (before entering the new component)
        let currentGlyphName;
        if (this.componentStack.length > 0) {
            // We're already in a component, so get its reference name
            // Use the componentIndex stored in the parent state (not this.editingComponentIndex)
            const parentState =
                this.componentStack[this.componentStack.length - 1];
            if (
                parentState &&
                parentState.layerData &&
                parentState.layerData.shapes &&
                parentState.componentIndex !== null &&
                parentState.componentIndex !== undefined
            ) {
                const currentComponent =
                    parentState.layerData.shapes[parentState.componentIndex];
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
            const glyphId = this.textRunEditor.selectedGlyph?.g;
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

        console.log(
            '[GlyphCanvas]',
            `Pushed to stack. Stack depth: ${this.componentStack.length}, storing glyphName: ${currentGlyphName}`
        );

        // Set the component as the current editing context
        this.editingComponentIndex = componentIndex;
        this.layerData = componentLayerData;
        // Clear isInterpolated flag since we're loading actual layer data
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }

        console.log(
            '[GlyphCanvas]',
            'Set layerData to component. this.layerData.shapes.length:',
            this.layerData?.shapes?.length
        );

        // Clear selections
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;

        console.log(
            '[GlyphCanvas]',
            `Entered component editing: ${componentShape.Component.reference}, stack depth: ${this.componentStack.length}`
        );

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

        console.log(
            '[GlyphCanvas]',
            'Refreshing component stack for new layer, stack depth:',
            this.componentStack.length
        );

        // Save the path of component indices from the stack
        const componentPath = [];
        for (let i = 0; i < this.componentStack.length; i++) {
            componentPath.push(this.componentStack[i].componentIndex);
        }

        // Clear the stack and editing state
        this.componentStack = [];
        this.editingComponentIndex = null;
        this.layerData = null;

        const glyphId = this.textRunEditor.selectedGlyph?.g;
        let glyphName = this.getCurrentGlyphName();

        // Fetch root layer data (bypassing the component check since stack is now empty)
        try {
            this.layerData = await window.fontManager.fetchRootLayerData(
                glyphName,
                this.selectedLayerId
            );

            // Re-enter each component level without UI updates
            for (const componentIndex of componentPath) {
                if (!this.layerData || !this.layerData.shapes[componentIndex]) {
                    console.error(
                        '[GlyphCanvas]',
                        'Failed to refresh component stack - component not found at index',
                        componentIndex
                    );
                    break;
                }

                await this.enterComponentEditing(componentIndex, true); // Skip UI updates
            }

            console.log(
                '[GlyphCanvas]',
                'Component stack refreshed, new depth:',
                this.componentStack.length
            );

            // Update UI once at the end
            this.updateComponentBreadcrumb();
            await this.updatePropertiesUI();
            this.render();
        } catch (error) {
            console.error(
                '[GlyphCanvas]',
                'Error refreshing component stack:',
                error
            );
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
        // Clear isInterpolated flag since we're restoring actual layer data
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }
        this.selectedPoints = previousState.selectedPoints || [];
        this.selectedAnchors = previousState.selectedAnchors || [];
        this.selectedComponents = previousState.selectedComponents || [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;

        console.log(
            '[GlyphCanvas]',
            `Exited component editing, stack depth: ${this.componentStack.length}`
        );

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
        /** @type{HTMLSpanElement} */
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
        if (
            !this.isGlyphEditMode ||
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
            glyphNameElement.style.display = 'none';
            return;
        }

        glyphNameElement.style.display = 'flex';

        // Get the main glyph name
        const glyphId = this.textRunEditor.selectedGlyph?.g;
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
                const currentState =
                    this.componentStack[this.componentStack.length - 1];
                if (
                    currentState &&
                    currentState.layerData &&
                    currentState.layerData.shapes &&
                    currentState.componentIndex !== null &&
                    currentState.componentIndex !== undefined
                ) {
                    const currentComponent =
                        currentState.layerData.shapes[
                            currentState.componentIndex
                        ];
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
        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;

        // Apply transforms from all components in the stack
        // The stack now contains all the components we've entered (level 0, 1, 2, etc.)
        for (const level of this.componentStack) {
            if (
                level.componentIndex !== null &&
                level.layerData &&
                level.layerData.shapes[level.componentIndex]
            ) {
                const comp =
                    level.layerData.shapes[level.componentIndex].Component;
                if (comp && comp.transform) {
                    const t = comp.transform;
                    // Multiply transforms: new = current * level
                    const newA = a * t[0] + c * t[1];
                    const newB = b * t[0] + d * t[1];
                    const newC = a * t[2] + c * t[3];
                    const newD = b * t[2] + d * t[3];
                    const newTx = a * t[4] + c * t[5] + tx;
                    const newTy = b * t[4] + d * t[5] + ty;
                    a = newA;
                    b = newB;
                    c = newC;
                    d = newD;
                    tx = newTx;
                    ty = newTy;
                }
            }
        }

        return [a, b, c, d, tx, ty];
    }

    transformMouseToComponentSpace(mouseX, mouseY) {
        // Transform mouse coordinates from canvas to component local space
        let { glyphX, glyphY } = this.viewportManager.getGlyphLocalCoordinates(
            mouseX,
            mouseY,
            this.textRunEditor.shapedGlyphs,
            this.textRunEditor.selectedGlyphIndex
        );
        // Note: getGlyphLocalCoordinates already subtracts xPosition + xOffset
        // so glyphX and glyphY are already in glyph-local space

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
            console.log(
                '[GlyphCanvas]',
                `transformMouseToComponentSpace: before inverse=(${glyphXBeforeInverse}, ${glyphYBeforeInverse}), after inverse=(${glyphX}, ${glyphY}), accumulated transform=[${compTransform}]`
            );
        }

        return { glyphX, glyphY };
    }

    calculateGlyphBoundingBox() {
        // Calculate bounding box for the currently selected glyph in outline editing mode
        // Returns {minX, minY, maxX, maxY, width, height} in glyph-local coordinates
        // Returns null if no glyph is selected or no layer data is available

        console.log(
            '[GlyphCanvas]',
            'calculateGlyphBoundingBox: isGlyphEditMode=',
            this.isGlyphEditMode,
            'layerData=',
            this.layerData
        );

        if (!this.isGlyphEditMode || !this.layerData) {
            return null;
        }

        console.log(
            '[GlyphCanvas]',
            'calculateGlyphBoundingBox: layerData.shapes=',
            this.layerData.shapes,
            'layerData.width=',
            this.layerData.width
        );

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let hasPoints = false;

        // Helper function to expand bounding box with a point
        const expandBounds = (x, y) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            hasPoints = true;
        };

        // Helper function to process shapes recursively (for components)
        const processShapes = (shapes, transform = [1, 0, 0, 1, 0, 0]) => {
            if (!shapes || !Array.isArray(shapes)) return;

            for (const shape of shapes) {
                if (shape.Component) {
                    // Component - recursively process its outline shapes with accumulated transform
                    const compTransform = shape.Component.transform || [
                        1, 0, 0, 1, 0, 0
                    ];
                    const [a1, b1, c1, d1, tx1, ty1] = transform;
                    const [a2, b2, c2, d2, tx2, ty2] = compTransform;

                    // Combine transforms
                    const combinedTransform = [
                        a1 * a2 + c1 * b2,
                        b1 * a2 + d1 * b2,
                        a1 * c2 + c1 * d2,
                        b1 * c2 + d1 * d2,
                        a1 * tx2 + c1 * ty2 + tx1,
                        b1 * tx2 + d1 * ty2 + ty1
                    ];

                    // Recursively process the component's actual outline shapes
                    if (
                        shape.Component.layerData &&
                        shape.Component.layerData.shapes
                    ) {
                        processShapes(
                            shape.Component.layerData.shapes,
                            combinedTransform
                        );
                    }
                } else if (
                    shape.nodes &&
                    Array.isArray(shape.nodes) &&
                    shape.nodes.length > 0
                ) {
                    // Path - process all nodes with the accumulated transform
                    for (const node of shape.nodes) {
                        const [x, y] = node;

                        // Apply accumulated transform
                        const [a, b, c, d, tx, ty] = transform;
                        const transformedX = a * x + c * y + tx;
                        const transformedY = b * x + d * y + ty;

                        expandBounds(transformedX, transformedY);
                    }
                }
            }
        };

        // Process all shapes
        processShapes(this.layerData.shapes);

        // Also include anchors in bounding box
        if (this.layerData.anchors && Array.isArray(this.layerData.anchors)) {
            for (const anchor of this.layerData.anchors) {
                expandBounds(anchor.x, anchor.y);
            }
        }

        if (!hasPoints) {
            // No points found (e.g., space character) - use glyph width from layer data
            // Create a small bbox: 10 units high, centered on baseline, as wide as the glyph
            const glyphWidth = this.layerData.width || 250; // Fallback to 250 if no width
            const height = 10;

            console.log(
                '[GlyphCanvas]',
                'calculateGlyphBoundingBox: No points found, creating bbox for empty glyph. width=',
                glyphWidth
            );

            return {
                minX: 0,
                minY: -height / 2,
                maxX: glyphWidth,
                maxY: height / 2,
                width: glyphWidth,
                height: height
            };
        }

        console.log(
            '[GlyphCanvas]',
            'calculateGlyphBoundingBox: Found points, bbox=',
            {
                minX,
                minY,
                maxX,
                maxY
            }
        );

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    frameCurrentGlyph(margin = null) {
        // Pan and zoom to show the current glyph with margin around it
        // Delegates to ViewportManager.frameGlyph

        if (
            !this.isGlyphEditMode ||
            this.textRunEditor.selectedGlyphIndex < 0
        ) {
            return;
        }

        const bounds = this.calculateGlyphBoundingBox();
        if (!bounds) {
            return;
        }

        const rect = this.canvas.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor._getGlyphPosition(
            this.textRunEditor.selectedGlyphIndex
        );

        // Delegate to ViewportManager
        this.viewportManager.frameGlyph(
            bounds,
            glyphPosition,
            rect,
            this.render.bind(this),
            margin
        );
    }

    panToGlyph(glyphIndex) {
        // Pan to show a specific glyph (used when switching glyphs with cmd+left/right)
        // Delegates to ViewportManager.panToGlyph

        if (
            !this.isGlyphEditMode ||
            glyphIndex < 0 ||
            glyphIndex >= this.textRunEditor.shapedGlyphs.length
        ) {
            console.log(
                '[GlyphCanvas]',
                'panToGlyph: early return - not in edit mode or invalid index',
                {
                    isGlyphEditMode: this.isGlyphEditMode,
                    glyphIndex,
                    shapedGlyphsLength: this.textRunEditor.shapedGlyphs?.length
                }
            );
            return;
        }

        // Check if we have layer data (needed for bbox calculation)
        if (!this.selectedLayerId || !this.layerData) {
            console.log(
                '[GlyphCanvas]',
                'panToGlyph: no layer data yet, skipping pan'
            );
            return;
        }

        const bounds = this.calculateGlyphBoundingBox();
        if (!bounds) {
            console.log('[GlyphCanvas]', 'panToGlyph: no bounds calculated');
            return;
        }

        const rect = this.canvas.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor._getGlyphPosition(glyphIndex);

        // Delegate to ViewportManager
        this.viewportManager.panToGlyph(
            bounds,
            glyphPosition,
            rect,
            this.render.bind(this)
        );
    }

    async updatePropertiesUI() {
        if (!this.propertiesSection) return;

        // Update editor title bar with glyph name
        this.updateEditorTitleBar();

        // Don't show properties if not in glyph edit mode
        if (!this.isGlyphEditMode) {
            requestAnimationFrame(() => {
                this.propertiesSection.innerHTML = '';
            });
            return;
        }

        if (
            this.textRunEditor.selectedGlyphIndex >= 0 &&
            this.textRunEditor.selectedGlyphIndex <
                this.textRunEditor.shapedGlyphs.length
        ) {
            // Build content off-screen first, then swap in one operation
            const tempContainer = document.createElement('div');
            const oldPropertiesSection = this.propertiesSection;
            this.propertiesSection = tempContainer;

            await this.displayLayersList();

            requestAnimationFrame(() => {
                oldPropertiesSection.innerHTML = '';
                while (tempContainer.firstChild) {
                    oldPropertiesSection.appendChild(tempContainer.firstChild);
                }
            });

            this.propertiesSection = oldPropertiesSection;
        } else {
            // No glyph selected
            requestAnimationFrame(() => {
                this.propertiesSection.innerHTML = '';
                const emptyMessage = document.createElement('div');
                emptyMessage.className = 'editor-empty-message';
                emptyMessage.textContent = 'No glyph selected';
                this.propertiesSection.appendChild(emptyMessage);
            });
        }
    }

    onTextChange() {
        // Debounce font recompilation when text changes
        if (this.textChangeDebounceTimer) {
            clearTimeout(this.textChangeDebounceTimer);
        }

        this.textChangeDebounceTimer = setTimeout(() => {
            if (window.fontManager && window.fontManager.isReady()) {
                console.log(
                    '[GlyphCanvas]',
                    '🔄 Text changed, recompiling editing font...'
                );
                window.fontManager
                    .compileEditingFont(this.textRunEditor.textBuffer)
                    .catch((error) => {
                        console.error(
                            '[GlyphCanvas]',
                            'Failed to recompile editing font:',
                            error
                        );
                    });
            }
        }, this.textChangeDebounceDelay);
    }

    startKeyboardZoom(zoomIn) {
        // Don't start a new animation if one is already in progress
        if (this.zoomAnimation.active) return;

        const settings = window.APP_SETTINGS.OUTLINE_EDITOR;
        const zoomFactor = zoomIn
            ? settings.ZOOM_KEYBOARD_FACTOR
            : 1 / settings.ZOOM_KEYBOARD_FACTOR;

        // Get canvas center for zoom
        const rect = this.canvas.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        // Set up animation
        this.zoomAnimation.active = true;
        this.zoomAnimation.currentFrame = 0;
        this.zoomAnimation.totalFrames = 10;
        this.zoomAnimation.startScale = this.viewportManager.scale;
        this.zoomAnimation.endScale = this.viewportManager.scale * zoomFactor;
        this.zoomAnimation.centerX = centerX;
        this.zoomAnimation.centerY = centerY;

        // Start animation loop
        this.animateKeyboardZoom();
    }

    animateKeyboardZoom() {
        if (!this.zoomAnimation.active) return;

        this.zoomAnimation.currentFrame++;

        // Calculate progress (ease-in-out)
        const progress =
            this.zoomAnimation.currentFrame / this.zoomAnimation.totalFrames;
        const easedProgress =
            progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // Interpolate scale
        const currentScale =
            this.zoomAnimation.startScale +
            (this.zoomAnimation.endScale - this.zoomAnimation.startScale) *
                easedProgress;

        // Apply zoom
        const zoomFactor = currentScale / this.viewportManager.scale;
        this.viewportManager.zoom(
            zoomFactor,
            this.zoomAnimation.centerX,
            this.zoomAnimation.centerY
        );

        // Render
        this.render();

        // Continue or finish animation
        if (this.zoomAnimation.currentFrame < this.zoomAnimation.totalFrames) {
            requestAnimationFrame(() => this.animateKeyboardZoom());
        } else {
            this.zoomAnimation.active = false;
        }
    }

    render() {
        this.renderer.render();
    }

    destroy() {
        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Clean up HarfBuzz resources
        this.textRunEditor.destroyHarfbuzz();

        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    // ==================== Cursor Methods ====================

    onFocus() {
        this.isFocused = true;
        this.cursorVisible = true;
        // Don't render on focus change if in preview mode (no cursor visible)
        if (!this.isPreviewMode) {
            this.render();
        }
    }

    onBlur() {
        this.isFocused = false;
        // Don't render on blur if in preview mode (no cursor visible)
        if (!this.isPreviewMode) {
            this.render();
        }
    }

    onKeyUp(e) {
        console.log(
            '[GlyphCanvas]',
            'onKeyUp called:',
            e.code,
            'isGlyphEditMode:',
            this.isGlyphEditMode,
            'isPreviewMode:',
            this.isPreviewMode
        );
        // Handle space bar release to exit preview mode
        if (e.code === 'Space' && this.isGlyphEditMode && this.isPreviewMode) {
            console.log(
                '[GlyphCanvas]',
                '  -> Exiting preview mode from Space release'
            );
            this.isPreviewMode = false;

            // Check if current axis position matches an exact layer
            this.autoSelectMatchingLayer().then(async () => {
                if (this.selectedLayerId !== null) {
                    // On an exact layer - fetch that layer's data
                    await this.fetchLayerData();
                    this.render();
                } else {
                    // Between layers - need to interpolate
                    if (this.currentGlyphName) {
                        await this.interpolateCurrentGlyph();
                    } else {
                        this.render();
                    }
                }
            });
        } else if (e.code === 'Space') {
            console.log(
                '[GlyphCanvas]',
                '  -> Space released but not exiting preview:',
                'isGlyphEditMode:',
                this.isGlyphEditMode,
                'isPreviewMode:',
                this.isPreviewMode
            );
        }
    }

    onKeyDown(e) {
        // Handle Cmd+Plus/Minus for zoom in/out
        if (
            (e.metaKey || e.ctrlKey) &&
            (e.key === '=' || e.key === '+' || e.key === '-')
        ) {
            e.preventDefault();
            const zoomIn = e.key === '=' || e.key === '+';
            this.startKeyboardZoom(zoomIn);
            return;
        }

        // Handle space bar press to enter preview mode
        if (e.code === 'Space' && this.isGlyphEditMode) {
            e.preventDefault();
            // Only enter preview mode if not already in it (prevents key repeat from re-entering)
            if (!this.isPreviewMode) {
                this.isPreviewMode = true;
                this.render();
            }
            return;
        }

        // Handle Cmd+Enter to enter glyph edit mode at cursor position (text editing mode only)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.key === 'Enter' &&
            !this.isGlyphEditMode
        ) {
            e.preventDefault();
            this.enterGlyphEditModeAtCursor();
            return;
        }

        // Handle cursor navigation and text editing
        // Note: Escape key is handled globally in constructor for better focus handling

        // Handle Cmd+Up/Down to cycle through layers when outline editor is active
        if (
            (e.metaKey || e.ctrlKey) &&
            this.isGlyphEditMode &&
            this.selectedLayerId &&
            this.fontData &&
            this.fontData.layers
        ) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.cycleLayers(e.key === 'ArrowUp');
                return;
            }
        }

        // Handle Cmd+Left/Right to navigate through glyphs in logical order
        // Only when in glyph edit mode but NOT in nested component mode
        if (
            (e.metaKey || e.ctrlKey) &&
            this.isGlyphEditMode &&
            this.componentStack.length === 0
        ) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.isGlyphEditMode && this.componentStack.length == 0) {
                    this.textRunEditor.navigateToPreviousGlyphLogical();
                }
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.textRunEditor.navigateToNextGlyphLogical();
                return;
            }
        }

        // Handle arrow keys for point/anchor/component movement in glyph edit mode
        if (
            this.isGlyphEditMode &&
            this.selectedLayerId &&
            (this.selectedPoints.length > 0 ||
                this.selectedAnchors.length > 0 ||
                this.selectedComponents.length > 0)
        ) {
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

        // Cmd+0 / Ctrl+0 - Frame current glyph (in edit mode) or reset zoom (in text mode)
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault();
            if (
                this.isGlyphEditMode &&
                this.textRunEditor.selectedGlyphIndex >= 0
            ) {
                // In glyph edit mode: frame the current glyph
                this.frameCurrentGlyph();
            } else {
                // In text mode: reset zoom and position
                this.resetZoomAndPosition();
            }
            return;
        }

        // Prevent all other text editing and cursor movement in glyph edit mode
        if (this.isGlyphEditMode) {
            e.preventDefault();
            return;
        }

        // Text run selection and editing shortcuts
        this.textRunEditor.handleKeyDown(e);
    }

    getClickedCursorPosition(e) {
        // Convert click position to cursor position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        let { x: glyphX, y: glyphY } =
            this.viewportManager.getFontSpaceCoordinates(mouseX, mouseY);

        // Check if clicking within cursor height range (same as cursor drawing)
        // Cursor goes from 1000 (top) to -300 (bottom)
        if (glyphY > 1000 || glyphY < -300) {
            return null; // Clicked outside cursor height - allow panning
        }
        return this.textRunEditor.getGlyphIndexAtClick(glyphX, glyphY);
    }

    isCursorVisible() {
        // Check if cursor is within the visible viewport
        const rect = this.canvas.getBoundingClientRect();

        // Transform cursor position from font space to screen space
        const screenX =
            this.textRunEditor.cursorX * this.viewportManager.scale +
            this.viewportManager.panX;

        // Define margin from edges (in screen pixels)
        const margin = 30;

        // Check if cursor is within visible bounds with margin
        return screenX >= margin && screenX <= rect.width - margin;
    }

    panToCursor() {
        // Pan viewport to show cursor with smooth animation
        if (this.isCursorVisible()) {
            return; // Cursor is already visible
        }

        const rect = this.canvas.getBoundingClientRect();
        const margin = 30; // Same margin as visibility check

        // Calculate target panX to center cursor with margin
        const screenX =
            this.textRunEditor.cursorX * this.viewportManager.scale +
            this.viewportManager.panX;

        let targetPanX;
        if (screenX < margin) {
            // Cursor is off left edge - position it at left margin
            targetPanX =
                margin -
                this.textRunEditor.cursorX * this.viewportManager.scale;
        } else {
            // Cursor is off right edge - position it at right margin
            targetPanX =
                rect.width -
                margin -
                this.textRunEditor.cursorX * this.viewportManager.scale;
        }

        // Start animation
        this.viewportManager.animatePan(
            targetPanX,
            this.viewportManager.panY,
            this.render.bind(this)
        );
    }

    resetZoomAndPosition() {
        // Reset zoom to initial scale and position to origin with animation
        const rect = this.canvas.getBoundingClientRect();
        const targetScale = this.initialScale;
        const targetPanX = rect.width / 4; // Same as initial position
        const targetPanY = rect.height / 2; // Same as initial position

        this.viewportManager.animateZoomAndPan(
            targetScale,
            targetPanX,
            targetPanY,
            this.render.bind(this)
        );
    }
}

function initCanvas() {
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
        const axesSection = window.glyphCanvas.axesManager.createAxesSection();
        rightSidebar.appendChild(axesSection);

        // Create OpenType features container (initially empty)
        const featuresSection =
            window.glyphCanvas.featuresManager.createFeaturesSection();
        rightSidebar.appendChild(featuresSection);

        // Store reference to sidebars for later updates
        window.glyphCanvas.leftSidebar = leftSidebar;
        window.glyphCanvas.propertiesSection = propertiesSection;
        window.glyphCanvas.rightSidebar = rightSidebar;
        window.glyphCanvas.axesSection = axesSection;

        // Observe when the editor view gains/loses focus (via 'focused' class)
        const editorView = document.querySelector('#view-editor');
        if (editorView) {
            const updateSidebarStyles = () => {
                const isFocused = editorView.classList.contains('focused');
                const bgColor = isFocused
                    ? 'var(--bg-editor-sidebar)'
                    : 'var(--bg-secondary)';
                leftSidebar.style.backgroundColor = bgColor;
                rightSidebar.style.backgroundColor = bgColor;
            };

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (
                        mutation.type === 'attributes' &&
                        mutation.attributeName === 'class'
                    ) {
                        // Update sidebar styles when focus changes
                        updateSidebarStyles();
                        // Render when focused class changes
                        window.glyphCanvas.render();
                    }
                });
            });
            observer.observe(editorView, {
                attributes: true,
                attributeFilter: ['class']
            });

            // Set initial state
            updateSidebarStyles();
        }

        // Listen for font compilation events
        setupFontLoadingListener();

        // Set up editor shortcuts modal
        setupEditorShortcutsModal();

        console.log('[GlyphCanvas]', 'Glyph canvas initialized');
    } else {
        setTimeout(initCanvas, 100);
    }
}

if (typeof document !== 'undefined' && document.addEventListener) {
    // Initialize when document is ready
    document.addEventListener('DOMContentLoaded', () => {
        // Wait for the editor view to be ready
        initCanvas();
    });
}

// Set up listener for compiled fonts
function setupFontLoadingListener() {
    console.log('[GlyphCanvas]', '🔧 Setting up font loading listeners...');

    // Listen for editing font compiled by font manager (primary)
    window.addEventListener(
        'editingFontCompiled',
        async (/** @type {any} */ e) => {
            console.log(
                '[GlyphCanvas]',
                '✅ Editing font compiled event received'
            );
            console.log('[GlyphCanvas]', '   Event detail:', e.detail);
            console.log(
                '[GlyphCanvas]',
                '   Canvas exists:',
                !!window.glyphCanvas
            );
            if (window.glyphCanvas && e.detail && e.detail.fontBytes) {
                console.log(
                    '[GlyphCanvas]',
                    '   Loading editing font into canvas...'
                );
                const arrayBuffer = e.detail.fontBytes.buffer.slice(
                    e.detail.fontBytes.byteOffset,
                    e.detail.fontBytes.byteOffset +
                        e.detail.fontBytes.byteLength
                );
                window.glyphCanvas.setFont(arrayBuffer);
                console.log(
                    '[GlyphCanvas]',
                    '   ✅ Editing font loaded into canvas'
                );
            } else {
                console.warn(
                    '[GlyphCanvas]',
                    '   ⚠️ Cannot load font - missing canvas or fontBytes'
                );
            }
        }
    );

    // Legacy: Custom event when font is compiled via compile button
    window.addEventListener('fontCompiled', async (/** @type {any} */ e) => {
        console.log('[GlyphCanvas]', 'Font compiled event received (legacy)');
        if (window.glyphCanvas && e.detail && e.detail.ttfBytes) {
            const arrayBuffer = e.detail.ttfBytes.buffer.slice(
                e.detail.ttfBytes.byteOffset,
                e.detail.ttfBytes.byteOffset + e.detail.ttfBytes.byteLength
            );
            window.glyphCanvas.setFont(arrayBuffer);
        }
    });

    // Also check for fonts loaded from file system
    window.addEventListener('fontLoaded', async (e) =>
        window.fontManager
            .onFontLoaded(e)
            .then((arrayBuffer) => window.glyphCanvas.setFont(arrayBuffer))
    );
}

// Set up editor keyboard shortcuts info modal
function setupEditorShortcutsModal() {
    const infoButton = document.getElementById('editor-info-btn');
    const modal = document.getElementById('editor-shortcuts-modal');
    const closeBtn = document.getElementById(
        'editor-shortcuts-modal-close-btn'
    );

    if (!infoButton || !modal || !closeBtn) return;

    // Open modal
    infoButton.addEventListener('click', (event) => {
        event.stopPropagation();
        modal.style.display = 'flex';
    });

    // Close modal
    const closeModal = () => {
        modal.style.display = 'none';
        // Restore focus to canvas if editor view was active
        const editorView = document.getElementById('view-editor');
        if (
            editorView &&
            editorView.classList.contains('focused') &&
            window.glyphCanvas &&
            window.glyphCanvas.canvas
        ) {
            setTimeout(() => window.glyphCanvas.canvas.focus(), 0);
        }
    };

    closeBtn.addEventListener('click', closeModal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            e.preventDefault();
            e.stopPropagation();
            closeModal();
        }
    });
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GlyphCanvas };
}
