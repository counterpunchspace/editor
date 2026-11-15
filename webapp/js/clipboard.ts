/**
 * Clipboard paste/copy orchestration for outline editing.
 *
 * Paste priority: Counterpunch JSON (custom MIME, text/plain envelope, or SVG
 * metadata) → Fontra tagged MIME (`fontra/json-clipboard`) → SVG paths.
 * Fontra JSON on text/plain is ignored.
 *
 * Chromium web custom formats (Fontra / Counterpunch tagged MIME) appear on
 * `navigator.clipboard.read()`, not reliably on paste `DataTransfer` — paste
 * therefore merges sync event payloads with an async ClipboardItem read.
 *
 * Copy writes a font-editor-clipboard envelope on text/plain, Fontra tagged
 * MIME for web interchange, and, via the Async Clipboard API, image/svg+xml
 * so macOS Chrome publishes public.svg-image for Glyphs Cmd+V.
 * Sync setData alone cannot expose SVG as a system UTI.
 * Selection pastes fan out to linked drawings when linked.
 * Whole-glyph JSON pastes create new glyphs (Glyphs-style .001 names)
 * with drawing content remapped onto this font's stations.
 * SVG pastes are centered in the target drawing.
 */

import { Logger } from './logger';
import { getHighestVisibleVerticalMetricValue } from './glyph-canvas/vertical-metrics';
import type { Font, Glyph, Drawing, Station, Path } from './babelfont-model';
import type { Babelfont } from './babelfont';
import type {
    PasteFeatureVariation,
    PasteGlyphDrawing,
    PasteGlyphsDocument
} from './clipboard/json';
import {
    canParseCounterpunchJson,
    COUNTERPUNCH_CLIPBOARD_MIME,
    parseCounterpunchJson
} from './clipboard/json';
import {
    canParseFontraClipboardPayload,
    FONTRA_CLIPBOARD_MIME_TYPES,
    fontraClipboardItemRepresentation,
    parseFontraClipboard,
    stringifyFontraClipboardDocument,
    writeFontraClipboardToDataTransfer,
    buildFontraAxisNameByKey
} from './clipboard/fontra';
import {
    SVG_MIME_TYPES,
    canParseSvg,
    extractCounterpunchJsonFromSvg,
    parseSvg,
    serializePathsToSvg
} from './clipboard/svg';
import type {
    ClipboardPayload,
    PasteFragment,
    PasteGuide,
    PastePath
} from './clipboard/types';
import type { CounterpunchClipboardDocument } from './clipboard/serialize';
import { stringifyClipboardDocument } from './clipboard/serialize';

export {
    buildGlyphsClipboardDocument,
    buildSelectionClipboardDocument,
    serializeAnchorForClipboard,
    serializeComponentForClipboard,
    serializeFontStationsForClipboard as serializeFontMastersForClipboard,
    serializeGlyphForClipboard,
    serializeGuideForClipboard,
    serializeDrawingForClipboard as serializeLayerForClipboard,
    serializeStationGuideForClipboard as serializeMasterGuideForClipboard,
    serializePathForClipboard,
    stringifyClipboardDocument,
    summarizeClipboardDocument,
    wrapClipboardEnvelope,
    COUNTERPUNCH_CLIPBOARD_VERSION
} from './clipboard/serialize';
export type {
    CounterpunchClipboardDocument,
    CounterpunchGlyphsClipboard,
    CounterpunchSelectionClipboard,
    FontEditorClipboardEnvelope
} from './clipboard/serialize';
export {
    serializePathsToSvg,
    SVG_MIME_TYPES,
    extractCounterpunchJsonFromSvg
} from './clipboard/svg';
export type { SerializePathsToSvgOptions } from './clipboard/svg';
export {
    COUNTERPUNCH_CLIPBOARD_MIME,
    COUNTERPUNCH_CLIPBOARD_VENDOR,
    COUNTERPUNCH_CLIPBOARD_METADATA_ID,
    FONT_EDITOR_CLIPBOARD_SCHEMA,
    FONT_EDITOR_CLIPBOARD_SCHEMA_VERSION
} from './clipboard/json';
export {
    FONTRA_CLIPBOARD_MIME,
    FONTRA_CLIPBOARD_MIME_TYPES,
    canParseFontraClipboardPayload,
    parseFontraClipboard,
    stringifyFontraClipboardDocument,
    buildFontraAxisNameByKey
} from './clipboard/fontra';
export type { ParsedFontraClipboard } from './clipboard/fontra';

const console = new Logger('Clipboard');

export type {
    ClipboardPayload,
    PasteFragment,
    PastePath,
    PasteGuide
} from './clipboard/types';

export type { PasteGlyphsDocument, PasteGlyph } from './clipboard/json';

export type ParsedClipboard =
    | { kind: 'selection'; fragment: PasteFragment }
    | { kind: 'glyphs'; document: PasteGlyphsDocument };

export type ClipboardPasteKind = 'glyphs' | 'selection' | 'text' | 'empty';

export type ApplyPasteOptions = {
    activeDrawing: Drawing;
    linkedDrawings: Drawing[];
    station?: Station | null;
    drawingWidth: number;
    verticalMetrics?: Record<string, number> | null;
    glyphExists: (name: string) => boolean;
};

export type ApplyPasteGlyphsOptions = {
    font: Font;
    glyphExists: (name: string) => boolean;
};

export type ApplyPasteResult = {
    fragment: PasteFragment;
    addedPathCount: number;
    addedComponentCount: number;
    addedAnchorCount: number;
    updatedAnchorCount: number;
    addedGuideCount: number;
    skippedComponents: string[];
    error?: string;
};

