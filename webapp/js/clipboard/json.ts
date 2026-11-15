/**
 * Counterpunch native JSON clipboard converter
 * (Glyphs "Copy to Counterpunch" script and Counterpunch copy).
 *
 * Wire JSON is a font-editor envelope: clipboardItems.<vendor> holds each
 * editor's private document. Counterpunch lives under "counterpunch".
 * Whole-glyph documents carry source stations and per-drawing masterIndex
 * association so paste can match across fonts by station order.
 */

import type {
    ClipboardFormatSpecific,
    ClipboardJsonValue,
    PasteAnchor,
    PasteComponent,
    PasteFragment,
    PasteGuide,
    PasteNode,
    PasteNodeType,
    PastePath
} from './types';

/** Shared envelope schema for multi-vendor text/plain JSON. */
export const FONT_EDITOR_CLIPBOARD_SCHEMA = 'font-editor-clipboard';
export const FONT_EDITOR_CLIPBOARD_SCHEMA_VERSION = 1;

/** Vendor key under clipboardItems. */
export const COUNTERPUNCH_CLIPBOARD_VENDOR = 'counterpunch';

/** Counterpunch document version (selection and glyphs). */
export const COUNTERPUNCH_CLIPBOARD_VERSION = 1;

/**
 * HTML/SVG metadata id for embedded Counterpunch JSON (not the vendor key).
 * Kept for stable DOM targeting in SVG interchange.
 */
export const COUNTERPUNCH_CLIPBOARD_METADATA_ID = 'counterpunch-clipboard';

/** Custom MIME for Counterpunch JSON. Chrome keeps this for web paste; macOS apps do not see it. */
export const COUNTERPUNCH_CLIPBOARD_MIME =
    'application/x-counterpunch-clipboard';

export type PasteDrawingStation =
    | { type: 'DefaultForMaster'; masterIndex: number }
    | { type: 'AssociatedWithMaster'; masterIndex: number }
    | { type: 'FreeFloating' };

export type PasteGlyphDrawing = {
    layerId?: string;
    name?: string;
    master: PasteDrawingStation;
    /** Designspace location for free drawings (axis id or tag keys). */
    location?: Record<string, number>;
    width?: number;
    leftMetricsKey?: string | null;
    rightMetricsKey?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
};

export type PasteFeatureVariation = {
    axisRules: unknown[];
    layers: PasteGlyphDrawing[];
};

export type PasteClipboardStation = {
    id: string;
    name: string;
    location?: Record<string, number>;
};

export type PasteGlyph = {
    name: string;
    leftMetricsKey?: string | null;
    rightMetricsKey?: string | null;
    layers: PasteGlyphDrawing[];
    featureVariations?: PasteFeatureVariation[];
};

export type PasteGlyphsDocument = {
    format: 'counterpunch-json';
    kind: 'glyphs';
    version: number;
    masters: PasteClipboardStation[];
    glyphs: PasteGlyph[];
    /**
     * `glyphs`: closed paths store the start node last (Glyphs native order).
     * `start-first`: closed paths store the start node at index 0 (Counterpunch).
     */
    nodeOrder?: 'glyphs' | 'start-first';
};

export type ParsedCounterpunchClipboard =
    | { kind: 'selection'; fragment: PasteFragment }
    | { kind: 'glyphs'; document: PasteGlyphsDocument };

export type CounterpunchNodeOrder = 'glyphs' | 'start-first';

export function canParseCounterpunchJson(payload: string): boolean {
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{')) {
        return false;
    }
    return (
        trimmed.includes(`"clipboardSchema"`) &&
        trimmed.includes(FONT_EDITOR_CLIPBOARD_SCHEMA) &&
        trimmed.includes(`"${COUNTERPUNCH_CLIPBOARD_VENDOR}"`)
    );
}

