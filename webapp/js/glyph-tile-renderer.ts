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
     */
    public renderGlyph(glyphData: GlyphOutlineData): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = this.tileWidth;
        canvas.height = this.tileHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error(
                '[GlyphTileRenderer]',
                'Failed to get canvas context'
            );
            return canvas;
        }

        // Calculate drawing area (reserve space at bottom for label)
        const labelHeight = 8;
        const drawHeight = this.tileHeight - labelHeight;
        const drawWidth = this.tileWidth;

        // Calculate scale to fit glyph in tile
        const bounds = glyphData.bounds;
        const glyphWidth = bounds.xMax - bounds.xMin;
        const glyphHeight = bounds.yMax - bounds.yMin;

        if (glyphWidth === 0 || glyphHeight === 0) {
            // Empty glyph
            return canvas;
        }

        const scaleX = (drawWidth - this.padding * 2) / glyphWidth;
        const scaleY = (drawHeight - this.padding * 2) / glyphHeight;
        const scale = Math.min(scaleX, scaleY);

        // Center the glyph
        const offsetX =
            (drawWidth - glyphWidth * scale) / 2 - bounds.xMin * scale;
        const offsetY =
            (drawHeight - glyphHeight * scale) / 2 - bounds.yMin * scale;

        ctx.save();
        ctx.translate(offsetX, drawHeight - offsetY); // Flip Y axis
        ctx.scale(scale, -scale);

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