export type ApplyPasteGlyphsResult = ApplyPasteResult & {
    createdGlyphNames: string[];
    warnings: string[];
};

export type ApplyReplaceSelectedPathsOptions = {
    activeDrawing: Drawing;
    /** Selected paths in ascending shape-index order. */
    selectedPaths: Path[];
    /** Names of anchors currently selected in the editor. */
    selectedAnchorNames: string[];
    fragment: PasteFragment;
};

export type ApplyReplaceSelectedPathsResult = {
    replacedPathCount: number;
    updatedAnchorCount: number;
    error?: string;
};

function pushClipboardPayload(
    payloads: ClipboardPayload[],
    seen: Set<string>,
    type: string,
    data: string
): void {
    if (!data || seen.has(`${type}\0${data}`)) {
        return;
    }
    seen.add(`${type}\0${data}`);
    payloads.push({ type, data });
}

export function collectClipboardPayloads(
    clipboardData: DataTransfer | null | undefined
): ClipboardPayload[] {
    if (!clipboardData) {
        return [];
    }
    const payloads: ClipboardPayload[] = [];
    const seen = new Set<string>();

    const types = Array.from(clipboardData.types || []);
    for (const type of types) {
        try {
            const data = clipboardData.getData(type);
            if (data) {
                pushClipboardPayload(payloads, seen, type, data);
            }
        } catch {
            // Some browsers throw for non-text types.
        }
    }

    for (const type of [
        COUNTERPUNCH_CLIPBOARD_MIME,
        `web ${COUNTERPUNCH_CLIPBOARD_MIME}`,
        ...FONTRA_CLIPBOARD_MIME_TYPES,
        ...SVG_MIME_TYPES,
        'text/plain',
        'text/html'
    ]) {
        if (types.includes(type)) {
            continue;
        }
        try {
            const data = clipboardData.getData(type);
            if (data) {
                pushClipboardPayload(payloads, seen, type, data);
            }
        } catch {
            // Ignore unavailable types.
        }
    }

    return payloads;
}

/**
 * Read clipboard representations via the Async Clipboard API.
 * Required for Chromium web custom formats such as
 * `web fontra/json-clipboard` that paste `DataTransfer` omits.
 */
export async function readClipboardPayloadsAsync(): Promise<
    ClipboardPayload[]
> {
    if (
        typeof navigator === 'undefined' ||
        typeof navigator.clipboard?.read !== 'function'
    ) {
        return [];
    }

    let items: ClipboardItems;
    try {
        items = await navigator.clipboard.read();
    } catch {
        return [];
    }

    const payloads: ClipboardPayload[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        for (const type of item.types) {
            try {
                const blob = await item.getType(type);
                const data = await blob.text();
                pushClipboardPayload(payloads, seen, type, data);
            } catch {
                // Binary or unavailable types.
            }
        }
    }

    return payloads;
}

/** Deduping concat; earlier lists win when the same type+data appears twice. */
export function mergeClipboardPayloads(
    ...lists: ClipboardPayload[][]
): ClipboardPayload[] {
    const payloads: ClipboardPayload[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
        for (const payload of list) {
            pushClipboardPayload(payloads, seen, payload.type, payload.data);
        }
    }
    return payloads;
}

/**
 * Sync paste DataTransfer plus async ClipboardItem read (Fontra / tagged MIME).
 * Prefer calling this from a user-gesture handler (paste / Cmd+V).
 */
export async function resolveClipboardPayloads(
    clipboardData?: DataTransfer | null
): Promise<ClipboardPayload[]> {
    const syncPayloads = collectClipboardPayloads(clipboardData);
    const asyncPayloads = await readClipboardPayloadsAsync();
    // Async first so tagged MIME is present before SVG fallbacks when parsing.
    return mergeClipboardPayloads(asyncPayloads, syncPayloads);
}

/** True when paste already has Counterpunch/Fontra fidelity (not SVG-only). */
export function isTaggedStructuredClipboard(
    parsed: ParsedClipboard | null | undefined
): boolean {
    if (!parsed) {
        return false;
    }
    if (parsed.kind === 'glyphs') {
        return true;
    }
    return (
        parsed.fragment.format === 'counterpunch-json' ||
        parsed.fragment.format === 'fontra-json'
    );
}

/**
 * Write a Counterpunch clipboard document for Cmd+C.
 *
 * Sync DataTransfer path (copy-event fallback): JSON on text/plain. Setting
 * image/svg+xml via setData does not publish a real macOS UTI — Chrome keeps
 * it in org.chromium.web-custom-data, which Glyphs cannot see.
 *
 * Prefer {@link writeClipboardDocumentAsync} which uses ClipboardItem so
 * image/svg+xml maps to public.svg-image for Glyphs/Illustrator Cmd+V.
 */
export function writeClipboardDocumentToDataTransfer(
    clipboardData: DataTransfer,
    document: CounterpunchClipboardDocument,
    paths: PastePath[],
    fontraOptions?: {
        layerId?: string;
        drawingWidth?: number;
        codePoints?: number[];
        glyphCodePoints?: Record<string, number[]>;
        axisNameByKey?: Record<string, string>;
    }
): void {
    const json = stringifyClipboardDocument(document);
    try {
        clipboardData.setData(COUNTERPUNCH_CLIPBOARD_MIME, json);
    } catch {
        // Some browsers reject non-standard MIME types.
    }
    clipboardData.setData('text/plain', json);

    // Fontra tagged MIME only — never put Fontra JSON on text/plain.
    try {
        writeFontraClipboardToDataTransfer(
            clipboardData,
            stringifyFontraClipboardDocument(document, fontraOptions)
        );
    } catch {
        // Optional interchange path.
    }

    // Best-effort: same-browser paste may still see these; native apps will not.
    const svg = serializePathsToSvg(paths);
    if (svg) {
        for (const type of SVG_MIME_TYPES) {
            try {
                clipboardData.setData(type, svg);
            } catch {
                // Some browsers reject non-standard MIME types.
            }
        }
    }
}

