import { Logger } from '../logger';
import type { Babelfont } from '../babelfont';
import type { GlyphCanvas } from '../glyph-canvas';
import { LayerDataNormalizer } from '../layer-data-normalizer';

const console: Logger = new Logger('StackPreviewAnimator', true);

const IDENTITY_TRANSFORM = [1, 0, 0, 1, 0, 0];

/**
 * Layer tree node representing a single component instance at a nesting level
 */
export interface LayerTreeNode {
    componentLayerData: Babelfont.Layer;
    depth: number;
    transform: number[]; // Accumulated 2D affine transform [a, b, c, d, tx, ty]
    yOffset: number;
}

/**
 * Configuration for stack preview animation
 */
export interface StackPreviewConfig {
    verticalSpacing: number; // Font units per nesting level
    diagonalOffsetAngle: number; // Degrees for diagonal offset direction
    targetTiltAngle: number; // Degrees to tilt leftward (horizontal skew)
    animationDuration: number; // Animation duration in milliseconds
    debugDrawBounds: boolean; // Draw bounding box for debugging
}

/**
 * Manages the stack preview animation for visualizing component nesting
 */
export class StackPreviewAnimator {
    glyphCanvas: GlyphCanvas;
    config: StackPreviewConfig;

    isActive = false;
    isAnimating = false;
    isReversing = false;
    currentTiltAngle = 0;
    animationStartTime = 0;
    layerTree: LayerTreeNode[] = [];

    // Viewport state
    savedPanX = 0;
    savedPanY = 0;
    savedScale = 1;
    targetPanX = 0;
    targetPanY = 0;
    targetScale = 1;

    // Debug visualization
    debugBounds: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null = null;

    constructor(
        glyphCanvas: GlyphCanvas,
        config?: Partial<StackPreviewConfig>
    ) {
        this.glyphCanvas = glyphCanvas;
        this.config = {
            verticalSpacing: config?.verticalSpacing ?? 500,
            diagonalOffsetAngle: config?.diagonalOffsetAngle ?? 45,
            targetTiltAngle: config?.targetTiltAngle ?? 30,
            animationDuration: config?.animationDuration ?? 500,
            debugDrawBounds: config?.debugDrawBounds ?? false
        };
    }

    /** Start forward animation to enter stack preview mode */
    startAnimation(): void {
        if (this.isAnimating) return;

        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;

        this.isActive = true;
        this.isAnimating = true;
        this.isReversing = false;
        this.animationStartTime = performance.now();

        this.savedPanX = viewport.panX;
        this.savedPanY = viewport.panY;
        this.savedScale = viewport.scale;

        this.buildLayerTree();
        this.calculateTargetViewport();
        this.animate();
    }

    /** Start reverse animation to exit stack preview mode */
    reverseAnimation(): void {
        if (this.isAnimating && this.isReversing) return;

        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;

        this.isAnimating = true;
        this.isReversing = true;
        this.animationStartTime = performance.now();

        this.targetPanX = viewport.panX;
        this.targetPanY = viewport.panY;
        this.targetScale = viewport.scale;

        this.animate();
    }

    /** Animation loop with easing */
    private animate(): void {
        const elapsed = performance.now() - this.animationStartTime;
        const progress = Math.min(elapsed / this.config.animationDuration, 1.0);

        // Forward: ease-out cubic, Reverse: ease-in cubic (mirrors opening)
        const t = this.isReversing
            ? Math.pow(progress, 3)
            : 1 - Math.pow(1 - progress, 3);

        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;

        if (this.isReversing) {
            this.currentTiltAngle = this.config.targetTiltAngle * (1 - t);
            viewport.panX =
                this.targetPanX + (this.savedPanX - this.targetPanX) * t;
            viewport.panY =
                this.targetPanY + (this.savedPanY - this.targetPanY) * t;
            viewport.scale =
                this.targetScale + (this.savedScale - this.targetScale) * t;
        } else {
            this.currentTiltAngle = this.config.targetTiltAngle * t;
            viewport.panX =
                this.savedPanX + (this.targetPanX - this.savedPanX) * t;
            viewport.panY =
                this.savedPanY + (this.targetPanY - this.savedPanY) * t;
            viewport.scale =
                this.savedScale + (this.targetScale - this.savedScale) * t;
        }

        this.glyphCanvas.render();

        if (progress < 1.0) {
            requestAnimationFrame(() => this.animate());
        } else {
            this.isAnimating = false;
            if (this.isReversing) {
                this.isActive = false;
                this.currentTiltAngle = 0;
                this.layerTree = [];
                viewport.panX = this.savedPanX;
                viewport.panY = this.savedPanY;
                viewport.scale = this.savedScale;
            }
            this.glyphCanvas.render();
        }
    }

