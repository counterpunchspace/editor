// Glyph Tile Renderer
// Renders glyph outlines into small canvas tiles for the overview
// Reuses LayerDataNormalizer for node parsing and path building

import { LayerDataNormalizer } from './layer-data-normalizer';

console.log('[GlyphTileRenderer]', 'glyph-tile-renderer.ts loaded');

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
     */
    public renderGlyph(
        glyphData: GlyphOutlineData,
        metrics?: RenderMetrics
    ): HTMLCanvasElement {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');

        // Set canvas size for hi-dpi
        canvas.width = this.tileWidth * dpr;
        canvas.height = this.tileHeight * dpr;
        canvas.style.width = `${this.tileWidth}px`;
        canvas.style.height = `${this.tileHeight}px`;

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
        const labelHeight = 8;
        const drawHeight = this.tileHeight - labelHeight;
        const drawWidth = this.tileWidth;

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

        // Draw shapes using LayerDataNormalizer utilities
        ctx.fillStyle = 'currentColor';
        ctx.beginPath();

        for (const shape of glyphData.shapes) {
            // Extract nodes from shape - handle both {Path: {nodes: ...}} and {nodes: ...} formats
            let nodes = shape.nodes;
            if (!nodes && shape.Path?.nodes) {
                // Parse string nodes format from babelfont-rs
                nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            }

            if (nodes && nodes.length > 0) {
                LayerDataNormalizer.buildPathFromNodes(nodes, ctx);
                ctx.closePath();
            }
        }

        ctx.fill();
        ctx.restore();

        return canvas;
    }
}

// Export singleton instance
export const glyphTileRenderer = new GlyphTileRenderer();
