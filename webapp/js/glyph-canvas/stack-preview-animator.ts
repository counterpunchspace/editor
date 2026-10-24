import { Logger } from '../logger';
import type { Babelfont } from '../babelfont';
import type { GlyphCanvas } from '../glyph-canvas';
import {
    createIdentityAffine,
    flattenShapesToPaths,
    multiplyAffineTransforms,
    normalizeAffineTransform
} from '../glyph-path-geometry';
import { LayerDataNormalizer } from '../layer-data-normalizer';

const console: Logger = new Logger('StackPreviewAnimator');

const IDENTITY_TRANSFORM = createIdentityAffine();

/**
 * Layer tree node representing a single component instance at a nesting level
 */
export interface LayerTreeNode {
    componentLayerData: Babelfont.Layer;
    glyphName: string;
    depth: number;
    transform: number[]; // Accumulated 2D affine transform [a, b, c, d, tx, ty]
    yOffset: number;
    componentPath: number[];
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
    hoveredLayerTreeIndex: number | null = null;
    highlightedLayerTreeIndex: number | null = null;
    highlightedComponentPath: number[] = [];
    transitionTargetComponentPath: number[] | null = null;
    private reverseCompletionCallbacks: Array<() => void> = [];

    // Viewport state
    savedPanX = 0;
    savedPanY = 0;
    savedScale = 1;
    targetPanX = 0;
    targetPanY = 0;
    targetScale = 1;
    cmdZeroViewportTarget: {
        scale: number;
        panX: number;
        panY: number;
    } | null = null;

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
        this.hoveredLayerTreeIndex = null;
        this.highlightedComponentPath = this.getCurrentGlyphStackPath();
        this.highlightedLayerTreeIndex = null;
        this.transitionTargetComponentPath = null;
        this.cmdZeroViewportTarget =
            this.glyphCanvas.getCmdZeroViewportTarget();
        this.animationStartTime = performance.now();

        this.savedPanX = viewport.panX;
        this.savedPanY = viewport.panY;
        this.savedScale = viewport.scale;

