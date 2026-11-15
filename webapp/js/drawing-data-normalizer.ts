// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { OutlineEditor } from './glyph-canvas/outline-editor';
import type { Babelfont } from './babelfont';
import { buildGlyphPathFromNodes } from './glyph-path-geometry';
import { Logger } from './logger';

const console = new Logger('DrawingDataNormalizer');

/**
 * Drawing Data Normalizer
 *
 * Transforms drawing data from multiple sources (Python drawing.to_dict() and
 * babelfont-rs interpolate_glyph JSON) into a unified format for GlyphCanvas rendering.
 *
 * This ensures both editable Python drawings and read-only interpolated drawings
 * can be displayed using the same rendering code.
 */

export class DrawingDataNormalizer {
    /**
     * Normalize drawing data from any source
     *
     * @param {Object} drawingData - Drawing data from either Python or babelfont-rs
     * @param {boolean} isInterpolated - Whether this is interpolated data (optional, defaults to false)
     * @returns {Object} Normalized drawing data with isInterpolated flag
     */
    static normalize(drawingData: any, isInterpolated: boolean = false) {
        if (!drawingData) {
            return null;
        }

        // Both Python and Rust now return identical structure with nested component layerData
        const normalized = {
            ...drawingData,
            shapes: this.normalizeShapes(
                drawingData.shapes || [],
                isInterpolated
            ),
            anchors: this.normalizeAnchors(drawingData.anchors || []),
            guides: drawingData.guides || [],
            format_specific: drawingData.format_specific || {},
            _verticalMetrics: drawingData._verticalMetrics || null,
            // Add metadata flag for rendering
            isInterpolated
        };

        return normalized;
    }

    /**
     * Normalize shapes array (Paths and Components)
     *
     * @param {Array} shapes - Array of shape objects
     * @param {boolean} isInterpolated - Whether this is interpolated data
     * @returns {Array} Normalized shapes array
     */
    static normalizeShapes(shapes: any[], isInterpolated: boolean): any[] {
        return shapes.map((shape, shapeIndex) => {
            if ('nodes' in shape) {
                if (!Array.isArray(shape.nodes)) {
                    throw new TypeError(
                        `Path shape nodes must be an array before drawing data normalization (shape ${shapeIndex}).`
                    );
                }

                return {
                    ...shape,
                    isInterpolated: isInterpolated
                };
            } else if ('reference' in shape) {
                return {
                    ...shape,
                    reference: shape.reference,
                    transform: shape.transform || [1, 0, 0, 1, 0, 0],
                    // Recursively normalize nested component drawing data
                    // Component layerData comes with the same isInterpolated flag as parent
                    layerData: shape.layerData
                        ? this.normalize(shape.layerData, isInterpolated)
                        : null,
                    isInterpolated: isInterpolated
                };
            }
            return shape;
        });
    }

    /**
     * Normalize anchors array
     *
     * @param {Array} anchors - Array of anchor objects
     * @returns {Array} Normalized anchors array
     */
    static normalizeAnchors(anchors: any[]): any[] {
        return anchors.map((anchor) => ({
            ...anchor,
            name: anchor.name ?? '',
            x: anchor.x ?? 0,
            y: anchor.y ?? 0
        }));
    }

    /**
     * Check if drawing data is from an exact drawing (not interpolated)
     *
     * @param {Object} normalizedData - Normalized drawing data
     * @returns {boolean} True if this is an exact drawing
     */
    static isExactDrawing(normalizedData: any) {
        return normalizedData && !normalizedData.isInterpolated;
    }

    /**
     * Restore exact drawing via Rust
     */
    static async restoreExactDrawing(outlineEditor: OutlineEditor) {
        await outlineEditor.fetchDrawingData();
    }

    /**
     * Get the next node in a circular array
     */
    static getNextNode(
        nodes: Babelfont.Node[],
        currentIndex: number
    ): Babelfont.Node | null {
        if (!nodes || nodes.length === 0) return null;
        const nextIndex = (currentIndex + 1) % nodes.length;
        return nodes[nextIndex];
    }

    /**
     * Get the previous node in a circular array
     */
    static getPrevNode(
        nodes: Babelfont.Node[],
        currentIndex: number
    ): Babelfont.Node | null {
        if (!nodes || nodes.length === 0) return null;
        const prevIndex = (currentIndex - 1 + nodes.length) % nodes.length;
        return nodes[prevIndex];
    }

    /**
     * Build a canvas path from a nodes array.
     * Standalone utility function extracted from Renderer.buildPathFromNodes.
     *
     * @param nodes - Array of Babelfont.Node objects
     * @param target - Canvas context or Path2D to draw to
     * @returns The start index for use in drawing direction arrows, or -1 if empty
     */
    static buildPathFromNodes(
        nodes: Babelfont.Node[],
        target: CanvasRenderingContext2D | Path2D
    ): number {
        return buildGlyphPathFromNodes(nodes, target);
    }
}
