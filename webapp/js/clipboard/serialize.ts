/**
 * Serialize Counterpunch model objects into the font-editor clipboard envelope.
 */

import {
    DecomposedAffineTransform,
    Drawing,
    featureVariationAxisRules,
    type Font,
    type Glyph
} from '../babelfont-model';
import {
    COUNTERPUNCH_CLIPBOARD_VENDOR,
    COUNTERPUNCH_CLIPBOARD_VERSION,
    FONT_EDITOR_CLIPBOARD_SCHEMA,
    FONT_EDITOR_CLIPBOARD_SCHEMA_VERSION,
    type PasteClipboardStation,
    type PasteFeatureVariation,
    type PasteGlyph,
    type PasteGlyphDrawing,
    type PasteDrawingStation
} from './json';
import type {
    PasteAnchor,
    PasteComponent,
    PasteGuide,
    PasteNode,
    PastePath
} from './types';

export { COUNTERPUNCH_CLIPBOARD_VERSION };

export type CounterpunchSelectionClipboard = {
    version: number;
    kind: 'selection';
    nodeOrder: 'start-first';
    keepAbsoluteCoords: true;
    glyph?: string | null;
    layerId?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
};

export type CounterpunchGlyphsClipboard = {
    version: number;
    kind: 'glyphs';
    nodeOrder: 'start-first';
    masters: PasteClipboardStation[];
    glyphs: PasteGlyph[];
};

export type CounterpunchClipboardDocument =
    CounterpunchSelectionClipboard | CounterpunchGlyphsClipboard;

export type FontEditorClipboardEnvelope = {
    clipboardSchema: typeof FONT_EDITOR_CLIPBOARD_SCHEMA;
    clipboardSchemaVersion: number;
    clipboardItems: {
        [vendor: string]: unknown;
        [COUNTERPUNCH_CLIPBOARD_VENDOR]?: CounterpunchClipboardDocument;
    };
};

export function buildSelectionClipboardDocument(options: {
    glyphName?: string | null;
    layerId?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
}): CounterpunchSelectionClipboard | null {
    const { paths, components, anchors, guides } = options;
    if (
        paths.length === 0 &&
        components.length === 0 &&
        anchors.length === 0 &&
        guides.length === 0
    ) {
        return null;
    }
    return {
        version: COUNTERPUNCH_CLIPBOARD_VERSION,
        kind: 'selection',
        nodeOrder: 'start-first',
        keepAbsoluteCoords: true,
        glyph: options.glyphName ?? null,
        layerId: options.layerId ?? null,
        paths,
        components,
        anchors,
        guides
    };
}

export function buildGlyphsClipboardDocument(
    glyphs: PasteGlyph[],
    stations: PasteClipboardStation[]
): CounterpunchGlyphsClipboard | null {
    if (glyphs.length === 0 || stations.length === 0) {
        return null;
    }
    return {
        version: COUNTERPUNCH_CLIPBOARD_VERSION,
        kind: 'glyphs',
        nodeOrder: 'start-first',
        masters: stations,
        glyphs
    };
}

export function wrapClipboardEnvelope(
    document: CounterpunchClipboardDocument,
    extraItems?: Record<string, unknown>
): FontEditorClipboardEnvelope {
    return {
        clipboardSchema: FONT_EDITOR_CLIPBOARD_SCHEMA,
        clipboardSchemaVersion: FONT_EDITOR_CLIPBOARD_SCHEMA_VERSION,
        clipboardItems: {
            ...(extraItems || {}),
            [COUNTERPUNCH_CLIPBOARD_VENDOR]: document
        }
    };
}

export function serializeFontStationsForClipboard(
    font: Font
): PasteClipboardStation[] {
    return (font.stations || []).map((station) => {
        const location = plainLocation(station.location);
        return {
            id: station.id,
            name: stationDisplayName(station),
            ...(location ? { location } : {})
        };
    });
}

export function serializeGlyphForClipboard(glyph: Glyph): PasteGlyph {
    const font = glyph.parent() as Font | null;
    const stationIds = (font?.stations || []).map((station) => station.id);
    const stationIndexById = new Map(
        stationIds.map((id, index) => [id, index] as const)
    );

    const baseDrawings: PasteGlyphDrawing[] = [];
    const featureVariationMap = new Map<
        string,
        { axisRules: unknown[]; layers: PasteGlyphDrawing[] }
    >();

    for (const drawing of getRawForegroundDrawings(glyph)) {
        const serialized = serializeDrawingForClipboard(
            drawing,
            stationIndexById
        );
        if (!serialized) {
            continue;
        }
        const axisRules = readFeatureVariationAxisRules(drawing);
        if (axisRules) {
            const familyId = JSON.stringify(axisRules);
            let family = featureVariationMap.get(familyId);
            if (!family) {
                family = { axisRules, layers: [] };
                featureVariationMap.set(familyId, family);
            }
            family.layers.push(serialized);
            continue;
        }
        baseDrawings.push(serialized);
    }

    const featureVariations: PasteFeatureVariation[] = [
        ...featureVariationMap.values()
    ];

    return {
        name: glyph.name,
        leftMetricsKey: glyph.leftMetricsKey ?? null,
        rightMetricsKey: glyph.rightMetricsKey ?? null,
        layers: baseDrawings,
        ...(featureVariations.length > 0 ? { featureVariations } : {})
    };
}

