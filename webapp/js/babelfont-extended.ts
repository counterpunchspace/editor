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
