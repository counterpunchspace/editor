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
    Color as BabelfontColor,
    isPath,
    isComponent
} from 'babelfont-ts';

// Import setParent directly from parent module (not exported from main index)
import { setParent } from '../vendor/babelfont-rs/babelfont-ts/src/parent';

// Re-export type guard functions for shape type checking
export { isPath, isComponent };

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

/**
 * Convert affine matrix [a,b,c,d,tx,ty] to decomposed transform format
 * Uses QR decomposition to extract translation, scale, rotation, and skew
 */
function affineToDecomposed(affine: number[]): {
    translation: [number, number];
    scale: [number, number];
    rotation: number;
    skew: [number, number];
} {
    const [a, b, c, d, tx, ty] = affine;

    // Translation is straightforward
    const translation: [number, number] = [tx, ty];

    // Decompose the 2x2 matrix part using QR-like decomposition
    // Matrix: [a c]
    //         [b d]

    // Scale x is length of first column
    const scaleX = Math.sqrt(a * a + b * b);

    // Normalize first column
    const a1 = scaleX !== 0 ? a / scaleX : 0;
    const b1 = scaleX !== 0 ? b / scaleX : 0;

    // Rotation angle from normalized first column
    const rotation = Math.atan2(b1, a1);

    // Compute skew - the angle between the columns
    // Second column projected onto perpendicular of first
    const skewX = a1 * c + b1 * d;

    // Scale y is length of second column minus skew contribution
    const scaleY = Math.sqrt(c * c + d * d - skewX * skewX) || 0;

    // Handle negative scale (reflection)
    const det = a * d - b * c;
    const finalScaleY = det < 0 ? -scaleY : scaleY;

    return {
        translation,
        scale: [scaleX, finalScaleY],
        rotation,
        skew: [scaleX !== 0 ? skewX / scaleX : 0, 0]
    };
}

/**
 * Normalize shapes from WASM tagged-enum format to flat format expected by babelfont-ts
 * WASM outputs: { "Path": { nodes: "...", closed: true } }
 * babelfont-ts expects: { nodes: "...", closed: true }
 * Also converts component transforms from affine [a,b,c,d,tx,ty] to decomposed format
 */
function normalizeShapesInData(data: IFont): IFont {
    if (!data.glyphs) return data;

    for (const glyph of data.glyphs) {
        if (!glyph.layers) continue;
        for (const layer of glyph.layers) {
            if (!layer.shapes) continue;
            layer.shapes = layer.shapes.map((shape: any) => {
                // Unwrap Path wrapper
                if (shape.Path) {
                    return shape.Path;
                }
                // Unwrap Component wrapper
                if (shape.Component) {
                    const component = shape.Component;
                    // Convert affine matrix transform to decomposed format
                    if (Array.isArray(component.transform)) {
                        component.transform = affineToDecomposed(
                            component.transform
                        );
                    }
                    return component;
                }
                // For already unwrapped components, also check transform format
                if (shape.reference && Array.isArray(shape.transform)) {
                    shape.transform = affineToDecomposed(shape.transform);
                }
                return shape;
            });
        }
    }
    return data;
}

