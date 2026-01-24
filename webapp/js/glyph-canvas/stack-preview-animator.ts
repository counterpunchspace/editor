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
    targetTiltAngle: number; // Degrees to tilt leftward
    totalFrames: number; // Animation duration in frames
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
    currentFrame: number = 0;

    layerTree: LayerTreeNode[] = [];

    constructor(
        glyphCanvas: GlyphCanvas,
        config?: Partial<StackPreviewConfig>
    ) {
        this.glyphCanvas = glyphCanvas;
        this.config = {
            verticalSpacing: config?.verticalSpacing ?? 500,
            targetTiltAngle: config?.targetTiltAngle ?? 60,
            totalFrames: config?.totalFrames ?? 60
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
        this.currentFrame = 0;

        // Build layer tree from current glyph's layer data
        this.buildLayerTree();

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
        this.currentFrame = 0;

        this.animate();
    }

    /**
     * Animation loop with ease-out cubic easing
     */
    private animate(): void {
        this.currentFrame++;
        const progress = Math.min(
            this.currentFrame / this.config.totalFrames,
            1.0
        );

        // Ease-out cubic: 1 - (1 - t)^3
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        if (this.isReversing) {
            // Animate from current angle back to 0
            this.currentTiltAngle =
                this.config.targetTiltAngle * (1 - easedProgress);
        } else {
            // Animate from 0 to target angle
            this.currentTiltAngle = this.config.targetTiltAngle * easedProgress;
        }

        // Trigger render
        this.glyphCanvas.render();

        if (progress < 1.0) {
            requestAnimationFrame(() => this.animate());
        } else {
            // Animation complete
            this.isAnimating = false;

            if (this.isReversing) {
                // Exit stack preview mode
                this.isActive = false;
                this.currentTiltAngle = 0;
                this.layerTree = [];
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
}
