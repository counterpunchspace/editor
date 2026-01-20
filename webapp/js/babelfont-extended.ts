/**
 * Extended babelfont classes with convenience methods and change tracking
 *
 * This file extends the babelfont-ts classes from babelfont-rs repository with:
 * - Convenience methods for common operations
 * - Change tracking hooks for undo/redo and collaboration
 * - Custom properties needed by the application
 * - WASM-backed geometry calculations
 */

import {
    Font as BabelfontFont,
    Glyph as BabelfontGlyph,
    Layer as BabelfontLayer,
    Path as BabelfontPath,
    Node as BabelfontNode,
    Component as BabelfontComponent,
    Anchor as BabelfontAnchor,
    Guide as BabelfontGuide,
    Axis as BabelfontAxis,
    Instance as BabelfontInstance,
    Master as BabelfontMaster,
    Names as BabelfontNames,
    Features as BabelfontFeatures,
    CustomOTValues as BabelfontCustomOTValues,
    Position as BabelfontPosition,
    DecomposedAffine as BabelfontDecomposedAffine,
    Color as BabelfontColor
} from 'babelfont-ts';

import type {
    Font as IFont,
    Glyph as IGlyph,
    Layer as ILayer,
    Path as IPath,
    Node as INode,
    Component as IComponent,
    Anchor as IAnchor,
    Guide as IGuide,
    Axis as IAxis,
    Instance as IInstance,
    Master as IMaster,
    Names as INames,
    Features as IFeatures,
    CustomOTValues as ICustomOTValues,
    Position as IPosition,
    DecomposedAffine as IDecomposedAffine,
    Color as IColor
} from 'babelfont-ts';

import type { ClassRegistry } from 'babelfont-ts';
import { Bezier } from 'bezier-js';
import { LayerDataNormalizer } from './layer-data-normalizer';

// Type for simple path data (used internally for geometry calculations)
type PathData = {
    nodes: Array<{
        x: number;
        y: number;
        nodetype?: string;
        type?: string;
        smooth?: boolean;
    }>;
    closed?: boolean;
};

// ============================================================================
// Font Class
// ============================================================================

export class Font extends BabelfontFont {
    constructor(data: IFont, registry?: ClassRegistry) {
        super(data, registry);
    }

    /**
     * Find a glyph by name
     *
     * @param name - The glyph name to search for
     * @returns The glyph if found, undefined otherwise
     * @example
     * glyph = font.findGlyph("A")
     * if glyph:
     *     print(glyph.width)
     */
    findGlyph(name: string): Glyph | undefined {
        return this.glyphs?.find((g) => g.name === name) as Glyph | undefined;
    }

    /**
     * Find a glyph by Unicode codepoint
     *
     * @param unicode - The Unicode codepoint (as integer)
     * @returns The glyph if found, undefined otherwise
     * @example
     * glyph = font.findGlyphByUnicode(0x0041)  # 'A'
     * if glyph:
     *     print(glyph.name)
     */
    findGlyphByUnicode(unicode: number): Glyph | undefined {
        return this.glyphs?.find((g) => g.codepoints?.includes(unicode)) as
            | Glyph
            | undefined;
    }

    /**
     * Get an axis by tag
     *
     * @param tag - The axis tag (e.g., "wght")
     * @returns The axis if found, undefined otherwise
     * @example
     * axis = font.getAxis("wght")
     * if axis:
     *     print(axis.min, axis.max)
     */
    getAxis(tag: string): Axis | undefined {
        return this.axes?.find((a) => a.tag === tag) as Axis | undefined;
    }

    /**
     * Get an axis by name
     *
     * @param name - The axis name
     * @returns The axis if found, undefined otherwise
     * @example
     * axis = font.getAxisByName("Weight")
     * if axis:
     *     print(axis.tag)
     */
    getAxisByName(name: string): Axis | undefined {
        return this.axes?.find((a) => {
            const axisName = typeof a.name === 'string' ? a.name : a.name?.dflt;
            return axisName === name;
        }) as Axis | undefined;
    }

    /**
     * Get a master by ID
     *
     * @param id - The master ID
     * @returns The master if found, undefined otherwise
     * @example
     * master = font.getMaster("m01")
     * if master:
     *     print(master.name)
     */
    getMaster(id: string): Master | undefined {
        return this.masters?.find((m) => m.id === id) as Master | undefined;
    }

