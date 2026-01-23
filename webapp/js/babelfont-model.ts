/**
 * Babelfont Object Model
 *
 * This module provides an object-oriented facade over the raw babelfontJson data.
 * All objects are lightweight wrappers that read/write directly to the underlying
 * JSON structure using getters and setters - no data duplication.
 *
 * This allows:
 * - Type-safe object manipulation in JavaScript/TypeScript
 * - Rich methods on classes (e.g., path.insertNode())
 * - Direct synchronous access from Python via Pyodide's JsProxy system
 */

import type { Babelfont } from './babelfont';
import { LayerDataNormalizer } from './layer-data-normalizer';
import { Bezier } from 'bezier-js';

/**
 * Mark the current font as dirty when data is modified
 */
function markFontDirty(): void {
    if (window.fontManager?.currentFont) {
        window.fontManager.currentFont.dirty = true;
        console.log('[BabelfontModel]', '✏️ Font marked as dirty');
    } else {
        console.warn(
            '[BabelfontModel]',
            '⚠️ Cannot mark font dirty - no currentFont'
        );
    }
}

/**
 * Base class for model objects that wrap JSON data
 */
abstract class ModelBase {
    protected _data: any;
    protected _parentObject: any = null;

    constructor(data: any, parentObject: any = null) {
        this._data = data;
        this._parentObject = parentObject;
    }

    /**
     * Get the underlying JSON data for this object
     */
    toJSON(): any {
        return this._data;
    }

    /**
     * Get the parent object in the hierarchy
     * @returns The parent object, or null if this is the root Font object
     */
    parent(): any {
        return this._parentObject;
    }
}

/**
 * Base class for objects that are elements in an array
 */
abstract class ArrayElementBase extends ModelBase {
    protected _parent: any[];
    protected _index: number;

    constructor(parent: any[], index: number, parentObject: any = null) {
        super(parent[index], parentObject);
        this._parent = parent;
        this._index = index;
    }

    /**
     * Get current data (handles index changes)
     */
    protected get data(): any {
        return this._parent[this._index];
    }

    /**
     * Update underlying data reference and mark font as dirty
     */
    protected set data(value: any) {
        this._parent[this._index] = value;
        markFontDirty();
    }
}

/**
 * Point in a path
 */
export class Node extends ArrayElementBase {
    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        this.data.x = value;
        markFontDirty();
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        this.data.y = value;
        markFontDirty();
    }

    get nodetype(): Babelfont.NodeType {
        return this.data.nodetype;
    }

    set nodetype(value: Babelfont.NodeType) {
        this.data.nodetype = value;
        markFontDirty();
    }

    get smooth(): boolean | undefined {
        return this.data.smooth;
    }

    set smooth(value: boolean | undefined) {
        this.data.smooth = value;
        markFontDirty();
    }

    toString(): string {
        const smooth = this.smooth ? ' smooth' : '';
        return `<Node (${this.x}, ${this.y}) ${this.nodetype}${smooth}>`;
    }
}

/**
 * Path (contour) in a layer
 */
export class Path extends ArrayElementBase {
    private _nodeWrappers: Node[] | null = null;

    get nodes(): Node[] {
        // If nodes is a string (from babelfont-rs compact format), parse it once
        // and replace the string with the array in the underlying JSON data.
        // This ensures all future accesses see the array, and modifications
        // are properly persisted to the JSON structure.
        if (typeof this.data.nodes === 'string') {
            this.data.nodes = this.parseNodesString(this.data.nodes);
        }

        // Ensure nodes is an array (defensive)
        if (!Array.isArray(this.data.nodes)) {
            this.data.nodes = [];
        }

        // Create wrapper objects if needed
        if (
            !this._nodeWrappers ||
            this._nodeWrappers.length !== this.data.nodes.length
        ) {
            this._nodeWrappers = this.data.nodes.map(
                (_: any, i: number) => new Node(this.data.nodes, i, this)
            );
        }
        return this._nodeWrappers!;
    }

    set nodes(value: Babelfont.Node[]) {
        this.data.nodes = value;
        this._nodeWrappers = null; // Invalidate cache
    }

    /**
     * Parse nodes from babelfont-rs string format
     * Format: "x1 y1 type x2 y2 type ..."
     * Types: m, l, o, c, q (with optional 's' suffix for smooth)
     */
    private parseNodesString(nodesStr: string): Babelfont.Node[] {
        const trimmed = nodesStr.trim();
        if (!trimmed) return [];

        const tokens = trimmed.split(/\s+/);
        const nodesArray: Babelfont.Node[] = [];

        for (let i = 0; i + 2 < tokens.length; i += 3) {
            const typeStr = tokens[i + 2];
            const smooth = typeStr.endsWith('s');
            const nodetype = this.mapNodeType(
                smooth ? typeStr.slice(0, -1) : typeStr
            );

            const node: Babelfont.Node = {
                x: parseFloat(tokens[i]),
                y: parseFloat(tokens[i + 1]),
                nodetype: nodetype
            };

            if (smooth) {
                node.smooth = true;
            }

            nodesArray.push(node);
        }

        return nodesArray;
    }

    /**
     * Map short node type to Babelfont.NodeType
     */
    private mapNodeType(shortType: string): Babelfont.NodeType {
        const map: Record<string, Babelfont.NodeType> = {
            m: 'Move',
            l: 'Line',
            o: 'OffCurve',
            c: 'Curve',
            q: 'QCurve'
        };
        return map[shortType] || 'Line';
    }

    /**
     * Convert nodes array back to compact string format for serialization
     */
    static nodesToString(nodes: Babelfont.Node[]): string {
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
                q: 'q',
                ms: 'm',
                ls: 'l',
                os: 'o',
                cs: 'c',
                qs: 'q'
            };

            let typeStr = typeMap[nodeType] || 'l';

            // Handle smooth flag - check if it's in the type string or separate property
            const isSmooth =
                node.smooth ||
                (typeof nodeType === 'string' && nodeType.endsWith('s'));
            if (isSmooth) {
                typeStr += 's';
            }

