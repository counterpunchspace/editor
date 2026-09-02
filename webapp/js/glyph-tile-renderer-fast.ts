// Fast Glyph Tile Renderer
// Renders glyph outlines directly to canvas elements without data URL conversion
// Uses a shared offscreen canvas for path building, then draws to target canvases

import { pathHasSubtractionFlag } from './path-boolean-flag';
import {
    fillPunchFillContoursOnContext,
    type PunchFillContour
} from './punch-fill-contours';
import {
    buildGlyphPathFromNodes,
    calculateGlyphShapeBounds,
    multiplyAffineTransforms,
    normalizeAffineTransform,
    transformPointWithAffine
} from './glyph-path-geometry';
import { Logger } from './logger';
import APP_SETTINGS from './settings';

const console = new Logger('GlyphTileRendererFast');

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

interface RenderMetrics {
    ascender: number;
    descender: number;
    upm: number;
}

interface GlyphOutlineData {
    name: string;
    width: number;
    shapes?: any[];
    bounds?: {
        xMin: number;
        yMin: number;
        xMax: number;
        yMax: number;
    };
}

function isIdentityAffine(affine: number[]): boolean {
    return (
        affine[0] === 1 &&
        affine[1] === 0 &&
        affine[2] === 0 &&
        affine[3] === 1 &&
        affine[4] === 0 &&
        affine[5] === 0
    );
}

function transformOutlineNodes(nodes: any[], affine: number[]): any[] {
    if (isIdentityAffine(affine)) {
        return nodes;
    }
    return nodes.map((node) => {
        const point = transformPointWithAffine(affine, node.x, node.y);
        return { ...node, x: point.x, y: point.y };
    });
}

function pathIsClosed(shape: any, data: any): boolean {
    if (data && 'closed' in data) {
        return Boolean(data.closed);
    }
    if (shape && 'closed' in shape) {
        return Boolean(shape.closed);
    }
    return true;
}

function pathIsSubtraction(shape: any, data: any): boolean {
    return (
        pathHasSubtractionFlag(data?.format_specific) ||
        pathHasSubtractionFlag(shape?.format_specific)
    );
}

/**
 * Flatten paths and nested components in shape order for overview punch-out.
 */
export function collectOverviewPunchFillContours(
    shapes: any[] | undefined,
    affine: number[],
    fillStyle: string,
    componentFillFor?: (component: any) => string
): PunchFillContour[] {
    const contours: PunchFillContour[] = [];
    if (!Array.isArray(shapes)) {
        return contours;
    }
    for (const shape of shapes) {
        if (!shape || typeof shape !== 'object') {
            continue;
        }
        if ('reference' in shape || 'Component' in shape) {
            const inner =
                shape.Component && typeof shape.Component === 'object'
                    ? shape.Component
                    : shape;
            const childAffine = multiplyAffineTransforms(
                affine,
                normalizeAffineTransform(inner.transform)
            );
            const childFill = componentFillFor
                ? componentFillFor(inner)
                : fillStyle;
            contours.push(
                ...collectOverviewPunchFillContours(
                    inner.layerData?.shapes,
                    childAffine,
                    childFill
                )
            );
            continue;
        }
        const data =
            shape.Path && typeof shape.Path === 'object'
                ? shape.Path
                : shape.Contour && typeof shape.Contour === 'object'
                  ? shape.Contour
                  : shape;
        if (!pathIsClosed(shape, data)) {
            continue;
        }
        const nodes = data.nodes;
        if (!nodes?.length) {
            continue;
        }
        contours.push({
            nodes: transformOutlineNodes(nodes, affine),
            subtract: pathIsSubtraction(shape, data),
            fillStyle
        });
    }
    return contours;
}

class FastGlyphTileRenderer {
    private autoComponentColor: string = '';
    private manualComponentColor: string = '';
    private pathColor: string = '';
    private colorsInitialized: boolean = false;

    constructor() {
        // Colors will be initialized lazily on first render
    }

