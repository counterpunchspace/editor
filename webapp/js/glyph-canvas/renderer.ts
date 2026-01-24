import { adjustColorHueAndLightness, desaturateColor } from '../design';
import APP_SETTINGS from '../settings';
import { Layer } from '../babelfont-model';

import type { ViewportManager } from './viewport';
import type { TextRunEditor } from './textrun';
import { GlyphCanvas } from '../glyph-canvas';
import { LayerDataNormalizer } from '../layer-data-normalizer';
import type { Babelfont } from '../babelfont';

/**
 * Calculate bounding box from SVG path data
 * Parses M, L, C, Q, Z commands to find min/max x and y coordinates
 */
function calculatePathBounds(pathData: string): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    if (!pathData) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // Parse SVG path commands
    const commands = pathData.match(/[MLCQZ][^MLCQZ]*/gi);
    if (!commands) return null;

    for (const cmd of commands) {
        const type = cmd[0];
        const coords = cmd
            .slice(1)
            .trim()
            .split(/[\s,]+/)
            .map(parseFloat)
            .filter((n) => !isNaN(n));

        // Process coordinates based on command type
        for (let i = 0; i < coords.length; i += 2) {
            const x = coords[i];
            const y = coords[i + 1];
            if (x !== undefined && y !== undefined) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
    }

    if (!isFinite(minX)) return null;

    return { minX, minY, maxX, maxY };
}

