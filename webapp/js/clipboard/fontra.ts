/**
 * Fontra web clipboard interchange (`fontra/json-clipboard`).
 *
 * Only the tagged Chromium custom MIME is used — never text/plain, even when
 * Fontra also mirrors JSON there. Paste gating stays in the shared
 * parseClipboardPayloads → view `.focused` path.
 */

import {
    affineToDecomposedAffine,
    decomposedAffineToAffine,
    multiplyAffineTransforms
} from '../glyph-path-geometry';
import type {
    CounterpunchClipboardDocument,
    CounterpunchGlyphsClipboard,
    CounterpunchSelectionClipboard
} from './serialize';
import type {
    PasteAnchor,
    PasteComponent,
    PasteFragment,
    PasteGuide,
    PasteNode,
    PastePath
} from './types';
import type {
    PasteClipboardStation,
    PasteGlyph,
    PasteGlyphDrawing,
    PasteGlyphsDocument
} from './json';
import { COUNTERPUNCH_CLIPBOARD_VERSION } from './json';
import type { Babelfont } from '../babelfont';

/** Unprefixed MIME Fontra registers via ClipboardItem. */
export const FONTRA_CLIPBOARD_MIME = 'fontra/json-clipboard';

/** Types Chrome reports on ClipboardItem / DataTransfer for Fontra JSON. */
export const FONTRA_CLIPBOARD_MIME_TYPES = [
    `web ${FONTRA_CLIPBOARD_MIME}`,
    FONTRA_CLIPBOARD_MIME
] as const;

const FONTRA_LAYER_GLYPHS = 'fontra-layer-glyphs';
const FONTRA_GLYPH_ARRAY = 'fontra-glyph-array';

/** Live Fontra packed-path flags (VarPackedPath). */
const FONTRA_OFF_CURVE = 0x02;
const FONTRA_SMOOTH_FLAG = 0x08;

export type ParsedFontraClipboard =
    | { kind: 'selection'; fragment: PasteFragment }
    | { kind: 'glyphs'; document: PasteGlyphsDocument };

type FontraDecomposedTransform = {
    translateX?: number;
    translateY?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    skewX?: number;
    skewY?: number;
    tCenterX?: number;
    tCenterY?: number;
};

type FontraPackedPath = {
    coordinates?: number[];
    pointTypes?: number[];
    contourInfo?: Array<{ endPoint?: number; isClosed?: boolean }>;
};

