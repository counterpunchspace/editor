// Measurement tool for measuring distances in glyph canvas
// Activated by holding Shift key in text mode or editing mode

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
    private disabledForTyping: boolean = false;

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
    }

    /**
     * Handle Shift key press - start delay timer
     */
    handleShiftKeyPress(): void {
        this.startDelayTimer();
    }

    /**
     * Handle Shift key release - reset all state
     */
    handleShiftKeyRelease(): void {
        this.cancelDelayTimer();
        this.visible = false;
        this.cancelledByZoom = false;
        this.isDragging = false;
        this.disabledForTyping = false;
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
     * Handle typing while Shift is held - disable measurement until Shift is released
     */
    handleTypingWithShift(): void {
        this.cancelDelayTimer();
        this.visible = false;
        this.disabledForTyping = true;
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
            !this.glyphCanvas.shiftKeyPressed ||
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
        return (
            (this.glyphCanvas.shiftKeyPressed && !this.disabledForTyping) ||
            this.isDragging
        );
    }

    /**
     * Check if crosshair cursor should be shown
     */
    shouldShowCrosshair(): boolean {
        return (
            this.glyphCanvas.shiftKeyPressed &&
            this.glyphCanvas.outlineEditor.active &&
            this.visible &&
            !this.disabledForTyping
        );
    }

    /**
     * Check if visual crosshair/measurement lines should be drawn
     */
    shouldDrawVisuals(): boolean {
        return (
            this.glyphCanvas.shiftKeyPressed &&
            this.visible &&
            this.glyphCanvas.outlineEditor.active &&
            !this.disabledForTyping
        );
    }

    /**
     * Check if text mode measurements should be drawn
     */
    shouldDrawTextModeMeasurements(): boolean {
        return (
            this.glyphCanvas.shiftKeyPressed &&
            this.visible &&
            !this.glyphCanvas.outlineEditor.active &&
            !this.disabledForTyping
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
            if (!this.cancelledByZoom && !this.disabledForTyping) {
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
