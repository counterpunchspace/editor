// webapp/js/glyph-canvas/viewport.js

import { Point, RectWithWidthHeight } from '../basictypes';
import APP_SETTINGS from '../settings';
import { ShapedGlyph } from './textrun';
import { getShapedGlyphPosition } from './text-run-layout';
import { MAX_VIEWPORT_SCALE, MIN_VIEWPORT_SCALE } from './point-size';

export interface ViewportPanLockTarget {
    panX: number;
    panY: number;
    fontToScreenCoordinates(
        fontX: number,
        fontY: number
    ): { x: number; y: number };
}

/** Usable camera box in canvas CSS pixels (top-left origin). */
export type ViewportFrame = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export function viewportFrameRight(frame: ViewportFrame): number {
    return (frame.left ?? 0) + frame.width;
}

export function viewportFrameBottom(frame: ViewportFrame): number {
    return (frame.top ?? 0) + frame.height;
}

export function viewportFrameCenterX(frame: ViewportFrame): number {
    return (frame.left ?? 0) + frame.width / 2;
}

export function viewportFrameCenterY(frame: ViewportFrame): number {
    return (frame.top ?? 0) + frame.height / 2;
}

/**
 * Shift pan so `fontX`/`fontY` maps to the captured screen point.
 * Default is X-only; pass `{ lockY: true }` to also lock vertical.
 */
export function applyFontPointScreenLock(
    viewport: ViewportPanLockTarget,
    screen: { x: number; y: number } | null | undefined,
    fontX: number,
    fontY: number,
    options?: { lockY?: boolean }
): void {
    if (!screen) {
        return;
    }
    const current = viewport.fontToScreenCoordinates(fontX, fontY);
    viewport.panX += screen.x - current.x;
    if (options?.lockY) {
        viewport.panY += screen.y - current.y;
    }
}

export class ViewportManager {
    private _scale: number;
    panX: number;
    panY: number;
    lastWheelTime: number;
    wheelTimeout: NodeJS.Timeout | null;
    detectedDevice: string | null;
    deviceLockDuration: number;

    constructor(initialScale: number, panX: number = 0, panY: number = 0) {
        this._scale = initialScale;
        this.panX = panX;
        this.panY = panY;

        // Device detection state
        this.lastWheelTime = 0;
        this.wheelTimeout = null;
        this.detectedDevice = null; // 'trackpad' or 'mouse'
        this.deviceLockDuration = 200; // Lock device type for 200ms after detection
    }

    get scale(): number {
        return this._scale;
    }

    set scale(value: number) {
        if (this._scale === value) {
            return;
        }
        this._scale = value;
        // Canvas zoom (viewport.scale) changed. Detail keys: scale.
        window.dispatchEvent(
            new CustomEvent('glyphCanvasViewportChanged', {
                detail: { scale: value }
            })
        );
    }

    getTransformMatrix() {
        // Return a transformation matrix for converting font coordinates to canvas coordinates
        return {
            a: this.scale,
            b: 0,
            c: 0,
            d: -this.scale, // Flip Y axis (font coordinates have Y going up)
            e: this.panX,
            f: this.panY
        };
    }

    /**
     * Transforms canvas-space coordinates to font-space coordinates.
     * @returns {Point} The coordinates in font space.
     */
    getFontSpaceCoordinates(canvasX: number, canvasY: number): Point {
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;

        const fontX =
            (transform.d * (canvasX - transform.e) -
                transform.c * (canvasY - transform.f)) /
            det;
        const fontY =
            (transform.a * (canvasY - transform.f) -
                transform.b * (canvasX - transform.e)) /
            det;

        return { x: fontX, y: fontY };
    }