        this.buildLayerTree();
        this.calculateTargetViewport();
        this.animate();
    }

    /** Start reverse animation to exit stack preview mode */
    reverseAnimation(
        onComplete?: () => void,
        transitionTargetComponentPath: number[] | null = null
    ): void {
        if (onComplete) {
            this.reverseCompletionCallbacks.push(onComplete);
        }

        this.transitionTargetComponentPath = transitionTargetComponentPath
            ? [...transitionTargetComponentPath]
            : null;

        if (this.transitionTargetComponentPath) {
            this.highlightedComponentPath = [
                ...this.transitionTargetComponentPath
            ];
            if (this.layerTree.length > 0) {
                this.resolveHighlightedLayerTreeIndex();
            }
        }

        if (this.isAnimating && this.isReversing) return;

        const viewport = this.glyphCanvas.viewportManager;
        if (!viewport) {
            this.flushReverseCompletionCallbacks();
            return;
        }

        if (!this.isActive && !this.isAnimating) {
            this.flushReverseCompletionCallbacks();
            return;
        }

        this.isAnimating = true;
        this.isReversing = true;
        this.hoveredLayerTreeIndex = null;
        this.animationStartTime = performance.now();

        if (this.cmdZeroViewportTarget) {
            this.savedPanX = this.cmdZeroViewportTarget.panX;
            this.savedPanY = this.cmdZeroViewportTarget.panY;
            this.savedScale = this.cmdZeroViewportTarget.scale;
        }

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
                this.hoveredLayerTreeIndex = null;
                this.highlightedLayerTreeIndex = null;
                this.highlightedComponentPath = [];
                this.transitionTargetComponentPath = null;
                this.cmdZeroViewportTarget = null;
                viewport.panX = this.savedPanX;
                viewport.panY = this.savedPanY;
                viewport.scale = this.savedScale;
                this.flushReverseCompletionCallbacks();
            }
            this.glyphCanvas.render();
        }
    }

    private flushReverseCompletionCallbacks(): void {
        if (this.reverseCompletionCallbacks.length === 0) {
            return;
        }
        const callbacks = [...this.reverseCompletionCallbacks];
        this.reverseCompletionCallbacks = [];
        for (const callback of callbacks) {
            callback();
        }
    }

    /** Build layer tree by recursively traversing all component instances */
    buildLayerTree(): void {
        this.layerTree = [];

        const layerData = this.glyphCanvas.outlineEditor.layerData;
        if (!layerData?.shapes) return;

        this.layerTree.push({
            componentLayerData: layerData,
            glyphName: this.glyphCanvas.getCurrentGlyphName(),
            depth: 0,
            transform: IDENTITY_TRANSFORM,
            yOffset: 0,
            componentPath: []
        });

        this.processComponents(layerData.shapes, IDENTITY_TRANSFORM, 1, []);
        this.resolveHighlightedLayerTreeIndex();
    }

    private getCurrentGlyphStackPath(): number[] {
        const parsed = this.glyphCanvas.outlineEditor.parseGlyphStack();
        if (parsed.length === 0) {
            return [];
        }

        const componentPath: number[] = [];
        for (const item of parsed) {
            if (item.componentIndex === undefined) {
                continue;
            }
            componentPath.push(item.componentIndex);
        }
        return componentPath;
    }

    private resolveHighlightedLayerTreeIndex(): void {
        const targetPath = this.highlightedComponentPath;
        this.highlightedLayerTreeIndex = this.layerTree.findIndex((node) => {
            if (node.componentPath.length !== targetPath.length) {
                return false;
            }
            for (let i = 0; i < targetPath.length; i++) {
                if (node.componentPath[i] !== targetPath[i]) {
                    return false;
                }
            }
            return true;
        });

        if (this.highlightedLayerTreeIndex < 0) {
            this.highlightedLayerTreeIndex = 0;
        }
    }

    /** Recursively process component shapes and add instances to layer tree */
    private processComponents(
        shapes: Babelfont.Shape[],
        accumulatedTransform: number[],
        depth: number,
        componentPath: number[]
    ): void {
        for (let index = 0; index < shapes.length; index++) {
            const shape = shapes[index];
            // Unwrapped format: Component has 'reference' field
            if (!('reference' in shape)) continue;

            const compTransform =
                (shape as any).transform || IDENTITY_TRANSFORM;
            const transformArray = normalizeAffineTransform(compTransform);
            const newTransform = multiplyAffineTransforms(
                accumulatedTransform,
                transformArray
            );
            const componentLayerData = (shape as any).layerData;
            const nextPath = [...componentPath, index];

            if (componentLayerData?.shapes) {
                this.layerTree.push({
                    componentLayerData,
                    glyphName: (shape as any).reference,
                    depth,
                    transform: newTransform,
                    yOffset: depth * this.config.verticalSpacing,
                    componentPath: nextPath
                });
                this.processComponents(
                    componentLayerData.shapes,
                    newTransform,
                    depth + 1,
                    nextPath
                );
            }
        }
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

        const position = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const baseX = position.xPosition + position.xOffset;
        const baseY = position.yOffset;

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

        // Usable camera box (canvas minus overlay property panel)
        const canvas = this.glyphCanvas.canvas;
        if (!canvas) return;
        const frame = this.glyphCanvas.getCanvasContentFrame?.();
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth =
            frame && frame.width > 0 ? frame.width : canvas.width / dpr;
        const canvasHeight =
            frame && frame.height > 0 ? frame.height : canvas.height / dpr;
        const frameLeft = frame && frame.width > 0 ? frame.left : 0;
        const frameTop = frame && frame.height > 0 ? frame.top : 0;

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

        this.targetPanX =
            frameLeft + canvasWidth / 2 - this.targetScale * skewedCenterX;
        this.targetPanY =
            frameTop + canvasHeight / 2 + this.targetScale * stackCenterY;
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
        for (const path of flattenShapesToPaths(shapes, transform)) {
            for (const node of path.nodes) {
                const worldX = node.x + baseX + diagXOffset;
                const worldY = node.y + baseY + diagYOffset;
                bounds.minX = Math.min(bounds.minX, worldX);
                bounds.maxX = Math.max(bounds.maxX, worldX);
                bounds.minY = Math.min(bounds.minY, worldY);
                bounds.maxY = Math.max(bounds.maxY, worldY);
            }
        }
    }
}
