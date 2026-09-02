import { desaturateColor, mixColors, toRgba } from '../design';
import APP_SETTINGS, {
    interpolateOutlineChromeScreenSize,
    outlineChromeStateScale
} from '../settings';
import { Layer, DecomposedAffineTransform } from '../babelfont-model';
import { pathHasSubtractionFlag } from '../path-boolean-flag';
import { fillPunchFillContoursOnContext } from '../punch-fill-contours';
import { Logger } from '../logger';
import { getPathFillOpacity } from '../path-fill-opacity-pref';
import { get_glyph_name } from '../../wasm-dist/babelfont_fontc_web';
import {
    normalizeAffineTransform,
    transformPointWithAffine as applyAffineToPoint,
    multiplyAffineTransforms,
    createIdentityAffine
} from '../glyph-path-geometry';

const console = new Logger('Renderer');

import type { ViewportManager } from './viewport';
import type { TextRunEditor } from './textrun';
import { GlyphCanvas } from '../glyph-canvas';
import {
    buildAnimatedGlyphDrawOps,
    isActiveEditGlyphDrawOp,
    lerp,
    shapedRunHorizontalExtents,
    type FeatureChangeDrawState
} from './feature-change-animator';
import {
    formatAdditionalMetricFamiliesLabel,
    getAdditionalDrawableMetricLineEntries,
    getCoreDrawableMetricLineEntries,
    getCoreVerticalMetricValues,
    getMetricOvershootBands,
    getVisibleVerticalMetricValues,
    type MetricLineEntry,
    type MetricLineFamily
} from './vertical-metrics';
import { isShowAllMetricsEnabled } from '../show-all-metrics-pref';
import type { Babelfont } from '../babelfont';

const DUPLICATE_NODE_WARNING_COLOR = '#ff3b30';

/**
 * Extract nodes array from a Shape union type with proper type checking
 */
function getNodesFromShape(
    shape: Babelfont.Shape
): Babelfont.Node[] | undefined {
    // Handle unwrapped Path type
    if (
        'nodes' in shape &&
        Array.isArray(shape.nodes) &&
        shape.nodes.length > 0
    ) {
        return shape.nodes;
    }
    return undefined;
}

function getNodesFromOutlineShape(shape: any): Babelfont.Node[] | undefined {
    if (!shape) {
        return undefined;
    }

    if (Array.isArray(shape.nodes) && shape.nodes.length > 0) {
        return shape.nodes;
    }

    if (shape.Path?.nodes && Array.isArray(shape.Path.nodes)) {
        return shape.Path.nodes;
    }

    if (shape.Contour?.nodes && Array.isArray(shape.Contour.nodes)) {
        return shape.Contour.nodes;
    }

    return undefined;
}

function getNodePositionKey(x: number, y: number): string {
    return `${x},${y}`;
}

function collectDuplicateNodePositionKeys(
    shapes: Babelfont.Shape[] | undefined
): Set<string> {
    const counts = new Map<string, number>();

    if (!Array.isArray(shapes)) {
        return new Set();
    }

    for (const shape of shapes) {
        if ('reference' in shape) {
            continue;
        }

        const nodes = getNodesFromShape(shape);
        if (!nodes?.length) {
            continue;
        }

        for (const node of nodes) {
            const key = getNodePositionKey(node.x, node.y);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    return new Set(
        [...counts.entries()]
            .filter(([, count]) => count > 1)
            .map(([key]) => key)
    );
}

type ComponentAlignmentLayerSnapshot = {
    shapes?: Array<{
        reference?: string;
        format_specific?: Record<string, number | undefined>;
    }>;
};

function isAutomaticallyAlignedComponentLayer(
    layerData: ComponentAlignmentLayerSnapshot | null | undefined
): boolean {
    const shapes = layerData?.shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) {
        return false;
    }

    return shapes.every(
        (shape) =>
            typeof shape.reference === 'string' &&
            shape.format_specific?.['com.schriftgestalt.Glyphs.alignment'] === 1
    );
}

function getClosedFromOutlineShape(shape: any): boolean {
    if (!shape || typeof shape !== 'object') {
        return false;
    }

    if ('closed' in shape) {
        return Boolean(shape.closed);
    }

    if (
        shape.Path &&
        typeof shape.Path === 'object' &&
        'closed' in shape.Path
    ) {
        return Boolean(shape.Path.closed);
    }

    if (
        shape.Contour &&
        typeof shape.Contour === 'object' &&
        'closed' in shape.Contour
    ) {
        return Boolean(shape.Contour.closed);
    }

    return false;
}

function getOutlineShapeFormatSpecific(
    shape: any
): Record<string, unknown> | undefined {
    if (!shape || typeof shape !== 'object') {
        return undefined;
    }
    if (shape.format_specific && typeof shape.format_specific === 'object') {
        return shape.format_specific;
    }
    if (
        shape.Path?.format_specific &&
        typeof shape.Path.format_specific === 'object'
    ) {
        return shape.Path.format_specific;
    }
    return undefined;
}

function outlineShapeIsSubtraction(shape: any): boolean {
    return pathHasSubtractionFlag(
        getOutlineShapeFormatSpecific(shape) as
            Record<string, ReturnType<typeof JSON.parse>> | undefined
    );
}

function outlineShapeIsComponent(shape: any): boolean {
    if (!shape || typeof shape !== 'object') {
        return false;
    }
    if ('Component' in shape) {
        return true;
    }
    return typeof shape.reference === 'string' && !Array.isArray(shape.nodes);
}

/**
 * Calculate bounding box from SVG path data
 * Parses M, L, C, Q, Z commands and resolves curve extrema.
 */
function calculatePathBounds(pathData: string): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    const bounds = Layer.calculateSvgPathBounds(pathData);
    if (!bounds) {
        return null;
    }

    return {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY
    };
}

function parseRgbaColor(color: string): {
    r: number;
    g: number;
    b: number;
    a: number;
} | null {
    const rgba = toRgba(color);
    const match = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);

    if (!match) {
        return null;
    }

    return {
        r: Number.parseInt(match[1], 10),
        g: Number.parseInt(match[2], 10),
        b: Number.parseInt(match[3], 10),
        a: Number.parseFloat(match[4])
    };
}

function withColorAlpha(color: string, alpha: number): string {
    const parsed = parseRgbaColor(color);
    if (!parsed) {
        return color;
    }
    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
}

