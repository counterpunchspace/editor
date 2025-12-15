// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

import { AxesManager } from './glyph-canvas/variations';
import { FeaturesManager } from './glyph-canvas/features';
import { TextRunEditor } from './glyph-canvas/textrun';
import { ViewportManager } from './glyph-canvas/viewport';
import { GlyphCanvasRenderer } from './glyph-canvas/renderer';
import * as opentype from 'opentype.js';
import fontManager from './font-manager';
import { OutlineEditor } from './glyph-canvas/outline-editor';
import { Logger } from './logger';
import APP_SETTINGS from './settings';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';

let console: Logger = new Logger('GlyphCanvas', true);

class GlyphCanvas {
    container: HTMLElement;
    canvas: HTMLCanvasElement | null = null;
    ctx: CanvasRenderingContext2D | null = null;
    outlineEditor: OutlineEditor = new OutlineEditor(this);

    axesManager: AxesManager | null = null;
    featuresManager: FeaturesManager | null = null;
    textRunEditor: TextRunEditor | null = null;
    renderer: GlyphCanvasRenderer | null = null;

    initialScale: number = 0.2;
    viewportManager: ViewportManager | null = null;

    currentFont: any = null;
    fontBlob: Blob | null = null;
    opentypeFont: opentype.Font | null = null;
    sourceGlyphNames: { [gid: number]: string } = {};

    isFocused: boolean = false;
    initialFontLoaded: boolean = false;

    mouseX: number = 0;
    mouseY: number = 0;
    glyphBounds: any[] = [];

    fontData: any = null;

    isSliderActive: boolean = false;

    glyphSelectionSequence: number = 0;

    textChangeDebounceTimer: any = null; // NodeJS.Timeout is not available in browser
    textChangeDebounceDelay: number = 1000;

    resizeObserver: ResizeObserver | null = null;

    propertiesSection: HTMLElement | null = null;
    leftSidebar: HTMLElement | null = null;
    rightSidebar: HTMLElement | null = null;
    axesSection: HTMLElement | null = null;
    glyphStackLabel: HTMLElement | null = null;

    zoomAnimation: {
        active: boolean;
        currentFrame: number;
        totalFrames: number;
        startScale: number;
        endScale: number;
        centerX: number;
        centerY: number;
    } = {
        active: false,
        currentFrame: 0,
        totalFrames: 0,
        startScale: 0,
        endScale: 0,
        centerX: 0,
        centerY: 0
    };

    // Internal state properties not in constructor
    cmdKeyPressed: boolean = false;
    altKeyPressed: boolean = false;
    isDraggingCanvas: boolean = false;
    lastMouseX: number = 0;
    lastMouseY: number = 0;
    mouseCanvasX: number = 0;
    mouseCanvasY: number = 0;
    cursorVisible: boolean = true;

    // Measurement tool drag state
    isMeasurementDragging: boolean = false;
    measurementOriginX: number = 0;
    measurementOriginY: number = 0;

    // Auto-pan anchor for text mode (cursor position)
    textModeAutoPanAnchorScreen: { x: number; y: number } | null = null;

    // Flag to suppress rendering during critical operations (e.g., layer data swap)
    renderSuppressed: boolean = false;

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        if (!this.container) {
            console.error(`Container ${containerId} not found`);
            return;
        }

        this.axesManager = new AxesManager();
        this.featuresManager = new FeaturesManager();
        this.textRunEditor = new TextRunEditor(
            this.featuresManager,
            this.axesManager
        );