type FontraStaticGlyph = {
    xAdvance?: number;
    path?: FontraPackedPath;
    components?: unknown[];
    anchors?: unknown[];
    guidelines?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function isFontraClipboardMimeType(type: string): boolean {
    return (FONTRA_CLIPBOARD_MIME_TYPES as readonly string[]).includes(type);
}

export function canParseFontraClipboardPayload(
    type: string,
    data: string
): boolean {
    if (!isFontraClipboardMimeType(type)) {
        return false;
    }
    const trimmed = data.trim();
    return (
        trimmed.startsWith('{') &&
        (trimmed.includes(`"${FONTRA_LAYER_GLYPHS}"`) ||
            trimmed.includes(`"${FONTRA_GLYPH_ARRAY}"`))
    );
}

export function parseFontraClipboard(
    payload: string
): ParsedFontraClipboard | null {
    let raw: unknown;
    try {
        raw = JSON.parse(payload);
    } catch {
        return null;
    }
    if (!isRecord(raw) || !isRecord(raw.data)) {
        return null;
    }

    if (raw.type === FONTRA_LAYER_GLYPHS) {
        const fragment = parseFontraLayerGlyphs(raw.data);
        return fragment ? { kind: 'selection', fragment } : null;
    }

    if (raw.type === FONTRA_GLYPH_ARRAY) {
        const document = parseFontraGlyphArray(raw.data);
        return document ? { kind: 'glyphs', document } : null;
    }

    return null;
}

function parseFontraLayerGlyphs(
    data: Record<string, unknown>
): PasteFragment | null {
    const drawingGlyphs = data.layerGlyphs;
    if (!Array.isArray(drawingGlyphs) || drawingGlyphs.length === 0) {
        return null;
    }

    const paths: PastePath[] = [];
    const components: PasteComponent[] = [];
    const anchors: PasteAnchor[] = [];
    const guides: PasteGuide[] = [];

    for (const entry of drawingGlyphs) {
        if (!isRecord(entry) || !isRecord(entry.glyph)) {
            continue;
        }
        const glyph = entry.glyph as FontraStaticGlyph;
        paths.push(...parseFontraPackedPath(glyph.path));
        components.push(...parseFontraComponents(glyph.components));
        anchors.push(...parseFontraAnchors(glyph.anchors));
        guides.push(...parseFontraGuidelines(glyph.guidelines));
    }

    if (
        paths.length === 0 &&
        components.length === 0 &&
        anchors.length === 0 &&
        guides.length === 0
    ) {
        return null;
    }

    return {
        format: 'fontra-json',
        paths,
        components,
        anchors,
        guides,
        keepAbsoluteCoords: true
    };
}

function parseFontraGlyphArray(
    data: Record<string, unknown>
): PasteGlyphsDocument | null {
    const glyphsRaw = data.glyphs;
    if (!Array.isArray(glyphsRaw) || glyphsRaw.length === 0) {
        return null;
    }

    const sourceLocations = isRecord(data.sourceLocations)
        ? data.sourceLocations
        : {};
    const stationIds = Object.keys(sourceLocations);
    if (stationIds.length === 0) {
        // Fall back to source order from the first variable glyph.
        const first = glyphsRaw.find((entry) => isRecord(entry));
        const vg =
            first && isRecord(first) && isRecord(first.variableGlyph)
                ? first.variableGlyph
                : null;
        const sources = vg && Array.isArray(vg.sources) ? vg.sources : [];
        for (const source of sources) {
            if (!isRecord(source)) {
                continue;
            }
            const id =
                optionalString(source.layerName) ||
                optionalString(source.locationBase);
            if (id && !stationIds.includes(id)) {
                stationIds.push(id);
            }
        }
    }
    if (stationIds.length === 0) {
        return null;
    }

    const stationIndexById = new Map(
        stationIds.map((id, index) => [id, index] as const)
    );
    const stations: PasteClipboardStation[] = stationIds.map((id) => {
        const locationRaw = sourceLocations[id];
        const location = isRecord(locationRaw)
            ? Object.fromEntries(
                  Object.entries(locationRaw).filter(
                      (entry): entry is [string, number] =>
                          typeof entry[1] === 'number' &&
                          Number.isFinite(entry[1])
                  )
              )
            : undefined;
        return {
            id,
            name: id,
            ...(location && Object.keys(location).length > 0
                ? { location }
                : {})
        };
    });

    const glyphs: PasteGlyph[] = [];
    for (const entry of glyphsRaw) {
        if (!isRecord(entry) || !isRecord(entry.variableGlyph)) {
            continue;
        }
        const variableGlyph = entry.variableGlyph;
        const name = optionalString(variableGlyph.name);
        if (!name) {
            continue;
        }
        const drawingsMap = isRecord(variableGlyph.layers)
            ? variableGlyph.layers
            : {};
        const sources = Array.isArray(variableGlyph.sources)
            ? variableGlyph.sources
            : [];

        const drawings: PasteGlyphDrawing[] = [];
        for (const source of sources) {
            if (!isRecord(source)) {
                continue;
            }
            const drawingName =
                optionalString(source.layerName) ||
                optionalString(source.locationBase);
            if (!drawingName || !isRecord(drawingsMap[drawingName])) {
                continue;
            }
            const stationIndex = stationIndexById.get(drawingName);
            if (stationIndex === undefined) {
                continue;
            }
            const drawingEntry = drawingsMap[drawingName] as Record<
                string,
                unknown
            >;
            const staticGlyph = isRecord(drawingEntry.glyph)
                ? (drawingEntry.glyph as FontraStaticGlyph)
                : null;
            if (!staticGlyph) {
                continue;
            }
            drawings.push({
                layerId: drawingName,
                name: drawingName,
                master: { type: 'DefaultForMaster', masterIndex: stationIndex },
                width: optionalNumber(staticGlyph.xAdvance) ?? undefined,
                paths: parseFontraPackedPath(staticGlyph.path),
                components: parseFontraComponents(staticGlyph.components),
                anchors: parseFontraAnchors(staticGlyph.anchors),
                guides: parseFontraGuidelines(staticGlyph.guidelines)
            });
        }

        if (drawings.length === 0) {
            continue;
        }

        glyphs.push({ name, layers: drawings });
    }

    if (glyphs.length === 0) {
        return null;
    }

    return {
        format: 'counterpunch-json',
        kind: 'glyphs',
        version: COUNTERPUNCH_CLIPBOARD_VERSION,
        masters: stations,
        glyphs,
        nodeOrder: 'start-first'
    };
}

function parseFontraPackedPath(
    path: FontraPackedPath | undefined
): PastePath[] {
    if (!path) {
        return [];
    }
    const coordinates = Array.isArray(path.coordinates) ? path.coordinates : [];
    const pointTypes = Array.isArray(path.pointTypes) ? path.pointTypes : [];
    const contourInfo = Array.isArray(path.contourInfo) ? path.contourInfo : [];
    const pointCount = Math.min(
        Math.floor(coordinates.length / 2),
        pointTypes.length
    );
    if (pointCount === 0 || contourInfo.length === 0) {
        return [];
    }

    const paths: PastePath[] = [];
    let start = 0;
    for (const contour of contourInfo) {
        const endPoint = optionalNumber(contour?.endPoint);
        if (endPoint === null || endPoint < start || endPoint >= pointCount) {
            break;
        }
        const nodes: PasteNode[] = [];
        for (let i = start; i <= endPoint; i++) {
            const type = Number(pointTypes[i]) || 0;
            const x = Number(coordinates[i * 2]) || 0;
            const y = Number(coordinates[i * 2 + 1]) || 0;
            if (isFontraOffCurve(type)) {
                nodes.push({ x, y, nodetype: 'OffCurve' });
            } else {
                nodes.push({
                    x,
                    y,
                    nodetype: 'Line',
                    ...(isFontraSmooth(type) ? { smooth: true } : {})
                });
            }
        }
        paths.push({
            closed: !!contour?.isClosed,
            nodes: finalizeFontraContourNodes(nodes, !!contour?.isClosed)
        });
        start = endPoint + 1;
    }
    return paths;
}

function isFontraOffCurve(type: number): boolean {
    return (type & 0x07) === FONTRA_OFF_CURVE;
}

function isFontraSmooth(type: number): boolean {
    return (type & FONTRA_SMOOTH_FLAG) !== 0;
}

function finalizeFontraContourNodes(
    nodes: PasteNode[],
    closed: boolean
): PasteNode[] {
    if (nodes.length === 0) {
        return nodes;
    }
    const result = nodes.map((node) => ({ ...node }));
    for (let i = 0; i < result.length; i++) {
        if (result[i].nodetype === 'OffCurve') {
            continue;
        }
        const prev = result[(i - 1 + result.length) % result.length];
        const useCurve = closed || i > 0 ? prev.nodetype === 'OffCurve' : false;
        result[i].nodetype = useCurve ? 'Curve' : 'Line';
    }
    return result;
}

function parseFontraComponents(value: unknown): PasteComponent[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const components: PasteComponent[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const name = optionalString(entry.name);
        if (!name) {
            continue;
        }
        const transformation = isRecord(entry.transformation)
            ? (entry.transformation as FontraDecomposedTransform)
            : {};
        const transform = fontraTransformToAffine(transformation);
        components.push({
            reference: name,
            x: transform[4],
            y: transform[5],
            transform
        });
    }
    return components;
}

function parseFontraAnchors(value: unknown): PasteAnchor[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const anchors: PasteAnchor[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const name = optionalString(entry.name);
        const x = optionalNumber(entry.x);
        const y = optionalNumber(entry.y);
        if (!name || x === null || y === null) {
            continue;
        }
        anchors.push({ name, x, y });
    }
    return anchors;
}

function parseFontraGuidelines(value: unknown): PasteGuide[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const guides: PasteGuide[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const x = optionalNumber(entry.x) ?? 0;
        const y = optionalNumber(entry.y) ?? 0;
        const angle = optionalNumber(entry.angle) ?? 0;
        guides.push({
            ...(optionalString(entry.name)
                ? { name: optionalString(entry.name)! }
                : {}),
            x,
            y,
            angle,
            global: false
        });
    }
    return guides;
}

const REST_OF_THE_WORLD = 'RestOfTheWorld' as Babelfont.TransformOrder;

export function fontraTransformToAffine(
    t: FontraDecomposedTransform
): [number, number, number, number, number, number] {
    const cx = Number(t.tCenterX) || 0;
    const cy = Number(t.tCenterY) || 0;
    const tx = Number(t.translateX) || 0;
    const ty = Number(t.translateY) || 0;
    const core = decomposedAffineToAffine({
        translation: [0, 0],
        scale: [Number(t.scaleX) || 1, Number(t.scaleY) || 1],
        rotation: ((Number(t.rotation) || 0) * Math.PI) / 180,
        skew: [
            ((Number(t.skewX) || 0) * Math.PI) / 180,
            ((Number(t.skewY) || 0) * Math.PI) / 180
        ],
        order: REST_OF_THE_WORLD
    });
    // Fontra: translate(t + c) · R·S·K · translate(-c)
    return multiplyAffineTransforms(
        multiplyAffineTransforms([1, 0, 0, 1, tx + cx, ty + cy], core),
        [1, 0, 0, 1, -cx, -cy]
    ) as [number, number, number, number, number, number];
}

export function affineToFontraTransform(
    affine: [number, number, number, number, number, number]
): FontraDecomposedTransform {
    const decomposed = affineToDecomposedAffine(affine, REST_OF_THE_WORLD);
    return {
        translateX: decomposed.translation?.[0] ?? 0,
        translateY: decomposed.translation?.[1] ?? 0,
        rotation: ((decomposed.rotation ?? 0) * 180) / Math.PI,
        scaleX: decomposed.scale?.[0] ?? 1,
        scaleY: decomposed.scale?.[1] ?? 1,
        skewX: ((decomposed.skew?.[0] ?? 0) * 180) / Math.PI,
        skewY: ((decomposed.skew?.[1] ?? 0) * 180) / Math.PI,
        tCenterX: 0,
        tCenterY: 0
    };
}

function packPaths(paths: PastePath[]): FontraPackedPath {
    const coordinates: number[] = [];
    const pointTypes: number[] = [];
    const contourInfo: Array<{ endPoint: number; isClosed: boolean }> = [];

    for (const path of paths) {
        for (const node of path.nodes) {
            coordinates.push(Number(node.x) || 0, Number(node.y) || 0);
            if (node.nodetype === 'OffCurve') {
                pointTypes.push(FONTRA_OFF_CURVE);
            } else {
                pointTypes.push(node.smooth ? FONTRA_SMOOTH_FLAG : 0);
            }
        }
        contourInfo.push({
            endPoint: pointTypes.length - 1,
            isClosed: !!path.closed
        });
    }

    return { coordinates, pointTypes, contourInfo };
}

function serializeStaticGlyph(options: {
    width?: number;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
}): FontraStaticGlyph {
    return {
        xAdvance: options.width ?? 0,
        path: packPaths(options.paths),
        components: options.components.map((component) => {
            const transform =
                component.transform ??
                ([1, 0, 0, 1, component.x, component.y] as [
                    number,
                    number,
                    number,
                    number,
                    number,
                    number
                ]);
            return {
                name: component.reference,
                transformation: affineToFontraTransform(transform),
                location: {},
                customData: {}
            };
        }),
        anchors: options.anchors.map((anchor) => ({
            name: anchor.name,
            x: anchor.x,
            y: anchor.y
        })),
        guidelines: options.guides
            .filter((guide) => !guide.global)
            .map((guide) => ({
                x: guide.x,
                y: guide.y,
                angle: guide.angle,
                locked: false,
                ...(guide.name ? { name: guide.name } : {})
            }))
    };
}

/**
 * Build Fontra tagged clipboard JSON from a Counterpunch clipboard document.
 */
export function stringifyFontraClipboardDocument(
    document: CounterpunchClipboardDocument,
    options?: {
        layerId?: string;
        layerWidth?: number;
        codePoints?: number[];
        glyphCodePoints?: Record<string, number[]>;
        /**
         * Map Counterpunch location keys (axis tag / id / name) → Fontra
         * sourceLocations axis name (e.g. wght → Weight).
         */
        axisNameByKey?: Record<string, string>;
    }
): string {
    if (document.kind === 'selection') {
        return JSON.stringify(
            buildFontraLayerGlyphs(document, options),
            null,
            0
        );
    }
    return JSON.stringify(buildFontraGlyphArray(document, options), null, 0);
}

/**
 * Build a tag/id/name → Fontra axis-name map from font axes.
 * Fontra `sourceLocations` use the axis display name ("Weight"), not the
 * OpenType tag ("wght") that Counterpunch stores on stations.
 */
export function buildFontraAxisNameByKey(
    axes: Array<{
        id?: string;
        tag?: string;
        name?: string | Record<string, string> | null;
    }>
): Record<string, string> {
    const map: Record<string, string> = {};
    for (const axis of axes || []) {
        const fontraName = fontraAxisDisplayName(axis);
        if (!fontraName) {
            continue;
        }
        map[fontraName] = fontraName;
        if (axis.tag) {
            map[axis.tag] = fontraName;
        }
        if (axis.id) {
            map[axis.id] = fontraName;
        }
    }
    return map;
}

function fontraAxisDisplayName(axis: {
    tag?: string;
    name?: string | Record<string, string> | null;
}): string | null {
    const name = axis.name;
    if (typeof name === 'string' && name.length > 0) {
        return name;
    }
    if (name && typeof name === 'object') {
        const record = name as Record<string, string>;
        const preferred =
            record.dflt || record.en || Object.values(record).find(Boolean);
        if (preferred) {
            return preferred;
        }
    }
    return axis.tag || null;
}

function remapLocationToFontraAxisNames(
    location: Record<string, number> | undefined,
    axisNameByKey?: Record<string, string>
): Record<string, number> {
    const source = location || {};
    if (!axisNameByKey) {
        return { ...source };
    }
    const remapped: Record<string, number> = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
        }
        remapped[axisNameByKey[key] || key] = value;
    }
    return remapped;
}

