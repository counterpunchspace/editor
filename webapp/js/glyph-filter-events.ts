/**
 * Stable event contract used to decide when glyph filters should refresh.
 * Event emission and filter execution intentionally live outside this registry.
 *
 * Host derivation lives in `glyph-filter-change-derivation.ts` and is invoked
 * from `GlyphOverviewFilterManager.handleCommittedChangeEntries` after each
 * committed change-bridge batch. Filters subscribe via `EVENT_TYPES` /
 * `event_types` using these dotted names only — browser `CustomEvent` names
 * are not part of the plugin API.
 *
 * Glyph creation, deletion, and renaming are host lifecycle operations, not
 * filter subscriptions. Event types cover incremental glyph-content edits.
 */
export const GLYPH_FILTER_EVENT_TYPES = [
    'glyph.unicode.changed',
    'glyph.category.changed',
    'glyph.export.changed',
    'glyph.production-name.changed',
    'glyph.paths.changed',
    'glyph.components.changed',
    'glyph.component.reference.changed',
    'glyph.component.transform.changed',
    'glyph.anchors.changed',
    'glyph.guides.changed',
    'glyph.drawings.changed',
    'glyph.drawing.location.changed',
    'glyph.metrics.changed',
    'glyph.metrics-key.changed',
    'glyph.compatibility.changed',
    'glyph.qa.changed'
] as const;

export type GlyphFilterEventType = (typeof GLYPH_FILTER_EVENT_TYPES)[number];

export type GlyphFilterEventMetadataFieldType =
    'boolean' | 'number' | 'string' | 'string[]' | 'number | null';

export interface GlyphFilterEventMetadataField {
    name: string;
    type: GlyphFilterEventMetadataFieldType;
    description: string;
    required: boolean;
}

export interface GlyphFilterEventDefinition {
    name: string;
    description: string;
    metadataFields: readonly GlyphFilterEventMetadataField[];
}

const GLYPH_NAME_FIELD: GlyphFilterEventMetadataField = {
    name: 'glyphName',
    type: 'string',
    description: "The affected glyph's name.",
    required: true
};

const DRAWING_IDS_FIELD: GlyphFilterEventMetadataField = {
    name: 'drawingIds',
    type: 'string[]',
    description: 'Drawing IDs touched by the change, when known.',
    required: false
};

export const GLYPH_FILTER_EVENT_REGISTRY = {
    'glyph.unicode.changed': {
        name: 'Glyph Unicode Changed',
        description: "A glyph's Unicode assignment changed.",
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: "The changed glyph's name.",
                required: true
            },
            {
                name: 'unicode',
                type: 'number | null',
                description: "The glyph's new Unicode value, if any.",
                required: true
            },
            {
                name: 'previousUnicode',
                type: 'number | null',
                description: "The glyph's previous Unicode value, if any.",
                required: true
            }
        ]
    },
    'glyph.category.changed': {
        name: 'Glyph Category Changed',
        description: "A glyph's category assignment changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.export.changed': {
        name: 'Glyph Export Changed',
        description: "A glyph's export flag changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.production-name.changed': {
        name: 'Glyph Production Name Changed',
        description: "A glyph's production name changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.paths.changed': {
        name: 'Glyph Paths Changed',
        description:
            'Path geometry or path structure on one or more drawings of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.components.changed': {
        name: 'Glyph Components Changed',
        description:
            'Component membership on one or more drawings of a glyph changed (add, remove, or replace).',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.component.reference.changed': {
        name: 'Glyph Component Reference Changed',
        description: 'A component instance changed which glyph it references.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.component.transform.changed': {
        name: 'Glyph Component Transform Changed',
        description: 'A component instance transform changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.anchors.changed': {
        name: 'Glyph Anchors Changed',
        description: 'Anchors on one or more drawings of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.guides.changed': {
        name: 'Glyph Guides Changed',
        description: 'Guides on one or more drawings of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.drawings.changed': {
        name: 'Glyph Drawings Changed',
        description:
            'A glyph drawing was added, removed, or otherwise structurally changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.drawing.location.changed': {
        name: 'Glyph Drawing Location Changed',
        description:
            'A free drawing’s location (designspace coordinates) changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.metrics.changed': {
        name: 'Glyph Metrics Changed',
        description:
            'Drawing metrics such as advance width or sidebearings changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.metrics-key.changed': {
        name: 'Glyph Metrics Key Changed',
        description:
            'A glyph- or drawing-level metrics key (LSB/RSB formula) changed.',
        metadataFields: [GLYPH_NAME_FIELD, DRAWING_IDS_FIELD]
    },
    'glyph.compatibility.changed': {
        name: 'Glyph Compatibility Changed',
        description:
            "A glyph's outline compatibility boolean (`Glyph.isCompatible`) toggled.",
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: 'The glyph whose compatibility changed.',
                required: true
            },
            {
                name: 'compatible',
                type: 'boolean',
                description:
                    'Whether the glyph’s relevant drawings are compatible after the change.',
                required: true
            },
            {
                name: 'drawingIds',
                type: 'string[]',
                description:
                    'The drawing IDs considered by the compatibility check.',
                required: true
            }
        ]
    },
    'glyph.qa.changed': {
        name: 'Glyph Auto QA Changed',
        description:
            'Whether Auto QA reports anything for a glyph (`Glyph.hasQaIssues`) toggled.',
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: 'The glyph whose Auto QA status changed.',
                required: true
            },
            {
                name: 'hasQaIssues',
                type: 'boolean',
                description:
                    'Whether Auto QA reports anything for the glyph after the change.',
                required: true
            }
        ]
    }
} as const satisfies Record<GlyphFilterEventType, GlyphFilterEventDefinition>;

export type GlyphFilterEventMetadataValue =
    boolean | number | string | readonly string[] | null;

export interface GlyphFilterChange {
    type: GlyphFilterEventType;
    metadata: Readonly<Record<string, GlyphFilterEventMetadataValue>>;
}

export interface GlyphFilterChangeBatch {
    changes: readonly GlyphFilterChange[];
}

export interface GlyphFilterAssistantEventDefinition {
    type: GlyphFilterEventType;
    name: string;
    description: string;
    metadataFields: readonly GlyphFilterEventMetadataField[];
}

export interface GlyphFilterEventAssistantView {
    events: readonly GlyphFilterAssistantEventDefinition[];
}

/** Returns whether a string is one of the registered glyph filter event types. */
export function isGlyphFilterEventType(
    value: string
): value is GlyphFilterEventType {
    return GLYPH_FILTER_EVENT_TYPES.includes(value as GlyphFilterEventType);
}

/** Returns the registry contract in a JSON-serializable assistant-facing shape. */
export function getGlyphFilterEventAssistantView(): GlyphFilterEventAssistantView {
    return {
        events: GLYPH_FILTER_EVENT_TYPES.map((type) => ({
            type,
            name: GLYPH_FILTER_EVENT_REGISTRY[type].name,
            description: GLYPH_FILTER_EVENT_REGISTRY[type].description,
            metadataFields: GLYPH_FILTER_EVENT_REGISTRY[
                type
            ].metadataFields.map((field) => ({ ...field }))
        }))
    };
}