export function serializeDrawingForClipboard(
    drawing: Drawing,
    stationIndexById?: Map<string, number>
): PasteGlyphDrawing | null {
    const station = serializeDrawingStation(drawing, stationIndexById);
    if (!station) {
        return null;
    }

    const paths: PastePath[] = [];
    const components: PasteComponent[] = [];
    for (const shape of drawing.shapes || []) {
        if (shape.isPath?.()) {
            paths.push(serializePathForClipboard(shape.asPath()));
        } else if (shape.isComponent?.()) {
            components.push(
                serializeComponentForClipboard(shape.asComponent())
            );
        }
    }

    const location = plainLocation(drawing.location);
    return {
        layerId: drawing.id,
        name: drawing.name,
        master: station,
        ...(location ? { location } : {}),
        width: Number(drawing.width),
        leftMetricsKey: drawing.leftMetricsKey ?? null,
        rightMetricsKey: drawing.rightMetricsKey ?? null,
        paths,
        components,
        anchors: (drawing.anchors || [])
            .filter((anchor) => !!anchor.name)
            .map(serializeAnchorForClipboard),
        guides: (drawing.guides || []).map((guide) =>
            serializeGuideForClipboard(guide, false)
        )
    };
}

export function serializePathForClipboard(path: {
    closed?: boolean;
    format_specific?: PastePath['format_specific'];
    nodes?: Array<{
        x: number;
        y: number;
        nodetype?: string;
        type?: string;
        smooth?: boolean;
    }>;
}): PastePath {
    const nodes: PasteNode[] = [];
    for (const node of path.nodes || []) {
        const serialized = serializeNodeForClipboard(node);
        if (serialized) {
            nodes.push(serialized);
        }
    }
    const closed = !!path.closed;
    return {
        closed,
        nodes: ensureStartFirstNodes(nodes, closed),
        ...(path.format_specific !== undefined
            ? { format_specific: path.format_specific }
            : {})
    };
}

/** Rotate Glyphs-ordered closed contours so the start on-curve is index 0. */
function ensureStartFirstNodes(
    nodes: PasteNode[],
    closed: boolean
): PasteNode[] {
    if (!closed || nodes.length < 2) {
        return nodes;
    }
    if (nodes[0].nodetype !== 'OffCurve') {
        return nodes;
    }
    const last = nodes[nodes.length - 1];
    if (last.nodetype === 'OffCurve') {
        return nodes;
    }
    return [last, ...nodes.slice(0, -1)];
}

export function serializeComponentForClipboard(component: {
    reference: string;
    transform?: unknown;
    automaticAlignment?: boolean;
    anchor?: string;
    format_specific?: PasteComponent['format_specific'];
}): PasteComponent {
    const transform = toAffineTuple(component.transform);
    return {
        reference: component.reference,
        x: transform[4],
        y: transform[5],
        transform,
        alignment: component.automaticAlignment ? 1 : 0,
        ...(component.anchor ? { anchor: component.anchor } : {}),
        ...(component.format_specific !== undefined
            ? { format_specific: component.format_specific }
            : {})
    };
}

export function serializeAnchorForClipboard(anchor: {
    name?: string;
    x: number;
    y: number;
    format_specific?: PasteAnchor['format_specific'];
}): PasteAnchor {
    return {
        name: anchor.name || '',
        x: Number(anchor.x),
        y: Number(anchor.y),
        ...(anchor.format_specific !== undefined
            ? { format_specific: anchor.format_specific }
            : {})
    };
}

export function serializeGuideForClipboard(
    guide: {
        name?: string;
        pos?: { x?: number; y?: number; angle?: number };
        x?: number;
        y?: number;
        angle?: number;
        format_specific?: PasteGuide['format_specific'];
    },
    globalGuide: boolean
): PasteGuide {
    const x = Number(guide.pos?.x ?? guide.x ?? 0);
    const y = Number(guide.pos?.y ?? guide.y ?? 0);
    const angle = Number(guide.pos?.angle ?? guide.angle ?? 0);
    return {
        ...(guide.name ? { name: guide.name } : {}),
        x,
        y,
        angle,
        global: globalGuide,
        ...(guide.format_specific !== undefined
            ? { format_specific: guide.format_specific }
            : {})
    };
}

export function serializeStationGuideForClipboard(guide: {
    name?: string;
    pos?: { x?: number; y?: number; angle?: number };
    x?: number;
    y?: number;
    angle?: number;
}): PasteGuide {
    return serializeGuideForClipboard(guide, true);
}

export function stringifyClipboardDocument(
    document: CounterpunchClipboardDocument
): string {
    return JSON.stringify(wrapClipboardEnvelope(document), null, 4);
}

