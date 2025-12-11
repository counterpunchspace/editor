import { AxisMap } from './locations';
import type { DesignspaceLocation } from './locations';
import type { Transform } from './basictypes';
export namespace PythonBabelfont {
    export type Master = {
        /** The name of the master. */
        name: I18NDictionary;
        /** An ID used to refer to this master in the
`Layer._master` field. (This is allows the user to change the master name
without the layers becoming lost.) */
        id: string;
        /** A dictionary mapping axis tags to coordinates
in order to locate this master in the design space. The coordinates are in designspace units. */
        location: DesignspaceLocation;
        /** If true, this master is sparse and may not have all glyphs */
        sparse?: boolean;
        /** A list of guides. */
        guides?: PythonBabelfont.Guide[];
        /** A dictionary mapping metric names (string) to metric value (integer). The following
metric names are reserved: `%s`. Other metrics may be added to this dictionary
as needed by font clients, but their interpretation is not guaranteed to be
compatible between clients. */
        metrics: Record<string, number>;
        kerning: any; /* Urgh */
    };
    export type Axis = {
        /** The display name for this axis. */
        name: string;
        /** The four-letter axis tag. */
        tag: string;
        /** An ID used to refer to this axis in the Master,
Layer and Instance `location` fields. (This is allows the user to change the
axis tag without the locations becoming lost.) If not provided, one will be
automatically generated on import from a UUID. */
        id: string;
        /** The minimum value of this axis, in user space coordinates. */
        min: number;
        /** The maximum value of this axis, in user space coordinates. */
        max: number;
        /** The default value of this axis (center of interpolation),
in user space coordinates. Note that if the min/max/default values are not supplied,
they are returned as `None` in the Python object, and should be computed from the
master locations on export. */
        default: number;
        /** The mapping between userspace and designspace coordinates. */
        map: AxisMap;
        /** If `True`, this axis is considered to be a 'hidden' axis.
        Hidden axes are used for internal font generation and are not displayed in the
        user interface. */
        hidden: boolean;
    };
    export type Glyph = {
        name: string;
        production_name?: string;
        category: string;
        codepoints: number[];
        layers: PythonBabelfont.Layer[];
        exported: boolean;
        direction?: 'LTR' | 'RTL' | 'TTB';
    };

    /**
     * A layer of a glyph in a font
     */
    export type Layer = {
        /**
         * The advance width of the layer
         */
        width: number;
        height?: number;
        vertWidth?: number;

        /**
         * The name of the layer
         */
        name?: string;

        /**
         * The ID of the layer
         */
        id?: string;

        /**
         * The relationship between this layer and a master, if any
         */
        _master?: string;

        /**
         * Guidelines in the layer
         */
        guides?: PythonBabelfont.Guide[];

        /**
         * Shapes (paths and components) in the layer
         */
        shapes: PythonBabelfont.Shape[];

        /**
         * Anchors in the layer
         */
        anchors?: PythonBabelfont.Anchor[];

        /**
         * The color of the layer
         */
        color?: PythonBabelfont.Color;

        /**
         * The index of the layer in a color font
         */
        layerIndex?: number;

        /**
         * Whether this layer is a background layer
         */
        is_background?: boolean;

        /**
         * The ID of the background layer for this layer, if any
         */
        background?: string;

        /**
         * The location of the layer in design space, if it is not at the default location for a master
         */
        location?: Record<string, number>;

        /**
         * Format-specific data for the layer
         */
        format_specific?: any;

        // Stuff we added
        isInterpolated: boolean;
    };
    export type Guide = {
        pos: PythonBabelfont.Position;
        name: string;
        color?: PythonBabelfont.Color;
    };
    export type Position = {
        x: number;
        y: number;
        angle: number;
    };
    export type Color = {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    export type Anchor = {
        name: string;
        x: number;
        y: number;
    };
    export type Shape =
        | { Path: PythonBabelfont.Path }
        | { Component: PythonBabelfont.Component }
        | { nodes: PythonBabelfont.Node[] };
    export type Path = {
        nodes: string; // JSON serialized list of nodes
        closed: boolean;
        direction?: number;
    };
    export type Component = {
        reference: string;
        transform?: Transform;
        layerData?: PythonBabelfont.Layer; // XXX Added for nested component data
    };
    export type NodeType = 'o' | 'c' | 'q' | 'l' | 'ls' | 'cs' | 'qs';
    export type Node = {
        x: number;
        y: number;
        type: NodeType;
    }; // our parsed format
}
