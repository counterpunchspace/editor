import { adjustColorHueAndLightness, desaturateColor } from '../design';
import APP_SETTINGS from '../settings';

import type { ViewportManager } from './viewport';
import type { TextRunEditor } from './textrun';
import { GlyphCanvas } from '../glyph-canvas';
import { LayerDataNormalizer } from '../layer-data-normalizer';
import { PythonBabelfont } from '../pythonbabelfont';

export class GlyphCanvasRenderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    glyphCanvas: GlyphCanvas;
    viewportManager: ViewportManager;
    textRunEditor: TextRunEditor;
    /**
     *
     * @param {HTMLCanvasElement} canvas
     * @param {GlyphCanvas} glyphCanvas
     * @param {ViewportManager} viewportManager
     * @param {TextRunEditor} textRunEditor
     */
    constructor(
        canvas: HTMLCanvasElement,
        glyphCanvas: any,
        viewportManager: ViewportManager,
        textRunEditor: TextRunEditor
    ) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.glyphCanvas = glyphCanvas;
        this.viewportManager = viewportManager;
        this.textRunEditor = textRunEditor;
    }
    render() {
        if (!this.ctx || !this.canvas) return;

        // Clear canvas
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Fill background (different color based on focus state)
        // Get computed CSS variable values
        const computedStyle = getComputedStyle(document.documentElement);

        // Check if the editor view has the 'focused' class
        const editorView = document.querySelector('#view-editor');
        const isViewFocused =
            editorView && editorView.classList.contains('focused');

        if (isViewFocused) {
            // Active/focused background (same as .view.focused)
            this.ctx.fillStyle = computedStyle
                .getPropertyValue('--bg-active')
                .trim();
        } else {
            // Inactive background (same as .view)
            this.ctx.fillStyle = computedStyle
                .getPropertyValue('--bg-secondary')
                .trim();
        }
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();

        // Apply transformation
        const transform = this.viewportManager.getTransformMatrix();
        this.ctx.save();
        this.ctx.transform(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f
        );

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
        const invScale = 1 / this.viewportManager.scale;

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
        if (
            !this.textRunEditor.shapedGlyphs ||
            this.textRunEditor.shapedGlyphs.length === 0
        )
            return;

        const invScale = 1 / this.viewportManager.scale;

        // Calculate total advance width
        let totalAdvance = 0;
        for (const glyph of this.textRunEditor.shapedGlyphs) {
            totalAdvance += glyph.ax || 0;
        }

        this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
        this.ctx.lineWidth = 1 * invScale;

        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(totalAdvance, 0);
        this.ctx.stroke();
    }

    drawShapedGlyphs() {
        if (
            !this.textRunEditor.shapedGlyphs ||
            this.textRunEditor.shapedGlyphs.length === 0
        ) {
            return;
        }

        if (!this.textRunEditor.hbFont) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;
        let xPosition = 0;

        // Clear glyph bounds for hit testing
        this.glyphCanvas.glyphBounds = [];

        // Use black on white or white on black based on theme
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        this.textRunEditor.shapedGlyphs.forEach(
            (glyph: any, glyphIndex: number) => {
                const glyphId = glyph.g;
                const xOffset = glyph.dx || 0;
                const yOffset = glyph.dy || 0;
                const xAdvance = glyph.ax || 0;

                const x = xPosition + xOffset;
                const y = yOffset;

                // Store bounds for hit testing (approximate with advance width)
                this.glyphCanvas.glyphBounds.push({
                    x: x,
                    y: y,
                    width: xAdvance,
                    height: 1000 // Font units height approximation
                });

                // Set color based on hover, selection state, and edit mode
                const isHovered =
                    glyphIndex ===
                    this.glyphCanvas.outlineEditor.hoveredGlyphIndex;
                const isSelected =
                    glyphIndex === this.textRunEditor.selectedGlyphIndex;

                // Check if we should skip HarfBuzz rendering for selected glyph
                // Skip HarfBuzz only in edit mode when NOT in preview mode
                // In preview mode, always use HarfBuzz (shows final rendered font)
                const skipHarfBuzz =
                    isSelected &&
                    this.glyphCanvas.outlineEditor.active &&
                    !this.glyphCanvas.outlineEditor.isPreviewMode;

                if (!skipHarfBuzz) {
                    // Set color based on mode and state
                    if (
                        this.glyphCanvas.outlineEditor.active &&
                        !this.glyphCanvas.outlineEditor.isPreviewMode
                    ) {
                        // Glyph edit mode (not preview): active glyph in solid color, others dimmed
                        if (isSelected) {
                            this.ctx.fillStyle = colors.GLYPH_ACTIVE_IN_EDITOR;
                        } else if (isHovered) {
                            // Hovered inactive glyph - darker than normal inactive
                            this.ctx.fillStyle = colors.GLYPH_HOVERED_IN_EDITOR;
                        } else {
                            // Dim other glyphs
                            this.ctx.fillStyle =
                                colors.GLYPH_INACTIVE_IN_EDITOR;
                        }
                    } else if (
                        this.glyphCanvas.outlineEditor.active &&
                        this.glyphCanvas.outlineEditor.isPreviewMode
                    ) {
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
                    const glyphData =
                        this.textRunEditor.hbFont.glyphToPath(glyphId);

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
                }

                xPosition += xAdvance;
            }
        );
    }

    drawGlyphTooltip() {
        // Draw glyph name tooltip on hover (in font coordinate space)
        // Don't show tooltip for the selected glyph in glyph edit mode
        if (
            this.glyphCanvas.outlineEditor.hoveredGlyphIndex >= 0 &&
            this.glyphCanvas.outlineEditor.hoveredGlyphIndex <
                this.textRunEditor.shapedGlyphs.length
        ) {
            // Skip tooltip for selected glyph in glyph edit mode
            if (
                this.glyphCanvas.outlineEditor.active &&
                this.glyphCanvas.outlineEditor.hoveredGlyphIndex ===
                    this.textRunEditor.selectedGlyphIndex
            ) {
                return;
            }

            const glyphId =
                this.textRunEditor.shapedGlyphs[
                    this.glyphCanvas.outlineEditor.hoveredGlyphIndex
                ].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from compiled font via OpenType.js
            if (
                this.glyphCanvas.opentypeFont &&
                this.glyphCanvas.opentypeFont.glyphs.get(glyphId)
            ) {
                const glyph = this.glyphCanvas.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
            }

            // Get glyph position and advance from shaped data
            const shapedGlyph =
                this.textRunEditor.shapedGlyphs[
                    this.glyphCanvas.outlineEditor.hoveredGlyphIndex
                ];
            const glyphBounds =
                this.glyphCanvas.glyphBounds[
                    this.glyphCanvas.outlineEditor.hoveredGlyphIndex
                ];
            const glyphWidth = shapedGlyph.ax || 0;
            const glyphYOffset = shapedGlyph.dy || 0; // Y offset from HarfBuzz shaping

            // Get glyph bounding box to find bottom edge
            let glyphYMin = 0;
            if (
                this.glyphCanvas.opentypeFont &&
                this.glyphCanvas.opentypeFont.glyphs.get(glyphId)
            ) {
                const glyph = this.glyphCanvas.opentypeFont.glyphs.get(glyphId);
                const bbox = glyph.getBoundingBox();
                glyphYMin = bbox.y1; // y1 is the minimum Y (bottom edge)
            }

            // Position tooltip centered under the glyph
            // In font coordinates: Y increases upward, so negative Y is below baseline
            // Note: glyphBounds.x already includes dx offset from HarfBuzz
            const tooltipX = glyphBounds.x + glyphWidth / 2;
            const tooltipY = glyphYOffset + glyphYMin - 100; // 100 units below bottom of bounding box, including HB Y offset

            const invScale = 1 / this.viewportManager.scale;
            const isDarkTheme =
                document.documentElement.getAttribute('data-theme') !== 'light';

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
            this.ctx.fillStyle = isDarkTheme
                ? 'rgba(40, 40, 40, 0.95)'
                : 'rgba(255, 255, 255, 0.95)';
            this.ctx.fillRect(bgX, bgY, bgWidth, bgHeight);

            // Draw border
            this.ctx.strokeStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 0.3)'
                : 'rgba(0, 0, 0, 0.3)';
            this.ctx.lineWidth = 2 * invScale;
            this.ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

            // Draw text
            this.ctx.fillStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 0.9)'
                : 'rgba(0, 0, 0, 0.9)';
            this.ctx.fillText(
                glyphName,
                bgX + padding,
                bgY + fontSize * 0.85 + padding / 2 + 4
            );

            this.ctx.restore();
        }
    }

    drawOutlineEditor() {
        // Validate APP_SETTINGS is available
        if (
            typeof APP_SETTINGS === 'undefined' ||
            !APP_SETTINGS.OUTLINE_EDITOR
        ) {
            console.error(
                '[Renderer]',
                'APP_SETTINGS not available in drawOutlineEditor!'
            );
            return;
        }

        // Draw outline editor when a layer is selected (skip in preview mode)
        // During interpolation without preview mode, layerData exists without selectedLayerId
        if (
            !this.glyphCanvas.outlineEditor.layerData ||
            this.glyphCanvas.outlineEditor.isPreviewMode
        ) {
            return;
        }

        // Skip rendering if layer data is invalid (empty shapes array)
        // This prevents flicker when interpolation hasn't completed yet
        if (
            !this.glyphCanvas.outlineEditor.layerData.shapes ||
            this.glyphCanvas.outlineEditor.layerData.shapes.length === 0
        ) {
            console.log('[Renderer]', 'Skipping drawOutlineEditor: no shapes');
            return;
        }

        // Get the position of the selected glyph
        if (
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
            console.log(
                '[Renderer]',
                'Skipping drawOutlineEditor: invalid selectedGlyphIndex'
            );
            return;
        }

        let xPosition = 0;
        for (let i = 0; i < this.textRunEditor.selectedGlyphIndex; i++) {
            xPosition += this.textRunEditor.shapedGlyphs[i].ax || 0;
        }

        const glyph =
            this.textRunEditor.shapedGlyphs[
                this.textRunEditor.selectedGlyphIndex
            ];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const x = xPosition + xOffset;
        const y = yOffset;

        this.ctx.save();
        this.ctx.translate(x, y);

        // Apply accumulated component transform if editing a component
        // This positions the editor at the component's location in the parent
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        if (this.glyphCanvas.outlineEditor.componentStack.length > 0) {
            console.log(
                '[Renderer]',
                `drawOutlineEditor: componentStack.length=${this.glyphCanvas.outlineEditor.componentStack.length}, accumulated transform=[${transform}]`
            );
            this.ctx.transform(
                transform[0],
                transform[1],
                transform[2],
                transform[3],
                transform[4],
                transform[5]
            );
        }

        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';

        // Draw parent glyph outlines in background if editing a component
        if (this.glyphCanvas.outlineEditor.componentStack.length > 0) {
            this.ctx.save();

            // Apply inverse transform to draw parent in original (untransformed) position
            const [a, b, c, d, tx, ty] = transform;
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
            const glyphIndex = this.textRunEditor.selectedGlyphIndex;
            if (
                glyphIndex >= 0 &&
                glyphIndex < this.textRunEditor.shapedGlyphs.length &&
                this.textRunEditor.hbFont
            ) {
                const shapedGlyph = this.textRunEditor.shapedGlyphs[glyphIndex];
                const glyphId = shapedGlyph.g;

                try {
                    // Get glyph outline from HarfBuzz
                    const glyphData =
                        this.textRunEditor.hbFont.glyphToPath(glyphId);

                    if (glyphData) {
                        this.ctx.beginPath();
                        const path = new Path2D(glyphData);
                        this.ctx.strokeStyle = isDarkTheme
                            ? 'rgba(255, 255, 255, 0.2)'
                            : 'rgba(0, 0, 0, 0.2)';
                        this.ctx.lineWidth = 1 * invScale;
                        this.ctx.stroke(path);
                    }
                } catch (error) {
                    console.error(
                        '[Renderer]',
                        'Failed to draw parent glyph:',
                        error
                    );
                }
            }

            this.ctx.restore(); // Restore to component-transformed state
        }

        // Draw 1-unit grid at high zoom levels
        if (
            this.viewportManager.scale >=
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_GRID
        ) {
            // Get glyph bounds from layer data (if available)
            let minX = -100,
                maxX = 700,
                minY = -200,
                maxY = 1000; // Default bounds

            if (
                this.glyphCanvas.outlineEditor.layerData &&
                this.glyphCanvas.outlineEditor.layerData.shapes
            ) {
                // Calculate bounds from all contours
                this.glyphCanvas.outlineEditor.layerData.shapes.forEach(
                    (shape) => {
                        if ('nodes' in shape && shape.nodes.length > 0) {
                            shape.nodes.forEach(
                                ({ x, y }: { x: number; y: number }) => {
                                    minX = Math.min(minX, x);
                                    maxX = Math.max(maxX, x);
                                    minY = Math.min(minY, y);
                                    maxY = Math.max(maxY, y);
                                }
                            );
                        }
                    }
                );
                // Add padding
                minX = Math.floor(minX - 50);
                maxX = Math.ceil(maxX + 50);
                minY = Math.floor(minY - 50);
                maxY = Math.ceil(maxY + 50);
            }

            // Draw vertical lines (every 1 unit)
            const colors = isDarkTheme
                ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
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
        console.log(
            '[Renderer]',
            'Drawing shapes. Component stack depth:',
            this.glyphCanvas.outlineEditor.componentStack.length,
            'layerData.shapes.length:',
            this.glyphCanvas.outlineEditor.layerData?.shapes?.length
        );

        // Only draw shapes if they exist (empty glyphs like space won't have shapes)
        if (
            this.glyphCanvas.outlineEditor.layerData.shapes &&
            Array.isArray(this.glyphCanvas.outlineEditor.layerData.shapes)
        ) {
            // Apply monochrome during manual slider interpolation OR when not on an exact layer
            // Don't apply monochrome during layer switch animations
            const isInterpolated =
                this.glyphCanvas.outlineEditor.isInterpolating ||
                (this.glyphCanvas.outlineEditor.selectedLayerId === null &&
                    this.glyphCanvas.outlineEditor.layerData?.isInterpolated);

            this.glyphCanvas.outlineEditor.layerData.shapes.forEach(
                (shape, contourIndex: number) =>
                    this.drawShape(shape, contourIndex, isInterpolated)
            );

            // Draw components
            this.glyphCanvas.outlineEditor.layerData.shapes.forEach(
                (shape, index: number) => {
                    if (!('Component' in shape)) {
                        return; // Not a component
                    }

                    console.log(
                        '[Renderer]',
                        `Component ${index}: reference="${shape.Component.reference}", has layerData=${!!shape.Component.layerData}, shapes=${shape.Component.layerData?.shapes?.length || 0}`
                    );

                    // Disable selection/hover highlighting for interpolated data
                    const isInterpolated =
                        this.glyphCanvas.outlineEditor.isInterpolating ||
                        (this.glyphCanvas.outlineEditor.selectedLayerId ===
                            null &&
                            this.glyphCanvas.outlineEditor.layerData
                                ?.isInterpolated);
                    const isHovered =
                        !isInterpolated &&
                        this.glyphCanvas.outlineEditor.hoveredComponentIndex ===
                            index;
                    const isSelected =
                        !isInterpolated &&
                        this.glyphCanvas.outlineEditor.selectedComponents.includes(
                            index
                        );

                    // Get full transform matrix [a, b, c, d, tx, ty]
                    let a = 1,
                        b = 0,
                        c = 0,
                        d = 1,
                        tx = 0,
                        ty = 0;
                    if (
                        'Component' in shape &&
                        Array.isArray(shape.Component.transform)
                    ) {
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
                    if (
                        'Component' in shape &&
                        shape.Component.layerData &&
                        shape.Component.layerData.shapes
                    ) {
                        // Recursively render all shapes in the component (including nested components)
                        const renderComponentShapes = (
                            shapes: any[],
                            transform = [1, 0, 0, 1, 0, 0]
                        ) => {
                            shapes.forEach((componentShape) => {
                                // Handle nested components
                                if (componentShape.Component) {
                                    // Save context for nested component transform
                                    this.ctx.save();

                                    // Apply nested component's transform
                                    if (
                                        componentShape.Component.transform &&
                                        Array.isArray(
                                            componentShape.Component.transform
                                        )
                                    ) {
                                        const t =
                                            componentShape.Component.transform;
                                        this.ctx.transform(
                                            t[0] || 1,
                                            t[1] || 0,
                                            t[2] || 0,
                                            t[3] || 1,
                                            t[4] || 0,
                                            t[5] || 0
                                        );
                                    }

                                    // Recursively render nested component's shapes
                                    if (
                                        componentShape.Component.layerData &&
                                        componentShape.Component.layerData
                                            .shapes
                                    ) {
                                        renderComponentShapes(
                                            componentShape.Component.layerData
                                                .shapes
                                        );
                                    }

                                    this.ctx.restore();
                                    return;
                                }

                                // Handle outline shapes (with nodes)
                                if (
                                    componentShape.nodes &&
                                    componentShape.nodes.length > 0
                                ) {
                                    // Get colors
                                    const colors = isDarkTheme
                                        ? APP_SETTINGS.OUTLINE_EDITOR
                                              .COLORS_DARK
                                        : APP_SETTINGS.OUTLINE_EDITOR
                                              .COLORS_LIGHT;

                                    // Determine stroke color based on state
                                    const baseStrokeColor = isSelected
                                        ? colors.COMPONENT_SELECTED
                                        : colors.COMPONENT_NORMAL;

                                    // For hover, make it 20% darker
                                    const strokeColor = isHovered
                                        ? adjustColorHueAndLightness(
                                              baseStrokeColor,
                                              0,
                                              50
                                          )
                                        : baseStrokeColor;

                                    // Determine fill color based on state
                                    const baseFillColor = isSelected
                                        ? colors.COMPONENT_FILL_SELECTED
                                        : colors.COMPONENT_FILL_NORMAL;

                                    // For hover, make it 20% darker
                                    const fillColor = isHovered
                                        ? adjustColorHueAndLightness(
                                              baseFillColor,
                                              0,
                                              50
                                          )
                                        : baseFillColor;

                                    // Apply glow effect only in dark theme
                                    if (isDarkTheme) {
                                        // Apply glow effect - blur stays constant in font units
                                        const glowBlur =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_BLUR;
                                        const hueShift =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_HUE_SHIFT;

                                        // Calculate glow stroke width based on zoom level
                                        const glowStrokeMin =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_STROKE_WIDTH_AT_MIN_ZOOM;
                                        const glowStrokeMax =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_STROKE_WIDTH_AT_MAX_ZOOM;
                                        const glowInterpolationMin =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_STROKE_INTERPOLATION_MIN;
                                        const glowInterpolationMax =
                                            APP_SETTINGS.OUTLINE_EDITOR
                                                .COMPONENT_GLOW_STROKE_INTERPOLATION_MAX;

                                        let glowStrokeWidth;
                                        if (
                                            this.viewportManager.scale <=
                                            glowInterpolationMin
                                        ) {
                                            glowStrokeWidth =
                                                glowStrokeMin * invScale;
                                        } else if (
                                            this.viewportManager.scale >=
                                            glowInterpolationMax
                                        ) {
                                            glowStrokeWidth =
                                                glowStrokeMax * invScale;
                                        } else {
                                            // Interpolate between min and max
                                            const zoomFactor =
                                                (this.viewportManager.scale -
                                                    glowInterpolationMin) /
                                                (glowInterpolationMax -
                                                    glowInterpolationMin);
                                            glowStrokeWidth =
                                                (glowStrokeMin +
                                                    (glowStrokeMax -
                                                        glowStrokeMin) *
                                                        zoomFactor) *
                                                invScale;
                                        }

                                        // Shift hue for glow color using adjustColorHueAndLightness
                                        let glowColor =
                                            adjustColorHueAndLightness(
                                                strokeColor,
                                                hueShift,
                                                0 // No lightness adjustment
                                            );
                                        // Parse and boost opacity if needed
                                        const glowMatch = glowColor.match(
                                            /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
                                        );
                                        if (glowMatch) {
                                            const r = glowMatch[1];
                                            const g = glowMatch[2];
                                            const b = glowMatch[3];
                                            glowColor = `rgba(${r}, ${g}, ${b}, 1.0)`; // Full opacity for strong glow
                                        }

                                        // First pass: Draw glow on the outside by stroking with shadow
                                        this.ctx.save();
                                        this.ctx.shadowBlur = glowBlur;
                                        this.ctx.shadowColor = glowColor;
                                        this.ctx.shadowOffsetX = 0;
                                        this.ctx.shadowOffsetY = 0;
                                        this.ctx.strokeStyle = glowColor;
                                        this.ctx.lineWidth = glowStrokeWidth;

                                        this.ctx.beginPath();
                                        this.buildPathFromNodes(
                                            componentShape.nodes
                                        );
                                        this.ctx.closePath();
                                        this.ctx.stroke();
                                        this.ctx.restore();
                                    }

                                    // Second pass: Draw fill and stroke without shadow
                                    this.ctx.shadowBlur = 0;
                                    this.ctx.shadowColor = 'transparent';

                                    this.ctx.beginPath();
                                    this.buildPathFromNodes(
                                        componentShape.nodes
                                    );
                                    this.ctx.closePath();

                                    this.ctx.fillStyle = fillColor;
                                    this.ctx.fill();

                                    // Stroke the outline
                                    this.ctx.strokeStyle = strokeColor;
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
                    const minZoomForHandles =
                        APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
                    if (this.viewportManager.scale < minZoomForHandles) {
                        this.ctx.restore();
                        return;
                    }

                    const markerSize =
                        APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_MARKER_SIZE *
                        invScale; // Draw cross marker
                    const colors = isDarkTheme
                        ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                        : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

                    // Determine marker stroke color based on state
                    const baseMarkerColor = isSelected
                        ? colors.COMPONENT_SELECTED
                        : colors.COMPONENT_NORMAL;

                    // For hover, make it 20% darker
                    const markerStrokeColor = isHovered
                        ? adjustColorHueAndLightness(baseMarkerColor, 0, -20)
                        : baseMarkerColor;

                    this.ctx.strokeStyle = markerStrokeColor;
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
                    this.ctx.fillStyle = isDarkTheme
                        ? 'rgba(255, 255, 255, 0.8)'
                        : 'rgba(0, 0, 0, 0.8)';
                    this.ctx.fillText(
                        ('Component' in shape && shape.Component.reference) ||
                            'component',
                        markerSize * 1.5,
                        markerSize
                    );
                    this.ctx.restore();

                    this.ctx.restore();
                }
            );
        } // End if (this.glyphCanvas.outlineEditor.layerData.shapes)

        // Draw anchors
        // Skip drawing anchors if zoom is under minimum threshold
        // or if showing interpolated data (non-editable)
        const minZoomForHandles =
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
        const minZoomForLabels =
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_ANCHOR_LABELS;

        if (
            this.viewportManager.scale >= minZoomForHandles &&
            this.glyphCanvas.outlineEditor.layerData.anchors &&
            this.glyphCanvas.outlineEditor.layerData.anchors.length > 0
        ) {
            // Calculate anchor size based on zoom level
            const anchorSizeMax =
                APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MAX_ZOOM;
            const anchorSizeMin =
                APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MIN_ZOOM;
            const anchorInterpolationMin =
                APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MIN;
            const anchorInterpolationMax =
                APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MAX;

            let anchorSize;
            if (this.viewportManager.scale >= anchorInterpolationMax) {
                anchorSize = anchorSizeMax * invScale;
            } else {
                // Interpolate between min and max size
                const zoomFactor =
                    (this.viewportManager.scale - anchorInterpolationMin) /
                    (anchorInterpolationMax - anchorInterpolationMin);
                anchorSize =
                    (anchorSizeMin +
                        (anchorSizeMax - anchorSizeMin) * zoomFactor) *
                    invScale;
            }
            const fontSize = 12 * invScale;

            this.glyphCanvas.outlineEditor.layerData.anchors.forEach(
                (anchor: any, index: number) => {
                    const { x, y, name } = anchor;
                    const isInterpolated =
                        this.glyphCanvas.outlineEditor.isInterpolating ||
                        (this.glyphCanvas.outlineEditor.selectedLayerId ===
                            null &&
                            this.glyphCanvas.outlineEditor.layerData
                                ?.isInterpolated);
                    const isHovered =
                        !isInterpolated &&
                        this.glyphCanvas.outlineEditor.hoveredAnchorIndex ===
                            index;
                    const isSelected =
                        !isInterpolated &&
                        this.glyphCanvas.outlineEditor.selectedAnchors.includes(
                            index
                        );

                    // Draw anchor as diamond
                    this.ctx.save();
                    this.ctx.translate(x, y);
                    this.ctx.rotate(Math.PI / 4); // Rotate 45 degrees to make diamond

                    const colors = isDarkTheme
                        ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                        : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    let fillColor = isSelected
                        ? colors.ANCHOR_SELECTED
                        : isHovered
                          ? colors.ANCHOR_HOVERED
                          : colors.ANCHOR_NORMAL;

                    // Apply monochrome for interpolated data
                    if (isInterpolated) {
                        fillColor = desaturateColor(fillColor);
                    }

                    this.ctx.fillStyle = fillColor;
                    this.ctx.fillRect(
                        -anchorSize,
                        -anchorSize,
                        anchorSize * 2,
                        anchorSize * 2
                    );
                    // Stroke permanently removed

                    this.ctx.restore();

                    // Draw anchor name only above minimum zoom threshold
                    if (name && this.viewportManager.scale > minZoomForLabels) {
                        this.ctx.save();
                        this.ctx.translate(x, y);
                        this.ctx.scale(1, -1); // Flip Y axis to fix upside-down text
                        this.ctx.font = `${fontSize}px monospace`;
                        this.ctx.fillStyle = isDarkTheme
                            ? 'rgba(255, 255, 255, 0.8)'
                            : 'rgba(0, 0, 0, 0.8)';
                        this.ctx.fillText(name, anchorSize * 1.5, anchorSize);
                        this.ctx.restore();
                    }
                }
            );
        }

        // Draw bounding box for testing
        this.drawBoundingBox();

        this.ctx.restore();
    }

    drawShape(
        shape: PythonBabelfont.Shape,
        contourIndex: number,
        isInterpolated: boolean
    ) {
        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        console.log(
            '[Renderer]',
            'Drawing shape',
            contourIndex,
            ':',
            'Component' in shape ? 'Component' : 'Path',
            'Component' in shape
                ? `ref=${shape.Component.reference}`
                : `nodes=${'nodes' in shape ? shape.nodes?.length : 0}`
        );
        if ('Component' in shape) {
            // Component - will be drawn separately as markers
            return;
        }

        // Handle Path object from to_dict() - nodes might be in shape.Path.nodes
        let nodes = 'nodes' in shape ? shape.nodes : undefined;
        if (!nodes && 'Path' in shape && shape.Path.nodes) {
            // Nodes are in a string format from to_dict() - parse them
            (shape as any).nodes = LayerDataNormalizer.parseNodes(
                shape.Path.nodes
            );
            delete (shape as any).Path; // Remove Path wrapper after parsing
            nodes = (shape as any).nodes;
        }

        if (!nodes || nodes.length === 0) {
            return;
        }

        // Draw the outline path
        this.ctx.beginPath();
        this.ctx.strokeStyle = isDarkTheme ? '#ffffff' : '#000000';
        this.ctx.lineWidth =
            APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_STROKE_WIDTH * invScale;

        // Build the path using the helper method
        const startIdx = this.buildPathFromNodes(nodes);

        this.ctx.closePath();
        this.ctx.stroke();

        // Skip drawing direction arrow and handles if zoom is under minimum threshold
        const minZoomForHandles =
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
        if (this.viewportManager.scale >= minZoomForHandles) {
            // Draw direction arrow from the first node
            if (nodes.length > 1) {
                const { x: firstX, y: firstY } = nodes[startIdx];
                const nextIdx = (startIdx + 1) % nodes.length;
                const { x: nextX, y: nextY } = nodes[nextIdx];

                // Calculate direction vector from first node to next
                const dx = nextX - firstX;
                const dy = nextY - firstY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance > 0) {
                    // Normalize direction
                    const ndx = dx / distance;
                    const ndy = dy / distance;

                    // Calculate arrow size based on node size (same scaling as nodes, but slightly bigger)
                    const nodeSizeMax =
                        APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MAX_ZOOM;
                    const nodeSizeMin =
                        APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MIN_ZOOM;
                    const nodeInterpolationMin =
                        APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MIN;
                    const nodeInterpolationMax =
                        APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MAX;

                    let baseSize;
                    if (this.viewportManager.scale >= nodeInterpolationMax) {
                        baseSize = nodeSizeMax * invScale;
                    } else {
                        const zoomFactor =
                            (this.viewportManager.scale -
                                nodeInterpolationMin) /
                            (nodeInterpolationMax - nodeInterpolationMin);
                        baseSize =
                            (nodeSizeMin +
                                (nodeSizeMax - nodeSizeMin) * zoomFactor) *
                            invScale;
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

                    let fillColor = isDarkTheme
                        ? 'rgba(0, 255, 255, 0.8)'
                        : 'rgba(0, 150, 150, 0.8)';

                    // Apply monochrome for interpolated data
                    if (isInterpolated) {
                        fillColor = desaturateColor(fillColor);
                    }

                    this.ctx.fillStyle = fillColor;
                    this.ctx.fill();
                }
            }

            // Draw control point handle lines (from off-curve to adjacent on-curve points)
            this.ctx.strokeStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 0.5)'
                : 'rgba(0, 0, 0, 0.5)';
            this.ctx.lineWidth = 1 * invScale;

            nodes.forEach((node: PythonBabelfont.Node, nodeIndex: number) => {
                const { x, y, type } = node;

                // Only draw lines from off-curve points
                if (type === 'o') {
                    // Check if this is the first or second control point in a cubic bezier pair
                    let prevIdx = nodeIndex - 1;
                    if (prevIdx < 0) prevIdx = nodes.length - 1;
                    const prevType = nodes[prevIdx].type;

                    let nextIdx = nodeIndex + 1;
                    if (nextIdx >= nodes.length) nextIdx = 0;
                    const nextType = nodes[nextIdx].type;
                    const isPrevOffCurve = prevType === 'o';
                    const isNextOffCurve = nextType === 'o';

                    if (isPrevOffCurve) {
                        // This is the second control point - connect to NEXT on-curve point
                        let targetIdx = nextIdx;
                        // Skip the other off-curve point if needed
                        if (isNextOffCurve) {
                            targetIdx++;
                            if (targetIdx >= nodes.length) targetIdx = 0;
                        }

                        const {
                            x: targetX,
                            y: targetY,
                            type: targetType
                        } = nodes[targetIdx];
                        if (
                            targetType === 'c' ||
                            targetType === 'cs' ||
                            targetType === 'l' ||
                            targetType === 'ls'
                        ) {
                            this.ctx.beginPath();
                            this.ctx.moveTo(x, y);
                            this.ctx.lineTo(targetX, targetY);
                            this.ctx.stroke();
                        }
                    } else {
                        // This is the first control point - connect to PREVIOUS on-curve point
                        let targetIdx = prevIdx;

                        const {
                            x: targetX,
                            y: targetY,
                            type: targetType
                        } = nodes[targetIdx];
                        if (
                            targetType === 'c' ||
                            targetType === 'cs' ||
                            targetType === 'l'
                        ) {
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
        if (this.viewportManager.scale < minZoomForHandles) {
            return;
        }

        (shape as any).nodes.forEach(
            (node: PythonBabelfont.Node, nodeIndex: number) => {
                const { x, y, type } = node;
                const isInterpolated =
                    this.glyphCanvas.outlineEditor.isInterpolating ||
                    (this.glyphCanvas.outlineEditor.selectedLayerId === null &&
                        this.glyphCanvas.outlineEditor.layerData
                            ?.isInterpolated);
                const isHovered =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.hoveredPointIndex &&
                    this.glyphCanvas.outlineEditor.hoveredPointIndex
                        .contourIndex === contourIndex &&
                    this.glyphCanvas.outlineEditor.hoveredPointIndex
                        .nodeIndex === nodeIndex;
                const isSelected =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.selectedPoints.some(
                        (p: any) =>
                            p.contourIndex === contourIndex &&
                            p.nodeIndex === nodeIndex
                    );

                // Skip quadratic bezier points for now
                if (type === 'q' || type === 'qs') {
                    return;
                }

                // Calculate point size based on zoom level
                const nodeSizeMax =
                    APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MAX_ZOOM;
                const nodeSizeMin =
                    APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_AT_MIN_ZOOM;
                const nodeInterpolationMin =
                    APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MIN;
                const nodeInterpolationMax =
                    APP_SETTINGS.OUTLINE_EDITOR.NODE_SIZE_INTERPOLATION_MAX;

                let pointSize;
                if (this.viewportManager.scale >= nodeInterpolationMax) {
                    pointSize = nodeSizeMax * invScale;
                } else {
                    // Interpolate between min and max size
                    const zoomFactor =
                        (this.viewportManager.scale - nodeInterpolationMin) /
                        (nodeInterpolationMax - nodeInterpolationMin);
                    pointSize =
                        (nodeSizeMin +
                            (nodeSizeMax - nodeSizeMin) * zoomFactor) *
                        invScale;
                }
                if (type === 'o') {
                    // Off-curve point (cubic bezier control point) - draw as circle
                    const colors = isDarkTheme
                        ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                        : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, pointSize, 0, Math.PI * 2);
                    let fillColor = isSelected
                        ? colors.CONTROL_POINT_SELECTED
                        : isHovered
                          ? colors.CONTROL_POINT_HOVERED
                          : colors.CONTROL_POINT_NORMAL;

                    // Apply monochrome for interpolated data
                    if (isInterpolated) {
                        fillColor = desaturateColor(fillColor);
                    }

                    this.ctx.fillStyle = fillColor;
                    this.ctx.fill();
                    // Stroke permanently removed
                } else {
                    // On-curve point - draw as square
                    const colors = isDarkTheme
                        ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                        : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    let fillColor = isSelected
                        ? colors.NODE_SELECTED
                        : isHovered
                          ? colors.NODE_HOVERED
                          : colors.NODE_NORMAL;

                    // Apply monochrome for interpolated data
                    if (isInterpolated) {
                        fillColor = desaturateColor(fillColor);
                    }

                    this.ctx.fillStyle = fillColor;
                    this.ctx.fillRect(
                        x - pointSize,
                        y - pointSize,
                        pointSize * 2,
                        pointSize * 2
                    );
                    // Stroke permanently removed
                }

                // Draw smooth indicator for smooth nodes
                if (type === 'cs') {
                    let smoothColor = isDarkTheme ? '#ffffff' : '#000000';

                    // Apply monochrome for interpolated data
                    if (isInterpolated) {
                        smoothColor = desaturateColor(smoothColor);
                    }

                    this.ctx.beginPath();
                    this.ctx.arc(x, y, pointSize * 0.4, 0, Math.PI * 2);
                    this.ctx.fillStyle = smoothColor;
                    this.ctx.fill();
                }
            }
        );
    }

    drawBoundingBox() {
        // Draw the calculated bounding box in outline editing mode
        if (
            !this.glyphCanvas.outlineEditor.active ||
            !this.glyphCanvas.outlineEditor.layerData
        ) {
            return;
        }

        // Check if bounding box display is enabled
        if (!APP_SETTINGS?.OUTLINE_EDITOR?.SHOW_BOUNDING_BOX) {
            return;
        }

        const bbox = this.glyphCanvas.outlineEditor.calculateGlyphBoundingBox();
        if (!bbox) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';

        // Draw bounding box rectangle
        this.ctx.strokeStyle = isDarkTheme
            ? 'rgba(255, 0, 255, 0.8)' // Magenta for dark theme
            : 'rgba(255, 0, 255, 0.8)'; // Magenta for light theme
        this.ctx.lineWidth = 2 * invScale;
        this.ctx.setLineDash([5 * invScale, 5 * invScale]); // Dashed line

        this.ctx.strokeRect(bbox.minX, bbox.minY, bbox.width, bbox.height);

        this.ctx.setLineDash([]); // Reset to solid line

        // Draw bbox dimensions as text labels
        const fontSize = 12 * invScale;
        this.ctx.font = `${fontSize}px monospace`;
        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 0, 255, 0.9)'
            : 'rgba(255, 0, 255, 0.9)';

        // Save context to flip text right-side up
        this.ctx.save();

        // Width label (centered at top)
        this.ctx.translate(bbox.minX + bbox.width / 2, bbox.maxY);
        this.ctx.scale(1, -1); // Flip Y to make text right-side up
        const widthText = `${Math.round(bbox.width)}`;
        const widthMetrics = this.ctx.measureText(widthText);
        this.ctx.fillText(widthText, -widthMetrics.width / 2, -fontSize);
        this.ctx.restore();

        // Height label (centered at left)
        this.ctx.save();
        this.ctx.translate(bbox.minX, bbox.minY + bbox.height / 2);
        this.ctx.scale(1, -1); // Flip Y to make text right-side up
        const heightText = `${Math.round(bbox.height)}`;
        this.ctx.fillText(heightText, -fontSize * 4, fontSize / 2);
        this.ctx.restore();

        // Corner coordinates (bottom-left and top-right)
        this.ctx.save();
        this.ctx.translate(bbox.minX, bbox.minY);
        this.ctx.scale(1, -1);
        const minText = `(${Math.round(bbox.minX)}, ${Math.round(bbox.minY)})`;
        this.ctx.fillText(minText, 0, fontSize + 5 * invScale);
        this.ctx.restore();

        this.ctx.save();
        this.ctx.translate(bbox.maxX, bbox.maxY);
        this.ctx.scale(1, -1);
        const maxText = `(${Math.round(bbox.maxX)}, ${Math.round(bbox.maxY)})`;
        const maxMetrics = this.ctx.measureText(maxText);
        this.ctx.fillText(maxText, -maxMetrics.width, -5 * invScale);
        this.ctx.restore();
    }

    drawUIOverlay() {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);

        const rect = this.canvas.getBoundingClientRect();

        // Use contrasting color based on theme
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 0.7)'
            : 'rgba(0, 0, 0, 0.7)';
        this.ctx.font = '12px monospace';

        // Draw zoom level
        const zoomText = `Zoom: ${(this.viewportManager.scale * 100).toFixed(1)}%`;
        this.ctx.fillText(zoomText, 10, rect.height - 10);

        // Draw pan position
        const panText = `Pan: (${Math.round(this.viewportManager.panX)}, ${Math.round(this.viewportManager.panY)})`;
        this.ctx.fillText(panText, 10, rect.height - 25);

        // Draw text buffer info
        if (this.textRunEditor.textBuffer) {
            const textInfo = `Text: "${this.textRunEditor.textBuffer}" (${this.textRunEditor.shapedGlyphs.length} glyphs)`;
            this.ctx.fillText(textInfo, 10, 20);
        }

        this.ctx.restore();
    }

    buildPathFromNodes(nodes: PythonBabelfont.Node[], pathTarget?: Path2D) {
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
            const { x, y, type } = nodes[i];
            if (type === 'c' || type === 'cs' || type === 'l') {
                startIdx = i;
                break;
            }
        }

        const { x: startX, y: startY } = nodes[startIdx];
        target.moveTo(startX, startY);

        // Draw contour by looking ahead for control points
        let i = 0;
        while (i < nodes.length) {
            const idx = (startIdx + i) % nodes.length;
            const nextIdx = (startIdx + i + 1) % nodes.length;
            const next2Idx = (startIdx + i + 2) % nodes.length;
            const next3Idx = (startIdx + i + 3) % nodes.length;

            const { x, y, type } = nodes[idx];
            const { x: next1X, y: next1Y, type: next1Type } = nodes[nextIdx];

            if (
                type === 'l' ||
                type === 'c' ||
                type === 'cs' ||
                type === 'ls'
            ) {
                // We're at an on-curve point, look ahead for next segment
                if (next1Type === 'o') {
                    // Next is off-curve - check if cubic (two consecutive off-curve)
                    const {
                        x: next2X,
                        y: next2Y,
                        type: next2Type
                    } = nodes[next2Idx];
                    const { x: next3X, y: next3Y } = nodes[next3Idx];

                    if (next2Type === 'o') {
                        // Cubic bezier: two off-curve control points + on-curve endpoint
                        target.bezierCurveTo(
                            next1X,
                            next1Y,
                            next2X,
                            next2Y,
                            next3X,
                            next3Y
                        );
                        i += 3; // Skip the two control points and endpoint
                    } else {
                        // Single off-curve - shouldn't happen with cubic, just draw line
                        target.lineTo(next2X, next2Y);
                        i += 2;
                    }
                } else if (
                    next1Type === 'l' ||
                    next1Type === 'ls' ||
                    next1Type === 'c' ||
                    next1Type === 'cs'
                ) {
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

    drawCursor() {
        // Draw the text cursor at the current position
        // Don't draw cursor in glyph edit mode
        if (
            !this.glyphCanvas.cursorVisible ||
            this.glyphCanvas.outlineEditor.active
        ) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;

        console.log(
            '[Renderer]',
            `Drawing cursor at x=${this.textRunEditor.cursorX.toFixed(
                0
            )} for logical position ${this.textRunEditor.cursorPosition}`
        );

        // Draw cursor line - dimmed when not focused, bright when focused
        const opacity = this.glyphCanvas.isFocused ? 0.8 : 0.3;

        // Use dark cursor for light theme, white cursor for dark theme
        const isLightTheme =
            document.documentElement.getAttribute('data-theme') === 'light';
        const cursorColor = isLightTheme
            ? `rgba(0, 0, 0, ${opacity})`
            : `rgba(255, 255, 255, ${opacity})`;

        this.ctx.strokeStyle = cursorColor;
        this.ctx.lineWidth = 2 * invScale;
        this.ctx.beginPath();
        this.ctx.moveTo(this.textRunEditor.cursorX, 1000); // Top (above cap height, positive Y is up in font space)
        this.ctx.lineTo(this.textRunEditor.cursorX, -300); // Bottom (below baseline, negative Y is down)
        this.ctx.stroke();
    }

    drawSelection() {
        // Draw selection highlight
        if (
            !this.textRunEditor.hasSelection() ||
            !this.textRunEditor.clusterMap ||
            this.textRunEditor.clusterMap.length === 0
        ) {
            return;
        }

        const range = this.textRunEditor.getSelectionRange();
        const invScale = 1 / this.viewportManager.scale;

        console.log('[Renderer]', '=== Drawing Selection ===');
        console.log('[Renderer]', 'Selection range:', range);
        console.log(
            '[Renderer]',
            'Text:',
            `"${this.textRunEditor.textBuffer.slice(range.start, range.end)}"`
        );

        // Draw selection highlight for each cluster in range
        this.ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';

        for (const cluster of this.textRunEditor.clusterMap) {
            // Check if this cluster overlaps with selection
            const clusterStart = cluster.start;
            const clusterEnd = cluster.end;

            // Skip if cluster is completely outside selection
            if (clusterEnd <= range.start || clusterStart >= range.end) {
                continue;
            }

            console.log(
                '[Renderer]',
                `Drawing selection for cluster [${clusterStart}-${clusterEnd}), RTL=${cluster.isRTL}, x=${cluster.x.toFixed(0)}, width=${cluster.width.toFixed(0)}`
            );

            // Calculate which part of the cluster is selected
            // Use the actual overlap, not interpolated positions
            const selStart = Math.max(range.start, clusterStart);
            const selEnd = Math.min(range.end, clusterEnd);

            console.log(
                '[Renderer]',
                `  Selection overlap: [${selStart}-${selEnd})`
            );

            // Check if we're selecting the entire cluster or just part of it
            const isFullySelected =
                selStart === clusterStart && selEnd === clusterEnd;
            const isPartiallySelected = !isFullySelected;

            // Calculate visual position and width for selected portion
            let highlightX, highlightWidth;

            if (isFullySelected) {
                // Entire cluster is selected - draw full width
                highlightX = cluster.x;
                highlightWidth = cluster.width;
                console.log(
                    '[Renderer]',
                    `  Full cluster selected: x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`
                );
            } else if (cluster.isRTL) {
                // RTL: right edge is start, left edge is end
                const rightEdge = cluster.x + cluster.width;
                const leftEdge = cluster.x;

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress =
                        (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress =
                        (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    const startX = rightEdge - cluster.width * startProgress;
                    const endX = rightEdge - cluster.width * endProgress;

                    highlightX = Math.min(startX, endX);
                    highlightWidth = Math.abs(startX - endX);
                    console.log(
                        '[Renderer]',
                        `  RTL partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`
                    );
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(
                        '[Renderer]',
                        `  RTL partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`
                    );
                }
            } else {
                // LTR: left edge is start, right edge is end

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress =
                        (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress =
                        (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    highlightX = cluster.x + cluster.width * startProgress;
                    highlightWidth =
                        cluster.width * (endProgress - startProgress);
                    console.log(
                        '[Renderer]',
                        `  LTR partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`
                    );
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(
                        '[Renderer]',
                        `  LTR partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`
                    );
                }
            }

            // Draw highlight rectangle
            this.ctx.fillRect(highlightX, -300, highlightWidth, 1300);
        }

        console.log('[Renderer]', '========================');
    }
}
