// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Update regenerate-types.sh or companion extension types instead.
//
// Type definitions for babelfont
// Project: https://github.com/simoncozens/babelfont-rs
// Definitions extracted from babelfont-ts@df18a2f

export namespace Babelfont {
    /** A dictionary for internationalized strings. */
    export type I18NDictionary = Record<string, string>;
    /** An anchor point in a glyph */
    export interface Anchor {
        /** X coordinate */
        x: number;
        /** Y coordinate */
        y: number;
        /** Name of the anchor */
        name?: string;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** An axis in a variable font */
    export interface Axis {
        /** Name of the axis */
        name: I18NDictionary;
        /** 4-character tag of the axis */
        tag: string;
        /** Minimum value of the axis in user space coordinates */
        min?: import('@simoncozens/fonttypes').UserspaceCoordinate;
        /** Maximum value of the axis in user space coordinates */
        max?: import('@simoncozens/fonttypes').UserspaceCoordinate;
        /** Default value of the axis in user space coordinates */
        default?: import('@simoncozens/fonttypes').UserspaceCoordinate;
        /** Mapping of user space coordinates to design space coordinates */
        map?: Array<
            [
                import('@simoncozens/fonttypes').UserspaceCoordinate,
                import('@simoncozens/fonttypes').DesignspaceCoordinate
            ]
        > | null;
        /** Whether the axis is hidden in the font's user interface */
        hidden?: boolean;
        /** Predefined values for the axis in user space coordinates */
        values?: import('@simoncozens/fonttypes').UserspaceCoordinate[];
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    export interface Color {
        r: number;
        g: number;
        b: number;
        a: number;
    }
    /** The order in which transform operations should be applied */
    export enum TransformOrder {
        /** Glyphs order: translate → skew → rotate → scale */
        Glyphs = 'Glyphs',
        /** Translate → rotate → scale → skew */
        RestOfTheWorld = 'RestOfTheWorld'
    }
    /** A decomposed affine transformation with separate translation, rotation, scale, and skew components */
    export interface DecomposedAffine {
        translation?: [number, number];
        scale?: [number, number];
        rotation?: number;
        skew?: [number, number];
        order?: TransformOrder;
    }
    /** A component in a glyph */
    export interface Component {
        /** The referenced glyph name */
        reference: string;
        /** The transformation applied to the component */
        transform: DecomposedAffine;
        /** A location for a variable component */
        location?: Record<
            string,
            import('@simoncozens/fonttypes').DesignspaceCoordinate
        >;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    export interface CrossAxisMapping {
        /** Description */
        description?: string;
        /** Source designspace locations */
        input: import('@simoncozens/fonttypes').DesignspaceLocation[];
        /** Target designspace locations */
        output: import('@simoncozens/fonttypes').DesignspaceLocation[];
    }
    /** Custom OpenType values that can be set per-master or per-font */
    export interface CustomOTValues {
        /**
         * Head table flags field
         *
         * A bit field. The flags are:
         * 0: Baseline for font at y=0
         * 1: Left sidebearing at x=0
         * 2: Instructions may depend on point size
         * 3: Force ppem to integer values for all internal scaler math
         * 4: Instructions may alter advance width (the advance width is not always the
         * same as the width of the glyph outline)
         * 5-10: Not used
         * 11: Font data is "lossless"
         * 12: Font converted (produce compatible metrics)
         * 13: Optimized for ClearType
         * 14: Last Resort font
         */
        head_flags?: number;
        /** Head table lowest recommended pixels per em field */
        head_lowest_rec_ppem?: number;
        /**
         * OS/2 table `usWeightClass`` field
         *
         * Indicates the visual weight (degree of blackness or thickness of strokes) of the characters in the font. Values from 1 to 1000 are valid.
         */
        os2_us_weight_class?: number;
        /**
         * OS/2 table `usWidthClass` field
         *
         * Indicates a relative change from the normal aspect ratio (width to height ratio) as specified by a font designer for the glyphs in a font.
         */
        os2_us_width_class?: number;
        /**
         * OS/2 table `fsType` field
         *
         * A bit field that specifies font embedding and licensing rights for the font.
         * The bits are:
         * 0-3: Used to specify embedding permissions
         * A value of 0 indicates that the font may be embedded and installed permanently on the remote system.
         * A value of 2 indicates that the font may be embedded but must be uninstalled when the document is closed.
         * A value of 4 indicates that the font may be embedded for preview and printing only.
         * A value of 8 indicates that the font may not be embedded.
         * 4-7: Reserved; set to 0
         * 8: No subsetting
         * 9: Bitmap embedding only
         * 10-15: Reserved; set to 0
         */
        os2_fs_type?: number;
        /** Font-family class and subclass */
        os2_family_class?: number;
        /** Panose classification */
        os2_panose?: [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number
        ];
        /** Unicode range bits 0-31; see OpenType spec for bit meanings */
        os2_unicode_range1?: number;
        /** Unicode range bits 32-63; see OpenType spec for bit meanings */
        os2_unicode_range2?: number;
        /** Unicode range bits 64-95; see OpenType spec for bit meanings */
        os2_unicode_range3?: number;
        /** Unicode range bits 96-127; see OpenType spec for bit meanings */
        os2_unicode_range4?: number;
        /** OS/2 Vendor ID field */
        os2_vendor_id?: string | null;
        /**
         * OS/2 fsSelection field
         *
         * A bit field. The bits are:
         * 0: Italic
         * 1: Underscore
         * 2: Negative
         * 3: Outlined
         * 4: Strikeout
         * 5: Bold
         * 6: Regular
         * 7: Use Typo Metrics
         * 8: WWS
         * 9: Oblique
         */
        os2_fs_selection?: number;
        /**
         * OS/2 Code Page Range 1 field
         * A bit field; see OpenType spec for bit meanings
         */
        os2_code_page_range1?: number;
        /**
         * OS/2 Code Page Range 2 field
         * A bit field; see OpenType spec for bit meanings
         */
        os2_code_page_range2?: number;
        /** CFF table BlueValues field */
        cff_blue_values?: number[];
        /** CFF table OtherBlues field */
        cff_other_blues?: number[];
        /** CFF table FamilyBlues field */
        cff_family_blues?: number[];
        /** CFF table FamilyOtherBlues field */
        cff_family_other_blues?: number[];
        /** CFF table StemSnapH field */
        cff_stem_snap_h?: number[];
        /** CFF table StemSnapV field */
        cff_stem_snap_v?: number[];
    }
    /** A wrapper for OpenType feature code that may be automatically generated. */
    export interface PossiblyAutomaticCode {
        /** The feature code. */
        code: string;
        /**
         * Whether this code was automatically generated.
         * If true, it may be regenerated by the application.
         */
        automatic?: boolean;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** A representation of OpenType features, classes, and prefixes. */
    export interface Features {
        /**
         * Opentype classes
         *
         * The key should not start with @.
         */
        classes: Record<string, PossiblyAutomaticCode>;
        /**
         * Opentype prefixes
         *
         * A dictionary of OpenType lookups and other feature code to be placed before features are defined.
         * The keys are user-defined names, the values are AFDKO feature code.
         */
        prefixes: Record<string, PossiblyAutomaticCode>;
        /**
         * OpenType features
         *
         * A list of OpenType feature code, expressed as a tuple (feature tag, code).
         */
        features: Array<[string, PossiblyAutomaticCode]>;
        /**
         * Include paths
         *
         * Paths to search for included feature files.
         */
        include_paths?: string[];
    }
    /** Name table values for a font or individual master */
    export interface Names {
        /** Copyright notice (OpenType Name ID 0) */
        copyright?: I18NDictionary;
        /** Font family name (OpenType Name ID 1) */
        family_name?: I18NDictionary;
        /** Font Subfamily name (OpenType Name ID 2) */
        preferred_subfamily_name?: I18NDictionary;
        /** Unique font identifier (OpenType Name ID 3) */
        unique_id?: I18NDictionary;
        /** Full font name (OpenType Name ID 4) */
        full_name?: I18NDictionary;
        /** Version string (OpenType Name ID 5) */
        version?: I18NDictionary;
        /** PostScript name for the font (OpenType Name ID 6) */
        postscript_name?: I18NDictionary;
        /** Trademark (OpenType Name ID 7) */
        trademark?: I18NDictionary;
        /** Manufacturer Name (OpenType Name ID 8) */
        manufacturer?: I18NDictionary;
        /** Designer. (Name of the designer of the typeface.) (OpenType Name ID 9) */
        designer?: I18NDictionary;
        /** Description. (Description of the typeface.) (OpenType Name ID 10) */
        description?: I18NDictionary;
        /** URL of Vendor. URL of font vendor (with protocol, e.g., http://, ftp://). (OpenType Name ID 11) */
        manufacturer_url?: I18NDictionary;
        /** URL of Designer. URL of typeface designer (with protocol, e.g., http://, ftp://). (OpenType Name ID 12) */
        designer_url?: I18NDictionary;
        /** License Description. Description of the license or licenses under which the font is provided. (OpenType Name ID 13) */
        license?: I18NDictionary;
        /** License Info URL. URL where additional licensing information can be found. (OpenType Name ID 14) */
        license_url?: I18NDictionary;
        /** Typographic Family name. (OpenType Name ID 16) */
        typographic_family?: I18NDictionary;
        /** Typographic Subfamily name. (OpenType Name ID 17) */
        typographic_subfamily?: I18NDictionary;
        /** Compatible Full (Macintosh only). (OpenType Name ID 18) */
        compatible_full_name?: I18NDictionary;
        /** Sample text. (OpenType Name ID 19) */
        sample_text?: I18NDictionary;
        /** PostScript CID findfont name. (OpenType Name ID 20) */
        postscript_cid_name?: I18NDictionary;
        /** WWS Family Name. (OpenType Name ID 21) */
        wws_family_name?: I18NDictionary;
        /** WWS Subfamily Name. (OpenType Name ID 22) */
        wws_subfamily_name?: I18NDictionary;
        /** Variations PostScript Name Prefix. (OpenType Name ID 25) */
        variations_postscript_name_prefix?: I18NDictionary;
    }
    /** A font instance */
    export interface Instance {
        /**
         * Unique identifier for the instance
         *
         * Should be unique within the design space; usually a UUID.
         */
        id: string;
        /** Name of the instance */
        name: I18NDictionary;
        /** Location of the instance in design space coordinates */
        location?: import('@simoncozens/fonttypes').DesignspaceLocation;
        /** Any custom names for the instance if it is exported as a static font */
        custom_names: Names;
        /** Whether the instance represents an export of a variable font */
        variable?: boolean;
        /** Name of the linked style for style linking (e.g., "Bold Italic" links to "Bold" and "Italic") */
        linked_style?: string;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** A position in 2D space, with an optional angle */
    export interface Position {
        /** X coordinate */
        x: number;
        /** Y coordinate */
        y: number;
        /** Angle in degrees */
        angle?: number;
    }
    /** A guideline in the font, whether at master or layer level */
    export interface Guide {
        /** Position of the guideline */
        pos: Position;
        /** Optional name of the guideline */
        name?: string;
        /** Optional color of the guideline */
        color?: Color;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** A master/source font in a design space */
    export interface Master {
        /** Name of the master */
        name: I18NDictionary;
        /** Unique identifier for the master (usually a UUID) */
        id: string;
        /** Location of the master in design space coordinates */
        location?: import('@simoncozens/fonttypes').DesignspaceLocation;
        /** Global guidelines associated with the master */
        guides?: Guide[];
        /** Master-specific metrics */
        metrics: Record<string, number>;
        /**
         * Kerning for this master.
         *
         * (Kerning pairs are (left glyph name, right glyph name) -> value)
         * Groups are represented as `@<groupname>`; whether they are first or second
         * groups is determined by position in the tuple.
         */
        kerning: Map<[string, string], number>;
        /** Custom OpenType values for this master */
        custom_ot_values?: CustomOTValues;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** The category of a glyph */
    export type GlyphCategory =
        /** A base glyph */
        | 'Base'
        /** A mark glyph */
        | 'Mark'
        /** An unknown / un-set category */
        | 'Unknown'
        /** A ligature glyph */
        | 'Ligature'
        /** Custom */
        | { Custom: string };
    /** The type of a layer in relation to masters */
    export type LayerType =
        /** A default layer for a master */
        | { type: 'DefaultForMaster'; master: string }
        /** A layer associated with a master but not the default */
        | { type: 'AssociatedWithMaster'; master: string }
        /** A free-floating layer not associated with any master */
        | { type: 'FreeFloating'; master?: undefined };
    /** A shape in a glyph, either a component or a path */
    export type Shape =
        /** A component in a glyph */
        | Component
        /** A path in a glyph */
        | Path;
    /** A layer of a glyph in a font */
    export interface Layer {
        /** The advance width of the layer */
        width: number;
        /** The name of the layer */
        name?: string;
        /** The ID of the layer */
        id?: string;
        /** The relationship between this layer and a master, if any */
        master?: LayerType;
        /** Guidelines in the layer */
        guides?: Guide[];
        /** Shapes (paths and components) in the layer */
        shapes?: Shape[];
        /** Anchors in the layer */
        anchors?: Anchor[];
        /** The color of the layer */
        color?: Color;
        /** The index of the layer in a color font */
        layer_index?: number;
        /** Whether this layer is a background layer */
        is_background?: boolean;
        /** The ID of the background layer for this layer, if any */
        background_layer_id?: string;
        /** The location of the layer in design space, if it is not at the default location for a master */
        location?: import('@simoncozens/fonttypes').DesignspaceLocation;
        /** The location of the layer in smart component (glyph-specific axes) space */
        smart_component_location?: import('@simoncozens/fonttypes').DesignspaceLocation;
        /** Format-specific data for the layer */
        format_specific?: Record<string, any>;
    }
    /** Direction of text flow */
    export enum Direction {
        /** Left to right text flow */
        LeftToRight = 'LeftToRight',
        /** Right to left text flow */
        RightToLeft = 'RightToLeft',
        /** Top to bottom text flow */
        TopToBottom = 'TopToBottom',
        /** Bidirectional, */
        Bidi = 'Bidi'
    }
    /** A glyph in the font */
    export interface Glyph {
        /** The name of the glyph */
        name: string;
        /** The production name of the glyph, if any */
        production_name?: string;
        /** The category of the glyph */
        category: GlyphCategory;
        /** Unicode codepoints assigned to the glyph */
        codepoints?: number[];
        /**
         * The layers in the glyph
         *
         * These include background layers, design-only layers, etc. as well as
         * the main master and location-specific layers.
         */
        layers?: Layer[];
        /** Whether the glyph is exported */
        exported: boolean;
        /** The writing direction of the glyph, if any */
        direction?: Direction;
        /** Glyph-specific axes for "smart components" / variable components */
        component_axes?: Axis[];
        /** Format-specific data */
        format_specific?: Record<string, any>;
        /** Immutable cloud/CRDT glyph id */
        id?: string;
    }
    /** A representation of a font source file */
    export interface Font {
        /** Units per em */
        upm: number;
        /** Font version as (major, minor) */
        version: [number, number];
        /**
         * A list of axes, in the case of variable/multiple master font.
         *
         * May be empty.
         */
        axes?: Axis[];
        /** A list of cross-axis mappings (avar2 mappings) */
        cross_axis_mappings?: CrossAxisMapping[];
        /** A list of named/static instances */
        instances?: Instance[];
        /** A list of the font's masters */
        masters?: Master[];
        /** A list of the font's glyphs */
        glyphs: Glyph[];
        /** An optional note about the font */
        note?: string;
        /** The font's creation date */
        date: Date;
        /** The font's naming information */
        names: Names;
        /**
         * Any values to be placed in OpenType tables on export to override defaults
         *
         * These must be font-wide. Metrics which may vary by master should be placed in the `metrics` field of a Master
         */
        custom_ot_values?: CustomOTValues;
        /** A map of Unicode Variation Sequences to glyph names */
        variation_sequences?: Record<string, string>;
        /** A representation of the font's OpenType features */
        features: Features;
        /**
         * A dictionary of kerning groups
         *
         * The key is the group name and the value is a list of glyph names in the group
         * Group names are *not* prefixed with "@" here. This is the first item in a kerning pair.
         * and so these are generally organized based on the profile of *right side* of the
         * glyph (for LTR scripts).
         */
        first_kern_groups?: Record<string, string[]>;
        /**
         *
         * The key is the group name and the value is a list of glyph names in the group
         * Group names are *not* prefixed with "@" here. This is the second item in a kerning pair.
         * and so these are generally organized based on the profile of *left side* of the
         * glyph (for LTR scripts).
         */
        second_kern_groups?: Record<string, string[]>;
        /** Format-specific data */
        format_specific?: Record<string, any>;
        /** The source file path, if any, from which this font was loaded */
        source?: string;
    }
    /** Types of nodes in a glyph outline */
    export enum NodeType {
        /** Move to a new position without drawing (only defined for open contours) */
        Move = 'Move',
        /** Draw a straight line to this node */
        Line = 'Line',
        /** Cubic Bézier curve control node (off-curve) */
        OffCurve = 'OffCurve',
        /** Draw a cubic Bézier curve to this node */
        Curve = 'Curve',
        /** Draw a quadratic Bézier curve to this node */
        QCurve = 'QCurve'
    }
    /** A node in a glyph outline */
    export interface Node {
        /** The x-coordinate of the node */
        x: number;
        /** The y-coordinate of the node */
        y: number;
        /** The type of the node */
        nodetype: NodeType;
        /** Whether the node is smooth */
        smooth?: boolean;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** A path in a glyph */
    export interface Path {
        /** A list of nodes in the path */
        nodes: Node[];
        /** Whether the path is closed */
        closed: boolean;
        /** Format-specific data */
        format_specific?: Record<string, any>;
    }
    /** Type of font metric */
    export type MetricType =
        /** X height */
        | 'XHeight'
        /** Cap height */
        | 'CapHeight'
        /** Ascender (design-time ascender for the master) */
        | 'Ascender'
        /** Descender (design-time descender for the master) */
        | 'Descender'
        /** Italic angle (in degrees, negative for right slant) */
        | 'ItalicAngle'
        /** Ascender (to be placed in the `hhea` table) */
        | 'HheaAscender'
        /** Descender (to be placed in the `hhea` table) */
        | 'HheaDescender'
        /** Line gap (to be placed in the `hhea` table) */
        | 'HheaLineGap'
        /** Windows Ascender (to be placed in the `OS/2` table) */
        | 'WinAscent'
        /** Windows Descender (to be placed in the `OS/2` table) */
        | 'WinDescent'
        /** Typographic Ascender (to be placed in the `OS/2` table) */
        | 'TypoAscender'
        /** Typographic Descender (to be placed in the `OS/2` table) */
        | 'TypoDescender'
        /** Typographic Line Gap (to be placed in the `OS/2` table) */
        | 'TypoLineGap'
        /** Subscript horizontal font size */
        | 'SubscriptXSize'
        /** Subscript vertical font size */
        | 'SubscriptYSize'
        /** Subscript horizontal offset */
        | 'SubscriptXOffset'
        /** Subscript vertical offset */
        | 'SubscriptYOffset'
        /** Superscript horizontal font size */
        | 'SuperscriptXSize'
        /** Superscript vertical font size */
        | 'SuperscriptYSize'
        /** Superscript horizontal offset */
        | 'SuperscriptXOffset'
        /** Superscript vertical offset */
        | 'SuperscriptYOffset'
        /** Strikeout size */
        | 'StrikeoutSize'
        /** Strikeout position */
        | 'StrikeoutPosition'
        /** Underline position */
        | 'UnderlinePosition'
        /** Underline thickness */
        | 'UnderlineThickness'
        /** Caret slope rise (for the `hhea` table) */
        | 'HheaCaretSlopeRise'
        /** Caret slope run (for the `hhea` table) */
        | 'HheaCaretSlopeRun'
        /** Caret offset (for the `hhea` table) */
        | 'HheaCaretOffset'
        /** Custom metric type */
        | { Custom: string };
    /** The style map style of a font */
    export enum StyleMapStyle {
        /** Bold italic style */
        BoldItalic = 'BoldItalic',
        /** Bold style */
        Bold = 'Bold',
        /** Regular style */
        Regular = 'Regular',
        /** Italic style */
        Italic = 'Italic'
    }
    /**
     * Custom JSON reviver and replacer functions for dynamic data transformation
     * ReviverFunc is used during JSON parsing to detect and transform specific data structures
     * ReplacerFunc is used during JSON serialization to modify certain values before stringifying.
     * These functions allow for flexible encoding and decoding of data, ensuring that complex types are properly handled when converting between TS objects and JSON
     */
    export const ReviverFunc = (key: string, value: unknown): unknown => {
        if (
            typeof value === 'string' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
            key === 'date'
        ) {
            return new Date(value);
        }
        return value;
    };
    export const ReplacerFunc = (key: string, value: unknown): unknown => {
        if (value instanceof Date) {
            return value.toISOString();
        }
        return value;
    };
}
