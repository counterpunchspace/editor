// Measurement tool for measuring distances in glyph canvas
// Activated immediately by holding Tab in text mode or editing mode

import type { GlyphCanvas } from '../glyph-canvas';

export class MeasurementTool {
    private glyphCanvas: GlyphCanvas;

    // Drag state
    isDragging: boolean = false;
    originX: number = 0; // Canvas coordinates
    originY: number = 0; // Canvas coordinates

    // Visibility state
    visible: boolean = false;
    private disabledForTyping: boolean = false;

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
    }

    /**
     * Handle the measurement key press and show the tool immediately.
     */
    handleMeasurementKeyPress(): void {
        this.showImmediately();
        this.glyphCanvas.updateCursorStyle();
    }

    /**
     * Handle the measurement key release and reset all state.
     */
    handleMeasurementKeyRelease(): void {
        const wasVisible = this.visible;
        this.visible = false;
        this.isDragging = false;
        this.disabledForTyping = false;

        if (wasVisible) {
            this.resetAfterHide(true);
        }
    }

    /**
     * Handle mouse wheel/zoom - cancel or hide tool
     */
    handleWheel(): void {
        const wasVisible = this.visible;
        this.visible = false;

        if (wasVisible) {
            this.resetAfterHide(false);
        }
    }

    private resetAfterHide(shouldRender: boolean): void {
        if (
            this.glyphCanvas.outlineEditor.active &&
            document.activeElement === this.glyphCanvas.canvas
        ) {
            this.glyphCanvas.outlineEditor.performHitDetection(null);
        }
        this.glyphCanvas.updateHoveredGlyph();
        this.glyphCanvas.updateCursorStyle();
        if (shouldRender) {
            this.glyphCanvas.render();
        }
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
            !this.glyphCanvas.measurementKeyPressed ||
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
            (this.glyphCanvas.measurementKeyPressed &&
                !this.disabledForTyping) ||
            this.isDragging
        );
    }

    /**
     * Check if crosshair cursor should be shown
     */
    shouldShowCrosshair(): boolean {
        return (
            this.glyphCanvas.measurementKeyPressed &&
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
            this.glyphCanvas.measurementKeyPressed &&
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
            this.glyphCanvas.measurementKeyPressed &&
            this.visible &&
            !this.glyphCanvas.outlineEditor.active &&
            !this.disabledForTyping
        );
    }

    /**
     * Show measurement tool immediately (when dragging starts)
     */
    private showImmediately(): void {
        this.visible = true;
        // Clear hover states when measurement tool turns on
        this.glyphCanvas.outlineEditor.hoveredGlyphIndex = -1;
        this.glyphCanvas.outlineEditor.hoveredComponentIndex = null;
        this.glyphCanvas.outlineEditor.hoveredPointIndex = null;
        this.glyphCanvas.outlineEditor.hoveredAnchorIndex = null;
    }
}