            tokens.push(typeStr);
        }

        return tokens.join(' ');
    }

    get closed(): boolean {
        return this.data.closed;
    }

    set closed(value: boolean) {
        this.data.closed = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

    /**
     * Insert a node at the specified index
     * @example
     * path.insertNode(1, 150, 250, "Line")  # Insert at index 1
     */
    insertNode(
        index: number,
        x: number,
        y: number,
        nodetype: Babelfont.NodeType = 'Line',
        smooth?: boolean
    ): Node {
        const nodeData: Babelfont.Node = { x, y, nodetype };
        if (smooth !== undefined) {
            nodeData.smooth = smooth;
        }

        this.data.nodes.splice(index, 0, nodeData);
        this._nodeWrappers = null; // Invalidate cache
        return new Node(this.data.nodes, index);
    }

    /**
     * Remove a node at the specified index
     * @example
     * path.removeNode(0)  # Remove first node
     */
    removeNode(index: number): void {
        this.data.nodes.splice(index, 1);
        this._nodeWrappers = null; // Invalidate cache
    }

    /**
     * Append a node to the end of the path
     * @example
     * path.appendNode(100, 200, "Line")
     * path.appendNode(300, 400, "Curve", smooth=True)
     */
    appendNode(
        x: number,
        y: number,
        nodetype: Babelfont.NodeType = 'Line',
        smooth?: boolean
    ): Node {
        return this.insertNode(this.data.nodes.length, x, y, nodetype, smooth);
    }

    toString(): string {
        const closedStr = this.closed ? 'closed' : 'open';
        const nodeCount = Array.isArray(this.data.nodes)
            ? this.data.nodes.length
            : 0;
        return `<Path ${closedStr} ${nodeCount} nodes>`;
    }
}

/**
 * Component reference to another glyph
 */
export class Component extends ArrayElementBase {
    get reference(): string {
        return this.data.reference;
    }

    set reference(value: string) {
        this.data.reference = value;
    }

    get transform(): number[] | undefined {
        return this.data.transform;
    }

    set transform(value: number[] | undefined) {
        this.data.transform = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

    toString(): string {
        const transform = this.transform
            ? ` transform=${JSON.stringify(this.transform)}`
            : '';
        return `<Component ref="${this.reference}"${transform}>`;
    }

    /**
     * Get all paths from this component with transforms applied recursively
     * Automatically determines the correct master by walking up the parent chain
     * @returns Array of transformed path data objects
     */
    getTransformedPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];
        const componentTransform = this.transform || [1, 0, 0, 1, 0, 0];

        // Get the Font object to look up component glyphs
        // Component -> Shape -> Layer -> Glyph -> Font
        const shape = this.parent() as Shape;
        if (!shape) return paths;

        const layer = shape.parent() as Layer;
        if (!layer) return paths;

        const glyph = layer.parent() as Glyph;
        if (!glyph) return paths;

        const font = glyph.parent() as Font;
        if (!font) return paths;

        // Get the master ID from the layer
        const masterId = (layer.master as any)?.DefaultForMaster;

        // Helper to transform a node
        const transformNode = (node: any, transform: number[]): any => {
            const [a, b, c, d, tx, ty] = transform;
            const result: any = {
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
            if (node.type !== undefined) result.type = node.type;
            if (node.nodetype !== undefined) result.nodetype = node.nodetype;
            if (node.smooth !== undefined) result.smooth = node.smooth;
            return result;
        };

        // Helper to combine two transform matrices
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

        // Look up the component glyph and get the matching layer
        const componentGlyph = font.findGlyph(this.reference);
        if (!componentGlyph || !componentGlyph.layers) return paths;

        let componentLayer;
        if (masterId) {
            componentLayer = componentGlyph.layers.find(
                (l) =>
                    l.master && (l.master as any).DefaultForMaster === masterId
            );
        }
        if (!componentLayer) {
            componentLayer = componentGlyph.layers[0];
        }
        if (!componentLayer) return paths;

        // Process shapes from the component layer
        if (componentLayer.shapes) {
            for (const shape of componentLayer.shapes) {
                if (shape.isComponent()) {
                    // Recursively get paths from nested components
                    const nestedComponent = shape.asComponent();
                    const nestedPaths = nestedComponent.getTransformedPaths();

                    // Apply this component's transform to all nested paths
                    for (const nestedPath of nestedPaths) {
                        const transformedNodes = nestedPath.nodes.map(
                            (node: any) =>
                                transformNode(node, componentTransform)
                        );
                        paths.push({
                            nodes: transformedNodes,
                            closed: nestedPath.closed
                        });
                    }
                } else if (shape.isPath()) {
                    // Transform the path nodes
                    const pathData = shape.asPath().toJSON();
                    let nodes = pathData.nodes;

                    // Parse nodes if they're a string
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    if (nodes && Array.isArray(nodes) && nodes.length > 0) {
                        const transformedNodes = nodes.map((node: any) =>
                            transformNode(node, componentTransform)
                        );
                        paths.push({
                            nodes: transformedNodes,
                            closed:
                                pathData.closed !== undefined
                                    ? pathData.closed
                                    : true
                        });
                    }
                }
            }
        }

        return paths;
    }
}

/**
 * Anchor point in a layer
 */
export class Anchor extends ArrayElementBase {
    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        this.data.x = value;
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        this.data.y = value;
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        this.data.name = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Anchor${name} (${this.x}, ${this.y})>`;
    }
}

/**
 * Guideline in a layer or master
 */
export class Guide extends ArrayElementBase {
    get pos(): Babelfont.Position {
        return this.data.pos;
    }

    set pos(value: Babelfont.Position) {
        this.data.pos = value;
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        this.data.name = value;
    }

    get color(): Babelfont.Color | undefined {
        return this.data.color;
    }

    set color(value: Babelfont.Color | undefined) {
        this.data.color = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Guide${name} pos=${JSON.stringify(this.pos)}>`;
    }
}