        this.init();
    }

    init(): void {
        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.cursor = 'default';
        this.canvas.style.outline = 'none'; // Remove focus outline
        this.canvas.tabIndex = 0; // Make canvas focusable
        this.container.appendChild(this.canvas);

        this.outlineEditor.canvas = this.canvas;

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
            this.textRunEditor!
        );

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();

        this.textRunEditor!.init();
    }

    setupHiDPI(): void {
        const dpr = window.devicePixelRatio || 1;

        // Get the container size (not the canvas bounding rect, which might be stale)
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        // Set the canvas size in actual pixels (accounting for DPR)
        this.canvas!.width = containerWidth * dpr;
        this.canvas!.height = containerHeight * dpr;

        // Set CSS size to match container
        this.canvas!.style.width = containerWidth + 'px';
        this.canvas!.style.height = containerHeight + 'px';

        // Get context again and scale for DPR
        this.ctx = this.canvas!.getContext('2d');
        this.ctx!.scale(dpr, dpr);
    }

    setupEventListeners(): void {
        // Mouse events for panning
        this.canvas!.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas!.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas!.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas!.addEventListener('mouseleave', (e) => this.onMouseUp(e));

        // Wheel event for zooming
        this.canvas!.addEventListener('wheel', (e) => this.onWheel(e), {
            passive: false
        });

        // Mouse move for hover detection
        this.canvas!.addEventListener('mousemove', (e) =>
            this.onMouseMoveHover(e)
        );

        // Keyboard events for cursor and text input
        this.canvas!.addEventListener('keydown', (e) => {
            console.log(
                'keydown:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'cmdKeyPressed:',
                this.cmdKeyPressed,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
            // Track Cmd key for panning
            if (e.metaKey || e.key === 'Meta') {
                this.cmdKeyPressed = true;
                this.updateCursorStyle(e);
            }
            // Track Alt key for measurement tool
            if (e.altKey || e.key === 'Alt') {
                this.altKeyPressed = true;
                this.render();
            }
            this.onKeyDown(e);
        });
        this.canvas!.addEventListener('keyup', (e) => {
            console.log(
                'keyup:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed,
                'cmdKeyPressed:',
                this.cmdKeyPressed
            );

            // Track Cmd key release
            if (e.key === 'Meta') {
                console.log('  -> Releasing Cmd key');
                this.cmdKeyPressed = false;
                // Stop panning if it was active
                if (this.isDraggingCanvas) {
                    this.isDraggingCanvas = false;
                }
                this.outlineEditor.onMetaKeyReleased();
                this.updateCursorStyle(e);
            }

            // Track Alt key release
            if (e.key === 'Alt') {
                this.altKeyPressed = false;
                this.render();
            }

            // Track Space key release
            if (e.code === 'Space') {
                console.log('  -> Releasing Space key');
                this.outlineEditor.onSpaceKeyReleased();
            }
        });

        // Reset key states when window loses focus (e.g., Cmd+Tab to switch apps)
        window.addEventListener('blur', () => {
            this.cmdKeyPressed = false;
            this.altKeyPressed = false;
            this.isDraggingCanvas = false;
            this.outlineEditor.onBlur();
            if (this.canvas) {
                this.canvas.style.cursor = this.outlineEditor.active
                    ? 'default'
                    : 'text';
            }
        });

        // Also reset when canvas loses focus
        this.canvas!.addEventListener('blur', () => {
            this.cmdKeyPressed = false;
            this.altKeyPressed = false;
            this.outlineEditor.spaceKeyPressed = false;
            this.isDraggingCanvas = false;
            // Don't exit preview mode when canvas loses focus to sidebar elements
            // (e.g., clicking sliders). Preview mode will be managed by slider events.
            // Only exit preview mode on true blur events (window blur, etc.)
        });

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
        // Note: Settings panel escape is handled in theme-switcher.js with capture phase
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.outlineEditor.onEscapeKey(e);
            }
        });

        // Focus/blur for cursor blinking
        this.canvas!.addEventListener('focus', () => this.onFocus());
        this.canvas!.addEventListener('blur', () => this.onBlur());

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Container resize (for when view dividers are moved)
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        // Sidebar click handlers to restore canvas focus in editor mode
        this.setupSidebarFocusHandlers();
        this.setupAxesManagerEventHandlers();
        this.featuresManager!.on('change', () => {
            this.textRunEditor!.shapeText();
        });
        this.setupTextEditorEventHandlers();
    }

    setupSidebarFocusHandlers(): void {
        // Add event listeners to both sidebars to restore canvas focus when clicked in editor mode
        const leftSidebar = document.getElementById('glyph-properties-sidebar');
        const rightSidebar = document.getElementById('glyph-editor-sidebar');

        const restoreFocus = (e: MouseEvent) => {
            this.outlineEditor.restoreFocus();
        };

        if (leftSidebar) {
            leftSidebar.addEventListener('mousedown', restoreFocus);
        }

        if (rightSidebar) {
            rightSidebar.addEventListener('mousedown', restoreFocus);
        }
    }
    setupAxesManagerEventHandlers(): void {
        this.axesManager!.on('sliderMouseDown', () => {
            this.outlineEditor.onSliderMouseDown();
            // Also capture text mode cursor position for auto-panning
            if (!this.outlineEditor.active && this.textRunEditor) {
                this.captureTextModeAutoPanAnchor();
            }
        });
        this.axesManager!.on('sliderMouseUp', async () => {
            if (this.outlineEditor.active) {
                this.outlineEditor.onSliderMouseUp();
            } else {
                // In text editing mode, restore focus to canvas
                // Clear auto-pan anchor if animation is already complete
                if (!this.axesManager!.isAnimating) {
                    this.textModeAutoPanAnchorScreen = null;
                }
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on('animationInProgress', () => {
            // In text mode, reshape with HarfBuzz and apply auto-pan together (skip render in shapeText)
            if (!this.outlineEditor.active) {
                this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
                this.applyTextModeAutoPanAdjustment();
                this.render(); // Single render after both HarfBuzz and auto-pan are updated
            }
            // In editing mode, don't reshape HarfBuzz here - wait for interpolated data
            // The outlineEditor will handle HarfBuzz update when interpolation completes
            this.outlineEditor.animationInProgress();
        });
        this.axesManager!.on('animationComplete', async () => {
            // Skip layer matching during manual slider interpolation
            // It will be handled properly in sliderMouseUp
            if (this.outlineEditor.isInterpolating) {
                // Don't call shapeText() here - it's already been called in the interpolation callback
                // with auto-pan adjustment. Calling it again would render without auto-pan causing jitter.

                // Only clear flags if slider is not currently active (dragging)
                // If still dragging, keep flags set so auto-pan continues
                if (!this.axesManager!.isSliderActive) {
                    this.outlineEditor.isInterpolating = false;
                    this.outlineEditor.autoPanAnchorScreen = null;
                    this.textModeAutoPanAnchorScreen = null;
                }
                return;
            }

            // If we were animating a layer switch, restore the target layer data
            if (this.outlineEditor.isLayerSwitchAnimating) {
                this.outlineEditor.restoreTargetLayerDataAfterAnimating();
                this.outlineEditor.isLayerSwitchAnimating = false;

                // NOTE: autoSelectMatchingLayer() is already called inside restoreTargetLayerDataAfterAnimating()
                // so we don't need to call it again here

                // Clear auto-pan anchor now that animation is complete
                this.outlineEditor.autoPanAnchorScreen = null;

                this.textRunEditor!.shapeText();
                this.textModeAutoPanAnchorScreen = null;
                return;
            }

            this.textRunEditor!.shapeText();

            // Restore focus to canvas after animation completes (for text editing mode)
            if (!this.outlineEditor.active) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on(
            'onSliderChange',
            this.outlineEditor.onSliderChange.bind(this.outlineEditor)
        );
        // Auto-select or deselect master when slider changes in text mode
        this.axesManager!.on('onSliderChange', () => {
            console.log(
                '[GlyphCanvas] Slider changed, calling autoSelectMatchingMaster'
            );
            this.autoSelectMatchingMaster();
        });
        // Also check after animation completes to handle the final value
        this.axesManager!.on('animationComplete', () => {
            console.log(
                '[GlyphCanvas] Animation complete, calling autoSelectMatchingMaster'
            );
            this.autoSelectMatchingMaster();
        });
    }

    setupTextEditorEventHandlers(): void {
        this.textRunEditor!.on('cursormoved', () => {
            this.panToCursor();
            this.render();
        });
        this.textRunEditor!.on('textchanged', () => {
            this.onTextChange();
        });
        this.textRunEditor!.on('render', () => {
            this.render();
        });
        this.textRunEditor!.on('exitcomponentediting', () => {
            this.outlineEditor.exitAllComponentEditing();
        });
        this.textRunEditor!.on(
            'glyphselected',
            async (
                ix: number,
                previousIndex: number,
                fromKeyboard: boolean = false
            ) => {
                const wasInEditMode = this.outlineEditor.active;

                // Increment sequence counter to track this selection
                this.glyphSelectionSequence++;
                const currentSequence = this.glyphSelectionSequence;

                // Save the previous glyph's vertical bounds BEFORE clearing layer data
                if (
                    wasInEditMode &&
                    previousIndex >= 0 &&
                    previousIndex !== ix &&
                    this.outlineEditor.layerData
                ) {
                    try {
                        const prevBounds =
                            this.outlineEditor.calculateGlyphBoundingBox();
                        if (
                            prevBounds &&
                            previousIndex <
                                this.textRunEditor!.shapedGlyphs.length
                        ) {
                            const prevPos =
                                this.textRunEditor!._getGlyphPosition(
                                    previousIndex
                                );
                            const fontSpaceMinY =
                                prevPos.yOffset + prevBounds.minY;
                            const fontSpaceMaxY =
                                prevPos.yOffset + prevBounds.maxY;

                            // Update accumulated vertical bounds with previous glyph
                            if (
                                !this.viewportManager!.accumulatedVerticalBounds
                            ) {
                                this.viewportManager!.accumulatedVerticalBounds =
                                    {
                                        minY: fontSpaceMinY,
                                        maxY: fontSpaceMaxY
                                    };
                            } else {
                                this.viewportManager!.accumulatedVerticalBounds.minY =
                                    Math.min(
                                        this.viewportManager!
                                            .accumulatedVerticalBounds.minY,
                                        fontSpaceMinY
                                    );
                                this.viewportManager!.accumulatedVerticalBounds.maxY =
                                    Math.max(
                                        this.viewportManager!
                                            .accumulatedVerticalBounds.maxY,
                                        fontSpaceMaxY
                                    );
                            }
                            console.log(
                                'Saved previous glyph vertical bounds:',
                                {
                                    fontSpaceMinY,
                                    fontSpaceMaxY
                                }
                            );
                        }
                    } catch (error) {
                        console.warn(
                            'Could not save previous glyph bounds:',
                            error
                        );
                    }
                }

                // Clear layer data immediately to prevent rendering stale outlines
                this.outlineEditor.layerData = null;

                // Clear glyph_stack when switching to a new glyph
                // It will be rebuilt when a layer is selected for the new glyph
                this.outlineEditor.glyphStack = '';

                if (ix != -1) {
                    this.outlineEditor.active = true;
                }
                // Update breadcrumb (will hide it since component stack is now empty)
                // Need to await doUIUpdate if we want to pan to glyph afterward
                if (
                    fromKeyboard &&
                    wasInEditMode &&
                    ix >= 0 &&
                    previousIndex !== ix
                ) {
                    // Need to wait for layer data to be loaded before panning
                    await this.doUIUpdateAsync();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render/pan for sequence',
                            currentSequence
                        );
                        return;
                    }

                    // Layer data should be loaded now, safe to pan
                    this.panToGlyph(ix);
                } else {
                    // Not panning, just do regular UI update
                    this.doUIUpdate();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render/pan for sequence',
                            currentSequence
                        );
                        return;
                    }

                    // Now render with the loaded data
                    this.render();
                }

                this.outlineEditor.onGlyphSelected();
            }
        );
    }

    onMouseDown(e: MouseEvent): void {
        // Focus the canvas when clicked
        this.canvas!.focus();

        // Priority: If Cmd key is pressed, start canvas panning immediately
        if (this.cmdKeyPressed) {
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }

        // Check for double-click
        if (e.detail === 2) {
            // In outline editor mode with layer selected
            const doubleClickHandled = this.outlineEditor.onDoubleClick(e);
            if (doubleClickHandled) {
                return; // Skip single-click logic
            }

            // Double-click on glyph - select glyph (when not in edit mode)
            if (
                !this.outlineEditor.active &&
                this.outlineEditor.hoveredGlyphIndex >= 0
            ) {
                this.textRunEditor!.selectGlyphByIndex(
                    this.outlineEditor.hoveredGlyphIndex
                );
                return;
            }
        }

        this.outlineEditor.onSingleClick(e);

        // Check if clicking on text to position cursor (only in text edit mode, not on double-click or glyph)
        // Skip if hovering over a glyph since that might be a double-click to enter edit mode
        if (
            !this.outlineEditor.active &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            this.outlineEditor.hoveredGlyphIndex < 0
        ) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.textRunEditor!.clearSelection();
                this.textRunEditor!.cursorPosition = clickedPos;
                this.textRunEditor!.updateCursorVisualPosition();
                this.render();
                // Keep text cursor
                this.canvas!.style.cursor = 'text';
                return; // Don't start dragging if clicking on text
            }
        }

        // Start measurement drag when Alt key is pressed in editing mode
        if (this.altKeyPressed && this.outlineEditor.active) {
            this.isMeasurementDragging = true;
            const rect = this.canvas!.getBoundingClientRect();
            this.measurementOriginX = e.clientX - rect.left;
            this.measurementOriginY = e.clientY - rect.top;
            this.render();
            return;
        }

        // Start canvas panning when Cmd key is pressed
        if (this.cmdKeyPressed) {
            console.log(
                'Starting canvas panning, cmdKeyPressed:',
                this.cmdKeyPressed
            );
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas!.style.cursor = 'grabbing';
        } else {
            console.log(
                'Not starting panning, cmdKeyPressed:',
                this.cmdKeyPressed
            );
        }
    }

    onMouseMove(e: MouseEvent): void {
        this.outlineEditor.onMouseMove(e);

        // Handle measurement dragging
        if (this.isMeasurementDragging) {
            this.render();
            return;
        }

        // Handle canvas panning
        if (this.isDraggingCanvas) {
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;

            this.viewportManager!.pan(deltaX, deltaY);
            this.render();

            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }
    }

    onMouseUp(e: MouseEvent): void {
        this.outlineEditor.onMouseUp(e);
        this.isDraggingCanvas = false;
        this.isMeasurementDragging = false;

        // Update cursor based on current mouse position and Cmd key state
        this.updateCursorStyle(e);
    }

    onWheel(e: WheelEvent): void {
        e.preventDefault();

        const rect = this.canvas!.getBoundingClientRect();
        this.viewportManager!.handleWheel(e, rect, this.render.bind(this));
    }

    onMouseMoveHover(e: MouseEvent): void {
        if (this.outlineEditor.draggingSomething) return; // Don't detect hover while dragging

        const rect = this.canvas!.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;

        // Don't perform hit detection when measurement tool is active
        if (!this.altKeyPressed && !this.isMeasurementDragging) {
            this.outlineEditor.performHitDetection(e);
            this.updateHoveredGlyph();
        }

        // Update cursor style based on position (after updating hover states)
        this.updateCursorStyle(e);

        // Re-render when alt key is pressed to update crosshair position
        if (this.altKeyPressed) {
            this.render();
        }
    }

    updateCursorStyle(e: MouseEvent | KeyboardEvent): void {
        // Alt key pressed in editing mode = crosshair cursor for measurement tool
        if (this.altKeyPressed && this.outlineEditor.active) {
            this.canvas!.style.cursor = 'crosshair';
            return;
        }

        // Cmd key pressed = always show grab cursor for panning
        if (this.cmdKeyPressed) {
            this.canvas!.style.cursor = this.isDraggingCanvas
                ? 'grabbing'
                : 'grab';
            return;
        }

        // In outline editor mode, let it control the cursor
        if (this.outlineEditor.active) {
            this.outlineEditor.cursorStyle();
            return;
        }

        // In text mode, show pointer when hovering over a glyph, otherwise text cursor
        if (this.outlineEditor.hoveredGlyphIndex !== -1) {
            this.canvas!.style.cursor = 'pointer';
        } else {
            this.canvas!.style.cursor = 'text';
        }
    }

    updateHoveredGlyph(): void {
        let foundIndex = -1;

        // Check each glyph using path hit testing
        let xPosition = 0;
        for (let i = 0; i < this.textRunEditor!.shapedGlyphs.length; i++) {
            const glyph = this.textRunEditor!.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Check if point is within this glyph's path
            try {
                const glyphData =
                    this.textRunEditor!.hbFont.glyphToPath(glyphId);
                if (glyphData) {
                    const path = new Path2D(glyphData);

                    // Create a temporary context for hit testing with proper transform
                    this.ctx!.save();

                    // Apply the same transform as rendering
                    const transform =
                        this.viewportManager!.getTransformMatrix();
                    this.ctx!.setTransform(
                        transform.a,
                        transform.b,
                        transform.c,
                        transform.d,
                        transform.e,
                        transform.f
                    );
                    this.ctx!.translate(x, y);

                    // Test if mouse point is in path or stroke (in canvas coordinates)
                    // Use stroke for better hit detection tolerance
                    // lineWidth is in transformed space, so divide by scale to get screen pixels
                    this.ctx!.lineWidth =
                        APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE /
                        this.viewportManager!.scale;
                    if (
                        this.ctx!.isPointInPath(
                            path,
                            this.mouseX,
                            this.mouseY
                        ) ||
                        this.ctx!.isPointInStroke(
                            path,
                            this.mouseX,
                            this.mouseY
                        )
                    ) {
                        foundIndex = i;
                        this.ctx!.restore();
                        break;
                    }

                    this.ctx!.restore();
                }
            } catch (error) {
                // Skip this glyph if path extraction fails
            }

            xPosition += xAdvance;
        }

        if (foundIndex !== this.outlineEditor.hoveredGlyphIndex) {
            this.outlineEditor.hoveredGlyphIndex = foundIndex;
            this.render();
        }
    }

    onResize(): void {
        this.setupHiDPI();
        this.render();
    }

    setFont(fontArrayBuffer: ArrayBuffer): void {
        if (!fontArrayBuffer) {
            console.error('No font data provided');
            return;
        }

        try {
            // Store current variation settings to restore after font reload
            const previousVariationSettings = {
                ...this.axesManager!.variationSettings
            };

            // Parse with opentype.js for glyph path extraction
            this.opentypeFont = opentype.parse(fontArrayBuffer);
            this.axesManager!.opentypeFont = this.opentypeFont;
            this.featuresManager!.opentypeFont = this.opentypeFont;
            this.textRunEditor!.opentypeFont = this.opentypeFont;
            console.log(
                'Font parsed with opentype.js:',
                this.opentypeFont!.names.fontFamily.en
            );

            // Create HarfBuzz blob, face, and font if HarfBuzz is loaded
            this.textRunEditor!.setFont(new Uint8Array(fontArrayBuffer)).then(
                (hbFont) => {
                    // Restore previous variation settings before updating UI
                    // This ensures the sliders show the previous values
                    this.axesManager!.variationSettings =
                        previousVariationSettings;

                    // Update axes UI (will restore slider positions from variationSettings)
                    this.axesManager!.updateAxesUI();
                    console.log('Updated axes UI after font load');

                    // Update features UI (async, then shape text)
                    this.featuresManager!.updateFeaturesUI().then(async () => {
                        // Shape text with new font after features are initialized
                        this.textRunEditor!.shapeText();

                        // Update properties UI to show master list in text mode
                        await this.updatePropertiesUI();

                        // Auto-select first master on initial load
                        if (
                            !this.initialFontLoaded &&
                            fontManager.currentFont?.fontModel?.masters
                        ) {
                            const firstMaster =
                                fontManager.currentFont.fontModel.masters[0];
                            if (
                                firstMaster &&
                                firstMaster.id &&
                                firstMaster.location
                            ) {
                                await this.selectMaster(
                                    firstMaster.id,
                                    firstMaster.location
                                );
                            }
                        }

                        // Zoom to fit the entire text in the canvas only on initial load
                        if (!this.initialFontLoaded) {
                            const rect = this.canvas!.getBoundingClientRect();
                            this.viewportManager!.zoomToFitText(
                                this.textRunEditor!.shapedGlyphs,
                                rect,
                                this.render.bind(this)
                            );
                            this.initialFontLoaded = true;
                        }
                    });
                }
            );
        } catch (error) {
            console.error('Error setting font:', error);
        }
    }

    async enterGlyphEditModeAtCursor(): Promise<void> {
        // Enter glyph edit mode for the glyph at the current cursor position
        if (this.outlineEditor.active) return;
        let glyphIndex = this.textRunEditor!.getGlyphIndexAtCursorPosition();

        if (glyphIndex !== undefined && glyphIndex >= 0) {
            console.log(
                `Entering glyph edit mode at cursor position ${this.textRunEditor!.cursorPosition}, glyph index ${glyphIndex}`
            );
            await this.textRunEditor!.selectGlyphByIndex(glyphIndex);
        } else {
            console.log(
                `No glyph found at cursor position ${this.textRunEditor!.cursorPosition}`
            );
        }
    }

    exitGlyphEditMode(): void {
        // Exit glyph edit mode and return to text edit mode

        // Determine cursor position based on whether glyph was typed or shaped
        const savedGlyphIndex = this.textRunEditor!.selectedGlyphIndex;

        const glyph = this.textRunEditor!.shapedGlyphs[savedGlyphIndex];
        console.log(
            '[v2024-12-01-FIX] exitGlyphEditMode CALLED - selectedGlyphIndex:',
            this.textRunEditor!.selectedGlyphIndex,
            'shapedGlyphs.length:',
            this.textRunEditor!.shapedGlyphs.length,
            'glyph:',
            glyph
        );

        // Update cursor position to before the edited glyph
        if (
            savedGlyphIndex >= 0 &&
            savedGlyphIndex < this.textRunEditor!.shapedGlyphs.length
        ) {
            const glyphInfo =
                this.textRunEditor!.isGlyphFromTypedCharacter(savedGlyphIndex);
            const clusterStart = glyph.cl || 0;
            const isRTL = this.textRunEditor!.isPositionRTL(clusterStart);

            console.log(
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
                this.textRunEditor!.cursorPosition = glyphInfo.logicalPosition;
                console.log(
                    'Typed character - set cursor position at logical position:',
                    this.textRunEditor!.cursorPosition
                );
            } else {
                // For shaped glyphs, position cursor at the cluster start
                this.textRunEditor!.cursorPosition = clusterStart;
                console.log(
                    'Shaped glyph - set cursor position at cluster start:',
                    this.textRunEditor!.cursorPosition
                );
            }
            this.textRunEditor!.updateCursorVisualPosition();
        }

        this.outlineEditor.active = false;
        this.textRunEditor!.selectedGlyphIndex = -1;
        this.outlineEditor.selectedLayerId = null;

        // Clear outline editor state
        this.outlineEditor.clearState();

        // Auto-select matching master based on current axis slider positions
        this.autoSelectMatchingMaster();

        console.log(`Exited glyph edit mode - returned to text edit mode`);
        this.updatePropertiesUI();
        this.render();
    }

    async displayMastersList(): Promise<void> {
        // Display masters list for text mode
        console.log('[GlyphCanvas] displayMastersList called');

        if (!fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model available');
            return;
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || fontModel.masters.length === 0) {
            console.log('[GlyphCanvas] No masters found');
            return;
        }

        console.log('[GlyphCanvas] Found', fontModel.masters.length, 'masters');

        // Add masters section title
        const mastersTitle = document.createElement('div');
        mastersTitle.className = 'editor-section-title';
        mastersTitle.textContent = 'Masters';
        this.propertiesSection!.appendChild(mastersTitle);

        // Create masters list
        const mastersList = document.createElement('div');
        mastersList.className = 'editor-layers-list'; // Reuse layer list styles

        for (const master of fontModel.masters) {
            const masterItem = document.createElement('div');
            masterItem.className = 'editor-layer-item'; // Reuse layer item styles
            masterItem.setAttribute('data-master-id', master.id!);

            if (this.textRunEditor!.selectedMasterId === master.id) {
                masterItem.classList.add('selected');
            }

            // Format axis values for display (e.g., "wght:400, wdth:100")
            // Convert from design coordinates to userspace coordinates
            let axisValues = '';
            if (master.location && fontModel.axes) {
                // Convert design location to userspace location
                const userspaceLocation = designspaceToUserspace(
                    master.location,
                    fontModel.axes as any
                );

                const axesOrder =
                    (fontModel as any).axesOrder ||
                    Object.keys(userspaceLocation).sort();
                const locationParts = axesOrder
                    .filter((tag: string) => tag in userspaceLocation)
                    .map(
                        (tag: string) =>
                            `${tag}:${Math.round(userspaceLocation[tag])}`
                    )
                    .join(', ');
                axisValues = locationParts;
            }

            // Get master name, handling I18NDictionary
            const masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name && 'en' in master.name
                      ? master.name.en
                      : null;
            masterItem.textContent = axisValues || masterName || 'Default';

            // Click handler to select master and animate to its location
            masterItem.addEventListener('click', () => {
                this.selectMaster(master.id!, master.location || {});
                // Restore focus to canvas if editor view is active
                const editorView = document.getElementById('view-editor');
                if (editorView && editorView.classList.contains('focused')) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            });

            mastersList.appendChild(masterItem);
        }

        this.propertiesSection!.appendChild(mastersList);
    }

    async selectMaster(
        masterId: string,
        masterLocation: Record<string, number>
    ): Promise<void> {
        // Select a master and animate to its location
        console.log(
            '[GlyphCanvas] Selecting master:',
            masterId,
            'with design location:',
            masterLocation
        );

        // Convert design location to userspace location
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.axes) {
            console.warn(
                '[GlyphCanvas] Cannot convert location: no axes available'
            );
            return;
        }

        const userspaceLocation = designspaceToUserspace(
            masterLocation,
            fontModel.axes as any
        );
        console.log(
            '[GlyphCanvas] Converted to userspace location:',
            userspaceLocation
        );

        // Store selected master ID
        this.textRunEditor!.selectedMasterId = masterId;

        // Update master list UI
        this.updateMasterSelection();

        // Capture cursor position for auto-pan during animation
        this.captureTextModeAutoPanAnchor();

        // Animate to master location (10 frames) using userspace coordinates
        await this.animateToLocation(userspaceLocation, 10);

        // Clear auto-pan anchor after animation
        this.textModeAutoPanAnchorScreen = null;
    }

    async cycleMasters(moveUp: boolean): Promise<void> {
        // Cycle through masters with Cmd+Up (previous) or Cmd+Down (next) in text mode
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.masters || fontModel.masters.length === 0) {
            return;
        }

        const masters = fontModel.masters;
        const currentMasterId = this.textRunEditor!.selectedMasterId;

        // Find current master index
        let currentIndex = masters.findIndex((m) => m.id === currentMasterId);

        // If no master selected or not found, select first master
        if (currentIndex === -1) {
            await this.selectMaster(masters[0].id!, masters[0].location || {});
            return;
        }

        // Calculate next index (with wrapping)
        let nextIndex;
        if (moveUp) {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) {
                nextIndex = masters.length - 1; // Wrap to last
            }
        } else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= masters.length) {
                nextIndex = 0; // Wrap to first
            }
        }

        // Select the next master
        await this.selectMaster(
            masters[nextIndex].id!,
            masters[nextIndex].location || {}
        );
    }

    async displayLayersList(): Promise<void> {
        // Fetch and display layers list
        this.fontData = await fontManager.fetchGlyphData(
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
        // But only if we're NOT in component editing mode - when editing a component,
        // currentGlyphName should stay set to the component reference
        if (
            this.fontData.glyphName &&
            !this.outlineEditor.isEditingComponent()
        ) {
            this.outlineEditor.currentGlyphName = this.fontData.glyphName;
            console.log(
                '[GlyphCanvas]',
                'Set currentGlyphName from fontData:',
                this.outlineEditor.currentGlyphName
            );
        }

        // Add layers section title
        const layersTitle = document.createElement('div');
        layersTitle.className = 'editor-section-title';
        layersTitle.textContent = 'Foreground Layers';
        this.propertiesSection!.appendChild(layersTitle);

        // Get filtered and sorted layers from the object model
        // This uses Glyph.layers which filters out background layers and copies,
        // and sorts by master order
        const glyphName = this.getCurrentGlyphName();
        const fontModel = fontManager.currentFont?.fontModel;
        const glyph = fontModel?.glyphs.find((g) => g.name === glyphName);
        const filteredLayers = glyph?.layers || [];

        // Create layers list
        const layersList = document.createElement('div');
        layersList.className = 'editor-layers-list';

        for (const layer of filteredLayers) {
            const layerItem = document.createElement('div');
            layerItem.className = 'editor-layer-item';
            if (this.outlineEditor.selectedLayerId === layer.id) {
                layerItem.classList.add('selected');
            }
            layerItem.setAttribute('data-layer-id', layer.id!); // Add data attribute for selection updates

            // Extract master ID from layer
            const masterId =
                layer.master &&
                typeof layer.master === 'object' &&
                'DefaultForMaster' in layer.master
                    ? layer.master.DefaultForMaster
                    : layer.id;

            // Find the master for this layer
            const master = this.fontData.masters.find(
                (m: any) => m.id === masterId
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
                    .filter((tag: string) => tag in master.location)
                    .map(
                        (tag: string) =>
                            `${tag}:${Math.round(master.location[tag])}`
                    )
                    .join(', ');
                axisValues = locationParts;
            }

            layerItem.textContent = axisValues || layer.name || 'Default';

            // Click handler - create minimal layer object with required properties
            layerItem.addEventListener('click', () => {
                this.outlineEditor.selectLayer({
                    id: layer.id,
                    name: layer.name,
                    _master: masterId, // Use the masterId we extracted above
                    shapes: [],
                    isInterpolated: false
                } as any);
                // Restore focus to canvas if editor view is active
                const editorView = document.getElementById('view-editor');
                if (editorView && editorView.classList.contains('focused')) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            });

            layersList.appendChild(layerItem);
        }

        this.propertiesSection!.appendChild(layersList);

        // Add glyph_stack debug label (development mode only)
        if (window.isDevelopment?.()) {
            const stackLabel = document.createElement('div');
            stackLabel.className = 'glyph-stack-debug';
            stackLabel.style.cssText = `
                margin-top: 8px;
                padding: 8px;
                background: var(--input-bg);
                border-radius: 4px;
                font-family: 'IBM Plex Sans', monospace;
                font-size: 11px;
                color: var(--text-muted);
                word-break: break-all;
                line-height: 1.4;
            `;
            stackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            this.glyphStackLabel = stackLabel; // Store reference for updates
            this.propertiesSection!.appendChild(stackLabel);
        }

        // Auto-select layer if current axis values match a layer's master location
        await this.outlineEditor.autoSelectMatchingLayer();
    }

    updateMasterSelection(): void {
        // Update the visual selection highlight for master items
        if (!this.propertiesSection) return;

        const masterItems =
            this.propertiesSection.querySelectorAll('[data-master-id]');
        masterItems.forEach((item) => {
            const masterId = item.getAttribute('data-master-id');
            if (masterId === this.textRunEditor!.selectedMasterId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    autoSelectMatchingMaster(): void {
        // Check if current axis values match a master location
        // If so, select that master. If not, deselect current master.
        console.log('[GlyphCanvas] autoSelectMatchingMaster called');
        if (!fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model, returning');
            return;
        }
        if (this.outlineEditor.active) {
            console.log('[GlyphCanvas] Outline editor active, returning');
            return; // Only for text mode
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || !fontModel.axes) {
            console.log('[GlyphCanvas] No masters or axes, returning');
            return;
        }

        const currentLocationUserspace: Record<string, number> = {};

        // Get current location from axes manager (userspace coordinates)
        if (!this.axesManager) {
            console.log('[GlyphCanvas] No axes manager, returning');
            return;
        }

        const axes = this.axesManager.getVariationAxes();
        for (const axis of axes) {
            currentLocationUserspace[axis.tag] =
                this.axesManager.getAxisValue(axis.tag) || axis.defaultValue;
        }

        // Convert to designspace for comparison with master.location (which is in designspace)
        const currentLocation = userspaceToDesignspace(
            currentLocationUserspace,
            fontModel.axes as any
        );

        // Check each master for a match (tolerance of 0.5)
        const tolerance = 0.5;
        let matchingMaster: any = null;

        console.log(
            '[GlyphCanvas] Checking masters. Current location (userspace):',
            currentLocationUserspace,
            '(designspace):',
            currentLocation
        );

        for (const master of fontModel.masters) {
            if (!master.location) continue;

            // Compare in designspace - both are in designspace
            const masterLocation = master.location;

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'location (designspace):',
                masterLocation
            );

            // Check if all axes match within tolerance
            let allMatch = true;
            for (const tag in masterLocation) {
                const masterValue = masterLocation[tag];
                const currentValue = currentLocation[tag];
                const diff = Math.abs(masterValue - currentValue);
                console.log(
                    `[GlyphCanvas]   Axis ${tag}: master=${masterValue}, current=${currentValue}, diff=${diff}, match=${diff <= tolerance}`
                );
                if (
                    currentValue === undefined ||
                    Math.abs(masterValue - currentValue) > tolerance
                ) {
                    allMatch = false;
                    break;
                }
            }

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'allMatch:',
                allMatch
            );

            if (allMatch) {
                matchingMaster = master;
                break;
            }
        }

        // Update selection based on match
        if (
            matchingMaster &&
            this.textRunEditor!.selectedMasterId !== matchingMaster.id
        ) {
            console.log(
                '[GlyphCanvas] Auto-selecting master:',
                matchingMaster.id
            );
            this.textRunEditor!.selectedMasterId = matchingMaster.id;
            this.updateMasterSelection();
        } else if (
            !matchingMaster &&
            this.textRunEditor!.selectedMasterId !== null
        ) {
            console.log('[GlyphCanvas] Deselecting master (no match)');
            this.textRunEditor!.selectedMasterId = null;
            this.updateMasterSelection();
        }
    }

    async animateToLocation(
        targetLocation: Record<string, number>,
        frames: number
    ): Promise<void> {
        // Animate designspace location from current to target over specified frames
        const startLocation: Record<string, number> = {};

        // Get current location from axes manager
        for (const tag in targetLocation) {
            startLocation[tag] =
                this.axesManager!.getAxisValue(tag) || targetLocation[tag];
        }

        console.log(
            '[GlyphCanvas] Animating from',
            startLocation,
            'to',
            targetLocation
        );

        // Animate over frames
        for (let frame = 0; frame <= frames; frame++) {
            const t = frame / frames; // 0 to 1
            const currentLocation: Record<string, number> = {};

            for (const tag in targetLocation) {
                currentLocation[tag] =
                    startLocation[tag] +
                    (targetLocation[tag] - startLocation[tag]) * t;
            }

            // Update axes
            for (const tag in currentLocation) {
                this.axesManager!.setAxisValue(tag, currentLocation[tag]);
            }

            // Update axis sliders UI to show the animation
            this.axesManager!.updateAxisSliders();

            // Shape text with HarfBuzz and apply auto-pan for all frames
            this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
            this.applyTextModeAutoPanAdjustment();
            this.render();

            // Wait for next frame
            if (frame < frames) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
    }

    getCurrentGlyphName(): string {
        // We're editing the main glyph
        const glyphId = this.textRunEditor!.selectedGlyph?.g;
        if (!glyphId) {
            return 'undefined';
        }
        let glyphName = `GID ${glyphId}`;

        // Get glyph name from font manager (source font) instead of compiled font
        if (fontManager && fontManager.currentFont) {
            glyphName = fontManager.getGlyphName(glyphId);
        } else if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
            // Fallback to compiled font name (will be production name like glyph00001)
            const glyph = this.opentypeFont.glyphs.get(glyphId);
            if (glyph.name) {
                glyphName = glyph.name;
            }
        }
        return glyphName;
    }

    doUIUpdate(): void {
        this.updateComponentBreadcrumb();
        this.updatePropertiesUI();
        this.render();
        this.outlineEditor.performHitDetection(null);
    }

    async doUIUpdateAsync(): Promise<void> {
        // Async version that waits for layer data to be loaded
        this.updateComponentBreadcrumb();
        await this.updatePropertiesUI();
        this.render();
        this.outlineEditor.performHitDetection(null);
    }

    updateComponentBreadcrumb(): void {
        // This function now just calls updateEditorTitleBar
        // Keeping it for backward compatibility with existing calls
        this.outlineEditor.updateEditorTitleBar();
    }

    getSortedLayers(): any[] {
        if (
            !this.fontData ||
            !this.fontData.layers ||
            this.fontData.layers.length === 0
        ) {
            return [];
        }

        // Get sorted layers (same as in displayLayersList)
        // Sort layers by master order (order in which masters are defined in font.masters)
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(
                (m: any) => m.id === a._master
            );
            const masterIndexB = this.fontData.masters.findIndex(
                (m: any) => m.id === b._master
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
        return sortedLayers;
    }

    doubleClickOnGlyph(index: number): void {
        if (index !== this.textRunEditor!.selectedGlyphIndex) {
            this.textRunEditor!.selectGlyphByIndex(index);
            return;
        }
    }

    frameCurrentGlyph(margin: number | null = null): void {
        // Pan and zoom to show the current glyph with margin around it
        // Delegates to ViewportManager.frameGlyph

        if (
            !this.outlineEditor.active ||
            this.textRunEditor!.selectedGlyphIndex < 0
        ) {
            return;
        }

        const bounds = this.outlineEditor.calculateGlyphBoundingBox();
        if (!bounds) {
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor!._getGlyphPosition(
            this.textRunEditor!.selectedGlyphIndex
        );

        // If editing inside a component, transform the bounding box to glyph space
        let transformedBounds = bounds;
        if (this.outlineEditor.isEditingComponent()) {
            const transform = this.outlineEditor.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;

            // Transform all four corners of the bbox
            const corners = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY }
            ];

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const corner of corners) {
                const transformedX = a * corner.x + c * corner.y + tx;
                const transformedY = b * corner.x + d * corner.y + ty;
                minX = Math.min(minX, transformedX);
                minY = Math.min(minY, transformedY);
                maxX = Math.max(maxX, transformedX);
                maxY = Math.max(maxY, transformedY);
            }

            transformedBounds = {
                minX,
                minY,
                maxX,
                maxY,
                width: maxX - minX,
                height: maxY - minY
            };
        }

        // Delegate to ViewportManager
        this.viewportManager!.frameGlyph(
            transformedBounds,
            glyphPosition,
            rect,
            this.render.bind(this),
            margin
        );
    }

    panToGlyph(glyphIndex: number): void {
        // Pan to show a specific glyph (used when switching glyphs with cmd+left/right)
        // Delegates to ViewportManager.panToGlyph

        if (
            !this.outlineEditor.active ||
            glyphIndex < 0 ||
            glyphIndex >= this.textRunEditor!.shapedGlyphs.length
        ) {
            console.log(
                'panToGlyph: early return - not in edit mode or invalid index',
                {
                    isGlyphEditMode: this.outlineEditor.active,
                    glyphIndex,
                    shapedGlyphsLength: this.textRunEditor!.shapedGlyphs?.length
                }
            );
            return;
        }

        const bounds = this.outlineEditor.calculateGlyphBoundingBox();
        if (!bounds) {
            console.log('panToGlyph: no bounds calculated');
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor!._getGlyphPosition(glyphIndex);

        // If editing inside a component, transform the bounding box to glyph space
        let transformedBounds = bounds;
        if (this.outlineEditor.isEditingComponent()) {
            const transform = this.outlineEditor.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;

            // Transform all four corners of the bbox
            const corners = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY }
            ];

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const corner of corners) {
                const transformedX = a * corner.x + c * corner.y + tx;
                const transformedY = b * corner.x + d * corner.y + ty;
                minX = Math.min(minX, transformedX);
                minY = Math.min(minY, transformedY);
                maxX = Math.max(maxX, transformedX);
                maxY = Math.max(maxY, transformedY);
            }

            transformedBounds = {
                minX,
                minY,
                maxX,
                maxY,
                width: maxX - minX,
                height: maxY - minY
            };
        }

        // Delegate to ViewportManager
        this.viewportManager!.panToGlyph(
            transformedBounds,
            glyphPosition,
            rect,
            this.render.bind(this)
        );
    }

    async updatePropertiesUI(): Promise<void> {
        if (!this.propertiesSection) return;

        // Update editor title bar with glyph name
        this.outlineEditor.updateEditorTitleBar();

        // In text mode, show master list
        if (!this.outlineEditor.active) {
            // Build content off-screen first, then swap in one operation
            const tempContainer = document.createElement('div');
            const oldPropertiesSection = this.propertiesSection;
            this.propertiesSection = tempContainer;

            await this.displayMastersList();

            requestAnimationFrame(() => {
                oldPropertiesSection.innerHTML = '';
                while (tempContainer.firstChild) {
                    oldPropertiesSection.appendChild(tempContainer.firstChild);
                }
            });

            this.propertiesSection = oldPropertiesSection;
            return;
        }

        if (
            this.textRunEditor!.selectedGlyphIndex >= 0 &&
            this.textRunEditor!.selectedGlyphIndex <
                this.textRunEditor!.shapedGlyphs.length
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
                this.propertiesSection!.innerHTML = '';
                const emptyMessage = document.createElement('div');
                emptyMessage.className = 'editor-empty-message';
                emptyMessage.textContent = 'No glyph selected';
                this.propertiesSection!.appendChild(emptyMessage);
            });
        }
    }

    onTextChange(): void {
        // Debounce font recompilation when text changes
        if (this.textChangeDebounceTimer) {
            clearTimeout(this.textChangeDebounceTimer);
        }

        this.textChangeDebounceTimer = setTimeout(() => {
            if (fontManager && fontManager.isReady()) {
                console.log('🔄 Text changed, recompiling editing font...');
                fontManager
                    .compileEditingFont(this.textRunEditor!.textBuffer)
                    .catch((error: any) => {
                        console.error(
                            'Failed to recompile editing font:',
                            error
                        );
                    });
            }
        }, this.textChangeDebounceDelay);
    }

    startKeyboardZoom(zoomIn: boolean): void {
        // Don't start a new animation if one is already in progress
        if (this.zoomAnimation.active) return;

        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        const zoomFactor = zoomIn
            ? settings.ZOOM_KEYBOARD_FACTOR
            : 1 / settings.ZOOM_KEYBOARD_FACTOR;

        // Get canvas center for zoom
        const rect = this.canvas!.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        // Set up animation
        this.zoomAnimation.active = true;
        this.zoomAnimation.currentFrame = 0;
        this.zoomAnimation.totalFrames = 10;
        this.zoomAnimation.startScale = this.viewportManager!.scale;
        this.zoomAnimation.endScale = this.viewportManager!.scale * zoomFactor;
        this.zoomAnimation.centerX = centerX;
        this.zoomAnimation.centerY = centerY;

        // Start animation loop
        this.animateKeyboardZoom();
    }

    animateKeyboardZoom(): void {
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
        const zoomFactor = currentScale / this.viewportManager!.scale;
        this.viewportManager!.zoom(
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

    render(): void {
        // Skip rendering if suppressed (during critical operations)
        if (this.renderSuppressed) {
            return;
        }

        // Update glyph_stack label if it exists (development mode only)
        if (window.isDevelopment?.()) {
            // If we don't have a reference, try to find it in the DOM (in case it was created asynchronously)
            if (!this.glyphStackLabel) {
                this.glyphStackLabel = this.propertiesSection?.querySelector(
                    '.glyph-stack-debug'
                ) as HTMLElement | null;
            }

            if (this.glyphStackLabel) {
                this.glyphStackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            }
        }

        this.renderer!.render();
    }

    destroy(): void {
        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Clean up HarfBuzz resources
        this.textRunEditor!.destroyHarfbuzz();

        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    // ==================== Cursor Methods ====================

    onFocus(): void {
        this.isFocused = true;
        this.cursorVisible = true;
        // Don't render on focus change if in preview mode (no cursor visible)
        if (!this.outlineEditor.isPreviewMode) {
            this.render();
        }
    }

    onBlur(): void {
        this.isFocused = false;
        // Don't render on blur if in preview mode (no cursor visible)
        if (!this.outlineEditor.isPreviewMode) {
            this.render();
        }
    }

    onKeyDown(e: KeyboardEvent): void {
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

        // Handle Cmd+Up/Down to cycle through masters in text mode
        if (
            (e.metaKey || e.ctrlKey) &&
            !this.outlineEditor.active &&
            (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
            e.preventDefault();
            this.cycleMasters(e.key === 'ArrowUp');
            return;
        }

        // Handle arrow keys and spacebar in outline editor
        this.outlineEditor.onKeyDown(e);

        // Handle Cmd+Enter to enter glyph edit mode at cursor position (text editing mode only)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.key === 'Enter' &&
            !this.outlineEditor.active
        ) {
            e.preventDefault();
            this.enterGlyphEditModeAtCursor();
            return;
        }

        // Handle cursor navigation and text editing
        // Note: Escape key is handled globally in constructor for better focus handling

        // Cmd+0 / Ctrl+0 - Frame current glyph (in edit mode) or reset zoom (in text mode)
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault();
            if (
                this.outlineEditor.active &&
                this.textRunEditor!.selectedGlyphIndex >= 0
            ) {
                // In glyph edit mode: frame the current glyph
                this.frameCurrentGlyph();
            } else {
                // In text mode: reset zoom and position
                this.resetZoomAndPosition();
            }
            return;
        }

        // In glyph edit mode: only prevent default for keys we handle
        // Let browser shortcuts (Cmd+R, Cmd+T, Cmd+W, etc.) pass through
        if (this.outlineEditor.active) {
            // Only prevent default for non-modifier keys and arrow keys that we handle
            if (!e.metaKey && !e.ctrlKey) {
                e.preventDefault();
            }
            return;
        }

        // Text run selection and editing shortcuts
        this.textRunEditor!.handleKeyDown(e);
    }

    getClickedCursorPosition(e: MouseEvent): number | null {
        // Convert click position to cursor position
        const rect = this.canvas!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        let { x: glyphX, y: glyphY } =
            this.viewportManager!.getFontSpaceCoordinates(mouseX, mouseY);

        // Check if clicking within cursor height range (same as cursor drawing)
        // Cursor goes from 1000 (top) to -300 (bottom)
        if (glyphY > 1000 || glyphY < -300) {
            return null; // Clicked outside cursor height - allow panning
        }
        return this.textRunEditor!.getGlyphIndexAtClick(glyphX, glyphY);
    }

    isCursorVisible(): boolean {
        // Check if cursor is within the visible viewport
        const rect = this.canvas!.getBoundingClientRect();

        // Transform cursor position from font space to screen space
        const screenX =
            this.textRunEditor!.cursorX * this.viewportManager!.scale +
            this.viewportManager!.panX;

        // Define margin from edges (in screen pixels)
        const margin = 30;

        // Check if cursor is within visible bounds with margin
        return screenX >= margin && screenX <= rect.width - margin;
    }

    panToCursor(): void {
        // Pan viewport to show cursor with smooth animation
        if (this.isCursorVisible()) {
            return; // Cursor is already visible
        }

        const rect = this.canvas!.getBoundingClientRect();
        const margin = 30; // Same margin as visibility check

        // Calculate target panX to center cursor with margin
        const screenX =
            this.textRunEditor!.cursorX * this.viewportManager!.scale +
            this.viewportManager!.panX;

        let targetPanX;
        if (screenX < margin) {
            // Cursor is off left edge - position it at left margin
            targetPanX =
                margin -
                this.textRunEditor!.cursorX * this.viewportManager!.scale;
        } else {
            // Cursor is off right edge - position it at right margin
            targetPanX =
                rect.width -
                margin -
                this.textRunEditor!.cursorX * this.viewportManager!.scale;
        }

        // Start animation
        this.viewportManager!.animatePan(
            targetPanX,
            this.viewportManager!.panY,
            this.render.bind(this)
        );
    }

    captureTextModeAutoPanAnchor(): void {
        // Capture the current cursor screen position for auto-panning during slider animation
        if (!this.textRunEditor || !this.viewportManager) {
            this.textModeAutoPanAnchorScreen = null;
            return;
        }

        // Convert cursor position from font coordinates to screen coordinates
        const screenPos = this.viewportManager.fontToScreenCoordinates(
            this.textRunEditor.cursorX,
            0 // Y position doesn't matter for horizontal text
        );

        this.textModeAutoPanAnchorScreen = screenPos;
    }

    applyTextModeAutoPanAdjustment(): void {
        // Adjust pan to keep cursor at the anchor position during animation
        if (
            !this.textModeAutoPanAnchorScreen ||
            !this.textRunEditor ||
            !this.viewportManager
        ) {
            return;
        }

        // Get current cursor screen position
        const currentScreenPos = this.viewportManager.fontToScreenCoordinates(
            this.textRunEditor.cursorX,
            0
        );

        // Calculate the offset
        const offsetX = this.textModeAutoPanAnchorScreen.x - currentScreenPos.x;

        // Apply the pan adjustment (only horizontal for text mode)
        this.viewportManager.panX += offsetX;
    }

    resetZoomAndPosition(): void {
        // Zoom to fit text, matching the initial view when font loads
        const rect = this.canvas!.getBoundingClientRect();
        this.viewportManager!.zoomToFitText(
            this.textRunEditor!.shapedGlyphs,
            rect,
            this.render.bind(this)
        );
    }

    toGlyphLocal(x: number, y: number): { glyphX: number; glyphY: number } {
        return this.viewportManager!.getGlyphLocalCoordinates(
            x,
            y,
            this.textRunEditor!.shapedGlyphs,
            this.textRunEditor!.selectedGlyphIndex
        );
    }

    isPointInComponent(
        componentShape: any,
        transform: any,
        parentTransform: number[],
        glyphX: number,
        glyphY: number
    ) {
        const path = new Path2D();
        this.renderer!.buildPathFromNodes(componentShape.nodes, path);
        path.closePath();

        this.ctx!.save();
        // Always use identity transform since glyphX/glyphY are already
        // in glyph-local space (xPosition has been subtracted)
        this.ctx!.setTransform(1, 0, 0, 1, 0, 0);

        this.ctx!.transform(
            transform[0],
            transform[1],
            transform[2],
            transform[3],
            transform[4],
            transform[5]
        );
        this.ctx!.transform(
            parentTransform[0],
            parentTransform[1],
            parentTransform[2],
            parentTransform[3],
            parentTransform[4],
            parentTransform[5]
        );

        // Always use glyphX/glyphY which are in glyph-local space
        // Use stroke for better hit detection tolerance
        // Calculate combined scale from both transforms to maintain constant screen-space tolerance
        const combinedScaleX = Math.sqrt(
            transform[0] * transform[0] + transform[1] * transform[1]
        );
        const combinedScaleY = Math.sqrt(
            transform[2] * transform[2] + transform[3] * transform[3]
        );
        const combinedScale = Math.max(combinedScaleX, combinedScaleY);
        const parentScaleX = Math.sqrt(
            parentTransform[0] * parentTransform[0] +
                parentTransform[1] * parentTransform[1]
        );
        const parentScaleY = Math.sqrt(
            parentTransform[2] * parentTransform[2] +
                parentTransform[3] * parentTransform[3]
        );
        const parentScale = Math.max(parentScaleX, parentScaleY);
        const totalScale =
            this.viewportManager!.scale * combinedScale * parentScale;
        this.ctx!.lineWidth =
            APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE / totalScale;
        const isInPath =
            this.ctx!.isPointInPath(path, glyphX, glyphY) ||
            this.ctx!.isPointInStroke(path, glyphX, glyphY);

        this.ctx!.restore();
        return isInPath;
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
        const axesSection = window.glyphCanvas.axesManager!.createAxesSection();
        rightSidebar.appendChild(axesSection);

        // Create OpenType features container (initially empty)
        const featuresSection =
            window.glyphCanvas.featuresManager!.createFeaturesSection();
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

        console.log('Glyph canvas initialized');
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
    console.log('🔧 Setting up font loading listeners...');

    // Listen for editing font compiled by font manager (primary)
    window.addEventListener('editingFontCompiled', async (e: any) => {
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
            console.warn(
                '   ⚠️ Cannot load font - missing canvas or fontBytes'
            );
        }
    });

    // Legacy: Custom event when font is compiled via compile button
    window.addEventListener('fontCompiled', async (e: any) => {
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
    window.addEventListener('editingFontCompiled', async (e: Event) => {
        let array: Uint8Array<ArrayBuffer> = (e as CustomEvent).detail
            ?.fontBytes;
        if (array) {
            window.glyphCanvas.setFont(array.buffer);
        }
    });
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
            setTimeout(() => window.glyphCanvas.canvas!.focus(), 0);
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

export { GlyphCanvas };