    /**
     * Update cached theme colors from settings
     */
    public updateThemeColors(): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const overviewColors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_LIGHT;
        const fills = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS;
        this.autoComponentColor = fills.AUTO_NORMAL;
        this.manualComponentColor = fills.MANUAL_NORMAL;
        this.pathColor = overviewColors.PATH;
        this.colorsInitialized = true;
    }

    /**
     * Ensure colors are initialized before rendering
     */
    private ensureColorsInitialized(): void {
        if (
            !this.colorsInitialized ||
            !this.autoComponentColor ||
            !this.manualComponentColor ||
            !this.pathColor
        ) {
            this.updateThemeColors();
        }
    }

    private toFiniteNumber(value: unknown, fallback: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return value;
    }

    private getSafeBounds(glyphData: GlyphOutlineData): {
        xMin: number;
        xMax: number;
    } {
        const computedBounds = this.getVisualBoundsFromShapes(
            Array.isArray(glyphData?.shapes) ? glyphData.shapes : []
        );
        if (computedBounds) {
            return {
                xMin: computedBounds.xMin,
                xMax: computedBounds.xMax
            };
        }

        const bounds = glyphData?.bounds;
        if (!bounds || typeof bounds !== 'object') {
            return { xMin: 0, xMax: 0 };
        }

        const xMin = this.toFiniteNumber((bounds as any).xMin, 0);
        const xMax = this.toFiniteNumber((bounds as any).xMax, xMin);
        if (xMax < xMin) {
            return { xMin: xMax, xMax: xMin };
        }

        return { xMin, xMax };
    }

    private getVisualBoundsFromShapes(
        shapes: any[],
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): {
        xMin: number;
        xMax: number;
        yMin: number;
        yMax: number;
    } | null {
        const bounds = calculateGlyphShapeBounds(shapes, parentTransform);
        if (!bounds) {
            return null;
        }

        return {
            xMin: bounds.minX,
            xMax: bounds.maxX,
            yMin: bounds.minY,
            yMax: bounds.maxY
        };
    }

    /**
     * Render a glyph directly to a canvas element
     * Reuses existing canvas if provided, creates new one otherwise
     */
    public renderToCanvas(
        glyphData: GlyphOutlineData,
        metrics: RenderMetrics | undefined,
        width: number,
        height: number,
        existingCanvas?: HTMLCanvasElement
    ): HTMLCanvasElement {
        this.ensureColorsInitialized();

        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(width * dpr);
        const canvasHeight = Math.round(height * dpr);

        // Reuse existing canvas or create new one
        const canvas = existingCanvas || document.createElement('canvas');

        // Only resize if dimensions changed
        if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) {
            return canvas;
        }

        // Clear and reset transform
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Scale for hi-dpi
        ctx.scale(dpr, dpr);

        // Calculate drawing area (reserve space at bottom for label)
        const labelHeight = Math.max(8, height * 0.16);
        const drawHeight = height - labelHeight;
        const drawWidth = width;
        const padding = 2;

        // Use provided metrics or calculate defaults
        const upm = metrics?.upm || 1000;
        const ascender = metrics?.ascender ?? upm * 0.75;
        const descender = metrics?.descender ?? -(upm * 0.25);
        const metricsHeight = ascender - descender;

        if (metricsHeight === 0) {
            return canvas;
        }

        // Scale to fit metrics height in drawing area (0.7 factor to draw 30% smaller)
        const scale = ((drawHeight - padding * 2) / metricsHeight) * 0.7;
        if (!Number.isFinite(scale) || scale <= 0) {
            return canvas;
        }

        // Center horizontally based on glyph visual bounds
        const bounds = this.getSafeBounds(glyphData);
        const glyphVisualCenterX = (bounds.xMin + bounds.xMax) / 2;
        const tileCenterX = drawWidth / 2;
        const offsetX = tileCenterX - glyphVisualCenterX * scale;

        // Y offset: position so ascender is at top of drawing area, shifted down 20% of tile height
        const offsetY = padding + ascender * scale + height * 0.2;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, -scale); // Flip Y axis

        // Draw shapes in layer order so subtraction cutters punch holes.
        const shapes = Array.isArray(glyphData?.shapes) ? glyphData.shapes : [];
        this.drawShapes(ctx, shapes);

        ctx.restore();

        return canvas;
    }

    /**
     * Draw paths and components in shape order, punching subtraction cutters.
     */
    private drawShapes(ctx: CanvasRenderingContext2D, shapes: any[]): void {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return;
        }

        const contours = collectOverviewPunchFillContours(
            shapes,
            [1, 0, 0, 1, 0, 0],
            this.pathColor,
            (component) =>
                this.isAutomaticallyAlignedComponent(component)
                    ? this.autoComponentColor
                    : this.manualComponentColor
        );
        fillPunchFillContoursOnContext(ctx, contours, (target, nodes) => {
            buildGlyphPathFromNodes(nodes as any[], target);
            target.closePath();
        });
    }

    private isAutomaticallyAlignedComponent(component: any): boolean {
        if (!component || typeof component !== 'object') {
            return false;
        }
        if (component.automaticAlignment === true) {
            return true;
        }
        return (
            component.format_specific?.[GLYPHS_COMPONENT_ALIGNMENT_KEY] === 1
        );
    }
}

// Export singleton instance
export const fastGlyphTileRenderer = new FastGlyphTileRenderer();
