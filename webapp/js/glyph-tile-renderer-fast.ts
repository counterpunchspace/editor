// Fast Glyph Tile Renderer
// Renders glyph outlines directly to canvas elements without data URL conversion
// Uses a shared offscreen canvas for path building, then draws to target canvases

import type { Babelfont } from './babelfont';
import { pathHasSubtractionFlag } from './path-boolean-flag';
import {
    fillPunchFillContoursOnContext,
    type PunchFillContour
} from './punch-fill-contours';
import {
    buildGlyphPathFromNodes,
    calculateGlyphShapeBounds,
    multiplyAffineTransforms,
    normalizeAffineTransform,
    transformPointWithAffine
} from './glyph-path-geometry';
import { Logger } from './logger';
import {
    paintPlaceholderGlyph,
    placeholderCenteringX,
    placeholderComponentRefs,
    placeholderContoursForReference,
    placeholderOutlineDash
} from './skills/placeholder-outlines';
import APP_SETTINGS from './settings';

const console = new Logger('GlyphTileRendererFast');

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

interface RenderMetrics {
    ascender: number;
    descender: number;
    upm: number;
}

interface GlyphOutlineData {
    name: string;
    width: number;
    shapes?: any[];
    bounds?: {
        xMin: number;
        yMin: number;
        xMax: number;
        yMax: number;
    };
}

export interface CompiledTileContour {
    path: Path2D | null;
    nodes?: Babelfont.Node[];
    subtract: boolean;
    fillKind: 'path' | 'auto' | 'manual';
}

export interface CompiledTileGlyph {
    __compiledTileGlyph: true;
    name: string;
    width: number;
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
    hasComponents: boolean;
    hasSubtraction: boolean;
    hasEmptyComponent: boolean;
    contours: CompiledTileContour[];
    /** Preserves test/diagnostic metadata if attached to raw outline payloads. */
    at?: unknown;
    outline?: unknown;
}

export interface OverviewFrameMetrics {
    dpr: number;
    scale: number;
    offsetY: number;
    pathColor: string;
    autoComponentColor: string;
    manualComponentColor: string;
    lastFillStyle: string;
}

const OVERVIEW_CMD_MOVE_TO = 0;
const OVERVIEW_CMD_LINE_TO = 1;
const OVERVIEW_CMD_QUAD_TO = 2;
const OVERVIEW_CMD_CURVE_TO = 3;
const OVERVIEW_CMD_CLOSE_PATH = 4;

const OVERVIEW_GLYPH_FLAG_HAS_COMPONENTS = 1;
const OVERVIEW_GLYPH_FLAG_HAS_SUBTRACTION = 2;
const OVERVIEW_GLYPH_FLAG_HAS_EMPTY_COMPONENT = 4;
const OVERVIEW_RUN_SUBTRACT_BIT = 4;

const overviewNameDecoder =
    typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function decodeUtf8Slice(
    bytes: Uint8Array,
    start: number,
    length: number
): string {
    if (overviewNameDecoder) {
        return overviewNameDecoder.decode(
            bytes.subarray(start, start + length)
        );
    }
    let out = '';
    for (let i = 0; i < length; i++) {
        out += String.fromCharCode(bytes[start + i]);
    }
    return out;
}

/**
 * Decode a compact binary overview outline packet produced by Rust
 * `get_glyphs_overview_binary` directly into `CompiledTileGlyph` + `Path2D`,
 * with zero JSON parsing and zero intermediate node objects.
 */