/**
 * Shape wrapper that can contain either a Component or a Path
 */
export class Shape extends ArrayElementBase {
    /**
     * Check if this shape is a component
     */
    isComponent(): boolean {
        return 'Component' in this.data;
    }

    /**
     * Check if this shape is a path
     */
    isPath(): boolean {
        return 'Path' in this.data;
    }

    /**
     * Get as Component (throws if not a component)
     */
    asComponent(): Component {
        if (!this.isComponent()) {
            throw new Error('Shape is not a Component');
        }
        // Create a fake array with single element to satisfy Component's constructor
        const fakeArray = [this.data.Component];
        Object.defineProperty(fakeArray, '0', {
            get: () => this.data.Component,
            set: (value) => {
                this.data.Component = value;
            }
        });
        return new Component(fakeArray as any, 0, this);
    }

    /**
     * Get as Path (throws if not a path)
     */
    asPath(): Path {
        if (!this.isPath()) {
            throw new Error('Shape is not a Path');
        }
        // Create a fake array with single element to satisfy Path's constructor
        const fakeArray = [this.data.Path];
        Object.defineProperty(fakeArray, '0', {
            get: () => this.data.Path,
            set: (value) => {
                this.data.Path = value;
            }
        });
        return new Path(fakeArray as any, 0, this);
    }

    toString(): string {
        if (this.isComponent()) {
            return `<Shape:${this.asComponent().toString()}>`;
        } else if (this.isPath()) {
            return `<Shape:${this.asPath().toString()}>`;
        }
        return '<Shape unknown>';
    }
}

/**
 * Layer in a glyph representing a master or intermediate design
 */
export class Layer extends ArrayElementBase {
    private _shapeWrappers: Shape[] | null = null;
    private _anchorWrappers: Anchor[] | null = null;
    private _guideWrappers: Guide[] | null = null;

    get width(): number {
        return this.data.width;
    }

    set width(value: number) {
        this.data.width = value;
    }

    /**
     * Get the left sidebearing (LSB) - the distance from x=0 to the left edge of the bounding box
     * @returns The left sidebearing value, or 0 if no geometry
     */
    get lsb(): number {
        const bbox = this.getBoundingBox(false);
        if (!bbox) {
            return 0;
        }
        return bbox.minX;
    }

    /**
     * Set the left sidebearing (LSB) by translating all geometry horizontally
     * This updates the position of all paths, components, and anchors, and adjusts width accordingly
     * @param value - The new left sidebearing value
     */
    set lsb(value: number) {
        const currentLsb = this.lsb;
        const offset = value - currentLsb;

        if (offset === 0) {
            return; // No change needed
        }

        // Translate all shapes (paths and components)
        if (this.data.shapes) {
            for (const shape of this.data.shapes) {
                if ('Path' in shape && shape.Path.nodes) {
                    // Parse nodes from string format
                    let nodes = shape.Path.nodes;
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    // Move all nodes in paths
                    if (Array.isArray(nodes)) {
                        for (const node of nodes) {
                            node.x += offset;
                        }
                        // Serialize back to string format
                        shape.Path.nodes =
                            LayerDataNormalizer.serializeNodes(nodes);
                    }
                } else if ('Component' in shape) {
                    // Update component transform translation
                    if (!shape.Component.transform) {
                        // Create identity transform if none exists
                        shape.Component.transform = [1, 0, 0, 1, 0, 0];
                    }
                    shape.Component.transform[4] += offset; // Update x translation
                }
            }
        }

        // Translate all anchors
        if (this.data.anchors) {
            for (const anchor of this.data.anchors) {
                anchor.x += offset;
            }
        }

        // Update width to maintain right sidebearing
        this.data.width += offset;

        markFontDirty();
    }

    /**
     * Get the right sidebearing (RSB) - the distance from the right edge of the bounding box to the advance width
     * @returns The right sidebearing value, or the width if no geometry
     */
    get rsb(): number {
        const bbox = this.getBoundingBox(false);
        if (!bbox) {
            return this.width;
        }
        return this.width - bbox.maxX;
    }

    /**
     * Set the right sidebearing (RSB) by adjusting the advance width
     * This only changes the width, not the geometry position
     * @param value - The new right sidebearing value
     */
    set rsb(value: number) {
        const bbox = this.getBoundingBox(false);
        if (!bbox) {
            this.data.width = value;
        } else {
            this.data.width = bbox.maxX + value;
        }
        markFontDirty();
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        this.data.name = value;
    }

    get id(): string | undefined {
        return this.data.id;
    }

    set id(value: string | undefined) {
        this.data.id = value;
    }

    get master(): Babelfont.LayerType | undefined {
        return this.data.master;
    }

    set master(value: Babelfont.LayerType | undefined) {
        this.data.master = value;
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: any, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return this._guideWrappers!;
    }

    get shapes(): Shape[] | undefined {
        if (!this.data.shapes) return undefined;
        if (
            !this._shapeWrappers ||
            this._shapeWrappers.length !== this.data.shapes.length
        ) {
            this._shapeWrappers = this.data.shapes.map(
                (_: any, i: number) => new Shape(this.data.shapes, i, this)
            );
        }
        return this._shapeWrappers!;
    }

    get anchors(): Anchor[] | undefined {
        if (!this.data.anchors) return undefined;
        if (
            !this._anchorWrappers ||
            this._anchorWrappers.length !== this.data.anchors.length
        ) {
            this._anchorWrappers = this.data.anchors.map(
                (_: any, i: number) => new Anchor(this.data.anchors, i, this)
            );
        }
        return this._anchorWrappers!;
    }

    get color(): Babelfont.Color | undefined {
        return this.data.color;
    }

    set color(value: Babelfont.Color | undefined) {
        this.data.color = value;
    }

    get layer_index(): number | undefined {
        return this.data.layer_index;
    }

    set layer_index(value: number | undefined) {
        this.data.layer_index = value;
    }

    get is_background(): boolean | undefined {
        return this.data.is_background;
    }

    set is_background(value: boolean | undefined) {
        this.data.is_background = value;
    }

