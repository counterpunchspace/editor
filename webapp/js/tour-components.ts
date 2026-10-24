/**
 * Tour helpers for neighboring glyphs, component outlines, and pan-to-fit.
 */

import {
    calculateGlyphShapeBounds,
    multiplyAffineTransforms,
    normalizeAffineTransform,
    transformBoundsWithAffine
} from './glyph-path-geometry';
import {
    viewportFrameBottom,
    viewportFrameRight
} from './glyph-canvas/viewport';

type TourCutoutRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

const IDENTITY = [1, 0, 0, 1, 0, 0];
const PAN_MARGIN_PX = 20;
const PAN_SETTLE_MS = 220;
const FIT_SETTLE_MS = 280;

type FontRect = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
};

const LETTER_BASE_GLYPH_NAMES: Record<string, string> = {
    ë: 'edieresis',
    e: 'e',
    ä: 'adieresis',
    a: 'a'
};

function componentReferenceMatches(
    actual: string | undefined,
    wanted: string
): boolean {
    if (!actual) {
        return false;
    }
    return actual === wanted || actual.startsWith(`${wanted}.`);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function getSelectedGlyphOrigin(): { x: number; y: number } {
    const textRun = window.glyphCanvas?.textRunEditor;
    const index = textRun?.selectedGlyphIndex ?? -1;
    const glyphs = textRun?.shapedGlyphs || [];
    if (index < 0 || index >= glyphs.length) {
        return { x: 0, y: 0 };
    }
    let xPosition = 0;
    for (let i = 0; i < index; i++) {
        xPosition += glyphs[i].ax || 0;
    }
    const glyph = glyphs[index];
    return {
        x: xPosition + (glyph.dx || 0),
        y: glyph.dy || 0
    };
}

function fontRectToCutout(rect: FontRect): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !viewport || !canvasEl) {
        return null;
    }
    const corners = [
        viewport.fontToScreenCoordinates(rect.minX, rect.minY),
        viewport.fontToScreenCoordinates(rect.maxX, rect.minY),
        viewport.fontToScreenCoordinates(rect.minX, rect.maxY),
        viewport.fontToScreenCoordinates(rect.maxX, rect.maxY)
    ];
    const canvasRect = canvasEl.getBoundingClientRect();
    const left = canvasRect.left + Math.min(...corners.map((point) => point.x));
    const top = canvasRect.top + Math.min(...corners.map((point) => point.y));
    const right =
        canvasRect.left + Math.max(...corners.map((point) => point.x));
    const bottom =
        canvasRect.top + Math.max(...corners.map((point) => point.y));
    return {
        left,
        top,
        width: Math.max(8, right - left),
        height: Math.max(8, bottom - top)
    };
}

export function findShapedGlyphIndexForLetter(letter: string): number {
    const textRun = window.glyphCanvas?.textRunEditor;
    const glyphs = textRun?.shapedGlyphs || [];
    const buffer = textRun?.textBuffer || '';
    const letterIndex = buffer.indexOf(letter);
    if (letterIndex >= 0) {
        for (let i = 0; i < glyphs.length; i++) {
            if ((glyphs[i].cl || 0) === letterIndex) {
                return i;
            }
        }
    }
    const baseName = LETTER_BASE_GLYPH_NAMES[letter];
    if (!baseName) {
        return -1;
    }
    const names = textRun?.glyphNameBuffer;
    if (!Array.isArray(names)) {
        return -1;
    }
    for (let i = 0; i < names.length; i++) {
        if (componentReferenceMatches(names[i], baseName)) {
            return i;
        }
    }
    return -1;
}

function getLetterFontRect(letter: string): FontRect | null {
    const canvas = window.glyphCanvas;
    const index = findShapedGlyphIndexForLetter(letter);
    if (!canvas || index < 0) {
        return null;
    }
    const bounds = canvas.glyphBounds?.[index];
    if (
        bounds &&
        Number.isFinite(bounds.x1) &&
        Number.isFinite(bounds.x2) &&
        Number.isFinite(bounds.y1) &&
        Number.isFinite(bounds.y2)
    ) {
        return {
            minX: bounds.x + bounds.x1,
            maxX: bounds.x + bounds.x2,
            minY: bounds.y + bounds.y1,
            maxY: bounds.y + bounds.y2
        };
    }
    const glyphs = canvas.textRunEditor?.shapedGlyphs || [];
    let xPosition = 0;
    for (let i = 0; i < index; i++) {
        xPosition += glyphs[i].ax || 0;
    }
    const glyph = glyphs[index];
    const band = canvas.getTextModeVerticalMetricsBand?.();
    const minY = (band?.lowest ?? 0) + (glyph?.dy || 0);
    const maxY = (band?.highest ?? 0) + (glyph?.dy || 0);
    return {
        minX: xPosition + (glyph?.dx || 0),
        maxX: xPosition + (glyph?.dx || 0) + (glyph?.ax || 0),
        minY,
        maxY
    };
}

