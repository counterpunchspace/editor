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
import { setYPath } from './change-bridge-ydoc';
import { toRestingLayerJson } from './resting-layer-json';
import { glyphDataIndex, type GlyphDataSearchResult } from './glyph-data';
import {
    labelsForGlyph,
    toGlyphQaMessages,
    type GlyphQaMessage
} from './auto-qa/auto-qa-matcher';
import {
    FIP001_BOOLEAN_KEY,
    FIP001_BOOLEAN_SUBTRACTION,
    GLYPHS_ATTR_KEY,
    glyphsAttrFromFormatSpecific,
    pathHasSubtractionFlag
} from './path-boolean-flag';

export {
    FIP001_BOOLEAN_KEY,
    FIP001_BOOLEAN_SUBTRACTION,
    GLYPHS_ATTR_KEY,
    pathHasSubtractionFlag
};
import { assertModelMutationAllowed } from './model-mutation-policy';
import type { FilesystemPlugin } from './filesystem-plugins/filesystem-plugin';
import { applyGlyphRenameUiContext } from './rename-glyphs-ui-context';
import { assertGlyphRenamePreflight } from './rename-glyphs-preflight';
import { applyGlyphDeleteUiContext } from './delete-glyphs-ui-context';
import { topologyEqualsForNodes } from './layer-geometry-ydoc';
import {
    countDeletedGlyphTokensInFeatureCode,
    collectFeatureLinesReferencingDeletedGlyphs,
    stripDeletedGlyphTokensFromClassCode,
    commentOutFeatureLinesReferencingDeletedGlyphs,
    buildAffectedKerningKeys,
    flattenKerningMap,
    forEachKerningPair,
    kerningPairIsAffected,
    filterKerningMap,
    type GlyphDeletePreflight
} from './delete-glyphs-preflight';
import {
    getKerningOperandKeys,
    resolveKerningValueForGlyphPair
} from './kerning-utils';
import { recordCompileBenchRecomposition } from './compile-bench-probe';

export type { GlyphDeletePreflight };

/**
 * Generate a stable unique identifier for CRDT addressing.
 * Uses crypto.randomUUID when available, falls back to a timestamp+random construction.
 */
export function generateStableId(): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ensure a node has an id, generating one if absent. Returns the id. */
function ensureNodeId(node: { id?: string }): string {
    if (!node.id) {
        node.id = generateStableId();
    }
    return node.id;
}

/**
 * Ensure every Node, Path, Component, Anchor, and Guide in the font has a stable `id`.
 * Called after font load / deserialization. Ids are generated for any element missing one;
 * existing ids are preserved. These ids support editor selection and the indexed-map
 * Y.Doc schema for shapes, anchors, and guides.
 *
 * Mutates the raw font data in place. Does NOT record change-log entries — this is
 * a load-time normalization, not an edit.
 */
export function ensureStableIds(
    fontData: Record<string, unknown> | null | undefined
): void {
    if (!fontData || typeof fontData !== 'object') return;

    const ensureId = (
        obj: Record<string, unknown> | undefined | null
    ): void => {
        if (!obj || typeof obj !== 'object') return;
        if (!obj.id || typeof obj.id !== 'string') {
            obj.id = generateStableId();
        }
    };

    // Glyphs → layers → shapes/anchors/guides → nodes
    const glyphs = fontData.glyphs;
    if (Array.isArray(glyphs)) {
        for (const glyph of glyphs) {
            if (!glyph || typeof glyph !== 'object') continue;
            const layers = (glyph as Record<string, unknown>).layers;
            if (!Array.isArray(layers)) continue;
            for (const layer of layers) {
                if (!layer || typeof layer !== 'object') continue;
                const layerObj = layer as Record<string, unknown>;

                // Shapes (paths and components)
                const shapes = layerObj.shapes;
                if (Array.isArray(shapes)) {
                    for (const shape of shapes) {
                        if (!shape || typeof shape !== 'object') continue;
                        const shapeObj = shape as Record<string, unknown>;
                        // Unwrap tagged-union wrapper if present ({ Path: {...} } / { Component: {...} })
                        const inner =
                            shapeObj.Path ?? shapeObj.Component ?? shapeObj;
                        ensureId(inner as Record<string, unknown> | undefined);
                        // Nodes (only on paths)
                        const nodes = (inner as Record<string, unknown>).nodes;
                        if (Array.isArray(nodes)) {
                            for (const node of nodes) {
                                ensureId(
                                    node as Record<string, unknown> | undefined
                                );
                            }
                        }
                    }
                }

                // Anchors
                const anchors = layerObj.anchors;
                if (Array.isArray(anchors)) {
                    for (const anchor of anchors) {
                        ensureId(anchor as Record<string, unknown> | undefined);
                    }
                }

                // Guides
                const guides = layerObj.guides;
                if (Array.isArray(guides)) {
                    for (const guide of guides) {
                        ensureId(guide as Record<string, unknown> | undefined);
                    }
                }
            }
        }
    }

    // Masters → guides
    const masters = fontData.masters;
    if (Array.isArray(masters)) {
        for (const master of masters) {
            if (!master || typeof master !== 'object') continue;
            const guides = (master as Record<string, unknown>).guides;
            if (Array.isArray(guides)) {
                for (const guide of guides) {
                    ensureId(guide as Record<string, unknown> | undefined);
                }
            }
        }
    }
}
import {
    affineToDecomposedAffine,
    calculateGlyphPathBounds,
    calculateGlyphShapeBounds,
    createIdentityDecomposedAffine,
    decomposedAffineToAffine
} from './glyph-path-geometry';
import { LayerDataNormalizer } from './layer-data-normalizer';
import { extendAxesForDesignspaceLocation } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import { Bezier } from 'bezier-js';
import { Logger } from './logger';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import type {
    PatchSyncEngine,
    TransactionBufferedOperation,
    TransactionHistoryTarget
} from './patch-sync-engine';
import {
    beginStartupInteractionLock,
    endStartupInteractionLock
} from './startup-interaction-lock';
import {
    getSidebearingTransactionLabel,
    type SidebearingSide
} from './sidebearing-utils';
import { translateLayerContentsX } from './x-translation-utils';

const console = new Logger('BabelfontModel');

type Unsafe = ReturnType<typeof JSON.parse>;
type PathData = {
    id?: string;
    nodes: Babelfont.Node[];
    closed: boolean;
    format_specific?: Record<string, Unsafe>;
};

type ComponentData = {
    id?: string;
    reference: string;
    transform: Babelfont.DecomposedAffine;
    location?: DesignspaceLocation;
    format_specific?: Record<string, Unsafe>;
};

type AnchorData = {
    id?: string;
    x: number;
    y: number;
    name?: string;
    format_specific?: Record<string, Unsafe>;
};

type GuideData = {
    id?: string;
    pos: Babelfont.Position;
    name?: string;
    color?: Babelfont.Color;
    format_specific?: Record<string, Unsafe>;
};

type MetricsKeyResolution = {
    input: string;
    value: number | null;
    error: string | null;
    referencedGlyphNames: string[];
    isLocal: boolean;
    updateScope?: 'layer' | 'font';
    affectedGlyphNames?: string[];
};

type ParsedMetricsKey =
    | {
          kind: 'constant';
          value: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'automatic-offset';
          delta: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'reference';
          glyphName: string | null;
          mirror: boolean;
          offsetY: number | null;
          operation: { operator: '+' | '-' | '*' | '/'; value: number } | null;
          referencedGlyphNames: string[];
      };

type MetricsKeyDependencyEntry = {
    layer: Layer;
    layerId: string;
    glyph: Glyph;
    glyphName: string;
    side: SidebearingSide;
    parsed: ParsedMetricsKey;
};

type MetricsKeyDependencyLookup = {
    keyedEntriesByGlyph: Map<string, MetricsKeyDependencyEntry[]>;
    referencedEntriesByGlyph: Map<string, MetricsKeyDependencyEntry[]>;
    automaticOffsetEntriesByGlyph: Map<string, MetricsKeyDependencyEntry[]>;
};

const GLYPHS_GLYPH_METRIC_LEFT_KEY = 'metric_left';
const GLYPHS_GLYPH_METRIC_RIGHT_KEY = 'metric_right';
const GLYPHS_LAYER_METRIC_LEFT_KEY = 'com.schriftgestalt.Glyphs.metricLeft';
const GLYPHS_LAYER_METRIC_RIGHT_KEY = 'com.schriftgestalt.Glyphs.metricRight';

function cloneInterpolationValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';
const GLYPHS_COMPONENT_ANCHOR_KEY = 'com.schriftgestalt.Glyphs.componentAnchor';

export type ShapeZOrderCommand = 'forward' | 'backward' | 'front' | 'back';

type FilteredBooleanFingerprintCacheEntry = {
    sourceKey: string;
    layers: Record<string, string>;
};

const filteredBooleanFingerprintCache = new Map<
    string,
    FilteredBooleanFingerprintCacheEntry
>();
const filteredBooleanFingerprintInflight = new Map<string, string>();

if (typeof window !== 'undefined') {
    window.addEventListener('fontLoaded', () => {
        filteredBooleanFingerprintCache.clear();
        filteredBooleanFingerprintInflight.clear();
    });
}

const CHAINED_BASE_ENTRY_ANCHOR = '#entry';
const CHAINED_BASE_EXIT_ANCHOR = '#exit';
const METRIC_UPDATE_EPSILON = 0.01;
let suppressModelRecordingDepth = 0;
let suppressMetricsKeyRecomputeDepth = 0;

type AutomaticCompositionAnchorPoint = {
    name: string;
    x: number;
    y: number;
};

type AutomaticCompositionSourceAnchor = {
    name: string;
    x: number;
    y: number;
};

type ComputedAnchorMap = Record<string, { x: number; y: number }>;

/**
 * Per-master vertical metrics. Access as attributes (`metrics.XHeight`).
 */
export type MasterMetrics = {
    XHeight?: number;
    CapHeight?: number;
    Ascender?: number;
    Descender?: number;
    ItalicAngle?: number;
    HheaAscender?: number;
    HheaDescender?: number;
    HheaLineGap?: number;
    WinAscent?: number;
    WinDescent?: number;
    TypoAscender?: number;
    TypoDescender?: number;
    TypoLineGap?: number;
    SubscriptXSize?: number;
    SubscriptYSize?: number;
    SubscriptXOffset?: number;
    SubscriptYOffset?: number;
    SuperscriptXSize?: number;
    SuperscriptYSize?: number;
    SuperscriptXOffset?: number;
    SuperscriptYOffset?: number;
    StrikeoutSize?: number;
    StrikeoutPosition?: number;
    UnderlinePosition?: number;
    UnderlineThickness?: number;
    HheaCaretSlopeRise?: number;
    HheaCaretSlopeRun?: number;
    HheaCaretOffset?: number;
} & Record<string, number | undefined>;

/** One axis condition on a Glyphs feature-variation family (`font.axes` order). */
export type FeatureVariationAxisRule = {
    min?: number;
    max?: number;
};

type AutomaticCompositionSourceData = {
    shapes: Unsafe[] | undefined;
    width: number;
    incomingAnchors: AutomaticCompositionSourceAnchor[];
    outgoingAnchors: AutomaticCompositionSourceAnchor[];
    chainedBaseEntryAnchor: AutomaticCompositionSourceAnchor | null;
};

type AutomaticCompositionPlacement = {
    translationX: number;
    translationY: number;
    attached: boolean;
    hasAttachment: boolean;
};

type AutomaticCompositionAttachment = {
    sourceAnchor: AutomaticCompositionSourceAnchor;
    targetAnchorName: string;
    targetAnchor: AutomaticCompositionAnchorPoint;
    kind: 'mark' | 'chained-base';
};

type AutomaticCompositionLayout = {
    placements: AutomaticCompositionPlacement[];
    baseBounds: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null;
    baseAdvanceWidth: number;
};

type AutomaticCompositionComponentInput = {
    reference: string | null;
    originalTransform: number[];
    overrideAnchorName?: string;
};

function parseAutomaticCompositionAffine(transformRaw: Unsafe): {
    affine: number[];
    usesArrayTransform: boolean;
} {
    const usesArrayTransform = Array.isArray(transformRaw);
    const affine = !transformRaw
        ? ([1, 0, 0, 1, 0, 0] as number[])
        : usesArrayTransform
          ? ([...transformRaw] as number[])
          : Array.from(DecomposedAffineTransform.toAffine(transformRaw));
    return { affine, usesArrayTransform };
}

function getAutomaticAnchorFamily(
    anchorName: string | undefined
): string | null {
    if (!anchorName) {
        return null;
    }

    const normalizedName = anchorName.startsWith('_')
        ? anchorName.slice(1)
        : anchorName;
    if (!normalizedName) {
        return null;
    }

    const separatorIndex = normalizedName.indexOf('_');
    return separatorIndex >= 0
        ? normalizedName.slice(0, separatorIndex)
        : normalizedName;
}

function isAutomaticAttachmentAnchor(anchorName: string | undefined): boolean {
    return Boolean(anchorName && anchorName.startsWith('_'));
}

/**
 * Unicode general categories allowed as a standalone automatic composite
 * (exactly one component, no attachment). Marks (`M*`) are excluded;
 * everything else with a known category is eligible.
 */
function isAutomaticStandaloneComponentCategory(
    generalCategory: string | undefined
): boolean {
    return (
        typeof generalCategory === 'string' &&
        generalCategory.length > 0 &&
        !generalCategory.startsWith('M')
    );
}

function isChainedBaseEntryAnchor(anchorName: string | undefined): boolean {
    return anchorName === CHAINED_BASE_ENTRY_ANCHOR;
}

function isChainedBaseExitAnchor(anchorName: string | undefined): boolean {
    return anchorName === CHAINED_BASE_EXIT_ANCHOR;
}

function transformPointWithAffine(
    transform: number[],
    x: number,
    y: number
): { x: number; y: number } {
    const [a, b, c, d, tx, ty] = transform;
    return {
        x: a * x + c * y + tx,
        y: b * x + d * y + ty
    };
}

function getAutomaticAdvanceDeltaX(transform: number[], width: number): number {
    const start = transformPointWithAffine(transform, 0, 0);
    const end = transformPointWithAffine(transform, width, 0);
    return Math.abs(end.x - start.x);
}

function getAutomaticComponentTransform(
    component: Component
): Babelfont.DecomposedAffine {
    return component.transform || createIdentityDecomposedAffine();
}

function hasExplicitManualComponentAlignment(component: Component): boolean {
    const value =
        getModelFormatSpecific(component)?.[GLYPHS_COMPONENT_ALIGNMENT_KEY];
    return value === -1;
}

function hasExplicitAutomaticComponentAlignment(component: Component): boolean {
    const value =
        getModelFormatSpecific(component)?.[GLYPHS_COMPONENT_ALIGNMENT_KEY];
    return value === 1;
}

type AutomaticKerningGroupPairSide = 'first' | 'second';

function glyphSideToKerningGroupPairSide(
    side: 'left' | 'right'
): AutomaticKerningGroupPairSide {
    // Left side of a glyph is the second of a kerning pair (MMK_L).
    // Right side of a glyph is the first of a kerning pair (MMK_R).
    return side === 'left' ? 'second' : 'first';
}

function getKerningGroupsForPairSide(
    font: Font,
    pairSide: AutomaticKerningGroupPairSide
): Record<string, string[]> | undefined {
    return pairSide === 'first'
        ? font.first_kern_groups
        : font.second_kern_groups;
}

function setKerningGroupsForPairSide(
    font: Font,
    pairSide: AutomaticKerningGroupPairSide,
    groups: Record<string, string[]>
): void {
    if (pairSide === 'first') {
        font.first_kern_groups = groups;
    } else {
        font.second_kern_groups = groups;
    }
}

function cloneKerningGroups(
    groups: Record<string, string[]> | undefined
): Record<string, string[]> {
    const next: Record<string, string[]> = {};
    for (const [groupName, members] of Object.entries(groups || {})) {
        if (Array.isArray(members)) {
            next[groupName] = [...members];
        }
    }
    return next;
}

function findKerningGroupNameForGlyph(
    groups: Record<string, string[]> | undefined,
    glyphName: string
): string | null {
    if (!groups) {
        return null;
    }

    const memberships: string[] = [];
    for (const [groupName, members] of Object.entries(groups)) {
        if (Array.isArray(members) && members.includes(glyphName)) {
            memberships.push(groupName);
        }
    }
    memberships.sort((left, right) => left.localeCompare(right));
    return memberships[0] ?? null;
}

function withGlyphInKerningGroup(
    groups: Record<string, string[]>,
    glyphName: string,
    groupName: string
): Record<string, string[]> {
    const next: Record<string, string[]> = {};
    for (const [name, members] of Object.entries(groups)) {
        if (!Array.isArray(members)) {
            continue;
        }
        const filtered = members.filter((member) => member !== glyphName);
        if (filtered.length > 0) {
            next[name] = filtered;
        }
    }

    const members = [...(next[groupName] || [])];
    if (!members.includes(glyphName)) {
        members.push(glyphName);
        members.sort((left, right) => left.localeCompare(right));
    }
    next[groupName] = members;
    return next;
}

function kerningGroupsEqual(
    left: Record<string, string[]> | undefined,
    right: Record<string, string[]> | undefined
): boolean {
    const leftGroups = left || {};
    const rightGroups = right || {};
    const leftNames = Object.keys(leftGroups).sort();
    const rightNames = Object.keys(rightGroups).sort();
    if (leftNames.length !== rightNames.length) {
        return false;
    }

    for (let index = 0; index < leftNames.length; index++) {
        if (leftNames[index] !== rightNames[index]) {
            return false;
        }
        const groupName = leftNames[index];
        const leftMembers = [...(leftGroups[groupName] || [])]
            .sort()
            .join('\0');
        const rightMembers = [...(rightGroups[groupName] || [])]
            .sort()
            .join('\0');
        if (leftMembers !== rightMembers) {
            return false;
        }
    }

    return true;
}

function assignAutomaticCompositeKerningGroupsForSide(
    font: Font,
    pairSide: AutomaticKerningGroupPairSide,
    terminalGlyphName: string,
    compositeGlyphName: string
): boolean {
    const currentGroups = getKerningGroupsForPairSide(font, pairSide);
    let nextGroups = cloneKerningGroups(currentGroups);
    let groupName = findKerningGroupNameForGlyph(nextGroups, terminalGlyphName);
    if (!groupName) {
        groupName = terminalGlyphName;
        nextGroups = withGlyphInKerningGroup(
            nextGroups,
            terminalGlyphName,
            groupName
        );
    }
    if (compositeGlyphName !== terminalGlyphName) {
        nextGroups = withGlyphInKerningGroup(
            nextGroups,
            compositeGlyphName,
            groupName
        );
    }

    if (kerningGroupsEqual(currentGroups, nextGroups)) {
        return false;
    }

    setKerningGroupsForPairSide(font, pairSide, nextGroups);
    return true;
}

function isAutomaticSidebearingOverrideKey(value: string | undefined): boolean {
    const normalizedValue = normalizeMetricsKeyValue(value);
    return Boolean(normalizedValue && /^==?[+-]/.test(normalizedValue));
}

type SegmentPoint = {
    x: number;
    y: number;
};

type PathSegmentDescriptor = {
    segmentId: number;
    type: 'line' | 'quadratic' | 'cubic';
    points: SegmentPoint[];
    startNodeIndex: number;
    endNodeIndex: number;
    controlNodeIndices: number[];
    runStartNodeIndex: number;
    runEndNodeIndex: number;
    runControlNodeIndices: number[];
    segmentIndexInRun: number;
    wrapsAround: boolean;
};

export function withSuppressedModelRecording<T>(fn: () => T): T {
    suppressModelRecordingDepth++;
    try {
        return fn();
    } finally {
        suppressModelRecordingDepth--;
    }
}

export function withSuppressedMetricsKeyRecompute<T>(fn: () => T): T {
    suppressMetricsKeyRecomputeDepth++;
    try {
        return fn();
    } finally {
        suppressMetricsKeyRecomputeDepth--;
    }
}

export type InterpolationRustLayerTarget = {
    glyphName: string;
    layerId: string;
};

export type InterpolationRustBatchMetadata = {
    changedGlyphs: string[];
    layerTargets: InterpolationRustLayerTarget[];
    layerOperations: Array<{
        glyphName: string;
        layerId: string;
        oldValue?: unknown;
        newValue?: unknown;
    }>;
    mastersOperation?: {
        oldValue?: unknown;
        newValue: unknown;
    } | null;
    axesOperation?: {
        oldValue?: unknown;
        newValue: unknown;
    } | null;
};

type AddMasterInterpolationLocation = {
    glyphName: string;
    designLocation: DesignspaceLocation;
};

type AddMasterOptions = {
    location?: DesignspaceLocation;
    metricTemplateMasterId?: string;
};

function getCurrentWindowFontModel(): Font | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const currentFontModel = (window as Unsafe).currentFontModel;
    return currentFontModel instanceof Font ? currentFontModel : null;
}

function clampUnitInterval(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function cloneSegmentPoint(point: SegmentPoint): SegmentPoint {
    return { x: point.x, y: point.y };
}

function cloneNodeData<T extends Babelfont.Node>(
    node: T,
    overrides: Partial<T> = {}
): T {
    return {
        ...node,
        ...overrides
    };
}

function flattenedPathToStoredShape(path: Babelfont.Path): Babelfont.Path {
    const nodes = (path.nodes || []).map((node: Unsafe) => {
        const nodetype = (node.nodetype ||
            node.type ||
            'Line') as Babelfont.NodeType;
        const stored: Babelfont.Node = {
            id: generateStableId(),
            x: Number(node.x),
            y: Number(node.y),
            nodetype
        };
        if (node.smooth !== undefined) {
            stored.smooth = !!node.smooth;
        }
        return stored;
    });
    return {
        id: generateStableId(),
        nodes,
        closed: path.closed !== false
    };
}

function midpoint(left: SegmentPoint, right: SegmentPoint): SegmentPoint {
    return {
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2
    };
}

function lerpPoint(
    start: SegmentPoint,
    end: SegmentPoint,
    t: number
): SegmentPoint {
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };
}

function subtractPoints(left: SegmentPoint, right: SegmentPoint): SegmentPoint {
    return {
        x: left.x - right.x,
        y: left.y - right.y
    };
}

function scalePoint(point: SegmentPoint, scalar: number): SegmentPoint {
    return {
        x: point.x * scalar,
        y: point.y * scalar
    };
}

function addPoints(left: SegmentPoint, right: SegmentPoint): SegmentPoint {
    return {
        x: left.x + right.x,
        y: left.y + right.y
    };
}

function pointLengthSquared(point: SegmentPoint): number {
    return point.x * point.x + point.y * point.y;
}

function dotPoints(left: SegmentPoint, right: SegmentPoint): number {
    return left.x * right.x + left.y * right.y;
}

function crossPoints(left: SegmentPoint, right: SegmentPoint): number {
    return left.x * right.y - left.y * right.x;
}

function pointDistanceSquared(left: SegmentPoint, right: SegmentPoint): number {
    return pointLengthSquared(subtractPoints(left, right));
}

function normalizePoint(
    point: SegmentPoint,
    fallback: SegmentPoint
): SegmentPoint {
    const pointLength = Math.hypot(point.x, point.y);
    if (pointLength > 0.000001) {
        return {
            x: point.x / pointLength,
            y: point.y / pointLength
        };
    }

    const fallbackLength = Math.hypot(fallback.x, fallback.y);
    if (fallbackLength > 0.000001) {
        return {
            x: fallback.x / fallbackLength,
            y: fallback.y / fallbackLength
        };
    }

    return { x: 1, y: 0 };
}

function getNodePoint(node: Unsafe): SegmentPoint {
    return { x: node.x, y: node.y };
}

function splitSegmentPoints(
    points: SegmentPoint[],
    t: number
): [SegmentPoint[], SegmentPoint[]] {
    const normalizedT = clampUnitInterval(t);

    if (points.length === 2) {
        const splitPoint = lerpPoint(points[0], points[1], normalizedT);
        return [
            [cloneSegmentPoint(points[0]), splitPoint],
            [splitPoint, cloneSegmentPoint(points[1])]
        ];
    }

    const split = new Bezier(points).split(normalizedT);
    return [
        split.left.points.map(({ x, y }: SegmentPoint) => ({ x, y })),
        split.right.points.map(({ x, y }: SegmentPoint) => ({ x, y }))
    ];
}

function buildPathSegmentDescriptors(pathData: {
    nodes: Unsafe[];
    closed?: boolean;
}): PathSegmentDescriptor[] {
    const segments: PathSegmentDescriptor[] = [];

    if (!pathData.nodes || pathData.nodes.length < 2) {
        return segments;
    }

    const nodes = pathData.nodes;
    const closed = pathData.closed !== false;

    const getNodeType = (node: Unsafe): string => {
        return (node.type || node.nodetype || '').toString().toLowerCase();
    };

    const isOffCurve = (node: Unsafe): boolean => {
        const type = getNodeType(node);
        return type === 'o' || type === 'offcurve';
    };

    const isOnCurve = (node: Unsafe): boolean => !isOffCurve(node);

    let startIdx = 0;
    if (closed) {
        for (let i = 0; i < nodes.length; i++) {
            if (isOnCurve(nodes[i])) {
                startIdx = i;
                break;
            }
        }
    }

    let i = startIdx;
    let processedCount = 0;
    const maxNodes = closed ? nodes.length : nodes.length - 1;
    let segmentId = 0;

    while (processedCount < maxNodes) {
        const currentIdx = i % nodes.length;
        const current = nodes[currentIdx];

        if (!isOnCurve(current)) {
            i++;
            processedCount++;
            continue;
        }

        const offcurveNodeIndices: number[] = [];
        let j = currentIdx + 1;
        let offcurveCount = 0;
        let endNodeIndex: number | null = null;

        while (offcurveCount < nodes.length) {
            if (j >= nodes.length && !closed) {
                break;
            }

            const candidateIndex =
                ((j % nodes.length) + nodes.length) % nodes.length;
            const candidate = nodes[candidateIndex];

            if (isOffCurve(candidate)) {
                offcurveNodeIndices.push(candidateIndex);
                j++;
                offcurveCount++;
                continue;
            }

            endNodeIndex = candidateIndex;
            break;
        }

        if (endNodeIndex === null) {
            break;
        }

        const startPoint = getNodePoint(current);
        const endPoint = getNodePoint(nodes[endNodeIndex]);
        const controlPoints = offcurveNodeIndices.map((index) =>
            getNodePoint(nodes[index])
        );
        const endType = getNodeType(nodes[endNodeIndex]);
        const wrapsAround = closed && endNodeIndex <= currentIdx;

        if (controlPoints.length === 0) {
            segments.push({
                segmentId: segmentId++,
                type: 'line',
                points: [startPoint, endPoint],
                startNodeIndex: currentIdx,
                endNodeIndex,
                controlNodeIndices: [],
                runStartNodeIndex: currentIdx,
                runEndNodeIndex: endNodeIndex,
                runControlNodeIndices: [],
                segmentIndexInRun: 0,
                wrapsAround
            });
        } else if (endType === 'curve' && controlPoints.length === 2) {
            segments.push({
                segmentId: segmentId++,
                type: 'cubic',
                points: [startPoint, ...controlPoints, endPoint],
                startNodeIndex: currentIdx,
                endNodeIndex,
                controlNodeIndices: [...offcurveNodeIndices],
                runStartNodeIndex: currentIdx,
                runEndNodeIndex: endNodeIndex,
                runControlNodeIndices: [...offcurveNodeIndices],
                segmentIndexInRun: 0,
                wrapsAround
            });
        } else {
            let segmentStartPoint = startPoint;
            const runEndPoints = controlPoints.map((controlPoint, index) =>
                index === controlPoints.length - 1
                    ? endPoint
                    : midpoint(controlPoint, controlPoints[index + 1])
            );

            for (
                let controlIndex = 0;
                controlIndex < controlPoints.length;
                controlIndex++
            ) {
                const segmentEndPoint = runEndPoints[controlIndex];
                segments.push({
                    segmentId: segmentId++,
                    type: 'quadratic',
                    points: [
                        cloneSegmentPoint(segmentStartPoint),
                        cloneSegmentPoint(controlPoints[controlIndex]),
                        cloneSegmentPoint(segmentEndPoint)
                    ],
                    startNodeIndex: currentIdx,
                    endNodeIndex,
                    controlNodeIndices: [offcurveNodeIndices[controlIndex]],
                    runStartNodeIndex: currentIdx,
                    runEndNodeIndex: endNodeIndex,
                    runControlNodeIndices: [...offcurveNodeIndices],
                    segmentIndexInRun: controlIndex,
                    wrapsAround
                });
                segmentStartPoint = segmentEndPoint;
            }
        }

        i += 1 + offcurveCount;
        processedCount += 1 + offcurveCount;

        if (processedCount > nodes.length * 2) {
            break;
        }
    }

    return segments;
}

function replaceSegmentRunInNodeArray(
    nodes: Babelfont.Node[],
    descriptor: PathSegmentDescriptor,
    replacementNodes: Babelfont.Node[],
    insertedNodeOffset: number,
    closed: boolean
): { nodes: Babelfont.Node[]; insertedNodeIndex: number } {
    const clonedNodes = nodes.map((node) => cloneNodeData(node));

    if (closed && descriptor.wrapsAround) {
        const rotatedNodes = [
            ...clonedNodes.slice(descriptor.runStartNodeIndex),
            ...clonedNodes.slice(0, descriptor.runStartNodeIndex)
        ];
        const rotatedRunEndIndex =
            clonedNodes.length -
            descriptor.runStartNodeIndex +
            descriptor.runEndNodeIndex;
        const nextNodes = [
            rotatedNodes[0],
            ...replacementNodes,
            ...rotatedNodes.slice(rotatedRunEndIndex + 1)
        ];
        const restoredStartIndex = replacementNodes.length;
        const restoredNodes = [
            ...nextNodes.slice(restoredStartIndex),
            ...nextNodes.slice(0, restoredStartIndex)
        ];
        const insertedNodeIndex =
            (((1 + insertedNodeOffset - restoredStartIndex) %
                restoredNodes.length) +
                restoredNodes.length) %
            restoredNodes.length;

        return {
            nodes: normalizePathNodeArray(restoredNodes, true),
            insertedNodeIndex
        };
    }

    const nextNodes = [
        ...clonedNodes.slice(0, descriptor.runStartNodeIndex + 1),
        ...replacementNodes,
        ...clonedNodes.slice(descriptor.runEndNodeIndex + 1)
    ];

    return {
        nodes: closed ? normalizePathNodeArray(nextNodes, true) : nextNodes,
        insertedNodeIndex: descriptor.runStartNodeIndex + 1 + insertedNodeOffset
    };
}

function buildInsertedSegmentNodeArray(
    nodes: Babelfont.Node[],
    descriptor: PathSegmentDescriptor,
    t: number,
    closed: boolean
): { nodes: Babelfont.Node[]; insertedNodeIndex: number } {
    const normalizedT = clampUnitInterval(t);

    if (descriptor.type === 'line') {
        const splitPoint = lerpPoint(
            descriptor.points[0],
            descriptor.points[1],
            normalizedT
        );
        const replacementNodes = [
            {
                x: splitPoint.x,
                y: splitPoint.y,
                nodetype: 'Line' as Babelfont.NodeType
            },
            cloneNodeData(nodes[descriptor.runEndNodeIndex])
        ];

        return replaceSegmentRunInNodeArray(
            nodes,
            descriptor,
            replacementNodes,
            0,
            closed
        );
    }

    if (descriptor.type === 'cubic') {
        const [leftPoints, rightPoints] = splitSegmentPoints(
            descriptor.points,
            normalizedT
        );
        const replacementNodes = [
            {
                x: leftPoints[1].x,
                y: leftPoints[1].y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            {
                x: leftPoints[2].x,
                y: leftPoints[2].y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            {
                x: leftPoints[3].x,
                y: leftPoints[3].y,
                nodetype: 'Curve' as Babelfont.NodeType,
                smooth: true
            },
            {
                x: rightPoints[1].x,
                y: rightPoints[1].y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            {
                x: rightPoints[2].x,
                y: rightPoints[2].y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            cloneNodeData(nodes[descriptor.runEndNodeIndex], {
                x: rightPoints[3].x,
                y: rightPoints[3].y,
                nodetype: 'Curve' as Babelfont.NodeType
            })
        ];

        return replaceSegmentRunInNodeArray(
            nodes,
            descriptor,
            replacementNodes,
            2,
            closed
        );
    }

    const runControlPoints = descriptor.runControlNodeIndices.map((index) =>
        getNodePoint(nodes[index])
    );
    const explicitRunEndPoints = runControlPoints.map((controlPoint, index) =>
        index === runControlPoints.length - 1
            ? getNodePoint(nodes[descriptor.runEndNodeIndex])
            : midpoint(controlPoint, runControlPoints[index + 1])
    );

    const explicitRunNodes: Babelfont.Node[] = [];
    for (let index = 0; index < runControlPoints.length; index++) {
        explicitRunNodes.push({
            x: runControlPoints[index].x,
            y: runControlPoints[index].y,
            nodetype: 'OffCurve' as Babelfont.NodeType
        });
        explicitRunNodes.push(
            index === runControlPoints.length - 1
                ? cloneNodeData(nodes[descriptor.runEndNodeIndex], {
                      x: explicitRunEndPoints[index].x,
                      y: explicitRunEndPoints[index].y,
                      nodetype: 'QCurve' as Babelfont.NodeType
                  })
                : {
                      x: explicitRunEndPoints[index].x,
                      y: explicitRunEndPoints[index].y,
                      nodetype: 'QCurve' as Babelfont.NodeType,
                      smooth: true
                  }
        );
    }

    const targetPairIndex = descriptor.segmentIndexInRun * 2;
    const [leftPoints, rightPoints] = splitSegmentPoints(
        descriptor.points,
        normalizedT
    );
    const explicitEndNode = explicitRunNodes[targetPairIndex + 1];

    explicitRunNodes.splice(
        targetPairIndex,
        2,
        {
            x: leftPoints[1].x,
            y: leftPoints[1].y,
            nodetype: 'OffCurve' as Babelfont.NodeType
        },
        {
            x: leftPoints[2].x,
            y: leftPoints[2].y,
            nodetype: 'QCurve' as Babelfont.NodeType,
            smooth: true
        },
        {
            x: rightPoints[1].x,
            y: rightPoints[1].y,
            nodetype: 'OffCurve' as Babelfont.NodeType
        },
        cloneNodeData(explicitEndNode, {
            x: rightPoints[2].x,
            y: rightPoints[2].y,
            nodetype: 'QCurve' as Babelfont.NodeType
        })
    );

    return replaceSegmentRunInNodeArray(
        nodes,
        descriptor,
        explicitRunNodes,
        targetPairIndex + 1,
        closed
    );
}

function buildLineCollapsedSegmentNodeArray(
    nodes: Babelfont.Node[],
    descriptor: PathSegmentDescriptor,
    closed: boolean
): Babelfont.Node[] {
    const clonedNodes = nodes.map((node) => cloneNodeData(node));

    if (descriptor.type === 'cubic') {
        return replaceSegmentRunInNodeArray(
            clonedNodes,
            descriptor,
            [
                cloneNodeData(clonedNodes[descriptor.runEndNodeIndex], {
                    x: descriptor.points[3].x,
                    y: descriptor.points[3].y,
                    nodetype: 'Line' as Babelfont.NodeType,
                    smooth: false
                })
            ],
            0,
            closed
        ).nodes;
    }

    const runControlPoints = descriptor.runControlNodeIndices.map((index) =>
        getNodePoint(clonedNodes[index])
    );
    const explicitRunEndPoints = runControlPoints.map((controlPoint, index) =>
        index === runControlPoints.length - 1
            ? getNodePoint(clonedNodes[descriptor.runEndNodeIndex])
            : midpoint(controlPoint, runControlPoints[index + 1])
    );

    const explicitRunNodes: Babelfont.Node[] = [];
    for (let index = 0; index < runControlPoints.length; index++) {
        explicitRunNodes.push({
            x: runControlPoints[index].x,
            y: runControlPoints[index].y,
            nodetype: 'OffCurve' as Babelfont.NodeType
        });
        explicitRunNodes.push(
            index === runControlPoints.length - 1
                ? cloneNodeData(clonedNodes[descriptor.runEndNodeIndex], {
                      x: explicitRunEndPoints[index].x,
                      y: explicitRunEndPoints[index].y,
                      nodetype: 'QCurve' as Babelfont.NodeType
                  })
                : {
                      x: explicitRunEndPoints[index].x,
                      y: explicitRunEndPoints[index].y,
                      nodetype: 'QCurve' as Babelfont.NodeType,
                      smooth: true
                  }
        );
    }

    const targetPairIndex = descriptor.segmentIndexInRun * 2;
    const segmentEndNode = explicitRunNodes[targetPairIndex + 1];

    explicitRunNodes.splice(
        targetPairIndex,
        2,
        cloneNodeData(segmentEndNode, {
            x: descriptor.points[2].x,
            y: descriptor.points[2].y,
            nodetype: 'Line' as Babelfont.NodeType,
            smooth: false
        })
    );

    return replaceSegmentRunInNodeArray(
        clonedNodes,
        descriptor,
        explicitRunNodes,
        0,
        closed
    ).nodes;
}

function buildLineCurvedSegmentNodeArray(
    nodes: Babelfont.Node[],
    descriptor: PathSegmentDescriptor,
    closed: boolean
): Babelfont.Node[] | null {
    if (descriptor.type !== 'line') {
        return null;
    }

    const clonedNodes = nodes.map((node) => cloneNodeData(node));
    clonedNodes[descriptor.runStartNodeIndex] = cloneNodeData(
        clonedNodes[descriptor.runStartNodeIndex],
        {
            smooth: false
        }
    );

    const firstHandle = lerpPoint(
        descriptor.points[0],
        descriptor.points[1],
        1 / 3
    );
    const secondHandle = lerpPoint(
        descriptor.points[0],
        descriptor.points[1],
        2 / 3
    );

    return replaceSegmentRunInNodeArray(
        clonedNodes,
        descriptor,
        [
            {
                x: firstHandle.x,
                y: firstHandle.y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            {
                x: secondHandle.x,
                y: secondHandle.y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            },
            cloneNodeData(clonedNodes[descriptor.runEndNodeIndex], {
                x: descriptor.points[1].x,
                y: descriptor.points[1].y,
                nodetype: 'Curve' as Babelfont.NodeType,
                smooth: false
            })
        ],
        2,
        closed
    ).nodes;
}

function intersectLines(
    originA: SegmentPoint,
    targetA: SegmentPoint,
    originB: SegmentPoint,
    targetB: SegmentPoint
): SegmentPoint | null {
    const directionA = subtractPoints(targetA, originA);
    const directionB = subtractPoints(targetB, originB);
    const denominator = crossPoints(directionA, directionB);

    if (Math.abs(denominator) < 0.000001) {
        return null;
    }

    const delta = subtractPoints(originB, originA);
    const ratio = crossPoints(delta, directionB) / denominator;

    return addPoints(originA, scalePoint(directionA, ratio));
}

function computeCollinearRatio(
    start: SegmentPoint,
    end: SegmentPoint,
    point: SegmentPoint
): number | null {
    const direction = subtractPoints(end, start);
    const lengthSquared = pointLengthSquared(direction);
    if (lengthSquared < 0.000001) {
        return null;
    }

    return dotPoints(subtractPoints(point, start), direction) / lengthSquared;
}

function pointsAreClose(
    left: SegmentPoint,
    right: SegmentPoint,
    epsilon = 0.0001
): boolean {
    return pointDistanceSquared(left, right) <= epsilon * epsilon;
}

function curveHasInteriorInflection(points: SegmentPoint[]): boolean {
    const inflections = new Bezier(points).inflections();
    return inflections.some((t) => t > 0.000001 && t < 0.999999);
}

function sanitizeMergedCubicWithFixedDirections(
    start: SegmentPoint,
    end: SegmentPoint,
    startDirection: SegmentPoint,
    endDirection: SegmentPoint,
    startHandleLength: number,
    endHandleLength: number
): SegmentPoint[] {
    const minimumHandleLength = 0.0001;
    const baseStartHandleLength = Math.max(
        startHandleLength,
        minimumHandleLength
    );
    const baseEndHandleLength = Math.max(endHandleLength, minimumHandleLength);
    const scales = [1, 0.9, 0.75, 0.6, 0.45, 0.3, 0.2, 0.1, 0.05, 0.01];
    let bestCandidate: SegmentPoint[] | null = null;
    let bestScore = -Infinity;

    for (const startScale of scales) {
        for (const endScale of scales) {
            const nextStartHandleLength = Math.max(
                baseStartHandleLength * startScale,
                minimumHandleLength
            );
            const nextEndHandleLength = Math.max(
                baseEndHandleLength * endScale,
                minimumHandleLength
            );
            const candidate = [
                start,
                addPoints(
                    start,
                    scalePoint(startDirection, nextStartHandleLength)
                ),
                addPoints(end, scalePoint(endDirection, nextEndHandleLength)),
                end
            ];

            const startHandle = candidate[1];
            const endHandle = candidate[2];
            const hasBadEndpointCollision =
                pointsAreClose(startHandle, end) ||
                pointsAreClose(endHandle, start);

            if (
                !hasBadEndpointCollision &&
                !curveHasInteriorInflection(candidate)
            ) {
                const score = nextStartHandleLength + nextEndHandleLength;
                if (score > bestScore) {
                    bestCandidate = candidate;
                    bestScore = score;
                }
            }
        }
    }

    if (bestCandidate) {
        return bestCandidate;
    }

    return [
        start,
        addPoints(start, scalePoint(startDirection, minimumHandleLength)),
        addPoints(end, scalePoint(endDirection, minimumHandleLength)),
        end
    ];
}

function tryInvertCubicSplit(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): { points: SegmentPoint[]; t: number } | null {
    const start = leftPoints[0];
    const leftHandle = leftPoints[1];
    const leftBridge = leftPoints[2];
    const rightBridge = rightPoints[1];
    const rightHandle = rightPoints[2];
    const end = rightPoints[3];

    const midpointHandle = intersectLines(
        leftHandle,
        leftBridge,
        rightHandle,
        rightBridge
    );
    if (!midpointHandle) {
        return null;
    }

    const tCandidates = [
        computeCollinearRatio(leftHandle, midpointHandle, leftBridge),
        computeCollinearRatio(midpointHandle, rightHandle, rightBridge)
    ].filter(
        (value): value is number => value !== null && Number.isFinite(value)
    );

    if (!tCandidates.length) {
        return null;
    }

    const t = clampUnitInterval(
        tCandidates.reduce((sum, value) => sum + value, 0) / tCandidates.length
    );
    if (t <= 0.000001 || t >= 0.999999) {
        return null;
    }

    const originalControl1 = addPoints(
        start,
        scalePoint(subtractPoints(leftHandle, start), 1 / t)
    );
    const originalControl2 = addPoints(
        end,
        scalePoint(subtractPoints(rightHandle, end), 1 / (1 - t))
    );
    const mergedPoints = [start, originalControl1, originalControl2, end];
    const [reconstructedLeft, reconstructedRight] = splitSegmentPoints(
        mergedPoints,
        t
    );

    const reconstructionMatches =
        reconstructedLeft.length === leftPoints.length &&
        reconstructedRight.length === rightPoints.length &&
        reconstructedLeft.every((point, index) =>
            pointsAreClose(point, leftPoints[index], 0.05)
        ) &&
        reconstructedRight.every((point, index) =>
            pointsAreClose(point, rightPoints[index], 0.05)
        );

    if (!reconstructionMatches) {
        return null;
    }

    return { points: mergedPoints, t };
}

function evaluateCubicBezier(points: SegmentPoint[], t: number): SegmentPoint {
    const [p0, p1, p2, p3] = points;
    const u = 1 - t;
    const u2 = u * u;
    const u3 = u2 * u;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
        x: u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
        y: u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y
    };
}

/** Default join tolerance matching babelfont Path.delete_keeping_shape. */
const DELETE_KEEPING_SHAPE_TOLERANCE = 1000;

const JOIN_BEZ_GAUSS_4: Array<[number, number]> = [
    [0.6521451548625461, -0.3399810435848563],
    [0.6521451548625461, 0.3399810435848563],
    [0.34785484513745385, -0.8611363115940526],
    [0.34785484513745385, 0.8611363115940526]
];

function joinBezBernstein(t: number): [number, number, number, number] {
    const mt = 1 - t;
    return [mt * mt * mt, 3 * t * mt * mt, 3 * t * t * mt, t * t * t];
}

const JOIN_BEZ_M = (() => {
    let m11 = 0;
    let m22 = 0;
    let m12 = 0;
    for (const [weight, x] of JOIN_BEZ_GAUSS_4) {
        const t = 0.5 * (x + 1);
        const w = 0.5 * weight;
        const b = joinBezBernstein(t);
        m11 += w * b[1] * b[1];
        m22 += w * b[2] * b[2];
        m12 += w * b[1] * b[2];
    }
    return { m11, m22, m12 };
})();

function cubicArclen(points: SegmentPoint[]): number {
    let length = 0;
    let previous = evaluateCubicBezier(points, 0);
    for (let index = 1; index <= 16; index++) {
        const point = evaluateCubicBezier(points, index / 16);
        length += Math.hypot(point.x - previous.x, point.y - previous.y);
        previous = point;
    }
    return length;
}

function evalJoinedCubics(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[],
    r: number,
    t: number
): SegmentPoint {
    if (t < r) {
        return evaluateCubicBezier(leftPoints, t / r);
    }
    return evaluateCubicBezier(rightPoints, (t - r) / (1 - r));
}

function recommendedJoinTolerance(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): number {
    const lenA = Math.max(1e-6, cubicArclen(leftPoints));
    const lenB = Math.max(1e-6, cubicArclen(rightPoints));
    const total = lenA + lenB;
    const uneven = Math.abs(lenA / total - 0.5);
    let tolerance = Math.max(64, 0.2 * total);
    if (uneven > 0.12) {
        tolerance = Math.max(tolerance, 128);
    }
    if (uneven > 0.25) {
        tolerance = Math.max(tolerance, 256);
    }
    return Math.min(tolerance, 4000);
}

function joinBezFit(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): SegmentPoint[] {
    const start = leftPoints[0];
    const end = rightPoints[3];
    const d1 = subtractPoints(leftPoints[1], start);
    const d2 = subtractPoints(end, rightPoints[2]);
    const lenA = cubicArclen(leftPoints);
    const lenB = cubicArclen(rightPoints);
    const r = Math.min(1 - 1e-3, Math.max(1e-3, lenA / (lenA + lenB)));
    let r1x = 0;
    let r1y = 0;
    let r2x = 0;
    let r2y = 0;

    for (const [weight, x] of JOIN_BEZ_GAUSS_4) {
        const t = 0.5 * (x + 1);
        const w = 0.5 * weight;
        const bt = joinBezBernstein(t);
        const sample = evalJoinedCubics(leftPoints, rightPoints, r, t);
        const fixedX = (bt[0] + bt[1]) * start.x + (bt[2] + bt[3]) * end.x;
        const fixedY = (bt[0] + bt[1]) * start.y + (bt[2] + bt[3]) * end.y;
        const residX = sample.x - fixedX;
        const residY = sample.y - fixedY;
        r1x += w * bt[1] * residX;
        r1y += w * bt[1] * residY;
        r2x += w * bt[2] * residX;
        r2y += w * bt[2] * residY;
    }

    const mat11 = (d1.x * d1.x + d1.y * d1.y) * JOIN_BEZ_M.m11;
    const mat22 = (d2.x * d2.x + d2.y * d2.y) * JOIN_BEZ_M.m22;
    const mat12 = -(d1.x * d2.x + d1.y * d2.y) * JOIN_BEZ_M.m12;
    const rhs1 = d1.x * r1x + d1.y * r1y;
    const rhs2 = -(d2.x * r2x + d2.y * r2y);
    const det = mat11 * mat22 - mat12 * mat12;
    let t1 = 0;
    let t2 = 0;
    if (Math.abs(det) > 1e-12) {
        t1 = (rhs1 * mat22 - mat12 * rhs2) / det;
        t2 = (mat11 * rhs2 - mat12 * rhs1) / det;
    }

    return [
        start,
        { x: start.x + t1 * d1.x, y: start.y + t1 * d1.y },
        { x: end.x - t2 * d2.x, y: end.y - t2 * d2.y },
        end
    ];
}

function joinBezMaxError(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[],
    fitted: SegmentPoint[]
): number {
    const lenA = cubicArclen(leftPoints);
    const lenB = cubicArclen(rightPoints);
    const r = Math.min(1 - 1e-3, Math.max(1e-3, lenA / (lenA + lenB)));
    let maxErr = 0;
    for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const sample = evalJoinedCubics(leftPoints, rightPoints, r, t);
        const fittedPoint = evaluateCubicBezier(fitted, t);
        maxErr = Math.max(
            maxErr,
            Math.hypot(sample.x - fittedPoint.x, sample.y - fittedPoint.y)
        );
    }
    return maxErr;
}

function joinBez(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[],
    tolerance: number
): SegmentPoint[] | null {
    const fitted = joinBezFit(leftPoints, rightPoints);
    if (joinBezMaxError(leftPoints, rightPoints, fitted) < tolerance) {
        return fitted;
    }
    return null;
}

function fitCubicCurveToConnectedCubicsFallback(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): SegmentPoint[] {
    const start = leftPoints[0];
    const end = rightPoints[3];
    const fallbackDirection = subtractPoints(end, start);
    const startDirection = normalizePoint(
        subtractPoints(leftPoints[1], start),
        fallbackDirection
    );
    const endDirection = normalizePoint(
        subtractPoints(rightPoints[2], end),
        scalePoint(fallbackDirection, -1)
    );

    const numSamples = 24;
    let a00 = 0;
    let a01 = 0;
    let a11 = 0;
    let b0 = 0;
    let b1 = 0;

    for (let index = 1; index < numSamples; index++) {
        const t = index / numSamples;
        const targetPoint =
            t <= 0.5
                ? evaluateCubicBezier(leftPoints, t * 2)
                : evaluateCubicBezier(rightPoints, (t - 0.5) * 2);
        const oneMinusT = 1 - t;
        const basis1 = 3 * oneMinusT * oneMinusT * t;
        const basis2 = 3 * oneMinusT * t * t;
        const startWeight = oneMinusT * oneMinusT * (1 + 2 * t);
        const endWeight = t * t * (3 - 2 * t);
        const basePoint = {
            x: startWeight * start.x + endWeight * end.x,
            y: startWeight * start.y + endWeight * end.y
        };
        const residual = subtractPoints(targetPoint, basePoint);
        const startContribution = scalePoint(startDirection, basis1);
        const endContribution = scalePoint(endDirection, basis2);

        a00 += pointLengthSquared(startContribution);
        a01 +=
            startContribution.x * endContribution.x +
            startContribution.y * endContribution.y;
        a11 += pointLengthSquared(endContribution);
        b0 +=
            startContribution.x * residual.x + startContribution.y * residual.y;
        b1 += endContribution.x * residual.x + endContribution.y * residual.y;
    }

    const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
    const fallbackLength = chordLength / 3;
    const determinant = a00 * a11 - a01 * a01;
    let startHandleLength = fallbackLength;
    let endHandleLength = fallbackLength;

    if (Math.abs(determinant) > 0.000001) {
        startHandleLength = (b0 * a11 - b1 * a01) / determinant;
        endHandleLength = (a00 * b1 - a01 * b0) / determinant;
    }

    startHandleLength = Math.max(0, startHandleLength);
    endHandleLength = Math.max(0, endHandleLength);

    if (startHandleLength === 0 && a11 > 0.000001) {
        endHandleLength = Math.max(0, b1 / a11);
    }
    if (endHandleLength === 0 && a00 > 0.000001) {
        startHandleLength = Math.max(0, b0 / a00);
    }

    return sanitizeMergedCubicWithFixedDirections(
        start,
        end,
        startDirection,
        endDirection,
        startHandleLength,
        endHandleLength
    );
}

function fitCubicCurveToConnectedCubics(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): SegmentPoint[] {
    const exactInverse = tryInvertCubicSplit(leftPoints, rightPoints);
    if (exactInverse) {
        return exactInverse.points;
    }

    const joinTolerance = Math.max(
        DELETE_KEEPING_SHAPE_TOLERANCE,
        recommendedJoinTolerance(leftPoints, rightPoints)
    );
    const joined = joinBez(leftPoints, rightPoints, joinTolerance);
    if (joined) {
        return joined;
    }

    return fitCubicCurveToConnectedCubicsFallback(leftPoints, rightPoints);
}

function fitQuadraticCurveToConnectedQuadratics(
    leftPoints: SegmentPoint[],
    rightPoints: SegmentPoint[]
): SegmentPoint[] {
    const start = leftPoints[0];
    const end = rightPoints[2];
    const numSamples = 8;
    const samples: SegmentPoint[] = [];

    for (let index = 0; index <= numSamples; index++) {
        const t = index / numSamples;
        if (t < 0.5) {
            samples.push(evaluateQuadraticBezier(leftPoints, t * 2));
        } else {
            samples.push(evaluateQuadraticBezier(rightPoints, (t - 0.5) * 2));
        }
    }

    return [start, samples[Math.floor(samples.length / 2)], end];
}

function evaluateQuadraticBezier(
    points: SegmentPoint[],
    t: number
): SegmentPoint {
    const [p0, p1, p2] = points;
    const u = 1 - t;
    const u2 = u * u;
    const t2 = t * t;

    return {
        x: u2 * p0.x + 2 * u * t * p1.x + t2 * p2.x,
        y: u2 * p0.y + 2 * u * t * p1.y + t2 * p2.y
    };
}

/**
 * Build node array for merging two segments when a node is deleted.
 * Handles all combinations: line-line, line-curve, curve-line, curve-curve
 */
function buildMergedSegmentNodeArray(
    nodes: Babelfont.Node[],
    leftDescriptor: PathSegmentDescriptor | null,
    rightDescriptor: PathSegmentDescriptor | null,
    deletedNodeIndex: number,
    closed: boolean
): Babelfont.Node[] | null {
    const clonedNodes = nodes.map((node) => cloneNodeData(node));

    // Case 1: No left segment (deleting first node in open path)
    if (!leftDescriptor) {
        if (!rightDescriptor) return null;
        // Just remove the node, the right segment becomes the start
        if (!closed && deletedNodeIndex === 0) {
            // Convert first on-curve node to Move
            const nextOnCurveIndex = findNextOnCurveNodeIndex(
                nodes,
                deletedNodeIndex
            );
            if (nextOnCurveIndex !== null) {
                clonedNodes[nextOnCurveIndex].nodetype =
                    'Move' as Babelfont.NodeType;
            }
        }
        return [
            ...clonedNodes.slice(0, deletedNodeIndex),
            ...clonedNodes.slice(deletedNodeIndex + 1)
        ];
    }

    // Case 2: No right segment (deleting last node in open path)
    if (!rightDescriptor) {
        // Just remove the node
        return [
            ...clonedNodes.slice(0, deletedNodeIndex),
            ...clonedNodes.slice(deletedNodeIndex + 1)
        ];
    }

    // Determine segment types
    const leftIsCurve =
        leftDescriptor.type === 'cubic' || leftDescriptor.type === 'quadratic';
    const rightIsCurve =
        rightDescriptor.type === 'cubic' ||
        rightDescriptor.type === 'quadratic';

    // Case 3: Line-Line -> Simple line
    if (!leftIsCurve && !rightIsCurve) {
        // Remove the deleted node and any off-curve nodes associated with it
        // The left segment end becomes the right segment end
        const leftStartIdx = leftDescriptor.runStartNodeIndex;
        const rightEndIdx = rightDescriptor.runEndNodeIndex;

        return [
            ...clonedNodes.slice(0, deletedNodeIndex),
            ...clonedNodes.slice(deletedNodeIndex + 1)
        ];
    }

    // Case 4: Line-Curve -> Convert to curve (keep right side's control points)
    if (!leftIsCurve && rightIsCurve) {
        const leftStartIdx = leftDescriptor.runStartNodeIndex;
        const rightEndIdx = rightDescriptor.runEndNodeIndex;
        const rightStartIdx = rightDescriptor.runStartNodeIndex;
        const isCubic = rightDescriptor.type === 'cubic';

        // Keep the right side's control points and end node
        // The right side's nodes are from rightStartIdx+1 to rightEndIdx (inclusive)
        const newNodes: Babelfont.Node[] = [];

        // Add control points from the right side
        for (let i = rightStartIdx + 1; i <= rightEndIdx; i++) {
            const node = clonedNodes[i];
            if (i === rightEndIdx) {
                // End point - convert to Curve/QCurve
                newNodes.push(
                    cloneNodeData(node, {
                        nodetype: (isCubic
                            ? 'Curve'
                            : 'QCurve') as Babelfont.NodeType,
                        smooth: node.smooth
                    })
                );
            } else {
                // Control point
                newNodes.push(
                    cloneNodeData(node, {
                        nodetype: 'OffCurve' as Babelfont.NodeType
                    })
                );
            }
        }

        return [
            ...clonedNodes.slice(0, leftStartIdx + 1),
            ...newNodes,
            ...clonedNodes.slice(rightEndIdx + 1)
        ];
    }

    // Case 5: Curve-Line -> Convert to curve (keep left side's control points)
    if (leftIsCurve && !rightIsCurve) {
        const leftStartIdx = leftDescriptor.runStartNodeIndex;
        const rightEndIdx = rightDescriptor.runEndNodeIndex;
        const leftEndIdx = leftDescriptor.endNodeIndex;
        const rightEndNode = clonedNodes[rightEndIdx];
        const isCubic = leftDescriptor.type === 'cubic';

        // Keep the left side's control points
        // The left side's control points are from leftStartIdx+1 to leftEndIdx-1
        const newNodes: Babelfont.Node[] = [];

        // Add control points from the left side
        for (let i = leftStartIdx + 1; i < leftEndIdx; i++) {
            const node = clonedNodes[i];
            newNodes.push(
                cloneNodeData(node, {
                    nodetype: 'OffCurve' as Babelfont.NodeType
                })
            );
        }

        // Add the end point as a Curve/QCurve
        newNodes.push(
            cloneNodeData(rightEndNode, {
                nodetype: (isCubic ? 'Curve' : 'QCurve') as Babelfont.NodeType,
                smooth: rightEndNode.smooth
            })
        );

        return [
            ...clonedNodes.slice(0, leftStartIdx + 1),
            ...newNodes,
            ...clonedNodes.slice(rightEndIdx + 1)
        ];
    }

    // Case 6: Curve-Curve -> Merge curves
    const mergedPoints =
        leftDescriptor.type === 'cubic' && rightDescriptor.type === 'cubic'
            ? fitCubicCurveToConnectedCubics(
                  leftDescriptor.points,
                  rightDescriptor.points
              )
            : fitQuadraticCurveToConnectedQuadratics(
                  leftDescriptor.points,
                  rightDescriptor.points
              );

    const newNodes: Babelfont.Node[] = [];
    const isCubic = leftDescriptor.type === 'cubic';

    for (let i = 1; i < mergedPoints.length; i++) {
        const point = mergedPoints[i];
        if (i === mergedPoints.length - 1) {
            // End point
            const endNodeIndex = rightDescriptor.endNodeIndex;
            newNodes.push(
                cloneNodeData(clonedNodes[endNodeIndex], {
                    x: point.x,
                    y: point.y,
                    nodetype: (isCubic
                        ? 'Curve'
                        : 'QCurve') as Babelfont.NodeType,
                    smooth: clonedNodes[endNodeIndex].smooth
                })
            );
        } else {
            // Control point
            newNodes.push({
                x: point.x,
                y: point.y,
                nodetype: 'OffCurve' as Babelfont.NodeType
            });
        }
    }

    const leftStartIdx = leftDescriptor.runStartNodeIndex;
    const rightEndIdx = rightDescriptor.runEndNodeIndex;

    return [
        ...clonedNodes.slice(0, leftStartIdx + 1),
        ...newNodes,
        ...clonedNodes.slice(rightEndIdx + 1)
    ];
}

/**
 * Find the index of the next on-curve node after the given index.
 */
function findNextOnCurveNodeIndex(
    nodes: Babelfont.Node[],
    startIndex: number
): number | null {
    for (let i = startIndex + 1; i < nodes.length; i++) {
        const type = (nodes[i].nodetype || '').toString().toLowerCase();
        if (type !== 'offcurve' && type !== 'o') {
            return i;
        }
    }
    return null;
}

function isOffCurveNodeType(type: string | undefined): boolean {
    const normalizedType = (type || '').toString().toLowerCase();
    return normalizedType === 'offcurve' || normalizedType === 'o';
}

const ONE_SIDED_SMOOTH_MAX_ANGLE_ERROR_RADIANS = (6 * Math.PI) / 180;

/**
 * Return the outgoing tangent direction at an on-curve node for a segment.
 */
function getOutgoingSegmentDirectionAtNode(
    descriptor: PathSegmentDescriptor | null,
    nodeIndex: number
): SegmentPoint | null {
    if (!descriptor || descriptor.points.length < 2) {
        return null;
    }

    if (descriptor.endNodeIndex === nodeIndex) {
        const endPoint = descriptor.points[descriptor.points.length - 1];
        const previousPoint = descriptor.points[descriptor.points.length - 2];
        return subtractPoints(endPoint, previousPoint);
    }

    if (descriptor.startNodeIndex === nodeIndex) {
        return subtractPoints(descriptor.points[1], descriptor.points[0]);
    }

    return null;
}

/**
 * Check whether two tangent directions are aligned within the one-sided smooth tolerance.
 */
function directionsMatchWithinSmoothAngleTolerance(
    left: SegmentPoint | null,
    right: SegmentPoint | null
): boolean {
    if (!left || !right) {
        return false;
    }

    const leftLengthSquared = pointLengthSquared(left);
    const rightLengthSquared = pointLengthSquared(right);
    if (leftLengthSquared <= 0.000001 || rightLengthSquared <= 0.000001) {
        return false;
    }

    const cosine =
        dotPoints(left, right) /
        Math.sqrt(leftLengthSquared * rightLengthSquared);
    const clampedCosine = Math.max(-1, Math.min(1, cosine));
    return Math.acos(clampedCosine) <= ONE_SIDED_SMOOTH_MAX_ANGLE_ERROR_RADIANS;
}

function canNodeRemainSmooth(
    nodes: Babelfont.Node[],
    nodeIndex: number,
    closed: boolean
): boolean {
    const targetNode = nodes[nodeIndex];
    if (
        !targetNode ||
        isOffCurveNodeType(targetNode.nodetype) ||
        targetNode.nodetype === 'Move'
    ) {
        return false;
    }

    const descriptors = buildPathSegmentDescriptors({ nodes, closed });
    const { leftDescriptor, rightDescriptor } = getAdjacentPathDescriptors(
        descriptors,
        nodeIndex
    );

    if (
        isCurveSegmentDescriptor(leftDescriptor) &&
        isCurveSegmentDescriptor(rightDescriptor)
    ) {
        return true;
    }

    if (!leftDescriptor || !rightDescriptor) {
        return false;
    }

    if (
        isCurveSegmentDescriptor(leftDescriptor) ===
        isCurveSegmentDescriptor(rightDescriptor)
    ) {
        return false;
    }

    return directionsMatchWithinSmoothAngleTolerance(
        getOutgoingSegmentDirectionAtNode(leftDescriptor, nodeIndex),
        getOutgoingSegmentDirectionAtNode(rightDescriptor, nodeIndex)
    );
}

function normalizePathNodeArray<T extends Babelfont.Node>(
    nodes: T[],
    closed: boolean
): T[] {
    const normalizedNodes = nodes.map((node) => cloneNodeData(node));

    if (closed) {
        for (let index = 0; index < normalizedNodes.length; index++) {
            const node = normalizedNodes[index];
            if (isOffCurveNodeType(node.nodetype)) {
                continue;
            }

            let offCurveCount = 0;
            let previousIndex =
                (((index - 1) % normalizedNodes.length) +
                    normalizedNodes.length) %
                normalizedNodes.length;

            while (
                offCurveCount < normalizedNodes.length &&
                isOffCurveNodeType(normalizedNodes[previousIndex].nodetype)
            ) {
                offCurveCount++;
                previousIndex =
                    (((previousIndex - 1) % normalizedNodes.length) +
                        normalizedNodes.length) %
                    normalizedNodes.length;
            }

            if (!offCurveCount) {
                continue;
            }

            const expectedNodeType =
                offCurveCount === 2
                    ? ('Curve' as Babelfont.NodeType)
                    : ('QCurve' as Babelfont.NodeType);

            if (node.nodetype !== expectedNodeType) {
                normalizedNodes[index] = cloneNodeData(node, {
                    nodetype: expectedNodeType
                } as Partial<T>);
            }
        }

        for (let index = 0; index < normalizedNodes.length; index++) {
            const node = normalizedNodes[index];
            if (
                node?.smooth &&
                !canNodeRemainSmooth(normalizedNodes, index, true)
            ) {
                normalizedNodes[index] = cloneNodeData(node, {
                    smooth: false
                } as Partial<T>);
            }
        }

        return normalizedNodes;
    }

    const firstOnCurveIndex = normalizedNodes.findIndex(
        (node) => !isOffCurveNodeType(node.nodetype)
    );

    if (firstOnCurveIndex === -1) {
        return [];
    }

    if (firstOnCurveIndex > 0) {
        normalizedNodes.splice(0, firstOnCurveIndex);
    }

    if (
        normalizedNodes.length &&
        !isOffCurveNodeType(normalizedNodes[0].nodetype) &&
        normalizedNodes[0].nodetype !== 'Move'
    ) {
        normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
            nodetype: 'Move' as Babelfont.NodeType
        } as Partial<T>);
    }

    let lastOnCurveIndex = -1;
    for (let index = normalizedNodes.length - 1; index >= 0; index--) {
        if (!isOffCurveNodeType(normalizedNodes[index].nodetype)) {
            lastOnCurveIndex = index;
            break;
        }
    }

    if (
        lastOnCurveIndex !== -1 &&
        lastOnCurveIndex < normalizedNodes.length - 1
    ) {
        normalizedNodes.splice(lastOnCurveIndex + 1);
    }

    for (let index = 1; index < normalizedNodes.length; index++) {
        const node = normalizedNodes[index];
        if (!node || isOffCurveNodeType(node.nodetype)) {
            continue;
        }

        let offCurveCount = 0;
        let previousIndex = index - 1;
        while (
            previousIndex >= 0 &&
            isOffCurveNodeType(normalizedNodes[previousIndex].nodetype)
        ) {
            offCurveCount++;
            previousIndex--;
        }

        const expectedNodeType =
            offCurveCount === 0
                ? ('Line' as Babelfont.NodeType)
                : offCurveCount === 2
                  ? ('Curve' as Babelfont.NodeType)
                  : ('QCurve' as Babelfont.NodeType);

        if (node.nodetype !== expectedNodeType) {
            normalizedNodes[index] = cloneNodeData(node, {
                nodetype: expectedNodeType
            } as Partial<T>);
        }
    }

    if (normalizedNodes.length) {
        normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
            smooth: false
        } as Partial<T>);
    }
    if (normalizedNodes.length > 1) {
        normalizedNodes[normalizedNodes.length - 1] = cloneNodeData(
            normalizedNodes[normalizedNodes.length - 1],
            {
                smooth: false
            } as Partial<T>
        );
    }

    for (let index = 0; index < normalizedNodes.length; index++) {
        const node = normalizedNodes[index];
        if (
            node?.smooth &&
            !canNodeRemainSmooth(normalizedNodes, index, false)
        ) {
            normalizedNodes[index] = cloneNodeData(node, {
                smooth: false
            } as Partial<T>);
        }
    }

    return normalizedNodes;
}

function promoteNodeToSmoothWhenEligible<T extends Babelfont.Node>(
    nodes: T[],
    nodeIndex: number,
    closed: boolean
): T[] {
    if (nodeIndex < 0 || nodeIndex >= nodes.length) {
        return nodes;
    }

    const node = nodes[nodeIndex];
    if (
        !node ||
        isOffCurveNodeType(node.nodetype) ||
        node.nodetype === 'Move' ||
        !canNodeRemainSmooth(nodes as Babelfont.Node[], nodeIndex, closed)
    ) {
        return nodes;
    }

    if (node.smooth) {
        return nodes;
    }

    const nextNodes = nodes.slice();
    nextNodes[nodeIndex] = cloneNodeData(node, {
        smooth: true
    } as Partial<T>);
    return nextNodes;
}

function reverseOpenPathNodeArray<T extends Babelfont.Node>(nodes: T[]): T[] {
    const descriptors = buildPathSegmentDescriptors({
        nodes: nodes as Babelfont.Node[],
        closed: false
    });
    if (!descriptors.length) {
        return normalizePathNodeArray(
            nodes.map((node) => cloneNodeData(node)) as T[],
            false
        );
    }

    const reverseControlNodes = (descriptor: PathSegmentDescriptor) =>
        descriptor.controlNodeIndices
            .slice()
            .reverse()
            .map((controlNodeIndex) =>
                cloneNodeData(nodes[controlNodeIndex], {
                    nodetype: 'OffCurve' as Babelfont.NodeType
                } as Partial<T>)
            );

    const orderedDescriptors = descriptors.slice().reverse();
    const firstDescriptor = orderedDescriptors[0];
    const reversedNodes: Babelfont.Node[] = [
        cloneNodeData(nodes[firstDescriptor.endNodeIndex], {
            nodetype: 'Move' as Babelfont.NodeType,
            smooth: false
        } as Partial<T>)
    ];

    for (const descriptor of orderedDescriptors) {
        reversedNodes.push(...reverseControlNodes(descriptor));
        reversedNodes.push(cloneNodeData(nodes[descriptor.startNodeIndex]));
    }

    const normalizedNodes = normalizePathNodeArray(reversedNodes as T[], false);
    if (normalizedNodes.length) {
        normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
            nodetype: 'Move' as Babelfont.NodeType,
            smooth: false
        } as Partial<T>);
    }
    return normalizedNodes;
}

function splitOpenPathNodeArray<T extends Babelfont.Node>(
    nodes: T[],
    nodeIndex: number
): { firstNodes: T[]; secondNodes: T[] } | null {
    if (nodeIndex <= 0 || nodeIndex >= nodes.length - 1) {
        return null;
    }

    const targetNode = nodes[nodeIndex];
    if (!targetNode || isOffCurveNodeType(targetNode.nodetype)) {
        return null;
    }

    const firstNodes = nodes.slice(0, nodeIndex + 1).map((node) => {
        if (node === targetNode) {
            return cloneNodeData(node, { smooth: false } as Partial<T>) as T;
        }
        return cloneNodeData(node) as T;
    });
    const secondNodes = [
        cloneNodeData(targetNode, {
            nodetype: 'Move' as Babelfont.NodeType,
            smooth: false
        } as Partial<T>) as T,
        ...nodes.slice(nodeIndex + 1).map((node) => cloneNodeData(node) as T)
    ];

    const normalizedFirstNodes = normalizePathNodeArray(firstNodes, false);
    const normalizedSecondNodes = normalizePathNodeArray(secondNodes, false);
    if (normalizedFirstNodes.length < 2 || normalizedSecondNodes.length < 2) {
        return null;
    }

    normalizedFirstNodes[normalizedFirstNodes.length - 1] = cloneNodeData(
        normalizedFirstNodes[normalizedFirstNodes.length - 1],
        {
            smooth: false
        } as Partial<T>
    );
    normalizedSecondNodes[0] = cloneNodeData(normalizedSecondNodes[0], {
        nodetype: 'Move' as Babelfont.NodeType,
        smooth: false
    } as Partial<T>);

    return {
        firstNodes: normalizedFirstNodes,
        secondNodes: normalizedSecondNodes
    };
}

function connectOpenPathNodeArrays<T extends Babelfont.Node>(
    sourceNodes: T[],
    sourceEdge: 'start' | 'end',
    targetNodes: T[],
    targetEdge: 'start' | 'end'
): { nodes: T[]; boundaryNodeIndex: number } | null {
    if (!sourceNodes.length || !targetNodes.length) {
        return null;
    }

    const orientedSourceNodes =
        sourceEdge === 'end'
            ? normalizePathNodeArray(
                  sourceNodes.map((node) => cloneNodeData(node)) as T[],
                  false
              )
            : reverseOpenPathNodeArray(sourceNodes);
    const orientedTargetNodes =
        targetEdge === 'start'
            ? normalizePathNodeArray(
                  targetNodes.map((node) => cloneNodeData(node)) as T[],
                  false
              )
            : reverseOpenPathNodeArray(targetNodes);

    if (!orientedSourceNodes.length || !orientedTargetNodes.length) {
        return null;
    }

    const sourceEndpoint = orientedSourceNodes[orientedSourceNodes.length - 1];
    const targetEndpoint = orientedTargetNodes[0];
    const boundaryNodeIndex = orientedSourceNodes.length - 1;
    const mergedNodes = [
        ...orientedSourceNodes.slice(0, -1),
        cloneNodeData(sourceEndpoint, {
            x: targetEndpoint.x,
            y: targetEndpoint.y,
            smooth: false
        } as Partial<T>) as T,
        ...orientedTargetNodes.slice(1).map((node) => cloneNodeData(node) as T)
    ];

    const normalizedNodes = normalizePathNodeArray(mergedNodes, false);
    if (
        !normalizedNodes.length ||
        boundaryNodeIndex >= normalizedNodes.length
    ) {
        return null;
    }

    normalizedNodes[boundaryNodeIndex] = cloneNodeData(
        normalizedNodes[boundaryNodeIndex],
        {
            smooth: false
        } as Partial<T>
    );

    const smoothedNodes = promoteNodeToSmoothWhenEligible(
        normalizedNodes,
        boundaryNodeIndex,
        false
    );

    return {
        nodes: smoothedNodes,
        boundaryNodeIndex
    };
}

function deleteNodeFromNodeArray<T extends Babelfont.Node>(
    nodes: T[],
    nodeIndex: number,
    closed: boolean
): T[] | null {
    if (nodeIndex < 0 || nodeIndex >= nodes.length) {
        return null;
    }

    const targetNode = nodes[nodeIndex];
    const isOffCurve = isOffCurveNodeType(targetNode.nodetype);

    if (isOffCurve) {
        const descriptors = buildPathSegmentDescriptors({
            nodes: nodes as Babelfont.Node[],
            closed
        });
        const containingDescriptor = descriptors.find((descriptor) =>
            descriptor.controlNodeIndices.includes(nodeIndex)
        );

        if (!containingDescriptor) {
            const nextNodes = nodes.map((node) => cloneNodeData(node));
            nextNodes.splice(nodeIndex, 1);
            return normalizePathNodeArray(nextNodes, closed);
        }

        return normalizePathNodeArray(
            buildLineCollapsedSegmentNodeArray(
                nodes as Babelfont.Node[],
                containingDescriptor,
                closed
            ) as T[],
            closed
        );
    }

    const descriptors = buildPathSegmentDescriptors({
        nodes: nodes as Babelfont.Node[],
        closed
    });
    const leftDescriptor = descriptors.find(
        (d) => d.endNodeIndex === nodeIndex
    );
    const rightDescriptor = descriptors.find(
        (d) => d.startNodeIndex === nodeIndex
    );
    const mergedNodes = buildMergedSegmentNodeArray(
        nodes as Babelfont.Node[],
        leftDescriptor || null,
        rightDescriptor || null,
        nodeIndex,
        closed
    ) as T[] | null;

    if (!mergedNodes) {
        return null;
    }

    const normalizedMergedNodes = normalizePathNodeArray(mergedNodes, closed);
    if (!closed && normalizedMergedNodes?.length && nodeIndex > 0) {
        const originalStartNode = nodes[0];
        const normalizedStartNode = normalizedMergedNodes[0];
        if (
            originalStartNode &&
            originalStartNode.nodetype !== 'Move' &&
            originalStartNode.nodetype !== 'Line' &&
            normalizedStartNode &&
            normalizedStartNode.x === originalStartNode.x &&
            normalizedStartNode.y === originalStartNode.y
        ) {
            normalizedMergedNodes[0] = cloneNodeData(normalizedStartNode, {
                nodetype: originalStartNode.nodetype,
                smooth: Boolean(originalStartNode.smooth)
            } as Partial<T>);
        }

        const originalEndNode = nodes[nodes.length - 1];
        const normalizedEndNode =
            normalizedMergedNodes[normalizedMergedNodes.length - 1];
        if (
            originalEndNode &&
            !isOffCurveNodeType(originalEndNode.nodetype) &&
            originalEndNode.nodetype !== 'Line' &&
            normalizedEndNode &&
            normalizedEndNode.x === originalEndNode.x &&
            normalizedEndNode.y === originalEndNode.y
        ) {
            normalizedMergedNodes[normalizedMergedNodes.length - 1] =
                cloneNodeData(normalizedEndNode, {
                    nodetype: originalEndNode.nodetype,
                    smooth: Boolean(originalEndNode.smooth)
                } as Partial<T>);
        }
    }

    return normalizedMergedNodes;
}

function getAdjacentPathDescriptors(
    descriptors: PathSegmentDescriptor[],
    nodeIndex: number
): {
    leftDescriptor: PathSegmentDescriptor | null;
    rightDescriptor: PathSegmentDescriptor | null;
} {
    return {
        leftDescriptor:
            descriptors.find(
                (descriptor) => descriptor.endNodeIndex === nodeIndex
            ) || null,
        rightDescriptor:
            descriptors.find(
                (descriptor) => descriptor.startNodeIndex === nodeIndex
            ) || null
    };
}

function isCurveSegmentDescriptor(
    descriptor: PathSegmentDescriptor | null
): descriptor is PathSegmentDescriptor {
    return Boolean(
        descriptor &&
        (descriptor.type === 'cubic' || descriptor.type === 'quadratic')
    );
}

function pointsMatchWithinTolerance(
    left: SegmentPoint,
    right: SegmentPoint,
    tolerance = 0.000001
): boolean {
    return (
        Math.abs(left.x - right.x) <= tolerance &&
        Math.abs(left.y - right.y) <= tolerance
    );
}

function findMergedSegmentDescriptorAfterNodeDeletion(
    mergedDescriptors: PathSegmentDescriptor[],
    leftDescriptor: PathSegmentDescriptor,
    rightDescriptor: PathSegmentDescriptor
): PathSegmentDescriptor | null {
    const expectedStart = leftDescriptor.points[0];
    const expectedEnd =
        rightDescriptor.points[rightDescriptor.points.length - 1];

    return (
        mergedDescriptors.find((descriptor) => {
            const startPoint = descriptor.points[0];
            const endPoint = descriptor.points[descriptor.points.length - 1];
            return (
                pointsMatchWithinTolerance(startPoint, expectedStart) &&
                pointsMatchWithinTolerance(endPoint, expectedEnd)
            );
        }) || null
    );
}

function projectPointOntoLineSegment(
    point: SegmentPoint,
    start: SegmentPoint,
    end: SegmentPoint
): number {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;

    if (!lengthSquared) {
        return 0;
    }

    return clampUnitInterval(
        ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
            lengthSquared
    );
}

function prepareSmoothPointSlideMutation(
    nodes: Babelfont.Node[],
    nodeIndex: number,
    closed: boolean
): {
    mergedNodes: Babelfont.Node[];
    mergedDescriptor: PathSegmentDescriptor;
} | null {
    if (nodeIndex < 0 || nodeIndex >= nodes.length) {
        return null;
    }

    const targetNode = nodes[nodeIndex];
    if (
        !targetNode ||
        isOffCurveNodeType(targetNode.nodetype) ||
        targetNode.nodetype === 'Move' ||
        !targetNode.smooth
    ) {
        return null;
    }

    const descriptors = buildPathSegmentDescriptors({ nodes, closed });
    const { leftDescriptor, rightDescriptor } = getAdjacentPathDescriptors(
        descriptors,
        nodeIndex
    );

    if (
        !isCurveSegmentDescriptor(leftDescriptor) ||
        !isCurveSegmentDescriptor(rightDescriptor)
    ) {
        return null;
    }

    const mergedNodes = deleteNodeFromNodeArray(nodes, nodeIndex, closed);
    if (!mergedNodes) {
        return null;
    }

    const mergedDescriptors = buildPathSegmentDescriptors({
        nodes: mergedNodes,
        closed
    });
    const mergedDescriptor = findMergedSegmentDescriptorAfterNodeDeletion(
        mergedDescriptors,
        leftDescriptor,
        rightDescriptor
    );

    if (!mergedDescriptor) {
        return null;
    }

    return {
        mergedNodes,
        mergedDescriptor
    };
}

function buildSmoothPointSlideMutationAtT(
    nodes: Babelfont.Node[],
    nodeIndex: number,
    t: number,
    closed: boolean
): { nodes: Babelfont.Node[]; insertedNodeIndex: number; t: number } | null {
    const prepared = prepareSmoothPointSlideMutation(nodes, nodeIndex, closed);
    if (!prepared) {
        return null;
    }

    const normalizedT = clampUnitInterval(t);

    const mutation = buildInsertedSegmentNodeArray(
        prepared.mergedNodes,
        prepared.mergedDescriptor,
        normalizedT,
        closed
    );

    return {
        ...mutation,
        t: normalizedT
    };
}

function buildSmoothPointSlideMutation(
    nodes: Babelfont.Node[],
    nodeIndex: number,
    targetPoint: SegmentPoint,
    closed: boolean
): { nodes: Babelfont.Node[]; insertedNodeIndex: number; t: number } | null {
    const prepared = prepareSmoothPointSlideMutation(nodes, nodeIndex, closed);
    if (!prepared) {
        return null;
    }

    const t =
        prepared.mergedDescriptor.points.length === 2
            ? projectPointOntoLineSegment(
                  targetPoint,
                  prepared.mergedDescriptor.points[0],
                  prepared.mergedDescriptor.points[1]
              )
            : clampUnitInterval(
                  new Bezier(prepared.mergedDescriptor.points).project(
                      targetPoint
                  ).t ?? 0
              );

    return buildSmoothPointSlideMutationAtT(nodes, nodeIndex, t, closed);
}

function stripBatchDeleteTracking(nodes: BatchTrackedNode[]): Babelfont.Node[] {
    return nodes.map((node) => {
        const { __batchDeleteOrigins, ...strippedNode } = node;
        return strippedNode;
    });
}

function findFontForModelObject(
    modelObj: ModelBase | null | undefined
): Font | null {
    let current: unknown = modelObj;
    while (current) {
        if (current instanceof Font) {
            return current;
        }

        if (!(current instanceof ModelBase)) {
            return null;
        }

        current = current.parent();
    }

    return null;
}

type SelectableLayerObject = Node | Anchor | Component | Guide;

type OutlineEditorSelectionPoint = {
    contourIndex: number;
    nodeIndex: number;
};

type OutlineEditorGuideHandle = {
    scope: 'master' | 'layer';
    index: number;
};

type BatchTrackedNode = Babelfont.Node & {
    __batchDeleteOrigins?: number[];
};

type OutlineEditorSelectionController = {
    active?: boolean;
    selectedPoints?: OutlineEditorSelectionPoint[];
    selectedAnchors?: number[];
    selectedComponents?: number[];
    selectedGuideHandle?: OutlineEditorGuideHandle | null;
    selectedSidebearingHandle?: unknown;
    selectedLayerId?: string | null;
    glyphCanvas?: {
        updatePropertyPanel?: () => void;
        render?: () => void;
    };
    getCurrentLayerModel?: () => Layer | null;
    getCurrentGlyphModel?: () => Glyph | null;
    getCurrentLayerId?: () => string | null;
    getRootMasterModel?: () => Master | null;
};

type OutlineEditorLayerLinkController = {
    isLayerLinked?: (
        layerId: string | null | undefined,
        glyphName?: string | null
    ) => boolean;
    setLayerLinked?: (
        layerId: string | null | undefined,
        linked: boolean,
        glyphName?: string | null
    ) => void;
};

function getOutlineEditorSelectionController(): OutlineEditorSelectionController | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const outlineEditor = (window as Unsafe).glyphCanvas?.outlineEditor;
    if (!outlineEditor?.active) {
        return null;
    }

    return outlineEditor as OutlineEditorSelectionController;
}

function getOutlineEditorLayerLinkController(): OutlineEditorLayerLinkController | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const outlineEditor = (window as Unsafe).glyphCanvas?.outlineEditor;
    if (
        !outlineEditor ||
        typeof outlineEditor.isLayerLinked !== 'function' ||
        typeof outlineEditor.setLayerLinked !== 'function'
    ) {
        return null;
    }

    return outlineEditor as OutlineEditorLayerLinkController;
}

function refreshLayerLinkageUi(
    glyphName: string | null,
    layerId: string | null | undefined,
    linked: boolean
): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(
        new CustomEvent('layerLinkageChanged', {
            detail: { glyphName, layerId: layerId ?? null, linked }
        })
    );

    const glyphCanvas = (window as Unsafe).glyphCanvas;
    void glyphCanvas?.updatePropertiesUI?.();
    glyphCanvas?.render?.();
}

function arePathsEqual(
    left: (string | number)[],
    right: (string | number)[]
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((segment, index) => segment === right[index]);
}

function areSameModelObject(
    left: ModelBase | null | undefined,
    right: ModelBase | null | undefined
): boolean {
    if (!left || !right) {
        return left === right;
    }

    if (left === right) {
        return true;
    }

    const leftFont = findFontForModelObject(left);
    const rightFont = findFontForModelObject(right);
    if (leftFont && rightFont && leftFont !== rightFont) {
        return false;
    }

    return arePathsEqual(left.getPath(), right.getPath());
}

function getPathIndex(modelObj: ModelBase, segmentName: string): number | null {
    const path = modelObj.getPath();
    for (let index = path.length - 2; index >= 0; index--) {
        if (path[index] !== segmentName) {
            continue;
        }

        const nextSegment = path[index + 1];
        if (typeof nextSegment === 'number') {
            return nextSegment;
        }
    }

    return null;
}

function getLayerForSelectableObject(value: unknown): Layer | null {
    if (value instanceof Anchor) {
        const parent = value.parent();
        return parent instanceof Layer ? parent : null;
    }

    if (value instanceof Guide) {
        const parent = value.parent();
        return parent instanceof Layer ? parent : null;
    }

    if (value instanceof Component) {
        const parentShape = value.parent();
        const parentLayer =
            parentShape instanceof Shape ? parentShape.parent() : null;
        return parentLayer instanceof Layer ? parentLayer : null;
    }

    if (value instanceof Node) {
        const parentPath = value.parent();
        if (parentPath instanceof Path) {
            const pathParent = parentPath.parent();
            if (pathParent instanceof Layer) {
                return pathParent;
            }
            if (pathParent instanceof Shape) {
                const parentLayer = pathParent.parent();
                return parentLayer instanceof Layer ? parentLayer : null;
            }
        }
    }

    return null;
}

function getCurrentOutlineEditorLayer(
    outlineEditor: OutlineEditorSelectionController
): Layer | null {
    const currentLayer = outlineEditor.getCurrentLayerModel?.();
    return currentLayer instanceof Layer ? currentLayer : null;
}

function getCurrentOutlineEditorGlyph(
    outlineEditor: OutlineEditorSelectionController
): Glyph | null {
    const currentGlyph = outlineEditor.getCurrentGlyphModel?.();
    return currentGlyph instanceof Glyph ? currentGlyph : null;
}

function isLayerActiveInOutlineEditor(
    layer: Layer,
    outlineEditor: OutlineEditorSelectionController
): boolean {
    const currentLayer = getCurrentOutlineEditorLayer(outlineEditor);
    if (currentLayer) {
        return areSameModelObject(layer, currentLayer);
    }

    const currentLayerId =
        outlineEditor.getCurrentLayerId?.() ??
        outlineEditor.selectedLayerId ??
        null;
    if (!currentLayerId || layer.id !== currentLayerId) {
        return false;
    }

    const currentGlyph = getCurrentOutlineEditorGlyph(outlineEditor);
    const layerGlyph = layer.parent();
    if (currentGlyph instanceof Glyph && layerGlyph instanceof Glyph) {
        return areSameModelObject(currentGlyph, layerGlyph);
    }

    return true;
}

function isMasterActiveInOutlineEditor(
    master: Master,
    outlineEditor: OutlineEditorSelectionController
): boolean {
    const rootMaster = outlineEditor.getRootMasterModel?.();
    return (
        rootMaster instanceof Master && areSameModelObject(master, rootMaster)
    );
}

function refreshOutlineEditorSelectionUi(
    outlineEditor: OutlineEditorSelectionController
): void {
    outlineEditor.glyphCanvas?.updatePropertyPanel?.();
    outlineEditor.glyphCanvas?.render?.();
}

function getPathOwningLayer(path: Path): Layer | null {
    const parent = path.parent();
    if (parent instanceof Layer) {
        return parent;
    }

    if (parent instanceof Shape) {
        const layer = parent.parent();
        return layer instanceof Layer ? layer : null;
    }

    return null;
}

function dispatchLayerFingerprintChanged(
    layer: Layer | null,
    previousFingerprint: string | null
): void {
    if (!layer || typeof window === 'undefined') {
        return;
    }

    if (layer.fingerprint === previousFingerprint) {
        return;
    }

    const glyph = layer.parent();
    const glyphName = glyph instanceof Glyph ? glyph.name : null;
    if (!glyphName || !layer.id) {
        return;
    }

    // Structural outline edits can change layer compatibility fingerprints.
    window.dispatchEvent(
        new CustomEvent('layerFingerprintChanged', {
            detail: {
                glyphName,
                layerId: layer.id
            }
        })
    );
}

function assertOutlineEditorSelectionMutationAllowed(
    layer: Layer,
    outlineEditor: OutlineEditorSelectionController | null,
    nextSelection: SelectableLayerObject[]
): OutlineEditorSelectionController {
    if (!outlineEditor) {
        if (nextSelection.length === 0) {
            return null as never;
        }

        throw new Error(
            'Cannot update UI selection while outline editing is inactive.'
        );
    }

    if (!isLayerActiveInOutlineEditor(layer, outlineEditor)) {
        if (nextSelection.length === 0) {
            return outlineEditor;
        }

        throw new Error(
            'Cannot update selection on a layer that is not the active outline-editor layer.'
        );
    }

    return outlineEditor;
}

function locationsMatch(
    left: DesignspaceLocation | undefined,
    right: DesignspaceLocation | undefined,
    axes: Axis[] | undefined
): boolean {
    if (!left || !right) {
        return false;
    }

    const tags = new Set<string>([
        ...(axes || []).map((axis) => axis.tag),
        ...Object.keys(left),
        ...Object.keys(right)
    ]);
    for (const tag of tags) {
        if ((left[tag] ?? 0) !== (right[tag] ?? 0)) {
            return false;
        }
    }

    return true;
}

export function buildInterpolationRustBatchOperations(
    metadata: InterpolationRustBatchMetadata
): TransactionBufferedOperation[] {
    const operations: TransactionBufferedOperation[] = [];

    if (metadata.axesOperation) {
        operations.push({
            op: 'set',
            path: ['axes'],
            oldValue: metadata.axesOperation.oldValue,
            newValue: metadata.axesOperation.newValue
        });
    }

    if (metadata.mastersOperation) {
        operations.push({
            op: 'set',
            path: ['masters'],
            oldValue: metadata.mastersOperation.oldValue,
            newValue: metadata.mastersOperation.newValue
        });
    }

    operations.push(
        ...metadata.layerOperations.map((operation) => {
            const path = [
                'glyphs',
                operation.glyphName,
                'layers',
                operation.layerId
            ] as (string | number)[];
            if (
                operation.newValue === undefined ||
                operation.newValue === null
            ) {
                return {
                    op: 'remove' as const,
                    path,
                    oldValue: operation.oldValue,
                    newValue: undefined,
                    workerReplayTargets: [
                        {
                            glyphName: operation.glyphName,
                            layerId: operation.layerId
                        }
                    ]
                };
            }

            return {
                op: 'set' as const,
                path,
                oldValue: operation.oldValue,
                newValue: operation.newValue,
                applyMode: 'layer-snapshot' as const,
                workerReplayTargets: [
                    {
                        glyphName: operation.glyphName,
                        layerId: operation.layerId
                    }
                ]
            };
        })
    );

    return operations;
}

/**
 * DecomposedAffine transformation utilities
 * Based on babelfont-ts implementation
 */
export class DecomposedAffineTransform {
    /**
     * Convert DecomposedAffine to affine matrix [a, b, c, d, e, f]
     * Handles the transform order (Glyphs vs RestOfTheWorld)
     */
    static toAffine(
        decomposed: Babelfont.DecomposedAffine
    ): [number, number, number, number, number, number] {
        return decomposedAffineToAffine(decomposed);
    }

    /**
     * Create identity transform
     */
    static identity(
        order?: Babelfont.TransformOrder
    ): Babelfont.DecomposedAffine {
        return createIdentityDecomposedAffine(order);
    }

    /**
     * Convert an affine matrix [a, b, c, d, e, f] to DecomposedAffine.
     * Mirrors babelfont-rs canonical decomposition for legacy affine input.
     */
    static fromAffine(
        affine: number[],
        order?: Babelfont.TransformOrder
    ): Babelfont.DecomposedAffine {
        return affineToDecomposedAffine(affine, order);
    }
}

/**
 * Mark the current font as dirty when data is modified
 */
function markFontDirty(): void {
    if (typeof window !== 'undefined' && window.fontManager?.currentFont) {
        window.fontManager.currentFont.markDirty();
        console.log('[BabelfontModel]', '✏️ Font marked as dirty');
    } else {
        console.warn(
            '[BabelfontModel]',
            '⚠️ Cannot mark font dirty - no currentFont'
        );
    }
}

/**
 * Record a property change in the PatchSyncEngine and mark the font dirty.
 * If no PatchSyncEngine is available, falls back to just marking dirty.
 */

/** Check if the bridge supports granular recording (has recordChange). */
function bridgeHasRecording(bridge: unknown): boolean {
    return !!bridge && typeof (bridge as any).recordChange === 'function';
}

function recordAndMarkDirty(
    modelObj: ModelBase,
    prop: string,
    oldVal: unknown,
    newVal: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    const bridge = getPatchSyncEngine();
    if (bridgeHasRecording(bridge)) {
        const path = modelObj.getPath();
        (bridge as any).recordChange(
            path,
            prop,
            normalizeBridgeRecordedValue(prop, oldVal),
            normalizeBridgeRecordedValue(prop, newVal)
        );
        return;
    }
    markFontDirty();
}

function recordPathChangeAndMarkDirty(
    path: (string | number)[],
    oldVal: unknown,
    newVal: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    const bridge = getPatchSyncEngine();
    if (bridgeHasRecording(bridge) && path.length > 0) {
        const last = path[path.length - 1];
        (bridge as any).recordChange(
            path.slice(0, -1),
            last,
            normalizeBridgeRecordedValue(String(last), oldVal),
            normalizeBridgeRecordedValue(String(last), newVal)
        );
        return;
    }
    markFontDirty();
}

/**
 * Record a path-level node change. Coordinate-only edits emit one packed
 * position per changed node; topology changes replace the path nodes array.
 */
function recordGranularNodesChange(
    basePath: (string | number)[],
    oldNodes: Babelfont.Node[],
    newNodes: Babelfont.Node[]
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    const bridge = getPatchSyncEngine();
    if (!bridgeHasRecording(bridge)) {
        markFontDirty();
        return;
    }

    if (topologyEqualsForNodes(oldNodes, newNodes)) {
        const count = Math.min(oldNodes.length, newNodes.length);
        for (let i = 0; i < count; i++) {
            const previous = oldNodes[i];
            const next = newNodes[i];
            if (
                !previous ||
                !next ||
                (previous.x === next.x && previous.y === next.y)
            ) {
                continue;
            }
            const nodeId = next.id || previous.id || generateStableId();
            if (!next.id) {
                next.id = nodeId;
            }
            const layerPath = basePath.slice(0, basePath.indexOf('shapes'));
            recordPathChangeAndMarkDirty(
                [...layerPath, 'nodePositionsById', nodeId],
                `${previous.x} ${previous.y}`,
                `${next.x} ${next.y}`
            );
        }
        return;
    }

    recordPathChangeAndMarkDirty([...basePath, 'nodes'], oldNodes, newNodes);
}

function recordLayerShapesGeometryChange(
    layerPath: (string | number)[],
    oldShapes: unknown[],
    newShapes: unknown[]
): void {
    if (oldShapes.length !== newShapes.length) {
        recordPathChangeAndMarkDirty(
            [...layerPath, 'shapes'],
            oldShapes,
            newShapes
        );
        return;
    }

    let topologyChanged = false;
    for (let i = 0; i < newShapes.length; i++) {
        const oldShape = oldShapes[i] as Unsafe | undefined;
        const newShape = newShapes[i] as Unsafe | undefined;
        const oldNodes = Array.isArray(oldShape?.nodes)
            ? (oldShape.nodes as Babelfont.Node[])
            : null;
        const newNodes = Array.isArray(newShape?.nodes)
            ? (newShape.nodes as Babelfont.Node[])
            : null;
        if (oldNodes && newNodes) {
            if (
                oldShape?.id !== newShape?.id ||
                oldShape?.closed !== newShape?.closed ||
                !topologyEqualsForNodes(oldNodes, newNodes)
            ) {
                topologyChanged = true;
                break;
            }
        } else if (
            Boolean(oldNodes) !== Boolean(newNodes) ||
            oldShape?.id !== newShape?.id ||
            oldShape?.reference !== newShape?.reference
        ) {
            topologyChanged = true;
            break;
        }
    }

    if (topologyChanged) {
        recordPathChangeAndMarkDirty(
            [...layerPath, 'shapes'],
            oldShapes,
            newShapes
        );
        return;
    }

    for (let i = 0; i < newShapes.length; i++) {
        const oldShape = oldShapes[i] as Unsafe | undefined;
        const newShape = newShapes[i] as Unsafe | undefined;
        if (Array.isArray(oldShape?.nodes) && Array.isArray(newShape?.nodes)) {
            recordGranularNodesChange(
                [...layerPath, 'shapes', i],
                oldShape.nodes as Babelfont.Node[],
                newShape.nodes as Babelfont.Node[]
            );
            continue;
        }
        if (newShape?.transform) {
            recordPathChangeAndMarkDirty(
                [...layerPath, 'shapes', i, 'transform'],
                oldShape?.transform,
                newShape.transform
            );
        }
    }
}

function recomputeMetricsKeysForModelLayer(
    layer: Layer | null | undefined
): void {
    const bridge = getPatchSyncEngine() as any;

    if (
        !layer ||
        suppressMetricsKeyRecomputeDepth > 0 ||
        suppressModelRecordingDepth > 0 ||
        bridge?._suppressRecording ||
        bridge?._isSyncing
    ) {
        return;
    }

    const glyph = layer.parent();
    const font =
        glyph instanceof Glyph ? (glyph.parent() as Font | null) : null;
    if (!font || !glyph?.name) {
        return;
    }

    font.recomputeMetricsKeys(new Set([glyph.name]));
}

function recomputeMetricsKeysForSelectableObject(
    modelObj: SelectableLayerObject | null | undefined
): void {
    recomputeMetricsKeysForModelLayer(
        modelObj ? getLayerForSelectableObject(modelObj) : null
    );
}

function recordAddAndMarkDirty(
    path: (string | number)[],
    value: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    const bridge = getPatchSyncEngine();
    if (bridge && typeof (bridge as any).recordAdd === 'function') {
        (bridge as any).recordAdd(path, cloneForHistory(value));
        return;
    }
    markFontDirty();
}

function recordRemoveAndMarkDirty(
    path: (string | number)[],
    oldValue: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    const bridge = getPatchSyncEngine();
    if (bridge && typeof (bridge as any).recordRemove === 'function') {
        (bridge as any).recordRemove(path, cloneForHistory(oldValue));
        return;
    }
    markFontDirty();
}

function withBridgeTransaction<T>(label: string, fn: () => T): T {
    const bridge = getPatchSyncEngine();
    if (!bridge) {
        return fn();
    }

    bridge.beginTransaction(label);
    try {
        return fn();
    } finally {
        bridge.endTransaction();
    }
}

function getCurrentSourcePlugin(): FilesystemPlugin | null {
    const plugin = window.fontManager?.currentFont?.sourcePlugin;
    if (
        plugin &&
        typeof plugin.getCachedCanAddGlyphs === 'function' &&
        typeof plugin.canAddGlyphs === 'function'
    ) {
        return plugin as FilesystemPlugin;
    }
    return null;
}

function assertCanAddGlyphs(additionalGlyphCount: number): void {
    const plugin = getCurrentSourcePlugin();
    if (!plugin) {
        return;
    }
    const gate = plugin.getCachedCanAddGlyphs(additionalGlyphCount);
    if (!gate.allowed) {
        throw new Error(gate.reason || 'Glyph limit reached');
    }
}

function getGlyphMetricFormatSpecificKey(side: SidebearingSide): string {
    return side === 'left'
        ? GLYPHS_GLYPH_METRIC_LEFT_KEY
        : GLYPHS_GLYPH_METRIC_RIGHT_KEY;
}

function getLayerMetricFormatSpecificKey(side: SidebearingSide): string {
    return side === 'left'
        ? GLYPHS_LAYER_METRIC_LEFT_KEY
        : GLYPHS_LAYER_METRIC_RIGHT_KEY;
}

function normalizeMetricsKeyValue(
    value: string | undefined | null
): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function localMetricsKeyStorageToPublic(
    value: string | undefined | null
): string | undefined {
    const normalized = normalizeMetricsKeyValue(value);
    if (!normalized) {
        return undefined;
    }

    return normalized.startsWith('=') ? `=${normalized}` : `==${normalized}`;
}

function localMetricsKeyPublicToStorage(
    value: string | undefined | null,
    font?: Font
): string | undefined {
    const normalized = normalizeMetricsKeyValue(value);
    if (!normalized) {
        return undefined;
    }

    const localBody = normalized.startsWith('==')
        ? normalized.slice(2)
        : normalized;
    if (!localBody) {
        return undefined;
    }

    if (localBody.startsWith('=')) {
        return localBody;
    }

    if (isPlainNumericText(localBody)) {
        return localBody;
    }

    if (font) {
        const glyphMatch = getGlyphNamePrefixMatch(font, localBody);
        if (glyphMatch && glyphMatch.rest === '') {
            return localBody;
        }
    }

    return `=${localBody}`;
}

function isPlainNumericText(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function roundMetricValue(value: number): number {
    return Math.round(value);
}

function appendMapArrayValue<Key, Value>(
    map: Map<Key, Value[]>,
    key: Key,
    value: Value
): void {
    const existingValues = map.get(key);
    if (existingValues) {
        existingValues.push(value);
        return;
    }

    map.set(key, [value]);
}

function getModelFormatSpecific(
    modelObj: ModelBase
): Record<string, Unsafe> | undefined {
    return (modelObj.toJSON() as { format_specific?: Record<string, Unsafe> })
        .format_specific;
}

function ensureModelFormatSpecific(
    modelObj: ModelBase
): Record<string, Unsafe> {
    assertModelMutationAllowed();
    const data = modelObj.toJSON() as {
        format_specific?: Record<string, Unsafe>;
    };

    if (!data.format_specific) {
        data.format_specific = {};
        recordPathChangeAndMarkDirty(
            [...modelObj.getPath(), 'format_specific'],
            undefined,
            data.format_specific
        );
    }

    return data.format_specific;
}

function setFormatSpecificKey(
    modelObj: ModelBase,
    key: string,
    value: string | Record<string, Unsafe> | undefined
): void {
    assertModelMutationAllowed();
    const data = modelObj.toJSON() as {
        format_specific?: Record<string, Unsafe>;
    };

    if (value === undefined) {
        if (!data.format_specific || !(key in data.format_specific)) {
            return;
        }

        const oldValue = cloneForHistory(data.format_specific[key]);
        delete data.format_specific[key];

        const bridge = getPatchSyncEngine();
        if (bridge && typeof (bridge as any).recordRemove === 'function') {
            (bridge as any).recordRemove(
                [...modelObj.getPath(), 'format_specific', key],
                oldValue
            );
        }
        markFontDirty();
        return;
    }

    const formatSpecific = ensureModelFormatSpecific(modelObj);
    const oldValue = cloneForHistory(formatSpecific[key]);
    formatSpecific[key] = value;
    recordPathChangeAndMarkDirty(
        [...modelObj.getPath(), 'format_specific', key],
        oldValue,
        value
    );
}

function getGlyphNamePrefixMatch(
    font: Font,
    text: string
): { glyphName: string; rest: string } | null {
    const glyphNames = font.getGlyphNamesByLengthDesc();

    for (const glyphName of glyphNames) {
        if (text === glyphName) {
            return { glyphName, rest: '' };
        }

        const nextChar = text[glyphName.length];
        if (
            text.startsWith(glyphName) &&
            ['@', '+', '-', '*', '/'].includes(nextChar)
        ) {
            return { glyphName, rest: text.slice(glyphName.length) };
        }
    }

    return null;
}

function parseMetricsKey(
    font: Font,
    rawKey: string
): ParsedMetricsKey | { error: string } {
    let input = rawKey.trim();
    if (!input) {
        return { error: 'Empty metrics key' };
    }

    if (input.startsWith('==')) {
        input = input.slice(1);
    }

    if (isPlainNumericText(input)) {
        return {
            kind: 'constant',
            value: Number(input),
            referencedGlyphNames: []
        };
    }

    if (/^=\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'constant',
            value: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    if (/^=[+-]\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'automatic-offset',
            delta: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    let body = input;
    if (body.startsWith('=')) {
        body = body.slice(1);
    }

    let mirror = false;
    if (body.startsWith('|')) {
        mirror = true;
        body = body.slice(1);
    }

    if (!body) {
        return {
            kind: 'reference',
            glyphName: null,
            mirror,
            offsetY: null,
            operation: null,
            referencedGlyphNames: []
        };
    }

    const prefixMatch = getGlyphNamePrefixMatch(font, body);
    if (!prefixMatch) {
        return { error: `Unknown glyph reference in metrics key: ${rawKey}` };
    }

    let rest = prefixMatch.rest;
    let offsetY: number | null = null;
    let operation: { operator: '+' | '-' | '*' | '/'; value: number } | null =
        null;

    if (rest.startsWith('@')) {
        const offsetMatch = rest.match(/^@([+-]?\d+(?:\.\d+)?)(.*)$/);
        if (!offsetMatch) {
            return {
                error: `Invalid baseline offset in metrics key: ${rawKey}`
            };
        }
        offsetY = Number(offsetMatch[1]);
        rest = offsetMatch[2] || '';
    }

    if (rest) {
        const operationMatch = rest.match(/^([+\-*/])([+-]?\d+(?:\.\d+)?)$/);
        if (!operationMatch) {
            return {
                error: `Invalid calculation suffix in metrics key: ${rawKey}`
            };
        }
        operation = {
            operator: operationMatch[1] as '+' | '-' | '*' | '/',
            value: Number(operationMatch[2])
        };
    }

    return {
        kind: 'reference',
        glyphName: prefixMatch.glyphName,
        mirror,
        offsetY,
        operation,
        referencedGlyphNames: [prefixMatch.glyphName]
    };
}

function applyMetricOperation(
    value: number,
    operation: { operator: '+' | '-' | '*' | '/'; value: number } | null
): number | null {
    if (!operation) {
        return value;
    }

    switch (operation.operator) {
        case '+':
            return value + operation.value;
        case '-':
            return value - operation.value;
        case '*':
            return value * operation.value;
        case '/':
            if (Math.abs(operation.value) < 1e-8) {
                return null;
            }
            return value / operation.value;
    }
}

const MUTATING_ARRAY_METHODS = new Set([
    'copyWithin',
    'fill',
    'pop',
    'push',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift'
]);
const MUTATING_MAP_METHODS = new Set(['set', 'delete', 'clear']);
const MUTATING_SET_METHODS = new Set(['add', 'delete', 'clear']);

const liveMutableProxyTargets = new WeakMap<object, object>();
const readOnlyCollectionProxyCache = new WeakMap<object, object>();

function cloneForHistory<T>(value: T): T {
    if (value === undefined) {
        return value;
    }

    if (value instanceof Map || value instanceof Set) {
        return cloneSerializableHistoryValue(value) as T;
    }

    try {
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
    }

    return cloneSerializableHistoryValue(value) as T;
}

function cloneSerializableHistoryValue(
    value: unknown,
    seen = new WeakMap<object, unknown>()
): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    const valueType = typeof value;
    if (
        valueType === 'string' ||
        valueType === 'number' ||
        valueType === 'boolean'
    ) {
        return value;
    }

    if (valueType === 'bigint') {
        return Number(value);
    }

    if (valueType === 'function' || valueType === 'symbol') {
        return undefined;
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return seen.get(value);
        }

        const clone: unknown[] = [];
        seen.set(value, clone);
        for (const item of value) {
            clone.push(cloneSerializableHistoryValue(item, seen));
        }
        return clone;
    }

    if (value instanceof Map) {
        const clone: Record<string, unknown> = {};
        seen.set(value, clone);
        for (const [key, entryValue] of value) {
            const clonedValue = cloneSerializableHistoryValue(entryValue, seen);
            if (clonedValue !== undefined) {
                clone[String(key)] = clonedValue;
            }
        }
        return clone;
    }

    if (value instanceof Set) {
        const clone: unknown[] = [];
        seen.set(value, clone);
        for (const entryValue of value) {
            clone.push(cloneSerializableHistoryValue(entryValue, seen));
        }
        return clone;
    }

    if (value instanceof Date) {
        return new Date(value.getTime());
    }

    if (value instanceof ArrayBuffer) {
        return value.slice(0);
    }

    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(
            value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength
            )
        );
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            return seen.get(value);
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) {
            const clone: Record<string, unknown> = {};
            seen.set(value, clone);

            for (const [key, entryValue] of Object.entries(value)) {
                const clonedValue = cloneSerializableHistoryValue(
                    entryValue,
                    seen
                );
                if (clonedValue !== undefined) {
                    clone[key] = clonedValue;
                }
            }

            return clone;
        }
    }

    return undefined;
}

function unwrapLiveMutableValue<T>(value: T): T {
    if (!value || typeof value !== 'object') {
        return value;
    }
    return (liveMutableProxyTargets.get(value as object) as T) ?? value;
}

function getLiveMutableValue<T>(
    modelObj: ModelBase,
    prop: string,
    value: T,
    getCurrentValue: () => T
): T {
    return getPreciseLiveMutableValue(
        [...modelObj.getPath(), prop],
        value,
        getCurrentValue
    );
}

function getPreciseLiveMutableValue<T>(
    pathPrefix: (string | number)[],
    value: T,
    getCurrentValue: () => T
): T {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const localProxyCache = new WeakMap<object, object>();

    const wrap = (
        currentValue: unknown,
        currentPath: (string | number)[]
    ): unknown => {
        if (!currentValue || typeof currentValue !== 'object') {
            return currentValue;
        }

        const cachedProxy = localProxyCache.get(currentValue as object);
        if (cachedProxy) {
            return cachedProxy;
        }

        const proxy = new Proxy(currentValue as object, {
            get(target, key, receiver) {
                const result = Reflect.get(target, key, receiver);

                if (
                    typeof key === 'string' &&
                    typeof result === 'function' &&
                    ((Array.isArray(target) &&
                        MUTATING_ARRAY_METHODS.has(key)) ||
                        (target instanceof Map &&
                            MUTATING_MAP_METHODS.has(key)) ||
                        (target instanceof Set &&
                            MUTATING_SET_METHODS.has(key)))
                ) {
                    return (...args: unknown[]) => {
                        assertModelMutationAllowed();
                        const nextArgs = args.map(unwrapLiveMutableValue);
                        return withBridgeTransaction(
                            `Edit ${String(currentPath[currentPath.length - 1] ?? 'array')}`,
                            () => {
                                const oldValue = cloneForHistory(target);
                                const operationResult = Reflect.apply(
                                    result,
                                    target,
                                    nextArgs
                                );
                                recordPathChangeAndMarkDirty(
                                    currentPath,
                                    oldValue,
                                    cloneForHistory(target)
                                );
                                return operationResult;
                            }
                        );
                    };
                }

                if (typeof result === 'function') {
                    return (...args: unknown[]) =>
                        Reflect.apply(
                            result,
                            target instanceof Map || target instanceof Set
                                ? target
                                : receiver,
                            args.map(unwrapLiveMutableValue)
                        );
                }

                const nextPath =
                    Array.isArray(target) && isArrayIndexKey(key)
                        ? currentPath.concat(Number(key))
                        : currentPath.concat(String(key));
                return wrap(result, nextPath);
            },

            set(target, key, nextValue, receiver) {
                assertModelMutationAllowed();
                const unwrappedValue = unwrapLiveMutableValue(nextValue);

                if (Array.isArray(target)) {
                    const oldArray = cloneForHistory(target);
                    const success = Reflect.set(
                        target,
                        key,
                        unwrappedValue,
                        receiver
                    );

                    if (key === 'length') {
                        recordPathChangeAndMarkDirty(
                            currentPath,
                            oldArray,
                            cloneForHistory(target)
                        );
                        return success;
                    }

                    if (isArrayIndexKey(key)) {
                        const index = Number(key);
                        recordPathChangeAndMarkDirty(
                            currentPath.concat(index),
                            cloneForHistory(oldArray[index]),
                            cloneForHistory((target as unknown[])[index])
                        );
                        return success;
                    }

                    recordPathChangeAndMarkDirty(
                        currentPath.concat(String(key)),
                        cloneForHistory((oldArray as Unsafe)[key]),
                        cloneForHistory((target as Unsafe)[key])
                    );
                    return success;
                }

                const propPath = currentPath.concat(String(key));
                const oldValue = cloneForHistory(
                    Reflect.get(target, key, receiver)
                );
                const success = Reflect.set(
                    target,
                    key,
                    unwrappedValue,
                    receiver
                );
                recordPathChangeAndMarkDirty(
                    propPath,
                    oldValue,
                    cloneForHistory(Reflect.get(target, key, receiver))
                );
                return success;
            },

            deleteProperty(target, key) {
                assertModelMutationAllowed();
                if (Array.isArray(target)) {
                    const oldValue = cloneForHistory(target);
                    const success = Reflect.deleteProperty(target, key);
                    recordPathChangeAndMarkDirty(
                        currentPath,
                        oldValue,
                        cloneForHistory(target)
                    );
                    return success;
                }

                const propPath = currentPath.concat(String(key));
                const oldValue = cloneForHistory(Reflect.get(target, key));
                const success = Reflect.deleteProperty(target, key);
                const bridge = getPatchSyncEngine();
                if (
                    bridge &&
                    typeof (bridge as any).recordRemove === 'function'
                ) {
                    (bridge as any).recordRemove(propPath, oldValue);
                }
                markFontDirty();
                return success;
            }
        });

        liveMutableProxyTargets.set(proxy, currentValue as object);
        localProxyCache.set(currentValue as object, proxy);
        return proxy;
    };

    return wrap(getCurrentValue(), pathPrefix) as T;
}

function isArrayIndexKey(key: PropertyKey): boolean {
    return typeof key === 'string' && /^\d+$/.test(key);
}

function getReadOnlyCollectionValue<T>(value: T, errorMessage: string): T {
    if (!Array.isArray(value)) {
        return value;
    }

    const cachedProxy = readOnlyCollectionProxyCache.get(value as object);
    if (cachedProxy) {
        return cachedProxy as T;
    }

    const proxy = new Proxy(value as unknown as object, {
        get(target, key, receiver) {
            const result = Reflect.get(target, key, receiver);

            if (
                typeof key === 'string' &&
                MUTATING_ARRAY_METHODS.has(key) &&
                typeof result === 'function'
            ) {
                return () => {
                    throw new TypeError(errorMessage);
                };
            }

            if (typeof result === 'function') {
                return (...args: unknown[]) =>
                    Reflect.apply(result, target, args);
            }

            return result;
        },

        set(target, key, nextValue, receiver) {
            if (key === 'length' || isArrayIndexKey(key)) {
                throw new TypeError(errorMessage);
            }

            assertModelMutationAllowed();
            return Reflect.set(target, key, nextValue, receiver);
        },

        deleteProperty(target, key) {
            if (key === 'length' || isArrayIndexKey(key)) {
                throw new TypeError(errorMessage);
            }

            assertModelMutationAllowed();
            return Reflect.deleteProperty(target, key);
        }
    });

    readOnlyCollectionProxyCache.set(value as object, proxy);
    return proxy as T;
}

function syncNormalizedModelValue(
    modelObj: ModelBase,
    prop: string,
    value: unknown
): void {
    const bridge = getPatchSyncEngine();
    if (!bridge) {
        return;
    }

    bridge.yDoc.transact(() => {
        setYPath(
            bridge.fontMap,
            [...modelObj.getPath(), prop],
            cloneForHistory(normalizeBridgeRecordedValue(prop, value))
        );
    });
}

function normalizeBridgeRecordedValue(_prop: string, value: unknown): unknown {
    return value;
}

/**
 * Get the global PatchSyncEngine instance, if available.
 */
function getPatchSyncEngine(): PatchSyncEngine | null {
    if (typeof window !== 'undefined') {
        const w = window as Unsafe;
        return w.patchSyncEngine ?? w.changeBridge ?? null;
    }
    return null;
}

function isDevelopmentMode(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    return typeof window.isDevelopment === 'function'
        ? window.isDevelopment()
        : false;
}

function isTaggedLayerType(value: Unsafe): boolean {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }

    const taggedValue = value as { type?: Unsafe; master?: Unsafe };

    if (taggedValue.type === 'FreeFloating') {
        return !('master' in taggedValue) || taggedValue.master === undefined;
    }

    if (
        (taggedValue.type === 'DefaultForMaster' ||
            taggedValue.type === 'AssociatedWithMaster') &&
        typeof taggedValue.master === 'string'
    ) {
        return true;
    }

    return false;
}

function assertTaggedLayerMaster(master: Unsafe, context: string): void {
    if (!isDevelopmentMode() || master === undefined) {
        return;
    }

    if (!isTaggedLayerType(master)) {
        let formatted = '[unserializable]';
        try {
            formatted = JSON.stringify(master);
        } catch (_error) {
            formatted = '[unserializable]';
        }

        throw new Error(
            `[BabelfontModel] Non-tagged layer.master detected at ${context}. Received: ${formatted}`
        );
    }
}

/**
 * Base class for model objects that wrap JSON data
 */
abstract class ModelBase<TData = Unsafe, TParent = Unsafe> {
    protected _data: TData;
    protected _parentObject: TParent | null = null;

    constructor(data: TData, parentObject: TParent | null = null) {
        this._data = data;
        this._parentObject = parentObject;
    }

    /**
     * Get the underlying JSON data for this object
     */
    toJSON(): TData {
        return this._data;
    }

    /**
     * Get the parent object in the hierarchy
     * @returns The parent object, or null if this is the root Font object
     */
    parent(): TParent | null {
        return this._parentObject;
    }

    /**
     * Get the path segment that identifies this object within its parent.
     * Override in subclasses. Returns an empty array for root objects.
     */
    getPathSegment(): (string | number)[] {
        return [];
    }

    /**
     * Build the full path from the font root to this object by walking
     * the parent chain.
     */
    getPath(): (string | number)[] {
        const segments: (string | number)[][] = [];
        let current: ModelBase | null = this as ModelBase;
        while (current) {
            const seg = current.getPathSegment();
            if (seg.length > 0) {
                segments.push(seg);
            }
            const p = current.parent();
            current = p instanceof ModelBase ? p : null;
        }
        segments.reverse();
        return segments.flat();
    }
}

/**
 * Base class for objects that are elements in an array
 */
abstract class ArrayElementBase<
    TData = Unsafe,
    TParent = Unsafe
> extends ModelBase<TData, TParent> {
    protected _parent: TData[];
    protected _index: number;

    constructor(
        parent: TData[],
        index: number,
        parentObject: TParent | null = null
    ) {
        super(parent[index], parentObject);
        this._parent = parent;
        this._index = index;
    }

    /**
     * Get current data (handles index changes)
     */
    protected get data(): TData {
        return this._parent[this._index];
    }

    /** True when this element still indexes into `array`. */
    isBoundToArray(array: TData[]): boolean {
        return this._parent === array;
    }

    /**
     * Update underlying data reference and mark font as dirty
     */
    protected set data(value: TData) {
        assertModelMutationAllowed();
        this._parent[this._index] = value;
        markFontDirty();
    }

    toJSON(): TData {
        return this.data;
    }
}

/**
 * Point in a path
 */
export class Node extends ArrayElementBase<Babelfont.Node, Path> {
    /** Stable identifier for CRDT addressing. Generated on load; preserved across edits. */
    get id(): string | undefined {
        return this.data.id;
    }

    getPathSegment(): (string | number)[] {
        return ['nodes', this._index];
    }

    /** Whether this node is selected in the active outline editor. */
    get selected(): boolean {
        const outlineEditor = getOutlineEditorSelectionController();
        const layer = getLayerForSelectableObject(this);
        const contourIndex = getPathIndex(this, 'shapes');
        const nodeIndex = getPathIndex(this, 'nodes');
        if (
            !outlineEditor ||
            !layer ||
            contourIndex === null ||
            nodeIndex === null ||
            !isLayerActiveInOutlineEditor(layer, outlineEditor)
        ) {
            return false;
        }

        return (outlineEditor.selectedPoints || []).some(
            (point) =>
                point.contourIndex === contourIndex &&
                point.nodeIndex === nodeIndex
        );
    }

    set selected(value: boolean) {
        assertModelMutationAllowed();
        const layer = getLayerForSelectableObject(this);
        if (!layer) {
            return;
        }

        const currentSelection = layer.selection;
        if (value) {
            layer.selection = [...currentSelection, this];
            return;
        }

        layer.selection = currentSelection.filter(
            (item) => !areSameModelObject(item, this)
        );
    }

    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        assertModelMutationAllowed();
        const path = this.parent();
        const oldNodes =
            path instanceof Path
                ? path.toJSON().nodes.map((node) => cloneNodeData(node))
                : null;
        this.data.x = value;
        if (path instanceof Path && oldNodes) {
            recordGranularNodesChange(
                path.getPath(),
                oldNodes,
                path.toJSON().nodes
            );
        } else {
            markFontDirty();
        }
        recomputeMetricsKeysForSelectableObject(this);
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        assertModelMutationAllowed();
        const path = this.parent();
        const oldNodes =
            path instanceof Path
                ? path.toJSON().nodes.map((node) => cloneNodeData(node))
                : null;
        this.data.y = value;
        if (path instanceof Path && oldNodes) {
            recordGranularNodesChange(
                path.getPath(),
                oldNodes,
                path.toJSON().nodes
            );
        } else {
            markFontDirty();
        }
        recomputeMetricsKeysForSelectableObject(this);
    }

    get nodetype(): Babelfont.NodeType {
        return this.data.nodetype;
    }

    set nodetype(value: Babelfont.NodeType) {
        assertModelMutationAllowed();
        const path = this.parent();
        const oldNodes =
            path instanceof Path
                ? path.toJSON().nodes.map((node) => cloneNodeData(node))
                : null;
        this.data.nodetype = value;
        if (path instanceof Path && oldNodes) {
            recordGranularNodesChange(
                path.getPath(),
                oldNodes,
                path.toJSON().nodes
            );
        } else {
            markFontDirty();
        }
    }

    get smooth(): boolean | undefined {
        return this.data.smooth;
    }

    set smooth(value: boolean | undefined) {
        assertModelMutationAllowed();
        const path = this.parent();
        const oldNodes =
            path instanceof Path
                ? path.toJSON().nodes.map((node) => cloneNodeData(node))
                : null;
        this.data.smooth = value;
        if (path instanceof Path && oldNodes) {
            recordGranularNodesChange(
                path.getPath(),
                oldNodes,
                path.toJSON().nodes
            );
        } else {
            markFontDirty();
        }
    }

    toString(): string {
        const smooth = this.smooth ? ' smooth' : '';
        return `<Node (${this.x}, ${this.y}) ${this.nodetype}${smooth}>`;
    }
}

/**
 * Path (contour) in a layer
 */
export class Path extends ArrayElementBase<PathData, Layer | Shape> {
    /** Stable identifier for CRDT addressing. Generated on load; preserved across edits. */
    get id(): string | undefined {
        return this.data.id;
    }

    private _nodeWrappers: Node[] | null = null;

    private getMutableNodeArray(): Babelfont.Node[] {
        if (!Array.isArray(this.data.nodes)) {
            throw new TypeError('Path nodes must be arrays.');
        }
        return this.data.nodes;
    }

    private withLayerFingerprintChangeEvent<T>(fn: () => T): T {
        const layer = getPathOwningLayer(this);
        const previousFingerprint = layer?.fingerprint ?? null;
        const result = fn();
        dispatchLayerFingerprintChanged(layer, previousFingerprint);
        return result;
    }

    getPathSegment(): (string | number)[] {
        // When wrapped by Shape.asPath(), Shape already provides ['shapes', idx]
        if (this._parentObject instanceof Shape) return [];
        return ['shapes', this._index];
    }

    get nodes(): Node[] {
        const nodeArray = this.getMutableNodeArray();

        // Create wrapper objects if needed
        if (
            !this._nodeWrappers ||
            this._nodeWrappers.length !== nodeArray.length
        ) {
            this._nodeWrappers = nodeArray.map(
                (_: Babelfont.Node, i: number) => new Node(nodeArray, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._nodeWrappers!,
            'Path.nodes is a read-only collection view. Use appendNode(), insertNode(), or removeNode() for structural edits.'
        );
    }

    set nodes(value: Babelfont.Node[]) {
        assertModelMutationAllowed();
        this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const old = this.getMutableNodeArray().map((node) =>
                cloneNodeData(node)
            );
            this.data.nodes = value;
            this._nodeWrappers = null; // Invalidate cache
            recordGranularNodesChange(this.getPath(), old, value);
        });
    }

    get closed(): boolean {
        return !!this.data.closed;
    }

    set closed(value: boolean) {
        assertModelMutationAllowed();
        this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const old = this.data.closed;
            this.data.closed = value;
            recordAndMarkDirty(this, 'closed', old, value);
        });
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const old = this.data.format_specific;
            this.data.format_specific = value;
            recordAndMarkDirty(this, 'format_specific', old, value);
        });
    }

    /**
     * Whether this path subtracts from shapes below it (`fip001-boolean`).
     */
    get isSubtraction(): boolean {
        return pathHasSubtractionFlag(this.data.format_specific);
    }

    set isSubtraction(value: boolean) {
        assertModelMutationAllowed();
        if (this.isSubtraction === Boolean(value)) {
            return;
        }
        this.withLayerFingerprintChangeEvent(() => {
            withBridgeTransaction(
                value ? 'Subtract paths' : 'Clear path subtraction',
                () => {
                    setFormatSpecificKey(
                        this,
                        FIP001_BOOLEAN_KEY,
                        value ? FIP001_BOOLEAN_SUBTRACTION : undefined
                    );
                    const attr = {
                        ...(glyphsAttrFromFormatSpecific(
                            this.data.format_specific
                        ) || {})
                    };
                    if (value) {
                        attr[FIP001_BOOLEAN_KEY] = FIP001_BOOLEAN_SUBTRACTION;
                        setFormatSpecificKey(this, GLYPHS_ATTR_KEY, attr);
                    } else {
                        delete attr[FIP001_BOOLEAN_KEY];
                        setFormatSpecificKey(
                            this,
                            GLYPHS_ATTR_KEY,
                            Object.keys(attr).length > 0 ? attr : undefined
                        );
                    }
                }
            );
        });
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
        nodetype: Babelfont.NodeType = 'Line' as Babelfont.NodeType,
        smooth?: boolean
    ): Node {
        assertModelMutationAllowed();
        return this.withLayerFingerprintChangeEvent(() => {
            const nodeArray = this.getMutableNodeArray();
            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const nodeData: Babelfont.Node = {
                id: generateStableId(),
                x,
                y,
                nodetype
            };
            if (smooth !== undefined) {
                nodeData.smooth = smooth;
            }

            nodeArray.splice(index, 0, nodeData);
            this._nodeWrappers = null; // Invalidate cache
            recordGranularNodesChange(this.getPath(), oldNodes, nodeArray);
            return new Node(nodeArray, index, this);
        });
    }

    /**
     * Remove a node at the specified index
     * @example
     * path.removeNode(0)  # Remove first node
     */
    removeNode(index: number): void {
        assertModelMutationAllowed();
        this.withLayerFingerprintChangeEvent(() => {
            const nodeArray = this.getMutableNodeArray();
            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const removedNode = nodeArray[index];
            if (removedNode === undefined) {
                return;
            }

            nodeArray.splice(index, 1);
            this._nodeWrappers = null; // Invalidate cache
            recordGranularNodesChange(this.getPath(), oldNodes, nodeArray);
        });
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
        nodetype: Babelfont.NodeType = 'Line' as Babelfont.NodeType,
        smooth?: boolean
    ): Node {
        assertModelMutationAllowed();
        return this.insertNode(
            this.getMutableNodeArray().length,
            x,
            y,
            nodetype,
            smooth
        );
    }

    _addPoint(
        segmentId: number,
        t: number,
        roundCoordinates: boolean = false
    ): number | null {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            const descriptors = buildPathSegmentDescriptors({
                nodes: nodeArray,
                closed: this.closed
            });
            const descriptor = descriptors.find(
                (candidate) => candidate.segmentId === segmentId
            );

            if (!descriptor) {
                return null;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const mutation = buildInsertedSegmentNodeArray(
                nodeArray,
                descriptor,
                t,
                this.closed
            );
            if (roundCoordinates) {
                for (const node of mutation.nodes) {
                    node.x = Math.round(node.x);
                    node.y = Math.round(node.y);
                }
            }

            this.data.nodes = mutation.nodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, mutation.nodes);
            return mutation.insertedNodeIndex;
        });
    }

    _appendLine(
        point: { x: number; y: number },
        edge: 'start' | 'end' = 'end'
    ): number | null {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (
                !point ||
                !Number.isFinite(point.x) ||
                !Number.isFinite(point.y)
            ) {
                return null;
            }

            if (this.closed) {
                return null;
            }

            const nodeArray = this.getMutableNodeArray();
            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            let nextNodes: Babelfont.Node[];
            let insertedNodeIndex: number;

            if (!nodeArray.length) {
                nextNodes = [
                    {
                        x: point.x,
                        y: point.y,
                        nodetype: 'Move' as Babelfont.NodeType
                    }
                ];
                insertedNodeIndex = 0;
            } else if (edge === 'start') {
                nextNodes = [
                    {
                        x: point.x,
                        y: point.y,
                        nodetype: 'Move' as Babelfont.NodeType
                    },
                    cloneNodeData(nodeArray[0], {
                        nodetype: 'Line' as Babelfont.NodeType,
                        smooth: false
                    }),
                    ...nodeArray.slice(1).map((node) => cloneNodeData(node))
                ];
                insertedNodeIndex = 0;
            } else {
                nextNodes = [
                    ...nodeArray.map((node) => cloneNodeData(node)),
                    {
                        x: point.x,
                        y: point.y,
                        nodetype: 'Line' as Babelfont.NodeType
                    }
                ];
                insertedNodeIndex = nextNodes.length - 1;
            }

            this.data.nodes = nextNodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, nextNodes);
            return insertedNodeIndex;
        });
    }

    _closeOpenPath(): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (this.closed) {
                return false;
            }

            const nodeArray = this.getMutableNodeArray();
            if (nodeArray.length < 3) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const oldClosed = this.data.closed;
            const nextNodes = nodeArray.map((node) => cloneNodeData(node));

            const normalizedFirstNodeType =
                nextNodes[0].nodetype === 'Move'
                    ? nextNodes.length >= 4 &&
                      nextNodes[1]?.nodetype === 'OffCurve' &&
                      nextNodes[nextNodes.length - 1]?.nodetype !== 'OffCurve'
                        ? (nextNodes[nextNodes.length - 1]
                              ?.nodetype as Babelfont.NodeType)
                        : ('Line' as Babelfont.NodeType)
                    : nextNodes[0].nodetype;

            nextNodes[0] = cloneNodeData(nextNodes[0], {
                nodetype: normalizedFirstNodeType,
                smooth:
                    normalizedFirstNodeType === 'Line'
                        ? false
                        : Boolean(nextNodes[0].smooth)
            });

            this.data.nodes = nextNodes;
            this.data.closed = true;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, nextNodes);
            recordAndMarkDirty(this, 'closed', oldClosed, true);
            return true;
        });
    }

    /**
     * Close an open path by merging the last node into the first.
     * The last node is removed and the first node's type changes
     * from Move to Line. Exact reverse of _openClosedPathAtNode.
     */
    _closeOpenPathByMerge(): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (this.closed) {
                return false;
            }

            const nodeArray = this.getMutableNodeArray();
            if (nodeArray.length < 2) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const oldClosed = this.data.closed;

            const nextNodes = nodeArray
                .slice(0, -1)
                .map((node) => cloneNodeData(node));

            const normalizedNodes = normalizePathNodeArray(nextNodes, true);
            if (!normalizedNodes.length) {
                return false;
            }

            if (normalizedNodes[0].nodetype === 'Move') {
                normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
                    nodetype: 'Line' as Babelfont.NodeType,
                    smooth: false
                });
            } else if (normalizedNodes[0].smooth) {
                normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
                    smooth: false
                });
            }

            const finalizedNodes = promoteNodeToSmoothWhenEligible(
                normalizedNodes,
                0,
                true
            );

            this.data.nodes = finalizedNodes;
            this.data.closed = true;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, finalizedNodes);
            recordAndMarkDirty(this, 'closed', oldClosed, true);
            return true;
        });
    }

    /**
     * Open a closed path at the given on-curve node index.
     * The node is duplicated: one copy becomes the start (Move),
     * the other becomes the end. The overall shape is preserved.
     */
    _openClosedPathAtNode(nodeIndex: number): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (!this.closed) {
                return false;
            }

            const nodeArray = this.getMutableNodeArray();
            if (nodeArray.length < 3) {
                return false;
            }

            const targetNode = nodeArray[nodeIndex];
            if (
                !targetNode ||
                isOffCurveNodeType(targetNode.nodetype) ||
                targetNode.nodetype === 'Move'
            ) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const oldClosed = this.data.closed;

            const rotated = [
                ...nodeArray.slice(nodeIndex),
                ...nodeArray.slice(0, nodeIndex)
            ].map((node) => cloneNodeData(node));

            rotated[0] = cloneNodeData(rotated[0], {
                nodetype: 'Move' as Babelfont.NodeType,
                smooth: false
            });
            ensureNodeId(rotated[0]);
            const duplicatedBoundaryNode = cloneNodeData(nodeArray[nodeIndex], {
                id: generateStableId(),
                smooth: false
            });
            ensureNodeId(duplicatedBoundaryNode);
            rotated.push(duplicatedBoundaryNode);

            this.data.nodes = rotated;
            this.data.closed = false;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, rotated);
            recordAndMarkDirty(this, 'closed', oldClosed, false);
            return true;
        });
    }

    _splitOpenPathAtNode(nodeIndex: number): Babelfont.Path | null {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (this.closed) {
                return null;
            }

            const nodeArray = this.getMutableNodeArray();
            const splitNodes = splitOpenPathNodeArray(nodeArray, nodeIndex);
            if (!splitNodes) {
                return null;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            this.data.nodes = splitNodes.firstNodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(
                this.getPath(),
                oldNodes,
                splitNodes.firstNodes
            );

            return {
                nodes: splitNodes.secondNodes,
                closed: false
            };
        });
    }

    _setStartNode(nodeIndex: number): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (!this.closed) {
                return false;
            }

            const nodeArray = this.getMutableNodeArray();
            if (nodeArray.length < 2) {
                return false;
            }

            const targetNode = nodeArray[nodeIndex];
            if (
                !targetNode ||
                nodeIndex <= 0 ||
                isOffCurveNodeType(targetNode.nodetype)
            ) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));

            // Rotate the existing node objects (preserving ids)
            const rotated = [
                ...nodeArray.slice(nodeIndex),
                ...nodeArray.slice(0, nodeIndex)
            ];
            const nextNodes = normalizePathNodeArray(rotated, true);

            this.data.nodes = nextNodes;
            this._nodeWrappers = null;

            const basePath = this.getPath();
            recordGranularNodesChange(basePath, oldNodes, nextNodes);

            return true;
        });
    }

    _reverseDirection(): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            if (nodeArray.length < 2) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));

            const descriptors = buildPathSegmentDescriptors({
                nodes: nodeArray,
                closed: this.closed
            });
            if (!descriptors.length) {
                return false;
            }

            const reverseControlNodes = (descriptor: PathSegmentDescriptor) =>
                descriptor.controlNodeIndices
                    .slice()
                    .reverse()
                    .map((controlNodeIndex) =>
                        cloneNodeData(nodeArray[controlNodeIndex], {
                            nodetype: 'OffCurve' as Babelfont.NodeType
                        })
                    );

            const nextNodes: Babelfont.Node[] = [];

            if (this.closed) {
                const startDescriptorIndex = descriptors.findIndex(
                    (descriptor) => descriptor.endNodeIndex === 0
                );
                if (startDescriptorIndex < 0) {
                    return false;
                }

                const orderedDescriptors = Array.from(
                    { length: descriptors.length },
                    (_value, offset) =>
                        descriptors[
                            (startDescriptorIndex -
                                offset +
                                descriptors.length) %
                                descriptors.length
                        ]
                );

                nextNodes.push(cloneNodeData(nodeArray[0]));

                orderedDescriptors.forEach((descriptor, descriptorIndex) => {
                    nextNodes.push(...reverseControlNodes(descriptor));

                    if (descriptorIndex < orderedDescriptors.length - 1) {
                        nextNodes.push(
                            cloneNodeData(nodeArray[descriptor.startNodeIndex])
                        );
                    }
                });
            } else {
                const orderedDescriptors = descriptors.slice().reverse();
                const firstDescriptor = orderedDescriptors[0];

                nextNodes.push(
                    cloneNodeData(nodeArray[firstDescriptor.endNodeIndex], {
                        nodetype: 'Move' as Babelfont.NodeType,
                        smooth: false
                    })
                );

                for (const descriptor of orderedDescriptors) {
                    nextNodes.push(...reverseControlNodes(descriptor));
                    nextNodes.push(
                        cloneNodeData(nodeArray[descriptor.startNodeIndex])
                    );
                }
            }

            const normalizedNodes = normalizePathNodeArray(
                nextNodes,
                this.closed
            );
            if (!this.closed && normalizedNodes.length) {
                normalizedNodes[0] = cloneNodeData(normalizedNodes[0], {
                    nodetype: 'Move' as Babelfont.NodeType,
                    smooth: false
                });
            }

            this.data.nodes = normalizedNodes;
            this._nodeWrappers = null;

            const basePath = this.getPath();
            recordGranularNodesChange(basePath, oldNodes, normalizedNodes);

            return true;
        });
    }

    _convertLineSegmentToCurve(segmentId: number): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            const descriptors = buildPathSegmentDescriptors({
                nodes: nodeArray,
                closed: this.closed
            });
            const descriptor = descriptors.find(
                (candidate) => candidate.segmentId === segmentId
            );

            if (!descriptor || descriptor.type !== 'line') {
                return false;
            }

            const nextNodes = buildLineCurvedSegmentNodeArray(
                nodeArray,
                descriptor,
                this.closed
            );

            if (!nextNodes) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            this.data.nodes = nextNodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, nextNodes);
            return true;
        });
    }

    _canSlideSmoothOnCurve(nodeIndex: number): boolean {
        const nodeArray = this.getMutableNodeArray();
        const targetNode = nodeArray[nodeIndex];

        if (
            !targetNode ||
            isOffCurveNodeType(targetNode.nodetype) ||
            targetNode.nodetype === 'Move' ||
            !targetNode.smooth
        ) {
            return false;
        }

        const descriptors = buildPathSegmentDescriptors({
            nodes: nodeArray,
            closed: this.closed
        });
        const { leftDescriptor, rightDescriptor } = getAdjacentPathDescriptors(
            descriptors,
            nodeIndex
        );

        return (
            isCurveSegmentDescriptor(leftDescriptor) &&
            isCurveSegmentDescriptor(rightDescriptor)
        );
    }

    _slideSmoothOnCurve(
        nodeIndex: number,
        targetPoint: { x: number; y: number }
    ): { insertedNodeIndex: number; changed: boolean; t: number } | null {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const mutation = buildSmoothPointSlideMutation(
                nodeArray,
                nodeIndex,
                targetPoint,
                this.closed
            );

            if (!mutation) {
                return null;
            }

            const changed =
                JSON.stringify(oldNodes) !== JSON.stringify(mutation.nodes);

            if (!changed) {
                return {
                    insertedNodeIndex: mutation.insertedNodeIndex,
                    changed: false,
                    t: mutation.t
                };
            }

            this.data.nodes = mutation.nodes;
            this._nodeWrappers = null;

            recordGranularNodesChange(this.getPath(), oldNodes, mutation.nodes);
            return {
                insertedNodeIndex: mutation.insertedNodeIndex,
                changed,
                t: mutation.t
            };
        });
    }

    _slideSmoothOnCurveAtT(
        nodeIndex: number,
        t: number
    ): { insertedNodeIndex: number; changed: boolean; t: number } | null {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            const mutation = buildSmoothPointSlideMutationAtT(
                nodeArray,
                nodeIndex,
                t,
                this.closed
            );

            if (!mutation) {
                return null;
            }

            const changed =
                JSON.stringify(oldNodes) !== JSON.stringify(mutation.nodes);

            if (!changed) {
                return {
                    insertedNodeIndex: mutation.insertedNodeIndex,
                    changed: false,
                    t: mutation.t
                };
            }

            this.data.nodes = mutation.nodes;
            this._nodeWrappers = null;

            recordGranularNodesChange(this.getPath(), oldNodes, mutation.nodes);
            return {
                insertedNodeIndex: mutation.insertedNodeIndex,
                changed,
                t: mutation.t
            };
        });
    }

    /**
     * Delete a node and merge/adjust adjacent segments accordingly.
     * This is the reverse operation of _addPoint.
     * @param nodeIndex - Index of the node to delete
     * @returns true if deletion was successful, false otherwise
     */
    _deleteNode(nodeIndex: number): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            if (nodeIndex < 0 || nodeIndex >= nodeArray.length) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));

            const mergedNodes = deleteNodeFromNodeArray(
                nodeArray,
                nodeIndex,
                this.closed
            );

            if (!mergedNodes) {
                return false;
            }

            this.data.nodes = mergedNodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, mergedNodes);
            return true;
        });
    }

    _deleteNodes(nodeIndices: number[]): boolean {
        return this.withLayerFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const nodeArray = this.getMutableNodeArray();
            const validNodeIndices = [...new Set(nodeIndices)]
                .filter(
                    (nodeIndex) =>
                        Number.isInteger(nodeIndex) &&
                        nodeIndex >= 0 &&
                        nodeIndex < nodeArray.length
                )
                .sort((left, right) => right - left);

            if (!validNodeIndices.length) {
                return false;
            }

            const oldNodes = nodeArray.map((node) => cloneNodeData(node));
            let trackedNodes: BatchTrackedNode[] = nodeArray.map(
                (node, index) => ({
                    ...cloneNodeData(node),
                    __batchDeleteOrigins: [index]
                })
            );
            let changed = false;

            for (const originalIndex of validNodeIndices) {
                const currentIndex = trackedNodes.findIndex((node) =>
                    node.__batchDeleteOrigins?.includes(originalIndex)
                );

                if (currentIndex === -1) {
                    continue;
                }

                const nextNodes = deleteNodeFromNodeArray(
                    trackedNodes,
                    currentIndex,
                    this.closed
                ) as BatchTrackedNode[] | null;

                if (!nextNodes) {
                    continue;
                }

                trackedNodes = nextNodes;
                changed = true;
            }

            if (!changed) {
                return false;
            }

            const mergedNodes = stripBatchDeleteTracking(trackedNodes);
            this.data.nodes = mergedNodes;
            this._nodeWrappers = null;
            recordGranularNodesChange(this.getPath(), oldNodes, mergedNodes);
            return true;
        });
    }

    toString(): string {
        const closedStr = this.closed ? 'closed' : 'open';
        const nodeCount = this.getMutableNodeArray().length;
        return `<Path ${closedStr} ${nodeCount} nodes>`;
    }
}

/**
 * Component reference to another glyph
 */
export class Component extends ArrayElementBase<ComponentData, Shape> {
    /** Stable identifier for CRDT addressing. Generated on load; preserved across edits. */
    get id(): string | undefined {
        return this.data.id;
    }

    getPathSegment(): (string | number)[] {
        // When wrapped by Shape.asComponent(), Shape already provides ['shapes', idx]
        if (this._parentObject instanceof Shape) return [];
        return ['shapes', this._index];
    }

    /** Whether this component is selected in the active outline editor. */
    get selected(): boolean {
        const outlineEditor = getOutlineEditorSelectionController();
        const layer = getLayerForSelectableObject(this);
        const shapeIndex = getPathIndex(this, 'shapes');
        if (
            !outlineEditor ||
            !layer ||
            shapeIndex === null ||
            !isLayerActiveInOutlineEditor(layer, outlineEditor)
        ) {
            return false;
        }

        return (outlineEditor.selectedComponents || []).includes(shapeIndex);
    }

    set selected(value: boolean) {
        assertModelMutationAllowed();
        const layer = getLayerForSelectableObject(this);
        if (!layer) {
            return;
        }

        const currentSelection = layer.selection;
        if (value) {
            layer.selection = [...currentSelection, this];
            return;
        }

        layer.selection = currentSelection.filter(
            (item) => !areSameModelObject(item, this)
        );
    }

    get reference(): string {
        return this.data.reference;
    }

    set reference(value: string) {
        assertModelMutationAllowed();
        const old = this.data.reference;
        this.data.reference = value;
        recordAndMarkDirty(this, 'reference', old, value);
        // Invalidate reverse component index when component reference changes
        const shape = this.parent();
        const layer = shape instanceof Shape ? shape.parent() : null;
        const glyph = layer instanceof Layer ? layer.parent() : null;
        const font =
            glyph instanceof Glyph ? (glyph.parent() as Font | null) : null;
        if (
            font &&
            typeof font.invalidateReverseComponentIndex === 'function'
        ) {
            font.invalidateReverseComponentIndex();
        }
    }

    /**
     * Decomposed affine: `translation` [x, y], `scale` [x, y],
     * `rotation` (degrees), `skew` [x, y], `order` (`Glyphs` or
     * `RestOfTheWorld`).
     * @example
     * component.transform.translation = [10, 0]
     */
    get transform(): Babelfont.DecomposedAffine {
        return getLiveMutableValue(
            this,
            'transform',
            this.data.transform,
            () => this.data.transform
        );
    }

    set transform(value: Babelfont.DecomposedAffine) {
        assertModelMutationAllowed();
        const old = this.data.transform;
        this.data.transform = value;
        recordAndMarkDirty(this, 'transform', old, value);
    }

    /**
     * Variable-component location. Access axis tags as attributes
     * (`component.location.wght`).
     */
    get location(): DesignspaceLocation | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: DesignspaceLocation | undefined) {
        assertModelMutationAllowed();
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    /**
     * Glyphs attachment anchor name stored in format_specific.
     */
    get anchor(): string | undefined {
        const value =
            getModelFormatSpecific(this)?.[GLYPHS_COMPONENT_ANCHOR_KEY];
        return typeof value === 'string' ? value : undefined;
    }

    set anchor(value: string | undefined) {
        assertModelMutationAllowed();
        const trimmed = value?.trim();
        setFormatSpecificKey(
            this,
            GLYPHS_COMPONENT_ANCHOR_KEY,
            trimmed ? trimmed : undefined
        );
        getLayerForSelectableObject(this)?.invalidateLayoutCache();
    }

    /**
     * Returns whether every component in the containing layer explicitly opts
     * into Glyphs automatic alignment.
     */
    isAutomaticAligned(): boolean {
        const layer = getLayerForSelectableObject(this);
        return layer
            ? layer.isAutomaticAlignedLayer()
            : hasExplicitAutomaticComponentAlignment(this);
    }

    /**
     * Whether this component explicitly opts into Glyphs automatic alignment.
     * Unlike isAutomaticAligned(), this is per-component metadata and does not
     * depend on the rest of its containing layer.
     */
    get automaticAlignment(): boolean {
        return hasExplicitAutomaticComponentAlignment(this);
    }

    set automaticAlignment(value: boolean) {
        assertModelMutationAllowed();
        const nextValue = value ? 1 : -1;
        if (
            this.format_specific?.[GLYPHS_COMPONENT_ALIGNMENT_KEY] === nextValue
        ) {
            return;
        }
        this.format_specific = {
            ...(this.format_specific || {}),
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: nextValue
        };
        const layer = getLayerForSelectableObject(this);
        layer?.invalidateLayoutCache();
        if (value) {
            layer?.assignAutomaticCompositeKerningGroups();
        }
    }

    /**
     * Returns whether this component itself carries Glyphs' explicit manual
     * alignment metadata, independent of the layer's effective state.
     */
    hasExplicitManualAlignment(): boolean {
        return hasExplicitManualComponentAlignment(this);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Convert transform to affine matrix array [a, b, c, d, e, f]
     * Uses the proper DecomposedAffineTransform utility
     */
    toAffineArray(): number[] {
        return DecomposedAffineTransform.toAffine(
            this.transform || DecomposedAffineTransform.identity()
        );
    }

    toString(): string {
        const transform = this.transform
            ? ` transform=${JSON.stringify(this.transform)}`
            : '';
        return `<Component ref="${this.reference}"${transform}>`;
    }

    /**
     * Replace this component with its recursively flattened outlines in place.
     * Nested components are expanded with accumulated transforms. Returns the
     * number of paths inserted, or `None` if the component is not on a layer.
     * @example
     * count = component.decompose()
     */
    decompose(): number | null {
        assertModelMutationAllowed();
        // Component -> Shape -> Layer
        const shape = this.parent() as Shape;
        const layer = shape?.parent() as Layer;
        if (!shape || !layer) {
            return null;
        }

        const shapes = layer.shapes;
        if (!shapes) {
            return null;
        }
        const index = shapes.findIndex((candidate) =>
            areSameModelObject(candidate, shape)
        );
        if (index < 0) {
            return null;
        }

        const pathShapes = this.getTransformedPaths()
            .filter(
                (path) => Array.isArray(path.nodes) && path.nodes.length > 0
            )
            .map((path) => flattenedPathToStoredShape(path));

        layer.removeShape(index);
        for (let pathOffset = 0; pathOffset < pathShapes.length; pathOffset++) {
            layer.insertShapeAt(index + pathOffset, pathShapes[pathOffset]);
        }
        return pathShapes.length;
    }

    /**
     * Get all paths from this component with transforms applied recursively
     * Automatically determines the correct master by walking up the parent chain
     * @returns Array of transformed path data objects
     */
    getTransformedPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];
        const componentTransform =
            this.transform ||
            ({
                translation: [0, 0],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0]
            } as Babelfont.DecomposedAffine);

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

        // Helper to transform a node
        const transformNode = (node: Unsafe, transform: number[]): Unsafe => {
            const [a, b, c, d, tx, ty] = transform;
            const result: Unsafe = {
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

        const componentLayer =
            layer.getMatchingLayerOnGlyph(this.reference) ??
            componentGlyph.layers[0];
        if (!componentLayer) return paths;

        // Process shapes from the component layer
        if (componentLayer.shapes) {
            for (const shape of componentLayer.shapes) {
                if (shape.isComponent()) {
                    // Recursively get paths from nested components
                    const nestedComponent = shape.asComponent();
                    const nestedPaths = nestedComponent.getTransformedPaths();

                    // Apply this component's transform to all nested paths
                    const transformArray =
                        DecomposedAffineTransform.toAffine(componentTransform);
                    for (const nestedPath of nestedPaths) {
                        const transformedNodes = nestedPath.nodes.map(
                            (node: Unsafe) =>
                                transformNode(node, transformArray)
                        );
                        paths.push({
                            nodes: transformedNodes,
                            closed: nestedPath.closed
                        });
                    }
                } else if (shape.isPath()) {
                    // Transform the path nodes
                    const pathData = shape.asPath().toJSON();
                    const nodes = pathData.nodes;

                    if (Array.isArray(nodes) && nodes.length > 0) {
                        const transformArray =
                            DecomposedAffineTransform.toAffine(
                                componentTransform
                            );
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transformArray)
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
export class Anchor extends ArrayElementBase<AnchorData, Layer> {
    /** Stable identifier for CRDT addressing. Generated on load; preserved across edits. */
    get id(): string | undefined {
        return this.data.id;
    }

    getPathSegment(): (string | number)[] {
        return ['anchors', this._index];
    }

    /** Whether this anchor is selected in the active outline editor. */
    get selected(): boolean {
        const outlineEditor = getOutlineEditorSelectionController();
        const layer = this.parent();
        const anchorIndex = getPathIndex(this, 'anchors');
        if (
            !outlineEditor ||
            !(layer instanceof Layer) ||
            anchorIndex === null ||
            !isLayerActiveInOutlineEditor(layer, outlineEditor)
        ) {
            return false;
        }

        return (outlineEditor.selectedAnchors || []).includes(anchorIndex);
    }

    set selected(value: boolean) {
        assertModelMutationAllowed();
        const layer = this.parent();
        if (!(layer instanceof Layer)) {
            return;
        }

        const currentSelection = layer.selection;
        if (value) {
            layer.selection = [...currentSelection, this];
            return;
        }

        layer.selection = currentSelection.filter(
            (item) => !areSameModelObject(item, this)
        );
    }

    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        assertModelMutationAllowed();
        const old = this.data.x;
        this.data.x = value;
        recordAndMarkDirty(this, 'x', old, value);
        const layer = getLayerForSelectableObject(this);
        layer?.invalidateLayoutCache();
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        assertModelMutationAllowed();
        const old = this.data.y;
        this.data.y = value;
        recordAndMarkDirty(this, 'y', old, value);
        const layer = getLayerForSelectableObject(this);
        layer?.invalidateLayoutCache();
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Anchor${name} (${this.x}, ${this.y})>`;
    }
}

/**
 * Guideline in a layer or master
 */
export class Guide extends ArrayElementBase<GuideData, Layer | Master> {
    /** Stable identifier for CRDT addressing. Generated on load; preserved across edits. */
    get id(): string | undefined {
        return this.data.id;
    }

    getPathSegment(): (string | number)[] {
        return ['guides', this._index];
    }

    /** Whether this guide is selected in the active outline editor. */
    get selected(): boolean {
        const outlineEditor = getOutlineEditorSelectionController();
        const guideIndex = getPathIndex(this, 'guides');
        const parent = this.parent();
        if (!outlineEditor || guideIndex === null) {
            return false;
        }

        const selectedGuide = outlineEditor.selectedGuideHandle;
        if (!selectedGuide) {
            return false;
        }

        if (parent instanceof Layer) {
            return (
                selectedGuide.scope === 'layer' &&
                selectedGuide.index === guideIndex &&
                isLayerActiveInOutlineEditor(parent, outlineEditor)
            );
        }

        if (parent instanceof Master) {
            return (
                selectedGuide.scope === 'master' &&
                selectedGuide.index === guideIndex &&
                isMasterActiveInOutlineEditor(parent, outlineEditor)
            );
        }

        return false;
    }

    set selected(value: boolean) {
        assertModelMutationAllowed();
        const outlineEditor = getOutlineEditorSelectionController();
        const guideIndex = getPathIndex(this, 'guides');
        const parent = this.parent();

        if (guideIndex === null) {
            return;
        }

        if (!value) {
            if (this.selected && outlineEditor) {
                outlineEditor.selectedGuideHandle = null;
                refreshOutlineEditorSelectionUi(outlineEditor);
            }
            return;
        }

        if (!outlineEditor) {
            throw new Error(
                'Cannot update UI selection while outline editing is inactive.'
            );
        }

        if (parent instanceof Layer) {
            if (!isLayerActiveInOutlineEditor(parent, outlineEditor)) {
                throw new Error(
                    'Cannot update selection on a layer that is not the active outline-editor layer.'
                );
            }

            outlineEditor.selectedPoints = [];
            outlineEditor.selectedAnchors = [];
            outlineEditor.selectedComponents = [];
            outlineEditor.selectedSidebearingHandle = null;
            outlineEditor.selectedGuideHandle = {
                scope: 'layer',
                index: guideIndex
            };
            refreshOutlineEditorSelectionUi(outlineEditor);
            return;
        }

        if (parent instanceof Master) {
            if (!isMasterActiveInOutlineEditor(parent, outlineEditor)) {
                throw new Error(
                    'Cannot update selection on a master guide that is not active in the outline editor.'
                );
            }

            outlineEditor.selectedPoints = [];
            outlineEditor.selectedAnchors = [];
            outlineEditor.selectedComponents = [];
            outlineEditor.selectedSidebearingHandle = null;
            outlineEditor.selectedGuideHandle = {
                scope: 'master',
                index: guideIndex
            };
            refreshOutlineEditorSelectionUi(outlineEditor);
        }
    }

    /**
     * Guide position: `x`, `y`, optional `angle` in degrees.
     * @example
     * guide.pos.y = 700
     */
    get pos(): Babelfont.Position {
        return getLiveMutableValue(
            this,
            'pos',
            this.data.pos,
            () => this.data.pos
        );
    }

    set pos(value: Babelfont.Position) {
        assertModelMutationAllowed();
        const old = this.data.pos;
        this.data.pos = value;
        recordAndMarkDirty(this, 'pos', old, value);
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    /**
     * RGBA color channels `r`, `g`, `b`, `a`.
     */
    get color(): Babelfont.Color | undefined {
        return getLiveMutableValue(
            this,
            'color',
            this.data.color,
            () => this.data.color
        );
    }

    set color(value: Babelfont.Color | undefined) {
        assertModelMutationAllowed();
        const old = this.data.color;
        this.data.color = value;
        recordAndMarkDirty(this, 'color', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
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
    getPathSegment(): (string | number)[] {
        return ['shapes', this._index];
    }

    /**
     * Check if this shape is a component
     */
    isComponent(): boolean {
        // Handle both nested {Component: {...}} and flat {reference: ...} formats
        return 'Component' in this.data || 'reference' in this.data;
    }

    /**
     * Check if this shape is a path
     */
    isPath(): boolean {
        // Handle both nested {Path: {...}} and flat {nodes: ...} formats
        return 'Path' in this.data || 'nodes' in this.data;
    }

    /**
     * Get as Component (throws if not a component)
     */
    asComponent(): Component {
        if (!this.isComponent()) {
            throw new Error('Shape is not a Component');
        }
        // Handle both nested {Component: {...}} and flat {reference: ...} formats
        const componentData =
            'Component' in this.data ? this.data.Component : this.data;
        // Create a fake array with single element to satisfy Component's constructor
        const fakeArray = [componentData];
        Object.defineProperty(fakeArray, '0', {
            get: () =>
                'Component' in this.data ? this.data.Component : this.data,
            set: (value) => {
                assertModelMutationAllowed();
                if ('Component' in this.data) {
                    this.data.Component = value;
                } else {
                    // Update the entire shape data for flat format
                    Object.assign(this.data, value);
                }
            }
        });
        return new Component(fakeArray as Unsafe, 0, this);
    }

    /**
     * Get as Path (throws if not a path)
     */
    asPath(): Path {
        if (!this.isPath()) {
            throw new Error('Shape is not a Path');
        }
        // Handle both nested {Path: {...}} and flat {nodes: ...} formats
        const pathData = 'Path' in this.data ? this.data.Path : this.data;
        // Create a fake array with single element to satisfy Path's constructor
        const fakeArray = [pathData];
        Object.defineProperty(fakeArray, '0', {
            get: () => ('Path' in this.data ? this.data.Path : this.data),
            set: (value) => {
                assertModelMutationAllowed();
                if ('Path' in this.data) {
                    this.data.Path = value;
                } else {
                    // Update the entire shape data for flat format
                    Object.assign(this.data, value);
                }
            }
        });
        return new Path(fakeArray as Unsafe, 0, this);
    }

    toString(): string {
        if (this.isComponent()) {
            return `<Shape:${this.asComponent().toString()}>`;
        } else if (this.isPath()) {
            return `<Shape:${this.asPath().toString()}>`;
        }
        return '<Shape Unsafe>';
    }
}

/**
 * Layer in a glyph representing a master or intermediate design
 */
export class Layer extends ArrayElementBase {
    private _shapeWrappers: Shape[] | null = null;
    private _anchorWrappers: Anchor[] | null = null;
    private _guideWrappers: Guide[] | null = null;
    private _virtualBackgroundOwner: Layer | null = null;
    private _cachedLayout: AutomaticCompositionLayout | null | undefined =
        undefined;

    /**
     * Resting / Yjs / editor representation of this layer.
     *
     * Automatic `=+/-=` offsets stay logical here: component translates are
     * unoffset and width already includes the adjustments. Never bake offsets
     * into this view — that double-applies after Yjs round-trips. Use
     * {@link toCompileJSON} at the Rust/compile/export/preview boundary.
     */
    toJSON(): Unsafe {
        return super.toJSON() as Unsafe;
    }

    /**
     * Compile-facing serialization: applies automatic `=+/-=` left offsets to
     * component translates so fontc / worker preview see physical ink and
     * advance. Must not be written back into the resting model or Yjs.
     */
    toCompileJSON(): Unsafe {
        const data = this.toJSON();
        if (!this.isAutomaticAlignedLayer()) {
            return data;
        }

        const leftAdjustment = this.getAutomaticSidebearingAdjustment('left');
        const rightAdjustment = this.getAutomaticSidebearingAdjustment('right');
        if (!leftAdjustment && !rightAdjustment) {
            return data;
        }

        const layout = this.getAutomaticCompositionLayout();
        if (!layout) {
            return data;
        }

        const layerData = cloneForHistory(data);
        const shapes = (layerData.shapes || []) as Unsafe[];
        const components = this.components;

        for (let index = 0; index < components.length; index++) {
            const placement = layout.placements[index];
            const shape = shapes[index];
            if (!placement || !shape) {
                continue;
            }

            const shapeData = (
                'Component' in shape ? shape.Component : shape
            ) as Unsafe;
            if (!shapeData || !('reference' in shapeData)) {
                continue;
            }

            const translationX = roundMetricValue(
                placement.translationX + leftAdjustment
            );
            const translationY = roundMetricValue(placement.translationY);
            const currentTransform = shapeData.transform;
            if (Array.isArray(currentTransform)) {
                const affine = Array.from(
                    DecomposedAffineTransform.toAffine(
                        getAutomaticComponentTransform(components[index])
                    )
                );
                affine[4] = translationX;
                affine[5] = translationY;
                shapeData.transform = affine;
            } else {
                shapeData.transform = {
                    ...getAutomaticComponentTransform(components[index]),
                    translation: [translationX, translationY]
                };
            }
        }

        layerData.width = this.getAutomaticCompositionDerivedWidth(layout);
        return layerData;
    }

    /**
     * Force shape wrapper rebuild on next access.
     * Call after replacing `data.shapes` externally so that
     * setDirectSidebearing operates on the current shapes array.
     */
    invalidateShapeCache(): void {
        this._shapeWrappers = null;
    }

    invalidateContentCaches(): void {
        this._shapeWrappers = null;
        this._anchorWrappers = null;
        this._guideWrappers = null;
        this._cachedLayout = undefined;
    }

    /**
     * Invalidate only the automatic composition layout cache.
     * Cheaper than full invalidateContentCaches() when only
     * anchor/composition state has changed (not shapes/guides).
     */
    invalidateLayoutCache(): void {
        this._cachedLayout = undefined;
    }

    getAutomaticCompositionSourceCacheKey(): object {
        return this.data as object;
    }

    /**
     * Bulk-sync mutable properties from the outline editor's working
     * copy into this layer's model data. Skips the expensive toJSON()
     * round-trip and layout recomputation that would otherwise occur
     * for automatic-aligned layers.
     *
     * Must be called inside withSuppressedModelRecording so that the
     * individual property mutations don't trigger recordAndMarkDirty.
     */
    syncFromEditorLayerData(layerData: {
        width: number;
        height?: number;
        vertWidth?: number;
        shapes?: Unsafe[];
        anchors?: Unsafe[];
        guides?: Unsafe[];
        format_specific?: Record<string, Unsafe>;
    }): void {
        assertModelMutationAllowed();
        const sanitized = toRestingLayerJson(layerData, {
            existing: this.data,
            mode: 'delta',
            allowWrapped: true,
            context: 'model writeback'
        });
        if (typeof sanitized.width === 'number') {
            this.data.width = sanitized.width;
        }
        if (sanitized.height !== undefined) {
            this.data.height = sanitized.height;
        }
        if (sanitized.vertWidth !== undefined) {
            this.data.vertWidth = sanitized.vertWidth;
        }
        if (sanitized.shapes !== undefined) {
            this.data.shapes = sanitized.shapes;
        }
        if (sanitized.anchors !== undefined) {
            this.data.anchors = sanitized.anchors;
        }
        if (sanitized.guides !== undefined) {
            this.data.guides = sanitized.guides;
        }
        if (sanitized.format_specific !== undefined) {
            this.data.format_specific = sanitized.format_specific;
        }
        this.invalidateContentCaches();
    }

    private withFingerprintChangeEvent<T>(fn: () => T): T {
        const previousFingerprint = this.fingerprint;
        const result = fn();
        dispatchLayerFingerprintChanged(this, previousFingerprint);
        // Invalidate reverse component index on any structural shape change
        const glyph = this.parent();
        const font =
            glyph instanceof Glyph ? (glyph.parent() as Font | null) : null;
        if (
            font &&
            typeof font.invalidateReverseComponentIndex === 'function'
        ) {
            font.invalidateReverseComponentIndex();
        }
        return result;
    }

    private static normalizeSignatureNodeType(
        nodeType: string | undefined
    ): string {
        switch (nodeType) {
            case 'Move':
                // Open-path endpoints can round-trip as either Move or Line
                // while remaining structurally equivalent for interpolation and
                // linked-layer compatibility purposes.
                return 'Line';
            case 'Line':
            case 'OffCurve':
            case 'Curve':
            case 'QCurve':
                return nodeType;
            default:
                return String(nodeType || 'Unknown');
        }
    }

    private getSelectionSnapshotFromOutlineEditor(
        outlineEditor: OutlineEditorSelectionController
    ): SelectableLayerObject[] {
        if (!isLayerActiveInOutlineEditor(this, outlineEditor)) {
            return [];
        }

        const selection: SelectableLayerObject[] = [];
        const shapes = this.shapes || [];
        const anchors = this.anchors || [];
        const guides = this.guides || [];

        for (const point of outlineEditor.selectedPoints || []) {
            const shape = shapes[point.contourIndex];
            if (!shape?.isPath()) {
                continue;
            }

            const node = shape.asPath().nodes[point.nodeIndex];
            if (node) {
                selection.push(node);
            }
        }

        for (const anchorIndex of outlineEditor.selectedAnchors || []) {
            const anchor = anchors[anchorIndex];
            if (anchor) {
                selection.push(anchor);
            }
        }

        for (const componentIndex of outlineEditor.selectedComponents || []) {
            const shape = shapes[componentIndex];
            if (shape?.isComponent()) {
                selection.push(shape.asComponent());
            }
        }

        if (outlineEditor.selectedGuideHandle?.scope === 'layer') {
            const guide = guides[outlineEditor.selectedGuideHandle.index];
            if (guide) {
                selection.push(guide);
            }
        }

        return selection;
    }

    private normalizeSelectionInput(
        value:
            SelectableLayerObject | SelectableLayerObject[] | null | undefined
    ): SelectableLayerObject[] {
        const normalized =
            value === null || value === undefined
                ? []
                : Array.isArray(value)
                  ? value
                  : [value];

        const dedupedSelection: SelectableLayerObject[] = [];
        const seenPaths = new Set<string>();

        for (const item of normalized) {
            if (
                !(item instanceof Node) &&
                !(item instanceof Anchor) &&
                !(item instanceof Component) &&
                !(item instanceof Guide)
            ) {
                throw new Error(
                    'Layer.selection only accepts nodes, anchors, components, and layer guides.'
                );
            }

            const objectLayer = getLayerForSelectableObject(item);
            if (!objectLayer || !areSameModelObject(objectLayer, this)) {
                throw new Error(
                    'Layer.selection can only contain objects that belong to this layer.'
                );
            }

            if (item instanceof Guide && !(item.parent() instanceof Layer)) {
                throw new Error(
                    'Layer.selection only accepts layer guides, not master guides.'
                );
            }

            const objectPath = item.getPath().join('/');
            if (seenPaths.has(objectPath)) {
                continue;
            }

            seenPaths.add(objectPath);
            dedupedSelection.push(item);
        }

        const guideCount = dedupedSelection.filter(
            (item) => item instanceof Guide
        ).length;
        if (guideCount > 1) {
            throw new Error('Layer.selection can contain at most one guide.');
        }

        if (guideCount === 1 && dedupedSelection.length > 1) {
            throw new Error(
                'Guide selection cannot be combined with nodes, anchors, or components.'
            );
        }

        return dedupedSelection;
    }

    private applySelectionToOutlineEditor(
        selection: SelectableLayerObject[]
    ): void {
        const outlineEditor = assertOutlineEditorSelectionMutationAllowed(
            this,
            getOutlineEditorSelectionController(),
            selection
        );

        if (!outlineEditor) {
            return;
        }

        const selectedPoints: OutlineEditorSelectionPoint[] = [];
        const selectedAnchors: number[] = [];
        const selectedComponents: number[] = [];
        let selectedGuideHandle: OutlineEditorGuideHandle | null = null;

        for (const item of selection) {
            if (item instanceof Node) {
                const contourIndex = getPathIndex(item, 'shapes');
                const nodeIndex = getPathIndex(item, 'nodes');
                if (contourIndex === null || nodeIndex === null) {
                    continue;
                }

                selectedPoints.push({ contourIndex, nodeIndex });
                continue;
            }

            if (item instanceof Anchor) {
                const anchorIndex = getPathIndex(item, 'anchors');
                if (anchorIndex !== null) {
                    selectedAnchors.push(anchorIndex);
                }
                continue;
            }

            if (item instanceof Component) {
                const componentIndex = getPathIndex(item, 'shapes');
                if (componentIndex !== null) {
                    selectedComponents.push(componentIndex);
                }
                continue;
            }

            if (item instanceof Guide) {
                const guideIndex = getPathIndex(item, 'guides');
                if (guideIndex !== null) {
                    selectedGuideHandle = { scope: 'layer', index: guideIndex };
                }
            }
        }

        outlineEditor.selectedPoints = selectedPoints;
        outlineEditor.selectedAnchors = selectedAnchors;
        outlineEditor.selectedComponents = selectedComponents;
        outlineEditor.selectedGuideHandle = selectedGuideHandle;
        outlineEditor.selectedSidebearingHandle = null;
        refreshOutlineEditorSelectionUi(outlineEditor);
    }

    _getSelectionSnapshotForPython(): SelectableLayerObject[] {
        const outlineEditor = getOutlineEditorSelectionController();
        return outlineEditor
            ? this.getSelectionSnapshotFromOutlineEditor(outlineEditor)
            : [];
    }

    _setSelectionFromPython(
        value:
            SelectableLayerObject | SelectableLayerObject[] | null | undefined
    ): void {
        this.applySelectionToOutlineEditor(this.normalizeSelectionInput(value));
    }

    private getFilteredShapes<T extends Path | Component>(
        predicate: (shape: Shape) => boolean,
        mapper: (shape: Shape) => T,
        errorMessage: string
    ): T[] {
        const shapes = this.shapes || [];
        const filteredShapes = shapes.filter(predicate).map(mapper);
        return getReadOnlyCollectionValue(filteredShapes, errorMessage);
    }

    private getFont(): Font | undefined {
        const glyph = this.parent() as Glyph;
        return glyph?.parent() as Font | undefined;
    }

    private getGlyphName(): string | null {
        return (this.parent() as Glyph | undefined)?.name || null;
    }

    private getLocalSidebearingKey(side: SidebearingSide): string | undefined {
        return normalizeMetricsKeyValue(
            getModelFormatSpecific(this)?.[
                getLayerMetricFormatSpecificKey(side)
            ] as string | undefined
        );
    }

    private setLocalSidebearingKey(
        side: SidebearingSide,
        value: string | undefined
    ): void {
        // The metrics-key dependency graph is cached; any key write invalidates it.
        this.getFont()?.invalidateMetricsKeyDependencyEntries?.();
        setFormatSpecificKey(
            this,
            getLayerMetricFormatSpecificKey(side),
            value
        );
    }

    private hasLocalSidebearingKey(side: SidebearingSide): boolean {
        return this.getLocalSidebearingKey(side) !== undefined;
    }

    private getEffectiveSidebearingKey(
        side: SidebearingSide
    ): string | undefined {
        return (
            this.getLocalSidebearingKey(side) ??
            this.getGlobalSidebearingKey(side)
        );
    }

    clearEffectiveSidebearingKey(side: SidebearingSide): void {
        if (this.hasLocalSidebearingKey(side)) {
            this.setLocalSidebearingKey(side, undefined);
            return;
        }

        const glyph = this.parent() as Glyph;
        if (!glyph) {
            return;
        }

        if (side === 'left') {
            glyph.leftMetricsKey = undefined;
        } else {
            glyph.rightMetricsKey = undefined;
        }
    }

    private setEffectiveSidebearingKey(
        side: SidebearingSide,
        value: string | undefined,
        forceLocal = false
    ): void {
        const normalizedValue = normalizeMetricsKeyValue(value);
        const glyph = this.parent() as Glyph;

        if (forceLocal) {
            this.setLocalSidebearingKey(side, normalizedValue);
            return;
        }

        if (this.hasLocalSidebearingKey(side)) {
            this.setLocalSidebearingKey(side, undefined);
        }

        if (!glyph) {
            return;
        }

        if (side === 'left') {
            glyph.leftMetricsKey = normalizedValue;
        } else {
            glyph.rightMetricsKey = normalizedValue;
        }
    }

    private getDirectSidebearing(side: SidebearingSide): number {
        if (side === 'left') {
            const bbox = this.getBoundingBox(false);
            if (!bbox) {
                return 0;
            }
            return roundMetricValue(bbox.minX);
        }

        const bbox = this.getBoundingBox(false);
        if (!bbox) {
            return roundMetricValue(this.width);
        }
        return roundMetricValue(this.width - bbox.maxX);
    }

    setDirectSidebearing(side: SidebearingSide, value: number): void {
        if (side === 'left') {
            const currentLsb = this.getDirectSidebearing('left');
            const currentRsb = this.getDirectSidebearing('right');
            const offset = value - currentLsb;

            if (offset === 0) {
                return;
            }

            const layerData = this.toJSON();
            const oldShapes = cloneForHistory(layerData.shapes || []);
            const oldAnchors = cloneForHistory(layerData.anchors || []);
            const oldWidth = layerData.width;

            withSuppressedMetricsKeyRecompute(() => {
                withSuppressedModelRecording(() => {
                    translateLayerContentsX(
                        {
                            shapes: this.shapes || [],
                            anchors: this.anchors || [],
                            getPathNodes: (shape) =>
                                shape.isPath() ? shape.asPath().nodes : null,
                            getOrCreateComponentTransform: (shape) => {
                                if (!shape.isComponent()) {
                                    return null;
                                }

                                const component = shape.asComponent();
                                if (!component.transform) {
                                    component.transform =
                                        DecomposedAffineTransform.identity();
                                } else if (Array.isArray(component.transform)) {
                                    component.transform =
                                        DecomposedAffineTransform.fromAffine(
                                            component.transform
                                        );
                                }
                                return component.transform;
                            },
                            shiftAnchor: (anchor, deltaX) => {
                                anchor.x += deltaX;
                            }
                        },
                        offset
                    );

                    const bbox = this.getBoundingBox(false);
                    this.width = bbox
                        ? roundMetricValue(
                              roundMetricValue(bbox.maxX) + currentRsb
                          )
                        : roundMetricValue(value + currentRsb);
                });

                this.translateMaterializedBackgroundLayerContentsX(offset);

                recordLayerShapesGeometryChange(
                    this.getPath(),
                    oldShapes,
                    cloneForHistory(layerData.shapes || [])
                );
                if (oldAnchors.length || (layerData.anchors || []).length) {
                    recordAndMarkDirty(
                        this,
                        'anchors',
                        oldAnchors,
                        cloneForHistory(layerData.anchors || [])
                    );
                }
                recordAndMarkDirty(this, 'width', oldWidth, layerData.width);
            });
            return;
        }

        const bbox = this.getBoundingBox(false);
        const oldWidth = this.toJSON().width;
        if (!bbox) {
            this.toJSON().width = roundMetricValue(value);
        } else {
            this.toJSON().width = roundMetricValue(
                roundMetricValue(bbox.maxX) + value
            );
        }
        recordAndMarkDirty(this, 'width', oldWidth, this.toJSON().width);
    }

    /**
     * Keep an existing background drawing aligned with a foreground X shift.
     * Virtual empty backgrounds remain unmaterialized and are intentionally ignored.
     */
    translateMaterializedBackgroundLayerContentsX(deltaX: number): void {
        if (this.is_background || deltaX === 0 || !this.background_layer_id) {
            return;
        }

        const background = (this.parent() as Glyph | null)?.findLayerById(
            this.background_layer_id
        );
        if (
            !background?.is_background ||
            ((!background.shapes || background.shapes.length === 0) &&
                (!background.anchors || background.anchors.length === 0))
        ) {
            return;
        }

        const backgroundData = background.toJSON();
        const oldShapes = cloneForHistory(backgroundData.shapes || []);
        const oldAnchors = cloneForHistory(backgroundData.anchors || []);

        withSuppressedModelRecording(() => {
            translateLayerContentsX(
                {
                    shapes: background.shapes || [],
                    anchors: background.anchors || [],
                    getPathNodes: (shape) =>
                        shape.isPath() ? shape.asPath().nodes : null,
                    getOrCreateComponentTransform: (shape) => {
                        if (!shape.isComponent()) {
                            return null;
                        }

                        const component = shape.asComponent();
                        if (!component.transform) {
                            component.transform =
                                DecomposedAffineTransform.identity();
                        } else if (Array.isArray(component.transform)) {
                            component.transform =
                                DecomposedAffineTransform.fromAffine(
                                    component.transform
                                );
                        }
                        return component.transform;
                    },
                    shiftAnchor: (anchor, offset) => {
                        anchor.x += offset;
                    }
                },
                deltaX
            );
        });

        recordLayerShapesGeometryChange(
            background.getPath(),
            oldShapes,
            cloneForHistory(backgroundData.shapes || [])
        );
        if (oldAnchors.length || (backgroundData.anchors || []).length) {
            recordAndMarkDirty(
                background,
                'anchors',
                oldAnchors,
                cloneForHistory(backgroundData.anchors || [])
            );
        }
    }

    /**
     * Resolve and apply this layer's own metrics keys (left/right)
     * without scanning the full font. Use during interactive editing
     * (keyboard/mouse) where only the current layer needs updating.
     */
    recomputeOwnMetricsKeys(): boolean {
        const glyph = this.parent() as Glyph | undefined;
        if (!glyph) return false;

        let changed = false;
        for (const side of ['left', 'right'] as SidebearingSide[]) {
            const key =
                side === 'left'
                    ? this.leftMetricsKey || glyph.leftMetricsKey
                    : this.rightMetricsKey || glyph.rightMetricsKey;
            if (!key) continue;

            const resolution = this.resolveMetricsKey(side);
            const applied = getAppliedMetricsKeySidebearing(
                this,
                side,
                resolution
            );
            const currentValue = side === 'left' ? this.lsb : this.rsb;
            if (
                applied.error ||
                applied.value === null ||
                Math.abs(currentValue - applied.value) <= METRIC_UPDATE_EPSILON
            ) {
                continue;
            }

            if (this.isAutomaticAlignedLayer()) {
                changed = true;
                continue;
            }

            this.setDirectSidebearing(side, applied.value);
            changed = true;
        }
        return changed;
    }

    isAutomaticAlignedLayer(): boolean {
        const shapes = this.shapes || [];
        if (shapes.length === 0) {
            return false;
        }

        const components = shapes.filter((shape) => shape.isComponent());
        if (components.length === 0 || components.length !== shapes.length) {
            return false;
        }

        return components.every((shape) =>
            hasExplicitAutomaticComponentAlignment(shape.asComponent())
        );
    }

    /**
     * In-memory preflight for migrating manual composites. The composition
     * engine must be able to place every component, and the result must match
     * stored translations and width. Eligible layouts today: unattached
     * non-mark bases (including ligatures, using LTR kerning between them),
     * two or more components where every non-base attaches by anchors, or a
     * single component whose referenced glyph is not a mark (Unicode general
     * category does not start with M). Does not mutate the layer.
     */
    matchesAutomaticCompositionPreflight(
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>
    ): boolean {
        if (this.isAutomaticAlignedLayer()) {
            return true;
        }

        const layout = this.getAutomaticCompositionEligibilityLayout(
            sourceDataCache,
            { allowUnattachedStandaloneComponents: true }
        );
        if (!layout) {
            return false;
        }

        const components = this.components;
        for (let index = 0; index < components.length; index++) {
            const placement = layout.placements[index];
            if (!placement) {
                return false;
            }

            const transform = getAutomaticComponentTransform(components[index]);
            const currentX = transform.translation?.[0] ?? 0;
            const currentY = transform.translation?.[1] ?? 0;
            if (
                Math.abs(currentX - placement.translationX) >
                    METRIC_UPDATE_EPSILON ||
                Math.abs(currentY - placement.translationY) >
                    METRIC_UPDATE_EPSILON
            ) {
                return false;
            }
        }

        const nextWidth = this.getAutomaticCompositionDerivedWidth(layout);
        return (
            Math.abs(roundMetricValue(this.width) - nextWidth) <=
            METRIC_UPDATE_EPSILON
        );
    }

    /**
     * Whether the composition engine can place this component-only layer.
     * Convert preflight and adding a component also allow unattached non-mark
     * bases (ligatures). Later unattached bases must still be non-marks.
     */
    private getAutomaticCompositionEligibilityLayout(
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>,
        options?: { allowUnattachedStandaloneComponents?: boolean }
    ): AutomaticCompositionLayout | null {
        if (this.is_background) {
            return null;
        }

        const shapes = this.shapes || [];
        const components = this.components;
        if (components.length === 0 || components.length !== shapes.length) {
            return null;
        }
        if (
            components.length === 1 &&
            !this.referencedGlyphIsAutomaticStandaloneCategory(components[0])
        ) {
            return null;
        }

        for (const component of components) {
            if (!this.getAutomaticComponentLayer(component)) {
                return null;
            }
        }

        const layout = this.getAutomaticCompositionLayout(sourceDataCache, {
            allowManualComponents: true
        });
        if (!layout || layout.placements.length !== components.length) {
            return null;
        }

        const allowUnattachedStandalone =
            options?.allowUnattachedStandaloneComponents === true;
        for (let index = 0; index < components.length; index++) {
            const placement = layout.placements[index];
            if (!placement) {
                return null;
            }
            if (placement.hasAttachment) {
                continue;
            }
            if (index === 0 && !allowUnattachedStandalone) {
                continue;
            }
            if (index > 0 && !allowUnattachedStandalone) {
                return null;
            }
            if (
                index > 0 &&
                !this.referencedGlyphIsAutomaticStandaloneCategory(
                    components[index]
                )
            ) {
                return null;
            }
        }

        return layout;
    }

    private enableAutomaticCompositionIfEligible(): void {
        if (
            !this.getAutomaticCompositionEligibilityLayout(undefined, {
                allowUnattachedStandaloneComponents: true
            })
        ) {
            return;
        }

        for (const component of this.components) {
            if (!component.automaticAlignment) {
                component.automaticAlignment = true;
            }
        }

        this.rebuildAutomaticComposition();
        const glyphName = this.getGlyphName();
        if (glyphName) {
            this.getFont()?.recomputeMetricsKeys(new Set([glyphName]));
        }
    }

    /**
     * Whether this component's referenced glyph may stand alone as an
     * automatic one-component composite under the current category rules.
     */
    private referencedGlyphIsAutomaticStandaloneCategory(
        component: Component
    ): boolean {
        const referenced = this.getFont()?.findGlyph(component.reference);
        return isAutomaticStandaloneComponentCategory(
            referenced?.glyphData?.general_category
        );
    }

    /**
     * Copy kerning groups from resolved automatic bases onto this glyph.
     * Invoked only when enabling automatic alignment makes the layer automatic.
     */
    assignAutomaticCompositeKerningGroups(): boolean {
        if (!this.isAutomaticAlignedLayer()) {
            return false;
        }

        const font = this.getFont();
        const glyphName = this.getGlyphName();
        if (!font || !glyphName) {
            return false;
        }

        let changed = false;
        for (const side of ['left', 'right'] as const) {
            const terminal = this.resolveAutomaticKerningGroupTerminal(
                side,
                new Set()
            );
            if (!terminal?.name) {
                continue;
            }

            if (
                assignAutomaticCompositeKerningGroupsForSide(
                    font,
                    glyphSideToKerningGroupPairSide(side),
                    terminal.name,
                    glyphName
                )
            ) {
                changed = true;
            }
        }

        return changed;
    }

    private collectAutomaticBaseGlyphNames(): string[] {
        if (!this.isAutomaticAlignedLayer()) {
            return [];
        }

        const layout = this.getAutomaticCompositionLayout();
        if (!layout) {
            return [];
        }

        const baseGlyphNames: string[] = [];
        const components = this.components;
        for (let index = 0; index < components.length; index++) {
            const component = components[index];
            const placement = layout.placements[index];
            if (
                !placement ||
                placement.attached ||
                !component.reference ||
                !this.getAutomaticComponentLayer(component)
            ) {
                continue;
            }
            baseGlyphNames.push(component.reference);
        }

        return baseGlyphNames;
    }

    private resolveAutomaticKerningGroupTerminal(
        side: 'left' | 'right',
        visited: Set<string>
    ): Glyph | null {
        const glyph = this.parent() as Glyph | undefined;
        if (!glyph?.name) {
            return null;
        }
        if (visited.has(glyph.name)) {
            return glyph;
        }
        visited.add(glyph.name);

        if (!this.isAutomaticAlignedLayer()) {
            return glyph;
        }

        const bases = this.collectAutomaticBaseGlyphNames();
        if (bases.length === 0) {
            return glyph;
        }

        const baseName = side === 'left' ? bases[0] : bases[bases.length - 1];
        const font = this.getFont();
        const baseGlyph = font?.findGlyph(baseName);
        if (!baseGlyph) {
            return glyph;
        }

        const baseLayer =
            this.getMatchingLayerOnGlyph(baseName) ?? baseGlyph.layers?.[0];
        if (!baseLayer?.isAutomaticAlignedLayer()) {
            return baseGlyph;
        }

        return (
            baseLayer.resolveAutomaticKerningGroupTerminal(side, visited) ??
            baseGlyph
        );
    }

    private getAutomaticComponentLayer(
        component: Component
    ): Layer | undefined {
        return (
            this.getMatchingLayerOnGlyph(component.reference) ??
            this.getFont()?.findGlyph(component.reference)?.layers?.[0]
        );
    }

    private collectOwnNamedAnchors(): ComputedAnchorMap {
        const anchors: ComputedAnchorMap = {};
        for (const anchor of this.anchors || []) {
            if (!anchor.name) {
                continue;
            }
            anchors[anchor.name] = {
                x: roundMetricValue(anchor.x),
                y: roundMetricValue(anchor.y)
            };
        }
        return anchors;
    }

    private hasStoredIncomingAttachmentAnchors(): boolean {
        return (this.anchors || []).some((anchor) =>
            isAutomaticAttachmentAnchor(anchor.name)
        );
    }

    private collectComputedAnchors(visited: Set<string>): ComputedAnchorMap {
        const glyphName = this.getGlyphName();
        if (glyphName && visited.has(glyphName)) {
            return {};
        }

        // A layer that already stores attachment anchors (`_top`, `_bottom`,
        // …) is a complete composition source. Nested components are drawings
        // (dotbelow-ar → dotabove-ar) and must not contribute `_top` / `top`.
        if (this.hasStoredIncomingAttachmentAnchors()) {
            return {};
        }

        const nextVisited = new Set(visited);
        if (glyphName) {
            nextVisited.add(glyphName);
        }

        const computed: ComputedAnchorMap = {};
        for (const component of this.components) {
            const referencedLayer = this.getAutomaticComponentLayer(component);
            if (!referencedLayer) {
                continue;
            }

            const { affine } = parseAutomaticCompositionAffine(
                getAutomaticComponentTransform(component)
            );
            const nested: ComputedAnchorMap = {
                ...referencedLayer.collectComputedAnchors(nextVisited),
                ...referencedLayer.collectOwnNamedAnchors()
            };
            for (const [name, point] of Object.entries(nested)) {
                const position = transformPointWithAffine(
                    affine,
                    point.x,
                    point.y
                );
                computed[name] = {
                    x: roundMetricValue(position.x),
                    y: roundMetricValue(position.y)
                };
            }
        }
        return computed;
    }

    private getAutomaticComponentAnchorChoices(
        incomingAnchorName: string,
        availableAnchors: Map<string, AutomaticCompositionAnchorPoint>,
        overrideAnchorName?: string
    ): string[] {
        const family = getAutomaticAnchorFamily(incomingAnchorName);
        if (!family) {
            return [];
        }

        const matchingAnchorNames = [...availableAnchors.keys()].filter(
            (anchorName) => getAutomaticAnchorFamily(anchorName) === family
        );
        if (matchingAnchorNames.length <= 1) {
            return matchingAnchorNames;
        }

        const exactFamilyName = family;
        const ordered = matchingAnchorNames.sort((left, right) => {
            if (left === overrideAnchorName) {
                return -1;
            }
            if (right === overrideAnchorName) {
                return 1;
            }
            if (left === exactFamilyName) {
                return -1;
            }
            if (right === exactFamilyName) {
                return 1;
            }
            return left.localeCompare(right);
        });

        return ordered;
    }

    private resolveAutomaticComponentAttachment(
        sourceData: AutomaticCompositionSourceData,
        availableAnchors: Map<string, AutomaticCompositionAnchorPoint>,
        overrideAnchorName?: string
    ): AutomaticCompositionAttachment | null {
        const chainedBaseEntryAnchor = sourceData.chainedBaseEntryAnchor;
        if (chainedBaseEntryAnchor) {
            const chainedBaseTargetAnchor = availableAnchors.get(
                CHAINED_BASE_EXIT_ANCHOR
            );
            if (chainedBaseTargetAnchor) {
                return {
                    sourceAnchor: chainedBaseEntryAnchor,
                    targetAnchorName: CHAINED_BASE_EXIT_ANCHOR,
                    targetAnchor: chainedBaseTargetAnchor,
                    kind: 'chained-base'
                };
            }
        }

        for (const incomingAnchor of sourceData.incomingAnchors) {
            if (!incomingAnchor.name) {
                continue;
            }

            const choices = this.getAutomaticComponentAnchorChoices(
                incomingAnchor.name,
                availableAnchors,
                overrideAnchorName
            );
            if (choices.length === 0) {
                continue;
            }

            const preferredTargetName =
                overrideAnchorName && choices.includes(overrideAnchorName)
                    ? overrideAnchorName
                    : choices[0];
            const targetAnchor = availableAnchors.get(preferredTargetName);
            if (!targetAnchor) {
                continue;
            }

            return {
                sourceAnchor: incomingAnchor,
                targetAnchorName: preferredTargetName,
                targetAnchor,
                kind: 'mark'
            };
        }

        return null;
    }

    private getAutomaticCompositionSourceData(
        componentLayer: Layer,
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>
    ): AutomaticCompositionSourceData {
        const cacheKey = componentLayer.getAutomaticCompositionSourceCacheKey();
        const cachedSourceData = sourceDataCache?.get(cacheKey);
        if (cachedSourceData) {
            return cachedSourceData;
        }

        const outgoingAnchors: AutomaticCompositionSourceAnchor[] = [];
        const incomingAnchors: AutomaticCompositionSourceAnchor[] = [];
        let chainedBaseEntryAnchor: AutomaticCompositionSourceAnchor | null =
            null;

        const mergedAnchors = new Map<
            string,
            AutomaticCompositionSourceAnchor
        >();
        for (const [name, point] of Object.entries(
            componentLayer.computedAnchors()
        )) {
            mergedAnchors.set(name, {
                name,
                x: point.x,
                y: point.y
            });
        }
        for (const anchor of componentLayer.anchors || []) {
            if (!anchor.name) {
                continue;
            }
            mergedAnchors.set(anchor.name, {
                name: anchor.name,
                x: anchor.x,
                y: anchor.y
            });
        }

        for (const anchorData of mergedAnchors.values()) {
            if (isChainedBaseEntryAnchor(anchorData.name)) {
                chainedBaseEntryAnchor = anchorData;
            }

            if (isAutomaticAttachmentAnchor(anchorData.name)) {
                incomingAnchors.push(anchorData);
                continue;
            }

            outgoingAnchors.push(anchorData);
        }

        const sourceData: AutomaticCompositionSourceData = {
            shapes: componentLayer.toJSON().shapes,
            width: componentLayer.width,
            incomingAnchors,
            outgoingAnchors,
            chainedBaseEntryAnchor
        };

        sourceDataCache?.set(cacheKey, sourceData);
        return sourceData;
    }

    private collectAutomaticComponentAnchors(
        sourceData: AutomaticCompositionSourceData,
        componentTransform: number[]
    ): AutomaticCompositionAnchorPoint[] {
        const anchorPoints: AutomaticCompositionAnchorPoint[] = [];
        for (const anchor of sourceData.outgoingAnchors) {
            if (!anchor.name || isAutomaticAttachmentAnchor(anchor.name)) {
                continue;
            }

            const position = transformPointWithAffine(
                componentTransform,
                anchor.x,
                anchor.y
            );
            anchorPoints.push({
                name: anchor.name,
                x: position.x,
                y: position.y
            });
        }

        return anchorPoints;
    }

    private setComponentTranslation(
        component: Component,
        translationX: number,
        translationY: number
    ): boolean {
        const transform = getAutomaticComponentTransform(component);
        const currentX = transform.translation?.[0] ?? 0;
        const currentY = transform.translation?.[1] ?? 0;
        if (
            Math.abs(currentX - translationX) <= METRIC_UPDATE_EPSILON &&
            Math.abs(currentY - translationY) <= METRIC_UPDATE_EPSILON
        ) {
            return false;
        }

        component.transform = {
            ...transform,
            translation: [
                roundMetricValue(translationX),
                roundMetricValue(translationY)
            ]
        };
        return true;
    }

    private computeAutomaticCompositionLayoutFromInputs(
        inputs: AutomaticCompositionComponentInput[],
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>
    ): AutomaticCompositionLayout | null {
        if (inputs.length === 0) {
            return null;
        }

        const availableAnchors = new Map<
            string,
            AutomaticCompositionAnchorPoint
        >();
        const placements: AutomaticCompositionPlacement[] = [];
        let baseBounds: AutomaticCompositionLayout['baseBounds'] = null;
        let baseAdvanceWidth = 0;
        let baseAdvanceCursor = 0;
        let baseAdvanceMinX: number | null = null;
        let baseAdvanceMaxX: number | null = null;
        const leftAdjustment = this.getAutomaticSidebearingAdjustment('left');
        const font = this.getFont();
        const kerningMaster = this.getKerningMasterForComposition();
        let previousUnattachedBaseReference: string | null = null;

        for (const input of inputs) {
            const componentLayer = input.reference
                ? (this.getMatchingLayerOnGlyph(input.reference) ??
                  this.getFont()?.findGlyph(input.reference)?.layers?.[0])
                : undefined;
            if (!componentLayer) {
                placements.push({
                    translationX: 0,
                    translationY: 0,
                    attached: false,
                    hasAttachment: false
                });
                continue;
            }

            const sourceData = this.getAutomaticCompositionSourceData(
                componentLayer,
                sourceDataCache
            );

            const originalTransform = [...input.originalTransform];
            const baseTransform = [...originalTransform];
            baseTransform[4] = 0;
            baseTransform[5] = 0;

            const attachment = this.resolveAutomaticComponentAttachment(
                sourceData,
                availableAnchors,
                input.overrideAnchorName
            );

            let stickyFirstBaseX = originalTransform[4];
            if (
                baseAdvanceCursor === 0 &&
                Math.abs(leftAdjustment) > METRIC_UPDATE_EPSILON &&
                Math.abs(stickyFirstBaseX - leftAdjustment) <=
                    METRIC_UPDATE_EPSILON
            ) {
                stickyFirstBaseX = 0;
            }
            const isUnattachedBase = !attachment;
            const kerningDelta =
                isUnattachedBase &&
                previousUnattachedBaseReference &&
                input.reference &&
                font &&
                kerningMaster
                    ? resolveKerningValueForGlyphPair(
                          kerningMaster.kerning,
                          previousUnattachedBaseReference,
                          input.reference,
                          font.first_kern_groups,
                          font.second_kern_groups
                      )
                    : 0;
            let translationX =
                baseAdvanceCursor === 0
                    ? stickyFirstBaseX
                    : roundMetricValue(baseAdvanceCursor + kerningDelta);
            let translationY = originalTransform[5];
            let attached = false;
            const contributesBaseMetrics =
                !attachment || attachment.kind === 'chained-base';

            if (attachment) {
                const sourcePosition = transformPointWithAffine(
                    baseTransform,
                    attachment.sourceAnchor.x,
                    attachment.sourceAnchor.y
                );
                translationX = attachment.targetAnchor.x - sourcePosition.x;
                translationY = attachment.targetAnchor.y - sourcePosition.y;
                attached = attachment.kind === 'mark';
            }

            placements.push({
                translationX: roundMetricValue(translationX),
                translationY: roundMetricValue(translationY),
                attached,
                hasAttachment: Boolean(attachment)
            });

            if (isUnattachedBase && input.reference) {
                previousUnattachedBaseReference = input.reference;
            }

            const appliedTransform = [...baseTransform];
            appliedTransform[4] = translationX;
            appliedTransform[5] = translationY;

            if (contributesBaseMetrics) {
                const componentShapes = sourceData.shapes;
                if (componentShapes) {
                    const componentBounds = Layer.calculateShapeBounds(
                        componentShapes,
                        appliedTransform
                    );
                    if (componentBounds) {
                        baseBounds = baseBounds
                            ? {
                                  minX: Math.min(
                                      baseBounds.minX,
                                      componentBounds.minX
                                  ),
                                  minY: Math.min(
                                      baseBounds.minY,
                                      componentBounds.minY
                                  ),
                                  maxX: Math.max(
                                      baseBounds.maxX,
                                      componentBounds.maxX
                                  ),
                                  maxY: Math.max(
                                      baseBounds.maxY,
                                      componentBounds.maxY
                                  ),
                                  width: 0,
                                  height: 0
                              }
                            : { ...componentBounds };
                    }
                }

                const advanceStart = transformPointWithAffine(
                    appliedTransform,
                    0,
                    0
                );
                const advanceEnd = transformPointWithAffine(
                    appliedTransform,
                    sourceData.width,
                    0
                );
                const advanceMin = Math.min(advanceStart.x, advanceEnd.x);
                const advanceMax = Math.max(advanceStart.x, advanceEnd.x);

                baseAdvanceMinX =
                    baseAdvanceMinX === null
                        ? advanceMin
                        : Math.min(baseAdvanceMinX, advanceMin);
                baseAdvanceMaxX =
                    baseAdvanceMaxX === null
                        ? advanceMax
                        : Math.max(baseAdvanceMaxX, advanceMax);
                baseAdvanceCursor = roundMetricValue(
                    Math.max(baseAdvanceCursor, advanceMax)
                );
                baseAdvanceWidth = roundMetricValue(
                    (baseAdvanceMaxX ?? 0) - (baseAdvanceMinX ?? 0)
                );
            }

            for (const anchorPoint of this.collectAutomaticComponentAnchors(
                sourceData,
                appliedTransform
            )) {
                availableAnchors.set(anchorPoint.name, anchorPoint);
            }
        }

        if (baseBounds) {
            baseBounds.width = baseBounds.maxX - baseBounds.minX;
            baseBounds.height = baseBounds.maxY - baseBounds.minY;
        }

        return {
            placements,
            baseBounds,
            baseAdvanceWidth: roundMetricValue(baseAdvanceWidth)
        };
    }

    private getAutomaticCompositionInputsFromComponents(): AutomaticCompositionComponentInput[] {
        return this.components.map((component) => {
            const { affine } = parseAutomaticCompositionAffine(
                getAutomaticComponentTransform(component)
            );
            return {
                reference: component.reference ?? null,
                originalTransform: affine,
                overrideAnchorName: component.anchor
            };
        });
    }

    private getAutomaticCompositionLayout(
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>,
        options?: { allowManualComponents?: boolean }
    ): AutomaticCompositionLayout | null {
        const allowManualComponents = options?.allowManualComponents === true;
        if (!allowManualComponents) {
            if (this._cachedLayout !== undefined) {
                return this._cachedLayout;
            }

            if (!this.isAutomaticAlignedLayer()) {
                this._cachedLayout = null;
                return null;
            }
        }

        const components = this.components;
        const shapes = this.shapes || [];
        if (
            components.length === 0 ||
            (allowManualComponents && components.length !== shapes.length)
        ) {
            if (!allowManualComponents) {
                this._cachedLayout = null;
            }
            return null;
        }

        const layout = this.computeAutomaticCompositionLayoutFromInputs(
            this.getAutomaticCompositionInputsFromComponents(),
            sourceDataCache
        );
        if (!allowManualComponents) {
            this._cachedLayout = layout;
        }
        return layout;
    }

    private getAutomaticSidebearingAdjustment(side: SidebearingSide): number {
        const glyph = this.parent() as Glyph | undefined;
        const layerFormatSpecific = this.data.format_specific as
            Record<string, Unsafe> | undefined;
        const glyphFormatSpecific = (glyph as Unsafe)?._data
            ?.format_specific as Record<string, Unsafe> | undefined;
        const key = normalizeMetricsKeyValue(
            (layerFormatSpecific?.[getLayerMetricFormatSpecificKey(side)] as
                string | undefined) ??
                (glyphFormatSpecific?.[
                    getGlyphMetricFormatSpecificKey(side)
                ] as string | undefined)
        );
        const font = this.getFont();
        if (!key || !font || !isAutomaticSidebearingOverrideKey(key)) {
            return 0;
        }

        const parsed = parseMetricsKey(font, key);
        if ('error' in parsed || parsed.kind !== 'automatic-offset') {
            return 0;
        }

        return parsed.delta;
    }

    private getAutomaticCompositionDerivedWidth(
        layout: AutomaticCompositionLayout
    ): number {
        return roundMetricValue(
            layout.baseAdvanceWidth +
                this.getAutomaticSidebearingAdjustment('left') +
                this.getAutomaticSidebearingAdjustment('right')
        );
    }

    getAutomaticComponentTargetAnchorOptions(component: Component): string[] {
        if (!this.isAutomaticAlignedLayer()) {
            return [];
        }

        const components = this.components;
        const targetIndex = components.findIndex((item) =>
            areSameModelObject(item, component)
        );
        if (targetIndex < 0) {
            return [];
        }

        const layout = this.getAutomaticCompositionLayout();
        if (!layout) {
            return [];
        }

        const availableAnchors = new Map<
            string,
            AutomaticCompositionAnchorPoint
        >();

        for (let index = 0; index < targetIndex; index++) {
            const currentComponent = components[index];
            const componentLayer =
                this.getAutomaticComponentLayer(currentComponent);
            const placement = layout.placements[index];
            if (!componentLayer || !placement) {
                continue;
            }

            const { affine } = parseAutomaticCompositionAffine(
                getAutomaticComponentTransform(currentComponent)
            );
            affine[4] = placement.translationX;
            affine[5] = placement.translationY;

            const sourceData =
                this.getAutomaticCompositionSourceData(componentLayer);

            for (const anchorPoint of this.collectAutomaticComponentAnchors(
                sourceData,
                affine
            )) {
                availableAnchors.set(anchorPoint.name, anchorPoint);
            }
        }

        const componentLayer = this.getAutomaticComponentLayer(component);
        if (!componentLayer) {
            return [];
        }

        const sourceData =
            this.getAutomaticCompositionSourceData(componentLayer);
        for (const incomingAnchor of sourceData.incomingAnchors) {
            if (!incomingAnchor.name) {
                continue;
            }

            const choices = this.getAutomaticComponentAnchorChoices(
                incomingAnchor.name,
                availableAnchors,
                component.anchor
            );
            if (choices.length > 0) {
                return choices;
            }
        }

        return [];
    }

    rebuildAutomaticComposition(
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>
    ): boolean {
        const layout = this.getAutomaticCompositionLayout(sourceDataCache);
        if (!layout) {
            return false;
        }

        let changed = false;
        const components = this.components;
        for (let index = 0; index < components.length; index++) {
            const placement = layout.placements[index];
            if (!placement) {
                continue;
            }

            if (
                this.setComponentTranslation(
                    components[index],
                    placement.translationX,
                    placement.translationY
                )
            ) {
                changed = true;
            }
        }

        const nextWidth = this.getAutomaticCompositionDerivedWidth(layout);
        if (Math.abs(this.width - nextWidth) > METRIC_UPDATE_EPSILON) {
            this.width = nextWidth;
            changed = true;
        }

        return changed;
    }

    /**
     * Apply automatic component anchoring and derived width to mutable layer
     * data without mutating the model layer itself.
     *
     * This is used by live editor interactions, such as resize-box scaling,
     * where component transforms are already edited on a working copy and only
     * the automatic translations and width need to be refreshed.
     */
    applyAutomaticCompositionToLayerData(
        layerData: {
            shapes?: Unsafe[];
            width?: number;
        },
        sourceDataCache?: WeakMap<object, AutomaticCompositionSourceData>
    ): boolean {
        if (
            !this.isAutomaticAlignedLayer() ||
            !Array.isArray(layerData.shapes)
        ) {
            return false;
        }

        const parsed = this.parseLayerDataCompositionInputs(layerData.shapes);
        if (!parsed) {
            return false;
        }

        const layout = this.computeAutomaticCompositionLayoutFromInputs(
            parsed.inputs,
            sourceDataCache
        );
        if (!layout || layout.placements.length !== parsed.entries.length) {
            return false;
        }

        let changed = false;
        for (let index = 0; index < parsed.entries.length; index++) {
            const entry = parsed.entries[index];
            const placement = layout.placements[index];
            if (!placement) {
                continue;
            }

            if (
                Math.abs(entry.originalAffine[4] - placement.translationX) >
                    METRIC_UPDATE_EPSILON ||
                Math.abs(entry.originalAffine[5] - placement.translationY) >
                    METRIC_UPDATE_EPSILON
            ) {
                changed = true;
            }

            const appliedTransform = [...entry.originalAffine];
            appliedTransform[4] = placement.translationX;
            appliedTransform[5] = placement.translationY;
            entry.componentData.transform = entry.usesArrayTransform
                ? appliedTransform
                : DecomposedAffineTransform.fromAffine(appliedTransform);
        }

        const nextWidth = this.getAutomaticCompositionDerivedWidth(layout);
        if (
            layerData.width === undefined ||
            Math.abs(layerData.width - nextWidth) > METRIC_UPDATE_EPSILON
        ) {
            layerData.width = nextWidth;
            changed = true;
        }

        return changed;
    }

    private parseLayerDataCompositionInputs(shapes: Unsafe[]): {
        inputs: AutomaticCompositionComponentInput[];
        entries: {
            componentData: Unsafe;
            originalAffine: number[];
            usesArrayTransform: boolean;
        }[];
    } | null {
        const entries: {
            componentData: Unsafe;
            originalAffine: number[];
            usesArrayTransform: boolean;
        }[] = [];
        const inputs: AutomaticCompositionComponentInput[] = [];

        for (const shape of shapes) {
            if (
                !shape ||
                typeof shape !== 'object' ||
                !('reference' in shape || 'Component' in shape)
            ) {
                return null;
            }

            const componentData = (
                'Component' in shape ? shape.Component : shape
            ) as Unsafe;
            const { affine, usesArrayTransform } =
                parseAutomaticCompositionAffine(componentData.transform);
            const overrideAnchorName =
                typeof componentData.format_specific?.[
                    GLYPHS_COMPONENT_ANCHOR_KEY
                ] === 'string'
                    ? (componentData.format_specific[
                          GLYPHS_COMPONENT_ANCHOR_KEY
                      ] as string)
                    : undefined;

            entries.push({
                componentData,
                originalAffine: affine,
                usesArrayTransform
            });
            inputs.push({
                reference:
                    typeof componentData.reference === 'string'
                        ? componentData.reference
                        : null,
                originalTransform: affine,
                overrideAnchorName
            });
        }

        if (entries.length === 0) {
            return null;
        }

        return { inputs, entries };
    }

    private getPrimaryAutoAlignedComponentLayer(): Layer | undefined {
        const firstComponentShape = (this.shapes || []).find((shape) =>
            shape.isComponent()
        );
        if (!firstComponentShape) {
            return undefined;
        }

        const reference = firstComponentShape.asComponent().reference;
        if (!reference) {
            return undefined;
        }

        return this.getMetricsReferenceLayerOnGlyph(reference);
    }

    private getAutomaticDerivedSidebearing(
        side: SidebearingSide
    ): number | null {
        const layout = this.getAutomaticCompositionLayout();
        if (!layout) {
            return null;
        }

        const baseBounds = layout.baseBounds;
        const automaticWidth = layout.baseAdvanceWidth;
        if (!baseBounds) {
            return side === 'left' ? 0 : automaticWidth;
        }

        return side === 'left'
            ? roundMetricValue(baseBounds.minX)
            : roundMetricValue(automaticWidth - baseBounds.maxX);
    }

    private getEffectiveDesignspaceLocation(): DesignspaceLocation | undefined {
        if (this.location && Object.keys(this.location).length > 0) {
            return this.location;
        }

        const font = this.getFont();
        const masterId = this.getMasterId();
        if (!font || !masterId) {
            return undefined;
        }

        return font.findMaster(masterId)?.location;
    }

    private getMetricsReferenceLayerOnGlyph(
        glyphName: string
    ): Layer | undefined {
        return this.getMatchingLayerOnGlyph(glyphName);
    }

    resolveMetricsKey(
        side: SidebearingSide,
        stack: Set<string> = new Set()
    ): MetricsKeyResolution {
        const input = this.getEffectiveSidebearingKey(side);
        if (!input) {
            return {
                input: '',
                value: this.getDirectSidebearing(side),
                error: null,
                referencedGlyphNames: [],
                isLocal: false
            };
        }

        const font = this.getFont();
        if (!font) {
            return {
                input,
                value: null,
                error: 'Layer is not attached to a font',
                referencedGlyphNames: [],
                isLocal: this.hasLocalSidebearingKey(side)
            };
        }

        const cycleKey = `${(this.parent() as Glyph)?.name || ''}:${this.id || ''}:${side}`;
        if (stack.has(cycleKey)) {
            return {
                input,
                value: null,
                error: 'Metrics key cycle detected',
                referencedGlyphNames: [],
                isLocal: this.hasLocalSidebearingKey(side)
            };
        }

        stack.add(cycleKey);

        try {
            const parsed = parseMetricsKey(font, input);
            if ('error' in parsed) {
                return {
                    input,
                    value: null,
                    error: parsed.error,
                    referencedGlyphNames: [],
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            const automaticDerivedSidebearing =
                this.isAutomaticAlignedLayer() &&
                !isAutomaticSidebearingOverrideKey(input)
                    ? this.getAutomaticDerivedSidebearing(side)
                    : null;

            if (parsed.kind === 'constant') {
                const resolvedValue = roundMetricValue(parsed.value);
                if (automaticDerivedSidebearing === resolvedValue) {
                    return {
                        input: '',
                        value: automaticDerivedSidebearing,
                        error: null,
                        referencedGlyphNames: parsed.referencedGlyphNames,
                        isLocal: false
                    };
                }

                return {
                    input,
                    value: resolvedValue,
                    error: null,
                    referencedGlyphNames: parsed.referencedGlyphNames,
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            if (parsed.kind === 'automatic-offset') {
                if (!this.isAutomaticAlignedLayer()) {
                    return {
                        input,
                        value: roundMetricValue(parsed.delta),
                        error: null,
                        referencedGlyphNames: [],
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }

                const baseSidebearing =
                    this.getAutomaticDerivedSidebearing(side) ??
                    (() => {
                        const baseLayer =
                            this.getPrimaryAutoAlignedComponentLayer();
                        if (!baseLayer) {
                            return this.getDirectSidebearing(side);
                        }

                        const componentResolution = baseLayer.resolveMetricsKey(
                            side,
                            stack
                        );
                        return componentResolution.error ||
                            componentResolution.value === null
                            ? baseLayer.getDirectSidebearing(side)
                            : componentResolution.value;
                    })();

                return {
                    input,
                    value: roundMetricValue(baseSidebearing + parsed.delta),
                    error: null,
                    referencedGlyphNames: [],
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            let targetLayer: Layer | undefined;
            if (parsed.glyphName) {
                targetLayer = this.getMetricsReferenceLayerOnGlyph(
                    parsed.glyphName
                );
                if (!targetLayer) {
                    const targetGlyph = font.findGlyph(parsed.glyphName);
                    targetLayer = targetGlyph?.layers?.[0];
                }

                if (!targetLayer) {
                    return {
                        input,
                        value: null,
                        error: `Could not resolve glyph ${parsed.glyphName}`,
                        referencedGlyphNames: parsed.referencedGlyphNames,
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }
            } else {
                targetLayer = this;
            }

            const targetSide = parsed.mirror
                ? side === 'left'
                    ? 'right'
                    : 'left'
                : side;

            let baseValue: number | null = null;
            if (parsed.offsetY !== null) {
                const measured = targetLayer.getSidebearingsAtHeight(
                    parsed.offsetY
                );
                if (!measured) {
                    return {
                        input,
                        value: null,
                        error: `Could not measure sidebearings at height ${parsed.offsetY}`,
                        referencedGlyphNames: parsed.referencedGlyphNames,
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }
                baseValue =
                    targetSide === 'left' ? measured.left : measured.right;
            } else {
                const targetKey =
                    targetLayer.getLocalSidebearingKey(targetSide) ??
                    targetLayer.getGlobalSidebearingKey(targetSide);

                if (targetKey) {
                    const nested = targetLayer.resolveMetricsKey(
                        targetSide,
                        stack
                    );
                    if (nested.error || nested.value === null) {
                        return {
                            input,
                            value: null,
                            error: nested.error,
                            referencedGlyphNames: parsed.referencedGlyphNames,
                            isLocal: this.hasLocalSidebearingKey(side)
                        };
                    }
                    baseValue = nested.value;
                } else {
                    baseValue = targetLayer.getDirectSidebearing(targetSide);
                }
            }

            const resolvedValue = applyMetricOperation(
                baseValue,
                parsed.operation
            );
            if (resolvedValue === null || !Number.isFinite(resolvedValue)) {
                return {
                    input,
                    value: null,
                    error: 'Invalid metrics-key calculation',
                    referencedGlyphNames: parsed.referencedGlyphNames,
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            const roundedResolvedValue = roundMetricValue(resolvedValue);
            if (automaticDerivedSidebearing === roundedResolvedValue) {
                return {
                    input: '',
                    value: automaticDerivedSidebearing,
                    error: null,
                    referencedGlyphNames: parsed.referencedGlyphNames,
                    isLocal: false
                };
            }

            return {
                input,
                value: roundedResolvedValue,
                error: null,
                referencedGlyphNames: parsed.referencedGlyphNames,
                isLocal: this.hasLocalSidebearingKey(side)
            };
        } finally {
            stack.delete(cycleKey);
        }
    }

    applySidebearingInput(
        side: SidebearingSide,
        rawValue: string
    ): MetricsKeyResolution {
        const input = rawValue.trim();
        const label = getSidebearingTransactionLabel(side);
        const glyphName = (this.parent() as Glyph)?.name;
        const isPlainNumericInput = isPlainNumericText(input);
        const forceLocal = input.startsWith('==');
        const useLocalKeyStorage = forceLocal;
        const suppressDerivedHistory = forceLocal;
        const updateScope: 'layer' | 'font' =
            !isPlainNumericInput && !useLocalKeyStorage ? 'font' : 'layer';
        const glyphNameList = [glyphName].filter(Boolean) as string[];

        const recomputeDependentMetrics = (
            affectedGlyphNames: Set<string>
        ): void => {
            const recompute = () =>
                this.getFont()?.recomputeMetricsKeys(affectedGlyphNames) ||
                new Set<string>();
            const bridge = getPatchSyncEngine();
            const dependentGlyphNames =
                suppressDerivedHistory && bridge?.runWithoutRecording
                    ? bridge.runWithoutRecording(recompute)
                    : recompute();
            for (const dependentGlyphName of dependentGlyphNames) {
                affectedGlyphNames.add(dependentGlyphName);
            }
        };

        return withBridgeTransaction(label, () => {
            if (!input) {
                this.clearEffectiveSidebearingKey(side);
                const affectedGlyphNames = new Set<string>(
                    [glyphName].filter(Boolean) as string[]
                );
                recomputeDependentMetrics(affectedGlyphNames);
                return {
                    ...this.resolveMetricsKey(side),
                    updateScope,
                    affectedGlyphNames: [...affectedGlyphNames]
                };
            }

            if (this.isAutomaticAlignedLayer() && !/^==?[+-]/.test(input)) {
                return {
                    input,
                    value: null,
                    error: 'Automatic sidebearings only accept =+/- or ==+/- adjustments',
                    referencedGlyphNames: [],
                    isLocal: this.hasLocalSidebearingKey(side),
                    updateScope: 'layer',
                    affectedGlyphNames: glyphNameList
                };
            }

            if (isPlainNumericInput) {
                this.clearEffectiveSidebearingKey(side);
                this.setDirectSidebearing(side, Number(input));
                const affectedGlyphNames = new Set<string>(
                    [glyphName].filter(Boolean) as string[]
                );
                recomputeDependentMetrics(affectedGlyphNames);
                return {
                    input,
                    value: Number(input),
                    error: null,
                    referencedGlyphNames: [],
                    isLocal: false,
                    updateScope,
                    affectedGlyphNames: [...affectedGlyphNames]
                };
            }

            if (useLocalKeyStorage) {
                if (side === 'left') {
                    this.leftMetricsKey = input;
                } else {
                    this.rightMetricsKey = input;
                }
            } else {
                this.setEffectiveSidebearingKey(side, input, false);
            }
            const resolution = this.resolveMetricsKey(side);
            if (resolution.error || resolution.value === null) {
                return {
                    ...resolution,
                    updateScope,
                    affectedGlyphNames: glyphNameList
                };
            }

            const applied = getAppliedMetricsKeySidebearing(
                this,
                side,
                resolution
            );
            if (applied.error || applied.value === null) {
                return {
                    ...resolution,
                    value: null,
                    error: applied.error,
                    updateScope,
                    affectedGlyphNames: glyphNameList
                };
            }

            const affectedGlyphNames = new Set<string>(
                [glyphName].filter(Boolean) as string[]
            );

            if (!this.isAutomaticAlignedLayer()) {
                this.setDirectSidebearing(side, applied.value);
            }

            recomputeDependentMetrics(affectedGlyphNames);
            return {
                ...resolution,
                updateScope,
                affectedGlyphNames: [...affectedGlyphNames]
            };
        });
    }

    private getGlobalSidebearingKey(side: SidebearingSide): string | undefined {
        const glyph = this.parent() as Glyph;
        if (!glyph) {
            return undefined;
        }

        return side === 'left' ? glyph.leftMetricsKey : glyph.rightMetricsKey;
    }

    get leftMetricsKey(): string | undefined {
        return localMetricsKeyStorageToPublic(
            this.getLocalSidebearingKey('left')
        );
    }

    set leftMetricsKey(value: string | undefined) {
        assertModelMutationAllowed();
        this.setLocalSidebearingKey(
            'left',
            localMetricsKeyPublicToStorage(value, this.getFont())
        );
    }

    get rightMetricsKey(): string | undefined {
        return localMetricsKeyStorageToPublic(
            this.getLocalSidebearingKey('right')
        );
    }

    set rightMetricsKey(value: string | undefined) {
        assertModelMutationAllowed();
        this.setLocalSidebearingKey(
            'right',
            localMetricsKeyPublicToStorage(value, this.getFont())
        );
    }

    getPathSegment(): (string | number)[] {
        const layerId = this.data.id;
        return layerId ? ['layers', layerId] : ['layers', this._index];
    }

    private getMasterId(): string | undefined {
        return this.master?.master;
    }

    /**
     * Get the resolved master object for this layer.
     * Returns a Master only when this layer is a DefaultForMaster layer.
     */
    getMaster(): Master | undefined {
        const layerMaster = this.master;
        if (!layerMaster || layerMaster.type !== 'DefaultForMaster') {
            return undefined;
        }

        const glyph = this.parent() as Glyph;
        if (!glyph) return undefined;

        const font = glyph.parent() as Font;
        if (!font) return undefined;

        return font.findMaster(layerMaster.master);
    }

    private getKerningMasterForComposition(): Master | undefined {
        const layerMaster = this.master;
        if (
            !layerMaster ||
            (layerMaster.type !== 'DefaultForMaster' &&
                layerMaster.type !== 'AssociatedWithMaster')
        ) {
            return undefined;
        }

        return this.getFont()?.findMaster(layerMaster.master);
    }

    private collectUnattachedAutomaticBaseReferencePairs(): Array<
        [string, string]
    > {
        if (!this.isAutomaticAlignedLayer()) {
            return [];
        }

        const layout = this.getAutomaticCompositionLayout();
        if (!layout) {
            return [];
        }

        const pairs: Array<[string, string]> = [];
        let previousReference: string | null = null;
        const components = this.components;
        for (let index = 0; index < components.length; index++) {
            const placement = layout.placements[index];
            const reference = components[index]?.reference;
            if (!placement || placement.hasAttachment || !reference) {
                continue;
            }
            if (previousReference) {
                pairs.push([previousReference, reference]);
            }
            previousReference = reference;
        }
        return pairs;
    }

    /**
     * True when this automatic layer stacks unattached bases that resolve to
     * the kerning pair (`glyph` or `@group` keys).
     */
    usesAutomaticLigatureKerningPair(
        firstKey: string,
        secondKey: string
    ): boolean {
        const font = this.getFont();
        if (!font) {
            return false;
        }

        for (const [
            leftRef,
            rightRef
        ] of this.collectUnattachedAutomaticBaseReferencePairs()) {
            const leftKeys = getKerningOperandKeys(
                leftRef,
                font.first_kern_groups
            );
            const rightKeys = getKerningOperandKeys(
                rightRef,
                font.second_kern_groups
            );
            if (leftKeys.includes(firstKey) && rightKeys.includes(secondKey)) {
                return true;
            }
        }
        return false;
    }

    /**
     * True when an unattached ligature operand is one of the glyphs whose
     * kern-group membership just changed (`first` = left of the pair).
     */
    usesAutomaticLigatureKerningGroupMembership(
        pairSide: 'first' | 'second',
        glyphNames: Iterable<string>
    ): boolean {
        const names = new Set(
            [...glyphNames].filter(
                (name) => typeof name === 'string' && name.length > 0
            )
        );
        if (names.size === 0) {
            return false;
        }

        for (const [
            leftRef,
            rightRef
        ] of this.collectUnattachedAutomaticBaseReferencePairs()) {
            if (pairSide === 'first' && names.has(leftRef)) {
                return true;
            }
            if (pairSide === 'second' && names.has(rightRef)) {
                return true;
            }
        }
        return false;
    }

    getComputedName(): string {
        const isIntermediateLayer =
            this.master?.type === 'AssociatedWithMaster' &&
            !!this.location &&
            Object.keys(this.location).length > 0;

        if (isIntermediateLayer) {
            return 'Intermediate Layer';
        }

        const master = this.getMaster();
        if (!master) {
            return this.name && this.name.trim() !== '' ? this.name : 'Default';
        }

        const masterName = master.toJSON().name;
        if (typeof masterName === 'string') {
            return masterName;
        }
        if (masterName?.dflt) {
            return masterName.dflt;
        }
        if (masterName?.en) {
            return masterName.en;
        }

        const firstName = Object.values(masterName || {}).find(
            (value) => typeof value === 'string'
        );
        return typeof firstName === 'string' ? firstName : 'Default';
    }

    get width(): number {
        return this.data.width;
    }

    set width(value: number) {
        assertModelMutationAllowed();
        const old = this.data.width;
        const roundedValue = roundMetricValue(value);
        this.data.width = roundedValue;
        recordAndMarkDirty(this, 'width', old, roundedValue);
    }

    /**
     * Get the left sidebearing (LSB) - the distance from x=0 to the left edge of the bounding box
     * @returns The left sidebearing value, or 0 if no geometry
     */
    get lsb(): number {
        return this.getDirectSidebearing('left');
    }

    /**
     * Set the left sidebearing (LSB) by translating all geometry horizontally
     * This updates the position of all paths, components, and anchors, and adjusts width accordingly
     * @param value - The new left sidebearing value
     */
    set lsb(value: number) {
        assertModelMutationAllowed();
        withBridgeTransaction(getSidebearingTransactionLabel('left'), () => {
            this.setDirectSidebearing('left', value);
            this.getFont()?.recomputeMetricsKeys(
                new Set([(this.parent() as Glyph)?.name].filter(Boolean))
            );
        });
    }

    /**
     * Get the right sidebearing (RSB) - the distance from the right edge of the bounding box to the advance width
     * @returns The right sidebearing value, or the width if no geometry
     */
    get rsb(): number {
        return this.getDirectSidebearing('right');
    }

    /**
     * Set the right sidebearing (RSB) by adjusting the advance width
     * This only changes the width, not the geometry position
     * @param value - The new right sidebearing value
     */
    set rsb(value: number) {
        assertModelMutationAllowed();
        withBridgeTransaction(getSidebearingTransactionLabel('right'), () => {
            this.setDirectSidebearing('right', value);
            this.getFont()?.recomputeMetricsKeys(
                new Set([(this.parent() as Glyph)?.name].filter(Boolean))
            );
        });
    }

    /**
     * Whether this layer is linked for editor multi-layer operations.
     * This is editor-only runtime state keyed by glyph and layer ID; it is not persisted into font data.
     */
    get linked(): boolean {
        if (!this.id) {
            return true;
        }

        const outlineEditor = getOutlineEditorLayerLinkController();
        if (!outlineEditor) {
            return true;
        }

        return outlineEditor.isLayerLinked!(this.id, this.getGlyphName());
    }

    set linked(value: boolean) {
        assertModelMutationAllowed();
        if (!this.id) {
            return;
        }

        const outlineEditor = getOutlineEditorLayerLinkController();
        if (!outlineEditor) {
            return;
        }

        const linked = Boolean(value);
        outlineEditor.setLayerLinked!(this.id, linked, this.getGlyphName());
        refreshLayerLinkageUi(this.getGlyphName(), this.id, linked);
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get id(): string | undefined {
        return this.data.id;
    }

    set id(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    /**
     * Tagged layer-to-master link: `{ "type": "DefaultForMaster", "master": id }`,
     * `"AssociatedWithMaster"`, or `"FreeFloating"` (master optional).
     * @example
     * layer.master["type"]  # `type` is a Python keyword
     * layer.master.master
     */
    get master(): Babelfont.LayerType | undefined {
        const layerId = this.data.id || '[no-layer-id]';
        assertTaggedLayerMaster(this.data.master, `Layer#${layerId}.master`);
        return getLiveMutableValue(this, 'master', this.data.master, () => {
            const currentLayerId = this.data.id || '[no-layer-id]';
            assertTaggedLayerMaster(
                this.data.master,
                `Layer#${currentLayerId}.master`
            );
            return this.data.master;
        });
    }

    set master(value: Babelfont.LayerType | undefined) {
        assertModelMutationAllowed();
        const layerId = this.data.id || '[no-layer-id]';
        assertTaggedLayerMaster(value, `Layer#${layerId}.master(set)`);
        const old = this.data.master;
        this.data.master = value;
        recordAndMarkDirty(this, 'master', old, value);
    }

    /**
     * Smart-component location: glyph-axis tag → userspace value.
     */
    get smart_component_location(): UserspaceLocation | undefined {
        return getLiveMutableValue(
            this,
            'smart_component_location',
            this.data.smart_component_location,
            () => this.data.smart_component_location
        );
    }

    set smart_component_location(value: UserspaceLocation | undefined) {
        assertModelMutationAllowed();
        const old = this.data.smart_component_location;
        this.data.smart_component_location = value;
        recordAndMarkDirty(this, 'smart_component_location', old, value);
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: Unsafe, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._guideWrappers!,
            'Layer.guides is a read-only collection view. Use addGuide() or removeGuide() for structural edits.'
        );
    }

    /**
     * Current UI selection on this layer.
     * Assign a node, anchor, component, guide, or a list of them to replace the selection.
     */
    get selection(): SelectableLayerObject[] {
        const outlineEditor = getOutlineEditorSelectionController();
        const selection = outlineEditor
            ? this.getSelectionSnapshotFromOutlineEditor(outlineEditor)
            : [];

        return getReadOnlyCollectionValue(
            selection,
            'Layer.selection is a derived UI selection view. Assign a new selection list to change it.'
        );
    }

    set selection(
        value:
            SelectableLayerObject | SelectableLayerObject[] | null | undefined
    ) {
        assertModelMutationAllowed();
        this._setSelectionFromPython(value);
    }

    get shapes(): Shape[] | undefined {
        if (!this.data.shapes) return undefined;
        if (
            !this._shapeWrappers ||
            this._shapeWrappers.length !== this.data.shapes.length
        ) {
            this._shapeWrappers = this.data.shapes.map(
                (_: Unsafe, i: number) => new Shape(this.data.shapes, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._shapeWrappers!,
            'Layer.shapes is a read-only collection view. Use addPath(), addComponent(), addShape(), or removeShape() for structural edits.'
        );
    }

    /**
     * Direct path objects in this layer, ready to use without Shape.asPath()
     * @example
     * path = layer.paths[0]
     */
    get paths(): Path[] {
        return this.getFilteredShapes(
            (shape) => shape.isPath(),
            (shape) => shape.asPath(),
            'Layer.paths is a read-only collection view. Use addPath() or removeShape() for structural edits.'
        );
    }

    /**
     * Direct component objects in this layer, ready to use without Shape.asComponent()
     * @example
     * component = layer.components[0]
     */
    get components(): Component[] {
        return this.getFilteredShapes(
            (shape) => shape.isComponent(),
            (shape) => shape.asComponent(),
            'Layer.components is a read-only collection view. Use addComponent() or removeShape() for structural edits.'
        );
    }

    get anchors(): Anchor[] | undefined {
        if (!this.data.anchors) return undefined;
        if (
            !this._anchorWrappers ||
            this._anchorWrappers.length !== this.data.anchors.length
        ) {
            this._anchorWrappers = this.data.anchors.map(
                (_: Unsafe, i: number) => new Anchor(this.data.anchors, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._anchorWrappers!,
            'Layer.anchors is a read-only collection view. Use addAnchor() or removeAnchor() for structural edits.'
        );
    }

    findAnchor(anchorName: string): Anchor | undefined {
        return this.anchors?.find((anchor) => anchor.name === anchorName);
    }

    /**
     * Anchors inherited from this layer's component stack, in this layer's
     * coordinate space. Stored anchors on this layer are not included; later
     * components overwrite earlier names. Nested components are walked
     * recursively unless this layer already stores an incoming attachment
     * anchor (`_top`, `_bottom`, …): those nested shapes are drawings, not
     * identity, so their anchors are omitted.
     * @example
     * anchors = layer.computedAnchors()
     * top = anchors["top"]
     */
    computedAnchors(): ComputedAnchorMap {
        return this.collectComputedAnchors(new Set());
    }

    /**
     * RGBA color channels `r`, `g`, `b`, `a`.
     */
    get color(): Babelfont.Color | undefined {
        return this.data.color;
    }

    set color(value: Babelfont.Color | undefined) {
        assertModelMutationAllowed();
        const old = this.data.color;
        this.data.color = value;
        recordAndMarkDirty(this, 'color', old, value);
    }

    get layer_index(): number | undefined {
        return this.data.layer_index;
    }

    set layer_index(value: number | undefined) {
        assertModelMutationAllowed();
        const old = this.data.layer_index;
        this.data.layer_index = value;
        recordAndMarkDirty(this, 'layer_index', old, value);
    }

    get is_background(): boolean | undefined {
        return this.data.is_background;
    }

    set is_background(value: boolean | undefined) {
        assertModelMutationAllowed();
        const old = this.data.is_background;
        this.data.is_background = value;
        recordAndMarkDirty(this, 'is_background', old, value);
    }

    get background_layer_id(): string | undefined {
        return this.data.background_layer_id;
    }

    set background_layer_id(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.background_layer_id;
        this.data.background_layer_id = value;
        recordAndMarkDirty(this, 'background_layer_id', old, value);
    }

    /**
     * The paired background layer. Empty backgrounds are transient until a path
     * or component is added, so merely accessing this property does not alter
     * the glyph.
     */
    get backgroundLayer(): Layer {
        if (this.is_background) {
            if (this._virtualBackgroundOwner) {
                return this._virtualBackgroundOwner;
            }
            const foreground = this.parent()?.layers?.find(
                (layer: Layer) => layer.background_layer_id === this.id
            );
            return foreground || this;
        }

        const glyph = this.parent() as Glyph | null;
        const existing = this.background_layer_id
            ? glyph?.findLayerById(this.background_layer_id)
            : undefined;
        if (existing?.is_background) {
            return existing;
        }

        const virtualBackground = new Layer(
            [
                {
                    id: `background-${this.id || this._index}`,
                    width: this.width,
                    master: this.master,
                    location: this.location,
                    is_background: true,
                    background_layer_id: this.id
                }
            ],
            0,
            glyph
        );
        virtualBackground._virtualBackgroundOwner = this;
        return virtualBackground;
    }

    private ensureMaterializedBackgroundLayer(): void {
        if (!this._virtualBackgroundOwner) {
            return;
        }

        const owner = this._virtualBackgroundOwner;
        const glyph = owner.parent() as Glyph | null;
        if (!glyph) {
            throw new Error(
                'Cannot materialize a background layer without a glyph'
            );
        }

        const background = glyph.addBackgroundLayer(owner);
        this._parent = background._parent;
        this._index = background._index;
        this._parentObject = glyph;
        this._virtualBackgroundOwner = null;
    }

    /**
     * Intermediate designspace location. Access axis tags as attributes
     * (`layer.location.wght`). Absent when the layer sits at its master default.
     */
    get location(): DesignspaceLocation | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: DesignspaceLocation | undefined) {
        assertModelMutationAllowed();
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Add a new shape to the layer
     */
    addShape(shape: Babelfont.Shape): Shape {
        assertModelMutationAllowed();
        return this.withFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (
                this.is_background &&
                !('nodes' in shape) &&
                !('reference' in shape)
            ) {
                throw new Error(
                    'Background layers can only contain paths and components'
                );
            }
            this.ensureMaterializedBackgroundLayer();
            if (!this.data.shapes) {
                this.data.shapes = [];
            }
            assertModelMutationAllowed();
            this.data.shapes.push(shape);
            this._shapeWrappers = null; // Invalidate cache
            const index = this.data.shapes.length - 1;
            const { id: _id, ...storedShape } = shape as unknown as Record<
                string,
                unknown
            >;
            recordAddAndMarkDirty(
                [...this.getPath(), 'shapes', index],
                storedShape
            );
            return new Shape(this.data.shapes, index, this);
        });
    }

    /**
     * Add a new path to the layer
     * @example
     * path = layer.addPath(closed=True)
     */
    addPath(closed: boolean | Record<string, Unsafe> = true): Path {
        assertModelMutationAllowed();
        // Pyodide/JS interop can pass keyword arguments as an object,
        // e.g. addPath(closed=True) may arrive as { closed: true }.
        const resolvedClosed =
            typeof closed === 'boolean'
                ? closed
                : !!closed && typeof closed === 'object' && 'closed' in closed
                  ? !!(closed as Unsafe).closed
                  : true;

        const pathData: Babelfont.Path = {
            id: generateStableId(),
            nodes: [],
            closed: resolvedClosed
        };
        const shapeData: Babelfont.Shape = pathData;
        const shape = this.addShape(shapeData);
        return shape.asPath();
    }

    /**
     * Add a new component to the layer. If the layer is then eligible for
     * automatic composition (component-only, and the engine can place every
     * component — including unattached non-mark bases as a ligature), automatic
     * alignment is enabled on every component and the layer is recomposed in
     * the same transaction.
     * @example
     * component = layer.addComponent("A")
     * # With transformation matrix (legacy 6-element format converted to DecomposedAffine)
     * component = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])
     */
    addComponent(
        reference: string,
        transform?: number[] | Babelfont.DecomposedAffine
    ): Component {
        assertModelMutationAllowed();
        return withBridgeTransaction('Add component', () => {
            const componentData: Babelfont.Component = {
                id: generateStableId(),
                reference,
                transform: this.normalizeTransform(transform)
            };
            const shapeData: Babelfont.Shape = componentData;
            const shape = this.addShape(shapeData);
            this.enableAutomaticCompositionIfEligible();
            return shape.asComponent();
        });
    }

    /**
     * Normalize transform to DecomposedAffine format
     * Converts legacy 6-element affine matrix to DecomposedAffine
     */
    private normalizeTransform(
        transform?: number[] | Babelfont.DecomposedAffine
    ): Babelfont.DecomposedAffine {
        if (!transform) {
            return DecomposedAffineTransform.identity();
        }

        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        return transform;
    }

    private resolveShapeIndex(
        shapeOrIndex: number | Shape | Path | Component
    ): number | null {
        if (typeof shapeOrIndex === 'number') {
            return shapeOrIndex;
        }

        const shapes = this.shapes || [];

        if (shapeOrIndex instanceof Shape) {
            const parentLayer = shapeOrIndex.parent();
            if (parentLayer !== this) {
                return null;
            }
            const index = shapes.indexOf(shapeOrIndex);
            return index >= 0 ? index : null;
        }

        if (shapeOrIndex instanceof Path || shapeOrIndex instanceof Component) {
            const parentShape = shapeOrIndex.parent();
            if (
                !(parentShape instanceof Shape) ||
                parentShape.parent() !== this
            ) {
                return null;
            }
            const index = shapes.indexOf(parentShape);
            return index >= 0 ? index : null;
        }

        return null;
    }

    private resolvePathShapeIndex(
        pathOrIndex: number | Shape | Path
    ): number | null {
        if (typeof pathOrIndex === 'number') {
            const shapes = this.shapes || [];
            let pathIndex = 0;

            for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
                if (!shapes[shapeIndex].isPath()) {
                    continue;
                }

                if (pathIndex === pathOrIndex) {
                    return shapeIndex;
                }

                pathIndex += 1;
            }

            return null;
        }

        const shapeIndex = this.resolveShapeIndex(pathOrIndex);
        if (shapeIndex === null) {
            return null;
        }

        const shape = this.shapes?.[shapeIndex];
        return shape?.isPath() ? shapeIndex : null;
    }

    private getPathIndexForShapeIndex(shapeIndex: number): number | null {
        const shapes = this.shapes || [];
        if (shapeIndex < 0 || shapeIndex >= shapes.length) {
            return null;
        }

        let pathIndex = 0;
        for (let index = 0; index < shapes.length; index++) {
            if (!shapes[index].isPath()) {
                continue;
            }

            if (index === shapeIndex) {
                return pathIndex;
            }

            pathIndex += 1;
        }

        return null;
    }

    /**
     * Insert a new shape at the specified index
     */
    insertShapeAt(index: number, shape: Babelfont.Shape): Shape {
        assertModelMutationAllowed();
        return this.withFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            if (!this.data.shapes) {
                this.data.shapes = [];
            }

            const boundedIndex = Math.max(
                0,
                Math.min(index, this.data.shapes.length)
            );
            assertModelMutationAllowed();
            this.data.shapes.splice(boundedIndex, 0, shape);
            this._shapeWrappers = null;
            recordAddAndMarkDirty(
                [...this.getPath(), 'shapes', boundedIndex],
                shape
            );
            return new Shape(this.data.shapes, boundedIndex, this);
        });
    }

    /**
     * Move selected shapes as a unit in z-order. Linked layers with a matching
     * fingerprint receive the same index permutation.
     *
     * `backward` / `forward` swap each selected index with the adjacent
     * unselected neighbor so relative selection order is preserved.
     * `back` / `front` extract the selection in current order and insert it
     * at the start or end.
     *
     * @returns Map from previous shape index to new shape index.
     */
    moveShapes(
        indexes: number[],
        command: ShapeZOrderCommand
    ): Map<number, number> {
        assertModelMutationAllowed();
        const linkedLayers = [...this._getLinkedLayers()];
        const mapping = this.applyShapeZOrderMove(indexes, command);
        for (const linkedLayer of linkedLayers) {
            linkedLayer.applyShapeZOrderMove(indexes, command);
        }
        return mapping;
    }

    private applyShapeZOrderMove(
        indexes: number[],
        command: ShapeZOrderCommand
    ): Map<number, number> {
        return this.withFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const shapes = this.data.shapes;
            const identity = new Map<number, number>();
            if (!Array.isArray(shapes) || shapes.length === 0) {
                return identity;
            }

            const selected = [
                ...new Set(
                    indexes.filter(
                        (index) =>
                            Number.isInteger(index) &&
                            index >= 0 &&
                            index < shapes.length
                    )
                )
            ].sort((a, b) => a - b);
            if (selected.length === 0) {
                return identity;
            }

            const order = shapes.map((_, index) => index);
            const selectedSet = new Set(selected);
            if (command === 'backward') {
                for (let i = 1; i < order.length; i++) {
                    if (
                        selectedSet.has(order[i]) &&
                        !selectedSet.has(order[i - 1])
                    ) {
                        const swapped = order[i - 1];
                        order[i - 1] = order[i];
                        order[i] = swapped;
                    }
                }
            } else if (command === 'forward') {
                for (let i = order.length - 2; i >= 0; i--) {
                    if (
                        selectedSet.has(order[i]) &&
                        !selectedSet.has(order[i + 1])
                    ) {
                        const swapped = order[i + 1];
                        order[i + 1] = order[i];
                        order[i] = swapped;
                    }
                }
            } else if (command === 'back') {
                const extracted = order.filter((index) =>
                    selectedSet.has(index)
                );
                const remaining = order.filter(
                    (index) => !selectedSet.has(index)
                );
                order.length = 0;
                order.push(...extracted, ...remaining);
            } else {
                const extracted = order.filter((index) =>
                    selectedSet.has(index)
                );
                const remaining = order.filter(
                    (index) => !selectedSet.has(index)
                );
                order.length = 0;
                order.push(...remaining, ...extracted);
            }

            const mapping = new Map<number, number>();
            let changed = false;
            for (let newIndex = 0; newIndex < order.length; newIndex++) {
                const oldIndex = order[newIndex];
                mapping.set(oldIndex, newIndex);
                if (oldIndex !== newIndex) {
                    changed = true;
                }
            }
            if (!changed) {
                return mapping;
            }

            const oldShapes = cloneForHistory(shapes);
            this.data.shapes = order.map((oldIndex) => shapes[oldIndex]);
            this._shapeWrappers = null;
            recordAndMarkDirty(this, 'shapes', oldShapes, this.data.shapes);
            return mapping;
        });
    }

    /**
     * Split an open path into two open paths at an interior on-curve node.
     */
    splitOpenPathAtNode(
        pathOrIndex: number | Shape | Path,
        nodeIndex: number
    ): { shapeIndex: number; insertedShapeIndex: number } | null {
        return this.withFingerprintChangeEvent(() => {
            assertModelMutationAllowed();
            const shapeIndex = this.resolvePathShapeIndex(pathOrIndex);
            if (shapeIndex === null) {
                return null;
            }

            const shape = this.shapes?.[shapeIndex];
            const path = shape?.isPath() ? shape.asPath() : null;
            if (!path || path.closed) {
                return null;
            }

            const splitPath = path._splitOpenPathAtNode(nodeIndex);
            if (!splitPath) {
                return null;
            }

            const insertedShapeIndex = shapeIndex + 1;
            const insertedShape: Babelfont.Shape = splitPath;
            if (!this.data.shapes) {
                this.data.shapes = [];
            }
            assertModelMutationAllowed();
            this.data.shapes.splice(insertedShapeIndex, 0, insertedShape);
            this._shapeWrappers = null;
            recordAddAndMarkDirty(
                [...this.getPath(), 'shapes', insertedShapeIndex],
                insertedShape
            );

            return { shapeIndex, insertedShapeIndex };
        });
    }

    /**
     * Connect two open-path endpoints or close a single open path by merging its endpoints.
     */
    connectOpenPathEndpoints(
        sourcePathOrIndex: number | Shape | Path,
        sourceEdge: 'start' | 'end',
        targetPathOrIndex: number | Shape | Path,
        targetEdge: 'start' | 'end'
    ): {
        shapeIndex: number;
        boundaryNodeIndex: number;
        closed: boolean;
    } | null {
        return this.withFingerprintChangeEvent(() => {
            const sourceShapeIndex =
                this.resolvePathShapeIndex(sourcePathOrIndex);
            const targetShapeIndex =
                this.resolvePathShapeIndex(targetPathOrIndex);
            if (sourceShapeIndex === null || targetShapeIndex === null) {
                return null;
            }

            const sourceShape = this.shapes?.[sourceShapeIndex];
            const targetShape = this.shapes?.[targetShapeIndex];
            const sourcePath = sourceShape?.isPath()
                ? sourceShape.asPath()
                : null;
            const targetPath = targetShape?.isPath()
                ? targetShape.asPath()
                : null;
            if (
                !sourcePath ||
                !targetPath ||
                sourcePath.closed ||
                targetPath.closed
            ) {
                return null;
            }

            const sourcePathData = sourcePath.toJSON();
            const targetPathData = targetPath.toJSON();
            const sourceNodes = Array.isArray(sourcePathData.nodes)
                ? sourcePathData.nodes.map((node) => cloneNodeData(node))
                : [];
            const targetNodes = Array.isArray(targetPathData.nodes)
                ? targetPathData.nodes.map((node) => cloneNodeData(node))
                : [];

            if (sourceShapeIndex === targetShapeIndex) {
                if (sourceEdge === targetEdge) {
                    return null;
                }

                const startNode = sourceNodes[0] || null;
                const endNode = sourceNodes[sourceNodes.length - 1] || null;
                const shouldMergeCoincidentEndpoints = Boolean(
                    startNode &&
                    endNode &&
                    startNode.x === endNode.x &&
                    startNode.y === endNode.y
                );
                const changed = shouldMergeCoincidentEndpoints
                    ? sourcePath._closeOpenPathByMerge()
                    : sourcePath._closeOpenPath();
                if (!changed) {
                    return null;
                }

                return {
                    shapeIndex: sourceShapeIndex,
                    boundaryNodeIndex: 0,
                    closed: true
                };
            }

            const connectedNodes = connectOpenPathNodeArrays(
                sourceNodes,
                sourceEdge,
                targetNodes,
                targetEdge
            );
            if (!connectedNodes) {
                return null;
            }

            const removeShapeIndexes = [
                sourceShapeIndex,
                targetShapeIndex
            ].sort((left, right) => right - left);
            const insertedShapeIndex = Math.min(
                sourceShapeIndex,
                targetShapeIndex
            );
            const connectedShape: Babelfont.Shape = {
                nodes: connectedNodes.nodes,
                closed: false
            };

            if (!this.data.shapes) {
                return null;
            }

            for (const shapeIndex of removeShapeIndexes) {
                const removedShape = this.data.shapes[shapeIndex];
                if (removedShape === undefined) {
                    return null;
                }
                assertModelMutationAllowed();
                this.data.shapes.splice(shapeIndex, 1);
                recordRemoveAndMarkDirty(
                    [...this.getPath(), 'shapes', shapeIndex],
                    removedShape
                );
            }

            assertModelMutationAllowed();

            this.data.shapes.splice(insertedShapeIndex, 0, connectedShape);
            this._shapeWrappers = null;
            recordAddAndMarkDirty(
                [...this.getPath(), 'shapes', insertedShapeIndex],
                connectedShape
            );

            return {
                shapeIndex: insertedShapeIndex,
                boundaryNodeIndex: connectedNodes.boundaryNodeIndex,
                closed: false
            };
        });
    }

    /**
     * Remove a shape at the specified index
     */
    removeShape(shapeOrIndex: number | Shape | Path | Component): void {
        assertModelMutationAllowed();
        this.withFingerprintChangeEvent(() => {
            if (!this.data.shapes) {
                return;
            }

            const index = this.resolveShapeIndex(shapeOrIndex);
            if (index === null) {
                return;
            }

            const removedShape = this.data.shapes[index];
            if (removedShape === undefined) {
                return;
            }

            assertModelMutationAllowed();

            this.data.shapes.splice(index, 1);
            this._shapeWrappers = null; // Invalidate cache
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'shapes', index],
                removedShape
            );
        });
    }

    /**
     * Add a new anchor to the layer
     * @example
     * anchor = layer.addAnchor(250, 700, "top")
     */
    addAnchor(x: number, y: number, name?: string): Anchor {
        assertModelMutationAllowed();
        if (this.is_background) {
            throw new Error('Background layers cannot contain anchors');
        }
        if (!this.data.anchors) {
            this.data.anchors = [];
        }
        const anchorData: Babelfont.Anchor = { id: generateStableId(), x, y };
        if (name) {
            anchorData.name = name;
        }
        assertModelMutationAllowed();
        this.data.anchors.push(anchorData);
        this._anchorWrappers = null; // Invalidate cache
        const index = this.data.anchors.length - 1;
        recordAddAndMarkDirty(
            [...this.getPath(), 'anchors', index],
            anchorData
        );
        return new Anchor(this.data.anchors, index, this);
    }

    addGuide(
        pos: Babelfont.Position,
        name?: string,
        color?: Babelfont.Color
    ): Guide {
        assertModelMutationAllowed();
        if (this.is_background) {
            throw new Error('Background layers cannot contain guides');
        }
        if (!this.data.guides) {
            this.data.guides = [];
        }

        const guideData: Babelfont.Guide = { id: generateStableId(), pos };
        if (name !== undefined) {
            guideData.name = name;
        }
        if (color !== undefined) {
            guideData.color = color;
        }

        assertModelMutationAllowed();

        this.data.guides.push(guideData);
        this._guideWrappers = null;
        const index = this.data.guides.length - 1;
        recordAddAndMarkDirty([...this.getPath(), 'guides', index], guideData);
        return new Guide(this.data.guides, index, this);
    }

    /**
     * Remove an anchor at the specified index
     */
    removeAnchor(index: number): void {
        assertModelMutationAllowed();
        if (this.data.anchors) {
            const removedAnchor = this.data.anchors[index];
            if (removedAnchor === undefined) {
                return;
            }

            assertModelMutationAllowed();

            this.data.anchors.splice(index, 1);
            this._anchorWrappers = null; // Invalidate cache
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'anchors', index],
                removedAnchor
            );
        }
    }

    removeGuide(index: number): void {
        assertModelMutationAllowed();
        if (this.data.guides) {
            const removedGuide = this.data.guides[index];
            if (removedGuide === undefined) {
                return;
            }

            assertModelMutationAllowed();

            this.data.guides.splice(index, 1);
            this._guideWrappers = null;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'guides', index],
                removedGuide
            );
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
        nodes: Unsafe[];
        closed?: boolean;
    }): Array<{
        points: Array<{ x: number; y: number }>;
        type: 'line' | 'quadratic' | 'cubic';
    }> {
        return buildPathSegmentDescriptors(pathData).map((segment) => ({
            points: segment.points.map((point) => ({
                x: point.x,
                y: point.y
            })),
            type: segment.type
        }));
    }

    public static getPathSegmentDescriptors(pathData: {
        nodes: Unsafe[];
        closed?: boolean;
    }): Array<{
        segmentId: number;
        type: 'line' | 'quadratic' | 'cubic';
        points: Array<{ x: number; y: number }>;
        startNodeIndex: number;
        endNodeIndex: number;
        controlNodeIndices: number[];
        runStartNodeIndex: number;
        runEndNodeIndex: number;
        runControlNodeIndices: number[];
        segmentIndexInRun: number;
        wrapsAround: boolean;
    }> {
        return buildPathSegmentDescriptors(pathData).map((segment) => ({
            ...segment,
            points: segment.points.map((point) => ({
                x: point.x,
                y: point.y
            }))
        }));
    }

    private static boundsFromMinMax(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (
            !Number.isFinite(minX) ||
            !Number.isFinite(minY) ||
            !Number.isFinite(maxX) ||
            !Number.isFinite(maxY)
        ) {
            return null;
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

    private static boundsFromSegments(
        segments: Array<{
            points: Array<{ x: number; y: number }>;
            type: 'line' | 'quadratic' | 'cubic';
        }>
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

        const includePoint = (x: number, y: number) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };

        for (const segment of segments) {
            if (
                !segment ||
                !Array.isArray(segment.points) ||
                segment.points.length < 2
            ) {
                continue;
            }

            if (segment.type === 'line' || segment.points.length < 3) {
                for (const point of segment.points) {
                    includePoint(point.x, point.y);
                }
                continue;
            }

            try {
                const bbox = new Bezier(segment.points).bbox();
                includePoint(bbox.x.min, bbox.y.min);
                includePoint(bbox.x.max, bbox.y.max);
            } catch {
                for (const point of segment.points) {
                    includePoint(point.x, point.y);
                }
            }
        }

        return Layer.boundsFromMinMax(minX, minY, maxX, maxY);
    }

    static calculatePathBounds(pathData: {
        nodes?: Unsafe[];
        closed?: boolean;
    }): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        return calculateGlyphPathBounds(pathData);
    }

    static calculateShapeBounds(
        shapes: Unsafe[] | undefined,
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        return calculateGlyphShapeBounds(shapes, parentTransform);
    }

    static calculateSvgPathBounds(pathData: string): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (!pathData) {
            return null;
        }

        const tokens = pathData.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
        if (!tokens) {
            return null;
        }

        const isCommand = (token: string): boolean => /^[MLCQZ]$/i.test(token);
        const readNumber = (index: number): number | null => {
            if (index >= tokens.length || isCommand(tokens[index])) {
                return null;
            }
            const value = Number.parseFloat(tokens[index]);
            return Number.isFinite(value) ? value : null;
        };

        const segments: Array<{
            points: Array<{ x: number; y: number }>;
            type: 'line' | 'quadratic' | 'cubic';
        }> = [];
        let currentPoint: { x: number; y: number } | null = null;
        let subpathStart: { x: number; y: number } | null = null;

        for (let index = 0; index < tokens.length;) {
            const command = tokens[index++].toUpperCase();

            if (command === 'M') {
                const x = readNumber(index);
                const y = readNumber(index + 1);
                if (x === null || y === null) {
                    break;
                }
                currentPoint = { x, y };
                subpathStart = { x, y };
                index += 2;

                while (index < tokens.length && !isCommand(tokens[index])) {
                    const nextX = readNumber(index);
                    const nextY = readNumber(index + 1);
                    if (
                        nextX === null ||
                        nextY === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'line',
                        points: [currentPoint, { x: nextX, y: nextY }]
                    });
                    currentPoint = { x: nextX, y: nextY };
                    index += 2;
                }
                continue;
            }

            if (command === 'L') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const x = readNumber(index);
                    const y = readNumber(index + 1);
                    if (x === null || y === null || currentPoint === null) {
                        break;
                    }
                    segments.push({
                        type: 'line',
                        points: [currentPoint, { x, y }]
                    });
                    currentPoint = { x, y };
                    index += 2;
                }
                continue;
            }

            if (command === 'Q') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const c1x = readNumber(index);
                    const c1y = readNumber(index + 1);
                    const x = readNumber(index + 2);
                    const y = readNumber(index + 3);
                    if (
                        c1x === null ||
                        c1y === null ||
                        x === null ||
                        y === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'quadratic',
                        points: [currentPoint, { x: c1x, y: c1y }, { x, y }]
                    });
                    currentPoint = { x, y };
                    index += 4;
                }
                continue;
            }

            if (command === 'C') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const c1x = readNumber(index);
                    const c1y = readNumber(index + 1);
                    const c2x = readNumber(index + 2);
                    const c2y = readNumber(index + 3);
                    const x = readNumber(index + 4);
                    const y = readNumber(index + 5);
                    if (
                        c1x === null ||
                        c1y === null ||
                        c2x === null ||
                        c2y === null ||
                        x === null ||
                        y === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'cubic',
                        points: [
                            currentPoint,
                            { x: c1x, y: c1y },
                            { x: c2x, y: c2y },
                            { x, y }
                        ]
                    });
                    currentPoint = { x, y };
                    index += 6;
                }
                continue;
            }

            if (
                command === 'Z' &&
                currentPoint &&
                subpathStart &&
                (currentPoint.x !== subpathStart.x ||
                    currentPoint.y !== subpathStart.y)
            ) {
                segments.push({
                    type: 'line',
                    points: [currentPoint, subpathStart]
                });
                currentPoint = subpathStart;
            }
        }

        return Layer.boundsFromSegments(segments);
    }

    /**
     * Flatten all components in the layer to paths with their transforms applied
     * This recursively processes nested components to arbitrary depth
     * @param layerData - Raw layer data object
     * @param font - Font object for looking up component references
     * @returns Array of flattened path data objects with transformed coordinates
     */
    private static flattenComponents(
        layerData: Unsafe,
        font?: Font,
        masterId?: string,
        matchingSource?: Layer
    ): Babelfont.Path[] {
        const flattenedPaths: Babelfont.Path[] = [];

        // Helper function to apply transform to a node
        const transformNode = (node: Unsafe, transform: number[]): Unsafe => {
            const [a, b, c, d, tx, ty] = transform;
            const result: Unsafe = {
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
            // Preserve node type field (either 'type' or 'nodetype')
            if (node.type !== undefined) result.type = node.type;
            if (node.nodetype !== undefined) result.nodetype = node.nodetype;
            if (node.smooth !== undefined) result.smooth = node.smooth;
            return result;
        };

        // Helper to convert DecomposedAffine to affine matrix array
        const toAffineArray = (
            transform: Babelfont.DecomposedAffine | number[] | undefined
        ): number[] => {
            if (!transform) return [1, 0, 0, 1, 0, 0];
            if (Array.isArray(transform)) return transform;
            // Use the proper transform composition from DecomposedAffineTransform
            return Array.from(DecomposedAffineTransform.toAffine(transform));
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
            shapes: Unsafe[],
            transform: number[] = [1, 0, 0, 1, 0, 0],
            sourceLayer?: Layer
        ) => {
            if (!shapes || !Array.isArray(shapes)) return;

            for (const shape of shapes) {
                // Handle both nested { Component: { reference, transform } } and flat { reference, transform }
                const isNestedComponent = 'Component' in shape;
                const componentData = isNestedComponent
                    ? (shape as Unsafe).Component
                    : shape;

                if ('reference' in componentData) {
                    // Component - recursively process its outline shapes with accumulated transform
                    const compTransform = toAffineArray(
                        componentData.transform
                    );
                    const combinedTransform = combineTransforms(
                        transform,
                        compTransform
                    );

                    // Get component's layer data - either from pre-populated layerData
                    // or by looking up the component glyph in the font
                    let componentLayerData = componentData.layerData;
                    let nestedSource = sourceLayer;

                    if (!componentLayerData && font) {
                        const componentGlyph = font.findGlyph(
                            componentData.reference
                        );
                        if (componentGlyph && componentGlyph.layers) {
                            let layer = sourceLayer?.getMatchingLayerOnGlyph(
                                componentData.reference
                            );
                            if (!layer && masterId) {
                                layer = componentGlyph.layers.find(
                                    (l) =>
                                        l.data.master &&
                                        (l.data.master as Unsafe).master ===
                                            masterId
                                );
                            }
                            if (!layer) {
                                layer = componentGlyph.layers[0];
                            }
                            if (layer) {
                                componentLayerData = layer.toJSON();
                                nestedSource = layer;
                            }
                        }
                    }

                    // Recursively process the component's actual outline shapes
                    if (componentLayerData && componentLayerData.shapes) {
                        processShapes(
                            componentLayerData.shapes,
                            combinedTransform,
                            nestedSource
                        );
                    }
                } else if ('Path' in shape && shape.Path?.nodes) {
                    const nodes = Array.isArray(shape.Path.nodes)
                        ? shape.Path.nodes
                        : [];

                    if (nodes.length > 0) {
                        // Transform all nodes and create a new path
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transform)
                        );

                        flattenedPaths.push({
                            nodes: transformedNodes,
                            closed: shape.Path.closed
                        });
                    }
                } else if ('nodes' in shape && Array.isArray(shape.nodes)) {
                    const nodes = shape.nodes;

                    if (nodes.length > 0) {
                        // Transform all nodes and create a new path
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transform)
                        );

                        flattenedPaths.push({
                            nodes: transformedNodes,
                            closed:
                                shape.closed !== undefined ? shape.closed : true
                        });
                    }
                }
            }
        };

        // Process all shapes
        if (layerData.shapes) {
            processShapes(layerData.shapes, [1, 0, 0, 1, 0, 0], matchingSource);
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
                paths.push(pathData as Babelfont.Path);
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

        if (!this.shapes) {
            return paths;
        }

        for (const shape of this.shapes) {
            if (shape.isPath()) {
                // Add direct path
                const pathData = shape.asPath().toJSON();
                paths.push(pathData as Babelfont.Path);
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
     * @param matchingSource - Layer whose designspace location selects component layers
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    static calculateBoundingBox(
        layerData: Unsafe,
        includeAnchors: boolean = false,
        font?: Font,
        masterId?: string,
        matchingSource?: Layer
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        let bounds = null;

        // Get all paths (we need to use the static flattenComponents for compatibility)
        // since we're working with raw layer data, not a Layer instance
        const paths = Layer.flattenComponents(
            layerData,
            font,
            masterId,
            matchingSource
        );

        // Process all paths
        for (const path of paths) {
            const pathBounds = Layer.calculatePathBounds(path);
            if (pathBounds) {
                bounds = bounds
                    ? {
                          minX: Math.min(bounds.minX, pathBounds.minX),
                          minY: Math.min(bounds.minY, pathBounds.minY),
                          maxX: Math.max(bounds.maxX, pathBounds.maxX),
                          maxY: Math.max(bounds.maxY, pathBounds.maxY),
                          width: 0,
                          height: 0
                      }
                    : { ...pathBounds };
            }
        }

        // Include anchors in bounding box if requested
        if (includeAnchors && layerData.anchors) {
            for (const anchor of layerData.anchors) {
                bounds = bounds
                    ? {
                          minX: Math.min(bounds.minX, anchor.x),
                          minY: Math.min(bounds.minY, anchor.y),
                          maxX: Math.max(bounds.maxX, anchor.x),
                          maxY: Math.max(bounds.maxY, anchor.y),
                          width: 0,
                          height: 0
                      }
                    : {
                          minX: anchor.x,
                          minY: anchor.y,
                          maxX: anchor.x,
                          maxY: anchor.y,
                          width: 0,
                          height: 0
                      };
            }
        }

        if (!bounds) {
            // Distinguish "genuinely empty" (space) from "geometry present but
            // unreadable". The advance-shaped fallback below is correct only for
            // the former; for the latter it masquerades as valid ink bounds and
            // makes every sidebearing read return 0.
            const hasPathGeometry =
                Array.isArray(layerData.shapes) &&
                layerData.shapes.some((shape: Unsafe) => {
                    if (!shape || typeof shape !== 'object') return false;
                    const record = shape as Record<string, Unsafe>;
                    const pathRecord = (record.Path ??
                        record.Contour ??
                        record) as Record<string, Unsafe>;
                    const nodes = pathRecord?.nodes;
                    return Array.isArray(nodes) && nodes.length > 0;
                });
            if (hasPathGeometry) {
                console.warn(
                    '[Layer] Bounding box could not be measured despite present ' +
                        'path geometry. Falling back to advance-shaped bounds; ' +
                        'sidebearing reads from this layer are not trustworthy.',
                    {
                        width: layerData.width,
                        shapeCount: layerData.shapes?.length
                    }
                );
            }

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
            minX: bounds.minX,
            minY: bounds.minY,
            maxX: bounds.maxX,
            maxY: bounds.maxY,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY
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

        const matchingSource = this.getComponentResolutionLayer();
        return Layer.calculateBoundingBox(
            this.data,
            includeAnchors,
            font,
            matchingSource.getMasterId(),
            matchingSource
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
                    const curveIntersections = curve.intersects(line as Unsafe);

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

        // Remove duplicate intersections (can occur when paths share exact endpoints)
        const uniqueIntersections: Array<{ x: number; y: number; t: number }> =
            [];
        for (const intersection of intersections) {
            const isDuplicate = uniqueIntersections.some(
                (existing) =>
                    Math.abs(existing.x - intersection.x) < 0.001 &&
                    Math.abs(existing.y - intersection.y) < 0.001 &&
                    Math.abs(existing.t - intersection.t) < 0.001
            );
            if (!isDuplicate) {
                uniqueIntersections.push(intersection);
            }
        }

        // Sort intersections by t parameter (distance along line from p1)
        uniqueIntersections.sort((a, b) => a.t - b.t);

        return uniqueIntersections;
    }

    /**
     * Calculate sidebearings at a given Y height by measuring distance from glyph edges to first/last outline intersections
     * @param y - Y coordinate at which to measure
     * @returns Object with left and right sidebearing distances, or null if no intersections found at this height. Negative values indicate outline extends beyond glyph edges.
     */
    getSidebearingsAtHeight(y: number): {
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
     * Background layers resolve component references through their partner
     * foreground layer so painted geometry matches that foreground's
     * master-bound neighbour on the referenced glyph.
     */
    private getComponentResolutionLayer(): Layer {
        if (!this.is_background) {
            return this;
        }
        const partner = this.backgroundLayer;
        return partner && !partner.is_background ? partner : this;
    }

    /**
     * Find the exact matching stored layer on another glyph for this layer's
     * effective designspace location.
     * Background layers resolve through their partner foreground layer.
     */
    getMatchingLayerOnGlyph(glyphName: string): Layer | undefined {
        const source = this.getComponentResolutionLayer();
        if (source !== this) {
            return source.getMatchingLayerOnGlyph(glyphName);
        }

        const font = this.getFont();
        const designspaceLocation = this.getEffectiveDesignspaceLocation();
        if (!font || !designspaceLocation) {
            return undefined;
        }

        const targetGlyph = font.findGlyph(glyphName);
        if (!targetGlyph || !targetGlyph.layers) {
            return undefined;
        }

        for (const layer of targetGlyph.layers) {
            if (
                locationsMatch(
                    designspaceLocation,
                    layer.getEffectiveDesignspaceLocation(),
                    font.axes
                )
            ) {
                return layer;
            }
        }

        return undefined;
    }

    /**
     * Returns a normalized outline-compatibility fingerprint for this layer.
     * The fingerprint includes components, paths, and anchors, with anchors
     * sorted by name and guides excluded.
     */
    get fingerprint(): string {
        const componentSignatures = (this.components || []).map(
            (component) => `C:${component.reference || ''}`
        );
        const pathSignatures = (this.paths || []).map((path) => {
            const nodeTypes = path.nodes.map((node) =>
                Layer.normalizeSignatureNodeType(node.nodetype)
            );
            const closedFlag = path.closed === false ? '0' : '1';
            const booleanSuffix = path.isSubtraction ? ':subtraction' : '';
            return `P:${closedFlag}:${nodeTypes.length}:${nodeTypes.join(',')}${booleanSuffix}`;
        });
        const anchorSignatures = (this.anchors || [])
            .map((anchor) => `A:${anchor.name || ''}`)
            .sort((a, b) => a.localeCompare(b));

        return [
            `components[${componentSignatures.join('|')}]`,
            `paths[${pathSignatures.join('|')}]`,
            `anchors[${anchorSignatures.join('|')}]`
        ].join(';');
    }

    /**
     * Internal helper for multi-layer editing workflows.
     * Returns sibling layers on the same glyph that are currently linked and
     * structurally compatible with this layer via matching fingerprints.
     */
    _getLinkedLayers(): Layer[] {
        const glyph = this.parent() as Glyph | null;
        if (!glyph || this.is_background || !this.linked) {
            return [];
        }

        const referenceFingerprint = this.fingerprint;
        const linkedLayers = (glyph.layers || []).filter(
            (layer) =>
                !areSameModelObject(layer, this) &&
                !layer.is_background &&
                layer.linked !== false &&
                layer.fingerprint === referenceFingerprint
        );

        return getReadOnlyCollectionValue(
            linkedLayers,
            'Layer._getLinkedLayers() returns a read-only collection view.'
        );
    }

    toString(): string {
        const masterId = this.getMasterId() || 'Unsafe';
        const shapesCount = this.shapes?.length || 0;
        return `<Layer width=${this.width} master="${masterId}" shapes=${shapesCount}>`;
    }
}

function getAppliedMetricsKeySidebearing(
    layer: Layer,
    side: SidebearingSide,
    resolution: MetricsKeyResolution
): { value: number | null; error: string | null } {
    if (resolution.error || resolution.value === null) {
        return {
            value: null,
            error: resolution.error ?? 'Invalid metrics-key calculation'
        };
    }

    const font = (layer.parent() as Glyph | undefined)?.parent() as
        Font | undefined;
    if (!font || !resolution.input) {
        return { value: resolution.value, error: null };
    }

    const parsed = parseMetricsKey(font, resolution.input);
    if (
        'error' in parsed ||
        parsed.kind !== 'reference' ||
        parsed.offsetY === null
    ) {
        return { value: resolution.value, error: null };
    }

    const measured = layer.getSidebearingsAtHeight(parsed.offsetY);
    if (!measured) {
        return {
            value: null,
            error: `Could not measure current sidebearings at height ${parsed.offsetY}`
        };
    }

    const measuredSidebearing =
        side === 'left' ? measured.left : measured.right;
    const directSidebearing = side === 'left' ? layer.lsb : layer.rsb;

    return {
        value: roundMetricValue(
            directSidebearing + (resolution.value - measuredSidebearing)
        ),
        error: null
    };
}

/**
 * Glyph in the font
 */
const GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY =
    'com.schriftgestalt.Glyphs.attr';

function canonicalizeFeatureVariationAxisRules(
    layer: Babelfont.Layer
): string | null {
    const attributes =
        layer.format_specific?.[GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY];
    const axisRules =
        attributes &&
        typeof attributes === 'object' &&
        !Array.isArray(attributes)
            ? (attributes as Record<string, Unsafe>).axisRules
            : undefined;

    if (!Array.isArray(axisRules)) {
        return null;
    }

    const normalize = (value: Unsafe): Unsafe => {
        if (Array.isArray(value)) {
            return value.map(normalize);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, normalize(value[key])])
            );
        }
        return value;
    };

    return JSON.stringify(normalize(axisRules));
}

function glyphTreeHasSubtraction(
    glyph: Glyph,
    visiting: Set<string> = new Set()
): boolean {
    const glyphName = glyph?.name;
    if (!glyphName || visiting.has(glyphName)) {
        return false;
    }
    visiting.add(glyphName);
    const font = glyph.parent();
    for (const layer of glyph.layers || []) {
        if (layer.is_background) {
            continue;
        }
        for (const shape of layer.shapes || []) {
            if (shape.isPath?.() && shape.asPath().isSubtraction) {
                return true;
            }
            if (shape.isComponent?.()) {
                const reference = shape.asComponent().reference;
                const referenced =
                    font && typeof font.findGlyph === 'function'
                        ? font.findGlyph(reference)
                        : null;
                if (
                    referenced &&
                    glyphTreeHasSubtraction(referenced, visiting)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

function glyphBooleanSourceKey(glyph: Glyph): string {
    const parts: string[] = [];
    const font = glyph.parent();
    const visit = (current: Glyph, visiting: Set<string>): void => {
        if (!current?.name || visiting.has(current.name)) {
            return;
        }
        visiting.add(current.name);
        for (const layer of current.layers || []) {
            if (layer.is_background) {
                continue;
            }
            parts.push(
                `${current.name}:${layer.id || ''}:${layer.fingerprint}`
            );
            for (const component of layer.components || []) {
                const referenced =
                    font && typeof font.findGlyph === 'function'
                        ? font.findGlyph(component.reference)
                        : null;
                if (referenced) {
                    visit(referenced, visiting);
                }
            }
        }
    };
    visit(glyph, new Set());
    return parts.join('\n');
}

export class Glyph extends ArrayElementBase {
    private _layerWrappers: Layer[] | null = null;

    private getGlobalSidebearingKey(side: SidebearingSide): string | undefined {
        return normalizeMetricsKeyValue(
            getModelFormatSpecific(this)?.[
                getGlyphMetricFormatSpecificKey(side)
            ] as string | undefined
        );
    }

    private setGlobalSidebearingKey(
        side: SidebearingSide,
        value: string | undefined
    ): void {
        // The metrics-key dependency graph is cached; any key write invalidates it.
        (
            this.parent() as Font | undefined
        )?.invalidateMetricsKeyDependencyEntries?.();
        setFormatSpecificKey(
            this,
            getGlyphMetricFormatSpecificKey(side),
            value
        );
    }

    get leftMetricsKey(): string | undefined {
        return this.getGlobalSidebearingKey('left');
    }

    set leftMetricsKey(value: string | undefined) {
        assertModelMutationAllowed();
        this.setGlobalSidebearingKey('left', normalizeMetricsKeyValue(value));
    }

    get rightMetricsKey(): string | undefined {
        return this.getGlobalSidebearingKey('right');
    }

    set rightMetricsKey(value: string | undefined) {
        assertModelMutationAllowed();
        this.setGlobalSidebearingKey('right', normalizeMetricsKeyValue(value));
    }

    getPathSegment(): (string | number)[] {
        return ['glyphs', this.data.name || ''];
    }

    private createUniqueLayerId(requestedLayerId?: string | null): string {
        const existingIds = new Set(
            (this.data.layers || [])
                .map((layer: Unsafe) => layer.id)
                .filter((id: Unsafe) => id)
        );
        if (
            requestedLayerId &&
            typeof requestedLayerId === 'string' &&
            !existingIds.has(requestedLayerId)
        ) {
            return requestedLayerId;
        }

        let layerId: string;
        do {
            layerId = crypto.randomUUID();
        } while (existingIds.has(layerId));
        return layerId;
    }

    private appendRawLayer(layerData: Babelfont.Layer): Layer {
        assertModelMutationAllowed();
        if (!this.data.layers) {
            this.data.layers = [];
        }
        assertModelMutationAllowed();
        this.data.layers.push(layerData);
        this._layerWrappers = null;
        recordAddAndMarkDirty(
            [
                ...this.getPath(),
                'layers',
                layerData.id || this.data.layers.length - 1
            ],
            layerData
        );
        return new Layer(this.data.layers, this.data.layers.length - 1, this);
    }

    getFeatureVariationLayerEntries(
        familyId?: string
    ): Array<{ familyId: string; layer: Layer }> {
        if (!this.data.layers) {
            return [];
        }

        return this.data.layers.flatMap((layerData: Unsafe, index: number) => {
            if (layerData.is_background) {
                return [];
            }
            const master = layerData.master as Unsafe;
            if (
                !master ||
                typeof master !== 'object' ||
                master.type !== 'AssociatedWithMaster'
            ) {
                return [];
            }
            const resolvedFamilyId =
                canonicalizeFeatureVariationAxisRules(layerData);
            if (
                !resolvedFamilyId ||
                (familyId && familyId !== resolvedFamilyId)
            ) {
                return [];
            }
            return [
                {
                    familyId: resolvedFamilyId,
                    layer: new Layer(this.data.layers!, index, this)
                }
            ];
        });
    }

    /**
     * Synthetic, authorable views over this glyph's raw Glyphs feature-variation layers.
     */
    get featureVariations(): FeatureVariationGlyph[] {
        const familyIds = new Set(
            this.getFeatureVariationLayerEntries().map(
                (entry) => entry.familyId
            )
        );
        return getReadOnlyCollectionValue(
            Array.from(
                familyIds,
                (familyId) => new FeatureVariationGlyph(this, familyId)
            ),
            'Glyph.featureVariations is a read-only collection view. Use addFeatureVariation() or removeFeatureVariation() for structural edits.'
        );
    }

    /**
     * Create one associated feature-variation layer for every base master layer,
     * copying each layer's materialized background when present.
     */
    addFeatureVariation(
        axisRules: FeatureVariationAxisRule[]
    ): FeatureVariationGlyph {
        assertModelMutationAllowed();
        const template = {
            format_specific: {
                [GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY]: { axisRules }
            }
        } as unknown as Babelfont.Layer;
        const familyId = canonicalizeFeatureVariationAxisRules(template);
        if (!familyId) {
            throw new Error('Feature variation axisRules must be an array.');
        }
        if (this.getFeatureVariationLayerEntries(familyId).length > 0) {
            throw new Error(
                'A feature variation with these axis rules already exists.'
            );
        }

        const baseLayers = (this.data.layers || []).filter(
            (layerData: Unsafe) => {
                const master = layerData.master as Unsafe;
                return (
                    !layerData.is_background &&
                    master &&
                    typeof master === 'object' &&
                    master.type === 'DefaultForMaster'
                );
            }
        );
        if (baseLayers.length === 0) {
            throw new Error(
                'Feature variations require at least one base master layer.'
            );
        }

        return withBridgeTransaction('Add feature variation', () => {
            for (const baseLayer of baseLayers) {
                const masterId = (baseLayer.master as Unsafe).master;
                const layerData = cloneForHistory(baseLayer) as Babelfont.Layer;
                const baseBackgroundLayer = baseLayer.background_layer_id
                    ? this.data.layers?.find(
                          (candidate: Unsafe) =>
                              candidate.id === baseLayer.background_layer_id &&
                              candidate.is_background
                      )
                    : undefined;
                layerData.id = this.createUniqueLayerId();
                layerData.master = {
                    type: 'AssociatedWithMaster',
                    master: masterId
                } as Babelfont.LayerType;
                delete layerData.location;
                delete layerData.is_background;
                delete layerData.background_layer_id;
                const attributes =
                    layerData.format_specific?.[
                        GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY
                    ];
                layerData.format_specific = {
                    ...(layerData.format_specific || {}),
                    [GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY]: {
                        ...(attributes &&
                        typeof attributes === 'object' &&
                        !Array.isArray(attributes)
                            ? cloneForHistory(attributes)
                            : {}),
                        axisRules: cloneForHistory(axisRules)
                    }
                };

                if (baseBackgroundLayer) {
                    const backgroundLayerData = cloneForHistory(
                        baseBackgroundLayer
                    ) as Babelfont.Layer;
                    backgroundLayerData.id = this.createUniqueLayerId();
                    backgroundLayerData.master = cloneForHistory(
                        layerData.master
                    );
                    delete backgroundLayerData.location;
                    backgroundLayerData.is_background = true;
                    backgroundLayerData.background_layer_id = layerData.id;
                    layerData.background_layer_id = backgroundLayerData.id;
                    this.appendRawLayer(layerData);
                    this.appendRawLayer(backgroundLayerData);
                    continue;
                }

                this.appendRawLayer(layerData);
            }

            return new FeatureVariationGlyph(this, familyId);
        });
    }

    /**
     * Delete every raw layer belonging to a feature-variation family.
     */
    removeFeatureVariation(
        featureVariation: FeatureVariationGlyph | string
    ): void {
        assertModelMutationAllowed();
        const familyId =
            typeof featureVariation === 'string'
                ? featureVariation
                : featureVariation.id;
        withBridgeTransaction('Remove feature variation', () => {
            const layerIds = this.getFeatureVariationLayerEntries(familyId)
                .flatMap((entry) => [
                    entry.layer.id,
                    entry.layer.background_layer_id
                ])
                .filter((layerId): layerId is string => !!layerId);
            for (const layerId of layerIds) {
                this.removeLayerById(layerId);
            }
        });
    }

    private static readonly BUILTIN_CATEGORIES = new Set([
        'Base',
        'Mark',
        'Unknown',
        'Ligature'
    ]);

    static normalizeCategory(
        value: Babelfont.GlyphCategory | string | undefined
    ): Babelfont.GlyphCategory {
        if (
            typeof value === 'object' &&
            value !== null &&
            'Custom' in value &&
            typeof (value as { Custom?: Unsafe }).Custom === 'string'
        ) {
            return value as Babelfont.GlyphCategory;
        }

        if (typeof value === 'string') {
            return Glyph.BUILTIN_CATEGORIES.has(value)
                ? (value as Babelfont.GlyphCategory)
                : { Custom: value };
        }

        return 'Unknown';
    }

    private getLayerIdentifier(layer: Layer): string {
        return layer.id || layer.master?.master || '[Unsafe-layer]';
    }

    get name(): string {
        return this.data.name;
    }

    get id(): string {
        if (typeof this.data.id !== 'string' || !this.data.id) {
            this.data.id = generateStableId();
        }
        return this.data.id;
    }

    set name(value: string) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        // Invalidate caches that key on glyph names (e.g. metrics-key prefix
        // lookup table and reverse component index).
        const font = this.parent() as Font | null;
        if (
            font &&
            typeof font.invalidateReverseComponentIndex === 'function'
        ) {
            font.invalidateReverseComponentIndex();
        }
        recordAndMarkDirty(this, 'name', old, value);
    }

    get production_name(): string | undefined {
        return this.data.production_name;
    }

    set production_name(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.production_name;
        this.data.production_name = value;
        recordAndMarkDirty(this, 'production_name', old, value);
    }

    get category(): Babelfont.GlyphCategory {
        return getLiveMutableValue(
            this,
            'category',
            Glyph.normalizeCategory(this.data.category),
            () => Glyph.normalizeCategory(this.data.category)
        );
    }

    set category(value: Babelfont.GlyphCategory | string) {
        assertModelMutationAllowed();
        const old = this.data.category;
        this.data.category = Glyph.normalizeCategory(value);
        recordAndMarkDirty(this, 'category', old, this.data.category);
    }

    get codepoints(): number[] | undefined {
        return getLiveMutableValue(
            this,
            'codepoints',
            this.data.codepoints,
            () => this.data.codepoints
        );
    }

    set codepoints(value: number[] | undefined) {
        assertModelMutationAllowed();
        const old = this.data.codepoints;
        this.data.codepoints = value;
        recordAndMarkDirty(this, 'codepoints', old, value);
    }

    /**
     * Read-only Unicode metadata from the bundled Glyph Data catalog.
     * Encoded base glyphs win over editable glyph names; dotted glyphs inherit
     * the identity of their base glyph before a name fallback is attempted.
     * Fields include `character`, `glyph_name`, `name`, `codepoint`,
     * `general_category`, `category`, `script`, `script_extensions`, `block`,
     * `age`, `joining_type`, `joining_group`, `decomposition`,
     * `combining_class`, `bidi_class`, `uppercase`, `lowercase`, `titlecase`.
     */
    get glyphData(): GlyphDataSearchResult | undefined {
        const font = this.parent() as Font | null;
        const baseName = this.name.split('.', 1)[0] || this.name;
        const baseGlyph =
            baseName !== this.name ? font?.findGlyph(baseName) : this;
        const target = baseGlyph || this;
        const record =
            glyphDataIndex.getGlyphDataForUnicode(target.codepoints) ||
            glyphDataIndex.getGlyphDataForName(target.name) ||
            (baseGlyph
                ? undefined
                : glyphDataIndex.getGlyphDataForName(baseName));
        return record;
    }

    /**
     * Read-only quality-assurance messages for this glyph. Built-in Auto QA
     * plus future plugin checks. Each item is a dict with `sourceId`,
     * `severity`, `checkId`, `message`, and `messageId`. Empty when the
     * glyph cannot be identified or no checks fire. Does not write the font.
     * @example
     * for message in glyph.qa:
     *     print(message.checkId, message.message)
     */
    get qa(): GlyphQaMessage[] {
        const font = this.parent() as Font | null;
        const name = this.name;
        const messages =
            !font || typeof name !== 'string' || !name
                ? []
                : toGlyphQaMessages(labelsForGlyph(font, name));
        return getReadOnlyCollectionValue(
            messages,
            'Glyph.qa is a read-only snapshot. It does not write the font.'
        );
    }

    /**
     * Copy computed component-stack anchors onto every foreground layer.
     * An empty list writes every computed anchor; otherwise only the named
     * anchors that exist in the computed set are added or updated.
     * @example
     * glyph.applyComputedAnchors()
     * glyph.applyComputedAnchors(["top"])
     */
    applyComputedAnchors(anchorNames: string[] = []): boolean {
        assertModelMutationAllowed();
        return withBridgeTransaction('Apply computed anchors', () => {
            const requestedNames = new Set(
                (anchorNames || []).filter(
                    (name): name is string =>
                        typeof name === 'string' && name.length > 0
                )
            );
            const applyAll = requestedNames.size === 0;
            let changed = false;

            for (const layer of this.layers || []) {
                if (layer.is_background) {
                    continue;
                }

                const computed = layer.computedAnchors();
                const names = applyAll
                    ? Object.keys(computed)
                    : [...requestedNames];
                for (const name of names) {
                    const point = computed[name];
                    if (!point) {
                        continue;
                    }

                    const existing = layer.findAnchor(name);
                    if (existing) {
                        if (
                            Math.abs(existing.x - point.x) >
                                METRIC_UPDATE_EPSILON ||
                            Math.abs(existing.y - point.y) >
                                METRIC_UPDATE_EPSILON
                        ) {
                            existing.x = point.x;
                            existing.y = point.y;
                            changed = true;
                        }
                        continue;
                    }

                    layer.addAnchor(point.x, point.y, name);
                    changed = true;
                }
            }

            if (changed) {
                (
                    this.parent() as Font | undefined
                )?.rebuildAutomaticCompositesForGlyphs(new Set([this.name]));
            }

            return changed;
        });
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
                    (_: Unsafe, i: number) =>
                        new Layer(this.data.layers, i, this)
                );
            }
            return getReadOnlyCollectionValue(
                this._layerWrappers!,
                'Glyph.layers is a read-only collection view. Use addLayer() or removeLayer() for structural edits.'
            );
        }

        // Filter: foreground layers that are either
        // - default layers for their master, or
        // - brace layers (AssociatedWithMaster + non-empty location)
        const masterIds = new Set(fontMasters.map((m: Master) => m.id));
        const filteredIndices: number[] = [];

        for (let i = 0; i < this.data.layers.length; i++) {
            const layer = this.data.layers[i];

            const layerId = layer.id || '[no-layer-id]';
            assertTaggedLayerMaster(
                layer.master,
                `Glyph#${this.name}.${layerId}`
            );

            // Skip background layers
            if (layer.is_background) continue;

            // Feature-variation layers are exposed through featureVariations,
            // including their variation-owned intermediate layers.
            if (canonicalizeFeatureVariationAxisRules(layer)) continue;

            const isDefaultLayer =
                layer.master &&
                typeof layer.master === 'object' &&
                'type' in layer.master &&
                layer.master.type === 'DefaultForMaster';

            const isAssociatedLayer =
                layer.master &&
                typeof layer.master === 'object' &&
                'type' in layer.master &&
                layer.master.type === 'AssociatedWithMaster';

            const hasBraceLocation =
                !!layer.location && Object.keys(layer.location).length > 0;

            if (!isDefaultLayer && !(isAssociatedLayer && hasBraceLocation)) {
                continue;
            }

            let masterId: string | undefined;
            if (layer.master && typeof layer.master === 'object') {
                if ('type' in layer.master) {
                    masterId = (layer.master as Unsafe).master;
                }
            }
            if (!masterId) {
                masterId = layer._master || layer.id;
            }

            if (!masterId || !masterIds.has(masterId)) continue;

            filteredIndices.push(i);
        }

        // Create wrappers for filtered layers
        const wrappers = filteredIndices.map(
            (i: number) => new Layer(this.data.layers, i, this)
        );

        // Sort by master order.
        // Within one master, keep default layer first and brace layers after it.
        wrappers.sort((a, b) => {
            const getMasterId = (layer: Layer): string => {
                const masterData = layer.master;
                if (masterData && typeof masterData === 'object') {
                    if ('type' in masterData) {
                        return (masterData as Unsafe).master || '';
                    }
                }
                return layer.id || '';
            };

            const getLayerTypeRank = (layer: Layer): number => {
                const masterData = layer.master;
                if (
                    masterData &&
                    typeof masterData === 'object' &&
                    'type' in masterData &&
                    masterData.type === 'DefaultForMaster'
                ) {
                    return 0;
                }
                return 1;
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

            if (posA !== posB) {
                return posA - posB;
            }

            const typeRankA = getLayerTypeRank(a);
            const typeRankB = getLayerTypeRank(b);
            if (typeRankA !== typeRankB) {
                return typeRankA - typeRankB;
            }

            return 0;
        });

        return getReadOnlyCollectionValue(
            wrappers,
            'Glyph.layers is a read-only collection view. Use addLayer() or removeLayer() for structural edits.'
        );
    }

    get exported(): boolean | undefined {
        return this.data.exported;
    }

    set exported(value: boolean | undefined) {
        assertModelMutationAllowed();
        const old = this.data.exported;
        this.data.exported = value;
        recordAndMarkDirty(this, 'exported', old, value);
    }

    get direction(): Babelfont.Direction | undefined {
        return this.data.direction;
    }

    set direction(value: Babelfont.Direction | undefined) {
        assertModelMutationAllowed();
        const old = this.data.direction;
        this.data.direction = value;
        recordAndMarkDirty(this, 'direction', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Add a new layer to the glyph.
     *
     * Default-for-master layers use the master id as the layer id so fontc
     * can resolve each source to a master location.
     * @example
     * layer = glyph.addLayer(500)  # 500 units wide
     * layer = glyph.addLayer(500, {"type": "DefaultForMaster", "master": master.id}, master.id)
     */
    addLayer(
        width: number,
        master?: Babelfont.LayerType,
        requestedLayerId?: string | null
    ): Layer {
        assertModelMutationAllowed();
        if (!this.data.layers) {
            this.data.layers = [];
        }

        const defaultMasterId =
            master?.type === 'DefaultForMaster' &&
            typeof master.master === 'string' &&
            master.master.length
                ? master.master
                : null;
        const layerData: Babelfont.Layer = {
            width,
            id: this.createUniqueLayerId(requestedLayerId ?? defaultMasterId),
            shapes: []
        };
        if (master) {
            layerData.master = cloneForHistory(master);
        }
        return this.appendRawLayer(layerData);
    }

    addBackgroundLayer(foreground: Layer): Layer {
        assertModelMutationAllowed();
        if (foreground.is_background) {
            throw new Error(
                'A background layer cannot own another background layer'
            );
        }

        const existing = foreground.background_layer_id
            ? this.findLayerById(foreground.background_layer_id)
            : undefined;
        if (existing?.is_background) {
            return existing;
        }

        const background = this.addLayer(
            foreground.width,
            cloneForHistory(foreground.master)
        );
        background.location = cloneForHistory(foreground.location);
        background.is_background = true;
        background.background_layer_id = foreground.id;
        foreground.background_layer_id = background.id;
        return background;
    }

    /**
     * Remove a layer at the specified index
     */
    removeLayer(index: number): void {
        assertModelMutationAllowed();
        if (this.data.layers) {
            const removedLayer = this.data.layers[index];
            if (removedLayer === undefined) {
                return;
            }

            assertModelMutationAllowed();

            this.data.layers.splice(index, 1);
            this._layerWrappers = null; // Invalidate cache
            const layerKey = removedLayer.id ?? index;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'layers', layerKey],
                removedLayer
            );
        }
    }

    /**
     * Remove a layer by its backing-array ID.
     */
    removeLayerById(id: string): void {
        assertModelMutationAllowed();
        if (!this.data.layers) {
            return;
        }

        const index = this.data.layers.findIndex((layer: Unsafe) => {
            return layer.id === id;
        });

        if (index >= 0) {
            this.removeLayer(index);
        }
    }

    /**
     * Find a layer by ID
     */
    findLayerById(id: string): Layer | undefined {
        const index = this.data.layers.findIndex((l: Unsafe) => l.id === id);
        return index >= 0
            ? new Layer(this.data.layers, index, this)
            : undefined;
    }

    /**
     * Rewrite metrics keys and component refs on every stored layer, including
     * backgrounds filtered out of the public `layers` view.
     */
    _rewriteStoredLayerNameReferences(
        replaceName: (value: string) => string,
        replaceMetricsKey: (value: string | undefined) => string | undefined
    ): void {
        if (!Array.isArray(this.data.layers)) {
            return;
        }
        for (let index = 0; index < this.data.layers.length; index++) {
            const layer = new Layer(this.data.layers, index, this);
            const leftLayerKey = replaceMetricsKey(layer.leftMetricsKey);
            const rightLayerKey = replaceMetricsKey(layer.rightMetricsKey);
            if (leftLayerKey !== layer.leftMetricsKey) {
                layer.leftMetricsKey = leftLayerKey;
            }
            if (rightLayerKey !== layer.rightMetricsKey) {
                layer.rightMetricsKey = rightLayerKey;
            }
            for (const component of layer.components) {
                const reference = replaceName(component.reference);
                if (reference !== component.reference) {
                    component.reference = reference;
                }
            }
        }
    }

    /**
     * Remove component instances whose reference is in `deletedNames`.
     * Walks every stored layer, including backgrounds.
     */
    _removeStoredLayerComponentReferences(
        deletedNames: ReadonlySet<string>
    ): void {
        if (!Array.isArray(this.data.layers) || deletedNames.size === 0) {
            return;
        }
        for (let index = 0; index < this.data.layers.length; index++) {
            const layer = new Layer(this.data.layers, index, this);
            // Remove by descending index so later removals do not invalidate
            // earlier indices, and never retain Component wrappers across splices.
            for (
                let shapeIndex = (layer.shapes?.length ?? 0) - 1;
                shapeIndex >= 0;
                shapeIndex--
            ) {
                const shapes = layer.shapes;
                if (!shapes || shapeIndex >= shapes.length) {
                    continue;
                }
                const shape = shapes[shapeIndex];
                const rawShape = shape
                    ? ((shape as Unsafe).data as Unsafe | undefined)
                    : undefined;
                if (!rawShape || typeof rawShape !== 'object') {
                    continue;
                }
                const reference =
                    rawShape.reference ?? rawShape.Component?.reference;
                if (
                    typeof reference === 'string' &&
                    deletedNames.has(reference)
                ) {
                    layer.removeShape(shapeIndex);
                }
            }
        }
    }

    /**
     * Clear metrics keys on stored layers that reference deleted glyphs.
     */
    _clearStoredLayerMetricsKeysReferencing(
        deletedNames: ReadonlySet<string>,
        font: Font
    ): void {
        if (!Array.isArray(this.data.layers) || deletedNames.size === 0) {
            return;
        }
        const shouldClear = (rawKey: string | undefined): boolean => {
            if (!rawKey) return false;
            const parsed = parseMetricsKey(font, rawKey);
            if ('error' in parsed) return false;
            if (parsed.kind === 'reference' && parsed.glyphName) {
                return deletedNames.has(parsed.glyphName);
            }
            return (parsed.referencedGlyphNames || []).some((name) =>
                deletedNames.has(name)
            );
        };
        for (let index = 0; index < this.data.layers.length; index++) {
            const layer = new Layer(this.data.layers, index, this);
            if (shouldClear(layer.leftMetricsKey)) {
                layer.leftMetricsKey = undefined;
            }
            if (shouldClear(layer.rightMetricsKey)) {
                layer.rightMetricsKey = undefined;
            }
        }
    }

    /**
     * Find a layer by master ID
     */
    findLayerByMasterId(masterId: string): Layer | undefined {
        const index = this.data.layers.findIndex((l: Unsafe) => {
            const master = l.master;
            if (!master) return false;
            if (typeof master === 'object') {
                if (
                    master.type === 'DefaultForMaster' &&
                    master.master === masterId
                ) {
                    return true;
                }
                if (
                    master.type === 'AssociatedWithMaster' &&
                    master.master === masterId
                ) {
                    return true;
                }
            }
            return false;
        });
        return index >= 0
            ? new Layer(this.data.layers, index, this)
            : undefined;
    }

    /**
     * Returns True/False based on whether the outline structure (components + paths + anchors) is compatible across all main layers of this glyph.
     */
    get isCompatible(): boolean {
        return this.calculateOutlineCompatibility().compatible;
    }

    /**
     * Compare outline structure across main layers (the same list shown in the UI).
     *
     * Source fingerprints include path `fip001-boolean` flags. When any path in
     * this glyph or its component tree is a subtraction cutter, compatibility
     * also ANDs post-boolean (Linesweeper) fingerprints from the compile worker.
     */
    calculateOutlineCompatibility(): {
        compatible: boolean;
        layerCount: number;
        referenceLayerId?: string;
        incompatibleLayerIds: string[];
    } {
        const layers = this.layers || [];
        if (layers.length === 0) {
            return {
                compatible: true,
                layerCount: 0,
                incompatibleLayerIds: []
            };
        }

        if (layers.length === 1) {
            return {
                compatible: true,
                layerCount: 1,
                referenceLayerId: this.getLayerIdentifier(layers[0]),
                incompatibleLayerIds: []
            };
        }

        const referenceLayer = layers[0];
        const referenceLayerId = this.getLayerIdentifier(referenceLayer);
        const referenceFingerprint = referenceLayer.fingerprint;
        const incompatibleLayerIds: string[] = [];

        for (let i = 1; i < layers.length; i++) {
            const layer = layers[i];
            if (layer.fingerprint !== referenceFingerprint) {
                incompatibleLayerIds.push(this.getLayerIdentifier(layer));
            }
        }

        if (glyphTreeHasSubtraction(this)) {
            const sourceKey = glyphBooleanSourceKey(this);
            const cached = filteredBooleanFingerprintCache.get(this.name);
            if (!cached || cached.sourceKey !== sourceKey) {
                this.scheduleFilteredBooleanFingerprintRefresh(sourceKey);
            } else {
                const referenceFiltered = cached.layers[referenceLayerId];
                for (let i = 1; i < layers.length; i++) {
                    const layer = layers[i];
                    const layerId = this.getLayerIdentifier(layer);
                    if (cached.layers[layerId] !== referenceFiltered) {
                        if (!incompatibleLayerIds.includes(layerId)) {
                            incompatibleLayerIds.push(layerId);
                        }
                    }
                }
            }
        }

        return {
            compatible: incompatibleLayerIds.length === 0,
            layerCount: layers.length,
            referenceLayerId,
            incompatibleLayerIds
        };
    }

    private scheduleFilteredBooleanFingerprintRefresh(sourceKey: string): void {
        if (typeof window === 'undefined') {
            return;
        }
        if (window.glyphCanvas?.outlineEditor?.draggingSomething) {
            return;
        }
        const glyphName = this.name;
        if (!glyphName) {
            return;
        }
        if (filteredBooleanFingerprintInflight.get(glyphName) === sourceKey) {
            return;
        }
        const fontCompilation = window.fontCompilation as
            | {
                  requestFilteredBooleanFingerprints?: (
                      name: string
                  ) => Promise<Record<string, string>>;
              }
            | undefined;
        if (
            typeof fontCompilation?.requestFilteredBooleanFingerprints !==
            'function'
        ) {
            return;
        }
        filteredBooleanFingerprintInflight.set(glyphName, sourceKey);
        void fontCompilation
            .requestFilteredBooleanFingerprints(glyphName)
            .then((layers) => {
                if (
                    filteredBooleanFingerprintInflight.get(glyphName) !==
                    sourceKey
                ) {
                    return;
                }
                filteredBooleanFingerprintInflight.delete(glyphName);
                filteredBooleanFingerprintCache.set(glyphName, {
                    sourceKey,
                    layers: layers || {}
                });
                const font = window.currentFontModel;
                const dependents =
                    font &&
                    typeof font.collectComponentDependentGlyphs === 'function'
                        ? font.collectComponentDependentGlyphs([glyphName], {
                              includeSourceGlyphNames: true
                          })
                        : new Set([glyphName]);
                // Post-boolean VF fingerprints arrived; refresh compatibility UI.
                window.dispatchEvent(
                    new CustomEvent('filteredBooleanCompatibilityUpdated', {
                        detail: {
                            glyphNames: [...dependents]
                        }
                    })
                );
                const glyph =
                    typeof font?.findGlyph === 'function'
                        ? font.findGlyph(glyphName)
                        : this;
                for (const layer of glyph?.layers || []) {
                    if (!layer?.id) {
                        continue;
                    }
                    window.dispatchEvent(
                        new CustomEvent('layerFingerprintChanged', {
                            detail: {
                                glyphName,
                                layerId: layer.id
                            }
                        })
                    );
                }
            })
            .catch(() => {
                if (
                    filteredBooleanFingerprintInflight.get(glyphName) ===
                    sourceKey
                ) {
                    filteredBooleanFingerprintInflight.delete(glyphName);
                }
            });
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
 * An authorable view over one conditional Glyphs feature-variation layer family.
 */
export class FeatureVariationGlyph {
    constructor(
        readonly sourceGlyph: Glyph,
        readonly id: string
    ) {}

    get name(): string {
        return this.sourceGlyph.name;
    }

    /**
     * Shared Glyphs feature-variation conditions. Each item is `{ min?, max? }`
     * for the corresponding font axis (same order as `font.axes`).
     * @example
     * feature_variation.axisRules[0].min
     */
    get axisRules(): FeatureVariationAxisRule[] {
        const layer = this.layers[0];
        const attributes = layer?.format_specific?.[
            GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY
        ] as Record<string, Unsafe> | undefined;
        return Array.isArray(attributes?.axisRules)
            ? (cloneForHistory(
                  attributes.axisRules
              ) as FeatureVariationAxisRule[])
            : [];
    }

    /**
     * Replace the shared Glyphs feature-variation rules on every raw family layer.
     */
    setAxisRules(axisRules: FeatureVariationAxisRule[]): FeatureVariationGlyph {
        const template = {
            format_specific: {
                [GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY]: { axisRules }
            }
        } as unknown as Babelfont.Layer;
        const nextFamilyId = canonicalizeFeatureVariationAxisRules(template);
        if (!nextFamilyId) {
            throw new Error('Feature variation axisRules must be an array.');
        }
        if (
            nextFamilyId !== this.id &&
            this.sourceGlyph.getFeatureVariationLayerEntries(nextFamilyId)
                .length > 0
        ) {
            throw new Error(
                'A feature variation with these axis rules already exists.'
            );
        }

        const layers = [...this.layers];
        if (layers.length === 0) {
            throw new Error('Feature variation has no associated layers.');
        }

        return withBridgeTransaction(
            'Update feature variation settings',
            () => {
                for (const layer of layers) {
                    const attributes =
                        layer.format_specific?.[
                            GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY
                        ];
                    layer.format_specific = {
                        ...(layer.format_specific || {}),
                        [GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY]: {
                            ...(attributes &&
                            typeof attributes === 'object' &&
                            !Array.isArray(attributes)
                                ? cloneForHistory(attributes)
                                : {}),
                            axisRules: cloneForHistory(axisRules)
                        }
                    };
                }

                return new FeatureVariationGlyph(
                    this.sourceGlyph,
                    nextFamilyId
                );
            }
        );
    }

    get layers(): Layer[] {
        return getReadOnlyCollectionValue(
            this.sourceGlyph
                .getFeatureVariationLayerEntries(this.id)
                .map((entry) => entry.layer),
            'FeatureVariationGlyph.layers is a read-only collection view. Use addLayer() or removeLayer() for structural edits.'
        );
    }

    findLayerById(id: string): Layer | undefined {
        return this.layers.find((layer) => layer.id === id);
    }

    findLayerByMasterId(masterId: string): Layer | undefined {
        return this.layers.find((layer) => {
            const master = layer.master as Unsafe;
            return master?.master === masterId;
        });
    }

    addLayer(
        width: number,
        master?: Babelfont.LayerType,
        requestedLayerId?: string | null
    ): Layer {
        assertModelMutationAllowed();
        if (!master || master.type !== 'AssociatedWithMaster') {
            throw new Error(
                'Feature-variation layers must be associated with a master.'
            );
        }
        const layer = this.sourceGlyph.addLayer(
            width,
            master,
            requestedLayerId
        );
        layer.format_specific = {
            ...(layer.format_specific || {}),
            [GLYPHS_FEATURE_VARIATION_ATTRIBUTES_KEY]: {
                axisRules: this.axisRules
            }
        };
        return layer;
    }

    removeLayer(index: number): void {
        assertModelMutationAllowed();
        const layer = this.layers[index];
        if (layer?.id) {
            this.sourceGlyph.removeLayerById(layer.id);
        }
    }

    removeLayerById(id: string): void {
        assertModelMutationAllowed();
        const layer = this.findLayerById(id);
        if (layer) {
            this.sourceGlyph.removeLayerById(id);
        }
    }

    toString(): string {
        return `<FeatureVariationGlyph "${this.name}" ${this.layers.length} layers>`;
    }
}

/**
 * Variation axis in a variable font
 */
export class Axis extends ArrayElementBase {
    getPathSegment(): (string | number)[] {
        return ['axes', this._index];
    }

    /**
     * Localized axis name. Access language tags as attributes
     * (`axis.name.dflt`). Do not use `.get()`.
     */
    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get tag(): string {
        return this.data.tag;
    }

    set tag(value: string) {
        assertModelMutationAllowed();
        const old = this.data.tag;
        this.data.tag = value;
        recordAndMarkDirty(this, 'tag', old, value);
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        assertModelMutationAllowed();
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    get min(): number | undefined {
        return this.data.min;
    }

    set min(value: number | undefined) {
        assertModelMutationAllowed();
        const old = this.data.min;
        this.data.min = value;
        recordAndMarkDirty(this, 'min', old, value);
    }

    get max(): number | undefined {
        return this.data.max;
    }

    set max(value: number | undefined) {
        assertModelMutationAllowed();
        const old = this.data.max;
        this.data.max = value;
        recordAndMarkDirty(this, 'max', old, value);
    }

    get default(): number | undefined {
        return this.data.default;
    }

    set default(value: number | undefined) {
        assertModelMutationAllowed();
        const old = this.data.default;
        this.data.default = value;
        recordAndMarkDirty(this, 'default', old, value);
    }

    /**
     * avar mapping: list of `[userspace, designspace]` coordinate pairs.
     */
    get map(): [number, number][] | undefined {
        return getLiveMutableValue(
            this,
            'map',
            this.data.map,
            () => this.data.map
        );
    }

    set map(value: [number, number][] | undefined) {
        assertModelMutationAllowed();
        const old = this.data.map;
        this.data.map = value;
        recordAndMarkDirty(this, 'map', old, value);
    }

    get hidden(): boolean | undefined {
        return this.data.hidden;
    }

    set hidden(value: boolean | undefined) {
        assertModelMutationAllowed();
        const old = this.data.hidden;
        this.data.hidden = value;
        recordAndMarkDirty(this, 'hidden', old, value);
    }

    get values(): number[] | undefined {
        return getLiveMutableValue(
            this,
            'values',
            this.data.values,
            () => this.data.values
        );
    }

    set values(value: number[] | undefined) {
        assertModelMutationAllowed();
        const old = this.data.values;
        this.data.values = value;
        recordAndMarkDirty(this, 'values', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const range = `${this.min || '?'}-${this.default || '?'}-${this.max || '?'}`;
        return `<Axis "${displayName}" tag="${this.tag}" ${range}>`;
    }
}

/**
 * Master/source in a design space
 */
export class Master extends ArrayElementBase {
    private _guideWrappers: Guide[] | null = null;

    getPathSegment(): (string | number)[] {
        return ['masters', this._index];
    }

    /**
     * Localized master name. Access language tags as attributes
     * (`master.name.dflt`). Do not use `.get()`.
     */
    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        assertModelMutationAllowed();
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    /**
     * Master location in designspace. Access axis tags as attributes
     * (`master.location.wght`).
     * @example
     * print(master.location)
     * print(master.location.wght)
     */
    get location(): DesignspaceLocation | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: DesignspaceLocation | undefined) {
        assertModelMutationAllowed();
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: Unsafe, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._guideWrappers!,
            'Master.guides is a read-only collection view. Use addGuide() or removeGuide() for structural edits.'
        );
    }

    addGuide(
        pos: Babelfont.Position,
        name?: string,
        color?: Babelfont.Color
    ): Guide {
        assertModelMutationAllowed();
        if (!this.data.guides) {
            this.data.guides = [];
        }

        const guideData: Babelfont.Guide = { id: generateStableId(), pos };
        if (name !== undefined) {
            guideData.name = name;
        }
        if (color !== undefined) {
            guideData.color = color;
        }

        assertModelMutationAllowed();

        this.data.guides.push(guideData);
        this._guideWrappers = null;
        const index = this.data.guides.length - 1;
        recordAddAndMarkDirty([...this.getPath(), 'guides', index], guideData);
        return new Guide(this.data.guides, index, this);
    }

    removeGuide(index: number): void {
        assertModelMutationAllowed();
        if (this.data.guides) {
            const removedGuide = this.data.guides[index];
            if (removedGuide === undefined) {
                return;
            }

            assertModelMutationAllowed();

            this.data.guides.splice(index, 1);
            this._guideWrappers = null;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'guides', index],
                removedGuide
            );
        }
    }

    /**
     * Per-master vertical metrics. Access as attributes: `XHeight`, `CapHeight`,
     * `Ascender`, `Descender`, `ItalicAngle`, `HheaAscender`, `HheaDescender`,
     * `HheaLineGap`, `WinAscent`, `WinDescent`, `TypoAscender`, `TypoDescender`,
     * `TypoLineGap`, `SubscriptXSize`, `SubscriptYSize`, `SubscriptXOffset`,
     * `SubscriptYOffset`, `SuperscriptXSize`, `SuperscriptYSize`,
     * `SuperscriptXOffset`, `SuperscriptYOffset`, `StrikeoutSize`,
     * `StrikeoutPosition`, `UnderlinePosition`, `UnderlineThickness`,
     * `HheaCaretSlopeRise`, `HheaCaretSlopeRun`, `HheaCaretOffset`.
     * @example
     * xh = master.metrics.XHeight
     * master.metrics.Ascender = 800
     */
    get metrics(): MasterMetrics {
        return getLiveMutableValue(
            this,
            'metrics',
            this.data.metrics,
            () => this.data.metrics
        );
    }

    set metrics(value: MasterMetrics) {
        assertModelMutationAllowed();
        const old = this.data.metrics;
        this.data.metrics = value;
        recordAndMarkDirty(this, 'metrics', old, value);
    }

    /**
     * LTR kerning: pair key `"left:right"` → value. Keys are glyph names or
     * `@groupName` (first vs second group from key position).
     * @example
     * master.kerning["A:V"] = -80
     */
    get kerning(): Record<string, number> {
        return getLiveMutableValue(
            this,
            'kerning',
            this.data.kerning,
            () => this.data.kerning
        );
    }

    set kerning(value: Record<string, number>) {
        assertModelMutationAllowed();
        const old = this.data.kerning;
        this.data.kerning = flattenKerningMap(value) as Unsafe;
        recordAndMarkDirty(this, 'kerning', old, this.data.kerning);
    }

    /**
     * RTL kerning: pair key `"first:second"` → value, same operand rules
     * as LTR.
     * @example
     * master.kerning_rtl["reh-ar:alef-ar"] = -80
     */
    get kerning_rtl(): Record<string, number> {
        return getLiveMutableValue(
            this,
            'kerning_rtl',
            this.data.kerning_rtl,
            () => this.data.kerning_rtl
        );
    }

    set kerning_rtl(value: Record<string, number>) {
        assertModelMutationAllowed();
        withBridgeTransaction('Set RTL kerning', () => {
            const old = this.data.kerning_rtl;
            this.data.kerning_rtl = value;
            const font = this.parent();
            if (font instanceof Font) {
                syncKerningRtlToFormatSpecific(font, this.data.id, value);
            }
            recordAndMarkDirty(this, 'kerning_rtl', old, value);
        });
    }

    /**
     * Per-master OpenType table overrides as a live dict (not a list).
     * Same keys as `Font.custom_ot_values`. Master-varying vertical metrics
     * belong on `metrics`, not here.
     */
    get custom_ot_values(): Babelfont.CustomOTValues | undefined {
        return getLiveMutableValue(
            this,
            'custom_ot_values',
            this.data.custom_ot_values,
            () => this.data.custom_ot_values
        );
    }

    set custom_ot_values(value: Babelfont.CustomOTValues | undefined) {
        assertModelMutationAllowed();
        const old = this.data.custom_ot_values;
        this.data.custom_ot_values = value;
        recordAndMarkDirty(this, 'custom_ot_values', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    async reinterpolateLayers(): Promise<void> {
        assertModelMutationAllowed();
        const outlineEditor =
            typeof window !== 'undefined'
                ? (window as Unsafe).glyphCanvas?.outlineEditor
                : null;
        if (
            outlineEditor &&
            typeof outlineEditor.reinterpolateAllLayersForMaster === 'function'
        ) {
            await outlineEditor.reinterpolateAllLayersForMaster(this.id);
            return;
        }

        const bridge = getPatchSyncEngine() as
            | (PatchSyncEngine & {
                  applyLocalGeneratedYjsUpdate?: (
                      update: Uint8Array,
                      operations: TransactionBufferedOperation[],
                      label: string | null,
                      historyTarget?: TransactionHistoryTarget | null
                  ) => unknown;
              })
            | null;
        if (!bridge?.applyLocalGeneratedYjsUpdate) {
            return;
        }

        beginLoadingCursor();
        beginStartupInteractionLock();
        try {
            const batchResult =
                await window.fontManager.buildWorkerReinterpolateMasterLayersBatch(
                    this.id
                );
            if (!batchResult.update.length && !batchResult.updates?.length) {
                return;
            }

            bridge.applyLocalGeneratedYjsUpdate(
                batchResult.update,
                buildInterpolationRustBatchOperations(batchResult.metadata),
                'Reinterpolate layer batch sync',
                null,
                batchResult.updates
            );
        } finally {
            endStartupInteractionLock();
            endLoadingCursor();
        }
    }

    async delete(): Promise<boolean> {
        const font = this.parent();
        if (!(font instanceof Font)) {
            return false;
        }

        return font.removeMastersByIds([this.id]);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Master "${displayName}" id="${this.id}" location=${location}>`;
    }
}

/**
 * Named instance in a variable font
 */
export class Instance extends ArrayElementBase {
    getPathSegment(): (string | number)[] {
        return ['instances', this._index];
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        assertModelMutationAllowed();
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    /**
     * Localized instance name. Access language tags as attributes
     * (`instance.name.dflt`). Do not use `.get()`.
     */
    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        assertModelMutationAllowed();
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    /**
     * Instance location in designspace. Access axis tags as attributes
     * (`instance.location.wght`).
     */
    get location(): DesignspaceLocation | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: DesignspaceLocation | undefined) {
        assertModelMutationAllowed();
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    /**
     * Same OpenType name-table fields as `Font.names`. Access language tags as
     * attributes (`instance.custom_names.family_name.dflt`). Do not use
     * `.get()`.
     */
    get custom_names(): Babelfont.Names {
        return getLiveMutableValue(
            this,
            'custom_names',
            this.data.custom_names,
            () => this.data.custom_names
        );
    }

    set custom_names(value: Babelfont.Names) {
        assertModelMutationAllowed();
        const old = this.data.custom_names;
        this.data.custom_names = value;
        recordAndMarkDirty(this, 'custom_names', old, value);
    }

    get variable(): boolean | undefined {
        return this.data.variable;
    }

    set variable(value: boolean | undefined) {
        assertModelMutationAllowed();
        const old = this.data.variable;
        this.data.variable = value;
        recordAndMarkDirty(this, 'variable', old, value);
    }

    get linked_style(): string | undefined {
        return this.data.linked_style;
    }

    set linked_style(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this.data.linked_style;
        this.data.linked_style = value;
        recordAndMarkDirty(this, 'linked_style', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Instance "${displayName}" location=${location}>`;
    }
}

/** Key under which Glyphs.app stores RTL kerning in Font.format_specific. */
const KEY_KERNING_RTL = 'com.schriftgestalt.Glyphs.kerningRTL';

/**
 * Convert a flat `kerning_rtl` map ("firstKey:secondKey" → value) back into
 * the nested Glyphs.app structure expected by `format_specific[KEY_KERNING_RTL]`:
 *
 *   { [masterId]: { [firstRestored]: { [secondRestored]: value } } }
 *
 * Group keys (starting with `@`) are restored to the `@MMK_R_`/`@MMK_L_`
 * prefix convention; plain glyph names are left as-is.
 */
function flatKerningRtlToNested(
    flat: Record<string, number>,
    masterId: string
): Record<string, Record<string, Record<string, number>>> {
    const nested: Record<string, Record<string, Record<string, number>>> = {};

    for (const [flatKey, value] of Object.entries(flat)) {
        const colonIdx = flatKey.indexOf(':');
        if (colonIdx === -1) continue;
        const firstRaw = flatKey.slice(0, colonIdx);
        const secondRaw = flatKey.slice(colonIdx + 1);

        // Restore @MMK_R_ / @MMK_L_ prefixes for group keys
        const firstRestored = firstRaw.startsWith('@')
            ? '@MMK_R_' + firstRaw.slice(1)
            : firstRaw;
        const secondRestored = secondRaw.startsWith('@')
            ? '@MMK_L_' + secondRaw.slice(1)
            : secondRaw;

        if (!nested[masterId]) nested[masterId] = {};
        if (!nested[masterId][firstRestored])
            nested[masterId][firstRestored] = {};
        nested[masterId][firstRestored][secondRestored] = value;
    }

    return nested;
}

/**
 * Sync a master's flat `kerning_rtl` back into the parent font's
 * `format_specific[KEY_KERNING_RTL]` so that Rust sees the data on
 * round-trip. Called from the Master.kerning_rtl setter.
 */
function syncKerningRtlToFormatSpecific(
    font: Font,
    masterId: string,
    flatRtl: Record<string, number>
): void {
    let liveFormatSpecific = font.format_specific;
    if (!liveFormatSpecific) {
        ensureModelFormatSpecific(font);
        liveFormatSpecific = font.format_specific;
    }
    if (!liveFormatSpecific) {
        return;
    }

    if (Object.keys(flatRtl).length === 0) {
        const existingRtl = liveFormatSpecific[KEY_KERNING_RTL] as
            Record<string, unknown> | undefined;
        if (existingRtl && typeof existingRtl === 'object') {
            delete existingRtl[masterId];
            if (Object.keys(existingRtl).length === 0) {
                delete liveFormatSpecific[KEY_KERNING_RTL];
            }
        }
        return;
    }

    const nested = flatKerningRtlToNested(flatRtl, masterId);
    if (
        !liveFormatSpecific[KEY_KERNING_RTL] ||
        typeof liveFormatSpecific[KEY_KERNING_RTL] !== 'object'
    ) {
        liveFormatSpecific[KEY_KERNING_RTL] = {};
    }
    const rtlRoot = liveFormatSpecific[KEY_KERNING_RTL] as Record<
        string,
        unknown
    >;
    rtlRoot[masterId] = nested[masterId] || {};
}

function remapFlatKerningPairKeys(
    kerning: Record<string, number>,
    replaceName: (name: string) => string
): Record<string, number> {
    const next: Record<string, number> = {};
    for (const [pair, value] of Object.entries(kerning)) {
        const separator = pair.indexOf(':');
        const left = separator < 0 ? pair : pair.slice(0, separator);
        const right = separator < 0 ? '' : pair.slice(separator + 1);
        next[`${replaceName(left)}:${replaceName(right)}`] = value;
    }
    return next;
}

/**
 * The main font class representing a complete font
 */
export function normalizeLegacyGlyphsRtlKerning(
    data: Babelfont.Font
): Babelfont.Font {
    const masters = Array.isArray(data.masters) ? data.masters : [];
    const formatSpecific = data.format_specific as
        Record<string, unknown> | undefined;
    const rawRtl = formatSpecific?.['com.schriftgestalt.Glyphs.kerningRTL'] as
        Record<string, Record<string, Record<string, number>>> | undefined;

    // Pair-key maps (`"left:right"`). Nested `{left: {right: n}}` is flattened.
    for (const master of masters) {
        master.kerning = flattenKerningMap(master.kerning) as Unsafe;
        master.kerning_rtl = flattenKerningMap(master.kerning_rtl);
    }

    if (!rawRtl) {
        return data;
    }

    // Unpack the nested Glyphs.app RTL kerning structure into a flat
    // "firstKey:secondKey" → value map on each master.
    //
    // IMPORTANT: We do NOT delete the format_specific key. It is the
    // canonical source that Rust reads/writes. The kerning_rtl field is
    // a JS-only convenience; the setter on Master keeps format_specific
    // in sync on every edit so that round-trips through Rust preserve
    // the data.
    for (const master of masters) {
        const masterRawRtl = rawRtl[master.id || ''];
        if (!masterRawRtl) {
            continue;
        }

        const nextKerningRtl = {
            ...(master.kerning_rtl || {})
        };

        for (const [kern1, subtable] of Object.entries(masterRawRtl)) {
            const firstKey = kern1.startsWith('@MMK_R_')
                ? '@' + kern1.slice(7)
                : kern1;
            for (const [kern2, value] of Object.entries(subtable || {})) {
                const secondKey = kern2.startsWith('@MMK_L_')
                    ? '@' + kern2.slice(7)
                    : kern2;
                if (typeof value !== 'number') {
                    continue;
                }
                nextKerningRtl[`${firstKey}:${secondKey}`] = value;
            }
        }

        master.kerning_rtl = nextKerningRtl;
    }

    return data;
}

export class Font extends ModelBase {
    private _glyphWrappers: Glyph[] | null = null;
    private _axisWrappers: Axis[] | null = null;
    private _masterWrappers: Master[] | null = null;
    private _instanceWrappers: Instance[] | null = null;
    private _isRecomputingMetricsKeys = false;
    /** Reverse index: componentGlyphName → Set of glyph names that use it */
    private _reverseComponentIndex: Map<string, Set<string>> | null = null;
    /**
     * Cached metrics-key dependency graph. Rebuilding it walks every
     * glyph × layer × side and parses each key, which is O(font) — and
     * `recomputeMetricsKeys` needs it on every call, i.e. once per pointer tick
     * during a live drag. Invalidated alongside `_reverseComponentIndex`.
     */
    private _metricsKeyDependencyEntries: MetricsKeyDependencyEntry[] | null =
        null;
    /**
     * Cache of glyph names sorted by length descending. Used as a longest-prefix
     * lookup table by metrics-key parsing (`getGlyphNamePrefixMatch`). Invalidated
     * alongside `_reverseComponentIndex` whenever glyphs are added/removed/renamed.
     */
    private _glyphNamesByLengthDesc: string[] | null = null;

    constructor(data: Babelfont.Font) {
        super(normalizeLegacyGlyphsRtlKerning(data));
    }

    get upm(): number {
        return this._data.upm;
    }

    set upm(value: number) {
        assertModelMutationAllowed();
        const old = this._data.upm;
        this._data.upm = value;
        recordAndMarkDirty(this, 'upm', old, value);
    }

    get version(): [number, number] {
        return getLiveMutableValue(
            this,
            'version',
            this._data.version,
            () => this._data.version
        );
    }

    set version(value: [number, number]) {
        assertModelMutationAllowed();
        const old = this._data.version;
        this._data.version = value;
        recordAndMarkDirty(this, 'version', old, value);
    }

    get axes(): Axis[] | undefined {
        if (!this._data.axes) return undefined;
        if (
            !this._axisWrappers ||
            this._axisWrappers.length !== this._data.axes.length ||
            !this._axisWrappers.every((wrapper) =>
                wrapper.isBoundToArray(this._data.axes!)
            )
        ) {
            this._axisWrappers = this._data.axes.map(
                (_: Unsafe, i: number) => new Axis(this._data.axes, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._axisWrappers!,
            'Font.axes is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    set axes(value: Babelfont.Axis[] | Babelfont.Axis) {
        assertModelMutationAllowed();
        this._data.axes = value;
        this._axisWrappers = null;
    }

    get instances(): Instance[] | undefined {
        if (!this._data.instances) return undefined;
        if (
            !this._instanceWrappers ||
            this._instanceWrappers.length !== this._data.instances.length ||
            !this._instanceWrappers.every((wrapper) =>
                wrapper.isBoundToArray(this._data.instances!)
            )
        ) {
            this._instanceWrappers = this._data.instances.map(
                (_: Unsafe, i: number) =>
                    new Instance(this._data.instances, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._instanceWrappers!,
            'Font.instances is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    set instances(value: Babelfont.Instance[] | Babelfont.Instance) {
        assertModelMutationAllowed();
        this._data.instances = value;
        this._instanceWrappers = null;
    }

    get masters(): Master[] | undefined {
        if (!this._data.masters) return undefined;
        if (
            !this._masterWrappers ||
            this._masterWrappers.length !== this._data.masters.length ||
            !this._masterWrappers.every((wrapper) =>
                wrapper.isBoundToArray(this._data.masters!)
            )
        ) {
            this._masterWrappers = this._data.masters.map(
                (_: Unsafe, i: number) =>
                    new Master(this._data.masters, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._masterWrappers!,
            'Font.masters is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    set masters(value: Babelfont.Master[] | Babelfont.Master) {
        assertModelMutationAllowed();
        this._data.masters = value;
        this._masterWrappers = null;
    }

    get glyphs(): Glyph[] {
        if (
            !this._glyphWrappers ||
            this._glyphWrappers.length !== this._data.glyphs.length ||
            !this._glyphWrappers.every((wrapper) =>
                wrapper.isBoundToArray(this._data.glyphs)
            )
        ) {
            this._glyphWrappers = this._data.glyphs.map(
                (_: Unsafe, i: number) => new Glyph(this._data.glyphs, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._glyphWrappers!,
            'Font.glyphs is a read-only collection view. Use addGlyph(), removeGlyph(), deleteGlyphs(), or duplicateGlyph() for structural edits.'
        );
    }

    private rebuildAutomaticComposites(
        changedGlyphNames?: Set<string>,
        options?: {
            skipSelfGlyphNames?: Set<string>;
            allowedGlyphNames?: Set<string>;
            preferredLayerId?: string | null;
            preferredSourceGlyphName?: string | null;
        }
    ): Set<string> {
        const startedAt = performance.now();
        const rebuiltGlyphNames = new Set<string>();
        const queue =
            changedGlyphNames && changedGlyphNames.size > 0
                ? new Set(changedGlyphNames)
                : new Set(this.glyphs.map((glyph) => glyph.name));
        const visitedGlyphNames = new Set<string>();
        const preferredLayerId = options?.preferredLayerId ?? null;
        const preferredSourceGlyphName =
            options?.preferredSourceGlyphName ??
            (changedGlyphNames && changedGlyphNames.size > 0
                ? (changedGlyphNames.values().next().value as string | null)
                : null);
        const preferredSourceLayer =
            preferredLayerId && preferredSourceGlyphName
                ? this.findGlyph(preferredSourceGlyphName)?.findLayerById(
                      preferredLayerId
                  )
                : null;
        const sourceDataCache = new WeakMap<
            object,
            AutomaticCompositionSourceData
        >();

        while (queue.size > 0) {
            const nextGlyphName = queue.values().next().value as string;
            queue.delete(nextGlyphName);
            if (!nextGlyphName || visitedGlyphNames.has(nextGlyphName)) {
                continue;
            }
            visitedGlyphNames.add(nextGlyphName);

            const candidateGlyphNames = new Set<string>([
                nextGlyphName,
                ...this.findDirectGlyphsUsingComponent(nextGlyphName)
            ]);

            for (const candidateGlyphName of candidateGlyphNames) {
                if (
                    options?.allowedGlyphNames &&
                    !options.allowedGlyphNames.has(candidateGlyphName)
                ) {
                    continue;
                }

                if (
                    candidateGlyphName === nextGlyphName &&
                    options?.skipSelfGlyphNames?.has(candidateGlyphName)
                ) {
                    continue;
                }

                const glyph = this.findGlyph(candidateGlyphName);
                if (!glyph) {
                    continue;
                }

                let glyphChanged = false;
                const changedLayers: Layer[] = [];
                const layersToRebuild = preferredLayerId
                    ? [
                          candidateGlyphName === preferredSourceGlyphName
                              ? preferredSourceLayer
                              : preferredSourceLayer?.getMatchingLayerOnGlyph?.(
                                    candidateGlyphName
                                ) || glyph.findLayerById(preferredLayerId)
                      ].filter((layer): layer is Layer => !!layer)
                    : glyph.layers || [];
                for (const layer of layersToRebuild) {
                    if (layer.isAutomaticAlignedLayer()) {
                        layer.invalidateLayoutCache();
                        if (
                            layer.rebuildAutomaticComposition(sourceDataCache)
                        ) {
                            glyphChanged = true;
                            changedLayers.push(layer);
                        }
                    }
                }

                if (!glyphChanged) {
                    continue;
                }

                for (const layer of changedLayers) {
                    sourceDataCache.delete(
                        layer.getAutomaticCompositionSourceCacheKey()
                    );
                }

                rebuiltGlyphNames.add(candidateGlyphName);
                for (const dependentGlyphName of this.findDirectGlyphsUsingComponent(
                    candidateGlyphName
                )) {
                    if (
                        options?.allowedGlyphNames &&
                        !options.allowedGlyphNames.has(dependentGlyphName)
                    ) {
                        continue;
                    }

                    if (!visitedGlyphNames.has(dependentGlyphName)) {
                        queue.add(dependentGlyphName);
                    }
                }
            }
        }

        recordCompileBenchRecomposition(
            'rebuild',
            performance.now() - startedAt,
            { glyphCount: rebuiltGlyphNames.size }
        );
        return rebuiltGlyphNames;
    }

    private rawFontDeclaresMetricsKeys(): boolean {
        for (const glyphData of this._data.glyphs || []) {
            const glyphFormatSpecific = glyphData?.format_specific as
                Record<string, unknown> | undefined;
            if (
                normalizeMetricsKeyValue(
                    glyphFormatSpecific?.[GLYPHS_GLYPH_METRIC_LEFT_KEY] as
                        string | undefined
                ) ||
                normalizeMetricsKeyValue(
                    glyphFormatSpecific?.[GLYPHS_GLYPH_METRIC_RIGHT_KEY] as
                        string | undefined
                )
            ) {
                return true;
            }

            for (const layerData of glyphData?.layers || []) {
                const layerFormatSpecific = layerData?.format_specific as
                    Record<string, unknown> | undefined;
                if (
                    normalizeMetricsKeyValue(
                        layerFormatSpecific?.[GLYPHS_LAYER_METRIC_LEFT_KEY] as
                            string | undefined
                    ) ||
                    normalizeMetricsKeyValue(
                        layerFormatSpecific?.[GLYPHS_LAYER_METRIC_RIGHT_KEY] as
                            string | undefined
                    )
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Yjs / JSON merges can replace `glyph.data.layers` with new objects while
     * this font model (and its metrics-key dependency cache) stays alive.
     * Cached Layer wrappers then point at orphaned records, so =| and other
     * keys mutate the wrong objects until a key write rebuilds the cache
     * (e.g. property-panel LSB set). Always rebind to the live layer by id.
     */
    private rebindMetricsKeyDependencyEntry(
        entry: MetricsKeyDependencyEntry
    ): Layer | null {
        const glyph = this.findGlyph(entry.glyphName);
        if (!glyph) {
            return null;
        }
        const layerId = entry.layerId || entry.layer?.id;
        if (!layerId) {
            return null;
        }
        const liveLayer = glyph.findLayerById(layerId);
        if (!liveLayer) {
            return null;
        }
        entry.glyph = glyph;
        entry.layer = liveLayer;
        entry.layerId = layerId;
        return liveLayer;
    }

    private collectMetricsKeyDependencyEntries(options?: {
        allowedGlyphNames?: Set<string>;
    }): MetricsKeyDependencyEntry[] {
        // The unfiltered graph is cached; per-call scoping is a cheap filter.
        // Without this the whole font is re-walked and every key re-parsed on
        // each recomputeMetricsKeys() — once per pointer tick during a drag.
        const cached = this._metricsKeyDependencyEntries;
        const cacheIsStaleEmpty =
            Array.isArray(cached) &&
            cached.length === 0 &&
            this.rawFontDeclaresMetricsKeys();
        if (cached === null || cacheIsStaleEmpty) {
            const built = this._buildMetricsKeyDependencyEntries();
            // Never permanently cache an empty graph while the font still
            // declares metrics keys. That happens when the filtered layer view
            // is not ready yet; caching [] disables =| / keyed cascades until
            // a later key write invalidates the cache (e.g. property-panel
            // LSB set), which matches "handle drag only works after panel".
            if (built.length > 0 || !this.rawFontDeclaresMetricsKeys()) {
                this._metricsKeyDependencyEntries = built;
            } else {
                this._metricsKeyDependencyEntries = null;
            }
            const allowedGlyphNames = options?.allowedGlyphNames;
            if (!allowedGlyphNames) {
                return built;
            }
            return built.filter((entry) =>
                allowedGlyphNames.has(entry.glyphName)
            );
        }

        const allowedGlyphNames = options?.allowedGlyphNames;
        if (!allowedGlyphNames) {
            return cached;
        }
        return cached.filter((entry) => allowedGlyphNames.has(entry.glyphName));
    }

    private _buildMetricsKeyDependencyEntries(): MetricsKeyDependencyEntry[] {
        const entries: MetricsKeyDependencyEntry[] = [];

        for (const glyph of this.glyphs) {
            for (const layer of glyph.layers || []) {
                for (const side of ['left', 'right'] as SidebearingSide[]) {
                    const key =
                        side === 'left'
                            ? layer.leftMetricsKey || glyph.leftMetricsKey
                            : layer.rightMetricsKey || glyph.rightMetricsKey;
                    if (!key) {
                        continue;
                    }

                    const parsed = parseMetricsKey(this, key);
                    if ('error' in parsed) {
                        continue;
                    }

                    const layerId = layer.id;
                    if (!layerId) {
                        continue;
                    }

                    entries.push({
                        layer,
                        layerId,
                        glyph,
                        glyphName: glyph.name,
                        side,
                        parsed
                    });
                }
            }
        }

        return entries;
    }

    private buildMetricsKeyDependencyLookup(
        entries: MetricsKeyDependencyEntry[]
    ): MetricsKeyDependencyLookup {
        const keyedEntriesByGlyph = new Map<
            string,
            MetricsKeyDependencyEntry[]
        >();
        const referencedEntriesByGlyph = new Map<
            string,
            MetricsKeyDependencyEntry[]
        >();
        const automaticOffsetEntriesByGlyph = new Map<
            string,
            MetricsKeyDependencyEntry[]
        >();

        for (const entry of entries) {
            appendMapArrayValue(keyedEntriesByGlyph, entry.glyphName, entry);

            if (entry.parsed.kind === 'automatic-offset') {
                appendMapArrayValue(
                    automaticOffsetEntriesByGlyph,
                    entry.glyphName,
                    entry
                );
                continue;
            }

            for (const referencedGlyphName of entry.parsed
                .referencedGlyphNames) {
                appendMapArrayValue(
                    referencedEntriesByGlyph,
                    referencedGlyphName,
                    entry
                );
            }
        }

        return {
            keyedEntriesByGlyph,
            referencedEntriesByGlyph,
            automaticOffsetEntriesByGlyph
        };
    }

    rebuildAutomaticCompositesForGlyphs(
        changedGlyphNames?: Set<string>,
        options?: {
            allowedGlyphNames?: Set<string>;
            preferredLayerId?: string | null;
            preferredSourceGlyphName?: string | null;
        }
    ): Set<string> {
        return this.rebuildAutomaticComposites(changedGlyphNames, options);
    }

    /**
     * Rebuild automatic ligatures whose unattached consecutive bases resolve
     * to this kerning pair (glyph or `@group` keys, overlay precedence).
     */
    rebuildAutomaticCompositesForKerningPair(
        firstKey: string,
        secondKey: string
    ): Set<string> {
        const seeds = new Set<string>();
        for (const glyph of this.glyphs) {
            for (const layer of glyph.layers || []) {
                if (
                    layer.usesAutomaticLigatureKerningPair(firstKey, secondKey)
                ) {
                    seeds.add(glyph.name);
                    break;
                }
            }
        }
        if (seeds.size === 0) {
            return new Set();
        }
        const rebuiltGlyphNames = this.rebuildAutomaticComposites(seeds);
        if (rebuiltGlyphNames.size > 0) {
            this.recomputeMetricsKeys(rebuiltGlyphNames, {
                skipInitialAutomaticCompositeRebuild: true
            });
        }
        return rebuiltGlyphNames;
    }

    /**
     * Rebuild automatic ligatures that use one of these glyphs as the
     * corresponding unattached-base operand after a kern-group membership edit.
     */
    rebuildAutomaticCompositesForKerningGroupMembership(
        pairSide: 'first' | 'second',
        glyphNames: Iterable<string>
    ): Set<string> {
        const seeds = new Set<string>();
        for (const glyph of this.glyphs) {
            for (const layer of glyph.layers || []) {
                if (
                    layer.usesAutomaticLigatureKerningGroupMembership(
                        pairSide,
                        glyphNames
                    )
                ) {
                    seeds.add(glyph.name);
                    break;
                }
            }
        }
        if (seeds.size === 0) {
            return new Set();
        }
        const rebuiltGlyphNames = this.rebuildAutomaticComposites(seeds);
        if (rebuiltGlyphNames.size > 0) {
            this.recomputeMetricsKeys(rebuiltGlyphNames, {
                skipInitialAutomaticCompositeRebuild: true
            });
        }
        return rebuiltGlyphNames;
    }

    /**
     * Enable automatic alignment only on glyphs where every non-empty
     * foreground layer preflights: the composition engine can place every
     * component (anchor attachment, unattached non-mark bases including
     * ligatures with LTR kerning, or a single non-mark component), and the
     * result matches stored translations and width on all of those layers.
     * Manual components that would move, or layers whose advance would
     * change, stay manual.
     *
     * `compositeGlyphCount` is how many glyphs have at least one component.
     * `convertedGlyphNames` is the subset that this run marked automatic.
     */
    convertMatchingManualComponentsToAutomatic(): {
        convertedGlyphNames: Set<string>;
        compositeGlyphCount: number;
    } {
        assertModelMutationAllowed();
        const sourceDataCache = new WeakMap<
            object,
            AutomaticCompositionSourceData
        >();
        const convertedGlyphNames = new Set<string>();
        let compositeGlyphCount = 0;

        for (const glyph of this.glyphs) {
            const layers = (glyph.layers || []).filter(
                (layer) =>
                    !layer.is_background && (layer.shapes?.length ?? 0) > 0
            );
            if (layers.length === 0) {
                continue;
            }
            if (!layers.some((layer) => layer.components.length > 0)) {
                continue;
            }
            compositeGlyphCount += 1;
            if (layers.every((layer) => layer.isAutomaticAlignedLayer())) {
                continue;
            }
            if (
                !layers.every((layer) =>
                    layer.matchesAutomaticCompositionPreflight(sourceDataCache)
                )
            ) {
                continue;
            }

            let changed = false;
            for (const layer of layers) {
                if (layer.isAutomaticAlignedLayer()) {
                    continue;
                }
                for (const component of layer.components) {
                    if (component.automaticAlignment) {
                        continue;
                    }
                    component.automaticAlignment = true;
                    changed = true;
                }
            }
            if (changed) {
                convertedGlyphNames.add(glyph.name);
            }
        }

        if (convertedGlyphNames.size > 0) {
            this.recomputeMetricsKeys(convertedGlyphNames);
        }
        return { convertedGlyphNames, compositeGlyphCount };
    }

    /**
     * Collect glyphs whose metrics keys / automatic-offset edges depend on the
     * given source glyphs, whether or not their stored sidebearings currently
     * need updating. Used by cascading commit so live-already-synced
     * dependents are still persisted into Yjs.
     */
    collectMetricsKeyDependentGlyphs(
        sourceGlyphNames: Iterable<string>
    ): Set<string> {
        const sources = new Set(
            Array.from(sourceGlyphNames).filter(
                (glyphName): glyphName is string =>
                    typeof glyphName === 'string' && glyphName.length > 0
            )
        );
        const dependentGlyphNames = new Set<string>();
        if (sources.size === 0) {
            return dependentGlyphNames;
        }

        const reverseComponentIndex = this._ensureReverseComponentIndex();
        const dependencyEntries = this.collectMetricsKeyDependencyEntries();
        for (const entry of dependencyEntries) {
            if (entry.parsed.kind === 'automatic-offset') {
                const liveLayer = this.rebindMetricsKeyDependencyEntry(entry);
                if (!liveLayer?.isAutomaticAlignedLayer()) {
                    continue;
                }
                let dependsOnSource = sources.has(entry.glyphName);
                if (!dependsOnSource) {
                    for (const sourceGlyphName of sources) {
                        const dependents =
                            reverseComponentIndex.get(sourceGlyphName);
                        if (dependents?.has(entry.glyphName)) {
                            dependsOnSource = true;
                            break;
                        }
                    }
                }
                if (dependsOnSource) {
                    dependentGlyphNames.add(entry.glyphName);
                }
                continue;
            }

            if (
                entry.parsed.referencedGlyphNames.some((referencedGlyphName) =>
                    sources.has(referencedGlyphName)
                )
            ) {
                dependentGlyphNames.add(entry.glyphName);
            }
        }

        return dependentGlyphNames;
    }

    /**
     * Return the transitive metrics-key prerequisites of glyphs that must be
     * recomposed live. A visible glyph can reference a hidden glyph through a
     * metrics key (for example a.ss03 =|n); its value is not correct until the
     * hidden reference and its own prerequisites have settled. The live
     * recomposition closure uses this to close its allowed mutation set before
     * running the same work queue as the all-scope commit path.
     */
    collectMetricsKeyPrerequisiteGlyphs(
        glyphNames: Iterable<string>
    ): Set<string> {
        const entriesByGlyph = new Map<string, MetricsKeyDependencyEntry[]>();
        for (const entry of this.collectMetricsKeyDependencyEntries()) {
            appendMapArrayValue(entriesByGlyph, entry.glyphName, entry);
        }

        const prerequisites = new Set<string>();
        const pending = Array.from(glyphNames).filter(
            (glyphName): glyphName is string =>
                typeof glyphName === 'string' && glyphName.length > 0
        );
        const visited = new Set<string>(pending);

        while (pending.length > 0) {
            const glyphName = pending.shift() as string;
            for (const entry of entriesByGlyph.get(glyphName) || []) {
                for (const referencedGlyphName of entry.parsed
                    .referencedGlyphNames) {
                    if (!visited.has(referencedGlyphName)) {
                        visited.add(referencedGlyphName);
                        prerequisites.add(referencedGlyphName);
                        pending.push(referencedGlyphName);
                    }
                }
            }
        }

        return prerequisites;
    }

    recomputeMetricsKeys(
        changedGlyphNames?: Set<string>,
        options?: {
            allowedGlyphNames?: Set<string>;
            skipAutomaticCompositeRebuild?: boolean;
            /** The caller already rebuilt automatic composites for the initial
             *  sources, but metric-induced changes must still rebuild their
             *  own automatic dependents. */
            skipInitialAutomaticCompositeRebuild?: boolean;
        }
    ): Set<string> {
        if (this._isRecomputingMetricsKeys) {
            return new Set();
        }

        this._isRecomputingMetricsKeys = true;
        const recomputedGlyphNames = new Set<string>();
        const skipCompositeRebuild = !!options?.skipAutomaticCompositeRebuild;
        const skipInitialAutomaticCompositeRebuild =
            !!options?.skipInitialAutomaticCompositeRebuild;
        try {
            const allowedGlyphNames = options?.allowedGlyphNames;
            const filterGlyphNames = (
                glyphNames: Iterable<string>
            ): Set<string> =>
                new Set(
                    Array.from(glyphNames).filter(
                        (glyphName): glyphName is string =>
                            typeof glyphName === 'string' &&
                            glyphName.length > 0 &&
                            (!allowedGlyphNames ||
                                allowedGlyphNames.has(glyphName))
                    )
                );
            const skipSelfAutomaticRebuildGlyphNames = new Set<string>();
            const initialGlyphNames =
                changedGlyphNames && changedGlyphNames.size > 0
                    ? filterGlyphNames(changedGlyphNames)
                    : filterGlyphNames(this.glyphs.map((glyph) => glyph.name));

            const dependencyEntries = this.collectMetricsKeyDependencyEntries({
                allowedGlyphNames
            });
            const dependencyLookup =
                this.buildMetricsKeyDependencyLookup(dependencyEntries);
            const reverseComponentIndex = this._ensureReverseComponentIndex();
            const getDirectComponentDependents = (
                glyphName: string
            ): string[] => {
                const dependentGlyphNames =
                    reverseComponentIndex.get(glyphName);
                if (!dependentGlyphNames || dependentGlyphNames.size === 0) {
                    return [];
                }

                return Array.from(dependentGlyphNames).filter(
                    (dependentGlyphName) =>
                        !allowedGlyphNames ||
                        allowedGlyphNames.has(dependentGlyphName)
                );
            };
            const pendingGlyphNames: string[] = [];
            const queuedGlyphNames = new Set<string>();
            const processedGlyphCounts = new Map<string, number>();
            const maxGlyphVisits = Math.max(
                (allowedGlyphNames?.size ?? this.glyphs.length) * 2,
                8
            );
            let warnedAboutMetricsKeyCascade = false;

            const enqueueGlyphName = (glyphName: string | null | undefined) => {
                if (
                    !glyphName ||
                    (allowedGlyphNames && !allowedGlyphNames.has(glyphName)) ||
                    queuedGlyphNames.has(glyphName)
                ) {
                    return;
                }

                pendingGlyphNames.push(glyphName);
                queuedGlyphNames.add(glyphName);
            };

            const recordChangedGlyph = (
                glyphName: string,
                changedOnlyByAutomaticOffset: boolean,
                enqueueForPropagation: boolean
            ) => {
                recomputedGlyphNames.add(glyphName);
                if (enqueueForPropagation) {
                    enqueueGlyphName(glyphName);
                }
                if (changedOnlyByAutomaticOffset) {
                    skipSelfAutomaticRebuildGlyphNames.add(glyphName);
                    return;
                }
                skipSelfAutomaticRebuildGlyphNames.delete(glyphName);
            };

            for (const glyphName of initialGlyphNames) {
                enqueueGlyphName(glyphName);
            }

            // When skipping full automatic-composite rebuild (sidebearing fast
            // path), still rebuild composites for the initially changed glyphs
            // so that the source glyph's own composites stay in sync. Skip
            // only the downstream cascade rebuilds that are expensive and
            // unnecessary when only sidebearing widths have changed.
            if (!skipInitialAutomaticCompositeRebuild) {
                for (const glyphName of skipCompositeRebuild
                    ? this.rebuildAutomaticComposites(initialGlyphNames, {
                          skipSelfGlyphNames: new Set<string>(),
                          allowedGlyphNames
                      })
                    : this.rebuildAutomaticComposites(initialGlyphNames, {
                          skipSelfGlyphNames:
                              skipSelfAutomaticRebuildGlyphNames,
                          allowedGlyphNames
                      })) {
                    recomputedGlyphNames.add(glyphName);
                    enqueueGlyphName(glyphName);
                }
            }

            if (dependencyEntries.length === 0) {
                return recomputedGlyphNames;
            }

            while (pendingGlyphNames.length > 0) {
                const changedGlyphName = pendingGlyphNames.shift() as string;
                queuedGlyphNames.delete(changedGlyphName);

                const nextProcessedGlyphCount =
                    (processedGlyphCounts.get(changedGlyphName) || 0) + 1;
                processedGlyphCounts.set(
                    changedGlyphName,
                    nextProcessedGlyphCount
                );
                if (nextProcessedGlyphCount > maxGlyphVisits) {
                    if (!warnedAboutMetricsKeyCascade) {
                        warnedAboutMetricsKeyCascade = true;
                        console.warn(
                            '[MetricsKeys] Bailing out of a repeated metrics-key cascade',
                            {
                                seedGlyphNames: [...initialGlyphNames],
                                repeatedGlyphName: changedGlyphName,
                                maxGlyphVisits
                            }
                        );
                    }
                    continue;
                }

                const directComponentDependents = new Set(
                    getDirectComponentDependents(changedGlyphName)
                );
                const candidateEntries = new Set<MetricsKeyDependencyEntry>([
                    ...(dependencyLookup.keyedEntriesByGlyph.get(
                        changedGlyphName
                    ) || []),
                    ...(dependencyLookup.referencedEntriesByGlyph.get(
                        changedGlyphName
                    ) || [])
                ]);

                for (const dependentGlyphName of directComponentDependents) {
                    for (const entry of dependencyLookup.automaticOffsetEntriesByGlyph.get(
                        dependentGlyphName
                    ) || []) {
                        candidateEntries.add(entry);
                    }
                }

                const changedGlyphStates = new Map<
                    string,
                    { changedOnlyByAutomaticOffset: boolean }
                >();

                for (const entry of candidateEntries) {
                    const liveLayer =
                        this.rebindMetricsKeyDependencyEntry(entry);
                    if (!liveLayer) {
                        continue;
                    }

                    const shouldRecompute =
                        entry.parsed.kind === 'automatic-offset'
                            ? entry.glyphName === changedGlyphName ||
                              directComponentDependents.has(entry.glyphName)
                            : entry.glyphName === changedGlyphName ||
                              entry.parsed.referencedGlyphNames.includes(
                                  changedGlyphName
                              );
                    if (!shouldRecompute) {
                        continue;
                    }

                    const resolution = liveLayer.resolveMetricsKey(entry.side);
                    const applied = getAppliedMetricsKeySidebearing(
                        liveLayer,
                        entry.side,
                        resolution
                    );
                    const currentValue =
                        entry.side === 'left' ? liveLayer.lsb : liveLayer.rsb;
                    if (
                        applied.error ||
                        applied.value === null ||
                        Math.abs(currentValue - applied.value) <=
                            METRIC_UPDATE_EPSILON
                    ) {
                        continue;
                    }

                    if (!liveLayer.isAutomaticAlignedLayer()) {
                        liveLayer.setDirectSidebearing(
                            entry.side,
                            applied.value
                        );
                    } else {
                        // Automatic layers are mutation-owned exclusively by
                        // rebuildAutomaticComposition. Never translate/bake
                        // their contents from the metrics fast path — that
                        // fights logical =+/- storage and live/commit parity.
                        continue;
                    }

                    const previousState = changedGlyphStates.get(
                        entry.glyphName
                    );
                    changedGlyphStates.set(entry.glyphName, {
                        changedOnlyByAutomaticOffset:
                            previousState?.changedOnlyByAutomaticOffset !==
                            false
                                ? entry.parsed.kind === 'automatic-offset'
                                : false
                    });
                }

                for (const [glyphName, glyphState] of changedGlyphStates) {
                    recordChangedGlyph(
                        glyphName,
                        glyphState.changedOnlyByAutomaticOffset,
                        glyphName !== changedGlyphName
                    );

                    if (skipCompositeRebuild) {
                        continue;
                    }

                    for (const rebuiltGlyphName of this.rebuildAutomaticComposites(
                        new Set([glyphName]),
                        {
                            skipSelfGlyphNames:
                                skipSelfAutomaticRebuildGlyphNames,
                            allowedGlyphNames
                        }
                    )) {
                        recomputedGlyphNames.add(rebuiltGlyphName);
                        enqueueGlyphName(rebuiltGlyphName);
                    }
                }
            }

            return recomputedGlyphNames;
        } finally {
            this._isRecomputingMetricsKeys = false;
        }
    }

    get note(): string | undefined {
        return this._data.note;
    }

    set note(value: string | undefined) {
        assertModelMutationAllowed();
        const old = this._data.note;
        this._data.note = value;
        recordAndMarkDirty(this, 'note', old, value);
    }

    get date(): string {
        return this._data.date;
    }

    set date(value: string) {
        assertModelMutationAllowed();
        const old = this._data.date;
        this._data.date = value;
        recordAndMarkDirty(this, 'date', old, value);
    }

    /**
     * OpenType name table. Fields are attributes (`family_name`,
     * `preferred_subfamily_name`, `full_name`, `copyright`, `unique_id`,
     * `version`, `postscript_name`, `trademark`, `manufacturer`, `designer`,
     * `description`, `manufacturer_url`, `designer_url`, `license`,
     * `license_url`, `typographic_family`, `typographic_subfamily`,
     * `compatible_full_name`, `sample_text`, `postscript_cid_name`,
     * `wws_family_name`, `wws_subfamily_name`,
     * `variations_postscript_name_prefix`). Access language tags as attributes
     * (`font.names.family_name.dflt`). Do not use `.get()`.
     * @example
     * print(font.names.family_name.dflt)
     * font.names.family_name.dflt = "My Family"
     */
    get names(): Babelfont.Names {
        return getLiveMutableValue(
            this,
            'names',
            this._data.names,
            () => this._data.names
        );
    }

    set names(value: Babelfont.Names) {
        assertModelMutationAllowed();
        const old = this._data.names;
        this._data.names = value;
        recordAndMarkDirty(this, 'names', old, value);
    }

    /**
     * Font-wide OpenType table overrides as a live dict (not a list).
     * Known keys include `head_flags`, `head_lowest_rec_ppem`,
     * `os2_us_weight_class`, `os2_us_width_class`, `os2_fs_type`,
     * `os2_family_class`, `os2_panose`, `os2_unicode_range1`–`4`,
     * `os2_vendor_id`, `os2_fs_selection`, `os2_code_page_range1`/`2`,
     * `cff_blue_values`, `cff_other_blues`, `cff_family_blues`,
     * `cff_family_other_blues`, `cff_stem_snap_h`, `cff_stem_snap_v`.
     * Master-varying metrics belong on `Master.metrics`, not here.
     * @example
     * font.custom_ot_values.os2_us_weight_class = 400
     */
    get custom_ot_values(): Babelfont.CustomOTValues | undefined {
        return getLiveMutableValue(
            this,
            'custom_ot_values',
            this._data.custom_ot_values,
            () => this._data.custom_ot_values
        );
    }

    set custom_ot_values(value: Babelfont.CustomOTValues | undefined) {
        assertModelMutationAllowed();
        const old = this._data.custom_ot_values;
        this._data.custom_ot_values = value;
        recordAndMarkDirty(this, 'custom_ot_values', old, value);
    }

    /**
     * Unicode Variation Sequences mapped to glyph names. Nested as
     * selector codepoint → unicode → glyph name when present.
     */
    get variation_sequences():
        Record<number, Record<number, string>> | undefined {
        return getLiveMutableValue(
            this,
            'variation_sequences',
            this._data.variation_sequences,
            () => this._data.variation_sequences
        );
    }

    set variation_sequences(
        value: Record<number, Record<number, string>> | undefined
    ) {
        assertModelMutationAllowed();
        const old = this._data.variation_sequences;
        this._data.variation_sequences = value;
        recordAndMarkDirty(this, 'variation_sequences', old, value);
    }

    /**
     * OpenType features as a live dict with `classes`, `prefixes`, `features`,
     * and optional `include_paths`. Class/prefix values are `{ code, automatic? }`.
     * `features` is a list of `[tag, code_dict]` pairs. Class names have no
     * leading `@`.
     * @example
     * font.features.classes["vowels"].code
     * font.features.features[0][0]  # feature tag
     */
    get features(): Babelfont.Features {
        return getPreciseLiveMutableValue(
            this.getPath().concat('features'),
            this._data.features,
            () => this._data.features
        );
    }

    set features(value: Babelfont.Features) {
        assertModelMutationAllowed();
        const old = this._data.features;
        this._data.features = value;
        recordAndMarkDirty(this, 'features', old, value);
    }

    /**
     * Kerning groups for the first (left, in LTR) operand: group name (no `@`)
     * → glyph names. Generally keyed by the glyph's *right-side* profile.
     */
    get first_kern_groups(): Record<string, string[]> | undefined {
        return getLiveMutableValue(
            this,
            'first_kern_groups',
            this._data.first_kern_groups,
            () => this._data.first_kern_groups
        );
    }

    set first_kern_groups(value: Record<string, string[]> | undefined) {
        assertModelMutationAllowed();
        const old = this._data.first_kern_groups;
        this._data.first_kern_groups = value;
        recordAndMarkDirty(this, 'first_kern_groups', old, value);
    }

    /**
     * Kerning groups for the second (right, in LTR) operand: group name (no `@`)
     * → glyph names. Generally keyed by the glyph's *left-side* profile.
     */
    get second_kern_groups(): Record<string, string[]> | undefined {
        return getLiveMutableValue(
            this,
            'second_kern_groups',
            this._data.second_kern_groups,
            () => this._data.second_kern_groups
        );
    }

    set second_kern_groups(value: Record<string, string[]> | undefined) {
        assertModelMutationAllowed();
        const old = this._data.second_kern_groups;
        this._data.second_kern_groups = value;
        recordAndMarkDirty(this, 'second_kern_groups', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this._data.format_specific,
            () => this._data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        assertModelMutationAllowed();
        const old = this._data.format_specific;
        this._data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    get source(): string | null {
        return this._data.source;
    }

    set source(value: string | null) {
        assertModelMutationAllowed();
        const old = this._data.source;
        this._data.source = value;
        recordAndMarkDirty(this, 'source', old, value);
    }

    /**
     * Find a glyph by name
     * @example
     * glyph = font.findGlyph("A")
     * if glyph:
     *     print(glyph.name)
     */
    findGlyph(name: string): Glyph | undefined {
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === name
        );
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Rename glyphs and every font-owned reference to them in one undoable
     * transaction. The mapping is simultaneous, so swaps are safe.
     */
    renameGlyphs(renameMap: ReadonlyMap<string, string>): void {
        assertModelMutationAllowed();
        const renames = new Map(
            Array.from(renameMap).filter(
                ([oldName, newName]) => oldName !== newName
            )
        );
        if (renames.size === 0) return;

        const existingNames = this._data.glyphs.map(
            (glyph: Unsafe) => glyph.name as string
        );
        assertGlyphRenamePreflight(renames, existingNames);

        const replaceName = (value: string): string =>
            renames.get(value) || value;
        const replaceMetricsKey = (
            value: string | undefined
        ): string | undefined => {
            if (!value) return value;
            const parsed = parseMetricsKey(this, value);
            if (
                'error' in parsed ||
                parsed.kind !== 'reference' ||
                !parsed.glyphName
            ) {
                return value;
            }
            const newName = renames.get(parsed.glyphName);
            if (!newName) return value;
            // Rewrite only the parsed glyph-name segment so prefixes like AA
            // are never disturbed when renaming A.
            let body = value.trim();
            let prefix = '';
            if (body.startsWith('==')) {
                prefix = '==';
                body = body.slice(2);
            } else if (body.startsWith('=')) {
                prefix = '=';
                body = body.slice(1);
            }
            let mirror = '';
            if (body.startsWith('|')) {
                mirror = '|';
                body = body.slice(1);
            }
            if (!body.startsWith(parsed.glyphName)) {
                return value;
            }
            return `${prefix}${mirror}${newName}${body.slice(parsed.glyphName.length)}`;
        };
        const replaceFeatureCode = (code: string): string => {
            // Glyph names are identifiers in feature source; preserve comments,
            // class references, and surrounding punctuation verbatim.
            return code.replace(
                /#[^\n]*|@[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+/g,
                (token) =>
                    token.startsWith('#') || token.startsWith('@')
                        ? token
                        : replaceName(token)
            );
        };

        const codepointsByOldName = new Map<string, number[]>();
        for (const oldName of renames.keys()) {
            const glyph = this.findGlyph(oldName);
            const codepoints = Array.isArray(glyph?.codepoints)
                ? glyph.codepoints.filter(
                      (value: unknown): value is number =>
                          typeof value === 'number' && Number.isFinite(value)
                  )
                : [];
            codepointsByOldName.set(oldName, codepoints);
        }

        withBridgeTransaction('Rename glyphs', () => {
            assertModelMutationAllowed();
            // Preflight before any model writes — withBridgeTransaction commits
            // buffered ops in `finally` even when the body throws.
            const bridge = getPatchSyncEngine();
            if (bridge && typeof bridge.hasGlyphInYDoc === 'function') {
                for (const oldName of renames.keys()) {
                    if (!bridge.hasGlyphInYDoc(oldName)) {
                        throw new Error(`Cannot rename glyph "${oldName}".`);
                    }
                }
            }

            for (const glyph of this.glyphs) {
                const leftMetricsKey = replaceMetricsKey(glyph.leftMetricsKey);
                const rightMetricsKey = replaceMetricsKey(
                    glyph.rightMetricsKey
                );
                if (leftMetricsKey !== glyph.leftMetricsKey) {
                    glyph.leftMetricsKey = leftMetricsKey;
                }
                if (rightMetricsKey !== glyph.rightMetricsKey) {
                    glyph.rightMetricsKey = rightMetricsKey;
                }
                // Glyph.layers hides backgrounds; Glyphs fonts often keep
                // composite refs only there (e.g. Fustat ae → a).
                glyph._rewriteStoredLayerNameReferences(
                    replaceName,
                    replaceMetricsKey
                );
            }

            for (const master of this.masters || []) {
                master.kerning = remapFlatKerningPairKeys(
                    flattenKerningMap(master.kerning),
                    replaceName
                );

                const rtlKerning: Record<string, number> = {};
                for (const [pair, value] of Object.entries(
                    master.kerning_rtl || {}
                )) {
                    const separator = pair.indexOf(':');
                    const left =
                        separator < 0 ? pair : pair.slice(0, separator);
                    const right =
                        separator < 0 ? '' : pair.slice(separator + 1);
                    rtlKerning[`${replaceName(left)}:${replaceName(right)}`] =
                        value;
                }
                master.kerning_rtl = rtlKerning;
            }

            const renameGroups = (
                groups: Record<string, string[]> | undefined
            ) =>
                groups &&
                Object.fromEntries(
                    Object.entries(groups).map(([name, members]) => [
                        name,
                        members.map(replaceName)
                    ])
                );
            this.first_kern_groups = renameGroups(this.first_kern_groups);
            this.second_kern_groups = renameGroups(this.second_kern_groups);

            if (this._data.features) {
                const oldFeatures = cloneForHistory(this._data.features);
                const features = cloneForHistory(this._data.features);
                for (const classData of Object.values(features.classes || {})) {
                    const codeData = classData as { code?: string };
                    if (codeData.code) {
                        codeData.code = replaceFeatureCode(codeData.code);
                    }
                }
                for (const [, featureData] of features.features || []) {
                    if (featureData?.code)
                        featureData.code = replaceFeatureCode(featureData.code);
                }
                for (const prefixData of Object.values(
                    features.prefixes || {}
                )) {
                    const codeData = prefixData as { code?: string };
                    if (codeData.code) {
                        codeData.code = replaceFeatureCode(codeData.code);
                    }
                }
                this._data.features = features;
                recordAndMarkDirty(this, 'features', oldFeatures, features);
            }

            const glyphRenames = this._data.glyphs.flatMap(
                (glyphData: Unsafe) => {
                    const oldName = glyphData.name;
                    const newName = renames.get(oldName);
                    if (!newName) return [];
                    const glyph = cloneForHistory(glyphData);
                    glyph.name = newName;
                    return [{ oldName, newName, glyph }];
                }
            );
            if (bridge && typeof bridge.renameGlyphs === 'function') {
                bridge.renameGlyphs(glyphRenames, 'Rename glyphs');
            } else {
                markFontDirty();
            }
            for (const glyphData of this._data.glyphs) {
                const newName = renames.get(glyphData.name);
                if (newName) {
                    glyphData.name = newName;
                }
            }
            this._glyphWrappers = null;
            this.invalidateReverseComponentIndex();
        });

        applyGlyphRenameUiContext(renames, codepointsByOldName);
    }

    /**
     * Resolve an editor glyph token to an authorable layer view. A literal glyph
     * name resolves to its persisted Glyph; `base.feaVar.N` resolves to the
     * corresponding synthetic feature-variation family.
     */
    resolveGlyphView(name: string): Glyph | FeatureVariationGlyph | undefined {
        const literalGlyph = this.findGlyph(name);
        if (literalGlyph) {
            return literalGlyph;
        }

        const featureVariationMatch = name.match(/^(.*)\.feaVar\.(\d+)$/);
        if (!featureVariationMatch) {
            return undefined;
        }

        const featureVariationIndex = Number(featureVariationMatch[2]);
        if (
            !Number.isInteger(featureVariationIndex) ||
            featureVariationIndex < 0
        ) {
            return undefined;
        }

        return this.findGlyph(featureVariationMatch[1])?.featureVariations[
            featureVariationIndex
        ];
    }

    /**
     * Find a glyph by codepoint
     * @example
     * glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
     */
    findGlyphByCodepoint(codepoint: number): Glyph | undefined {
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.codepoints && g.codepoints.includes(codepoint)
        );
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Build or rebuild the reverse component index.
     * Maps componentGlyphName → Set of glyph names that reference it.
     */
    private _buildReverseComponentIndex(): Map<string, Set<string>> {
        const index = new Map<string, Set<string>>();
        for (const glyphData of this._data.glyphs) {
            if (!glyphData.layers) continue;
            const glyphName = glyphData.name;
            for (const layer of glyphData.layers) {
                if (!layer || !layer.shapes || !Array.isArray(layer.shapes))
                    continue;
                for (const shape of layer.shapes) {
                    if (!shape || typeof shape !== 'object') continue;
                    const ref =
                        shape.reference ??
                        shape.Component?.reference ??
                        undefined;
                    if (ref) {
                        let set = index.get(ref);
                        if (!set) {
                            set = new Set();
                            index.set(ref, set);
                        }
                        set.add(glyphName);
                    }
                }
            }
        }
        return index;
    }

    private _ensureReverseComponentIndex(): Map<string, Set<string>> {
        if (!this._reverseComponentIndex) {
            this._reverseComponentIndex = this._buildReverseComponentIndex();
        }
        return this._reverseComponentIndex;
    }

    invalidateReverseComponentIndex(): void {
        this._reverseComponentIndex = null;
        this._glyphNamesByLengthDesc = null;
        this._metricsKeyDependencyEntries = null;
    }

    /**
     * Drop only the metrics-key dependency cache. Call when a metrics key is
     * added, changed, or removed without the glyph set changing.
     */
    invalidateMetricsKeyDependencyEntries(): void {
        this._metricsKeyDependencyEntries = null;
    }

    /**
     * Returns glyph names sorted by length descending, cached. Used by metrics-key
     * parsing for longest-prefix matching. Cache is invalidated when glyphs are
     * added/removed/renamed (see `invalidateReverseComponentIndex`).
     */
    getGlyphNamesByLengthDesc(): string[] {
        if (!this._glyphNamesByLengthDesc) {
            const names: string[] = [];
            for (const g of this._data.glyphs) {
                if (g && g.name) names.push(g.name);
            }
            names.sort((a, b) => b.length - a.length);
            this._glyphNamesByLengthDesc = names;
        }
        return this._glyphNamesByLengthDesc;
    }

    findDirectGlyphsUsingComponent(componentGlyphName: string): string[] {
        const index = this._ensureReverseComponentIndex();
        const set = index.get(componentGlyphName);
        return set ? Array.from(set) : [];
    }

    collectComponentDependentGlyphs(
        componentGlyphNames: Iterable<string>,
        options?: {
            includeSourceGlyphNames?: boolean;
            retainGlyphNames?: Set<string>;
        }
    ): Set<string> {
        const sourceGlyphNames = Array.from(componentGlyphNames).filter(
            (glyphName): glyphName is string =>
                typeof glyphName === 'string' && glyphName.length > 0
        );
        const dependentGlyphNames = new Set<string>();

        if (options?.includeSourceGlyphNames) {
            for (const glyphName of sourceGlyphNames) {
                dependentGlyphNames.add(glyphName);
            }
        }

        if (sourceGlyphNames.length === 0) {
            return dependentGlyphNames;
        }

        const retainGlyphNames = options?.retainGlyphNames;
        if (retainGlyphNames && retainGlyphNames.size > 0) {
            const retainMemo = new Map<string, boolean>();
            const visitingGlyphNames = new Set<string>();

            const reachesRetainedGlyph = (glyphName: string): boolean => {
                if (retainMemo.has(glyphName)) {
                    return retainMemo.get(glyphName)!;
                }
                if (visitingGlyphNames.has(glyphName)) {
                    return false;
                }

                visitingGlyphNames.add(glyphName);

                let shouldRetain = retainGlyphNames.has(glyphName);
                for (const dependentGlyphName of this.findDirectGlyphsUsingComponent(
                    glyphName
                )) {
                    if (reachesRetainedGlyph(dependentGlyphName)) {
                        dependentGlyphNames.add(dependentGlyphName);
                        shouldRetain = true;
                    }
                }

                visitingGlyphNames.delete(glyphName);
                retainMemo.set(glyphName, shouldRetain);
                return shouldRetain;
            };

            for (const glyphName of sourceGlyphNames) {
                for (const dependentGlyphName of this.findDirectGlyphsUsingComponent(
                    glyphName
                )) {
                    if (reachesRetainedGlyph(dependentGlyphName)) {
                        dependentGlyphNames.add(dependentGlyphName);
                    }
                }
            }

            return dependentGlyphNames;
        }

        const queue = [...sourceGlyphNames];
        const visitedGlyphNames = new Set<string>(sourceGlyphNames);

        while (queue.length > 0) {
            const glyphName = queue.shift() as string;
            for (const dependentGlyphName of this.findDirectGlyphsUsingComponent(
                glyphName
            )) {
                if (visitedGlyphNames.has(dependentGlyphName)) {
                    continue;
                }

                visitedGlyphNames.add(dependentGlyphName);
                dependentGlyphNames.add(dependentGlyphName);
                queue.push(dependentGlyphName);
            }
        }

        return dependentGlyphNames;
    }

    /**
     * Invalidate automatic composition layout caches for all layers
     * of the specified glyphs. Call before recomputing compositions
     * so that stale cached layouts from a previous frame are not reused.
     */
    invalidateLayoutCachesForGlyphs(glyphNames: Iterable<string>): void {
        for (const glyphName of glyphNames) {
            const glyph = this.findGlyph(glyphName);
            if (!glyph?.layers) continue;
            for (const layer of glyph.layers) {
                if (layer instanceof Layer) {
                    layer.invalidateLayoutCache();
                }
            }
        }
    }

    /**
     * Find all glyphs that reference a given glyph as a component
     * This recursively finds glyphs at each nesting level
     * @param componentGlyphName - Name of the component glyph to search for
     * @returns Array of glyph names that contain this component
     * @example
     * glyphs = font.findGlyphsUsingComponent("o")
     * # Returns ["ö", "õ", "ø", ...] if they use "o" as a component
     */
    findGlyphsUsingComponent(componentGlyphName: string): string[] {
        return Array.from(
            this.collectComponentDependentGlyphs([componentGlyphName])
        );
    }

    /**
     * Duplicate a glyph with a new name, inserted immediately after the source.
     * The duplicate does not keep Unicode codepoints.
     * @example
     * new_glyph = font.duplicateGlyph(glyph, "A.alt")
     */
    duplicateGlyph(glyph: Glyph, newName: string): Glyph {
        assertModelMutationAllowed();
        assertCanAddGlyphs(1);
        // Check if glyph with newName already exists
        if (this.findGlyph(newName)) {
            throw new Error(`Glyph "${newName}" already exists in the font`);
        }

        // Get the source glyph data - access through the internal _data array
        const sourceGlyphIndex = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === glyph.name
        );
        if (sourceGlyphIndex < 0) {
            throw new Error(`Source glyph "${glyph.name}" not found in font`);
        }

        // Deep clone the glyph data
        const clonedData = JSON.parse(
            JSON.stringify(this._data.glyphs[sourceGlyphIndex])
        );

        // Set the new name; duplicates are unencoded.
        clonedData.name = newName;
        delete clonedData.codepoints;
        clonedData.id = generateStableId();

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

        // Insert the clone directly after the source glyph
        assertModelMutationAllowed();
        const insertIndex = sourceGlyphIndex + 1;
        this._data.glyphs.splice(insertIndex, 0, clonedData);
        this._glyphWrappers = null; // Invalidate cache
        this.invalidateReverseComponentIndex();
        recordAddAndMarkDirty(['glyphs', newName], clonedData);

        // Return the newly created glyph
        return new Glyph(this._data.glyphs, insertIndex, this);
    }

    /**
     * Next free glyph name using Glyphs-style .001 / .002 suffixes.
     * `a` → `a`; if taken → `a.001`, then `a.002`, …
     */
    allocateUniqueGlyphName(baseName: string): string {
        const name = String(baseName || '').trim();
        if (!name) {
            throw new Error('Glyph name must be non-empty');
        }
        if (!this.findGlyph(name)) {
            return name;
        }
        let index = 1;
        while (index < 10000) {
            const candidate = `${name}.${String(index).padStart(3, '0')}`;
            if (!this.findGlyph(candidate)) {
                return candidate;
            }
            index += 1;
        }
        throw new Error(`Could not allocate a unique name for "${name}"`);
    }

    /**
     * Duplicate each named glyph under a unique .001-style name.
     * Each clone is inserted directly after its source, loses codepoints,
     * regenerates layer IDs, and keeps master references.
     */
    duplicateGlyphs(names: Iterable<string>): Glyph[] {
        const uniqueNames = [
            ...new Set(
                [...names].filter(
                    (name) => typeof name === 'string' && name.length > 0
                )
            )
        ];
        // Process in font order so multi-select inserts stay next to sources.
        uniqueNames.sort((a, b) => {
            const indexA = this._data.glyphs.findIndex(
                (g: Unsafe) => g.name === a
            );
            const indexB = this._data.glyphs.findIndex(
                (g: Unsafe) => g.name === b
            );
            return indexA - indexB;
        });
        const toDuplicate = uniqueNames.filter((name) => this.findGlyph(name));
        assertCanAddGlyphs(toDuplicate.length);
        return withBridgeTransaction('Duplicate glyphs', () => {
            const created: Glyph[] = [];
            for (const name of toDuplicate) {
                const glyph = this.findGlyph(name);
                if (!glyph) {
                    continue;
                }
                const newName = this.allocateUniqueGlyphName(name);
                created.push(this.duplicateGlyph(glyph, newName));
            }
            return created;
        });
    }

    /**
     * Find an axis by ID
     */
    findAxis(id: string): Axis | undefined {
        const axes = this.axes;
        if (!axes) return undefined;
        const index = this._data.axes.findIndex((a: Unsafe) => a.id === id);
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
        const index = this._data.axes.findIndex((a: Unsafe) => a.tag === tag);
        return index >= 0 ? axes[index] : undefined;
    }

    /**
     * Find a master by ID
     */
    findMaster(id: string): Master | undefined {
        const masters = this.masters;
        if (!masters) return undefined;
        const index = this._data.masters.findIndex((m: Unsafe) => m.id === id);
        return index >= 0 ? masters[index] : undefined;
    }

    private createModelRecordId(prefix: string): string {
        if (
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
        ) {
            return crypto.randomUUID();
        }

        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    private clonePlainValue<T>(value: T): T {
        if (value === undefined) {
            return value;
        }

        return JSON.parse(JSON.stringify(value)) as T;
    }

    private getEffectiveDesignspaceLocationForLayer(
        layer: Layer | null | undefined
    ): DesignspaceLocation | undefined {
        if (!layer) {
            return undefined;
        }

        if (layer.location && Object.keys(layer.location).length > 0) {
            return this.clonePlainValue(layer.location);
        }

        const masterId = layer.master?.master;
        if (!masterId) {
            return undefined;
        }

        const master = this.findMaster(masterId);
        return master?.location
            ? this.clonePlainValue(master.location)
            : undefined;
    }

    private getAddMasterInterpolationLocations(
        targetLocation: DesignspaceLocation | undefined
    ): AddMasterInterpolationLocation[] {
        const locations: AddMasterInterpolationLocation[] = [];

        if (!targetLocation || Object.keys(targetLocation).length === 0) {
            return locations;
        }

        // Master locations are designspace. Pass them through directly — do not
        // round-trip via userspace (that path previously risked feeding the
        // extrapolated userspace endpoint back as a design coordinate).
        const designLocation = this.clonePlainValue(targetLocation);

        for (const glyph of this.glyphs) {
            locations.push({
                glyphName: glyph.name,
                designLocation
            });
        }

        return locations;
    }

    private getNextMasterLocation(): Record<string, number> | undefined {
        const axes = this.axes || [];
        if (axes.length === 0) {
            return undefined;
        }

        const existingByAxis: Record<string, Set<number>> = {};
        for (const master of this.masters || []) {
            const location = master.location || {};
            for (const axis of axes) {
                const tag = axis.tag;
                if (tag === undefined) {
                    continue;
                }

                if (!existingByAxis[tag]) {
                    existingByAxis[tag] = new Set<number>();
                }

                const axisDefault = axis.default as number | undefined;
                const value =
                    typeof location[tag] === 'number'
                        ? (location[tag] as number)
                        : (axisDefault ?? 0);
                existingByAxis[tag].add(value);
            }
        }

        const entries: [string, number][] = [];
        for (const axis of axes) {
            const tag = axis.tag;
            if (tag === undefined) {
                continue;
            }

            const taken = existingByAxis[tag] ?? new Set<number>();
            const map = Array.isArray(axis.map) ? axis.map : [];
            const designValues = map
                .map((entry) => Number(entry?.[1]))
                .filter((value) => Number.isFinite(value));
            const axisMaxDesign =
                designValues.length > 0
                    ? Math.max(...designValues)
                    : (axis.max as number | undefined);
            const axisMinDesign =
                designValues.length > 0
                    ? Math.min(...designValues)
                    : (axis.min as number | undefined);
            const axisDefault = axis.default as number | undefined;

            let chosen = axisDefault ?? 0;
            if (axisMaxDesign !== undefined && !taken.has(axisMaxDesign)) {
                chosen = axisMaxDesign;
            } else if (
                axisMinDesign !== undefined &&
                !taken.has(axisMinDesign)
            ) {
                chosen = axisMinDesign;
            }

            entries.push([tag, chosen]);
        }

        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    private buildDefaultMasterRecord(
        options?: AddMasterOptions
    ): Babelfont.Master {
        const nextIndex = (this.masters?.length ?? 0) + 1;
        const templateMaster = options?.metricTemplateMasterId
            ? this.findMaster(options.metricTemplateMasterId)
            : undefined;
        const metricTemplate =
            templateMaster?.metrics ||
            this.masters?.[this.masters.length - 1]?.metrics ||
            this.masters?.[0]?.metrics ||
            {};
        const metrics = Object.fromEntries(
            Object.entries(metricTemplate).map(([key, value]) => [
                key,
                typeof value === 'number' ? value : 0
            ])
        );

        return {
            id: this.createModelRecordId('master'),
            name: { dflt: `Master ${nextIndex}` },
            location: options?.location
                ? this.clonePlainValue(options.location)
                : this.getNextMasterLocation(),
            metrics,
            kerning: {} as Unsafe,
            kerning_rtl: {}
        };
    }

    private setLocalMastersList(nextMasters: Babelfont.Master[]): void {
        assertModelMutationAllowed();
        this._data.masters = nextMasters;
        this._masterWrappers = null;
    }

    private collectAutomaticNewLayerOverrides(
        metadata: InterpolationRustBatchMetadata
    ): Array<{
        glyphName: string;
        layerId: string;
        layer: Babelfont.Layer;
    }> {
        if (
            !metadata.mastersOperation?.newValue ||
            !Array.isArray(metadata.layerOperations) ||
            metadata.layerOperations.length === 0
        ) {
            return [];
        }

        return withSuppressedModelRecording(() => {
            const overlayData = this.clonePlainValue(
                this._data
            ) as Babelfont.Font;
            overlayData.masters = this.clonePlainValue(
                metadata.mastersOperation!.newValue
            ) as Babelfont.Master[];

            for (const operation of metadata.layerOperations) {
                if (
                    operation.newValue === undefined ||
                    operation.newValue === null
                ) {
                    continue;
                }
                const glyphData = overlayData.glyphs?.find(
                    (glyph) => glyph.name === operation.glyphName
                );
                if (!glyphData) {
                    continue;
                }
                if (!Array.isArray(glyphData.layers)) {
                    glyphData.layers = [];
                }
                const nextLayer = this.clonePlainValue(
                    operation.newValue
                ) as Babelfont.Layer;
                const existingIndex = glyphData.layers.findIndex(
                    (layer) => layer.id === operation.layerId
                );
                if (existingIndex >= 0) {
                    glyphData.layers[existingIndex] = nextLayer;
                } else {
                    glyphData.layers.push(nextLayer);
                }
            }

            const overlay = Font.fromData(overlayData);
            type AutoTarget = {
                glyphName: string;
                layerId: string;
                layer: Layer;
                componentRefs: string[];
            };
            const autoTargets: AutoTarget[] = [];
            for (const operation of metadata.layerOperations) {
                const layer = overlay
                    .findGlyph(operation.glyphName)
                    ?.findLayerById(operation.layerId);
                if (!layer?.isAutomaticAlignedLayer()) {
                    continue;
                }
                autoTargets.push({
                    glyphName: operation.glyphName,
                    layerId: operation.layerId,
                    layer,
                    componentRefs: layer.components
                        .map((component) => component.reference)
                        .filter(
                            (reference): reference is string =>
                                typeof reference === 'string' &&
                                reference.length > 0
                        )
                });
            }
            if (!autoTargets.length) {
                return [];
            }

            const autoGlyphNames = new Set(
                autoTargets.map((target) => target.glyphName)
            );
            const remaining = new Map(
                autoTargets.map((target) => [target.glyphName, target])
            );
            const ordered: AutoTarget[] = [];
            while (remaining.size > 0) {
                let progressed = false;
                for (const [glyphName, target] of [...remaining]) {
                    const blocked = target.componentRefs.some(
                        (reference) =>
                            autoGlyphNames.has(reference) &&
                            remaining.has(reference)
                    );
                    if (blocked) {
                        continue;
                    }
                    ordered.push(target);
                    remaining.delete(glyphName);
                    progressed = true;
                }
                if (!progressed) {
                    ordered.push(...remaining.values());
                    break;
                }
            }

            const sourceDataCache = new WeakMap<
                object,
                AutomaticCompositionSourceData
            >();
            const overrides: Array<{
                glyphName: string;
                layerId: string;
                layer: Babelfont.Layer;
            }> = [];
            for (const target of ordered) {
                const before = JSON.stringify(target.layer.toJSON());
                const changed =
                    target.layer.rebuildAutomaticComposition(sourceDataCache);
                if (!changed) {
                    continue;
                }
                const afterData = this.clonePlainValue(
                    target.layer.toJSON()
                ) as Babelfont.Layer;
                if (JSON.stringify(afterData) === before) {
                    continue;
                }
                overrides.push({
                    glyphName: target.glyphName,
                    layerId: target.layerId,
                    layer: afterData
                });
            }
            return overrides;
        });
    }

    async addMaster(
        master?: Babelfont.Master,
        options?: AddMasterOptions
    ): Promise<Master | null> {
        assertModelMutationAllowed();
        const clonedMaster = this.clonePlainValue(
            master ?? this.buildDefaultMasterRecord(options)
        );
        const previousAxes = this.clonePlainValue(this._data.axes ?? []);
        const axisExtension = extendAxesForDesignspaceLocation(
            previousAxes,
            clonedMaster.location
        );
        if (axisExtension.changed) {
            this._data.axes = axisExtension.axes;
        }
        const bridge = getPatchSyncEngine() as
            | (PatchSyncEngine & {
                  applyLocalGeneratedYjsUpdate?: (
                      update: Uint8Array,
                      operations: TransactionBufferedOperation[],
                      label: string | null,
                      historyTarget?: TransactionHistoryTarget | null
                  ) => unknown;
              })
            | null;

        if (
            getCurrentWindowFontModel() === this &&
            bridge?.applyLocalGeneratedYjsUpdate
        ) {
            beginLoadingCursor();
            beginStartupInteractionLock();
            try {
                const batchResult =
                    await window.fontManager.buildWorkerAddMasterWithInterpolatedLayersBatch(
                        clonedMaster,
                        this.getAddMasterInterpolationLocations(
                            clonedMaster.location
                        ),
                        // Always send the axes snapshot used for interpolation.
                        // Even when min/max/map did not change, the worker
                        // FONT_CACHE can lag (e.g. prior structural sync
                        // quarantine); omitting axes then extrapolates with a
                        // stale avar map and produces frankenstein layers.
                        this._data.axes ?? []
                    );
                if (
                    !batchResult.update.length &&
                    !batchResult.updates?.length
                ) {
                    if (axisExtension.changed) {
                        this._data.axes = previousAxes;
                    }
                    return this.findMaster(clonedMaster.id || '') || null;
                }

                let finalUpdate = batchResult.update;
                let documentUpdates = batchResult.updates;
                const metadata = batchResult.metadata;
                if (axisExtension.changed && !metadata.axesOperation) {
                    metadata.axesOperation = {
                        oldValue: previousAxes,
                        newValue: axisExtension.axes
                    };
                }
                const overrides =
                    this.collectAutomaticNewLayerOverrides(metadata);
                if (overrides.length) {
                    const refined =
                        await window.fontManager.buildWorkerRefineLayerSnapshotsBatch(
                            batchResult.update,
                            overrides
                        );
                    if (refined.update.length) {
                        finalUpdate = refined.update;
                    }
                    if (refined.updates?.length) {
                        documentUpdates = refined.updates;
                    }
                    const overrideByKey = new Map(
                        overrides.map((override) => [
                            `${override.glyphName}::${override.layerId}`,
                            override.layer
                        ])
                    );
                    for (const operation of metadata.layerOperations) {
                        const key = `${operation.glyphName}::${operation.layerId}`;
                        const overrideLayer = overrideByKey.get(key);
                        if (overrideLayer !== undefined) {
                            operation.newValue = overrideLayer;
                        }
                    }
                }

                bridge.applyLocalGeneratedYjsUpdate(
                    finalUpdate,
                    buildInterpolationRustBatchOperations(metadata),
                    'Add master',
                    ...(documentUpdates?.length ? [null, documentUpdates] : [])
                );
            } finally {
                endStartupInteractionLock();
                endLoadingCursor();
            }
            return this.findMaster(clonedMaster.id || '') || null;
        }

        const nextMasters = [
            ...this._data.masters.map((existing: Babelfont.Master) =>
                this.clonePlainValue(existing)
            ),
            clonedMaster
        ];
        this.setLocalMastersList(nextMasters);

        const masterId = clonedMaster.id;
        if (masterId) {
            for (const glyph of this.glyphs) {
                const sourceLayer = glyph.layers?.[glyph.layers.length - 1];
                const sourceWidth = sourceLayer?.width ?? 500;
                glyph.addLayer(
                    sourceWidth,
                    {
                        type: 'DefaultForMaster',
                        master: masterId
                    },
                    masterId
                );
            }
        }

        const currentFont =
            typeof window !== 'undefined'
                ? (window as Unsafe).fontManager?.currentFont
                : null;
        currentFont?.markDirty?.('font-info-masters-list');

        return this.findMaster(clonedMaster.id || '') || null;
    }

    async removeMastersByIds(masterIds: string[]): Promise<boolean> {
        assertModelMutationAllowed();
        const normalizedMasterIds = Array.from(
            new Set(
                masterIds.filter(
                    (masterId): masterId is string =>
                        typeof masterId === 'string' && masterId.length > 0
                )
            )
        );
        if (!normalizedMasterIds.length) {
            return false;
        }

        const previousMasters = this._data.masters.map(
            (master: Babelfont.Master) => this.clonePlainValue(master)
        );
        const nextMasters = previousMasters.filter(
            (master: Babelfont.Master) =>
                !normalizedMasterIds.includes(master.id || '')
        );
        if (nextMasters.length === previousMasters.length) {
            return false;
        }

        const removeMasterBoundLayers = () => {
            for (const glyph of this.glyphs) {
                const rawLayers = ((glyph as Unsafe).data?.layers ||
                    []) as Array<Babelfont.Layer & { id?: string }>;
                const layerIdsToRemove = rawLayers
                    .filter((layer) => {
                        const layerMaster = layer.master as
                            { master?: string } | undefined;
                        return (
                            typeof layer.id === 'string' &&
                            typeof layerMaster?.master === 'string' &&
                            normalizedMasterIds.includes(layerMaster.master)
                        );
                    })
                    .map((layer) => layer.id as string)
                    .filter((layerId, index, values) => {
                        return values.indexOf(layerId) === index;
                    });

                for (const layerId of layerIdsToRemove) {
                    glyph.removeLayerById(layerId);
                }
            }
        };

        const bridge = getPatchSyncEngine() as
            | (PatchSyncEngine & {
                  applyLocalGeneratedYjsUpdate?: (
                      update: Uint8Array,
                      operations: TransactionBufferedOperation[],
                      label: string | null,
                      historyTarget?: TransactionHistoryTarget | null
                  ) => unknown;
              })
            | null;

        if (
            getCurrentWindowFontModel() === this &&
            bridge?.applyLocalGeneratedYjsUpdate
        ) {
            beginLoadingCursor();
            beginStartupInteractionLock();
            try {
                const batchResult =
                    await window.fontManager.buildWorkerRemoveMastersBatch(
                        normalizedMasterIds
                    );
                if (
                    !batchResult.update.length &&
                    !batchResult.updates?.length
                ) {
                    return false;
                }
                bridge.applyLocalGeneratedYjsUpdate(
                    batchResult.update,
                    buildInterpolationRustBatchOperations(batchResult.metadata),
                    'Remove master',
                    null,
                    batchResult.updates
                );
            } finally {
                endStartupInteractionLock();
                endLoadingCursor();
            }
            return true;
        }

        this.setLocalMastersList(nextMasters);
        removeMasterBoundLayers();

        const currentFont = (window as Unsafe).fontManager?.currentFont;
        currentFont?.markDirty?.('font-info-masters-list');
        return true;
    }

    /**
     * Index at which to insert a new glyph that belongs with `baseName`.
     * Strips a trailing `.NNN` so clipboard names like `a.001` still land
     * with the `a` / `a.NNN` family. Prefers immediately after the last
     * existing family sibling; otherwise appends.
     */
    findInsertIndexAfterName(baseName: string): number {
        let name = String(baseName || '').trim();
        if (!name || !Array.isArray(this._data.glyphs)) {
            return this._data.glyphs?.length ?? 0;
        }
        while (/\.\d{3,}$/.test(name)) {
            name = name.replace(/\.\d{3,}$/, '');
        }
        if (!name) {
            return this._data.glyphs.length;
        }
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numbered = new RegExp(`^${escaped}\\.\\d{3,}$`);
        let lastIndex = -1;
        for (let index = 0; index < this._data.glyphs.length; index++) {
            const glyphName = this._data.glyphs[index]?.name;
            if (
                typeof glyphName === 'string' &&
                (glyphName === name || numbered.test(glyphName))
            ) {
                lastIndex = index;
            }
        }
        return lastIndex >= 0 ? lastIndex + 1 : this._data.glyphs.length;
    }

    /**
     * Add a new glyph to the font.
     *
     * Seeds one empty DefaultForMaster layer for every font master, using
     * `Glyph.addLayer()` so Python and the UI share the same constructor.
     * @example
     * glyph = font.addGlyph("myGlyph", "Base")
     */
    addGlyph(
        name: string,
        category: Babelfont.GlyphCategory | string = 'Base',
        options?: { insertIndex?: number }
    ): Glyph {
        assertModelMutationAllowed();
        assertCanAddGlyphs(1);
        const glyphData: Babelfont.Glyph = {
            name,
            category: Glyph.normalizeCategory(category),
            layers: [],
            exported: true,
            id: generateStableId()
        };
        assertModelMutationAllowed();
        const insertIndex =
            typeof options?.insertIndex === 'number' &&
            Number.isInteger(options.insertIndex) &&
            options.insertIndex >= 0 &&
            options.insertIndex <= this._data.glyphs.length
                ? options.insertIndex
                : this._data.glyphs.length;
        this._data.glyphs.splice(insertIndex, 0, glyphData);
        this._glyphWrappers = null; // Invalidate cache
        this.invalidateReverseComponentIndex();
        const glyph = new Glyph(this._data.glyphs, insertIndex, this);
        withSuppressedModelRecording(() => {
            for (const master of this._data.masters) {
                const masterId = master?.id;
                if (typeof masterId !== 'string' || !masterId.length) {
                    continue;
                }
                glyph.addLayer(
                    500,
                    {
                        type: 'DefaultForMaster',
                        master: masterId
                    },
                    masterId
                );
            }
        });
        recordAddAndMarkDirty(['glyphs', name], glyphData);
        return glyph;
    }

    /** Add several Unicode-backed glyphs as one undoable document edit. */
    addGlyphs(
        glyphs: Array<{
            name: string;
            codepoints: number[];
            category?: Babelfont.GlyphCategory | string;
        }>
    ): Glyph[] {
        assertCanAddGlyphs(glyphs.length);
        return withBridgeTransaction('Add glyphs', () =>
            glyphs.map((glyph) => {
                const added = this.addGlyph(
                    glyph.name,
                    glyph.category || 'Base'
                );
                added.codepoints = glyph.codepoints;
                return added;
            })
        );
    }

    /**
     * Count cleanup hits for a proposed glyph deletion and collect preview
     * details for the confirm dialog.
     */
    preflightDeleteGlyphs(names: Iterable<string>): GlyphDeletePreflight {
        const deletedNames = new Set(
            [...names].filter(
                (name) => typeof name === 'string' && name.length > 0
            )
        );
        const result: GlyphDeletePreflight = {
            featureReferences: 0,
            metricsKeyReferences: 0,
            componentReferences: 0,
            kerningPairReferences: 0,
            featureHits: [],
            metricsHits: [],
            componentGlyphNames: [],
            kerningMasters: [],
            kerningLtrHits: [],
            kerningRtlHits: []
        };
        if (deletedNames.size === 0) {
            return result;
        }

        const metricsKeyHits = (rawKey: string | undefined): boolean => {
            if (!rawKey) return false;
            const parsed = parseMetricsKey(this, rawKey);
            if ('error' in parsed) return false;
            if (parsed.kind === 'reference' && parsed.glyphName) {
                return deletedNames.has(parsed.glyphName);
            }
            return (parsed.referencedGlyphNames || []).some((name) =>
                deletedNames.has(name)
            );
        };

        const pushFeatureHit = (
            kind: 'feature' | 'class' | 'prefix',
            name: string,
            code: string
        ) => {
            const tokenCount = countDeletedGlyphTokensInFeatureCode(
                code,
                deletedNames
            );
            if (tokenCount === 0) {
                return;
            }
            result.featureReferences += tokenCount;
            const lines = collectFeatureLinesReferencingDeletedGlyphs(
                code,
                deletedNames
            );
            if (lines.length > 0) {
                result.featureHits.push({ kind, name, lines });
            }
        };

        if (this._data.features) {
            for (const [className, classData] of Object.entries(
                this._data.features.classes || {}
            )) {
                const codeData = classData as { code?: string };
                if (codeData.code) {
                    pushFeatureHit('class', className, codeData.code);
                }
            }
            for (const [featureTag, featureData] of this._data.features
                .features || []) {
                if (featureData?.code) {
                    pushFeatureHit(
                        'feature',
                        String(featureTag),
                        featureData.code
                    );
                }
            }
            for (const [prefixName, prefixData] of Object.entries(
                this._data.features.prefixes || {}
            )) {
                const codeData = prefixData as { code?: string };
                if (codeData.code) {
                    pushFeatureHit('prefix', prefixName, codeData.code);
                }
            }
        }

        const componentGlyphNames = new Set<string>();

        for (
            let glyphIndex = 0;
            glyphIndex < this._data.glyphs.length;
            glyphIndex++
        ) {
            const glyphData = this._data.glyphs[glyphIndex];
            if (deletedNames.has(glyphData.name)) {
                continue;
            }
            const glyph = new Glyph(this._data.glyphs, glyphIndex, this);
            let leftKey: string | null = null;
            let rightKey: string | null = null;

            if (metricsKeyHits(glyph.leftMetricsKey)) {
                result.metricsKeyReferences += 1;
                leftKey = glyph.leftMetricsKey || null;
            }
            if (metricsKeyHits(glyph.rightMetricsKey)) {
                result.metricsKeyReferences += 1;
                rightKey = glyph.rightMetricsKey || null;
            }

            if (Array.isArray(glyphData.layers)) {
                for (
                    let layerIndex = 0;
                    layerIndex < glyphData.layers.length;
                    layerIndex++
                ) {
                    const layer = new Layer(
                        glyphData.layers,
                        layerIndex,
                        glyph
                    );
                    if (metricsKeyHits(layer.leftMetricsKey)) {
                        result.metricsKeyReferences += 1;
                        if (!leftKey) {
                            leftKey = layer.leftMetricsKey || null;
                        }
                    }
                    if (metricsKeyHits(layer.rightMetricsKey)) {
                        result.metricsKeyReferences += 1;
                        if (!rightKey) {
                            rightKey = layer.rightMetricsKey || null;
                        }
                    }
                    for (const shape of glyphData.layers[layerIndex].shapes ||
                        []) {
                        if (!shape || typeof shape !== 'object') continue;
                        const reference =
                            (shape as Unsafe).reference ??
                            (shape as Unsafe).Component?.reference;
                        if (
                            typeof reference === 'string' &&
                            deletedNames.has(reference)
                        ) {
                            result.componentReferences += 1;
                            componentGlyphNames.add(glyphData.name);
                        }
                    }
                }
            }

            if (leftKey || rightKey) {
                result.metricsHits.push({
                    glyphName: glyphData.name,
                    leftKey,
                    rightKey
                });
            }
        }

        result.componentGlyphNames = [...componentGlyphNames].sort((a, b) =>
            a.localeCompare(b)
        );

        const masters = this.masters || [];
        result.kerningMasters = masters.map((master) => {
            const name = master.name;
            const label =
                typeof name === 'string'
                    ? name
                    : name && typeof name === 'object'
                      ? String(
                            (name as { dflt?: string; en?: string }).dflt ||
                                (name as { en?: string }).en ||
                                Object.values(name)[0] ||
                                master.id
                        )
                      : master.id;
            return { id: master.id, label };
        });

        const {
            relatedLeftKeys,
            relatedRightKeys,
            removedLeftKeys,
            removedRightKeys
        } = buildAffectedKerningKeys(
            deletedNames,
            this.first_kern_groups,
            this.second_kern_groups
        );

        const ltrHits = new Map<
            string,
            {
                left: string;
                right: string;
                values: Array<number | null>;
                willRemove: boolean;
            }
        >();
        const rtlHits = new Map<
            string,
            {
                left: string;
                right: string;
                values: Array<number | null>;
                willRemove: boolean;
            }
        >();
        const emptyValues = (): Array<number | null> => masters.map(() => null);

        masters.forEach((master, masterIndex) => {
            forEachKerningPair(master.kerning, (left, right, value) => {
                if (
                    !kerningPairIsAffected(
                        left,
                        right,
                        relatedLeftKeys,
                        relatedRightKeys
                    )
                ) {
                    return;
                }
                const key = `${left}\0${right}`;
                let hit = ltrHits.get(key);
                if (!hit) {
                    hit = {
                        left,
                        right,
                        values: emptyValues(),
                        willRemove: kerningPairIsAffected(
                            left,
                            right,
                            removedLeftKeys,
                            removedRightKeys
                        )
                    };
                    ltrHits.set(key, hit);
                }
                hit.values[masterIndex] = value;
            });
            forEachKerningPair(master.kerning_rtl, (left, right, value) => {
                if (
                    !kerningPairIsAffected(
                        left,
                        right,
                        relatedLeftKeys,
                        relatedRightKeys
                    )
                ) {
                    return;
                }
                const key = `${left}\0${right}`;
                let hit = rtlHits.get(key);
                if (!hit) {
                    hit = {
                        left,
                        right,
                        values: emptyValues(),
                        willRemove: kerningPairIsAffected(
                            left,
                            right,
                            removedLeftKeys,
                            removedRightKeys
                        )
                    };
                    rtlHits.set(key, hit);
                }
                hit.values[masterIndex] = value;
            });
        });

        const sortKernHits = (
            hits: Map<
                string,
                {
                    left: string;
                    right: string;
                    values: Array<number | null>;
                    willRemove: boolean;
                }
            >
        ) =>
            [...hits.values()].sort((a, b) => {
                if (a.willRemove !== b.willRemove) {
                    return a.willRemove ? -1 : 1;
                }
                return (
                    a.left.localeCompare(b.left) ||
                    a.right.localeCompare(b.right)
                );
            });

        result.kerningLtrHits = sortKernHits(ltrHits);
        result.kerningRtlHits = sortKernHits(rtlHits);
        result.kerningPairReferences =
            result.kerningLtrHits.filter((hit) => hit.willRemove).length +
            result.kerningRtlHits.filter((hit) => hit.willRemove).length;

        return result;
    }

    /**
     * Delete glyphs and clean font-owned references in one undoable
     * transaction. Always cleans features/classes/prefixes, metrics keys,
     * components, kerning (LTR + RTL), and kern-group membership (dropping
     * empty groups).
     */
    deleteGlyphs(names: Iterable<string>): void {
        assertModelMutationAllowed();

        const deletedNames = new Set<string>();
        for (const name of names) {
            if (
                typeof name === 'string' &&
                name &&
                this._data.glyphs.some((glyph: Unsafe) => glyph.name === name)
            ) {
                deletedNames.add(name);
            }
        }
        if (deletedNames.size === 0) {
            return;
        }

        const codepointsByDeletedName = new Map<string, number[]>();
        for (const name of deletedNames) {
            const glyph = this.findGlyph(name);
            const codepoints = Array.isArray(glyph?.codepoints)
                ? glyph.codepoints.filter(
                      (value: unknown): value is number =>
                          typeof value === 'number' && Number.isFinite(value)
                  )
                : [];
            codepointsByDeletedName.set(name, codepoints);
        }

        const shouldClearMetricsKey = (rawKey: string | undefined): boolean => {
            if (!rawKey) return false;
            const parsed = parseMetricsKey(this, rawKey);
            if ('error' in parsed) return false;
            if (parsed.kind === 'reference' && parsed.glyphName) {
                return deletedNames.has(parsed.glyphName);
            }
            return (parsed.referencedGlyphNames || []).some((name) =>
                deletedNames.has(name)
            );
        };

        withBridgeTransaction(
            deletedNames.size === 1
                ? `Delete glyph ${[...deletedNames][0]}`
                : `Delete ${deletedNames.size} glyphs`,
            () => {
                assertModelMutationAllowed();
                for (const glyph of this.glyphs) {
                    if (deletedNames.has(glyph.name)) {
                        continue;
                    }
                    if (shouldClearMetricsKey(glyph.leftMetricsKey)) {
                        glyph.leftMetricsKey = undefined;
                    }
                    if (shouldClearMetricsKey(glyph.rightMetricsKey)) {
                        glyph.rightMetricsKey = undefined;
                    }
                    glyph._clearStoredLayerMetricsKeysReferencing(
                        deletedNames,
                        this
                    );
                    glyph._removeStoredLayerComponentReferences(deletedNames);
                }

                const { removedLeftKeys, removedRightKeys } =
                    buildAffectedKerningKeys(
                        deletedNames,
                        this.first_kern_groups,
                        this.second_kern_groups
                    );
                for (const master of this.masters || []) {
                    master.kerning = filterKerningMap(
                        master.kerning,
                        removedLeftKeys,
                        removedRightKeys
                    );
                    master.kerning_rtl = filterKerningMap(
                        master.kerning_rtl,
                        removedLeftKeys,
                        removedRightKeys
                    );
                }

                const filterKernGroups = (
                    groups: Record<string, string[]> | undefined
                ): Record<string, string[]> | undefined => {
                    if (!groups) return groups;
                    const next: Record<string, string[]> = {};
                    for (const [groupName, members] of Object.entries(groups)) {
                        const filtered = members.filter(
                            (member) => !deletedNames.has(member)
                        );
                        if (filtered.length > 0) {
                            next[groupName] = filtered;
                        }
                    }
                    return next;
                };
                this.first_kern_groups = filterKernGroups(
                    this.first_kern_groups
                );
                this.second_kern_groups = filterKernGroups(
                    this.second_kern_groups
                );

                if (this._data.features) {
                    const oldFeatures = cloneForHistory(this._data.features);
                    const features = cloneForHistory(this._data.features);
                    for (const classData of Object.values(
                        features.classes || {}
                    )) {
                        const codeData = classData as { code?: string };
                        if (codeData.code) {
                            codeData.code =
                                stripDeletedGlyphTokensFromClassCode(
                                    codeData.code,
                                    deletedNames
                                );
                        }
                    }
                    for (const [, featureData] of features.features || []) {
                        if (featureData?.code) {
                            featureData.code =
                                commentOutFeatureLinesReferencingDeletedGlyphs(
                                    featureData.code,
                                    deletedNames
                                );
                        }
                    }
                    for (const prefixData of Object.values(
                        features.prefixes || {}
                    )) {
                        const codeData = prefixData as { code?: string };
                        if (codeData.code) {
                            codeData.code =
                                commentOutFeatureLinesReferencingDeletedGlyphs(
                                    codeData.code,
                                    deletedNames
                                );
                        }
                    }
                    this._data.features = features;
                    recordAndMarkDirty(this, 'features', oldFeatures, features);
                }

                for (const name of deletedNames) {
                    const index = this._data.glyphs.findIndex(
                        (glyph: Unsafe) => glyph.name === name
                    );
                    if (index < 0) {
                        continue;
                    }
                    const removedGlyph = this._data.glyphs[index];
                    this._data.glyphs.splice(index, 1);
                    recordRemoveAndMarkDirty(['glyphs', name], removedGlyph);
                }

                this._glyphWrappers = null;
                this.invalidateReverseComponentIndex();
            }
        );

        applyGlyphDeleteUiContext(deletedNames, codepointsByDeletedName);
    }

    /**
     * Remove a glyph by name
     * @example
     * font.removeGlyph("oldGlyph")
     */
    removeGlyph(name: string): boolean {
        assertModelMutationAllowed();
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === name
        );
        if (index >= 0) {
            const removedGlyph = this._data.glyphs[index];
            assertModelMutationAllowed();
            this._data.glyphs.splice(index, 1);
            this._glyphWrappers = null; // Invalidate cache
            this.invalidateReverseComponentIndex();
            recordRemoveAndMarkDirty(['glyphs', name], removedGlyph);
            return true;
        }
        return false;
    }

    /**
     * Serialize the font back to JSON string
     */
    toJSONString(options?: { compileFacing?: boolean }): string {
        // Worker/Yjs/resting state is always logical. Only explicit export or
        // compile-facing callers request the physical automatic =+/- view.
        const compileFacing = options?.compileFacing === true;
        const stripNodeIds = (nodes: unknown[]): unknown[] =>
            nodes.map((node) => {
                if (!node || typeof node !== 'object') {
                    return node;
                }
                const { id: _id, ...nodeWithoutId } = node as Unsafe;
                return nodeWithoutId;
            });
        const layerDataOverrides = new WeakMap<object, Unsafe>();
        if (compileFacing) {
            for (const glyph of this.glyphs) {
                for (const layer of glyph.layers ?? []) {
                    if (!layer.isAutomaticAlignedLayer()) continue;
                    const adjustedData = layer.toCompileJSON() as Unsafe;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const rawLayerData = (layer as any)._data as object;
                    if ((adjustedData as object) !== rawLayerData) {
                        layerDataOverrides.set(rawLayerData, adjustedData);
                    }
                }
            }
        }

        return JSON.stringify(
            this._data,
            (key, value) => {
                // Substitute offset-applied layer data for automatic layers with sidebearing keys
                if (
                    value &&
                    typeof value === 'object' &&
                    !Array.isArray(value) &&
                    layerDataOverrides.has(value)
                ) {
                    return layerDataOverrides.get(value);
                }

                // When serializing shape objects, normalize normalizer wrappers
                // back to plain (untagged) babelfont Shape objects.
                //
                // Input wrappers can look like:
                //   { Path: {...}, nodes: [...], isInterpolated?: bool }
                //   { Component: {...}, isInterpolated?: bool }
                //
                // Output must be plain shapes for Rust serde untagged enums:
                //   { nodes: ..., closed: ... }  OR  { reference: ..., transform: ... }
                if (
                    value &&
                    typeof value === 'object' &&
                    !Array.isArray(value)
                ) {
                    const hasPathWrapper =
                        'Path' in value &&
                        value.Path &&
                        typeof value.Path === 'object';
                    const hasComponentWrapper =
                        'Component' in value &&
                        value.Component &&
                        typeof value.Component === 'object';
                    const hasFlatPathFields = 'nodes' in value;
                    const hasFlatComponentFields = 'reference' in value;

                    // Normalize wrapped Path shape to unwrapped Path payload
                    if (hasPathWrapper) {
                        const pathPayload =
                            value.Path && typeof value.Path === 'object'
                                ? value.Path
                                : null;
                        if (pathPayload) {
                            const { id: _id, ...result } = pathPayload;
                            if (!Array.isArray(result.nodes)) {
                                throw new TypeError(
                                    'Path shape nodes must be arrays.'
                                );
                            }
                            result.nodes = stripNodeIds(result.nodes);
                            // Ensure `closed` field
                            if (!('closed' in result)) {
                                result.closed = false;
                            }
                            return result;
                        }
                    }

                    // Normalize wrapped Component shape to unwrapped Component payload
                    if (hasComponentWrapper && !hasPathWrapper) {
                        const componentPayload =
                            value.Component &&
                            typeof value.Component === 'object'
                                ? value.Component
                                : null;
                        if (componentPayload) {
                            const { id: _id, ...result } = componentPayload;
                            // Convert array-format transforms to DecomposedAffine objects
                            // Rust expects {translation, scale, rotation, skew, order}, not [a,b,c,d,tx,ty]
                            if (Array.isArray(result.transform)) {
                                result.transform =
                                    DecomposedAffineTransform.fromAffine(
                                        result.transform
                                    );
                            }
                            return result;
                        }
                    }

                    // Normalize flat Component shapes with array transforms
                    if (
                        hasFlatComponentFields &&
                        Array.isArray(value.transform)
                    ) {
                        const { id: _id, ...result } = value;
                        return {
                            ...result,
                            transform: DecomposedAffineTransform.fromAffine(
                                value.transform
                            )
                        };
                    }

                    if (hasFlatComponentFields && 'id' in value) {
                        const { id: _id, ...result } = value;
                        return result;
                    }

                    // Ensure `closed` field for flat Path shapes (Y.Doc roundtrip can lose it)
                    if (hasFlatPathFields) {
                        if (!Array.isArray(value.nodes)) {
                            throw new TypeError(
                                'Path shape nodes must be arrays.'
                            );
                        }
                        const { id: _id, ...result } = value;
                        return {
                            ...result,
                            nodes: stripNodeIds(value.nodes),
                            closed: 'closed' in value ? value.closed : false
                        };
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

    /**
     * Analyze a feature's code to determine if it contains GSUB and/or GPOS rules
     * @param featureTag - The 4-character feature tag (e.g., "liga", "kern")
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzeFeatureTables("liga")
     * if (analysis.hasGSUB) console.log("Feature has substitution rules")
     */
    analyzeFeatureTables(featureTag: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features?.features) {
            return { hasGSUB: false, hasGPOS: false };
        }

        // Find the feature by tag
        const feature = this.features.features.find(
            ([tag]) => tag === featureTag
        );
        if (!feature) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const code = feature[1].code || '';
        // Use a set to track visited features to prevent infinite recursion
        const visitedFeatures = new Set<string>([featureTag]);
        return this._analyzeOpenTypeCodeInternal(code, visitedFeatures);
    }

    /**
     * Analyze OpenType feature code to determine if it contains GSUB and/or GPOS rules
     * This is a general-purpose method that can analyze code from features, prefixes, or other sources
     * @param code - The AFDKO feature code to analyze
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzeOpenTypeCode("substitute a by b;")
     * if (analysis.hasGSUB) console.log("Code contains substitution rules")
     */
    analyzeOpenTypeCode(code: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        // Use an empty set since we're analyzing standalone code without feature references
        return this._analyzeOpenTypeCodeInternal(code, new Set());
    }

    /**
     * Analyze a prefix's code to determine if it contains GSUB and/or GPOS rules
     * @param prefixName - The name of the prefix to analyze
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzePrefix("myLookup")
     * if (analysis.hasGSUB) console.log("Prefix contains substitution rules")
     */
    analyzePrefix(prefixName: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features?.prefixes) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const prefix = this.features.prefixes[prefixName];
        if (!prefix) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const code = prefix.code || '';
        // Use an empty set since prefixes don't have feature tag references
        return this._analyzeOpenTypeCodeInternal(code, new Set());
    }

    /**
     * Internal method to analyze OpenType code for GSUB/GPOS content
     * Handles lookup references and feature references by parsing all features and prefixes
     * @param visitedFeatures - Set of feature tags already visited to prevent infinite recursion
     */
    private _analyzeOpenTypeCodeInternal(
        code: string,
        visitedFeatures: Set<string> = new Set()
    ): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        // GSUB keywords from OpenType Feature File Specification
        const gsubKeywords = ['substitute', 'sub', 'reversesub', 'rsub'];

        // GPOS keywords from OpenType Feature File Specification
        const gposKeywords = ['position', 'pos', 'valueRecordDef', 'cursive'];

        let hasGSUB = false;
        let hasGPOS = false;

        // Check for direct GSUB keywords
        for (const keyword of gsubKeywords) {
            // Match keyword as whole word (not part of another word)
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(code)) {
                hasGSUB = true;
                break;
            }
        }

        // Check for direct GPOS keywords
        for (const keyword of gposKeywords) {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(code)) {
                hasGPOS = true;
                break;
            }
        }

        // Check for feature references (e.g., "feature salt;" in aalt)
        const featureRefPattern = /\bfeature\s+([a-zA-Z0-9]{4})\s*;/g;
        const featureRefs: string[] = [];
        let match;
        while ((match = featureRefPattern.exec(code)) !== null) {
            const referencedTag = match[1];
            // Only process if we haven't visited this feature already
            if (!visitedFeatures.has(referencedTag)) {
                featureRefs.push(referencedTag);
            }
        }

        // Recursively analyze referenced features
        if (featureRefs.length > 0 && this.features?.features) {
            for (const refTag of featureRefs) {
                const refFeature = this.features.features.find(
                    ([tag]) => tag === refTag
                );
                if (refFeature) {
                    // Mark this feature as visited to prevent infinite recursion
                    const newVisited = new Set(visitedFeatures);
                    newVisited.add(refTag);
                    const refAnalysis = this._analyzeOpenTypeCodeInternal(
                        refFeature[1].code || '',
                        newVisited
                    );
                    if (refAnalysis.hasGSUB) hasGSUB = true;
                    if (refAnalysis.hasGPOS) hasGPOS = true;
                }
            }
        }

        // Check for lookup references (e.g., "lookup LOOKUP_NAME;")
        const lookupRefPattern = /lookup\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
        const lookupRefs: string[] = [];
        while ((match = lookupRefPattern.exec(code)) !== null) {
            lookupRefs.push(match[1]);
        }

        // If we found lookup references, analyze those lookups
        if (lookupRefs.length > 0) {
            for (const lookupName of lookupRefs) {
                const lookupAnalysis = this._analyzeLookupByName(
                    lookupName,
                    visitedFeatures
                );
                if (lookupAnalysis.hasGSUB) hasGSUB = true;
                if (lookupAnalysis.hasGPOS) hasGPOS = true;
            }
        }

        return { hasGSUB, hasGPOS };
    }

    /**
     * Find and analyze a named lookup in features or prefixes
     * @param visitedFeatures - Set of feature tags already visited to prevent infinite recursion
     */
    private _analyzeLookupByName(
        lookupName: string,
        visitedFeatures: Set<string> = new Set()
    ): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features) {
            return { hasGSUB: false, hasGPOS: false };
        }

        // Search in prefixes
        if (this.features.prefixes) {
            const prefixCode = this.features.prefixes[lookupName];
            if (prefixCode?.code) {
                return this._analyzeOpenTypeCodeInternal(
                    prefixCode.code,
                    visitedFeatures
                );
            }
        }

        // Search in all features for named lookup blocks
        // Pattern: lookup NAME { ... } NAME;
        const lookupPattern = new RegExp(
            `lookup\\s+${lookupName}\\s*\\{([^}]+)\\}\\s*${lookupName}\\s*;`,
            'gs'
        );

        if (this.features.features) {
            for (const [, featureData] of this.features.features) {
                const featureCode = featureData.code || '';
                const lookupMatch = lookupPattern.exec(featureCode);
                if (lookupMatch) {
                    return this._analyzeOpenTypeCodeInternal(
                        lookupMatch[1],
                        visitedFeatures
                    );
                }
            }
        }

        // Also check prefixes for lookup blocks
        if (this.features.prefixes) {
            for (const prefixCode of Object.values(this.features.prefixes)) {
                const code = prefixCode.code || '';
                const lookupMatch = lookupPattern.exec(code);
                if (lookupMatch) {
                    return this._analyzeOpenTypeCodeInternal(
                        lookupMatch[1],
                        visitedFeatures
                    );
                }
            }
        }

        return { hasGSUB: false, hasGPOS: false };
    }
}