    /**
     * Transforms font-space coordinates to canvas-space (screen) coordinates.
     * This is the inverse of getFontSpaceCoordinates.
     * @param {number} fontX - The x-coordinate in font space.
     * @param {number} fontY - The y-coordinate in font space.
     * @returns {Point} The coordinates in canvas space.
     */
    fontToScreenCoordinates(fontX: number, fontY: number): Point {
        const transform = this.getTransformMatrix();
        // Apply the transform matrix: screen = transform * font
        // screenX = a * fontX + c * fontY + e
        // screenY = b * fontX + d * fontY + f
        const screenX = transform.a * fontX + transform.c * fontY + transform.e;
        const screenY = transform.b * fontX + transform.d * fontY + transform.f;
        return { x: screenX, y: screenY };
    }

    /**
     * Transforms canvas-space coordinates to the local coordinate system of a specific glyph within the shaped text run.
     * @param {number} canvasX - The x-coordinate in canvas space.
     * @param {number} canvasY - The y-coordinate in canvas space.
     * @param {Array} shapedGlyphs - The array of shaped glyphs from HarfBuzz.
     * @param {number} selectedGlyphIndex - The index of the glyph whose local space we want.
     * @returns {{glyphX: number, glyphY: number}} The coordinates in the glyph's local space.
     */
    getGlyphLocalCoordinates(
        canvasX: number,
        canvasY: number,
        shapedGlyphs: ShapedGlyph[] | null,
        selectedGlyphIndex: number
    ) {
        let { x: glyphX, y: glyphY } = this.getFontSpaceCoordinates(
            canvasX,
            canvasY
        );

        if (
            selectedGlyphIndex < 0 ||
            !shapedGlyphs ||
            selectedGlyphIndex >= shapedGlyphs.length
        ) {
            return { glyphX, glyphY };
        }

        const position = getShapedGlyphPosition(
            shapedGlyphs,
            selectedGlyphIndex
        );
        glyphX -= position.xPosition + position.xOffset;
        glyphY -= position.yOffset;

        return { glyphX, glyphY };
    }

    /**
     * Zooms the viewport towards a specific point.
     * @param {number} zoomFactor - The factor to zoom by (e.g., 1.1 for zoom in, 0.9 for zoom out).
     * @param {number} mouseX - The canvas x-coordinate to zoom towards.
     * @param {number} mouseY - The canvas y-coordinate to zoom towards.
     * @returns {boolean} - True if zoom happened, false otherwise.
     */
    zoom(zoomFactor: number, mouseX: number, mouseY: number) {
        const newScale = this.scale * zoomFactor;

        // Limit zoom range
        if (newScale < MIN_VIEWPORT_SCALE || newScale > MAX_VIEWPORT_SCALE)
            return false;

        // Adjust pan to zoom toward mouse position
        this.panX = mouseX - (mouseX - this.panX) * zoomFactor;
        this.panY = mouseY - (mouseY - this.panY) * zoomFactor;

        this.scale = newScale;
        return true;
    }

    /**
     * Pans the viewport.
     * @param {number} dx - The change in x.
     * @param {number} dy - The change in y.
     */
    pan(dx: number, dy: number) {
        this.panX += dx;
        this.panY += dy;
    }

    animateZoomAndPan(
        targetScale: number,
        targetPanX: number,
        targetPanY: number,
        renderCallback: Function,
        onComplete?: () => void
    ) {
        // Animate zoom and pan together
        const startScale = this.scale;
        const startPanX = this.panX;
        const startPanY = this.panY;
        const frames = 10;
        let currentFrame = 0;

        const animate = () => {
            currentFrame++;
            const progress = Math.min(currentFrame / frames, 1.0);

            // Ease-out cubic for smooth deceleration
            const easedProgress = 1 - Math.pow(1 - progress, 3);

            // Interpolate scale and pan values
            this.scale =
                startScale + (targetScale - startScale) * easedProgress;
            this.panX = startPanX + (targetPanX - startPanX) * easedProgress;
            this.panY = startPanY + (targetPanY - startPanY) * easedProgress;

            renderCallback();

            if (progress < 1.0) {
                requestAnimationFrame(animate);
            } else {
                // Ensure we end exactly at target
                this.scale = targetScale;
                this.panX = targetPanX;
                this.panY = targetPanY;
                renderCallback();
                if (onComplete) {
                    onComplete();
                }
            }
        };

        animate();
    }