export function parseCounterpunchJson(
    payload: string
): ParsedCounterpunchClipboard | null {
    let raw: unknown;
    try {
        raw = JSON.parse(payload);
    } catch {
        return null;
    }

    const item = extractCounterpunchClipboardItem(raw);
    if (!item) {
        return null;
    }

    const nodeOrder = parseNodeOrder(item.nodeOrder);
    const kind = item.kind;
    if (kind === 'glyphs') {
        const document = parseGlyphsDocument(item, nodeOrder);
        if (!document) {
            return null;
        }
        return { kind: 'glyphs', document };
    }

    // Default / "selection"
    const fragment = parseSelectionFragment(item, nodeOrder);
    if (!fragment) {
        return null;
    }
    return { kind: 'selection', fragment };
}

/**
 * Pull the Counterpunch vendor document out of a font-editor clipboard envelope.
 */
export function extractCounterpunchClipboardItem(
    raw: unknown
): Record<string, unknown> | null {
    if (!isRecord(raw)) {
        return null;
    }
    if (raw.clipboardSchema !== FONT_EDITOR_CLIPBOARD_SCHEMA) {
        return null;
    }
    const schemaVersion = optionalNumber(raw.clipboardSchemaVersion);
    if (
        schemaVersion === null ||
        schemaVersion < FONT_EDITOR_CLIPBOARD_SCHEMA_VERSION
    ) {
        return null;
    }
    if (!isRecord(raw.clipboardItems)) {
        return null;
    }
    const item = raw.clipboardItems[COUNTERPUNCH_CLIPBOARD_VENDOR];
    return isRecord(item) ? item : null;
}

function parseNodeOrder(value: unknown): CounterpunchNodeOrder {
    return value === 'start-first' ? 'start-first' : 'glyphs';
}

function parseSelectionFragment(
    raw: Record<string, unknown>,
    nodeOrder: CounterpunchNodeOrder
): PasteFragment | null {
    const paths = parsePaths(raw.paths, nodeOrder);
    const components = parseComponents(raw.components);
    const anchors = parseAnchors(raw.anchors);
    const guides = parseGuides(raw.guides);
    if (
        paths.length === 0 &&
        components.length === 0 &&
        anchors.length === 0 &&
        guides.length === 0
    ) {
        return null;
    }
    return {
        format: 'counterpunch-json',
        paths,
        components,
        anchors,
        guides,
        keepAbsoluteCoords: raw.keepAbsoluteCoords !== false
    };
}

function parseGlyphsDocument(
    raw: Record<string, unknown>,
    nodeOrder: CounterpunchNodeOrder
): PasteGlyphsDocument | null {
    const version = optionalNumber(raw.version);
    if (version === null || version < COUNTERPUNCH_CLIPBOARD_VERSION) {
        return null;
    }

    const stations = parseStations(raw.masters);
    if (!stations || stations.length === 0) {
        return null;
    }

    const glyphs = parseGlyphs(raw.glyphs, nodeOrder, stations.length);
    if (!glyphs || glyphs.length === 0) {
        return null;
    }

    return {
        format: 'counterpunch-json',
        kind: 'glyphs',
        version,
        masters: stations,
        glyphs,
        nodeOrder
    };
}

function parseStations(value: unknown): PasteClipboardStation[] | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }
    const stations: PasteClipboardStation[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
            return null;
        }
        const name =
            typeof entry.name === 'string' && entry.name
                ? entry.name
                : entry.id;
        stations.push({
            id: entry.id,
            name,
            location: parseLocation(entry.location) ?? undefined
        });
    }
    return stations;
}

function parseGlyphs(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder,
    stationCount: number
): PasteGlyph[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const glyphs: PasteGlyph[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const drawingsRaw = entry.layers;
        if (!Array.isArray(drawingsRaw) || drawingsRaw.length === 0) {
            continue;
        }
        const drawings: PasteGlyphDrawing[] = [];
        for (const drawingEntry of drawingsRaw) {
            const drawing = parseGlyphDrawing(
                drawingEntry,
                nodeOrder,
                stationCount
            );
            if (drawing) {
                drawings.push(drawing);
            }
        }
        if (drawings.length === 0) {
            continue;
        }

        const featureVariations = parseFeatureVariations(
            entry.featureVariations,
            nodeOrder,
            stationCount
        );

        glyphs.push({
            name: entry.name,
            leftMetricsKey: optionalString(entry.leftMetricsKey),
            rightMetricsKey: optionalString(entry.rightMetricsKey),
            layers: drawings,
            ...(featureVariations.length > 0 ? { featureVariations } : {})
        });
    }
    return glyphs.length > 0 ? glyphs : null;
}