    /** Build layer tree by recursively traversing all component instances */
    buildLayerTree(): void {
        this.layerTree = [];

        const layerData = this.glyphCanvas.outlineEditor.layerData;
        if (!layerData?.shapes) return;

        this.layerTree.push({
            componentLayerData: layerData,
            depth: 0,
            transform: IDENTITY_TRANSFORM,
            yOffset: 0
        });

        this.processComponents(layerData.shapes, IDENTITY_TRANSFORM, 1);
    }

    /** Recursively process component shapes and add instances to layer tree */
    private processComponents(
        shapes: Babelfont.Shape[],
        accumulatedTransform: number[],
        depth: number
    ): void {
        for (const shape of shapes) {
            if (!('Component' in shape) || !shape.Component) continue;

            const componentTransform =
                shape.Component.transform || IDENTITY_TRANSFORM;
            const newTransform = this.multiplyMatrices(
                accumulatedTransform,
                componentTransform
            );
            const componentLayerData = shape.Component.layerData;

            if (componentLayerData?.shapes) {
                this.layerTree.push({
                    componentLayerData,
                    depth,
                    transform: newTransform,
                    yOffset: depth * this.config.verticalSpacing
                });
                this.processComponents(
                    componentLayerData.shapes,
                    newTransform,
                    depth + 1
                );
            }
        }
    }

    /** Multiply two 2D affine transformation matrices [a, b, c, d, tx, ty] */
    private multiplyMatrices(m1: number[], m2: number[]): number[] {
        return [
            m1[0] * m2[0] + m1[2] * m2[1],
            m1[1] * m2[0] + m1[3] * m2[1],
            m1[0] * m2[2] + m1[2] * m2[3],
            m1[1] * m2[2] + m1[3] * m2[3],
            m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
            m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
        ];
    }

    /** Transform point using affine matrix */
    private transformPoint(
        x: number,
        y: number,
        m: number[]
    ): { x: number; y: number } {
        return {
            x: m[0] * x + m[2] * y + m[4],
            y: m[1] * x + m[3] * y + m[5]
        };
    }

    getTiltAngleRadians(): number {
        return (this.currentTiltAngle * Math.PI) / 180;
    }

    isInputBlocked(): boolean {
        return this.isAnimating;
    }

    shouldRenderStackPreview(): boolean {
        return this.isActive && this.layerTree.length > 0;
    }