    animatePan(
        targetPanX: number,
        targetPanY: number,
        renderCallback: Function
    ) {
        this.animateZoomAndPan(
            this.scale,
            targetPanX,
            targetPanY,
            renderCallback
        );
    }

    private computeGlyphFontSpaceBounds(
        bounds: RectWithWidthHeight,
        glyphPosition: { xPosition: number; xOffset: number; yOffset: number }
    ) {
        const minX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.minX;
        const maxX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.maxX;
        const minY = glyphPosition.yOffset + bounds.minY;
        const maxY = glyphPosition.yOffset + bounds.maxY;
        return {
            minX,
            maxX,
            minY,
            maxY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2,
            height: maxY - minY
        };
    }

    /**
     * Frame a glyph to fit within the viewport with margin.
     * Uses animated camera movement (10 frames).
     * @param {Object} bounds - The glyph bounding box {minX, maxX, minY, maxY, width, height}
     * @param {Object} glyphPosition - Glyph position in text run {xPosition, xOffset, yOffset}
     * @param {ViewportFrame} canvasRect - Usable camera box in canvas CSS pixels
     * @param {Function} renderCallback - Callback to render after each frame
     * @param {number} margin - Canvas margin in pixels (defaults to Cmd+0 frame margin)
     */
    frameGlyph(
        bounds: RectWithWidthHeight,
        glyphPosition: { xPosition: number; xOffset: number; yOffset: number },
        canvasRect: ViewportFrame,
        renderCallback: Function,
        margin: number | null = null
    ) {
        // Use setting if no margin specified
        if (margin === null) {
            margin = APP_SETTINGS.OUTLINE_EDITOR.CMD_ZERO_FRAME_MARGIN;
        }

        const { centerX: fontSpaceCenterX, centerY: fontSpaceCenterY } =
            this.computeGlyphFontSpaceBounds(bounds, glyphPosition);

        // Calculate the scale needed to fit the bounding box with margin
        const scaleX = (canvasRect.width - margin * 2) / bounds.width;
        const scaleY = (canvasRect.height - margin * 2) / bounds.height;
        const targetScale = Math.min(scaleX, scaleY);

        // Clamp scale to reasonable limits (max zoom from settings to avoid over-zooming small glyphs)
        const clampedScale = Math.max(
            0.01,
            Math.min(
                APP_SETTINGS.OUTLINE_EDITOR.MAX_ZOOM_FOR_CMD_ZERO,
                Number.isFinite(targetScale) ? targetScale : 0.01
            )
        );

        // Calculate pan to center the glyph both horizontally and vertically
        const targetPanX =
            viewportFrameCenterX(canvasRect) - fontSpaceCenterX * clampedScale;
        // Note: Y is flipped in canvas, so we negate fontSpaceCenterY
        const targetPanY =
            viewportFrameCenterY(canvasRect) - -fontSpaceCenterY * clampedScale;

        // Animate to target
        this.animateZoomAndPan(
            clampedScale,
            targetPanX,
            targetPanY,
            renderCallback
        );
    }