export function getTourLetterCutout(letter: string): TourCutoutRect | null {
    const rect = getLetterFontRect(letter);
    if (!rect) {
        return null;
    }
    return fontRectToCutout(rect);
}

/**
 * Cmd+0-style zoom-to-fit for a letter in the text run, without selecting it.
 */
export async function fitTourLetterIntoView(letter: string): Promise<void> {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    const textRun = canvas?.textRunEditor;
    const index = findShapedGlyphIndexForLetter(letter);
    if (
        !canvas ||
        !viewport ||
        !textRun ||
        index < 0 ||
        typeof canvas.getCanvasContentFrame !== 'function' ||
        typeof viewport.frameGlyph !== 'function' ||
        typeof textRun._getGlyphPosition !== 'function'
    ) {
        await panTourLetterFullyIntoView(letter);
        return;
    }
    const frame = canvas.getCanvasContentFrame();
    if (!frame || frame.width <= 0 || frame.height <= 0) {
        await panTourLetterFullyIntoView(letter);
        return;
    }
    const position = textRun._getGlyphPosition(index);
    const stored = canvas.glyphBounds?.[index];
    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    if (
        stored &&
        Number.isFinite(stored.x1) &&
        Number.isFinite(stored.x2) &&
        Number.isFinite(stored.y1) &&
        Number.isFinite(stored.y2)
    ) {
        minX = stored.x1;
        maxX = stored.x2;
        minY = stored.y1;
        maxY = stored.y2;
    } else {
        const rect = getLetterFontRect(letter);
        if (!rect) {
            return;
        }
        minX = rect.minX - (position.xPosition + position.xOffset);
        maxX = rect.maxX - (position.xPosition + position.xOffset);
        minY = rect.minY - position.yOffset;
        maxY = rect.maxY - position.yOffset;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) {
        await panTourLetterFullyIntoView(letter);
        return;
    }
    const margin =
        typeof canvas.getCmdZeroFrameMargin === 'function'
            ? canvas.getCmdZeroFrameMargin(frame)
            : PAN_MARGIN_PX;
    viewport.frameGlyph(
        { minX, maxX, minY, maxY, width, height },
        position,
        frame,
        () => {
            canvas.render?.();
        },
        margin
    );
    await delay(FIT_SETTLE_MS);
}

