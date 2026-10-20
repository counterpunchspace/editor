import type { Babelfont } from '../babelfont';
import {
    buildGlyphPathFromNodes,
    normalizeAffineTransform,
    setGlyphStandInContours,
    transformPointWithAffine
} from '../glyph-path-geometry';
import { getPathFillOpacity } from '../path-fill-opacity-pref';
import APP_SETTINGS from '../settings';
import type { GlyphDrawing } from './composition-planner';
import { ccmpDecomposition } from './ccmp-shells';

const PLACEHOLDER_FILL = '188, 188, 188';
const PLACEHOLDER_STROKE = '72, 72, 72';
const PLACEHOLDER_STROKE_HOVER = '40, 40, 40';

const drawings = new Map<string, GlyphDrawing>();
const hinted = new Set<string>();
const pending = new Set<string>();
let lookupTimer: ReturnType<typeof setTimeout> | null = null;

type FontModel = {
    upm?: number;
    features?: Parameters<typeof ccmpDecomposition>[0];
    findGlyph?: (name: string) =>
        | {
              codepoints?: number[];
              findLayerByMasterId?: (masterId: string) => FontLayer | null;
              layers?: FontLayer[];
          }
        | null
        | undefined;
};

type FontLayer = {
    master?: { type?: string; master?: string };
    paths?: Array<{ nodes?: Array<{ x: number }> }>;
    anchors?: Array<{ name?: string; x?: number; y?: number }>;
    components?: Array<{
        reference?: string;
        automaticAlignment?: boolean;
        format_specific?: Record<string, number | undefined>;
        transform?:
            | Babelfont.DecomposedAffine
            | [number, number, number, number, number, number];
    }>;
};

const GLYPHS_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

export type PlaceholderContour = {
    nodes: Babelfont.Node[];
    closed: boolean;
};

export type PlaceholderComponentRef = {
    name: string;
    transform: [number, number, number, number, number, number];
    automatic: boolean;
};

export type PlaceholderEmphasis = 'rest' | 'hover' | 'active';
export type PlaceholderAppearance = 'edit' | 'text';

type PlaceholderPaintOptions = {
    depth?: number;
    emphasis?: PlaceholderEmphasis;
    appearance?: PlaceholderAppearance;
    token?: boolean;
    muted?: boolean;
    paintDecomposed?: (parts: string[]) => boolean;
};

function fontModel(): FontModel | null {
    return (
        (window as Window & { currentFontModel?: FontModel })
            .currentFontModel || null
    );
}

function fontUpm(): number {
    const upm = fontModel()?.upm;
    return upm && upm > 0 ? upm : 1000;
}

function glyphLayers(name: string): FontLayer[] {
    return fontModel()?.findGlyph?.(name)?.layers || [];
}

function isMasterLayer(layer: FontLayer): boolean {
    return layer.master?.type === 'DefaultForMaster';
}

/**
 * The master layer for the selected master, else the first master layer.
 * `layers[0]` is only a fallback: Glyphs sources often list an associated
 * or intermediate layer before the master, and that layer can be empty.
 */
function glyphLayer(name: string): FontLayer | null {
    const layers = glyphLayers(name);
    if (!layers.length) {
        return null;
    }
    const masterId = (
        window as Window & {
            glyphCanvas?: {
                textRunEditor?: { selectedMasterId?: string | null };
            };
        }
    ).glyphCanvas?.textRunEditor?.selectedMasterId;
    if (masterId) {
        const selected = layers.find(
            (layer) => isMasterLayer(layer) && layer.master?.master === masterId
        );
        if (selected) {
            return selected;
        }
    }
    return layers.find(isMasterLayer) || layers[0] || null;
}

function layerHasPathNodes(layer: FontLayer | null | undefined): boolean {
    return (layer?.paths || []).some((path) => (path.nodes?.length || 0) > 0);
}

function layerHasComponents(layer: FontLayer | null | undefined): boolean {
    return (layer?.components || []).some((component) => component.reference);
}

function masterLayers(name: string): FontLayer[] {
    const layers = glyphLayers(name);
    const masters = layers.filter(isMasterLayer);
    return masters.length ? masters : layers;
}

/**
 * True when any master layer already has outlines or components.
 * Component names are not compared with a recipe: any reference counts.
 */
function glyphIsComposed(name: string): boolean {
    return masterLayers(name).some(
        (layer) => layerHasPathNodes(layer) || layerHasComponents(layer)
    );
}

function glyphHasPathInk(name: string): boolean {
    return layerHasPathNodes(glyphLayer(name));
}

function codepointOf(name: string): number | null {
    const codepoint = fontModel()?.findGlyph?.(name)?.codepoints?.[0];
    return typeof codepoint === 'number' ? codepoint : null;
}