export function decodeOverviewBinaryOutlines(
    buffer: ArrayBuffer,
    byteOffset: number = 0,
    byteLength: number = buffer.byteLength - byteOffset
): CompiledTileGlyph[] {
    const view = new DataView(buffer, byteOffset, byteLength);
    const bytes = new Uint8Array(buffer, byteOffset, byteLength);
    if (byteLength < 4) {
        return [];
    }
    const hasPath2D = typeof Path2D !== 'undefined';
    const glyphCount = view.getUint32(0, true);
    let pos = 4;
    const results: CompiledTileGlyph[] = new Array(glyphCount);

    for (let g = 0; g < glyphCount; g++) {
        const nameLen = view.getUint16(pos, true);
        pos += 2;
        const name = decodeUtf8Slice(bytes, pos, nameLen);
        pos += nameLen;

        const width = view.getFloat32(pos, true);
        const xMin = view.getFloat32(pos + 4, true);
        const yMin = view.getFloat32(pos + 8, true);
        const xMax = view.getFloat32(pos + 12, true);
        const yMax = view.getFloat32(pos + 16, true);
        pos += 20;

        const flags = bytes[pos++];
        const runCount = view.getUint16(pos, true);
        pos += 2;

        const contours: CompiledTileContour[] = new Array(runCount);
        for (let r = 0; r < runCount; r++) {
            const runFlags = bytes[pos++];
            const cmdLen = view.getUint32(pos, true);
            pos += 4;
            const cmdEnd = pos + cmdLen;
            const fillBits = runFlags & 0b11;
            const fillKind: 'path' | 'auto' | 'manual' =
                fillBits === 1 ? 'auto' : fillBits === 2 ? 'manual' : 'path';
            const subtract = (runFlags & OVERVIEW_RUN_SUBTRACT_BIT) !== 0;

            let path: Path2D | null = null;
            if (hasPath2D) {
                path = new Path2D();
                let p = pos;
                while (p < cmdEnd) {
                    const cmd = bytes[p++];
                    if (cmd === OVERVIEW_CMD_MOVE_TO) {
                        path.moveTo(
                            view.getFloat32(p, true),
                            view.getFloat32(p + 4, true)
                        );
                        p += 8;
                    } else if (cmd === OVERVIEW_CMD_LINE_TO) {
                        path.lineTo(
                            view.getFloat32(p, true),
                            view.getFloat32(p + 4, true)
                        );
                        p += 8;
                    } else if (cmd === OVERVIEW_CMD_QUAD_TO) {
                        path.quadraticCurveTo(
                            view.getFloat32(p, true),
                            view.getFloat32(p + 4, true),
                            view.getFloat32(p + 8, true),
                            view.getFloat32(p + 12, true)
                        );
                        p += 16;
                    } else if (cmd === OVERVIEW_CMD_CURVE_TO) {
                        path.bezierCurveTo(
                            view.getFloat32(p, true),
                            view.getFloat32(p + 4, true),
                            view.getFloat32(p + 8, true),
                            view.getFloat32(p + 12, true),
                            view.getFloat32(p + 16, true),
                            view.getFloat32(p + 20, true)
                        );
                        p += 24;
                    } else if (cmd === OVERVIEW_CMD_CLOSE_PATH) {
                        path.closePath();
                    }
                }
            }
            pos = cmdEnd;

            contours[r] = {
                path,
                subtract,
                fillKind
            };
        }

        results[g] = {
            __compiledTileGlyph: true,
            name,
            width,
            xMin,
            yMin,
            xMax,
            yMax,
            hasComponents: (flags & OVERVIEW_GLYPH_FLAG_HAS_COMPONENTS) !== 0,
            hasSubtraction: (flags & OVERVIEW_GLYPH_FLAG_HAS_SUBTRACTION) !== 0,
            hasEmptyComponent:
                (flags & OVERVIEW_GLYPH_FLAG_HAS_EMPTY_COMPONENT) !== 0,
            contours
        };
    }

    return results;
}

export function isCompiledTileGlyph(
    value: unknown
): value is CompiledTileGlyph {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { __compiledTileGlyph?: unknown }).__compiledTileGlyph ===
            true
    );
}

function isIdentityAffine(affine: number[]): boolean {
    return (
        affine[0] === 1 &&
        affine[1] === 0 &&
        affine[2] === 0 &&
        affine[3] === 1 &&
        affine[4] === 0 &&
        affine[5] === 0
    );
}