    get background_layer_id(): string | undefined {
        return this.data.background_layer_id;
    }

    set background_layer_id(value: string | undefined) {
        this.data.background_layer_id = value;
    }

    get location(): Record<string, number> | undefined {
        return this.data.location;
    }

    set location(value: Record<string, number> | undefined) {
        this.data.location = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

    /**
     * Add a new shape to the layer
     */
    addShape(shape: Babelfont.Shape): Shape {
        if (!this.data.shapes) {
            this.data.shapes = [];
        }
        this.data.shapes.push(shape);
        this._shapeWrappers = null; // Invalidate cache
        return new Shape(this.data.shapes, this.data.shapes.length - 1);
    }

    /**
     * Add a new path to the layer
     * @example
     * path = layer.addPath(closed=True)
     */
    addPath(closed: boolean = true): Path {
        const pathData: Babelfont.Path = {
            nodes: [],
            closed
        };
        const shapeData: Babelfont.Shape = { Path: pathData };
        const shape = this.addShape(shapeData);
        return shape.asPath();
    }

    /**
     * Add a new component to the layer
     * @example
     * component = layer.addComponent("A")
     * # With transformation
     * component = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])
     */
    addComponent(reference: string, transform?: number[]): Component {
        const componentData: Babelfont.Component = { reference };
        if (transform) {
            componentData.transform = transform;
        }
        const shapeData: Babelfont.Shape = { Component: componentData };
        const shape = this.addShape(shapeData);
        return shape.asComponent();
    }

    /**
     * Remove a shape at the specified index
     */
    removeShape(index: number): void {
        if (this.data.shapes) {
            this.data.shapes.splice(index, 1);
            this._shapeWrappers = null; // Invalidate cache
        }
    }

    /**
     * Add a new anchor to the layer
     * @example
     * anchor = layer.addAnchor(250, 700, "top")
     */
    addAnchor(x: number, y: number, name?: string): Anchor {
        if (!this.data.anchors) {
            this.data.anchors = [];
        }
        const anchorData: Babelfont.Anchor = { x, y };
        if (name) {
            anchorData.name = name;
        }
        this.data.anchors.push(anchorData);
        this._anchorWrappers = null; // Invalidate cache
        return new Anchor(this.data.anchors, this.data.anchors.length - 1);
    }

    /**
     * Remove an anchor at the specified index
     */
    removeAnchor(index: number): void {
        if (this.data.anchors) {
            this.data.anchors.splice(index, 1);
            this._anchorWrappers = null; // Invalidate cache
        }
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
    public static processPathSegments(pathData: {
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
     * @param layerData - Raw layer data object
     * @param font - Font object for looking up component references
     * @returns Array of flattened path data objects with transformed coordinates
     */
    private static flattenComponents(
        layerData: any,
        font?: Font,
        masterId?: string
    ): Babelfont.Path[] {
        const flattenedPaths: Babelfont.Path[] = [];

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

        // Helper function to process shapes recursively (for components)
        const processShapes = (
            shapes: any[],
            transform: number[] = [1, 0, 0, 1, 0, 0]
        ) => {
            if (!shapes || !Array.isArray(shapes)) return;

            for (const shape of shapes) {
                if ('Component' in shape) {
                    // Component - recursively process its outline shapes with accumulated transform
                    const compTransform = shape.Component.transform || [
                        1, 0, 0, 1, 0, 0
                    ];
                    const combinedTransform = combineTransforms(
                        transform,
                        compTransform
                    );

                    // Get component's layer data - either from pre-populated layerData
                    // or by looking up the component glyph in the font
                    let componentLayerData = shape.Component.layerData;

                    if (!componentLayerData && font) {
                        // Look up the component glyph and get the matching layer for the current master
                        const componentGlyph = font.findGlyph(
                            shape.Component.reference
                        );
                        if (componentGlyph && componentGlyph.layers) {
                            let layer;
                            if (masterId) {
                                // Find the layer that matches the current master
                                layer = componentGlyph.layers.find(
                                    (l) =>
                                        l.data.master &&
                                        (l.data.master as any)
                                            .DefaultForMaster === masterId
                                );
                            }
                            // Fallback to first layer if no matching master found
                            if (!layer) {
                                layer = componentGlyph.layers[0];
                            }
                            if (layer) {
                                componentLayerData = layer.toJSON();
                            }
                        }
                    }

                    // Recursively process the component's actual outline shapes
                    if (componentLayerData && componentLayerData.shapes) {
                        processShapes(
                            componentLayerData.shapes,
                            combinedTransform
                        );
                    }
                } else if ('Path' in shape && shape.Path.nodes) {
                    // Path with nested structure
                    let nodes = shape.Path.nodes;

                    // Parse nodes if they're a string
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    if (Array.isArray(nodes) && nodes.length > 0) {
                        // Transform all nodes and create a new path
                        const transformedNodes = nodes.map((node: any) =>
                            transformNode(node, transform)
                        );

                        flattenedPaths.push({
                            nodes: transformedNodes,
                            closed: shape.Path.closed
                        });
                    }
                } else if (
                    'nodes' in shape &&
                    Array.isArray(shape.nodes) &&
                    shape.nodes.length > 0
                ) {
                    // Path with flat structure (parsed format)
                    const transformedNodes = shape.nodes.map((node: any) =>
                        transformNode(node, transform)
                    );

                    flattenedPaths.push({
                        nodes: transformedNodes,
                        closed: shape.closed !== undefined ? shape.closed : true
                    });
                }
            }
        };

        // Process all shapes
        if (layerData.shapes) {
            processShapes(layerData.shapes);
        }

        return flattenedPaths;
    }

    /**
     * Get only direct paths in this layer (no components)
     * @returns Array of path data objects from shapes that are paths
     */
    private getDirectPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];

        if (!this.shapes) return paths;

        for (const shape of this.shapes) {
            if (shape.isPath()) {
                const pathData = shape.asPath().toJSON();
                if (pathData.nodes) {
                    paths.push(pathData);
                }
            }
        }

        return paths;
    }

    /**
     * Get all paths in this layer including transformed paths from components (recursively flattened)
     * @returns Array of path data objects with all components resolved to transformed paths
     */
    getAllPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];

        if (!this.shapes) return paths;

        for (const shape of this.shapes) {
            if (shape.isPath()) {
                // Add direct path
                const pathData = shape.asPath().toJSON();
                if (pathData.nodes) {
                    // Parse nodes if they're stored as a string
                    if (typeof pathData.nodes === 'string') {
                        pathData.nodes = LayerDataNormalizer.parseNodes(
                            pathData.nodes
                        );
                    }
                    paths.push(pathData);
                }
            } else if (shape.isComponent()) {
                // Get transformed paths from component recursively
                const component = shape.asComponent();
                const componentPaths = component.getTransformedPaths();
                paths.push(...componentPaths);
            }
        }

        return paths;
    }