/**
 * Write JSON + SVG via the Async Clipboard API.
 * On macOS Chrome, image/svg+xml becomes public.svg-image (system-visible),
 * which Glyphs Cmd+V can paste. text/plain stays Counterpunch JSON for scripts.
 */
export async function writeClipboardDocumentAsync(
    document: CounterpunchClipboardDocument,
    paths: PastePath[],
    fontraOptions?: {
        layerId?: string;
        drawingWidth?: number;
        codePoints?: number[];
        glyphCodePoints?: Record<string, number[]>;
        axisNameByKey?: Record<string, string>;
    }
): Promise<boolean> {
    if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard?.write ||
        typeof ClipboardItem === 'undefined'
    ) {
        return false;
    }

    const json = stringifyClipboardDocument(document);
    const fontraJson = stringifyFontraClipboardDocument(
        document,
        fontraOptions
    );
    const representations: Record<string, Blob> = {
        'text/plain': new Blob([json], { type: 'text/plain' })
    };

    const svg = serializePathsToSvg(paths);
    const supportsSvg =
        typeof ClipboardItem.supports !== 'function' ||
        ClipboardItem.supports('image/svg+xml');
    if (svg && supportsSvg) {
        representations['image/svg+xml'] = new Blob([svg], {
            type: 'image/svg+xml'
        });
    }

    const withAllCustom: Record<string, Blob> = {
        ...representations,
        [`web ${COUNTERPUNCH_CLIPBOARD_MIME}`]: new Blob([json], {
            type: COUNTERPUNCH_CLIPBOARD_MIME
        }),
        ...fontraClipboardItemRepresentation(fontraJson)
    };
    const withFontraOnly: Record<string, Blob> = {
        ...representations,
        ...fontraClipboardItemRepresentation(fontraJson)
    };

    // Prefer full custom set; if a vendor MIME is rejected, still try Fontra
    // alone before falling back to text/SVG only.
    for (const attempt of [withAllCustom, withFontraOnly, representations]) {
        try {
            await navigator.clipboard.write([new ClipboardItem(attempt)]);
            return true;
        } catch {
            // Try the next representation set.
        }
    }

    console.warn('Async clipboard write failed');
    return false;
}

export function parseClipboardPayloads(
    payloads: ClipboardPayload[]
): ParsedClipboard | null {
    // Prefer Counterpunch JSON on any text-like payload (including SVG metadata).
    for (const payload of payloads) {
        const candidates = [payload.data];
        if (canParseSvg(payload.data)) {
            const embedded = extractCounterpunchJsonFromSvg(payload.data);
            if (embedded) {
                candidates.unshift(embedded);
            }
        }
        for (const candidate of candidates) {
            if (!canParseCounterpunchJson(candidate)) {
                continue;
            }
            const parsed = parseCounterpunchJson(candidate);
            if (parsed) {
                return parsed;
            }
        }
    }

    // Fontra tagged MIME only — ignore Fontra JSON mirrored on text/plain.
    for (const payload of payloads) {
        if (!canParseFontraClipboardPayload(payload.type, payload.data)) {
            continue;
        }
        const parsed = parseFontraClipboard(payload.data);
        if (parsed) {
            return parsed;
        }
    }

    const byType = new Map(
        payloads.map((payload) => [payload.type, payload.data])
    );

    for (const type of SVG_MIME_TYPES) {
        const data = byType.get(type);
        if (!data) {
            continue;
        }
        const parsed = parseSvg(data);
        if (parsed) {
            return { kind: 'selection', fragment: parsed };
        }
    }

    for (const payload of payloads) {
        if (canParseSvg(payload.data)) {
            const parsed = parseSvg(payload.data);
            if (parsed) {
                return { kind: 'selection', fragment: parsed };
            }
        }
    }

    return null;
}

/**
 * Classify clipboard contents for paste targeting: whole glyphs, drawing
 * selection / SVG, ordinary text, or nothing pasteable.
 */
export function classifyClipboardPayloads(
    payloads: ClipboardPayload[]
): ClipboardPasteKind {
    const parsed = parseClipboardPayloads(payloads);
    if (parsed?.kind === 'glyphs') {
        return 'glyphs';
    }
    if (parsed?.kind === 'selection') {
        return 'selection';
    }
    const text = payloads.find(
        (payload) => payload.type === 'text/plain'
    )?.data;
    if (typeof text === 'string' && text.length > 0) {
        return 'text';
    }
    return 'empty';
}

export function applyPasteFragment(
    fragment: PasteFragment,
    options: ApplyPasteOptions
): ApplyPasteResult {
    const targetDrawings = [options.activeDrawing, ...options.linkedDrawings];
    const isBackground = !!options.activeDrawing.is_background;

    let working: PasteFragment = cloneFragment(fragment);

    if (!working.keepAbsoluteCoords) {
        working = centerFragmentInDrawing(
            working,
            options.drawingWidth,
            options.verticalMetrics
        );
        working = placeGuideOrigins(working, options.verticalMetrics);
    }

    const result = emptyResult(working);
    const foregroundTargets = targetDrawings.filter(
        (drawing) => !drawing.is_background
    );

    for (const drawing of targetDrawings) {
        for (const path of working.paths) {
            appendPathToDrawing(drawing, path);
        }
    }
    result.addedPathCount = working.paths.length * targetDrawings.length;

    applyNonPathObjectsToDrawings(
        working,
        isBackground ? targetDrawings : foregroundTargets,
        options.activeDrawing,
        options.station ?? null,
        options.glyphExists,
        result,
        {
            fanOutAnchors: !isBackground,
            includeAnchorsAndGuides: !isBackground
        }
    );

    return result;
}

