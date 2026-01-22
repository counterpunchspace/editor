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
import type { Node, NodeType, Shape } from './babelfont-types';

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
            // Handle old wrapped format: { Path: { nodes: ... } }
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
            }
            // Handle new unwrapped format: direct Path object with nodes property
            else if (shape.nodes !== undefined && shape.reference === undefined) {
                // Parse nodes if they're a string
                let parsedNodes = this.parseNodes(shape.nodes);

                // For non-interpolated data, update in place
                if (typeof shape.nodes === 'string') {
                    shape.nodes = parsedNodes;
                }

                // Return the shape with parsed nodes
                return {
                    ...shape,
                    nodes: parsedNodes,
                    isInterpolated: isInterpolated
                };
            }
            // Handle old wrapped component format: { Component: { reference: ... } }
            else if (shape.Component) {
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
            // Handle new unwrapped component format: direct Component object with reference property
            else if (shape.reference !== undefined) {
                return {
                    ...shape,
                    // Recursively normalize nested component layer data if present
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
     * Map babelfont-ts NodeType enum names to renderer shorthand types
     *
     * babelfont-ts uses full names: Move, Line, OffCurve, Curve, QCurve
     * renderer uses shorthand: m, l, o, c, q (with 's' suffix for smooth: ms, ls, cs, qs)
     *
     * @param {string} nodetype - The node type from babelfont-ts or already shorthand
     * @param {boolean} smooth - Whether the node is smooth (for on-curve nodes)
     * @returns {NodeType} The shorthand nodetype for the renderer
     */
    static normalizeNodeType(nodetype: string, smooth?: boolean): NodeType {
        // Map babelfont-ts enum names to shorthand
        const typeMap: Record<string, string> = {
            Move: 'm',
            Line: 'l',
            OffCurve: 'o',
            Curve: 'c',
            QCurve: 'q'
        };

        // Check if it's a babelfont-ts type name
        if (nodetype in typeMap) {
            const shortType = typeMap[nodetype];
            // Add 's' suffix for smooth on-curve nodes (not off-curve)
            if (smooth && shortType !== 'o' && shortType !== 'm') {
                return (shortType + 's') as NodeType;
            }
            return shortType as NodeType;
        }

        // Already shorthand or unknown - return as-is
        return nodetype as NodeType;
    }

    /**
     * Parse nodes from string or array format
     *
     * babelfont format: "x1 y1 type [x2 y2 type ...]"
     * where type is: m, l, o, c, q (with optional 's' suffix for smooth)
     *
     * @param {string|Array} nodes - Nodes as string or already-parsed array
     * @returns {Array} Array of node objects with normalized types
     */
    static parseNodes(nodes: string | any[]): Node[] {
        // If already an array, normalize node types (babelfont-ts uses full names)
        if (Array.isArray(nodes)) {
            return nodes.map((node) => {
                // Check if nodetype needs normalization
                if (
                    node.nodetype &&
                    ['Move', 'Line', 'OffCurve', 'Curve', 'QCurve'].includes(
                        node.nodetype
                    )
                ) {
                    return {
                        ...node,
                        nodetype: this.normalizeNodeType(
                            node.nodetype,
                            node.smooth
                        )
                    };
                }
                return node;
            });
        }

        // Parse string format
        if (typeof nodes === 'string') {
            const nodesStr = nodes.trim();
            if (!nodesStr) return [];

            const tokens = nodesStr.split(/\s+/);
            const nodesArray: Node[] = [];

            for (let i = 0; i + 2 < tokens.length; i += 3) {
                nodesArray.push({
                    x: parseFloat(tokens[i]), // x
                    y: parseFloat(tokens[i + 1]), // y
                    nodetype: tokens[i + 2] as NodeType // type (m, l, o, c, q, ms, ls, etc.)
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
    static serializeNodes(nodes: Node[]): string {
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
                // Handle old wrapped format: { Path: { nodes: "..." } }
                if (shape.Path && !shape.nodes) {
                    shape.nodes = this.parseNodes(shape.Path.nodes);
                }
                // Handle new unwrapped format: { nodes: "...", closed: true }
                if (typeof shape.nodes === 'string') {
                    shape.nodes = this.parseNodes(shape.nodes);
                }

                // Recursively parse nested component data - handle both formats
                if (
                    shape.Component &&
                    shape.Component.layerData &&
                    shape.Component.layerData.shapes
                ) {
                    parseComponentNodes(shape.Component.layerData.shapes);
                } else if (
                    shape.reference &&
                    shape.layerData &&
                    shape.layerData.shapes
                ) {
                    // New unwrapped component format
                    parseComponentNodes(shape.layerData.shapes);
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
    static getNextNode(nodes: Node[], currentIndex: number): Node | null {
        if (!nodes || nodes.length === 0) return null;
        const nextIndex = (currentIndex + 1) % nodes.length;
        return nodes[nextIndex];
    }

    /**
     * Get the previous node in a circular array
     */
    static getPrevNode(nodes: Node[], currentIndex: number): Node | null {
        if (!nodes || nodes.length === 0) return null;
        const prevIndex = (currentIndex - 1 + nodes.length) % nodes.length;
        return nodes[prevIndex];
    }
}