export class GlyphCanvasRenderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    glyphCanvas: GlyphCanvas;
    viewportManager: ViewportManager;
    textRunEditor: TextRunEditor;

    // FPS tracking - measure actual frame render rate
    private frameCount: number = 0;
    private fpsStartTime: number = 0;
    private fps: number = 0;
    private readonly FPS_UPDATE_INTERVAL = 500; // Update FPS display every 500ms

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

        // Track FPS by counting frames over time intervals
        const now = performance.now();

        // Initialize FPS tracking on first render
        if (this.fpsStartTime === 0) {
            this.fpsStartTime = now;
            this.frameCount = 0;
        }

        this.frameCount++;

        // Update FPS calculation every FPS_UPDATE_INTERVAL ms
        const elapsed = now - this.fpsStartTime;
        if (elapsed >= this.FPS_UPDATE_INTERVAL) {
            this.fps = (this.frameCount / elapsed) * 1000;
            this.frameCount = 0;
            this.fpsStartTime = now;
        }

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
                .getPropertyValue('--background-primary')
                .trim();
        } else {
            // Inactive background (same as .view)
            this.ctx.fillStyle = computedStyle
                .getPropertyValue('--background-secondary')
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

        // Check if stack preview mode is active
        if (this.glyphCanvas.stackPreviewAnimator.shouldRenderStackPreview()) {
            // In stack preview mode, skip normal rendering and draw stack layers
            this.drawStackPreview();
        } else {
            // Normal rendering
            // Draw selection highlight
            this.drawSelection();

            // Draw shaped glyphs
            this.drawShapedGlyphs();

            // Draw canvas plugins below outline editor
            this.drawCanvasPluginsBelow();

            // Draw outline editor (when layer is selected)
            this.drawOutlineEditor();

            // Draw canvas plugins above outline editor
            this.drawCanvasPluginsAbove();
        }

        // Draw measurement tool intersections (in transformed space)
        this.drawMeasurementIntersections();

        // Draw text mode measurement tool
        this.drawTextModeMeasurements();

        // Draw cursor
        this.drawCursor();

        // Draw glyph name tooltip (still in transformed space)
        this.drawGlyphTooltip();

        this.ctx.restore();

        // Draw UI overlay (zoom level, etc.)
        this.drawUIOverlay();
    }

    /**
     * Apply inverse transform to cancel out accumulated component transformations.
     * This is used to render UI elements (like nodes, labels) in normal aspect ratio
     * even when they're inside transformed components.
     * Only inverts the linear transformation (scaling, rotation, skewing) while
     * preserving the translation (position).
     * @returns {boolean} True if inverse transform was applied, false if determinant is too small
     */
    applyInverseComponentTransform(): boolean {
        if (!this.glyphCanvas.outlineEditor.isEditingComponent()) {
            return false;
        }

        // Get the accumulated transform from the current layerData (which may be interpolated)
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();

        const [a, b, c, d, tx, ty] = transform;
        const det = a * d - b * c;

        if (Math.abs(det) > 0.0001) {
            // Apply inverse of only the linear transformation (a, b, c, d)
            // to cancel out scaling/rotation/skewing, but keep translation at 0
            // since we translate to the point position separately
            const invA = d / det;
            const invB = -b / det;
            const invC = -c / det;
            const invD = a / det;
            this.ctx.transform(invA, invB, invC, invD, 0, 0);
            return true;
        }

        return false;
    }

    /**
     * Calculate glow parameters (color and stroke width) based on zoom level.
     * @param {string} baseColor - The base color to apply hue shift to
     * @param {number} invScale - Inverse of viewport scale (1/scale)
     * @param {number} opacity - Opacity for the glow color (0-1)
     * @returns {{ glowColor: string, glowStrokeWidth: number, glowBlur: number }}
     */
    calculateGlowParams(
        baseColor: string,
        invScale: number,
        opacity: number = 1.0
    ): { glowColor: string; glowStrokeWidth: number; glowBlur: number } {
        const glowBlur = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_BLUR;
        const hueShift = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_HUE_SHIFT;

        // Calculate glow stroke width based on zoom level
        const glowStrokeMin =
            APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_STROKE_WIDTH_AT_MIN_ZOOM;
        const glowStrokeMax =
            APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_STROKE_WIDTH_AT_MAX_ZOOM;
        const glowInterpolationMin =
            APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_STROKE_INTERPOLATION_MIN;
        const glowInterpolationMax =
            APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_GLOW_STROKE_INTERPOLATION_MAX;

        let glowStrokeWidth;
        if (this.viewportManager.scale <= glowInterpolationMin) {
            glowStrokeWidth = glowStrokeMin * invScale;
        } else if (this.viewportManager.scale >= glowInterpolationMax) {
            glowStrokeWidth = glowStrokeMax * invScale;
        } else {
            // Interpolate between min and max
            const zoomFactor =
                (this.viewportManager.scale - glowInterpolationMin) /
                (glowInterpolationMax - glowInterpolationMin);
            glowStrokeWidth =
                (glowStrokeMin + (glowStrokeMax - glowStrokeMin) * zoomFactor) *
                invScale;
        }

        // Shift hue for glow color
        let glowColor = adjustColorHueAndLightness(baseColor, hueShift, 0);

        // Parse and apply opacity
        const glowMatch = glowColor.match(
            /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
        );
        if (glowMatch) {
            const r = glowMatch[1];
            const g = glowMatch[2];
            const b = glowMatch[3];
            glowColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        }

        return { glowColor, glowStrokeWidth, glowBlur };
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

                // Get glyph outline from HarfBuzz to calculate actual bounds
                const glyphData =
                    this.textRunEditor.hbFont.glyphToPath(glyphId);
                const pathBounds = glyphData
                    ? calculatePathBounds(glyphData)
                    : null;

                // Store bounds for hit testing and tooltip positioning
                this.glyphCanvas.glyphBounds.push({
                    x: x,
                    y: y,
                    width: xAdvance,
                    height: 1000, // Font units height approximation for hit testing
                    // Visual bounds from actual glyph path
                    x1: pathBounds ? pathBounds.minX : 0,
                    y1: pathBounds ? pathBounds.minY : 0,
                    x2: pathBounds ? pathBounds.maxX : xAdvance,
                    y2: pathBounds ? pathBounds.maxY : 1000
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
                        // Don't show hover effects in preview mode
                        if (
                            isHovered &&
                            !this.glyphCanvas.outlineEditor.isPreviewMode
                        ) {
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

                        // Parse the SVG path data
                        const path = new Path2D(glyphData);

                        // Apply glow effect for hovered glyph in text mode (dark theme only)
                        // Skip glow in preview mode
                        if (
                            isDarkTheme &&
                            !this.glyphCanvas.outlineEditor.active &&
                            !this.glyphCanvas.outlineEditor.isPreviewMode &&
                            isHovered
                        ) {
                            const { glowColor, glowBlur } =
                                this.calculateGlowParams(
                                    this.ctx.fillStyle as string,
                                    invScale,
                                    0.5 // Reduced opacity for subtler glow
                                );

                            // Apply glow using shadow on the fill
                            this.ctx.shadowBlur = glowBlur;
                            this.ctx.shadowColor = glowColor;
                            this.ctx.shadowOffsetX = 0;
                            this.ctx.shadowOffsetY = 0;
                        }

                        // Draw the fill (with shadow if hovered)
                        this.ctx.fill(path);

                        // Reset shadow after drawing
                        if (
                            isDarkTheme &&
                            !this.glyphCanvas.outlineEditor.active &&
                            isHovered
                        ) {
                            this.ctx.shadowBlur = 0;
                            this.ctx.shadowColor = 'transparent';
                        }

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
        // Don't show tooltip in preview mode
        if (
            !this.glyphCanvas.outlineEditor.isPreviewMode &&
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

            // Get glyph name from font manager
            if (
                window.fontManager &&
                window.fontManager.currentFont?.babelfontData
            ) {
                glyphName = window.fontManager.getGlyphName(glyphId);
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

            // Use visual bounding box for positioning
            const visualMinX = glyphBounds?.x1 || 0;
            const visualMaxX = glyphBounds?.x2 || glyphWidth;
            const visualMinY = glyphBounds?.y1 || 0;

            // Position tooltip centered under the glyph's visual bounding box
            // In font coordinates: Y increases upward, so negative Y is below baseline
            const tooltipX = glyphBounds.x + (visualMinX + visualMaxX) / 2;
            const tooltipY = glyphYOffset + visualMinY - 100; // 100 units below bottom of visual bounding box

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

    /**
     * Helper method to get bounding box of component shapes
     */
    private getComponentBounds(shapes: any[]): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        hasPoints: boolean;
    } {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let hasPoints = false;

        const expandBounds = (x: number, y: number) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            hasPoints = true;
        };

        shapes.forEach((shape: any) => {
            // Handle direct node shapes (most common in components)
            if (shape.nodes) {
                shape.nodes.forEach((node: any) => {
                    expandBounds(node.x, node.y);
                });
            }
            // Also handle Contour-wrapped shapes
            else if ('Contour' in shape && shape.Contour.nodes) {
                shape.Contour.nodes.forEach((node: any) => {
                    expandBounds(node.x, node.y);
                });
            }
            // Handle nested components recursively
            else if (
                'Component' in shape &&
                shape.Component.layerData?.shapes
            ) {
                const nestedBounds = this.getComponentBounds(
                    shape.Component.layerData.shapes
                );
                if (nestedBounds.hasPoints) {
                    // Apply the nested component's transform to its bounds
                    const transform = shape.Component.transform || [
                        1, 0, 0, 1, 0, 0
                    ];
                    const [a, b, c, d, tx, ty] = transform;

                    // Transform all four corners of the bounding box
                    const corners = [
                        { x: nestedBounds.minX, y: nestedBounds.minY },
                        { x: nestedBounds.maxX, y: nestedBounds.minY },
                        { x: nestedBounds.minX, y: nestedBounds.maxY },
                        { x: nestedBounds.maxX, y: nestedBounds.maxY }
                    ];

                    corners.forEach((corner) => {
                        const transformedX = a * corner.x + c * corner.y + tx;
                        const transformedY = b * corner.x + d * corner.y + ty;
                        expandBounds(transformedX, transformedY);
                    });
                }
            }
        });

        return { minX, minY, maxX, maxY, hasPoints };
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

        // Get the layer data at the current position in glyph_stack
        // This will return the root glyph data if not in component editing,
        // or the nested component data if we've entered components
        const currentLayerData =
            this.glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();

        // Skip rendering if layer data is invalid (empty shapes array)
        // This prevents flicker when interpolation hasn't completed yet
        if (
            !currentLayerData ||
            !currentLayerData.shapes ||
            currentLayerData.shapes.length === 0
        ) {
            console.log(
                '[Renderer]',
                'Skipping drawOutlineEditor: no shapes at current stack position'
            );
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
        // Get the accumulated transform from the current layerData (which may be interpolated)
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();

        if (this.glyphCanvas.outlineEditor.isEditingComponent()) {
            console.log(
                '[Renderer] Applying accumulated transform:',
                transform
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

        // Draw filled glyph background in 3% black before everything else
        // Build a combined path from all contours (not components) to use nonzero winding for counters
        this.ctx.save();
        this.ctx.beginPath();

        if (currentLayerData.shapes && Array.isArray(currentLayerData.shapes)) {
            currentLayerData.shapes.forEach((shape) => {
                // Only process contours/paths, skip components
                if ('Component' in shape) {
                    return;
                }

                // Get nodes from shape
                let nodes = 'nodes' in shape ? shape.nodes : undefined;
                if (!nodes && 'Path' in shape && shape.Path.nodes) {
                    nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
                }

                if (nodes && nodes.length > 0) {
                    this.buildPathFromNodes(nodes);
                    this.ctx.closePath();
                }
            });
        }

        // Fill with 3% white (dark theme) or black (light theme) - nonzero winding automatically handles counters
        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 0.015)'
            : 'rgba(0, 0, 0, 0.015)';
        this.ctx.fill();
        this.ctx.restore();

        // Draw parent glyph outlines in background if editing a component
        if (this.glyphCanvas.outlineEditor.isEditingComponent()) {
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

        // Draw 1-unit grid at high zoom levels with fade-in
        if (
            this.viewportManager.scale >=
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_GRID_FADE_START
        ) {
            // Calculate grid opacity based on zoom level
            let gridOpacity = 1.0;
            const fadeStart =
                APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_GRID_FADE_START;
            const fadeEnd = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_GRID;

            if (this.viewportManager.scale < fadeEnd) {
                // Interpolate opacity between 0 and 1 as zoom goes from fadeStart to fadeEnd
                gridOpacity =
                    (this.viewportManager.scale - fadeStart) /
                    (fadeEnd - fadeStart);
                gridOpacity = Math.max(0, Math.min(1, gridOpacity)); // Clamp to [0, 1]
            }

            // Get glyph bounds from layer data (if available)
            let minX = -100,
                maxX = 700,
                minY = -200,
                maxY = 1000; // Default bounds

            if (currentLayerData && currentLayerData.shapes) {
                // Calculate bounds from all contours
                currentLayerData.shapes.forEach((shape) => {
                    if (
                        'nodes' in shape &&
                        shape.nodes &&
                        shape.nodes.length > 0
                    ) {
                        shape.nodes.forEach(
                            ({ x, y }: { x: number; y: number }) => {
                                minX = Math.min(minX, x);
                                maxX = Math.max(maxX, x);
                                minY = Math.min(minY, y);
                                maxY = Math.max(maxY, y);
                            }
                        );
                    }
                });
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

            // Apply opacity to grid color
            const gridColor = colors.GRID;
            const rgbaMatch = gridColor.match(
                /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
            );
            if (rgbaMatch) {
                const r = rgbaMatch[1];
                const g = rgbaMatch[2];
                const b = rgbaMatch[3];
                const baseAlpha = rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1;
                this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${baseAlpha * gridOpacity})`;
            } else {
                this.ctx.strokeStyle = gridColor;
                this.ctx.globalAlpha = gridOpacity;
            }

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

            // Reset global alpha if it was used
            if (!rgbaMatch) {
                this.ctx.globalAlpha = 1.0;
            }
        }

        // Draw each shape (contour or component)
        console.log(
            '[Renderer]',
            'Drawing shapes. Component stack depth:',
            this.glyphCanvas.outlineEditor.getComponentDepth(),
            'currentLayerData.shapes.length:',
            currentLayerData?.shapes?.length
        );

        // Collect component labels to draw at the end (on top of everything)
        const componentLabels: Array<{
            componentName: string;
            bounds: {
                minX: number;
                minY: number;
                maxX: number;
                maxY: number;
                hasPoints: boolean;
            };
            transform: number[];
        }> = [];

        // Collect anchor labels to draw last (on top of component labels)
        const anchorLabels: Array<{
            name: string;
            x: number;
            y: number;
            anchorSize: number;
            fontSize: number;
        }> = [];

        // Only draw shapes if they exist (empty glyphs like space won't have shapes)
        if (currentLayerData.shapes && Array.isArray(currentLayerData.shapes)) {
            // Apply monochrome during manual slider interpolation OR when not on an exact layer
            // Don't apply monochrome during layer switch animations
            const isInterpolated =
                this.glyphCanvas.outlineEditor.isInterpolating ||
                (this.glyphCanvas.outlineEditor.selectedLayerId === null &&
                    currentLayerData?.isInterpolated);

            currentLayerData.shapes.forEach((shape, contourIndex: number) =>
                this.drawShape(shape, contourIndex, !!isInterpolated)
            );

            // Draw components
            currentLayerData.shapes.forEach((shape, index: number) => {
                if (!('Component' in shape)) {
                    return; // Not a component
                }

                console.log(
                    '[Renderer]',
                    `Component ${index}: reference="${shape.Component.reference}"`
                );

                // Disable selection/hover highlighting for interpolated data
                const isInterpolated =
                    this.glyphCanvas.outlineEditor.isInterpolating ||
                    (this.glyphCanvas.outlineEditor.selectedLayerId === null &&
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
                console.log('[Renderer] Applying component shape transform:', [
                    a,
                    b,
                    c,
                    d,
                    tx,
                    ty
                ]);
                this.ctx.transform(a, b, c, d, tx, ty);

                // Draw the component's outline shapes if they were fetched
                if (
                    'Component' in shape &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    this.drawComponentWithOutlines(
                        shape.Component.layerData.shapes,
                        isSelected,
                        isHovered,
                        !!isInterpolated,
                        invScale,
                        isDarkTheme
                    );

                    // Collect component label data for later drawing (on top of everything)
                    // Only show on hover
                    if (isHovered) {
                        const componentName =
                            shape.Component.reference || 'component';
                        const bounds = this.getComponentBounds(
                            shape.Component.layerData.shapes
                        );
                        if (bounds.hasPoints) {
                            componentLabels.push({
                                componentName,
                                bounds,
                                transform: [a, b, c, d, tx, ty]
                            });
                        }
                    }
                }

                // Draw component reference marker at origin
                // Skip drawing markers if disabled or if zoom is under minimum threshold
                if (
                    !APP_SETTINGS.OUTLINE_EDITOR.SHOW_COMPONENT_ORIGIN_MARKERS
                ) {
                    this.ctx.restore();
                    return;
                }
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
                let markerStrokeColor = isHovered
                    ? adjustColorHueAndLightness(baseMarkerColor, 0, -20)
                    : baseMarkerColor;

                // Apply monochrome for interpolated data
                if (isInterpolated) {
                    markerStrokeColor = desaturateColor(markerStrokeColor);
                }

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

                // Draw component reference name with inverse transform for normal aspect
                const fontSize = 12 * invScale;
                this.ctx.save();
                this.applyInverseComponentTransform(); // Cancel out component transform
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
            });
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
            currentLayerData.anchors &&
            currentLayerData.anchors.length > 0
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

            currentLayerData.anchors.forEach((anchor: any, index: number) => {
                const { x, y, name } = anchor;
                const isInterpolated =
                    this.glyphCanvas.outlineEditor.isInterpolating ||
                    (this.glyphCanvas.outlineEditor.selectedLayerId === null &&
                        currentLayerData?.isInterpolated);
                const isHovered =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.hoveredAnchorIndex === index;
                const isSelected =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.selectedAnchors.includes(
                        index
                    );

                // Draw anchor as diamond with inverse transform for normal aspect ratio
                this.ctx.save();
                this.ctx.translate(x, y);
                this.applyInverseComponentTransform(); // Cancel out component transform
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

                // Collect anchor label for drawing later (on top of everything)
                if (name && isSelected) {
                    anchorLabels.push({ name, x, y, anchorSize, fontSize });
                }
            });
        }

        // Draw component labels on top of everything
        componentLabels.forEach(({ componentName, bounds, transform }) => {
            const [a, b, c, d, tx, ty] = transform;
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const labelY = bounds.minY - 100; // 100 units below bottom in local space

            this.ctx.save();
            this.ctx.transform(a, b, c, d, tx, ty); // Apply component transform
            this.ctx.translate(centerX, labelY);
            this.ctx.scale(1, -1); // Flip Y to make text right-side up

            const fontSize = 16 * invScale;
            this.ctx.font = `${fontSize}px IBM Plex Mono`;
            const metrics = this.ctx.measureText(componentName);
            const padding = 10 * invScale;
            const bgWidth = metrics.width + padding * 2;
            const bgHeight = fontSize * 1.8;

            const bgX = -bgWidth / 2;
            const bgY = 0;

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
                componentName,
                bgX + padding,
                bgY + fontSize * 0.85 + padding / 2 + 4
            );

            this.ctx.restore();
        });

        // Draw anchor labels on top of component labels
        anchorLabels.forEach(({ name, x, y, anchorSize, fontSize }) => {
            this.ctx.save();
            this.ctx.translate(x, y);
            this.applyInverseComponentTransform(); // Cancel out component transform
            this.ctx.scale(1, -1); // Flip Y axis to fix upside-down text
            this.ctx.font = `${fontSize}px Inter, -apple-system, system-ui, sans-serif`;

            // Measure text for background rectangle
            const metrics = this.ctx.measureText(name);
            const padding = 2 * invScale;
            const textX = anchorSize + 4.5 * invScale;
            const textY = anchorSize;
            const bgX = textX - padding;
            const bgY = textY - fontSize * 0.75 - padding;
            const bgWidth = metrics.width + padding * 2;
            const bgHeight = fontSize + padding * 2;

            // Draw background rectangle
            this.ctx.fillStyle = isDarkTheme
                ? 'rgba(0, 0, 0, 0.75)'
                : 'rgba(255, 255, 255, 0.75)';
            this.ctx.fillRect(bgX, bgY, bgWidth, bgHeight);

            // Draw text
            this.ctx.fillStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 1.0)'
                : 'rgba(0, 0, 0, 1.0)';
            this.ctx.fillText(name, textX, textY);
            this.ctx.restore();
        });

        // Draw bounding box for testing
        this.drawBoundingBox();

        this.ctx.restore();
    }

    drawShape(
        shape: Babelfont.Shape,
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
            // Don't mutate the original shape - just use the parsed nodes for rendering
            nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            console.log(
                '[Renderer] Parsed from shape.Path.nodes, first coords:',
                nodes?.[0]?.x,
                nodes?.[0]?.y
            );
        }

        if (!nodes || nodes.length === 0) {
            return;
        }

        // Log first node coordinates to track interpolation
        console.log(
            '[Renderer] Final nodes to render, first coords:',
            nodes[0]?.x,
            nodes[0]?.y
        );

        // Draw the outline path
        this.ctx.beginPath();
        const outlineOpacity = APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_OPACITY;
        this.ctx.strokeStyle = isDarkTheme
            ? `rgba(255, 255, 255, ${outlineOpacity})`
            : `rgba(0, 0, 0, ${outlineOpacity})`;
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
            const handleOpacity =
                APP_SETTINGS.OUTLINE_EDITOR.HANDLE_LINE_OPACITY;
            this.ctx.strokeStyle = isDarkTheme
                ? `rgba(255, 255, 255, ${handleOpacity})`
                : `rgba(0, 0, 0, ${handleOpacity})`;
            this.ctx.lineWidth = 1 * invScale;

            nodes.forEach((node: Babelfont.Node, nodeIndex: number) => {
                const { x, y, nodetype: type } = node;

                // Only draw lines from off-curve points
                if (type === 'o') {
                    // Check if this is the first or second control point in a cubic bezier pair
                    let prevIdx = nodeIndex - 1;
                    if (prevIdx < 0) prevIdx = nodes.length - 1;
                    const prevType = nodes[prevIdx].nodetype;

                    let nextIdx = nodeIndex + 1;
                    if (nextIdx >= nodes.length) nextIdx = 0;
                    const nextType = nodes[nextIdx].nodetype;
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
                            nodetype: targetType
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
                            nodetype: targetType
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
            (node: Babelfont.Node, nodeIndex: number) => {
                const { x, y, nodetype: type } = node;
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
                // Draw nodes with inverse transform to maintain normal aspect ratio
                this.ctx.save();
                this.ctx.translate(x, y);
                this.applyInverseComponentTransform(); // Cancel out component transform

                if (type === 'o') {
                    // Off-curve point (cubic bezier control point) - draw as circle
                    const colors = isDarkTheme
                        ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                        : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                    this.ctx.beginPath();
                    this.ctx.arc(0, 0, pointSize, 0, Math.PI * 2);
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
                        -pointSize,
                        -pointSize,
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
                    this.ctx.arc(0, 0, pointSize * 0.4, 0, Math.PI * 2);
                    this.ctx.fillStyle = smoothColor;
                    this.ctx.fill();
                }

                this.ctx.restore();
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

        // Draw center point of bounding box
        const centerX = bbox.minX + bbox.width / 2;
        const centerY = bbox.minY + bbox.height / 2;
        const crossSize = 10 * invScale;

        this.ctx.strokeStyle = isDarkTheme
            ? 'rgba(255, 0, 255, 1.0)' // Bright magenta for dark theme
            : 'rgba(255, 0, 255, 1.0)'; // Bright magenta for light theme
        this.ctx.lineWidth = 2 * invScale;

        // Draw crosshair at center
        this.ctx.beginPath();
        this.ctx.moveTo(centerX - crossSize, centerY);
        this.ctx.lineTo(centerX + crossSize, centerY);
        this.ctx.moveTo(centerX, centerY - crossSize);
        this.ctx.lineTo(centerX, centerY + crossSize);
        this.ctx.stroke();

        // Draw bbox dimensions as text labels
        const fontSize = 10 * invScale;
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

        // Draw text buffer info (top left)
        if (this.textRunEditor.textBuffer) {
            const textInfo = `Text: "${this.textRunEditor.textBuffer}" (${this.textRunEditor.shapedGlyphs.length} glyphs)`;
            this.ctx.fillText(textInfo, 10, 20);
        }

        // Draw pan/zoom info (top left) - skip in test mode to prevent screenshot diffs
        if (!window.isTestMode?.()) {
            const panText = `Pan: (${Math.round(this.viewportManager.panX)}, ${Math.round(this.viewportManager.panY)})`;
            this.ctx.fillText(panText, 10, 35);

            const zoomText = `Zoom: ${(this.viewportManager.scale * 100).toFixed(1)}%`;
            this.ctx.fillText(zoomText, 10, 50);
        }

        // Draw FPS (top left) - skip in test mode to prevent screenshot diffs
        if (this.fps > 0 && !window.isTestMode?.()) {
            const fpsText = `FPS: ${Math.round(this.fps)}`;
            this.ctx.fillText(fpsText, 10, 65);
        }

        // Draw crosshair or user-defined line when alt key is pressed in editing mode
        if (this.glyphCanvas.measurementTool.shouldDrawVisuals()) {
            const isDarkTheme =
                document.documentElement.getAttribute('data-theme') !== 'light';
            const colors = isDarkTheme
                ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
            this.ctx.save();
            this.ctx.globalAlpha =
                APP_SETTINGS.OUTLINE_EDITOR.MEASUREMENT_TOOL_GUIDE_LINES_OPACITY;
            this.ctx.strokeStyle = colors.MEASUREMENT_TOOL_CROSSHAIR;
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();

            if (this.glyphCanvas.measurementTool.isDragging) {
                // Draw user-defined line from origin to current mouse position
                const originCanvasX =
                    (this.glyphCanvas.measurementTool.originX *
                        this.canvas.width) /
                    rect.width;
                const originCanvasY =
                    (this.glyphCanvas.measurementTool.originY *
                        this.canvas.height) /
                    rect.height;

                // Draw faint crosshair lines at origin and mouse position
                // Horizontal line through origin
                this.ctx.moveTo(0, originCanvasY);
                this.ctx.lineTo(this.canvas.width, originCanvasY);

                // Vertical line through origin
                this.ctx.moveTo(originCanvasX, 0);
                this.ctx.lineTo(originCanvasX, this.canvas.height);

                // Horizontal line through mouse position
                this.ctx.moveTo(0, this.glyphCanvas.mouseCanvasY);
                this.ctx.lineTo(
                    this.canvas.width,
                    this.glyphCanvas.mouseCanvasY
                );

                // Vertical line through mouse position
                this.ctx.moveTo(this.glyphCanvas.mouseCanvasX, 0);
                this.ctx.lineTo(
                    this.glyphCanvas.mouseCanvasX,
                    this.canvas.height
                );

                this.ctx.stroke();

                // Draw measurement labels (width, height, diagonal distance)
                // Get origin and mouse positions in font space
                const { x: originFontX, y: originFontY } =
                    this.viewportManager.getFontSpaceCoordinates(
                        this.glyphCanvas.measurementTool.originX,
                        this.glyphCanvas.measurementTool.originY
                    );
                const { x: mouseFontX, y: mouseFontY } =
                    this.viewportManager.getFontSpaceCoordinates(
                        this.glyphCanvas.mouseX,
                        this.glyphCanvas.mouseY
                    );

                const deltaX = Math.abs(mouseFontX - originFontX);
                const deltaY = Math.abs(mouseFontY - originFontY);
                const diagonal = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

                this.ctx.save();
                this.ctx.globalAlpha =
                    APP_SETTINGS.OUTLINE_EDITOR.MEASUREMENT_TOOL_GUIDE_LINES_OPACITY;
                this.ctx.fillStyle = isDarkTheme ? '#FFFFFF' : '#000000';
                this.ctx.font = '18px system-ui, -apple-system, sans-serif';
                this.ctx.textBaseline = 'bottom';

                // Width label on top (centered between origin and mouse X)
                const widthLabelX =
                    (originCanvasX + this.glyphCanvas.mouseCanvasX) / 2;
                const widthLabelY = Math.min(
                    originCanvasY,
                    this.glyphCanvas.mouseCanvasY
                );
                this.ctx.textAlign = 'center';
                this.ctx.fillText(
                    `${Math.round(deltaX)}`,
                    widthLabelX,
                    widthLabelY - 9
                );

                // Height label on the right (centered between origin and mouse Y)
                const heightLabelX = Math.max(
                    originCanvasX,
                    this.glyphCanvas.mouseCanvasX
                );
                const heightLabelY =
                    (originCanvasY + this.glyphCanvas.mouseCanvasY) / 2;
                this.ctx.textAlign = 'left';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(
                    `${Math.round(deltaY)}`,
                    heightLabelX + 9,
                    heightLabelY
                );

                // Diagonal distance at mouse position (outer corner)
                const diagonalLabelX = this.glyphCanvas.mouseCanvasX;
                const diagonalLabelY = this.glyphCanvas.mouseCanvasY;

                // Align left if mouse is right of origin, right if mouse is left of origin
                const mouseIsRightOfOrigin =
                    this.glyphCanvas.mouseCanvasX > originCanvasX;
                this.ctx.textAlign = mouseIsRightOfOrigin ? 'left' : 'right';

                // Position above if mouse is above origin, below if mouse is below origin
                const mouseIsAboveOrigin =
                    this.glyphCanvas.mouseCanvasY < originCanvasY;
                this.ctx.textBaseline = mouseIsAboveOrigin ? 'bottom' : 'top';

                const diagonalOffsetX = mouseIsRightOfOrigin ? 9 : -9;
                const diagonalOffsetY = mouseIsAboveOrigin ? -9 : 9;

                this.ctx.fillText(
                    `⌀${Math.round(diagonal)}`,
                    diagonalLabelX + diagonalOffsetX,
                    diagonalLabelY + diagonalOffsetY
                );

                this.ctx.restore();

                // Draw main measurement line
                this.ctx.beginPath();
                this.ctx.moveTo(originCanvasX, originCanvasY);
                this.ctx.lineTo(
                    this.glyphCanvas.mouseCanvasX,
                    this.glyphCanvas.mouseCanvasY
                );
            } else {
                // Draw crosshair at mouse position
                // Horizontal line across entire canvas
                this.ctx.moveTo(0, this.glyphCanvas.mouseCanvasY);
                this.ctx.lineTo(
                    this.canvas.width,
                    this.glyphCanvas.mouseCanvasY
                );
                // Vertical line across entire canvas
                this.ctx.moveTo(this.glyphCanvas.mouseCanvasX, 0);
                this.ctx.lineTo(
                    this.glyphCanvas.mouseCanvasX,
                    this.canvas.height
                );
            }

            this.ctx.stroke();
            this.ctx.restore();

            // Draw coordinate labels for crosshair (not for custom drag line)
            if (!this.glyphCanvas.measurementTool.isDragging) {
                // Get mouse position in font space
                const { x: mouseFontX, y: mouseFontY } =
                    this.viewportManager.getFontSpaceCoordinates(
                        this.glyphCanvas.mouseX,
                        this.glyphCanvas.mouseY
                    );

                // Calculate glyph origin position to make x coordinate relative
                let glyphOriginX = 0;
                if (
                    this.textRunEditor.selectedGlyphIndex >= 0 &&
                    this.textRunEditor.selectedGlyphIndex <
                        this.textRunEditor.shapedGlyphs.length
                ) {
                    // Accumulate advance widths up to selected glyph
                    for (
                        let i = 0;
                        i < this.textRunEditor.selectedGlyphIndex;
                        i++
                    ) {
                        glyphOriginX +=
                            this.textRunEditor.shapedGlyphs[i].ax || 0;
                    }
                    // Add the selected glyph's offset
                    const glyph =
                        this.textRunEditor.shapedGlyphs[
                            this.textRunEditor.selectedGlyphIndex
                        ];
                    glyphOriginX += glyph.dx || 0;
                }

                this.ctx.save();
                // Use screen space for labels
                this.ctx.resetTransform();
                const labelColor = isDarkTheme ? '#FFFFFF' : '#000000';
                this.ctx.fillStyle = labelColor;
                this.ctx.font = '14px system-ui, -apple-system, sans-serif';
                const labelPadding = 6;

                // Y-coordinate label on left edge
                this.ctx.textBaseline = 'bottom';
                this.ctx.textAlign = 'left';
                const yLabel = `y=${Math.round(mouseFontY)}`;
                this.ctx.fillText(
                    yLabel,
                    labelPadding,
                    this.glyphCanvas.mouseCanvasY - labelPadding
                );

                // X-coordinate label at top (relative to glyph origin)
                this.ctx.textBaseline = 'top';
                this.ctx.textAlign = 'left';
                const relativeX = mouseFontX - glyphOriginX;
                const xLabel = `x=${Math.round(relativeX)}`;
                this.ctx.fillText(
                    xLabel,
                    this.glyphCanvas.mouseCanvasX + labelPadding,
                    labelPadding
                );

                this.ctx.restore();
            }
        }

        this.ctx.restore();
    }

    /**
     * Draw canvas plugins above the outline editor.
     * Calls the draw_above() method of each loaded plugin.
     */
    drawCanvasPluginsAbove() {
        this._drawCanvasPlugins('above');
    }

    /**
     * Draw canvas plugins below the outline editor.
     * Calls the draw_below() method of each loaded plugin.
     */
    drawCanvasPluginsBelow() {
        this._drawCanvasPlugins('below');
    }

    /**
     * Internal method to draw canvas plugins at a specific position.
     */
    private _drawCanvasPlugins(position: 'above' | 'below') {
        console.log(
            `[Renderer] drawCanvasPlugins${position === 'above' ? 'Above' : 'Below'} called`
        );

        // Skip plugins in preview mode
        if (this.glyphCanvas.outlineEditor.isPreviewMode) {
            console.log('[Renderer] Skipping plugins - preview mode active');
            return;
        }

        // Only draw plugins when we have an active outline editor with layer data
        if (
            !this.glyphCanvas.outlineEditor.layerData ||
            !window.canvasPluginManager ||
            !window.canvasPluginManager.isLoaded()
        ) {
            console.log('[Renderer] Early return:', {
                hasLayerData: !!this.glyphCanvas.outlineEditor.layerData,
                hasPluginManager: !!window.canvasPluginManager,
                isLoaded: window.canvasPluginManager?.isLoaded()
            });
            return;
        }

        // Get the current glyph name
        const selectedGlyphIndex = this.textRunEditor.selectedGlyphIndex;
        if (
            selectedGlyphIndex < 0 ||
            selectedGlyphIndex >= this.textRunEditor.shapedGlyphs.length
        ) {
            console.log('[Renderer] Invalid glyph index:', selectedGlyphIndex);
            return;
        }

        const glyphId = this.textRunEditor.shapedGlyphs[selectedGlyphIndex].g;

        // Get glyph name from font manager (same way as tooltip does)
        let glyphName = '';
        if (window.fontManager?.currentFont?.babelfontData) {
            try {
                glyphName = window.fontManager.getGlyphName(glyphId);
            } catch (error) {
                console.warn('[Renderer] Failed to get glyph name:', error);
            }
        }

        // Get the current layer data
        const layerData =
            this.glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();

        if (!layerData) {
            console.log('[Renderer] No layer data from stack');
            return;
        }

        console.log(
            `[Renderer] Calling ${position} plugins for glyph:`,
            glyphName
        );

        // Calculate glyph position in text run (same as drawOutlineEditor does)
        let xPosition = 0;
        for (let i = 0; i < selectedGlyphIndex; i++) {
            xPosition += this.textRunEditor.shapedGlyphs[i].ax || 0;
        }

        const glyph = this.textRunEditor.shapedGlyphs[selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const x = xPosition + xOffset;
        const y = yOffset;

        // Save context and translate to glyph position
        this.ctx.save();
        this.ctx.translate(x, y);

        // Apply accumulated component transform if editing a component
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        if (this.glyphCanvas.outlineEditor.isEditingComponent()) {
            this.ctx.transform(
                transform[0],
                transform[1],
                transform[2],
                transform[3],
                transform[4],
                transform[5]
            );
        }

        // Call plugins (the actual drawing is synchronous, just the wrapper returns a promise)
        // We catch errors but don't wait for the promise - restore context immediately
        const pluginMethod =
            position === 'above'
                ? window.canvasPluginManager.drawPluginsAbove.bind(
                      window.canvasPluginManager
                  )
                : window.canvasPluginManager.drawPluginsBelow.bind(
                      window.canvasPluginManager
                  );

        pluginMethod(
            layerData,
            glyphName,
            this.ctx,
            this.viewportManager
        ).catch((error: any) => {
            console.error(
                `[Renderer] Error drawing canvas plugins (${position}):`,
                error
            );
        });

        // Restore context immediately after calling plugins (synchronous)
        this.ctx.restore();
    }

    drawMeasurementIntersections() {
        // Only draw when alt key is pressed, in editing mode, and we have layer data
        if (
            !this.glyphCanvas.measurementTool.shouldDrawVisuals() ||
            !this.glyphCanvas.outlineEditor.layerData
        ) {
            return;
        }

        // Get the selected glyph's position
        if (
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
            return;
        }

        // Use the same coordinate transformation as hit detection
        // This accounts for component nesting via transformMouseToComponentSpace
        const { glyphX: localX, glyphY: localY } =
            this.glyphCanvas.outlineEditor.transformMouseToComponentSpace();

        // Use the raw layerData from outlineEditor which has nested components properly populated
        // via fontManager.fetchLayerData() - this is already at the correct nesting level
        const layerData = this.glyphCanvas.outlineEditor.layerData;

        // Create a temporary Layer wrapper to use getIntersectionsOnLine()
        // Get the current glyph wrapper from the font model to enable component lookups
        const glyphName = this.glyphCanvas.outlineEditor.currentGlyphName;
        const glyphWrapper = glyphName
            ? (window as any).currentFontModel.findGlyph(glyphName)
            : null;

        // Find the matching Layer wrapper on the glyph that corresponds to the current layerData
        // This ensures component lookups use the correct master ID
        let layerWrapper: Layer | null = null;
        if (glyphWrapper && glyphWrapper.layers) {
            const currentLayerId =
                this.glyphCanvas.outlineEditor.selectedLayerId;
            for (const layer of glyphWrapper.layers) {
                if (layer.id === currentLayerId) {
                    layerWrapper = layer;
                    break;
                }
            }
        }

        // Fallback: create temporary wrapper if we couldn't find the layer
        const tempLayer =
            layerWrapper || new Layer([layerData], 0, glyphWrapper);

        // Define line endpoints in component-local space
        let horizontalIntersections: Array<{
            x: number;
            y: number;
            t: number;
        }> = [];
        let verticalIntersections: Array<{ x: number; y: number; t: number }> =
            [];

        if (this.glyphCanvas.measurementTool.isDragging) {
            // User-defined line: get intersections along the line from origin to current mouse
            // Transform origin CSS coordinates to glyph-local space using the same method as current mouse
            let { glyphX: originGlyphX, glyphY: originGlyphY } =
                this.glyphCanvas.toGlyphLocal(
                    this.glyphCanvas.measurementTool.originX,
                    this.glyphCanvas.measurementTool.originY
                );

            // Transform current mouse position to component-local space
            const currentTransformed =
                this.glyphCanvas.outlineEditor.transformMouseToComponentSpace();
            let currentLocalX = currentTransformed.glyphX;
            let currentLocalY = currentTransformed.glyphY;

            // Apply the same component transform to origin if in component mode
            let originLocalX = originGlyphX;
            let originLocalY = originGlyphY;

            if (this.glyphCanvas.outlineEditor.isEditingComponent()) {
                const compTransform =
                    this.glyphCanvas.outlineEditor.getAccumulatedTransform();
                const [a, b, c, d, tx, ty] = compTransform;
                const det = a * d - b * c;

                if (Math.abs(det) > 0.0001) {
                    // Inverse transform for origin point
                    const localX = originGlyphX - tx;
                    const localY = originGlyphY - ty;
                    originLocalX = (d * localX - c * localY) / det;
                    originLocalY = (a * localY - b * localX) / det;
                }
            }

            // Get intersections along the user-defined line
            const lineIntersections = tempLayer.getIntersectionsOnLine(
                { x: originLocalX, y: originLocalY },
                { x: currentLocalX, y: currentLocalY },
                true // include nested components
            );

            // Use the same intersections for both (we'll handle them as a single line)
            horizontalIntersections = lineIntersections;
            verticalIntersections = []; // No vertical intersections for user-defined line
        } else {
            // Crosshair mode: get intersections along horizontal and vertical lines
            const largeDistance = 100000;

            // Get intersections along horizontal line at crosshair Y (in component-local coords)
            const horizontalP1 = { x: -largeDistance, y: localY };
            const horizontalP2 = { x: largeDistance, y: localY };
            horizontalIntersections = tempLayer.getIntersectionsOnLine(
                horizontalP1,
                horizontalP2,
                true // include nested components
            );

            // Get intersections along vertical line at crosshair X (in component-local coords)
            const verticalP1 = { x: localX, y: -largeDistance };
            const verticalP2 = { x: localX, y: largeDistance };
            verticalIntersections = tempLayer.getIntersectionsOnLine(
                verticalP1,
                verticalP2,
                true // include nested components
            );
        }

        // Get color from settings
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        this.ctx.fillStyle = colors.MEASUREMENT_TOOL_DOT;

        // Calculate dot radius in font units (inverse of scale to keep constant screen size)
        const dotRadius = 5 / this.viewportManager.scale;

        // Get glyph world position
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
        const glyphWorldX = xPosition + xOffset;
        const glyphWorldY = yOffset;

        // If we're in component editing mode, apply the accumulated component transform
        // to convert from component-local coords to glyph-local coords
        const isInComponentMode =
            this.glyphCanvas.outlineEditor.isEditingComponent();
        let accumulatedTransform: number[] | null = null;

        if (isInComponentMode) {
            accumulatedTransform =
                this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        }

        // Helper function to transform a point from component-local to world coords
        const transformToWorld = (point: { x: number; y: number }) => {
            let x = point.x;
            let y = point.y;

            // Apply accumulated component transform if in component mode
            if (accumulatedTransform) {
                const [a, b, c, d, tx, ty] = accumulatedTransform;
                const transformedX = a * x + c * y + tx;
                const transformedY = b * x + d * y + ty;
                x = transformedX;
                y = transformedY;
            }

            // Convert from glyph-local to world coords
            return {
                x: x + glyphWorldX,
                y: y + glyphWorldY
            };
        };

        // Draw measurement lines and dots first, then labels on top
        this.ctx.strokeStyle = colors.MEASUREMENT_TOOL_LINE;
        this.ctx.lineWidth = 2 / this.viewportManager.scale;

        // Collect label data to draw later (on top)
        const labelsToRender: Array<{
            x: number;
            y: number;
            distance: number;
            orientation: 'horizontal' | 'vertical';
        }> = [];

        if (
            this.glyphCanvas.measurementTool.isDragging &&
            horizontalIntersections.length > 0
        ) {
            // User-defined line: draw measurements along the line
            // Only draw over inked areas (even-indexed segments), skip counters (odd-indexed segments)
            for (let i = 0; i < horizontalIntersections.length - 1; i++) {
                // Skip odd-indexed segments (these are over counters/white space)
                if (i % 2 !== 0) continue;

                const p1 = transformToWorld(horizontalIntersections[i]);
                const p2 = transformToWorld(horizontalIntersections[i + 1]);

                // Draw line between consecutive intersection points
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
                this.ctx.stroke();

                // Calculate distance and midpoint (Euclidean distance for user-defined line)
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;

                // Store label data for later rendering
                labelsToRender.push({
                    x: midX,
                    y: midY,
                    distance,
                    orientation: 'horizontal'
                });
            }
        } else {
            // Crosshair mode: draw horizontal and vertical measurements separately
            // Only draw over inked areas (even-indexed segments), skip counters (odd-indexed segments)
            for (let i = 0; i < horizontalIntersections.length - 1; i++) {
                // Skip odd-indexed segments (these are over counters/white space)
                if (i % 2 !== 0) continue;

                const p1 = transformToWorld(horizontalIntersections[i]);
                const p2 = transformToWorld(horizontalIntersections[i + 1]);

                // Draw line between consecutive intersection points
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
                this.ctx.stroke();

                // Calculate distance and midpoint
                const distance = Math.abs(p2.x - p1.x);
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;

                // Store label data for later rendering
                labelsToRender.push({
                    x: midX,
                    y: midY,
                    distance,
                    orientation: 'horizontal'
                });
            }

            // Draw vertical measurements
            // Only draw over inked areas (even-indexed segments), skip counters (odd-indexed segments)
            for (let i = 0; i < verticalIntersections.length - 1; i++) {
                // Skip odd-indexed segments (these are over counters/white space)
                if (i % 2 !== 0) continue;

                const p1 = transformToWorld(verticalIntersections[i]);
                const p2 = transformToWorld(verticalIntersections[i + 1]);

                // Draw line between consecutive intersection points
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
                this.ctx.stroke();

                // Calculate distance and midpoint
                const distance = Math.abs(p2.y - p1.y);
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;

                // Store label data for later rendering
                labelsToRender.push({
                    x: midX,
                    y: midY,
                    distance,
                    orientation: 'vertical'
                });
            }
        }

        // Draw intersection dots in world coordinates
        this.ctx.fillStyle = colors.MEASUREMENT_TOOL_DOT;
        for (const intersection of horizontalIntersections) {
            const worldPos = transformToWorld(intersection);
            this.ctx.beginPath();
            this.ctx.arc(worldPos.x, worldPos.y, dotRadius, 0, Math.PI * 2);
            this.ctx.fill();
        }

        for (const intersection of verticalIntersections) {
            const worldPos = transformToWorld(intersection);
            this.ctx.beginPath();
            this.ctx.arc(worldPos.x, worldPos.y, dotRadius, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // Draw labels on top of everything
        for (const label of labelsToRender) {
            this.drawMeasurementLabel(
                label.x,
                label.y,
                label.distance,
                label.orientation
            );
        }
    }

    /**
     * Draw a measurement label at the specified position
     */
    private drawMeasurementLabel(
        x: number,
        y: number,
        distance: number,
        orientation: 'horizontal' | 'vertical',
        placeBelow: boolean = false
    ) {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        // Format distance to 1 decimal place
        const distanceText = distance.toFixed(1);

        // Font size in world units (to maintain constant screen size)
        const invScale = 1 / this.viewportManager.scale;
        const fontSize = 12 * invScale;

        this.ctx.save();

        // Translate to world position and flip Y to make text readable
        this.ctx.translate(x, y);
        this.ctx.scale(1, -1);

        const labelFontSize = fontSize * 0.83;
        this.ctx.font = `${labelFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // Measure text dimensions
        const metrics = this.ctx.measureText(distanceText);
        const textWidth = metrics.width;
        const textHeight = labelFontSize * 1.2;

        // Calculate background padding
        const padding = 4 * invScale;
        const bgWidth = textWidth + padding * 2;
        const bgHeight = textHeight + padding;

        // Offset label position based on orientation
        let offsetX = 0;
        let offsetY = 0;

        if (orientation === 'horizontal') {
            // Place label above or below the line based on placeBelow parameter
            if (placeBelow) {
                offsetY = bgHeight / 2 + 8 * invScale;
            } else {
                offsetY = -bgHeight / 2 - 8 * invScale;
            }
        } else {
            // Place label slightly to the right of the line
            offsetX = bgWidth / 2 + 8 * invScale;
        }

        // Draw background rectangle
        this.ctx.fillStyle = colors.MEASUREMENT_TOOL_LABEL_BG;
        this.ctx.fillRect(
            offsetX - bgWidth / 2,
            offsetY - bgHeight / 2,
            bgWidth,
            bgHeight
        );

        // Draw text
        this.ctx.fillStyle = colors.MEASUREMENT_TOOL_LABEL_TEXT;
        this.ctx.fillText(distanceText, offsetX, offsetY);

        this.ctx.restore();
    }

    buildPathFromNodes(nodes: Babelfont.Node[], pathTarget?: Path2D) {
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
            const { x, y, nodetype: type } = nodes[i];
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

            const { x, y, nodetype: type } = nodes[idx];
            const {
                x: next1X,
                y: next1Y,
                nodetype: next1Type
            } = nodes[nextIdx];

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
                        nodetype: next2Type
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
        // Don't draw cursor if not visible, in glyph edit mode, in preview mode, or when measurement tool is active in text mode
        if (
            !this.glyphCanvas.cursorVisible ||
            this.glyphCanvas.outlineEditor.active ||
            this.glyphCanvas.outlineEditor.isPreviewMode ||
            this.glyphCanvas.measurementTool.shouldDrawTextModeMeasurements()
        ) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;

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

        // Don't draw selection background when in edit mode (outline editor active)
        // Selection state is preserved, but background is hidden until we exit edit mode
        if (this.glyphCanvas.outlineEditor.active) {
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

    /**
     * Draw measurement tool for text mode
     * Shows horizontal line at mouse Y position with distance measurements from glyph edges to outline intersections
     */
    drawTextModeMeasurements() {
        // Only draw when alt key is pressed, in text mode, and we have a font
        if (!this.glyphCanvas.shiftKeyPressed) return;

        if (!this.glyphCanvas.measurementTool.shouldDrawTextModeMeasurements())
            return;

        if (
            this.glyphCanvas.outlineEditor.active ||
            !this.textRunEditor.shapedGlyphs ||
            this.textRunEditor.shapedGlyphs.length === 0 ||
            !window.currentFontModel
        ) {
            return;
        }

        console.log(
            '[TextMeasure] Drawing measurements, mouse at',
            this.glyphCanvas.mouseX,
            this.glyphCanvas.mouseY
        );

        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        // Get mouse position in font space (using mouseX/mouseY which are in screen pixels)
        const { x: mouseGlyphX, y: mouseGlyphY } =
            this.viewportManager.getFontSpaceCoordinates(
                this.glyphCanvas.mouseX,
                this.glyphCanvas.mouseY
            );

        console.log(
            '[TextMeasure] Mouse coordinates:',
            'screen:',
            { x: this.glyphCanvas.mouseX, y: this.glyphCanvas.mouseY },
            'font space:',
            { x: mouseGlyphX, y: mouseGlyphY },
            'pan:',
            { x: this.viewportManager.panX, y: this.viewportManager.panY },
            'scale:',
            this.viewportManager.scale
        );

        // Draw horizontal line across entire viewport at mouse Y position
        // Style it like the edit mode crosshair (solid line, 1px canvas width)
        this.ctx.save();

        this.ctx.strokeStyle = colors.MEASUREMENT_TOOL_CROSSHAIR;
        this.ctx.lineWidth = 1;

        // Get viewport bounds in font space
        const viewportLeft =
            -this.viewportManager.panX / this.viewportManager.scale;
        const viewportRight =
            (this.canvas.width - this.viewportManager.panX) /
            this.viewportManager.scale;

        this.ctx.beginPath();
        this.ctx.moveTo(viewportLeft, mouseGlyphY);
        this.ctx.lineTo(viewportRight, mouseGlyphY);
        this.ctx.stroke();

        this.ctx.restore();

        // Draw y-coordinate label on left viewport edge (in screen space to avoid y-flip)
        this.ctx.save();
        this.ctx.resetTransform();
        this.ctx.fillStyle = isDarkTheme ? '#FFFFFF' : '#000000';
        this.ctx.font = '14px system-ui, -apple-system, sans-serif';
        this.ctx.textBaseline = 'bottom';
        this.ctx.textAlign = 'left';
        const yLabel = `y=${Math.round(mouseGlyphY)}`;
        const labelPadding = 6;
        this.ctx.fillText(
            yLabel,
            labelPadding,
            this.glyphCanvas.mouseCanvasY - labelPadding
        );
        this.ctx.restore();

        // Get current master ID for layer lookup
        // Use the first master if available, or get it from the selected layer
        const fontModel = window.currentFontModel;
        if (!fontModel || !fontModel.masters || fontModel.masters.length === 0)
            return;

        // Try to get master from selectedLayerId, otherwise use first master
        let masterId = fontModel.masters[0].id;
        if (this.glyphCanvas.outlineEditor.selectedLayerId) {
            // Find the master from the selected layer
            const selectedLayer = fontModel.glyphs
                .flatMap((g: any) => g.layers || [])
                .find(
                    (l: any) =>
                        l.id === this.glyphCanvas.outlineEditor.selectedLayerId
                );
            if (selectedLayer && selectedLayer.master) {
                masterId = selectedLayer.master.id;
            }
        }

        // Process each glyph in the text line
        let xPosition = 0;
        const invScale = 1 / this.viewportManager.scale;

        // Track previous right label position for overlap detection
        let previousRightLabelEnd: number | null = null;

        console.log(
            '[TextMeasure] Processing',
            this.textRunEditor.shapedGlyphs.length,
            'glyphs, masterId=',
            masterId
        );

        this.textRunEditor.shapedGlyphs.forEach(
            (glyph: any, glyphIndex: number) => {
                const glyphId = glyph.g;
                const xOffset = glyph.dx || 0;
                const yOffset = glyph.dy || 0;
                const xAdvance = glyph.ax || 0;

                // Glyph position in font space
                const glyphX = xPosition + xOffset;
                const glyphY = yOffset;

                // Get glyph name from font manager
                let glyphName: string | undefined;
                if (
                    window.fontManager &&
                    window.fontManager.currentFont?.babelfontData
                ) {
                    try {
                        glyphName = window.fontManager.getGlyphName(glyphId);
                    } catch (error) {
                        // WASM not ready, use fallback
                        glyphName = undefined;
                    }
                }

                console.log('[TextMeasure] Found glyph name:', glyphName);
                if (!glyphName) {
                    console.log('[TextMeasure] No glyph name, skipping');
                    xPosition += xAdvance;
                    return;
                }

                // Find the glyph in the font model
                const fontModel = window.currentFontModel;
                if (!fontModel) {
                    console.log('[TextMeasure] No font model, skipping');
                    xPosition += xAdvance;
                    return;
                }

                const glyphWrapper = fontModel.findGlyph(glyphName);
                console.log(
                    '[TextMeasure] Glyph wrapper:',
                    !!glyphWrapper,
                    'layers:',
                    glyphWrapper?.layers?.length
                );
                if (!glyphWrapper || !glyphWrapper.layers) {
                    console.log(
                        '[TextMeasure] No glyph wrapper or layers, skipping'
                    );
                    xPosition += xAdvance;
                    return;
                }

                // Find the layer for the selected master
                // Only proceed if a master is selected in text mode
                const selectedMasterId = this.textRunEditor.selectedMasterId;
                if (!selectedMasterId) {
                    xPosition += xAdvance;
                    return;
                }

                console.log(
                    `[TextMeasure] ${glyphName}: Looking for master ${selectedMasterId}, available masters:`,
                    glyphWrapper.layers.map((l: any) => ({
                        master: (l.master as any)?.DefaultForMaster || 'none',
                        hasShapes: !!l.shapes,
                        shapeCount: l.shapes?.length || 0
                    }))
                );

                const layer = glyphWrapper.layers.find(
                    (l: any) =>
                        l.master &&
                        (l.master as any).DefaultForMaster === selectedMasterId
                );

                if (!layer) {
                    console.log(
                        `[TextMeasure] ${glyphName}: No matching layer found!`
                    );
                    xPosition += xAdvance;
                    return;
                }

                console.log(
                    `[TextMeasure] ${glyphName}: Found layer with ${(layer as any).shapes?.length || 0} shapes`
                );

                // Calculate measurement Y in glyph-local space
                // mouseGlyphY is in font space (absolute Y), yOffset is the glyph's Y position
                // To get the Y coordinate within the glyph's own coordinate system, subtract yOffset
                const lineY = mouseGlyphY - yOffset;

                console.log(
                    `[TextMeasure] ${glyphName}: yOffset=${yOffset}, mouseGlyphY=${mouseGlyphY.toFixed(1)}, lineY=${lineY.toFixed(1)}, bbox=`,
                    (layer as any).getBoundingBox(false)
                );

                // Use the Layer's sidebearing method to get measurements
                const sidebearings = (layer as any).getSidebearingsAtHeight(
                    lineY
                );

                console.log(
                    `[TextMeasure] ${glyphName}: sidebearings=`,
                    sidebearings
                );

                // Only draw if we have valid sidebearings (i.e., outline intersects the line)
                if (sidebearings !== null) {
                    const leftDistance = sidebearings.left;
                    const rightDistance = sidebearings.right;

                    // Calculate intersection points in glyph-local space
                    const firstIntersectionX = leftDistance;
                    const lastIntersectionX = xAdvance - rightDistance;

                    // Transform to world space for drawing
                    const firstWorldX = firstIntersectionX + glyphX;
                    const firstWorldY = mouseGlyphY;
                    const lastWorldX = lastIntersectionX + glyphX;
                    const lastWorldY = mouseGlyphY;
                    const glyphLeftX = glyphX;
                    const glyphRightX = glyphX + xAdvance;

                    this.ctx.save();

                    // Draw dots at intersections
                    this.ctx.fillStyle = colors.MEASUREMENT_TOOL_LINE;
                    const dotRadius = 3 / this.viewportManager.scale;

                    this.ctx.beginPath();
                    this.ctx.arc(
                        firstWorldX,
                        firstWorldY,
                        dotRadius,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.fill();

                    this.ctx.beginPath();
                    this.ctx.arc(
                        lastWorldX,
                        lastWorldY,
                        dotRadius,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.fill();

                    // Draw measurement lines from glyph edges to intersections
                    this.ctx.strokeStyle = colors.MEASUREMENT_TOOL_LINE;
                    this.ctx.lineWidth = 1 / this.viewportManager.scale;

                    // Left measurement line
                    this.ctx.beginPath();
                    this.ctx.moveTo(glyphLeftX, mouseGlyphY);
                    this.ctx.lineTo(firstWorldX, mouseGlyphY);
                    this.ctx.stroke();

                    // Right measurement line
                    this.ctx.beginPath();
                    this.ctx.moveTo(lastWorldX, mouseGlyphY);
                    this.ctx.lineTo(glyphRightX, mouseGlyphY);
                    this.ctx.stroke();

                    // Draw vertical ticks at glyph edges
                    const tickHeight = 20 * invScale;
                    this.ctx.beginPath();
                    this.ctx.moveTo(glyphLeftX, mouseGlyphY - tickHeight / 2);
                    this.ctx.lineTo(glyphLeftX, mouseGlyphY + tickHeight / 2);
                    this.ctx.stroke();

                    this.ctx.beginPath();
                    this.ctx.moveTo(glyphRightX, mouseGlyphY - tickHeight / 2);
                    this.ctx.lineTo(glyphRightX, mouseGlyphY + tickHeight / 2);
                    this.ctx.stroke();

                    // Draw labels for the measurements
                    const fontSize = 12 * invScale;
                    const labelFontSize = fontSize * 0.83;

                    // Calculate label positions and check for overlap
                    const leftLabelX = (glyphLeftX + firstWorldX) / 2;
                    const rightLabelX = (lastWorldX + glyphRightX) / 2;

                    // Estimate label width (conservative estimate)
                    const estimatedLabelWidth =
                        leftDistance.toFixed(1).length * labelFontSize * 0.6 +
                        16 * invScale;

                    // Check if left label would overlap with previous right label
                    const leftLabelStart = leftLabelX - estimatedLabelWidth / 2;
                    const leftLabelPlaceBelow =
                        previousRightLabelEnd !== null &&
                        leftLabelStart < previousRightLabelEnd;

                    // Left label
                    this.drawMeasurementLabel(
                        leftLabelX,
                        mouseGlyphY,
                        leftDistance,
                        'horizontal',
                        leftLabelPlaceBelow
                    );

                    // Right label (always above)
                    this.drawMeasurementLabel(
                        rightLabelX,
                        mouseGlyphY,
                        rightDistance,
                        'horizontal',
                        false
                    );

                    // Update previous right label end position for next iteration
                    const rightLabelWidth =
                        rightDistance.toFixed(1).length * labelFontSize * 0.6 +
                        16 * invScale;
                    previousRightLabelEnd = rightLabelX + rightLabelWidth / 2;

                    this.ctx.restore();
                }

                xPosition += xAdvance;
            }
        );
    }

    /**
     * Render stack preview mode showing component nesting layers
     */
    drawStackPreview(): void {
        console.log('[StackPreview] Rendering stack preview');

        const layerTree = this.glyphCanvas.stackPreviewAnimator.layerTree;
        if (layerTree.length === 0) return;

        // Get glyph position in text run (same as normal rendering)
        if (
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
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
        const baseX = xPosition + xOffset;
        const baseY = yOffset;

        const tiltRadians =
            this.glyphCanvas.stackPreviewAnimator.getTiltAngleRadians();

        // Render layers from bottom to top (deepest nesting first)
        // This ensures proper visual stacking
        const sortedLayers = [...layerTree].sort((a, b) => b.depth - a.depth);

        sortedLayers.forEach((node, index) => {
            this.ctx.save();

            // Calculate opacity fade based on depth
            const alpha = Math.max(0.3, 1 - node.depth * 0.15);
            this.ctx.globalAlpha = alpha;

            // Translate to base glyph position
            this.ctx.translate(baseX, baseY);

            // Apply accumulated transform for this component instance
            this.ctx.transform(
                node.transform[0],
                node.transform[1],
                node.transform[2],
                node.transform[3],
                node.transform[4],
                node.transform[5]
            );

            // Apply vertical offset for this layer
            this.ctx.translate(0, node.yOffset);

            // Apply tilt transform (skew leftward)
            // Matrix: [1, 0, tan(angle), 1, 0, 0] for horizontal skew
            // Negative tan for leftward tilt
            this.ctx.transform(1, 0, -Math.tan(tiltRadians), 1, 0, 0);

            // Draw this component instance
            this.drawComponentInstance(node);

            this.ctx.restore();
        });
    }

    /**
     * Draw a single component instance in stack preview mode
     * Renders the component's layer data without applying transforms again
     */
    drawComponentInstance(node: any): void {
        const layerData = node.componentLayerData;
        if (!layerData || !layerData.shapes) return;

        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';

        // Draw filled background for paths
        this.ctx.save();
        this.ctx.beginPath();

        layerData.shapes.forEach((shape: any) => {
            if ('Component' in shape) return;

            let nodes = 'nodes' in shape ? shape.nodes : undefined;
            if (!nodes && 'Path' in shape && shape.Path.nodes) {
                nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            }

            if (nodes && nodes.length > 0) {
                this.buildPathFromNodes(nodes);
                this.ctx.closePath();
            }
        });

        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 0.015)'
            : 'rgba(0, 0, 0, 0.015)';
        this.ctx.fill();
        this.ctx.restore();

        // Draw paths (outlines only)
        layerData.shapes.forEach((shape: any, index: number) => {
            if ('Component' in shape) return;
            this.drawShape(shape, index, false);
        });

        // Draw blue boxes for nested components
        // The component's CONTENT is in separate layer tree nodes, but we show the blue box here
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        layerData.shapes.forEach((shape: any) => {
            if (!('Component' in shape)) return;

            const component = shape.Component;
            if (!component.layerData || !component.layerData.shapes) return;

            // Apply component's transform to position the blue box
            const transform = component.transform || [1, 0, 0, 1, 0, 0];
            const [a, b, c, d, tx, ty] = transform;

            this.ctx.save();
            this.ctx.transform(a, b, c, d, tx, ty);

            // Draw flattened component outlines (blue box)
            this.drawComponentWithOutlines(
                component.layerData.shapes,
                false,
                false,
                false,
                invScale,
                isDarkTheme
            );

            // Draw component origin marker
            if (
                APP_SETTINGS.OUTLINE_EDITOR.SHOW_COMPONENT_ORIGIN_MARKERS &&
                this.viewportManager.scale >=
                    APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES
            ) {
                const markerSize =
                    APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_MARKER_SIZE *
                    invScale;

                this.ctx.strokeStyle = colors.COMPONENT_NORMAL;
                this.ctx.lineWidth = 2 * invScale;
                this.ctx.beginPath();
                this.ctx.moveTo(-markerSize, 0);
                this.ctx.lineTo(markerSize, 0);
                this.ctx.moveTo(0, -markerSize);
                this.ctx.lineTo(0, markerSize);
                this.ctx.stroke();

                this.ctx.beginPath();
                this.ctx.arc(0, 0, markerSize, 0, Math.PI * 2);
                this.ctx.stroke();
            }

            this.ctx.restore();
        });
    }

    /**
     * Render layer shapes (paths and components)
     * Extracted from main render loop for reuse in stack preview
     */
    private renderLayerShapes(
        layerData: any,
        invScale: number,
        isDarkTheme: boolean,
        enableInteraction: boolean
    ): void {
        // Draw filled background
        this.ctx.save();
        this.ctx.beginPath();

        layerData.shapes.forEach((shape: any) => {
            if ('Component' in shape) return;

            let nodes = 'nodes' in shape ? shape.nodes : undefined;
            if (!nodes && 'Path' in shape && shape.Path.nodes) {
                nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            }

            if (nodes && nodes.length > 0) {
                this.buildPathFromNodes(nodes);
                this.ctx.closePath();
            }
        });

        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 0.015)'
            : 'rgba(0, 0, 0, 0.015)';
        this.ctx.fill();
        this.ctx.restore();

        // Draw paths
        layerData.shapes.forEach((shape: any, index: number) =>
            this.drawShape(shape, index, false)
        );

        // Draw components
        layerData.shapes.forEach((shape: any, index: number) => {
            if (!('Component' in shape)) return;

            const component = shape.Component;
            if (!component.layerData || !component.layerData.shapes) return;

            // Get selection/hover state (only if interaction is enabled)
            const isHovered =
                enableInteraction &&
                this.glyphCanvas.outlineEditor.hoveredComponentIndex === index;
            const isSelected =
                enableInteraction &&
                this.glyphCanvas.outlineEditor.selectedComponents.includes(
                    index
                );

            // Get component transform
            const transform = component.transform || [1, 0, 0, 1, 0, 0];
            const [a, b, c, d, tx, ty] = transform;

            this.ctx.save();
            this.ctx.transform(a, b, c, d, tx, ty);

            // Draw component outlines
            this.drawComponentWithOutlines(
                component.layerData.shapes,
                isSelected,
                isHovered,
                false,
                invScale,
                isDarkTheme
            );

            // Draw component marker
            if (
                APP_SETTINGS.OUTLINE_EDITOR.SHOW_COMPONENT_ORIGIN_MARKERS &&
                this.viewportManager.scale >=
                    APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES
            ) {
                const colors = isDarkTheme
                    ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                    : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                const markerSize =
                    APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_MARKER_SIZE *
                    invScale;
                const markerStrokeColor = isSelected
                    ? colors.COMPONENT_SELECTED
                    : isHovered
                      ? adjustColorHueAndLightness(
                            colors.COMPONENT_NORMAL,
                            0,
                            -20
                        )
                      : colors.COMPONENT_NORMAL;

                this.ctx.strokeStyle = markerStrokeColor;
                this.ctx.lineWidth = 2 * invScale;
                this.ctx.beginPath();
                this.ctx.moveTo(-markerSize, 0);
                this.ctx.lineTo(markerSize, 0);
                this.ctx.moveTo(0, -markerSize);
                this.ctx.lineTo(0, markerSize);
                this.ctx.stroke();

                this.ctx.beginPath();
                this.ctx.arc(0, 0, markerSize, 0, Math.PI * 2);
                this.ctx.stroke();
            }

            this.ctx.restore();
        });
    }

    /**
     * Draw component with flattened outline shapes (blue filled boxes)
     * Reusable method for both normal editing mode and stack preview
     */
    private drawComponentWithOutlines(
        shapes: any[],
        isSelected: boolean,
        isHovered: boolean,
        isInterpolated: boolean,
        invScale: number,
        isDarkTheme: boolean
    ): void {
        // Collect all outline shapes (non-component shapes with nodes) at each nesting level
        const collectOutlineShapes = (
            shapes: any[],
            transform: number[] | null = null
        ): Array<{ nodes: any[]; transform: number[] | null }> => {
            const outlineShapes: Array<{
                nodes: any[];
                transform: number[] | null;
            }> = [];

            shapes.forEach((componentShape) => {
                if ('Component' in componentShape) {
                    let nestedTransform = transform;
                    if (
                        componentShape.Component.transform &&
                        Array.isArray(componentShape.Component.transform)
                    ) {
                        const t = componentShape.Component.transform;
                        if (transform) {
                            const [a1, b1, c1, d1, tx1, ty1] = transform;
                            const [a2, b2, c2, d2, tx2, ty2] = [
                                t[0] || 1,
                                t[1] || 0,
                                t[2] || 0,
                                t[3] || 1,
                                t[4] || 0,
                                t[5] || 0
                            ];
                            nestedTransform = [
                                a1 * a2 + b1 * c2,
                                a1 * b2 + b1 * d2,
                                c1 * a2 + d1 * c2,
                                c1 * b2 + d1 * d2,
                                a1 * tx2 + c1 * ty2 + tx1,
                                b1 * tx2 + d1 * ty2 + ty1
                            ];
                        } else {
                            nestedTransform = [
                                t[0] || 1,
                                t[1] || 0,
                                t[2] || 0,
                                t[3] || 1,
                                t[4] || 0,
                                t[5] || 0
                            ];
                        }
                    }

                    if (
                        componentShape.Component.layerData &&
                        componentShape.Component.layerData.shapes
                    ) {
                        outlineShapes.push(
                            ...collectOutlineShapes(
                                componentShape.Component.layerData.shapes,
                                nestedTransform
                            )
                        );
                    }
                } else if (
                    componentShape.nodes &&
                    componentShape.nodes.length > 0
                ) {
                    outlineShapes.push({
                        nodes: componentShape.nodes,
                        transform: transform
                    });
                }
            });

            return outlineShapes;
        };

        const outlineShapes = collectOutlineShapes(shapes);

        if (outlineShapes.length === 0) return;

        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        const baseStrokeColor = isSelected
            ? colors.COMPONENT_SELECTED
            : colors.COMPONENT_NORMAL;
        let strokeColor = isHovered
            ? adjustColorHueAndLightness(baseStrokeColor, 0, 50)
            : baseStrokeColor;

        const baseFillColor = isSelected
            ? colors.COMPONENT_FILL_SELECTED
            : colors.COMPONENT_FILL_NORMAL;
        let fillColor = isHovered
            ? adjustColorHueAndLightness(baseFillColor, 0, 50)
            : baseFillColor;

        if (isInterpolated) {
            strokeColor = desaturateColor(strokeColor);
            fillColor = desaturateColor(fillColor);
        }

        // Glow
        if (isDarkTheme) {
            const { glowColor, glowStrokeWidth, glowBlur } =
                this.calculateGlowParams(strokeColor, invScale, 1.0);

            this.ctx.save();
            this.ctx.shadowBlur = glowBlur;
            this.ctx.shadowColor = glowColor;
            this.ctx.shadowOffsetX = 0;
            this.ctx.shadowOffsetY = 0;
            this.ctx.strokeStyle = glowColor;
            this.ctx.lineWidth = glowStrokeWidth;

            this.ctx.beginPath();
            outlineShapes.forEach(({ nodes, transform }) => {
                if (transform) {
                    this.ctx.save();
                    this.ctx.transform(
                        transform[0],
                        transform[1],
                        transform[2],
                        transform[3],
                        transform[4],
                        transform[5]
                    );
                }
                this.buildPathFromNodes(nodes);
                this.ctx.closePath();
                if (transform) this.ctx.restore();
            });
            this.ctx.stroke();
            this.ctx.restore();
        }

        // Fill
        this.ctx.shadowBlur = 0;
        this.ctx.shadowColor = 'transparent';
        this.ctx.beginPath();
        outlineShapes.forEach(({ nodes, transform }) => {
            if (transform) {
                this.ctx.save();
                this.ctx.transform(
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                );
            }
            this.buildPathFromNodes(nodes);
            this.ctx.closePath();
            if (transform) this.ctx.restore();
        });
        this.ctx.fillStyle = fillColor;
        this.ctx.fill();

        // Stroke
        this.ctx.beginPath();
        outlineShapes.forEach(({ nodes, transform }) => {
            if (transform) {
                this.ctx.save();
                this.ctx.transform(
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                );
            }
            this.buildPathFromNodes(nodes);
            this.ctx.closePath();
            if (transform) this.ctx.restore();
        });
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = 1 * invScale;
        this.ctx.stroke();
    }
}
