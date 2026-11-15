/**
 * Normalized clipboard paste payload shared by format converters.
 */

export type PasteNodeType = 'Line' | 'Curve' | 'OffCurve' | 'QCurve' | 'Move';

export type ClipboardJsonValue =
    | string
    | number
    | boolean
    | null
    | ClipboardJsonValue[]
    | { [key: string]: ClipboardJsonValue };

export type ClipboardFormatSpecific = Record<string, ClipboardJsonValue>;

export type PasteNode = {
    x: number;
    y: number;
    nodetype: PasteNodeType;
    smooth?: boolean;
};

export type PastePath = {
    closed: boolean;
    nodes: PasteNode[];
    format_specific?: ClipboardFormatSpecific;
};

export type PasteComponent = {
    reference: string;
    x: number;
    y: number;
    /**
     * Affine matrix [a, b, c, d, e, f] matching Glyphs `GSComponent.transform`
     * / NSAffineTransformStruct ({m11, m12, m21, m22, tX, tY}).
     */
    transform?: [number, number, number, number, number, number];
    /** Glyphs alignment: 1 = automatic, anything else = manual. */
    alignment?: number;
    /** Explicit automatic-alignment target anchor name. */
    anchor?: string;
    format_specific?: ClipboardFormatSpecific;
};

export type PasteAnchor = {
    name: string;
    x: number;
    y: number;
    format_specific?: ClipboardFormatSpecific;
};

export type PasteGuide = {
    name?: string;
    x: number;
    y: number;
    angle: number;
    /** True when source marks a station/global guide. */
    global?: boolean;
    format_specific?: ClipboardFormatSpecific;
};

export type PasteFragment = {
    format: 'svg' | 'counterpunch-json' | 'fontra-json';
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
    /**
     * When true, keep source coordinates.
     * When false, center the paste bbox in the target drawing.
     */
    keepAbsoluteCoords: boolean;
};

export type ClipboardPayload = {
    type: string;
    data: string;
};
