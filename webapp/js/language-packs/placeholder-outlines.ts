import type { Babelfont } from '../babelfont';
import {
    buildGlyphPathFromNodes,
    normalizeAffineTransform
} from '../glyph-path-geometry';
import { getPathFillOpacity } from '../path-fill-opacity-pref';
import APP_SETTINGS from '../settings';
import type { GlyphDrawing } from './composition-planner';
import { ccmpDecomposition } from './ccmp-shells';

const PLACEHOLDER_RED = '196, 48, 48';

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
    paths?: Array<{ nodes?: Array<{ x: number }> }>;
    anchors?: Array<{ name?: string; x?: number; y?: number }>;
    components?: Array<{
        reference?: string;
        transform?:
            | Babelfont.DecomposedAffine
            | [number, number, number, number, number, number];
    }>;
};

export type PlaceholderEmphasis = 'rest' | 'hover' | 'active';

type PlaceholderPaintOptions = {
    depth?: number;
    emphasis?: PlaceholderEmphasis;
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

function glyphLayer(name: string): FontLayer | null {
    const glyph = fontModel()?.findGlyph?.(name);
    if (!glyph) {
        return null;
    }
    const masterId = (
        window as Window & {
            glyphCanvas?: {
                textRunEditor?: { selectedMasterId?: string | null };
            };
        }
    ).glyphCanvas?.textRunEditor?.selectedMasterId;
    if (masterId && glyph.findLayerByMasterId) {
        const layer = glyph.findLayerByMasterId(masterId);
        if (layer) {
            return layer;
        }
    }
    return glyph.layers?.[0] || null;
}

function glyphHasPathInk(name: string): boolean {
    const layer = glyphLayer(name);
    return (layer?.paths || []).some((path) => (path.nodes?.length || 0) > 0);
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

function modelComponents(name: string): Array<{
    name: string;
    transform: [number, number, number, number, number, number];
}> {
    const layer = glyphLayer(name);
    const components = layer?.components || [];
    return components
        .filter((component) => component.reference)
        .map((component) => ({
            name: component.reference as string,
            transform: normalizeAffineTransform(component.transform)
        }));
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
    const drawing = drawings.get(name);
    if (drawing?.paths?.length) {
        let minX = Infinity;
        let maxX = -Infinity;
        for (const path of drawing.paths) {
            for (const node of path.nodes) {
                minX = Math.min(minX, node.x);
                maxX = Math.max(maxX, node.x);
            }
        }
        if (Number.isFinite(minX) && maxX > minX) {
            const scale = fontUpm() / (drawing.upm || fontUpm());
            return ((minX + maxX) / 2) * scale;
        }
    }
    return width > 0 ? width / 2 : 0;
}

/** ccmp pieces to draw when this glyph has no sample outline of its own. */
export function placeholderCcmpParts(name: string): string[] {
    if (drawings.get(name)?.paths?.length) {
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

function applyPlaceholderInk(
    ctx: CanvasRenderingContext2D,
    emphasis: PlaceholderEmphasis
): void {
    const pixel = screenPixel(ctx);
    const dash = APP_SETTINGS.OUTLINE_EDITOR.SUBTRACTION_OUTLINE_DASH;
    const strokePx =
        emphasis === 'active'
            ? 2
            : APP_SETTINGS.OUTLINE_EDITOR.OUTLINE_STROKE_WIDTH;
    ctx.fillStyle = `rgba(${PLACEHOLDER_RED}, ${placeholderFillAlpha(emphasis)})`;
    ctx.strokeStyle =
        emphasis === 'hover'
            ? `rgba(160, 28, 28, 1)`
            : `rgba(${PLACEHOLDER_RED}, ${emphasis === 'rest' ? 0.85 : 1})`;
    ctx.lineWidth = strokePx * pixel;
    ctx.setLineDash([dash[0] * pixel, dash[1] * pixel]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
}

function paintLeaf(
    ctx: CanvasRenderingContext2D,
    name: string,
    emphasis: PlaceholderEmphasis
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
            applyPlaceholderInk(ctx, emphasis);
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
    applyPlaceholderInk(ctx, emphasis);
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
    const components = modelComponents(name);
    if (components.length) {
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
    paintLeaf(ctx, name, options.emphasis ?? 'rest');
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
