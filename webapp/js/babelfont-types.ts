/**
 * Babelfont type definitions
 *
 * Re-exports types from babelfont-ts with custom extensions needed by this codebase:
 * - Custom Node/Layer/Shape interface properties (smooth, layer_index, is_background, etc.)
 * - NodeType string literal mapping for compatibility with codebase conventions
 * - Type aliases used across multiple modules
 */

import type {
    I18NDictionary as BabelfontI18NDictionary,
    Axis as BabelfontAxis,
    Names as BabelfontNames,
    Master as BabelfontMaster,
    Instance as BabelfontInstance,
    Guide as BabelfontGuide,
    Anchor as BabelfontAnchor,
    Color as BabelfontColor,
    Position as BabelfontPosition,
    CustomOTValues as BabelfontCustomOTValues,
    Features as BabelfontFeatures,
    Node as BabelfontNode,
    Component as BabelfontComponent,
    Path as BabelfontPath,
    Layer as BabelfontLayer,
    Glyph as BabelfontGlyph,
    Font as BabelfontFont,
    NodeType as BabelfontNodeType,
    Direction,
    LayerType,
    GlyphCategory
} from 'babelfont-ts';

// Re-export types from babelfont-ts
export type I18NDictionary = BabelfontI18NDictionary;
export type Axis = BabelfontAxis;
export type Names = BabelfontNames;
export type Master = BabelfontMaster;
export type Instance = BabelfontInstance;
export type Guide = BabelfontGuide;
export type Anchor = BabelfontAnchor;
export type Color = BabelfontColor;
export type Position = BabelfontPosition;
export type CustomOTValues = BabelfontCustomOTValues;
export type Features = BabelfontFeatures;

// NodeType compatibility - map enum to string literals used in code
export type NodeType =
    | 'Move'
    | 'Line'
    | 'OffCurve'
    | 'Curve'
    | 'QCurve'
    | 'm'
    | 'l'
    | 'o'
    | 'c'
    | 'q'
    | 'ms'
    | 'ls'
    | 'os'
    | 'cs'
    | 'qs';

// Node type with string-based nodetype for compatibility
export interface Node {
    x: number;
    y: number;
    nodetype?: NodeType;
    smooth?: boolean;
}

// Path interface
export interface Path {
    nodes?: string | Node[];
    closed?: boolean;
}

// Component interface
export interface Component {
    reference: string;
    transform?: number[] | any;
    location?: Record<string, number>;
    layerData?: Layer; // Custom property for cached layer data
}

// Shape is either a Path or Component wrapped in an object
export type Shape = { Path: Path } | { Component: Component };

// Layer interface with custom properties
export interface Layer {
    id?: string;
    name?: string;
    width: number;
    height?: number;
    vertWidth?: number;
    vertOrigin?: number;
    advanceHeight?: number;
    advanceWidth?: number;
    tsb?: number;
    bsb?: number;
    lsb?: number;
    rsb?: number;
    shapes?: Shape[];
    anchors?: Anchor[];
    guides?: Guide[];
    color?: Color;
    master?: LayerType;
    _master?: string; // Legacy property
    location?: Record<string, number>;
    isInterpolated?: boolean; // Custom property
    layer_index?: number;
    is_background?: boolean;
    background_layer_id?: string;
    format_specific?: FormatSpecific;
}

// Glyph interface
export interface Glyph {
    name: string;
    production_name?: string;
    codepoints?: number[];
    category?: string;
    layers?: Layer[];
    exported?: boolean;
}

// Font interface
export interface Font {
    axes?: Axis[];
    masters?: Master[];
    instances?: Instance[];
    names?: Names;
    glyphs?: Glyph[];
    features?: Features;
    customOTValues?: CustomOTValues;
    version?: number;
    appVersion?: string;
    format_specific?: Record<string, any>;
}

// Type alias for JSON values
export type JSONValue =
    | null
    | boolean
    | number
    | string
    | JSONValue[]
    | { [key: string]: JSONValue };

export type FormatSpecific = Record<string, JSONValue>;

// Direction, LayerType, GlyphCategory exports
export type { Direction, LayerType, GlyphCategory };

// OTValue alias for compatibility
export type OTValue = CustomOTValues;
