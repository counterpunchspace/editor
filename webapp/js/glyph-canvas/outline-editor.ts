import { LayerDataNormalizer } from '../layer-data-normalizer';
import { fontInterpolation } from '../font-interpolation';
import { GlyphCanvas } from '../glyph-canvas';
import fontManager from '../font-manager';
import type {
    Shape,
    Layer as LayerType,
    Node as NodeType,
    NodeType as NodeTypeEnum,
    Master,
    Anchor
} from '../babelfont-types';
import { Transform } from '../basictypes';
import { Logger } from '../logger';
import { Layer } from '../babelfont-extended';
import APP_SETTINGS from '../settings';

let console: Logger = new Logger('OutlineEditor', true);

type Point = { contourIndex: number; nodeIndex: number };

// Recursively parse nodes in component layer data (including nested components)
const parseComponentNodes = (shapes: Shape[]) => {
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
    cursorStyleBeforePreview: string | null = null; // Store cursor before preview mode
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
    selectedPointIndex: any = null;

    layerDataDirty: boolean = false;
    previousSelectedLayerId: string | null = null;
    previousVariationSettings: Record<string, number> | null = null;
    layerData: LayerType | null = null;
    targetLayerData: LayerType | null = null;
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

    // New glyph_stack: Single source of truth for glyph/layer/component navigation
    // Format: {glyph_name}@{layer_ID}>{component_index}:{glyph_name}@{layer_ID}>{component_index}:{glyph_name}@{layer_ID}
    glyphStack: string = '';

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
    }

    /**
     * Parse glyph_stack into structured components
     * @returns Array of stack items, each with glyphName, layerId, and componentIndex
     */
    parseGlyphStack(): Array<{
        glyphName: string;
        layerId: string;
        componentIndex?: number;
    }> {
        if (!this.glyphStack) return [];

        const segments = this.glyphStack.split('>');
        const result: Array<{
            glyphName: string;
            layerId: string;
            componentIndex?: number;
        }> = [];

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            let glyphAndLayer: string;
            let componentIndex: number | undefined;

            // Check if this segment has a component index (format: componentIndex:glyphName@layerId)
            if (segment.includes(':')) {
                const parts = segment.split(':');
                componentIndex = parseInt(parts[0], 10);
                glyphAndLayer = parts[1];
            } else {
                glyphAndLayer = segment;
            }

            // Split glyphName@layerId
            const [glyphName, layerId] = glyphAndLayer.split('@');

            result.push({
                glyphName,
                layerId,
                componentIndex
            });
        }

        return result;
    }

    /**
     * Check if currently editing a nested component
     * @returns true if inside one or more nested components
     */
    isEditingComponent(): boolean {
        const parsed = this.parseGlyphStack();
        return parsed.length > 1; // More than just root means we're in a component
    }

    /**
     * Get component nesting depth from glyphStack
     * @returns Number of nested component levels (0 = root, 1 = one level deep, etc.)
     */
    getComponentDepth(): number {
        const parsed = this.parseGlyphStack();
        return Math.max(0, parsed.length - 1); // Subtract 1 for root
    }

    /**
     * Build glyph_stack string from current state
     * @param rootGlyphName - Name of the root glyph
     * @param layerId - Current layer ID
     * @param componentPath - Array of component indices representing the nesting path
     */
    buildGlyphStack(
        rootGlyphName: string,
        layerId: string,
        componentPath: number[] = []
    ): void {
        let stack = `${rootGlyphName}@${layerId}`;

        // Add each nested component to the stack
        let currentLayerData = this.layerData;
        for (let i = 0; i < componentPath.length; i++) {
            const compIndex = componentPath[i];

            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[compIndex]
            ) {
                console.error(
                    '[GlyphStack] Invalid component path at index',
                    i,
                    compIndex
                );
                break;
            }

            const shape = currentLayerData.shapes[compIndex];
            if (!('Component' in shape)) {
                console.error(
                    '[GlyphStack] Shape at index',
                    compIndex,
                    'is not a component'
                );
                break;
            }

            const componentGlyphName = shape.Component.reference;
            stack += `>${compIndex}:${componentGlyphName}@${layerId}`;

            // Move to the nested component's layer data for the next iteration
            currentLayerData = shape.Component.layerData || null;
        }

        this.glyphStack = stack;
        console.log('[GlyphStack] Built stack:', this.glyphStack);
    }

    /**
     * Rebuild glyph_stack with new layer IDs when switching layers
     * This method does NOT depend on this.layerData, so it works even when layer data hasn't been fetched yet
     * Preserves the component navigation path
     */
    rebuildGlyphStackWithNewLayer(newLayerId: string): void {
        if (!this.glyphStack) return;

        // Simply replace all layer IDs in the stack with the new one
        // Stack format: "glyphA@layerID1>0:glyphB@layerID1>1:glyphC@layerID1"
        // We want: "glyphA@newLayerID>0:glyphB@newLayerID>1:glyphC@newLayerID"

        // Split by '>' to get segments
        const segments = this.glyphStack.split('>');
        const newSegments = segments.map((segment) => {
            // Each segment is either "glyphName@layerID" or "compIndex:glyphName@layerID"
            if (segment.includes(':')) {
                // Format: "compIndex:glyphName@layerID"
                const colonIndex = segment.indexOf(':');
                const beforeColon = segment.substring(0, colonIndex);
                const afterColon = segment.substring(colonIndex + 1);
                // afterColon is "glyphName@layerID", replace layer ID
                const atIndex = afterColon.lastIndexOf('@');
                const glyphName = afterColon.substring(0, atIndex);
                return `${beforeColon}:${glyphName}@${newLayerId}`;
            } else {
                // Format: "glyphName@layerID"
                const atIndex = segment.lastIndexOf('@');
                const glyphName = segment.substring(0, atIndex);
                return `${glyphName}@${newLayerId}`;
            }
        });

        this.glyphStack = newSegments.join('>');
        console.log(
            '[GlyphStack] Rebuilt stack with new layer ID:',
            this.glyphStack
        );
    }

    clearState() {
        this.layerData = null;
        this.selectedPoints = [];
        this.hoveredPointIndex = null;
        this.isDraggingPoint = false;
        this.layerDataDirty = false;
    }

    clearAllSelections() {
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;
        this.hoveredGlyphIndex = -1;
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

        // Priority 0: Stop any active loop animations (play button sine waves)
        if (this.glyphCanvas.axesManager?.isLoopAnimating) {
            e.preventDefault();
            this.glyphCanvas.axesManager.stopAllLoopAnimations();
            return;
        }

        e.preventDefault();

        console.log('Escape pressed. Previous state:', {
            layerId: this.previousSelectedLayerId,
            settings: this.previousVariationSettings,
            componentStackDepth: this.getComponentDepth()
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
                console.log('Restoring previous layer by selecting it');

                // Find the previous layer object
                const layers = this.glyphCanvas.fontData?.layers;
                if (layers) {
                    const previousLayer = layers.find(
                        (l: LayerType) => l.id === this.previousSelectedLayerId
                    );

                    if (previousLayer) {
                        // Clear interpolating flag since we're transitioning to a real layer
                        this.isInterpolating = false;

                        // Clear previous state before calling selectLayer
                        // (selectLayer will also clear these, but we do it here to be explicit)
                        this.previousSelectedLayerId = null;
                        this.previousVariationSettings = null;

                        // Imitate clicking on the layer in the list by calling selectLayer
                        // This will handle everything: fetch data, animate sliders, update UI
                        this.selectLayer(previousLayer);
                        return;
                    }
                }

                // Fallback if layer not found - just clear state
                console.warn('Previous layer not found, clearing state');
                this.previousSelectedLayerId = null;
                this.previousVariationSettings = null;
            }
        }

        // Priority 2: Check if we're in component editing mode
        if (this.isEditingComponent()) {
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
        console.log('[OutlineEditor] onSliderMouseUp called', {
            active: this.active,
            isPreviewMode: this.isPreviewMode,
            isInterpolating: this.isInterpolating,
            selectedLayerId: this.selectedLayerId
        });
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

                // Fetch layer data but skip render - we'll render after clearing flags
                await this.fetchLayerData(true);

                // Clear interpolating flag immediately since we're now on an exact layer
                // This ensures that if the user switches glyphs, the new glyph will properly
                // fetch its layer data in autoSelectMatchingLayer
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            } else if (this.layerData && this.layerData.isInterpolated) {
                // No exact layer match - keep interpolated data
                // Only restore if shapes are empty/missing
                if (
                    !this.layerData.shapes ||
                    this.layerData.shapes.length === 0
                ) {
                    await LayerDataNormalizer.restoreExactLayer(this);
                }

                // Still interpolating - only clear flags if animation is complete
                if (!this.glyphCanvas.axesManager!.isAnimating) {
                    this.isInterpolating = false;
                    this.autoPanAnchorScreen = null;
                }
            }

            // Always render to update colors after clearing isInterpolating flag
            this.glyphCanvas.render();
        } else if (this.active) {
            this.isPreviewMode = false;

            // Check if we're on an exact layer
            console.log(
                '[OutlineEditor] About to call autoSelectMatchingLayer from onSliderMouseUp (non-preview mode)'
            );
            await this.autoSelectMatchingLayer();
            console.log(
                '[OutlineEditor] After autoSelectMatchingLayer, selectedLayerId:',
                this.selectedLayerId
            );

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

                // Fetch layer data but skip render - we'll render after clearing flags
                await this.fetchLayerData(true);

                // Clear interpolating flag immediately since we're on an exact layer
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            }

            // If no exact layer match, keep showing interpolated data

            // Render with updated data and cleared flags
            this.glyphCanvas.render();
            // Restore focus to canvas
            setTimeout(() => this.canvas!.focus(), 0);
        }
    }

    // Real-time interpolation during slider movement
    // Skip interpolation if in preview mode (HarfBuzz handles interpolation)
    onSliderChange(axisTag: string, value: number) {
        console.log('[OutlineEditor] onSliderChange called', {
            axisTag,
            value,
            selectedLayerId: this.selectedLayerId,
            isInterpolating: this.isInterpolating,
            active: this.active
        });

        // Save current state before manual adjustment (only once per manual session)
        // When starting a new slider drag from a selected layer, save that layer
        // and deselect to enable interpolation mode
        if (this.selectedLayerId !== null) {
            // Only update previous state if we're starting a new drag session
            // (not continuing an existing interpolation session)
            if (
                this.previousSelectedLayerId === null ||
                this.previousSelectedLayerId !== this.selectedLayerId
            ) {
                this.previousSelectedLayerId = this.selectedLayerId;
                this.previousVariationSettings = {
                    ...this.glyphCanvas.axesManager!.variationSettings
                };
                console.log(
                    '[OutlineEditor] Saved previous state for Escape:',
                    {
                        layerId: this.previousSelectedLayerId,
                        settings: this.previousVariationSettings
                    }
                );
            }
            this.selectedLayerId = null; // Deselect layer
            console.log(
                '[OutlineEditor] Deselected layer, selectedLayerId is now null'
            );
            // Always update layer selection UI when deselecting to show immediate visual feedback
            this.updateLayerSelection();
        }
        if (
            this.active &&
            this.isInterpolating &&
            !this.isPreviewMode &&
            this.currentGlyphName
        ) {
            console.log(
                '[OutlineEditor] Calling interpolateCurrentGlyph from onSliderChange'
            );
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
            }
        }
    }

    onDoubleClick(e: MouseEvent): boolean {
        console.log(
            '[OutlineEditor] Double-click detected. isGlyphEditMode:',
            this.active,
            'selectedLayerId:',
            this.selectedLayerId,
            'hoveredGlyphIndex:',
            this.hoveredGlyphIndex,
            'hoveredComponentIndex:',
            this.hoveredComponentIndex
        );

        // If in edit mode with a component/point/anchor hovered, prioritize that over glyph switching
        if (this.active && this.selectedLayerId) {
            // Double-click on component - enter component editing (without selecting it)
            if (this.hoveredComponentIndex !== null) {
                console.log(
                    '[OutlineEditor] Entering component editing for index:',
                    this.hoveredComponentIndex
                );
                // Clear component selection before entering
                this.selectedComponents = [];
                this.enterComponentEditing(
                    this.hoveredComponentIndex,
                    false,
                    e
                );
                return true; // Event handled - skip single-click
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
                return true; // Event handled - skip single-click
            }
        }

        // Double-click on other glyph - switch to that glyph
        // Check this after edit mode interactions, but before checking selectedLayerId,
        // so it works even when interpolating
        if (this.hoveredGlyphIndex >= 0) {
            console.log(
                '[OutlineEditor] Double-clicking on glyph:',
                this.hoveredGlyphIndex
            );
            this.glyphCanvas.doubleClickOnGlyph(this.hoveredGlyphIndex);
            return true; // Event handled - skip single-click
        }

        return false; // Event not handled
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

        // Update glyphCanvas mouse coordinates so transformMouseToComponentSpace() uses current position
        this.glyphCanvas.mouseX = mouseX;
        this.glyphCanvas.mouseY = mouseY;

        // Transform to component space (accounts for component transforms)
        const { glyphX, glyphY } = this.transformMouseToComponentSpace();

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
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) return;

        // Build a set of selected point identifiers to avoid moving them twice
        const selectedPointKeys = new Set(
            this.selectedPoints.map(
                ({ contourIndex, nodeIndex }) => `${contourIndex}:${nodeIndex}`
            )
        );

        // Process each selected point
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = currentLayerData.shapes[contourIndex];
            if (!contour || !('nodes' in contour) || !(contour as any).nodes)
                continue;

            const nodes = (contour as any).nodes as NodeType[];
            const node = nodes[nodeIndex];
            if (!node) continue;

            // If this is a curve point, remove its handles from selection (we'll move them together)
            if (node.nodetype === 'c' || node.nodetype === 'cs') {
                const prevIndex = (nodeIndex - 1 + nodes.length) % nodes.length;
                const nextIndex = (nodeIndex + 1) % nodes.length;
                const prevNode = nodes[prevIndex];
                const nextNode = nodes[nextIndex];

                if (prevNode?.nodetype === 'o') {
                    selectedPointKeys.delete(`${contourIndex}:${prevIndex}`);
                }
                if (nextNode?.nodetype === 'o') {
                    selectedPointKeys.delete(`${contourIndex}:${nextIndex}`);
                }
            }
        }

        // Move the selected nodes
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const key = `${contourIndex}:${nodeIndex}`;
            if (!selectedPointKeys.has(key)) continue; // Skip if removed above

            const contour = currentLayerData.shapes[contourIndex];
            if (!contour || !('nodes' in contour) || !(contour as any).nodes)
                continue;

            const nodes = (contour as any).nodes as NodeType[];
            const node = nodes[nodeIndex];
            if (!node) continue;

            node.x += deltaX;
            node.y += deltaY;

            // If this is a curve point, move its handles together
            if (node.nodetype === 'c' || node.nodetype === 'cs') {
                const prevIndex = (nodeIndex - 1 + nodes.length) % nodes.length;
                const nextIndex = (nodeIndex + 1) % nodes.length;
                const prevNode = nodes[prevIndex];
                const nextNode = nodes[nextIndex];

                if (prevNode?.nodetype === 'o') {
                    prevNode.x += deltaX;
                    prevNode.y += deltaY;
                }
                if (nextNode?.nodetype === 'o') {
                    nextNode.x += deltaX;
                    nextNode.y += deltaY;
                }
            }
        }

        // Handle smooth curve constraint for single offcurve dragging
        if (this.selectedPoints.length === 1) {
            const { contourIndex, nodeIndex } = this.selectedPoints[0];
            const contour = currentLayerData.shapes[contourIndex];
            if (contour && 'nodes' in contour && (contour as any).nodes) {
                const nodes = (contour as any).nodes as NodeType[];
                const offcurve = nodes[nodeIndex];

                if (offcurve?.nodetype === 'o') {
                    // Find the associated curve point and the other handle
                    const nextIndex = (nodeIndex + 1) % nodes.length;
                    const prevIndex =
                        (nodeIndex - 1 + nodes.length) % nodes.length;
                    const nextNode = nodes[nextIndex];
                    const prevNode = nodes[prevIndex];

                    let curvePoint: NodeType | null = null;
                    let otherHandleIndex = -1;

                    if (
                        nextNode &&
                        (nextNode.nodetype === 'c' ||
                            nextNode.nodetype === 'cs')
                    ) {
                        curvePoint = nextNode;
                        const afterCurve = (nextIndex + 1) % nodes.length;
                        if (
                            afterCurve !== nodeIndex &&
                            nodes[afterCurve]?.nodetype === 'o'
                        ) {
                            otherHandleIndex = afterCurve;
                        }
                    } else if (
                        prevNode &&
                        (prevNode.nodetype === 'c' ||
                            prevNode.nodetype === 'cs')
                    ) {
                        curvePoint = prevNode;
                        const beforeCurve =
                            (prevIndex - 1 + nodes.length) % nodes.length;
                        if (
                            beforeCurve !== nodeIndex &&
                            nodes[beforeCurve]?.nodetype === 'o'
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
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData) return;

        let anchors = currentLayerData.anchors || [];
        for (const anchorIndex of this.selectedAnchors) {
            const anchor = anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }
    }

    _updateDraggedComponents(deltaX: number, deltaY: number): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) return;

        for (const compIndex of this.selectedComponents) {
            const shape = currentLayerData.shapes[compIndex];
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
        } else if (this.hoveredGlyphIndex !== -1) {
            // Hovering over another glyph in editing mode
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
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        // First, check for hovering near component origins, which take priority.
        const components = currentLayerData.shapes
            .map((shape: Shape, index: number) => ({
                shape,
                index
            }))
            .filter(
                (item: { shape: Shape; index: number }) =>
                    'Component' in item.shape
            );

        const getComponentOrigin = (item: { shape: Shape; index: number }) => {
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

            for (
                let index = 0;
                index < currentLayerData.shapes.length;
                index++
            ) {
                const shape = currentLayerData.shapes[index];
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

    _isPointInComponent(shape: Shape, glyphX: number, glyphY: number): boolean {
        if (!('Component' in shape)) {
            return false;
        }

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

        // Collect all outline shapes with their accumulated transforms
        // This allows proper counter detection via nonzero winding rule
        const collectOutlineShapes = (
            shapes: Shape[],
            parentTransform: Transform = [1, 0, 0, 1, 0, 0]
        ): Array<{ nodes: any[]; transform: Transform }> => {
            const outlineShapes: Array<{
                nodes: any[];
                transform: Transform;
            }> = [];

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

                    // Multiply matrices to combine transforms
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
                        componentShape.Component.layerData.shapes
                    ) {
                        outlineShapes.push(
                            ...collectOutlineShapes(
                                componentShape.Component.layerData.shapes,
                                combinedTransform
                            )
                        );
                    }
                } else if (
                    'nodes' in componentShape &&
                    (componentShape as any).nodes &&
                    (componentShape as any).nodes.length > 0
                ) {
                    outlineShapes.push({
                        nodes: (componentShape as any).nodes,
                        transform: parentTransform
                    });
                }
            }

            return outlineShapes;
        };

        // Collect all shapes from the component hierarchy
        const outlineShapes = collectOutlineShapes(
            shape.Component.layerData!.shapes || []
        );

        if (outlineShapes.length === 0) {
            return false;
        }

        // Build a single combined path with all contours
        // This allows the canvas nonzero winding rule to properly handle counters
        const combinedPath = new Path2D();

        for (const { nodes, transform: nestedTransform } of outlineShapes) {
            // Create a path for this shape
            const shapePath = new Path2D();
            this.glyphCanvas.renderer!.buildPathFromNodes(nodes, shapePath);
            shapePath.closePath();

            // Apply the accumulated transform to this shape's path
            const matrix = new DOMMatrix([
                nestedTransform[0],
                nestedTransform[1],
                nestedTransform[2],
                nestedTransform[3],
                nestedTransform[4],
                nestedTransform[5]
            ]);

            // Add the transformed path to the combined path
            combinedPath.addPath(shapePath, matrix);
        }

        // Now do a single hit test on the combined path with the component's transform
        this.glyphCanvas.ctx!.save();
        this.glyphCanvas.ctx!.setTransform(1, 0, 0, 1, 0, 0);
        this.glyphCanvas.ctx!.transform(
            transformArray[0],
            transformArray[1],
            transformArray[2],
            transformArray[3],
            transformArray[4],
            transformArray[5]
        );

        // Calculate scale for hit tolerance
        const scaleX = Math.sqrt(
            transformArray[0] * transformArray[0] +
                transformArray[1] * transformArray[1]
        );
        const scaleY = Math.sqrt(
            transformArray[2] * transformArray[2] +
                transformArray[3] * transformArray[3]
        );
        const scale = Math.max(scaleX, scaleY);
        const totalScale = this.glyphCanvas.viewportManager!.scale * scale;
        this.glyphCanvas.ctx!.lineWidth =
            APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE / totalScale;

        // Use both fill and stroke for hit detection
        const isInPath =
            this.glyphCanvas.ctx!.isPointInPath(combinedPath, glyphX, glyphY) ||
            this.glyphCanvas.ctx!.isPointInStroke(combinedPath, glyphX, glyphY);

        this.glyphCanvas.ctx!.restore();
        return isInPath;
    }

    updateHoveredAnchor(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.anchors) {
            return;
        }

        const foundAnchorIndex = this._findHoveredItem(
            currentLayerData.anchors.map((anchor: Anchor, index: number) => ({
                ...anchor,
                index
            })),
            (item) => ({ x: item.x, y: item.y }),
            (item) => item.index
        );

        if (foundAnchorIndex !== this.hoveredAnchorIndex) {
            this.hoveredAnchorIndex = foundAnchorIndex;
            this.glyphCanvas.render();
        }
    }

    updateHoveredPoint(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        const points = currentLayerData.shapes.flatMap(
            (shape: Shape, contourIndex: number) => {
                if (!('nodes' in shape) || !(shape as any).nodes) return [];
                return (shape as any).nodes.map(
                    (node: NodeType, nodeIndex: number) => ({
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
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (
            !currentLayerData ||
            !currentLayerData.shapes ||
            this.selectedPoints.length === 0
        ) {
            return;
        }

        for (const point of this.selectedPoints) {
            const { contourIndex, nodeIndex } = point;
            const shape = currentLayerData.shapes[contourIndex];
            if (
                shape &&
                'nodes' in shape &&
                shape.nodes &&
                (shape as any).nodes[nodeIndex]
            ) {
                (shape as any).nodes[nodeIndex].x += deltaX;
                (shape as any).nodes[nodeIndex].y += deltaY;
            }
        }

        // Save to Python (non-blocking)
        this.saveLayerData();
        this.glyphCanvas.render();
    }

    moveSelectedAnchors(deltaX: number, deltaY: number): void {
        // Move all selected anchors by the given delta
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (
            !currentLayerData ||
            !currentLayerData.anchors ||
            this.selectedAnchors.length === 0
        ) {
            return;
        }

        for (const anchorIndex of this.selectedAnchors) {
            const anchor = currentLayerData.anchors[anchorIndex];
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
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        const { contourIndex, nodeIndex } = pointIndex;
        const shape = currentLayerData.shapes[contourIndex];

        if (
            !shape ||
            !('nodes' in shape) ||
            !(shape as any).nodes ||
            !(shape as any).nodes[nodeIndex]
        ) {
            return;
        }

        const node = (shape as any).nodes[nodeIndex];
        const { nodetype: type } = node;

        // Toggle smooth state based on current type
        let newType = (
            {
                c: 'cs',
                cs: 'c',
                q: 'qs',
                qs: 'q',
                l: 'ls',
                ls: 'l',
                m: 'ms',
                ms: 'm',
                o: 'o'
            } as any
        )[type] as NodeTypeEnum;

        node.nodetype = newType;

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

        // Restore cursor style
        if (this.glyphCanvas.canvas && this.cursorStyleBeforePreview) {
            this.glyphCanvas.canvas.style.cursor =
                this.cursorStyleBeforePreview;
            this.cursorStyleBeforePreview = null;
        }

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
            // Restore cursor visibility in text mode
            if (!this.active) {
                this.glyphCanvas.cursorVisible = true;
            }
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

            // ALWAYS interpolate the root glyph (with full component tree)
            // This matches the architecture where layerData always contains the root glyph
            // and we navigate to nested components using glyphStack
            const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
            const interpolatedLayer = await fontInterpolation.interpolateGlyph(
                rootGlyphName,
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

            // Don't apply interpolated data if we're no longer in an interpolating state
            // This can happen if a layer switch animation completes while an interpolation is in flight
            if (
                !this.isInterpolating &&
                !this.isLayerSwitchAnimating &&
                !force
            ) {
                console.log(
                    '[OutlineEditor] 🚫 Skipping applyInterpolatedLayer - no longer interpolating'
                );
                return;
            }

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

            // In editing mode, update HarfBuzz and auto-pan together to keep them in sync
            if (
                interpolatedLayer._interpolationLocation &&
                this.autoPanAnchorScreen !== null
            ) {
                // Update the axes manager's variation settings to match the interpolated location
                // This ensures HarfBuzz renders at the same location as the interpolated outline
                this.glyphCanvas.axesManager!.variationSettings = {
                    ...interpolatedLayer._interpolationLocation
                };

                // Update HarfBuzz font with the new variation settings (updates text width)
                // Skip render here - we'll render after auto-pan adjustment
                this.glyphCanvas.textRunEditor!.shapeText(true);

                // Apply auto-pan adjustment now that text width is updated
                this.applyAutoPanAdjustment();
            }

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
        // Handle space bar press to enter preview mode and enable panning
        if (e.code === 'Space') {
            e.preventDefault();
            this.spaceKeyPressed = true;
            // Only enter preview mode if not already in it (prevents key repeat from re-entering)
            if (!this.isPreviewMode) {
                this.isPreviewMode = true;
                // Store current cursor and change to grab cursor
                if (this.glyphCanvas.canvas) {
                    this.cursorStyleBeforePreview =
                        this.glyphCanvas.canvas.style.cursor;
                    this.glyphCanvas.canvas.style.cursor = 'grab';
                }
                this.glyphCanvas.render();
            }
            return;
        }

        // Handle Cmd+Left/Right to navigate through glyphs in logical order
        // Only when in glyph edit mode but NOT in nested component mode
        if ((e.metaKey || e.ctrlKey) && !this.isEditingComponent()) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.active && !this.isEditingComponent()) {
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

    async selectLayer(layer: LayerType): Promise<void> {
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

        // Rebuild glyph_stack with new layer ID (preserves component path)
        if (this.glyphStack && this.glyphStack !== '') {
            this.rebuildGlyphStackWithNewLayer(layer.id!);
        } else {
            // Initial selection - build stack from scratch at root level
            const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
            this.buildGlyphStack(rootGlyphName, layer.id!, []);
        }

        // Capture anchor point before layer switch animation begins
        this.captureAutoPanAnchor();

        // Immediately clear interpolated flag on existing data
        // to prevent rendering with monochrome colors
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }
        let masters: Master[] = this.glyphCanvas.fontData.masters;
        console.log(`Selected layer: ${layer.name} (ID: ${layer.id})`);
        console.log('Layer data:', layer);
        console.log('Available masters:', masters);

        // Store current layer data before fetching new one (for animation)
        const oldLayerData = this.layerData;

        // CRITICAL SECTION: Suppress all renders during layer data fetch and swap
        // This prevents the target layer from flashing before animation starts
        this.glyphCanvas.renderSuppressed = true;

        try {
            // Fetch layer data now and store as target for animation
            // This ensures new outlines are ready before animation starts
            await this.fetchLayerData(true);

            // Immediately swap layer data to prevent flash
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

            // Perform mouse hit detection after swap (uses layerData)
            this.performHitDetection(null);
        } finally {
            // Always re-enable rendering after critical section
            this.glyphCanvas.renderSuppressed = false;
        }

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
        // Don't clear isLayerSwitchAnimating here - it's cleared in glyph-canvas.ts
        // after calling restoreTargetLayerDataAfterAnimating()

        // Don't handle interpolation slider resets here when layer switching
        // The layer switch logic in glyph-canvas.ts will handle everything
        if (!this.isLayerSwitchAnimating) {
            fontInterpolation.resetRequestTracking();
        }

        // Clear auto-pan anchor since animation is complete
        this.autoPanAnchorScreen = null;

        // Only handle interpolation mode here, not layer switches
        // Layer switches are handled in restoreTargetLayerDataAfterAnimating()
        if (this.isLayerSwitchAnimating) {
            // Layer switch animation - don't handle here
            return;
        }

        // Check if new variation settings match any layer (interpolation mode only)
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
        console.log('[OutlineEditor] autoSelectMatchingLayer called', {
            active: this.active,
            isInterpolating: this.isInterpolating,
            selectedLayerId: this.selectedLayerId
        });

        // Check if current variation settings match any layer's master location
        let layers = this.glyphCanvas.fontData?.layers;
        let masters: Master[] = this.glyphCanvas.fontData?.masters;
        if (!layers || !masters) {
            console.log(
                '[OutlineEditor] No layers or masters found, returning'
            );
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

                // Build or rebuild glyph_stack with new layer ID
                if (this.glyphStack && this.glyphStack !== '') {
                    // If stack exists, rebuild with new layer (preserves component path)
                    this.rebuildGlyphStackWithNewLayer(layer.id!);
                } else {
                    // If stack is empty, build initial stack for root glyph
                    this.buildGlyphStack(this.currentGlyphName!, layer.id!, []);
                }

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

                // Fetch layer data immediately when we find a match
                // This ensures the layer is loaded even during slider dragging
                await this.fetchLayerData(); // Fetch layer data for outline editor

                // Perform mouse hit detection after layer data is loaded
                this.performHitDetection(null);

                // Clear the interpolating flag and render to display the new outlines
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;

                if (this.active) {
                    this.glyphCanvas.render();
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

            // Pan to glyph after interpolation completes (when switching glyphs via keyboard)
            // This ensures we have the correct interpolated bounds for panning
            if (
                this.glyphCanvas.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.glyphCanvas.textRunEditor!.selectedGlyphIndex <
                    this.glyphCanvas.textRunEditor!.shapedGlyphs.length
            ) {
                this.glyphCanvas.panToGlyph(
                    this.glyphCanvas.textRunEditor!.selectedGlyphIndex
                );
            }
        }
    }

    /**
     * Get the layer data for the current position in glyph_stack
     * Always starts from root layerData and navigates through components
     * @returns The layer data at the current glyph_stack position
     */
    getCurrentLayerDataFromStack(): LayerType | null {
        if (!this.layerData || !this.glyphStack) {
            return this.layerData;
        }

        const parsed = this.parseGlyphStack();
        if (parsed.length === 0) {
            return this.layerData;
        }

        // Start with root layer data
        let currentLayerData: LayerType | null = this.layerData;

        // Navigate through each component in the stack (skip the first root item)
        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i];

            // Skip root item (has no componentIndex)
            if (item.componentIndex === undefined) {
                continue;
            }

            // Navigate to the component
            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[item.componentIndex]
            ) {
                console.error(
                    '[GlyphStack] Invalid navigation at index',
                    i,
                    'componentIndex:',
                    item.componentIndex
                );
                return null;
            }

            const shape: Shape = currentLayerData.shapes[item.componentIndex];
            if (!('Component' in shape)) {
                console.error(
                    '[GlyphStack] Shape at index',
                    item.componentIndex,
                    'is not a component'
                );
                return null;
            }

            // Move to the component's layer data
            currentLayerData = shape.Component.layerData || null;
            if (!currentLayerData) {
                console.error(
                    '[GlyphStack] Component at index',
                    item.componentIndex,
                    'has no layerData'
                );
                return null;
            }
        }

        return currentLayerData;
    }

    async fetchLayerData(skipRender: boolean = false): Promise<void> {
        // Reset interpolation request tracking since we're loading exact layer data
        fontInterpolation.resetRequestTracking();

        // ALWAYS fetch root glyph layer data (with nested components)
        // Never fetch layer data for a component separately
        if (!window.pyodide || !this.selectedLayerId) {
            this.layerData = null;
            return;
        }

        try {
            // Always fetch root glyph name - never component reference
            let glyphName = this.glyphCanvas.getCurrentGlyphName();
            console.log(
                `🔍 Fetching ROOT layer data for glyph: "${glyphName}", layer: ${this.selectedLayerId}`
            );

            // Fetch root layer data with all nested components
            this.layerData = await fontManager!.fetchLayerData(
                glyphName,
                this.selectedLayerId
            );

            // Clear isInterpolated flag since we're loading actual layer data
            if (this.layerData) {
                this.layerData.isInterpolated = false;
            }

            // Parse all component nodes in the entire tree
            if (this.layerData && this.layerData.shapes) {
                parseComponentNodes(this.layerData.shapes);
            }

            // Update currentGlyphName based on glyph_stack position
            // If we're in a nested component, extract the component name from the stack
            const parsed = this.parseGlyphStack();
            if (parsed.length > 1) {
                // We're in a nested component - use the last glyph name in the stack
                this.currentGlyphName = parsed[parsed.length - 1].glyphName;
            } else {
                // We're at root level
                this.currentGlyphName = glyphName;
            }

            console.log('Fetched ROOT layer data:', this.layerData);
            console.log('Current position in stack:', this.glyphStack);

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
            const parsed = this.parseGlyphStack();
            const rootGlyphName =
                parsed.length > 0
                    ? parsed[0].glyphName
                    : this.glyphCanvas.getCurrentGlyphName();

            // ALWAYS save to ROOT glyph (contains full component tree)
            // Component modifications are saved as part of the root glyph's component references
            console.log(
                `[SaveLayerData] Saving ROOT glyph "${rootGlyphName}" with stack: ${this.glyphStack}`
            );
            await fontManager!.saveLayerData(
                rootGlyphName,
                this.selectedLayerId,
                this.layerData
            );

            // If editing a nested component, also save changes to the component glyph definition
            if (this.isEditingComponent()) {
                const currentLayerData = this.getCurrentLayerDataFromStack();
                if (currentLayerData) {
                    // Get the component glyph name from the stack
                    const componentGlyphName =
                        parsed[parsed.length - 1].glyphName;

                    console.log(
                        `[SaveLayerData] Also saving component glyph definition "${componentGlyphName}" with layer: ${this.selectedLayerId}`
                    );

                    // Save the component's layer data to its own glyph definition
                    await fontManager!.saveLayerData(
                        componentGlyphName,
                        this.selectedLayerId,
                        currentLayerData
                    );
                }
            }

            console.log('Layer data saved successfully');
        } catch (error) {
            console.error('Error saving layer data to Python:', error);
        }
    }

    updateLayerSelection(): void {
        // Update the visual selection highlight for layer items without rebuilding
        if (!this.glyphCanvas.propertiesSection) return;

        // Find all master/layer items and update their selected class
        // Items now have data-master-id, and optionally data-layer-id if layer exists
        const masterItems =
            this.glyphCanvas.propertiesSection.querySelectorAll(
                '[data-master-id]'
            );
        masterItems.forEach((item) => {
            const layerId = item.getAttribute('data-layer-id');
            if (layerId === this.selectedLayerId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async enterComponentEditing(
        componentIndex: number,
        skipUIUpdate: boolean = false,
        mouseEvent: MouseEvent | null = null
    ): Promise<void> {
        // Enter editing mode for a component
        // With glyph_stack approach: we DON'T swap layerData, we just update the stack
        // layerData ALWAYS remains the root glyph's data
        // skipUIUpdate: if true, skip UI updates (useful when rebuilding component stack)
        if (
            !this.layerData ||
            !this.layerData.shapes ||
            !this.layerData.shapes[componentIndex] ||
            !this.selectedLayerId
        ) {
            return;
        }

        // Get the component shape from current position in stack
        const currentLayerData =
            this.getCurrentLayerDataFromStack() || this.layerData;

        if (
            !currentLayerData.shapes ||
            !currentLayerData.shapes[componentIndex]
        ) {
            return;
        }

        const componentShape = currentLayerData.shapes[componentIndex];
        if (
            !('Component' in componentShape) ||
            !componentShape.Component.reference
        ) {
            console.log('Component has no reference');
            return;
        }

        console.log(
            `[EnterComponent] Entering component: ${componentShape.Component.reference}, index: ${componentIndex}`
        );

        // Get component transform
        const transform = componentShape.Component.transform || [
            1, 0, 0, 1, 0, 0
        ];

        // Get current glyph name (for breadcrumb trail)
        let currentGlyphName: string;
        const parsed = this.parseGlyphStack();
        if (parsed.length > 0) {
            // Get the last glyph name from the stack
            currentGlyphName = parsed[parsed.length - 1].glyphName;
        } else {
            currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        const editingGlyphName = componentShape.Component.reference;

        // Clear selections when entering component
        this.clearAllSelections();

        console.log(
            `Entering component. New depth: ${this.getComponentDepth() + 1}, current glyph: ${currentGlyphName}`
        );

        // Update glyph_stack by adding this component to the navigation path
        const componentPath: number[] = [];
        // Extract existing component path
        for (let i = 0; i < parsed.length; i++) {
            if (parsed[i].componentIndex !== undefined) {
                componentPath.push(parsed[i].componentIndex!);
            }
        }
        // Add the new component index
        componentPath.push(componentIndex);
        // Rebuild with updated path
        const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
        this.buildGlyphStack(
            rootGlyphName,
            this.selectedLayerId,
            componentPath
        );

        // Update currentGlyphName for interpolation to target the component we're entering
        this.currentGlyphName = editingGlyphName;

        // DON'T set layerData to component data - keep it as root!
        // The renderer will use getCurrentLayerDataFromStack() to get the right data

        console.log(
            `[EnterComponent] Entered component: ${editingGlyphName}, stack depth: ${this.getComponentDepth()}`
        );
        console.log(`[EnterComponent] Updated glyph_stack: ${this.glyphStack}`);

        if (!skipUIUpdate) {
            // Update UI and perform hit detection to update hover states
            this.glyphCanvas.updateComponentBreadcrumb();
            this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();

            // Perform hit detection immediately if we have a mouse event
            if (mouseEvent) {
                this.performHitDetection(mouseEvent);
                this.glyphCanvas.render();
            }
        }
    }

    exitComponentEditing(skipUIUpdate: boolean = false): boolean {
        // Exit current component editing level
        // With glyph_stack: we DON'T restore layerData, we just update the stack
        // layerData ALWAYS remains the root glyph's data
        // skipUIUpdate: if true, skip UI updates (useful when exiting multiple levels)
        console.log(
            '[EXIT] exitComponentEditing called, current stack depth:',
            this.getComponentDepth()
        );

        if (!this.isEditingComponent()) {
            return false; // Not in component mode
        }

        // Update glyph_stack by removing the last component
        const parsed = this.parseGlyphStack();
        const componentPath: number[] = [];
        // Extract component path (excluding the last one we're exiting)
        for (let i = 0; i < parsed.length; i++) {
            if (
                parsed[i].componentIndex !== undefined &&
                i < parsed.length - 1
            ) {
                componentPath.push(parsed[i].componentIndex!);
            }
        }
        // Rebuild with reduced path
        const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
        if (this.selectedLayerId) {
            this.buildGlyphStack(
                rootGlyphName,
                this.selectedLayerId,
                componentPath
            );
        }

        // Clear selections when exiting (selection tracking will be added separately)
        this.clearAllSelections();

        // Update currentGlyphName based on new stack position
        const newParsed = this.parseGlyphStack();
        if (newParsed.length > 1) {
            // Still in a nested component
            this.currentGlyphName = newParsed[newParsed.length - 1].glyphName;
        } else {
            // Back to root level
            this.currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        console.log(
            `[EXIT] Exited component editing, stack depth: ${this.getComponentDepth()}`
        );
        console.log(`[EXIT] Updated glyph_stack: ${this.glyphStack}`);

        if (!skipUIUpdate) {
            this.glyphCanvas.updateComponentBreadcrumb();
            this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();
        }

        return true;
    }

    exitAllComponentEditing(): void {
        // If we're in nested component mode, exit all levels first
        // Skip UI updates during batch exit to avoid duplicate layer interfaces
        while (this.isEditingComponent()) {
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
                font-family: var(--font-families-mono);
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

        // Build breadcrumb trail from glyphStack
        const trail: string[] = [];

        if (this.glyphStack && this.glyphStack !== '') {
            // Parse glyphStack to build trail
            const parsed = this.parseGlyphStack();

            // Add each glyph name from the stack
            for (const item of parsed) {
                trail.push(item.glyphName);
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
            const mainGlyphName = this.glyphCanvas.getCurrentGlyphName();
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
        parentLayer: any
    ): number[] | null {
        // Navigate through the glyphStack accumulating interpolated transforms
        // This matches how getAccumulatedTransform() works for master layers

        const parsed = this.parseGlyphStack();
        console.log(
            '[extractComponentTransform] Called with glyphStack depth:',
            parsed.length
        );

        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;
        let currentLayer = parentLayer;

        // Skip the first item (root glyph), process remaining items (components)
        for (let i = 1; i < parsed.length; i++) {
            const stackItem = parsed[i];
            if (
                !currentLayer?.shapes ||
                stackItem.componentIndex === undefined
            ) {
                console.error(
                    '[OutlineEditor] Cannot navigate glyphStack - missing shapes or invalid index',
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
            console.log(
                '[extractComponentTransform] Stack level',
                i,
                'component:',
                componentShape.Component.reference,
                'transform:',
                t
            );

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
            if (i < parsed.length - 1) {
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
        console.log(
            '[extractComponentTransform] Final accumulated transform:',
            [a, b, c, d, tx, ty]
        );
        return [a, b, c, d, tx, ty];
    }

    /**
     * Get accumulated transform from glyphStack by navigating through root layerData
     * This replaces the old componentStack-based approach
     */
    getAccumulatedTransformFromStack(): number[] {
        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;

        if (!this.layerData || !this.glyphStack) {
            return [a, b, c, d, tx, ty];
        }

        const parsed = this.parseGlyphStack();
        console.log(
            `[getAccumulatedTransformFromStack] Stack: ${this.glyphStack}`
        );
        console.log(
            `[getAccumulatedTransformFromStack] Parsed depth: ${parsed.length - 1}`,
            parsed
        );

        // Start at root and navigate through components
        let currentLayerData: LayerType | null = this.layerData;

        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i];

            // Skip root (no transform to apply)
            if (item.componentIndex === undefined) {
                continue;
            }

            // Get the component shape
            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[item.componentIndex]
            ) {
                console.error(
                    '[getAccumulatedTransformFromStack] Invalid navigation at index',
                    i,
                    'componentIndex:',
                    item.componentIndex
                );
                break;
            }

            const shape: Shape = currentLayerData.shapes[item.componentIndex];
            if (!('Component' in shape)) {
                console.error(
                    '[getAccumulatedTransformFromStack] Shape at index',
                    item.componentIndex,
                    'is not a component'
                );
                break;
            }

            const comp: any = shape.Component;
            console.log(
                `[getAccumulatedTransformFromStack] Level ${i}: component "${comp.reference}", transform:`,
                comp.transform
            );

            // Apply this component's transform
            if (comp.transform) {
                const t = comp.transform;
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

            // Move to next level
            currentLayerData = comp.layerData || null;
        }

        const result = [a, b, c, d, tx, ty];
        console.log('[getAccumulatedTransformFromStack] Result:', result);
        return result;
    }

    /**
     * @deprecated Use getAccumulatedTransformFromStack() instead
     * Legacy method kept for backward compatibility during migration
     */
    getAccumulatedTransform(): number[] {
        // For now, delegate to new implementation
        return this.getAccumulatedTransformFromStack();
    }

    transformMouseToComponentSpace(): { glyphX: number; glyphY: number } {
        // Transform mouse coordinates from canvas to component local space
        let { glyphX, glyphY } = this.glyphCanvas.toGlyphLocal(
            this.glyphCanvas.mouseX,
            this.glyphCanvas.mouseY
        );

        // Apply inverse component transform if editing a component
        if (this.isEditingComponent()) {
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
                `[transformMouseToComponentSpace] before inverse=(${glyphXBeforeInverse}, ${glyphYBeforeInverse}), after inverse=(${glyphX}, ${glyphY}), accumulated transform=[${compTransform}], det=${det}`
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
        let localCenterX = bbox.minX + bbox.width / 2;
        let localCenterY = bbox.minY + bbox.height / 2;

        // If editing a component, apply the component's transform to the local center
        if (this.isEditingComponent()) {
            const transform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;
            const transformedX = a * localCenterX + c * localCenterY + tx;
            const transformedY = b * localCenterX + d * localCenterY + ty;
            localCenterX = transformedX;
            localCenterY = transformedY;
        }

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
        let localCenterX = bbox.minX + bbox.width / 2;
        let localCenterY = bbox.minY + bbox.height / 2;

        // If editing a component, apply the component's transform to the local center
        if (this.isEditingComponent()) {
            const transform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;
            const transformedX = a * localCenterX + c * localCenterY + tx;
            const transformedY = b * localCenterX + d * localCenterY + ty;
            localCenterX = transformedX;
            localCenterY = transformedY;
        }

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
        // Calculate bounding box for the currently edited glyph
        // When editing a component, this returns the bbox of the component, not the root glyph
        // Returns {minX, minY, maxX, maxY, width, height} in glyph-local coordinates
        // Returns null if no glyph is selected or no layer data is available

        if (!this.active || !this.layerData) {
            return null;
        }

        // Get the layer data for the current editing position
        // If editing a component, this navigates to the component's layer data
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData) {
            return null;
        }

        console.log(
            '[OutlineEditor]',
            'calculateGlyphBoundingBox: currentLayerData.shapes=',
            currentLayerData.shapes,
            'currentLayerData.width=',
            currentLayerData.width,
            'isEditingComponent=',
            this.isEditingComponent()
        );

        // Find the layer instance from currentFontModel
        const glyphName = this.currentGlyphName;
        const layerId = this.selectedLayerId;

        let layerInstance: Layer | null = null;
        if (glyphName && layerId) {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            if (glyph && glyph.layers) {
                layerInstance =
                    glyph.layers.find((l: Layer) => l.id === layerId) || null;
            }
        }

        let bbox = null;
        if (layerInstance) {
            // Use instance method
            bbox = layerInstance.getBoundingBox(true);
        }

        if (bbox) {
            console.log(
                '[OutlineEditor]',
                'calculateGlyphBoundingBox: bbox=',
                bbox
            );
        } else {
            console.log(
                '[OutlineEditor]',
                'calculateGlyphBoundingBox: No bbox calculated'
            );
        }

        return bbox;
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