function transformOutlineNodes(nodes: any[], affine: number[]): any[] {
    if (isIdentityAffine(affine)) {
        return nodes;
    }
    return nodes.map((node) => {
        const point = transformPointWithAffine(affine, node.x, node.y);
        return { ...node, x: point.x, y: point.y };
    });
}

function pathIsClosed(shape: any, data: any): boolean {
    if (data && 'closed' in data) {
        return Boolean(data.closed);
    }
    if (shape && 'closed' in shape) {
        return Boolean(shape.closed);
    }
    return true;
}

function shapesIncludeComponent(
    shapes: Array<{ reference?: string; Component?: object } | null>
): boolean {
    return shapes.some(
        (shape) =>
            !!shape &&
            typeof shape === 'object' &&
            ('reference' in shape || 'Component' in shape)
    );
}

function pathIsSubtraction(shape: any, data: any): boolean {
    return (
        pathHasSubtractionFlag(data?.format_specific) ||
        pathHasSubtractionFlag(shape?.format_specific)
    );
}

/**
 * Flatten paths and nested components in shape order for overview punch-out.
 */
export function collectOverviewPunchFillContours(
    shapes: any[] | undefined,
    affine: number[],
    fillStyle: string,
    componentFillFor?: (component: any) => string
): PunchFillContour[] {
    const contours: PunchFillContour[] = [];
    if (!Array.isArray(shapes)) {
        return contours;
    }
    for (const shape of shapes) {
        if (!shape || typeof shape !== 'object') {
            continue;
        }
        if ('reference' in shape || 'Component' in shape) {
            const inner =
                shape.Component && typeof shape.Component === 'object'
                    ? shape.Component
                    : shape;
            const childAffine = multiplyAffineTransforms(
                affine,
                normalizeAffineTransform(inner.transform)
            );
            const childFill = componentFillFor
                ? componentFillFor(inner)
                : fillStyle;
            const nested = collectOverviewPunchFillContours(
                inner.layerData?.shapes,
                childAffine,
                childFill
            );
            if (nested.length) {
                contours.push(...nested);
                continue;
            }
            const reference =
                typeof inner.reference === 'string' ? inner.reference : '';
            for (const leaf of placeholderContoursForReference(reference)) {
                if (!leaf.closed || !leaf.nodes.length) {
                    continue;
                }
                contours.push({
                    nodes: transformOutlineNodes(leaf.nodes, childAffine),
                    subtract: false,
                    fillStyle: childFill
                });
            }
            continue;
        }
        const data =
            shape.Path && typeof shape.Path === 'object'
                ? shape.Path
                : shape.Contour && typeof shape.Contour === 'object'
                  ? shape.Contour
                  : shape;
        if (!pathIsClosed(shape, data)) {
            continue;
        }
        const nodes = data.nodes;
        if (!nodes?.length) {
            continue;
        }
        contours.push({
            nodes: transformOutlineNodes(nodes, affine),
            subtract: pathIsSubtraction(shape, data),
            fillStyle
        });
    }
    return contours;
}

class FastGlyphTileRenderer {
    private autoComponentColor: string = '';
    private manualComponentColor: string = '';
    private pathColor: string = '';
    private colorsInitialized: boolean = false;
    private tilePunchScratch: HTMLCanvasElement | null = null;

    constructor() {
        // Colors will be initialized lazily on first render
    }