    /**
     * Pan to show a specific glyph (used when switching glyphs with keyboard shortcuts).
     * @param {Object} bounds - The glyph bounding box {minX, maxX, minY, maxY, width, height}
     * @param {Object} glyphPosition - Glyph position in text run {xPosition, xOffset, yOffset}
     * @param {ViewportFrame} canvasRect - Usable camera box in canvas CSS pixels
     * @param {Function} renderCallback - Callback to render after each frame
     * @param {number} margin - Canvas margin in pixels (defaults to CANVAS_MARGIN setting)
     */
    panToGlyph(
        bounds: RectWithWidthHeight,
        glyphPosition: { xPosition: number; xOffset: number; yOffset: number },
        canvasRect: ViewportFrame,
        renderCallback: Function,
        margin: number | null = null
    ) {
        // Use setting if no margin specified
        if (margin === null) {
            margin = APP_SETTINGS.OUTLINE_EDITOR.CANVAS_MARGIN;
        }

        console.log(
            '[Viewport]',
            'ViewportManager.panToGlyph: calculated bounds',
            bounds
        );

        const {
            minX: fontSpaceMinX,
            maxX: fontSpaceMaxX,
            minY: fontSpaceMinY,
            maxY: fontSpaceMaxY,
            height: glyphHeight,
            centerY: glyphCenterY
        } = this.computeGlyphFontSpaceBounds(bounds, glyphPosition);

        const currentScale = this.scale;
        const availableWidth = canvasRect.width - margin * 2;
        const availableHeight = canvasRect.height - margin * 2;

        let targetScale = currentScale;
        let targetPanX = this.panX;
        let targetPanY = this.panY;

        // Check if current glyph fits within the viewport at current scale
        const currentScreenLeft = fontSpaceMinX * currentScale + this.panX;
        const currentScreenRight = fontSpaceMaxX * currentScale + this.panX;
        const currentScreenTop = -fontSpaceMaxY * currentScale + this.panY;
        const currentScreenBottom = -fontSpaceMinY * currentScale + this.panY;

        const fitsHorizontally =
            currentScreenLeft >= canvasRect.left + margin &&
            currentScreenRight <= viewportFrameRight(canvasRect) - margin;
        const fitsVertically =
            currentScreenTop >= canvasRect.top + margin &&
            currentScreenBottom <= viewportFrameBottom(canvasRect) - margin;

        // Only adjust viewport if glyph doesn't fit comfortably
        if (!fitsHorizontally || !fitsVertically) {
            // Calculate scale to fit the active glyph (zoom out only if needed).
            const scaleY = availableHeight / glyphHeight;
            const scaleX = availableWidth / bounds.width;
            targetScale = Math.min(scaleY, scaleX, currentScale); // Don't zoom in, only out
            // Clamp to reasonable limits
            targetScale = Math.max(0.01, Math.min(100, targetScale));

            // If scale changed, we need to adjust panX to maintain horizontal position
            // When zooming, content shifts relative to viewport center
            if (targetScale !== currentScale) {
                const scaleFactor = targetScale / currentScale;
                const centerX = viewportFrameCenterX(canvasRect);
                // Adjust panX to keep the horizontal center point stable during zoom
                targetPanX = centerX - (centerX - this.panX) * scaleFactor;
            }

            // Note: Y is flipped in canvas, so we negate glyphCenterY.
            targetPanY =
                viewportFrameCenterY(canvasRect) - -glyphCenterY * targetScale;

            console.log(
                '[Viewport]',
                'ViewportManager.panToGlyph: centering vertically on active glyph',
                {
                    glyphCenterY,
                    targetPanY,
                    targetScale,
                    scaleFactor: targetScale / currentScale
                }
            );

            // Pan horizontally: only move if glyph is outside the viewport margins
            // IMPORTANT: Calculate screen position with the NEW scale and adjusted panX
            const screenLeftAfterZoom =
                fontSpaceMinX * targetScale + targetPanX;
            const screenRightAfterZoom =
                fontSpaceMaxX * targetScale + targetPanX;

            // Calculate how far outside the viewport the glyph extends
            const leftOverhang = canvasRect.left + margin - screenLeftAfterZoom; // Positive if glyph is off left edge
            const rightOverhang =
                screenRightAfterZoom -
                (viewportFrameRight(canvasRect) - margin); // Positive if glyph is off right edge

            if (leftOverhang > 0) {
                // Glyph extends past left edge - pan right just enough to bring it to margin
                targetPanX = targetPanX + leftOverhang;
            } else if (rightOverhang > 0) {
                // Glyph extends past right edge - pan left just enough to bring it to margin
                targetPanX = targetPanX - rightOverhang;
            }
            // If glyph is within margins horizontally, don't change targetPanX (keep adjusted pan)

            console.log(
                '[Viewport]',
                'ViewportManager.panToGlyph: panning to',
                {
                    targetScale,
                    targetPanX,
                    targetPanY,
                    scaleChanged: targetScale !== currentScale
                }
            );

            // Animate to target (zoom and pan together if scale changed, otherwise just pan)
            if (targetScale !== currentScale) {
                this.animateZoomAndPan(
                    targetScale,
                    targetPanX,
                    targetPanY,
                    renderCallback
                );
            } else {
                this.animatePan(targetPanX, targetPanY, renderCallback);
            }
        } else {
            console.log(
                '[Viewport]',
                'ViewportManager.panToGlyph: glyph fits comfortably, no viewport adjustment needed'
            );
        }
    }

