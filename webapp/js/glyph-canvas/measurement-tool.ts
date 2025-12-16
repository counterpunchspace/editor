// Measurement tool for measuring distances in glyph canvas
// Activated by holding Alt key in text mode or editing mode

import APP_SETTINGS from '../settings';
import type { GlyphCanvas } from '../glyph-canvas';

export class MeasurementTool {
    private glyphCanvas: GlyphCanvas;

    // Drag state
    isDragging: boolean = false;
    originX: number = 0; // Canvas coordinates
    originY: number = 0; // Canvas coordinates

    // Visibility state
    private delayTimer: number | null = null;
    visible: boolean = false;
    private cancelledByZoom: boolean = false;

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
    }

    /**
     * Handle Alt key press - start delay timer
     */
    handleAltKeyPress(): void {
        this.startDelayTimer();
    }

    /**
     * Handle Alt key release - reset all state
     */
    handleAltKeyRelease(): void {
        this.cancelDelayTimer();
        this.visible = false;
        this.cancelledByZoom = false;
        this.isDragging = false;
    }

    /**
     * Handle mouse wheel/zoom - cancel or hide tool
     */
    handleWheel(): void {
        this.cancelDelayTimer();
        this.visible = false;
        this.cancelledByZoom = true;
    }

    /**
     * Handle mouse down to start dragging measurement line
     */
    handleMouseDown(
        clientX: number,
        clientY: number,
        canvasRect: DOMRect
    ): boolean {
        if (
            !this.glyphCanvas.altKeyPressed ||
            !this.glyphCanvas.outlineEditor.active
        ) {
            return false;
        }

        this.isDragging = true;
        this.originX = clientX - canvasRect.left;
        this.originY = clientY - canvasRect.top;
        this.showImmediately();
        return true;
    }

    /**
     * Handle mouse up to stop dragging
     */
    handleMouseUp(): void {
        this.isDragging = false;
    }

    /**
     * Check if measurement tool should block hit detection
     */
    shouldBlockHitDetection(): boolean {
        return this.glyphCanvas.altKeyPressed || this.isDragging;
    }

    /**
     * Check if crosshair cursor should be shown
     */
    shouldShowCrosshair(): boolean {
        return (
            this.glyphCanvas.altKeyPressed &&
            this.glyphCanvas.outlineEditor.active &&
            this.visible
        );
    }

    /**
     * Check if visual crosshair/measurement lines should be drawn
     */
    shouldDrawVisuals(): boolean {
        return (
            this.glyphCanvas.altKeyPressed &&
            this.visible &&
            this.glyphCanvas.outlineEditor.active
        );
    }

    /**
     * Check if text mode measurements should be drawn
     */
    shouldDrawTextModeMeasurements(): boolean {
        return (
            this.glyphCanvas.altKeyPressed &&
            this.visible &&
            !this.glyphCanvas.outlineEditor.active
        );
    }

    /**
     * Start delay timer before showing measurement tool
     */
    private startDelayTimer(): void {
        this.cancelDelayTimer();
        this.cancelledByZoom = false;

        const delay =
            APP_SETTINGS.OUTLINE_EDITOR.MEASUREMENT_TOOL_DISPLAY_DELAY;
        this.delayTimer = window.setTimeout(() => {
            if (!this.cancelledByZoom) {
                this.visible = true;
                this.glyphCanvas.updateCursorStyle();
            }
            this.delayTimer = null;
            this.glyphCanvas.render();
        }, delay);
    }

    /**
     * Cancel delay timer
     */
    private cancelDelayTimer(): void {
        if (this.delayTimer !== null) {
            window.clearTimeout(this.delayTimer);
            this.delayTimer = null;
        }
    }

    /**
     * Show measurement tool immediately (when dragging starts)
     */
    private showImmediately(): void {
        this.cancelDelayTimer();
        this.visible = true;
    }
}
