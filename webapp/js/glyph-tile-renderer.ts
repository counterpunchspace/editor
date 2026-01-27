// Glyph Tile Renderer
// Renders glyph outlines into small canvas tiles for the overview
// Reuses LayerDataNormalizer for node parsing and path building

import { LayerDataNormalizer } from './layer-data-normalizer';

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

interface RenderMetrics {
    ascender: number;
    descender: number;
    upm: number;
}

export class GlyphTileRenderer {
    private tileWidth: number;
    private tileHeight: number;
    private padding: number;

    constructor(
        tileWidth: number = 30,
        tileHeight: number = 50,
        padding: number = 2
    ) {
        this.tileWidth = tileWidth;
        this.tileHeight = tileHeight;
        this.padding = padding;
    }

    /**
     * Render a glyph outline into a canvas element
     * @param glyphData - Glyph outline data with shapes and bounds
     * @param metrics - Optional ascender/descender/upm for consistent sizing. Defaults to 750/-250 for 1000upm.
     * @param tileWidth - Override tile width (optional)
     * @param tileHeight - Override tile height (optional)
     */
    public renderGlyph(
        glyphData: GlyphOutlineData,
        metrics?: RenderMetrics,
        tileWidth?: number,
        tileHeight?: number
    ): HTMLCanvasElement {
        const width = tileWidth ?? this.tileWidth;
        const height = tileHeight ?? this.tileHeight;
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');

        // Set canvas size for hi-dpi
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error(
                '[GlyphTileRenderer]',
                'Failed to get canvas context'
            );
            return canvas;
        }

        // Scale context for hi-dpi
        ctx.scale(dpr, dpr);

        // Calculate drawing area (reserve space at bottom for label)
        const labelHeight = Math.max(8, height * 0.16); // Scale label height
        const drawHeight = height - labelHeight;
        const drawWidth = width;

        // Use provided metrics or calculate defaults based on upm
        const upm = metrics?.upm || 1000;
        const ascender = metrics?.ascender ?? upm * 0.75; // Default: 750 for 1000upm
        const descender = metrics?.descender ?? -(upm * 0.25); // Default: -250 for 1000upm

        // Total vertical range from descender to ascender
        const metricsHeight = ascender - descender;

        if (metricsHeight === 0) {
            return canvas;
        }

        // Scale to fit metrics height in drawing area (with padding)
        const scale = (drawHeight - this.padding * 2) / metricsHeight;

        // Center horizontally based on glyph visual bounds (not advance width)
        const bounds = glyphData.bounds;
        const glyphVisualCenterX = (bounds.xMin + bounds.xMax) / 2;
        const tileCenterX = drawWidth / 2;
        const offsetX = tileCenterX - glyphVisualCenterX * scale;

        // Y offset: position so ascender is at top of drawing area
        // In canvas, Y increases downward, but font coords have Y up
        // After flipping: ascender should be at padding from top
        const offsetY = this.padding + ascender * scale;

        ctx.save();
        ctx.translate(offsetX, offsetY); // Position origin
        ctx.scale(scale, -scale); // Flip Y axis (font coords: Y up)

        // Detect theme and get colors from CSS variables
        const computedStyle = getComputedStyle(document.documentElement);
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const componentColor = computedStyle
            .getPropertyValue('--glyph-overview-component-color')
            .trim();
        const pathColor = isDarkTheme ? '#ffffff' : 'currentColor';

        // Draw shapes - paths in white (dark) or currentColor (light), components in blue
        this.drawShapes(
            ctx,
            glyphData.shapes,
            componentColor,
            pathColor,
            null, // No transform for root level
            false // Not inside a component
        );

        ctx.restore();

        return canvas;
    }

    /**
     * Recursively draw shapes (paths and components)
     * @param ctx - Canvas rendering context
     * @param shapes - Array of shape objects (Path or Component)
     * @param componentColor - Color for component outlines
     * @param pathColor - Color for regular path outlines
     * @param parentTransform - Optional parent transformation matrix [a, b, c, d, tx, ty]
     * @param insideComponent - Whether we're currently inside a component
     */
    private drawShapes(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        componentColor: string,
        pathColor: string,
        parentTransform: number[] | null,
        insideComponent: boolean
    ): void {
        // First pass: draw all regular paths (not components)
        ctx.beginPath();
        this.buildPathsOnly(ctx, shapes, parentTransform);
        ctx.fillStyle = insideComponent ? componentColor : pathColor;
        ctx.fill();

        // Second pass: draw all components
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
                    this.drawShapes(
                        ctx,
                        component.layerData.shapes,
                        componentColor,
                        pathColor,
                        null,
                        true // Inside a component
                    );
                    ctx.restore();
                }
            }
        }
    }

    /**
     * Build combined path from regular paths only (skip components)
     * @param ctx - Canvas rendering context
     * @param shapes - Array of shape objects
     * @param parentTransform - Optional parent transformation matrix
     */
    private buildPathsOnly(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        parentTransform: number[] | null
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
            }
        }
    }

    /**
     * Multiply two transformation matrices
     * @param t1 - First transform [a, b, c, d, tx, ty]
     * @param t2 - Second transform [a, b, c, d, tx, ty]
     * @returns Combined transform
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
export const glyphTileRenderer = new GlyphTileRenderer();