    /**
     * Serialize font to JSON string
     *
     * @returns JSON string representation
     * @example
     * json_str = font.toJSONString()
     * with open("font.json", "w") as f:
     *     f.write(json_str)
     */
    toJSONString(): string {
        return JSON.stringify(this, (key, value) => {
            // When serializing shape objects, filter out normalizer wrapper properties
            // The normalizer adds { Path: {...}, nodes: [...], isInterpolated?: bool }
            // but we only want { Path: {...} } or { Component: {...} } in the JSON
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // Check if this looks like a normalizer wrapper for a Path shape
                // It will have BOTH 'Path' and 'nodes' at the same level (duplicate property)
                if (
                    'Path' in value &&
                    'nodes' in value &&
                    !('Component' in value)
                ) {
                    return { Path: value.Path };
                }
                // Check if this looks like a normalizer wrapper for a Component shape
                if (
                    'Component' in value &&
                    ('isInterpolated' in value || 'nodes' in value) &&
                    !('Path' in value)
                ) {
                    return { Component: value.Component };
                }
            }
            return value;
        });
    }

    /**
     * Create a Font instance from parsed JSON data
     *
     * @param data - Font data object
     * @returns Font instance
     * @example
     * font = Font.fromData(data_dict)
     */
    static fromData(data: IFont): Font {
        return new Font(data);
    }
}

// ============================================================================
// Glyph Class
// ============================================================================

export class Glyph extends BabelfontGlyph {
    /**
     * Get a layer by ID
     *
     * @param id - The layer ID
     * @returns The layer if found, undefined otherwise
     * @example
     * layer = glyph.getLayerById("m01")
     * if layer:
     *     print(layer.width)
     */
    getLayerById(id: string): Layer | undefined {
        return this.layers?.find((l) => l.id === id) as Layer | undefined;
    }

    /**
     * Get a layer by master ID
     *
     * @param masterId - The master ID
     * @returns The layer if found, undefined otherwise
     * @example
     * layer = glyph.getLayerByMasterId("m01")
     * if layer:
     *     print(layer.width)
     */
    getLayerByMasterId(masterId: string): Layer | undefined {
        return this.layers?.find((l) => {
            if (!l.master) return false;
            const master = l.master as any;
            return master.master === masterId || master === masterId;
        }) as Layer | undefined;
    }
}

// ============================================================================
// Layer Class
// ============================================================================

export class Layer extends BabelfontLayer {
    // Custom property for caching component layer data
    cachedComponentLayerData?: any;

    /**
     * Get bounding box of layer (WASM-backed)
     *
     * @returns Bounding box with x, y, width, height
     * @example
     * bounds = layer.bounds()
     * print(f"x={bounds['x']}, y={bounds['y']}")
     */
    bounds(): { x: number; y: number; width: number; height: number } | null {
        // TODO: Call WASM method
        // For now, return placeholder
        console.warn('[Layer.bounds] WASM implementation pending');
        return null;
    }

    /**
     * Get left sidebearing
     *
     * @returns Left sidebearing value
     * @example
     * lsb = layer.lsb
     * print(f"LSB: {lsb}")
     */
    get lsb(): number {
        const bounds = this.bounds();
        if (!bounds) return 0;
        return bounds.x;
    }

    /**
     * Set left sidebearing
     *
     * @param value - New LSB value
     * @example
     * layer.lsb = 50
     */
    set lsb(value: number) {
        const bounds = this.bounds();
        if (!bounds) return;

        const delta = value - bounds.x;

        // Shift all shapes
        this.shapes?.forEach((shape) => {
            if ('nodes' in shape) {
                // Path
                (shape as any).nodes?.forEach((node: any) => {
                    node.x += delta;
                });
            } else if ('transform' in shape) {
                // Component
                (shape as any).transform.x += delta;
            }
        });

        this.markDirty();
    }

    /**
     * Get right sidebearing
     *
     * @returns Right sidebearing value
     * @example
     * rsb = layer.rsb
     * print(f"RSB: {rsb}")
     */
    get rsb(): number {
        const bounds = this.bounds();
        if (!bounds) return 0;
        return this.width - (bounds.x + bounds.width);
    }

