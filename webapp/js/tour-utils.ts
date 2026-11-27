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