    /** Calculate target viewport (pan/zoom) to fit the entire stack */
    private calculateTargetViewport(): void {
        if (this.layerTree.length === 0) {
            this.targetPanX = this.savedPanX;
            this.targetPanY = this.savedPanY;
            this.targetScale = this.savedScale;
            return;
        }

        const textRunEditor = this.glyphCanvas.textRunEditor;
        if (
            !textRunEditor ||
            textRunEditor.selectedGlyphIndex < 0 ||
            textRunEditor.selectedGlyphIndex >=
                textRunEditor.shapedGlyphs.length
        ) {
            this.targetPanX = this.savedPanX;
            this.targetPanY = this.savedPanY;
            this.targetScale = this.savedScale;
            return;
        }

        // Calculate base glyph position
        let xPosition = 0;
        for (let i = 0; i < textRunEditor.selectedGlyphIndex; i++) {
            xPosition += textRunEditor.shapedGlyphs[i].ax || 0;
        }
        const glyph =
            textRunEditor.shapedGlyphs[textRunEditor.selectedGlyphIndex];
        const baseX = xPosition + (glyph.dx || 0);
        const baseY = glyph.dy || 0;

        const diagonalAngleRad =
            (this.config.diagonalOffsetAngle * Math.PI) / 180;
        const bounds = this.calculateStackBounds(
            baseX,
            baseY,
            diagonalAngleRad
        );

        this.debugBounds = { ...bounds };

        // Apply tilt to get screen-space bounds
        const tiltAngleRad = (this.config.targetTiltAngle * Math.PI) / 180;
        const tanTilt = Math.tan(tiltAngleRad);

        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.minX, y: bounds.maxY },
            { x: bounds.maxX, y: bounds.maxY }
        ];

        let skewedMinX = Infinity,
            skewedMaxX = -Infinity;
        for (const c of corners) {
            const skewedX = c.x + c.y * tanTilt;
            skewedMinX = Math.min(skewedMinX, skewedX);
            skewedMaxX = Math.max(skewedMaxX, skewedX);
        }

        // Add padding
        const padding = 100;
        skewedMinX -= padding;
        skewedMaxX += padding;
        bounds.minY -= padding;
        bounds.maxY += padding;

        // Get canvas dimensions (CSS pixels)
        const canvas = this.glyphCanvas.canvas;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = canvas.width / dpr;
        const canvasHeight = canvas.height / dpr;

        const margin = 40;
        const availableWidth = canvasWidth - 2 * margin;
        const availableHeight = canvasHeight - 2 * margin;

        const stackWidth = skewedMaxX - skewedMinX;
        const stackHeight = bounds.maxY - bounds.minY;

        this.targetScale = Math.min(
            availableWidth / stackWidth,
            availableHeight / stackHeight
        );

        // Center calculation with skew compensation
        const stackCenterX = (bounds.minX + bounds.maxX) / 2;
        const stackCenterY = (bounds.minY + bounds.maxY) / 2;
        const skewedCenterX = stackCenterX - stackCenterY * tanTilt;

        this.targetPanX = canvasWidth / 2 - this.targetScale * skewedCenterX;
        this.targetPanY = canvasHeight / 2 + this.targetScale * stackCenterY;
    }

    /** Calculate bounds of entire stack in font coordinates */
    private calculateStackBounds(
        baseX: number,
        baseY: number,
        diagonalAngleRad: number
    ): { minX: number; minY: number; maxX: number; maxY: number } {
        const bounds = {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        };

        for (const node of this.layerTree) {
            const layerData = node.componentLayerData;
            if (!layerData?.shapes) continue;

            const offsetDistance = node.depth * this.config.verticalSpacing;
            const diagXOffset = offsetDistance * Math.cos(diagonalAngleRad);
            const diagYOffset = offsetDistance * Math.sin(diagonalAngleRad);

            this.addShapeBounds(
                layerData.shapes,
                node.transform,
                baseX,
                baseY,
                diagXOffset,
                diagYOffset,
                bounds
            );
        }

        return bounds;
    }

    /** Add bounds from shapes (paths and components) */
    private addShapeBounds(
        shapes: Babelfont.Shape[],
        transform: number[],
        baseX: number,
        baseY: number,
        diagXOffset: number,
        diagYOffset: number,
        bounds: { minX: number; minY: number; maxX: number; maxY: number }
    ): void {
        for (const shape of shapes) {
            if ('Component' in shape && shape.Component) {
                const compTransform =
                    shape.Component.transform || IDENTITY_TRANSFORM;
                const combinedTransform = this.multiplyMatrices(
                    transform,
                    compTransform
                );
                const compLayerData = shape.Component.layerData;
                if (compLayerData?.shapes) {
                    this.addShapeBounds(
                        compLayerData.shapes,
                        combinedTransform,
                        baseX,
                        baseY,
                        diagXOffset,
                        diagYOffset,
                        bounds
                    );
                }
                continue;
            }

            let nodes = 'nodes' in shape ? (shape as any).nodes : undefined;
            if (!nodes && 'Path' in shape && shape.Path.nodes) {
                nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            }

            if (nodes?.length) {
                for (const n of nodes) {
                    const p = this.transformPoint(n.x, n.y, transform);
                    const worldX = p.x + baseX + diagXOffset;
                    const worldY = p.y + baseY + diagYOffset;
                    bounds.minX = Math.min(bounds.minX, worldX);
                    bounds.maxX = Math.max(bounds.maxX, worldX);
                    bounds.minY = Math.min(bounds.minY, worldY);
                    bounds.maxY = Math.max(bounds.maxY, worldY);
                }
            }
        }
    }
}