    /**
     * Calculate bounding box for layer data
     * @param layerData - Raw layer data object
     * @param includeAnchors - If true, include anchors in the bounding box calculation (default: false)
     * @param font - Font object for component lookup (optional)
     * @param masterId - Master ID for finding matching component layers (optional)
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    static calculateBoundingBox(
        layerData: any,
        includeAnchors: boolean = false,
        font?: Font,
        masterId?: string
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

        // Get all paths (we need to use the static flattenComponents for compatibility)
        // since we're working with raw layer data, not a Layer instance
        const paths = Layer.flattenComponents(layerData, font, masterId);

        // Process all paths
        for (const path of paths) {
            if (path.nodes && Array.isArray(path.nodes)) {
                for (const node of path.nodes) {
                    expandBounds(node.x, node.y);
                }
            }
        }

        // Include anchors in bounding box if requested
        if (includeAnchors && layerData.anchors) {
            for (const anchor of layerData.anchors) {
                expandBounds(anchor.x, anchor.y);
            }
        }

        if (!hasPoints) {
            // No points found (e.g., space character) - use glyph width from layer data
            // Create a small bbox: 10 units high, centered on baseline, as wide as the glyph
            const glyphWidth = layerData.width || 250; // Fallback to 250 if no width
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
        const glyph = this.parent() as Glyph;
        const font = glyph ? (glyph.parent() as Font) : undefined;

        // Get the master ID from the layer data
        const masterId = this.data.master?.DefaultForMaster;

        return Layer.calculateBoundingBox(
            this.data,
            includeAnchors,
            font,
            masterId
        );
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

    /**
     * Calculate sidebearings at a given Y height by measuring distance from glyph edges to first/last outline intersections
     * @param y - Y coordinate at which to measure
     * @returns Object with left and right sidebearing distances, or null if no intersections found at this height. Negative values indicate outline extends beyond glyph edges.
     */
    private getSidebearingsAtHeight(y: number): {
        left: number;
        right: number;
    } | null {
        const glyphWidth = this.width;

        // Define horizontal line extending far beyond glyph bounds
        const lineP1 = { x: -10000, y: y };
        const lineP2 = { x: glyphWidth + 10000, y: y };

        // Use existing getIntersectionsOnLine method with components included
        const intersections = this.getIntersectionsOnLine(lineP1, lineP2, true);

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
     * Find the matching layer on another glyph that represents the same master
     * @param glyphName - The name of the glyph to find the matching layer on
     * @returns The matching layer on the specified glyph, or undefined if not found
     */
    getMatchingLayerOnGlyph(glyphName: string): Layer | undefined {
        // Get the master ID of this layer
        let thisMasterId: string | undefined;
        if (typeof this.master === 'object') {
            if ('DefaultForMaster' in this.master) {
                thisMasterId = this.master.DefaultForMaster;
            } else if ('AssociatedWithMaster' in this.master) {
                thisMasterId = this.master.AssociatedWithMaster;
            }
        } else {
            thisMasterId = this.master;
        }

        if (!thisMasterId) {
            return undefined;
        }

        // Navigate up to get the Font object
        const glyph = this.parent() as Glyph;
        if (!glyph) return undefined;

        const font = glyph.parent() as Font;
        if (!font) return undefined;

        // Find the target glyph
        const targetGlyph = font.findGlyph(glyphName);
        if (!targetGlyph || !targetGlyph.layers) return undefined;

        // Find the layer on the target glyph with the same master ID
        for (const layer of targetGlyph.layers) {
            let layerMasterId: string | undefined;
            if (typeof layer.master === 'object') {
                if ('DefaultForMaster' in layer.master) {
                    layerMasterId = layer.master.DefaultForMaster;
                } else if ('AssociatedWithMaster' in layer.master) {
                    layerMasterId = layer.master.AssociatedWithMaster;
                }
            } else {
                layerMasterId = layer.master;
            }

            if (layerMasterId === thisMasterId) {
                return layer;
            }
        }

        return undefined;
    }

    toString(): string {
        let masterId: string;
        if (typeof this.master === 'object') {
            if ('DefaultForMaster' in this.master) {
                masterId = this.master.DefaultForMaster;
            } else if ('AssociatedWithMaster' in this.master) {
                masterId = this.master.AssociatedWithMaster;
            } else {
                masterId = 'unknown';
            }
        } else {
            masterId = this.master || 'none';
        }
        const shapesCount = this.shapes?.length || 0;
        return `<Layer width=${this.width} master="${masterId}" shapes=${shapesCount}>`;
    }
}

/**
 * Glyph in the font
 */
export class Glyph extends ArrayElementBase {
    private _layerWrappers: Layer[] | null = null;

    get name(): string {
        return this.data.name;
    }

    set name(value: string) {
        this.data.name = value;
    }

    get production_name(): string | undefined {
        return this.data.production_name;
    }

    set production_name(value: string | undefined) {
        this.data.production_name = value;
    }

    get category(): Babelfont.GlyphCategory {
        return this.data.category;
    }

    set category(value: Babelfont.GlyphCategory) {
        this.data.category = value;
    }

