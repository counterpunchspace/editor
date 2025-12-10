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
    isDraggingCanvas: boolean = false;
    lastMouseX: number = 0;
    lastMouseY: number = 0;
    mouseCanvasX: number = 0;
    mouseCanvasY: number = 0;
    cursorVisible: boolean = true;

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

            // Track Space key release
            if (e.code === 'Space') {
                console.log('  -> Releasing Space key');
                this.outlineEditor.onSpaceKeyReleased();
            }
        });

        // Reset key states when window loses focus (e.g., Cmd+Tab to switch apps)
        window.addEventListener('blur', () => {
            this.cmdKeyPressed = false;
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
            this.outlineEditor.spaceKeyPressed = false;
            this.isDraggingCanvas = false;
            // Don't exit preview mode when canvas loses focus to sidebar elements
            // (e.g., clicking sliders). Preview mode will be managed by slider events.
            // Only exit preview mode on true blur events (window blur, etc.)
        });

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
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
        });
        this.axesManager!.on('sliderMouseUp', async () => {
            if (this.outlineEditor.active) {
                this.outlineEditor.onSliderMouseUp();
            } else {
                // In text editing mode, restore focus to canvas
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on('animationInProgress', () => {
            this.textRunEditor!.shapeText();
            this.outlineEditor.animationInProgress();
        });
        this.axesManager!.on('animationComplete', async () => {
            // Skip layer matching during manual slider interpolation
            // It will be handled properly in sliderMouseUp
            if (this.outlineEditor.isInterpolating) {
                this.textRunEditor!.shapeText();
                return;
            }

            // If we were animating a layer switch, restore the target layer data
            if (this.outlineEditor.isLayerSwitchAnimating) {
                this.outlineEditor.restoreTargetLayerDataAfterAnimating();
                this.outlineEditor.isLayerSwitchAnimating = false;
                this.textRunEditor!.shapeText();
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

                if (ix != -1) {
                    this.outlineEditor.active = true;
                }
                // Update breadcrumb (will hide it since component stack is now empty)
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
            this.outlineEditor.onDoubleClick(e); // Will return if not active

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

        this.outlineEditor.performHitDetection(e);
        this.updateHoveredGlyph();
        // Update cursor style based on position (after updating hover states)
        this.updateCursorStyle(e);
    }

    updateCursorStyle(e: MouseEvent | KeyboardEvent): void {
        // Cmd key pressed = always show grab cursor for panning
        if (this.cmdKeyPressed) {
            this.canvas!.style.cursor = this.isDraggingCanvas
                ? 'grabbing'
                : 'grab';
            return;
        }

        // In text mode, show text cursor
        this.canvas!.style.cursor = this.outlineEditor.cursorStyle() || 'text';
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

                    // Test if mouse point is in path (in canvas coordinates)
                    if (
                        this.ctx!.isPointInPath(path, this.mouseX, this.mouseY)
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
                    this.featuresManager!.updateFeaturesUI().then(() => {
                        // Shape text with new font after features are initialized
                        this.textRunEditor!.shapeText();
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

        if (glyphIndex && glyphIndex >= 0) {
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

        console.log(`Exited glyph edit mode - returned to text edit mode`);
        this.updatePropertiesUI();
        this.render();
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
        if (this.fontData.glyphName) {
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

        // Create layers list
        const layersList = document.createElement('div');
        layersList.className = 'editor-layers-list';

        for (const layer of sortedLayers) {
            const layerItem = document.createElement('div');
            layerItem.className = 'editor-layer-item';
            if (this.outlineEditor.selectedLayerId === layer.id) {
                layerItem.classList.add('selected');
            }
            layerItem.setAttribute('data-layer-id', layer.id); // Add data attribute for selection updates

            // Find the master for this layer
            const master = this.fontData.masters.find(
                (m: any) => m.id === layer._master
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

            // Click handler
            layerItem.addEventListener('click', () => {
                this.outlineEditor.selectLayer(layer);
            });

            layersList.appendChild(layerItem);
        }

        this.propertiesSection!.appendChild(layersList);

        // Auto-select layer if current axis values match a layer's master location
        await this.outlineEditor.autoSelectMatchingLayer();
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

        // Delegate to ViewportManager
        this.viewportManager!.frameGlyph(
            bounds,
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

        // Delegate to ViewportManager
        this.viewportManager!.panToGlyph(
            bounds,
            glyphPosition,
            rect,
            this.render.bind(this)
        );
    }

    async updatePropertiesUI(): Promise<void> {
        if (!this.propertiesSection) return;

        // Update editor title bar with glyph name
        this.outlineEditor.updateEditorTitleBar();

        // Don't show properties if not in glyph edit mode
        if (!this.outlineEditor.active) {
            requestAnimationFrame(() => {
                this.propertiesSection!.innerHTML = '';
            });
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

        const settings = window.APP_SETTINGS.OUTLINE_EDITOR;
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

        // Prevent all other text editing and cursor movement in glyph edit mode
        if (this.outlineEditor.active) {
            e.preventDefault();
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

    resetZoomAndPosition(): void {
        // Reset zoom to initial scale and position to origin with animation
        const rect = this.canvas!.getBoundingClientRect();
        const targetScale = this.initialScale;
        const targetPanX = rect.width / 4; // Same as initial position
        const targetPanY = rect.height / 2; // Same as initial position

        this.viewportManager!.animateZoomAndPan(
            targetScale,
            targetPanX,
            targetPanY,
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
        const isInPath = this.ctx!.isPointInPath(path, glyphX, glyphY);

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
