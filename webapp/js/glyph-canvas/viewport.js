// webapp/js/glyph-canvas/viewport.js

class ViewportManager {
    constructor(initialScale, panX = 0, panY = 0) {
        this.scale = initialScale;
        this.panX = panX;
        this.panY = panY;
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
     * @param {number} canvasX - The x-coordinate in canvas space.
     * @param {number} canvasY - The y-coordinate in canvas space.
     * @returns {{x: number, y: number}} The coordinates in font space.
     */
    getFontSpaceCoordinates(canvasX, canvasY) {
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
     * Transforms canvas-space coordinates to the local coordinate system of a specific glyph within the shaped text run.
     * @param {number} canvasX - The x-coordinate in canvas space.
     * @param {number} canvasY - The y-coordinate in canvas space.
     * @param {Array} shapedGlyphs - The array of shaped glyphs from HarfBuzz.
     * @param {number} selectedGlyphIndex - The index of the glyph whose local space we want.
     * @returns {{glyphX: number, glyphY: number}} The coordinates in the glyph's local space.
     */
    getGlyphLocalCoordinates(
        canvasX,
        canvasY,
        shapedGlyphs,
        selectedGlyphIndex
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

        // Adjust for the selected glyph's position in the run
        let xPosition = 0;
        for (let i = 0; i < selectedGlyphIndex; i++) {
            xPosition += shapedGlyphs[i].ax || 0;
        }
        const glyph = shapedGlyphs[selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;

        glyphX -= xPosition + xOffset;
        glyphY -= yOffset;

        return { glyphX, glyphY };
    }

    /**
     * Zooms the viewport towards a specific point.
     * @param {number} zoomFactor - The factor to zoom by (e.g., 1.1 for zoom in, 0.9 for zoom out).
     * @param {number} mouseX - The canvas x-coordinate to zoom towards.
     * @param {number} mouseY - The canvas y-coordinate to zoom towards.
     * @returns {boolean} - True if zoom happened, false otherwise.
     */
    zoom(zoomFactor, mouseX, mouseY) {
        const newScale = this.scale * zoomFactor;

        // Limit zoom range
        if (newScale < 0.01 || newScale > 100) return false;

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
    pan(dx, dy) {
        this.panX += dx;
        this.panY += dy;
    }

    animateZoomAndPan(targetScale, targetPanX, targetPanY, renderCallback) {
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
            }
        };

        animate();
    }

    animatePan(targetPanX, targetPanY, renderCallback) {
        // Set up animation state
        const startPanX = this.panX;
        const startPanY = this.panY;
        const frames = 10;
        let currentFrame = 0;

        const animate = () => {
            currentFrame++;
            const progress = Math.min(currentFrame / frames, 1.0);

            // Ease-out cubic for smooth deceleration
            const easedProgress = 1 - Math.pow(1 - progress, 3);

            // Interpolate pan values
            this.panX = startPanX + (targetPanX - startPanX) * easedProgress;
            this.panY = startPanY + (targetPanY - startPanY) * easedProgress;

            renderCallback();

            if (progress < 1.0) {
                requestAnimationFrame(animate);
            } else {
                // Ensure we end exactly at target
                this.panX = targetPanX;
                this.panY = targetPanY;
                renderCallback();
            }
        };

        animate();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ViewportManager };
}
