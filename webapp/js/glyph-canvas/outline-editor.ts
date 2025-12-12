import { LayerDataNormalizer } from '../layer-data-normalizer';
import { fontInterpolation } from '../font-interpolation';
import { GlyphCanvas } from '../glyph-canvas';
import fontManager from '../font-manager';
import { PythonBabelfont } from '../pythonbabelfont';
import { Transform } from '../basictypes';
import { Logger } from '../logger';

let console: Logger = new Logger('OutlineEditor', true);

type Point = { contourIndex: number; nodeIndex: number };

export type ComponentStackItem = {
    componentIndex: number;
    transform: number[];
    layerData: PythonBabelfont.Layer | null;
    selectedPoints: Point[];
    selectedAnchors: number[];
    selectedComponents: number[];
    glyphName: string; // The glyph name of the context we're leaving (for breadcrumb)
    editingGlyphName: string; // The glyph name of the component we're entering (for saving)
};

// Recursively parse nodes in component layer data (including nested components)
const parseComponentNodes = (shapes: PythonBabelfont.Shape[]) => {
    if (!shapes) return;

    shapes.forEach((shape) => {
        // Parse nodes in Path shapes
        if ('Path' in shape && shape.Path.nodes) {
            // Parse if string, replace in place so object model and renderer share same reference
            if (typeof shape.Path.nodes === 'string') {
                (shape.Path.nodes as any) = LayerDataNormalizer.parseNodes(
                    shape.Path.nodes
                );
            }
            // Reference the same array (not a copy) so modifications propagate
            (shape as any).nodes = shape.Path.nodes;
        }

        // Recursively parse nested component data
        if (
            'Component' in shape &&
            shape.Component.layerData &&
            shape.Component.layerData.shapes
        ) {
            parseComponentNodes(shape.Component.layerData.shapes);
        }
    });
};

export class OutlineEditor {
    active: boolean = false;
    isPreviewMode: boolean = false;
    previewModeBeforeSlider: boolean = false;
    spaceKeyPressed: boolean = false;
    isDraggingPoint: boolean = false;
    isDraggingComponent: boolean = false;
    isDraggingAnchor: boolean = false;
    currentGlyphName: string | null = null;
    glyphCanvas: GlyphCanvas;

    selectedAnchors: number[] = [];
    selectedPoints: Point[] = [];
    selectedComponents: number[] = [];
    hoveredPointIndex: Point | null = null;
    hoveredAnchorIndex: number | null = null;
    hoveredComponentIndex: number | null = null;
    hoveredGlyphIndex: number = -1;
    editingComponentIndex: number | null = null;
    selectedPointIndex: any = null;

    layerDataDirty: boolean = false;
    componentStack: ComponentStackItem[] = [];
    interpolatedComponentTransform: number[] | null = null; // Interpolated transform when in component editing mode
    previousSelectedLayerId: string | null = null;
    previousVariationSettings: Record<string, number> | null = null;
    layerData: PythonBabelfont.Layer | null = null;
    targetLayerData: PythonBabelfont.Layer | null = null;
    selectedLayerId: string | null = null;
    isInterpolating: boolean = false;
    isLayerSwitchAnimating: boolean = false;
    currentInterpolationId: number = 0; // Counter to track and cancel old interpolations
    lastGlyphX: number | null = null;
    lastGlyphY: number | null = null;
    canvas: HTMLCanvasElement | null = null;