    /**
     * Set right sidebearing
     *
     * @param value - New RSB value
     * @example
     * layer.rsb = 50
     */
    set rsb(value: number) {
        const bounds = this.bounds();
        if (!bounds) return;

        const currentRsb = this.width - (bounds.x + bounds.width);
        const delta = value - currentRsb;
        this.width += delta;

        this.markDirty();
    }

    /**
     * Add a new path to the layer
     *
     * @param closed - Whether the path should be closed
     * @returns The newly created path
     * @example
     * path = layer.addPath(closed=True)
     * path.addNode({"x": 0, "y": 0, "type": "line"})
     */
    addPath(closed: boolean = false): Path {
        const path = new Path({ nodes: [], closed });
        if (!this.shapes) this.shapes = [];
        this.shapes.push(path as any);
        this.markDirty();
        return path;
    }

    /**
     * Delete a path by index
     *
     * @param index - Index of path to delete
     * @example
     * layer.deletePath(0)
     */
    deletePath(index: number): void {
        if (!this.shapes) return;
        this.shapes.splice(index, 1);
        this.markDirty();
    }

    /**
     * Add a new component to the layer
     *
     * @param reference - Name of glyph to reference
     * @param transform - Transform object (optional)
     * @returns The newly created component
     * @example
     * comp = layer.addComponent("A")
     * comp.transform.x = 100
     */
    addComponent(reference: string, transform?: any): Component {
        const comp = new Component({
            reference,
            transform: transform || {
                x: 0,
                y: 0,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                skewX: 0,
                skewY: 0
            }
        });
        if (!this.shapes) this.shapes = [];
        this.shapes.push(comp as any);
        this.markDirty();
        return comp;
    }

    /**
     * Delete a component by index
     *
     * @param index - Index of component to delete
     * @example
     * layer.deleteComponent(0)
     */
    deleteComponent(index: number): void {
        if (!this.shapes) return;
        this.shapes.splice(index, 1);
        this.markDirty();
    }

    /**
     * Create and add an anchor
     *
     * @param name - Anchor name
     * @param x - X coordinate
     * @param y - Y coordinate
     * @returns The newly created anchor
     * @example
     * anchor = layer.createAnchor("top", 250, 700)
     */
    createAnchor(name: string, x: number, y: number): Anchor {
        const anchor = new Anchor({ name, x, y });
        if (!this.anchors) this.anchors = [];
        this.anchors.push(anchor as any);
        this.markDirty();
        return anchor;
    }

