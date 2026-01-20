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

import { GlyphCanvas } from './glyph-canvas';
import { OutlineEditor } from './glyph-canvas/outline-editor';
import { DesignspaceLocation } from './locations';
import type { Babelfont } from './babelfont';

/**
 * Layer Data Normalizer
 *
 * Transforms layer data from multiple sources (Python layer.to_dict() and
 * babelfont-rs interpolate_glyph JSON) into a unified format for GlyphCanvas rendering.
 *
 * This ensures both editable Python layers and read-only interpolated layers
 * can be displayed using the same rendering code.
 */

export class LayerDataNormalizer {
    /**
     * Normalize layer data from any source
     *
     * @param {Object} layerData - Layer data from either Python or babelfont-rs
     * @param {boolean} isInterpolated - Whether this is interpolated data (optional, defaults to false)
     * @returns {Object} Normalized layer data with isInterpolated flag
     */
    static normalize(layerData: any, isInterpolated: boolean = false) {
        if (!layerData) {
            return null;
        }

        // Both Python and Rust now return identical structure with nested component layerData
        const normalized = {
            width: layerData.width || 0,
            shapes: this.normalizeShapes(
                layerData.shapes || [],
                isInterpolated
            ),
            anchors: this.normalizeAnchors(layerData.anchors || []),
            guides: layerData.guides || [],
            format_specific: layerData.format_specific || {},
            // Add metadata flag for rendering
            isInterpolated: isInterpolated,
            name: layerData.name || null,
            id: layerData.id || null
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
            if (shape.Path) {
                // Parse nodes if they're a string (from babelfont-rs)
                let parsedNodes = this.parseNodes(shape.Path.nodes);

                // IMPORTANT: For non-interpolated data, replace string with array in place
                // so object model and renderer share the same array reference.
                // This ensures modifications through window.currentFontModel are immediately visible.
                // For interpolated data, always use the freshly parsed nodes.
                if (typeof shape.Path.nodes === 'string') {
                    shape.Path.nodes = parsedNodes;
                }

                return {
                    Path: shape.Path, // Reference the same Path object
                    // For rendering: use the parsed nodes (ensures interpolated data uses new array)
                    nodes: parsedNodes,
                    isInterpolated: isInterpolated
                };
            } else if (shape.Component) {
                return {
                    Component: {
                        reference: shape.Component.reference,
                        transform: shape.Component.transform || [
                            1, 0, 0, 1, 0, 0
                        ],
                        format_specific: shape.Component.format_specific || {},
                        // Recursively normalize nested component layer data
                        // Component layerData comes with the same isInterpolated flag as parent
                        layerData: shape.Component.layerData
                            ? this.normalize(
                                  shape.Component.layerData,
                                  isInterpolated
                              )
                            : null
                    },
                    isInterpolated: isInterpolated
                };
            }
            return shape;
        });
    }

    /**
     * Parse nodes from string or array format
     *
     * babelfont format: "x1 y1 type [x2 y2 type ...]"
     * where type is: m, l, o, c, q (with optional 's' suffix for smooth)
     *
     * @param {string|Array} nodes - Nodes as string or already-parsed array
     * @returns {Array} Array of [x, y, type] triplets
     */
    static parseNodes(nodes: string | any[]): Babelfont.Node[] {
        // If already an array, return as-is
        if (Array.isArray(nodes)) {
            return nodes;
        }

        // Parse string format
        if (typeof nodes === 'string') {
            const nodesStr = nodes.trim();
            if (!nodesStr) return [];

            const tokens = nodesStr.split(/\s+/);
            const nodesArray: Babelfont.Node[] = [];

            for (let i = 0; i + 2 < tokens.length; i += 3) {
                nodesArray.push({
                    x: parseFloat(tokens[i]), // x
                    y: parseFloat(tokens[i + 1]), // y
                    nodetype: tokens[i + 2] as Babelfont.NodeType // type (m, l, o, c, q, ms, ls, etc.)
                });
            }

            return nodesArray;
        }

        return [];
    }

    /**
     * Serialize nodes array back to string format
     *
     * @param {Array} nodes - Array of node objects with x, y, type properties
     * @returns {string} Nodes as space-separated string "x1 y1 type x2 y2 type ..."
     */
    static serializeNodes(nodes: Babelfont.Node[]): string {
        if (!Array.isArray(nodes) || nodes.length === 0) {
            return '';
        }

        return nodes
            .map((node) => `${node.x} ${node.y} ${node.nodetype}`)
            .join(' ');
    }

    /**
     * Normalize anchors array
     *
     * @param {Array} anchors - Array of anchor objects
     * @returns {Array} Normalized anchors array
     */
    static normalizeAnchors(anchors: any[]): any[] {
        return anchors.map((anchor) => ({
            name: anchor.name || '',
            x: anchor.x || 0,
            y: anchor.y || 0,
            format_specific: anchor.format_specific || {}
        }));
    }

    /**
     * Check if layer data is from an exact layer (not interpolated)
     *
     * @param {Object} normalizedData - Normalized layer data
     * @returns {boolean} True if this is an exact layer
     */
    static isExactLayer(normalizedData: any) {
        return normalizedData && !normalizedData.isInterpolated;
    }

    /**
     * Apply interpolated layer data from babelfont-rs to GlyphCanvas
     *
     * @param {OutlineEditor} outlineEditor - The glyph canvas instance
     * @param {Object} interpolatedLayer - Layer data from babelfont-rs interpolate_glyph
     * @param {Object} location - The designspace location used for interpolation
     */
    static applyInterpolatedLayer(
        outlineEditor: OutlineEditor,
        interpolatedLayer: any,
        location: DesignspaceLocation
    ) {
        console.log(
            '[LayerDataNormalizer]',
            '📍 Location:',
            JSON.stringify(location)
        );
        const normalized = this.normalize(interpolatedLayer, true);

        // Parse component nodes recursively
        const parseComponentNodes = (shapes: any[]) => {
            if (!shapes) return;

            shapes.forEach((shape) => {
                // Already parsed in normalize(), but ensure consistency
                if (shape.Path && !shape.nodes) {
                    shape.nodes = this.parseNodes(shape.Path.nodes);
                }

                // Recursively parse nested component data
                if (
                    shape.Component &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    parseComponentNodes(shape.Component.layerData.shapes);
                }
            });
        };

        if (normalized && normalized.shapes) {
            parseComponentNodes(normalized.shapes);
        }

        outlineEditor.layerData = normalized;
        console.log('[LayerDataNormalizer]', 'Layer data applied to canvas');
        // Don't render here - let the calling code control when to render
        // This prevents intermediate renders that can cause flicker
    }

    /**
     * Restore exact layer from Python
     */
    static async restoreExactLayer(outlineEditor: OutlineEditor) {
        // Fetch layer data from Python
        await outlineEditor.fetchLayerData();
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
}