function buildFontraLayerGlyphs(
    document: CounterpunchSelectionClipboard,
    options?: {
        layerId?: string;
        layerWidth?: number;
        codePoints?: number[];
    }
): Record<string, unknown> {
    const drawingId = options?.layerId || 'clipboard';
    return {
        type: FONTRA_LAYER_GLYPHS,
        data: {
            layerGlyphs: [
                {
                    layerName: drawingId,
                    location: {},
                    glyph: serializeStaticGlyph({
                        width: options?.layerWidth,
                        paths: document.paths,
                        components: document.components,
                        anchors: document.anchors,
                        guides: document.guides
                    })
                }
            ],
            glyphName: document.glyph || '',
            codePoints: options?.codePoints || []
        }
    };
}

function buildFontraGlyphArray(
    document: CounterpunchGlyphsClipboard,
    options?: {
        glyphCodePoints?: Record<string, number[]>;
        axisNameByKey?: Record<string, string>;
    }
): Record<string, unknown> {
    const stations = document.masters || [];
    const sourceLocations: Record<string, Record<string, number>> = {};
    for (const station of stations) {
        // Fontra binds sources via locationBase → sourceLocations, and matches
        // those locations to the destination font using axis *names* (Weight),
        // not Counterpunch's station location tags (wght).
        sourceLocations[station.id] = remapLocationToFontraAxisNames(
            station.location,
            options?.axisNameByKey
        );
    }

    const glyphs = document.glyphs.map((glyph) => {
        const drawings: Record<
            string,
            { glyph: FontraStaticGlyph; customData: Record<string, unknown> }
        > = {};
        const sources: Array<Record<string, unknown>> = [];

        for (const drawing of glyph.layers) {
            if (drawing.master.type !== 'DefaultForMaster') {
                continue;
            }
            const station = stations[drawing.master.masterIndex];
            if (!station) {
                continue;
            }
            drawings[station.id] = {
                glyph: serializeStaticGlyph({
                    width: drawing.width,
                    paths: drawing.paths,
                    components: drawing.components,
                    anchors: drawing.anchors,
                    guides: drawing.guides
                }),
                customData: {}
            };
            // Match native Fontra copy: locationBase + empty location.
            sources.push({
                name: '',
                locationBase: station.id,
                location: {},
                layerName: station.id,
                inactive: false,
                customData: {}
            });
        }

        return {
            codePoints: options?.glyphCodePoints?.[glyph.name] || [],
            variableGlyph: {
                name: glyph.name,
                axes: [],
                sources,
                layers: drawings,
                customData: {}
            }
        };
    });

    return {
        type: FONTRA_GLYPH_ARRAY,
        data: {
            glyphs,
            sourceLocations,
            backgroundImageData: {}
        }
    };
}

export function writeFontraClipboardToDataTransfer(
    clipboardData: DataTransfer,
    fontraJson: string
): void {
    for (const type of FONTRA_CLIPBOARD_MIME_TYPES) {
        try {
            clipboardData.setData(type, fontraJson);
        } catch {
            // Some browsers reject non-standard MIME types.
        }
    }
}

/** Blob map entry for Async ClipboardItem (`web fontra/json-clipboard`). */
export function fontraClipboardItemRepresentation(
    fontraJson: string
): Record<string, Blob> {
    return {
        [`web ${FONTRA_CLIPBOARD_MIME}`]: new Blob([fontraJson], {
            type: FONTRA_CLIPBOARD_MIME
        })
    };
}