    /**
     * Process a path into Bezier curve segments
     * Handles the babelfont node format where:
     * - Nodes can have 'type' (lowercase: o, c, l, q, etc.) or 'nodetype' (capitalized: OffCurve, Curve, Line, etc.)
     * - Segments are sequences: [oncurve] [offcurve*] [oncurve]
     * - For closed paths, the path can start with offcurve nodes
     *
     * @param pathData - Path data with nodes array and closed flag
     * @returns Array of Bezier curve segments, each with {points, type}
     */
    static processPathSegments(pathData: {
        nodes: any[];
        closed?: boolean;
    }): Array<{
        points: Array<{ x: number; y: number }>;
        type: 'line' | 'quadratic' | 'cubic';
    }> {
        const segments: Array<{
            points: Array<{ x: number; y: number }>;
            type: 'line' | 'quadratic' | 'cubic';
        }> = [];

        if (!pathData.nodes || pathData.nodes.length < 2) {
            return segments;
        }

        const nodes = pathData.nodes;
        const closed = pathData.closed !== false; // Default to true

        // Helper to get node type (handles both 'type' and 'nodetype' fields)
        const getNodeType = (node: any): string => {
            return (node.type || node.nodetype || '').toString().toLowerCase();
        };

        // Helper to check if node is offcurve
        const isOffCurve = (node: any): boolean => {
            const type = getNodeType(node);
            return type === 'o' || type === 'offcurve';
        };

        // Helper to check if node is oncurve
        const isOnCurve = (node: any): boolean => {
            return !isOffCurve(node);
        };

        // Find the first oncurve node to start from
        let startIdx = 0;
        if (closed) {
            // For closed paths, find first oncurve node
            for (let i = 0; i < nodes.length; i++) {
                if (isOnCurve(nodes[i])) {
                    startIdx = i;
                    break;
                }
            }
        }

        // Process segments
        let i = startIdx;
        let processedCount = 0;
        const maxNodes = closed ? nodes.length : nodes.length - 1;

        while (processedCount < maxNodes) {
            const currentIdx = i % nodes.length;
            const current = nodes[currentIdx];

            if (!isOnCurve(current)) {
                // Skip if we somehow landed on an offcurve (shouldn't happen after finding start)
                i++;
                processedCount++;
                continue;
            }

            // Collect points for this segment: [oncurve] [offcurve*] [oncurve]
            const points: Array<{ x: number; y: number }> = [
                { x: current.x, y: current.y }
            ];

            // Collect all following offcurve nodes
            let j = (currentIdx + 1) % nodes.length;
            let offcurveCount = 0;
            while (offcurveCount < nodes.length) {
                // Safety limit
                if (j >= nodes.length && !closed) break;

                const node = nodes[j % nodes.length];
                if (isOffCurve(node)) {
                    points.push({ x: node.x, y: node.y });
                    j++;
                    offcurveCount++;
                } else {
                    // Found next oncurve node
                    points.push({ x: node.x, y: node.y });
                    break;
                }
            }

            // Determine segment type based on number of points
            if (points.length === 2) {
                // Line segment: [oncurve] [oncurve]
                segments.push({ points, type: 'line' });
                i++;
                processedCount++;
            } else if (points.length === 3) {
                // Quadratic Bezier: [oncurve] [offcurve] [oncurve]
                segments.push({ points, type: 'quadratic' });
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else if (points.length === 4) {
                // Cubic Bezier: [oncurve] [offcurve] [offcurve] [oncurve]
                segments.push({ points, type: 'cubic' });
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else if (points.length > 4) {
                // Too many control points - skip this malformed segment
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else {
                // Not enough points (shouldn't happen)
                i++;
                processedCount++;
            }

            // Safety check to prevent infinite loops
            if (processedCount > nodes.length * 2) {
                break;
            }
        }

        return segments;
    }

    /**
     * Flatten all components in the layer to paths with their transforms applied
     * This recursively processes nested components to any depth
     * @param layer - Layer instance
     * @param font - Font object for looking up component references
     * @returns Array of flattened path data objects with transformed coordinates
     */
    private static flattenComponents(layer: Layer, font?: Font): PathData[] {
        const flattenedPaths: PathData[] = [];

        if (!layer.shapes) return flattenedPaths;

        // Helper function to apply transform to a node
        const transformNode = (node: any, transform: number[]): any => {
            const [a, b, c, d, tx, ty] = transform;
            const result: any = {
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
            // Preserve node type field (either 'type' or 'nodetype')
            if (node.type !== undefined) result.type = node.type;
            if (node.nodetype !== undefined) result.nodetype = node.nodetype;
            if (node.smooth !== undefined) result.smooth = node.smooth;
            return result;
        };

        // Helper function to combine two transform matrices
        const combineTransforms = (t1: number[], t2: number[]): number[] => {
            const [a1, b1, c1, d1, tx1, ty1] = t1;
            const [a2, b2, c2, d2, tx2, ty2] = t2;
            return [
                a1 * a2 + c1 * b2,
                b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2,
                b1 * c2 + d1 * d2,
                a1 * tx2 + c1 * ty2 + tx1,
                b1 * tx2 + d1 * ty2 + ty1
            ];
        };

        // Process shapes
        const processShape = (
            shape: Path | Component,
            transform: number[] = [1, 0, 0, 1, 0, 0]
        ) => {
            if (shape instanceof BabelfontPath) {
                // Direct path - transform its nodes
                const transformedNodes = shape.nodes.map((node: any) =>
                    transformNode(node, transform)
                );
                flattenedPaths.push({
                    nodes: transformedNodes,
                    closed: shape.closed ?? true
                });
            } else if (shape instanceof BabelfontComponent) {
                // Component - recursively process its shapes with accumulated transform
                const compTransform = shape.transform?.toAffine() || [
                    1, 0, 0, 1, 0, 0
                ];
                const combinedTransform = combineTransforms(
                    transform,
                    compTransform
                );

                // Look up the component glyph
                if (font) {
                    const componentGlyph = font.findGlyph(shape.reference);
                    if (
                        componentGlyph &&
                        componentGlyph.layers &&
                        componentGlyph.layers.length > 0
                    ) {
                        // Use the first layer (or find matching master)
                        const componentLayer = componentGlyph.layers[0];
                        if (componentLayer.shapes) {
                            for (const nestedShape of componentLayer.shapes) {
                                processShape(
                                    nestedShape as Path | Component,
                                    combinedTransform
                                );
                            }
                        }
                    }
                }
            }
        };

        for (const shape of layer.shapes) {
            processShape(shape as Path | Component);
        }

        return flattenedPaths;
    }

    /**
     * Get only direct paths in this layer (no components)
     * @returns Array of path data objects from shapes that are paths
     */
    private getDirectPaths(): PathData[] {
        const paths: PathData[] = [];

        if (!this.shapes) return paths;

        for (const shape of this.shapes) {
            if (shape instanceof BabelfontPath) {
                paths.push({
                    nodes: shape.nodes.map((n: any) => ({ ...n.toJSON() })),
                    closed: shape.closed ?? true
                });
            }
        }

        return paths;
    }

    /**
     * Get all paths in this layer including transformed paths from components (recursively flattened)
     * @returns Array of path data objects with all components resolved to transformed paths
     */
    getAllPaths(): PathData[] {
        // Navigate up to Font to enable component lookup
        const glyph = this.parent as Glyph;
        const font = glyph ? (glyph.parent as Font) : undefined;

        return Layer.flattenComponents(this, font);
    }

    /**
     * Calculate bounding box for layer
     * @param layer - Layer instance
     * @param includeAnchors - If true, include anchors in the bounding box calculation (default: false)
     * @param font - Font object for component lookup (optional)
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    static calculateBoundingBox(
        layer: Layer,
        includeAnchors: boolean = false,
        font?: Font
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let hasPoints = false;

        // Helper function to expand bounding box with a point
        const expandBounds = (x: number, y: number) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            hasPoints = true;
        };

        // Get all paths (flattened including components)
        const paths = Layer.flattenComponents(layer, font);

        // Process all paths
        for (const path of paths) {
            if (path.nodes && Array.isArray(path.nodes)) {
                for (const node of path.nodes) {
                    expandBounds(node.x, node.y);
                }
            }
        }

        // Include anchors in bounding box if requested
        if (includeAnchors && layer.anchors) {
            for (const anchor of layer.anchors) {
                expandBounds((anchor as any).x, (anchor as any).y);
            }
        }

        if (!hasPoints) {
            // No points found (e.g., space character) - use glyph width from layer
            const glyphWidth = layer.width || 250; // Fallback to 250 if no width
            const height = 10;

            return {
                minX: 0,
                minY: -height / 2,
                maxX: glyphWidth,
                maxY: height / 2,
                width: glyphWidth,
                height: height
            };
        }

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    /**
     * Calculate bounding box for this layer
     * @param includeAnchors - If true, include anchors in the bounding box calculation (default: false)
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    getBoundingBox(includeAnchors: boolean = false): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        // Navigate up to Font to enable component lookup
        const glyph = this.parent as Glyph;
        const font = glyph ? (glyph.parent as Font) : undefined;

        return Layer.calculateBoundingBox(this, includeAnchors, font);
    }

    /**
     * Calculate intersections between a line segment and all paths in this layer
     * @param p1 - First point {x, y} of the line segment
     * @param p2 - Second point {x, y} of the line segment
     * @param includeComponents - If true, include component paths (default: false)
     * @returns Array of intersection points sorted by distance from p1, each with {x, y, t} where t is the parameter along the line (0 at p1, 1 at p2)
     */
    getIntersectionsOnLine(
        p1: { x: number; y: number },
        p2: { x: number; y: number },
        includeComponents: boolean = false
    ): Array<{ x: number; y: number; t: number }> {
        const intersections: Array<{ x: number; y: number; t: number }> = [];

        // Get all paths including components if requested
        const paths = includeComponents
            ? this.getAllPaths()
            : this.getDirectPaths();

        // Create a line object for intersections
        const line = {
            p1: { x: p1.x, y: p1.y },
            p2: { x: p2.x, y: p2.y }
        };

        // Process each path
        for (const path of paths) {
            if (!path.nodes || !Array.isArray(path.nodes)) continue;

            // Use the reusable segment processor
            const segments = Layer.processPathSegments({
                nodes: path.nodes,
                closed: path.closed
            });

            // Process each segment
            for (const segment of segments) {
                // Validate segment points before creating Bezier
                if (
                    !segment ||
                    !segment.points ||
                    !Array.isArray(segment.points) ||
                    segment.points.length < 2
                ) {
                    continue;
                }

                // Check all points are valid
                let allPointsValid = true;
                for (const pt of segment.points) {
                    if (
                        !pt ||
                        typeof pt.x !== 'number' ||
                        typeof pt.y !== 'number'
                    ) {
                        allPointsValid = false;
                        break;
                    }
                }

                if (!allPointsValid) {
                    continue;
                }

                try {
                    // Handle line-line intersection manually (bezier-js doesn't detect these reliably)
                    if (
                        segment.type === 'line' &&
                        segment.points.length === 2
                    ) {
                        const s1 = segment.points[0];
                        const s2 = segment.points[1];

                        // Line-line intersection formula
                        // Line 1 (segment): s1 to s2
                        // Line 2 (test line): p1 to p2
                        const denom =
                            (p2.y - p1.y) * (s2.x - s1.x) -
                            (p2.x - p1.x) * (s2.y - s1.y);

                        // Check if lines are parallel (or coincident)
                        if (Math.abs(denom) > 1e-10) {
                            const ua =
                                ((p2.x - p1.x) * (s1.y - p1.y) -
                                    (p2.y - p1.y) * (s1.x - p1.x)) /
                                denom;
                            const ub =
                                ((s2.x - s1.x) * (s1.y - p1.y) -
                                    (s2.y - s1.y) * (s1.x - p1.x)) /
                                denom;

                            // Check if intersection is within both line segments (0 <= t <= 1)
                            if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
                                const point = {
                                    x: s1.x + ua * (s2.x - s1.x),
                                    y: s1.y + ua * (s2.y - s1.y)
                                };

                                intersections.push({
                                    x: point.x,
                                    y: point.y,
                                    t: ub // t on the test line
                                });
                            }
                        }

                        // Skip bezier-js for line segments
                        continue;
                    }

                    // Create Bezier curve from segment points
                    const curve = new Bezier(segment.points);

                    // Find intersections between this curve segment and the line
                    const curveIntersections = curve.intersects(line as any);

                    if (Array.isArray(curveIntersections)) {
                        for (const result of curveIntersections) {
                            let point: { x: number; y: number };
                            let tOnLine: number;

                            if (typeof result === 'string') {
                                // Format: "t1/t2" where t1 is t on curve, t2 is t on line
                                const parts = result.split('/');
                                tOnLine = parseFloat(parts[1]);
                                point = {
                                    x: p1.x + tOnLine * (p2.x - p1.x),
                                    y: p1.y + tOnLine * (p2.y - p1.y)
                                };
                            } else {
                                // Single number
                                // For line-line intersections, this is t on the line being tested
                                // For curve-line intersections, this is t on the curve
                                if (segment.type === 'line') {
                                    // Line-line intersection: result is t on the line being tested
                                    tOnLine = result;
                                    point = {
                                        x: p1.x + tOnLine * (p2.x - p1.x),
                                        y: p1.y + tOnLine * (p2.y - p1.y)
                                    };
                                } else {
                                    // Curve-line intersection: result is t on the curve
                                    // Get the point on the curve at this t value
                                    const curvePoint = curve.get(result);
                                    point = {
                                        x: curvePoint.x,
                                        y: curvePoint.y
                                    };

                                    // Calculate t on the line
                                    // For horizontal line: t = (x - x1) / (x2 - x1)
                                    // For vertical line: t = (y - y1) / (y2 - y1)
                                    if (
                                        Math.abs(p2.x - p1.x) >
                                        Math.abs(p2.y - p1.y)
                                    ) {
                                        // More horizontal than vertical
                                        tOnLine =
                                            (point.x - p1.x) / (p2.x - p1.x);
                                    } else {
                                        // More vertical than horizontal
                                        tOnLine =
                                            (point.y - p1.y) / (p2.y - p1.y);
                                    }
                                }
                            }

                            intersections.push({
                                x: point.x,
                                y: point.y,
                                t: tOnLine
                            });
                        }
                    }
                } catch (e) {
                    // Skip segments that cause errors
                    continue;
                }
            }
        }

        // Sort intersections by t parameter (distance along line from p1)
        intersections.sort((a, b) => a.t - b.t);

        return intersections;
    }

    private markDirty(): void {
        if ((window as any).fontManager?.currentFont) {
            (window as any).fontManager.currentFont.dirty = true;
        }
    }
}

// ============================================================================
// Path Class
// ============================================================================

export class Path extends BabelfontPath {
    /**
     * Convert nodes array to compact string format
     *
     * @param nodes - Array of nodes
     * @returns Compact string representation
     * @example
     * nodes_str = Path.nodesToString(path.nodes)
     */
    static nodesToString(nodes: INode[]): string {
        const tokens: string[] = [];

        for (const node of nodes) {
            // Ensure we have valid numbers
            const x =
                typeof node.x === 'number'
                    ? node.x
                    : parseFloat(String(node.x));
            const y =
                typeof node.y === 'number'
                    ? node.y
                    : parseFloat(String(node.y));

            if (isNaN(x) || isNaN(y)) {
                console.error('[Path]', 'Invalid node coordinates:', node);
                continue;
            }

            tokens.push(x.toString());
            tokens.push(y.toString());

            // Get node type - check both 'nodetype' (object model) and 'type' (normalizer)
            const nodeType = (node as any).nodetype || (node as any).type;

            // Map nodetype back to short form
            const typeMap: Record<string, string> = {
                Move: 'm',
                Line: 'l',
                OffCurve: 'o',
                Curve: 'c',
                QCurve: 'q',
                // Also handle short forms directly (from normalizer)
                m: 'm',
                l: 'l',
                o: 'o',
                c: 'c',
                q: 'q'
            };

            const typeChar = typeMap[nodeType] || 'l';
            tokens.push(typeChar);
        }

        return tokens.join(' ');
    }

    /**
     * Insert a node at a specific index
     *
     * @param index - Index where to insert
     * @param node - Node to insert
     * @example
     * path.insertNode(1, {"x": 100, "y": 200, "type": "line"})
     */
    insertNode(index: number, node: INode): void {
        if (!this.nodes) this.nodes = [];
        this.nodes.splice(index, 0, new Node(node) as any);
        this.markDirty();
    }

    /**
     * Add a node to the end of the path
     *
     * @param node - Node to add
     * @example
     * path.addNode({"x": 100, "y": 200, "type": "line"})
     */
    addNode(node: INode): void {
        if (!this.nodes) this.nodes = [];
        this.nodes.push(new Node(node) as any);
        this.markDirty();
    }

    /**
     * Delete a node by index
     *
     * @param index - Index of node to delete
     * @example
     * path.deleteNode(0)
     */
    deleteNode(index: number): void {
        if (!this.nodes) return;
        this.nodes.splice(index, 1);
        this.markDirty();
    }

    private markDirty(): void {
        if ((window as any).fontManager?.currentFont) {
            (window as any).fontManager.currentFont.dirty = true;
        }
    }
}

// ============================================================================
// Component Class
// ============================================================================

export class Component extends BabelfontComponent {
    // Custom property for caching component layer data
    cachedComponentLayerData?: any;
}

// ============================================================================
// Re-export other classes unchanged
// ============================================================================

export class Node extends BabelfontNode {}
export class Anchor extends BabelfontAnchor {}
export class Guide extends BabelfontGuide {}
export class Axis extends BabelfontAxis {}
export class Instance extends BabelfontInstance {}
export class Master extends BabelfontMaster {}
export class Names extends BabelfontNames {}
export class Features extends BabelfontFeatures {}
export class CustomOTValues extends BabelfontCustomOTValues {}
export class Position extends BabelfontPosition {}
export class DecomposedAffine extends BabelfontDecomposedAffine {}
export class Color extends BabelfontColor {}

// ============================================================================
// Class Registry
// ============================================================================

export const ExtendedClassRegistry: ClassRegistry = {
    Font,
    Glyph,
    Layer,
    Path,
    Node,
    Component,
    Anchor,
    Guide,
    Axis,
    Instance,
    Master,
    Names,
    Features,
    CustomOTValues,
    Position,
    DecomposedAffine,
    Color
};

/**
 * Load a font from JSON using extended classes
 *
 * @param data - Font data as JSON
 * @returns Font instance with extended classes
 * @example
 * font = loadFontFromJSON(json_data)
 * print(font.findGlyph("A").width)
 */
export function loadFontFromJSON(data: any): Font {
    return new Font(data, ExtendedClassRegistry);
}
