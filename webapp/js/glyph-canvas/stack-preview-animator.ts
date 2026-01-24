import { Logger } from '../logger';
import type { Babelfont } from '../babelfont';
import type { GlyphCanvas } from '../glyph-canvas';

let console: Logger = new Logger('StackPreviewAnimator', true);

/**
 * Layer tree node representing a single component instance at a nesting level
 */
export interface LayerTreeNode {
    componentLayerData: Babelfont.Layer; // The component's layer data to render
    depth: number;
    transform: number[]; // Accumulated 2D affine transform [a, b, c, d, tx, ty]
    yOffset: number; // Vertical offset in font units
}

/**
 * Configuration for stack preview animation
 */
export interface StackPreviewConfig {
    verticalSpacing: number; // Font units per nesting level
    diagonalOffsetAngle: number; // Degrees for diagonal offset direction (45° = top-right)
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

    isActive: boolean = false;
    isAnimating: boolean = false;
    isReversing: boolean = false;

    currentTiltAngle: number = 0; // Current tilt angle in degrees
    animationStartTime: number = 0;

    layerTree: LayerTreeNode[] = [];

    // Saved viewport state for returning after stack preview
    savedPanX: number = 0;
    savedPanY: number = 0;
    savedScale: number = 1;

    // Target viewport state for fitting stack
    targetPanX: number = 0;
    targetPanY: number = 0;
    targetScale: number = 1;

    // Debug: calculated bounds for visualization
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

    /**
     * Start forward animation to enter stack preview mode
     */
    startAnimation(): void {
        if (this.isAnimating) return;

        console.log('[StackPreview] Starting forward animation');
        this.isActive = true;
        this.isAnimating = true;
        this.isReversing = false;
        this.animationStartTime = performance.now();

        // Save current viewport state
        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;
        this.savedPanX = viewport.panX;
        this.savedPanY = viewport.panY;
        this.savedScale = viewport.scale;

        // Build layer tree from current glyph's layer data
        this.buildLayerTree();

        // Calculate target viewport to fit the entire stack
        this.calculateTargetViewport();

        this.animate();
    }

    /**
     * Start reverse animation to exit stack preview mode
     */
    reverseAnimation(): void {
        if (this.isAnimating && this.isReversing) return;

        console.log('[StackPreview] Starting reverse animation');
        this.isAnimating = true;
        this.isReversing = true;
        this.animationStartTime = performance.now();

        // Capture current viewport state (user might have panned/zoomed while in stack preview)
        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;
        this.targetPanX = viewport.panX;
        this.targetPanY = viewport.panY;
        this.targetScale = viewport.scale;

        this.animate();
    }

    /**
     * Animation loop with easing
     */
    private animate(): void {
        const elapsed = performance.now() - this.animationStartTime;
        const progress = Math.min(elapsed / this.config.animationDuration, 1.0);

        // Use different easing for forward vs reverse
        // Forward: ease-out cubic (fast start, slow end)
        // Reverse: ease-in cubic (slow start, fast end) - mirrors the opening
        const easedProgress = this.isReversing
            ? Math.pow(progress, 3) // ease-in cubic: t^3
            : 1 - Math.pow(1 - progress, 3); // ease-out cubic: 1 - (1-t)^3

        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) return;

        if (this.isReversing) {
            // Animate from current angle back to 0
            this.currentTiltAngle =
                this.config.targetTiltAngle * (1 - easedProgress);

            // Interpolate from current viewport (targetPan/Scale) to saved viewport
            viewport.panX =
                this.targetPanX +
                (this.savedPanX - this.targetPanX) * easedProgress;
            viewport.panY =
                this.targetPanY +
                (this.savedPanY - this.targetPanY) * easedProgress;
            viewport.scale =
                this.targetScale +
                (this.savedScale - this.targetScale) * easedProgress;
        } else {
            // Animate from 0 to target angle
            this.currentTiltAngle = this.config.targetTiltAngle * easedProgress;

            // Interpolate from saved viewport to target viewport (to fit stack)
            viewport.panX =
                this.savedPanX +
                (this.targetPanX - this.savedPanX) * easedProgress;
            viewport.panY =
                this.savedPanY +
                (this.targetPanY - this.savedPanY) * easedProgress;
            viewport.scale =
                this.savedScale +
                (this.targetScale - this.savedScale) * easedProgress;
        }