/**
 * Normalize node types the same way drawing fingerprints do (Move ≡ Line).
 */
export function normalizeClipboardPathNodeType(
    nodeType: string | undefined
): string {
    switch (nodeType) {
        case 'Move':
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

export function getPastePathStructureSignature(path: {
    closed?: boolean;
    nodes: Array<{ nodetype?: string }>;
}): string {
    const closedFlag = path.closed === false ? '0' : '1';
    const nodeTypes = getPastePathNormalizedNodeTypes(path);
    return `P:${closedFlag}:${nodeTypes.length}:${nodeTypes.join(',')}`;
}

export function getPastePathNormalizedNodeTypes(path: {
    nodes: Array<{ nodetype?: string }>;
}): string[] {
    return (path.nodes || []).map((node) =>
        normalizeClipboardPathNodeType(node.nodetype)
    );
}

/**
 * True when closed flag and node-type sequence match (coordinates ignored).
 * Closed paths may start at a different node; types are compared cyclically.
 * Callers must pass path geometry only — ignore anchors/components/guides.
 */
export function arePastePathsStructurallyCompatible(
    a: { closed?: boolean; nodes: Array<{ nodetype?: string }> },
    b: { closed?: boolean; nodes: Array<{ nodetype?: string }> }
): boolean {
    const aClosed = a.closed !== false;
    const bClosed = b.closed !== false;
    if (aClosed !== bClosed) {
        return false;
    }
    return findPastePathTypeAlignmentOffset(a, b) !== null;
}

/**
 * Offset to rotate `source` node types so they match `target`.
 * Open paths only succeed at offset 0. Closed paths allow any start node.
 * When several type alignments exist (repeating segments), pick the offset
 * whose coordinates are closest to the current target nodes.
 */
export function findPastePathTypeAlignmentOffset(
    target: {
        closed?: boolean;
        nodes: Array<{ x?: number; y?: number; nodetype?: string }>;
    },
    source: {
        closed?: boolean;
        nodes: Array<{ x?: number; y?: number; nodetype?: string }>;
    }
): number | null {
    const targetTypes = getPastePathNormalizedNodeTypes(target);
    const sourceTypes = getPastePathNormalizedNodeTypes(source);
    if (targetTypes.length !== sourceTypes.length) {
        return null;
    }
    if (targetTypes.length === 0) {
        return 0;
    }

    const closed = target.closed !== false && source.closed !== false;
    const maxOffset = closed ? targetTypes.length : 1;
    let bestOffset: number | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < maxOffset; offset++) {
        let matches = true;
        for (let i = 0; i < targetTypes.length; i++) {
            if (
                targetTypes[i] !==
                sourceTypes[(i + offset) % sourceTypes.length]
            ) {
                matches = false;
                break;
            }
        }
        if (!matches) {
            continue;
        }

        let score = 0;
        for (let i = 0; i < targetTypes.length; i++) {
            const targetNode = target.nodes[i];
            const sourceNode = source.nodes[(i + offset) % source.nodes.length];
            const dx =
                (Number(targetNode?.x) || 0) - (Number(sourceNode?.x) || 0);
            const dy =
                (Number(targetNode?.y) || 0) - (Number(sourceNode?.y) || 0);
            score += dx * dx + dy * dy;
        }
        if (score < bestScore) {
            bestScore = score;
            bestOffset = offset;
        }
    }
    return bestOffset;
}

/** Rotate clipboard path nodes so their type sequence aligns with the target. */
export function alignPastePathNodesToTarget(
    target: { closed?: boolean; nodes: Array<{ nodetype?: string }> },
    source: PastePath
): PastePath | null {
    const offset = findPastePathTypeAlignmentOffset(target, source);
    if (offset === null) {
        return null;
    }
    if (offset === 0) {
        return {
            closed: source.closed,
            nodes: source.nodes.map((node) => ({ ...node }))
        };
    }
    const nodes = source.nodes;
    return {
        closed: source.closed,
        nodes: nodes
            .slice(offset)
            .concat(nodes.slice(0, offset))
            .map((node) => ({ ...node }))
    };
}

/**
 * Replace selected paths' geometry on the active drawing only (never fans out to
 * linked drawings). Clipboard path count and structure must match the selection.
 * Only paths are compared — clipboard/local anchors, components, and guides are
 * ignored for compatibility. Closed-path start nodes may differ; incoming nodes
 * are rotated to preserve the selected path's start. Clipboard anchors update
 * existing active-drawing anchors only when those anchors are currently selected.
 */
export function applyReplaceSelectedPaths(
    options: ApplyReplaceSelectedPathsOptions
): ApplyReplaceSelectedPathsResult {
    const { activeDrawing, selectedPaths, selectedAnchorNames, fragment } =
        options;

    if (!selectedPaths.length) {
        return {
            replacedPathCount: 0,
            updatedAnchorCount: 0,
            error: 'Select one or more paths to replace in place.'
        };
    }

    // Paths only — ignore clipboard components/anchors/guides for matching.
    const clipboardPaths = fragment.paths || [];
    if (clipboardPaths.length !== selectedPaths.length) {
        return {
            replacedPathCount: 0,
            updatedAnchorCount: 0,
            error: `Clipboard has ${clipboardPaths.length} path(s) but ${selectedPaths.length} path(s) are selected. Counts must match.`
        };
    }

    const alignedSources: PastePath[] = [];
    for (let i = 0; i < selectedPaths.length; i++) {
        const aligned = alignPastePathNodesToTarget(
            selectedPaths[i],
            clipboardPaths[i]
        );
        if (!aligned) {
            return {
                replacedPathCount: 0,
                updatedAnchorCount: 0,
                error: `Selected path ${i + 1} is not structurally compatible with clipboard path ${i + 1}.`
            };
        }
        alignedSources.push(aligned);
    }

    for (let i = 0; i < selectedPaths.length; i++) {
        const target = selectedPaths[i];
        const source = alignedSources[i];
        target.nodes = source.nodes.map((node) => ({
            x: node.x,
            y: node.y,
            nodetype: node.nodetype as Babelfont.NodeType,
            ...(node.smooth ? { smooth: true } : {})
        }));
        if (typeof source.closed === 'boolean') {
            target.closed = source.closed;
        }
    }

    let updatedAnchorCount = 0;
    if (selectedAnchorNames.length > 0 && fragment.anchors.length > 0) {
        const selectedNames = new Set(selectedAnchorNames);
        for (const anchor of fragment.anchors) {
            if (!selectedNames.has(anchor.name)) {
                continue;
            }
            const existing = findAnchorByName(activeDrawing, anchor.name);
            if (!existing) {
                continue;
            }
            existing.x = anchor.x;
            existing.y = anchor.y;
            updatedAnchorCount += 1;
        }
    }

    return {
        replacedPathCount: selectedPaths.length,
        updatedAnchorCount
    };
}

/**
 * Paste whole-glyph clipboard data as always-new glyphs.
 * Drawings are matched by masterIndex (source station order → target station order).
 * Drawing copies and free drawings are recreated; free drawings whose location axes are missing
 * in the target are skipped with a warning. Variations are attached to
 * the new glyph as AssociatedWithMaster families.
 */
export function applyPasteGlyphsDocument(
    document: PasteGlyphsDocument,
    options: ApplyPasteGlyphsOptions
): ApplyPasteGlyphsResult {
    const empty = (): ApplyPasteGlyphsResult => ({
        ...emptyResult({
            format: 'counterpunch-json',
            paths: [],
            components: [],
            anchors: [],
            guides: [],
            keepAbsoluteCoords: true
        }),
        createdGlyphNames: [],
        warnings: []
    });

    if (!document.glyphs.length) {
        return { ...empty(), error: 'Clipboard has no glyphs to paste.' };
    }

    const targetStations = options.font.stations || [];
    const stationCount = targetStations.length;
    if (stationCount < 1) {
        return {
            ...empty(),
            error: 'Font has no stations to receive whole-glyph paste.'
        };
    }

    if (!document.masters?.length) {
        return {
            ...empty(),
            error: 'Clipboard is missing station metadata. Re-copy with the current Counterpunch / Glyphs script.'
        };
    }

    if (document.masters.length !== stationCount) {
        return {
            ...empty(),
            error: `Clipboard has ${document.masters.length} stations, font has ${stationCount}. Station counts must match.`
        };
    }

    const targetAxisKeys = collectTargetAxisKeys(options.font);
    const aggregate = empty();
    let skippedBraceCount = 0;

    for (const sourceGlyph of document.glyphs) {
        const newName = options.font.allocateUniqueGlyphName(sourceGlyph.name);
        // Prefer the allocated name so trailing .NNN still resolves to the
        // family root via findInsertIndexAfterName's suffix stripping.
        const insertIndex =
            typeof options.font.findInsertIndexAfterName === 'function'
                ? options.font.findInsertIndexAfterName(newName)
                : undefined;
        const targetGlyph = options.font.addGlyph(
            newName,
            'Base',
            insertIndex === undefined ? undefined : { insertIndex }
        );
        if (sourceGlyph.leftMetricsKey) {
            targetGlyph.leftMetricsKey = sourceGlyph.leftMetricsKey;
        }
        if (sourceGlyph.rightMetricsKey) {
            targetGlyph.rightMetricsKey = sourceGlyph.rightMetricsKey;
        }

        const defaultDrawingsByStationIndex = getDefaultDrawingsByStationIndex(
            targetGlyph,
            targetStations
        );
        if (defaultDrawingsByStationIndex.length !== stationCount) {
            return {
                ...aggregate,
                error: `Glyph /${newName}: expected ${stationCount} default drawings, got ${defaultDrawingsByStationIndex.length}.`
            };
        }

        skippedBraceCount += pasteDrawingsOntoGlyph(sourceGlyph.layers, {
            targetGlyph,
            defaultDrawingsByStationIndex,
            targetStations,
            targetAxisKeys,
            glyphExists: options.glyphExists,
            aggregate
        });

        for (const featureVariation of sourceGlyph.featureVariations || []) {
            skippedBraceCount += pasteFeatureVariationOntoGlyph(
                featureVariation,
                {
                    targetGlyph,
                    targetStations,
                    targetAxisKeys,
                    glyphExists: options.glyphExists,
                    aggregate
                }
            );
        }

        aggregate.createdGlyphNames.push(newName);
    }

    if (skippedBraceCount > 0) {
        aggregate.warnings.push(
            `Skipped ${skippedBraceCount} free drawing${
                skippedBraceCount === 1 ? '' : 's'
            } because one or more axis ids are missing in this font.`
        );
    }

    return aggregate;
}

type PasteOntoGlyphContext = {
    targetGlyph: Glyph;
    defaultDrawingsByStationIndex?: Drawing[];
    targetStations: Station[];
    targetAxisKeys: Set<string>;
    glyphExists: (name: string) => boolean;
    aggregate: ApplyPasteGlyphsResult;
};

function pasteDrawingsOntoGlyph(
    sourceDrawings: PasteGlyphDrawing[],
    context: PasteOntoGlyphContext
): number {
    let skippedBraces = 0;
    for (const sourceDrawing of sourceDrawings) {
        const station = sourceDrawing.master;
        if (station.type === 'FreeFloating') {
            continue;
        }

        const stationIndex = station.masterIndex;
        const targetStation = context.targetStations[stationIndex];
        if (!targetStation?.id) {
            continue;
        }

        const location = sourceDrawing.location;
        const hasBraceLocation = !!location && Object.keys(location).length > 0;

        if (station.type === 'DefaultForMaster') {
            const targetDrawing =
                context.defaultDrawingsByStationIndex?.[stationIndex];
            if (!targetDrawing) {
                continue;
            }
            pasteDrawingContent(sourceDrawing, targetDrawing, context);
            continue;
        }

        // AssociatedWithMaster: free drawing or drawing copy
        if (hasBraceLocation) {
            if (!locationAxesExistInTarget(location, context.targetAxisKeys)) {
                skippedBraces += 1;
                continue;
            }
            const width =
                typeof sourceDrawing.width === 'number' &&
                Number.isFinite(sourceDrawing.width)
                    ? sourceDrawing.width
                    : 500;
            const targetDrawing = context.targetGlyph.addDrawing(width, {
                type: 'AssociatedWithMaster',
                master: targetStation.id
            });
            targetDrawing.location = { ...location };
            pasteDrawingContent(sourceDrawing, targetDrawing, context);
            continue;
        }

        const width =
            typeof sourceDrawing.width === 'number' &&
            Number.isFinite(sourceDrawing.width)
                ? sourceDrawing.width
                : 500;
        const targetDrawing = context.targetGlyph.addDrawing(width, {
            type: 'AssociatedWithMaster',
            master: targetStation.id
        });
        pasteDrawingContent(sourceDrawing, targetDrawing, context);
    }
    return skippedBraces;
}

function pasteFeatureVariationOntoGlyph(
    featureVariation: PasteFeatureVariation,
    context: Omit<PasteOntoGlyphContext, 'defaultDrawingsByStationIndex'>
): number {
    let skippedBraces = 0;
    const GLYPHS_ATTR_KEY = 'com.schriftgestalt.Glyphs.attr';

    for (const sourceDrawing of featureVariation.layers) {
        const station = sourceDrawing.master;
        if (station.type === 'FreeFloating') {
            continue;
        }
        const targetStation = context.targetStations[station.masterIndex];
        if (!targetStation?.id) {
            continue;
        }

        const location = sourceDrawing.location;
        const hasBraceLocation = !!location && Object.keys(location).length > 0;
        if (
            hasBraceLocation &&
            !locationAxesExistInTarget(location, context.targetAxisKeys)
        ) {
            skippedBraces += 1;
            continue;
        }

        const width =
            typeof sourceDrawing.width === 'number' &&
            Number.isFinite(sourceDrawing.width)
                ? sourceDrawing.width
                : 500;
        const targetDrawing = context.targetGlyph.addDrawing(width, {
            type: 'AssociatedWithMaster',
            master: targetStation.id
        });
        if (hasBraceLocation) {
            targetDrawing.location = { ...location };
        }
        targetDrawing.format_specific = {
            ...(targetDrawing.format_specific || {}),
            [GLYPHS_ATTR_KEY]: {
                axisRules: featureVariation.axisRules
            }
        };
        pasteDrawingContent(sourceDrawing, targetDrawing, {
            ...context,
            aggregate: context.aggregate
        });
    }
    return skippedBraces;
}

function pasteDrawingContent(
    sourceDrawing: PasteGlyphDrawing,
    targetDrawing: Drawing,
    context: {
        glyphExists: (name: string) => boolean;
        aggregate: ApplyPasteGlyphsResult;
    }
): void {
    const fragment: PasteFragment = {
        format: 'counterpunch-json',
        paths: sourceDrawing.paths,
        components: sourceDrawing.components,
        anchors: sourceDrawing.anchors,
        guides: sourceDrawing.guides,
        keepAbsoluteCoords: true
    };

    for (const path of fragment.paths) {
        appendPathToDrawing(targetDrawing, path);
    }
    context.aggregate.addedPathCount += fragment.paths.length;
    context.aggregate.fragment.paths.push(...fragment.paths);
    context.aggregate.fragment.components.push(...fragment.components);
    context.aggregate.fragment.anchors.push(...fragment.anchors);
    context.aggregate.fragment.guides.push(...fragment.guides);

    applyNonPathObjectsToDrawings(
        fragment,
        [targetDrawing],
        targetDrawing,
        targetDrawing.getStation?.() ?? null,
        context.glyphExists,
        context.aggregate,
        { fanOutAnchors: false }
    );

    if (
        typeof sourceDrawing.width === 'number' &&
        Number.isFinite(sourceDrawing.width)
    ) {
        targetDrawing.width = sourceDrawing.width;
    }
    if (sourceDrawing.leftMetricsKey) {
        targetDrawing.leftMetricsKey = sourceDrawing.leftMetricsKey;
    }
    if (sourceDrawing.rightMetricsKey) {
        targetDrawing.rightMetricsKey = sourceDrawing.rightMetricsKey;
    }
}

function getDefaultDrawingsByStationIndex(
    glyph: Glyph,
    stations: Station[]
): Drawing[] {
    const drawings = (glyph.drawings || []).filter(
        (drawing) => !drawing.is_background
    );
    return stations.map((station) => {
        const match = drawings.find((drawing) => {
            const drawingStation = drawing.station;
            return (
                drawingStation?.type === 'DefaultForMaster' &&
                drawingStation.master === station.id
            );
        });
        return match!;
    });
}

function collectTargetAxisKeys(font: Font): Set<string> {
    const keys = new Set<string>();
    for (const axis of font.axes || []) {
        if (axis.id) {
            keys.add(axis.id);
        }
        if (axis.tag) {
            keys.add(axis.tag);
        }
    }
    return keys;
}

function locationAxesExistInTarget(
    location: Record<string, number>,
    targetAxisKeys: Set<string>
): boolean {
    return Object.keys(location).every((key) => targetAxisKeys.has(key));
}

function applyNonPathObjectsToDrawings(
    working: PasteFragment,
    targetDrawings: Drawing[],
    activeDrawing: Drawing,
    station: Station | null,
    glyphExists: (name: string) => boolean,
    result: ApplyPasteResult,
    options: { fanOutAnchors: boolean; includeAnchorsAndGuides?: boolean }
): void {
    for (const component of working.components) {
        if (!glyphExists(component.reference)) {
            if (!result.skippedComponents.includes(component.reference)) {
                result.skippedComponents.push(component.reference);
            }
            continue;
        }
        const transform = component.transform ?? [
            1,
            0,
            0,
            1,
            component.x,
            component.y
        ];
        for (const drawing of targetDrawings) {
            const added = drawing.addComponent(component.reference, [
                ...transform
            ]);
            if (component.alignment === 1 && !drawing.is_background) {
                added.automaticAlignment = true;
            }
            if (component.anchor) {
                added.anchor = component.anchor;
            }
            if (component.format_specific !== undefined) {
                added.format_specific = component.format_specific;
            }
        }
        result.addedComponentCount += targetDrawings.length;
    }

    if (options.includeAnchorsAndGuides === false) {
        return;
    }

    for (const anchor of working.anchors) {
        const existingOnActive = findAnchorByName(activeDrawing, anchor.name);
        if (existingOnActive) {
            existingOnActive.x = anchor.x;
            existingOnActive.y = anchor.y;
            result.updatedAnchorCount += 1;
            continue;
        }

        if (options.fanOutAnchors) {
            let blocked = false;
            for (const drawing of targetDrawings) {
                if (findAnchorByName(drawing, anchor.name)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                console.warn(
                    `Skipped paste of anchor "${anchor.name}" because it exists on a linked drawing.`
                );
                continue;
            }
            for (const drawing of targetDrawings) {
                const added = drawing.addAnchor(
                    anchor.x,
                    anchor.y,
                    anchor.name
                );
                if (anchor.format_specific !== undefined) {
                    added.format_specific = anchor.format_specific;
                }
            }
            result.addedAnchorCount += 1;
            continue;
        }

        if (findAnchorByName(activeDrawing, anchor.name)) {
            continue;
        }
        const added = activeDrawing.addAnchor(anchor.x, anchor.y, anchor.name);
        if (anchor.format_specific !== undefined) {
            added.format_specific = anchor.format_specific;
        }
        result.addedAnchorCount += 1;
    }

    for (const guide of working.guides) {
        if (guide.global) {
            if (station) {
                const added = station.addGuide(
                    { x: guide.x, y: guide.y, angle: guide.angle },
                    guide.name
                );
                if (guide.format_specific !== undefined) {
                    added.format_specific = guide.format_specific;
                }
                result.addedGuideCount += 1;
            }
            continue;
        }
        for (const drawing of targetDrawings) {
            const added = drawing.addGuide(
                { x: guide.x, y: guide.y, angle: guide.angle },
                guide.name
            );
            if (guide.format_specific !== undefined) {
                added.format_specific = guide.format_specific;
            }
        }
        result.addedGuideCount += 1;
    }
}

function cloneFragment(fragment: PasteFragment): PasteFragment {
    return {
        ...fragment,
        paths: fragment.paths.map((path) => ({
            ...path,
            nodes: path.nodes.map((node) => ({ ...node }))
        })),
        components: fragment.components.map((component) => ({
            ...component,
            ...(component.transform
                ? {
                      transform: [
                          ...component.transform
                      ] as typeof component.transform
                  }
                : {})
        })),
        anchors: fragment.anchors.map((anchor) => ({ ...anchor })),
        guides: fragment.guides.map((guide) => ({ ...guide }))
    };
}

function emptyResult(fragment: PasteFragment): ApplyPasteResult {
    return {
        fragment,
        addedPathCount: 0,
        addedComponentCount: 0,
        addedAnchorCount: 0,
        updatedAnchorCount: 0,
        addedGuideCount: 0,
        skippedComponents: []
    };
}

function appendPathToDrawing(drawing: Drawing, path: PastePath): void {
    const added = drawing.addPath(path.closed);
    added.nodes = path.nodes.map((node) => ({
        x: node.x,
        y: node.y,
        nodetype: node.nodetype as Babelfont.NodeType,
        ...(node.smooth ? { smooth: true } : {})
    }));
    if (path.closed && !added.closed) {
        added.closed = true;
    }
    if (path.format_specific !== undefined) {
        added.format_specific = path.format_specific;
    }
}

function findAnchorByName(drawing: Drawing, name: string) {
    const anchors = drawing.anchors || [];
    for (const anchor of anchors) {
        if (anchor.name === name) {
            return anchor;
        }
    }
    return null;
}

function centerFragmentInDrawing(
    fragment: PasteFragment,
    drawingWidth: number,
    verticalMetrics?: Record<string, number> | null
): PasteFragment {
    const bounds = computeFragmentBounds(fragment);
    if (!bounds) {
        return fragment;
    }

    const highest =
        getHighestVisibleVerticalMetricValue(verticalMetrics) ?? bounds.maxY;
    const lowest = getLowestMetricFallback(verticalMetrics, bounds.minY);
    const targetMidX = (Number.isFinite(drawingWidth) ? drawingWidth : 0) / 2;
    const targetMidY = (highest + lowest) / 2;
    const tx = targetMidX - (bounds.minX + bounds.maxX) / 2;
    const ty = targetMidY - (bounds.minY + bounds.maxY) / 2;

    return translateFragment(fragment, tx, ty);
}

function getLowestMetricFallback(
    verticalMetrics: Record<string, number> | null | undefined,
    fallback: number
): number {
    if (!verticalMetrics) {
        return Math.min(0, fallback);
    }
    const values = Object.entries(verticalMetrics)
        .filter(([key]) => /descender|descent/i.test(key))
        .map(([, value]) => value)
        .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
        return Math.min(...values);
    }
    return Math.min(0, fallback);
}

function placeGuideOrigins(
    fragment: PasteFragment,
    verticalMetrics?: Record<string, number> | null
): PasteFragment {
    const highest = getHighestVisibleVerticalMetricValue(verticalMetrics) ?? 0;
    return {
        ...fragment,
        guides: fragment.guides.map((guide) => placeGuideOrigin(guide, highest))
    };
}

function placeGuideOrigin(
    guide: PasteGuide,
    highestMetricY: number
): PasteGuide {
    const angle = ((guide.angle % 180) + 180) % 180;
    const isHorizontal = Math.abs(angle) < 0.5 || Math.abs(angle - 180) < 0.5;
    const isVertical = Math.abs(angle - 90) < 0.5;
    if (isHorizontal) {
        return { ...guide, x: 0, y: guide.y, angle: 0 };
    }
    if (isVertical) {
        return { ...guide, x: guide.x, y: highestMetricY, angle: 90 };
    }
    return guide;
}

function translateFragment(
    fragment: PasteFragment,
    tx: number,
    ty: number
): PasteFragment {
    return {
        ...fragment,
        paths: fragment.paths.map((path) => ({
            ...path,
            nodes: path.nodes.map((node) => ({
                ...node,
                x: node.x + tx,
                y: node.y + ty
            }))
        })),
        components: fragment.components.map((component) => ({
            ...component,
            x: component.x + tx,
            y: component.y + ty,
            ...(component.transform
                ? {
                      transform: [
                          component.transform[0],
                          component.transform[1],
                          component.transform[2],
                          component.transform[3],
                          component.transform[4] + tx,
                          component.transform[5] + ty
                      ] as [number, number, number, number, number, number]
                  }
                : {})
        })),
        anchors: fragment.anchors.map((anchor) => ({
            ...anchor,
            x: anchor.x + tx,
            y: anchor.y + ty
        })),
        guides: fragment.guides.map((guide) => ({
            ...guide,
            x: guide.x + tx,
            y: guide.y + ty
        }))
    };
}

function computeFragmentBounds(fragment: PasteFragment): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;

    const consider = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        found = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };

    for (const path of fragment.paths) {
        for (const node of path.nodes) {
            consider(node.x, node.y);
        }
    }
    for (const component of fragment.components) {
        consider(component.x, component.y);
    }
    for (const anchor of fragment.anchors) {
        consider(anchor.x, anchor.y);
    }

    if (!found) {
        return null;
    }
    return { minX, minY, maxX, maxY };
}