export class Font extends BabelfontFont {
    constructor(data: IFont, registry?: ClassRegistry) {
        // Normalize shapes from WASM format before passing to babelfont-ts
        const normalizedData = normalizeShapesInData(data);
        super(normalizedData, registry);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const familyName =
                    this.names?.family_name?.en ||
                    Object.values(this.names?.family_name || {})[0] ||
                    'Unnamed';
                const glyphCount = this.glyphs?.length || 0;
                const masterCount = this.masters?.length || 0;
                const axisCount = this.axes?.length || 0;
                const info =
                    masterCount > 1
                        ? ` ${axisCount} axes, ${masterCount} masters`
                        : '';
                return `<Font "${familyName}" ${glyphCount} glyphs${info}>`;
            }
        });
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
     * Create and add a new glyph to the font
     *
     * @param name - The glyph name
     * @param category - The glyph category (default: "Base")
     * @returns The newly created glyph
     * @example
     * glyph = font.addGlyph("A")
     * print(glyph.name)
     */
    addGlyph(name: string, category: string = 'Base'): Glyph {
        // Create minimal glyph data matching IGlyph interface
        const glyphData: any = {
            name,
            category,
            exported: true,
            codepoints: [],
            layers: []
        };
        const glyph = new Glyph(glyphData);
        if (!this.glyphs) this.glyphs = [];
        this.glyphs.push(glyph as any);
        // Set parent relationship
        setParent(glyph as any, this);
        return glyph;
    }

    /**
     * Remove a glyph from the font by name
     *
     * @param name - The glyph name to remove
     * @returns True if glyph was removed, false if not found
     * @example
     * removed = font.removeGlyph("A")
     * if removed:
     *     print("Glyph removed")
     */
    removeGlyph(name: string): boolean {
        if (!this.glyphs) return false;
        const index = this.glyphs.findIndex((g) => g.name === name);
        if (index === -1) return false;
        this.glyphs.splice(index, 1);
        return true;
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
        // Pre-process: ensure all Path objects have nodes array initialized
        // This must happen BEFORE JSON.stringify calls toJSON() on each object
        const ensurePathNodes = (obj: any): void => {
            if (!obj || typeof obj !== 'object') return;

            // Fix Path instances
            if (obj instanceof BabelfontPath && obj.nodes === undefined) {
                obj.nodes = [];
            }

            // Recursively process all properties
            if (Array.isArray(obj)) {
                obj.forEach((item) => ensurePathNodes(item));
            } else {
                Object.values(obj).forEach((value) => ensurePathNodes(value));
            }
        };

        // Fix all paths in the font before serialization
        ensurePathNodes(this);

        return JSON.stringify(this, (key, value) => {
            // When serializing shape objects, we need to handle multiple cases:
            // 1. Normalizer wrappers: { Path: {...}, nodes: [...], isInterpolated?: bool }
            // 2. Unwrapped shapes: directly Path or Component instances without wrapper
            // Rust expects: { Path: {...} } or { Component: {...} } (tagged format)
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // If we're processing the content inside a Path or Component wrapper,
                // don't try to wrap it again (prevents infinite recursion)
                if (key === 'Path' || key === 'Component') {
                    return value;
                }

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

                // Handle unwrapped Path: has 'nodes' property but no 'Path' wrapper
                // Only wrap if it has a toJSON method (class instance or proxy), not plain objects
                // Plain objects from toJSON() don't have toJSON method
                if (
                    'nodes' in value &&
                    'closed' in value &&
                    !('Path' in value) &&
                    !('Component' in value) &&
                    !('reference' in value) &&
                    typeof value.toJSON === 'function'
                ) {
                    // Get the serialized path (with nodes as string)
                    const pathData = value.toJSON();
                    return { Path: pathData };
                }

                // Handle unwrapped Component: has 'reference' property but no 'Component' wrapper
                // Check for parent getter (defined on class instances via ensureParentAccessors)
                // to distinguish class instances from plain objects
                if (
                    'reference' in value &&
                    !('Path' in value) &&
                    !('Component' in value) &&
                    !('nodes' in value && 'closed' in value) &&
                    Object.getOwnPropertyDescriptor(value, 'parent')?.get
                ) {
                    // Filter out internal properties like __parent
                    const { __parent, ...componentData } = value as any;
                    return { Component: componentData };
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
        return new Font(data, ExtendedClassRegistry);
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(font)  # <Font "MyFont" 123 glyphs>
     */
    toString(): string {
        const familyName =
            this.names?.family_name?.en ||
            Object.values(this.names?.family_name || {})[0] ||
            'Unnamed';
        const glyphCount = this.glyphs?.length || 0;
        const masterCount = this.masters?.length || 0;
        const axisCount = this.axes?.length || 0;
        const info =
            masterCount > 1 ? ` ${axisCount} axes, ${masterCount} masters` : '';
        return `<Font "${familyName}" ${glyphCount} glyphs${info}>`;
    }
}

// ============================================================================
// Glyph Class
// ============================================================================

export class Glyph extends BabelfontGlyph {
    constructor(data: IGlyph) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const codepoints =
                    this.codepoints
                        ?.map(
                            (cp) =>
                                `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
                        )
                        .join(', ') || 'none';
                const layerCount = this.layers?.length || 0;
                return `<Glyph "${this.name}" [${codepoints}] ${layerCount} layers>`;
            }
        });
    }

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
        return this.getLayer(id) as Layer | undefined;
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

    /**
     * Create and add a new layer to the glyph
     *
     * @param masterId - The master ID for this layer (optional)
     * @param width - Layer width (default: 600)
     * @returns The newly created layer
     * @example
     * layer = glyph.addLayer("m01")
     * print(layer.width)
     */
    addLayer(masterId?: string, width: number = 600): Layer {
        // Create minimal layer data matching ILayer interface
        const layerData: any = {
            width,
            shapes: [] as any[],
            anchors: [] as any[]
        };
        if (masterId) {
            layerData.master = masterId;
            layerData.id = masterId;
        }
        const layer = new Layer(layerData);
        if (!this.layers) this.layers = [];
        this.layers.push(layer as any);
        // Set parent relationship
        setParent(layer as any, this);
        return layer;
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(glyph)  # <Glyph "A" [U+0041] 2 layers>
     */
    toString(): string {
        const codepoints =
            this.codepoints
                ?.map(
                    (cp) =>
                        `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
                )
                .join(', ') || 'none';
        const layerCount = this.layers?.length || 0;
        return `<Glyph "${this.name}" [${codepoints}] ${layerCount} layers>`;
    }
}

// ============================================================================
// Layer Class
// ============================================================================

export class Layer extends BabelfontLayer {
    // Custom property for caching component layer data
    cachedComponentLayerData?: any;

    constructor(data: ILayer) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                let masterId: string;
                if (typeof this.master === 'object') {
                    if ('DefaultForMaster' in this.master) {
                        masterId = (this.master as any).DefaultForMaster;
                    } else if ('AssociatedWithMaster' in this.master) {
                        masterId = (this.master as any).AssociatedWithMaster;
                    } else {
                        masterId = (this.master as any).master || 'unknown';
                    }
                } else {
                    masterId = this.master || this.id || 'unknown';
                }
                const width =
                    this.width !== undefined ? ` width=${this.width}` : '';
                return `<Layer "${masterId}"${width}>`;
            }
        });
    }

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
        const bbox = this.getBoundingBox(false);
        if (!bbox) return 0;
        return bbox.minX;
    }

    /**
     * Set left sidebearing
     *
     * @param value - New LSB value
     * @example
     * layer.lsb = 50
     */
    set lsb(value: number) {
        const bbox = this.getBoundingBox(false);
        if (!bbox) return;

        const delta = value - bbox.minX;

        // Shift all shapes
        this.shapes?.forEach((shape) => {
            if (isPath(shape)) {
                // Path - shift all nodes
                shape.nodes?.forEach((node: any) => {
                    node.x += delta;
                });
            } else if (isComponent(shape)) {
                // Component - ensure transform exists and update translation
                if (!shape.transform) {
                    // Create default identity transform as DecomposedAffine
                    (shape as any).transform = new BabelfontDecomposedAffine({
                        translation: [0, 0],
                        scale: [1, 1],
                        rotation: 0,
                        skew: [0, 0]
                    });
                }
                const transform = shape.transform as any;
                if (transform.translation) {
                    // DecomposedAffine format with translation: [x, y]
                    transform.translation[0] =
                        (transform.translation[0] || 0) + delta;
                } else if (Array.isArray(transform)) {
                    // Matrix format [a, b, c, d, tx, ty]
                    transform[4] = (transform[4] || 0) + delta;
                }
            }
        });

        // Adjust width to maintain rsb
        this.width += delta;
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
        const bbox = this.getBoundingBox(false);
        if (!bbox) return 0;
        return this.width - bbox.maxX;
    }

    /**
     * Set right sidebearing
     *
     * @param value - New RSB value
     * @example
     * layer.rsb = 50
     */
    set rsb(value: number) {
        const bbox = this.getBoundingBox(false);
        if (!bbox) return;

        const currentRsb = this.width - bbox.maxX;
        const delta = value - currentRsb;
        this.width += delta;

        this.markDirty();
    }

    /**
     * Get the master ID for this layer
     * Handles the various formats master can be stored in
     *
     * @returns The master ID string
     */
    getMasterId(): string | undefined {
        if (!this.master) return this.id;
        if (typeof this.master === 'string') return this.master;
        if (typeof this.master === 'object') {
            const m = this.master as any;
            if ('DefaultForMaster' in m) return m.DefaultForMaster;
            if ('AssociatedWithMaster' in m) return m.AssociatedWithMaster;
            if ('master' in m) return m.master;
        }
        return this.id;
    }

    /**
     * Find the matching layer on another glyph (same master)
     *
     * @param glyphName - Name of the glyph to find matching layer on
     * @returns The matching layer if found, undefined otherwise
     * @example
     * layer_a = glyph_a.layers[0]
     * layer_b = layer_a.getMatchingLayerOnGlyph("B")  # Same master on glyph B
     */
    getMatchingLayerOnGlyph(glyphName: string): Layer | undefined {
        // Navigate up to get the font
        const glyph = this.parent as Glyph;
        if (!glyph) return undefined;
        const font = glyph.parent as Font;
        if (!font) return undefined;

        // Find the target glyph
        const targetGlyph = font.findGlyph(glyphName);
        if (!targetGlyph || !targetGlyph.layers) return undefined;

        // Get this layer's master ID
        const masterId = this.getMasterId();
        if (!masterId) return undefined;

        // Find matching layer in target glyph
        for (const layer of targetGlyph.layers) {
            const extLayer = layer as Layer;
            if (extLayer.getMasterId() === masterId) {
                return extLayer;
            }
        }

        return undefined;
    }

    /**
     * Get sidebearings at a specific height (y value)
     * Calculates the distance from the left edge (0) and right edge (layer width) to the outline intersections at the given height
     *
     * @param height - The y coordinate at which to measure sidebearings
     * @param includeComponents - Whether to include component paths in the calculation (default: true)
     * @returns Object with left and right sidebearing values, or null if no intersections found at this height
     * @example
     * sb = layer.getSidebearingsAtHeight(400)
     * if sb:
     *     print(f"LSB at 400: {sb['left']}, RSB at 400: {sb['right']}")
     */
    getSidebearingsAtHeight(
        height: number,
        includeComponents: boolean = true
    ): { left: number; right: number } | null {
        const glyphWidth = this.width;

        // Define horizontal line extending far beyond glyph bounds
        const lineP1 = { x: -10000, y: height };
        const lineP2 = { x: glyphWidth + 10000, y: height };

        // Use existing getIntersectionsOnLine method with components included
        const intersections = this.getIntersectionsOnLine(
            lineP1,
            lineP2,
            includeComponents
        );

        if (intersections.length === 0) {
            return null;
        }

        // Sort by X coordinate
        intersections.sort((a, b) => a.x - b.x);

        const firstIntersection = intersections[0];
        const lastIntersection = intersections[intersections.length - 1];

        // Calculate distances from glyph edges
        const leftSidebearing = firstIntersection.x - 0;
        const rightSidebearing = glyphWidth - lastIntersection.x;

        return {
            left: leftSidebearing,
            right: rightSidebearing
        };
    }

    /**
     * Add a new path to the layer
     *
     * @param closed - Whether the path should be closed (default: False)
     * @returns The newly created path
     * @example
     * path = layer.addPath()
     * path.addNode({"x": 0, "y": 0, "type": "line"})
     */
    addPath(closed: boolean = false): Path {
        // Create path using constructor with empty nodes string
        // IPath interface expects nodes as Node[] but constructor parses string to Node[]
        const path = new Path({ nodes: '' as any, closed } as IPath);
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

        // Helper to check if shape is a path (class instance or plain object)
        // Note: Check property-based detection FIRST because instanceof may fail with Proxy-wrapped objects
        const isPath = (shape: any): boolean => {
            // Plain object with wrapped format {Path: {...}}
            if (shape && typeof shape === 'object' && 'Path' in shape)
                return true;
            // Plain object or class instance with nodes array (but not component)
            if (
                shape &&
                typeof shape === 'object' &&
                'nodes' in shape &&
                !('reference' in shape)
            )
                return true;
            return false;
        };

        // Helper to check if shape is a component (class instance or plain object)
        // Note: Check property-based detection FIRST because instanceof may fail with Proxy-wrapped objects
        const isComponent = (shape: any): boolean => {
            // Plain object with wrapped format {Component: {...}}
            if (shape && typeof shape === 'object' && 'Component' in shape)
                return true;
            // Plain object or class instance with direct reference property
            if (shape && typeof shape === 'object' && 'reference' in shape)
                return true;
            return false;
        };

        // Helper to get path data from shape (handles both formats)
        // Note: Check property-based detection FIRST because instanceof may fail with Proxy-wrapped objects
        const getPathData = (
            shape: any
        ): { nodes: any[]; closed: boolean } | null => {
            // Plain object with wrapped format {Path: {...}}
            if ('Path' in shape) {
                const pathData = shape.Path;
                if (!pathData.nodes) return null;
                const nodes = Array.isArray(pathData.nodes)
                    ? pathData.nodes
                    : [];
                return { nodes, closed: pathData.closed ?? true };
            }
            // Plain object or class instance with direct nodes (Proxy-wrapped or not)
            if ('nodes' in shape) {
                const nodes = Array.isArray(shape.nodes) ? shape.nodes : [];
                return { nodes, closed: shape.closed ?? true };
            }
            return null;
        };

        // Helper to convert DecomposedAffine plain object to affine array
        const decomposedToAffine = (decomposed: any): number[] => {
            if (!decomposed) return [1, 0, 0, 1, 0, 0];
            // Ensure all required fields have defaults before instantiating
            const normalized = {
                translation: decomposed.translation ?? [0, 0],
                scale: decomposed.scale ?? [1, 1],
                rotation: decomposed.rotation ?? 0,
                skew: decomposed.skew ?? [0, 0],
                order: decomposed.order
            };
            const instance = new BabelfontDecomposedAffine(normalized);
            return instance.toAffine();
        };

        // Helper to get component data from shape (handles both formats)
        // Note: Check property-based detection FIRST because instanceof may fail with Proxy-wrapped objects
        const getComponentData = (
            shape: any
        ): {
            reference: string;
            transform: number[];
            inlineLayerData?: any;
        } | null => {
            // Helper to check if object is array-like (0-5 numeric keys from Proxy-wrapped array)
            const isArrayLikeTransform = (obj: any): boolean => {
                return (
                    obj &&
                    typeof obj === 'object' &&
                    '0' in obj &&
                    '1' in obj &&
                    '2' in obj &&
                    '3' in obj &&
                    '4' in obj &&
                    '5' in obj
                );
            };

            // Helper to convert array-like object to array
            const toTransformArray = (obj: any): number[] => {
                return [obj[0], obj[1], obj[2], obj[3], obj[4], obj[5]];
            };

            // Plain object with wrapped format {Component: {...}}
            if ('Component' in shape) {
                const compData = shape.Component;
                let transform = [1, 0, 0, 1, 0, 0];
                if (Array.isArray(compData.transform)) {
                    transform = compData.transform;
                } else if (isArrayLikeTransform(compData.transform)) {
                    // Proxy-wrapped array with numeric keys
                    transform = toTransformArray(compData.transform);
                } else if (
                    compData.transform &&
                    typeof compData.transform === 'object'
                ) {
                    // DecomposedAffine object (class instance or plain) - normalize and convert
                    transform = decomposedToAffine(compData.transform);
                }
                return {
                    reference: compData.ref || compData.reference,
                    transform,
                    inlineLayerData: compData.layerData
                };
            }
            // Plain object or class instance with direct reference (Proxy-wrapped or not)
            if ('reference' in shape) {
                let transform = [1, 0, 0, 1, 0, 0];
                if (Array.isArray(shape.transform)) {
                    transform = shape.transform;
                } else if (isArrayLikeTransform(shape.transform)) {
                    // Proxy-wrapped array with numeric keys
                    transform = toTransformArray(shape.transform);
                } else if (
                    shape.transform &&
                    typeof shape.transform === 'object'
                ) {
                    // DecomposedAffine object (class instance or plain) - normalize and convert
                    transform = decomposedToAffine(shape.transform);
                }
                return {
                    reference: shape.ref || shape.reference,
                    transform,
                    inlineLayerData: shape.layerData
                };
            }
            return null;
        };

        // Process shapes
        const processShape = (
            shape: Path | Component,
            transform: number[] = [1, 0, 0, 1, 0, 0]
        ) => {
            if (isPath(shape)) {
                // Direct path - transform its nodes
                const pathData = getPathData(shape);
                if (!pathData) return;
                const transformedNodes = pathData.nodes.map((node: any) =>
                    transformNode(node, transform)
                );
                flattenedPaths.push({
                    nodes: transformedNodes,
                    closed: pathData.closed
                });
            } else if (isComponent(shape)) {
                // Component - recursively process its shapes with accumulated transform
                const compData = getComponentData(shape);
                if (!compData) return;

                const combinedTransform = combineTransforms(
                    transform,
                    compData.transform
                );

                // First priority: use inline layerData if available (for interpolated data)
                if (compData.inlineLayerData?.shapes) {
                    for (const nestedShape of compData.inlineLayerData.shapes) {
                        processShape(
                            nestedShape as Path | Component,
                            combinedTransform
                        );
                    }
                    return;
                }

                // Fallback: look up the component glyph from font
                if (font) {
                    const componentGlyph = font.findGlyph(compData.reference);
                    if (
                        componentGlyph &&
                        componentGlyph.layers &&
                        componentGlyph.layers.length > 0
                    ) {
                        // Find matching layer by master ID, fall back to first layer
                        let componentLayer = componentGlyph.layers[0];
                        if (layer.id) {
                            const matchingLayer = componentGlyph.layers.find(
                                (l: any) => l.id === layer.id
                            );
                            if (matchingLayer) {
                                componentLayer = matchingLayer;
                            }
                        }
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

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(layer)  # <Layer "m01" width=500>
     */
    toString(): string {
        let masterId: string;
        if (typeof this.master === 'object') {
            if ('DefaultForMaster' in this.master) {
                masterId = (this.master as any).DefaultForMaster;
            } else if ('AssociatedWithMaster' in this.master) {
                masterId = (this.master as any).AssociatedWithMaster;
            } else {
                masterId = (this.master as any).master || 'unknown';
            }
        } else {
            masterId = this.master || this.id || 'unknown';
        }
        const width = this.width !== undefined ? ` width=${this.width}` : '';
        return `<Layer "${masterId}"${width}>`;
    }
}

// ============================================================================
// Path Class
// ============================================================================

export class Path extends BabelfontPath {
    constructor(data: IPath) {
        // Handle nodes that are already arrays (from WASM output) vs strings (from Glyphs files)
        // babelfont-ts parseNodes() expects a string, so we need to convert arrays to string format
        if (data.nodes && Array.isArray(data.nodes)) {
            // Convert array of node objects to string format: "x y type x y type ..."
            const nodesStr = (data.nodes as any[])
                .map((n: any) => {
                    const typeChar =
                        n.nodetype === 'move'
                            ? 'm'
                            : n.nodetype === 'offcurve'
                              ? 'o'
                              : n.nodetype === 'curve'
                                ? n.smooth
                                    ? 'cs'
                                    : 'c'
                                : n.nodetype === 'qcurve'
                                  ? n.smooth
                                      ? 'qs'
                                      : 'q'
                                  : n.smooth
                                    ? 'ls'
                                    : 'l';
                    return `${n.x} ${n.y} ${typeChar}`;
                })
                .join(' ');
            (data as any).nodes = nodesStr;
        }
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const closedStr = this.closed ? 'closed' : 'open';
                const nodeCount = Array.isArray(this.nodes)
                    ? this.nodes.length
                    : 0;
                return `<Path ${closedStr} ${nodeCount} nodes>`;
            }
        });
    }

    /**
     * Override toJSON to add safety check for undefined nodes
     * This prevents crashes during serialization if nodes isn't properly initialized
     */
    toJSON(): any {
        // Ensure nodes is initialized before calling parent toJSON
        if (!this.nodes) {
            this.nodes = [];
        }
        return super.toJSON();
    }

    /**
     * Convert nodes array to compact string format
     *
     * @param nodes - Array of nodes
     * @returns Compact string representation
     * @example
     * nodes_str = Path.nodesToString(path.nodes)
     */
    static nodesToString(nodes: any[]): string {
        // Use babelfont-ts Path.toJSON() method
        // We need to create a Path instance with the nodes, but IPath expects nodes as string
        // So we bypass the constructor and set properties directly
        const tempPath = Object.create(Path.prototype);
        tempPath.nodes = nodes;
        tempPath.closed = false;
        return tempPath.toJSON().nodes;
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

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(path)  # <Path closed 4 nodes>
     */
    toString(): string {
        const closedStr = this.closed ? 'closed' : 'open';
        const nodeCount = Array.isArray(this.nodes) ? this.nodes.length : 0;
        return `<Path ${closedStr} ${nodeCount} nodes>`;
    }
}

// ============================================================================
// Component Class
// ============================================================================

export class Component extends BabelfontComponent {
    // Custom property for caching component layer data
    cachedComponentLayerData?: any;

    constructor(data: IComponent) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const transform = this.transform
                    ? ` transform=${JSON.stringify(this.transform)}`
                    : '';
                return `<Component ref="${this.reference}"${transform}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(comp)  # <Component ref="A">
     */
    toString(): string {
        const transform = this.transform
            ? ` transform=${JSON.stringify(this.transform)}`
            : '';
        return `<Component ref="${this.reference}"${transform}>`;
    }
}

// ============================================================================
// Re-export other classes unchanged
// ============================================================================

export class Node extends BabelfontNode {
    constructor(data: INode) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const smooth = this.smooth ? ' smooth' : '';
                return `<Node (${this.x}, ${this.y}) ${this.nodetype}${smooth}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(node)  # <Node (100, 200) Line smooth>
     */
    toString(): string {
        const smooth = this.smooth ? ' smooth' : '';
        return `<Node (${this.x}, ${this.y}) ${this.nodetype}${smooth}>`;
    }
}
export class Anchor extends BabelfontAnchor {
    constructor(data: IAnchor) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const name = this.name ? ` "${this.name}"` : '';
                return `<Anchor${name} (${this.x}, ${this.y})>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(anchor)  # <Anchor "top" (250, 700)>
     */
    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Anchor${name} (${this.x}, ${this.y})>`;
    }
}
export class Guide extends BabelfontGuide {
    constructor(data: IGuide) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const name = this.name ? ` "${this.name}"` : '';
                return `<Guide${name} pos=${JSON.stringify(this.pos)}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(guide)  # <Guide "baseline" pos={...}>
     */
    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Guide${name} pos=${JSON.stringify(this.pos)}>`;
    }
}
export class Axis extends BabelfontAxis {
    constructor(data: IAxis) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const displayName =
                    typeof this.name === 'string'
                        ? this.name
                        : this.name?.dflt ||
                          Object.values(this.name || {})[0] ||
                          'unknown';
                const range = `${this.min || '?'}-${this.default || '?'}-${this.max || '?'}`;
                return `<Axis "${displayName}" tag="${this.tag}" ${range}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(axis)  # <Axis "Weight" tag="wght" 100-400-900>
     */
    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.dflt ||
                  Object.values(this.name || {})[0] ||
                  'unknown';
        const range = `${this.min || '?'}-${this.default || '?'}-${this.max || '?'}`;
        return `<Axis "${displayName}" tag="${this.tag}" ${range}>`;
    }
}
export class Instance extends BabelfontInstance {
    constructor(data: IInstance) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const displayName =
                    typeof this.name === 'string'
                        ? this.name
                        : this.name?.en ||
                          Object.values(this.name || {})[0] ||
                          'unknown';
                const location = this.location
                    ? JSON.stringify(this.location)
                    : '{}';
                return `<Instance "${displayName}" location=${location}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(instance)  # <Instance "Bold" location={...}>
     */
    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'unknown';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Instance "${displayName}" location=${location}>`;
    }
}
export class Master extends BabelfontMaster {
    constructor(data: IMaster) {
        super(data);

        // Add _pyrepr as a getter that computes the string inline (bypasses Proxy interception)
        // This is used by the Python wrapper for __str__ representation for print()
        Object.defineProperty(this, '_pyrepr', {
            get: () => {
                const displayName =
                    typeof this.name === 'string'
                        ? this.name
                        : this.name?.en ||
                          Object.values(this.name || {})[0] ||
                          'unknown';
                const location = this.location
                    ? JSON.stringify(this.location)
                    : '{}';
                return `<Master "${displayName}" id="${this.id}" location=${location}>`;
            }
        });
    }

    /**
     * String representation for debugging
     *
     * @returns Human-readable string
     * @example
     * print(master)  # <Master "Regular" id="m01" location={...}>
     */
    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'unknown';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Master "${displayName}" id="${this.id}" location=${location}>`;
    }
}
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
 * Unwrap shapes from babelfont JSON format to babelfont-ts expected format.
 * babelfont JSON uses: {Component: {reference: ...}} and {Path: {nodes: ...}}
 * babelfont-ts expects: {reference: ...} and {nodes: ...} (flat format)
 */
function preprocessFontData(data: any): any {
    if (!data || !data.glyphs) return data;

    // Deep clone to avoid modifying original
    const cloned = JSON.parse(JSON.stringify(data));

    for (const glyph of cloned.glyphs) {
        if (!glyph.layers) continue;
        for (const layer of glyph.layers) {
            if (!layer.shapes) continue;
            layer.shapes = layer.shapes.map((shape: any) => {
                // Unwrap {Component: {...}} to flat format
                if (shape.Component) {
                    return shape.Component;
                }
                // Unwrap {Path: {...}} to flat format
                if (shape.Path) {
                    return shape.Path;
                }
                // Already in flat format
                return shape;
            });
        }
    }

    return cloned;
}

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
    const preprocessed = preprocessFontData(data);
    return new Font(preprocessed, ExtendedClassRegistry);
}