function isDrawableCodepoint(codepoint: number): boolean {
    if (
        codepoint <= 32 ||
        codepoint === 0x7f ||
        codepoint === 0xa0 ||
        codepoint === 0xfeff
    ) {
        return false;
    }
    if (codepoint >= 0x2000 && codepoint <= 0x200f) {
        return false;
    }
    if (codepoint >= 0x2028 && codepoint <= 0x202f) {
        return false;
    }
    return true;
}

function componentIsAutomatic(component: {
    automaticAlignment?: boolean;
    format_specific?: Record<string, number | undefined>;
}): boolean {
    if (component.automaticAlignment === true) {
        return true;
    }
    return component.format_specific?.[GLYPHS_ALIGNMENT_KEY] === 1;
}

function modelComponents(name: string): PlaceholderComponentRef[] {
    const layer = glyphLayer(name);
    const components = layer?.components || [];
    return components
        .filter((component) => component.reference)
        .map((component) => ({
            name: component.reference as string,
            transform: normalizeAffineTransform(component.transform),
            automatic: componentIsAutomatic(component)
        }));
}

function transformContourNodes(
    nodes: Babelfont.Node[],
    affine: [number, number, number, number, number, number]
): Babelfont.Node[] {
    return nodes.map((node) => {
        const point = transformPointWithAffine(affine, node.x, node.y);
        return { ...node, x: point.x, y: point.y };
    });
}

function scaledDrawingContours(name: string): PlaceholderContour[] {
    const drawing = drawings.get(name);
    if (!drawing?.paths?.length) {
        return [];
    }
    const upm = fontUpm();
    const scale = upm / (drawing.upm || upm || 1000);
    const contours: PlaceholderContour[] = [];
    for (const path of drawing.paths) {
        if (!path.nodes?.length) {
            continue;
        }
        contours.push({
            closed: path.closed !== false,
            nodes: path.nodes.map((node) => ({
                x: node.x * scale,
                y: node.y * scale,
                nodetype: node.nodetype as Babelfont.NodeType,
                ...(node.smooth ? { smooth: true } : {})
            }))
        });
    }
    return contours;
}

/**
 * Outlines for a referenced glyph that has no real path ink.
 * Nested component transforms are baked in. Empty when the glyph
 * has real outlines, or no vector sample is loaded yet.
 */
export function placeholderContoursForReference(
    name: string,
    depth = 0
): PlaceholderContour[] {
    if (!name || name === '.notdef' || depth > 5) {
        return [];
    }
    if (!fontModel()?.findGlyph?.(name) || glyphHasPathInk(name)) {
        return [];
    }
    queuePlaceholderNames([name]);
    const components = modelComponents(name);
    if (components.length) {
        const contours: PlaceholderContour[] = [];
        for (const component of components) {
            const children = placeholderContoursForReference(
                component.name,
                depth + 1
            );
            for (const child of children) {
                contours.push({
                    closed: child.closed,
                    nodes: transformContourNodes(
                        child.nodes,
                        component.transform
                    )
                });
            }
        }
        return contours;
    }
    if (glyphIsComposed(name)) {
        return [];
    }
    return scaledDrawingContours(name);
}

/** Top-level components of a glyph that itself has no path ink. */
export function placeholderComponentRefs(
    name: string
): PlaceholderComponentRef[] {
    if (!name || name === '.notdef' || glyphHasPathInk(name)) {
        return [];
    }
    return modelComponents(name);
}

/** Keep sample drawings for overlay. They are not written onto the glyph. */
export function rememberPlaceholderDrawing(
    name: string,
    drawing: GlyphDrawing | null | undefined
): void {
    if (!name || !drawing) {
        return;
    }
    hinted.add(name);
    if (drawing.paths?.length) {
        drawings.set(name, drawing);
    }
}

export function queuePlaceholderNames(names: readonly string[]): void {
    let added = false;
    for (const name of names) {
        if (
            !name ||
            name === '.notdef' ||
            drawings.has(name) ||
            hinted.has(name) ||
            pending.has(name)
        ) {
            continue;
        }
        pending.add(name);
        added = true;
    }
    if (!added) {
        return;
    }
    if (lookupTimer !== null) {
        clearTimeout(lookupTimer);
    }
    lookupTimer = setTimeout(() => {
        lookupTimer = null;
        void flushPlaceholderLookups();
    }, 40);
}

async function flushPlaceholderLookups(): Promise<void> {
    const names = [...pending];
    pending.clear();
    if (!names.length) {
        return;
    }
    let found: Record<string, GlyphDrawing> = {};
    try {
        const { languagePackManager } = await import('./language-pack-manager');
        found = await languagePackManager.drawings(names);
    } catch {
        found = {};
    }
    for (const name of names) {
        hinted.add(name);
    }
    for (const [name, drawing] of Object.entries(found)) {
        rememberPlaceholderDrawing(name, drawing);
    }
    (
        window as Window & { glyphCanvas?: { render?: () => void } }
    ).glyphCanvas?.render?.();
    window.dispatchEvent(new CustomEvent('placeholderOutlinesReady'));
}

