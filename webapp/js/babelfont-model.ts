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

/**
 * Base class for model objects that wrap JSON data
 */
abstract class ModelBase {
    protected _data: any;

    constructor(data: any) {
        this._data = data;
    }

    /**
     * Get the underlying JSON data for this object
     */
    toJSON(): any {
        return this._data;
    }
}

/**
 * Base class for objects that are elements in an array
 */
abstract class ArrayElementBase extends ModelBase {
    protected _parent: any[];
    protected _index: number;

    constructor(parent: any[], index: number) {
        super(parent[index]);
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
     * Update underlying data reference
     */
    protected set data(value: any) {
        this._parent[this._index] = value;
    }
}

/**
 * A node in a glyph outline
 */
export class Node extends ArrayElementBase {
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

    get nodetype(): Babelfont.NodeType {
        return this.data.nodetype;
    }

    set nodetype(value: Babelfont.NodeType) {
        this.data.nodetype = value;
    }

    get smooth(): boolean | undefined {
        return this.data.smooth;
    }

    set smooth(value: boolean | undefined) {
        this.data.smooth = value;
    }
}

/**
 * A path in a glyph
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
        if (!this._nodeWrappers || this._nodeWrappers.length !== this.data.nodes.length) {
            this._nodeWrappers = this.data.nodes.map(
                (_: any, i: number) => new Node(this.data.nodes, i)
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
            const nodetype = this.mapNodeType(smooth ? typeStr.slice(0, -1) : typeStr);
            
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
            'm': 'Move',
            'l': 'Line',
            'o': 'OffCurve',
            'c': 'Curve',
            'q': 'QCurve'
        };
        return map[shortType] || 'Line';
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
     */
    insertNode(index: number, x: number, y: number, nodetype: Babelfont.NodeType = 'Line', smooth?: boolean): Node {
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
     */
    removeNode(index: number): void {
        this.data.nodes.splice(index, 1);
        this._nodeWrappers = null; // Invalidate cache
    }

    /**
     * Append a node to the end of the path
     */
    appendNode(x: number, y: number, nodetype: Babelfont.NodeType = 'Line', smooth?: boolean): Node {
        return this.insertNode(this.data.nodes.length, x, y, nodetype, smooth);
    }
}

/**
 * A component in a glyph
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
}

/**
 * An anchor point in a glyph
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
}

/**
 * A guideline
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
}

/**
 * Wrapper for Shape union type (Component or Path)
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
        return new Component(fakeArray as any, 0);
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
        return new Path(fakeArray as any, 0);
    }
}

/**
 * A layer of a glyph in a font
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
        if (!this._guideWrappers || this._guideWrappers.length !== this.data.guides.length) {
            this._guideWrappers = this.data.guides.map(
                (_: any, i: number) => new Guide(this.data.guides, i)
            );
        }
        return this._guideWrappers!;
    }

    get shapes(): Shape[] | undefined {
        if (!this.data.shapes) return undefined;
        if (!this._shapeWrappers || this._shapeWrappers.length !== this.data.shapes.length) {
            this._shapeWrappers = this.data.shapes.map(
                (_: any, i: number) => new Shape(this.data.shapes, i)
            );
        }
        return this._shapeWrappers!;
    }

    get anchors(): Anchor[] | undefined {
        if (!this.data.anchors) return undefined;
        if (!this._anchorWrappers || this._anchorWrappers.length !== this.data.anchors.length) {
            this._anchorWrappers = this.data.anchors.map(
                (_: any, i: number) => new Anchor(this.data.anchors, i)
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
}

/**
 * A glyph in the font
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
        if (!this._layerWrappers || this._layerWrappers.length !== this.data.layers.length) {
            this._layerWrappers = this.data.layers.map(
                (_: any, i: number) => new Layer(this.data.layers, i)
            );
        }
        return this._layerWrappers!;
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
     */
    addLayer(width: number, master?: Babelfont.LayerType): Layer {
        if (!this.data.layers) {
            this.data.layers = [];
        }
        const layerData: Babelfont.Layer = { width };
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
                return master.DefaultForMaster === masterId || master.AssociatedWithMaster === masterId;
            }
            return false;
        });
        return index >= 0 ? layers[index] : undefined;
    }
}

/**
 * An axis in a variable font
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
}

/**
 * A master/source font in a design space
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
        if (!this._guideWrappers || this._guideWrappers.length !== this.data.guides.length) {
            this._guideWrappers = this.data.guides.map(
                (_: any, i: number) => new Guide(this.data.guides, i)
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
}

/**
 * A font instance
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
}

/**
 * The main Font class representing a complete font
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
        if (!this._axisWrappers || this._axisWrappers.length !== this._data.axes.length) {
            this._axisWrappers = this._data.axes.map(
                (_: any, i: number) => new Axis(this._data.axes, i)
            );
        }
        return this._axisWrappers!;
    }

    get instances(): Instance[] | undefined {
        if (!this._data.instances) return undefined;
        if (!this._instanceWrappers || this._instanceWrappers.length !== this._data.instances.length) {
            this._instanceWrappers = this._data.instances.map(
                (_: any, i: number) => new Instance(this._data.instances, i)
            );
        }
        return this._instanceWrappers!;
    }

    get masters(): Master[] | undefined {
        if (!this._data.masters) return undefined;
        if (!this._masterWrappers || this._masterWrappers.length !== this._data.masters.length) {
            this._masterWrappers = this._data.masters.map(
                (_: any, i: number) => new Master(this._data.masters, i)
            );
        }
        return this._masterWrappers!;
    }

    get glyphs(): Glyph[] {
        if (!this._glyphWrappers || this._glyphWrappers.length !== this._data.glyphs.length) {
            this._glyphWrappers = this._data.glyphs.map(
                (_: any, i: number) => new Glyph(this._data.glyphs, i)
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

    get variation_sequences(): Record<number, Record<number, string>> | undefined {
        return this._data.variation_sequences;
    }

    set variation_sequences(value: Record<number, Record<number, string>> | undefined) {
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
     */
    findGlyph(name: string): Glyph | undefined {
        const index = this._data.glyphs.findIndex((g: any) => g.name === name);
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Find a glyph by codepoint
     */
    findGlyphByCodepoint(codepoint: number): Glyph | undefined {
        const index = this._data.glyphs.findIndex((g: any) => 
            g.codepoints && g.codepoints.includes(codepoint)
        );
        return index >= 0 ? this.glyphs[index] : undefined;
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
        return JSON.stringify(this._data);
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
}