function adjustGlyphRestingColor(color: string, deltaPercent: number): string {
    const rgba = parseRgbaColor(color);
    if (!rgba) {
        return color;
    }

    const ratio = Math.min(1, Math.max(0, Math.abs(deltaPercent) / 100));
    const isLighten = deltaPercent > 0;

    const adjustChannel = (value: number): number => {
        if (isLighten) {
            return Math.round(value + (255 - value) * ratio);
        }
        return Math.round(value * (1 - ratio));
    };

    let r = adjustChannel(rgba.r);
    let g = adjustChannel(rgba.g);
    let b = adjustChannel(rgba.b);
    let a = rgba.a;

    const isSaturatedWhite = rgba.r === 255 && rgba.g === 255 && rgba.b === 255;
    const isSaturatedBlack = rgba.r === 0 && rgba.g === 0 && rgba.b === 0;

    // If channels are saturated and cannot move further, adjust alpha to keep change visible.
    if ((isLighten && isSaturatedWhite) || (!isLighten && isSaturatedBlack)) {
        a = Math.min(1, rgba.a + (1 - rgba.a) * ratio);
        r = rgba.r;
        g = rgba.g;
        b = rgba.b;
    }

    return `rgba(${r}, ${g}, ${b}, ${a})`;
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
    private punchOutScratch: HTMLCanvasElement | null = null;

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
            // Inactive background (same as editor sidebar)
            this.ctx.fillStyle = computedStyle
                .getPropertyValue('--background-editor-sidebar')
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

        // Apply rotation if stack preview mode is active
        if (this.glyphCanvas.stackPreviewAnimator.shouldRenderStackPreview()) {
            // Apply 30° slant to the left (horizontal skew)
            const slantAngle = this.getStackPreviewSlantAngleRadians();
            this.ctx.transform(1, 0, Math.tan(slantAngle), 1, 0, 0);
        }

        const editOverlayFade =
            this.getFeatureChangeOutlineFadeAlpha() *
            this.glyphCanvas.previewChromeOpacity;

        // Check if stack preview mode is active
        if (this.glyphCanvas.stackPreviewAnimator.shouldRenderStackPreview()) {
            // In stack preview mode, render other glyphs normally but replace selected glyph with stack preview
            this.drawSelection();
            this.drawShapedGlyphsWithStackPreview();
            if (editOverlayFade > 0) {
                this.ctx.save();
                this.ctx.globalAlpha *= editOverlayFade;
                this.drawBackgroundEditingTint();
                this.drawEditingMetricsUnderlay();
                this.drawCanvasPluginsBelow();
                this.drawCanvasPluginsAbove();
                this.ctx.restore();
            }
        } else {
            // Normal rendering
            this.drawSelection();

            // Draw shaped glyphs
            this.drawShapedGlyphs();
            this.drawTextModeKerningOverlay();

            if (editOverlayFade > 0) {
                this.ctx.save();
                this.ctx.globalAlpha *= editOverlayFade;
                this.drawBackgroundEditingTint();
                this.drawEditingMetricsUnderlay();
                this.drawCanvasPluginsBelow();
                this.drawOutlineEditor();
                this.drawSnapVisualization();
                this.drawCanvasPluginsAbove();
                this.ctx.restore();
            }
        }

        if (editOverlayFade > 0) {
            this.ctx.save();
            this.ctx.globalAlpha *= editOverlayFade;
            this.drawMeasurementIntersections();
            this.drawGlyphTooltip();
            this.drawStackPreviewHoverLabel();
            this.ctx.restore();
        }

        // Draw text mode measurement tool
        this.drawTextModeMeasurements();

        // Draw cursor
        this.drawCursor();

        this.ctx.restore();

        // Draw UI overlay (zoom level, etc.)
        this.drawUIOverlay();
    }

    private getStackPreviewEasedProgress(): number {
        const animationProgress = this.getStackPreviewAnimationProgress();
        return 1 - Math.pow(1 - animationProgress, 3);
    }

    private getStackPreviewAnimationProgress(): number {
        const animator = this.glyphCanvas.stackPreviewAnimator;
        let animationProgress;
        if (animator.isAnimating) {
            const elapsed = performance.now() - animator.animationStartTime;
            const rawProgress = Math.min(
                elapsed / animator.config.animationDuration,
                1.0
            );
            animationProgress = animator.isReversing
                ? 1 - rawProgress
                : rawProgress;
        } else {
            animationProgress = animator.isActive ? 1 : 0;
        }
        return animationProgress;
    }

    private getStackPreviewSlantAngleRadians(): number {
        return -30 * (Math.PI / 180) * this.getStackPreviewEasedProgress();
    }

    private getSelectedGlyphBasePosition(): {
        baseX: number;
        baseY: number;
    } | null {
        if (
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
            return null;
        }

        const pos = this.textRunEditor._getGlyphPosition(
            this.textRunEditor.selectedGlyphIndex
        );
        return {
            baseX: pos.xPosition + (pos.xOffset || 0),
            baseY: pos.yOffset
        };
    }

    private transformPointWithAffine(
        x: number,
        y: number,
        transform: number[]
    ): { x: number; y: number } {
        return applyAffineToPoint(transform, x, y);
    }

    private getLayerLocalBounds(
        layerData: Babelfont.Layer,
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): { minX: number; minY: number; maxX: number; maxY: number } | null {
        const bounds = Layer.calculateShapeBounds(
            layerData?.shapes,
            parentTransform
        );
        if (!bounds) {
            return null;
        }

        return {
            minX: bounds.minX,
            minY: bounds.minY,
            maxX: bounds.maxX,
            maxY: bounds.maxY
        };
    }

    private isPointInLayerShapes(
        layerData: Babelfont.Layer,
        mouseX: number,
        mouseY: number,
        invScale: number
    ): boolean {
        if (!layerData?.shapes) {
            return false;
        }

        for (const shape of layerData.shapes) {
            if ('reference' in shape) {
                const nestedLayerData = (shape as any).layerData;
                if (!nestedLayerData?.shapes) {
                    continue;
                }

                const transformRaw =
                    (shape as any).transform ||
                    DecomposedAffineTransform.identity();
                const transform = normalizeAffineTransform(transformRaw);

                this.ctx.save();
                this.ctx.transform(
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                );
                const hit = this.isPointInLayerShapes(
                    nestedLayerData,
                    mouseX,
                    mouseY,
                    invScale
                );
                this.ctx.restore();

                if (hit) {
                    return true;
                }
                continue;
            }

            const nodes =
                getNodesFromShape(shape) || getNodesFromOutlineShape(shape);
            if (!nodes || nodes.length === 0) {
                continue;
            }

            const closed = getClosedFromOutlineShape(shape);

            this.ctx.beginPath();
            this.buildPathFromNodes(nodes, closed);
            if (closed) {
                this.ctx.closePath();
            }
            this.ctx.lineWidth =
                APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE /
                this.viewportManager.scale;

            if (
                (closed && this.ctx.isPointInPath(mouseX, mouseY)) ||
                this.ctx.isPointInStroke(mouseX, mouseY)
            ) {
                return true;
            }
        }

        return false;
    }

    hitTestStackPreviewLayer(mouseX: number, mouseY: number): number | null {
        const animator = this.glyphCanvas.stackPreviewAnimator;
        if (
            !animator.shouldRenderStackPreview() ||
            animator.layerTree.length === 0
        ) {
            return null;
        }

        const basePosition = this.getSelectedGlyphBasePosition();
        if (!basePosition) {
            return null;
        }

        const easedProgress = this.getStackPreviewEasedProgress();
        const diagonalAngleRad =
            (animator.config.diagonalOffsetAngle * Math.PI) / 180;
        const invScale = 1 / this.viewportManager.scale;
        const viewportTransform = this.viewportManager.getTransformMatrix();

        let bestLayerTreeIndex: number | null = null;
        let bestDistance = Infinity;

        for (let i = 0; i < animator.layerTree.length; i++) {
            const node = animator.layerTree[i];

            this.ctx.save();
            this.ctx.setTransform(
                viewportTransform.a,
                viewportTransform.b,
                viewportTransform.c,
                viewportTransform.d,
                viewportTransform.e,
                viewportTransform.f
            );

            const slantAngle = this.getStackPreviewSlantAngleRadians();
            this.ctx.transform(1, 0, Math.tan(slantAngle), 1, 0, 0);

            this.ctx.translate(basePosition.baseX, basePosition.baseY);
            this.ctx.transform(
                node.transform[0],
                node.transform[1],
                node.transform[2],
                node.transform[3],
                node.transform[4],
                node.transform[5]
            );

            const offsetDistance =
                node.depth * animator.config.verticalSpacing * easedProgress;
            this.ctx.translate(
                offsetDistance * Math.cos(diagonalAngleRad),
                offsetDistance * Math.sin(diagonalAngleRad)
            );

            const hit = this.isPointInLayerShapes(
                node.componentLayerData,
                mouseX,
                mouseY,
                invScale
            );

            if (hit) {
                const currentTransform = this.ctx.getTransform();
                const originScreenX = currentTransform.e;
                const originScreenY = currentTransform.f;
                const dx = mouseX - originScreenX;
                const dy = mouseY - originScreenY;
                const distance = Math.hypot(dx, dy);

                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestLayerTreeIndex = i;
                }
            }

            this.ctx.restore();
        }

        return bestLayerTreeIndex;
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

    private getFeatureChangeOutlineFadeAlpha(): number {
        return (
            this.glyphCanvas.featureChangeAnimator?.getOutlineEditorFadeAlpha() ??
            1
        );
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

        // Clear glyph bounds for hit testing
        this.glyphCanvas.glyphBounds = [];

        // Use black on white or white on black based on theme
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
        const featureChangeDraw =
            this.glyphCanvas.featureChangeAnimator?.getDrawState() ?? null;
        const previewFillAlpha = this.glyphCanvas.getPreviewFillAlpha();

        this.textRunEditor.shapedGlyphs.forEach(
            (glyph: any, glyphIndex: number) => {
                const glyphId = glyph.g;
                const xAdvance = glyph.ax || 0;
                const explicitGlyphName = glyph.explicitGlyphName;
                const pos = this.textRunEditor._getGlyphPosition(glyphIndex);
                const x = pos.xPosition + (glyph.dx || 0);
                const y = pos.yOffset;

                const glyphData = this.textRunEditor.hbFont
                    ? this.textRunEditor.hbFont.glyphToPath(glyphId)
                    : null;
                const explicitOutline = explicitGlyphName
                    ? this.textRunEditor.getCachedExplicitGlyphOutline(
                          explicitGlyphName
                      )
                    : null;
                const useExplicitOutline =
                    !!explicitOutline && !!explicitGlyphName && glyphId === 0;

                // Get bounds for hit testing
                const pathBounds = glyphData
                    ? calculatePathBounds(glyphData)
                    : useExplicitOutline && explicitOutline?.bounds
                      ? {
                            minX: explicitOutline.bounds.xMin,
                            minY: explicitOutline.bounds.yMin,
                            maxX: explicitOutline.bounds.xMax,
                            maxY: explicitOutline.bounds.yMax
                        }
                      : null;
                const isVisuallyEmpty =
                    this.glyphCanvas.isShapedGlyphVisuallyEmpty(glyphIndex);
                const metricsBand = isVisuallyEmpty
                    ? this.glyphCanvas.getTextModeVerticalMetricsBand()
                    : null;

                // Store bounds for hit testing and tooltip positioning
                this.glyphCanvas.glyphBounds.push({
                    x: x,
                    y: y,
                    width: xAdvance,
                    height: isVisuallyEmpty
                        ? (metricsBand?.highest ?? 1000) -
                          (metricsBand?.lowest ?? 0)
                        : 1000, // Font units height approximation for hit testing
                    // Visual bounds from actual glyph path; empty glyphs use the
                    // metrics band so labels/hit targets don't depend on ink.
                    x1: pathBounds ? pathBounds.minX : 0,
                    y1: pathBounds
                        ? pathBounds.minY
                        : isVisuallyEmpty
                          ? (metricsBand?.lowest ?? 0)
                          : 0,
                    x2: pathBounds ? pathBounds.maxX : xAdvance,
                    y2: pathBounds
                        ? pathBounds.maxY
                        : isVisuallyEmpty
                          ? (metricsBand?.highest ?? 1000)
                          : 1000,
                    isEmpty: isVisuallyEmpty
                });

                if (featureChangeDraw) {
                    return;
                }

                // Set color based on hover, selection state, and edit mode
                const isHovered =
                    glyphIndex ===
                    this.glyphCanvas.outlineEditor.hoveredGlyphIndex;
                const isSelected =
                    glyphIndex === this.textRunEditor.selectedGlyphIndex;
                const isExplicitToken = !!explicitGlyphName;

                // Selected glyph: compiled fill only while Space preview is
                // on. Leaving preview uses the outline editor instead so
                // component fills and path strokes do not sit on top of a
                // second HarfBuzz fill.
                const skipHarfBuzz =
                    isSelected &&
                    this.glyphCanvas.outlineEditor.active &&
                    !this.glyphCanvas.outlineEditor.isPreviewMode;

                if (!skipHarfBuzz) {
                    // Check if this is .notdef (GID 0) with no explicit fallback.
                    const isNotdef = glyphId === 0 && !useExplicitOutline;
                    let fillColor: string;
                    let inEditingMode = false;
                    let inTextMode = false;

                    // Set color based on mode and state
                    if (
                        this.glyphCanvas.outlineEditor.active &&
                        (this.glyphCanvas.outlineEditor.isPreviewMode ||
                            previewFillAlpha > 0)
                    ) {
                        fillColor = isNotdef
                            ? colors.GLYPH_NOTDEF
                            : colors.GLYPH_NORMAL;
                    } else if (this.glyphCanvas.outlineEditor.active) {
                        inEditingMode = true;
                        // Glyph edit mode (not preview): active glyph in solid color, others dimmed
                        if (isSelected) {
                            fillColor = colors.GLYPH_ACTIVE_IN_EDITOR;
                        } else if (isHovered) {
                            // Hovered inactive glyph - darker than normal inactive
                            fillColor = colors.GLYPH_HOVERED_IN_EDITOR;
                        } else {
                            // Dim other glyphs
                            fillColor = colors.GLYPH_INACTIVE_IN_EDITOR;
                        }
                    } else {
                        inTextMode = true;
                        // Text edit mode: normal coloring
                        // Don't show hover effects in preview mode
                        if (
                            isHovered &&
                            !this.glyphCanvas.outlineEditor.isPreviewMode
                        ) {
                            fillColor = colors.GLYPH_HOVERED;
                        } else if (isSelected) {
                            fillColor = colors.GLYPH_SELECTED;
                        } else {
                            // Use faded color for .notdef glyphs
                            fillColor = isNotdef
                                ? colors.GLYPH_NOTDEF
                                : colors.GLYPH_NORMAL;
                        }
                    }

                    // Resting means not hovered. Apply only to Unicode glyphs.
                    if (isExplicitToken) {
                        if (inTextMode) {
                            fillColor = adjustGlyphRestingColor(
                                fillColor,
                                isDarkTheme ? -40 : 40
                            );
                        } else if (inEditingMode) {
                            fillColor = adjustGlyphRestingColor(
                                fillColor,
                                isDarkTheme ? -40 : 40
                            );
                        }
                    }

                    const previewColor = isNotdef
                        ? colors.GLYPH_NOTDEF
                        : colors.GLYPH_NORMAL;
                    let restColor = isHovered
                        ? colors.GLYPH_HOVERED_IN_EDITOR
                        : colors.GLYPH_INACTIVE_IN_EDITOR;
                    if (isExplicitToken) {
                        restColor = adjustGlyphRestingColor(
                            restColor,
                            isDarkTheme ? -40 : 40
                        );
                    }

                    const paintFill = (color: string, alpha: number): void => {
                        if (alpha <= 0) {
                            return;
                        }
                        this.ctx.save();
                        this.ctx.globalAlpha *= alpha;
                        this.ctx.fillStyle = color;
                        if (useExplicitOutline && explicitOutline?.shapes) {
                            this.drawCachedExplicitGlyphOutline(
                                explicitOutline,
                                x,
                                y
                            );
                        } else if (glyphData && !isVisuallyEmpty) {
                            this.ctx.save();
                            this.ctx.translate(x, y);
                            this.ctx.fill(new Path2D(glyphData));
                            this.ctx.restore();
                        }
                        this.ctx.restore();
                    };

                    const blending =
                        previewFillAlpha > 0 && previewFillAlpha < 1;
                    if (
                        this.glyphCanvas.outlineEditor.active &&
                        !isSelected &&
                        blending &&
                        !this.glyphCanvas.outlineEditor.isPreviewMode
                    ) {
                        paintFill(previewColor, previewFillAlpha);
                        paintFill(
                            restColor,
                            this.glyphCanvas.previewChromeOpacity
                        );
                    } else {
                        const fillAlpha =
                            this.glyphCanvas.outlineEditor.active &&
                            isSelected &&
                            blending
                                ? previewFillAlpha
                                : 1;
                        paintFill(fillColor, fillAlpha);
                    }
                }
            }
        );

        if (featureChangeDraw) {
            this.drawAnimatedFeatureChangeGlyphs(featureChangeDraw, colors);
        }
    }

    private drawAnimatedFeatureChangeGlyphs(
        drawState: FeatureChangeDrawState,
        colors: any
    ): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const inEditMode =
            this.glyphCanvas.outlineEditor.active &&
            !this.glyphCanvas.outlineEditor.isPreviewMode;
        const ops = buildAnimatedGlyphDrawOps(
            drawState.from,
            drawState.to,
            drawState.u,
            drawState.alphaOld,
            drawState.alphaNew
        );
        for (const op of ops) {
            if (op.alpha <= 0) {
                continue;
            }
            const glyphIndex = op.toGlyphIndex ?? op.fromGlyphIndex ?? -1;
            const isHovered =
                glyphIndex === this.glyphCanvas.outlineEditor.hoveredGlyphIndex;
            const isSelected =
                op.toGlyphIndex === this.textRunEditor.selectedGlyphIndex;
            const skipHarfBuzz =
                inEditMode &&
                isActiveEditGlyphDrawOp(
                    op,
                    drawState.fromSelectedIndex,
                    drawState.toSelectedIndex
                );
            if (skipHarfBuzz) {
                continue;
            }

            const glyphId = op.glyph.g;
            const explicitGlyphName = op.glyph.explicitGlyphName;
            const glyphData = this.textRunEditor.hbFont
                ? this.textRunEditor.hbFont.glyphToPath(glyphId)
                : null;
            const explicitOutline = explicitGlyphName
                ? this.textRunEditor.getCachedExplicitGlyphOutline(
                      explicitGlyphName
                  )
                : null;
            const useExplicitOutline =
                !!explicitOutline && !!explicitGlyphName && glyphId === 0;
            const isNotdef = glyphId === 0 && !useExplicitOutline;
            let fillColor: string;
            let inEditingMode = false;
            let inTextMode = false;

            if (
                this.glyphCanvas.outlineEditor.active &&
                !this.glyphCanvas.outlineEditor.isPreviewMode
            ) {
                inEditingMode = true;
                if (isSelected) {
                    fillColor = colors.GLYPH_ACTIVE_IN_EDITOR;
                } else if (isHovered) {
                    fillColor = colors.GLYPH_HOVERED_IN_EDITOR;
                } else {
                    fillColor = colors.GLYPH_INACTIVE_IN_EDITOR;
                }
            } else if (
                this.glyphCanvas.outlineEditor.active &&
                this.glyphCanvas.outlineEditor.isPreviewMode
            ) {
                fillColor = isNotdef
                    ? colors.GLYPH_NOTDEF
                    : colors.GLYPH_NORMAL;
            } else {
                inTextMode = true;
                if (
                    isHovered &&
                    !this.glyphCanvas.outlineEditor.isPreviewMode
                ) {
                    fillColor = colors.GLYPH_HOVERED;
                } else if (isSelected) {
                    fillColor = colors.GLYPH_SELECTED;
                } else {
                    fillColor = isNotdef
                        ? colors.GLYPH_NOTDEF
                        : colors.GLYPH_NORMAL;
                }
            }

            if (!!explicitGlyphName && (inTextMode || inEditingMode)) {
                fillColor = adjustGlyphRestingColor(
                    fillColor,
                    isDarkTheme ? -40 : 40
                );
            }

            this.ctx.save();
            this.ctx.globalAlpha = op.alpha;
            this.ctx.fillStyle = fillColor;
            if (useExplicitOutline && explicitOutline?.shapes) {
                this.drawCachedExplicitGlyphOutline(
                    explicitOutline,
                    op.x,
                    op.y
                );
            } else if (glyphData) {
                this.ctx.translate(op.x, op.y);
                this.ctx.fill(new Path2D(glyphData));
            }
            this.ctx.restore();
        }
    }

    private getLiveSelectedLayerWidth(): number | null {
        const overlayWidth =
            this.glyphCanvas.outlineEditor.getLiveSidebearingOverlayWidth();
        if (overlayWidth !== null) {
            return overlayWidth;
        }
        if (
            this.glyphCanvas.outlineEditor.active &&
            this.glyphCanvas.outlineEditor.layerData &&
            Number.isFinite(this.glyphCanvas.outlineEditor.layerData.width)
        ) {
            return this.glyphCanvas.outlineEditor.layerData.width;
        }
        return null;
    }

    private getTextRunHorizontalExtents(): {
        minX: number;
        maxX: number;
    } | null {
        const liveSelectedLayerWidth = this.getLiveSelectedLayerWidth();
        const toExtents = shapedRunHorizontalExtents(
            this.textRunEditor.shapedGlyphs,
            this.textRunEditor.selectedGlyphIndex,
            liveSelectedLayerWidth
        );
        const drawState =
            this.glyphCanvas.featureChangeAnimator?.getDrawState() ?? null;
        if (!drawState || !toExtents) {
            return toExtents;
        }

        const fromExtents = shapedRunHorizontalExtents(
            drawState.from.glyphs,
            drawState.fromSelectedIndex,
            liveSelectedLayerWidth
        );
        if (!fromExtents) {
            return toExtents;
        }

        return {
            minX: lerp(fromExtents.minX, toExtents.minX, drawState.u),
            maxX: lerp(fromExtents.maxX, toExtents.maxX, drawState.u)
        };
    }

    private getAnimatedActiveGlyphOriginX(): number | null {
        const animatedOriginX =
            this.glyphCanvas.featureChangeAnimator?.getSelectedGlyphOriginX();
        if (animatedOriginX !== null && animatedOriginX !== undefined) {
            return animatedOriginX;
        }
        const selectedGlyphIndex = this.textRunEditor.selectedGlyphIndex;
        if (
            selectedGlyphIndex < 0 ||
            selectedGlyphIndex >= this.textRunEditor.shapedGlyphs.length
        ) {
            return null;
        }
        const glyphPosition =
            this.textRunEditor._getGlyphPosition(selectedGlyphIndex);
        return glyphPosition.xPosition + glyphPosition.xOffset;
    }

    private getActiveLineBaselineY(): number {
        return this.textRunEditor.getActiveBaselineY();
    }

    private drawBackgroundEditingTint(): void {
        const outlineEditor = this.glyphCanvas.outlineEditor;
        if (
            !outlineEditor.active ||
            !outlineEditor.isEditingBackgroundLayer()
        ) {
            return;
        }

        const metricValues = getVisibleVerticalMetricValues(
            outlineEditor.renderVerticalMetrics
        );
        const selectedGlyphIndex = this.textRunEditor.selectedGlyphIndex;
        if (
            metricValues.length === 0 ||
            selectedGlyphIndex < 0 ||
            selectedGlyphIndex >= this.textRunEditor.shapedGlyphs.length
        ) {
            return;
        }

        const widthOriginX = this.getAnimatedActiveGlyphOriginX();
        if (widthOriginX === null) {
            return;
        }
        const pairedLayer = outlineEditor.getPairedLayerModel();
        const width = pairedLayer?.width ?? outlineEditor.layerData?.width;
        if (typeof width !== 'number' || !Number.isFinite(width)) {
            return;
        }

        const topY = Math.max(...metricValues) + this.getActiveLineBaselineY();
        const bottomY =
            Math.min(...metricValues) + this.getActiveLineBaselineY();
        const accentYellow = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-yellow')
            .trim();

        this.ctx.save();
        this.ctx.fillStyle = accentYellow;
        this.ctx.globalAlpha *= 0.1;
        this.ctx.fillRect(widthOriginX, bottomY, width, topY - bottomY);
        this.ctx.restore();
    }

    private drawEditingMetricsUnderlay(): void {
        if (!this.glyphCanvas.outlineEditor.active) {
            return;
        }

        const lineExtents = this.getTextRunHorizontalExtents();
        if (!lineExtents) {
            return;
        }

        const verticalMetrics =
            this.glyphCanvas.outlineEditor.renderVerticalMetrics;
        if (!verticalMetrics) {
            return;
        }

        const baselineY = this.getActiveLineBaselineY();
        const uniqueMetricValues =
            getVisibleVerticalMetricValues(verticalMetrics);
        const coreMetricValues = getCoreVerticalMetricValues(verticalMetrics);
        const showAllMetrics = isShowAllMetricsEnabled();
        const coreEntries = getCoreDrawableMetricLineEntries(
            verticalMetrics
        ).map((entry) => ({ ...entry, y: entry.y + baselineY }));
        const additionalEntries = showAllMetrics
            ? getAdditionalDrawableMetricLineEntries(verticalMetrics).map(
                  (entry) => ({ ...entry, y: entry.y + baselineY })
              )
            : [];
        const additionalStrokeEntries = additionalEntries.filter(
            (entry) =>
                !coreMetricValues.some(
                    (coreValue) =>
                        Math.abs(coreValue - (entry.y - baselineY)) < 0.25
                )
        );
        const additionalMetricValues = additionalStrokeEntries
            .map((entry) => entry.y)
            .filter(
                (metricValue, index, values) =>
                    values.findIndex(
                        (candidate) => Math.abs(candidate - metricValue) < 0.25
                    ) === index
            );

        if (uniqueMetricValues.length === 0 && coreMetricValues.length === 0) {
            return;
        }

        const extentValues =
            uniqueMetricValues.length > 0
                ? uniqueMetricValues
                : coreMetricValues;
        const topY = Math.max(...extentValues) + baselineY;
        const bottomY = Math.min(...extentValues) + baselineY;

        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        const baseMetricColor = desaturateColor(colors.GLYPH_ACTIVE_IN_EDITOR);
        const parsedBaseColor = parseRgbaColor(toRgba(baseMetricColor));
        const underlayColor = parsedBaseColor
            ? `rgba(${parsedBaseColor.r}, ${parsedBaseColor.g}, ${parsedBaseColor.b}, 0.16)`
            : baseMetricColor;
        const baselineColor = parsedBaseColor
            ? `rgba(${parsedBaseColor.r}, ${parsedBaseColor.g}, ${parsedBaseColor.b}, 0.22)`
            : baseMetricColor;
        const additionalUnderlayColor = parsedBaseColor
            ? `rgba(${parsedBaseColor.r}, ${parsedBaseColor.g}, ${parsedBaseColor.b}, 0.08)`
            : underlayColor;
        const additionalLabelColor = parsedBaseColor
            ? `rgba(${parsedBaseColor.r}, ${parsedBaseColor.g}, ${parsedBaseColor.b}, 0.4)`
            : additionalUnderlayColor;
        const overshootFillColor = parsedBaseColor
            ? `rgba(${parsedBaseColor.r}, ${parsedBaseColor.g}, ${parsedBaseColor.b}, 0.05)`
            : underlayColor;

        this.ctx.save();
        this.ctx.lineWidth = 1 / this.viewportManager.scale;

        const overshootBands = getMetricOvershootBands(
            verticalMetrics,
            showAllMetrics
        );
        if (overshootBands.length > 0) {
            this.ctx.fillStyle = overshootFillColor;
            const bandWidth = lineExtents.maxX - lineExtents.minX;
            for (const band of overshootBands) {
                const yMin = Math.min(band.y, band.y + band.overshoot);
                const height = Math.abs(band.overshoot);
                if (height < 1e-8) {
                    continue;
                }
                this.ctx.fillRect(
                    lineExtents.minX,
                    yMin + baselineY,
                    bandWidth,
                    height
                );
            }
        }

        for (const metricValue of coreMetricValues) {
            const isBaseline = Math.abs(metricValue) < 1e-8;
            this.ctx.strokeStyle = isBaseline ? baselineColor : underlayColor;
            this.ctx.beginPath();
            this.ctx.moveTo(lineExtents.minX, metricValue + baselineY);
            this.ctx.lineTo(lineExtents.maxX, metricValue + baselineY);
            this.ctx.stroke();
        }

        if (additionalMetricValues.length > 0) {
            this.ctx.strokeStyle = additionalUnderlayColor;
            for (const metricValue of additionalMetricValues) {
                this.ctx.beginPath();
                this.ctx.moveTo(lineExtents.minX, metricValue);
                this.ctx.lineTo(lineExtents.maxX, metricValue);
                this.ctx.stroke();
            }
        }

        this.drawMetricLineLabels(
            [...coreEntries, ...additionalEntries],
            lineExtents.minX,
            additionalLabelColor
        );

        const selectedGlyphIndex = this.textRunEditor.selectedGlyphIndex;
        if (
            selectedGlyphIndex >= 0 &&
            selectedGlyphIndex < this.textRunEditor.shapedGlyphs.length
        ) {
            const selectedLayerData = this.glyphCanvas.outlineEditor.layerData;
            const selectedGlyph =
                this.textRunEditor.shapedGlyphs[selectedGlyphIndex];
            const animatedOriginX = this.getAnimatedActiveGlyphOriginX();
            if (animatedOriginX === null) {
                this.ctx.restore();
                return;
            }

            const pairedLayer =
                this.glyphCanvas.outlineEditor.isEditingBackgroundLayer()
                    ? this.glyphCanvas.outlineEditor.getPairedLayerModel()
                    : null;
            const overlayWidth =
                this.glyphCanvas.outlineEditor.getLiveSidebearingOverlayWidth();
            const layerWidth =
                overlayWidth ?? pairedLayer?.width ?? selectedLayerData?.width;
            const activeGlyphAdvance =
                typeof layerWidth === 'number' && Number.isFinite(layerWidth)
                    ? layerWidth
                    : Number(selectedGlyph.ax) || 0;

            const activeGlyphStartX = animatedOriginX;
            const activeGlyphEndX = activeGlyphStartX + activeGlyphAdvance;

            this.ctx.strokeStyle = underlayColor;

            this.ctx.beginPath();
            this.ctx.moveTo(activeGlyphStartX, bottomY);
            this.ctx.lineTo(activeGlyphStartX, topY);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.moveTo(activeGlyphEndX, bottomY);
            this.ctx.lineTo(activeGlyphEndX, topY);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    /**
     * Label metric lines with short family names (ascender, xheight, typo, …).
     * Nearby labels merge ("ascender+hhea+typo") until zoom gives each space.
     * Labels sit left of the line start, or pin to the left viewport edge when
     * that start is off-screen or the concatenated text would clip.
     */
    private drawMetricLineLabels(
        entries: MetricLineEntry[],
        lineStartX: number,
        labelColor: string
    ): void {
        if (entries.length === 0) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;
        const fontSize = 11 * invScale;
        const labelGapFont = fontSize * 1.15;
        const edgeMarginPx = 8;
        const lineGapFont = 6 * invScale;

        // Collapse exact/near-coincident Ys, collecting families per line.
        type LineGroup = {
            y: number;
            families: Set<MetricLineFamily>;
        };
        const lineGroups: LineGroup[] = [];
        const sortedEntries = [...entries].sort(
            (left, right) => right.y - left.y
        );
        for (const entry of sortedEntries) {
            const existing = lineGroups.find(
                (group) => Math.abs(group.y - entry.y) < 0.25
            );
            if (existing) {
                existing.families.add(entry.family);
                existing.y =
                    (existing.y * (existing.families.size - 1) + entry.y) /
                    existing.families.size;
            } else {
                lineGroups.push({
                    y: entry.y,
                    families: new Set([entry.family])
                });
            }
        }

        // Merge labels that would vertically collide at the current zoom.
        type LabelCluster = {
            y: number;
            families: Set<MetricLineFamily>;
            count: number;
        };
        const clusters: LabelCluster[] = [];
        for (const group of lineGroups) {
            const colliding = clusters.find(
                (cluster) => Math.abs(cluster.y - group.y) < labelGapFont
            );
            if (colliding) {
                for (const family of group.families) {
                    colliding.families.add(family);
                }
                colliding.y =
                    (colliding.y * colliding.count + group.y) /
                    (colliding.count + 1);
                colliding.count += 1;
            } else {
                clusters.push({
                    y: group.y,
                    families: new Set(group.families),
                    count: 1
                });
            }
        }

        const contentFrame = this.glyphCanvas.getCanvasContentFrame();
        const pinScreenX = contentFrame.left + edgeMarginPx;
        const lineStartScreen = this.viewportManager.fontToScreenCoordinates(
            lineStartX,
            0
        );
        const lineStartVisible = lineStartScreen.x >= pinScreenX;
        const viewportLeftFontX = this.viewportManager.getFontSpaceCoordinates(
            pinScreenX,
            0
        ).x;

        this.ctx.save();
        this.ctx.font = `${fontSize}px 'Inter UI', sans-serif`;
        this.ctx.fillStyle = labelColor;
        this.ctx.textBaseline = 'middle';

        for (const cluster of clusters) {
            const text = formatAdditionalMetricFamiliesLabel(cluster.families);
            if (!text) {
                continue;
            }

            const textWidth = this.ctx.measureText(text).width;
            const rightAlignedLeft = lineStartX - lineGapFont - textWidth;
            const pinToViewportLeft =
                !lineStartVisible || rightAlignedLeft < viewportLeftFontX;

            this.ctx.save();
            if (!pinToViewportLeft) {
                this.ctx.translate(lineStartX, cluster.y);
                this.ctx.scale(1, -1);
                this.ctx.textAlign = 'right';
                this.ctx.fillText(text, -lineGapFont, 0);
            } else {
                this.ctx.translate(viewportLeftFontX, cluster.y);
                this.ctx.scale(1, -1);
                this.ctx.textAlign = 'left';
                this.ctx.fillText(text, 0, 0);
            }
            this.ctx.restore();
        }

        this.ctx.restore();
    }

    private drawTextModeKerningOverlay(): void {
        if (this.glyphCanvas.outlineEditor.active) {
            return;
        }
        if (this.glyphCanvas.outlineEditor.isPreviewMode) {
            return;
        }
        if (this.glyphCanvas.featureChangeAnimator?.isActive()) {
            return;
        }

        const markerOverlays =
            this.glyphCanvas.getTextModeKerningOverlayStates();
        const activeOverlay = this.glyphCanvas.getTextModeKerningOverlayState();
        if (markerOverlays.length === 0 && !activeOverlay) {
            return;
        }

        const computedStyle = getComputedStyle(document.documentElement);
        const positiveColor = computedStyle
            .getPropertyValue('--accent-green')
            .trim();
        const negativeColor = computedStyle
            .getPropertyValue('--accent-red')
            .trim();
        const markerHeight = 20;

        this.ctx.save();
        for (const overlay of markerOverlays) {
            if (overlay.maxX <= overlay.minX) {
                continue;
            }

            this.ctx.fillStyle =
                overlay.value > 0 ? positiveColor : negativeColor;
            this.ctx.fillRect(
                overlay.minX,
                overlay.bottomY,
                overlay.maxX - overlay.minX,
                markerHeight
            );
        }

        if (activeOverlay && activeOverlay.maxX > activeOverlay.minX) {
            this.ctx.globalAlpha = 0.22;
            this.ctx.fillStyle =
                activeOverlay.value > 0 ? positiveColor : negativeColor;
            this.ctx.fillRect(
                activeOverlay.minX,
                activeOverlay.bottomY,
                activeOverlay.maxX - activeOverlay.minX,
                activeOverlay.topY - activeOverlay.bottomY
            );
        }
        this.ctx.restore();
    }

    drawCachedExplicitGlyphOutline(outlineData: any, x: number, y: number) {
        if (!outlineData?.shapes || !Array.isArray(outlineData.shapes)) {
            return;
        }

        this.ctx.save();
        this.ctx.translate(x, y);

        this.ctx.beginPath();
        for (const shape of outlineData.shapes) {
            const nodes = getNodesFromOutlineShape(shape);
            if (!nodes || nodes.length === 0) {
                continue;
            }
            const closed = getClosedFromOutlineShape(shape);
            if (!closed) {
                continue;
            }

            this.buildPathFromNodes(nodes, closed);
            this.ctx.closePath();
        }

        this.ctx.fill();
        this.ctx.restore();
    }

    /**
     * Unified method to draw a hover label/tooltip with consistent styling.
     * Used for both glyph tooltips in text mode and component labels in edit mode.
     *
     * @param text - The label text to display
     * @param x - X position (center of the label) in font coordinates
     * @param y - Y position (top of the label box) in font coordinates
     * @param invScale - Inverse of current zoom scale for consistent sizing
     * @param offsetX - Optional X offset when canvas has been translated (e.g., inside drawOutlineEditor)
     * @param offsetY - Optional Y offset when canvas has been translated
     */
    drawHoverLabel(
        text: string,
        x: number,
        y: number,
        invScale: number,
        offsetX: number = 0,
        offsetY: number = 0
    ): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        // Font size and metrics (scaled to remain constant regardless of zoom)
        const fontSize = 16 * invScale;
        this.ctx.font = `${fontSize}px 'Inter UI', sans-serif`;
        const metrics = this.ctx.measureText(text);
        const padding = 10 * invScale;
        const bgWidth = metrics.width + padding * 2;
        const bgHeight = fontSize * 1.8;

        // Calculate label bounds in font coordinates (before any adjustments)
        // The label is centered horizontally around x, and starts at y (top edge)
        const labelMinX = x - bgWidth / 2;
        const labelMaxX = x + bgWidth / 2;
        const labelMinY = y - bgHeight; // In flipped Y, label extends downward from y
        const labelMaxY = y;

        // Convert label corners to screen coordinates to check viewport bounds
        const scale = this.viewportManager.scale;
        const panX = this.viewportManager.panX;
        const panY = this.viewportManager.panY;

        // Screen coordinates (Y is flipped in font space)
        // Account for canvas translation offset when called from inside drawOutlineEditor
        const screenMinX = (labelMinX + offsetX) * scale + panX;
        const screenMaxX = (labelMaxX + offsetX) * scale + panX;
        const screenMinY = -(labelMaxY + offsetY) * scale + panY; // Top edge in screen space
        const screenMaxY = -(labelMinY + offsetY) * scale + panY; // Bottom edge in screen space

        // Canvas dimensions
        const contentFrame = this.glyphCanvas.getCanvasContentFrame();
        const canvasLeft = contentFrame.left;
        const canvasTop = contentFrame.top;
        const canvasWidth = contentFrame.width;
        const canvasHeight = contentFrame.height;

        // Use 1/3 of panToGlyph margin for tighter label constraint
        const margin = APP_SETTINGS.OUTLINE_EDITOR.CANVAS_MARGIN / 3;

        // Calculate adjustments needed to keep label within viewport
        let adjustX = 0;
        let adjustY = 0;

        // Check horizontal bounds
        if (screenMinX < canvasLeft + margin) {
            adjustX = (canvasLeft + margin - screenMinX) / scale; // Move right
        } else if (screenMaxX > canvasLeft + canvasWidth - margin) {
            adjustX = (canvasLeft + canvasWidth - margin - screenMaxX) / scale; // Move left
        }

        // Check vertical bounds (remember screen Y is flipped)
        if (screenMinY < canvasTop + margin) {
            adjustY = -(canvasTop + margin - screenMinY) / scale; // Move down in font space
        } else if (screenMaxY > canvasTop + canvasHeight - margin) {
            adjustY = -(canvasTop + canvasHeight - margin - screenMaxY) / scale; // Move up in font space
        }

        // Apply adjustments to position
        const adjustedX = x + adjustX;
        const adjustedY = y + adjustY;

        // Save context to flip text right-side up
        this.ctx.save();
        this.ctx.translate(adjustedX, adjustedY);
        this.ctx.scale(1, -1); // Flip Y to make text right-side up

        // Center horizontally around origin
        const bgX = -bgWidth / 2;
        const bgY = 0; // Top of box at origin

        // Draw background with rounded corners
        const radius = 4 * invScale;
        this.ctx.fillStyle = colors.HOVER_LABEL_BG;
        this.ctx.beginPath();
        this.pathRoundedRect(bgX, bgY, bgWidth, bgHeight, radius);
        this.ctx.fill();

        // Draw border
        this.ctx.strokeStyle = colors.HOVER_LABEL_BORDER;
        this.ctx.lineWidth = 1 * invScale;
        this.ctx.beginPath();
        this.pathRoundedRect(bgX, bgY, bgWidth, bgHeight, radius);
        this.ctx.stroke();

        // Draw text with explicit baseline for consistent rendering
        this.ctx.fillStyle = colors.HOVER_LABEL_TEXT;
        this.ctx.textBaseline = 'top';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(text, bgX + padding, bgY + padding - 3 * invScale);

        this.ctx.restore();
    }

    private pathRoundedRect(
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number
    ): void {
        if (typeof this.ctx.roundRect === 'function') {
            this.ctx.roundRect(x, y, width, height, radius);
            return;
        }
        this.ctx.rect(x, y, width, height);
    }

    private sameGuideHandle(
        left: { scope: 'master' | 'layer'; index: number } | null,
        right: { scope: 'master' | 'layer'; index: number } | null
    ): boolean {
        if (!left || !right) {
            return left === right;
        }

        return left.scope === right.scope && left.index === right.index;
    }

    private getGuideColor(scope: 'master' | 'layer'): string {
        return scope === 'master'
            ? 'rgba(220, 64, 64, 0.95)'
            : 'rgba(64, 128, 235, 0.95)';
    }

    private drawGuideLabel(
        text: string,
        x: number,
        y: number,
        invScale: number,
        isDarkTheme: boolean
    ): void {
        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.scale(1, -1);

        const fontSize = 11 * invScale;
        const padding = 2 * invScale;
        const offsetX = 8 * invScale;
        const offsetY = 8 * invScale;

        this.ctx.font = `${fontSize}px 'Inter UI', sans-serif`;
        const metrics = this.ctx.measureText(text);
        const bgX = offsetX - padding;
        const bgY = -offsetY - fontSize - padding + 1 * invScale;
        const bgWidth = metrics.width + padding * 2;
        const bgHeight = fontSize + padding * 2;

        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(0, 0, 0, 0.75)'
            : 'rgba(255, 255, 255, 0.8)';
        this.ctx.fillRect(bgX, bgY, bgWidth, bgHeight);

        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 1.0)'
            : 'rgba(0, 0, 0, 1.0)';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(text, offsetX, -offsetY - fontSize + 1 * invScale);
        this.ctx.restore();
    }

    private getNodeChromeFontRadius(invScale: number): number {
        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        return (
            interpolateOutlineChromeScreenSize(
                this.viewportManager.scale,
                settings.NODE_SIZE_AT_MIN_ZOOM,
                settings.NODE_SIZE_AT_MID_ZOOM,
                settings.NODE_SIZE_AT_MAX_ZOOM
            ) * invScale
        );
    }

    private getAnchorChromeFontRadius(
        invScale: number,
        coincidentWithNode: boolean,
        isDiamond: boolean
    ): number {
        const nodeRadius = this.getNodeChromeFontRadius(invScale);
        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        if (coincidentWithNode) {
            return nodeRadius * settings.ANCHOR_SIZE_RATIO;
        }
        return isDiamond
            ? nodeRadius * settings.NODE_DIAMOND_SIZE_RATIO
            : nodeRadius;
    }

    private addOutlineChromePath(
        kind: 'circle' | 'square' | 'diamond',
        radius: number
    ): void {
        if (kind === 'circle') {
            this.ctx.moveTo(radius, 0);
            this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
        } else if (kind === 'diamond') {
            this.ctx.moveTo(0, radius);
            this.ctx.lineTo(radius, 0);
            this.ctx.lineTo(0, -radius);
            this.ctx.lineTo(-radius, 0);
            this.ctx.closePath();
        } else {
            this.ctx.rect(-radius, -radius, radius * 2, radius * 2);
        }
    }

    private pathOutlineChrome(
        kind: 'circle' | 'square' | 'diamond',
        radius: number
    ): void {
        this.ctx.beginPath();
        this.addOutlineChromePath(kind, radius);
    }

    private paintOutlineChrome(
        kind: 'circle' | 'square' | 'diamond',
        radius: number,
        strokeColor: string,
        fillColor: string | null,
        strokeWidth: number,
        fillComposite: GlobalCompositeOperation | null = null
    ): void {
        this.pathOutlineChrome(kind, radius);
        if (fillColor) {
            this.ctx.save();
            if (fillComposite) {
                this.ctx.globalCompositeOperation = fillComposite;
            }
            this.ctx.fillStyle = fillColor;
            this.ctx.fill();
            this.ctx.restore();
        }
        this.ctx.lineJoin = 'miter';
        this.ctx.lineWidth = strokeWidth;
        this.ctx.strokeStyle = strokeColor;
        this.ctx.stroke();
    }

    private getZoneHaloWidth(
        objectRadius: number,
        kind: 'circle' | 'square' | 'diamond'
    ): number {
        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        const width = objectRadius * settings.NODE_ZONE_HALO_SIZE_RATIO;
        return kind === 'diamond'
            ? width * settings.NODE_DIAMOND_SIZE_RATIO
            : width;
    }

    private paintZoneHalo(
        kind: 'circle' | 'square' | 'diamond',
        radius: number,
        chromeStrokeWidth: number,
        haloColor: string,
        haloOpacity: number,
        haloStrokeWidth: number
    ): void {
        const innerRadius = radius + chromeStrokeWidth / 2;
        const outerRadius = innerRadius + haloStrokeWidth;
        this.ctx.save();
        this.ctx.globalAlpha = haloOpacity;
        this.ctx.fillStyle = haloColor;
        this.ctx.beginPath();
        this.addOutlineChromePath(kind, outerRadius);
        this.addOutlineChromePath(kind, innerRadius);
        this.ctx.fill('evenodd');
        this.ctx.restore();
    }

    /**
     * LSB/RSB handle accents match property-panel kerning-side colors
     * (second = orange/left, first = blue/right).
     */
    private getSidebearingAccentColors(): { left: string; right: string } {
        const computed = getComputedStyle(document.documentElement);
        const left = computed
            .getPropertyValue('--kerning-accent-second')
            .trim();
        const right = computed
            .getPropertyValue('--kerning-accent-first')
            .trim();
        const fallback =
            document.documentElement.getAttribute('data-theme') === 'light'
                ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT.SIDEBEARING_SELECTED
                : APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK.SIDEBEARING_SELECTED;
        return {
            left: left || fallback,
            right: right || fallback
        };
    }

    private getCurrentLayerAdvanceWidth(): number {
        const overlayWidth =
            this.glyphCanvas.outlineEditor.getLiveSidebearingOverlayWidth();
        if (typeof overlayWidth === 'number' && Number.isFinite(overlayWidth)) {
            return overlayWidth;
        }
        const layerWidth =
            this.glyphCanvas.outlineEditor.getCurrentLayerDataFromStack()
                ?.width;
        return typeof layerWidth === 'number' && Number.isFinite(layerWidth)
            ? layerWidth
            : 0;
    }

    private isOnVerticalMetricLine(x: number, y: number): boolean {
        const tolerance =
            APP_SETTINGS.OUTLINE_EDITOR.NODE_ON_DELIMITER_TOLERANCE;
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        const world = applyAffineToPoint(transform, x, y);
        if (Math.abs(world.y) <= tolerance) {
            return true;
        }

        const metricYs = getVisibleVerticalMetricValues(
            this.glyphCanvas.outlineEditor.renderVerticalMetrics
        );
        for (const metricY of metricYs) {
            if (Math.abs(world.y - metricY) <= tolerance) {
                return true;
            }
        }
        return false;
    }

    private isOnCurveDiamondNode(x: number, y: number): boolean {
        const tolerance =
            APP_SETTINGS.OUTLINE_EDITOR.NODE_ON_DELIMITER_TOLERANCE;
        if (Math.abs(x) <= tolerance) {
            return true;
        }
        const width = this.getCurrentLayerAdvanceWidth();
        if (Math.abs(x - width) <= tolerance) {
            return true;
        }
        if (this.isOnVerticalMetricLine(x, y)) {
            return true;
        }

        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        const world = applyAffineToPoint(transform, x, y);
        for (const guide of this.glyphCanvas.outlineEditor.getVisibleGuides()) {
            const angleRad = (guide.rootAngle * Math.PI) / 180;
            const dirX = Math.cos(angleRad);
            const dirY = Math.sin(angleRad);
            const distance = Math.abs(
                (world.x - guide.rootX) * dirY - (world.y - guide.rootY) * dirX
            );
            if (distance <= tolerance) {
                return true;
            }
        }
        return false;
    }

    private shouldPaintZoneHalo(x: number, y: number): boolean {
        return (
            this.isOnCurveDiamondNode(x, y) || this.isNodeInOvershootArea(x, y)
        );
    }

    private isNodeInOvershootArea(x: number, y: number): boolean {
        const bands = getMetricOvershootBands(
            this.glyphCanvas.outlineEditor.renderVerticalMetrics,
            true
        );
        if (bands.length === 0) {
            return false;
        }

        const tolerance =
            APP_SETTINGS.OUTLINE_EDITOR.NODE_ON_DELIMITER_TOLERANCE;
        const transform =
            this.glyphCanvas.outlineEditor.getAccumulatedTransform();
        const world = applyAffineToPoint(transform, x, y);

        for (const band of bands) {
            const metricY = band.y;
            const overshootY = band.y + band.overshoot;
            const yMin = Math.min(metricY, overshootY);
            const yMax = Math.max(metricY, overshootY);
            if (yMax - yMin < 1e-8) {
                continue;
            }
            if (world.y >= yMin - tolerance && world.y <= yMax + tolerance) {
                return true;
            }
        }
        return false;
    }

    private strokeTrimmedHandleLine(
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        fromRadius: number,
        toRadius: number
    ): void {
        const dx = toX - fromX;
        const dy = toY - fromY;
        const distance = Math.hypot(dx, dy);
        if (distance <= fromRadius + toRadius || distance === 0) {
            return;
        }
        const ux = dx / distance;
        const uy = dy / distance;
        this.ctx.beginPath();
        this.ctx.moveTo(fromX + ux * fromRadius, fromY + uy * fromRadius);
        this.ctx.lineTo(toX - ux * toRadius, toY - uy * toRadius);
        this.ctx.stroke();
    }

    private drawOutlineGuides(
        guides: Array<{
            scope: 'master' | 'layer';
            index: number;
            guide: Babelfont.Guide;
            rootX: number;
            rootY: number;
            rootAngle: number;
        }>,
        invScale: number,
        isDarkTheme: boolean,
        phase: 'lines' | 'handles' = 'lines'
    ): void {
        if (guides.length === 0) {
            return;
        }

        const minZoomForHandles =
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
        if (this.viewportManager.scale < minZoomForHandles) {
            return;
        }

        const viewportExtent =
            (Math.max(this.canvas.width, this.canvas.height) /
                window.devicePixelRatio /
                this.viewportManager.scale) *
            2;
        const baseHandleRadius = this.getNodeChromeFontRadius(invScale);

        if (phase !== 'handles') {
            this.withContentFrameClip(() => {
                for (const guideEntry of guides) {
                    const angleRad = (guideEntry.rootAngle * Math.PI) / 180;
                    const dirX = Math.cos(angleRad);
                    const dirY = Math.sin(angleRad);
                    const color = this.getGuideColor(guideEntry.scope);

                    this.ctx.save();
                    this.ctx.strokeStyle = color;
                    this.ctx.lineWidth = 1 * invScale;
                    this.ctx.beginPath();
                    this.ctx.moveTo(
                        guideEntry.rootX - dirX * viewportExtent,
                        guideEntry.rootY - dirY * viewportExtent
                    );
                    this.ctx.lineTo(
                        guideEntry.rootX + dirX * viewportExtent,
                        guideEntry.rootY + dirY * viewportExtent
                    );
                    this.ctx.stroke();
                    this.ctx.restore();
                }
            });
        }

        if (phase === 'lines') {
            return;
        }

        const hoveredGuideHandle =
            this.glyphCanvas.outlineEditor.hoveredGuideHandle;
        const selectedGuideHandle =
            this.glyphCanvas.outlineEditor.selectedGuideHandle;

        this.withContentFrameClip(() => {
            for (const guideEntry of guides) {
                const isHovered = this.sameGuideHandle(
                    guideEntry,
                    hoveredGuideHandle
                );
                const isSelected = this.sameGuideHandle(
                    guideEntry,
                    selectedGuideHandle
                );
                const color = this.getGuideColor(guideEntry.scope);
                const handleRadius =
                    baseHandleRadius *
                    outlineChromeStateScale(isSelected, isHovered);

                this.ctx.save();
                this.ctx.translate(guideEntry.rootX, guideEntry.rootY);
                this.ctx.beginPath();
                this.ctx.arc(0, 0, handleRadius, 0, Math.PI * 2);
                this.ctx.fillStyle = color;
                this.ctx.fill();
                this.ctx.lineWidth = 1 * invScale;
                this.ctx.strokeStyle = isDarkTheme
                    ? 'rgba(0, 0, 0, 0.9)'
                    : 'rgba(255, 255, 255, 0.95)';
                this.ctx.stroke();
                this.ctx.restore();

                if (guideEntry.guide.name) {
                    this.drawGuideLabel(
                        guideEntry.guide.name,
                        guideEntry.rootX,
                        guideEntry.rootY,
                        invScale,
                        isDarkTheme
                    );
                }
            }
        });
    }

    /**
     * Clip drawing to the camera box above the overlay property panel.
     * The clip is applied in device pixels so it stays correct after the
     * glyph-origin translate used by outline drawing.
     */
    private withContentFrameClip(draw: () => void): void {
        const frame = this.glyphCanvas.getCanvasContentFrame?.();
        const canvas = this.canvas;
        if (!frame || frame.width <= 0 || frame.height <= 0 || !canvas) {
            draw();
            return;
        }

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            draw();
            return;
        }

        const currentTransform = this.ctx.getTransform();
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.beginPath();
        this.ctx.rect(
            (frame.left / rect.width) * canvas.width,
            (frame.top / rect.height) * canvas.height,
            (frame.width / rect.width) * canvas.width,
            (frame.height / rect.height) * canvas.height
        );
        this.ctx.clip();
        this.ctx.setTransform(currentTransform);
        draw();
        this.ctx.restore();
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

            const hoveredIndex =
                this.glyphCanvas.outlineEditor.hoveredGlyphIndex;
            const glyphId = this.textRunEditor.shapedGlyphs[hoveredIndex].g;

            // Get actual glyph name from the shaped glyph ID (after OpenType feature substitutions)
            // This ensures we show the correct glyph name (e.g., "a.ss04" instead of "a")
            let glyphName: string;
            if (this.textRunEditor.fontBlob) {
                try {
                    glyphName = get_glyph_name(
                        this.textRunEditor.fontBlob,
                        glyphId
                    );
                } catch (e) {
                    console.warn(
                        `Failed to get glyph name for GID ${glyphId}:`,
                        e
                    );
                    glyphName = `GID ${glyphId}`;
                }
            } else {
                glyphName = `GID ${glyphId}`;
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
            const glyphOriginY =
                glyphBounds?.y ??
                this.textRunEditor._getGlyphPosition(hoveredIndex).yOffset;
            const isEmptyGlyph = !!glyphBounds?.isEmpty;

            // Use visual bounding box for positioning. Empty glyphs have no ink,
            // so center on the advance width and place the label under baseline.
            const visualMinX = isEmptyGlyph ? 0 : glyphBounds?.x1 || 0;
            const visualMaxX = isEmptyGlyph
                ? glyphWidth
                : glyphBounds?.x2 || glyphWidth;
            const visualMinY = isEmptyGlyph ? 0 : glyphBounds?.y1 || 0;

            // Position tooltip centered under the glyph's visual bounding box
            // In font coordinates: Y increases upward, so negative Y is below baseline
            const tooltipX =
                (glyphBounds?.x ?? 0) + (visualMinX + visualMaxX) / 2;
            const tooltipY = glyphOriginY + visualMinY - 100; // 100 units below bottom of visual bounding box / baseline

            const invScale = 1 / this.viewportManager.scale;
            this.drawHoverLabel(glyphName, tooltipX, tooltipY, invScale);
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
        const bounds = Layer.calculateShapeBounds(shapes);
        if (!bounds) {
            return {
                minX: Infinity,
                minY: Infinity,
                maxX: -Infinity,
                maxY: -Infinity,
                hasPoints: false
            };
        }

        return {
            minX: bounds.minX,
            minY: bounds.minY,
            maxX: bounds.maxX,
            maxY: bounds.maxY,
            hasPoints: true
        };
    }

    private getPathFillColor(isDarkTheme: boolean): string {
        const alpha = getPathFillOpacity();
        return isDarkTheme
            ? `rgba(255, 255, 255, ${alpha})`
            : `rgba(0, 0, 0, ${alpha})`;
    }

    private getSubtractionStrokeColor(): string {
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-magenta')
            .trim();
        return withColorAlpha(accent, 0.85);
    }

    private getSubtractionFillColor(): string {
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-magenta')
            .trim();
        return withColorAlpha(accent, getPathFillOpacity());
    }

    private subtractionOutlineDash(invScale: number): number[] {
        const [dash, gap] =
            APP_SETTINGS.OUTLINE_EDITOR.SUBTRACTION_OUTLINE_DASH;
        return [dash * invScale, gap * invScale];
    }

    private getComponentPunchFillStyle(
        shapeIndex: number,
        isAutomatic: boolean
    ): string {
        const isInterpolated =
            this.glyphCanvas.outlineEditor.isPaintingInterpolatedPreview();
        const isHovered =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.hoveredComponentIndex === shapeIndex;
        const isSelected =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.selectedComponents.includes(
                shapeIndex
            );
        const fills = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS;
        let fillColor = isAutomatic
            ? isSelected
                ? fills.AUTO_SELECTED
                : isHovered
                  ? fills.AUTO_HOVERED
                  : fills.AUTO_NORMAL
            : isSelected
              ? fills.MANUAL_SELECTED
              : isHovered
                ? fills.MANUAL_HOVERED
                : fills.MANUAL_NORMAL;
        fillColor = toRgba(fillColor);
        if (isInterpolated) {
            fillColor = desaturateColor(fillColor);
        }
        return fillColor;
    }

    private transformOutlineNodes(
        nodes: Babelfont.Node[],
        affine: number[]
    ): Babelfont.Node[] {
        const isIdentity =
            affine[0] === 1 &&
            affine[1] === 0 &&
            affine[2] === 0 &&
            affine[3] === 1 &&
            affine[4] === 0 &&
            affine[5] === 0;
        if (isIdentity) {
            return nodes;
        }
        return nodes.map((node) => {
            const point = applyAffineToPoint(affine, node.x, node.y);
            return { ...node, x: point.x, y: point.y };
        });
    }

    private collectPunchFillContours(
        shapes: unknown[] | undefined,
        affine: number[],
        fillStyle: string,
        componentFillForIndex?: (shapeIndex: number) => string
    ): Array<{
        nodes: Babelfont.Node[];
        subtract: boolean;
        fillStyle: string;
    }> {
        const contours: Array<{
            nodes: Babelfont.Node[];
            subtract: boolean;
            fillStyle: string;
        }> = [];
        if (!Array.isArray(shapes)) {
            return contours;
        }
        for (let index = 0; index < shapes.length; index++) {
            const shape = shapes[index];
            if (outlineShapeIsComponent(shape)) {
                const component = shape as {
                    Component?: {
                        transform?: unknown;
                        layerData?: { shapes?: unknown[] };
                    };
                    transform?: unknown;
                    layerData?: { shapes?: unknown[] };
                };
                const inner = component.Component || component;
                const transformRaw =
                    inner.transform || DecomposedAffineTransform.identity();
                const childAffine = multiplyAffineTransforms(
                    affine,
                    Array.isArray(transformRaw)
                        ? transformRaw
                        : DecomposedAffineTransform.toAffine(transformRaw)
                );
                const childFill = componentFillForIndex
                    ? componentFillForIndex(index)
                    : fillStyle;
                contours.push(
                    ...this.collectPunchFillContours(
                        inner.layerData?.shapes,
                        childAffine,
                        childFill
                    )
                );
                continue;
            }
            if (!getClosedFromOutlineShape(shape)) {
                continue;
            }
            const nodes =
                getNodesFromShape(shape as Babelfont.Shape) ||
                getNodesFromOutlineShape(shape);
            if (!nodes?.length) {
                continue;
            }
            contours.push({
                nodes: this.transformOutlineNodes(nodes, affine),
                subtract: outlineShapeIsSubtraction(shape),
                fillStyle
            });
        }
        return contours;
    }

    private fillPunchFillContoursOnContext(
        contours: Array<{
            nodes: Babelfont.Node[];
            subtract: boolean;
            fillStyle: string;
        }>
    ): void {
        fillPunchFillContoursOnContext(
            this.ctx,
            contours,
            (ctx, nodes) => {
                this.buildPathFromNodes(nodes as Babelfont.Node[], true);
                ctx.closePath();
            },
            this.getSubtractionFillColor()
        );
    }

    private fillOutlineEditorPunchOut(
        layerData: { shapes?: unknown[] },
        localFillStyle: string
    ): void {
        const isAutomatic = isAutomaticallyAlignedComponentLayer(
            layerData as ComponentAlignmentLayerSnapshot
        );
        const contours = this.collectPunchFillContours(
            layerData.shapes,
            createIdentityAffine(),
            localFillStyle,
            (shapeIndex) =>
                this.getComponentPunchFillStyle(shapeIndex, isAutomatic)
        );
        if (!contours.length) {
            return;
        }

        const main = this.ctx;
        const canvas = main.canvas;
        if (
            !this.punchOutScratch ||
            this.punchOutScratch.width !== canvas.width ||
            this.punchOutScratch.height !== canvas.height
        ) {
            this.punchOutScratch = document.createElement('canvas');
            this.punchOutScratch.width = canvas.width;
            this.punchOutScratch.height = canvas.height;
        }
        const offscreen = this.punchOutScratch;
        const offscreenCtx = offscreen.getContext('2d');
        if (!offscreenCtx) {
            this.fillPunchFillContoursOnContext(contours);
            return;
        }

        offscreenCtx.setTransform(1, 0, 0, 1, 0, 0);
        offscreenCtx.clearRect(0, 0, offscreen.width, offscreen.height);
        offscreenCtx.setTransform(main.getTransform());

        const previous = this.ctx;
        this.ctx = offscreenCtx;
        try {
            this.fillPunchFillContoursOnContext(contours);
        } finally {
            this.ctx = previous;
        }

        main.save();
        main.setTransform(1, 0, 0, 1, 0, 0);
        main.drawImage(offscreen, 0, 0);
        main.restore();
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

        // Draw outline editor when a layer is selected. Space preview
        // multiplies this pass by previewChromeOpacity in render().
        if (!this.glyphCanvas.outlineEditor.layerData) {
            return;
        }

        // Get the layer data at the current position in glyph_stack
        // This will return the root glyph data if not in component editing,
        // or the nested component data if we've entered components
        const currentLayerData =
            this.glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();
        const visibleGuides = this.glyphCanvas.outlineEditor.getVisibleGuides();
        const hasPairedGhost =
            this.glyphCanvas.outlineEditor.isPairedLayerVisible() &&
            this.glyphCanvas.outlineEditor.getPairedLayerGhostPaths().length >
                0;

        // Skip rendering if there is nothing editable to show.
        if (
            !currentLayerData ||
            ((!currentLayerData.shapes ||
                currentLayerData.shapes.length === 0) &&
                (!currentLayerData.anchors ||
                    currentLayerData.anchors.length === 0) &&
                visibleGuides.length === 0 &&
                !hasPairedGhost)
        ) {
            console.log(
                '[Renderer]',
                'Skipping drawOutlineEditor: no shapes, anchors, or guides at current stack position'
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

        const glyph =
            this.textRunEditor.shapedGlyphs[
                this.textRunEditor.selectedGlyphIndex
            ];
        const layout = this.textRunEditor._getGlyphPosition(
            this.textRunEditor.selectedGlyphIndex
        );
        let xPosition = layout.xPosition;
        let xOffset = glyph.dx || 0;
        const animatedOriginX =
            this.glyphCanvas.featureChangeAnimator?.getSelectedGlyphOriginX();
        if (animatedOriginX !== null && animatedOriginX !== undefined) {
            xPosition = animatedOriginX;
            xOffset = 0;
        }
        const x = xPosition + xOffset;
        const y = layout.yOffset;
        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';

        this.ctx.save();
        this.ctx.translate(x, y);

        this.drawOutlineGuides(visibleGuides, invScale, isDarkTheme, 'lines');

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

        // Filled glyph background: all additive contours share one nonzero
        // fill so reverse counters punch regardless of path/component order.
        // Subtraction cutters then dest-out in shape order; later additives
        // cover the cutter. Cutter fill stays except where later solids sit.
        this.fillOutlineEditorPunchOut(
            currentLayerData,
            this.getPathFillColor(isDarkTheme)
        );

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
                    const nodes = getNodesFromShape(shape);
                    if (nodes && nodes.length > 0) {
                        nodes.forEach(({ x, y }: { x: number; y: number }) => {
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
                this.ctx.save();
                this.ctx.globalAlpha *= gridOpacity;
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

            if (!rgbaMatch) {
                this.ctx.restore();
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
        const duplicateNodePositionKeys = collectDuplicateNodePositionKeys(
            currentLayerData.shapes
        );
        const drawnDuplicateNodeWarningKeys = new Set<string>();

        // Only draw shapes if they exist (empty glyphs like space won't have shapes)
        if (currentLayerData.shapes && Array.isArray(currentLayerData.shapes)) {
            const isAutomaticComponentLayer =
                isAutomaticallyAlignedComponentLayer(currentLayerData);
            // Apply monochrome for interpolated previews. Exact stored layers
            // keep object-model color even while a slider drag is still down.
            const isInterpolated =
                this.glyphCanvas.outlineEditor.isPaintingInterpolatedPreview();

            currentLayerData.shapes.forEach((shape, contourIndex: number) =>
                this.drawShape(
                    shape,
                    contourIndex,
                    !!isInterpolated,
                    duplicateNodePositionKeys,
                    drawnDuplicateNodeWarningKeys
                )
            );

            if (!this.glyphCanvas.outlineEditor.isPreviewMode) {
                currentLayerData.shapes.forEach((shape, index: number) => {
                    if (!('reference' in shape)) {
                        return; // Not a component
                    }

                    // Disable selection/hover highlighting for interpolated data
                    const isInterpolated =
                        this.glyphCanvas.outlineEditor.isPaintingInterpolatedPreview();
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
                    const transformRaw =
                        'reference' in shape && shape.transform
                            ? shape.transform
                            : undefined;
                    const transform = normalizeAffineTransform(transformRaw);
                    const [a, b, c, d, tx, ty] = transform;

                    this.ctx.save();

                    // Apply component transform
                    this.ctx.transform(a, b, c, d, tx, ty);

                    // Draw the component's outline shapes if they were fetched
                    if (
                        'reference' in shape &&
                        shape.layerData &&
                        shape.layerData.shapes
                    ) {
                        this.drawComponentWithOutlines(
                            shape.layerData.shapes,
                            isSelected,
                            isHovered,
                            isAutomaticComponentLayer,
                            !!isInterpolated,
                            invScale,
                            isDarkTheme,
                            true
                        );

                        // Collect component label data for later drawing (on top of everything)
                        // Only show on hover
                        if (isHovered) {
                            const componentName =
                                shape.reference || 'component';
                            const bounds = this.getComponentBounds(
                                shape.layerData.shapes
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

                    this.ctx.restore();
                });
            }
        }

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
            const fontSize = 12 * invScale;

            currentLayerData.anchors.forEach((anchor: any, index: number) => {
                const { x, y, name } = anchor;
                const isInterpolated =
                    this.glyphCanvas.outlineEditor.isPaintingInterpolatedPreview();
                const isHovered =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.hoveredAnchorIndex === index;
                const isSelected =
                    !isInterpolated &&
                    this.glyphCanvas.outlineEditor.selectedAnchors.includes(
                        index
                    );
                const coincidentWithNode =
                    this.glyphCanvas.outlineEditor.anchorSharesLocationWithNode(
                        x,
                        y
                    );
                const isDiamond = this.isOnVerticalMetricLine(x, y);
                const anchorSize = this.getAnchorChromeFontRadius(
                    invScale,
                    coincidentWithNode,
                    isDiamond
                );

                // Inverse transform keeps anchors square in screen space.
                this.ctx.save();
                this.ctx.translate(x, y);
                this.applyInverseComponentTransform(); // Cancel out component transform

                const colors = isDarkTheme
                    ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                    : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
                const strokeColor = colors.ANCHOR_STROKE;
                let fillColor = isSelected
                    ? colors.ANCHOR_SELECTED
                    : colors.ANCHOR_NORMAL;

                if (isInterpolated) {
                    fillColor = desaturateColor(fillColor);
                }

                const shapeKind: 'square' | 'diamond' = isDiamond
                    ? 'diamond'
                    : 'square';
                const scaledAnchorSize =
                    anchorSize *
                    outlineChromeStateScale(isSelected, isHovered) *
                    (isDiamond && coincidentWithNode
                        ? APP_SETTINGS.OUTLINE_EDITOR.NODE_DIAMOND_SIZE_RATIO
                        : 1);
                const strokeWidth =
                    APP_SETTINGS.OUTLINE_EDITOR.NODE_CHROME_STROKE_WIDTH *
                    invScale;
                if (this.shouldPaintZoneHalo(x, y)) {
                    this.paintZoneHalo(
                        shapeKind,
                        scaledAnchorSize,
                        strokeWidth,
                        isInterpolated
                            ? desaturateColor(colors.NODE_ZONE_HALO_STROKE)
                            : colors.NODE_ZONE_HALO_STROKE,
                        colors.NODE_ZONE_HALO_OPACITY,
                        this.getZoneHaloWidth(
                            this.getNodeChromeFontRadius(invScale) *
                                (coincidentWithNode
                                    ? APP_SETTINGS.OUTLINE_EDITOR
                                          .ANCHOR_SIZE_RATIO
                                    : 1) *
                                outlineChromeStateScale(isSelected, isHovered),
                            shapeKind
                        )
                    );
                }
                this.paintOutlineChrome(
                    shapeKind,
                    scaledAnchorSize,
                    isInterpolated ? desaturateColor(strokeColor) : strokeColor,
                    fillColor,
                    strokeWidth
                );

                this.ctx.restore();

                // Collect anchor label for drawing later (on top of everything)
                if (name && (isSelected || isHovered)) {
                    anchorLabels.push({
                        name,
                        x,
                        y,
                        anchorSize: scaledAnchorSize,
                        fontSize
                    });
                }
            });
        }

        const sidebearingHandles =
            this.glyphCanvas.outlineEditor.getVisibleSidebearingHandles();
        if (sidebearingHandles.length > 0) {
            const baseHandleRadius = this.getNodeChromeFontRadius(invScale);
            const strokeWidth =
                APP_SETTINGS.OUTLINE_EDITOR.NODE_CHROME_STROKE_WIDTH * invScale;
            const colors = isDarkTheme
                ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
            const sideAccents = this.getSidebearingAccentColors();

            sidebearingHandles.forEach((handle) => {
                const isHovered =
                    this.glyphCanvas.outlineEditor.hoveredSidebearingHandle
                        ?.side === handle.side;
                const isSelected =
                    this.glyphCanvas.outlineEditor.selectedSidebearingHandle
                        ?.side === handle.side;
                const sideColor =
                    handle.side === 'left'
                        ? sideAccents.left
                        : sideAccents.right;
                const strokeColor = handle.editable
                    ? sideColor
                    : colors.SIDEBEARING_DISABLED;
                const fillAlpha =
                    APP_SETTINGS.OUTLINE_EDITOR.SIDEBEARING_HANDLE_FILL_ALPHA;
                const fillColor = isSelected
                    ? strokeColor
                    : isHovered
                      ? withColorAlpha(strokeColor, fillAlpha)
                      : `rgba(255, 255, 255, ${fillAlpha})`;
                const handleRadius =
                    baseHandleRadius *
                    outlineChromeStateScale(isSelected, isHovered);

                this.ctx.save();
                this.ctx.translate(handle.x, handle.y);
                this.applyInverseComponentTransform();
                this.paintOutlineChrome(
                    'circle',
                    handleRadius,
                    strokeColor,
                    fillColor,
                    strokeWidth
                );
                this.ctx.restore();
            });
        }

        this.drawSelectionResizeBox(invScale, isDarkTheme);

        if (APP_SETTINGS.OUTLINE_EDITOR.SHOW_BBOX_CENTER_CROSSHAIR) {
            const bounds = Layer.calculateBoundingBox(currentLayerData, true);
            if (bounds) {
                const centerX = bounds.minX + bounds.width / 2;
                const centerY = bounds.minY + bounds.height / 2;
                const markerRadius = 10 * invScale;
                const colors = isDarkTheme
                    ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                    : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

                this.ctx.save();
                this.ctx.translate(centerX, centerY);
                this.applyInverseComponentTransform();
                this.ctx.strokeStyle = colors.MEASUREMENT_TOOL_CROSSHAIR;
                this.ctx.lineWidth = 1.5 * invScale;
                this.ctx.beginPath();
                this.ctx.moveTo(-markerRadius, 0);
                this.ctx.lineTo(markerRadius, 0);
                this.ctx.moveTo(0, -markerRadius);
                this.ctx.lineTo(0, markerRadius);
                this.ctx.stroke();
                this.ctx.restore();
            }
        }

        // Draw component labels on top of everything
        componentLabels.forEach(({ componentName, bounds, transform }) => {
            const [a, b, c, d, tx, ty] = transform;
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const labelY = bounds.minY - 100; // 100 units below bottom in local space

            // Apply component transform to get world coordinates
            // Transform matrix: [a, b, c, d, tx, ty] represents:
            // x' = a*x + c*y + tx
            // y' = b*x + d*y + ty
            const worldX = a * centerX + c * labelY + tx;
            const worldY = b * centerX + d * labelY + ty;

            // Pass glyph offset since we're inside ctx.translate(x, y) context
            this.drawHoverLabel(componentName, worldX, worldY, invScale, x, y);
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

        this.drawPairedLayerGhost(invScale);
        this.drawMarqueeSelectionRect();

        this.ctx.restore();

        this.ctx.save();
        this.ctx.translate(x, y);
        this.drawOutlineGuides(visibleGuides, invScale, isDarkTheme, 'handles');
        this.ctx.restore();
    }

    private drawSelectionResizeBox(
        invScale: number,
        isDarkTheme: boolean
    ): void {
        const bounds =
            this.glyphCanvas.outlineEditor.getVisibleSelectionTransformBounds();
        if (!bounds) {
            return;
        }

        const handles =
            this.glyphCanvas.outlineEditor.getVisibleSelectionResizeHandles();
        if (handles.length === 0) {
            return;
        }

        const strokeColor = isDarkTheme
            ? 'rgba(210, 210, 210, 0.9)'
            : 'rgba(168, 168, 168, 0.95)';
        const handleFillColor = isDarkTheme
            ? 'rgba(156, 247, 240, 1)'
            : 'rgba(20, 118, 110, 1)';
        const hoveredHandleKey =
            this.glyphCanvas.outlineEditor.hoveredResizeHandle?.key;
        const lineWidth = 1.5 * invScale;

        this.ctx.save();
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = lineWidth;
        this.ctx.setLineDash([Math.max(1.5 * invScale, 1), 3.5 * invScale]);
        this.ctx.beginPath();
        this.ctx.rect(bounds.minX, bounds.minY, bounds.width, bounds.height);
        this.ctx.stroke();
        this.ctx.restore();

        const handleSize = Math.max(8 * invScale, 10 * invScale);
        handles.forEach((handle) => {
            this.ctx.save();
            this.ctx.translate(handle.x, handle.y);
            this.applyInverseComponentTransform();
            this.ctx.beginPath();
            this.ctx.rect(
                -handleSize / 2,
                -handleSize / 2,
                handleSize,
                handleSize
            );
            this.ctx.fillStyle =
                hoveredHandleKey === handle.key ? handleFillColor : strokeColor;
            this.ctx.fill();
            this.ctx.lineWidth = Math.max(invScale, lineWidth * 0.75);
            this.ctx.strokeStyle = isDarkTheme
                ? 'rgba(0, 0, 0, 0.55)'
                : 'rgba(255, 255, 255, 0.7)';
            this.ctx.stroke();
            this.ctx.restore();
        });
    }

    private drawPairedLayerGhost(invScale: number): void {
        if (!this.glyphCanvas.outlineEditor.isPairedLayerVisible()) {
            return;
        }
        const ghostPaths =
            this.glyphCanvas.outlineEditor.getPairedLayerGhostPaths();
        if (!ghostPaths.length) {
            return;
        }

        this.ctx.save();
        this.ctx.globalAlpha *= 0.35;
        this.ctx.strokeStyle = getComputedStyle(
            document.documentElement
        ).getPropertyValue('--accent-yellow');
        this.ctx.lineWidth = 1.5 * invScale;
        ghostPaths.forEach((path) => {
            if (path.nodes.length === 0) {
                return;
            }
            this.ctx.beginPath();
            this.buildPathFromNodes(path.nodes, path.closed);
            if (path.closed) {
                this.ctx.closePath();
            }
            this.ctx.stroke();
        });
        this.ctx.restore();
    }

    drawShape(
        shape: Babelfont.Shape,
        contourIndex: number,
        isInterpolated: boolean,
        duplicateNodePositionKeys: Set<string> | null = null,
        drawnDuplicateNodeWarningKeys: Set<string> | null = null
    ) {
        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        console.log(
            '[Renderer]',
            'Drawing shape',
            contourIndex,
            ':',
            'reference' in shape ? 'Component' : 'Path',
            'reference' in shape
                ? `ref=${shape.reference}`
                : `nodes=${'nodes' in shape ? (shape.nodes as Babelfont.Node[] | undefined)?.length || 0 : 0}`
        );
        if ('reference' in shape) {
            // Component - will be drawn separately as markers
            return;
        }

        // Handle Path object from to_dict() - nodes might be in shape.Path.nodes
        const nodes = getNodesFromShape(shape);

        if (!nodes || nodes.length === 0) {
            return;
        }

        // Log first node coordinates to track interpolation
        console.log(
            '[Renderer] Final nodes to render, first coords:',
            nodes[0]?.x,
            nodes[0]?.y
        );

        const addPointPreview =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.hoveredAddPointPreview &&
            this.glyphCanvas.outlineEditor.hoveredAddPointPreview.shapeIndex ===
                contourIndex
                ? this.glyphCanvas.outlineEditor.hoveredAddPointPreview
                : null;
        const commandCurvePreview =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.hoveredCommandCurvePreview &&
            this.glyphCanvas.outlineEditor.hoveredCommandCurvePreview
                .shapeIndex === contourIndex
                ? this.glyphCanvas.outlineEditor.hoveredCommandCurvePreview
                : null;
        const segmentPreview = addPointPreview || commandCurvePreview;
        const closed = getClosedFromOutlineShape(shape);
        const addPointPreviewDescriptor = segmentPreview
            ? Layer.getPathSegmentDescriptors({ nodes, closed }).find(
                  (descriptor) =>
                      descriptor.segmentId === segmentPreview.segmentId
              ) || null
            : null;
        const previewControlNodeIndices = new Set(
            addPointPreviewDescriptor?.runControlNodeIndices ?? []
        );
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        const isNodeHovered = (nodeIndex: number): boolean =>
            !isInterpolated &&
            !!this.glyphCanvas.outlineEditor.hoveredPointIndex &&
            this.glyphCanvas.outlineEditor.hoveredPointIndex.contourIndex ===
                contourIndex &&
            this.glyphCanvas.outlineEditor.hoveredPointIndex.nodeIndex ===
                nodeIndex;

        const isNodeSelected = (nodeIndex: number): boolean =>
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.selectedPoints.some(
                (p: { contourIndex: number; nodeIndex: number }) =>
                    p.contourIndex === contourIndex && p.nodeIndex === nodeIndex
            );

        const getOffCurveOnCurveIndex = (nodeIndex: number): number | null => {
            if (nodes[nodeIndex]?.nodetype !== 'OffCurve') {
                return null;
            }
            let prevIdx = nodeIndex - 1;
            if (prevIdx < 0) {
                prevIdx = nodes.length - 1;
            }
            let nextIdx = nodeIndex + 1;
            if (nextIdx >= nodes.length) {
                nextIdx = 0;
            }
            if (nodes[prevIdx].nodetype === 'OffCurve') {
                let targetIdx = nextIdx;
                if (nodes[nextIdx].nodetype === 'OffCurve') {
                    targetIdx++;
                    if (targetIdx >= nodes.length) {
                        targetIdx = 0;
                    }
                }
                return nodes[targetIdx].nodetype === 'OffCurve'
                    ? null
                    : targetIdx;
            }
            const prevType = nodes[prevIdx].nodetype;
            if (
                prevType === 'Move' ||
                prevType === 'Curve' ||
                prevType === 'QCurve' ||
                prevType === 'Line'
            ) {
                return prevIdx;
            }
            return null;
        };

        const hoveredPointIndex =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.hoveredPointIndex?.contourIndex ===
                contourIndex
                ? this.glyphCanvas.outlineEditor.hoveredPointIndex.nodeIndex
                : null;
        const hoveredSeg =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.hoveredPathSegment?.shapeIndex ===
                contourIndex
                ? this.glyphCanvas.outlineEditor.hoveredPathSegment
                : null;
        const hoveredPointOwner =
            hoveredPointIndex !== null
                ? getOffCurveOnCurveIndex(hoveredPointIndex)
                : null;
        const hoverMix = (rest: string, selected: string): string =>
            mixColors(
                rest,
                selected,
                APP_SETTINGS.OUTLINE_EDITOR.CHROME_HOVER_MIX
            );

        const isOnCurveHoverCluster = (nodeIndex: number): boolean => {
            if (nodes[nodeIndex]?.nodetype === 'OffCurve') {
                return false;
            }
            if (hoveredPointIndex === nodeIndex) {
                return true;
            }
            if (hoveredPointOwner === nodeIndex) {
                return true;
            }
            return !!(
                hoveredSeg &&
                (hoveredSeg.startNodeIndex === nodeIndex ||
                    hoveredSeg.endNodeIndex === nodeIndex)
            );
        };

        const isHandleHoverCluster = (nodeIndex: number): boolean => {
            if (nodes[nodeIndex]?.nodetype !== 'OffCurve') {
                return false;
            }
            if (hoveredPointIndex === nodeIndex) {
                return true;
            }
            const owner = getOffCurveOnCurveIndex(nodeIndex);
            if (owner === null) {
                return false;
            }
            if (hoveredPointIndex === owner) {
                return true;
            }
            if (!hoveredSeg) {
                return false;
            }
            if (hoveredSeg.controlNodeIndices.includes(nodeIndex)) {
                return true;
            }
            return (
                hoveredSeg.type === 'line' &&
                (hoveredSeg.startNodeIndex === owner ||
                    hoveredSeg.endNodeIndex === owner) &&
                !!nodes[owner]?.smooth
            );
        };

        const isChromeHoverCluster = (nodeIndex: number): boolean =>
            isOnCurveHoverCluster(nodeIndex) || isHandleHoverCluster(nodeIndex);

        const isHandleLineHoverCluster = (handleIndex: number): boolean =>
            isHandleHoverCluster(handleIndex);

        const isSegmentHoverCluster = (descriptor: {
            segmentId: number;
        }): boolean => hoveredSeg?.segmentId === descriptor.segmentId;

        const isSubtractionPath = outlineShapeIsSubtraction(shape);
        const unselectedOutline = isSubtractionPath
            ? this.getSubtractionStrokeColor()
            : isDarkTheme
              ? `rgba(255, 255, 255, ${APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_OPACITY})`
              : `rgba(0, 0, 0, ${APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_OPACITY})`;
        const outlineWidth =
            APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_STROKE_WIDTH * invScale;
        const applySubtractionDash = (): void => {
            this.ctx.setLineDash(
                isSubtractionPath ? this.subtractionOutlineDash(invScale) : []
            );
        };
        const pathDescriptors = Layer.getPathSegmentDescriptors({
            nodes,
            closed
        });
        const selectedPathSegments = pathDescriptors.filter(
            (descriptor) =>
                isNodeSelected(descriptor.startNodeIndex) &&
                isNodeSelected(descriptor.endNodeIndex)
        );
        const isHandleImplicitlySelected = (handleIndex: number): boolean => {
            if (nodes[handleIndex]?.nodetype !== 'OffCurve') {
                return false;
            }
            const owner = getOffCurveOnCurveIndex(handleIndex);
            if (owner === null || !isNodeSelected(owner)) {
                return false;
            }
            const ownerOnSelectedSegment = selectedPathSegments.filter(
                (segment) =>
                    segment.startNodeIndex === owner ||
                    segment.endNodeIndex === owner
            );
            if (ownerOnSelectedSegment.length === 0) {
                return true;
            }
            if (
                ownerOnSelectedSegment.some((segment) =>
                    segment.controlNodeIndices.includes(handleIndex)
                )
            ) {
                return true;
            }
            return ownerOnSelectedSegment.some(
                (segment) => segment.type === 'line' && !!nodes[owner]?.smooth
            );
        };
        if (pathDescriptors.length === 0) {
            this.ctx.save();
            applySubtractionDash();
            this.ctx.beginPath();
            this.ctx.strokeStyle = unselectedOutline;
            this.ctx.lineWidth = outlineWidth;
            this.buildPathFromNodes(nodes, closed);
            if (closed) {
                this.ctx.closePath();
            }
            this.ctx.stroke();
            this.ctx.restore();
        } else {
            const strokeSegment = (
                descriptor: (typeof pathDescriptors)[number],
                strokeStyle: string,
                lineWidth: number
            ): void => {
                const pieces =
                    segmentPreview &&
                    descriptor.segmentId === segmentPreview.segmentId
                        ? segmentPreview.segments
                        : [descriptor];
                if (pieces.length === 0 || pieces[0].points.length < 2) {
                    return;
                }
                this.ctx.save();
                applySubtractionDash();
                this.ctx.beginPath();
                this.ctx.moveTo(pieces[0].points[0].x, pieces[0].points[0].y);
                pieces.forEach((piece) => {
                    this.appendPreviewSegmentToPath(this.ctx, piece);
                });
                this.ctx.strokeStyle = strokeStyle;
                this.ctx.lineWidth = lineWidth;
                this.ctx.stroke();
                this.ctx.restore();
            };
            pathDescriptors.forEach((descriptor) => {
                const segmentSelected =
                    isNodeSelected(descriptor.startNodeIndex) &&
                    isNodeSelected(descriptor.endNodeIndex);
                const isHoveredSegment = isSegmentHoverCluster(descriptor);
                if (segmentSelected || isHoveredSegment) {
                    return;
                }
                strokeSegment(descriptor, unselectedOutline, outlineWidth);
            });
            pathDescriptors.forEach((descriptor) => {
                const segmentSelected =
                    isNodeSelected(descriptor.startNodeIndex) &&
                    isNodeSelected(descriptor.endNodeIndex);
                const isHoveredSegment = isSegmentHoverCluster(descriptor);
                if (!segmentSelected && !isHoveredSegment) {
                    return;
                }
                strokeSegment(
                    descriptor,
                    segmentSelected
                        ? colors.OUTLINE_SELECTED
                        : hoverMix(unselectedOutline, colors.OUTLINE_SELECTED),
                    outlineWidth *
                        (segmentSelected
                            ? 1
                            : outlineChromeStateScale(false, true))
                );
            });
        }

        const startIdx = this.getPathStartIndex(nodes);

        const commandPathPreviewLine =
            !isInterpolated &&
            this.glyphCanvas.outlineEditor.getCommandPathPreviewContourIndex() ===
                contourIndex
                ? this.glyphCanvas.outlineEditor.getCommandPathPreviewLine()
                : null;
        if (commandPathPreviewLine) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.strokeStyle = colors.NODE_HOVERED;
            this.ctx.lineWidth = 1 * invScale;
            this.ctx.moveTo(
                commandPathPreviewLine.start.x,
                commandPathPreviewLine.start.y
            );
            this.ctx.lineTo(
                commandPathPreviewLine.end.x,
                commandPathPreviewLine.end.y
            );
            this.ctx.stroke();
            this.ctx.restore();
        }
        const minZoomForHandles =
            APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        const pointSize = this.getNodeChromeFontRadius(invScale);
        const strokeWidth = settings.NODE_CHROME_STROKE_WIDTH * invScale;
        const smoothDotRatio = settings.NODE_SMOOTH_DOT_RATIO;
        const controlRatio = settings.CONTROL_POINT_SIZE_RATIO;
        const smoothRatio = settings.NODE_SMOOTH_SIZE_RATIO;
        const diamondRatio = settings.NODE_DIAMOND_SIZE_RATIO;
        const strokePad = strokeWidth / 2;

        const chromeOuterRadius = (
            node: Babelfont.Node,
            nodeIndex: number
        ): number => {
            const stateScale = outlineChromeStateScale(
                isNodeSelected(nodeIndex),
                isNodeHovered(nodeIndex) || isChromeHoverCluster(nodeIndex)
            );
            if (node.nodetype === 'OffCurve') {
                return pointSize * stateScale * controlRatio + strokePad;
            }
            const onCurveRatio = node.smooth ? smoothRatio : 1;
            const diamondScale = this.isOnCurveDiamondNode(node.x, node.y)
                ? diamondRatio
                : 1;
            return (
                pointSize * stateScale * onCurveRatio * diamondScale + strokePad
            );
        };

        // Skip drawing direction arrow and handles if zoom is under minimum threshold
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

                    const baseSize = this.getNodeChromeFontRadius(invScale);

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

                    let fillColor = colors.NODE_NORMAL;
                    if (isInterpolated) {
                        fillColor = desaturateColor(fillColor);
                    }

                    this.ctx.save();
                    this.ctx.globalAlpha =
                        APP_SETTINGS.OUTLINE_EDITOR.CONTOUR_DIRECTION_ARROW_OPACITY;
                    this.ctx.fillStyle = fillColor;
                    this.ctx.fill();
                    this.ctx.restore();
                }
            }

            // Draw control point handle lines (from off-curve to adjacent on-curve points)
            const handleOpacity =
                APP_SETTINGS.OUTLINE_EDITOR.HANDLE_LINE_OPACITY;
            const idleHandleLine = isDarkTheme
                ? `rgba(255, 255, 255, ${handleOpacity})`
                : `rgba(0, 0, 0, ${handleOpacity})`;
            const strokeHandleLine = (
                fromIndex: number,
                toIndex: number,
                fromX: number,
                fromY: number,
                toX: number,
                toY: number,
                fromRadius: number,
                toRadius: number
            ): void => {
                const isActive =
                    isNodeSelected(fromIndex) ||
                    isHandleImplicitlySelected(fromIndex);
                const isHoveredLine = isHandleLineHoverCluster(fromIndex);
                this.ctx.strokeStyle = isActive
                    ? colors.HANDLE_LINE_SELECTED
                    : isHoveredLine
                      ? hoverMix(idleHandleLine, colors.HANDLE_LINE_SELECTED)
                      : idleHandleLine;
                this.ctx.lineWidth = 1 * invScale;
                this.strokeTrimmedHandleLine(
                    fromX,
                    fromY,
                    toX,
                    toY,
                    fromRadius,
                    toRadius
                );
            };

            nodes.forEach((node: Babelfont.Node, nodeIndex: number) => {
                const { x, y, nodetype: type } = node;

                if (previewControlNodeIndices.has(nodeIndex)) {
                    return;
                }

                // Only draw lines from off-curve points
                if (type === 'OffCurve') {
                    // Check if this is the first or second control point in a cubic bezier pair
                    let prevIdx = nodeIndex - 1;
                    if (prevIdx < 0) prevIdx = nodes.length - 1;
                    const prevType = nodes[prevIdx].nodetype;

                    let nextIdx = nodeIndex + 1;
                    if (nextIdx >= nodes.length) nextIdx = 0;
                    const nextType = nodes[nextIdx].nodetype;
                    const isPrevOffCurve = prevType === 'OffCurve';
                    const isNextOffCurve = nextType === 'OffCurve';

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
                        // Connect to on-curve points, including Move for open contours.
                        if (targetType !== 'OffCurve') {
                            strokeHandleLine(
                                nodeIndex,
                                targetIdx,
                                x,
                                y,
                                targetX,
                                targetY,
                                chromeOuterRadius(node, nodeIndex),
                                chromeOuterRadius(nodes[targetIdx], targetIdx)
                            );
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
                            targetType === 'Move' ||
                            targetType === 'Curve' ||
                            targetType === 'QCurve' ||
                            targetType === 'Line'
                        ) {
                            strokeHandleLine(
                                nodeIndex,
                                targetIdx,
                                x,
                                y,
                                targetX,
                                targetY,
                                chromeOuterRadius(node, nodeIndex),
                                chromeOuterRadius(nodes[targetIdx], targetIdx)
                            );
                        }
                    }
                }
            });

            if (segmentPreview) {
                const previewOffRadius = pointSize * controlRatio + strokePad;
                const previewOnRadius = pointSize + strokePad;
                this.ctx.strokeStyle = idleHandleLine;
                this.ctx.lineWidth = 1 * invScale;
                segmentPreview.segments.forEach((segment) => {
                    if (segment.type === 'quadratic') {
                        this.strokeTrimmedHandleLine(
                            segment.points[0].x,
                            segment.points[0].y,
                            segment.points[1].x,
                            segment.points[1].y,
                            previewOnRadius,
                            previewOffRadius
                        );
                        this.strokeTrimmedHandleLine(
                            segment.points[2].x,
                            segment.points[2].y,
                            segment.points[1].x,
                            segment.points[1].y,
                            previewOnRadius,
                            previewOffRadius
                        );
                    } else if (segment.type === 'cubic') {
                        this.strokeTrimmedHandleLine(
                            segment.points[0].x,
                            segment.points[0].y,
                            segment.points[1].x,
                            segment.points[1].y,
                            previewOnRadius,
                            previewOffRadius
                        );
                        this.strokeTrimmedHandleLine(
                            segment.points[3].x,
                            segment.points[3].y,
                            segment.points[2].x,
                            segment.points[2].y,
                            previewOnRadius,
                            previewOffRadius
                        );
                    }
                });
            }
        }

        // Draw nodes (points)
        // Nodes are drawn at the same zoom threshold as handles
        if (this.viewportManager.scale < minZoomForHandles) {
            return;
        }

        nodes.forEach((node: Babelfont.Node, nodeIndex: number) => {
            const { x, y, nodetype: type } = node;
            const isHovered = isNodeHovered(nodeIndex);
            const isSelected = isNodeSelected(nodeIndex);
            const inHoverCluster = isChromeHoverCluster(nodeIndex);

            if (previewControlNodeIndices.has(nodeIndex)) {
                return;
            }

            // Closed contours do not expose a Move start node in the editor.
            if (type === 'Move' && closed) {
                return;
            }

            const isOffCurve = type === 'OffCurve';
            const onCurveOwnerSelected =
                isOffCurve && isHandleImplicitlySelected(nodeIndex);
            const handleLooksSelected =
                isOffCurve && (isSelected || onCurveOwnerSelected);
            const restStroke = isOffCurve
                ? handleLooksSelected
                    ? colors.HANDLE_LINE_SELECTED
                    : inHoverCluster
                      ? hoverMix(
                            colors.CONTROL_POINT_OUTLINE,
                            colors.HANDLE_LINE_SELECTED
                        )
                      : colors.CONTROL_POINT_OUTLINE
                : colors.NODE_NORMAL;
            let strokeColor = restStroke;
            let fillColor = isOffCurve
                ? isSelected
                    ? colors.CONTROL_POINT_SELECTED
                    : onCurveOwnerSelected
                      ? colors.CONTROL_POINT_OWNER_SELECTED_FILL
                      : inHoverCluster
                        ? hoverMix(
                              colors.NODE_UNSELECTED_FILL,
                              colors.CONTROL_POINT_OWNER_SELECTED_FILL
                          )
                        : colors.NODE_UNSELECTED_FILL
                : isSelected
                  ? colors.NODE_NORMAL
                  : inHoverCluster
                    ? hoverMix(colors.NODE_UNSELECTED_FILL, colors.NODE_NORMAL)
                    : colors.NODE_UNSELECTED_FILL;
            if (isInterpolated) {
                strokeColor = desaturateColor(strokeColor);
                if (fillColor) {
                    fillColor = desaturateColor(fillColor);
                }
            }

            const stateScale = outlineChromeStateScale(
                isSelected,
                isHovered || inHoverCluster
            );
            let shapeKind: 'circle' | 'square' | 'diamond';
            if (isOffCurve) {
                shapeKind = 'circle';
            } else if (this.isOnCurveDiamondNode(x, y)) {
                shapeKind = 'diamond';
            } else if (node.smooth) {
                shapeKind = 'circle';
            } else {
                shapeKind = 'square';
            }
            const radius =
                pointSize *
                stateScale *
                (isOffCurve ? controlRatio : node.smooth ? smoothRatio : 1) *
                (shapeKind === 'diamond' ? diamondRatio : 1);
            const dotRadius =
                pointSize *
                stateScale *
                (node.smooth ? smoothRatio : 1) *
                smoothDotRatio;

            this.ctx.save();
            this.ctx.translate(x, y);
            this.applyInverseComponentTransform();
            if (!isOffCurve && this.shouldPaintZoneHalo(x, y)) {
                this.paintZoneHalo(
                    shapeKind,
                    radius,
                    strokeWidth,
                    isInterpolated
                        ? desaturateColor(colors.NODE_ZONE_HALO_STROKE)
                        : colors.NODE_ZONE_HALO_STROKE,
                    colors.NODE_ZONE_HALO_OPACITY,
                    this.getZoneHaloWidth(pointSize * stateScale, shapeKind)
                );
            }
            this.paintOutlineChrome(
                shapeKind,
                radius,
                strokeColor,
                fillColor,
                strokeWidth
            );

            if (node.smooth) {
                let smoothColor = colors.NODE_SMOOTH_DOT;
                if (isInterpolated) {
                    smoothColor = desaturateColor(smoothColor);
                }
                this.ctx.beginPath();
                this.ctx.arc(0, 0, dotRadius, 0, Math.PI * 2);
                this.ctx.fillStyle = smoothColor;
                this.ctx.fill();
            }

            const nodePositionKey = getNodePositionKey(x, y);
            if (
                duplicateNodePositionKeys?.has(nodePositionKey) &&
                !drawnDuplicateNodeWarningKeys?.has(nodePositionKey)
            ) {
                const warningRadius = radius * 2.175;
                const underlineY = warningRadius + radius * 0.5;

                this.ctx.beginPath();
                this.ctx.arc(0, 0, warningRadius, 0, Math.PI * 2);
                this.ctx.strokeStyle = DUPLICATE_NODE_WARNING_COLOR;
                this.ctx.lineWidth = Math.max(invScale, radius * 0.33);
                this.ctx.stroke();

                this.ctx.beginPath();
                this.ctx.moveTo(-warningRadius * 0.8, underlineY);
                this.ctx.lineTo(warningRadius * 0.8, underlineY);
                this.ctx.stroke();

                drawnDuplicateNodeWarningKeys?.add(nodePositionKey);
            }

            this.ctx.restore();
        });

        if (segmentPreview) {
            const previewPoints = segmentPreview.segments.flatMap((segment) => {
                if (segment.type === 'line') {
                    return [
                        {
                            point: segment.points[1],
                            type: 'oncurve'
                        }
                    ];
                }

                if (segment.type === 'quadratic') {
                    return [
                        {
                            point: segment.points[1],
                            type: 'offcurve'
                        },
                        {
                            point: segment.points[2],
                            type: 'oncurve'
                        }
                    ];
                }

                return [
                    {
                        point: segment.points[1],
                        type: 'offcurve'
                    },
                    {
                        point: segment.points[2],
                        type: 'offcurve'
                    },
                    {
                        point: segment.points[3],
                        type: 'oncurve'
                    }
                ];
            });

            previewPoints.slice(0, -1).forEach(({ point, type }) => {
                this.ctx.save();
                this.ctx.translate(point.x, point.y);
                this.applyInverseComponentTransform();
                const isOffCurve = type === 'offcurve';
                const isInsertedOnCurve =
                    !isOffCurve &&
                    addPointPreview !== null &&
                    Math.abs(point.x - addPointPreview.point.x) < 0.001 &&
                    Math.abs(point.y - addPointPreview.point.y) < 0.001;
                const isSmoothInsertPreview =
                    isInsertedOnCurve &&
                    addPointPreview.segments.some(
                        (segment) =>
                            segment.type === 'cubic' ||
                            segment.type === 'quadratic'
                    );
                const previewKind = isOffCurve
                    ? 'circle'
                    : this.isOnCurveDiamondNode(point.x, point.y)
                      ? 'diamond'
                      : isSmoothInsertPreview
                        ? 'circle'
                        : 'square';
                const previewRadius =
                    pointSize *
                    (isOffCurve
                        ? controlRatio
                        : isSmoothInsertPreview
                          ? smoothRatio
                          : 1) *
                    (previewKind === 'diamond' ? diamondRatio : 1);
                if (!isOffCurve && this.shouldPaintZoneHalo(point.x, point.y)) {
                    this.paintZoneHalo(
                        previewKind,
                        previewRadius,
                        strokeWidth,
                        desaturateColor(colors.NODE_ZONE_HALO_STROKE),
                        colors.NODE_ZONE_HALO_OPACITY,
                        this.getZoneHaloWidth(pointSize, previewKind)
                    );
                }
                this.paintOutlineChrome(
                    previewKind,
                    previewRadius,
                    desaturateColor(
                        isOffCurve
                            ? colors.CONTROL_POINT_OUTLINE
                            : colors.NODE_NORMAL
                    ),
                    null,
                    strokeWidth
                );
                if (isSmoothInsertPreview) {
                    this.ctx.beginPath();
                    this.ctx.arc(
                        0,
                        0,
                        pointSize * smoothRatio * smoothDotRatio,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.fillStyle = desaturateColor(
                        colors.NODE_SMOOTH_DOT
                    );
                    this.ctx.fill();
                }
                this.ctx.restore();
            });
        }
    }

    drawMarqueeSelectionRect() {
        const rect =
            this.glyphCanvas.outlineEditor.getVisibleMarqueeSelectionBox();
        if (!rect) {
            return;
        }

        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';

        this.ctx.save();
        this.ctx.fillStyle = isDarkTheme
            ? 'rgba(96, 165, 250, 0.05)'
            : 'rgba(37, 99, 235, 0.05)';
        this.ctx.strokeStyle = isDarkTheme
            ? 'rgba(147, 197, 253, 0.4)'
            : 'rgba(29, 78, 216, 0.35)';
        this.ctx.lineWidth = 1 * invScale;
        this.ctx.setLineDash([4 * invScale, 4 * invScale]);
        this.ctx.fillRect(rect.minX, rect.minY, rect.width, rect.height);
        this.ctx.strokeRect(rect.minX, rect.minY, rect.width, rect.height);
        this.ctx.restore();
    }

    drawUIOverlay() {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);

        const rect = this.canvas.getBoundingClientRect();
        const contentFrame = this.glyphCanvas.getCanvasContentFrame?.();
        const cssToCanvasX =
            rect.width > 0 ? this.canvas.width / rect.width : 1;
        const cssToCanvasY =
            rect.height > 0 ? this.canvas.height / rect.height : 1;
        const overlayLeft = (contentFrame?.left ?? 0) * cssToCanvasX;
        const overlayTop = (contentFrame?.top ?? 0) * cssToCanvasY;

        // Debug HUD (top left of the drawing slot) — development only;
        // skip in test mode for screenshot diffs
        if (window.isDevelopment?.() && !window.isTestMode?.()) {
            const isDarkTheme =
                document.documentElement.getAttribute('data-theme') !== 'light';
            this.ctx.fillStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 0.7)'
                : 'rgba(0, 0, 0, 0.7)';
            this.ctx.font = `${12 * cssToCanvasY}px monospace`;

            const hudX = overlayLeft + 10 * cssToCanvasX;
            const hudY = overlayTop;

            if (this.textRunEditor.textBuffer) {
                const textInfo = `Text: "${this.textRunEditor.textBuffer}" (${this.textRunEditor.shapedGlyphs.length} glyphs)`;
                this.ctx.fillText(textInfo, hudX, hudY + 20 * cssToCanvasY);
            }

            const panText = `Pan: (${Math.round(this.viewportManager.panX)}, ${Math.round(this.viewportManager.panY)})`;
            this.ctx.fillText(panText, hudX, hudY + 35 * cssToCanvasY);

            const zoomText = `Zoom: ${(this.viewportManager.scale * 100).toFixed(1)}%`;
            this.ctx.fillText(zoomText, hudX, hudY + 50 * cssToCanvasY);

            if (this.fps > 0) {
                const fpsText = `FPS: ${Math.round(this.fps)}`;
                this.ctx.fillText(fpsText, hudX, hudY + 65 * cssToCanvasY);
            }
        }

        const previewGuide = this.glyphCanvas.previewViewportGuide;
        if (
            previewGuide &&
            this.glyphCanvas.previewChromeOpacity < 1 &&
            rect.width > 0 &&
            rect.height > 0
        ) {
            const computedStyle = getComputedStyle(document.documentElement);
            const cssToCanvas = this.canvas.width / rect.width;
            this.ctx.save();
            this.ctx.strokeStyle = computedStyle
                .getPropertyValue('--text-muted')
                .trim();
            this.ctx.globalAlpha = 0.35;
            this.ctx.lineWidth = 1 * cssToCanvas;
            this.ctx.setLineDash([8 * cssToCanvas, 5 * cssToCanvas]);
            this.ctx.strokeRect(
                (previewGuide.left / rect.width) * this.canvas.width,
                (previewGuide.top / rect.height) * this.canvas.height,
                (previewGuide.width / rect.width) * this.canvas.width,
                (previewGuide.height / rect.height) * this.canvas.height
            );
            this.ctx.restore();
        }

        // Draw crosshair or a user-defined line when the measurement key is pressed in editing mode
        if (this.glyphCanvas.measurementTool.shouldDrawVisuals()) {
            const isDarkTheme =
                document.documentElement.getAttribute('data-theme') !== 'light';
            const colors = isDarkTheme
                ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
                : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
            this.ctx.save();
            if (
                contentFrame &&
                contentFrame.width > 0 &&
                contentFrame.height > 0 &&
                rect.width > 0 &&
                rect.height > 0
            ) {
                this.ctx.beginPath();
                this.ctx.rect(
                    (contentFrame.left / rect.width) * this.canvas.width,
                    (contentFrame.top / rect.height) * this.canvas.height,
                    (contentFrame.width / rect.width) * this.canvas.width,
                    (contentFrame.height / rect.height) * this.canvas.height
                );
                this.ctx.clip();
            }
            this.ctx.globalAlpha *=
                APP_SETTINGS.OUTLINE_EDITOR
                    .MEASUREMENT_TOOL_GUIDE_LINES_OPACITY *
                this.glyphCanvas.previewChromeOpacity;
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
                this.ctx.globalAlpha *=
                    APP_SETTINGS.OUTLINE_EDITOR
                        .MEASUREMENT_TOOL_GUIDE_LINES_OPACITY *
                    this.glyphCanvas.previewChromeOpacity;
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
                    overlayLeft + labelPadding,
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
                    overlayTop + labelPadding
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

        // Get glyph name from glyphNameBuffer (current shaped output)
        // instead of looking up GID in font manager (which uses full font glyph order)
        const glyphName =
            this.textRunEditor.glyphNameBuffer[selectedGlyphIndex] || '';

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

        const layout = this.textRunEditor._getGlyphPosition(selectedGlyphIndex);
        const glyph = this.textRunEditor.shapedGlyphs[selectedGlyphIndex];
        const x = layout.xPosition + (glyph.dx || 0);
        const y = layout.yOffset;

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

    private isExactOriginSnapReturn(
        snapVisualizationState: {
            snapTarget: {
                xSource: { source: string } | null;
                ySource: { source: string } | null;
                snappedX: number;
                snappedY: number;
            } | null;
            naturalPos: { x: number; y: number } | null;
            originPos: { x: number; y: number } | null;
        } | null
    ): boolean {
        const snapTarget = snapVisualizationState?.snapTarget;
        const originPos = snapVisualizationState?.originPos;
        if (!snapTarget || !originPos) {
            return false;
        }

        return (
            snapTarget.snappedX === originPos.x &&
            snapTarget.snappedY === originPos.y &&
            (snapTarget.xSource?.source === 'origin' ||
                snapTarget.ySource?.source === 'origin')
        );
    }

    /**
     * Draw snap visualization:
     * - Neighboring glyph snap nodes as faint dots
     * - Highlight the snap source node and draw a faint line to it
     */
    drawSnapVisualization() {
        // Only render when editing mode is active and we have a selected glyph
        if (
            !this.glyphCanvas.outlineEditor.active ||
            !this.glyphCanvas.outlineEditor.layerData
        ) {
            return;
        }

        if (
            this.textRunEditor.selectedGlyphIndex < 0 ||
            this.textRunEditor.selectedGlyphIndex >=
                this.textRunEditor.shapedGlyphs.length
        ) {
            return;
        }

        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        const layout = this.textRunEditor._getGlyphPosition(
            this.textRunEditor.selectedGlyphIndex
        );
        const glyph =
            this.textRunEditor.shapedGlyphs[
                this.textRunEditor.selectedGlyphIndex
            ];
        const x = layout.xPosition + (glyph.dx || 0);
        const y = layout.yOffset;

        const invScale = 1 / this.viewportManager.scale;

        this.ctx.save();
        this.ctx.translate(x, y);

        const snapVisualizationState =
            this.glyphCanvas.outlineEditor.getSnapVisualizationState();
        const closeTargets = snapVisualizationState?.closeTargets || [];
        const exactOriginReturn = this.isExactOriginSnapReturn(
            snapVisualizationState
        );
        const highlightLineColor = exactOriginReturn
            ? colors.CLOSE_TARGET
            : colors.SNAP_HIGHLIGHT_LINE;
        const highlightNodeColor = exactOriginReturn
            ? colors.CLOSE_TARGET
            : colors.SNAP_HIGHLIGHT_NODE;

        const isCloseTargetSnap = (snappedX: number, snappedY: number) =>
            closeTargets.some(
                (target) => target.x === snappedX && target.y === snappedY
            );

        this.ctx.save();
        this.ctx.globalAlpha *=
            APP_SETTINGS.OUTLINE_EDITOR.SNAP_VISUALIZATION_OPACITY;

        // ---- Neighboring glyph snap nodes ----
        {
            const candidates = snapVisualizationState?.debugCandidates || [];

            if (candidates.length > 0) {
                const dotRadius = 3 * invScale;
                this.ctx.save();
                this.ctx.fillStyle = colors.SNAP_DEBUG_NODE;
                this.ctx.strokeStyle = exactOriginReturn
                    ? colors.CLOSE_TARGET
                    : colors.SNAP_HIGHLIGHT_NODE;
                this.ctx.lineWidth = 1 * invScale;
                for (const c of candidates) {
                    if (c.source === 'origin') {
                        const originRadius = dotRadius * 1.75;
                        this.ctx.beginPath();
                        this.ctx.arc(c.x, c.y, originRadius, 0, Math.PI * 2);
                        this.ctx.stroke();

                        this.ctx.beginPath();
                        this.ctx.moveTo(c.x - originRadius, c.y);
                        this.ctx.lineTo(c.x + originRadius, c.y);
                        this.ctx.moveTo(c.x, c.y - originRadius);
                        this.ctx.lineTo(c.x, c.y + originRadius);
                        this.ctx.stroke();
                    } else {
                        this.ctx.beginPath();
                        this.ctx.arc(c.x, c.y, dotRadius, 0, Math.PI * 2);
                        this.ctx.fill();
                    }
                }
                this.ctx.restore();
            }
        }

        // ---- Snap highlight: one guide per active snap axis ----
        // xSource and ySource may be different nodes (independent axis snaps)
        // or the same node (exact XY point snap). Draw a guide for each.
        const snapTarget = snapVisualizationState?.snapTarget || null;
        const naturalPos = snapVisualizationState?.naturalPos || null;

        if (
            snapTarget &&
            naturalPos &&
            !isCloseTargetSnap(snapTarget.snappedX, snapTarget.snappedY)
        ) {
            const highlightRadius = 5 * invScale;
            const highlightRingRadius =
                highlightRadius * (exactOriginReturn ? 2.75 : 2);
            const lineWidth = 1 * invScale;
            const { xSource, ySource, snappedX, snappedY } = snapTarget;

            type SnapSrc = NonNullable<typeof xSource>;

            // Draw one guide: line from dragged node → snap candidate, circle
            // on the snap candidate.
            //
            // Exception — metric/edge sources: the snap is to an infinite line,
            // not a specific point. In that case the target circle is drawn on
            // the dragged node and the line runs from the natural position to
            // the dragged node.
            const drawGuide = (source: SnapSrc) => {
                const isLineSource =
                    source.source === 'metric' || source.source === 'edge';

                let lineStartX: number,
                    lineStartY: number,
                    lineEndX: number,
                    lineEndY: number,
                    targetX: number,
                    targetY: number;

                if (isLineSource) {
                    // Line: natural pos → snap result (shows the "pull")
                    lineStartX = naturalPos.x;
                    lineStartY = naturalPos.y;
                    lineEndX = snappedX;
                    lineEndY = snappedY;
                    // Target: on the dragged node (snap candidate is a line)
                    targetX = snappedX;
                    targetY = snappedY;
                } else {
                    // Line: dragged node (snapped position) → source candidate
                    lineStartX = snappedX;
                    lineStartY = snappedY;
                    lineEndX = source.x;
                    lineEndY = source.y;
                    // Target: on the source candidate node
                    targetX = source.x;
                    targetY = source.y;
                }

                this.ctx.save();
                this.ctx.strokeStyle = highlightLineColor;
                this.ctx.fillStyle = highlightNodeColor;
                this.ctx.lineWidth = lineWidth;

                // Draw the line only if it has non-zero length
                if (lineStartX !== lineEndX || lineStartY !== lineEndY) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(lineStartX, lineStartY);
                    this.ctx.lineTo(lineEndX, lineEndY);
                    this.ctx.stroke();
                }

                // Filled dot at target
                this.ctx.beginPath();
                this.ctx.arc(targetX, targetY, highlightRadius, 0, Math.PI * 2);
                this.ctx.fill();
                // Ring around target
                this.ctx.beginPath();
                this.ctx.arc(
                    targetX,
                    targetY,
                    highlightRingRadius,
                    0,
                    Math.PI * 2
                );
                this.ctx.stroke();

                this.ctx.restore();
            };

            // When both axes snap to the same object, draw one guide.
            // When they snap to different objects, draw one guide per axis.
            if (xSource && ySource && xSource === ySource) {
                drawGuide(xSource);
            } else {
                if (xSource) drawGuide(xSource);
                if (ySource) drawGuide(ySource);
            }

            // Extra origin guide for the combined (originX, metricY) case:
            // when a metric snap locked both axes (snapped to originX on X and
            // metricY on Y), also draw a line from the snapped position back to
            // the original node position so the user can see how far they've
            // moved vertically from the origin.
            const originPos = snapVisualizationState?.originPos || null;
            const isLineSnapXY =
                xSource &&
                ySource &&
                xSource === ySource &&
                (xSource.source === 'metric' || xSource.source === 'edge');
            if (isLineSnapXY && originPos) {
                // Only draw if the origin differs from the current snapped pos
                if (originPos.x !== snappedX || originPos.y !== snappedY) {
                    this.ctx.save();
                    this.ctx.strokeStyle = highlightLineColor;
                    this.ctx.fillStyle = highlightNodeColor;
                    this.ctx.lineWidth = lineWidth;

                    this.ctx.beginPath();
                    this.ctx.moveTo(snappedX, snappedY);
                    this.ctx.lineTo(originPos.x, originPos.y);
                    this.ctx.stroke();

                    // Filled dot at origin
                    this.ctx.beginPath();
                    this.ctx.arc(
                        originPos.x,
                        originPos.y,
                        highlightRadius,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.fill();
                    // Ring around origin
                    this.ctx.beginPath();
                    this.ctx.arc(
                        originPos.x,
                        originPos.y,
                        highlightRadius * 2,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.stroke();

                    this.ctx.restore();
                }
            }
        }

        this.ctx.restore();

        if (closeTargets.length > 0) {
            const targetRadius = 5 * invScale;
            this.ctx.save();
            this.ctx.strokeStyle = colors.CLOSE_TARGET;
            this.ctx.fillStyle = colors.CLOSE_TARGET;
            this.ctx.lineWidth = 1 * invScale;
            for (const target of closeTargets) {
                const ringRadius = targetRadius * (target.active ? 2.75 : 2);
                this.ctx.beginPath();
                this.ctx.arc(target.x, target.y, ringRadius, 0, Math.PI * 2);
                this.ctx.stroke();
                this.ctx.beginPath();
                this.ctx.moveTo(target.x - ringRadius, target.y);
                this.ctx.lineTo(target.x + ringRadius, target.y);
                this.ctx.moveTo(target.x, target.y - ringRadius);
                this.ctx.lineTo(target.x, target.y + ringRadius);
                this.ctx.stroke();
                if (target.active) {
                    this.ctx.beginPath();
                    this.ctx.arc(
                        target.x,
                        target.y,
                        targetRadius,
                        0,
                        Math.PI * 2
                    );
                    this.ctx.fill();
                }
            }
            this.ctx.restore();
        }

        this.ctx.restore();
    }

    drawMeasurementIntersections() {
        // Only draw when the measurement key is pressed, in editing mode, and we have layer data
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
        // via Rust WASM interpolation - this is already at the correct nesting level
        const layerData = this.glyphCanvas.outlineEditor.layerData;

        // Create a temporary Layer wrapper to use getIntersectionsOnLine()
        // Get the current glyph wrapper from the font model to enable component lookups
        const glyphName = this.glyphCanvas.outlineEditor.currentGlyphName;
        const glyphWrapper = glyphName
            ? (window as any).currentFontModel.findGlyph(glyphName)
            : null;

        // Find the matching Layer wrapper on the glyph to borrow stable metadata such as master.
        // The intersection math itself must use the live edited layerData so drag updates render immediately.
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

        const measurementLayerData = {
            ...(layerWrapper?.toJSON?.() || {}),
            ...layerData,
            id: layerData.id || layerWrapper?.id,
            master: layerData.master || layerWrapper?.master,
            width: layerData.width ?? layerWrapper?.width ?? layerData.width,
            shapes: layerData.shapes,
            anchors: layerData.anchors,
            guides: layerData.guides,
            format_specific:
                layerData.format_specific || layerWrapper?.format_specific
        };

        const tempLayer = new Layer([measurementLayerData], 0, glyphWrapper);

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

        const layout = this.textRunEditor._getGlyphPosition(
            this.textRunEditor.selectedGlyphIndex
        );
        const glyph =
            this.textRunEditor.shapedGlyphs[
                this.textRunEditor.selectedGlyphIndex
            ];
        const xOffset = glyph.dx || 0;
        const glyphWorldX = layout.xPosition + xOffset;
        const glyphWorldY = layout.yOffset;

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
        this.ctx.font = `${labelFontSize}px 'Inter UI', sans-serif`;
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

    buildPathFromNodes(
        nodes: Babelfont.Node[],
        closed = true,
        pathTarget?: Path2D
    ) {
        // Build a canvas path from a nodes array
        // pathTarget: if provided (Path2D object), draws to it; otherwise draws to this.ctx
        // Returns the startIdx for use in drawing direction arrows
        if (!nodes || nodes.length === 0) {
            return -1;
        }

        // Use the provided path target or default to canvas context
        const target = pathTarget || this.ctx;

        const startIdx = this.getPathStartIndex(nodes);

        const { x: startX, y: startY } = nodes[startIdx];
        target.moveTo(startX, startY);

        // Draw contour by looking ahead for control points
        const getNodeIndex = (offset: number): number | null => {
            const logicalIndex = startIdx + offset;

            if (closed) {
                return (
                    ((logicalIndex % nodes.length) + nodes.length) %
                    nodes.length
                );
            }

            return logicalIndex < nodes.length ? logicalIndex : null;
        };

        let i = 0;
        while (i < nodes.length) {
            const idx = getNodeIndex(i);
            const nextIdx = getNodeIndex(i + 1);
            const next2Idx = getNodeIndex(i + 2);
            const next3Idx = getNodeIndex(i + 3);

            if (idx === null || nextIdx === null) {
                break;
            }

            const { nodetype: type } = nodes[idx];
            const {
                x: next1X,
                y: next1Y,
                nodetype: next1Type
            } = nodes[nextIdx];

            // Check if we're at an on-curve point
            if (type !== 'OffCurve') {
                // We're at an on-curve point, look ahead for next segment
                if (next1Type === 'OffCurve') {
                    if (next2Idx === null) {
                        break;
                    }

                    // Next is off-curve - check if cubic (two consecutive off-curve)
                    const {
                        x: next2X,
                        y: next2Y,
                        nodetype: next2Type
                    } = nodes[next2Idx];

                    if (next2Type === 'OffCurve') {
                        if (next3Idx === null) {
                            break;
                        }

                        const { x: next3X, y: next3Y } = nodes[next3Idx];

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
                        const startIdx = this.getPathStartIndex(nodes);
                        target.lineTo(next2X, next2Y);
                        i += 2;
                    }
                } else if (next1Type !== 'Move') {
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

    private appendPreviewSegmentToPath(
        target: CanvasPath | Path2D,
        segment:
            | {
                  type: 'line' | 'quadratic' | 'cubic';
                  points: Array<{ x: number; y: number }>;
              }
            | {
                  type: 'line' | 'quadratic' | 'cubic';
                  points: Array<{ x: number; y: number }>;
              }
    ): void {
        if (segment.type === 'line') {
            target.lineTo(segment.points[1].x, segment.points[1].y);
            return;
        }

        if (segment.type === 'quadratic') {
            target.quadraticCurveTo(
                segment.points[1].x,
                segment.points[1].y,
                segment.points[2].x,
                segment.points[2].y
            );
            return;
        }

        target.bezierCurveTo(
            segment.points[1].x,
            segment.points[1].y,
            segment.points[2].x,
            segment.points[2].y,
            segment.points[3].x,
            segment.points[3].y
        );
    }

    private buildPathWithAddPointPreview(
        nodes: Babelfont.Node[],
        closed: boolean,
        preview: {
            segmentId: number;
            segments: Array<{
                type: 'line' | 'quadratic' | 'cubic';
                points: Array<{ x: number; y: number }>;
            }>;
        },
        pathTarget?: Path2D
    ): number {
        const descriptors = Layer.getPathSegmentDescriptors({ nodes, closed });
        if (!descriptors.length) {
            return this.buildPathFromNodes(nodes, closed, pathTarget);
        }

        const startIdx = this.getPathStartIndex(nodes);

        const target = pathTarget || this.ctx;
        target.moveTo(descriptors[0].points[0].x, descriptors[0].points[0].y);

        descriptors.forEach((descriptor) => {
            if (descriptor.segmentId === preview.segmentId) {
                preview.segments.forEach((segment) => {
                    this.appendPreviewSegmentToPath(target, segment);
                });
                return;
            }

            this.appendPreviewSegmentToPath(target, descriptor);
        });

        if (closed) {
            target.closePath();
        }

        return startIdx;
    }

    private getPathStartIndex(nodes: Babelfont.Node[]): number {
        let startIdx = 0;
        let foundMove = false;

        for (let i = 0; i < nodes.length; i++) {
            const { nodetype: type } = nodes[i];
            if (type === 'Move') {
                startIdx = i;
                foundMove = true;
                break;
            }
        }

        if (foundMove) {
            return startIdx;
        }

        for (let i = 0; i < nodes.length; i++) {
            const { nodetype: type } = nodes[i];
            if (type === 'Curve' || type === 'QCurve' || type === 'Line') {
                startIdx = i;
                break;
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

        const cursorX =
            this.glyphCanvas.featureChangeAnimator?.getInterpolatedAnchorFontX() ??
            this.textRunEditor.cursorX;

        this.ctx.strokeStyle = cursorColor;
        this.ctx.lineWidth = 2 * invScale;
        this.ctx.beginPath();
        this.ctx.moveTo(cursorX, (this.textRunEditor.cursorY || 0) + 1000);
        this.ctx.lineTo(cursorX, (this.textRunEditor.cursorY || 0) - 300);
        this.ctx.stroke();
    }

    /**
     * Draw shaped glyphs with stack preview for selected glyph
     */
    drawShapedGlyphsWithStackPreview() {
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

        // Clear glyph bounds for hit testing
        this.glyphCanvas.glyphBounds = [];

        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;

        this.textRunEditor.shapedGlyphs.forEach(
            (glyph: any, glyphIndex: number) => {
                const glyphId = glyph.g;
                const xAdvance = glyph.ax || 0;
                const pos = this.textRunEditor._getGlyphPosition(glyphIndex);
                const x = pos.xPosition + (glyph.dx || 0);
                const y = pos.yOffset;

                const glyphData = this.textRunEditor.hbFont
                    ? this.textRunEditor.hbFont.glyphToPath(glyphId)
                    : null;
                const pathBounds = glyphData
                    ? calculatePathBounds(glyphData)
                    : null;
                const isVisuallyEmpty =
                    this.glyphCanvas.isShapedGlyphVisuallyEmpty(glyphIndex);
                const metricsBand = isVisuallyEmpty
                    ? this.glyphCanvas.getTextModeVerticalMetricsBand()
                    : null;

                this.glyphCanvas.glyphBounds.push({
                    x: x,
                    y: y,
                    width: xAdvance,
                    height: isVisuallyEmpty
                        ? (metricsBand?.highest ?? 1000) -
                          (metricsBand?.lowest ?? 0)
                        : 1000,
                    x1: pathBounds ? pathBounds.minX : 0,
                    y1: pathBounds
                        ? pathBounds.minY
                        : isVisuallyEmpty
                          ? (metricsBand?.lowest ?? 0)
                          : 0,
                    x2: pathBounds ? pathBounds.maxX : xAdvance,
                    y2: pathBounds
                        ? pathBounds.maxY
                        : isVisuallyEmpty
                          ? (metricsBand?.highest ?? 1000)
                          : 1000,
                    isEmpty: isVisuallyEmpty
                });

                const isSelected =
                    glyphIndex === this.textRunEditor.selectedGlyphIndex;

                // For selected glyph, draw stack preview instead
                if (isSelected) {
                    this.drawStackPreview();
                } else {
                    // Draw other glyphs normally with HarfBuzz
                    this.ctx.fillStyle = colors.GLYPH_INACTIVE_IN_EDITOR;

                    if (glyphData) {
                        this.ctx.save();
                        this.ctx.translate(x, y);
                        const path = new Path2D(glyphData);
                        this.ctx.fill(path);
                        this.ctx.restore();
                    }
                }
            }
        );
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
        const selectionFill = 'rgba(100, 150, 255, 0.3)';
        const editorView = document.querySelector('#view-editor');
        const isEditorViewFocused =
            !!editorView && editorView.classList.contains('focused');

        console.log('[Renderer]', '=== Drawing Selection ===');
        console.log('[Renderer]', 'Selection range:', range);
        console.log(
            '[Renderer]',
            'Text:',
            `"${this.textRunEditor.textBuffer.slice(range.start, range.end)}"`
        );

        // Draw selection highlight for each cluster in range
        this.ctx.fillStyle = isEditorViewFocused
            ? selectionFill
            : desaturateColor(selectionFill);

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
            this.ctx.fillRect(
                highlightX,
                (cluster.y ?? 0) - 300,
                highlightWidth,
                1300
            );
        }

        console.log('[Renderer]', '========================');
    }

    /**
     * Draw measurement tool for text mode
     * Shows horizontal line at mouse Y position with distance measurements from glyph edges to outline intersections
     */
    drawTextModeMeasurements() {
        // Only draw when the measurement key is pressed, in text mode, and we have a font
        if (!this.glyphCanvas.measurementKeyPressed) return;

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
        const fontModel = window.currentFontModel;
        if (!fontModel || !fontModel.masters || fontModel.masters.length === 0)
            return;

        // In text mode, use selectedMasterId from textRunEditor
        // In edit mode, get master from selected layer
        let masterId = fontModel.masters[0].id;

        if (this.textRunEditor.selectedMasterId) {
            // Text mode: use the master ID set by autoSelectMatchingMaster
            masterId = this.textRunEditor.selectedMasterId;
        } else if (this.glyphCanvas.outlineEditor.selectedLayerId) {
            // Edit mode: find the master from the selected layer
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
                const xAdvance = glyph.ax || 0;
                const pos = this.textRunEditor._getGlyphPosition(glyphIndex);
                const glyphX = pos.xPosition + (glyph.dx || 0);
                const glyphY = pos.yOffset;

                // Get glyph name from glyphNameBuffer (current shaped output)
                // instead of looking up GID in font manager (which uses full font glyph order)
                const glyphName =
                    this.textRunEditor.glyphNameBuffer[glyphIndex];

                console.log('[TextMeasure] Found glyph name:', glyphName);
                if (!glyphName) {
                    console.log('[TextMeasure] No glyph name, skipping');
                    return;
                }

                // Find the glyph in the font model
                const fontModel = window.currentFontModel;
                if (!fontModel) {
                    console.log('[TextMeasure] No font model, skipping');
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
                    return;
                }

                // Find the layer for the selected master
                // Use the masterId determined at the start of this function
                if (!masterId) {
                    return;
                }

                console.log(
                    `[TextMeasure] ${glyphName}: Looking for master ${masterId}, available layers:`,
                    glyphWrapper.layers.map((l: any) => ({
                        id: l.id,
                        masterType: l.master?.type,
                        masterId: l.master?.master,
                        hasShapes: !!l.shapes,
                        shapeCount: l.shapes?.length || 0
                    }))
                );

                const layer = glyphWrapper.layers.find(
                    (l: any) => l.master && l.master.master === masterId
                );

                // Fallback: if no matching layer found, use the first layer
                const actualLayer = layer || glyphWrapper.layers[0];

                if (!actualLayer) {
                    console.log(
                        `[TextMeasure] ${glyphName}: No layer available!`
                    );
                    return;
                }

                console.log(
                    `[TextMeasure] ${glyphName}: Found layer with ${(actualLayer as any).shapes?.length || 0} shapes`
                );

                // Get the actual width from this layer (not from shaped glyph which may be from different master)
                const actualWidth = (actualLayer as any).width || xAdvance;

                console.log(
                    `[TextMeasure] ${glyphName}: shaped xAdvance=${xAdvance}, actual layer width=${actualWidth}`
                );

                // Calculate measurement Y in glyph-local space
                // mouseGlyphY is in font space (absolute Y), yOffset is the glyph's Y position
                // To get the Y coordinate within the glyph's own coordinate system, subtract yOffset
                const lineY = mouseGlyphY - glyphY;

                console.log(
                    `[TextMeasure] ${glyphName}: yOffset=${glyphY}, mouseGlyphY=${mouseGlyphY.toFixed(1)}, lineY=${lineY.toFixed(1)}, bbox=`,
                    (actualLayer as any).getBoundingBox(false)
                );

                // Use the Layer's sidebearing method to get measurements
                const sidebearings = (
                    actualLayer as any
                ).getSidebearingsAtHeight(lineY);

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
                    const lastIntersectionX = actualWidth - rightDistance;

                    // Transform to world space for drawing
                    const firstWorldX = firstIntersectionX + glyphX;
                    const firstWorldY = mouseGlyphY;
                    const lastWorldX = lastIntersectionX + glyphX;
                    const lastWorldY = mouseGlyphY;
                    const glyphLeftX = glyphX;
                    const glyphRightX = glyphX + actualWidth;

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

        const basePosition = this.getSelectedGlyphBasePosition();
        if (!basePosition) {
            return;
        }
        const { baseX, baseY } = basePosition;

        // Draw debug bounds if enabled
        if (
            this.glyphCanvas.stackPreviewAnimator.config.debugDrawBounds &&
            this.glyphCanvas.stackPreviewAnimator.debugBounds
        ) {
            const bounds = this.glyphCanvas.stackPreviewAnimator.debugBounds;
            const invScale = 1 / this.viewportManager.scale;

            this.ctx.save();
            this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
            this.ctx.lineWidth = 2 * invScale;
            this.ctx.setLineDash([10 * invScale, 5 * invScale]);
            this.ctx.strokeRect(
                bounds.minX,
                bounds.minY,
                bounds.maxX - bounds.minX,
                bounds.maxY - bounds.minY
            );
            this.ctx.restore();
        }

        const easedProgress = this.getStackPreviewEasedProgress();

        // Collect guide lines from ALL layers with outlines (not just max depth)
        interface PathOriginPair {
            topX: number;
            topY: number;
            baseX: number;
            baseY: number;
        }

        const guideLines: PathOriginPair[] = [];

        // Get diagonal angle from config
        const diagonalAngleRad =
            (this.glyphCanvas.stackPreviewAnimator.config.diagonalOffsetAngle *
                Math.PI) /
            180;

        // Get path origins from ALL layers - only outline paths, not components
        layerTree.forEach((node) => {
            // Skip layers without depth (base layer has no offset)
            if (node.depth === 0) return;

            const layerData = node.componentLayerData;
            if (!layerData || !layerData.shapes) return;

            layerData.shapes.forEach((shape: any) => {
                if ('Component' in shape) return; // Only process paths, not components

                const nodes = getNodesFromShape(shape);

                if (nodes && nodes.length > 0) {
                    // Find first on-curve point (origin)
                    for (let i = 0; i < nodes.length; i++) {
                        const { x, y, nodetype: type } = nodes[i];
                        if (
                            type === 'Curve' ||
                            type === 'QCurve' ||
                            type === 'Line'
                        ) {
                            // Calculate diagonal offset for this depth using config angle
                            const offsetDistance =
                                node.depth *
                                this.glyphCanvas.stackPreviewAnimator.config
                                    .verticalSpacing *
                                easedProgress;
                            const diagXOffset =
                                offsetDistance * Math.cos(diagonalAngleRad);
                            const diagYOffset =
                                offsetDistance * Math.sin(diagonalAngleRad);

                            // Top position (with offset applied)
                            const topX =
                                node.transform[0] * x +
                                node.transform[2] * y +
                                node.transform[4] +
                                baseX +
                                diagXOffset;
                            const topY =
                                node.transform[1] * x +
                                node.transform[3] * y +
                                node.transform[5] +
                                baseY +
                                diagYOffset;

                            // Base position (without offset - subtract the diagonal offset)
                            const baseX_pos = topX - diagXOffset;
                            const baseY_pos = topY - diagYOffset;

                            guideLines.push({
                                topX,
                                topY,
                                baseX: baseX_pos,
                                baseY: baseY_pos
                            });
                            break;
                        }
                    }
                }
            });
        });

        // Draw guide lines from top positions down to base positions (45° downward)
        console.log('[StackPreview] Guide lines:', {
            lineCount: guideLines.length,
            easedProgress
        });

        if (guideLines.length > 0) {
            const invScale = 1 / this.viewportManager.scale;
            const isDarkTheme =
                document.documentElement.getAttribute('data-theme') !== 'light';

            this.ctx.save();
            this.ctx.strokeStyle = isDarkTheme
                ? 'rgba(255, 255, 255, 0.3)'
                : 'rgba(0, 0, 0, 0.3)';
            this.ctx.lineWidth = 1 * invScale;
            this.ctx.setLineDash([5 * invScale, 5 * invScale]);

            for (const line of guideLines) {
                this.ctx.beginPath();
                this.ctx.moveTo(line.topX, line.topY);
                this.ctx.lineTo(line.baseX, line.baseY);
                this.ctx.stroke();
            }

            this.ctx.restore();
        }

        const animator = this.glyphCanvas.stackPreviewAnimator;
        const activeHighlightLayerTreeIndex =
            animator.hoveredLayerTreeIndex ??
            animator.highlightedLayerTreeIndex;
        const animationProgress = this.getStackPreviewAnimationProgress();

        const isSamePath = (pathA: number[], pathB: number[]): boolean => {
            if (pathA.length !== pathB.length) {
                return false;
            }
            for (let i = 0; i < pathA.length; i++) {
                if (pathA[i] !== pathB[i]) {
                    return false;
                }
            }
            return true;
        };

        const getLayerOpacity = (node: any): number => {
            // Entering stack preview: keep the origin layer fully visible and fade in all others.
            if (animator.isAnimating && !animator.isReversing) {
                const isOriginLayer = isSamePath(
                    node.componentPath,
                    animator.highlightedComponentPath
                );
                return isOriginLayer ? 1 : animationProgress;
            }

            // Exiting via double-click: keep only the exact target layer fully visible,
            // while all other layers fade out continuously.
            if (
                animator.isAnimating &&
                animator.isReversing &&
                animator.transitionTargetComponentPath
            ) {
                const isTargetLayer = isSamePath(
                    node.componentPath,
                    animator.transitionTargetComponentPath
                );
                return isTargetLayer ? 1 : animationProgress;
            }

            return 1;
        };

        const getLayerOpacitySafe = (node: any): number => {
            const opacity = getLayerOpacity(node);
            if (opacity < 0) {
                return 0;
            }
            if (opacity > 1) {
                return 1;
            }
            return opacity;
        };

        // Render all layers with animated diagonal offset (45° to top-right)
        layerTree.forEach((node, layerTreeIndex) => {
            const layerOpacity = getLayerOpacitySafe(node);
            if (layerOpacity <= 0.001) {
                return;
            }

            this.ctx.save();
            this.ctx.globalAlpha *= layerOpacity;

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

            // Apply animated diagonal offset using config angle
            const offsetDistance =
                node.depth *
                this.glyphCanvas.stackPreviewAnimator.config.verticalSpacing *
                easedProgress;
            const diagonalAngleRad =
                (this.glyphCanvas.stackPreviewAnimator.config
                    .diagonalOffsetAngle *
                    Math.PI) /
                180;
            const xOffset = offsetDistance * Math.cos(diagonalAngleRad);
            const yOffset = offsetDistance * Math.sin(diagonalAngleRad);
            this.ctx.translate(xOffset, yOffset);

            // Draw this component instance
            this.drawComponentInstance(node);

            if (
                activeHighlightLayerTreeIndex !== null &&
                layerTreeIndex === activeHighlightLayerTreeIndex
            ) {
                this.drawStackPreviewLayerHighlight(node);
            }

            this.ctx.restore();
        });
    }

    private strokeLayerOutlinesRecursively(layerData: Babelfont.Layer): void {
        if (!layerData?.shapes) {
            return;
        }

        for (const shape of layerData.shapes) {
            if ('reference' in shape) {
                const nestedLayerData = (shape as any).layerData;
                if (!nestedLayerData?.shapes) {
                    continue;
                }

                const transformRaw =
                    (shape as any).transform ||
                    DecomposedAffineTransform.identity();
                const transform = Array.isArray(transformRaw)
                    ? transformRaw
                    : DecomposedAffineTransform.toAffine(transformRaw);

                this.ctx.save();
                this.ctx.transform(
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                );
                this.strokeLayerOutlinesRecursively(nestedLayerData);
                this.ctx.restore();
                continue;
            }

            const nodes =
                getNodesFromShape(shape) || getNodesFromOutlineShape(shape);
            if (!nodes || nodes.length === 0) {
                continue;
            }

            const closed = getClosedFromOutlineShape(shape);

            this.ctx.beginPath();
            this.buildPathFromNodes(nodes, closed);
            if (closed) {
                this.ctx.closePath();
            }
            this.ctx.stroke();
        }
    }

    private drawStackPreviewLayerHighlight(node: any): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const animator = this.glyphCanvas.stackPreviewAnimator;
        const highlightFade =
            animator.isAnimating && animator.isReversing
                ? this.getStackPreviewAnimationProgress()
                : 1;

        this.ctx.save();
        this.ctx.globalAlpha *= highlightFade;
        this.ctx.strokeStyle = isDarkTheme
            ? 'rgba(255, 255, 255, 0.14)'
            : 'rgba(0, 0, 0, 0.12)';
        this.ctx.lineWidth = 10 / this.viewportManager.scale;
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';

        this.strokeLayerOutlinesRecursively(node.componentLayerData);

        this.ctx.restore();
    }

    drawStackPreviewHoverLabel(): void {
        const animator = this.glyphCanvas.stackPreviewAnimator;
        if (!animator.shouldRenderStackPreview()) {
            return;
        }

        const hoveredLayerTreeIndex = animator.hoveredLayerTreeIndex;
        if (hoveredLayerTreeIndex === null) {
            return;
        }

        const node = animator.layerTree[hoveredLayerTreeIndex];
        if (!node) {
            return;
        }

        const basePosition = this.getSelectedGlyphBasePosition();
        if (!basePosition) {
            return;
        }

        const easedProgress = this.getStackPreviewEasedProgress();
        const diagonalAngleRad =
            (animator.config.diagonalOffsetAngle * Math.PI) / 180;
        const offsetDistance =
            node.depth * animator.config.verticalSpacing * easedProgress;

        const localBounds = this.getLayerLocalBounds(node.componentLayerData);
        let labelX =
            basePosition.baseX +
            node.transform[4] +
            offsetDistance * Math.cos(diagonalAngleRad);
        let labelY =
            basePosition.baseY +
            node.transform[5] +
            offsetDistance * Math.sin(diagonalAngleRad) -
            100;

        if (localBounds) {
            const corners = [
                this.transformPointWithAffine(
                    localBounds.minX,
                    localBounds.minY,
                    node.transform
                ),
                this.transformPointWithAffine(
                    localBounds.maxX,
                    localBounds.minY,
                    node.transform
                ),
                this.transformPointWithAffine(
                    localBounds.minX,
                    localBounds.maxY,
                    node.transform
                ),
                this.transformPointWithAffine(
                    localBounds.maxX,
                    localBounds.maxY,
                    node.transform
                )
            ];

            const transformedMinX = Math.min(...corners.map((p) => p.x));
            const transformedMaxX = Math.max(...corners.map((p) => p.x));
            const transformedMinY = Math.min(...corners.map((p) => p.y));

            labelX =
                basePosition.baseX +
                (transformedMinX + transformedMaxX) / 2 +
                offsetDistance * Math.cos(diagonalAngleRad);
            labelY =
                basePosition.baseY +
                transformedMinY -
                100 +
                offsetDistance * Math.sin(diagonalAngleRad);
        }

        const labelText =
            node.glyphName || this.glyphCanvas.getCurrentGlyphName();
        this.drawHoverLabel(
            labelText,
            labelX,
            labelY,
            1 / this.viewportManager.scale
        );
    }

    /**
     * Draw a single component instance in stack preview mode
     * Draw paths and component boxes, but DON'T recurse into nested components
     */
    drawComponentInstance(node: any): void {
        const layerData = node.componentLayerData;
        if (!layerData || !layerData.shapes) return;

        const invScale = 1 / this.viewportManager.scale;
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT;
        const isAutomaticComponentLayer =
            isAutomaticallyAlignedComponentLayer(layerData);

        // Draw paths (not components)
        layerData.shapes.forEach((shape: any, index: number) => {
            if ('reference' in shape) return;
            this.drawShape(shape, index, false);
        });

        // Draw blue boxes for components (same as normal editing mode)
        layerData.shapes.forEach((shape: any, index: number) => {
            if (!('reference' in shape)) return;

            if (!shape.layerData || !shape.layerData.shapes) return;

            const transformRaw =
                shape.transform || DecomposedAffineTransform.identity();
            const transform = Array.isArray(transformRaw)
                ? transformRaw
                : DecomposedAffineTransform.toAffine(transformRaw);
            const [a, b, c, d, tx, ty] = transform;

            this.ctx.save();
            this.ctx.transform(a, b, c, d, tx, ty);

            // Draw the component's flattened outline (blue box) using existing function
            this.drawComponentWithOutlines(
                shape.layerData.shapes,
                false,
                false,
                isAutomaticComponentLayer,
                false,
                invScale,
                isDarkTheme
            );

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
        const isAutomaticComponentLayer =
            isAutomaticallyAlignedComponentLayer(layerData);
        // Draw filled background
        this.ctx.save();
        this.ctx.beginPath();

        layerData.shapes.forEach((shape: any) => {
            if ('reference' in shape) return;

            const nodes = getNodesFromShape(shape);
            const closed = getClosedFromOutlineShape(shape);

            if (nodes && nodes.length > 0 && closed) {
                this.buildPathFromNodes(nodes, closed);
                this.ctx.closePath();
            }
        });

        this.ctx.fillStyle = this.getPathFillColor(isDarkTheme);
        this.ctx.fill();
        this.ctx.restore();

        // Draw paths
        layerData.shapes.forEach((shape: any, index: number) =>
            this.drawShape(shape, index, false)
        );

        // Draw components
        layerData.shapes.forEach((shape: any, index: number) => {
            if (!('reference' in shape)) return;

            if (!shape.layerData || !shape.layerData.shapes) return;

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
            const transformRaw =
                shape.transform || DecomposedAffineTransform.identity();
            const transform = Array.isArray(transformRaw)
                ? transformRaw
                : DecomposedAffineTransform.toAffine(transformRaw);
            const [a, b, c, d, tx, ty] = transform;

            this.ctx.save();
            this.ctx.transform(a, b, c, d, tx, ty);

            // Draw component outlines
            this.drawComponentWithOutlines(
                shape.layerData.shapes,
                isSelected,
                isHovered,
                isAutomaticComponentLayer,
                false,
                invScale,
                isDarkTheme
            );

            this.ctx.restore();
        });
    }

    /**
     * Draw component with flattened outline shapes using explicit path fill and stroke.
     * Reusable method for both normal editing mode and stack preview.
     */
    private drawComponentWithOutlines(
        shapes: any[],
        isSelected: boolean,
        isHovered: boolean,
        isAutomatic: boolean,
        isInterpolated: boolean,
        invScale: number,
        isDarkTheme: boolean,
        skipFill = false
    ): void {
        type FlattenedOutlineShape = {
            nodes: any[];
            transform: number[] | null;
            closed: boolean;
            subtract: boolean;
        };

        // Collect all outline shapes (non-component shapes with nodes) at each nesting level
        const collectOutlineShapes = (
            shapes: any[],
            transform: number[] | null = null
        ): FlattenedOutlineShape[] => {
            const outlineShapes: FlattenedOutlineShape[] = [];

            shapes.forEach((componentShape) => {
                if ('reference' in componentShape) {
                    let nestedTransform = transform;
                    if (componentShape.transform) {
                        const transformRaw = componentShape.transform;
                        const t = Array.isArray(transformRaw)
                            ? transformRaw
                            : DecomposedAffineTransform.toAffine(transformRaw);
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
                        componentShape.layerData &&
                        componentShape.layerData.shapes
                    ) {
                        outlineShapes.push(
                            ...collectOutlineShapes(
                                componentShape.layerData.shapes,
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
                        transform: transform,
                        closed: Boolean(componentShape.closed),
                        subtract: outlineShapeIsSubtraction(componentShape)
                    });
                }
            });

            return outlineShapes;
        };

        const outlineShapes = collectOutlineShapes(shapes);

        if (outlineShapes.length === 0) return;

        const fills = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS;

        let fillColor = isAutomatic
            ? isSelected
                ? fills.AUTO_SELECTED
                : isHovered
                  ? fills.AUTO_HOVERED
                  : fills.AUTO_NORMAL
            : isSelected
              ? fills.MANUAL_SELECTED
              : isHovered
                ? fills.MANUAL_HOVERED
                : fills.MANUAL_NORMAL;

        // Convert to rgba format for consistent alpha handling
        fillColor = toRgba(fillColor);

        if (isInterpolated) {
            fillColor = desaturateColor(fillColor);
        }

        const strokeColor = adjustGlyphRestingColor(
            fillColor,
            -APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_STROKE_DARKEN_PERCENT
        );

        this.ctx.shadowBlur = 0;
        this.ctx.shadowColor = 'transparent';
        if (!skipFill) {
            this.ctx.beginPath();
            outlineShapes.forEach(({ nodes, transform, closed }) => {
                if (!closed) {
                    return;
                }

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
                this.buildPathFromNodes(nodes, closed);
                this.ctx.closePath();
                if (transform) this.ctx.restore();
            });
            this.ctx.fillStyle = fillColor;
            this.ctx.fill();
        }

        // Stroke all explicit component paths so manual and automatic components
        // stay visually distinct from neighboring inactive glyph fills.
        const subtractionDash = this.subtractionOutlineDash(invScale);
        outlineShapes.forEach(({ nodes, transform, closed, subtract }) => {
            this.ctx.save();
            if (transform) {
                this.ctx.transform(
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                );
            }
            this.ctx.beginPath();
            this.buildPathFromNodes(nodes, closed);
            if (closed) {
                this.ctx.closePath();
            }
            this.ctx.strokeStyle = strokeColor;
            this.ctx.lineWidth =
                APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_STROKE_WIDTH * invScale;
            this.ctx.setLineDash(subtract ? subtractionDash : []);
            this.ctx.stroke();
            this.ctx.restore();
        });
    }
}