function parseFeatureVariations(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder,
    stationCount: number
): PasteFeatureVariation[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const result: PasteFeatureVariation[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || !Array.isArray(entry.axisRules)) {
            continue;
        }
        if (!Array.isArray(entry.layers) || entry.layers.length === 0) {
            continue;
        }
        const drawings: PasteGlyphDrawing[] = [];
        for (const drawingEntry of entry.layers) {
            const drawing = parseGlyphDrawing(
                drawingEntry,
                nodeOrder,
                stationCount
            );
            if (drawing) {
                drawings.push(drawing);
            }
        }
        if (drawings.length === 0) {
            continue;
        }
        result.push({
            axisRules: entry.axisRules,
            layers: drawings
        });
    }
    return result;
}

function parseGlyphDrawing(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder,
    stationCount: number
): PasteGlyphDrawing | null {
    if (!isRecord(value)) {
        return null;
    }
    const station = parseDrawingStation(value.master, stationCount);
    if (!station) {
        return null;
    }
    return {
        layerId: optionalString(value.layerId) ?? undefined,
        name: optionalString(value.name) ?? undefined,
        master: station,
        location: parseLocation(value.location) ?? undefined,
        width: optionalNumber(value.width) ?? undefined,
        leftMetricsKey: optionalString(value.leftMetricsKey),
        rightMetricsKey: optionalString(value.rightMetricsKey),
        paths: parsePaths(value.paths, nodeOrder),
        components: parseComponents(value.components),
        anchors: parseAnchors(value.anchors),
        guides: parseGuides(value.guides)
    };
}

function parseDrawingStation(
    value: unknown,
    stationCount: number
): PasteDrawingStation | null {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    if (value.type === 'FreeFloating') {
        return { type: 'FreeFloating' };
    }
    const stationIndex = optionalNumber(value.masterIndex);
    if (
        stationIndex === null ||
        !Number.isInteger(stationIndex) ||
        stationIndex < 0 ||
        stationIndex >= stationCount
    ) {
        return null;
    }
    if (value.type === 'DefaultForMaster') {
        return { type: 'DefaultForMaster', masterIndex: stationIndex };
    }
    if (value.type === 'AssociatedWithMaster') {
        return { type: 'AssociatedWithMaster', masterIndex: stationIndex };
    }
    return null;
}

function parseLocation(value: unknown): Record<string, number> | null {
    if (!isRecord(value)) {
        return null;
    }
    const location: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
        const num = optionalNumber(raw);
        if (num === null) {
            continue;
        }
        location[key] = num;
    }
    return Object.keys(location).length > 0 ? location : null;
}

function parsePaths(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder
): PastePath[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const paths: PastePath[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || !Array.isArray(entry.nodes)) {
            continue;
        }
        const nodes: PasteNode[] = [];
        for (const nodeEntry of entry.nodes) {
            const node = parseNode(nodeEntry);
            if (node) {
                nodes.push(node);
            }
        }
        if (nodes.length === 0) {
            continue;
        }
        const closed = Boolean(entry.closed);
        paths.push({
            closed,
            nodes:
                closed && nodeOrder === 'glyphs'
                    ? glyphsClosedPathToStartFirst(nodes)
                    : nodes,
            ...(parseFormatSpecific(entry.format_specific) !== undefined
                ? {
                      format_specific: parseFormatSpecific(
                          entry.format_specific
                      )
                  }
                : {})
        });
    }
    return paths;
}

/**
 * Glyphs stores the closed-path start node at the last index (the oncurve that
 * ends the segment wrapping to nodes[0]). Counterpunch uses index 0 as start.
 */
