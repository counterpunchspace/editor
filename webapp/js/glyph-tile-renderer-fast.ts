// Fast Glyph Tile Renderer
// Renders glyph outlines directly to canvas elements without data URL conversion
// Uses a shared offscreen canvas for path building, then draws to target canvases

import { LayerDataNormalizer } from './layer-data-normalizer';

interface RenderMetrics {
    ascender: number;
    descender: number;
    upm: number;
}

interface GlyphOutlineData {
    name: string;
    width: number;
    shapes: any[];
    bounds: {
        xMin: number;
        yMin: number;
        xMax: number;
        yMax: number;
    };
}

class FastGlyphTileRenderer {
    private componentColor: string = '';
    private pathColor: string = '';
    private colorsInitialized: boolean = false;

    constructor() {
        // Colors will be initialized lazily on first render
    }

    /**
     * Update cached theme colors from CSS variables
     */
    public updateThemeColors(): void {
        const computedStyle = getComputedStyle(document.documentElement);
        this.componentColor = computedStyle
            .getPropertyValue('--glyph-overview-component-color')
            .trim();
        this.pathColor = computedStyle
            .getPropertyValue('--glyph-overview-path-color')
            .trim();
        this.colorsInitialized = true;
    }

    /**
     * Ensure colors are initialized before rendering
     */
    private ensureColorsInitialized(): void {
        if (
            !this.colorsInitialized ||
            !this.componentColor ||
            !this.pathColor
        ) {
            this.updateThemeColors();
        }
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

        // Scale to fit metrics height in drawing area
        const scale = (drawHeight - padding * 2) / metricsHeight;

        // Center horizontally based on glyph visual bounds
        const bounds = glyphData.bounds;
        const glyphVisualCenterX = (bounds.xMin + bounds.xMax) / 2;
        const tileCenterX = drawWidth / 2;
        const offsetX = tileCenterX - glyphVisualCenterX * scale;

        // Y offset: position so ascender is at top of drawing area
        const offsetY = padding + ascender * scale;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, -scale); // Flip Y axis

        // Draw shapes
        this.drawShapes(
            ctx,
            glyphData.shapes,
            this.componentColor,
            this.pathColor,
            null,
            false
        );

        ctx.restore();

        return canvas;
    }

    /**
     * Recursively draw shapes (paths and components)
     */
    private drawShapes(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        componentColor: string,
        pathColor: string,
        parentTransform: number[] | null,
        insideComponent: boolean
    ): void {
        // First pass: draw all regular paths
        ctx.beginPath();
        this.buildPathsOnly(ctx, shapes);
        ctx.fillStyle = insideComponent ? componentColor : pathColor;
        ctx.fill();

        // Second pass: combine ALL component paths, then fill once
        const hasComponents = shapes.some((s) => s.Component);
        if (hasComponents) {
            ctx.beginPath();
            for (const shape of shapes) {
                if (shape.Component) {
                    const component = shape.Component;
                    const transform = component.transform || [1, 0, 0, 1, 0, 0];

                    const finalTransform = parentTransform
                        ? this.multiplyTransforms(parentTransform, transform)
                        : transform;

                    if (component.layerData && component.layerData.shapes) {
                        ctx.save();
                        ctx.transform(
                            finalTransform[0],
                            finalTransform[1],
                            finalTransform[2],
                            finalTransform[3],
                            finalTransform[4],
                            finalTransform[5]
                        );
                        this.buildComponentPaths(
                            ctx,
                            component.layerData.shapes
                        );
                        ctx.restore();
                    }
                }
            }
            ctx.fillStyle = componentColor;
            ctx.fill();
        }
    }

    /**
     * Build all paths from component shapes recursively
     */
    private buildComponentPaths(
        ctx: CanvasRenderingContext2D,
        shapes: any[]
    ): void {
        for (const shape of shapes) {
            if (shape.Path) {
                let nodes = shape.Path.nodes;
                if (typeof nodes === 'string') {
                    nodes = LayerDataNormalizer.parseNodes(nodes);
                }
                if (nodes && nodes.length > 0) {
                    LayerDataNormalizer.buildPathFromNodes(nodes, ctx);
                    ctx.closePath();
                }
            } else if (shape.Component) {
                const component = shape.Component;
                const transform = component.transform || [1, 0, 0, 1, 0, 0];
                if (component.layerData && component.layerData.shapes) {
                    ctx.save();
                    ctx.transform(
                        transform[0],
                        transform[1],
                        transform[2],
                        transform[3],
                        transform[4],
                        transform[5]
                    );
                    this.buildComponentPaths(ctx, component.layerData.shapes);
                    ctx.restore();
                }
            }
        }
    }

    /**
     * Build combined path from regular paths only
     */
    private buildPathsOnly(ctx: CanvasRenderingContext2D, shapes: any[]): void {
        for (const shape of shapes) {
            if (shape.Path) {
                let nodes = shape.Path.nodes;
                if (typeof nodes === 'string') {
                    nodes = LayerDataNormalizer.parseNodes(nodes);
                }
                if (nodes && nodes.length > 0) {
                    LayerDataNormalizer.buildPathFromNodes(nodes, ctx);
                    ctx.closePath();
                }
            }
        }
    }

    /**
     * Multiply two transformation matrices
     */
    private multiplyTransforms(t1: number[], t2: number[]): number[] {
        const [a1, b1, c1, d1, tx1, ty1] = t1;
        const [a2, b2, c2, d2, tx2, ty2] = t2;
        return [
            a1 * a2 + b1 * c2,
            a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2,
            c1 * b2 + d1 * d2,
            a1 * tx2 + c1 * ty2 + tx1,
            b1 * tx2 + d1 * ty2 + ty1
        ];
    }
}

// Export singleton instance
export const fastGlyphTileRenderer = new FastGlyphTileRenderer();