    get codepoints(): number[] | undefined {
        return this.data.codepoints;
    }

    set codepoints(value: number[] | undefined) {
        this.data.codepoints = value;
    }

    get layers(): Layer[] | undefined {
        if (!this.data.layers) return undefined;

        // Get font masters to filter and sort layers
        // Navigate up to Font object via parent chain
        const font = this.parent() as Font;
        const fontMasters = font?.masters;
        if (!fontMasters || fontMasters.length === 0) {
            // Fallback: return all layers if we can't access font data
            if (
                !this._layerWrappers ||
                this._layerWrappers.length !== this.data.layers.length
            ) {
                this._layerWrappers = this.data.layers.map(
                    (_: any, i: number) => new Layer(this.data.layers, i, this)
                );
            }
            return this._layerWrappers!;
        }

        // Filter: only foreground layers that are default for their master
        const masterIds = new Set(fontMasters.map((m: Master) => m.id));
        const filteredIndices: number[] = [];

        for (let i = 0; i < this.data.layers.length; i++) {
            const layer = this.data.layers[i];

            // Skip background layers
            if (layer.is_background) continue;

            // Check if this is a default layer (has DefaultForMaster in master dict)
            const isDefaultLayer =
                layer.master &&
                typeof layer.master === 'object' &&
                'DefaultForMaster' in layer.master;

            if (!isDefaultLayer) continue;

            // Extract master ID from layer.master.DefaultForMaster or use layer._master
            const masterId =
                layer.master &&
                typeof layer.master === 'object' &&
                'DefaultForMaster' in layer.master
                    ? layer.master.DefaultForMaster
                    : layer._master || layer.id;

            if (!masterId || !masterIds.has(masterId)) continue;

            filteredIndices.push(i);
        }

        // Create wrappers for filtered layers
        const wrappers = filteredIndices.map(
            (i: number) => new Layer(this.data.layers, i, this)
        );

        // Sort by master order
        wrappers.sort((a, b) => {
            // Extract master IDs from the wrappers
            const getMasterId = (layer: Layer): string => {
                const masterData = layer.master;
                if (
                    masterData &&
                    typeof masterData === 'object' &&
                    'DefaultForMaster' in masterData
                ) {
                    return masterData.DefaultForMaster;
                }
                // Fallback to raw data access
                return (layer as any).data._master || layer.id || '';
            };

            const masterIdA = getMasterId(a);
            const masterIdB = getMasterId(b);

            const masterIndexA = fontMasters.findIndex(
                (m: Master) => m.id === masterIdA
            );
            const masterIndexB = fontMasters.findIndex(
                (m: Master) => m.id === masterIdB
            );

            const posA =
                masterIndexA === -1 ? fontMasters.length : masterIndexA;
            const posB =
                masterIndexB === -1 ? fontMasters.length : masterIndexB;

            return posA - posB;
        });

        return wrappers;
    }

    get exported(): boolean | undefined {
        return this.data.exported;
    }

    set exported(value: boolean | undefined) {
        this.data.exported = value;
    }

    get direction(): Babelfont.Direction | undefined {
        return this.data.direction;
    }

    set direction(value: Babelfont.Direction | undefined) {
        this.data.direction = value;
    }

    get formatspecific(): Babelfont.FormatSpecific | undefined {
        return this.data.formatspecific;
    }

    set formatspecific(value: Babelfont.FormatSpecific | undefined) {
        this.data.formatspecific = value;
    }

    /**
     * Add a new layer to the glyph
     * @example
     * layer = glyph.addLayer(500)  # 500 units wide
     */
    addLayer(width: number, master?: Babelfont.LayerType): Layer {
        if (!this.data.layers) {
            this.data.layers = [];
        }

        // Generate a unique ID for the layer
        let layerId: string;
        const existingIds = new Set(
            this.data.layers.map((l: any) => l.id).filter((id: any) => id)
        );
        do {
            layerId = crypto.randomUUID();
        } while (existingIds.has(layerId));

        const layerData: Babelfont.Layer = { width, id: layerId };
        if (master) {
            layerData.master = master;
        }
        this.data.layers.push(layerData);
        this._layerWrappers = null; // Invalidate cache
        return new Layer(this.data.layers, this.data.layers.length - 1);
    }

    /**
     * Remove a layer at the specified index
     */
    removeLayer(index: number): void {
        if (this.data.layers) {
            this.data.layers.splice(index, 1);
            this._layerWrappers = null; // Invalidate cache
        }
    }

    /**
     * Find a layer by ID
     */
    findLayerById(id: string): Layer | undefined {
        const layers = this.layers;
        if (!layers) return undefined;
        const index = this.data.layers.findIndex((l: any) => l.id === id);
        return index >= 0 ? layers[index] : undefined;
    }

    /**
     * Find a layer by master ID
     */
    findLayerByMasterId(masterId: string): Layer | undefined {
        const layers = this.layers;
        if (!layers) return undefined;
        const index = this.data.layers.findIndex((l: any) => {
            const master = l.master;
            if (!master) return false;
            if (typeof master === 'object') {
                return (
                    master.DefaultForMaster === masterId ||
                    master.AssociatedWithMaster === masterId
                );
            }
            return false;
        });
        return index >= 0 ? layers[index] : undefined;
    }

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

/**
 * Variation axis in a variable font
 */
export class Axis extends ArrayElementBase {
    get name(): Babelfont.I18NDictionary {
        return this.data.name;
    }

    set name(value: Babelfont.I18NDictionary) {
        this.data.name = value;
    }

    get tag(): string {
        return this.data.tag;
    }

    set tag(value: string) {
        this.data.tag = value;
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        this.data.id = value;
    }

    get min(): number | undefined {
        return this.data.min;
    }

    set min(value: number | undefined) {
        this.data.min = value;
    }

    get max(): number | undefined {
        return this.data.max;
    }

    set max(value: number | undefined) {
        this.data.max = value;
    }

    get default(): number | undefined {
        return this.data.default;
    }