export function describePasteResult(result: ApplyPasteResult): string {
    if (result.error) {
        return result.error;
    }
    const createdNames = (result as ApplyPasteGlyphsResult).createdGlyphNames;
    const warnings = (result as ApplyPasteGlyphsResult).warnings || [];
    if (createdNames?.length) {
        const base = `Pasted ${createdNames.length} glyph${
            createdNames.length === 1 ? '' : 's'
        }: ${createdNames.map((name) => `/${name}`).join(', ')}`;
        return warnings.length ? `${base}. ${warnings.join(' ')}` : base;
    }
    const parts: string[] = [];
    if (result.fragment.paths.length > 0) {
        parts.push(
            `${result.fragment.paths.length} path${result.fragment.paths.length === 1 ? '' : 's'}`
        );
    }
    if (result.fragment.components.length > 0) {
        const kept =
            result.fragment.components.length - result.skippedComponents.length;
        parts.push(`${kept} component${kept === 1 ? '' : 's'}`);
    }
    if (result.addedAnchorCount > 0 || result.updatedAnchorCount > 0) {
        const count = result.addedAnchorCount + result.updatedAnchorCount;
        parts.push(`${count} anchor${count === 1 ? '' : 's'}`);
    }
    if (result.addedGuideCount > 0) {
        parts.push(
            `${result.addedGuideCount} guide${result.addedGuideCount === 1 ? '' : 's'}`
        );
    }
    const summary = parts.length > 0 ? parts.join(', ') : 'nothing';
    return `Pasted ${summary} from ${result.fragment.format}`;
}