/** Horizontal center for an empty overview tile, in font units. */
export function placeholderCenteringX(name: string, width: number): number {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const contour of placeholderContoursForReference(name)) {
        for (const node of contour.nodes) {
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x);
        }
    }
    if (Number.isFinite(minX) && maxX > minX) {
        return (minX + maxX) / 2;
    }
    return width > 0 ? width / 2 : 0;
}

/** ccmp pieces to draw when this glyph has no sample outline of its own. */
export function placeholderCcmpParts(name: string): string[] {
    if (glyphIsComposed(name) || drawings.get(name)?.paths?.length) {
        return [];
    }
    const parts = ccmpDecomposition(fontModel()?.features).get(name);
    if (!parts || parts.length < 2) {
        return [];
    }
    return parts;
}

/** Screen-pixel size in the context's current font space. */
function screenPixel(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scale = Math.hypot(transform.a, transform.b);
    return scale > 0 ? 1 / scale : 1;
}

/** Outline dash in the context's current user space, so every element matches. */
export function placeholderOutlineDash(
    ctx: CanvasRenderingContext2D
): number[] {
    const pixel = screenPixel(ctx);
    const dash = APP_SETTINGS.OUTLINE_EDITOR.SUBTRACTION_OUTLINE_DASH;
    return [dash[0] * pixel, dash[1] * pixel];
}

function placeholderFillAlpha(emphasis: PlaceholderEmphasis): number {
    const slider = getPathFillOpacity();
    if (emphasis === 'active') {
        return Math.min(0.12, slider + 0.04);
    }
    if (emphasis === 'hover') {
        return Math.min(0.12, slider * 2 + 0.02);
    }
    return slider;
}

function themeIsDark(): boolean {
    return document.documentElement.getAttribute('data-theme') !== 'light';
}

function shiftChannel(value: number, lighten: boolean): number {
    if (lighten) {
        return Math.round(value + (255 - value) * 0.4);
    }
    return Math.round(value * 0.6);
}

function applyPlaceholderInk(
    ctx: CanvasRenderingContext2D,
    emphasis: PlaceholderEmphasis,
    appearance: PlaceholderAppearance,
    token: boolean,
    muted: boolean
): void {
    const pixel = screenPixel(ctx);
    const strokePx =
        emphasis === 'active'
            ? 2
            : APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_STROKE_WIDTH;
    const isDark = themeIsDark();
    if (appearance === 'text') {
        const fill = isDark ? [150, 150, 150] : [176, 176, 176];
        const shifted = token
            ? fill.map((channel) => shiftChannel(channel, !isDark))
            : fill;
        ctx.fillStyle = `rgba(${shifted[0]}, ${shifted[1]}, ${shifted[2]}, ${muted ? 0.4 : 1})`;
        ctx.strokeStyle = isDark
            ? 'rgba(255, 255, 255, 1)'
            : 'rgba(0, 0, 0, 1)';
    } else {
        const stroke =
            emphasis === 'hover'
                ? isDark
                    ? '255, 255, 255'
                    : PLACEHOLDER_STROKE_HOVER
                : isDark
                  ? '230, 230, 230'
                  : PLACEHOLDER_STROKE;
        const strokeAlpha = emphasis === 'rest' ? 0.85 : 1;
        ctx.fillStyle = `rgba(${isDark ? '210, 210, 210' : PLACEHOLDER_FILL}, ${placeholderFillAlpha(emphasis)})`;
        ctx.strokeStyle = `rgba(${stroke}, ${strokeAlpha})`;
    }
    ctx.lineWidth = strokePx * pixel;
    ctx.setLineDash(placeholderOutlineDash(ctx));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
}