export function glyphsClosedPathToStartFirst(nodes: PasteNode[]): PasteNode[] {
    if (nodes.length < 2) {
        return nodes;
    }
    const last = nodes[nodes.length - 1];
    if (last.nodetype === 'OffCurve') {
        return nodes;
    }
    return [last, ...nodes.slice(0, -1)];
}

function parseNode(value: unknown): PasteNode | null {
    if (!isRecord(value)) {
        return null;
    }
    const x = optionalNumber(value.x);
    const y = optionalNumber(value.y);
    if (x === null || y === null) {
        return null;
    }
    const nodetype = parseNodeType(value.nodetype ?? value.type);
    if (!nodetype) {
        return null;
    }
    const node: PasteNode = { x, y, nodetype };
    if (value.smooth === true) {
        node.smooth = true;
    }
    return node;
}

function parseNodeType(value: unknown): PasteNodeType | null {
    if (typeof value !== 'string') {
        return null;
    }
    switch (value) {
        case 'Line':
        case 'Curve':
        case 'OffCurve':
        case 'QCurve':
        case 'Move':
            return value;
        default:
            return null;
    }
}

function parseComponents(value: unknown): PasteComponent[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const components: PasteComponent[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.reference !== 'string') {
            continue;
        }
        const transform = parseTransform(entry.transform);
        const component: PasteComponent = {
            reference: entry.reference,
            x: optionalNumber(entry.x) ?? transform?.[4] ?? 0,
            y: optionalNumber(entry.y) ?? transform?.[5] ?? 0
        };
        if (transform) {
            component.transform = transform;
        }
        if (typeof entry.alignment === 'number') {
            component.alignment = entry.alignment;
        }
        if (typeof entry.anchor === 'string') {
            component.anchor = entry.anchor;
        }
        const formatSpecific = parseFormatSpecific(entry.format_specific);
        if (formatSpecific !== undefined) {
            component.format_specific = formatSpecific;
        }
        components.push(component);
    }
    return components;
}

function parseTransform(
    value: unknown
): [number, number, number, number, number, number] | undefined {
    if (!Array.isArray(value) || value.length < 6) {
        return undefined;
    }
    const nums = value.slice(0, 6).map(optionalNumber);
    if (nums.some((n) => n === null)) {
        return undefined;
    }
    return nums as [number, number, number, number, number, number];
}

function parseAnchors(value: unknown): PasteAnchor[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const anchors: PasteAnchor[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const x = optionalNumber(entry.x);
        const y = optionalNumber(entry.y);
        if (x === null || y === null) {
            continue;
        }
        anchors.push({
            name: entry.name,
            x,
            y,
            ...(parseFormatSpecific(entry.format_specific) !== undefined
                ? {
                      format_specific: parseFormatSpecific(
                          entry.format_specific
                      )
                  }
                : {})
        });
    }
    return anchors;
}

function parseGuides(value: unknown): PasteGuide[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const guides: PasteGuide[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const x = optionalNumber(entry.x);
        const y = optionalNumber(entry.y);
        if (x === null || y === null) {
            continue;
        }
        guides.push({
            ...(typeof entry.name === 'string' && entry.name
                ? { name: entry.name }
                : {}),
            x,
            y,
            angle: optionalNumber(entry.angle) ?? 0,
            ...(entry.global === true ? { global: true } : {}),
            ...(parseFormatSpecific(entry.format_specific) !== undefined
                ? {
                      format_specific: parseFormatSpecific(
                          entry.format_specific
                      )
                  }
                : {})
        });
    }
    return guides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseFormatSpecific(
    value: unknown
): ClipboardFormatSpecific | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    for (const nestedValue of Object.values(value)) {
        if (!isClipboardJsonValue(nestedValue)) {
            return undefined;
        }
    }
    return value as ClipboardFormatSpecific;
}

function isClipboardJsonValue(value: unknown): value is ClipboardJsonValue {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isClipboardJsonValue);
    }
    if (isRecord(value)) {
        return Object.values(value).every(isClipboardJsonValue);
    }
    return false;
}

function optionalNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function optionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