    set default(value: number | undefined) {
        this.data.default = value;
    }

    get map(): [number, number][] | undefined {
        return this.data.map;
    }

    set map(value: [number, number][] | undefined) {
        this.data.map = value;
    }

    get hidden(): boolean | undefined {
        return this.data.hidden;
    }

    set hidden(value: boolean | undefined) {
        this.data.hidden = value;
    }

    get values(): number[] | undefined {
        return this.data.values;
    }

    set values(value: number[] | undefined) {
        this.data.values = value;
    }

    get formatspecific(): Babelfont.FormatSpecific | undefined {
        return this.data.formatspecific;
    }

    set formatspecific(value: Babelfont.FormatSpecific | undefined) {
        this.data.formatspecific = value;
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'unknown';
        const range = `${this.min || '?'}-${this.default || '?'}-${this.max || '?'}`;
        return `<Axis "${displayName}" tag="${this.tag}" ${range}>`;
    }
}

/**
 * Master/source in a design space
 */
export class Master extends ArrayElementBase {
    private _guideWrappers: Guide[] | null = null;

    get name(): Babelfont.I18NDictionary {
        return this.data.name;
    }

    set name(value: Babelfont.I18NDictionary) {
        this.data.name = value;
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        this.data.id = value;
    }

    get location(): Record<string, number> | undefined {
        return this.data.location;
    }

    set location(value: Record<string, number> | undefined) {
        this.data.location = value;
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: any, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return this._guideWrappers!;
    }

    get metrics(): Record<string, number> {
        return this.data.metrics;
    }

    set metrics(value: Record<string, number>) {
        this.data.metrics = value;
    }

    get kerning(): Record<string, Record<string, number>> {
        return this.data.kerning;
    }

    set kerning(value: Record<string, Record<string, number>>) {
        this.data.kerning = value;
    }

    get custom_ot_values(): Babelfont.OTValue[] | undefined {
        return this.data.custom_ot_values;
    }