export function summarizeClipboardDocument(
    document: CounterpunchClipboardDocument
): string {
    if (document.kind === 'selection') {
        const counts: string[] = [];
        const entries: Array<[keyof CounterpunchSelectionClipboard, string]> = [
            ['paths', 'path'],
            ['components', 'component'],
            ['anchors', 'anchor'],
            ['guides', 'guide']
        ];
        for (const [key, label] of entries) {
            const value = document[key];
            const count = Array.isArray(value) ? value.length : 0;
            if (count > 0) {
                counts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
            }
        }
        const detail = counts.length > 0 ? counts.join(', ') : 'nothing';
        return `Copied ${detail} from /${document.glyph || '?'}`;
    }
    const count = document.glyphs.length;
    return `Copied ${count} glyph${count === 1 ? '' : 's'}`;
}

function serializeNodeForClipboard(node: {
    x: number;
    y: number;
    nodetype?: string;
    type?: string;
    smooth?: boolean;
}): PasteNode | null {
    const rawType = String(node.nodetype || node.type || '');
    const nodetype = normalizeNodeType(rawType);
    if (!nodetype) {
        return null;
    }
    return {
        x: Number(node.x),
        y: Number(node.y),
        nodetype,
        ...(node.smooth && nodetype !== 'OffCurve' ? { smooth: true } : {})
    };
}

function normalizeNodeType(value: string): PasteNode['nodetype'] | null {
    switch (value) {
        case 'Line':
        case 'Curve':
        case 'OffCurve':
        case 'QCurve':
        case 'Move':
            return value;
        case 'line':
            return 'Line';
        case 'curve':
            return 'Curve';
        case 'offcurve':
        case 'o':
            return 'OffCurve';
        case 'qcurve':
            return 'QCurve';
        case 'move':
            return 'Move';
        default:
            return null;
    }
}

function toAffineTuple(
    transform: unknown
): [number, number, number, number, number, number] {
    if (Array.isArray(transform) && transform.length >= 6) {
        return [
            Number(transform[0]) || 0,
            Number(transform[1]) || 0,
            Number(transform[2]) || 0,
            Number(transform[3]) || 0,
            Number(transform[4]) || 0,
            Number(transform[5]) || 0
        ];
    }
    if (transform && typeof transform === 'object') {
        return DecomposedAffineTransform.toAffine(
            transform as Parameters<
                typeof DecomposedAffineTransform.toAffine
            >[0]
        );
    }
    return DecomposedAffineTransform.toAffine(
        DecomposedAffineTransform.identity()
    );
}

function getRawForegroundDrawings(glyph: Glyph): Drawing[] {
    const drawingsData = (glyph as unknown as { data?: { layers?: unknown[] } })
        .data?.layers;
    if (!Array.isArray(drawingsData)) {
        return [];
    }
    const drawings: Drawing[] = [];
    for (let index = 0; index < drawingsData.length; index++) {
        const drawing = new Drawing(drawingsData as never, index, glyph);
        if (drawing.is_background) {
            continue;
        }
        drawings.push(drawing);
    }
    return drawings;
}

function serializeDrawingStation(
    drawing: Drawing,
    stationIndexById?: Map<string, number>
): PasteDrawingStation | null {
    const station = drawing.station;
    if (!station || typeof station !== 'object' || !('type' in station)) {
        return null;
    }
    if (station.type === 'FreeFloating') {
        return { type: 'FreeFloating' };
    }
    if (
        station.type !== 'DefaultForMaster' &&
        station.type !== 'AssociatedWithMaster'
    ) {
        return null;
    }
    const stationId = station.master;
    if (typeof stationId !== 'string' || !stationId) {
        return null;
    }
    const stationIndex = stationIndexById?.get(stationId);
    if (stationIndex === undefined) {
        return null;
    }
    return { type: station.type, masterIndex: stationIndex };
}

function readFeatureVariationAxisRules(drawing: Drawing): unknown[] | null {
    return featureVariationAxisRules(
        drawing.toJSON() as Parameters<typeof featureVariationAxisRules>[0]
    );
}

function plainLocation(value: unknown): Record<string, number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const location: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(num)) {
            continue;
        }
        location[key] = num;
    }
    return Object.keys(location).length > 0 ? location : null;
}

function stationDisplayName(station: {
    id: string;
    toJSON?: () => { name?: unknown };
}): string {
    const name = station.toJSON?.()?.name;
    if (typeof name === 'string' && name) {
        return name;
    }
    if (name && typeof name === 'object' && !Array.isArray(name)) {
        const record = name as Record<string, unknown>;
        for (const key of ['dflt', 'en']) {
            if (typeof record[key] === 'string' && record[key]) {
                return record[key] as string;
            }
        }
        for (const value of Object.values(record)) {
            if (typeof value === 'string' && value) {
                return value;
            }
        }
    }
    return station.id;
}

// Re-export helpers used by callers that also serialize station guides.
export type { PasteGlyph };