        // Trigger render
        this.glyphCanvas.render();

        if (progress < 1.0) {
            requestAnimationFrame(() => this.animate());
        } else {
            // Animation complete
            this.isAnimating = false;

            if (this.isReversing) {
                // Exit stack preview mode and restore viewport
                this.isActive = false;
                this.currentTiltAngle = 0;
                this.layerTree = [];
                viewport.panX = this.savedPanX;
                viewport.panY = this.savedPanY;
                viewport.scale = this.savedScale;
                console.log('[StackPreview] Animation complete, mode exited');
            } else {
                console.log('[StackPreview] Forward animation complete');
            }

            this.glyphCanvas.render();
        }
    }

    /**
     * Build layer tree by recursively traversing ALL component instances
     */
    buildLayerTree(): void {
        this.layerTree = [];

        const layerData = this.glyphCanvas.outlineEditor.layerData;
        if (!layerData || !layerData.shapes) {
            console.log('[StackPreview] No layer data to build tree from');
            return;
        }

        // Add base layer (depth 0) - the glyph being edited
        this.layerTree.push({
            componentLayerData: layerData,
            depth: 0,
            transform: [1, 0, 0, 1, 0, 0], // Identity transform
            yOffset: 0
        });

        // Recursively process all components starting from depth 1
        this.processComponents(layerData.shapes, [1, 0, 0, 1, 0, 0], 1);

        console.log(
            '[StackPreview] Built layer tree with',
            this.layerTree.length,
            'component instances'
        );
    }

    /**
     * Recursively process component shapes and add ALL instances to layer tree
     */
    private processComponents(
        shapes: Babelfont.Shape[],
        accumulatedTransform: number[],
        depth: number
    ): void {
        for (const shape of shapes) {
            if ('Component' in shape && shape.Component) {
                const componentTransform = shape.Component.transform || [
                    1, 0, 0, 1, 0, 0
                ];

                // Multiply accumulated transform with component transform
                const newTransform = this.multiplyMatrices(
                    accumulatedTransform,
                    componentTransform
                );

                // Get component's layer data
                const componentLayerData = shape.Component.layerData;
                if (componentLayerData && componentLayerData.shapes) {
                    // Add this component INSTANCE to the tree
                    // Store the FULL accumulated transform (including this component's transform)
                    const yOffset = depth * this.config.verticalSpacing;

                    this.layerTree.push({
                        componentLayerData: componentLayerData,
                        depth: depth,
                        transform: newTransform, // Full accumulated transform
                        yOffset: yOffset
                    });

                    // Recursively process nested components with the accumulated transform
                    this.processComponents(
                        componentLayerData.shapes,
                        newTransform,
                        depth + 1
                    );
                }
            }
        }
    }

    /**
     * Multiply two 2D affine transformation matrices
     * Matrix format: [a, b, c, d, tx, ty]
     */
    private multiplyMatrices(m1: number[], m2: number[]): number[] {
        return [
            m1[0] * m2[0] + m1[2] * m2[1], // a
            m1[1] * m2[0] + m1[3] * m2[1], // b
            m1[0] * m2[2] + m1[2] * m2[3], // c
            m1[1] * m2[2] + m1[3] * m2[3], // d
            m1[0] * m2[4] + m1[2] * m2[5] + m1[4], // tx
            m1[1] * m2[4] + m1[3] * m2[5] + m1[5] // ty
        ];
    }

    /**
     * Get current tilt angle in radians
     */
    getTiltAngleRadians(): number {
        return (this.currentTiltAngle * Math.PI) / 180;
    }

    /**
     * Check if input should be blocked (during animation)
     */
    isInputBlocked(): boolean {
        return this.isAnimating;
    }

    /**
     * Check if we should render in stack preview mode
     */
    shouldRenderStackPreview(): boolean {
        return this.isActive && this.layerTree.length > 0;
    }

    /**
     * Calculate target viewport (pan/zoom) to fit the entire stack
     */
    private calculateTargetViewport(): void {
        if (this.layerTree.length === 0) {
            this.targetPanX = this.savedPanX;
            this.targetPanY = this.savedPanY;
            this.targetScale = this.savedScale;
            return;
        }

        // Get selected glyph position
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

        let xPosition = 0;
        for (let i = 0; i < textRunEditor.selectedGlyphIndex; i++) {
            xPosition += textRunEditor.shapedGlyphs[i].ax || 0;
        }

        const glyph =
            textRunEditor.shapedGlyphs[textRunEditor.selectedGlyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const baseX = xPosition + xOffset;
        const baseY = yOffset;

        // Calculate diagonal angle in radians
        const diagonalAngleRad =
            (this.config.diagonalOffsetAngle * Math.PI) / 180;

        // Find bounds of all layers in the stack (at full animation)
        const bounds = {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        };

        // Also track base layer (depth 0) bounds separately for anchoring
        const baseBounds = {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        };

        this.layerTree.forEach((node) => {
            const layerData = node.componentLayerData;
            if (!layerData || !layerData.shapes) return;

            // Calculate position with full diagonal offset
            const offsetDistance = node.depth * this.config.verticalSpacing;
            const diagXOffset = offsetDistance * Math.cos(diagonalAngleRad);
            const diagYOffset = offsetDistance * Math.sin(diagonalAngleRad);

            // Get rough bounds for this layer (checking all path nodes and component shapes)
            layerData.shapes.forEach((shape: any) => {
                if ('Component' in shape && shape.Component) {
                    // Process component shapes recursively with component transform
                    const compTransform = shape.Component.transform || [
                        1, 0, 0, 1, 0, 0
                    ];
                    const compLayerData = shape.Component.layerData;
                    if (compLayerData && compLayerData.shapes) {
                        this.addComponentBounds(
                            compLayerData.shapes,
                            node.transform,
                            compTransform,
                            baseX,
                            baseY,
                            diagXOffset,
                            diagYOffset,
                            bounds
                        );
                        // Also add to base bounds if depth 0
                        if (node.depth === 0) {
                            this.addComponentBounds(
                                compLayerData.shapes,
                                node.transform,
                                compTransform,
                                baseX,
                                baseY,
                                diagXOffset,
                                diagYOffset,
                                baseBounds
                            );
                        }
                    }
                    return;
                }

                let nodes = 'nodes' in shape ? shape.nodes : undefined;
                if (!nodes && 'Path' in shape && shape.Path.nodes) {
                    const LayerDataNormalizer =
                        require('../layer-data-normalizer').LayerDataNormalizer;
                    nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
                }

                if (nodes && nodes.length > 0) {
                    nodes.forEach((n: any) => {
                        // Transform to world coordinates
                        const worldX =
                            node.transform[0] * n.x +
                            node.transform[2] * n.y +
                            node.transform[4] +
                            baseX +
                            diagXOffset;
                        const worldY =
                            node.transform[1] * n.x +
                            node.transform[3] * n.y +
                            node.transform[5] +
                            baseY +
                            diagYOffset;

                        bounds.minX = Math.min(bounds.minX, worldX);
                        bounds.maxX = Math.max(bounds.maxX, worldX);
                        bounds.minY = Math.min(bounds.minY, worldY);
                        bounds.maxY = Math.max(bounds.maxY, worldY);

                        // Also add to base bounds if depth 0
                        if (node.depth === 0) {
                            baseBounds.minX = Math.min(baseBounds.minX, worldX);
                            baseBounds.maxX = Math.max(baseBounds.maxX, worldX);
                            baseBounds.minY = Math.min(baseBounds.minY, worldY);
                            baseBounds.maxY = Math.max(baseBounds.maxY, worldY);
                        }
                    });
                }
            });
        });

        // Store bounds for debug visualization
        this.debugBounds = {
            minX: bounds.minX,
            minY: bounds.minY,
            maxX: bounds.maxX,
            maxY: bounds.maxY
        };

        // Calculate viewport

        // Apply tilt transformation to bounds to get actual screen-space bounds
        // Horizontal skew: x' = x + y * tan(angle)
        const tiltAngleRad = (this.config.targetTiltAngle * Math.PI) / 180;
        const tanTilt = Math.tan(tiltAngleRad);

        // Transform all four corners and find new bounds
        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.minX, y: bounds.maxY },
            { x: bounds.maxX, y: bounds.maxY }
        ];

        let skewedMinX = Infinity;
        let skewedMaxX = -Infinity;
        corners.forEach((c) => {
            const skewedX = c.x + c.y * tanTilt;
            skewedMinX = Math.min(skewedMinX, skewedX);
            skewedMaxX = Math.max(skewedMaxX, skewedX);
        });

        // Add padding
        const padding = 100;
        skewedMinX -= padding;
        bounds.minY -= padding;
        skewedMaxX += padding;
        bounds.maxY += padding;

        // Get canvas dimensions (in CSS pixels, not device pixels)
        const canvas = this.glyphCanvas.canvas;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = canvas.width / dpr;
        const canvasHeight = canvas.height / dpr;

        // Add margin for UI frame
        const margin = 40;
        const availableWidth = canvasWidth - 2 * margin;
        const availableHeight = canvasHeight - 2 * margin;

        // Calculate stack size in screen units (after skew)
        const stackWidth = skewedMaxX - skewedMinX;
        const stackHeight = bounds.maxY - bounds.minY;

        // Calculate what scale would be needed to FIT the stack in the viewport
        const scaleToFitX = availableWidth / stackWidth;
        const scaleToFitY = availableHeight / stackHeight;
        const scaleToFit = Math.min(scaleToFitX, scaleToFitY);

        // Fit the stack to viewport (zoom in or out as needed)
        this.targetScale = scaleToFit;

        // Calculate center of full stack in font coordinates
        const stackCenterX = (bounds.minX + bounds.maxX) / 2;
        const stackCenterY = (bounds.minY + bounds.maxY) / 2;

        // The skew transform shifts X based on Y: x' = x - y * tan(angle) (left tilt)
        // So the center point in skewed space is:
        const skewedCenterX = stackCenterX - stackCenterY * tanTilt;

        // Center the skewed stack in the canvas
        this.targetPanX = canvasWidth / 2 - this.targetScale * skewedCenterX;
        this.targetPanY = canvasHeight / 2 + this.targetScale * stackCenterY;

        console.log('[StackPreview] Calculated target viewport:', {
            bounds: {
                minX: bounds.minX,
                minY: bounds.minY,
                maxX: bounds.maxX,
                maxY: bounds.maxY
            },
            stackSize: { width: stackWidth, height: stackHeight },
            scaleToFit,
            currentScale: this.savedScale,
            targetScale: this.targetScale,
            action:
                this.targetScale < this.savedScale ? 'zoom out' : 'keep zoom'
        });
    }

    /**
     * Recursively add bounds from component shapes
     */
    private addComponentBounds(
        shapes: any[],
        parentTransform: number[],
        componentTransform: number[],
        baseX: number,
        baseY: number,
        diagXOffset: number,
        diagYOffset: number,
        bounds: { minX: number; minY: number; maxX: number; maxY: number }
    ): void {
        // Combine parent transform with component transform
        const combinedTransform = this.multiplyMatrices(
            parentTransform,
            componentTransform
        );

        shapes.forEach((shape: any) => {
            if ('Component' in shape && shape.Component) {
                // Recursively process nested components
                const nestedCompTransform = shape.Component.transform || [
                    1, 0, 0, 1, 0, 0
                ];
                const nestedLayerData = shape.Component.layerData;
                if (nestedLayerData && nestedLayerData.shapes) {
                    this.addComponentBounds(
                        nestedLayerData.shapes,
                        combinedTransform,
                        nestedCompTransform,
                        baseX,
                        baseY,
                        diagXOffset,
                        diagYOffset,
                        bounds
                    );
                }
                return;
            }

            let nodes = 'nodes' in shape ? shape.nodes : undefined;
            if (!nodes && 'Path' in shape && shape.Path.nodes) {
                const LayerDataNormalizer =
                    require('../layer-data-normalizer').LayerDataNormalizer;
                nodes = LayerDataNormalizer.parseNodes(shape.Path.nodes);
            }

            if (nodes && nodes.length > 0) {
                nodes.forEach((n: any) => {
                    // Transform to world coordinates with combined transform
                    const worldX =
                        combinedTransform[0] * n.x +
                        combinedTransform[2] * n.y +
                        combinedTransform[4] +
                        baseX +
                        diagXOffset;
                    const worldY =
                        combinedTransform[1] * n.x +
                        combinedTransform[3] * n.y +
                        combinedTransform[5] +
                        baseY +
                        diagYOffset;

                    bounds.minX = Math.min(bounds.minX, worldX);
                    bounds.maxX = Math.max(bounds.maxX, worldX);
                    bounds.minY = Math.min(bounds.minY, worldY);
                    bounds.maxY = Math.max(bounds.maxY, worldY);
                });
            }
        });
    }
}