function paintLeaf(
    ctx: CanvasRenderingContext2D,
    name: string,
    emphasis: PlaceholderEmphasis,
    appearance: PlaceholderAppearance,
    token: boolean,
    muted: boolean
): void {
    const drawing = drawings.get(name);
    const upm = fontUpm();
    ctx.save();
    if (drawing?.paths?.length) {
        const scale = upm / (drawing.upm || upm || 1000);
        ctx.scale(scale, scale);
        // One compound path so reversed counters punch under the nonzero rule.
        const built = new Path2D();
        let hasContour = false;
        for (const path of drawing.paths) {
            if (!path.nodes?.length) {
                continue;
            }
            buildGlyphPathFromNodes(path.nodes as Babelfont.Node[], built);
            if (path.closed !== false) {
                built.closePath();
            }
            hasContour = true;
        }
        if (hasContour) {
            applyPlaceholderInk(ctx, emphasis, appearance, token, muted);
            ctx.fill(built, 'nonzero');
            ctx.stroke(built);
        }
        ctx.restore();
        return;
    }
    const codepoint = codepointOf(name);
    if (
        codepoint === null ||
        !isDrawableCodepoint(codepoint) ||
        !hinted.has(name)
    ) {
        ctx.restore();
        return;
    }
    ctx.scale(1, -1);
    applyPlaceholderInk(ctx, emphasis, appearance, token, muted);
    ctx.font = `${upm}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const markAnchor = (glyphLayer(name)?.anchors || []).find((anchor) =>
        anchor.name?.startsWith('_')
    );
    const text = String.fromCodePoint(codepoint);
    if (markAnchor && Number.isFinite(markAnchor.x)) {
        ctx.textAlign = 'center';
        ctx.fillText(text, markAnchor.x || 0, 0);
        ctx.strokeText(text, markAnchor.x || 0, 0);
    } else {
        ctx.fillText(text, 0, 0);
        ctx.strokeText(text, 0, 0);
    }
    ctx.restore();
}

/** Faint sample outline or CSS character. Nothing here is part of the font. */
export function paintPlaceholderGlyph(
    ctx: CanvasRenderingContext2D,
    name: string,
    options: PlaceholderPaintOptions = {}
): void {
    const depth = options.depth ?? 0;
    if (!name || name === '.notdef' || depth > 5) {
        return;
    }
    if (!fontModel()?.findGlyph?.(name) || glyphHasPathInk(name)) {
        return;
    }
    queuePlaceholderNames([name]);
    const appearance = options.appearance ?? 'edit';
    const emphasis = options.emphasis ?? 'rest';
    const token = options.token === true;
    const muted = options.muted === true;
    const components = modelComponents(name);
    // Text mode paints a composite with the same dashed sample as a leaf.
    // Edit mode draws those components through the component pipeline.
    if (components.length) {
        if (appearance !== 'text') {
            return;
        }
        for (const component of components) {
            ctx.save();
            ctx.transform(
                component.transform[0],
                component.transform[1],
                component.transform[2],
                component.transform[3],
                component.transform[4],
                component.transform[5]
            );
            paintPlaceholderGlyph(ctx, component.name, {
                ...options,
                depth: depth + 1
            });
            ctx.restore();
        }
        return;
    }
    if (depth === 0) {
        const parts = placeholderCcmpParts(name);
        if (parts.length > 1 && options.paintDecomposed?.(parts)) {
            return;
        }
    }
    if (glyphIsComposed(name)) {
        return;
    }
    paintLeaf(ctx, name, emphasis, appearance, token, muted);
}

/**
 * Sample outline in font units, with component transforms included.
 * Null when this glyph has real ink, or no vector sample is loaded yet.
 */
export function buildPlaceholderPath(name: string, depth = 0): Path2D | null {
    if (!name || name === '.notdef' || depth > 5) {
        return null;
    }
    if (!fontModel()?.findGlyph?.(name) || glyphHasPathInk(name)) {
        return null;
    }
    const components = modelComponents(name);
    if (components.length) {
        const built = new Path2D();
        let hasChild = false;
        for (const component of components) {
            const child = buildPlaceholderPath(component.name, depth + 1);
            if (!child) {
                continue;
            }
            const transform = component.transform;
            built.addPath(
                child,
                new DOMMatrix([
                    transform[0],
                    transform[1],
                    transform[2],
                    transform[3],
                    transform[4],
                    transform[5]
                ])
            );
            hasChild = true;
        }
        return hasChild ? built : null;
    }
    if (glyphIsComposed(name)) {
        return null;
    }
    const drawing = drawings.get(name);
    if (!drawing?.paths?.length) {
        return null;
    }
    const upm = fontUpm();
    const scale = upm / (drawing.upm || upm || 1000);
    const built = new Path2D();
    let hasContour = false;
    for (const path of drawing.paths) {
        if (!path.nodes?.length) {
            continue;
        }
        const contour = new Path2D();
        buildGlyphPathFromNodes(path.nodes as Babelfont.Node[], contour);
        if (path.closed !== false) {
            contour.closePath();
        }
        built.addPath(contour, new DOMMatrix([scale, 0, 0, scale, 0, 0]));
        hasContour = true;
    }
    return hasContour ? built : null;
}

/** True when a vector sample outline can be hit, including ccmp pieces. */
export function placeholderHasVectorOutline(name: string, depth = 0): boolean {
    if (!name || name === '.notdef' || depth > 5) {
        return false;
    }
    if (buildPlaceholderPath(name)) {
        return true;
    }
    return placeholderCcmpParts(name).some(
        (part) => part !== name && placeholderHasVectorOutline(part, depth + 1)
    );
}

setGlyphStandInContours(placeholderContoursForReference);