    // Auto-panning properties to keep glyph centered during animation
    autoPanAnchorScreen: { x: number; y: number } | null = null; // Screen coordinates of bbox center before animation
    autoPanEnabled: boolean = true; // Can be toggled by user preference

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
    }

    clearState() {
        this.layerData = null;
        this.selectedPoints = [];
        this.hoveredPointIndex = null;
        this.isDraggingPoint = false;
        this.layerDataDirty = false;
    }

    popState(previousState: ComponentStackItem) {
        this.selectedPoints = previousState.selectedPoints || [];
        this.selectedAnchors = previousState.selectedAnchors || [];
        this.selectedComponents = previousState.selectedComponents || [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;
    }

    clearAllSelections() {
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;
    }

    saveState(
        componentIndex: number,
        transform: number[],
        glyphName: string,
        editingGlyphName: string
    ): ComponentStackItem {
        return {
            componentIndex,
            transform,
            layerData: this.layerData,
            selectedPoints: this.selectedPoints,
            selectedAnchors: this.selectedAnchors,
            selectedComponents: this.selectedComponents,
            glyphName,
            editingGlyphName
        };
    }

    onMetaKeyReleased() {
        // Exit preview mode when Cmd is released if we're in preview mode
        // This handles the case where Space keyup doesn't fire due to browser/OS issues

        if (!this.active) return;
        console.log('  -> Exiting preview mode on Cmd release');
        this.isPreviewMode = false;
        this.spaceKeyPressed = false; // Also reset Space state since keyup might not fire
        this.glyphCanvas.render();
    }
    onEscapeKey(e: KeyboardEvent) {
        if (!this.active) return;

        // Check if editor view is focused
        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            editorView && editorView.classList.contains('focused');

        if (!isEditorFocused) {
            return; // Don't handle Escape if editor view is not focused
        }

        e.preventDefault();

        console.log('Escape pressed. Previous state:', {
            layerId: this.previousSelectedLayerId,
            settings: this.previousVariationSettings,
            componentStackDepth: this.componentStack.length
        });

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
                    'Already on previous layer, clearing state and continuing to exit'
                );
                this.previousSelectedLayerId = null;
                this.previousVariationSettings = null;
                // Don't return - fall through to exit component or edit mode
            } else {
                console.log('Restoring previous layer state');
                // Restore previous layer selection and axis values
                this.selectedLayerId = this.previousSelectedLayerId;

                // Fetch layer data for the restored layer
                this.fetchLayerData().then(() => {
                    // Update layer selection UI
                    this.updateLayerSelection();

                    // Render with restored layer data
                    this.glyphCanvas.render();
                });

                // Restore axis values with animation
                this.glyphCanvas.axesManager!._setupAnimation({
                    ...this.previousVariationSettings
                });

                // Clear previous state
                this.previousSelectedLayerId = null;
                this.previousVariationSettings = null;

                // Return focus to canvas
                this.canvas!.focus();
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
        this.glyphCanvas.exitGlyphEditMode();
    }

    restoreFocus() {
        // Only restore focus when in editor mode
        if (!this.active) return;
        // Use setTimeout to allow the click event to complete first
        // (e.g., slider interaction, button click)
        setTimeout(() => {
            this.canvas!.focus();
        }, 0);
    }

    onSliderMouseDown() {
        if (!this.active) return;
        // Remember if preview was already on (from keyboard toggle)
        this.previewModeBeforeSlider = this.isPreviewMode;

        // Set interpolating flag (don't change preview mode)
        this.isInterpolating = true;

        // Capture anchor point for auto-panning
        this.captureAutoPanAnchor();

        // If not in preview mode, mark current layer data as interpolated and render
        // to show monochrome visual feedback immediately
        if (!this.isPreviewMode && this.layerData) {
            this.layerData.isInterpolated = true;
            this.glyphCanvas.render();
        }
    }

    async onSliderMouseUp() {
        if (this.active && this.isPreviewMode) {
            // Only exit preview mode if we entered it via slider
            // If it was already on (from keyboard), keep it on
            const shouldExitPreview = !this.previewModeBeforeSlider;

            if (shouldExitPreview) {
                this.isPreviewMode = false;
            }

            // Check if we're on an exact layer
            await this.autoSelectMatchingLayer();

            // Note: Don't clear isInterpolating here - let it stay true until animation completes
            // so auto-panning continues working. It will be cleared in animationComplete handler.
            fontInterpolation.resetRequestTracking();

            // If we landed on an exact layer, update the saved state to this new layer
            // so Escape will return here, not to the original layer
            if (this.selectedLayerId) {
                this.previousSelectedLayerId = this.selectedLayerId;
                this.previousVariationSettings = {
                    ...this.glyphCanvas.axesManager!.variationSettings
                };
                console.log('Updated previous state to new layer:', {
                    layerId: this.previousSelectedLayerId,
                    settings: this.previousVariationSettings
                });
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

            // Clear flags only if animation is already complete
            // (If still animating, animationComplete handler will clear them)
            if (!this.glyphCanvas.axesManager!.isAnimating) {
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            }

            // Always render to update colors after clearing isInterpolating flag
            this.glyphCanvas.render();
        } else if (this.active) {
            this.isPreviewMode = false;

            // Check if we're on an exact layer
            await this.autoSelectMatchingLayer();

            // Note: Don't clear isInterpolating here - let it stay true until animation completes
            // so auto-panning continues working. It will be cleared in animationComplete handler.
            fontInterpolation.resetRequestTracking();

            // If we landed on an exact layer, update the saved state to this new layer
            // so Escape will return here, not to the original layer
            if (this.selectedLayerId) {
                this.previousSelectedLayerId = this.selectedLayerId;
                this.previousVariationSettings = {
                    ...this.glyphCanvas.axesManager!.variationSettings
                };
                console.log('Updated previous state to new layer:', {
                    layerId: this.previousSelectedLayerId,
                    settings: this.previousVariationSettings
                });
                await this.fetchLayerData();
            }

            // If no exact layer match, keep showing interpolated data

            // Clear flags only if animation is already complete
            // (If still animating, animationComplete handler will clear them)
            if (!this.glyphCanvas.axesManager!.isAnimating) {
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            }

            this.glyphCanvas.render();
            // Restore focus to canvas
            setTimeout(() => this.canvas!.focus(), 0);
        }
    }

    // Real-time interpolation during slider movement
    // Skip interpolation if in preview mode (HarfBuzz handles interpolation)
    onSliderChange(axisTag: string, value: number) {
        // Save current state before manual adjustment (only once per manual session)
        if (
            this.selectedLayerId !== null &&
            this.previousSelectedLayerId === null
        ) {
            this.previousSelectedLayerId = this.selectedLayerId;
            this.previousVariationSettings = {
                ...this.glyphCanvas.axesManager!.variationSettings
            };
            console.log('Saved previous state for Escape:', {
                layerId: this.previousSelectedLayerId,
                settings: this.previousVariationSettings
            });
            this.selectedLayerId = null; // Deselect layer
            // Don't update layer selection UI during interpolation to avoid triggering render
            if (!this.isInterpolating) {
                this.updateLayerSelection();
            }
        }
        if (
            this.active &&
            this.isInterpolating &&
            !this.isPreviewMode &&
            this.currentGlyphName
        ) {
            this.interpolateCurrentGlyph();
        }
    }

    animationInProgress() {
        // Interpolate during both slider dragging AND layer switch animations
        console.log('[OutlineEditor] animationInProgress called:', {
            active: this.active,
            hasGlyphName: !!this.currentGlyphName,
            isInterpolating: this.isInterpolating,
            isLayerSwitchAnimating: this.isLayerSwitchAnimating
        });
        if (this.active && this.currentGlyphName) {
            if (this.isInterpolating || this.isLayerSwitchAnimating) {
                // Interpolate at current position for smooth animation
                console.log(
                    '[OutlineEditor] Calling interpolateCurrentGlyph from animationInProgress'
                );
                this.interpolateCurrentGlyph();

                // Apply auto-pan adjustment to keep glyph centered
                this.applyAutoPanAdjustment();
            }
        }
    }

    onDoubleClick(e: MouseEvent) {
        console.log(
            'Double-click detected. isGlyphEditMode:',
            this.active,
            'selectedLayerId:',
            this.selectedLayerId,
            'hoveredComponentIndex:',
            this.hoveredComponentIndex
        );
        if (!this.active || !this.selectedLayerId) return;
        // Double-click on component - enter component editing (without selecting it)
        if (this.hoveredComponentIndex !== null) {
            console.log(
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
        if (this.hoveredGlyphIndex >= 0) {
            this.glyphCanvas.doubleClickOnGlyph(this.hoveredGlyphIndex);
        }
    }

    onSingleClick(e: MouseEvent) {
        if (
            !this.active ||
            !this.selectedLayerId ||
            !this.layerData ||
            this.isPreviewMode
        )
            return;

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
                    this.selectedComponents.push(this.hoveredComponentIndex);
                }
                this.glyphCanvas.render();
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
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null;
                this.lastGlyphY = null;
                this.glyphCanvas.render();
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
                this.glyphCanvas.render();
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
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null; // Reset for delta calculation
                this.lastGlyphY = null;
                this.glyphCanvas.render();
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
                            this.hoveredPointIndex!.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex!.nodeIndex
                );
                if (existingIndex >= 0) {
                    // Remove from selection
                    this.selectedPoints.splice(existingIndex, 1);
                } else {
                    // Add to selection
                    this.selectedPoints.push({ ...this.hoveredPointIndex });
                }
                this.glyphCanvas.render();
            } else {
                // Check if clicked point is already in selection
                const isInSelection = this.selectedPoints.some(
                    (p) =>
                        p.contourIndex ===
                            this.hoveredPointIndex!.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex!.nodeIndex
                );

                if (!isInSelection) {
                    // Regular click on unselected point: select only this point, clear anchors
                    this.selectedPoints = [{ ...this.hoveredPointIndex }];
                    this.selectedAnchors = []; // Clear anchor selection
                }
                // If already in selection, keep all selected points and anchors

                // Start dragging (all selected points and anchors)
                this.isDraggingPoint = true;
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null; // Reset for delta calculation
                this.lastGlyphY = null;
                this.glyphCanvas.render();
            }
            return; // Don't start canvas panning
        } else if (!e.shiftKey) {
            // Clicked on empty space without shift: clear selection
            this.selectedPoints = [];
            this.selectedAnchors = [];
            this.selectedComponents = [];
            this.glyphCanvas.render();
        }
    }

    onMouseMove(e: MouseEvent) {
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
    }

    _handleDrag(e: MouseEvent): void {
        const rect = this.canvas!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        const { glyphX, glyphY } = this.glyphCanvas.toGlyphLocal(
            mouseX,
            mouseY
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

        this.glyphCanvas.render();
    }

    _updateDraggedPoints(deltaX: number, deltaY: number): void {
        if (!this.layerData) return;

        // Build a set of selected point identifiers to avoid moving them twice
        const selectedPointKeys = new Set(
            this.selectedPoints.map(
                ({ contourIndex, nodeIndex }) => `${contourIndex}:${nodeIndex}`
            )
        );

        // Process each selected point
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = this.layerData.shapes[contourIndex];
            if (!contour || !('nodes' in contour)) continue;

            const nodes = contour.nodes;
            const node = nodes[nodeIndex];
            if (!node) continue;

            // If this is a curve point, remove its handles from selection (we'll move them together)
            if (node.type === 'c' || node.type === 'cs') {
                const prevIndex = (nodeIndex - 1 + nodes.length) % nodes.length;
                const nextIndex = (nodeIndex + 1) % nodes.length;
                const prevNode = nodes[prevIndex];
                const nextNode = nodes[nextIndex];

                if (prevNode?.type === 'o') {
                    selectedPointKeys.delete(`${contourIndex}:${prevIndex}`);
                }
                if (nextNode?.type === 'o') {
                    selectedPointKeys.delete(`${contourIndex}:${nextIndex}`);
                }
            }
        }

        // Move the selected nodes
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const key = `${contourIndex}:${nodeIndex}`;
            if (!selectedPointKeys.has(key)) continue; // Skip if removed above

            const contour = this.layerData.shapes[contourIndex];
            if (!contour || !('nodes' in contour)) continue;

            const nodes = contour.nodes;
            const node = nodes[nodeIndex];
            if (!node) continue;

            node.x += deltaX;
            node.y += deltaY;

            // If this is a curve point, move its handles together
            if (node.type === 'c' || node.type === 'cs') {
                const prevIndex = (nodeIndex - 1 + nodes.length) % nodes.length;
                const nextIndex = (nodeIndex + 1) % nodes.length;
                const prevNode = nodes[prevIndex];
                const nextNode = nodes[nextIndex];

                if (prevNode?.type === 'o') {
                    prevNode.x += deltaX;
                    prevNode.y += deltaY;
                }
                if (nextNode?.type === 'o') {
                    nextNode.x += deltaX;
                    nextNode.y += deltaY;
                }
            }
        }

        // Handle smooth curve constraint for single offcurve dragging
        if (this.selectedPoints.length === 1) {
            const { contourIndex, nodeIndex } = this.selectedPoints[0];
            const contour = this.layerData.shapes[contourIndex];
            if (contour && 'nodes' in contour) {
                const nodes = contour.nodes;
                const offcurve = nodes[nodeIndex];

                if (offcurve?.type === 'o') {
                    // Find the associated curve point and the other handle
                    const nextIndex = (nodeIndex + 1) % nodes.length;
                    const prevIndex =
                        (nodeIndex - 1 + nodes.length) % nodes.length;
                    const nextNode = nodes[nextIndex];
                    const prevNode = nodes[prevIndex];

                    let curvePoint: PythonBabelfont.Node | null = null;
                    let otherHandleIndex = -1;

                    if (
                        nextNode &&
                        (nextNode.type === 'c' || nextNode.type === 'cs')
                    ) {
                        curvePoint = nextNode;
                        const afterCurve = (nextIndex + 1) % nodes.length;
                        if (
                            afterCurve !== nodeIndex &&
                            nodes[afterCurve]?.type === 'o'
                        ) {
                            otherHandleIndex = afterCurve;
                        }
                    } else if (
                        prevNode &&
                        (prevNode.type === 'c' || prevNode.type === 'cs')
                    ) {
                        curvePoint = prevNode;
                        const beforeCurve =
                            (prevIndex - 1 + nodes.length) % nodes.length;
                        if (
                            beforeCurve !== nodeIndex &&
                            nodes[beforeCurve]?.type === 'o'
                        ) {
                            otherHandleIndex = beforeCurve;
                        }
                    }

                    // If we found a smooth curve point and the other handle, move it symmetrically
                    if (curvePoint && otherHandleIndex >= 0) {
                        const otherHandle = nodes[otherHandleIndex];
                        const dx = offcurve.x - curvePoint.x;
                        const dy = offcurve.y - curvePoint.y;
                        otherHandle.x = curvePoint.x - dx;
                        otherHandle.y = curvePoint.y - dy;
                    }
                }
            }
        }
    }

    _updateDraggedAnchors(deltaX: number, deltaY: number): void {
        let anchors = this.layerData!.anchors || [];
        for (const anchorIndex of this.selectedAnchors) {
            const anchor = anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }
    }

    _updateDraggedComponents(deltaX: number, deltaY: number): void {
        for (const compIndex of this.selectedComponents) {
            const shape = this.layerData!.shapes[compIndex];
            if (shape && 'Component' in shape) {
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

    onMouseUp(e: MouseEvent): void {
        this.isDraggingPoint = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
    }

    get draggingSomething() {
        return (
            this.active &&
            (this.isDraggingPoint ||
                this.isDraggingAnchor ||
                this.isDraggingComponent)
        );
    }

    // In outline editor mode, check for hovered components, anchors and points first (unless in preview mode), then other glyphs
    performHitDetection(e: MouseEvent | null): void {
        if (
            !(
                this.active &&
                this.selectedLayerId &&
                this.layerData &&
                !this.isPreviewMode
            )
        )
            return;

        this.updateHoveredComponent();
        this.updateHoveredAnchor();
        this.updateHoveredPoint();
    }

    cursorStyle(): string | null {
        if (!this.active) return null;
        if (
            this.selectedLayerId &&
            this.layerData &&
            !this.isPreviewMode &&
            (this.hoveredComponentIndex !== null ||
                this.hoveredPointIndex ||
                this.hoveredAnchorIndex !== null)
        ) {
            this.canvas!.style.cursor = 'pointer';
        } else {
            this.canvas!.style.cursor = 'default';
        }
        return null;
    }

    _findHoveredItem<T, U>(
        items: T[],
        getCoords: (item: T) => { x: number; y: number } | null,
        getValue: (item: T) => U,
        hitRadius: number = 10
    ): U | null {
        if (!this.layerData || !items) {
            return null;
        }
        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const scaledHitRadius =
            hitRadius / this.glyphCanvas.viewportManager!.scale;

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

    updateHoveredComponent(): void {
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        // First, check for hovering near component origins, which take priority.
        const components = this.layerData.shapes
            .map((shape: PythonBabelfont.Shape, index: number) => ({
                shape,
                index
            }))
            .filter(
                (item: { shape: PythonBabelfont.Shape; index: number }) =>
                    'Component' in item.shape
            );

        const getComponentOrigin = (item: {
            shape: PythonBabelfont.Shape;
            index: number;
        }) => {
            const transform = ('Component' in item.shape &&
                item.shape.Component.transform) || [1, 0, 0, 1, 0, 0];
            return { x: transform[4] || 0, y: transform[5] || 0 };
        };

        let foundComponentIndex: number | null = this._findHoveredItem(
            components,
            getComponentOrigin,
            (item) => item.index,
            20 // Larger hit radius for origin marker
        );

        // If no origin was hovered, proceed with path-based hit testing.
        if (foundComponentIndex === null) {
            const { glyphX, glyphY } = this.transformMouseToComponentSpace();

            for (let index = 0; index < this.layerData.shapes.length; index++) {
                const shape = this.layerData.shapes[index];
                if (
                    'Component' in shape &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    if (this._isPointInComponent(shape, glyphX, glyphY)) {
                        foundComponentIndex = index;
                    }
                }
            }
        }

        if (foundComponentIndex !== this.hoveredComponentIndex) {
            this.hoveredComponentIndex = foundComponentIndex;
            this.glyphCanvas.render();
        }
    }

    _isPointInComponent(
        shape: PythonBabelfont.Shape,
        glyphX: number,
        glyphY: number
    ): boolean {
        const transform =
            'Component' in shape && shape.Component.transform
                ? shape.Component.transform
                : [1, 0, 0, 1, 0, 0];

        // Ensure transform is always an array with 6 elements
        const transformArray: Transform = (
            Array.isArray(transform) && transform.length >= 6
                ? transform
                : [1, 0, 0, 1, 0, 0]
        ) as Transform;

        const checkShapesRecursive = (
            shapes: PythonBabelfont.Shape[],
            parentTransform: Transform = [1, 0, 0, 1, 0, 0]
        ): boolean => {
            for (const componentShape of shapes) {
                if ('Component' in componentShape) {
                    const nestedTransform = componentShape.Component
                        .transform || [1, 0, 0, 1, 0, 0];
                    const nestedTransformArray: Transform = (
                        Array.isArray(nestedTransform) &&
                        nestedTransform.length >= 6
                            ? nestedTransform
                            : [1, 0, 0, 1, 0, 0]
                    ) as Transform;
                    const combinedTransform: Transform = [
                        parentTransform[0] * nestedTransformArray[0] +
                            parentTransform[2] * nestedTransformArray[1],
                        parentTransform[1] * nestedTransformArray[0] +
                            parentTransform[3] * nestedTransformArray[1],
                        parentTransform[0] * nestedTransformArray[2] +
                            parentTransform[2] * nestedTransformArray[3],
                        parentTransform[1] * nestedTransformArray[2] +
                            parentTransform[3] * nestedTransformArray[3],
                        parentTransform[0] * nestedTransformArray[4] +
                            parentTransform[2] * nestedTransformArray[5] +
                            parentTransform[4],
                        parentTransform[1] * nestedTransformArray[4] +
                            parentTransform[3] * nestedTransformArray[5] +
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

                if (
                    'nodes' in componentShape &&
                    componentShape.nodes.length > 0
                ) {
                    const isInPath = this.glyphCanvas.isPointInComponent(
                        componentShape,
                        transformArray,
                        parentTransform,
                        glyphX,
                        glyphY
                    );
                    if (isInPath) return true;
                }
            }
            return false;
        };

        if (!('Component' in shape)) {
            return false;
        }

        return checkShapesRecursive(shape.Component.layerData!.shapes);
    }

    updateHoveredAnchor(): void {
        if (!this.layerData || !this.layerData.anchors) {
            return;
        }

        const foundAnchorIndex = this._findHoveredItem(
            this.layerData.anchors.map(
                (anchor: PythonBabelfont.Anchor, index: number) => ({
                    ...anchor,
                    index
                })
            ),
            (item) => ({ x: item.x, y: item.y }),
            (item) => item.index
        );

        if (foundAnchorIndex !== this.hoveredAnchorIndex) {
            this.hoveredAnchorIndex = foundAnchorIndex;
            this.glyphCanvas.render();
        }
    }

    updateHoveredPoint(): void {
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        const points = this.layerData.shapes.flatMap(
            (shape: PythonBabelfont.Shape, contourIndex: number) => {
                if (!('nodes' in shape)) return [];
                return shape.nodes.map(
                    (node: PythonBabelfont.Node, nodeIndex: number) => ({
                        node,
                        contourIndex,
                        nodeIndex
                    })
                );
            }
        );

        const foundPoint = this._findHoveredItem(
            points,
            (item) => ({ x: item.node.x, y: item.node.y }),
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
            this.glyphCanvas.render();
        }
    }

    onGlyphSelected() {
        // Perform mouse hit detection for objects at current mouse position
        if (this.active && this.selectedLayerId && this.layerData) {
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
        }
    }

    moveSelectedPoints(deltaX: number, deltaY: number): void {
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
            if (shape && 'nodes' in shape && shape.nodes[nodeIndex]) {
                shape.nodes[nodeIndex].x += deltaX;
                shape.nodes[nodeIndex].y += deltaY;
            }
        }

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.glyphCanvas.render();
    }

    moveSelectedAnchors(deltaX: number, deltaY: number): void {
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
        this.glyphCanvas.render();
    }

    moveSelectedComponents(deltaX: number, deltaY: number): void {
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
            if (shape && 'Component' in shape) {
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
        this.glyphCanvas.render();
    }

    togglePointSmooth(pointIndex: Point): void {
        // Toggle smooth state of a point
        if (!this.layerData || !this.layerData.shapes) {
            return;
        }

        const { contourIndex, nodeIndex } = pointIndex;
        const shape = this.layerData.shapes[contourIndex];

        if (!shape || !('nodes' in shape) || !shape.nodes[nodeIndex]) {
            return;
        }

        const node = shape.nodes[nodeIndex];
        const { type } = node;

        // Toggle smooth state based on current type
        let newType = {
            c: 'cs',
            cs: 'c',
            q: 'qs',
            qs: 'q',
            l: 'ls',
            ls: 'l',
            o: 'o'
        }[type] as PythonBabelfont.NodeType;

        node.type = newType;

        // Save (non-blocking)
        this.saveLayerData();
        this.glyphCanvas.render();

        console.log(`Toggled point smooth: ${type} -> ${newType}`);
    }

    onSpaceKeyReleased() {
        if (!this.active || !this.isPreviewMode) return;
        this.spaceKeyPressed = false;
        console.log('  -> Exiting preview mode from Space release');
        this.isPreviewMode = false;

        // Check if current axis position matches an exact layer
        this.autoSelectMatchingLayer().then(async () => {
            if (this.selectedLayerId !== null) {
                // On an exact layer - fetch that layer's data
                await this.fetchLayerData();
                this.glyphCanvas.render();
            } else {
                // Between layers - need to interpolate
                if (this.currentGlyphName) {
                    await this.interpolateCurrentGlyph();
                } else {
                    this.glyphCanvas.render();
                }
            }
        });
    }

    onBlur() {
        this.spaceKeyPressed = false;
        this.isDraggingPoint = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        // Exit preview mode if active
        if (this.isPreviewMode) {
            this.isPreviewMode = false;
            this.glyphCanvas.render();
        }
    }

    async interpolateCurrentGlyph(force: boolean = false): Promise<void> {
        // Interpolate the current glyph at current variation settings
        if (!this.currentGlyphName) {
            console.log('[OutlineEditor] Skipping interpolation:', {
                hasGlyphName: !!this.currentGlyphName
            });
            return;
        }

        // Allow interpolation during active interpolation OR layer switch animation
        // Unless force=true (e.g., entering edit mode at interpolated position)
        if (!force && !this.isInterpolating && !this.isLayerSwitchAnimating) {
            console.log(
                '[OutlineEditor] Skipping interpolation - not in active interpolation state'
            );
            return;
        }

        // Increment counter and capture it locally - this invalidates all previous calls
        const myInterpolationId = ++this.currentInterpolationId;
        console.log(
            '[OutlineEditor] Starting interpolation',
            myInterpolationId
        );

        try {
            const location = this.glyphCanvas.axesManager!.variationSettings;
            let interpolatedLayer;

            // When in component editing mode, interpolate the component and extract its transform from the parent
            if (this.componentStack.length > 0) {
                // Interpolate the component itself (gives us the shapes)
                interpolatedLayer = await fontInterpolation.interpolateGlyph(
                    this.currentGlyphName,
                    location
                );

                // Check if we've been superseded by a newer interpolation call
                if (myInterpolationId !== this.currentInterpolationId) {
                    console.log(
                        '[OutlineEditor] 🚫 Aborting stale interpolation',
                        myInterpolationId,
                        '(current is',
                        this.currentInterpolationId,
                        ')'
                    );
                    return;
                }

                // Also interpolate the parent to get the interpolated component reference transform
                const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
                const parentLayer = await fontInterpolation.interpolateGlyph(
                    rootGlyphName,
                    location
                );

                // Check again after second await
                if (myInterpolationId !== this.currentInterpolationId) {
                    console.log(
                        '[OutlineEditor] 🚫 Aborting stale interpolation',
                        myInterpolationId,
                        '(current is',
                        this.currentInterpolationId,
                        ')'
                    );
                    return;
                }

                // Extract the interpolated transform for this component
                this.interpolatedComponentTransform =
                    this.extractComponentTransformFromInterpolatedLayer(
                        parentLayer,
                        this.componentStack
                    );
            } else {
                // Not in component mode - interpolate directly
                interpolatedLayer = await fontInterpolation.interpolateGlyph(
                    this.currentGlyphName,
                    location
                );

                // Check if we've been superseded by a newer interpolation call
                if (myInterpolationId !== this.currentInterpolationId) {
                    console.log(
                        '[OutlineEditor] 🚫 Aborting stale interpolation',
                        myInterpolationId,
                        '(current is',
                        this.currentInterpolationId,
                        ')'
                    );
                    return;
                }
            }

            // Final check before rendering
            if (myInterpolationId !== this.currentInterpolationId) {
                console.log(
                    '[OutlineEditor] 🚫 Aborting stale interpolation',
                    myInterpolationId,
                    '(current is',
                    this.currentInterpolationId,
                    ')'
                );
                return;
            }

            console.log(
                '[OutlineEditor] ✅ Rendering interpolation',
                myInterpolationId
            );

            // Apply interpolated data using normalizer
            console.log(
                '[OutlineEditor] Calling LayerDataNormalizer.applyInterpolatedLayer...'
            );
            console.log(
                '[OutlineEditor] Before applyInterpolatedLayer - layerData.width:',
                this.layerData?.width
            );
            LayerDataNormalizer.applyInterpolatedLayer(
                this,
                interpolatedLayer,
                location
            );
            console.log(
                '[OutlineEditor] After applyInterpolatedLayer - layerData.width:',
                this.layerData?.width
            );

            // Render with the new interpolated data
            console.log(
                '[OutlineEditor] About to render with layerData.width:',
                this.layerData?.width
            );
            this.glyphCanvas.render();
            console.log(
                '[OutlineEditor] After render - layerData.width:',
                this.layerData?.width
            );

            console.log(
                `[OutlineEditor] ✅ Applied interpolated layer for "${this.currentGlyphName}"`
            );
        } catch (error: any) {
            // Silently ignore cancellation errors
            if (error.message && error.message.includes('cancelled')) {
                console.log(
                    '[OutlineEditor] 🚫 Interpolation cancelled (newer request pending)'
                );
                return;
            }

            console.warn(
                `[OutlineEditor] ⚠️ Interpolation failed for "${this.currentGlyphName}":`,
                error
            );
            // On error, keep showing whatever data we have
        }
    }

    onKeyDown(e: KeyboardEvent) {
        if (!this.active) return;
        // Handle space bar press to enter preview mode
        if (e.code === 'Space') {
            e.preventDefault();
            this.spaceKeyPressed = true;
            // Only enter preview mode if not already in it (prevents key repeat from re-entering)
            if (!this.isPreviewMode) {
                this.isPreviewMode = true;
                this.glyphCanvas.render();
            }
            return;
        }

        // Handle Cmd+Left/Right to navigate through glyphs in logical order
        // Only when in glyph edit mode but NOT in nested component mode
        if ((e.metaKey || e.ctrlKey) && this.componentStack.length === 0) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.active && this.componentStack.length == 0) {
                    this.glyphCanvas.textRunEditor!.navigateToPreviousGlyphLogical();
                }
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.glyphCanvas.textRunEditor!.navigateToNextGlyphLogical();
                return;
            }
        }

        // Handle Cmd+Up/Down to cycle through layers
        if ((e.metaKey || e.ctrlKey) && this.selectedLayerId) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.cycleLayers(e.key === 'ArrowUp');
                return;
            }
        }

        // Handle arrow keys for point/anchor/component movement
        if (
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
    }

    async cycleLayers(moveUp: boolean): Promise<void> {
        let sortedLayers = this.glyphCanvas.getSortedLayers();
        if (sortedLayers.length === 0) {
            return;
        }
        // Cycle through layers with Cmd+Up (previous) or Cmd+Down (next)
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

    async selectLayer(layer: PythonBabelfont.Layer): Promise<void> {
        // Select a layer and update axis sliders to match its master location
        // Clear previous state when explicitly selecting a layer
        this.previousSelectedLayerId = null;
        this.previousVariationSettings = null;

        console.log(
            `[OutlineEditor] selectLayer called with layer:`,
            layer,
            `id: ${layer.id}, _master: ${layer._master}`
        );
        this.selectedLayerId = layer.id!;

        // Capture anchor point before layer switch animation begins
        this.captureAutoPanAnchor();

        // Immediately clear interpolated flag on existing data
        // to prevent rendering with monochrome colors
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }
        let masters: PythonBabelfont.Master[] =
            this.glyphCanvas.fontData.masters;
        console.log(`Selected layer: ${layer.name} (ID: ${layer.id})`);
        console.log('Layer data:', layer);
        console.log('Available masters:', masters);

        // Store current layer data before fetching new one (for animation)
        const oldLayerData = this.layerData;

        // Fetch layer data now and store as target for animation
        // This ensures new outlines are ready before animation starts
        // Skip rendering to prevent flicker - animation will handle first render
        await this.fetchLayerData(true);

        // If we're in edit mode, set up animation state
        // Move the NEW layer data to targetLayerData and restore OLD layer data
        // so the animation interpolates FROM old TO new
        if (this.active && this.layerData) {
            this.targetLayerData = this.layerData;
            this.layerData = oldLayerData;
            this.isLayerSwitchAnimating = true;
            console.log(
                'Starting layer switch animation - old layer in layerData, new layer in targetLayerData'
            );
        }
        // Perform mouse hit detection after layer data is loaded
        this.performHitDetection(null);

        // Find the master for this layer
        const master = masters.find((m) => m.id === layer._master);
        if (!master || !master.location) {
            console.warn('No master location found for layer', {
                layer_master: layer._master,
                available_master_ids: masters.map((m) => m.id),
                master_found: master
            });
            return;
        }

        console.log(`Setting axis values to master location:`, master.location);

        // Set up animation to all axes at once
        const newSettings: Record<string, number> = {};
        for (const [axisTag, value] of Object.entries(master.location)) {
            newSettings[axisTag] = value as number;
        }
        this.glyphCanvas.axesManager!._setupAnimation(newSettings);

        // Update the visual selection highlight for layers without rebuilding the entire UI
        this.updateLayerSelection();
    }

    async onAnimationComplete() {
        // Clear layer switch animation flag and reset request tracking
        this.isLayerSwitchAnimating = false;
        fontInterpolation.resetRequestTracking();

        // Clear auto-pan anchor since animation is complete
        this.autoPanAnchorScreen = null;

        // Check if new variation settings match any layer
        if (this.active && this.glyphCanvas.fontData) {
            await this.autoSelectMatchingLayer();

            // If no exact layer match, keep interpolated data visible
            if (
                this.selectedLayerId === null &&
                this.layerData &&
                this.layerData.isInterpolated
            ) {
                // Keep showing interpolated data
                console.log('Animation complete: showing interpolated glyph');
            }
        }
    }

    async autoSelectMatchingLayer(): Promise<void> {
        // Check if current variation settings match any layer's master location
        let layers = this.glyphCanvas.fontData?.layers;
        let masters: PythonBabelfont.Master[] =
            this.glyphCanvas.fontData?.masters;
        if (!layers || !masters) {
            return;
        }

        // Get current axis tags and values
        const currentLocation = {
            ...this.glyphCanvas.axesManager!.variationSettings
        };

        console.log(
            '[OutlineEditor]',
            'autoSelectMatchingLayer - current axis values:',
            currentLocation
        );

        // Check each layer to find a match
        for (const layer of layers) {
            const master = masters.find((m) => m.id === layer._master);
            if (!master || !master.location) {
                console.log(
                    '[OutlineEditor]',
                    `  Skipping layer ${layer.id}: no master found for _master=${layer._master}`
                );
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
                console.log(
                    '[OutlineEditor]',
                    `  ✓ MATCH found: layer ${layer.id} with master location`,
                    master.location
                );
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
                        'Cleared previous state (not during slider use)'
                    );
                } else {
                    console.log('Keeping previous state (during slider use)');
                }

                // Only fetch layer data if we're not currently interpolating
                // During interpolation, the next interpolateCurrentGlyph() call will handle the data
                if (!this.isInterpolating) {
                    // Only fetch layer data if we're not currently editing a component
                    // If editing a component, the layer switch will be handled by refreshComponentStack
                    if (this.componentStack.length === 0) {
                        await this.fetchLayerData(); // Fetch layer data for outline editor

                        // Perform mouse hit detection after layer data is loaded
                        this.performHitDetection(null);

                        // Render to display the new outlines
                        if (this.active) {
                            this.glyphCanvas.render();
                        }
                    }
                } else {
                    // During interpolation (sliderMouseUp), we still need to render
                    // to update colors after isInterpolated flag is cleared
                    // Clear the isInterpolated flag since we're on an exact layer now
                    if (this.layerData) {
                        this.layerData.isInterpolated = false;
                    }
                    if (this.active) {
                        this.glyphCanvas.render();
                    }
                }
                this.updateLayerSelection();
                console.log(
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
            console.log('No matching layer - deselected');
        }

        // If we're in glyph edit mode and not on a layer, interpolate at current position
        if (
            this.active &&
            this.selectedLayerId === null &&
            this.currentGlyphName
        ) {
            console.log(
                'Interpolating at current position after entering edit mode'
            );
            await this.interpolateCurrentGlyph(true); // force=true to bypass guard
        }
    }

    async fetchLayerData(skipRender: boolean = false): Promise<void> {
        // Clear interpolated transform when switching to exact layer
        this.interpolatedComponentTransform = null;

        // Reset interpolation request tracking since we're loading exact layer data
        fontInterpolation.resetRequestTracking();

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
            // const glyphId =
            //     this.textRunEditor!.shapedGlyphs[
            //         this.textRunEditor!.selectedGlyphIndex
            //     ].g;
            let glyphName = this.glyphCanvas.getCurrentGlyphName();
            console.log(
                `🔍 Fetching layer data for glyph: "${glyphName}" ( production name), layer: ${this.selectedLayerId}`
            );

            this.layerData = await fontManager!.fetchLayerData(
                glyphName,
                this.selectedLayerId
            );

            // Clear isInterpolated flag since we're loading actual layer data
            if (this.layerData) {
                this.layerData.isInterpolated = false;
            }

            // Only update currentGlyphName if we're NOT in component editing mode
            // When in component editing, currentGlyphName should stay set to the component reference
            if (this.componentStack.length === 0) {
                this.currentGlyphName = glyphName; // Store for interpolation
            }

            if (this.layerData && this.layerData.shapes) {
                parseComponentNodes(this.layerData.shapes);
            }

            console.log('Fetched layer data:', this.layerData);
            if (!skipRender) {
                this.glyphCanvas.render();
            }
        } catch (error) {
            console.error('Error fetching layer data from Python:', error);
            this.layerData = null;
        }
    }

    async saveLayerData(): Promise<void> {
        // Save layer data back to Python using from_dict()
        if (!window.pyodide || !this.layerData) {
            return;
        }

        // Don't save interpolated data - it's not editable and has no layer ID
        if (this.layerData.isInterpolated) {
            console.warn(
                'Cannot save interpolated layer data - not on an exact layer location'
            );
            return;
        }

        if (!this.selectedLayerId) {
            console.warn('No layer selected - cannot save');
            return;
        }

        try {
            // Determine which glyph to save to
            let glyphName;

            if (this.componentStack.length > 0) {
                // We're editing a component - save to the component's glyph
                // Get the editingGlyphName from the top of the stack
                const currentState =
                    this.componentStack[this.componentStack.length - 1];
                glyphName = currentState.editingGlyphName;
            } else {
                glyphName = this.glyphCanvas.getCurrentGlyphName();
            }

            await fontManager!.saveLayerData(
                glyphName,
                this.selectedLayerId,
                this.layerData
            );

            console.log('Layer data saved successfully');
        } catch (error) {
            console.error('Error saving layer data to Python:', error);
        }
    }

    updateLayerSelection(): void {
        // Update the visual selection highlight for layer items without rebuilding
        if (!this.glyphCanvas.propertiesSection) return;

        // Find all layer items and update their selected class
        const layerItems =
            this.glyphCanvas.propertiesSection.querySelectorAll(
                '[data-layer-id]'
            );
        layerItems.forEach((item) => {
            const layerId = item.getAttribute('data-layer-id');
            if (layerId === this.selectedLayerId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async refreshComponentStack(): Promise<void> {
        // Refresh all component layer data in the stack for the current layer
        // This is called when switching layers while editing a nested component

        if (this.componentStack.length === 0 || !this.selectedLayerId) {
            return;
        }

        console.log(
            'Refreshing component stack for new layer, stack depth:',
            this.componentStack.length
        );

        // Save the path of component indices from the stack
        const componentPath: number[] = [];
        for (let i = 0; i < this.componentStack.length; i++) {
            componentPath.push(this.componentStack[i].componentIndex);
        }

        // Clear the stack and editing state
        this.componentStack = [];
        this.editingComponentIndex = null;
        this.layerData = null;

        let glyphName = this.glyphCanvas.getCurrentGlyphName();

        // Fetch root layer data (bypassing the component check since stack is now empty)
        try {
            this.layerData = await fontManager!.fetchLayerData(
                glyphName,
                this.selectedLayerId
            );

            // Re-enter each component level without UI updates
            for (const componentIndex of componentPath) {
                if (!this.layerData || !this.layerData.shapes[componentIndex]) {
                    console.error(
                        'Failed to refresh component stack - component not found at index',
                        componentIndex
                    );
                    break;
                }

                await this.enterComponentEditing(componentIndex, true); // Skip UI updates
            }

            console.log(
                'Component stack refreshed, new depth:',
                this.componentStack.length
            );

            // Update UI once at the end
            this.glyphCanvas.updateComponentBreadcrumb();
            await this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();
        } catch (error) {
            console.error('Error refreshing component stack:', error);
        }
    }

    async enterComponentEditing(
        componentIndex: number,
        skipUIUpdate: boolean = false
    ): Promise<void> {
        // Enter editing mode for a component
        // skipUIUpdate: if true, skip UI updates (useful when rebuilding component stack)
        if (
            !this.layerData ||
            !this.layerData.shapes[componentIndex] ||
            !this.selectedLayerId
        ) {
            return;
        }

        const componentShape = this.layerData.shapes[componentIndex];
        if (
            !('Component' in componentShape) ||
            !componentShape.Component.reference
        ) {
            console.log('Component has no reference');
            return;
        }

        // Fetch the component's layer data
        const componentLayerData = fontManager!.fetchLayerData(
            componentShape.Component.reference,
            this.selectedLayerId
        );
        if (!componentLayerData) {
            console.error(
                'Failed to fetch component layer data for:',
                componentShape.Component.reference
            );
            return;
        }

        console.log('Fetched component layer data:', componentLayerData);

        if (componentLayerData.shapes) {
            parseComponentNodes(componentLayerData.shapes);
        }

        console.log(
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
        let currentGlyphName: string;
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
                if (currentComponent && 'Component' in currentComponent) {
                    currentGlyphName = currentComponent.Component.reference;
                } else {
                    currentGlyphName = 'Unknown';
                }
            } else {
                currentGlyphName = 'Unknown';
            }
        } else {
            currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        // Push current state onto stack (before changing this.layerData)
        // Store the component we're about to enter (componentIndex), not the old editingComponentIndex
        // editingGlyphName is the reference of the component we're entering (for save operations)
        const editingGlyphName = componentShape.Component.reference;
        this.componentStack.push(
            this.saveState(
                componentIndex,
                this.getAccumulatedTransform(),
                currentGlyphName,
                editingGlyphName
            )
        );

        console.log(
            `Pushed to stack. Stack depth: ${this.componentStack.length}, storing glyphName: ${currentGlyphName}`
        );

        // Update currentGlyphName for interpolation to target the component we're entering
        this.currentGlyphName = editingGlyphName;

        // Set the component as the current editing context
        // After entering, we're no longer "editing" a component reference - we're inside it
        // So editingComponentIndex should be null
        this.editingComponentIndex = null;
        this.layerData = componentLayerData;
        // Clear isInterpolated flag since we're loading actual layer data
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }

        console.log(
            'Set layerData to component. this.layerData.shapes.length:',
            this.layerData?.shapes?.length
        );

        // Clear selections
        this.clearAllSelections();

        console.log(
            '[OutlineEditor] After clearAllSelections:',
            'selectedComponents:',
            this.selectedComponents,
            'selectedPoints:',
            this.selectedPoints,
            'selectedAnchors:',
            this.selectedAnchors
        );

        console.log(
            `Entered component editing: ${componentShape.Component.reference}, stack depth: ${this.componentStack.length}`
        );

        if (!skipUIUpdate) {
            // Update UI but skip hit detection since mouse context has changed
            this.glyphCanvas.updateComponentBreadcrumb();
            this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();
            // Don't call performHitDetection here - let the next mouse move handle it

            console.log(
                '[OutlineEditor] After UI update (without hit detection):',
                'selectedComponents:',
                this.selectedComponents
            );
        }
    }

    exitComponentEditing(skipUIUpdate: boolean = false): boolean {
        // Exit current component editing level
        // skipUIUpdate: if true, skip UI updates (useful when exiting multiple levels)
        if (this.componentStack.length === 0) {
            return false; // No component stack to exit from
        }

        const previousState = this.componentStack.pop()!;

        // Restore previous state
        this.editingComponentIndex = previousState.componentIndex;
        this.layerData = previousState.layerData;
        // Clear isInterpolated flag since we're restoring actual layer data
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }
        this.popState(previousState);

        // Restore currentGlyphName for interpolation
        // If still in nested component, use parent's editingGlyphName
        // Otherwise use top-level glyph name
        if (this.componentStack.length > 0) {
            const parentState =
                this.componentStack[this.componentStack.length - 1];
            this.currentGlyphName = parentState.editingGlyphName;
        } else {
            this.currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        console.log(
            `Exited component editing, stack depth: ${this.componentStack.length}`
        );

        if (!skipUIUpdate) {
            this.glyphCanvas.doUIUpdate();
        }

        return true;
    }

    exitAllComponentEditing(): void {
        // If we're in nested component mode, exit all levels first
        // Skip UI updates during batch exit to avoid duplicate layer interfaces
        while (this.componentStack.length > 0) {
            this.exitComponentEditing(true); // Skip UI updates
        }
    }

    updateEditorTitleBar(): void {
        // Update the editor title bar with glyph name and breadcrumb
        const editorView = document.getElementById('view-editor');
        if (!editorView) return;

        const titleBar = editorView.querySelector('.view-title-bar');
        if (!titleBar) return;

        const titleLeft = titleBar.querySelector('.view-title-left');
        if (!titleLeft) return;

        // Find or create the glyph name element
        let glyphNameElement = titleBar.querySelector(
            '.editor-glyph-name'
        ) as HTMLSpanElement;
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
            !this.active ||
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex < 0 ||
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex >=
                this.glyphCanvas.textRunEditor!.shapedGlyphs.length
        ) {
            glyphNameElement.style.display = 'none';
            return;
        }

        glyphNameElement.style.display = 'flex';

        // Get the main glyph name
        let mainGlyphName = this.glyphCanvas.getCurrentGlyphName();
        // Build breadcrumb trail
        const trail: string[] = [];

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
                    if (currentComponent && 'Component' in currentComponent) {
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
                        this.glyphCanvas.doUIUpdate();
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

    extractComponentTransformFromInterpolatedLayer(
        parentLayer: any,
        componentStack: ComponentStackItem[]
    ): number[] | null {
        // Navigate through the component stack accumulating interpolated transforms
        // This matches how getAccumulatedTransform() works for master layers

        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;
        let currentLayer = parentLayer;

        for (const stackItem of componentStack) {
            if (!currentLayer?.shapes || stackItem.componentIndex === null) {
                console.error(
                    '[OutlineEditor] Cannot navigate component stack - missing shapes or invalid index',
                    { stackItem, currentLayer }
                );
                return null;
            }

            const componentShape =
                currentLayer.shapes[stackItem.componentIndex];
            if (!componentShape || !('Component' in componentShape)) {
                console.error(
                    '[OutlineEditor] Component shape not found at index',
                    stackItem.componentIndex
                );
                return null;
            }

            // Get this component's interpolated transform and accumulate it
            const t = componentShape.Component.transform || [1, 0, 0, 1, 0, 0];

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

            // Get the component's layer data to continue navigating (unless this is the last level)
            if (stackItem !== componentStack[componentStack.length - 1]) {
                if (!componentShape.Component.layerData) {
                    console.error(
                        '[OutlineEditor] Component has no layerData',
                        componentShape.Component.reference
                    );
                    return null;
                }

                // Move to the next level
                currentLayer = componentShape.Component.layerData;
            }
        }

        // Return the accumulated transform
        return [a, b, c, d, tx, ty];
    }

    extractComponentFromInterpolatedLayer(
        parentLayer: any,
        componentStack: ComponentStackItem[]
    ): any {
        // Navigate through the component stack to extract the nested component layer data
        // This walks the same path as enterComponentEditing to get to the current editing level

        let currentLayer = parentLayer;

        for (const stackItem of componentStack) {
            if (!currentLayer?.shapes || stackItem.componentIndex === null) {
                console.error(
                    '[OutlineEditor] Cannot navigate component stack - missing shapes or invalid index',
                    { stackItem, currentLayer }
                );
                return null;
            }

            const componentShape =
                currentLayer.shapes[stackItem.componentIndex];
            if (!componentShape || !('Component' in componentShape)) {
                console.error(
                    '[OutlineEditor] Component shape not found at index',
                    stackItem.componentIndex
                );
                return null;
            }

            // Get the component's layer data (which should be populated by Rust interpolation)
            if (!componentShape.Component.layerData) {
                console.error(
                    '[OutlineEditor] Component has no layerData',
                    componentShape.Component.reference
                );
                return null;
            }

            // Move to the next level
            currentLayer = componentShape.Component.layerData;
        }

        return currentLayer;
    }

    getAccumulatedTransform(): number[] {
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
                let currentShape = level.layerData.shapes[level.componentIndex];
                if (!('Component' in currentShape)) {
                    continue; // Not a component shape
                }

                const comp = currentShape.Component;
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

    transformMouseToComponentSpace(): { glyphX: number; glyphY: number } {
        // Transform mouse coordinates from canvas to component local space
        let { glyphX, glyphY } = this.glyphCanvas.toGlyphLocal(
            this.glyphCanvas.mouseX,
            this.glyphCanvas.mouseY
        );

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
                `transformMouseToComponentSpace: before inverse=(${glyphXBeforeInverse}, ${glyphYBeforeInverse}), after inverse=(${glyphX}, ${glyphY}), accumulated transform=[${compTransform}]`
            );
        }

        return { glyphX, glyphY };
    }

    /**
     * Capture the current bbox center as an anchor point in screen coordinates.
     * This is called before starting an animation (slider or layer switch).
     */
    captureAutoPanAnchor() {
        if (!this.autoPanEnabled) {
            this.autoPanAnchorScreen = null;
            return;
        }

        if (!this.active) {
            this.autoPanAnchorScreen = null;
            return;
        }

        const bbox = this.calculateGlyphBoundingBox();
        if (!bbox) {
            this.autoPanAnchorScreen = null;
            return;
        }

        // Check if we have a valid selected glyph
        if (
            !this.glyphCanvas.textRunEditor ||
            this.glyphCanvas.textRunEditor.selectedGlyphIndex < 0
        ) {
            this.autoPanAnchorScreen = null;
            return;
        }

        // Get glyph position in text run
        const glyphPosition = this.glyphCanvas.textRunEditor!._getGlyphPosition(
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex
        );

        // Calculate bbox center in glyph-local space
        const localCenterX = bbox.minX + bbox.width / 2;
        const localCenterY = bbox.minY + bbox.height / 2;

        // Transform to world space (account for glyph position in text run)
        const worldCenterX =
            glyphPosition.xPosition + glyphPosition.xOffset + localCenterX;
        const worldCenterY = glyphPosition.yOffset + localCenterY;

        // Convert to screen coordinates
        const screenPos =
            this.glyphCanvas.viewportManager!.fontToScreenCoordinates(
                worldCenterX,
                worldCenterY
            );

        this.autoPanAnchorScreen = screenPos;
    }

    /**
     * Adjust pan to keep the bbox center at the anchor point.
     * This is called after interpolation updates the glyph.
     */
    applyAutoPanAdjustment() {
        if (!this.autoPanEnabled || !this.autoPanAnchorScreen) {
            return;
        }

        const bbox = this.calculateGlyphBoundingBox();
        if (!bbox) {
            return;
        }

        // Check if we have a valid selected glyph
        if (
            !this.glyphCanvas.textRunEditor ||
            this.glyphCanvas.textRunEditor.selectedGlyphIndex < 0
        ) {
            return;
        }

        // Get glyph position in text run
        const glyphPosition = this.glyphCanvas.textRunEditor!._getGlyphPosition(
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex
        );

        // Calculate new bbox center in glyph-local space
        const localCenterX = bbox.minX + bbox.width / 2;
        const localCenterY = bbox.minY + bbox.height / 2;

        // Transform to world space (account for glyph position in text run)
        const worldCenterX =
            glyphPosition.xPosition + glyphPosition.xOffset + localCenterX;
        const worldCenterY = glyphPosition.yOffset + localCenterY;

        // Convert to screen coordinates with current pan/scale
        const currentScreenPos =
            this.glyphCanvas.viewportManager!.fontToScreenCoordinates(
                worldCenterX,
                worldCenterY
            );

        // Calculate the offset between where the bbox center is now vs where it should be
        const offsetX = this.autoPanAnchorScreen.x - currentScreenPos.x;
        const offsetY = this.autoPanAnchorScreen.y - currentScreenPos.y;

        // Apply the pan adjustment
        this.glyphCanvas.viewportManager!.panX += offsetX;
        this.glyphCanvas.viewportManager!.panY += offsetY;
    }

    calculateGlyphBoundingBox(): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        // Calculate bounding box for the currently selected glyph in outline editing mode
        // Returns {minX, minY, maxX, maxY, width, height} in glyph-local coordinates
        // Returns null if no glyph is selected or no layer data is available

        console.log(
            'calculateGlyphBoundingBox: isGlyphEditMode=',
            this.active,
            'layerData=',
            this.layerData
        );

        if (!this.active || !this.layerData) {
            return null;
        }

        console.log(
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
        const expandBounds = (x: number, y: number) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            hasPoints = true;
        };

        // Helper function to process shapes recursively (for components)
        const processShapes = (
            shapes: PythonBabelfont.Shape[],
            transform: number[] = [1, 0, 0, 1, 0, 0]
        ) => {
            if (!shapes || !Array.isArray(shapes)) return;

            for (const shape of shapes) {
                if ('Component' in shape) {
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
                    'nodes' in shape &&
                    Array.isArray(shape.nodes) &&
                    shape.nodes.length > 0
                ) {
                    // Path - process all nodes with the accumulated transform
                    for (const node of shape.nodes) {
                        const { x, y } = node;

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

        console.log('calculateGlyphBoundingBox: Found points, bbox=', {
            minX,
            minY,
            maxX,
            maxY
        });

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    async restoreTargetLayerDataAfterAnimating(): Promise<void> {
        if (this.targetLayerData) {
            console.log(
                'Before restore - layerData.isInterpolated:',
                this.layerData?.isInterpolated
            );
            console.log(
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
                    this.layerData.shapes.forEach((shape: any) => {
                        if (shape.isInterpolated !== undefined) {
                            shape.isInterpolated = false;
                        }
                    });
                }
            }
            console.log(
                'After restore - layerData.isInterpolated:',
                this.layerData?.isInterpolated
            );
            console.log(
                'Layer switch animation complete, restored target layer for editing'
            );

            // Now check if we're on an exact layer match to update selectedLayerId
            await this.autoSelectMatchingLayer();

            if (this.active) {
                this.glyphCanvas.render();
            }
        }
    }
}
