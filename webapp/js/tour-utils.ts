/**
 * Shared helpers for the interactive tour subsystem.
 */

import type { TourCutoutRect } from './tour-slides';

export type TourFontRect = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
};

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

export function viewAnimationDelayMs(): number {
    const animation = window.VIEW_SETTINGS?.animation;
    if (animation?.enabled && typeof animation.duration === 'number') {
        return animation.duration + 40;
    }
    return 0;
}

export function getStationDisplayName(station: {
    name?: string | { dflt?: string; en?: string };
}): string {
    const name = station.name;
    if (typeof name === 'string') {
        return name;
    }
    if (name?.dflt) {
        return name.dflt;
    }
    if (name?.en) {
        return name.en;
    }
    return '';
}

export function getFontStations(): Array<{
    id?: string;
    name?: string | { dflt?: string; en?: string };
    location?: Record<string, number>;
}> {
    const fontModel =
        window.currentFontModel || window.fontManager?.currentFont?.fontModel;
    return fontModel?.stations || [];
}

export function fontRectToCutout(rect: TourFontRect): TourCutoutRect | null {
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

export function getSelectedGlyphWorldOrigin(): { x: number; y: number } {
    const textRun = window.glyphCanvas?.textRunEditor;
    const index = textRun?.selectedGlyphIndex ?? -1;
    if (
        textRun &&
        typeof textRun._getGlyphPosition === 'function' &&
        index >= 0
    ) {
        const position = textRun._getGlyphPosition(index);
        return {
            x: (position.xPosition || 0) + (position.xOffset || 0),
            y: position.yOffset || 0
        };
    }
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

export function getSelectedGlyphOutlineFontRect(): TourFontRect | null {
    const canvas = window.glyphCanvas;
    if (!canvas?.outlineEditor?.active) {
        return null;
    }
    const index = canvas.textRunEditor?.selectedGlyphIndex;
    if (typeof index !== 'number' || index < 0) {
        return null;
    }
    const bounds = canvas.glyphBounds?.[index];
    if (
        !bounds ||
        !Number.isFinite(bounds.x1) ||
        !Number.isFinite(bounds.x2) ||
        !Number.isFinite(bounds.y1) ||
        !Number.isFinite(bounds.y2)
    ) {
        return null;
    }
    return {
        minX: bounds.x + bounds.x1,
        maxX: bounds.x + bounds.x2,
        minY: bounds.y + bounds.y1,
        maxY: bounds.y + bounds.y2
    };
}