    set custom_ot_values(value: Babelfont.OTValue[] | undefined) {
        this.data.custom_ot_values = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

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

/**
 * Named instance in a variable font
 */
export class Instance extends ArrayElementBase {
    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        this.data.id = value;
    }

    get name(): Babelfont.I18NDictionary {
        return this.data.name;
    }

    set name(value: Babelfont.I18NDictionary) {
        this.data.name = value;
    }

    get location(): Record<string, number> | undefined {
        return this.data.location;
    }

    set location(value: Record<string, number> | undefined) {
        this.data.location = value;
    }

    get custom_names(): Babelfont.Names {
        return this.data.custom_names;
    }

    set custom_names(value: Babelfont.Names) {
        this.data.custom_names = value;
    }

    get variable(): boolean | undefined {
        return this.data.variable;
    }

    set variable(value: boolean | undefined) {
        this.data.variable = value;
    }

    get linked_style(): string | undefined {
        return this.data.linked_style;
    }

    set linked_style(value: string | undefined) {
        this.data.linked_style = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this.data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this.data.format_specific = value;
    }

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

/**
 * The main font class representing a complete font
 */
export class Font extends ModelBase {
    private _glyphWrappers: Glyph[] | null = null;
    private _axisWrappers: Axis[] | null = null;
    private _masterWrappers: Master[] | null = null;
    private _instanceWrappers: Instance[] | null = null;

    constructor(data: Babelfont.Font) {
        super(data);
    }

    get upm(): number {
        return this._data.upm;
    }

    set upm(value: number) {
        this._data.upm = value;
    }

    get version(): [number, number] {
        return this._data.version;
    }

    set version(value: [number, number]) {
        this._data.version = value;
    }

    get axes(): Axis[] | undefined {
        if (!this._data.axes) return undefined;
        if (
            !this._axisWrappers ||
            this._axisWrappers.length !== this._data.axes.length
        ) {
            this._axisWrappers = this._data.axes.map(
                (_: any, i: number) => new Axis(this._data.axes, i, this)
            );
        }
        return this._axisWrappers!;
    }

    get instances(): Instance[] | undefined {
        if (!this._data.instances) return undefined;
        if (
            !this._instanceWrappers ||
            this._instanceWrappers.length !== this._data.instances.length
        ) {
            this._instanceWrappers = this._data.instances.map(
                (_: any, i: number) =>
                    new Instance(this._data.instances, i, this)
            );
        }
        return this._instanceWrappers!;
    }

    get masters(): Master[] | undefined {
        if (!this._data.masters) return undefined;
        if (
            !this._masterWrappers ||
            this._masterWrappers.length !== this._data.masters.length
        ) {
            this._masterWrappers = this._data.masters.map(
                (_: any, i: number) => new Master(this._data.masters, i, this)
            );
        }
        return this._masterWrappers!;
    }

    get glyphs(): Glyph[] {
        if (
            !this._glyphWrappers ||
            this._glyphWrappers.length !== this._data.glyphs.length
        ) {
            this._glyphWrappers = this._data.glyphs.map(
                (_: any, i: number) => new Glyph(this._data.glyphs, i, this)
            );
        }
        return this._glyphWrappers!;
    }

    get note(): string | undefined {
        return this._data.note;
    }

    set note(value: string | undefined) {
        this._data.note = value;
    }

    get date(): string {
        return this._data.date;
    }

    set date(value: string) {
        this._data.date = value;
    }

    get names(): Babelfont.Names {
        return this._data.names;
    }

    set names(value: Babelfont.Names) {
        this._data.names = value;
    }

    get custom_ot_values(): Babelfont.OTValue[] | undefined {
        return this._data.custom_ot_values;
    }

    set custom_ot_values(value: Babelfont.OTValue[] | undefined) {
        this._data.custom_ot_values = value;
    }

    get variation_sequences():
        | Record<number, Record<number, string>>
        | undefined {
        return this._data.variation_sequences;
    }

    set variation_sequences(
        value: Record<number, Record<number, string>> | undefined
    ) {
        this._data.variation_sequences = value;
    }

    get features(): Babelfont.Features {
        return this._data.features;
    }

    set features(value: Babelfont.Features) {
        this._data.features = value;
    }

    get first_kern_groups(): Record<string, string[]> | undefined {
        return this._data.first_kern_groups;
    }

    set first_kern_groups(value: Record<string, string[]> | undefined) {
        this._data.first_kern_groups = value;
    }

    get second_kern_groups(): Record<string, string[]> | undefined {
        return this._data.second_kern_groups;
    }

    set second_kern_groups(value: Record<string, string[]> | undefined) {
        this._data.second_kern_groups = value;
    }

    get format_specific(): Babelfont.FormatSpecific | undefined {
        return this._data.format_specific;
    }

    set format_specific(value: Babelfont.FormatSpecific | undefined) {
        this._data.format_specific = value;
    }

    get source(): string | null {
        return this._data.source;
    }

    set source(value: string | null) {
        this._data.source = value;
    }

    /**
     * Find a glyph by name
     * @example
     * glyph = font.findGlyph("A")
     * if glyph:
     *     print(glyph.name)
     */
    findGlyph(name: string): Glyph | undefined {
        const index = this._data.glyphs.findIndex((g: any) => g.name === name);
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Find a glyph by codepoint
     * @example
     * glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
     */
    findGlyphByCodepoint(codepoint: number): Glyph | undefined {
        const index = this._data.glyphs.findIndex(
            (g: any) => g.codepoints && g.codepoints.includes(codepoint)
        );
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Duplicate a glyph with a new name
     * @example
     * new_glyph = font.duplicateGlyph(glyph, "A.alt")
     */
    duplicateGlyph(glyph: Glyph, newName: string): Glyph {
        // Check if glyph with newName already exists
        if (this.findGlyph(newName)) {
            throw new Error(`Glyph "${newName}" already exists in the font`);
        }

        // Get the source glyph data - access through the internal _data array
        const sourceGlyphIndex = this._data.glyphs.findIndex(
            (g: any) => g.name === glyph.name
        );
        if (sourceGlyphIndex < 0) {
            throw new Error(`Source glyph "${glyph.name}" not found in font`);
        }

        // Deep clone the glyph data
        const clonedData = JSON.parse(
            JSON.stringify(this._data.glyphs[sourceGlyphIndex])
        );

        // Set the new name
        clonedData.name = newName;

        // Generate new unique IDs for all layers
        if (clonedData.layers) {
            // Collect all layer IDs from the entire font to avoid duplicates
            const allExistingLayerIds = new Set<string>();
            for (const g of this.glyphs) {
                if (g.layers) {
                    for (const layer of g.layers) {
                        if (layer.id) {
                            allExistingLayerIds.add(layer.id);
                        }
                    }
                }
            }

            // Generate new unique IDs for each cloned layer
            for (const layer of clonedData.layers) {
                if (layer.id) {
                    let newId: string;
                    do {
                        newId = crypto.randomUUID();
                    } while (allExistingLayerIds.has(newId));
                    layer.id = newId;
                    allExistingLayerIds.add(newId);
                }
            }
        }

        // Add the cloned glyph to the font
        this._data.glyphs.push(clonedData);
        this._glyphWrappers = null; // Invalidate cache

        // Return the newly created glyph
        return new Glyph(this._data.glyphs, this._data.glyphs.length - 1, this);
    }

    /**
     * Find an axis by ID
     */
    findAxis(id: string): Axis | undefined {
        const axes = this.axes;
        if (!axes) return undefined;
        const index = this._data.axes.findIndex((a: any) => a.id === id);
        return index >= 0 ? axes[index] : undefined;
    }

    /**
     * Find an axis by tag
     * @example
     * weight_axis = font.findAxisByTag("wght")
     */
    findAxisByTag(tag: string): Axis | undefined {
        const axes = this.axes;
        if (!axes) return undefined;
        const index = this._data.axes.findIndex((a: any) => a.tag === tag);
        return index >= 0 ? axes[index] : undefined;
    }

    /**
     * Find a master by ID
     */
    findMaster(id: string): Master | undefined {
        const masters = this.masters;
        if (!masters) return undefined;
        const index = this._data.masters.findIndex((m: any) => m.id === id);
        return index >= 0 ? masters[index] : undefined;
    }

    /**
     * Add a new glyph to the font
     * @example
     * glyph = font.addGlyph("myGlyph", "Base")
     */
    addGlyph(name: string, category: Babelfont.GlyphCategory = 'Base'): Glyph {
        const glyphData: Babelfont.Glyph = {
            name,
            category,
            layers: []
        };
        this._data.glyphs.push(glyphData);
        this._glyphWrappers = null; // Invalidate cache
        return new Glyph(this._data.glyphs, this._data.glyphs.length - 1);
    }

    /**
     * Remove a glyph by name
     * @example
     * font.removeGlyph("oldGlyph")
     */
    removeGlyph(name: string): boolean {
        const index = this._data.glyphs.findIndex((g: any) => g.name === name);
        if (index >= 0) {
            this._data.glyphs.splice(index, 1);
            this._glyphWrappers = null; // Invalidate cache
            return true;
        }
        return false;
    }

    /**
     * Serialize the font back to JSON string
     */
    toJSONString(): string {
        return JSON.stringify(
            this._data,
            (key, value) => {
                // When serializing shape objects, filter out normalizer wrapper properties
                // The normalizer adds { Path: {...}, nodes: [...], isInterpolated?: bool }
                // but we only want { Path: {...} } or { Component: {...} } in the JSON
                if (
                    value &&
                    typeof value === 'object' &&
                    !Array.isArray(value)
                ) {
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
            },
            2
        ); // Format with 2-space indentation for readable git diffs
    }

    /**
     * Create a Font instance from JSON string
     */
    static fromJSONString(json: string): Font {
        return new Font(JSON.parse(json));
    }

    /**
     * Create a Font instance from parsed JSON data
     */
    static fromData(data: Babelfont.Font): Font {
        return new Font(data);
    }

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