    /**
     * Update cached theme colors from settings
     */
    public updateThemeColors(): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const overviewColors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_LIGHT;
        const fills = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS;
        this.autoComponentColor = fills.AUTO_NORMAL;
        this.manualComponentColor = fills.MANUAL_NORMAL;
        this.pathColor = overviewColors.PATH;
        this.colorsInitialized = true;
    }

    /**
     * Ensure colors are initialized before rendering
     */
    private ensureColorsInitialized(): void {
        if (
            !this.colorsInitialized ||
            !this.autoComponentColor ||
            !this.manualComponentColor ||
            !this.pathColor
        ) {
            this.updateThemeColors();
        }
    }

    private toFiniteNumber(value: unknown, fallback: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return value;
    }

    private getSafeBounds(glyphData: GlyphOutlineData): {
        xMin: number;
        xMax: number;
    } {
        const computedBounds = this.getVisualBoundsFromShapes(
            Array.isArray(glyphData?.shapes) ? glyphData.shapes : []
        );
        if (computedBounds) {
            return {
                xMin: computedBounds.xMin,
                xMax: computedBounds.xMax
            };
        }

        const bounds = glyphData?.bounds;
        if (!bounds || typeof bounds !== 'object') {
            return { xMin: 0, xMax: 0 };
        }

        const xMin = this.toFiniteNumber((bounds as any).xMin, 0);
        const xMax = this.toFiniteNumber((bounds as any).xMax, xMin);
        if (xMax < xMin) {
            return { xMin: xMax, xMax: xMin };
        }

        return { xMin, xMax };
    }

    private getVisualBoundsFromShapes(
        shapes: any[],
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): {
        xMin: number;
        xMax: number;
        yMin: number;
        yMax: number;
    } | null {
        const bounds = calculateGlyphShapeBounds(shapes, parentTransform);
        if (!bounds) {
            return null;
        }

        return {
            xMin: bounds.minX,
            xMax: bounds.maxX,
            yMin: bounds.minY,
            yMax: bounds.maxY
        };
    }

    /**
     * Render a glyph directly to a canvas element
     * Reuses existing canvas if provided, creates new one otherwise
     */
    public renderToCanvas(
        glyphData: GlyphOutlineData,
        metrics: RenderMetrics | undefined,
        width: number,
        height: number,
        existingCanvas?: HTMLCanvasElement,
        options?: { fill?: string; sample?: boolean }
    ): HTMLCanvasElement {
        this.ensureColorsInitialized();

        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(width * dpr);
        const canvasHeight = Math.round(height * dpr);

        // Reuse existing canvas or create new one
        const canvas = existingCanvas || document.createElement('canvas');

        // Only resize if dimensions changed
        if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) {
            return canvas;
        }

        // Clear and reset transform
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Scale for hi-dpi
        ctx.scale(dpr, dpr);

        // Overview tiles keep a label band and draw smaller. Sample tiles
        // fill the square and use the caller's ink.
        const labelHeight = options?.sample ? 0 : Math.max(8, height * 0.16);
        const drawHeight = height - labelHeight;
        const drawWidth = width;
        const padding = 2;

        // Use provided metrics or calculate defaults
        const upm = metrics?.upm || 1000;
        const ascender = metrics?.ascender ?? upm * 0.75;
        const descender = metrics?.descender ?? -(upm * 0.25);
        const metricsHeight = ascender - descender;

        if (metricsHeight === 0) {
            return canvas;
        }

        // Scale to fit metrics height in drawing area (0.7 factor to draw 30% smaller)
        const scale =
            ((drawHeight - padding * 2) / metricsHeight) *
            (options?.sample ? 1 : 0.7);
        if (!Number.isFinite(scale) || scale <= 0) {
            return canvas;
        }

        // Center horizontally based on glyph visual bounds. Empty glyphs
        // have no ink yet, so center the placeholder on its sample or advance.
        const bounds = this.getSafeBounds(glyphData);
        const degenerate = bounds.xMax - bounds.xMin < 1;
        const glyphVisualCenterX = degenerate
            ? placeholderCenteringX(glyphData.name, glyphData.width || 0)
            : (bounds.xMin + bounds.xMax) / 2;
        const tileCenterX = drawWidth / 2;
        const offsetX = tileCenterX - glyphVisualCenterX * scale;

        // Y offset: position so ascender is at top of drawing area, shifted down 20% of tile height
        const offsetY =
            padding + ascender * scale + (options?.sample ? 0 : height * 0.2);

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, -scale); // Flip Y axis

        // Draw shapes in layer order so subtraction cutters punch holes.
        const shapes = Array.isArray(glyphData?.shapes) ? glyphData.shapes : [];
        this.drawShapes(ctx, shapes, options?.fill);
        if (!options?.sample) {
            let paintedLeaf = false;
            if (glyphData.name && !shapesIncludeComponent(shapes)) {
                if (!this.paintModelComponents(ctx, glyphData.name)) {
                    paintPlaceholderGlyph(ctx, glyphData.name);
                    paintedLeaf = true;
                }
            }
            if (glyphData.name && !paintedLeaf) {
                const stroked = this.strokePlaceholderContours(
                    ctx,
                    glyphData.name
                );
                if (!stroked) {
                    paintPlaceholderGlyph(ctx, glyphData.name, {
                        appearance: 'text'
                    });
                }
            }
        }

        ctx.restore();

        return canvas;
    }

    public createFrameMetrics(
        metrics: RenderMetrics | undefined,
        height: number,
        dpr: number
    ): OverviewFrameMetrics | null {
        this.ensureColorsInitialized();
        if (height <= 0) {
            return null;
        }
        const labelHeight = Math.max(8, height * 0.16);
        const drawHeight = height - labelHeight;
        const padding = 2;

        const upm = metrics?.upm || 1000;
        const ascender = metrics?.ascender ?? upm * 0.75;
        const descender = metrics?.descender ?? -(upm * 0.25);
        const metricsHeight = ascender - descender;
        if (metricsHeight === 0) {
            return null;
        }

        const scale = ((drawHeight - padding * 2) / metricsHeight) * 0.7;
        if (!Number.isFinite(scale) || scale <= 0) {
            return null;
        }

        const offsetY = padding + ascender * scale + height * 0.2;
        return {
            dpr,
            scale,
            offsetY,
            pathColor: this.pathColor,
            autoComponentColor: this.autoComponentColor,
            manualComponentColor: this.manualComponentColor,
            lastFillStyle: ''
        };
    }

    /**
     * Compile raw outline JSON once into a compact Path2D-backed structure so
     * raw node arrays / nested component layerData can be garbage-collected.
     */
    public compileGlyphOutline(
        glyphData: GlyphOutlineData | CompiledTileGlyph
    ): CompiledTileGlyph {
        if (isCompiledTileGlyph(glyphData)) {
            return glyphData;
        }
        const shapes = Array.isArray(glyphData?.shapes) ? glyphData.shapes : [];
        const visualBounds = this.getVisualBoundsFromShapes(shapes);
        const bounds = visualBounds
            ? {
                  xMin: visualBounds.xMin,
                  yMin: visualBounds.yMin,
                  xMax: visualBounds.xMax,
                  yMax: visualBounds.yMax
              }
            : (() => {
                  const safe = this.getSafeBounds(glyphData);
                  const rawB = glyphData?.bounds;
                  return {
                      xMin: safe.xMin,
                      yMin: this.toFiniteNumber(rawB?.yMin, 0),
                      xMax: safe.xMax,
                      yMax: this.toFiniteNumber(rawB?.yMax, 0)
                  };
              })();
        const hasComponents = shapesIncludeComponent(shapes);
        const rawContours = collectOverviewPunchFillContours(
            shapes,
            [1, 0, 0, 1, 0, 0],
            'path',
            (component) =>
                this.isAutomaticallyAlignedComponent(component)
                    ? 'auto'
                    : 'manual'
        );
        const hasPath2D = typeof Path2D !== 'undefined';
        let hasSubtraction = false;
        const contours: CompiledTileContour[] = [];
        for (const contour of rawContours) {
            if (contour.subtract) {
                hasSubtraction = true;
            }
            const fillKind: 'path' | 'auto' | 'manual' =
                contour.fillStyle === 'auto'
                    ? 'auto'
                    : contour.fillStyle === 'manual'
                      ? 'manual'
                      : 'path';
            const last = contours[contours.length - 1];
            // Merge consecutive non-subtracting contours of the same fillKind into one Path2D
            if (
                hasPath2D &&
                !contour.subtract &&
                last &&
                !last.subtract &&
                last.fillKind === fillKind &&
                last.path
            ) {
                buildGlyphPathFromNodes(
                    contour.nodes as Babelfont.Node[],
                    last.path
                );
                last.path.closePath();
                continue;
            }
            let path: Path2D | null = null;
            if (hasPath2D) {
                path = new Path2D();
                buildGlyphPathFromNodes(
                    contour.nodes as Babelfont.Node[],
                    path
                );
                path.closePath();
            }
            contours.push({
                path,
                nodes: hasPath2D
                    ? undefined
                    : (contour.nodes as Babelfont.Node[]),
                subtract: contour.subtract,
                fillKind
            });
        }

        const compiled: CompiledTileGlyph = {
            __compiledTileGlyph: true,
            name: glyphData?.name ?? '',
            width: this.toFiniteNumber(glyphData?.width, 0),
            xMin: bounds.xMin,
            yMin: bounds.yMin,
            xMax: bounds.xMax,
            yMax: bounds.yMax,
            hasComponents,
            hasSubtraction,
            hasEmptyComponent: hasComponents && contours.length === 0,
            contours
        };
        const extra = glyphData as unknown as Record<string, unknown>;
        if ('at' in extra) {
            compiled.at = extra.at;
        }
        if ('outline' in extra) {
            compiled.outline = extra.outline;
        }
        return compiled;
    }

    /**
     * Draw a compiled glyph directly onto a shared viewport Canvas2D at CSS
     * coordinates (x, y, width, height). ctx must already be scaled by dpr
     * (or pass frameMetrics for the zero-save/zero-clip fast path).
     */
    public renderCompiledToContext(
        ctx: CanvasRenderingContext2D,
        compiled: CompiledTileGlyph,
        metrics: RenderMetrics | undefined,
        x: number,
        y: number,
        width: number,
        height: number,
        options?: {
            alpha?: number;
            dpr?: number;
            frameMetrics?: OverviewFrameMetrics;
        }
    ): void {
        if (width <= 0 || height <= 0) {
            return;
        }

        const fm =
            options?.frameMetrics ??
            this.createFrameMetrics(
                metrics,
                height,
                options?.dpr ?? window.devicePixelRatio ?? 1
            );
        if (!fm) {
            return;
        }

        const { dpr, scale, offsetY } = fm;
        const degenerate = compiled.xMax - compiled.xMin < 1;
        const glyphVisualCenterX = degenerate
            ? placeholderCenteringX(compiled.name, compiled.width || 0)
            : (compiled.xMin + compiled.xMax) / 2;
        const offsetX = width / 2 - glyphVisualCenterX * scale;

        const alpha = options?.alpha ?? 1;
        const hasContours = compiled.contours.length > 0;
        const skipPlaceholders = hasContours && !compiled.hasEmptyComponent;

        // Check whether the glyph ink stays inside the tile box so we can skip
        // expensive save() + beginPath() + rect() + clip() + restore().
        const leftPx = offsetX + compiled.xMin * scale;
        const rightPx = offsetX + compiled.xMax * scale;
        const topPx = offsetY - compiled.yMax * scale;
        const bottomPx = offsetY - compiled.yMin * scale;
        const fitsInTile =
            !degenerate &&
            leftPx >= 0 &&
            rightPx <= width &&
            topPx >= 0 &&
            bottomPx <= height;

        // Ultra-fast path: no subtraction, full opacity, fits in tile, has contours
        if (
            !compiled.hasSubtraction &&
            alpha === 1 &&
            fitsInTile &&
            skipPlaceholders
        ) {
            const s = dpr * scale;
            ctx.setTransform(
                s,
                0,
                0,
                -s,
                dpr * (x + offsetX),
                dpr * (y + offsetY)
            );
            const contours = compiled.contours;
            for (let i = 0; i < contours.length; i++) {
                const contour = contours[i];
                const fill =
                    contour.fillKind === 'auto'
                        ? fm.autoComponentColor
                        : contour.fillKind === 'manual'
                          ? fm.manualComponentColor
                          : fm.pathColor;
                if (fm.lastFillStyle !== fill) {
                    ctx.fillStyle = fill;
                    fm.lastFillStyle = fill;
                }
                if (contour.path) {
                    ctx.fill(contour.path);
                } else if (contour.nodes) {
                    ctx.beginPath();
                    buildGlyphPathFromNodes(contour.nodes, ctx);
                    ctx.closePath();
                    ctx.fill();
                }
            }
            return;
        }

        const fillForKind = (kind: 'path' | 'auto' | 'manual'): string =>
            kind === 'auto'
                ? fm.autoComponentColor
                : kind === 'manual'
                  ? fm.manualComponentColor
                  : fm.pathColor;

        const drawInto = (targetCtx: CanvasRenderingContext2D): void => {
            targetCtx.save();
            targetCtx.translate(offsetX, offsetY);
            targetCtx.scale(scale, -scale);

            for (const contour of compiled.contours) {
                if (contour.subtract) {
                    targetCtx.save();
                    targetCtx.globalCompositeOperation = 'destination-out';
                    targetCtx.fillStyle = '#000';
                    if (contour.path) {
                        targetCtx.fill(contour.path);
                    } else if (contour.nodes) {
                        targetCtx.beginPath();
                        buildGlyphPathFromNodes(contour.nodes, targetCtx);
                        targetCtx.closePath();
                        targetCtx.fill();
                    }
                    targetCtx.restore();
                } else {
                    targetCtx.fillStyle = fillForKind(contour.fillKind);
                    if (contour.path) {
                        targetCtx.fill(contour.path);
                    } else if (contour.nodes) {
                        targetCtx.beginPath();
                        buildGlyphPathFromNodes(contour.nodes, targetCtx);
                        targetCtx.closePath();
                        targetCtx.fill();
                    }
                }
            }

            if (!skipPlaceholders) {
                let paintedLeaf = false;
                if (compiled.name && !compiled.hasComponents) {
                    if (!this.paintModelComponents(targetCtx, compiled.name)) {
                        paintPlaceholderGlyph(targetCtx, compiled.name);
                        paintedLeaf = true;
                    }
                }
                if (compiled.name && !paintedLeaf) {
                    const stroked = this.strokePlaceholderContours(
                        targetCtx,
                        compiled.name
                    );
                    if (!stroked) {
                        paintPlaceholderGlyph(targetCtx, compiled.name, {
                            appearance: 'text'
                        });
                    }
                }
            }

            targetCtx.restore();
        };

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        if (alpha !== 1) {
            ctx.globalAlpha *= alpha;
        }
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();

        if (compiled.hasSubtraction) {
            // Isolate destination-out to a tiny single-tile scratch canvas
            // so subtraction cutters never erase neighboring tiles.
            const sw = Math.max(1, Math.round(width * dpr));
            const sh = Math.max(1, Math.round(height * dpr));
            if (!this.tilePunchScratch) {
                this.tilePunchScratch = document.createElement('canvas');
            }
            const scratch = this.tilePunchScratch;
            if (scratch.width !== sw || scratch.height !== sh) {
                scratch.width = sw;
                scratch.height = sh;
            }
            const sctx = scratch.getContext('2d', { alpha: true });
            if (sctx) {
                sctx.setTransform(1, 0, 0, 1, 0, 0);
                sctx.clearRect(0, 0, sw, sh);
                sctx.scale(dpr, dpr);
                drawInto(sctx);
                ctx.drawImage(scratch, 0, 0, sw, sh, x, y, width, height);
            }
        } else {
            ctx.translate(x, y);
            drawInto(ctx);
        }

        ctx.restore();
        fm.lastFillStyle = '';
    }

    public releaseTilePunchScratch(): void {
        if (this.tilePunchScratch) {
            this.tilePunchScratch.width = 0;
            this.tilePunchScratch.height = 0;
        }
    }

    /**
     * Dashed outline over sample contours that stand in for an empty base.
     */
    private strokePlaceholderContours(
        ctx: CanvasRenderingContext2D,
        name: string
    ): boolean {
        const contours = placeholderContoursForReference(name);
        if (!contours.length) {
            return false;
        }
        const path = new Path2D();
        let hasContour = false;
        for (const contour of contours) {
            if (!contour.nodes.length) {
                continue;
            }
            buildGlyphPathFromNodes(contour.nodes, path);
            if (contour.closed) {
                path.closePath();
            }
            hasContour = true;
        }
        if (!hasContour) {
            return false;
        }
        const isDark =
            document.documentElement.getAttribute('data-theme') !== 'light';
        ctx.save();
        ctx.strokeStyle = isDark
            ? 'rgba(230, 230, 230, 0.95)'
            : 'rgba(60, 60, 60, 0.95)';
        const dash = placeholderOutlineDash(ctx);
        ctx.lineWidth =
            dash[0] / APP_SETTINGS.OUTLINE_EDITOR.SUBTRACTION_OUTLINE_DASH[0];
        ctx.setLineDash(dash);
        ctx.lineJoin = 'round';
        ctx.stroke(path);
        ctx.restore();
        return true;
    }

    /**
     * Component fill for a composite whose tile payload has no component shapes.
     * Sample contours stand in for a referenced glyph that has no outlines.
     */
    private paintModelComponents(
        ctx: CanvasRenderingContext2D,
        name: string
    ): boolean {
        const refs = placeholderComponentRefs(name);
        if (!refs.length) {
            return false;
        }
        const contours: PunchFillContour[] = [];
        for (const component of refs) {
            const fillStyle = component.automatic
                ? this.autoComponentColor
                : this.manualComponentColor;
            for (const leaf of placeholderContoursForReference(
                component.name
            )) {
                if (!leaf.closed || !leaf.nodes.length) {
                    continue;
                }
                contours.push({
                    nodes: transformOutlineNodes(
                        leaf.nodes,
                        component.transform
                    ),
                    subtract: false,
                    fillStyle
                });
            }
        }
        if (contours.length) {
            fillPunchFillContoursOnContext(ctx, contours, (target, nodes) => {
                buildGlyphPathFromNodes(nodes as Babelfont.Node[], target);
                target.closePath();
            });
        }
        return true;
    }

    /**
     * Draw paths and components in shape order, punching subtraction cutters.
     */
    private drawShapes(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        fill?: string
    ): void {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return;
        }

        const pathFill = fill || this.pathColor;
        const contours = collectOverviewPunchFillContours(
            shapes,
            [1, 0, 0, 1, 0, 0],
            pathFill,
            fill
                ? () => pathFill
                : (component) =>
                      this.isAutomaticallyAlignedComponent(component)
                          ? this.autoComponentColor
                          : this.manualComponentColor
        );
        fillPunchFillContoursOnContext(ctx, contours, (target, nodes) => {
            buildGlyphPathFromNodes(nodes as any[], target);
            target.closePath();
        });
    }

    private isAutomaticallyAlignedComponent(component: any): boolean {
        if (!component || typeof component !== 'object') {
            return false;
        }
        if (component.automaticAlignment === true) {
            return true;
        }
        return (
            component.format_specific?.[GLYPHS_COMPONENT_ALIGNMENT_KEY] === 1
        );
    }
}

// Export singleton instance
export const fastGlyphTileRenderer = new FastGlyphTileRenderer();