    /**
     * Handle wheel events for zooming and panning.
     * - Alt + wheel: zoom in/out (down = zoom in, up = zoom out)
     * - Shift + wheel (or trackpad horizontal): pan horizontally
     * - Wheel alone: pan vertically
     * @param {WheelEvent} e - The wheel event
     * @param {DOMRect} canvasRect - The canvas bounding rectangle (pointer mapping)
     * @param {Function} renderCallback - Callback to render after change
     * @returns {boolean} - True if viewport changed, false otherwise
     */
    handleWheel(e: WheelEvent, canvasRect: DOMRect, renderCallback: Function) {
        const now = Date.now();

        // Always perform device detection based on current event characteristics
        // The magnitude of the delta is the most reliable indicator
        const deltaX = Math.abs(e.deltaX);
        const deltaY = Math.abs(e.deltaY);
        const maxDelta = Math.max(deltaX, deltaY);

        let isTrackpad = false;

        if (e.deltaMode === 0) {
            // Pixel mode
            // Primary heuristic: magnitude is the most reliable indicator
            // Mouse wheel produces larger jumps (typically 40-300+)
            // Trackpad produces smaller, smoother deltas (typically < 20)
            if (maxDelta > 25) {
                // Large values = definitely mouse wheel
                isTrackpad = false;
            } else if (maxDelta < 10) {
                // Very small values = definitely trackpad
                isTrackpad = true;
            } else {
                // Ambiguous range (10-25): use previous detection if recent, otherwise default to trackpad
                if (this.detectedDevice && now - this.lastWheelTime < 100) {
                    isTrackpad = this.detectedDevice === 'trackpad';
                } else {
                    isTrackpad = maxDelta < 15;
                }
            }
        } else {
            // deltaMode 1 (line) or 2 (page) = definitely mouse wheel
            isTrackpad = false;
        }

        // Store detected device type
        this.detectedDevice = isTrackpad ? 'trackpad' : 'mouse';
        this.lastWheelTime = now;

        // Clear any existing timeout and set new one to reset device lock
        if (this.wheelTimeout) {
            clearTimeout(this.wheelTimeout);
        }
        this.wheelTimeout = setTimeout(() => {
            this.detectedDevice = null;
        }, this.deviceLockDuration);

        console.log('[Viewport]', 'handleWheel:', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            maxDelta: Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY)).toFixed(
                2
            ),
            isTrackpad,
            detectedDevice: this.detectedDevice,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey
        });

        // Pinch-to-zoom on trackpad (ctrlKey set by browser) OR Alt key + wheel = zoom
        if (e.ctrlKey || e.altKey) {
            const mouseX = e.clientX - canvasRect.left;
            const mouseY = e.clientY - canvasRect.top;

            // Determine zoom speed based on input method
            // Pinch gestures (ctrlKey) get their own setting for better control
            let zoomSpeed;
            if (e.ctrlKey) {
                // Pinch-to-zoom gesture
                zoomSpeed = APP_SETTINGS.OUTLINE_EDITOR.ZOOM_SPEED_PINCH;
            } else {
                // Alt+wheel/scroll
                zoomSpeed = isTrackpad
                    ? APP_SETTINGS.OUTLINE_EDITOR.ZOOM_SPEED_TRACKPAD
                    : APP_SETTINGS.OUTLINE_EDITOR.ZOOM_SPEED_MOUSE;
            }

            // Normalize deltaY for consistent zoom behavior
            // Mouse wheels send large discrete values (e.g., ±100-120)
            // Trackpad sends smooth, smaller values (typically ±1-10)
            let normalizedDeltaY = e.deltaY;
            if (!isTrackpad) {
                // Cap mouse wheel delta to prevent excessive zoom jumps
                // Use a much lower cap to prevent speed-based zoom differences
                const maxMouseDelta = 10;
                normalizedDeltaY =
                    Math.sign(e.deltaY) *
                    Math.min(Math.abs(e.deltaY), maxMouseDelta);
            }

            // deltaY > 0 means scrolling down = zoom in
            // deltaY < 0 means scrolling up = zoom out
            const zoomDelta = -normalizedDeltaY * zoomSpeed;
            const zoomFactor = Math.exp(zoomDelta);

            console.log('[Viewport]', 'zoom:', {
                rawDeltaY: e.deltaY,
                normalizedDeltaY,
                zoomSpeed,
                zoomDelta,
                zoomFactor: zoomFactor.toFixed(4),
                isPinch: e.ctrlKey,
                isTrackpad
            });

            if (this.zoom(zoomFactor, mouseX, mouseY)) {
                renderCallback();
                return true;
            }
            return false;
        }

        // For panning, we need to normalize mouse wheel values to prevent acceleration
        // Mouse wheel typically sends large discrete values (e.g., ±100)
        // Trackpad sends smooth, smaller values
        let panDeltaX = e.deltaX;
        let panDeltaY = e.deltaY;

        // Normalize mouse wheel deltas to a maximum magnitude
        if (!isTrackpad) {
            const maxDelta = 40; // Cap the delta to prevent runaway panning
            panDeltaX =
                Math.sign(panDeltaX) * Math.min(Math.abs(panDeltaX), maxDelta);
            panDeltaY =
                Math.sign(panDeltaY) * Math.min(Math.abs(panDeltaY), maxDelta);
        }

        // Shift key + wheel = force horizontal pan (mouse only, trackpad ignores shift for natural panning)
        if (e.shiftKey && !isTrackpad) {
            // Shift + mouse wheel: use vertical scroll for horizontal panning
            // Use whichever delta is larger (some mice send deltaX, some send deltaY)
            const horizontalDelta =
                Math.abs(panDeltaX) > Math.abs(panDeltaY)
                    ? panDeltaX
                    : panDeltaY;
            // Positive delta means scrolling right/down = pan right
            // Negative delta means scrolling left/up = pan left
            const horizontalPanSpeed =
                APP_SETTINGS.OUTLINE_EDITOR.PAN_SPEED_MOUSE_HORIZONTAL;
            const dx = -horizontalDelta * horizontalPanSpeed;
            this.pan(dx, 0);
            renderCallback();
            return true;
        }

        // No shift key: natural panning
        // Support diagonal panning by applying both deltaX and deltaY if present
        let panApplied = false;

        if (Math.abs(panDeltaX) > 0 || Math.abs(panDeltaY) > 0) {
            // Determine speeds based on device type
            const horizontalPanSpeed = isTrackpad
                ? APP_SETTINGS.OUTLINE_EDITOR.PAN_SPEED_TRACKPAD
                : APP_SETTINGS.OUTLINE_EDITOR.PAN_SPEED_MOUSE_HORIZONTAL;
            const verticalPanSpeed = isTrackpad
                ? APP_SETTINGS.OUTLINE_EDITOR.PAN_SPEED_TRACKPAD
                : APP_SETTINGS.OUTLINE_EDITOR.PAN_SPEED_MOUSE_VERTICAL;

            const dx = -panDeltaX * horizontalPanSpeed;
            const dy = -panDeltaY * verticalPanSpeed;

            this.pan(dx, dy);
            renderCallback();
            panApplied = true;
        }

        return panApplied;
    }

    /**
     * Zoom and pan so a font-space box fills the canvas with margin.
     * Zero-width boxes (caret-only) use vertical scale only.
     */
    fitFontBounds(
        minX: number,
        maxX: number,
        minY: number,
        maxY: number,
        canvasRect: ViewportFrame,
        renderCallback: Function,
        margin: number | null = null,
        onComplete?: () => void,
        scaleLimits?: { min: number; max: number }
    ) {
        if (margin === null) {
            margin = APP_SETTINGS.OUTLINE_EDITOR.CANVAS_MARGIN;
        }

        const textWidth = maxX - minX;
        const textHeight = Math.max(maxY - minY, 1);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const availableWidth = canvasRect.width - margin * 2;
        const availableHeight = canvasRect.height - margin * 2;
        const scaleX =
            textWidth > 0.01
                ? availableWidth / textWidth
                : Number.POSITIVE_INFINITY;
        const scaleY = availableHeight / textHeight;
        const targetScale = Math.min(scaleX, scaleY);
        const minScale = scaleLimits?.min ?? 0.01;
        const maxScale =
            scaleLimits?.max ??
            APP_SETTINGS.OUTLINE_EDITOR.MAX_ZOOM_FOR_TEXT_FIT;
        const clampedScale = Math.max(
            minScale,
            Math.min(
                maxScale,
                Number.isFinite(targetScale) ? targetScale : scaleY
            )
        );

        const targetPanX =
            viewportFrameCenterX(canvasRect) - centerX * clampedScale;
        const targetPanY =
            viewportFrameCenterY(canvasRect) - -centerY * clampedScale;

        this.animateZoomAndPan(
            clampedScale,
            targetPanX,
            targetPanY,
            renderCallback,
            onComplete
        );

        return clampedScale;
    }

    /**
     * Zoom and pan to fit the entire text run in the canvas viewport.
     * Vertical bounds default to a UPM-1000 Latin box when omitted.
     */
    zoomToFitText(
        shapedGlyphs: ShapedGlyph[] | null,
        canvasRect: ViewportFrame,
        renderCallback: Function,
        margin: number | null = null,
        onComplete?: () => void,
        verticalBounds: { minY: number; maxY: number } | null = null,
        scaleLimits?: { min: number; max: number }
    ) {
        if (!shapedGlyphs || shapedGlyphs.length === 0) {
            return;
        }

        const boundMinY = verticalBounds?.minY ?? -200;
        const boundMaxY = verticalBounds?.maxY ?? 800;
        let minX = 0;
        let maxX = 0;
        let minY = boundMinY;
        let maxY = boundMaxY;

        for (let i = 0; i < shapedGlyphs.length; i++) {
            const glyph = shapedGlyphs[i];
            const position = getShapedGlyphPosition(shapedGlyphs, i);
            const xAdvance = glyph.ax || 0;
            const glyphX = position.xPosition + position.xOffset;

            minX = Math.min(minX, glyphX);
            maxX = Math.max(maxX, glyphX + xAdvance);
            minY = Math.min(minY, boundMinY + (glyph.dy || 0));
            maxY = Math.max(maxY, boundMaxY + (glyph.dy || 0));
        }

        return this.fitFontBounds(
            minX,
            maxX,
            minY,
            maxY,
            canvasRect,
            renderCallback,
            margin,
            onComplete,
            scaleLimits
        );
    }

    /**
     * Zoom and pan so the caret sits on the canvas center using vertical metrics.
     */
    zoomToFitCursor(
        cursorX: number,
        canvasRect: ViewportFrame,
        renderCallback: Function,
        verticalBounds: { minY: number; maxY: number } | null = null,
        margin: number | null = null,
        onComplete?: () => void,
        scaleLimits?: { min: number; max: number }
    ) {
        const minY = verticalBounds?.minY ?? -200;
        const maxY = verticalBounds?.maxY ?? 800;
        return this.fitFontBounds(
            cursorX,
            cursorX,
            minY,
            maxY,
            canvasRect,
            renderCallback,
            margin,
            onComplete,
            scaleLimits
        );
    }
}