export async function panTourLetterFullyIntoView(
    letter: string
): Promise<void> {
    const rect = getLetterFontRect(letter);
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    if (
        !rect ||
        !canvas ||
        !viewport ||
        typeof canvas.getCanvasContentFrame !== 'function' ||
        typeof viewport.animatePan !== 'function' ||
        typeof viewport.fontToScreenCoordinates !== 'function'
    ) {
        return;
    }
    const frame = canvas.getCanvasContentFrame();
    if (!frame || frame.width <= 0 || frame.height <= 0) {
        return;
    }
    const corners = [
        viewport.fontToScreenCoordinates(rect.minX, rect.minY),
        viewport.fontToScreenCoordinates(rect.maxX, rect.minY),
        viewport.fontToScreenCoordinates(rect.minX, rect.maxY),
        viewport.fontToScreenCoordinates(rect.maxX, rect.maxY)
    ];
    const left = Math.min(...corners.map((point) => point.x));
    const right = Math.max(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const bottom = Math.max(...corners.map((point) => point.y));
    const frameRight = viewportFrameRight(frame);
    const frameBottom = viewportFrameBottom(frame);
    let deltaX = 0;
    let deltaY = 0;
    const leftOverhang = frame.left + PAN_MARGIN_PX - left;
    const rightOverhang = right - (frameRight - PAN_MARGIN_PX);
    const topOverhang = frame.top + PAN_MARGIN_PX - top;
    const bottomOverhang = bottom - (frameBottom - PAN_MARGIN_PX);
    if (leftOverhang > 0) {
        deltaX = leftOverhang;
    } else if (rightOverhang > 0) {
        deltaX = -rightOverhang;
    }
    if (topOverhang > 0) {
        deltaY = topOverhang;
    } else if (bottomOverhang > 0) {
        deltaY = -bottomOverhang;
    }
    if (deltaX === 0 && deltaY === 0) {
        return;
    }
    viewport.animatePan(viewport.panX + deltaX, viewport.panY + deltaY, () => {
        canvas.render?.();
    });
    await delay(PAN_SETTLE_MS);
}

export function getTourComponentCutout(
    reference: string
): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const editor = canvas?.outlineEditor;
    if (!canvas || !editor) {
        return null;
    }
    const layer =
        editor.getCurrentLayerDataFromStack?.() || editor.layerData || null;
    const shapes = layer?.shapes;
    if (!Array.isArray(shapes)) {
        return null;
    }
    const shape = shapes.find(
        (entry) =>
            entry &&
            typeof entry === 'object' &&
            'reference' in entry &&
            componentReferenceMatches(
                (entry as { reference?: string }).reference,
                reference
            )
    );
    if (!shape || typeof shape !== 'object' || !('reference' in shape)) {
        return null;
    }
    const component = shape as {
        reference: string;
        transform?: unknown;
        layerData?: {
            width?: number;
            shapes?: Parameters<typeof calculateGlyphShapeBounds>[0];
        };
    };
    const nestedShapes = component.layerData?.shapes;
    const childTransform = normalizeAffineTransform(component.transform);
    const parentTransform =
        editor.isEditingComponent?.() &&
        typeof editor.getAccumulatedTransform === 'function'
            ? editor.getAccumulatedTransform()
            : IDENTITY;
    const composed = multiplyAffineTransforms(parentTransform, childTransform);
    const bounds =
        calculateGlyphShapeBounds(nestedShapes, composed) ||
        fallbackComponentBounds(component.layerData, composed);
    if (!bounds) {
        return null;
    }
    const origin = getSelectedGlyphOrigin();
    return fontRectToCutout({
        minX: origin.x + bounds.minX,
        maxX: origin.x + bounds.maxX,
        minY: origin.y + bounds.minY,
        maxY: origin.y + bounds.maxY
    });
}

function fallbackComponentBounds(
    layerData: { width?: number } | undefined,
    transform: number[]
): FontRect | null {
    const width = Number(layerData?.width);
    if (!Number.isFinite(width) || width <= 0) {
        return null;
    }
    const tx = transform[4] || 0;
    const ty = transform[5] || 0;
    return {
        minX: tx,
        maxX: tx + width,
        minY: ty,
        maxY: ty + Math.max(width, 500)
    };
}

function applyAffineToRect(rect: FontRect, transform: number[]): FontRect {
    const bounds = transformBoundsWithAffine(rect, transform);
    return {
        minX: bounds.minX,
        maxX: bounds.maxX,
        minY: bounds.minY,
        maxY: bounds.maxY
    };
}

export function getTourCurrentEditingGlyphCutout(): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const editor = canvas?.outlineEditor;
    const bbox = editor?.calculateGlyphBoundingBox?.();
    if (!bbox) {
        return null;
    }
    let rect: FontRect = {
        minX: bbox.minX,
        maxX: bbox.maxX,
        minY: bbox.minY,
        maxY: bbox.maxY
    };
    if (
        editor.isEditingComponent?.() &&
        typeof editor.getAccumulatedTransform === 'function'
    ) {
        rect = applyAffineToRect(rect, editor.getAccumulatedTransform());
    }
    const origin = getSelectedGlyphOrigin();
    return fontRectToCutout({
        minX: origin.x + rect.minX,
        maxX: origin.x + rect.maxX,
        minY: origin.y + rect.minY,
        maxY: origin.y + rect.maxY
    });
}

export function getTourComponentDepth(): number {
    const editor = window.glyphCanvas?.outlineEditor;
    if (typeof editor?.getComponentDepth === 'function') {
        return editor.getComponentDepth();
    }
    return 0;
}

export function isTourEditingComponent(): boolean {
    return window.glyphCanvas?.outlineEditor?.isEditingComponent?.() === true;
}
