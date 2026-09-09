// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

import {
    getHighestVisibleVerticalMetricValue,
    getLowestVisibleVerticalMetricValue
} from './glyph-canvas/vertical-metrics';
import { AxesManager } from './glyph-canvas/variations';
import { FeaturesManager } from './glyph-canvas/features';
import { TextRunEditor } from './glyph-canvas/textrun';
import { userTextBufferHasBeenWritten } from './glyph-canvas/text-buffer-session';
import { lineBaselineY } from './glyph-canvas/text-run-layout';
import { textLayoutControls } from './glyph-canvas/text-layout-controls';
import {
    MAX_VIEWPORT_SCALE,
    MIN_VIEWPORT_SCALE
} from './glyph-canvas/point-size';
import {
    applyFontPointScreenLock,
    ViewportManager,
    viewportFrameBottom,
    viewportFrameCenterX,
    viewportFrameCenterY,
    viewportFrameRight,
    type ViewportFrame
} from './glyph-canvas/viewport';
import { GlyphCanvasRenderer } from './glyph-canvas/renderer';
import {
    FeatureChangeAnimator,
    snapshotShapedRun
} from './glyph-canvas/feature-change-animator';
import { MeasurementTool } from './glyph-canvas/measurement-tool';
import { StackPreviewAnimator } from './glyph-canvas/stack-preview-animator';
import { get_glyph_name } from '../wasm-dist/babelfont_fontc_web';
import fontManager from './font-manager';
import { OutlineEditor } from './glyph-canvas/outline-editor';
import {
    applyKerningGroupMembership,
    buildEditViewKerningGroupSide,
    collectKerningGroupMemberships,
    formatKerningGroupKindLabel,
    formatKerningOperandLabel,
    formatTextModeKerningSideTitle,
    renderKerningGroupWidget,
    type KerningGroupChip
} from './glyph-canvas/kerning-group-widget';
import { Logger } from './logger';
import { editorHealth } from './editor-health-monitor';
import APP_SETTINGS from './settings';
import { attachTopRowSidebarInterpolation } from './top-row-sidebar-interpolation';
import {
    isStartupStateReady,
    reapplyStartupCursorIfNeeded
} from './state-restore';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import {
    Anchor,
    Component,
    DecomposedAffineTransform,
    FeatureVariationGlyph,
    Glyph,
    Guide,
    Layer,
    Master,
    withSuppressedModelRecording
} from './babelfont-model';
import { updateUrlState, encodeLocation } from './url-state';
import { isSyncEnabled } from './state-sync';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { SavedVariationState } from './saved-variation-state';
import { ArrowAdjustableTextInput } from './arrow-adjustable-text-input';
import { LayerDataNormalizer } from './layer-data-normalizer';
import {
    buildOrderedKerningPairs,
    getKerningPairValue,
    getOrderedKerningPairKey,
    setKerningPairValueOnMaster,
    type KerningContainer
} from './kerning-utils';
import { KeyboardPreviewEditFunnel } from './keyboard-preview-edit-funnel';
import { getPreviewArea } from './editor-preview-area-pref';
import tippy from 'tippy.js';
import {
    applyPasteGlyphsDocument,
    buildGlyphsClipboardDocument,
    buildFontraAxisNameByKey,
    collectClipboardPayloads,
    describePasteResult,
    isTaggedStructuredClipboard,
    parseClipboardPayloads,
    classifyClipboardPayloads,
    readClipboardPayloadsAsync,
    mergeClipboardPayloads,
    serializeFontMastersForClipboard,
    serializeGlyphForClipboard,
    serializePathForClipboard,
    summarizeClipboardDocument,
    writeClipboardDocumentAsync,
    writeClipboardDocumentToDataTransfer,
    type ClipboardPasteKind,
    type ParsedClipboard,
    type PasteGlyphsDocument
} from './clipboard';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import {
    applyLiveSidebearingVisualSync,
    syncModelSidebearingEditToCanvas
} from './sidebearing-utils';
import { getUndoRedoContext } from './undo-redo-context';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { getCommittedChangeRefreshPromise } from './change-bridge-init';
import { recordLiveTextDiagnostic } from './live-text-diagnostics';
import { QA_CORPUS_READY_EVENT } from './auto-qa/auto-qa-corpus';
import { labelsForGlyph } from './auto-qa/auto-qa-matcher';
import {
    destroyAutoQaTippy,
    renderAutoQaWidget
} from './auto-qa/auto-qa-widget';
import { PATH_FILL_OPACITY_CHANGED_EVENT } from './path-fill-opacity-pref';

let console: Logger = new Logger('GlyphCanvas');
let latestOpenSessionId: string | null = null;

function syncLatestOpenSessionId(event: Event): void {
    const detail = (event as CustomEvent).detail;
    latestOpenSessionId = detail?.openSessionId || null;
}

function syncLatestOpenSessionIdFromLifecycle(event: Event): void {
    const detail = (event as CustomEvent).detail;
    if (detail?.phase !== 'fontLoaded') {
        return;
    }
    latestOpenSessionId = detail?.openSessionId || null;
}

function isPlainNumericInputValue(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function isViewFocused(viewId: string): boolean {
    return !!document.getElementById(viewId)?.classList.contains('focused');
}

function isNativeEditableClipboardTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return !!(
        element &&
        (element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.isContentEditable)
    );
}

function abbreviateGlyphNameMiddle(
    glyphName: string,
    maximumLength: number = 20
): string {
    if (glyphName.length <= maximumLength) {
        return glyphName;
    }

    const visibleLength = maximumLength - 3;
    const prefixLength = Math.ceil(visibleLength / 2);
    const suffixLength = visibleLength - prefixLength;
    return `${glyphName.slice(0, prefixLength)}...${glyphName.slice(-suffixLength)}`;
}

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

function getSharedNumericValue(
    values: number[],
    epsilon = 0.000001
): number | null {
    if (values.length === 0) {
        return null;
    }

    const first = values[0];
    return values.every((value) => Math.abs(value - first) <= epsilon)
        ? first
        : null;
}

type ActivePropertyInputState = {
    fieldKey: string;
    selectionStart: number | null;
    selectionEnd: number | null;
};

type AnchorPositionField = 'x' | 'y';

type GuidePositionField = 'x' | 'y' | 'angle';

type ComponentTransformField =
    | 'translateX'
    | 'translateY'
    | 'rotation'
    | 'scaleX'
    | 'scaleY'
    | 'skewX'
    | 'skewY';

type ComponentCheckboxState = boolean | 'mixed';

type NormalizedDecomposedTransform = {
    translation: [number, number];
    scale: [number, number];
    rotation: number;
    skew: [number, number];
    order: 'Glyphs' | 'RestOfTheWorld';
};

type LayerListContextTarget = {
    glyphName: string;
    masterId: string;
    layerId: string | null;
    userspaceLocation: UserspaceLocation | null;
    designLocation: DesignspaceLocation | null;
    isMasterBound: boolean;
};

type FeatureVariationAxisRule = {
    min?: number;
    max?: number;
};

type KerningSide = 'first' | 'second';

type TextModeKerningStatus =
    'ready' | 'off-master' | 'bidi-boundary' | 'no-pair';

type TextRunClusterInfo = {
    glyphIndex: number;
    glyphCount: number;
    start: number;
    end: number;
    x: number;
    y?: number;
    width: number;
    lineIndex?: number;
    isRTL: boolean;
    isNewline?: boolean;
};

type TextModeKerningOperand = {
    side: KerningSide;
    kind: 'glyph' | 'group';
    name: string;
    key: string;
    label: string;
    removable: boolean;
    participates: boolean;
    compatible: boolean;
    active: boolean;
};

type TextModeKerningSelection = {
    firstKey: string | null;
    secondKey: string | null;
};

type TextModeKerningContext = {
    status: TextModeKerningStatus;
    message: string;
    isRTL: boolean;
    master: Master | null;
    metrics: Record<string, number> | null;
    firstGlyphName: string | null;
    secondGlyphName: string | null;
    firstCluster: TextRunClusterInfo | null;
    secondCluster: TextRunClusterInfo | null;
    firstOptions: TextModeKerningOperand[];
    secondOptions: TextModeKerningOperand[];
    selectedFirstKey: string | null;
    selectedSecondKey: string | null;
    selectedFirstLabel: string | null;
    selectedSecondLabel: string | null;
    selectedValue: number | null;
    hasSelectedValue: boolean;
};

type TextModeKerningOverlay = {
    minX: number;
    maxX: number;
    topY: number;
    bottomY: number;
    value: number;
};

type TextModeKerningPair = {
    firstKey: string;
    secondKey: string;
    pairKey: string;
};

type TextModeKerningOverlayCacheEntry = {
    adjacencyKey: string;
    firstKeys: string[];
    secondKeys: string[];
    secondCluster: TextRunClusterInfo;
    isRTL: boolean;
    resolvedFirstKey: string | null;
    resolvedSecondKey: string | null;
    value: number | null;
    overlay: TextModeKerningOverlay | null;
};

type TextModeKerningOverlayCache = {
    layoutVersion: number;
    masterId: string;
    overlays: TextModeKerningOverlay[];
    entries: TextModeKerningOverlayCacheEntry[];
    entriesByAdjacencyKey: Map<string, TextModeKerningOverlayCacheEntry>;
    candidatePairToAdjacencyKeys: Map<string, Set<string>>;
};

type PendingTextModeKerningPreview = {
    masterId: string;
    firstKey: string;
    secondKey: string;
    isRTL: boolean;
    /** Kerning value already reflected in the current shaped glyph advances. */
    baselineValue: number;
    previewValue: number | null;
    glyphIndex: number;
    baselineAx: number;
    /** RTL: baseline dx for every glyph visually left of the caret. */
    baselineDxByGlyphIndex: Record<number, number> | null;
};

function getTextModeKerningPairKey(
    firstKey: string,
    secondKey: string
): string {
    return getOrderedKerningPairKey(firstKey, secondKey);
}

function getTextModeKerningAdjacencyKey(
    firstCluster: TextRunClusterInfo,
    secondCluster: TextRunClusterInfo
): string {
    return [
        firstCluster.start,
        firstCluster.end,
        secondCluster.start,
        secondCluster.end,
        firstCluster.isRTL ? 'rtl' : 'ltr'
    ].join('\u0000');
}

function buildOrderedTextModeKerningPairs(
    firstKeys: string[],
    secondKeys: string[]
): TextModeKerningPair[] {
    return buildOrderedKerningPairs(firstKeys, secondKeys);
}

function compareLocationMaps(
    left: Record<string, any> | null | undefined,
    right: Record<string, any> | null | undefined,
    axesOrder: string[]
): number {
    for (const tag of axesOrder) {
        const leftValue = Number(left?.[tag] ?? 0);
        const rightValue = Number(right?.[tag] ?? 0);
        const diff = leftValue - rightValue;
        if (Math.abs(diff) > 0.000001) {
            return diff;
        }
    }

    const extraLeftTags = Object.keys(left || {}).filter(
        (tag) => !axesOrder.includes(tag)
    );
    const extraRightTags = Object.keys(right || {}).filter(
        (tag) => !axesOrder.includes(tag)
    );
    const allExtraTags = Array.from(
        new Set([...extraLeftTags, ...extraRightTags])
    ).sort();

    for (const tag of allExtraTags) {
        const leftValue = Number(left?.[tag] ?? 0);
        const rightValue = Number(right?.[tag] ?? 0);
        const diff = leftValue - rightValue;
        if (Math.abs(diff) > 0.000001) {
            return diff;
        }
    }

    return 0;
}

/**
 * Font-space Y band for text caret placement, drag selection, and the I-beam
 * cursor. Extends generously past the drawn caret (1000 … -300) so clicks and
 * drags still hit above/below the word.
 */
const TEXT_INTERACTION_Y_MAX = 1400;
const TEXT_INTERACTION_Y_MIN = -700;
/** Drawn text caret in font space (renderer `drawCursor`). */
const TEXT_CARET_FONT_Y_TOP = 1000;
const TEXT_CARET_FONT_Y_BOTTOM = -300;
const TEXT_CARET_FONT_Y_CENTER =
    (TEXT_CARET_FONT_Y_TOP + TEXT_CARET_FONT_Y_BOTTOM) / 2;
const CURSOR_VIEW_MARGIN = 30;
const BACKSPACE_PRECEDING_GLYPH_COUNT = 2;
const BACKSPACE_SAFE_VIEWPORT_FRACTION = 1 / 5;
class GlyphCanvas {
    static COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH = 96;

    container: HTMLElement;
    canvasHost: HTMLElement | null = null;
    canvasStage: HTMLElement | null = null;
    canvas: HTMLCanvasElement | null = null;
    previewChromeOpacity: number = 1;
    previewViewportGuide: ViewportFrame | null = null;
    ctx: CanvasRenderingContext2D | null = null;
    outlineEditor: OutlineEditor = new OutlineEditor(this);

    axesManager: AxesManager | null = null;
    featuresManager: FeaturesManager | null = null;
    textRunEditor: TextRunEditor | null = null;
    renderer: GlyphCanvasRenderer | null = null;
    featureChangeAnimator: FeatureChangeAnimator | null = null;

    initialScale: number = 0.2;
    viewportManager: ViewportManager | null = null;

    currentFont: any = null;
    fontBlob: Blob | null = null;
    fontBytes: Uint8Array | null = null;
    sourceGlyphNames: { [gid: number]: string } = {};

    isFocused: boolean = false;
    initialFontLoaded: boolean = false;

    blurTimeoutId: any = null; // Delay blur to prevent cursor flicker when clicking sidebar

    mouseX: number = 0;
    mouseY: number = 0;
    glyphBounds: any[] = [];

    fontData: any = null;

    isSliderActive: boolean = false;

    glyphSelectionSequence: number = 0;

    textChangeDebounceTimer: any = null; // NodeJS.Timeout is not available in browser
    // Adaptive debounce timing for progressive typing compilation
    textChangeLastKeystrokeTime: number = 0;
    textChangeBurstThreshold: number = 200; // ms - keystrokes within this window considered "burst typing"
    textChangeFastDelay: number = 150; // ms - delay during fast typing bursts
    textChangeSlowDelay: number = 150; // ms - delay during slow typing
    textChangeLastSubsetKey: string = '';
    textInputFullCompileTimer: any = null; // Deferred full compilation after typing stops

    resizeObserver: ResizeObserver | null = null;
    private propertyPanelClassObserver: MutationObserver | null = null;

    // Track previous container dimensions for resize handling
    lastContainerWidth: number = 0;
    lastContainerHeight: number = 0;
    lastCutoutLeft: number = 0;
    lastCutoutTop: number = 0;
    lastContentFrame: ViewportFrame | null = null;
    lastStableViewportSnapshot: {
        scale: number;
        panX: number;
        panY: number;
        viewportWidth?: number;
        viewportHeight?: number;
        contentAnchorFontX?: number;
        contentAnchorFontY?: number;
        contentAnchorScreenFractionX?: number;
        contentAnchorScreenFractionY?: number;
    } | null = null;
    collapsedViewportSnapshot: {
        scale: number;
        panX: number;
        panY: number;
        viewportWidth?: number;
        viewportHeight?: number;
        contentAnchorFontX?: number;
        contentAnchorFontY?: number;
        contentAnchorScreenFractionX?: number;
        contentAnchorScreenFractionY?: number;
    } | null = null;
    suppressNextViewportResizeAdjustment: boolean = false;
    /**
     * While > 0, keyboard-driven view layout changes keep the text cursor
     * (text mode) or active glyph bbox center (edit mode) on the same
     * screen point instead of re-centering on the canvas midpoint.
     */
    keyboardViewportResizePreservationCount: number = 0;

    private snapshotCurrentViewport(): {
        scale: number;
        panX: number;
        panY: number;
        viewportWidth?: number;
        viewportHeight?: number;
        contentAnchorFontX?: number;
        contentAnchorFontY?: number;
        contentAnchorScreenFractionX?: number;
        contentAnchorScreenFractionY?: number;
    } | null {
        if (!this.viewportManager) {
            return null;
        }

        const contentFrame = this.getCanvasContentFrameAsViewport();
        const viewportWidth =
            contentFrame.width ||
            this.container.clientWidth ||
            this.lastContainerWidth ||
            0;
        const viewportHeight =
            contentFrame.height ||
            this.container.clientHeight ||
            this.lastContainerHeight ||
            0;
        const snapshot: {
            scale: number;
            panX: number;
            panY: number;
            viewportWidth?: number;
            viewportHeight?: number;
            contentAnchorFontX?: number;
            contentAnchorFontY?: number;
            contentAnchorScreenFractionX?: number;
            contentAnchorScreenFractionY?: number;
        } = {
            scale: this.viewportManager.scale,
            panX: this.viewportManager.panX,
            panY: this.viewportManager.panY,
            viewportWidth,
            viewportHeight
        };

        const anchor = this.getResizeViewportAnchorFontPosition(contentFrame);
        if (anchor && viewportWidth > 0 && viewportHeight > 0) {
            const screen = this.viewportManager.fontToScreenCoordinates(
                anchor.x,
                anchor.y
            );
            snapshot.contentAnchorFontX = anchor.x;
            snapshot.contentAnchorFontY = anchor.y;
            snapshot.contentAnchorScreenFractionX =
                (screen.x - contentFrame.left) / viewportWidth;
            snapshot.contentAnchorScreenFractionY =
                (screen.y - contentFrame.top) / viewportHeight;
        }

        return snapshot;
    }

    beginKeyboardViewportResizePreservation(): void {
        this.keyboardViewportResizePreservationCount += 1;
    }

    endKeyboardViewportResizePreservation(): void {
        this.keyboardViewportResizePreservationCount = Math.max(
            0,
            this.keyboardViewportResizePreservationCount - 1
        );
    }

    isKeyboardViewportResizePreservationActive(): boolean {
        return this.keyboardViewportResizePreservationCount > 0;
    }

    /**
     * Content lock point: edit-mode glyph bbox center, otherwise the
     * drawn text caret's vertical center.
     */
    getKeyboardResizeContentAnchorFontPosition(): {
        x: number;
        y: number;
    } | null {
        if (this.outlineEditor?.active) {
            const bboxCenter =
                this.outlineEditor.getBoundingBoxCenterFontPosition();
            if (bboxCenter) {
                return bboxCenter;
            }
        }

        if (this.textRunEditor) {
            return {
                x:
                    this.featureChangeAnimator?.getInterpolatedAnchorFontX() ??
                    this.textRunEditor.cursorX,
                y: TEXT_CARET_FONT_Y_CENTER
            };
        }

        return null;
    }

    /**
     * Resize lock: preferred focus point when it is inside the inset,
     * otherwise a visible point in the text run (edit mode).
     */
    getResizeViewportAnchorFontPosition(
        frame: ViewportFrame
    ): { x: number; y: number } | null {
        const preferred = this.getKeyboardResizeContentAnchorFontPosition();
        if (preferred && this.isFontPointInContentFrame(preferred, frame)) {
            return preferred;
        }
        if (this.outlineEditor?.active) {
            const visible = this.findVisibleTextRunAnchorFontPosition(
                frame,
                preferred
            );
            if (visible) {
                return visible;
            }
        }
        return preferred;
    }

    private isFontPointInContentFrame(
        fontPosition: { x: number; y: number },
        frame: ViewportFrame
    ): boolean {
        if (!this.viewportManager || frame.width <= 0 || frame.height <= 0) {
            return false;
        }
        const screen = this.viewportManager.fontToScreenCoordinates(
            fontPosition.x,
            fontPosition.y
        );
        return (
            screen.x >= frame.left &&
            screen.x <= frame.left + frame.width &&
            screen.y >= frame.top &&
            screen.y <= frame.top + frame.height
        );
    }

    private findVisibleTextRunAnchorFontPosition(
        frame: ViewportFrame,
        preferred: { x: number; y: number } | null
    ): { x: number; y: number } | null {
        const shapedGlyphs = this.textRunEditor?.shapedGlyphs;
        if (
            !shapedGlyphs ||
            shapedGlyphs.length === 0 ||
            !this.viewportManager
        ) {
            return null;
        }

        let best: { x: number; y: number } | null = null;
        let bestDistance = Infinity;
        const frameCenterX = frame.left + frame.width / 2;
        const frameCenterY = frame.top + frame.height / 2;

        for (let index = 0; index < shapedGlyphs.length; index++) {
            const bounds = this.glyphBounds[index];
            const position = this.textRunEditor!._getGlyphPosition(index);
            const fontX = bounds
                ? bounds.x + (bounds.x1 + bounds.x2) / 2
                : position.xPosition + position.xOffset;
            const fontY = bounds
                ? bounds.y + (bounds.y1 + bounds.y2) / 2
                : position.yOffset || 0;
            const fontPosition = { x: fontX, y: fontY };
            if (!this.isFontPointInContentFrame(fontPosition, frame)) {
                continue;
            }
            const screen = this.viewportManager.fontToScreenCoordinates(
                fontX,
                fontY
            );
            const distance = preferred
                ? Math.hypot(fontX - preferred.x, fontY - preferred.y)
                : Math.hypot(screen.x - frameCenterX, screen.y - frameCenterY);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = fontPosition;
            }
        }
        return best;
    }

    private applyContentInsetRelativeLock(
        oldFrame: ViewportFrame,
        newFrame: ViewportFrame,
        fontPosition: { x: number; y: number },
        preZoomScreen?: { x: number; y: number }
    ): void {
        if (
            !this.viewportManager ||
            oldFrame.width <= 0 ||
            oldFrame.height <= 0 ||
            newFrame.width <= 0 ||
            newFrame.height <= 0
        ) {
            return;
        }
        const screen =
            preZoomScreen ||
            this.viewportManager.fontToScreenCoordinates(
                fontPosition.x,
                fontPosition.y
            );
        const fractionX = (screen.x - oldFrame.left) / oldFrame.width;
        const fractionY = (screen.y - oldFrame.top) / oldFrame.height;
        applyFontPointScreenLock(
            this.viewportManager,
            {
                x: newFrame.left + fractionX * newFrame.width,
                y: newFrame.top + fractionY * newFrame.height
            },
            fontPosition.x,
            fontPosition.y,
            { lockY: true }
        );
    }

    private contentFramesMatch(
        left: ViewportFrame | null,
        right: ViewportFrame
    ): boolean {
        if (!left) {
            return false;
        }
        return (
            left.left === right.left &&
            left.top === right.top &&
            left.width === right.width &&
            left.height === right.height
        );
    }

    /**
     * Edit-mode idle lock: origin (LTR 0,0 / RTL xAdvance,0) unless this
     * packet is a sidebearing edit on the active glyph (bbox center) or a
     * keyed LSB outline/component realignment (advance right edge).
     */
    getIdleViewLockFontPosition(options?: {
        bboxCenter?: boolean;
        rightEdge?: boolean;
    }): {
        x: number;
        y: number;
    } | null {
        if (this.outlineEditor?.active) {
            if (options?.bboxCenter) {
                const bboxCenter =
                    this.outlineEditor.getBoundingBoxCenterFontPosition();
                if (bboxCenter) {
                    return bboxCenter;
                }
            } else if (options?.rightEdge) {
                const rightEdge =
                    this.outlineEditor.getEditModeAdvanceRightLockFontPosition();
                if (rightEdge) {
                    return rightEdge;
                }
            }
            const origin =
                this.outlineEditor.getEditModeOriginLockFontPosition();
            if (origin) {
                return origin;
            }
        }

        if (this.textRunEditor) {
            return { x: this.textRunEditor.cursorX, y: 0 };
        }

        return null;
    }

    /**
     * True while this canvas owns a live gesture lock (drag or sidebearing
     * burst). Idle committed packets must not capture a viewer lock then.
     */
    shouldSkipIdleViewLock(): boolean {
        return !!(
            this.outlineEditor?.draggingSomething ||
            this.outlineEditor?.isLiveSidebearingInteractionActive?.()
        );
    }

    /**
     * Capture this window's idle viewer lock before a committed packet
     * mutates the canvas (local, remote, undo, or redo). Edit mode locks
     * the active glyph origin, its bbox center for a sidebearing edit on
     * that glyph, or its advance right edge for keyed LSB realignment;
     * text-mode kerning locks the pair's reference glyph; other text-mode
     * packets lock the caret.
     */
    captureIdleViewLock(options?: {
        kerningPair?: boolean;
        bboxCenter?: boolean;
        rightEdge?: boolean;
    }): boolean {
        this.clearIdleViewLock();
        if (this.shouldSkipIdleViewLock() || !this.viewportManager) {
            return false;
        }

        if (options?.kerningPair && !this.outlineEditor?.active) {
            this.captureTextModeKerningPanAnchor();
            if (this.textModeKerningPanAnchor) {
                this.pendingIdleViewLock = 'kerning-pair';
                this.idleViewLockScreen = {
                    x: this.textModeKerningPanAnchor.screenX,
                    y: 0
                };
                return true;
            }
        }

        const useBboxCenter =
            !!options?.bboxCenter && !!this.outlineEditor?.active;
        const useRightEdge =
            !useBboxCenter &&
            !!options?.rightEdge &&
            !!this.outlineEditor?.active;
        const fontPosition = this.getIdleViewLockFontPosition({
            bboxCenter: useBboxCenter,
            rightEdge: useRightEdge
        });
        if (!fontPosition) {
            return false;
        }
        this.idleViewLockScreen = this.viewportManager.fontToScreenCoordinates(
            fontPosition.x,
            fontPosition.y
        );
        this.pendingIdleViewLock = 'content';
        this.idleViewLockUsesBbox = useBboxCenter;
        this.idleViewLockUsesRightEdge = useRightEdge;
        return true;
    }

    /**
     * Re-apply a captured idle viewer lock after model sync or reshape.
     */
    reapplyIdleViewLock(): boolean {
        if (!this.pendingIdleViewLock || !this.viewportManager) {
            return false;
        }

        if (this.pendingIdleViewLock === 'kerning-pair') {
            this.applyTextModeKerningPanAdjustment();
            return this.textModeKerningPanAnchor !== null;
        }

        const fontPosition = this.getIdleViewLockFontPosition({
            bboxCenter: this.idleViewLockUsesBbox,
            rightEdge: this.idleViewLockUsesRightEdge
        });
        if (!fontPosition || !this.idleViewLockScreen) {
            return false;
        }
        applyFontPointScreenLock(
            this.viewportManager,
            this.idleViewLockScreen,
            fontPosition.x,
            fontPosition.y,
            { lockY: !!this.outlineEditor?.active }
        );
        return true;
    }

    /**
     * Re-apply and drop an idle viewer lock after reshape. Also clears the
     * local kerning compile flag so a later full compile cannot pan twice.
     */
    consumeIdleViewLockAfterReshape(): boolean {
        if (!this.hasPendingIdleViewLock()) {
            return false;
        }
        this.reapplyIdleViewLock();
        this.clearIdleViewLock();
        this.pendingTextModeKerningCursorAnchor = false;
        return true;
    }

    hasPendingIdleViewLock(): boolean {
        return this.pendingIdleViewLock !== null;
    }

    /**
     * True while a critical apply owns the next paint, or an idle lock is
     * waiting for reshape consume. Stray paints in that window show the
     * pre-lock pan (LSB undo flash).
     */
    shouldDeferCanvasPaint(): boolean {
        return this.renderSuppressed || this.hasPendingIdleViewLock();
    }

    /**
     * Drop a consumed or abandoned idle viewer lock.
     */
    clearIdleViewLock(): void {
        this.pendingIdleViewLock = null;
        this.idleViewLockScreen = null;
        this.idleViewLockUsesBbox = false;
        this.idleViewLockUsesRightEdge = false;
    }

    /**
     * Editing compiles hold an idle viewer lock until reshape. A failed
     * compile never emits `editingFontCompiled`, so drop that lock and paint
     * again instead of leaving the canvas frozen.
     */
    releaseDeferredPaintAfterFailedCompile(): void {
        const hadIdleLock = this.hasPendingIdleViewLock();
        const wasSuppressed = this.renderSuppressed;
        if (!hadIdleLock && !wasSuppressed) {
            return;
        }
        this.renderSuppressed = false;
        this.clearIdleViewLock();
        this.outlineEditor?.clearPendingSidebearingBboxCenterAnchor?.();
        this.render();
    }

    /**
     * Fail-safe for keyboard (and collapse restore) resizes: place the
     * caret / glyph bbox center at a target screen point, clamped inside
     * the current canvas so content cannot stay invisible after reopen.
     */
    ensureKeyboardResizeContentAnchorVisible(
        options: {
            screenFractionX?: number;
            screenFractionY?: number;
        } = {}
    ): boolean {
        if (!this.viewportManager || !this.canvas) {
            return false;
        }

        const frame = this.getCanvasContentFrame();
        const width = frame.width;
        const height = frame.height;
        if (
            width <= GlyphCanvas.COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH ||
            height <= 0
        ) {
            return false;
        }

        const anchor = this.getKeyboardResizeContentAnchorFontPosition();
        if (!anchor) {
            return false;
        }

        const marginX = Math.min(CURSOR_VIEW_MARGIN, Math.max(8, width / 4));
        const marginY = Math.min(CURSOR_VIEW_MARGIN, Math.max(8, height / 4));
        const currentScreen = this.viewportManager.fontToScreenCoordinates(
            anchor.x,
            anchor.y
        );

        let targetScreenX =
            typeof options.screenFractionX === 'number'
                ? frame.left + options.screenFractionX * width
                : currentScreen.x;
        let targetScreenY =
            typeof options.screenFractionY === 'number'
                ? frame.top + options.screenFractionY * height
                : currentScreen.y;

        targetScreenX = Math.min(
            Math.max(targetScreenX, frame.left + marginX),
            Math.max(frame.left + marginX, frame.left + width - marginX)
        );
        targetScreenY = Math.min(
            Math.max(targetScreenY, frame.top + marginY),
            Math.max(frame.top + marginY, frame.top + height - marginY)
        );

        const alreadyVisible =
            currentScreen.x >= frame.left + marginX &&
            currentScreen.x <= frame.left + width - marginX &&
            currentScreen.y >= frame.top + marginY &&
            currentScreen.y <= frame.top + height - marginY &&
            typeof options.screenFractionX !== 'number' &&
            typeof options.screenFractionY !== 'number';
        if (alreadyVisible) {
            return false;
        }

        applyFontPointScreenLock(
            this.viewportManager,
            { x: targetScreenX, y: targetScreenY },
            anchor.x,
            anchor.y,
            { lockY: true }
        );
        return true;
    }

    freezeViewportForCollapse(
        referenceWidth?: number,
        referenceHeight?: number,
        options?: { force?: boolean }
    ): void {
        if (!this.viewportManager) {
            return;
        }

        // Keep the first freeze for this collapse cycle. Resizer and onResize
        // both call this while the panel is still shrinking; overwriting would
        // replace the pre-collapse scale/pan with a mid-collapse fitted view.
        if (this.collapsedViewportSnapshot && !options?.force) {
            return;
        }

        const width =
            referenceWidth ||
            this.container.clientWidth ||
            this.lastContainerWidth ||
            0;
        const height =
            referenceHeight ||
            this.container.clientHeight ||
            this.lastContainerHeight ||
            0;

        const snapshot = this.snapshotCurrentViewport();
        if (!snapshot) {
            return;
        }

        // Prefer the pre-collapse size so relative caret placement survives
        // reopen into a smaller first-stage panel.
        if (width > 0 && height > 0) {
            snapshot.viewportWidth = width;
            snapshot.viewportHeight = height;
            const anchor = this.getResizeViewportAnchorFontPosition(
                this.getCanvasContentFrameAsViewport()
            );
            if (anchor) {
                const screen = this.viewportManager.fontToScreenCoordinates(
                    anchor.x,
                    anchor.y
                );
                const contentFrame = this.getCanvasContentFrameAsViewport();
                snapshot.contentAnchorFontX = anchor.x;
                snapshot.contentAnchorFontY = anchor.y;
                snapshot.contentAnchorScreenFractionX =
                    contentFrame.width > 0
                        ? (screen.x - contentFrame.left) / contentFrame.width
                        : 0.5;
                snapshot.contentAnchorScreenFractionY =
                    contentFrame.height > 0
                        ? (screen.y - contentFrame.top) / contentFrame.height
                        : 0.5;
            }
        }

        this.collapsedViewportSnapshot = snapshot;
        this.lastStableViewportSnapshot = { ...snapshot };
    }

    restoreViewportAfterCollapse(): void {
        if (!this.viewportManager) {
            return;
        }

        const snapshot =
            this.collapsedViewportSnapshot || this.lastStableViewportSnapshot;
        if (!snapshot) {
            return;
        }

        this.viewportManager.scale = snapshot.scale;

        const hasRelativeAnchor =
            typeof snapshot.contentAnchorScreenFractionX === 'number' &&
            typeof snapshot.contentAnchorFontX === 'number';

        if (hasRelativeAnchor) {
            // Place the caret/bbox at the same relative canvas position it
            // had before collapse, clamped into the current (possibly smaller)
            // panel so the first keyboard reopen cannot leave it invisible.
            this.ensureKeyboardResizeContentAnchorVisible({
                screenFractionX: snapshot.contentAnchorScreenFractionX,
                screenFractionY: snapshot.contentAnchorScreenFractionY ?? 0.5
            });
        } else {
            this.viewportManager.panX = snapshot.panX;
            this.viewportManager.panY = snapshot.panY;
            this.ensureKeyboardResizeContentAnchorVisible();
        }

        this.lastStableViewportSnapshot = {
            scale: this.viewportManager.scale,
            panX: this.viewportManager.panX,
            panY: this.viewportManager.panY,
            ...(this.snapshotCurrentViewport() || {})
        };
        this.collapsedViewportSnapshot = null;
        this.suppressNextViewportResizeAdjustment = true;
        this.render();
    }

    propertiesSection: HTMLElement | null = null;
    propertyPanel: HTMLElement | null = null;
    leftSidebar: HTMLElement | null = null;
    rightSidebar: HTMLElement | null = null;
    axesSection: HTMLElement | null = null;
    glyphStackLabel: HTMLElement | null = null;
    restoreCanvasFocusAfterPropertyCommit: boolean = false;
    textModeKerningSelection: TextModeKerningSelection = {
        firstKey: null,
        secondKey: null
    };
    textModeKerningSelectionPinned: boolean = false;
    textModeKerningSelectionScopeKey: string | null = null;
    textModeKerningDraftPairKey: string | null = null;
    textModeKerningDraftScopeKey: string | null = null;
    textModeKerningDraftValue: string | null = null;
    textModeKerningOverlayCache: TextModeKerningOverlayCache | null = null;
    private textModeKerningPreviewFunnel = new KeyboardPreviewEditFunnel();
    private pendingTextModeKerningPreview: PendingTextModeKerningPreview | null =
        null;

    zoomAnimation: {
        active: boolean;
        currentFrame: number;
        totalFrames: number;
        startScale: number;
        endScale: number;
        centerX: number;
        centerY: number;
        fontX: number;
        fontY: number;
        lockFontPoint: boolean;
    } = {
        active: false,
        currentFrame: 0,
        totalFrames: 0,
        startScale: 0,
        endScale: 0,
        centerX: 0,
        centerY: 0,
        fontX: 0,
        fontY: 0,
        lockFontPoint: false
    };
    private cmdZeroStage1Target: {
        scale: number;
        panX: number;
        panY: number;
    } | null = null;
    private cmdZeroStage1Pending: boolean = false;

    // Internal state properties not in constructor
    measurementKeyPressed: boolean = false;
    isDraggingCanvas: boolean = false;
    isSelectingText: boolean = false;
    lastMouseX: number = 0;
    lastMouseY: number = 0;
    mouseCanvasX: number = 0;
    mouseCanvasY: number = 0;
    cursorVisible: boolean = true;
    private mouseUpFinalization: Promise<void> | null = null;
    // After Cmd+Tab / app switch, browsers often synthesize a Meta keydown (sometimes
    // without a matching keyup). Ignore Cmd/Ctrl activation until a fresh press.
    private commandKeyRequiresFreshPress: boolean = false;
    private altKeyRequiresFreshPress: boolean = false;
    private commandKeyActivationSuppressedUntil: number = 0;
    private altKeyActivationSuppressedUntil: number = 0;
    // Track real browser-window activation. Cmd+Tab often skips reliable blur
    // delivery; document.hasFocus() is the authoritative signal.
    private browserWindowActive: boolean = true;
    private modifierFocusWatchRaf: number | null = null;

    // Measurement tool
    measurementTool!: MeasurementTool; // Initialized in constructor

    // Stack preview animator for component visualization
    stackPreviewAnimator!: StackPreviewAnimator; // Initialized in constructor

    // Auto-pan anchor for text mode (cursor position during axis animation)
    textModeAutoPanAnchorScreen: { x: number; y: number } | null = null;
    /** Kerning reshape: keep firstCluster's visual X (x+dx) screen-stationary. */
    textModeKerningPanAnchor: {
        screenX: number;
        clusterStart: number;
    } | null = null;
    textModeEscapeState: SavedVariationState = new SavedVariationState();

    // Re-apply kerning pan after the compile reshape that follows a kerning write
    pendingTextModeKerningCursorAnchor: boolean = false;

    /**
     * Idle committed-packet viewer lock: keep this canvas's focus point
     * screen-stationary across model sync and reshape.
     */
    private pendingIdleViewLock: 'content' | 'kerning-pair' | null = null;
    private idleViewLockScreen: { x: number; y: number } | null = null;
    private idleViewLockUsesBbox = false;
    private idleViewLockUsesRightEdge = false;

    // Flag to suppress rendering during critical operations (e.g., layer data swap)
    renderSuppressed: boolean = false;
    hasDeferredRenderRequest: boolean = false;
    pendingCanvasBackingStoreSync: boolean = false;
    editModeGlyphResyncInProgress: boolean = false;

    // Flag to prevent overlapping updatePropertiesUI calls
    isUpdatingPropertiesUI: boolean = false;
    private cutInFlight = false;
    private clipboardPasteKind: ClipboardPasteKind = 'empty';

    private handleLayerFingerprintChanged = (event: Event): void => {
        if (!this.outlineEditor.active) {
            return;
        }

        const detail = (event as CustomEvent).detail;
        const currentGlyphName =
            this.outlineEditor.getLayerLinkGlyphName() ||
            this.getCurrentGlyphName();

        if (detail?.glyphName && detail.glyphName !== currentGlyphName) {
            return;
        }

        if (this.outlineEditor.draggingSomething) {
            console.log(
                '[DRAG-DEBUG] Skipping updatePropertiesUI from layerFingerprintChanged during drag'
            );
            return;
        }

        void this.updatePropertiesUI();
    };

    /**
     * Copy selected overview glyphs as Counterpunch JSON (whole-glyph payload)
     * plus SVG of paths from each glyph's first foreground layer.
     */
    private copySelectedOverviewGlyphsToClipboard(
        event?: ClipboardEvent | null
    ): boolean {
        const prepared = this.prepareOverviewGlyphsClipboardWrite();
        if (!prepared) {
            return false;
        }
        if (event) {
            if (!event.clipboardData) {
                return false;
            }
            event.preventDefault();
            event.stopPropagation();
            writeClipboardDocumentToDataTransfer(
                event.clipboardData,
                prepared.document,
                prepared.svgPaths,
                prepared.fontraOptions
            );
        }
        void writeClipboardDocumentAsync(
            prepared.document,
            prepared.svgPaths,
            prepared.fontraOptions
        );
        console.log(summarizeClipboardDocument(prepared.document));
        this.rememberClipboardPasteKind('glyphs');
        return true;
    }

    rememberClipboardPasteKind(kind: ClipboardPasteKind): void {
        this.clipboardPasteKind = kind;
    }

    async refreshClipboardPasteKind(): Promise<void> {
        const payloads = await readClipboardPayloadsAsync();
        if (payloads.length === 0) {
            return;
        }
        this.rememberClipboardPasteKind(classifyClipboardPayloads(payloads));
    }

    canCopyFocusedClipboardSelection(): boolean {
        return this.canCutFocusedClipboardSelection();
    }

    canCutFocusedClipboardSelection(): boolean {
        const overviewFocused = isViewFocused('view-overview');
        const editorFocused = isViewFocused('view-editor');
        if (overviewFocused) {
            return (
                (window.glyphOverviewInstance?.getSelectedGlyphNames?.()
                    .length || 0) > 0
            );
        }
        if (!editorFocused) {
            return false;
        }
        if (this.outlineEditor.active) {
            return this.outlineEditor.hasCopyableSelection();
        }
        return !!this.textRunEditor?.hasSelection?.();
    }

    canPasteFocusedClipboard(): boolean {
        if (!fontManager.currentFont) {
            return false;
        }
        const kind = this.clipboardPasteKind;
        if (kind === 'glyphs') {
            return isViewFocused('view-overview');
        }
        if (kind === 'selection') {
            return isViewFocused('view-editor') && this.outlineEditor.active;
        }
        if (kind === 'text') {
            return isViewFocused('view-editor') && !this.outlineEditor.active;
        }
        return false;
    }

    copyFocusedClipboardSelection(): boolean {
        const overviewFocused = isViewFocused('view-overview');
        const editorFocused = isViewFocused('view-editor');
        if (overviewFocused) {
            return this.copySelectedOverviewGlyphsToClipboard();
        }
        if (editorFocused && this.outlineEditor.active) {
            return this.outlineEditor.copySelectionToClipboard();
        }
        if (
            editorFocused &&
            !this.outlineEditor.active &&
            this.textRunEditor?.hasSelection?.()
        ) {
            void this.textRunEditor.copySelection();
            return true;
        }
        return false;
    }

    async pasteFocusedClipboard(): Promise<void> {
        await this.refreshClipboardPasteKind();
        if (!this.canPasteFocusedClipboard()) {
            return;
        }
        const overviewFocused = isViewFocused('view-overview');
        const editorFocused = isViewFocused('view-editor');
        if (editorFocused && !this.outlineEditor.active && this.textRunEditor) {
            await this.textRunEditor.paste();
            return;
        }
        if (!overviewFocused && !(editorFocused && this.outlineEditor.active)) {
            return;
        }
        const payloads = await readClipboardPayloadsAsync();
        const parsed = parseClipboardPayloads(payloads);
        if (!parsed) {
            return;
        }
        this.applyParsedClipboardPaste(parsed, null);
    }

    async cutFocusedClipboardSelection(
        event?: ClipboardEvent | null
    ): Promise<boolean> {
        if (this.cutInFlight) {
            return false;
        }
        this.cutInFlight = true;
        try {
            const overviewFocused = isViewFocused('view-overview');
            const editorFocused = isViewFocused('view-editor');
            if (overviewFocused) {
                return await this.cutSelectedOverviewGlyphs(event);
            }
            if (editorFocused && this.outlineEditor.active) {
                return await this.outlineEditor.cutSelectionToClipboard(event);
            }
            if (
                editorFocused &&
                !this.outlineEditor.active &&
                this.textRunEditor?.hasSelection?.()
            ) {
                event?.preventDefault();
                event?.stopPropagation();
                await this.textRunEditor.cutSelection();
                return true;
            }
            return false;
        } finally {
            this.cutInFlight = false;
        }
    }

    private prepareOverviewGlyphsClipboardWrite(): {
        document: NonNullable<ReturnType<typeof buildGlyphsClipboardDocument>>;
        svgPaths: ReturnType<typeof serializePathForClipboard>[];
        fontraOptions: {
            glyphCodePoints: Record<string, number[]>;
            axisNameByKey: Record<string, string>;
        };
        selectedNames: string[];
    } | null {
        const overview = window.glyphOverviewInstance;
        const selectedNames = overview?.getSelectedGlyphNames?.() || [];
        if (selectedNames.length === 0) {
            return null;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.findGlyph) {
            return null;
        }

        const glyphs = [];
        const svgPaths = [];
        for (const name of selectedNames) {
            const glyph = fontModel.findGlyph(name);
            if (!glyph) {
                continue;
            }
            glyphs.push(serializeGlyphForClipboard(glyph));
            const layer = (glyph.layers || []).find(
                (candidate: Layer) => !candidate.is_background
            );
            if (!layer) {
                continue;
            }
            for (const shape of layer.shapes || []) {
                if (shape.isPath?.()) {
                    svgPaths.push(serializePathForClipboard(shape.asPath()));
                }
            }
        }

        const document = buildGlyphsClipboardDocument(
            glyphs,
            serializeFontMastersForClipboard(fontModel)
        );
        if (!document) {
            return null;
        }

        const glyphCodePoints: Record<string, number[]> = {};
        for (const glyph of glyphs) {
            const modelGlyph = fontModel.findGlyph(glyph.name);
            if (
                modelGlyph &&
                Array.isArray(modelGlyph.codepoints) &&
                modelGlyph.codepoints.length > 0
            ) {
                glyphCodePoints[glyph.name] = [...modelGlyph.codepoints];
            }
        }

        return {
            document,
            svgPaths,
            fontraOptions: {
                glyphCodePoints,
                axisNameByKey: buildFontraAxisNameByKey(fontModel.axes || [])
            },
            selectedNames
        };
    }

    /**
     * Copy selected overview glyphs, then delete them without the confirm
     * dialog (paste restores the glyphs).
     */
    private async cutSelectedOverviewGlyphs(
        event?: ClipboardEvent | null
    ): Promise<boolean> {
        const prepared = this.prepareOverviewGlyphsClipboardWrite();
        if (!prepared) {
            return false;
        }
        if (event) {
            if (!event.clipboardData) {
                return false;
            }
            event.preventDefault();
            event.stopPropagation();
            writeClipboardDocumentToDataTransfer(
                event.clipboardData,
                prepared.document,
                prepared.svgPaths,
                prepared.fontraOptions
            );
            void writeClipboardDocumentAsync(
                prepared.document,
                prepared.svgPaths,
                prepared.fontraOptions
            );
        } else {
            const wrote = await writeClipboardDocumentAsync(
                prepared.document,
                prepared.svgPaths,
                prepared.fontraOptions
            );
            if (!wrote) {
                window.alert?.('Unable to write the clipboard.');
                return false;
            }
        }
        console.log(summarizeClipboardDocument(prepared.document));
        this.rememberClipboardPasteKind('glyphs');
        const font = window.currentFontModel;
        if (!font?.deleteGlyphs) {
            return false;
        }
        try {
            font.deleteGlyphs(prepared.selectedNames);
        } catch (error) {
            console.error('Failed to delete cut glyphs', error);
            return false;
        }
        return true;
    }

    /**
     * Route a parsed clipboard document using view `.focused` gating.
     * `event` is set for the sync path (still need preventDefault); null when
     * the paste event was already claimed for an async ClipboardItem read.
     */
    private applyParsedClipboardPaste(
        parsed: ParsedClipboard,
        event: ClipboardEvent | null
    ): void {
        this.rememberClipboardPasteKind(parsed.kind);
        if (!this.canPasteFocusedClipboard()) {
            event?.preventDefault();
            event?.stopPropagation();
            event?.stopImmediatePropagation();
            return;
        }

        if (parsed.kind === 'glyphs') {
            event?.preventDefault();
            event?.stopPropagation();
            event?.stopImmediatePropagation();
            this.pasteWholeGlyphsDocument(parsed.document);
            return;
        }

        this.outlineEditor.pasteFromParsedClipboard(parsed, event);
    }

    /**
     * Paste whole-glyph clipboard data as always-new glyphs in the overview.
     * Build under recording suppression (insert after namesake), then record
     * each glyph once (full snapshot). `recordAdd` also syncs `glyphOrder`
     * from the model so Yjs / overview keep that insert position — same path
     * as duplicateGlyph / addGlyph.
     */
    private pasteWholeGlyphsDocument(document: PasteGlyphsDocument): void {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            window.alert?.('No font open.');
            return;
        }

        const bridge = window.patchSyncEngine;
        const overview = window.glyphOverviewInstance;
        const selectAndRevealCreatedGlyphs = (names: string[]) => {
            if (typeof overview?.selectAndRevealGlyphNames === 'function') {
                overview.selectAndRevealGlyphNames(names);
            } else {
                overview?.queueSelectGlyphsByNames?.(names);
            }
        };
        let selectionQueuedForBridgeRefresh = false;
        bridge?.beginTransaction('Paste glyphs');
        let result;
        try {
            result = withSuppressedModelRecording(() =>
                applyPasteGlyphsDocument(document, {
                    font: fontModel,
                    glyphExists: (name) => !!fontModel.findGlyph?.(name)
                })
            );
            if (!result.error) {
                let recordedGlyph = false;
                for (const name of result.createdGlyphNames) {
                    const glyph = fontModel.findGlyph?.(name);
                    if (glyph && typeof bridge?.recordAdd === 'function') {
                        bridge.recordAdd(['glyphs', name], glyph.toJSON());
                        recordedGlyph = true;
                    }
                }

                // The bridge emits the authoritative identity refresh when the
                // transaction ends. Queue selection before that refresh rather
                // than racing it with a second local overview sync.
                if (recordedGlyph && result.createdGlyphNames.length > 0) {
                    selectAndRevealCreatedGlyphs(result.createdGlyphNames);
                    selectionQueuedForBridgeRefresh = true;
                }
            }
        } finally {
            bridge?.endTransaction();
        }

        if (result.error) {
            console.warn(result.error);
            window.alert?.(result.error);
            return;
        }

        if (result.warnings?.length) {
            window.alert?.(result.warnings.join('\n'));
        }

        if (result.createdGlyphNames.length > 0) {
            // Update immediately for local feedback. The queued reveal token
            // also survives the bridge's later authoritative refresh.
            const glyphData = fontModel.glyphs.map(
                (glyph: { name?: string }) => ({
                    id: glyph.name || '',
                    name: glyph.name || ''
                })
            );
            if (typeof overview?.syncGlyphs === 'function') {
                void overview.syncGlyphs(glyphData).then(() => {
                    if (!selectionQueuedForBridgeRefresh) {
                        selectAndRevealCreatedGlyphs(result.createdGlyphNames);
                    }
                });
            } else if (!selectionQueuedForBridgeRefresh) {
                selectAndRevealCreatedGlyphs(result.createdGlyphNames);
            }

            if (selectionQueuedForBridgeRefresh) {
                // The bridge refresh runs after its transaction settles. Reveal
                // again only when that authoritative refresh is complete, so
                // its scroll restoration cannot undo the paste reveal.
                void getCommittedChangeRefreshPromise().then(() => {
                    selectAndRevealCreatedGlyphs(result.createdGlyphNames);
                });
            }
        }
        console.log(describePasteResult(result));
    }

    private scheduleSparseTextCompileIfNeeded(): void {
        if (!fontManager?.isHydrationSparse?.() || !fontManager.isReady?.()) {
            return;
        }
        const text = this.textRunEditor?.textBuffer || '';
        if (!text || !fontManager.needsEditingCompileForText?.(text)) {
            return;
        }
        this.textChangeLastSubsetKey = '';
        this.onTextChange();
    }

    private handleFontModelSync = (): void => {
        this.invalidateTextModeKerningOverlayCache();
        this.scheduleSparseTextCompileIfNeeded();

        if (
            this.textModeKerningDraftPairKey === null &&
            this.textModeKerningDraftScopeKey === null &&
            this.textModeKerningDraftValue === null
        ) {
            if (this.outlineEditor.active || !this.propertyPanel) {
                return;
            }

            this.updatePropertyPanel();
            this.render();
            return;
        }

        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftScopeKey = null;
        this.textModeKerningDraftValue = null;

        if (this.outlineEditor.active || !this.propertyPanel) {
            return;
        }

        this.updatePropertyPanel();
        this.render();
    };

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        if (!this.container) {
            console.error(`Container ${containerId} not found`);
            return;
        }

        // Initialize measurement tool
        this.measurementTool = new MeasurementTool(this);

        // Initialize stack preview animator
        this.stackPreviewAnimator = new StackPreviewAnimator(this);

        this.axesManager = new AxesManager();
        this.featuresManager = new FeaturesManager();
        this.textRunEditor = new TextRunEditor(
            this.featuresManager,
            this.axesManager
        );
        this.featureChangeAnimator = new FeatureChangeAnimator(() => {
            if (this.renderer) {
                this.render();
            }
        });

        this.init();
    }

    init(): void {
        this.container.replaceChildren();

        this.canvasHost = document.createElement('div');
        this.canvasHost.className = 'glyph-canvas-viewport';
        this.container.appendChild(this.canvasHost);

        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.cursor = 'default';
        this.canvas.style.outline = 'none'; // Remove focus outline
        this.canvas.tabIndex = 0; // Make canvas focusable
        this.canvas.dataset.hasContextMenu = 'true';
        this.mountCanvasElement();

        this.propertyPanel = document.createElement('div');
        this.propertyPanel.className = 'glyph-property-panel';
        this.container.appendChild(this.propertyPanel);

        this.outlineEditor.canvas = this.canvas;

        this.syncCanvasBackingStore();

        const cutout = this.getCanvasCutoutFrame();
        this.lastContainerWidth = cutout.width;
        this.lastContainerHeight = cutout.height;
        this.lastCutoutLeft = cutout.left;
        this.lastCutoutTop = cutout.top;
        this.lastContentFrame = this.getCanvasContentFrameAsViewport();

        // Set initial scale and position with deterministic values
        // Using fixed values instead of getBoundingClientRect() for consistency
        this.viewportManager = new ViewportManager(
            this.initialScale,
            100 + cutout.left, // Fixed horizontal pan, offset into the chrome cutout
            250 + cutout.top // Fixed vertical pan
        );
        this.renderer = new GlyphCanvasRenderer(
            this.canvas,
            this,
            this.viewportManager,
            this.textRunEditor!
        );

        // Set up event listeners
        this.setupEventListeners();
        window.addEventListener(QA_CORPUS_READY_EVENT, () => {
            this.updatePropertyPanel();
        });
        window.addEventListener(PATH_FILL_OPACITY_CHANGED_EVENT, () => {
            this.render();
        });

        // Initial render
        this.render();

        this.textRunEditor!.init();
    }

    /**
     * Match the canvas bitmap to the host CSS size × device pixel ratio.
     * Assigning `canvas.width` clears the buffer, so skip when the size is
     * unchanged, and postpone reallocation while paint is deferred.
     */
    syncCanvasBackingStore(): boolean {
        if (!this.canvas) {
            return false;
        }

        const dpr = window.devicePixelRatio || 1;
        const measurementTarget =
            this.canvasStage || this.canvasHost || this.container;
        const nextWidth = measurementTarget.clientWidth * dpr;
        const nextHeight = measurementTarget.clientHeight * dpr;
        const sizeUnchanged =
            this.canvas.width === (nextWidth | 0) &&
            this.canvas.height === (nextHeight | 0);

        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';

        if (sizeUnchanged) {
            this.pendingCanvasBackingStoreSync = false;
            return false;
        }

        if (this.shouldDeferCanvasPaint()) {
            this.pendingCanvasBackingStoreSync = true;
            return false;
        }

        this.canvas.width = nextWidth;
        this.canvas.height = nextHeight;
        this.ctx = this.canvas.getContext('2d');
        this.ctx!.scale(dpr, dpr);
        this.pendingCanvasBackingStoreSync = false;
        return true;
    }

    /**
     * Hoist the bitmap behind app chrome when the full editor shell is present.
     * Jest fixtures only have a test container, so the canvas stays in-host.
     */
    private usesFullWindowCanvas(): boolean {
        return !!(
            document.querySelector('.toolbar') &&
            document.querySelector('.container')
        );
    }

    private mountCanvasElement(): void {
        if (!this.canvas || !this.canvasHost) {
            return;
        }

        if (!this.usesFullWindowCanvas()) {
            this.canvasHost.appendChild(this.canvas);
            document.body.classList.remove('has-full-window-glyph-canvas');
            return;
        }

        let stage = document.getElementById('glyph-canvas-stage');
        if (!stage) {
            stage = document.createElement('div');
            stage.id = 'glyph-canvas-stage';
            document.body.insertBefore(stage, document.body.firstChild);
        }
        this.canvasStage = stage;
        stage.appendChild(this.canvas);
        document.body.classList.add('has-full-window-glyph-canvas');
    }

    /**
     * Editor hole in canvas CSS pixels: the current chrome cutout, including
     * the overlay property panel.
     */
    getCanvasCutoutFrame(): ViewportFrame {
        const canvasRect = this.canvas?.getBoundingClientRect();
        const holeEl = this.container;
        const holeRect = holeEl?.getBoundingClientRect();
        const host = this.canvasHost || this.container;
        const canvasWidth =
            (canvasRect && canvasRect.width > 0 ? canvasRect.width : 0) ||
            host?.clientWidth ||
            this.container?.clientWidth ||
            0;
        const canvasHeight =
            (canvasRect && canvasRect.height > 0 ? canvasRect.height : 0) ||
            host?.clientHeight ||
            this.container?.clientHeight ||
            0;
        const holeValid = !!(
            holeRect &&
            holeRect.width > 0 &&
            holeRect.height > 0
        );
        if (!canvasRect || canvasWidth <= 0 || canvasHeight <= 0) {
            return {
                left: 0,
                top: 0,
                width: canvasWidth,
                height: canvasHeight
            };
        }
        if (!holeValid) {
            // Width-collapsed chrome hides `.view-content`, so the hole is
            // 0×0. Keep the last camera instead of 0 (freeze + stretched
            // bitmap) or the whole window (paint over Overview).
            const widthCollapsed = !!(
                this.container?.closest?.('.collapsed-width') ||
                document
                    .getElementById('view-editor')
                    ?.classList.contains('collapsed-width')
            );
            if (
                widthCollapsed &&
                this.lastContainerWidth > 0 &&
                this.lastContainerHeight > 0
            ) {
                return {
                    left: this.lastCutoutLeft,
                    top: this.lastCutoutTop,
                    width: this.lastContainerWidth,
                    height: this.lastContainerHeight
                };
            }
            return {
                left: 0,
                top: 0,
                width: canvasWidth,
                height: canvasHeight
            };
        }

        return {
            left: holeRect.left - canvasRect.left,
            top: holeRect.top - canvasRect.top,
            width: holeRect.width,
            height: holeRect.height
        };
    }

    /**
     * Screen-fixed dotted rectangle for Space preview, in canvas CSS pixels.
     * Small uses the editor view box minus the overlay property panel;
     * Medium and Full use the canvas drawing slot (cutout minus that panel).
     */
    getPreviewViewportGuide(): ViewportFrame {
        if (getPreviewArea() !== 'small') {
            return this.getCanvasContentFrameAsViewport();
        }

        const canvasRect = this.canvas?.getBoundingClientRect();
        const viewRect = document
            .getElementById('view-editor')
            ?.getBoundingClientRect();
        if (
            !canvasRect ||
            canvasRect.width <= 0 ||
            canvasRect.height <= 0 ||
            !viewRect ||
            viewRect.width <= 0 ||
            viewRect.height <= 0
        ) {
            return this.getCanvasContentFrameAsViewport();
        }

        const panelInset = this.getPropertyPanelBottomInset(viewRect.height);
        return {
            left: viewRect.left - canvasRect.left,
            top: viewRect.top - canvasRect.top,
            width: viewRect.width,
            height: Math.max(0, viewRect.height - panelInset)
        };
    }

    private getCanvasContentFrameAsViewport(): ViewportFrame {
        const frame = this.getCanvasContentFrame();
        return {
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height
        };
    }

    private getPropertyPanelBottomInset(maxHeight: number): number {
        const panel = this.propertyPanel;
        const panelHidden = !panel || panel.classList.contains('hidden');
        if (panelHidden) {
            return 0;
        }
        return Math.min(
            Math.max(0, panel.getBoundingClientRect().height),
            Math.max(0, maxHeight)
        );
    }

    /**
     * Usable camera box in canvas CSS pixels: the chrome cutout minus the
     * overlay property panel at the bottom. Hidden panels contribute no
     * bottom inset. Pointer mapping still uses the full canvas
     * `getBoundingClientRect()`.
     */
    getCanvasContentFrame(): {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    } {
        const cutout = this.getCanvasCutoutFrame();
        const bottomInset = this.getPropertyPanelBottomInset(cutout.height);
        const canvasRect = this.canvas?.getBoundingClientRect();
        const canvasWidth =
            (canvasRect && canvasRect.width > 0 ? canvasRect.width : 0) ||
            cutout.left + cutout.width;
        const canvasHeight =
            (canvasRect && canvasRect.height > 0 ? canvasRect.height : 0) ||
            cutout.top + cutout.height;
        const width = Math.max(0, cutout.width);
        const height = Math.max(0, cutout.height - bottomInset);
        return {
            left: cutout.left,
            top: cutout.top,
            right: Math.max(0, canvasWidth - cutout.left - width),
            bottom: Math.max(0, canvasHeight - cutout.top - height),
            width,
            height
        };
    }

    setPreviewMode(active: boolean): void {
        const wasActive = this.outlineEditor.isPreviewMode;
        this.outlineEditor.isPreviewMode = active;
        if (active && !wasActive) {
            this.previewViewportGuide = this.getPreviewViewportGuide();
            this.applyPreviewChrome(0);
        } else if (!active && wasActive) {
            this.applyPreviewChrome(1);
        } else {
            this.render();
        }
    }

    private applyPreviewChrome(opacity: number): void {
        this.previewChromeOpacity = opacity;
        if (opacity === 1) {
            this.previewViewportGuide = null;
        }
        this.applyPreviewChromeOpacity();
        this.render();
    }

    runAfterPreviewChromeSettled(callback: () => void): void {
        callback();
    }

    private applyPreviewChromeOpacity(): void {
        document.documentElement.style.setProperty(
            '--preview-chrome-opacity',
            String(this.previewChromeOpacity)
        );
        this.applyPreviewChromeClasses();
    }

    private applyPreviewChromeClasses(): void {
        const keepPreviewVisuals =
            this.outlineEditor.isPreviewMode || this.previewChromeOpacity < 1;
        const area = getPreviewArea();
        const fadeChrome = keepPreviewVisuals && area !== 'small';
        document.body.classList.toggle('preview-mode-chrome', fadeChrome);
        document.body.classList.remove(
            'preview-area-small',
            'preview-area-medium',
            'preview-area-full'
        );
        if (fadeChrome) {
            document.body.classList.add(`preview-area-${area}`);
        }
    }

    getPreviewFillAlpha(): number {
        return Math.max(0, Math.min(1, 1 - this.previewChromeOpacity));
    }

    restoreCanvasKeyboardFocus(): void {
        const editorView = document.getElementById('view-editor');
        if (!editorView?.classList.contains('focused') || !this.canvas) {
            return;
        }
        this.canvas.focus({ preventScroll: true });
    }

    private handlePreviewAreaChanged = (): void => {
        if (this.outlineEditor.isPreviewMode || this.previewChromeOpacity < 1) {
            this.previewViewportGuide = this.getPreviewViewportGuide();
        }
        this.applyPreviewChromeClasses();
        this.render();
    };

    setupEventListeners(): void {
        window.addEventListener(
            'layerFingerprintChanged',
            this.handleLayerFingerprintChanged
        );
        window.addEventListener('fontModelSync', this.handleFontModelSync);
        window.addEventListener(
            'editorPreviewAreaChanged',
            this.handlePreviewAreaChanged
        );

        // Mouse events for panning
        this.canvas!.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas!.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas!.addEventListener('mouseup', (e) => {
            void this.onMouseUp(e);
        });
        this.canvas!.addEventListener('mouseleave', (e) =>
            this.onMouseLeave(e)
        );
        this.canvas!.addEventListener('contextmenu', (e) => {
            const rect = this.canvas!.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
            this.mouseCanvasY =
                (this.mouseY * this.canvas!.height) / rect.height;

            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e);
                this.updateHoveredGlyph();
            }

            this.outlineEditor.onContextMenu(e);
        });

        // Wheel event for zooming
        this.canvas!.addEventListener('wheel', (e) => this.onWheel(e), {
            passive: false
        });

        // Mouse move for hover detection
        this.canvas!.addEventListener('mousemove', (e) =>
            this.onMouseMoveHover(e)
        );

        // Keyboard events for cursor and text input
        this.canvas!.addEventListener('keydown', (e) => {
            this.syncBrowserWindowActiveState();

            const editorView = document.getElementById('view-editor');
            if (!editorView?.classList.contains('focused')) {
                // View activation via keyboard can leave the canvas focused
                // briefly; never type into the editor unless it is the focused view.
                return;
            }

            if (this.shouldBlockTextEditingDuringLoopAnimation(e)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            console.log(
                'keydown:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
            // Cmd/Ctrl/Alt+Tab is an OS app switch — drop command drawing immediately
            // so guides are not left armed while the window is backgrounded.
            if (this.isOsAppSwitcherTabEvent(e)) {
                this.clearModifierDrawingForWindowDeactivation();
                return;
            }
            // Track Tab for the measurement tool and keep focus on the canvas
            if (e.key === 'Tab' && !e.defaultPrevented) {
                e.preventDefault();
                if (!this.measurementKeyPressed) {
                    this.measurementKeyPressed = true;
                    this.measurementTool.handleMeasurementKeyPress();
                    this.render();
                }
            }
            this.onKeyDown(e);
            this.noteModifierPointerOrKeyEvent(e);
            if (e.key === 'Alt') {
                // Duplicate non-repeat Alt while already down = missed keyup /
                // synthetic re-entry after Cmd+Tab. Do not keep drawing aids on.
                if (this.outlineEditor.altKeyPressed && !e.repeat) {
                    this.clearModifierDrawingForWindowDeactivation();
                } else if (this.shouldIgnoreAltKeyActivation()) {
                    this.altKeyRequiresFreshPress = false;
                } else {
                    this.outlineEditor.setAltKeyPressed(true);
                }
            }
            if (e.key === 'Meta' || e.key === 'Control') {
                // Live probe showed Cmd+Tab loses Meta keyup and later delivers a
                // fresh (!repeat) Meta keydown while cmdKeyPressed is still true.
                // hasFocus/blur never flip, so focus watchers cannot clear this —
                // treat duplicate non-repeat modifier keydowns as stale and clear.
                if (this.outlineEditor.cmdKeyPressed && !e.repeat) {
                    this.clearModifierDrawingForWindowDeactivation();
                } else if (this.shouldIgnoreCommandKeyActivation()) {
                    this.commandKeyRequiresFreshPress = false;
                } else {
                    this.outlineEditor.setCommandKeyPressed(true);
                    this.updateCursorStyle();
                    this.render();
                }
            }
        });
        this.canvas!.addEventListener('keyup', (e) => {
            const editorView = document.getElementById('view-editor');
            if (!editorView?.classList.contains('focused')) {
                return;
            }

            if (this.shouldBlockTextEditingDuringLoopAnimation(e)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            console.log(
                'keyup:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );

            // Track Tab release (plain Tab only — not OS app switching)
            if (
                e.key === 'Tab' &&
                !e.defaultPrevented &&
                !this.isOsAppSwitcherTabEvent(e)
            ) {
                e.preventDefault();
                this.measurementKeyPressed = false;
                this.measurementTool.handleMeasurementKeyRelease();
                this.updateCursorStyle(); // Update cursor immediately
                this.render();
            }

            // Track Space key release
            if (e.code === 'Space') {
                console.log(
                    '  -> Releasing Space key, active:',
                    this.outlineEditor.active
                );
                if (this.outlineEditor.active) {
                    // In edit mode, handle space as preview mode toggle
                    this.outlineEditor.onSpaceKeyReleased();
                } else {
                    // In text mode, handle space with delay logic
                    console.log('  -> Calling textRunEditor.handleKeyUp');
                    this.textRunEditor!.handleKeyUp(e);
                }
            }

            if (e.key === 'Alt') {
                this.altKeyRequiresFreshPress = false;
                this.outlineEditor.setAltKeyPressed(false);
            }
            if (e.key === 'Meta' || e.key === 'Control') {
                this.commandKeyRequiresFreshPress = false;
                this.outlineEditor.setCommandKeyPressed(false);
                this.updateCursorStyle();
                this.render();
            }

            this.noteModifierPointerOrKeyEvent(e);
            this.outlineEditor.onKeyUp(e);
        });

        // Reset command-drawing modifiers whenever the browser window deactivates
        // or reactivates. Cmd+Tab does not deliver a Tab key event to the page, and
        // window blur/visibility alone are unreliable on macOS — sync from hasFocus().
        const syncBrowserWindowActiveState = () => {
            this.syncBrowserWindowActiveState();
        };
        window.addEventListener('blur', syncBrowserWindowActiveState);
        window.addEventListener('focus', syncBrowserWindowActiveState);
        document.addEventListener(
            'visibilitychange',
            syncBrowserWindowActiveState
        );
        window.addEventListener('pagehide', syncBrowserWindowActiveState);
        window.addEventListener('pageshow', syncBrowserWindowActiveState);
        document.addEventListener('freeze', syncBrowserWindowActiveState);
        document.addEventListener('resume', syncBrowserWindowActiveState);
        this.browserWindowActive = this.isBrowserWindowActive();

        // Also reset when canvas loses focus
        this.canvas!.addEventListener('blur', () => {
            this.measurementKeyPressed = false;
            this.isDraggingCanvas = false;
            this.outlineEditor.cancelQueuedKeyboardPreviewMoves();
            this.outlineEditor.setCommandKeyPressed(false);
            // Note: Don't reset spaceKeyPressed here - it should be handled by the keyup event
            // Resetting it here causes preview mode to malfunction because the keyup handler
            // can't tell if preview mode was activated
            // Don't exit preview mode when canvas loses focus to sidebar elements
            // (e.g., clicking sliders). Preview mode will be managed by slider events.
            // Only exit preview mode on true blur events (window blur, etc.)
        });

        // Background-layer commands remain available while another editor control has focus.
        document.addEventListener(
            'keydown',
            (e) => {
                if (
                    window.glyphCanvas !== this ||
                    !this.outlineEditor.active ||
                    !(e.metaKey || e.ctrlKey) ||
                    e.code !== 'KeyB' ||
                    (!e.shiftKey && !e.altKey)
                ) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                void this.outlineEditor.onKeyDown(e);
            },
            true
        );

        // Outline / overview paste: use `.focused` for view routing. Layer paste
        // additionally requires active glyph editing; outlineEditor.active alone
        // is not a view target because a glyph tab can stay active in overview.
        // Chromium web custom formats (Fontra) need async clipboard.read().
        document.addEventListener(
            'paste',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }
                if (isNativeEditableClipboardTarget(e.target)) {
                    return;
                }

                const syncPayloads = collectClipboardPayloads(e.clipboardData);
                const syncParsed = parseClipboardPayloads(syncPayloads);
                if (syncParsed) {
                    this.rememberClipboardPasteKind(syncParsed.kind);
                }
                if (isTaggedStructuredClipboard(syncParsed)) {
                    if (!this.canPasteFocusedClipboard()) {
                        const overviewFocused = isViewFocused('view-overview');
                        const editorFocused = isViewFocused('view-editor');
                        if (overviewFocused || editorFocused) {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                        }
                        return;
                    }
                    this.applyParsedClipboardPaste(syncParsed!, e);
                    return;
                }

                const overviewFocused = isViewFocused('view-overview');
                const editorFocused = isViewFocused('view-editor');
                if (!overviewFocused && !editorFocused) {
                    return;
                }

                // Claim before await so default insertion cannot race Fontra.
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                void (async () => {
                    const asyncPayloads = await readClipboardPayloadsAsync();
                    const merged = mergeClipboardPayloads(
                        asyncPayloads,
                        syncPayloads
                    );
                    this.rememberClipboardPasteKind(
                        classifyClipboardPayloads(merged)
                    );
                    if (!this.canPasteFocusedClipboard()) {
                        return;
                    }
                    const parsed = parseClipboardPayloads(merged);
                    if (!parsed) {
                        return;
                    }
                    this.applyParsedClipboardPaste(parsed, null);
                })();
            },
            true
        );

        // Outline / overview copy: route by `.focused`, not outlineEditor.active.
        document.addEventListener(
            'copy',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }
                if (isNativeEditableClipboardTarget(e.target)) {
                    return;
                }
                const overviewFocused = isViewFocused('view-overview');
                const editorFocused = isViewFocused('view-editor');
                if (overviewFocused) {
                    this.copySelectedOverviewGlyphsToClipboard(e);
                    return;
                }
                if (editorFocused) {
                    this.outlineEditor.copyToClipboardEvent(e);
                }
            },
            true
        );

        // Cut often has no DOM selection, so Chromium may not fire a `cut`
        // event. Handle Cmd/Ctrl+X on keydown, and still listen for `cut`.
        document.addEventListener(
            'cut',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }
                if (isNativeEditableClipboardTarget(e.target)) {
                    return;
                }
                void this.cutFocusedClipboardSelection(e);
            },
            true
        );
        document.addEventListener(
            'keydown',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }
                if (isNativeEditableClipboardTarget(e.target)) {
                    return;
                }
                const cmdKey = e.metaKey || e.ctrlKey;
                if (
                    !cmdKey ||
                    e.altKey ||
                    e.shiftKey ||
                    e.key.toLowerCase() !== 'x'
                ) {
                    return;
                }
                if (!this.canCutFocusedClipboardSelection()) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                void this.cutFocusedClipboardSelection();
            },
            true
        );

        // Capture Tab at the document level while the editor view is focused so
        // browser focus traversal cannot move to other HTML elements first.
        document.addEventListener(
            'keydown',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }

                // Cmd/Ctrl/Alt+Tab belongs to the OS app switcher — never claim it
                // for the measurement tool, and drop any armed command drawing.
                if (this.isOsAppSwitcherTabEvent(e)) {
                    this.clearModifierDrawingForWindowDeactivation();
                    return;
                }

                if (!this.shouldHandleMeasurementTabGlobally(e)) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                this.focusCanvasForMeasurementTab();

                if (!this.measurementKeyPressed) {
                    this.measurementKeyPressed = true;
                    this.measurementTool.handleMeasurementKeyPress();
                    this.updateCursorStyle();
                    this.render();
                }
            },
            true
        );

        document.addEventListener(
            'keyup',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }

                if (e.key !== 'Tab' || !this.measurementKeyPressed) {
                    return;
                }

                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    !!editorView && editorView.classList.contains('focused');
                const activeElement =
                    document.activeElement as HTMLElement | null;
                const isCanvasActive = activeElement === this.canvas;

                if (!isCanvasActive && !isEditorFocused) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.focusCanvasForMeasurementTab();
                this.measurementKeyPressed = false;
                this.measurementTool.handleMeasurementKeyRelease();
                this.updateCursorStyle();
                this.render();
            },
            true
        );

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
        // Note: Settings panel escape is handled in theme-switcher.js with capture phase
        document.addEventListener('keydown', (e) => {
            // Block all input during stack preview animation
            if (this.stackPreviewAnimator.isInputBlocked()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) {
                // Check if stack preview is active first
                if (
                    this.stackPreviewAnimator.isActive &&
                    !this.stackPreviewAnimator.isAnimating
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.stackPreviewAnimator.reverseAnimation();
                    return;
                }
                if (!this.outlineEditor.active) {
                    this.handleTextModeEscapeKey(e);
                    return;
                }
                this.outlineEditor.onEscapeKey(e);
            }
        });

        // Intercept browser Find while the canvas owns keyboard focus.
        document.addEventListener(
            'keydown',
            (e) => {
                if (
                    !(e.metaKey || e.ctrlKey) ||
                    e.shiftKey ||
                    e.altKey ||
                    e.key.toLowerCase() !== 'f' ||
                    document.activeElement !== this.canvas
                ) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                window.findGlyphDialog.open({
                    selectionMode: 'multiple',
                    confirmLabel: 'Insert',
                    searchMemoryKey: 'find-glyphs',
                    onConfirm: (glyphNames) => {
                        const tokenText = glyphNames
                            .map((glyphName) => `/${glyphName}`)
                            .join(' ');
                        this.textRunEditor?.insertText(`${tokenText} `);
                    },
                    onClose: () => {
                        if (this.canvas) {
                            setTimeout(() => this.canvas!.focus(), 0);
                        }
                    }
                });
            },
            true
        );

        // Cmd+Alt+S handler with capture phase to activate stack preview
        document.addEventListener('keydown', (e) => {
            // Use code instead of key because Alt+S produces '‚' on macOS
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyS') {
                console.log('[GlyphCanvas] Cmd+Alt+S detected', {
                    key: e.key,
                    code: e.code,
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey,
                    outlineEditorActive: this.outlineEditor.active,
                    stackPreviewActive: this.stackPreviewAnimator.isActive,
                    stackPreviewAnimating: this.stackPreviewAnimator.isAnimating
                });

                // Check if editing view is active and in editing mode
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    editorView && editorView.classList.contains('focused');

                console.log('[GlyphCanvas] Editor focus check:', {
                    editorView: !!editorView,
                    isEditorFocused,
                    outlineEditorActive: this.outlineEditor.active
                });

                if (isEditorFocused && this.outlineEditor.active) {
                    e.preventDefault();
                    e.stopPropagation();

                    if (
                        !this.stackPreviewAnimator.isActive &&
                        !this.stackPreviewAnimator.isAnimating
                    ) {
                        console.log(
                            '[GlyphCanvas] Starting stack preview mode'
                        );
                        this.stackPreviewAnimator.startAnimation();
                    } else if (
                        this.stackPreviewAnimator.isActive &&
                        !this.stackPreviewAnimator.isAnimating
                    ) {
                        console.log('[GlyphCanvas] Closing stack preview mode');
                        this.stackPreviewAnimator.reverseAnimation();
                    } else {
                        console.log(
                            '[GlyphCanvas] Stack preview already active or animating'
                        );
                    }
                } else {
                    console.log(
                        '[GlyphCanvas] Not starting stack preview - editor not focused or not active'
                    );
                }
            }
        });

        document.addEventListener(
            'keydown',
            (e) => {
                if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyL') {
                    const editorView = document.querySelector('#view-editor');
                    const isEditorFocused =
                        !!editorView &&
                        editorView.classList.contains('focused');

                    if (!isEditorFocused || !this.outlineEditor.active) {
                        return;
                    }

                    e.preventDefault();
                    e.stopPropagation();

                    const summaryLinkButton =
                        this.propertiesSection?.querySelector(
                            '.editor-layer-link-summary-toggle'
                        ) as HTMLButtonElement | null;
                    summaryLinkButton?.click();
                }
            },
            true
        );

        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyG') {
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    !!editorView && editorView.classList.contains('focused');

                if (!isEditorFocused) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                this.outlineEditor.toggleGuidelinesVisible();
            }
        });

        // Focus/blur for cursor blinking
        this.canvas!.addEventListener('focus', () => this.onFocus());
        this.canvas!.addEventListener('blur', () => this.onBlur());

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Viewport resize (window and splitters) plus overlay chrome (property
        // panel). The panel does not change the host box, so observe it too.
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.canvasHost || this.container);
        if (this.propertyPanel) {
            this.resizeObserver.observe(this.propertyPanel);
            this.propertyPanelClassObserver = new MutationObserver(() =>
                this.onResize()
            );
            this.propertyPanelClassObserver.observe(this.propertyPanel, {
                attributes: true,
                attributeFilter: ['class']
            });
        }

        // Sidebar click handlers to restore canvas focus in editor mode
        this.setupSidebarFocusHandlers();
        this.setupAxesManagerEventHandlers();
        this.featuresManager!.on('change', async () => {
            console.log(
                '[GlyphCanvas]',
                'Features changed, re-running Stage 2 shaping'
            );

            // Re-run Stage 2 only (apply new feature settings to existing glyphs).
            // Layout closure ensures all substituted glyphs are already in the editing font,
            // so no compile is needed for feature toggles.
            console.log(
                '[GlyphCanvas]',
                'Re-running Stage 2 with updated features (no font recompilation needed)'
            );
            const textRun = this.textRunEditor!;
            const fromSelectedIndex = textRun.selectedGlyphIndex;
            const fromSnapshot = snapshotShapedRun(
                textRun.shapedGlyphs,
                textRun.glyphNameBuffer
            );
            const fromAnchor = this.getViewportAnchorFontPosition();
            const fromAnchorScreen = this.viewportManager
                ? this.viewportManager.fontToScreenCoordinates(
                      fromAnchor.x,
                      fromAnchor.y
                  )
                : null;
            if (!this.outlineEditor.active) {
                this.textModeAutoPanAnchorScreen = fromAnchorScreen;
            }

            this.textRunEditor!.shapeStage2WithBiDiRuns();

            // Build cluster map and update cursor position
            this.textRunEditor!.buildClusterMap();
            this.textRunEditor!.updateCursorVisualPosition();

            if (this.outlineEditor.active) {
                if (textRun.selectedGlyphIndex >= textRun.shapedGlyphs.length) {
                    textRun.selectedGlyphIndex = Math.max(
                        0,
                        textRun.shapedGlyphs.length - 1
                    );
                }
                await this.syncEditModeGlyphAfterTextMutation();
            }

            const toAnchor = this.getViewportAnchorFontPosition();
            const started = this.featureChangeAnimator?.begin(
                fromSnapshot,
                snapshotShapedRun(
                    textRun.shapedGlyphs,
                    textRun.glyphNameBuffer
                ),
                {
                    fromSelectedIndex,
                    toSelectedIndex: textRun.selectedGlyphIndex,
                    editMode:
                        this.outlineEditor.active &&
                        !this.outlineEditor.isPreviewMode,
                    viewportAnchor:
                        fromAnchorScreen && this.viewportManager
                            ? {
                                  screenX: fromAnchorScreen.x,
                                  screenY: fromAnchorScreen.y,
                                  fromFontX: fromAnchor.x,
                                  fromFontY: fromAnchor.y,
                                  toFontX: toAnchor.x,
                                  toFontY: toAnchor.y,
                                  lockY: this.outlineEditor.active
                              }
                            : null
                }
            );

            if (!this.outlineEditor.active && !started) {
                this.applyTextModeAutoPanAdjustment();
                this.textModeAutoPanAnchorScreen = null;
            } else if (!this.outlineEditor.active && started) {
                this.textModeAutoPanAnchorScreen = null;
            }

            this.render();
        });
        this.setupTextEditorEventHandlers();
    }

    setupSidebarFocusHandlers(): void {
        // Add event listeners to both sidebars to restore canvas focus when clicked in editor mode
        const leftSidebar = document.getElementById('glyph-properties-sidebar');
        const rightSidebar = document.getElementById('glyph-editor-sidebar');

        const restoreFocus = (e: MouseEvent) => {
            // Don't restore focus if clicking on text input fields
            const target = e.target as HTMLElement;
            if (target && this.isTextInputElement(target)) {
                return;
            }

            // Always restore focus to canvas when clicking sidebar
            setTimeout(() => this.canvas!.focus(), 0);
        };

        if (leftSidebar) {
            leftSidebar.addEventListener('mousedown', restoreFocus);
        }

        if (rightSidebar) {
            rightSidebar.addEventListener('mousedown', restoreFocus);
        }
    }

    isTextInputElement(element: HTMLElement): boolean {
        if (!element) return false;

        const tagName = element.tagName?.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();

        // Check if it's a text input type
        if (tagName === 'input') {
            const textInputTypes = [
                'text',
                'password',
                'email',
                'search',
                'tel',
                'url',
                'number'
            ];
            return !type || textInputTypes.includes(type);
        }

        // Check if it's a textarea
        if (tagName === 'textarea') {
            return true;
        }

        if (tagName === 'select') {
            return true;
        }

        return false;
    }

    /**
     * Command drawing must never stay armed across browser-window deactivation
     * (Cmd+Tab, etc.). Tab itself is not delivered to the page by macOS, so we
     * key off document.hasFocus() / visibility and poll while modifiers are down.
     */
    private isBrowserWindowActive(): boolean {
        return document.visibilityState === 'visible' && document.hasFocus();
    }

    syncBrowserWindowActiveState(): void {
        const active = this.isBrowserWindowActive();
        if (active === this.browserWindowActive) {
            // Event delivery can be flaky: re-assert clear while inactive.
            if (!active) {
                this.clearModifierDrawingForWindowDeactivation();
            }
            return;
        }

        this.browserWindowActive = active;
        if (!active) {
            this.clearModifierDrawingForWindowDeactivation();
            this.isDraggingCanvas = false;
            this.outlineEditor.onBlur();
            if (this.canvas) {
                this.canvas.style.cursor = this.outlineEditor.active
                    ? 'default'
                    : 'text';
            }
            return;
        }

        this.resetModifiersAfterWindowActivation();
    }

    private isOsAppSwitcherTabEvent(e: KeyboardEvent): boolean {
        return e.key === 'Tab' && (e.metaKey || e.ctrlKey || e.altKey);
    }

    private clearModifierDrawingForWindowDeactivation(): void {
        const wasCommandPressed = this.outlineEditor.cmdKeyPressed;
        const wasAltPressed = this.outlineEditor.altKeyPressed;
        const wasMeasuring = this.measurementKeyPressed;

        this.stopModifierFocusWatch();
        this.outlineEditor.setCommandKeyPressed(false);
        this.outlineEditor.setAltKeyPressed(false);
        this.armModifierKeyFocusSuppression();

        if (wasMeasuring) {
            this.measurementKeyPressed = false;
            this.measurementTool.handleMeasurementKeyRelease();
        }

        if (wasCommandPressed || wasAltPressed || wasMeasuring) {
            this.updateCursorStyle();
            this.render();
        }
    }

    private armModifierKeyFocusSuppression(): void {
        this.commandKeyRequiresFreshPress = true;
        this.altKeyRequiresFreshPress = true;
        // Cover delayed synthetic Meta events after focus returns.
        const suppressUntil = performance.now() + 1000;
        this.commandKeyActivationSuppressedUntil = suppressUntil;
        this.altKeyActivationSuppressedUntil = suppressUntil;
    }

    private resetModifiersAfterWindowActivation(): void {
        this.clearModifierDrawingForWindowDeactivation();
        // Beat synthetic Meta keydowns that race after the focus/visibility event.
        for (const delayMs of [0, 50, 100, 250, 500]) {
            window.setTimeout(() => {
                if (!this.isBrowserWindowActive()) {
                    return;
                }
                this.outlineEditor.setCommandKeyPressed(false);
                this.outlineEditor.setAltKeyPressed(false);
            }, delayMs);
        }
    }

    private shouldIgnoreCommandKeyActivation(): boolean {
        return (
            !this.isBrowserWindowActive() ||
            this.commandKeyRequiresFreshPress ||
            performance.now() < this.commandKeyActivationSuppressedUntil
        );
    }

    private shouldIgnoreAltKeyActivation(): boolean {
        return (
            !this.isBrowserWindowActive() ||
            this.altKeyRequiresFreshPress ||
            performance.now() < this.altKeyActivationSuppressedUntil
        );
    }

    private noteModifierPointerOrKeyEvent(
        e: Pick<KeyboardEvent | MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey'>
    ): void {
        // Authoritative sync from event modifier flags. After Cmd+Tab, keyup is
        // often lost while hasFocus/blur never change — mouse/key events still
        // report the real metaKey/ctrlKey/altKey state.
        if (this.outlineEditor.cmdKeyPressed && !e.metaKey && !e.ctrlKey) {
            this.outlineEditor.setCommandKeyPressed(false);
            this.armModifierKeyFocusSuppression();
        }
        if (this.outlineEditor.altKeyPressed && !e.altKey) {
            this.outlineEditor.setAltKeyPressed(false);
            this.altKeyRequiresFreshPress = true;
            this.altKeyActivationSuppressedUntil = performance.now() + 1000;
        }

        // Do not drop the fresh-press latch during the post-focus suppress window;
        // early mousemove events would otherwise re-arm Cmd drawing too soon.
        if (performance.now() < this.commandKeyActivationSuppressedUntil) {
            return;
        }
        if (!e.metaKey && !e.ctrlKey) {
            this.commandKeyRequiresFreshPress = false;
        }
        if (
            performance.now() >= this.altKeyActivationSuppressedUntil &&
            !e.altKey
        ) {
            this.altKeyRequiresFreshPress = false;
        }
    }

    /** Poll hasFocus() while Cmd/Alt drawing is armed — blur events are unreliable. */
    startModifierFocusWatch(): void {
        if (this.modifierFocusWatchRaf != null) {
            return;
        }
        const tick = () => {
            this.modifierFocusWatchRaf = null;
            if (
                !this.outlineEditor.cmdKeyPressed &&
                !this.outlineEditor.altKeyPressed
            ) {
                return;
            }
            if (!this.isBrowserWindowActive()) {
                this.syncBrowserWindowActiveState();
                return;
            }
            this.modifierFocusWatchRaf = window.requestAnimationFrame(tick);
        };
        this.modifierFocusWatchRaf = window.requestAnimationFrame(tick);
    }

    stopModifierFocusWatch(): void {
        if (this.modifierFocusWatchRaf == null) {
            return;
        }
        window.cancelAnimationFrame(this.modifierFocusWatchRaf);
        this.modifierFocusWatchRaf = null;
    }

    private shouldHandleMeasurementTabGlobally(event: KeyboardEvent): boolean {
        if (event.key !== 'Tab') {
            return false;
        }

        // Leave Cmd/Ctrl/Alt+Tab to the OS app switcher.
        if (this.isOsAppSwitcherTabEvent(event)) {
            return false;
        }

        const target = event.target as HTMLElement | null;
        if (target && this.isTextInputElement(target)) {
            return false;
        }

        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            !!editorView && editorView.classList.contains('focused');
        const activeElement = document.activeElement as HTMLElement | null;
        const isCanvasActive = activeElement === this.canvas;

        return isCanvasActive || isEditorFocused;
    }

    private focusCanvasForMeasurementTab(): void {
        if (!this.canvas || document.activeElement === this.canvas) {
            return;
        }

        this.canvas.focus({ preventScroll: true });
    }

    private focusCanvasForTextModeKerning(): void {
        if (this.outlineEditor.active) {
            return;
        }

        this.focusCanvasForMeasurementTab();
    }

    shouldBlockTextEditingDuringLoopAnimation(e: KeyboardEvent): boolean {
        if (!this.axesManager?.isLoopAnimating || this.outlineEditor.active) {
            return false;
        }

        if (e.metaKey || e.ctrlKey) {
            return false;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            return true;
        }

        if (e.code === 'Space') {
            return true;
        }

        return e.key.length === 1;
    }

    setupAxesManagerEventHandlers(): void {
        this.axesManager!.on('sliderMouseDown', async () => {
            // Ensure a full compile (with features/kerning) exists before
            // axis changes, since HarfBuzz shaping during slider animation
            // depends on GPOS/kerning tables being present in the font.
            await fontManager.ensureFullEditingCompile();
            this.outlineEditor.onSliderMouseDown();
            // Also capture text mode cursor position for auto-panning
            if (!this.outlineEditor.active && this.textRunEditor) {
                const selectedMasterId = this.textRunEditor.selectedMasterId;
                if (
                    this.axesManager &&
                    this.textModeEscapeState.save(
                        selectedMasterId,
                        this.axesManager.variationSettings
                    )
                ) {
                    console.log(
                        '[GlyphCanvas] Saved previous text mode state for Escape:',
                        {
                            masterId: selectedMasterId,
                            settings: this.axesManager.variationSettings
                        }
                    );
                }

                this.textRunEditor.selectedMasterId = null;
                this.updateMasterSelection();
                this.captureTextModeAutoPanAnchor();
            }
        });
        this.axesManager!.on('sliderMouseUp', async () => {
            console.log('[GlyphCanvas] sliderMouseUp event triggered');
            if (this.outlineEditor.active) {
                console.log(
                    '[GlyphCanvas] Calling outlineEditor.onSliderMouseUp()'
                );
                await this.outlineEditor.onSliderMouseUp();
            } else {
                await this.finalizeTextModeSliderInteraction();
                // In text editing mode, restore focus to canvas
                // Clear auto-pan anchor if animation is already complete
                if (!this.axesManager!.isAnimating) {
                    this.textModeAutoPanAnchorScreen = null;
                }
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on('textFieldAnimationComplete', async () => {
            // Skip layer selection during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            // Handle layer selection after text field change animation completes
            if (this.outlineEditor.active) {
                await this.outlineEditor.autoSelectMatchingLayer();
                this.outlineEditor.isInterpolating = false;
                this.render();
            }
        });
        this.axesManager!.on('animationInProgress', () => {
            // In text mode, reshape with HarfBuzz and apply auto-pan together (skip render in shapeText)
            if (!this.outlineEditor.active) {
                this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
                this.applyTextModeAutoPanAdjustment();
                this.render(); // Single render after both HarfBuzz and auto-pan are updated
            } else {
                // The worker response updates both the active outline and
                // HarfBuzz together at one immutable interpolation location.
                this.outlineEditor.animationInProgress();
            }
        });
        this.axesManager!.on('animationComplete', async () => {
            try {
                console.log('[GlyphCanvas] animationComplete event triggered', {
                    isInterpolating: this.outlineEditor.isInterpolating,
                    isLayerSwitchAnimating:
                        this.outlineEditor.isLayerSwitchAnimating,
                    isSliderActive: this.axesManager!.isSliderActive
                });
            } catch (e) {
                console.error(
                    '[GlyphCanvas] ERROR in animationComplete initial logging:',
                    e
                );
            }
            // If we were animating a layer switch, restore the target layer data
            if (this.outlineEditor.isLayerSwitchAnimating) {
                console.log(
                    '[GlyphCanvas] Animation complete - calling restoreTargetLayerDataAfterAnimating()'
                );
                this.outlineEditor.restoreTargetLayerDataAfterAnimating();
                this.outlineEditor.isLayerSwitchAnimating = false;
                console.log(
                    '[GlyphCanvas] Layer switch animation restoration complete'
                );

                // NOTE: autoSelectMatchingLayer() is already called inside restoreTargetLayerDataAfterAnimating()
                // so we don't need to call it again here

                this.textRunEditor!.shapeText();
                this.textModeAutoPanAnchorScreen = null;
                return;
            }

            // During edit interpolation, the accepted worker response shapes
            // HarfBuzz at that response's exact location and owns the paint.
            // A separate final reshape would pair a newer text run with an
            // older outline and bypass its bbox-center anchoring.
            if (this.outlineEditor.isInterpolating) {
                return;
            }

            // No edit interpolation is active, so HarfBuzz owns the final paint.
            this.textRunEditor!.shapeText();

            // Restore focus to canvas after animation completes (for text editing mode)
            if (!this.outlineEditor.active) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on(
            'onSliderChange',
            this.outlineEditor.onSliderChange.bind(this.outlineEditor)
        );
        // Auto-select or deselect master/layer when slider changes
        this.axesManager!.on('onSliderChange', () => {
            // Skip layer selection during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            if (this.outlineEditor.active) {
                // In edit mode, auto-select matching layer during slider drag
                console.log(
                    '[GlyphCanvas] Slider changed in edit mode, calling autoSelectMatchingLayer'
                );
                this.outlineEditor.autoSelectMatchingLayer();
            } else {
                // In text mode, auto-select matching master
                console.log(
                    '[GlyphCanvas] Slider changed, calling autoSelectMatchingMaster'
                );
                this.autoSelectMatchingMaster();
            }
        });
        // Also check after animation completes to handle the final value
        this.axesManager!.on('animationComplete', () => {
            // Skip during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            // Skip during layer switch animations - layer restoration will handle it
            if (this.outlineEditor.isLayerSwitchAnimating) {
                console.log(
                    '[GlyphCanvas] Animation complete during layer switch - skipping autoSelectMatchingMaster'
                );
                return;
            }
            console.log(
                '[GlyphCanvas] Animation complete, calling autoSelectMatchingMaster'
            );
            if (this.outlineEditor.active) {
                void this.outlineEditor.autoSelectMatchingLayer();
            } else {
                this.autoSelectMatchingMaster();
            }
        });
    }

    setupTextEditorEventHandlers(): void {
        this.textRunEditor!.on('willreshape', () => {
            this.cancelFeatureChangeAnimation();
        });
        this.textRunEditor!.on('cursormoved', (reason?: string) => {
            this.updatePropertyPanel();
            if (this.hasPendingIdleViewLock() || this.renderSuppressed) {
                return;
            }
            this.panToCursor(reason === 'backspace');
            this.render();
        });
        this.textRunEditor!.on('textchanged', () => {
            this.onTextChange();
        });
        this.textRunEditor!.on('render', () => {
            if (this.outlineEditor.active) {
                const nextGlyphName = this.getCurrentGlyphName();
                const activeRootGlyphName =
                    this.getActiveEditModeRootGlyphName();

                if (
                    nextGlyphName &&
                    nextGlyphName !== 'undefined' &&
                    nextGlyphName !== activeRootGlyphName
                ) {
                    void this.syncEditModeGlyphAfterTextMutation();
                    return;
                }
            }

            this.updatePropertyPanel();
            this.render();
        });
        this.textRunEditor!.on('exitcomponentediting', () => {
            this.outlineEditor.exitAllComponentEditing();
        });
        this.textRunEditor!.on('activatePreviewMode', () => {
            // Activate preview mode when space key timer expires in text mode
            this.outlineEditor.spaceKeyPressed = true;
            this.setPreviewMode(true);
            // Store current cursor style and switch to grab cursor
            this.textRunEditor!.cursorStyleBeforePreview =
                this.canvas!.style.cursor;
            this.canvas!.style.cursor = 'grab';
            this.render();
        });
        this.textRunEditor!.on('deactivatePreviewMode', () => {
            // Deactivate preview mode when space key is released after long press
            console.log(
                '[GlyphCanvas] Deactivating preview mode, current state:',
                {
                    spaceKeyPressed: this.outlineEditor.spaceKeyPressed,
                    isPreviewMode: this.outlineEditor.isPreviewMode
                }
            );
            this.outlineEditor.spaceKeyPressed = false;
            this.setPreviewMode(false);
            // Restore previous cursor style
            if (this.textRunEditor!.cursorStyleBeforePreview) {
                this.canvas!.style.cursor =
                    this.textRunEditor!.cursorStyleBeforePreview;
                this.textRunEditor!.cursorStyleBeforePreview = null;
            } else {
                // Fallback to text cursor
                this.canvas!.style.cursor = 'text';
            }
            // Ensure text cursor is visible
            this.cursorVisible = true;
            console.log('[GlyphCanvas] After deactivation:', {
                spaceKeyPressed: this.outlineEditor.spaceKeyPressed,
                isPreviewMode: this.outlineEditor.isPreviewMode,
                cursorVisible: this.cursorVisible
            });
            this.render();
        });
        this.textRunEditor!.on(
            'glyphselected',
            async (
                ix: number,
                previousIndex: number,
                fromKeyboard: boolean = false
            ) => {
                this.cancelFeatureChangeAnimation();
                const wasInEditMode = this.outlineEditor.active;

                // Increment sequence counter to track this selection
                this.glyphSelectionSequence++;
                const currentSequence = this.glyphSelectionSequence;

                if (
                    wasInEditMode &&
                    previousIndex >= 0 &&
                    previousIndex !== ix
                ) {
                    const nextGlyphName =
                        ix >= 0 && ix < this.textRunEditor!.shapedGlyphs.length
                            ? this.getCurrentGlyphName()
                            : 'undefined';
                    this.outlineEditor.prepareForGlyphSwitch(nextGlyphName);
                    if (nextGlyphName && nextGlyphName !== 'undefined') {
                        this.outlineEditor.currentGlyphName =
                            this.outlineEditor.getAuthoringGlyphName(
                                nextGlyphName
                            );
                    }
                }

                // Clear layer data immediately to prevent rendering stale outlines
                this.outlineEditor.layerData = null;

                // Clear glyph_stack when switching to a new glyph
                // It will be rebuilt when a layer is selected for the new glyph
                this.outlineEditor.glyphStack = '';

                if (ix != -1) {
                    this.outlineEditor.active = true;
                    this.outlineEditor.syncEditToolAvailability(!wasInEditMode);
                    // Dispatch mode change event for URL sync
                    window.dispatchEvent(
                        new CustomEvent('editorModeChanged', {
                            detail: { mode: 'edit' }
                        })
                    );
                }
                // Update breadcrumb (will hide it since component stack is now empty)
                if (
                    fromKeyboard &&
                    wasInEditMode &&
                    ix >= 0 &&
                    previousIndex !== ix
                ) {
                    await this.doUIUpdateAsync();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render for sequence',
                            currentSequence
                        );
                        return;
                    }
                } else {
                    // Not panning, just do regular UI update
                    this.doUIUpdate();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render for sequence',
                            currentSequence
                        );
                        return;
                    }
                }

                this.outlineEditor.onGlyphSelected();
                if (
                    fromKeyboard &&
                    wasInEditMode &&
                    ix >= 0 &&
                    previousIndex !== ix &&
                    this.viewportManager &&
                    this.canvas
                ) {
                    const bounds =
                        this.outlineEditor.calculateGlyphBoundingBox();
                    if (bounds) {
                        this.viewportManager.panToGlyph(
                            bounds,
                            this.textRunEditor!._getGlyphPosition(ix),
                            this.getCanvasContentFrame(),
                            () => this.render()
                        );
                    }
                }
                this.dispatchModeActivationEvent('edit', 'glyphselected');
            }
        );
    }

    /**
     * The bitmap is not a descendant of `#view-editor`, so cutout clicks do
     * not bubble to the view click-focus handler. Mirror that handler here.
     */
    private focusEditorViewFromCanvasPointer(): void {
        const editorView = document.getElementById('view-editor');
        if (!editorView || typeof window.focusView !== 'function') {
            return;
        }
        const isCollapsed =
            editorView.classList.contains('collapsed') ||
            editorView.classList.contains('collapsed-width');
        if (!editorView.classList.contains('focused') || isCollapsed) {
            window.focusView('view-editor');
        }
    }

    async onMouseDown(e: MouseEvent): Promise<void> {
        if (e.button === 2) {
            return;
        }

        this.focusEditorViewFromCanvasPointer();

        // Start each pointer gesture from a clean pan state. Mouseup can be
        // missed when a previous pan leaves the canvas/window.
        this.isDraggingCanvas = false;

        if (this.featureChangeAnimator?.isActive()) {
            this.cancelFeatureChangeAnimation();
            this.render();
        }

        // Focus the canvas when clicked
        this.canvas!.focus();
        this.noteModifierPointerOrKeyEvent(e);
        this.outlineEditor.setCommandKeyPressed(
            (e.metaKey || e.ctrlKey) && !this.shouldIgnoreCommandKeyActivation()
        );

        // Refresh mouse position + hover targets at click time.
        // Double-click handling relies on hovered* state and can otherwise use stale values
        // when the pointer did not move just before the click.
        const rect = this.canvas!.getBoundingClientRect();
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;
        if (!this.measurementTool.shouldBlockHitDetection()) {
            this.outlineEditor.performHitDetection(e);
            this.updateHoveredGlyph();
        }

        // Priority: If Space key is pressed, start canvas panning immediately
        if (this.outlineEditor.spaceKeyPressed) {
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }

        // Check for double-click
        if (e.detail === 2) {
            // In outline editor mode with layer selected
            const doubleClickHandled = this.outlineEditor.onDoubleClick(e);
            if (doubleClickHandled) {
                return; // Skip single-click logic
            }

            // Double-click on glyph - select glyph (when not in edit mode)
            if (
                !this.outlineEditor.active &&
                this.outlineEditor.hoveredGlyphIndex >= 0
            ) {
                this.textRunEditor!.selectGlyphByIndex(
                    this.outlineEditor.hoveredGlyphIndex
                );
                return;
            }
        }

        // Viewer / sparse-hidden-glyph lock: still allow double-click to
        // select a glyph. Block only mutating click paths.
        if (window.cloudPlugin?.canMutateCurrentAsset?.() === false) {
            return;
        }

        // Let the measurement tool claim the click before edit-mode selection logic.
        if (this.measurementTool.handleMouseDown(e.clientX, e.clientY, rect)) {
            this.updateCursorStyle();
            this.render();
            return;
        }

        await this.outlineEditor.onSingleClick(e);

        if (this.outlineEditor.draggingSomething) {
            this.isDraggingCanvas = false;
            return;
        }

        // Check if clicking on text to place caret / start selection (text mode only).
        // Works over glyphs too — double-click still enters edit mode above.
        // Skip modifier chords other than Shift (used to extend an existing selection).
        if (
            !this.outlineEditor.active &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            e.detail < 2
        ) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.startTextSelectionDrag(clickedPos, e.shiftKey);
                this.render();
                this.canvas!.style.cursor = 'text';
                return; // Don't start canvas panning while selecting text
            }

            // Click outside the text hit band clears any active selection.
            if (this.textRunEditor?.hasSelection()) {
                this.textRunEditor.clearSelection();
                this.render();
            }
        }

        // Start canvas panning when Space key is pressed
        if (this.outlineEditor.spaceKeyPressed) {
            console.log(
                'Starting canvas panning, spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas!.style.cursor = 'grabbing';
        } else {
            console.log(
                'Not starting panning, spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
        }
    }

    onMouseMove(e: MouseEvent): void {
        if (this.isSelectingText) {
            this.updateTextSelectionDrag(e);
            return;
        }

        this.outlineEditor.onMouseMove(e);

        if (this.outlineEditor.draggingSomething) {
            this.isDraggingCanvas = false;
            return;
        }

        // Handle measurement dragging
        if (this.measurementTool.isDragging) {
            this.render();
            return;
        }

        // Handle canvas panning
        if (this.isDraggingCanvas) {
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;

            this.clearCmdZeroStage1();
            this.viewportManager!.pan(deltaX, deltaY);

            // Update mouse position for hit-testing during pan
            const rect = this.canvas!.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
            this.mouseCanvasY =
                (this.mouseY * this.canvas!.height) / rect.height;

            // Perform hit-testing during panning (both text mode and editing mode)
            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e);
                this.updateHoveredGlyph();
                this.updateCursorStyle(e); // Update cursor after hit-testing
            }

            this.render();

            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }
    }

    async onMouseUp(e: MouseEvent): Promise<void> {
        this.endTextSelectionDrag();

        const deferRenderToSidebearingPreview =
            this.outlineEditor.isLiveSidebearingInteractionActive();
        const finalization = this.outlineEditor.onMouseUp(e).catch((error) => {
            console.error('Outline mouseup failed:', error);
        });
        const trackedFinalization = finalization.finally(() => {
            if (this.mouseUpFinalization === trackedFinalization) {
                this.mouseUpFinalization = null;
            }
        });
        this.mouseUpFinalization = trackedFinalization;
        this.isDraggingCanvas = false;
        this.measurementTool.handleMouseUp();

        // Update cursor based on current mouse position and Cmd key state
        this.updateCursorStyle(e);

        if (!deferRenderToSidebearingPreview) {
            this.render();
        }

        await finalization;
    }

    onMouseLeave(e: MouseEvent): void {
        // Keep an in-progress text selection alive outside the canvas; document
        // mouseup (via the drag listeners) finalizes it.
        if (this.isSelectingText) {
            const hadHover =
                this.outlineEditor.hoveredGlyphIndex >= 0 ||
                this.outlineEditor.hoveredGuideHandle !== null ||
                this.outlineEditor.hoveredComponentIndex !== null ||
                this.outlineEditor.hoveredAnchorIndex !== null ||
                this.outlineEditor.hoveredPointIndex !== null ||
                this.outlineEditor.hoveredAddPointPreview !== null ||
                this.outlineEditor.hoveredCommandCurvePreview !== null;

            this.outlineEditor.hoveredGlyphIndex = -1;
            this.outlineEditor.hoveredGuideHandle = null;
            this.outlineEditor.hoveredComponentIndex = null;
            this.outlineEditor.hoveredAnchorIndex = null;
            this.outlineEditor.hoveredPointIndex = null;
            this.outlineEditor.hoveredAddPointPreview = null;
            this.outlineEditor.hoveredCommandCurvePreview = null;

            if (hadHover) {
                this.render();
            }
            return;
        }

        // Call onMouseUp first to handle any ongoing drag operations
        void this.onMouseUp(e);

        // Clear all hover states when mouse leaves the canvas
        const hadHover =
            this.outlineEditor.hoveredGlyphIndex >= 0 ||
            this.outlineEditor.hoveredGuideHandle !== null ||
            this.outlineEditor.hoveredComponentIndex !== null ||
            this.outlineEditor.hoveredAnchorIndex !== null ||
            this.outlineEditor.hoveredPointIndex !== null ||
            this.outlineEditor.hoveredAddPointPreview !== null ||
            this.outlineEditor.hoveredCommandCurvePreview !== null;

        this.outlineEditor.hoveredGlyphIndex = -1;
        this.outlineEditor.hoveredGuideHandle = null;
        this.outlineEditor.hoveredComponentIndex = null;
        this.outlineEditor.hoveredAnchorIndex = null;
        this.outlineEditor.hoveredPointIndex = null;
        this.outlineEditor.hoveredAddPointPreview = null;
        this.outlineEditor.hoveredCommandCurvePreview = null;

        // Re-render only if there was a hover state to clear
        if (hadHover) {
            this.render();
        }
    }

    onWheel(e: WheelEvent): void {
        e.preventDefault();

        // If Tab is pressed, turn off the measurement tool (cancel delay or hide if visible)
        if (this.measurementKeyPressed) {
            this.measurementTool.handleWheel();
            this.updateCursorStyle(); // Update cursor immediately
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Update mouse position from wheel event (mouse doesn't move during trackpad pan)
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;

        // Perform viewport pan/zoom (will call render callback)
        this.clearCmdZeroStage1();
        this.viewportManager!.handleWheel(e, rect, () => {
            // After pan/zoom, perform hit-testing since content moved under static cursor
            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e as any);
                this.updateHoveredGlyph();
                this.updateCursorStyle(e as any); // Update cursor after hit-testing
            }
            this.render();
        });
    }

    onMouseMoveHover(e: MouseEvent): void {
        if (this.isSelectingText) return;
        if (this.outlineEditor.draggingSomething) return; // Don't detect hover while dragging

        // Focus events are unreliable on Cmd+Tab; re-sync from hasFocus() here.
        this.syncBrowserWindowActiveState();

        // Clear post-focus Cmd/Alt suppression once the modifier is no longer held
        // (covers synthetic Meta keydowns that never receive a keyup).
        this.noteModifierPointerOrKeyEvent(e);

        const rect = this.canvas!.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;

        // Don't perform hit detection when measurement tool is active
        if (!this.measurementTool.shouldBlockHitDetection()) {
            this.outlineEditor.performHitDetection(e);
            this.updateHoveredGlyph();
        }

        // Update cursor style based on position (after updating hover states)
        this.updateCursorStyle(e);

        // Re-render when auxiliary overlays depend on the pointer position.
        // Command-path snapping needs this even before a preview line exists,
        // because Cmd-hover alone can show snap guides/candidates.
        if (
            this.measurementKeyPressed ||
            this.outlineEditor.cmdKeyPressed ||
            this.outlineEditor.isPenDrawArmed() ||
            this.outlineEditor.shouldRenderCommandPathPreview()
        ) {
            this.render();
        }
    }

    updateCursorStyle(e?: MouseEvent | KeyboardEvent): void {
        // Tab pressed in editing mode with measurement tool visible = crosshair cursor
        if (this.measurementTool.shouldShowCrosshair()) {
            this.canvas!.style.cursor = 'crosshair';
            return;
        }

        // Space key pressed in edit mode = show grab cursor for panning
        // In text mode preview = show grab cursor for panning
        if (this.outlineEditor.spaceKeyPressed) {
            this.canvas!.style.cursor = this.isDraggingCanvas
                ? 'grabbing'
                : 'grab';
            return;
        }

        // Stack preview has its own transformed hit targets and pointer behavior.
        if (this.stackPreviewAnimator.shouldRenderStackPreview()) {
            this.canvas!.style.cursor =
                this.stackPreviewAnimator.hoveredLayerTreeIndex !== null
                    ? 'pointer'
                    : 'default';
            return;
        }

        // In outline editor mode, let it control the cursor
        if (this.outlineEditor.active) {
            this.outlineEditor.cursorStyle();
            return;
        }

        // In text mode, show pointer when hovering a glyph (including empty
        // glyphs with a metrics hit target) so double-click-to-edit is clear.
        // Otherwise show the I-beam only inside the text interaction band.
        if (this.outlineEditor.hoveredGlyphIndex !== -1) {
            this.canvas!.style.cursor = 'pointer';
        } else if (
            this.isSelectingText ||
            this.isPointerInTextInteractionBand()
        ) {
            this.canvas!.style.cursor = 'text';
        } else {
            this.canvas!.style.cursor = 'default';
        }
    }

    updateHoveredGlyph(): void {
        if (this.stackPreviewAnimator.shouldRenderStackPreview()) {
            const hoveredLayerTreeIndex =
                this.renderer?.hitTestStackPreviewLayer(
                    this.mouseX,
                    this.mouseY
                ) ?? null;

            let didChange = false;

            if (
                this.stackPreviewAnimator.hoveredLayerTreeIndex !==
                hoveredLayerTreeIndex
            ) {
                this.stackPreviewAnimator.hoveredLayerTreeIndex =
                    hoveredLayerTreeIndex;
                didChange = true;
            }

            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                didChange = true;
            }

            if (didChange) {
                this.render();
            }
            return;
        }

        if (
            this.outlineEditor.active &&
            (this.outlineEditor.hoveredResizeHandle !== null ||
                this.outlineEditor.hoveredGuideHandle !== null ||
                this.outlineEditor.hoveredSidebearingHandle !== null ||
                this.outlineEditor.hoveredComponentIndex !== null ||
                this.outlineEditor.hoveredAnchorIndex !== null ||
                this.outlineEditor.hoveredPointIndex !== null ||
                this.outlineEditor.hoveredAddPointPreview !== null ||
                this.outlineEditor.hoveredCommandCurvePreview !== null)
        ) {
            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                this.render();
            }
            return;
        }

        if (this.outlineEditor.active && this.outlineEditor.isPenDrawArmed()) {
            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                this.render();
            }
            return;
        }

        if (this.stackPreviewAnimator.hoveredLayerTreeIndex !== null) {
            this.stackPreviewAnimator.hoveredLayerTreeIndex = null;
        }

        let foundIndex = -1;

        const fontSpace = this.viewportManager!.getFontSpaceCoordinates(
            this.mouseX,
            this.mouseY
        );
        const metricsBand = this.getTextModeVerticalMetricsBand();

        // Pass 1: drawable outline / explicit-outline path hits (ink wins).
        for (let i = 0; i < this.textRunEditor!.shapedGlyphs.length; i++) {
            const glyph = this.textRunEditor!.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xAdvance = glyph.ax || 0;
            const pos = this.textRunEditor!._getGlyphPosition(i);
            const x = pos.xPosition + (glyph.dx || 0);
            const y = pos.yOffset;

            if (!this.isShapedGlyphVisuallyEmpty(i)) {
                try {
                    const glyphData =
                        this.textRunEditor!.hbFont.glyphToPath(glyphId);
                    if (glyphData) {
                        const path = new Path2D(glyphData);

                        this.ctx!.save();
                        const transform =
                            this.viewportManager!.getTransformMatrix();
                        this.ctx!.setTransform(
                            transform.a,
                            transform.b,
                            transform.c,
                            transform.d,
                            transform.e,
                            transform.f
                        );
                        this.ctx!.translate(x, y);

                        this.ctx!.lineWidth =
                            APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE /
                            this.viewportManager!.scale;
                        if (
                            this.ctx!.isPointInPath(
                                path,
                                this.mouseX,
                                this.mouseY
                            ) ||
                            this.ctx!.isPointInStroke(
                                path,
                                this.mouseX,
                                this.mouseY
                            )
                        ) {
                            foundIndex = i;
                            this.ctx!.restore();
                            break;
                        }

                        this.ctx!.restore();
                    }
                } catch (error) {
                    // Skip this glyph if path extraction fails
                }
            }
        }

        // Pass 2: empty glyphs (no outlines/components to draw) use the full
        // advance width × metrics band so they can still be double-clicked.
        if (foundIndex < 0) {
            for (let i = 0; i < this.textRunEditor!.shapedGlyphs.length; i++) {
                const glyph = this.textRunEditor!.shapedGlyphs[i];
                const xAdvance = glyph.ax || 0;
                const pos = this.textRunEditor!._getGlyphPosition(i);
                const x = pos.xPosition + (glyph.dx || 0);

                if (this.isShapedGlyphVisuallyEmpty(i) && xAdvance > 0) {
                    const yMin = metricsBand.lowest + pos.yOffset;
                    const yMax = metricsBand.highest + pos.yOffset;
                    if (
                        fontSpace.x >= x &&
                        fontSpace.x <= x + xAdvance &&
                        fontSpace.y >= yMin &&
                        fontSpace.y <= yMax
                    ) {
                        foundIndex = i;
                        break;
                    }
                }
            }
        }

        if (foundIndex !== this.outlineEditor.hoveredGlyphIndex) {
            this.outlineEditor.hoveredGlyphIndex = foundIndex;
            this.render();
        }
    }

    /**
     * Highest/lowest visible vertical metrics for text-mode empty-glyph hits.
     * Falls back to the drawn caret extent when masters have no metrics.
     */
    getTextModeVerticalMetricsBand(): { lowest: number; highest: number } {
        const fontModel = fontManager.currentFont?.fontModel;
        const selectedMaster = this.getSelectedTextModeKerningMaster();
        const master =
            selectedMaster ||
            fontModel?.masters?.find(
                (candidate: Master) => candidate?.metrics
            ) ||
            fontModel?.masters?.[0] ||
            null;

        const rawMetrics = master?.metrics;
        let verticalMetrics: Record<string, number> | null = null;
        if (rawMetrics && typeof rawMetrics === 'object') {
            verticalMetrics = Object.fromEntries(
                Object.entries(rawMetrics).filter(([, value]) =>
                    Number.isFinite(value)
                )
            ) as Record<string, number>;
            if (Number.isFinite(verticalMetrics.WinDescent)) {
                verticalMetrics.WinDescent = -Math.abs(
                    verticalMetrics.WinDescent
                );
            }
            if (Object.keys(verticalMetrics).length === 0) {
                verticalMetrics = null;
            }
        }

        const lowest =
            getLowestVisibleVerticalMetricValue(verticalMetrics) ??
            TEXT_CARET_FONT_Y_BOTTOM;
        const highest =
            getHighestVisibleVerticalMetricValue(verticalMetrics) ??
            TEXT_CARET_FONT_Y_TOP;
        return {
            lowest: Math.min(lowest, highest),
            highest: Math.max(lowest, highest)
        };
    }

    /**
     * True when a shaped glyph has no drawable outline (and no explicit
     * outline cache) — empty slots like space that still need a metrics hit
     * target for double-click-to-edit.
     */
    isShapedGlyphVisuallyEmpty(glyphIndex: number): boolean {
        const shaped = this.textRunEditor?.shapedGlyphs?.[glyphIndex];
        if (!shaped || !this.textRunEditor) {
            return true;
        }

        const explicitName = shaped.explicitGlyphName;
        if (explicitName) {
            const explicitOutline =
                this.textRunEditor.getCachedExplicitGlyphOutline(explicitName);
            if (explicitOutline?.shapes && explicitOutline.shapes.length > 0) {
                return false;
            }
            // Explicit token with no cached outline yet — treat as empty so the
            // metrics slot remains interactive.
            if (!this.textRunEditor.hbFont || shaped.g === 0) {
                return true;
            }
        }

        if (!this.textRunEditor.hbFont) {
            return true;
        }

        try {
            const glyphData = this.textRunEditor.hbFont.glyphToPath(shaped.g);
            if (!glyphData || !glyphData.trim()) {
                return true;
            }
            const bounds = Layer.calculateSvgPathBounds(glyphData);
            if (!bounds) {
                return true;
            }
            return bounds.maxX <= bounds.minX && bounds.maxY <= bounds.minY;
        } catch {
            return true;
        }
    }

    onResize(): void {
        // Splitter/collapse sizing is based on the editor cutout, not the
        // full-window bitmap. Overlay property-panel size is ignored here.
        const cutout = this.getCanvasCutoutFrame();
        const contentFrame = this.getCanvasContentFrameAsViewport();
        const newWidth = cutout.width || this.container.clientWidth;
        const newHeight = cutout.height || this.container.clientHeight;
        const newLeft = cutout.left;
        const newTop = cutout.top;

        const oldWidth = this.lastContainerWidth || newWidth;
        const oldHeight = this.lastContainerHeight || newHeight;
        const oldLeft = this.lastCutoutLeft;
        const oldTop = this.lastCutoutTop;
        const oldContentFrame =
            this.lastContentFrame &&
            this.lastContentFrame.width > 0 &&
            this.lastContentFrame.height > 0
                ? this.lastContentFrame
                : {
                      left: oldLeft,
                      top: oldTop,
                      width: oldWidth,
                      height: oldHeight
                  };

        this.lastContainerWidth = newWidth;
        this.lastContainerHeight = newHeight;
        this.lastCutoutLeft = newLeft;
        this.lastCutoutTop = newTop;
        this.lastContentFrame = contentFrame;

        this.syncCanvasBackingStore();

        if (!this.viewportManager) {
            this.render();
            return;
        }

        const freezeWidth = GlyphCanvas.COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH;
        const wasCollapsedWidth = oldWidth <= freezeWidth;
        const isCollapsedWidth = newWidth <= freezeWidth;

        if (isCollapsedWidth) {
            if (!this.collapsedViewportSnapshot) {
                this.freezeViewportForCollapse(oldWidth, oldHeight);
            }

            this.render();
            return;
        }

        if (wasCollapsedWidth && this.collapsedViewportSnapshot) {
            const snapshot = this.collapsedViewportSnapshot;
            this.viewportManager.scale = snapshot.scale;
            this.collapsedViewportSnapshot = null;
            this.suppressNextViewportResizeAdjustment = true;

            const hasRelativeAnchor =
                typeof snapshot.contentAnchorScreenFractionX === 'number';
            if (hasRelativeAnchor) {
                this.ensureKeyboardResizeContentAnchorVisible({
                    screenFractionX: snapshot.contentAnchorScreenFractionX,
                    screenFractionY:
                        snapshot.contentAnchorScreenFractionY ?? 0.5
                });
            } else {
                this.viewportManager.panX = snapshot.panX;
                this.viewportManager.panY = snapshot.panY;
                this.ensureKeyboardResizeContentAnchorVisible();
            }

            this.lastStableViewportSnapshot = this.snapshotCurrentViewport();
            this.render();
            return;
        }

        if (
            this.suppressNextViewportResizeAdjustment &&
            this.lastStableViewportSnapshot
        ) {
            this.suppressNextViewportResizeAdjustment = false;
            const snapshot = this.lastStableViewportSnapshot;
            this.viewportManager.scale = snapshot.scale;

            if (
                this.isKeyboardViewportResizePreservationActive() &&
                typeof snapshot.contentAnchorScreenFractionX === 'number'
            ) {
                this.ensureKeyboardResizeContentAnchorVisible({
                    screenFractionX: snapshot.contentAnchorScreenFractionX,
                    screenFractionY:
                        snapshot.contentAnchorScreenFractionY ?? 0.5
                });
            } else {
                this.viewportManager.panX = snapshot.panX;
                this.viewportManager.panY = snapshot.panY;
                if (this.isKeyboardViewportResizePreservationActive()) {
                    this.ensureKeyboardResizeContentAnchorVisible();
                }
            }

            this.lastStableViewportSnapshot = this.snapshotCurrentViewport();
            this.render();
            return;
        }

        // Skip viewport adjustment if the cutout is unchanged. Property-panel
        // overlay size shifts are exempt: they do not resettle pan or zoom.
        if (
            oldWidth === newWidth &&
            oldHeight === newHeight &&
            oldLeft === newLeft &&
            oldTop === newTop
        ) {
            this.lastStableViewportSnapshot = this.snapshotCurrentViewport();
            if (!this.contentFramesMatch(oldContentFrame, contentFrame)) {
                this.render();
            }
            return;
        }

        const cutoutSizeChanged =
            oldWidth !== newWidth || oldHeight !== newHeight;
        const contentAnchor =
            this.getResizeViewportAnchorFontPosition(oldContentFrame);
        const contentAnchorScreen = contentAnchor
            ? this.viewportManager.fontToScreenCoordinates(
                  contentAnchor.x,
                  contentAnchor.y
              )
            : null;

        if (cutoutSizeChanged && oldWidth > 0 && oldHeight > 0) {
            const oldScale = this.viewportManager.scale;
            const widthRatio = newWidth / oldWidth;
            const heightRatio = newHeight / oldHeight;
            const sizeRatio =
                Math.abs(widthRatio - 1) > Math.abs(heightRatio - 1)
                    ? widthRatio
                    : heightRatio;
            const dampenedRatio = 1 + (sizeRatio - 1) * 0.7;
            const newScale = oldScale * dampenedRatio;
            if (newScale >= 0.01 && newScale <= 100) {
                this.viewportManager.scale = newScale;
            }
        }

        if (contentAnchor && contentAnchorScreen) {
            this.applyContentInsetRelativeLock(
                oldContentFrame,
                contentFrame,
                contentAnchor,
                contentAnchorScreen
            );
        } else {
            const oldCenterX = oldContentFrame.left + oldContentFrame.width / 2;
            const oldCenterY = oldContentFrame.top + oldContentFrame.height / 2;
            const fontSpaceCenter =
                this.viewportManager.getFontSpaceCoordinates(
                    oldCenterX,
                    oldCenterY
                );
            const newCenterX = contentFrame.left + contentFrame.width / 2;
            const newCenterY = contentFrame.top + contentFrame.height / 2;
            this.viewportManager.panX =
                newCenterX - this.viewportManager.scale * fontSpaceCenter.x;
            this.viewportManager.panY =
                newCenterY + this.viewportManager.scale * fontSpaceCenter.y;
        }

        this.lastStableViewportSnapshot = this.snapshotCurrentViewport();

        this.render();
    }

    setFont(
        fontArrayBuffer: ArrayBuffer,
        options?: {
            skipInitialShapeRender?: boolean;
            skipPropertiesUIUpdate?: boolean;
        }
    ): Promise<void> {
        if (!fontArrayBuffer) {
            console.error('No font data provided');
            return Promise.resolve();
        }

        try {
            this.textChangeLastSubsetKey = '';

            // Store current variation settings to restore after font reload.
            // Capture can go stale while awaiting HarfBuzz load if URL restore
            // lands mid-flight — re-check StateManager below before applying.
            let previousVariationSettings: UserspaceLocation = {
                ...this.axesManager!.variationSettings
            };

            // Store editing font bytes on GlyphCanvas (for outline editor etc.)
            const fontBytesArray = new Uint8Array(fontArrayBuffer);
            this.fontBytes = fontBytesArray;
            console.log(
                '[GlyphCanvas]',
                'Editing font bytes stored, length:',
                fontBytesArray.length
            );
            this.axesManager!.fontBytes = fontBytesArray;

            // Create HarfBuzz blob, face, and font for the editing font
            // Pass initialFontLoaded flag to only load text from font on first load
            // Return the Promise so callers can await font loading completion
            const loadFontSpanId = timelineSpanStart(
                'canvas.setFont.loadHarfBuzz'
            );
            return this.textRunEditor!.setFont(
                fontBytesArray,
                !this.initialFontLoaded
            ).then(async (hbFont) => {
                timelineSpanEnd(loadFontSpanId);
                // Rebuild editing font name→GID map for Stage 2 shaping
                const gidMapSpanId = timelineSpanStart(
                    'canvas.setFont.rebuildNameToGidMap'
                );
                this.textRunEditor!.rebuildEditingFontNameToGid();
                timelineSpanEnd(gidMapSpanId);

                // During startup, prefer URL-restored StateManager location over a
                // stale pre-await capture so we don't paint the font default first.
                if (!isStartupStateReady()) {
                    const restored =
                        window.stateManager?.editor_variation_location;
                    if (restored && Object.keys(restored).length > 0) {
                        previousVariationSettings = { ...restored };
                    }
                }

                // Restore previous variation settings before updating UI
                this.axesManager!.variationSettings = previousVariationSettings;

                const axesUiSpanId = timelineSpanStart(
                    'canvas.setFont.updateAxesUI'
                );
                await this.axesManager!.updateAxesUI();
                timelineSpanEnd(axesUiSpanId);

                // Shape text with new editing font
                // (Stage 2 will use the rebuilt name→GID map)
                const shapeTextSpanId = timelineSpanStart(
                    'canvas.setFont.shapeText'
                );
                this.textRunEditor!.shapeText(
                    options?.skipInitialShapeRender === true
                );
                await reapplyStartupCursorIfNeeded(this);
                timelineSpanEnd(shapeTextSpanId);
                console.log(
                    '[GlyphCanvas]',
                    'Shaped text after editing font reload'
                );

                // Update properties UI to show master list in text mode
                if (!options?.skipPropertiesUIUpdate) {
                    const propertiesUiSpanId = timelineSpanStart(
                        'canvas.setFont.updatePropertiesUI'
                    );
                    await this.updatePropertiesUI();
                    timelineSpanEnd(propertiesUiSpanId);
                }

                // Seed first master instantly on initial load (no animation).
                // Startup URL/state restore may overwrite this before the single
                // fontReady overview render; avoid variationLocationChanged races.
                const armedLocation =
                    window.stateManager?.editor_variation_location;
                const mastersForInitialSeed =
                    !this.initialFontLoaded &&
                    !(armedLocation && Object.keys(armedLocation).length > 0)
                        ? fontManager.currentFont?.fontModel?.masters
                        : undefined;
                if (mastersForInitialSeed && mastersForInitialSeed.length > 0) {
                    const fontModel = fontManager.currentFont!.fontModel!;
                    const firstMaster = mastersForInitialSeed[0];
                    if (
                        firstMaster?.id &&
                        firstMaster.location &&
                        fontModel.axes &&
                        this.axesManager
                    ) {
                        const userspaceLocation = designspaceToUserspace(
                            firstMaster.location,
                            fontModel.axes as any
                        );
                        this.textModeEscapeState.clear();
                        this.applyTextModeKerningMasterChange(firstMaster.id);
                        for (const [tag, value] of Object.entries(
                            userspaceLocation
                        )) {
                            this.axesManager.setAxisValue(tag, Number(value));
                        }
                        this.axesManager.updateAxisSliders();
                        this.updateMasterSelection();
                        this.updatePropertyPanel();
                    }
                }

                // Signal that shaping is done so URL/state restore can apply
                // `?text=` before the initial zoom-to-fit.
                if (!this.initialFontLoaded) {
                    timelineMark('canvas.initialZoomComplete');
                    window.dispatchEvent(
                        new CustomEvent('canvasInitialReady', {
                            detail: {
                                openSessionId: latestOpenSessionId,
                                source: 'initial-shape-complete'
                            }
                        })
                    );
                    this.initialFontLoaded = true;
                }
            });
        } catch (error) {
            console.error('Error setting font:', error);
            return Promise.reject(error);
        }
    }

    async enterGlyphEditModeAtCursor(): Promise<void> {
        // Enter glyph edit mode for the glyph at the current cursor position
        if (this.outlineEditor.active) return;
        let glyphIndex = this.textRunEditor!.getGlyphIndexAtCursorPosition();

        if (glyphIndex !== undefined && glyphIndex >= 0) {
            console.log(
                `Entering glyph edit mode at cursor position ${this.textRunEditor!.cursorPosition}, glyph index ${glyphIndex}`
            );
            await this.textRunEditor!.selectGlyphByIndex(glyphIndex);
        } else {
            console.log(
                `No glyph found at cursor position ${this.textRunEditor!.cursorPosition}`
            );
        }
    }

    exitGlyphEditMode(): void {
        // Exit glyph edit mode and return to text edit mode

        // Determine cursor position based on whether glyph was typed or shaped
        const savedGlyphIndex = this.textRunEditor!.selectedGlyphIndex;

        const glyph = this.textRunEditor!.shapedGlyphs[savedGlyphIndex];
        console.log(
            '[v2024-12-01-FIX] exitGlyphEditMode CALLED - selectedGlyphIndex:',
            this.textRunEditor!.selectedGlyphIndex,
            'shapedGlyphs.length:',
            this.textRunEditor!.shapedGlyphs.length,
            'glyph:',
            glyph
        );

        // Update cursor position to before the edited glyph
        if (
            savedGlyphIndex >= 0 &&
            savedGlyphIndex < this.textRunEditor!.shapedGlyphs.length
        ) {
            const glyphInfo =
                this.textRunEditor!.isGlyphFromTypedCharacter(savedGlyphIndex);
            const clusterStart = glyph.cl || 0;
            const isRTL = this.textRunEditor!.isPositionRTL(clusterStart);

            console.log(
                'Exit glyph edit mode [v2024-12-01-FIX] - glyphInfo:',
                glyphInfo,
                'clusterStart:',
                clusterStart,
                'isRTL:',
                isRTL
            );

            if (glyphInfo.isTyped) {
                // For typed characters, position cursor at the character's logical position
                // (which is the space before the character, where we entered from)
                this.textRunEditor!.cursorPosition = glyphInfo.logicalPosition;
                console.log(
                    'Typed character - set cursor position at logical position:',
                    this.textRunEditor!.cursorPosition
                );
            } else {
                // For shaped glyphs, position cursor at the cluster start
                this.textRunEditor!.cursorPosition = clusterStart;
                console.log(
                    'Shaped glyph - set cursor position at cluster start:',
                    this.textRunEditor!.cursorPosition
                );
            }
            this.textRunEditor!.updateCursorVisualPosition();
        }

        this.outlineEditor.active = false;
        this.textRunEditor!.selectedGlyphIndex = -1;
        this.outlineEditor.selectedLayerId = null;
        this.outlineEditor.notifyEditToolsChanged();
        window.fontManager?.notifyActiveEditorGlyphRoom?.();

        // Dispatch mode change event for URL sync
        window.dispatchEvent(
            new CustomEvent('editorModeChanged', {
                detail: { mode: 'text' }
            })
        );

        // Clear outline editor state
        this.outlineEditor.clearState();

        // Auto-select matching master based on current axis slider positions
        this.autoSelectMatchingMaster();

        console.log(`Exited glyph edit mode - returned to text edit mode`);
        this.updatePropertyPanel();
        this.updatePropertiesUI();
        this.render();
        this.dispatchModeActivationEvent('text', 'exitGlyphEditMode');
    }

    resetForOpenedFontReplacement(): void {
        this.initialFontLoaded = false;
        this.glyphSelectionSequence++;
        this.textChangeLastSubsetKey = '';
        latestAppliedEditingRevision = -1;
        editingFontApplyQueue = Promise.resolve();
        this.textModeAutoPanAnchorScreen = null;
        this.pendingTextModeKerningCursorAnchor = false;
        this.clearTextModeKerningLivePreview({ cancelCommit: true });
        this.renderSuppressed = false;
        this.hasDeferredRenderRequest = false;
        this.editModeGlyphResyncInProgress = false;
        this.isUpdatingPropertiesUI = false;
        editorHealth.notePropertiesUpdateFinished();

        this.outlineEditor.active = false;
        this.outlineEditor.selectedLayerId = null;
        this.outlineEditor.glyphStack = '';
        this.outlineEditor.clearState();

        if (this.textRunEditor) {
            this.textRunEditor.selectedGlyphIndex = -1;
            this.textRunEditor.cursorPosition = 0;
            this.textRunEditor.selectedMasterId = null;
            this.textRunEditor.selectionStart = null;
            this.textRunEditor.selectionEnd = null;

            // Clear shaping state so the compile fallback chain doesn't feed
            // stale glyph names from the previous font into a new empty font,
            // which would cause a Rust panic. The text buffer and glyph name
            // buffer are ephemeral shaping artifacts and must be invalidated
            // when the font is replaced.
            // Keep a user/test-written buffer across font replacement so a
            // later display_string load cannot restore the previous sample.
            if (!userTextBufferHasBeenWritten()) {
                this.textRunEditor.textBuffer = '';
            }
            this.textRunEditor.glyphNameBuffer = [];
            this.textRunEditor.shapedGlyphs = [];
            this.textRunEditor.explicitGlyphTokens = [];
            this.textRunEditor.intrinsicGlyphAdvances.clear();
            this.textRunEditor.fontBlob = null;
            this.textRunEditor.shapingFontBlob = null;
            this.textRunEditor.hbFont = null;
            this.textRunEditor.hbFace = null;
            this.textRunEditor.hbBlob = null;
            this.textRunEditor.shapingHbFont = null;
            this.textRunEditor.shapingHbFace = null;
            this.textRunEditor.shapingHbBlob = null;
        }

        if (this.propertiesSection) {
            this.propertiesSection.replaceChildren();
        }
        if (this.axesSection) {
            this.axesSection.replaceChildren();
        }
        if (this.axesManager) {
            this.axesManager.variationSettings = {};
        }
        if (this.featuresManager?.featuresSection) {
            this.featuresManager.featuresSection.replaceChildren();
            this.featuresManager.featureAvailabilityInEditingSubset = {};
            this.featuresManager.editingFontBytes = null;
        }

        window.dispatchEvent(
            new CustomEvent('editorModeChanged', {
                detail: { mode: 'text' }
            })
        );

        this.dispatchModeActivationEvent(
            'text',
            'resetForOpenedFontReplacement'
        );
        this.render();
    }

    private promptForFeatureVariationAxisRules(
        existingAxisRules: FeatureVariationAxisRule[],
        isEditing: boolean
    ): Promise<FeatureVariationAxisRule[] | null> {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className =
                'info-popup-overlay feature-variation-settings-modal';

            const content = document.createElement('div');
            content.className =
                'info-popup feature-variation-settings-modal-content';
            const header = document.createElement('div');
            header.className = 'info-popup-header';
            const title = document.createElement('h3');
            title.textContent = isEditing
                ? 'Edit Feature Variation'
                : 'Add Feature Variation';
            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'info-popup-close';
            closeButton.setAttribute('aria-label', 'Close');
            const closeIcon = document.createElement('span');
            closeIcon.className = 'material-symbols-outlined';
            closeIcon.textContent = 'close';
            closeButton.appendChild(closeIcon);
            header.append(title, closeButton);

            const form = document.createElement('form');
            form.className =
                'info-popup-content feature-variation-settings-modal-body';
            const description = document.createElement('div');
            description.className = 'feature-variation-settings-description';
            description.textContent =
                'Define the active range for each variation axis.';
            const coordinateNote = document.createElement('small');
            coordinateNote.className =
                'feature-variation-settings-coordinate-note';
            coordinateNote.textContent =
                'Values are in designspace coordinates.';
            const rows = document.createElement('div');
            rows.className = 'feature-variation-settings-rows';
            form.append(description, rows, coordinateNote);
            const axisRuleInputs: Array<{
                min: HTMLInputElement;
                max: HTMLInputElement;
            }> = [];
            const fontModel = fontManager.currentFont?.fontModel;
            for (const [axisIndex, axis] of (fontModel?.axes || []).entries()) {
                const existingRule = existingAxisRules[axisIndex];
                const rule =
                    existingRule &&
                    typeof existingRule === 'object' &&
                    !Array.isArray(existingRule)
                        ? (existingRule as Record<string, unknown>)
                        : {};
                const row = document.createElement('div');
                row.className = 'feature-variation-settings-row';
                const label = document.createElement('label');
                label.className = 'feature-variation-settings-axis-label';
                label.textContent =
                    (typeof axis.name === 'string'
                        ? axis.name
                        : axis.name?.dflt) ||
                    axis.tag ||
                    `Axis ${axisIndex + 1}`;
                const min = document.createElement('input');
                min.type = 'number';
                min.step = 'any';
                min.className =
                    'localized-string-input localized-string-modal-input feature-variation-settings-input';
                min.placeholder = 'Min';
                min.value =
                    typeof rule.min === 'number' ? String(rule.min) : '';
                const max = document.createElement('input');
                max.type = 'number';
                max.step = 'any';
                max.className =
                    'localized-string-input localized-string-modal-input feature-variation-settings-input';
                max.placeholder = 'Max';
                max.value =
                    typeof rule.max === 'number' ? String(rule.max) : '';
                const minField = document.createElement('label');
                minField.className = 'feature-variation-settings-bound';
                minField.textContent = 'Min';
                minField.appendChild(min);
                const maxField = document.createElement('label');
                maxField.className = 'feature-variation-settings-bound';
                maxField.textContent = 'Max';
                maxField.appendChild(max);
                row.append(label, minField, maxField);
                rows.appendChild(row);
                axisRuleInputs.push({ min, max });
            }

            const actions = document.createElement('div');
            actions.className = 'feature-variation-settings-actions';
            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'dialog-button';
            cancelButton.textContent = 'Cancel';
            const saveButton = document.createElement('button');
            saveButton.type = 'submit';
            saveButton.className = 'dialog-button dialog-button-primary';
            saveButton.textContent = isEditing ? 'Save' : 'Add';
            actions.append(cancelButton, saveButton);
            form.appendChild(actions);
            content.append(header, form);
            modal.appendChild(content);
            document.body.appendChild(modal);

            let settled = false;
            let escapeBinding: ModalEscapeBinding | null = null;
            const close = (result: FeatureVariationAxisRule[] | null): void => {
                if (settled) {
                    return;
                }
                settled = true;
                escapeBinding?.release();
                escapeBinding = null;
                modal.remove();
                resolve(result);
            };
            escapeBinding = bindModalEscape(() => close(null), {
                isOpen: () => modal.isConnected
            });
            closeButton.addEventListener('click', () => close(null));
            cancelButton.addEventListener('click', () => close(null));
            modal.addEventListener('click', (event) => {
                if (event.target === modal) {
                    close(null);
                }
            });
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const axisRules: FeatureVariationAxisRule[] = [];
                for (const { min, max } of axisRuleInputs) {
                    const minValue = min.value.trim();
                    const maxValue = max.value.trim();
                    const parsedMin = minValue === '' ? null : Number(minValue);
                    const parsedMax = maxValue === '' ? null : Number(maxValue);
                    if (
                        (parsedMin !== null && !Number.isFinite(parsedMin)) ||
                        (parsedMax !== null && !Number.isFinite(parsedMax)) ||
                        (parsedMin !== null &&
                            parsedMax !== null &&
                            parsedMin > parsedMax)
                    ) {
                        min.setCustomValidity(
                            'Enter finite bounds with minimum less than or equal to maximum.'
                        );
                        min.reportValidity();
                        min.setCustomValidity('');
                        return;
                    }
                    const rule: Record<string, number> = {};
                    if (parsedMin !== null) {
                        rule.min = parsedMin;
                    }
                    if (parsedMax !== null) {
                        rule.max = parsedMax;
                    }
                    axisRules.push(rule);
                }
                close(axisRules);
            });
            axisRuleInputs[0]?.min.focus();
        });
    }

    async displayMastersList(
        targetContainer: HTMLElement = this.propertiesSection!,
        autoSelectLayer: boolean = true
    ): Promise<void> {
        // Display unified masters/layers list
        // In text mode: show all masters, click selects master location
        // In edit mode: show all masters, check if glyph has corresponding layers
        //   - if layer exists: show active, click loads layer
        //   - if layer missing: show inactive/disabled
        console.log(
            '[GlyphCanvas] displayMastersList called, selectedLayerId:',
            this.outlineEditor?.selectedLayerId
        );

        if (!targetContainer || !fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model available');
            return;
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || fontModel.masters.length === 0) {
            console.log('[GlyphCanvas] No masters found');
            return;
        }

        const isEditMode = this.outlineEditor.active;
        const preselectedLayerId = isEditMode
            ? (this.outlineEditor.isEditingBackgroundLayer()
                  ? this.outlineEditor.getPairedLayerModel()?.id
                  : null) ||
              this.outlineEditor.selectedLayerId ||
              this.outlineEditor.findMatchingLayer()?.id
            : null;
        console.log(
            '[GlyphCanvas] Found',
            fontModel.masters.length,
            'masters, mode:',
            isEditMode ? 'edit' : 'text'
        );

        // In edit mode, get current glyph and its layers
        let glyph: Glyph | FeatureVariationGlyph | undefined;
        let glyphLayers: Layer[] = [];
        if (isEditMode) {
            const authoringGlyphName =
                this.outlineEditor.getAuthoringRootGlyphName();
            // Fetch glyph data (needed for interpolation and layer management)
            this.fontData =
                await fontManager.fetchGlyphData(authoringGlyphName);

            if (
                !this.fontData ||
                !this.fontData.layers ||
                this.fontData.layers.length === 0
            ) {
                console.log('[GlyphCanvas] No font data or layers found');
                return;
            }

            // Store glyph name for interpolation (needed even when not on a layer)
            // But only if we're NOT in component editing mode
            if (
                this.fontData.glyphName &&
                !this.outlineEditor.isEditingComponent()
            ) {
                this.outlineEditor.currentGlyphName = this.fontData.glyphName;
                window.fontManager?.notifyActiveEditorGlyphRoom?.();
                console.log(
                    '[GlyphCanvas]',
                    'Set currentGlyphName from fontData:',
                    this.outlineEditor.currentGlyphName
                );
            }

            const glyphName = this.outlineEditor.isEditingComponent()
                ? this.outlineEditor.getLayerLinkGlyphName() ||
                  authoringGlyphName
                : this.outlineEditor.parseGlyphStack()[0]?.glyphName ||
                  authoringGlyphName;
            glyph = fontModel.resolveGlyphView(glyphName);
            glyphLayers = glyph?.layers || [];
            console.log(
                '[GlyphCanvas] Edit mode: glyph',
                glyphName,
                'has',
                glyphLayers.length,
                'layers'
            );
        }

        const layersWidget = document.createElement('div');
        layersWidget.className = 'editor-layers-widget';

        // Add section title
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'editor-section-title editor-layers-header';

        const sectionTitleText = document.createElement('span');
        sectionTitleText.className = 'editor-section-title-text';
        sectionTitleText.textContent = isEditMode ? 'Layers' : 'Masters';
        sectionTitle.appendChild(sectionTitleText);

        const glyphNameForLinkState =
            this.outlineEditor.getLayerLinkGlyphName() ||
            glyph?.name ||
            this.getCurrentGlyphName();
        const axesOrder =
            (fontModel as any).axesOrder ||
            (fontModel.axes || []).map((axis: any) => axis.tag).sort();
        const activeLayer =
            isEditMode && preselectedLayerId
                ? glyphLayers.find(
                      (candidate) => candidate.id === preselectedLayerId
                  )
                : undefined;
        const activeLayerFingerprint = activeLayer?.fingerprint || null;
        const displayedLayerIds: string[] = [];
        const layerLinkButtons: HTMLButtonElement[] = [];
        const layerRows: LayerListContextTarget[] = [];

        const isLayerCompatibleWithActive = (
            layer: Layer | undefined
        ): boolean => {
            if (!isEditMode || !layer?.id || !activeLayerFingerprint) {
                return true;
            }

            return (
                layer.id === activeLayer?.id ||
                layer.fingerprint === activeLayerFingerprint
            );
        };

        const setLinkButtonState = (
            button: HTMLButtonElement,
            linked: boolean,
            linkedTitle: string,
            unlinkedTitle: string
        ): void => {
            button.setAttribute('data-linked', linked ? 'true' : 'false');
            button.setAttribute('aria-pressed', linked ? 'true' : 'false');
            button.setAttribute('title', linked ? linkedTitle : unlinkedTitle);
            const icon = button.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = linked ? 'link' : 'link_off';
            }
        };

        const createLinkButton = (
            onClick: (event: MouseEvent) => void,
            extraClassName: string = ''
        ): HTMLButtonElement => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className =
                `editor-layer-link-toggle ${extraClassName}`.trim();

            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            button.appendChild(icon);

            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onClick(event);
            });

            return button;
        };

        const createHeaderIconButton = (
            iconName: string,
            title: string,
            onClick: (event: MouseEvent) => void,
            extraClassName: string = ''
        ): HTMLButtonElement => {
            const button = createLinkButton(onClick, extraClassName);
            button.title = title;
            button.setAttribute('aria-label', title);
            const icon = button.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = iconName;
            }
            return button;
        };

        const createCompatibilityIndicator = (): HTMLSpanElement => {
            const indicator = document.createElement('span');
            indicator.className = 'editor-layer-compatibility-indicator';
            indicator.title = 'Outline is incompatible with the active layer';

            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            icon.textContent = 'broken_image';
            indicator.appendChild(icon);

            return indicator;
        };

        let summaryLinkButton: HTMLButtonElement | null = null;
        let addLayerButton: HTMLButtonElement | null = null;
        const refreshLayerLinkControls = (): void => {
            if (!isEditMode || !summaryLinkButton) {
                return;
            }

            const hasExactLayerAtCurrentLocation =
                !!this.outlineEditor.findMatchingLayer(glyphNameForLinkState);

            const allLinked = this.outlineEditor.areAllLayersLinked(
                displayedLayerIds,
                glyphNameForLinkState
            );

            summaryLinkButton.disabled = displayedLayerIds.length === 0;
            setLinkButtonState(
                summaryLinkButton,
                allLinked,
                'Unlink all layers (Cmd+Alt+L)',
                'Link all layers (Cmd+Alt+L)'
            );

            for (const button of layerLinkButtons) {
                const layerId = button.getAttribute('data-layer-id');
                const linked = this.outlineEditor.isLayerLinked(
                    layerId,
                    glyphNameForLinkState
                );
                setLinkButtonState(
                    button,
                    linked,
                    'Unlink layer',
                    'Link layer'
                );
            }

            if (addLayerButton) {
                addLayerButton.disabled =
                    !glyphNameForLinkState || hasExactLayerAtCurrentLocation;
            }
        };

        if (isEditMode) {
            const headerActions = document.createElement('div');
            headerActions.className = 'editor-layers-header-actions';

            addLayerButton = createHeaderIconButton(
                'add',
                'Create layer at current location',
                async () => {
                    const currentUserspaceLocation =
                        this.outlineEditor.getCurrentUserspaceLocation();
                    const masterId = this.outlineEditor.findClosestMasterId(
                        currentUserspaceLocation
                    );
                    if (!masterId) {
                        return;
                    }
                    const master = (fontModel.masters || []).find(
                        (candidate: any) => candidate.id === masterId
                    );
                    const designLocation = userspaceToDesignspace(
                        currentUserspaceLocation,
                        fontModel.axes || []
                    );
                    await this.outlineEditor.createInterpolatedLayer({
                        glyphName: glyphNameForLinkState,
                        userspaceLocation: currentUserspaceLocation,
                        masterId,
                        designLocation,
                        isMasterBound: false,
                        changeSource: 'layer-create-button',
                        selectNewLayer: true,
                        extrapolate: true
                    });
                    await this.updatePropertiesUI();
                    this.render();
                },
                'editor-layer-add-button'
            );
            headerActions.appendChild(addLayerButton);

            summaryLinkButton = createLinkButton(() => {
                const linkAll = !this.outlineEditor.areAllLayersLinked(
                    displayedLayerIds,
                    glyphNameForLinkState
                );
                this.outlineEditor.setAllLayersLinked(
                    displayedLayerIds,
                    linkAll,
                    glyphNameForLinkState
                );
                refreshLayerLinkControls();
            }, 'editor-layer-link-summary-toggle');
            headerActions.appendChild(summaryLinkButton);
            sectionTitle.appendChild(headerActions);
        }

        layersWidget.appendChild(sectionTitle);

        const sourceGlyph =
            glyph instanceof FeatureVariationGlyph ? glyph.sourceGlyph : glyph;
        const featureVariations = isEditMode
            ? sourceGlyph?.featureVariations || []
            : [];
        let featureVariationsWidget: HTMLDivElement | null = null;
        if (
            isEditMode &&
            !this.outlineEditor.isEditingComponent() &&
            sourceGlyph
        ) {
            const selectedFeatureVariationId =
                this.outlineEditor.getSelectedRootFeatureVariationId();
            featureVariationsWidget = document.createElement('div');
            featureVariationsWidget.className =
                'editor-layers-widget editor-feature-variations-widget';

            const featureVariationsHeader = document.createElement('div');
            featureVariationsHeader.className =
                'editor-section-title editor-layers-header';
            const featureVariationsTitle = document.createElement('span');
            featureVariationsTitle.className = 'editor-section-title-text';
            featureVariationsTitle.textContent = 'Variations';
            featureVariationsHeader.appendChild(featureVariationsTitle);

            const featureVariationLabel = (
                featureVariation: FeatureVariationGlyph,
                index: number
            ): string => {
                const conditions = featureVariation.axisRules.flatMap(
                    (rule: unknown, axisIndex: number) => {
                        if (!rule || typeof rule !== 'object') {
                            return [];
                        }
                        const axisRule = rule as Record<string, unknown>;
                        const axisTag =
                            (fontModel.axes || [])[axisIndex]?.tag ||
                            `axis ${axisIndex + 1}`;
                        if (
                            typeof axisRule.min === 'number' &&
                            typeof axisRule.max === 'number'
                        ) {
                            return [
                                `${axisRule.min} < ${axisTag} < ${axisRule.max}`
                            ];
                        }
                        if (typeof axisRule.min === 'number') {
                            return [`${axisRule.min} < ${axisTag}`];
                        }
                        if (typeof axisRule.max === 'number') {
                            return [`${axisTag} < ${axisRule.max}`];
                        }
                        return [];
                    }
                );
                return conditions.length
                    ? conditions.join(', ')
                    : `Feature variation ${index + 1}`;
            };

            const selectFeatureVariation = async (
                featureVariationId: string | null
            ): Promise<void> => {
                this.outlineEditor.setRootFeatureVariationSelection(
                    featureVariationId,
                    { clearLayerSelection: true }
                );
                await this.outlineEditor.autoSelectMatchingLayer({
                    skipRender: true
                });
                if (this.outlineEditor.selectedLayerId === null) {
                    await this.outlineEditor.interpolateCurrentGlyph(true);
                }
                await this.updatePropertiesUI({
                    skipAutoSelectMatchingLayer: true
                });
                this.render();
            };

            const openFeatureVariationSettings = async (
                featureVariation?: FeatureVariationGlyph
            ): Promise<void> => {
                const axisRules = await this.promptForFeatureVariationAxisRules(
                    featureVariation?.axisRules || [],
                    !!featureVariation
                );
                if (axisRules === null) {
                    return;
                }

                try {
                    const nextFeatureVariation = featureVariation
                        ? featureVariation.setAxisRules(axisRules)
                        : sourceGlyph.addFeatureVariation(axisRules);
                    await selectFeatureVariation(nextFeatureVariation.id);
                } catch (error) {
                    console.warn(
                        '[GlyphCanvas] Could not update feature variation settings:',
                        error
                    );
                }
            };

            const featureVariationsHeaderActions =
                document.createElement('div');
            featureVariationsHeaderActions.className =
                'editor-layers-header-actions';
            featureVariationsHeaderActions.appendChild(
                createHeaderIconButton(
                    'add',
                    'Add feature variation',
                    () => {
                        void openFeatureVariationSettings();
                    },
                    'editor-feature-variation-add-button'
                )
            );
            featureVariationsHeader.appendChild(featureVariationsHeaderActions);
            featureVariationsWidget.appendChild(featureVariationsHeader);

            const buildFeatureVariationContextMenuHtml = (): string => `
                <div class="plugin-menu" tabindex="0" role="menu" aria-label="Feature variation actions">
                    <div class="plugin-menu-item" data-action="edit" role="menuitem">
                        <span class="material-symbols-outlined">edit</span>
                        <span>Edit</span>
                    </div>
                    <div class="plugin-menu-item" data-action="remove" role="menuitem">
                        <span class="material-symbols-outlined">delete</span>
                        <span>Remove</span>
                    </div>
                </div>
            `;

            const removeFeatureVariation = async (
                featureVariation: FeatureVariationGlyph
            ): Promise<void> => {
                if (
                    !window.confirm(
                        'Remove this feature variation from all master layers?'
                    )
                ) {
                    return;
                }

                const wasSelected =
                    this.outlineEditor.getSelectedRootFeatureVariationId() ===
                    featureVariation.id;
                sourceGlyph.removeFeatureVariation(featureVariation);

                if (wasSelected) {
                    await selectFeatureVariation(null);
                    return;
                }

                await this.updatePropertiesUI({
                    skipAutoSelectMatchingLayer: true
                });
                this.render();
            };

            const attachFeatureVariationContextMenu = (
                item: HTMLDivElement,
                featureVariation: FeatureVariationGlyph
            ): void => {
                const backdrop = getOrCreateBackdrop(
                    'editor-feature-variation-context-menu-backdrop'
                );
                const tippyInstance = tippy(item, {
                    content: buildFeatureVariationContextMenuHtml(),
                    allowHTML: true,
                    trigger: 'manual',
                    interactive: true,
                    appendTo: () => document.body,
                    placement: 'right-start',
                    theme: getTheme(),
                    arrow: false,
                    offset: [0, 4],
                    hideOnClick: false,
                    getReferenceClientRect: () => item.getBoundingClientRect(),
                    onShown: (instance) => {
                        const menu =
                            instance.popper.querySelector('.plugin-menu');
                        if (!menu) {
                            return;
                        }

                        setupMenuKeyboardNav(menu);
                        menu.querySelectorAll('.plugin-menu-item').forEach(
                            (menuItem) => {
                                (menuItem as HTMLElement).onclick =
                                    async () => {
                                        const action =
                                            menuItem.getAttribute(
                                                'data-action'
                                            );
                                        instance.hide();
                                        await new Promise((resolve) =>
                                            requestAnimationFrame(resolve)
                                        );
                                        if (action === 'edit') {
                                            await openFeatureVariationSettings(
                                                featureVariation
                                            );
                                        } else if (action === 'remove') {
                                            await removeFeatureVariation(
                                                featureVariation
                                            );
                                        }
                                    };
                            }
                        );
                    }
                });

                addTippyBackdropSupport(tippyInstance, backdrop, {
                    targetElement: item,
                    activeClass: 'context-menu-active'
                });

                item.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const mouseX = event.clientX;
                    const mouseY = event.clientY;
                    tippyInstance.setProps({
                        content: buildFeatureVariationContextMenuHtml(),
                        getReferenceClientRect: () => ({
                            width: 0,
                            height: 0,
                            top: mouseY,
                            bottom: mouseY,
                            left: mouseX,
                            right: mouseX,
                            x: mouseX,
                            y: mouseY,
                            toJSON: () => ({})
                        }),
                        theme: getTheme()
                    });
                    tippyInstance.show();
                });
            };

            const featureVariationsList = document.createElement('div');
            featureVariationsList.className = 'editor-layers-list';
            const createFeatureVariationItem = (
                label: string,
                featureVariationId: string | null,
                featureVariation?: FeatureVariationGlyph
            ): HTMLDivElement => {
                const item = document.createElement('div');
                item.className =
                    'editor-layer-item editor-feature-variation-item';
                item.setAttribute(
                    'data-feature-variation-id',
                    featureVariationId || ''
                );
                if (featureVariationId === selectedFeatureVariationId) {
                    item.classList.add('selected');
                }

                const itemContent = document.createElement('div');
                itemContent.className = 'editor-layer-item-content';
                const name = document.createElement('div');
                name.className = 'master-item-name';
                name.textContent = label;
                itemContent.appendChild(name);
                item.appendChild(itemContent);

                if (featureVariation) {
                    attachFeatureVariationContextMenu(item, featureVariation);
                }

                item.addEventListener('click', () => {
                    void selectFeatureVariation(featureVariationId);
                });
                return item;
            };

            if (featureVariations.length > 0) {
                featureVariationsList.appendChild(
                    createFeatureVariationItem('Base glyph', null)
                );
            }
            featureVariations.forEach((featureVariation, index) => {
                featureVariationsList.appendChild(
                    createFeatureVariationItem(
                        featureVariationLabel(featureVariation, index),
                        featureVariation.id,
                        featureVariation
                    )
                );
            });
            if (featureVariations.length > 0) {
                featureVariationsWidget.appendChild(featureVariationsList);
            }
        }

        // Create masters/layers list
        const mastersList = document.createElement('div');
        mastersList.className = 'editor-layers-list';

        const getLocationTags = (
            ...locations: Array<Record<string, number> | undefined | null>
        ): string[] => {
            const extraTags = locations
                .flatMap((location) => Object.keys(location || {}))
                .filter((tag) => !axesOrder.includes(tag));

            return [...axesOrder, ...extraTags];
        };

        const formatCompactLocationSummary = (
            userspaceLocation: Record<string, number> | undefined | null,
            designspaceLocation: Record<string, number> | undefined | null
        ): string[] => {
            const tags = getLocationTags(
                userspaceLocation,
                designspaceLocation
            );
            const summary = tags
                .filter(
                    (tag: string) =>
                        userspaceLocation?.[tag] !== undefined ||
                        designspaceLocation?.[tag] !== undefined
                )
                .map((tag: string) => {
                    const userspaceValue = userspaceLocation?.[tag];
                    const designspaceValue = designspaceLocation?.[tag];

                    return `${tag}:${Math.round(Number(userspaceValue ?? designspaceValue))}/${Math.round(Number(designspaceValue ?? userspaceValue))}`;
                })
                .join(', ');

            return summary ? [summary] : ['default'];
        };

        const formatAxisValues = (
            location: DesignspaceLocation | undefined
        ): string[] => {
            const designspaceLocation = location
                ? ({ ...location } as Record<string, number>)
                : {};
            const userspaceLocation: Record<string, number> = location
                ? ({
                      ...designspaceToUserspace(location, fontModel.axes as any)
                  } as Record<string, number>)
                : {};

            for (const [tag, value] of Object.entries(designspaceLocation)) {
                if (userspaceLocation[tag] === undefined) {
                    userspaceLocation[tag] = value;
                }
            }

            return formatCompactLocationSummary(
                userspaceLocation,
                designspaceLocation
            );
        };

        const getLayerMasterId = (layer: Layer): string | undefined => {
            const layerMaster = layer.master;
            if (layerMaster && typeof layerMaster === 'object') {
                if ('type' in layerMaster) {
                    return (layerMaster as any).master;
                }
            }
            return undefined;
        };

        const getUserspaceLocationForDisplay = (
            location: DesignspaceLocation | undefined
        ): UserspaceLocation | null => {
            if (!location) {
                return null;
            }

            return designspaceToUserspace(location, fontModel.axes || []);
        };

        const buildLayerContextMenuHtml = (
            target: LayerListContextTarget
        ): string => {
            const items: string[] = [];

            if (!target.isMasterBound) {
                items.push(`
                    <div class="plugin-menu-item plugin-menu-item-danger" data-action="delete-layer" role="menuitem" tabindex="-1">
                        <span class="material-symbols-outlined">delete</span>
                        <span>Delete layer</span>
                    </div>
                `);
            }
            items.push(`
                <div class="plugin-menu-item" data-action="reinterpolate-layer" role="menuitem" tabindex="-1">
                    <span class="material-symbols-outlined">refresh</span>
                    <span>Reinterpolate</span>
                </div>
            `);

            return `<div class="plugin-menu" tabindex="0" role="menu" aria-label="Layer actions">${items.join('')}</div>`;
        };

        const runLayerContextAction = async (
            target: LayerListContextTarget,
            action: string | null
        ): Promise<void> => {
            if (action === 'delete-layer' && target.layerId) {
                await this.outlineEditor.deleteLayerById(target.layerId, {
                    glyphName: target.glyphName,
                    changeSource: 'layer-delete-context-menu'
                });
            } else if (action === 'reinterpolate-layer' && target.layerId) {
                await this.outlineEditor.reinterpolateLayerById(
                    target.layerId,
                    {
                        glyphName: target.glyphName,
                        changeSource: 'layer-reinterpolate-context-menu',
                        selectNewLayer: true
                    }
                );
            }

            await this.updatePropertiesUI();
            this.render();
        };

        const resolveLiveRowActionTarget = (
            item: HTMLDivElement,
            fallbackTarget: LayerListContextTarget
        ): LayerListContextTarget => {
            const glyphName =
                item.getAttribute('data-glyph-name') ||
                fallbackTarget.glyphName;
            const layerId = item.getAttribute('data-layer-id');

            return {
                ...fallbackTarget,
                glyphName,
                layerId: layerId || null
            };
        };

        const attachLayerContextMenu = (
            item: HTMLDivElement,
            target: LayerListContextTarget
        ): void => {
            if (!isEditMode || !target.layerId) {
                return;
            }

            const backdrop = getOrCreateBackdrop(
                'editor-layer-list-context-menu-backdrop'
            );
            const tippyInstance = tippy(item, {
                content: buildLayerContextMenuHtml(target),
                allowHTML: true,
                trigger: 'manual',
                interactive: true,
                appendTo: () => document.body,
                placement: 'right-start',
                theme: getTheme(),
                arrow: false,
                offset: [0, 4],
                hideOnClick: false,
                getReferenceClientRect: () => item.getBoundingClientRect(),
                onShown: (instance) => {
                    const menu = instance.popper.querySelector('.plugin-menu');
                    if (!menu) {
                        return;
                    }

                    setupMenuKeyboardNav(menu);
                    menu.querySelectorAll('.plugin-menu-item').forEach(
                        (menuItem) => {
                            (menuItem as HTMLElement).onclick = async () => {
                                const action =
                                    menuItem.getAttribute('data-action');
                                const liveTarget = resolveLiveRowActionTarget(
                                    item,
                                    target
                                );
                                instance.hide();
                                await new Promise((resolve) =>
                                    requestAnimationFrame(resolve)
                                );
                                await runLayerContextAction(liveTarget, action);
                            };
                        }
                    );
                }
            });

            addTippyBackdropSupport(tippyInstance, backdrop, {
                targetElement: item,
                activeClass: 'context-menu-active'
            });

            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const mouseX = event.clientX;
                const mouseY = event.clientY;
                tippyInstance.setProps({
                    content: buildLayerContextMenuHtml(target),
                    getReferenceClientRect: () => ({
                        width: 0,
                        height: 0,
                        top: mouseY,
                        bottom: mouseY,
                        left: mouseX,
                        right: mouseX,
                        x: mouseX,
                        y: mouseY,
                        toJSON: () => ({})
                    }),
                    theme: getTheme()
                });
                tippyInstance.show();
            });
        };

        const createLayerItem = (
            master: any,
            layer: Layer | undefined,
            displayName: string,
            axisValues: string[],
            italicizeName: boolean = false,
            target?: LayerListContextTarget
        ): HTMLDivElement => {
            const item = document.createElement('div');
            item.className = 'editor-layer-item';
            item.setAttribute('data-master-id', master.id!);
            if (target?.glyphName) {
                item.setAttribute('data-glyph-name', target.glyphName);
            }

            if (layer?.id) {
                item.setAttribute('data-layer-id', layer.id);
            }

            if (isEditMode) {
                if (layer?.id && preselectedLayerId === layer.id) {
                    item.classList.add('selected');
                }
            } else if (this.textRunEditor!.selectedMasterId === master.id) {
                item.classList.add('selected');
            }

            const itemContent = document.createElement('div');
            itemContent.className = 'editor-layer-item-content';

            const nameSpan = document.createElement('div');
            nameSpan.className = 'master-item-name';
            if (italicizeName) {
                nameSpan.classList.add('master-item-name-intermediate');
            }
            nameSpan.textContent = displayName;
            itemContent.appendChild(nameSpan);

            if (axisValues.length > 0) {
                const axisSpan = document.createElement('div');
                axisSpan.className = 'master-item-location';
                axisSpan.replaceChildren(
                    ...axisValues.map((line) => {
                        const lineEl = document.createElement('div');
                        lineEl.className = 'master-item-location-line';
                        lineEl.textContent = line;
                        return lineEl;
                    })
                );
                itemContent.appendChild(axisSpan);
            }

            item.appendChild(itemContent);

            if (isEditMode && layer?.id) {
                displayedLayerIds.push(layer.id);
                const linkButton = createLinkButton(() => {
                    const nextLinked = !this.outlineEditor.isLayerLinked(
                        layer.id,
                        glyphNameForLinkState
                    );
                    this.outlineEditor.setLayerLinked(
                        layer.id,
                        nextLinked,
                        glyphNameForLinkState
                    );
                    refreshLayerLinkControls();
                });

                linkButton.setAttribute('data-layer-id', layer.id);
                layerLinkButtons.push(linkButton);
                item.appendChild(linkButton);

                if (!isLayerCompatibleWithActive(layer)) {
                    item.appendChild(createCompatibilityIndicator());
                }
            }

            item.addEventListener('click', () => {
                if (isEditMode && layer) {
                    this.outlineEditor.selectRootFeatureVariationForLayer(
                        layer.id
                    );
                    void this.outlineEditor.selectLayer({
                        id: layer.id,
                        name: layer.name,
                        master: layer.master,
                        location: layer.location,
                        shapes: layer.shapes || [],
                        width: layer.width,
                        isInterpolated: false
                    } as any);
                } else {
                    void this.selectMaster(master.id!, master.location || {});
                }

                const editorView = document.getElementById('view-editor');
                if (editorView && editorView.classList.contains('focused')) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            });

            if (target) {
                attachLayerContextMenu(item, target);
            }

            return item;
        };

        for (const master of fontModel.masters) {
            const masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name && 'dflt' in master.name
                      ? master.name.dflt
                      : master.name && 'en' in master.name
                        ? master.name.en
                        : null;

            let defaultLayer: Layer | undefined;
            let intermediateLayers: Layer[] = [];

            if (isEditMode) {
                defaultLayer = glyphLayers.find((layer) => {
                    const layerMaster = layer.master;
                    const isFeatureVariationMasterLayer =
                        glyph instanceof FeatureVariationGlyph &&
                        layerMaster &&
                        typeof layerMaster === 'object' &&
                        'type' in layerMaster &&
                        layerMaster.type === 'AssociatedWithMaster' &&
                        (!layer.location ||
                            Object.keys(layer.location).length === 0);
                    return (
                        layerMaster &&
                        typeof layerMaster === 'object' &&
                        'type' in layerMaster &&
                        (layerMaster.type === 'DefaultForMaster' ||
                            isFeatureVariationMasterLayer) &&
                        getLayerMasterId(layer) === master.id
                    );
                });

                intermediateLayers = glyphLayers.filter((layer) => {
                    const layerMaster = layer.master;
                    return (
                        layerMaster &&
                        typeof layerMaster === 'object' &&
                        'type' in layerMaster &&
                        layerMaster.type === 'AssociatedWithMaster' &&
                        getLayerMasterId(layer) === master.id &&
                        layer.id !== defaultLayer?.id &&
                        !!layer.location &&
                        Object.keys(layer.location).length > 0
                    );
                });

                intermediateLayers.sort((left, right) => {
                    return compareLocationMaps(
                        (left.location || {}) as Record<string, any>,
                        (right.location || {}) as Record<string, any>,
                        axesOrder
                    );
                });
            }

            if (isEditMode) {
                if (defaultLayer) {
                    const masterTarget: LayerListContextTarget = {
                        glyphName: glyphNameForLinkState,
                        masterId: master.id,
                        layerId: defaultLayer.id || null,
                        userspaceLocation: getUserspaceLocationForDisplay(
                            master.location
                        ),
                        designLocation: master.location || null,
                        isMasterBound: true
                    };

                    const masterItem = createLayerItem(
                        master,
                        defaultLayer,
                        masterName || 'Default',
                        formatAxisValues(master.location),
                        false,
                        masterTarget
                    );
                    mastersList.appendChild(masterItem);
                    layerRows.push(masterTarget);
                }

                if (intermediateLayers.length > 0) {
                    for (const intermediateLayer of intermediateLayers) {
                        const braceTarget: LayerListContextTarget = {
                            glyphName: glyphNameForLinkState,
                            masterId: master.id,
                            layerId: intermediateLayer.id || null,
                            userspaceLocation: getUserspaceLocationForDisplay(
                                intermediateLayer.location
                            ),
                            designLocation: intermediateLayer.location || null,
                            isMasterBound: false
                        };
                        const braceItem = createLayerItem(
                            master,
                            intermediateLayer,
                            intermediateLayer.getComputedName(),
                            formatAxisValues(intermediateLayer.location),
                            true,
                            braceTarget
                        );
                        mastersList.appendChild(braceItem);
                        layerRows.push(braceTarget);
                    }
                }
            } else {
                const masterItem = createLayerItem(
                    master,
                    glyphLayers.find((l) => {
                        const lm = l.master;
                        return (
                            lm &&
                            typeof lm === 'object' &&
                            'type' in lm &&
                            lm.type === 'DefaultForMaster' &&
                            getLayerMasterId(l) === master.id
                        );
                    }) as Layer | undefined,
                    masterName || 'Default',
                    formatAxisValues(master.location),
                    false,
                    undefined
                );
                mastersList.appendChild(masterItem);
            }
        }

        layersWidget.appendChild(mastersList);
        refreshLayerLinkControls();
        if (featureVariationsWidget) {
            targetContainer.appendChild(featureVariationsWidget);
        }
        targetContainer.appendChild(layersWidget);

        // In edit mode, add glyph_stack debug label (development mode only, not in test mode)
        if (isEditMode && window.isDevelopment?.() && !window.isTestMode?.()) {
            const stackLabel = document.createElement('div');
            stackLabel.className = 'glyph-stack-debug';
            stackLabel.style.cssText = `
                margin-top: 8px;
                padding: 8px;
                background: var(--input-bg);
                border-radius: 4px;
                font-family: 'IBM Plex Sans', monospace;
                font-size: 11px;
                color: var(--text-muted);
                word-break: break-all;
                line-height: 1.4;
            `;
            stackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            this.glyphStackLabel = stackLabel;
            targetContainer.appendChild(stackLabel);
        }

        // In edit mode, auto-select layer if current axis values match a layer's master location
        if (isEditMode && autoSelectLayer) {
            await this.outlineEditor.autoSelectMatchingLayer();
        }
    }

    async selectMaster(
        masterId: string,
        masterLocation: DesignspaceLocation
    ): Promise<void> {
        // Ensure a full compile before layer/master switch
        await fontManager.ensureFullEditingCompile();

        this.textModeEscapeState.clear();

        // Select a master and animate to its location
        console.log(
            '[GlyphCanvas] Selecting master:',
            masterId,
            'with design location:',
            masterLocation
        );

        // Convert design location to userspace location
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.axes) {
            console.warn(
                '[GlyphCanvas] Cannot convert location: no axes available'
            );
            return;
        }

        const userspaceLocation = designspaceToUserspace(
            masterLocation,
            fontModel.axes as any
        );
        console.log(
            '[GlyphCanvas] Converted to userspace location:',
            userspaceLocation
        );

        // Store selected master ID
        this.applyTextModeKerningMasterChange(masterId);

        // Update master list UI
        this.updateMasterSelection();
        this.updatePropertyPanel();

        // Capture cursor position for auto-pan during animation
        this.captureTextModeAutoPanAnchor();

        // Animate to master location (10 frames) using userspace coordinates
        await this.animateToLocation(userspaceLocation, 10);

        // Clear auto-pan anchor after animation
        this.textModeAutoPanAnchorScreen = null;

        // Update URL with new location after animation completes (only if sync enabled)
        if (isSyncEnabled()) {
            updateUrlState({
                location: encodeLocation(this.axesManager!.variationSettings)
            });
        }
    }

    async cycleMasters(moveUp: boolean): Promise<void> {
        // Cycle through masters with Cmd+Up (previous) or Cmd+Down (next) in text mode
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.masters || fontModel.masters.length === 0) {
            return;
        }

        const masters = fontModel.masters;
        const currentMasterId = this.textRunEditor!.selectedMasterId;

        // Find current master index
        let currentIndex = masters.findIndex((m) => m.id === currentMasterId);

        // If no master selected or not found, select first master
        if (currentIndex === -1) {
            await this.selectMaster(masters[0].id!, masters[0].location || {});
            return;
        }

        // Calculate next index (with wrapping)
        let nextIndex;
        if (moveUp) {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) {
                nextIndex = masters.length - 1; // Wrap to last
            }
        } else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= masters.length) {
                nextIndex = 0; // Wrap to first
            }
        }

        // Select the next master
        await this.selectMaster(
            masters[nextIndex].id!,
            masters[nextIndex].location || {}
        );
    }

    updateMasterSelection(): void {
        // Update the visual selection highlight for master items
        if (!this.propertiesSection) return;

        const masterItems =
            this.propertiesSection.querySelectorAll('[data-master-id]');
        masterItems.forEach((item: any) => {
            const masterId = item.getAttribute('data-master-id');
            if (masterId === this.textRunEditor!.selectedMasterId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async finalizeTextModeSliderInteraction(): Promise<void> {
        if (
            this.outlineEditor.active ||
            !this.textRunEditor ||
            !this.axesManager
        ) {
            return;
        }

        await this.autoSelectMatchingMaster();

        if (this.textRunEditor.selectedMasterId !== null) {
            this.textModeEscapeState.sync(
                this.textRunEditor.selectedMasterId,
                this.axesManager.variationSettings
            );
            console.log(
                '[GlyphCanvas] Updated previous text mode state to new master:',
                {
                    masterId: this.textRunEditor.selectedMasterId,
                    settings: this.axesManager.variationSettings
                }
            );
        }
    }

    alignTextModeEscapeStateWithCurrentMaster(): void {
        if (
            this.outlineEditor.active ||
            !this.textRunEditor ||
            !this.axesManager
        ) {
            return;
        }

        this.textModeEscapeState.sync(
            this.textRunEditor.selectedMasterId,
            this.axesManager.variationSettings
        );
    }

    async handleTextModeEscapeKey(e: KeyboardEvent): Promise<void> {
        // Check if editor view is focused
        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            editorView && editorView.classList.contains('focused');

        if (!isEditorFocused) {
            return;
        }

        if (this.axesManager?.isLoopAnimating) {
            e.preventDefault();
            this.axesManager.stopAllLoopAnimations();
            return;
        }

        if (!this.textModeEscapeState.hasSavedState()) {
            return;
        }

        e.preventDefault();

        if (
            this.textModeEscapeState.matchesCurrent(
                this.textRunEditor?.selectedMasterId || null
            )
        ) {
            this.textModeEscapeState.clear();
            return;
        }

        const previousState = this.textModeEscapeState.consume();
        if (!previousState) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        const previousMaster = fontModel?.masters?.find(
            (master) => master.id === previousState.selectionId
        );

        if (previousMaster?.location) {
            await this.selectMaster(
                previousState.selectionId,
                previousMaster.location
            );
            return;
        }

        if (previousState.variationSettings) {
            await this.animateToLocation(previousState.variationSettings, 10);
        }
    }

    async autoSelectMatchingMaster(): Promise<void> {
        // Check if current axis values match a master location
        // If so, select that master. If not, deselect current master.
        console.log('[GlyphCanvas] autoSelectMatchingMaster called');
        if (!fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model, returning');
            return;
        }
        if (this.outlineEditor.active) {
            console.log('[GlyphCanvas] Outline editor active, returning');
            return; // Only for text mode
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || !fontModel.axes) {
            console.log('[GlyphCanvas] No masters or axes, returning');
            return;
        }

        const currentLocationUserspace: UserspaceLocation = {};

        // Get current location from axes manager (userspace coordinates)
        if (!this.axesManager) {
            console.log('[GlyphCanvas] No axes manager, returning');
            return;
        }

        const axes = await this.axesManager.getVariationAxes();
        for (const axis of axes) {
            currentLocationUserspace[axis.tag] =
                this.axesManager.getAxisValue(axis.tag) || axis.default;
        }

        // Convert to designspace for comparison with master.location (which is in designspace)
        const currentLocation = userspaceToDesignspace(
            currentLocationUserspace,
            fontModel.axes as any
        );

        // Check each master for a match (tolerance of 0.5)
        const tolerance = 0.5;
        let matchingMaster: any = null;

        console.log(
            '[GlyphCanvas] Checking masters. Current location (userspace):',
            currentLocationUserspace,
            '(designspace):',
            currentLocation
        );

        for (const master of fontModel.masters) {
            if (!master.location) continue;

            // Compare in designspace - both are in designspace
            const masterLocation = master.location;

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'location (designspace):',
                masterLocation
            );

            // Check if all axes match within tolerance
            let allMatch = true;
            for (const tag in masterLocation) {
                const masterValue = Number(masterLocation[tag]);
                const currentValue =
                    currentLocation[tag] === undefined
                        ? undefined
                        : Number(currentLocation[tag]);
                if (currentValue === undefined) {
                    allMatch = false;
                    break;
                }
                const diff = Math.abs(masterValue - currentValue);
                console.log(
                    `[GlyphCanvas]   Axis ${tag}: master=${masterValue}, current=${currentValue}, diff=${diff}, match=${diff <= tolerance}`
                );
                if (Math.abs(masterValue - currentValue) > tolerance) {
                    allMatch = false;
                    break;
                }
            }

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'allMatch:',
                allMatch
            );

            if (allMatch) {
                matchingMaster = master;
                break;
            }
        }

        // Update selection based on match
        if (
            matchingMaster &&
            this.textRunEditor!.selectedMasterId !== matchingMaster.id
        ) {
            console.log(
                '[GlyphCanvas] Auto-selecting master:',
                matchingMaster.id
            );
            this.applyTextModeKerningMasterChange(matchingMaster.id);
            this.updateMasterSelection();
            this.updatePropertyPanel();
        } else if (
            !matchingMaster &&
            this.textRunEditor!.selectedMasterId !== null
        ) {
            console.log('[GlyphCanvas] Deselecting master (no match)');
            this.applyTextModeKerningMasterChange(null);
            this.updateMasterSelection();
            this.updatePropertyPanel();
        }
    }

    async animateToLocation(
        targetLocation: UserspaceLocation,
        frames: number
    ): Promise<void> {
        // Animate userspace axis values from current to target over specified frames
        const startLocation: UserspaceLocation = {};
        const isEditing = this.outlineEditor.active;
        const previousIsAnimating = this.axesManager!.isAnimating;

        if (isEditing) {
            this.outlineEditor.onSliderMouseDown();
        }

        this.axesManager!.isAnimating = true;

        // Get current location from axes manager
        for (const tag in targetLocation) {
            startLocation[tag] =
                this.axesManager!.getAxisValue(tag) ?? targetLocation[tag];
        }

        console.log(
            '[GlyphCanvas] Animating from',
            startLocation,
            'to',
            targetLocation
        );

        // Animate over frames
        for (let frame = 0; frame <= frames; frame++) {
            const t = frame / frames; // 0 to 1
            const currentLocation: UserspaceLocation = {};

            for (const tag in targetLocation) {
                const startValue = Number(startLocation[tag]);
                const targetValue = Number(targetLocation[tag]);
                currentLocation[tag] =
                    startValue + (targetValue - startValue) * t;
            }

            // Update axes
            for (const tag in currentLocation) {
                this.axesManager!.setAxisValue(
                    tag,
                    Number(currentLocation[tag])
                );
            }

            // Update axis sliders UI to show the animation
            this.axesManager!.updateAxisSliders();

            if (isEditing) {
                this.outlineEditor.animationInProgress();
            } else {
                // Shape text with HarfBuzz and apply auto-pan for all frames
                this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
                this.applyTextModeAutoPanAdjustment();
                this.render();
            }

            // Wait for next frame
            if (frame < frames) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }

        // Snap to exact target values at the end to avoid accumulated float drift.
        for (const tag in targetLocation) {
            this.axesManager!.setAxisValue(tag, Number(targetLocation[tag]));
        }
        this.axesManager!.updateAxisSliders();

        this.axesManager!.isAnimating = false;

        if (isEditing) {
            await this.outlineEditor.onSliderMouseUp();
        } else {
            this.textRunEditor!.shapeText(true);
            this.applyTextModeAutoPanAdjustment();
            this.render();
        }

        this.axesManager!.isAnimating = previousIsAnimating;

        // Notify listeners (e.g. glyph overview) about the final location
        const finalLocation: UserspaceLocation = {};
        for (const tag in targetLocation) {
            finalLocation[tag] = Math.round(Number(targetLocation[tag]));
        }
        window.dispatchEvent(
            new CustomEvent('variationLocationChanged', {
                detail: { location: finalLocation }
            })
        );

        await this.autoSelectMatchingMaster();
    }

    getCurrentGlyphName(): string {
        // Get the selected glyph index
        const selectedIndex = this.textRunEditor!.selectedGlyphIndex;
        if (
            selectedIndex < 0 ||
            selectedIndex >= this.textRunEditor!.shapedGlyphs.length
        ) {
            return 'undefined';
        }

        // Get glyph ID from shaped glyphs (after OpenType feature substitutions)
        const shapedGlyph = this.textRunEditor!.shapedGlyphs[selectedIndex];
        if (shapedGlyph.explicitGlyphName) {
            return shapedGlyph.explicitGlyphName;
        }

        const glyphId = shapedGlyph.g;
        const bufferedGlyphName =
            this.textRunEditor!.glyphNameBuffer[selectedIndex] || null;

        // Get actual glyph name from the shaped glyph ID
        // This ensures we edit the correct glyph (e.g., "a.ss04" instead of "a")
        if (this.textRunEditor!.fontBlob) {
            try {
                const glyphName = get_glyph_name(
                    this.textRunEditor!.fontBlob,
                    glyphId
                );
                if (glyphName && glyphName !== '.notdef') {
                    return glyphName;
                }
            } catch (e) {
                console.warn(`Failed to get glyph name for GID ${glyphId}:`, e);
            }
        }

        if (bufferedGlyphName) {
            return bufferedGlyphName;
        }

        // Fallback to GID if font blob is not available
        return `GID ${glyphId}`;
    }

    doUIUpdate(): void {
        this.updateComponentBreadcrumb();
        this.updatePropertiesUI();
        this.updatePropertyPanel();

        // Only render if we're on a layer (not interpolating)
        // If interpolating, render will be called after interpolation completes
        if (this.outlineEditor.selectedLayerId !== null) {
            this.render();
            this.outlineEditor.performHitDetection(null);
        }
    }

    private dispatchModeActivationEvent(
        mode: 'text' | 'edit',
        source: string
    ): void {
        const eventName =
            mode === 'edit' ? 'editModeActivated' : 'textModeActivated';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const isModeActive =
                    mode === 'edit'
                        ? this.outlineEditor.active &&
                          this.textRunEditor!.selectedGlyphIndex >= 0
                        : !this.outlineEditor.active &&
                          this.textRunEditor!.selectedGlyphIndex === -1;

                if (!isModeActive) {
                    return;
                }

                window.dispatchEvent(
                    new CustomEvent(eventName, {
                        detail: { mode, source }
                    })
                );
            });
        });
    }

    private getActiveEditModeRootGlyphName(): string | null {
        return this.outlineEditor.getAuthoringRootGlyphName() || null;
    }

    private async syncEditModeGlyphAfterTextMutation(): Promise<void> {
        if (this.editModeGlyphResyncInProgress || !this.outlineEditor.active) {
            return;
        }

        const nextGlyphName = this.getCurrentGlyphName();
        if (!nextGlyphName || nextGlyphName === 'undefined') {
            return;
        }

        const nextAuthoringRootGlyphName =
            this.outlineEditor.getAuthoringGlyphName(nextGlyphName);

        const activeRootGlyphName = this.getActiveEditModeRootGlyphName();
        if (activeRootGlyphName === nextAuthoringRootGlyphName) {
            return;
        }

        this.editModeGlyphResyncInProgress = true;

        try {
            if (activeRootGlyphName) {
                this.outlineEditor.prepareForGlyphSwitch(
                    nextAuthoringRootGlyphName
                );
            }

            this.outlineEditor.layerData = null;
            this.outlineEditor.glyphStack = '';
            this.outlineEditor.currentGlyphName = nextAuthoringRootGlyphName;

            await this.updatePropertiesUI();
            this.updateComponentBreadcrumb();
            this.updatePropertyPanel();

            if (this.outlineEditor.selectedLayerId !== null) {
                this.render();
                this.outlineEditor.performHitDetection(null);
            }

            this.outlineEditor.onGlyphSelected();
        } finally {
            this.editModeGlyphResyncInProgress = false;
        }
    }

    async doUIUpdateAsync(): Promise<void> {
        // Async version that waits for layer data to be loaded
        this.updateComponentBreadcrumb();
        await this.updatePropertiesUI();
        this.updatePropertyPanel();

        // Only render if we're on a layer (not interpolating)
        // If interpolating, render will be called after interpolation completes
        if (this.outlineEditor.selectedLayerId !== null) {
            this.render();
            this.outlineEditor.performHitDetection(null);
        }
    }

    updateComponentBreadcrumb(): void {
        // This function now just calls updateEditorTitleBar
        // Keeping it for backward compatibility with existing calls
        this.outlineEditor.updateEditorTitleBar();
    }

    private getCurrentLayerModel(): Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel || !this.outlineEditor.selectedLayerId) {
            return null;
        }

        const glyphName = this.getCurrentGlyphName();
        const glyph = fontModel.resolveGlyphView(glyphName);
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById(this.outlineEditor.selectedLayerId) || null;
    }

    private getCurrentEditingLayerModel(): Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return null;
        }

        const parsedStack = this.outlineEditor.parseGlyphStack();
        const currentStackItem =
            parsedStack.length > 0 ? parsedStack[parsedStack.length - 1] : null;
        const glyphName =
            currentStackItem?.glyphName ??
            this.outlineEditor.getAuthoringRootGlyphName();
        const layerId =
            currentStackItem?.layerId ?? this.outlineEditor.selectedLayerId;

        if (!glyphName || !layerId) {
            return null;
        }

        const glyph = fontModel.resolveGlyphView(glyphName);
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById(layerId) || null;
    }

    private getSelectedComponentModels(layer: Layer): Component[] {
        const componentIndices = this.outlineEditor.selectedComponents;
        if (componentIndices.length === 0) {
            return [];
        }

        const components: Component[] = [];
        for (const componentIndex of componentIndices) {
            const shape = layer.shapes?.[componentIndex];
            if (shape?.isComponent()) {
                components.push(shape.asComponent());
            }
        }

        return components;
    }

    private getSelectedAnchorModels(layer: Layer): Anchor[] {
        const anchorIndices = this.outlineEditor.selectedAnchors;
        if (anchorIndices.length === 0) {
            return [];
        }

        const anchors: Anchor[] = [];
        for (const anchorIndex of anchorIndices) {
            const anchor = layer.anchors?.[anchorIndex];
            if (anchor) {
                anchors.push(anchor);
            }
        }

        return anchors;
    }

    /** Layer that owns local guides (foreground when editing a background). */
    private getGuideOwningLayerModel(): Layer | null {
        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return null;
        }

        if (layer.is_background) {
            const foreground = layer.backgroundLayer;
            return foreground && !foreground.is_background ? foreground : null;
        }

        return layer;
    }

    private getCurrentEditingMasterModel(): Master | null {
        const layer =
            this.getGuideOwningLayerModel() ||
            this.getCurrentEditingLayerModel();
        if (!layer) {
            return null;
        }

        const masterId =
            typeof layer.master === 'object' && layer.master
                ? layer.master.master || null
                : null;
        if (!masterId) {
            return null;
        }

        const masters = fontManager.currentFont?.fontModel?.masters || [];
        return masters.find((master) => master.id === masterId) || null;
    }

    private getSelectedGuideModel(): Guide | null {
        const handle = this.outlineEditor.selectedGuideHandle;
        if (!handle) {
            return null;
        }

        if (handle.scope === 'layer') {
            const layer = this.getGuideOwningLayerModel();
            return layer?.guides?.[handle.index] || null;
        }

        const master = this.getCurrentEditingMasterModel();
        return master?.guides?.[handle.index] || null;
    }

    private layerHasAnchorNamed(
        layer: Layer,
        name: string,
        excludeIndices: number[] = []
    ): boolean {
        const excluded = new Set(excludeIndices);
        return (layer.anchors || []).some(
            (anchor, index) =>
                !excluded.has(index) && (anchor.name || '') === name
        );
    }

    private canEditSelectedComponentTranslation(
        layer: Layer,
        components: Component[]
    ): boolean {
        return components.length > 0 && !layer.isAutomaticAlignedLayer();
    }

    private getAutomaticComponentAnchorOverrideOptions(
        layer: Layer,
        components: Component[]
    ): string[] {
        if (components.length !== 1 || !components[0].isAutomaticAligned()) {
            return [];
        }

        return layer.getAutomaticComponentTargetAnchorOptions(components[0]);
    }

    private getNormalizedComponentTransform(
        component: Component
    ): NormalizedDecomposedTransform {
        const transform =
            component.transform || DecomposedAffineTransform.identity();
        return {
            translation: [
                transform.translation?.[0] ?? 0,
                transform.translation?.[1] ?? 0
            ],
            scale: [transform.scale?.[0] ?? 1, transform.scale?.[1] ?? 1],
            rotation: transform.rotation ?? 0,
            skew: [transform.skew?.[0] ?? 0, transform.skew?.[1] ?? 0],
            order: (transform.order ?? 'RestOfTheWorld') as
                'Glyphs' | 'RestOfTheWorld'
        };
    }

    private getComponentTransformFieldValue(
        component: Component,
        field: ComponentTransformField
    ): number {
        const transform = this.getNormalizedComponentTransform(component);
        switch (field) {
            case 'translateX':
                return transform.translation[0];
            case 'translateY':
                return transform.translation[1];
            case 'rotation':
                return (transform.rotation * 180) / Math.PI;
            case 'scaleX':
                return transform.scale[0];
            case 'scaleY':
                return transform.scale[1];
            case 'skewX':
                return (transform.skew[0] * 180) / Math.PI;
            case 'skewY':
                return (transform.skew[1] * 180) / Math.PI;
        }
    }

    private setComponentTransformFieldValue(
        component: Component,
        field: ComponentTransformField,
        value: number
    ): boolean {
        const transform = this.getNormalizedComponentTransform(component);
        const next = {
            ...transform,
            translation: [
                transform.translation[0],
                transform.translation[1]
            ] as [number, number],
            scale: [transform.scale[0], transform.scale[1]] as [number, number],
            skew: [transform.skew[0], transform.skew[1]] as [number, number]
        };

        switch (field) {
            case 'translateX':
                next.translation[0] = value;
                break;
            case 'translateY':
                next.translation[1] = value;
                break;
            case 'rotation':
                next.rotation = (value * Math.PI) / 180;
                break;
            case 'scaleX':
                next.scale[0] = value;
                break;
            case 'scaleY':
                next.scale[1] = value;
                break;
            case 'skewX':
                next.skew[0] = (value * Math.PI) / 180;
                break;
            case 'skewY':
                next.skew[1] = (value * Math.PI) / 180;
                break;
        }

        const previous = this.getComponentTransformFieldValue(component, field);
        if (Math.abs(previous - value) <= 0.000001) {
            return false;
        }

        component.transform = next as Component['transform'];
        return true;
    }

    private setComponentAutoAlignmentValue(
        component: Component,
        enabled: boolean
    ): boolean {
        if (component.automaticAlignment === enabled) {
            return false;
        }

        component.automaticAlignment = enabled;
        return true;
    }

    /**
     * Open the single-glyph picker to replace the selected component reference.
     */
    private openComponentReferencePicker(
        layer: Layer,
        component: Component
    ): void {
        window.findGlyphDialog.open({
            selectionMode: 'single',
            selectedGlyphNames: [component.reference],
            title: 'Replace Component',
            confirmLabel: 'Replace',
            onConfirm: (glyphNames) => {
                const reference = glyphNames[0];
                if (reference) {
                    void this.commitComponentReferenceChange(
                        layer,
                        component,
                        reference
                    );
                }
            },
            onClose: () => {
                if (this.canvas) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            }
        });
    }

    /**
     * Replace a component reference in the normal component update transaction.
     */
    private async commitComponentReferenceChange(
        layer: Layer,
        component: Component,
        reference: string
    ): Promise<void> {
        if (!reference || component.reference === reference) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = layer.parent()?.name;
        if (!glyphName) {
            return;
        }

        const componentIndex = layer.shapes?.findIndex(
            (shape) => shape.isComponent() && shape.asComponent() === component
        );
        const selectedComponentIndex =
            this.outlineEditor.selectedComponents.find((shapeIndex) => {
                const shape = layer.shapes?.[shapeIndex];
                if (!shape?.isComponent()) {
                    return false;
                }

                return component.id
                    ? shape.asComponent().id === component.id
                    : shape.asComponent().reference === component.reference;
            });
        const targetComponentIndex =
            componentIndex !== undefined && componentIndex >= 0
                ? componentIndex
                : selectedComponentIndex;
        if (targetComponentIndex === undefined) {
            return;
        }

        const linkedLayers = layer._getLinkedLayers?.() || [];
        const targetComponents = [layer, ...linkedLayers].map(
            (targetLayer) => targetLayer.shapes?.[targetComponentIndex]
        );
        if (targetComponents.some((shape) => !shape?.isComponent())) {
            return;
        }

        const structuralLayerTargets = [layer, ...linkedLayers]
            .filter((targetLayer) => !!targetLayer.id)
            .map((targetLayer) => ({
                glyphName,
                layerId: targetLayer.id!
            }));
        const affectedGlyphNames = new Set<string>([glyphName]);
        window.patchSyncEngine?.beginTransaction('Replace component reference');
        try {
            for (const targetComponent of targetComponents) {
                if (targetComponent?.isComponent()) {
                    targetComponent.asComponent().reference = reference;
                }
            }
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
            this.outlineEditor.prepareComponentStructuralChange(
                structuralLayerTargets
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            layer.id ?? null
        );
    }

    /**
     * Open the single-glyph picker for a component placed at the origin.
     */
    public openAddComponentDialog(): void {
        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        window.findGlyphDialog.open({
            selectionMode: 'single',
            title: 'Add Component',
            confirmLabel: 'Add',
            searchMemoryKey: 'add-component',
            onConfirm: (glyphNames) => {
                const reference = glyphNames[0];
                if (reference) {
                    void this.addComponentToLayer(layer, reference);
                }
            },
            onClose: () => {
                if (this.canvas) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            }
        });
    }

    /**
     * Prompt for an anchor name and add it at the captured canvas position.
     */
    public async openAddAnchorDialogAt(position: {
        x: number;
        y: number;
    }): Promise<void> {
        const layer = this.getCurrentEditingLayerModel();
        if (!layer || layer.is_background) {
            return;
        }

        const rawName = window.prompt('Anchor name');
        if (rawName === null) {
            if (this.canvas) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
            return;
        }

        const name = rawName.trim();
        if (!name) {
            if (this.canvas) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
            return;
        }

        if (this.layerHasAnchorNamed(layer, name)) {
            window.alert(
                `An anchor named "${name}" already exists on this layer.`
            );
            if (this.canvas) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
            return;
        }

        await this.addAnchorAtPosition(layer, name, position);
    }

    /**
     * Insert a local (layer) guideline at the captured canvas position with no
     * name, select it, and ensure guidelines are visible.
     */
    public async addGuideAtPosition(position: {
        x: number;
        y: number;
    }): Promise<void> {
        const layer = this.getCurrentEditingLayerModel();
        if (!layer || layer.is_background) {
            return;
        }

        window.patchSyncEngine?.beginTransaction('Add guide');
        try {
            layer.addGuide({
                x: Math.round(position.x),
                y: Math.round(position.y),
                angle: 0
            });
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        const guideIndex = (layer.guides?.length ?? 1) - 1;
        this.outlineEditor.selectedPoints = [];
        this.outlineEditor.selectedAnchors = [];
        this.outlineEditor.selectedComponents = [];
        this.outlineEditor.selectedSidebearingHandle = null;
        this.outlineEditor.selectedGuideHandle =
            guideIndex >= 0 ? { scope: 'layer', index: guideIndex } : null;

        if (!this.outlineEditor.guidelinesVisible) {
            this.outlineEditor.setGuidelinesVisible(true);
        }

        await this.finalizeGuidePropertyPanelMutation();

        if (this.canvas) {
            setTimeout(() => this.canvas!.focus(), 0);
        }
    }

    /**
     * Insert a component at the origin and select it.
     */
    private async addComponentToLayer(
        layer: Layer,
        reference: string
    ): Promise<void> {
        const activeLayer = this.getCurrentEditingLayerModel();
        if (
            !activeLayer ||
            activeLayer.id !== layer.id ||
            activeLayer.parent()?.name !== layer.parent()?.name
        ) {
            return;
        }

        const glyphName = activeLayer.parent()?.name;
        if (!glyphName) {
            return;
        }

        const linkedLayers = activeLayer._getLinkedLayers?.() || [];
        const affectedGlyphNames = new Set<string>([glyphName]);
        window.patchSyncEngine?.beginTransaction('Add component');
        try {
            for (const targetLayer of [activeLayer, ...linkedLayers]) {
                targetLayer.addComponent(reference);
            }
            if (
                activeLayer.is_background &&
                activeLayer.id &&
                this.outlineEditor.selectedLayerId !== activeLayer.id
            ) {
                this.outlineEditor.selectedLayerId = activeLayer.id;
                this.outlineEditor.rebuildGlyphStackWithNewLayer(
                    activeLayer.id
                );
            }
            const structuralLayerTargets = [activeLayer, ...linkedLayers]
                .filter((targetLayer) => !!targetLayer.id)
                .map((targetLayer) => ({
                    glyphName,
                    layerId: targetLayer.id!
                }));
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
            this.outlineEditor.prepareComponentStructuralChange(
                structuralLayerTargets
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        const shapeIndex = (activeLayer.shapes?.length ?? 1) - 1;
        if (shapeIndex >= 0) {
            this.outlineEditor.selectedComponents = [shapeIndex];
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            activeLayer.id ?? null
        );
    }

    /**
     * Insert an anchor at the captured canvas position and select it.
     */
    private async addAnchorAtPosition(
        layer: Layer,
        name: string,
        position: { x: number; y: number }
    ): Promise<void> {
        const activeLayer = this.getCurrentEditingLayerModel();
        if (
            !activeLayer ||
            activeLayer.id !== layer.id ||
            activeLayer.parent()?.name !== layer.parent()?.name
        ) {
            return;
        }

        const glyphName = activeLayer.parent()?.name;
        if (!glyphName) {
            return;
        }

        if (this.layerHasAnchorNamed(activeLayer, name)) {
            window.alert(
                `An anchor named "${name}" already exists on this layer.`
            );
            return;
        }

        const linkedLayers = activeLayer._getLinkedLayers?.() || [];
        const targetLayers = [activeLayer, ...linkedLayers];
        for (const targetLayer of linkedLayers) {
            if (this.layerHasAnchorNamed(targetLayer, name)) {
                window.alert(
                    `An anchor named "${name}" already exists on a linked layer.`
                );
                return;
            }
        }

        const structuralLayerTargets = targetLayers
            .filter((targetLayer) => !!targetLayer.id)
            .map((targetLayer) => ({
                glyphName,
                layerId: targetLayer.id!
            }));
        const affectedGlyphNames = new Set<string>([glyphName]);
        const roundedX = Math.round(position.x);
        const roundedY = Math.round(position.y);
        window.patchSyncEngine?.beginTransaction('Add anchor');
        try {
            for (const targetLayer of targetLayers) {
                targetLayer.addAnchor(roundedX, roundedY, name);
            }
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
            this.outlineEditor.prepareAnchorStructuralChange(
                structuralLayerTargets
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        const anchorIndex = (activeLayer.anchors?.length ?? 1) - 1;
        if (anchorIndex >= 0) {
            this.outlineEditor.selectedAnchors = [anchorIndex];
            this.outlineEditor.selectedPoints = [];
            this.outlineEditor.selectedComponents = [];
            this.outlineEditor.selectedGuideHandle = null;
            this.outlineEditor.selectedSidebearingHandle = null;
        }

        await this.finalizeAnchorPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            activeLayer.id ?? null
        );
    }

    private getComponentAutoAlignmentState(
        components: Component[]
    ): ComponentCheckboxState {
        if (components.length === 0) {
            return false;
        }

        const values = components.map((component) =>
            component.isAutomaticAligned()
        );
        const first = values[0];
        return values.every((value) => value === first) ? first : 'mixed';
    }

    private async finalizeComponentPropertyPanelMutation(
        affectedGlyphNames: string[],
        layerId: string | null
    ): Promise<void> {
        try {
            // When PatchSyncEngine is active, the authoritative bridge Yjs
            // packet + shared committed-change funnel own worker sync and
            // compile wake-up. A second refreshGlyphsAfterModelBatch would
            // delete/recreate the selected layer on the worker mirror and
            // diverge that layer's CRDT identity from the bridge document
            // (COMPILATION_EDIT_POLICY §19 / property-panel rule).
            const bridgeOwnsCommittedRefresh = !!window.patchSyncEngine;
            if (!bridgeOwnsCommittedRefresh && affectedGlyphNames.length > 0) {
                await window.fontManager?.refreshGlyphsAfterModelBatch?.(
                    affectedGlyphNames,
                    layerId || undefined
                );
            }
            await this.outlineEditor.fetchLayerData(true);
        } catch (error) {
            console.warn(
                'Failed to refresh layer after component property-panel update',
                error
            );
        }

        this.updatePropertyPanel();
        this.outlineEditor.performHitDetection(null);
        this.render();
    }

    private async finalizeAnchorPropertyPanelMutation(
        affectedGlyphNames: string[],
        layerId: string | null
    ): Promise<void> {
        try {
            const bridgeOwnsCommittedRefresh = !!window.patchSyncEngine;
            if (!bridgeOwnsCommittedRefresh && affectedGlyphNames.length > 0) {
                await window.fontManager?.refreshGlyphsAfterModelBatch?.(
                    affectedGlyphNames,
                    layerId || undefined
                );
            }
            await this.outlineEditor.fetchLayerData(true);
        } catch (error) {
            console.warn(
                'Failed to refresh layer after anchor property-panel update',
                error
            );
        }

        this.updatePropertyPanel();
        this.outlineEditor.performHitDetection(null);
        this.render();
    }

    private async finalizeGuidePropertyPanelMutation(): Promise<void> {
        // Guide edits never trigger font compilation (COMPILATION_EDIT_POLICY §15).
        try {
            const owningLayer = this.getGuideOwningLayerModel();
            if (owningLayer) {
                this.syncCurrentOutlineLayerDataFromModel(owningLayer);
            }
            await this.outlineEditor.fetchLayerData(true);
        } catch (error) {
            console.warn(
                'Failed to refresh layer after guide property-panel update',
                error
            );
        }

        this.updatePropertyPanel();
        this.outlineEditor.performHitDetection(null);
        this.render();
    }

    private async commitGuideNamePropertyPanelValue(
        value: string
    ): Promise<void> {
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const guide = this.getSelectedGuideModel();
        if (!guide) {
            this.updatePropertyPanel();
            return;
        }

        const nextName = value.trim() || undefined;
        if ((guide.name || undefined) === nextName) {
            this.updatePropertyPanel();
            return;
        }

        window.patchSyncEngine?.beginTransaction('Rename guide');
        try {
            guide.name = nextName;
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeGuidePropertyPanelMutation();
    }

    private async commitGuidePositionPropertyPanelValue(
        field: GuidePositionField,
        value: string
    ): Promise<void> {
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const guide = this.getSelectedGuideModel();
        if (!guide) {
            this.updatePropertyPanel();
            return;
        }

        const trimmedValue = value.trim();
        if (!isPlainNumericInputValue(trimmedValue)) {
            this.updatePropertyPanel();
            return;
        }

        const numericValue = Number(trimmedValue);
        const currentValue =
            field === 'angle' ? (guide.pos.angle ?? 0) : guide.pos[field];
        if (Math.abs(currentValue - numericValue) <= 0.000001) {
            this.updatePropertyPanel();
            return;
        }

        const transactionLabel =
            field === 'angle' ? 'Set guide angle' : 'Set guide position';
        window.patchSyncEngine?.beginTransaction(transactionLabel);
        try {
            if (field === 'angle') {
                guide.pos.angle = numericValue;
            } else {
                guide.pos[field] = numericValue;
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeGuidePropertyPanelMutation();
    }

    private async commitGuideGlobalPropertyPanelValue(
        isGlobal: boolean
    ): Promise<void> {
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const handle = this.outlineEditor.selectedGuideHandle;
        const guide = this.getSelectedGuideModel();
        if (!handle || !guide) {
            this.updatePropertyPanel();
            return;
        }

        const currentlyGlobal = handle.scope === 'master';
        if (currentlyGlobal === isGlobal) {
            this.updatePropertyPanel();
            return;
        }

        const layer = this.getGuideOwningLayerModel();
        const master = this.getCurrentEditingMasterModel();
        if (!layer || !master) {
            this.updatePropertyPanel();
            return;
        }

        const pos = {
            x: guide.pos.x,
            y: guide.pos.y,
            ...(guide.pos.angle !== undefined ? { angle: guide.pos.angle } : {})
        };
        const name = guide.name;
        const color = guide.color
            ? {
                  r: guide.color.r,
                  g: guide.color.g,
                  b: guide.color.b,
                  a: guide.color.a
              }
            : undefined;

        if (isGlobal) {
            // Local → Global
            const selectedIndex = handle.index;
            const selectedName = guide.name;
            const linkedLayers = layer._getLinkedLayers?.() || [];

            window.patchSyncEngine?.beginTransaction('Make guide global');
            try {
                layer.removeGuide(selectedIndex);
                if (selectedName) {
                    for (const linkedLayer of linkedLayers) {
                        const linkedGuideIndex = linkedLayer.guides?.findIndex(
                            (candidate) => candidate.name === selectedName
                        );
                        if (
                            linkedGuideIndex !== undefined &&
                            linkedGuideIndex >= 0
                        ) {
                            linkedLayer.removeGuide(linkedGuideIndex);
                        }
                    }
                }

                master.addGuide(pos, name, color);
                const newIndex = (master.guides?.length ?? 1) - 1;
                this.outlineEditor.selectedPoints = [];
                this.outlineEditor.selectedAnchors = [];
                this.outlineEditor.selectedComponents = [];
                this.outlineEditor.selectedSidebearingHandle = null;
                this.outlineEditor.selectedGuideHandle = {
                    scope: 'master',
                    index: newIndex
                };
            } finally {
                window.patchSyncEngine?.endTransaction();
            }
        } else {
            // Global → Local
            const selectedIndex = handle.index;

            window.patchSyncEngine?.beginTransaction('Make guide local');
            try {
                master.removeGuide(selectedIndex);
                layer.addGuide(pos, name, color);
                const newIndex = (layer.guides?.length ?? 1) - 1;
                this.outlineEditor.selectedPoints = [];
                this.outlineEditor.selectedAnchors = [];
                this.outlineEditor.selectedComponents = [];
                this.outlineEditor.selectedSidebearingHandle = null;
                this.outlineEditor.selectedGuideHandle = {
                    scope: 'layer',
                    index: newIndex
                };
            } finally {
                window.patchSyncEngine?.endTransaction();
            }
        }

        await this.finalizeGuidePropertyPanelMutation();
    }

    private async commitAnchorNamePropertyPanelValue(
        value: string
    ): Promise<void> {
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const selectedIndices = [...this.outlineEditor.selectedAnchors];
        if (selectedIndices.length !== 1) {
            this.updatePropertyPanel();
            return;
        }

        const anchorIndex = selectedIndices[0];
        const anchor = layer.anchors?.[anchorIndex];
        if (!anchor) {
            this.updatePropertyPanel();
            return;
        }

        const nextName = value.trim();
        if (!nextName) {
            this.updatePropertyPanel();
            return;
        }

        if ((anchor.name || '') === nextName) {
            this.updatePropertyPanel();
            return;
        }

        if (this.layerHasAnchorNamed(layer, nextName, [anchorIndex])) {
            window.alert(
                `An anchor named "${nextName}" already exists on this layer.`
            );
            this.updatePropertyPanel();
            return;
        }

        const previousName = anchor.name || '';
        const glyphName = layer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        const linkedLayers = layer._getLinkedLayers?.() || [];
        for (const linkedLayer of linkedLayers) {
            if (this.layerHasAnchorNamed(linkedLayer, nextName)) {
                window.alert(
                    `An anchor named "${nextName}" already exists on a linked layer.`
                );
                this.updatePropertyPanel();
                return;
            }
        }

        const affectedGlyphNames = new Set<string>([glyphName]);
        const structuralLayerTargets = [layer, ...linkedLayers]
            .filter((targetLayer) => !!targetLayer.id)
            .map((targetLayer) => ({
                glyphName,
                layerId: targetLayer.id!
            }));

        window.patchSyncEngine?.beginTransaction('Rename anchor');
        try {
            anchor.name = nextName;
            for (const linkedLayer of linkedLayers) {
                const linkedAnchor = linkedLayer.anchors?.find(
                    (candidate) => (candidate.name || '') === previousName
                );
                if (linkedAnchor) {
                    linkedAnchor.name = nextName;
                }
            }
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
            this.outlineEditor.prepareAnchorStructuralChange(
                structuralLayerTargets
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeAnchorPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            layer.id ?? null
        );
    }

    private async commitAnchorPositionPropertyPanelValue(
        field: AnchorPositionField,
        value: string
    ): Promise<void> {
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const trimmedValue = value.trim();
        if (!isPlainNumericInputValue(trimmedValue)) {
            this.updatePropertyPanel();
            return;
        }

        const numericValue = Number(trimmedValue);
        const selectedAnchors = this.getSelectedAnchorModels(layer);
        if (selectedAnchors.length === 0) {
            return;
        }

        let changed = false;
        const affectedGlyphNames = new Set<string>();
        window.patchSyncEngine?.beginTransaction('Set anchor position');
        try {
            for (const anchor of selectedAnchors) {
                if (field === 'x') {
                    if (Math.abs(anchor.x - numericValue) > 0.000001) {
                        anchor.x = numericValue;
                        changed = true;
                    }
                } else if (Math.abs(anchor.y - numericValue) > 0.000001) {
                    anchor.y = numericValue;
                    changed = true;
                }
            }

            const glyphName = layer.parent()?.name;
            if (glyphName) {
                affectedGlyphNames.add(glyphName);
                for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                    new Set([glyphName])
                ) || []) {
                    affectedGlyphNames.add(affectedGlyphName);
                }
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        if (!changed) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = layer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        await this.finalizeAnchorPropertyPanelMutation(
            Array.from(
                affectedGlyphNames.size > 0
                    ? affectedGlyphNames
                    : new Set([glyphName])
            ),
            layer.id ?? null
        );
    }

    private async commitComponentTransformPropertyPanelValue(
        field: ComponentTransformField,
        value: string
    ): Promise<void> {
        // During canvas drag operations, transform changes are already tracked
        // by the drag transaction in OutlineEditor. Avoid creating a second
        // history item from property-panel blur/change events.
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const trimmedValue = value.trim();
        if (!isPlainNumericInputValue(trimmedValue)) {
            this.updatePropertyPanel();
            return;
        }

        const numericValue = Number(trimmedValue);
        const selectedComponents = this.getSelectedComponentModels(layer);
        if (selectedComponents.length === 0) {
            return;
        }

        if (
            (field === 'translateX' || field === 'translateY') &&
            !this.canEditSelectedComponentTranslation(layer, selectedComponents)
        ) {
            this.updatePropertyPanel();
            return;
        }

        let changed = false;
        const affectedGlyphNames = new Set<string>();
        window.patchSyncEngine?.beginTransaction('Set component transform');
        try {
            for (const component of selectedComponents) {
                if (
                    this.setComponentTransformFieldValue(
                        component,
                        field,
                        numericValue
                    )
                ) {
                    changed = true;
                }
            }

            const glyphName = layer.parent()?.name;
            if (glyphName) {
                affectedGlyphNames.add(glyphName);
                for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                    new Set([glyphName])
                ) || []) {
                    affectedGlyphNames.add(affectedGlyphName);
                }
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        if (!changed) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = layer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(
                affectedGlyphNames.size > 0
                    ? affectedGlyphNames
                    : new Set([glyphName])
            ),
            layer.id ?? null
        );
    }

    private async commitComponentAutoAlignmentPropertyPanelValue(
        checked: boolean
    ): Promise<void> {
        const currentLayer = this.getCurrentEditingLayerModel();
        if (!currentLayer) {
            return;
        }

        const glyph = currentLayer.parent();
        if (!glyph) {
            return;
        }

        const componentIndices = this.outlineEditor.selectedComponents;
        if (componentIndices.length === 0) {
            return;
        }

        let changed = false;
        const affectedGlyphNames = new Set<string>([glyph.name]);
        window.patchSyncEngine?.beginTransaction(
            'Set component automatic alignment'
        );
        try {
            for (const layer of glyph.layers || []) {
                for (const componentIndex of componentIndices) {
                    const shape = layer.shapes?.[componentIndex];
                    if (!shape?.isComponent()) {
                        continue;
                    }

                    const component = shape.asComponent();
                    if (
                        this.setComponentAutoAlignmentValue(component, checked)
                    ) {
                        changed = true;
                    }
                }
            }

            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyph.name])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        if (!changed) {
            this.updatePropertyPanel();
            return;
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            currentLayer.id ?? null
        );
    }

    private async commitComponentAnchorPropertyPanelValue(
        value: string
    ): Promise<void> {
        const currentLayer = this.getCurrentEditingLayerModel();
        if (!currentLayer) {
            return;
        }

        const selectedComponents =
            this.getSelectedComponentModels(currentLayer);
        if (selectedComponents.length !== 1) {
            return;
        }

        const component = selectedComponents[0];
        const trimmedValue = value.trim();
        const nextAnchor = trimmedValue || undefined;
        if ((component.anchor || undefined) === nextAnchor) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = currentLayer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        const affectedGlyphNames = new Set<string>([glyphName]);
        window.patchSyncEngine?.beginTransaction(
            'Set component anchor override'
        );
        try {
            component.anchor = nextAnchor;
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            currentLayer.id ?? null
        );
    }

    private hasComponentOnlySelection(): boolean {
        return (
            this.outlineEditor.selectedComponents.length > 0 &&
            this.outlineEditor.selectedPoints.length === 0 &&
            this.outlineEditor.selectedAnchors.length === 0 &&
            this.outlineEditor.selectedGuideHandle === null
        );
    }

    private hasAnchorOnlySelection(): boolean {
        return (
            this.outlineEditor.selectedAnchors.length > 0 &&
            this.outlineEditor.selectedPoints.length === 0 &&
            this.outlineEditor.selectedComponents.length === 0 &&
            this.outlineEditor.selectedGuideHandle === null
        );
    }

    private hasGuideOnlySelection(): boolean {
        return (
            this.outlineEditor.selectedGuideHandle !== null &&
            this.outlineEditor.selectedPoints.length === 0 &&
            this.outlineEditor.selectedAnchors.length === 0 &&
            this.outlineEditor.selectedComponents.length === 0
        );
    }

    private collectLiveGlyphAdvancesForCurrentEdit(): Record<string, number> {
        if (!this.outlineEditor.active) {
            return {};
        }

        const currentLayer = this.getCurrentLayerModel();
        if (!currentLayer || !Number.isFinite(currentLayer.width)) {
            return {};
        }

        const parsedStack = this.outlineEditor.parseGlyphStack();
        const glyphName =
            parsedStack[parsedStack.length - 1]?.glyphName ??
            this.getCurrentGlyphName();
        const sourceGlyphName =
            this.outlineEditor.getAuthoringGlyphName(glyphName);
        if (!sourceGlyphName || sourceGlyphName === 'undefined') {
            return {};
        }

        if (fontManager.lastEditType !== 'anchor') {
            return { [sourceGlyphName]: currentLayer.width };
        }

        const currentLayerId = this.outlineEditor.selectedLayerId;
        const masterId =
            typeof currentLayer.master === 'object' && currentLayer.master
                ? currentLayer.master.master || null
                : null;
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return { [sourceGlyphName]: currentLayer.width };
        }

        const glyphNames =
            fontManager.getAutomaticCompositionDragScopeGlyphNames(
                sourceGlyphName,
                fontModel
            );

        const glyphAdvances: Record<string, number> = {};
        for (const candidateGlyphName of glyphNames) {
            const candidateSourceGlyphName =
                this.outlineEditor.getAuthoringGlyphName(candidateGlyphName);
            if (
                !candidateSourceGlyphName ||
                candidateSourceGlyphName in glyphAdvances
            ) {
                continue;
            }

            const glyph = fontModel.resolveGlyphView(candidateGlyphName);
            const layer =
                (currentLayerId
                    ? glyph?.findLayerById(currentLayerId)
                    : undefined) ||
                (masterId ? glyph?.findLayerByMasterId(masterId) : undefined);
            if (!layer || !Number.isFinite(layer.width)) {
                continue;
            }

            glyphAdvances[candidateSourceGlyphName] = layer.width;
        }

        if (!(sourceGlyphName in glyphAdvances)) {
            glyphAdvances[sourceGlyphName] = currentLayer.width;
        }

        return glyphAdvances;
    }

    reapplyActiveEditedGlyphAdvanceAfterShape(): boolean {
        // A completed shape is authoritative for kerning, features, variation,
        // and anchor positioning. Live width deltas belong to the pre-shape
        // interaction frame and must never overwrite that result.
        return false;
    }

    private hasInspectableSelection(): boolean {
        return (
            this.outlineEditor.selectedPoints.length > 0 ||
            this.outlineEditor.selectedAnchors.length > 0 ||
            this.outlineEditor.selectedGuideHandle !== null
        );
    }

    private setSidebearingKeyCompileContext(): void {
        fontManager.setEditingCompileContext('keyboard-sidebearing', null);
    }

    private armSidebearingKeyCompileContext(): void {
        this.setSidebearingKeyCompileContext();
    }

    private async commitPropertyPanelValue(
        side: 'left' | 'right',
        value: string
    ): Promise<void> {
        const trimmedValue = value.trim();

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        if (
            layer.isAutomaticAlignedLayer() &&
            trimmedValue &&
            !/^==?[+-]/.test(trimmedValue)
        ) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            this.render();
            return;
        }

        if (
            isPlainNumericInputValue(trimmedValue) &&
            this.outlineEditor.setSidebearingValue(side, Number(trimmedValue))
        ) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            if (!window.patchSyncEngine) {
                this.render();
            }
            return;
        }

        const previousWidth = layer.width;
        const previousChangeSource = fontManager.lastChangeSource;
        const previousEditType = fontManager.lastEditType;
        const previousChangeVersion = fontManager.currentFont?.changeVersion;

        this.setSidebearingKeyCompileContext();
        const resolution = layer.applySidebearingInput(side, value);
        const glyphName =
            (typeof layer.parent === 'function'
                ? layer.parent()?.name
                : null) ?? this.getCurrentGlyphName();
        const usesIncrementalLayerRefresh = resolution.updateScope === 'layer';

        const { advancesRefreshed } = syncModelSidebearingEditToCanvas(this, {
            layer,
            glyphName,
            side,
            previousWidth,
            render: false
        });

        this.updatePropertyPanel();

        if (!advancesRefreshed) {
            this.render();
        }
        this.outlineEditor.performHitDetection(null);

        fontManager.setEditingCompileContext('keyboard-sidebearing', null);
        const affectedGlyphNames = Array.from(
            new Set(
                resolution.affectedGlyphNames?.length
                    ? resolution.affectedGlyphNames
                    : glyphName
                      ? [glyphName]
                      : []
            )
        );
        const modelChanged =
            previousChangeVersion === undefined ||
            fontManager.currentFont?.changeVersion !== previousChangeVersion;
        const shouldRecompileAfterRefresh =
            !resolution.error &&
            !isPlainNumericInputValue(trimmedValue) &&
            affectedGlyphNames.length > 0;
        const shouldFetchLayerData =
            usesIncrementalLayerRefresh || layer.isAutomaticAlignedLayer();

        if (!modelChanged && !shouldRecompileAfterRefresh) {
            // No actual font data change — restore previous compile context.
            fontManager.setEditingCompileContext(
                previousChangeSource,
                previousEditType
            );
        }

        try {
            const bridgeOwnsCommittedRefresh = !!window.patchSyncEngine;

            if (!bridgeOwnsCommittedRefresh && affectedGlyphNames.length > 0) {
                await window.fontManager?.refreshGlyphsAfterModelBatch?.(
                    affectedGlyphNames,
                    usesIncrementalLayerRefresh
                        ? this.outlineEditor.selectedLayerId
                        : undefined
                );
            }

            if (!bridgeOwnsCommittedRefresh && shouldRecompileAfterRefresh) {
                fontManager.currentFont?.requestRecompileWithoutDataChange?.();
                window.autoCompileManager?.checkAndSchedule?.();
            }

            if (shouldFetchLayerData) {
                await this.outlineEditor.fetchLayerData(true);
            }
        } catch (error) {
            console.warn(
                'Failed to refresh layer after property-panel update',
                error
            );
        }

        if (shouldFetchLayerData) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            this.render();
        }
    }

    syncCurrentOutlineLayerDataFromModel(layer: Layer): void {
        if (
            !this.outlineEditor.selectedLayerId ||
            this.outlineEditor.selectedLayerId !== layer.id ||
            !this.outlineEditor.layerData ||
            this.outlineEditor.layerData.isInterpolated
        ) {
            return;
        }

        this.outlineEditor.layerData = LayerDataNormalizer.normalize(
            layer.toJSON(),
            false
        );
    }

    private getActivePropertyInputState(): ActivePropertyInputState | null {
        if (this.restoreCanvasFocusAfterPropertyCommit) {
            return null;
        }

        const activeElement = document.activeElement as HTMLElement | null;
        if (
            !activeElement ||
            !(activeElement instanceof HTMLInputElement) ||
            !activeElement.classList.contains('glyph-property-input')
        ) {
            return null;
        }

        const fieldKey = activeElement.dataset.propertyField;
        if (!fieldKey) {
            return null;
        }

        return {
            fieldKey,
            selectionStart: activeElement.selectionStart,
            selectionEnd: activeElement.selectionEnd
        };
    }

    private restoreActivePropertyInput(
        activeInputState: ActivePropertyInputState | null
    ): void {
        if (!activeInputState || !this.propertyPanel) {
            return;
        }

        const replacementInput = this.propertyPanel.querySelector(
            `.glyph-property-input[data-property-field="${activeInputState.fieldKey}"]`
        ) as HTMLInputElement | null;
        if (!replacementInput) {
            return;
        }

        replacementInput.focus();

        const selectionStart = Math.max(
            0,
            Math.min(
                activeInputState.selectionStart ??
                    replacementInput.value.length,
                replacementInput.value.length
            )
        );
        const selectionEnd = Math.max(
            selectionStart,
            Math.min(
                activeInputState.selectionEnd ?? replacementInput.value.length,
                replacementInput.value.length
            )
        );
        replacementInput.setSelectionRange(selectionStart, selectionEnd);
    }

    private handlePropertyInputUndoRedo(event: KeyboardEvent): boolean {
        const cmdKey = event.metaKey || event.ctrlKey;
        if (!cmdKey || event.altKey || event.key.toLowerCase() !== 'z') {
            return false;
        }

        const parsedStack = this.outlineEditor.active
            ? this.outlineEditor.parseGlyphStack()
            : [];
        const {
            rootGlyphName: contextRootGlyphName,
            undoGlyphName: contextUndoGlyphName,
            undoLayerId: contextUndoLayerId,
            historyTargetKey,
            surface
        } = getUndoRedoContext();
        const rootGlyphName = contextRootGlyphName ?? parsedStack[0]?.glyphName;
        const undoGlyphName =
            contextUndoGlyphName ??
            parsedStack[parsedStack.length - 1]?.glyphName ??
            undefined;
        const undoLayerId =
            contextUndoLayerId ?? this.outlineEditor.selectedLayerId ?? null;

        if (this.outlineEditor.active && (!rootGlyphName || !undoGlyphName)) {
            if (undoGlyphName || undoLayerId) {
                console.warn(
                    'Skipping property-input undo/redo: active outline editor has incomplete glyph stack'
                );
                return true;
            }
        }

        event.preventDefault();
        event.stopPropagation();

        void window.runBridgeUndoRedo?.(
            event.shiftKey ? 'redo' : 'undo',
            undoGlyphName,
            rootGlyphName,
            undoLayerId,
            historyTargetKey,
            surface
        );
        return true;
    }

    private getSelectedTextModeKerningMaster(): Master | null {
        if (!this.textRunEditor?.selectedMasterId) {
            return null;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        return (
            fontModel?.masters?.find(
                (candidate: Master) =>
                    candidate.id === this.textRunEditor?.selectedMasterId
            ) ?? null
        );
    }

    private getKerningGlyphNameForCluster(
        cluster: TextRunClusterInfo | null
    ): string | null {
        if (!cluster || !this.textRunEditor) {
            return null;
        }

        const glyphIndex = cluster.isRTL
            ? this.textRunEditor.findLastGlyphAtClusterPosition(cluster.start)
            : this.textRunEditor.findFirstGlyphAtClusterPosition(cluster.start);
        if (glyphIndex < 0) {
            return null;
        }

        return this.textRunEditor.glyphNameBuffer[glyphIndex] || null;
    }

    private clearTextModeKerningDraft(): void {
        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftScopeKey = null;
        this.textModeKerningDraftValue = null;
    }

    private getTextModeKerningDraftScopeKey(
        masterId: string | null,
        isRTL: boolean
    ): string | null {
        if (!masterId) {
            return null;
        }

        return `${masterId}\u0000${isRTL ? 'rtl' : 'ltr'}`;
    }

    private applyTextModeKerningMasterChange(
        nextMasterId: string | null
    ): void {
        if (!this.textRunEditor) {
            return;
        }

        if (this.textRunEditor.selectedMasterId === nextMasterId) {
            return;
        }

        this.textRunEditor.selectedMasterId = nextMasterId;
        this.textRunEditor.relayoutLines();
        this.invalidateTextModeKerningOverlayCache();
        this.textModeKerningSelectionPinned = false;
        this.clearTextModeKerningDraft();
    }

    private syncTextModeKerningSelection(
        firstKeys: string[],
        secondKeys: string[]
    ): TextModeKerningSelection {
        const previousFirstKey = this.textModeKerningSelection.firstKey;
        const previousSecondKey = this.textModeKerningSelection.secondKey;
        const nextFirstKey = firstKeys.includes(
            this.textModeKerningSelection.firstKey || ''
        )
            ? this.textModeKerningSelection.firstKey
            : null;
        const nextSecondKey = secondKeys.includes(
            this.textModeKerningSelection.secondKey || ''
        )
            ? this.textModeKerningSelection.secondKey
            : null;

        this.textModeKerningSelection = {
            firstKey: nextFirstKey,
            secondKey: nextSecondKey
        };

        if (
            nextFirstKey !== previousFirstKey ||
            nextSecondKey !== previousSecondKey
        ) {
            this.textModeKerningSelectionPinned = false;
        }

        const pairKey =
            nextFirstKey && nextSecondKey
                ? getTextModeKerningPairKey(nextFirstKey, nextSecondKey)
                : null;
        if (pairKey !== this.textModeKerningDraftPairKey) {
            this.clearTextModeKerningDraft();
        }

        return this.textModeKerningSelection;
    }

    private syncTextModeKerningSelectionScope(scopeKey: string | null): void {
        if (this.textModeKerningSelectionScopeKey === scopeKey) {
            return;
        }

        if (this.pendingTextModeKerningPreview) {
            void this.flushTextModeKerningPreviewCommit();
        }

        this.textModeKerningSelectionScopeKey = scopeKey;
        this.textModeKerningSelectionPinned = false;
    }

    private getPreferredTextModeKerningSelection(
        master: Master | null,
        firstKeys: string[],
        secondKeys: string[],
        isRTL: boolean = false
    ): TextModeKerningSelection {
        const pickFallbackKey = (keys: string[]): string | null => {
            const groupKey = keys.find((key) => key.startsWith('@'));
            return groupKey ?? keys[0] ?? null;
        };
        const fallbackSelection = {
            firstKey: pickFallbackKey(firstKeys),
            secondKey: pickFallbackKey(secondKeys)
        };

        if (!master) {
            return fallbackSelection;
        }

        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            KerningContainer | undefined;
        if (!kerning) {
            return fallbackSelection;
        }

        const preferredPairs = buildOrderedTextModeKerningPairs(
            firstKeys,
            secondKeys
        );

        for (const { firstKey, secondKey } of preferredPairs) {
            const value = getKerningPairValue(kerning, firstKey, secondKey);
            if (value !== null && value !== 0) {
                return { firstKey, secondKey };
            }
        }

        for (const { firstKey, secondKey } of preferredPairs) {
            const value = getKerningPairValue(kerning, firstKey, secondKey);
            if (value !== null) {
                return { firstKey, secondKey };
            }
        }

        return fallbackSelection;
    }

    private resolveTextModeKerningSelection(
        master: Master | null,
        firstKeys: string[],
        secondKeys: string[],
        currentSelection: TextModeKerningSelection | null,
        isRTL: boolean = false
    ): TextModeKerningSelection {
        const preferredSelection = this.getPreferredTextModeKerningSelection(
            master,
            firstKeys,
            secondKeys,
            isRTL
        );

        if (
            !currentSelection ||
            !firstKeys.includes(currentSelection.firstKey ?? '') ||
            !secondKeys.includes(currentSelection.secondKey ?? '')
        ) {
            return preferredSelection;
        }

        if (!master) {
            return currentSelection;
        }

        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            KerningContainer | undefined;
        const currentValue =
            kerning &&
            currentSelection.firstKey != null &&
            currentSelection.secondKey != null
                ? getKerningPairValue(
                      kerning,
                      currentSelection.firstKey,
                      currentSelection.secondKey
                  )
                : null;
        const preferredValue =
            preferredSelection.firstKey &&
            preferredSelection.secondKey &&
            kerning
                ? getKerningPairValue(
                      kerning,
                      preferredSelection.firstKey,
                      preferredSelection.secondKey
                  )
                : null;

        if (
            (currentValue === null || currentValue === 0) &&
            !this.textModeKerningSelectionPinned &&
            preferredValue !== null &&
            preferredValue !== 0
        ) {
            return preferredSelection;
        }

        return currentSelection;
    }

    private buildTextModeKerningOperands(
        side: KerningSide,
        glyphName: string,
        groupNames: string[],
        master: Master | null,
        oppositeKeys: string[],
        selectedOppositeKey: string | null,
        activeKey: string | null,
        isRTL: boolean = false
    ): TextModeKerningOperand[] {
        const kerning = (
            master ? (isRTL ? master.kerning_rtl : master.kerning) : undefined
        ) as KerningContainer | undefined;
        const options = [
            {
                side,
                kind: 'glyph' as const,
                name: glyphName,
                key: glyphName,
                label: formatKerningOperandLabel('glyph', glyphName),
                removable: false
            },
            ...groupNames.map((groupName) => ({
                side,
                kind: 'group' as const,
                name: groupName,
                key: `@${groupName}`,
                label: formatKerningOperandLabel('group', groupName),
                removable: true
            }))
        ];

        return options.map((option) => {
            let participates = false;
            let compatible = false;

            if (kerning) {
                for (const oppositeKey of oppositeKeys) {
                    const value =
                        side === 'first'
                            ? getKerningPairValue(
                                  kerning,
                                  option.key,
                                  oppositeKey
                              )
                            : getKerningPairValue(
                                  kerning,
                                  oppositeKey,
                                  option.key
                              );
                    if (value !== null && value !== 0) {
                        participates = true;
                        break;
                    }
                }

                if (selectedOppositeKey) {
                    const selectedValue =
                        side === 'first'
                            ? getKerningPairValue(
                                  kerning,
                                  option.key,
                                  selectedOppositeKey
                              )
                            : getKerningPairValue(
                                  kerning,
                                  selectedOppositeKey,
                                  option.key
                              );
                    compatible = selectedValue !== null && selectedValue !== 0;
                }
            }

            return {
                ...option,
                participates,
                compatible,
                active: option.key === activeKey
            };
        });
    }

    private getCurrentTextModeKerningContext(): TextModeKerningContext {
        const defaultContext: TextModeKerningContext = {
            status: 'no-pair',
            message: 'Place the cursor between two glyphs',
            isRTL: false,
            master: null,
            metrics: null,
            firstGlyphName: null,
            secondGlyphName: null,
            firstCluster: null,
            secondCluster: null,
            firstOptions: [],
            secondOptions: [],
            selectedFirstKey: null,
            selectedSecondKey: null,
            selectedFirstLabel: null,
            selectedSecondLabel: null,
            selectedValue: null,
            hasSelectedValue: false
        };

        if (!this.textRunEditor || !fontManager.currentFont?.fontModel) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        const clusterMap = this.textRunEditor.clusterMap as
            TextRunClusterInfo[] | undefined;
        const cursorPosition = this.textRunEditor.cursorPosition;
        let firstCluster: TextRunClusterInfo | null = null;
        let secondCluster: TextRunClusterInfo | null = null;
        if (clusterMap) {
            for (const cluster of clusterMap) {
                if (cluster.end === cursorPosition) {
                    firstCluster = cluster;
                }
                if (
                    secondCluster === null &&
                    cluster.start === cursorPosition
                ) {
                    secondCluster = cluster;
                }
            }
        }
        if (!firstCluster || !secondCluster) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        if (
            firstCluster.isNewline ||
            secondCluster.isNewline ||
            (firstCluster.lineIndex ?? 0) !== (secondCluster.lineIndex ?? 0)
        ) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        if (firstCluster.isRTL !== secondCluster.isRTL) {
            return {
                ...defaultContext,
                status: 'bidi-boundary',
                message: 'Kerning is disabled at direction boundaries',
                isRTL: firstCluster.isRTL,
                firstCluster,
                secondCluster
            };
        }

        const firstGlyphName = this.getKerningGlyphNameForCluster(firstCluster);
        const secondGlyphName =
            this.getKerningGlyphNameForCluster(secondCluster);
        if (!firstGlyphName || !secondGlyphName) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        this.syncTextModeKerningSelectionScope(
            [
                this.textRunEditor.selectedMasterId || '',
                firstGlyphName,
                secondGlyphName,
                String(firstCluster.start),
                String(secondCluster.start),
                firstCluster.isRTL ? 'rtl' : 'ltr'
            ].join('\u0000')
        );

        const fontModel = fontManager.currentFont.fontModel;
        const firstGroupNames = collectKerningGroupMemberships(
            fontModel.first_kern_groups,
            firstGlyphName
        );
        const secondGroupNames = collectKerningGroupMemberships(
            fontModel.second_kern_groups,
            secondGlyphName
        );
        const firstKeys = [
            firstGlyphName,
            ...firstGroupNames.map((name) => `@${name}`)
        ];
        const secondKeys = [
            secondGlyphName,
            ...secondGroupNames.map((name) => `@${name}`)
        ];
        const selection = this.syncTextModeKerningSelection(
            firstKeys,
            secondKeys
        );
        const master = this.getSelectedTextModeKerningMaster();
        const resolvedSelection = this.resolveTextModeKerningSelection(
            master,
            firstKeys,
            secondKeys,
            selection,
            firstCluster.isRTL
        );

        this.textModeKerningSelection = resolvedSelection;
        const firstOptions = this.buildTextModeKerningOperands(
            'first',
            firstGlyphName,
            firstGroupNames,
            master,
            secondKeys,
            resolvedSelection.secondKey,
            resolvedSelection.firstKey,
            firstCluster.isRTL
        );
        const secondOptions = this.buildTextModeKerningOperands(
            'second',
            secondGlyphName,
            secondGroupNames,
            master,
            firstKeys,
            resolvedSelection.firstKey,
            resolvedSelection.secondKey,
            firstCluster.isRTL
        );

        const selectedValue =
            master && resolvedSelection.firstKey && resolvedSelection.secondKey
                ? getKerningPairValue(
                      (firstCluster.isRTL
                          ? master.kerning_rtl
                          : master.kerning) as KerningContainer | undefined,
                      resolvedSelection.firstKey,
                      resolvedSelection.secondKey
                  )
                : null;
        const previewValue = this.getPendingTextModeKerningPreviewValue(
            master?.id || null,
            resolvedSelection.firstKey,
            resolvedSelection.secondKey,
            firstCluster.isRTL
        );
        const effectiveValue =
            previewValue !== undefined ? previewValue : selectedValue;
        const selectedFirstLabel =
            firstOptions.find(
                (option) => option.key === resolvedSelection.firstKey
            )?.label ?? null;
        const selectedSecondLabel =
            secondOptions.find(
                (option) => option.key === resolvedSelection.secondKey
            )?.label ?? null;

        return {
            status: master ? 'ready' : 'off-master',
            message: master ? '' : 'Select an exact master to edit kerning',
            isRTL: firstCluster.isRTL,
            master,
            metrics: (master?.metrics as Record<string, number> | null) || null,
            firstGlyphName,
            secondGlyphName,
            firstCluster,
            secondCluster,
            firstOptions,
            secondOptions,
            selectedFirstKey: resolvedSelection.firstKey,
            selectedSecondKey: resolvedSelection.secondKey,
            selectedFirstLabel,
            selectedSecondLabel,
            selectedValue: effectiveValue,
            hasSelectedValue: effectiveValue !== null
        };
    }

    private buildTextModeKerningOverlay(
        secondCluster: TextRunClusterInfo,
        isRTL: boolean,
        metrics: Record<string, number> | null,
        value: number,
        anchorX: number | null = null
    ): TextModeKerningOverlay | null {
        if (!metrics || value === 0) {
            return null;
        }

        // Junction edge on the second glyph: left edge in LTR, right edge in
        // RTL. Negative spans sit to the right (LTR) / left (RTL) of that edge;
        // positive spans sit on the opposite side. Pin that edge to cursorX so
        // live overlays grow away from the caret.
        const glyphEdge = isRTL
            ? secondCluster.x + secondCluster.width
            : secondCluster.x;
        const adjustmentEdge = glyphEdge - (isRTL ? -1 : 1) * value;
        const useCursorAnchor = anchorX !== null && Number.isFinite(anchorX);
        let minX = Math.min(glyphEdge, adjustmentEdge);
        let maxX = Math.max(glyphEdge, adjustmentEdge);
        if (useCursorAnchor) {
            const shift = (anchorX as number) - glyphEdge;
            minX += shift;
            maxX += shift;
        }
        const metricValues = Object.values(metrics).filter((metricValue) =>
            Number.isFinite(metricValue)
        );
        const fontUpm = Number(fontManager.currentFont?.fontModel?.upm) || 1000;
        const topY =
            (metricValues.length > 0
                ? Math.max(...metricValues, 0)
                : fontUpm * 0.8) + (secondCluster.y ?? 0);
        const bottomY =
            (metricValues.length > 0
                ? Math.min(...metricValues, 0)
                : -fontUpm * 0.2) + (secondCluster.y ?? 0);

        return {
            minX,
            maxX,
            topY,
            bottomY,
            value
        };
    }

    private invalidateTextModeKerningOverlayCache(): void {
        this.textModeKerningOverlayCache = null;
    }

    private rebuildTextModeKerningOverlayCacheOverlays(
        cache: TextModeKerningOverlayCache
    ): void {
        cache.overlays = cache.entries
            .map((entry) => entry.overlay)
            .filter((overlay): overlay is TextModeKerningOverlay => !!overlay);
    }

    private recomputeTextModeKerningOverlayCacheEntry(
        entry: TextModeKerningOverlayCacheEntry,
        master: Master
    ): void {
        const kerning = (entry.isRTL ? master.kerning_rtl : master.kerning) as
            KerningContainer | undefined;
        const metrics =
            (master.metrics as Record<string, number> | null) || null;
        const preferredSelection = this.getPreferredTextModeKerningSelection(
            master,
            entry.firstKeys,
            entry.secondKeys,
            entry.isRTL
        );

        entry.resolvedFirstKey = preferredSelection.firstKey;
        entry.resolvedSecondKey = preferredSelection.secondKey;
        entry.value =
            kerning &&
            preferredSelection.firstKey &&
            preferredSelection.secondKey
                ? getKerningPairValue(
                      kerning,
                      preferredSelection.firstKey,
                      preferredSelection.secondKey
                  )
                : null;
        entry.overlay =
            entry.value === null || entry.value === 0
                ? null
                : this.buildTextModeKerningOverlay(
                      entry.secondCluster,
                      entry.isRTL,
                      metrics,
                      entry.value,
                      this.textRunEditor &&
                          this.textRunEditor.cursorPosition ===
                              entry.secondCluster.start
                          ? this.textRunEditor.cursorX
                          : null
                  );
    }

    private buildTextModeKerningOverlayCache(): TextModeKerningOverlayCache | null {
        if (!this.textRunEditor || !fontManager.currentFont?.fontModel) {
            return null;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master?.id || !master.kerning || !master.metrics) {
            return null;
        }

        const fontModel = fontManager.currentFont.fontModel;
        const sortedClusters = [
            ...((this.textRunEditor.clusterMap as TextRunClusterInfo[]) || [])
        ].sort((left, right) => left.start - right.start);
        const entries: TextModeKerningOverlayCacheEntry[] = [];
        const entriesByAdjacencyKey = new Map<
            string,
            TextModeKerningOverlayCacheEntry
        >();
        const candidatePairToAdjacencyKeys = new Map<string, Set<string>>();

        for (let index = 0; index < sortedClusters.length - 1; index++) {
            const firstCluster = sortedClusters[index];
            const secondCluster = sortedClusters[index + 1];
            if (
                firstCluster.end !== secondCluster.start ||
                firstCluster.isRTL !== secondCluster.isRTL
            ) {
                continue;
            }

            const firstGlyphName =
                this.getKerningGlyphNameForCluster(firstCluster);
            const secondGlyphName =
                this.getKerningGlyphNameForCluster(secondCluster);
            if (!firstGlyphName || !secondGlyphName) {
                continue;
            }

            const firstGroupNames = collectKerningGroupMemberships(
                fontModel.first_kern_groups,
                firstGlyphName
            );
            const secondGroupNames = collectKerningGroupMemberships(
                fontModel.second_kern_groups,
                secondGlyphName
            );
            const firstKeys = [
                firstGlyphName,
                ...firstGroupNames.map((name) => `@${name}`)
            ];
            const secondKeys = [
                secondGlyphName,
                ...secondGroupNames.map((name) => `@${name}`)
            ];
            const adjacencyKey = getTextModeKerningAdjacencyKey(
                firstCluster,
                secondCluster
            );
            const entry: TextModeKerningOverlayCacheEntry = {
                adjacencyKey,
                firstKeys,
                secondKeys,
                secondCluster,
                isRTL: firstCluster.isRTL,
                resolvedFirstKey: null,
                resolvedSecondKey: null,
                value: null,
                overlay: null
            };

            this.recomputeTextModeKerningOverlayCacheEntry(entry, master);
            entries.push(entry);
            entriesByAdjacencyKey.set(adjacencyKey, entry);

            for (const pair of buildOrderedTextModeKerningPairs(
                firstKeys,
                secondKeys
            )) {
                let adjacencyKeys = candidatePairToAdjacencyKeys.get(
                    pair.pairKey
                );
                if (!adjacencyKeys) {
                    adjacencyKeys = new Set<string>();
                    candidatePairToAdjacencyKeys.set(
                        pair.pairKey,
                        adjacencyKeys
                    );
                }
                adjacencyKeys.add(adjacencyKey);
            }
        }

        const cache: TextModeKerningOverlayCache = {
            layoutVersion: this.textRunEditor.layoutVersion,
            masterId: master.id,
            overlays: [],
            entries,
            entriesByAdjacencyKey,
            candidatePairToAdjacencyKeys
        };
        this.rebuildTextModeKerningOverlayCacheOverlays(cache);
        return cache;
    }

    private getTextModeKerningOverlayCache(): TextModeKerningOverlayCache | null {
        if (!this.textRunEditor) {
            return null;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master?.id) {
            this.textModeKerningOverlayCache = null;
            return null;
        }

        const cache = this.textModeKerningOverlayCache;
        if (
            cache &&
            cache.layoutVersion === this.textRunEditor.layoutVersion &&
            cache.masterId === master.id
        ) {
            return cache;
        }

        this.textModeKerningOverlayCache =
            this.buildTextModeKerningOverlayCache();
        return this.textModeKerningOverlayCache;
    }

    private patchTextModeKerningOverlayCachePair(
        master: Master,
        firstKey: string,
        secondKey: string
    ): void {
        const cache = this.getTextModeKerningOverlayCache();
        if (!cache || cache.masterId !== master.id) {
            return;
        }

        const pairKey = getTextModeKerningPairKey(firstKey, secondKey);
        const adjacencyKeys = cache.candidatePairToAdjacencyKeys.get(pairKey);
        if (!adjacencyKeys || adjacencyKeys.size === 0) {
            return;
        }

        for (const adjacencyKey of adjacencyKeys) {
            const entry = cache.entriesByAdjacencyKey.get(adjacencyKey);
            if (!entry) {
                continue;
            }

            this.recomputeTextModeKerningOverlayCacheEntry(entry, master);
        }

        this.rebuildTextModeKerningOverlayCacheOverlays(cache);
    }

    getTextModeKerningOverlayStates(): TextModeKerningOverlay[] {
        return this.getTextModeKerningOverlayCache()?.overlays || [];
    }

    private setTextModeKerningSelection(side: KerningSide, key: string): void {
        this.textModeKerningSelection = {
            ...this.textModeKerningSelection,
            [side === 'first' ? 'firstKey' : 'secondKey']: key
        };
        this.textModeKerningSelectionPinned = true;
        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftValue = null;
        this.updatePropertyPanel();
        this.render();
        this.focusCanvasForTextModeKerning();
    }

    private scheduleTextModeKerningCompile(reason: string): void {
        const isGroupEdit = reason === 'kerning-group-membership';
        fontManager.setEditingCompileContext(
            isGroupEdit ? 'keyboard-kerning-groups' : 'keyboard-kerning-value',
            isGroupEdit ? 'kerning-groups' : 'kerning-value'
        );
        fontManager.currentFont?.markDirty(reason);
        // Kerning edits already flow through PatchSyncEngine and the shared
        // committed-change funnel, which requests the authoritative immediate
        // editing compile after the worker Yjs update settles. Waking the
        // auto-compile loop here creates a second local compile race that can
        // briefly apply an intermediate kerning result before the committed
        // compile lands.
        if (!window.patchSyncEngine) {
            fontManager.currentFont?.requestRecompileWithoutDataChange?.();
            window.autoCompileManager?.checkAndSchedule?.();
        }
    }

    private updateTextModeKerningGroupMembership(
        side: KerningSide,
        glyphName: string,
        groupName: string,
        include: boolean
    ): void {
        const normalizedGroupName = groupName.trim().replace(/^@+/, '');
        if (!normalizedGroupName) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return;
        }

        window.patchSyncEngine?.beginTransaction(
            include
                ? 'Add kern group membership'
                : 'Remove kern group membership'
        );
        try {
            if (
                !applyKerningGroupMembership(
                    fontModel,
                    side,
                    [glyphName],
                    normalizedGroupName,
                    include
                )
            ) {
                return;
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.scheduleTextModeKerningCompile('kerning-group-membership');
        this.invalidateTextModeKerningOverlayCache();
        this.updatePropertyPanel();
        this.render();
    }

    private promptAndAddTextModeKerningGroup(
        side: KerningSide,
        glyphName: string | null,
        sideTitle: string = side
    ): void {
        if (!glyphName) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        const existingGroupNames = collectKerningGroupMemberships(
            side === 'first'
                ? fontModel?.first_kern_groups
                : fontModel?.second_kern_groups,
            glyphName
        );
        if (existingGroupNames.length > 0) {
            return;
        }

        const groupName = window.prompt(`Add ${glyphName} to ${sideTitle}`);
        if (groupName === null) {
            return;
        }

        this.updateTextModeKerningGroupMembership(
            side,
            glyphName,
            groupName,
            true
        );
    }

    private async commitTextModeKerningValue(
        value: string,
        context: TextModeKerningContext,
        focusCanvas: boolean = false,
        options: { flushImmediately?: boolean } = {}
    ): Promise<void> {
        if (
            !context.master ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey
        ) {
            return;
        }

        const trimmedValue = value.trim();
        const nextValue = trimmedValue === '' ? null : Number(trimmedValue);
        if (trimmedValue !== '' && !Number.isFinite(nextValue)) {
            this.updatePropertyPanel();
            if (focusCanvas) {
                this.focusCanvasForTextModeKerning();
            }
            return;
        }

        const currentValue = context.hasSelectedValue
            ? context.selectedValue
            : null;
        const nextPairKey = getTextModeKerningPairKey(
            context.selectedFirstKey,
            context.selectedSecondKey
        );
        if (currentValue === nextValue) {
            // Preview already matches the typed value; still flush on blur
            // so the deferred model write lands when leaving the field.
            if (
                options.flushImmediately &&
                this.pendingTextModeKerningPreview
            ) {
                await this.flushTextModeKerningPreviewCommit();
            }
            this.textModeKerningDraftPairKey = nextPairKey;
            this.textModeKerningDraftScopeKey =
                this.getTextModeKerningDraftScopeKey(
                    context.master.id || null,
                    context.isRTL
                );
            this.textModeKerningDraftValue = trimmedValue;
            if (focusCanvas) {
                const active = document.activeElement as HTMLElement | null;
                if (active && this.propertyPanel?.contains(active)) {
                    active.blur();
                }
            }
            this.updatePropertyPanel();
            if (focusCanvas) {
                this.focusCanvasForTextModeKerning();
            }
            return;
        }

        this.applyTextModeKerningPreview(nextValue, context);
        if (!this.pendingTextModeKerningPreview) {
            // No live shape data (e.g. unit tests / off-canvas) — write now.
            await this.commitTextModeKerningValueDirectly(nextValue, context);
        } else {
            this.scheduleTextModeKerningPreviewCommit();
            if (options.flushImmediately) {
                await this.flushTextModeKerningPreviewCommit();
            }
        }

        if (focusCanvas) {
            // Blur before rebuilding the panel so restoreActivePropertyInput
            // does not steal focus back from the canvas.
            const active = document.activeElement as HTMLElement | null;
            if (active && this.propertyPanel?.contains(active)) {
                active.blur();
            }
        }
        this.updatePropertyPanel();
        if (focusCanvas) {
            this.focusCanvasForTextModeKerning();
        }
    }

    private async nudgeTextModeKerningValue(delta: number): Promise<void> {
        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status !== 'ready' ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey
        ) {
            return;
        }

        const currentValue = context.selectedValue ?? 0;
        await this.commitTextModeKerningValue(
            String(currentValue + delta),
            context,
            true
        );
    }

    private getPendingTextModeKerningPreviewValue(
        masterId: string | null,
        firstKey: string | null,
        secondKey: string | null,
        isRTL: boolean
    ): number | null | undefined {
        const pending = this.pendingTextModeKerningPreview;
        if (
            !pending ||
            !masterId ||
            !firstKey ||
            !secondKey ||
            pending.masterId !== masterId ||
            pending.firstKey !== firstKey ||
            pending.secondKey !== secondKey ||
            pending.isRTL !== isRTL
        ) {
            return undefined;
        }

        return pending.previewValue;
    }

    private getTextModeKerningPreviewGlyphIndex(
        firstCluster: TextRunClusterInfo,
        secondCluster: TextRunClusterInfo,
        isRTL: boolean
    ): number {
        const cluster = isRTL ? secondCluster : firstCluster;
        return cluster.glyphIndex + cluster.glyphCount - 1;
    }

    /** Glyph indices with cluster.x strictly left of caretFontX (any BiDi run). */
    private getGlyphIndicesVisuallyLeftOfCaret(caretFontX: number): number[] {
        const clusterMap = this.textRunEditor?.clusterMap as
            TextRunClusterInfo[] | undefined;
        const shapedGlyphs = this.textRunEditor?.shapedGlyphs;
        if (
            !clusterMap?.length ||
            !shapedGlyphs?.length ||
            !this.textRunEditor
        ) {
            return [];
        }

        const caretLine =
            this.textRunEditor.getLineRangeAt(this.textRunEditor.cursorPosition)
                .lineIndex ?? 0;
        const indices: number[] = [];
        for (const cluster of clusterMap) {
            if ((cluster.lineIndex ?? 0) !== caretLine) {
                continue;
            }
            if (cluster.x >= caretFontX) {
                continue;
            }
            const end = Math.min(
                cluster.glyphIndex + cluster.glyphCount,
                shapedGlyphs.length
            );
            for (let i = cluster.glyphIndex; i < end; i++) {
                indices.push(i);
            }
        }
        return indices;
    }

    private restoreTextModeKerningPreviewBaselines(
        pending: PendingTextModeKerningPreview
    ): void {
        const shapedGlyphs = this.textRunEditor?.shapedGlyphs;
        if (!shapedGlyphs) {
            return;
        }

        if (pending.baselineDxByGlyphIndex) {
            for (const [indexText, baselineDx] of Object.entries(
                pending.baselineDxByGlyphIndex
            )) {
                const glyph = shapedGlyphs[Number(indexText)];
                if (glyph) {
                    glyph.dx = baselineDx;
                }
            }
            return;
        }

        const glyph = shapedGlyphs[pending.glyphIndex];
        if (glyph) {
            glyph.ax = pending.baselineAx;
        }
    }

    private applyTextModeKerningPreview(
        previewValue: number | null,
        context: TextModeKerningContext
    ): void {
        if (
            !context.master?.id ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey ||
            !context.firstCluster ||
            !context.secondCluster ||
            !this.textRunEditor?.shapedGlyphs
        ) {
            return;
        }

        const glyphIndex = this.getTextModeKerningPreviewGlyphIndex(
            context.firstCluster,
            context.secondCluster,
            context.isRTL
        );
        const glyph = this.textRunEditor.shapedGlyphs[glyphIndex];
        if (!glyph) {
            return;
        }

        let pending = this.pendingTextModeKerningPreview;
        const samePair =
            pending &&
            pending.masterId === context.master.id &&
            pending.firstKey === context.selectedFirstKey &&
            pending.secondKey === context.selectedSecondKey &&
            pending.isRTL === context.isRTL &&
            pending.glyphIndex === glyphIndex;

        if (!samePair) {
            if (pending) {
                // Commit the previous pair immediately so a fire-and-forget
                // flush cannot race and write the newly staged preview.
                this.textModeKerningPreviewFunnel.cancelPendingCommit();
                const previous = pending;
                this.restoreTextModeKerningPreviewBaselines(previous);
                this.pendingTextModeKerningPreview = null;
                const previousMaster = this.getSelectedTextModeKerningMaster();
                if (previousMaster && previousMaster.id === previous.masterId) {
                    const committedValue =
                        getKerningPairValue(
                            (previous.isRTL
                                ? previousMaster.kerning_rtl
                                : previousMaster.kerning) as
                                KerningContainer | undefined,
                            previous.firstKey,
                            previous.secondKey
                        ) ?? null;
                    if (committedValue !== previous.previewValue) {
                        this.writeTextModeKerningPairValue(
                            previousMaster,
                            previous.firstKey,
                            previous.secondKey,
                            previous.previewValue,
                            previous.isRTL
                        );
                    }
                }
            }
            const committedValue =
                getKerningPairValue(
                    (context.isRTL
                        ? context.master.kerning_rtl
                        : context.master.kerning) as
                        KerningContainer | undefined,
                    context.selectedFirstKey,
                    context.selectedSecondKey
                ) ?? 0;
            let baselineDxByGlyphIndex: Record<number, number> | null = null;
            if (context.isRTL) {
                const caretFontX = Number.isFinite(this.textRunEditor.cursorX)
                    ? this.textRunEditor.cursorX
                    : context.secondCluster.x + context.secondCluster.width;
                baselineDxByGlyphIndex =
                    this.captureTextModeKerningPreviewRtlBaselines(caretFontX);
            }
            pending = {
                masterId: context.master.id,
                firstKey: context.selectedFirstKey,
                secondKey: context.selectedSecondKey,
                isRTL: context.isRTL,
                baselineValue: committedValue,
                previewValue: committedValue,
                glyphIndex,
                baselineAx: glyph.ax || 0,
                baselineDxByGlyphIndex
            };
            this.pendingTextModeKerningPreview = pending;
        }

        pending!.previewValue = previewValue;
        this.applyPendingTextModeKerningPreviewDelta();

        this.textModeKerningDraftPairKey = getTextModeKerningPairKey(
            context.selectedFirstKey,
            context.selectedSecondKey
        );
        this.textModeKerningDraftScopeKey =
            this.getTextModeKerningDraftScopeKey(
                context.master.id,
                context.isRTL
            );
        this.textModeKerningDraftValue =
            previewValue === null ? '' : String(previewValue);

        this.textRunEditor.buildClusterMap();
        this.textRunEditor.updateCursorVisualPosition();
        this.invalidateTextModeKerningOverlayCache();
        this.render();
    }

    private captureTextModeKerningPreviewRtlBaselines(
        caretFontX: number
    ): Record<number, number> {
        const baselineDxByGlyphIndex: Record<number, number> = {};
        const shapedGlyphs = this.textRunEditor?.shapedGlyphs;
        if (!shapedGlyphs) {
            return baselineDxByGlyphIndex;
        }

        for (const index of this.getGlyphIndicesVisuallyLeftOfCaret(
            caretFontX
        )) {
            const leftGlyph = shapedGlyphs[index];
            if (leftGlyph) {
                baselineDxByGlyphIndex[index] = leftGlyph.dx || 0;
            }
        }
        return baselineDxByGlyphIndex;
    }

    private recaptureTextModeKerningPreviewBaselines(
        pending: PendingTextModeKerningPreview
    ): boolean {
        const textRunEditor = this.textRunEditor;
        const shapedGlyphs = textRunEditor?.shapedGlyphs;
        if (!textRunEditor || !shapedGlyphs) {
            return false;
        }

        const glyph = shapedGlyphs[pending.glyphIndex];
        if (!glyph) {
            return false;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master || master.id !== pending.masterId) {
            return false;
        }

        pending.baselineValue =
            getKerningPairValue(
                (pending.isRTL ? master.kerning_rtl : master.kerning) as
                    KerningContainer | undefined,
                pending.firstKey,
                pending.secondKey
            ) ?? 0;
        pending.baselineAx = glyph.ax || 0;

        if (pending.isRTL) {
            const context = this.getCurrentTextModeKerningContext();
            const caretFontX = Number.isFinite(textRunEditor.cursorX)
                ? textRunEditor.cursorX
                : context.secondCluster
                  ? context.secondCluster.x + context.secondCluster.width
                  : 0;
            pending.baselineDxByGlyphIndex =
                this.captureTextModeKerningPreviewRtlBaselines(caretFontX);
        } else {
            pending.baselineDxByGlyphIndex = null;
        }

        return true;
    }

    private applyPendingTextModeKerningPreviewDelta(): void {
        const pending = this.pendingTextModeKerningPreview;
        const shapedGlyphs = this.textRunEditor?.shapedGlyphs;
        if (!pending || !shapedGlyphs) {
            return;
        }

        const delta = (pending.previewValue ?? 0) - pending.baselineValue;
        if (pending.isRTL && pending.baselineDxByGlyphIndex) {
            const shift = -delta;
            for (const [indexText, baselineDx] of Object.entries(
                pending.baselineDxByGlyphIndex
            )) {
                const leftGlyph = shapedGlyphs[Number(indexText)];
                if (leftGlyph) {
                    leftGlyph.dx = baselineDx + shift;
                }
            }
            return;
        }

        const glyph = shapedGlyphs[pending.glyphIndex];
        if (glyph) {
            glyph.ax = pending.baselineAx + delta;
        }
    }

    private scheduleTextModeKerningPreviewCommit(): void {
        if (!this.pendingTextModeKerningPreview) {
            return;
        }

        this.textModeKerningPreviewFunnel.scheduleCommit(async () => {
            await this.commitPendingTextModeKerningPreview();
        });
    }

    private async flushTextModeKerningPreviewCommit(): Promise<void> {
        await this.textModeKerningPreviewFunnel.flushPendingCommit();
    }

    private async commitPendingTextModeKerningPreview(): Promise<void> {
        const pending = this.pendingTextModeKerningPreview;
        if (!pending) {
            return;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master || master.id !== pending.masterId) {
            this.clearTextModeKerningLivePreview({ cancelCommit: true });
            return;
        }

        const committedValue =
            getKerningPairValue(
                (pending.isRTL ? master.kerning_rtl : master.kerning) as
                    KerningContainer | undefined,
                pending.firstKey,
                pending.secondKey
            ) ?? null;
        if (committedValue === pending.previewValue) {
            // Keep the live preview object so a later nudge on the same
            // pair reuses the original shaped baseline instead of
            // recapturing advances that still include the previous preview.
            return;
        }

        this.writeTextModeKerningPairValue(
            master,
            pending.firstKey,
            pending.secondKey,
            pending.previewValue,
            pending.isRTL
        );
    }

    private async commitTextModeKerningValueDirectly(
        nextValue: number | null,
        context: TextModeKerningContext
    ): Promise<void> {
        if (
            !context.master ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey
        ) {
            return;
        }

        this.writeTextModeKerningPairValue(
            context.master,
            context.selectedFirstKey,
            context.selectedSecondKey,
            nextValue,
            context.isRTL
        );

        const pairKey = getTextModeKerningPairKey(
            context.selectedFirstKey,
            context.selectedSecondKey
        );
        this.textModeKerningDraftPairKey = pairKey;
        this.textModeKerningDraftScopeKey =
            this.getTextModeKerningDraftScopeKey(
                context.master.id || null,
                context.isRTL
            );
        this.textModeKerningDraftValue =
            nextValue === null ? '' : String(nextValue);
    }

    private writeTextModeKerningPairValue(
        master: Master,
        firstKey: string,
        secondKey: string,
        value: number | null,
        isRTL: boolean
    ): void {
        window.patchSyncEngine?.beginTransaction('Edit kerning pair');
        try {
            setKerningPairValueOnMaster(
                master,
                firstKey,
                secondKey,
                value,
                isRTL
            );
            this.patchTextModeKerningOverlayCachePair(
                master,
                firstKey,
                secondKey
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.pendingTextModeKerningCursorAnchor = true;
        this.scheduleTextModeKerningCompile('kerning-property-panel');
    }

    /**
     * True while a text-mode kerning nudge/field burst is still live
     * (uncommitted preview, or a pending preview commit). Used to postpone
     * the deferred full compile so its reshape cannot clobber the burst.
     */
    hasActiveTextModeKerningPreviewBurst(): boolean {
        if (this.textModeKerningPreviewFunnel.hasPendingWork()) {
            return true;
        }

        const pending = this.pendingTextModeKerningPreview;
        if (!pending) {
            return false;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master || master.id !== pending.masterId) {
            return false;
        }

        const committedValue =
            getKerningPairValue(
                (pending.isRTL ? master.kerning_rtl : master.kerning) as
                    KerningContainer | undefined,
                pending.firstKey,
                pending.secondKey
            ) ?? null;
        return pending.previewValue !== committedValue;
    }

    /**
     * After a kerning-only or full reshape, recapture shaped baselines and
     * re-apply any newer uncommitted preview instead of clearing it.
     */
    reapplyTextModeKerningLivePreviewAfterReshape(): void {
        const pending = this.pendingTextModeKerningPreview;
        if (!pending) {
            return;
        }

        if (!this.recaptureTextModeKerningPreviewBaselines(pending)) {
            this.clearTextModeKerningLivePreview();
            return;
        }

        this.applyPendingTextModeKerningPreviewDelta();
        if (pending.previewValue === pending.baselineValue) {
            this.pendingTextModeKerningPreview = null;
            return;
        }

        this.textRunEditor?.buildClusterMap();
        this.textRunEditor?.updateCursorVisualPosition();
        this.invalidateTextModeKerningOverlayCache();
    }

    clearTextModeKerningLivePreview(
        options: { cancelCommit?: boolean } = {}
    ): void {
        if (options.cancelCommit) {
            this.textModeKerningPreviewFunnel.cancelPendingCommit();
        }
        this.pendingTextModeKerningPreview = null;
    }

    private updateTextModeKerningMirror(
        input: HTMLInputElement,
        mirror: HTMLElement
    ): void {
        const nextValue = input.value.trim() || input.placeholder || '0';
        mirror.textContent = nextValue;
        mirror.classList.toggle(
            'glyph-kerning-value-mirror-empty',
            !input.value.trim()
        );
    }

    getTextModeKerningOverlayState(): TextModeKerningOverlay | null {
        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status !== 'ready' ||
            !context.firstCluster ||
            !context.secondCluster ||
            !context.metrics ||
            !context.hasSelectedValue ||
            context.selectedValue === null ||
            context.selectedValue === 0
        ) {
            return null;
        }

        return this.buildTextModeKerningOverlay(
            context.secondCluster,
            context.isRTL,
            context.metrics,
            context.selectedValue,
            this.textRunEditor?.cursorX ?? null
        );
    }

    /**
     * Active First/Second keys from the text-mode kerning property panel,
     * including class (`@…`) operands when those chips are selected.
     */
    getActiveTextModeKerningPairSelection(): {
        firstKey: string;
        secondKey: string;
        isRTL: boolean;
    } | null {
        if (this.outlineEditor?.active) {
            return null;
        }
        const context = this.getCurrentTextModeKerningContext();
        if (!context.selectedFirstKey || !context.selectedSecondKey) {
            return null;
        }
        return {
            firstKey: context.selectedFirstKey,
            secondKey: context.selectedSecondKey,
            isRTL: context.isRTL
        };
    }

    private renderCurrentGlyphAutoQaWidget(): HTMLElement | null {
        const fontModel = fontManager.currentFont?.fontModel;
        const glyphName = this.getCurrentGlyphName();
        if (!fontModel || !glyphName || glyphName === 'undefined') {
            return null;
        }
        if (!fontModel.findGlyph?.(glyphName)) {
            return null;
        }
        const labels = labelsForGlyph(fontModel, glyphName);
        return renderAutoQaWidget(labels);
    }

    updatePropertyPanel(): void {
        if (!this.propertyPanel) {
            return;
        }

        destroyAutoQaTippy();

        const activeInputState = this.getActivePropertyInputState();
        this.propertyPanel.classList.remove('component-properties');
        this.propertyPanel.classList.remove('text-mode-kerning-panel');
        this.propertyPanel.classList.remove('glyph-kerning-groups-panel');
        this.propertyPanel.classList.remove('glyph-kerning-groups-rtl');

        this.propertyPanel.textContent = '';

        if (!this.outlineEditor.active) {
            this.renderTextModePropertyPanel(activeInputState);
            return;
        }

        this.propertyPanel.classList.remove('hidden');

        const isAnchorOnlySelection = this.hasAnchorOnlySelection();
        if (isAnchorOnlySelection) {
            const currentLayer = this.getCurrentEditingLayerModel();
            if (!currentLayer) {
                return;
            }

            const selectedAnchors = this.getSelectedAnchorModels(currentLayer);
            if (selectedAnchors.length === 0) {
                return;
            }

            this.propertyPanel.classList.add('component-properties');

            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';

            const fieldsRow = document.createElement('div');
            fieldsRow.className = 'glyph-component-property-grid';

            if (selectedAnchors.length === 1) {
                const nameControl = document.createElement('div');
                nameControl.className =
                    'glyph-component-property-control glyph-anchor-property-name';

                const nameLabel = document.createElement('span');
                nameLabel.className = 'glyph-property-control-label';
                nameLabel.textContent = 'Name';
                nameLabel.title = 'Anchor name';
                nameControl.appendChild(nameLabel);

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'glyph-property-input';
                nameInput.dataset.propertyField = 'anchor-name';
                nameInput.value = selectedAnchors[0].name || '';

                nameInput.addEventListener('change', () => {
                    if (this.outlineEditor.draggingSomething) {
                        return;
                    }

                    if (nameInput.dataset.skipNextPropertyCommit === 'true') {
                        delete nameInput.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitAnchorNamePropertyPanelValue(
                        nameInput.value
                    );
                });

                nameInput.addEventListener('keydown', (event) => {
                    if (this.handlePropertyInputUndoRedo(event)) {
                        return;
                    }

                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.restoreCanvasFocusAfterPropertyCommit = true;
                        nameInput.dataset.skipNextPropertyCommit = 'true';
                        void this.commitAnchorNamePropertyPanelValue(
                            nameInput.value
                        );
                        nameInput.blur();
                    }
                });

                nameInput.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (this.restoreCanvasFocusAfterPropertyCommit) {
                            this.restoreCanvasFocusAfterPropertyCommit = false;
                            this.outlineEditor.restoreFocus();
                            return;
                        }

                        const activeElement =
                            document.activeElement as HTMLElement | null;
                        if (
                            activeElement &&
                            this.isTextInputElement(activeElement)
                        ) {
                            return;
                        }

                        this.outlineEditor.restoreFocus();
                    }, 0);
                });

                nameControl.appendChild(nameInput);
                fieldsRow.appendChild(nameControl);
            }

            const createAnchorPositionControl = (
                field: AnchorPositionField
            ) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'glyph-component-property-control';

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'glyph-property-input';
                input.dataset.propertyField = `anchor-${field}`;
                input.title =
                    field === 'x'
                        ? 'Anchor position on X axis'
                        : 'Anchor position on Y axis';

                const sharedValue = getSharedNumericValue(
                    selectedAnchors.map((anchor) =>
                        field === 'x' ? anchor.x : anchor.y
                    )
                );

                if (sharedValue === null) {
                    input.value = '';
                    input.placeholder = 'Multiple values';
                    input.classList.add('glyph-property-input-mixed');
                } else {
                    input.value = String(Number(sharedValue.toFixed(4)));
                }

                const arrowInputController = new ArrowAdjustableTextInput({
                    input,
                    getValue: () => {
                        const trimmedValue = input.value.trim();
                        if (isPlainNumericInputValue(trimmedValue)) {
                            return Number(trimmedValue);
                        }

                        return (
                            sharedValue ??
                            (field === 'x'
                                ? selectedAnchors[0].x
                                : selectedAnchors[0].y)
                        );
                    },
                    applyValue: async (nextValue) => {
                        input.dataset.skipNextPropertyCommit = 'true';
                        await this.commitAnchorPositionPropertyPanelValue(
                            field,
                            String(nextValue)
                        );
                    },
                    findReplacementInput: () =>
                        this.propertyPanel?.querySelector(
                            `.glyph-property-input[data-property-field="anchor-${field}"]`
                        ) as HTMLInputElement | null
                });

                input.addEventListener('change', () => {
                    if (this.outlineEditor.draggingSomething) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitAnchorPositionPropertyPanelValue(
                        field,
                        input.value
                    );
                });

                input.addEventListener('keydown', (event) => {
                    if (this.handlePropertyInputUndoRedo(event)) {
                        return;
                    }

                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.restoreCanvasFocusAfterPropertyCommit = true;
                        input.dataset.skipNextPropertyCommit = 'true';
                        void this.commitAnchorPositionPropertyPanelValue(
                            field,
                            input.value
                        );
                        input.blur();
                    }
                });

                input.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (this.restoreCanvasFocusAfterPropertyCommit) {
                            this.restoreCanvasFocusAfterPropertyCommit = false;
                            if (!arrowInputController.isApplyingStep) {
                                this.outlineEditor.restoreFocus();
                            }
                            return;
                        }

                        const activeElement =
                            document.activeElement as HTMLElement | null;
                        if (
                            activeElement &&
                            this.isTextInputElement(activeElement)
                        ) {
                            return;
                        }

                        if (!arrowInputController.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                    }, 0);
                });

                wrapper.appendChild(input);
                return wrapper;
            };

            const positionGroup = document.createElement('div');
            positionGroup.className =
                'glyph-component-property-transform-group';

            const positionLabel = document.createElement('span');
            positionLabel.className = 'glyph-property-control-label';
            positionLabel.textContent = 'Position X/Y';
            positionGroup.appendChild(positionLabel);
            positionGroup.appendChild(createAnchorPositionControl('x'));
            positionGroup.appendChild(createAnchorPositionControl('y'));
            fieldsRow.appendChild(positionGroup);

            content.appendChild(fieldsRow);
            this.propertyPanel.appendChild(content);
            this.restoreActivePropertyInput(activeInputState);
            return;
        }

        const isGuideOnlySelection = this.hasGuideOnlySelection();
        if (isGuideOnlySelection) {
            const guide = this.getSelectedGuideModel();
            if (!guide) {
                return;
            }

            const guideHandle = this.outlineEditor.selectedGuideHandle!;
            const isGlobal = guideHandle.scope === 'master';

            this.propertyPanel.classList.add('component-properties');

            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';

            const fieldsRow = document.createElement('div');
            fieldsRow.className = 'glyph-component-property-grid';

            const nameControl = document.createElement('div');
            nameControl.className =
                'glyph-component-property-control glyph-anchor-property-name';

            const nameLabel = document.createElement('span');
            nameLabel.className = 'glyph-property-control-label';
            nameLabel.textContent = 'Name';
            nameLabel.title = 'Guideline name';
            nameControl.appendChild(nameLabel);

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'glyph-property-input';
            nameInput.dataset.propertyField = 'guide-name';
            nameInput.value = guide.name || '';

            nameInput.addEventListener('change', () => {
                if (this.outlineEditor.draggingSomething) {
                    return;
                }

                if (nameInput.dataset.skipNextPropertyCommit === 'true') {
                    delete nameInput.dataset.skipNextPropertyCommit;
                    return;
                }

                void this.commitGuideNamePropertyPanelValue(nameInput.value);
            });

            nameInput.addEventListener('keydown', (event) => {
                if (this.handlePropertyInputUndoRedo(event)) {
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.outlineEditor.restoreFocus();
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.restoreCanvasFocusAfterPropertyCommit = true;
                    nameInput.dataset.skipNextPropertyCommit = 'true';
                    void this.commitGuideNamePropertyPanelValue(
                        nameInput.value
                    );
                    nameInput.blur();
                }
            });

            nameInput.addEventListener('blur', () => {
                setTimeout(() => {
                    if (this.restoreCanvasFocusAfterPropertyCommit) {
                        this.restoreCanvasFocusAfterPropertyCommit = false;
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    const activeElement =
                        document.activeElement as HTMLElement | null;
                    if (
                        activeElement &&
                        this.isTextInputElement(activeElement)
                    ) {
                        return;
                    }

                    this.outlineEditor.restoreFocus();
                }, 0);
            });

            nameControl.appendChild(nameInput);
            fieldsRow.appendChild(nameControl);

            const createGuideNumericControl = (field: GuidePositionField) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'glyph-component-property-control';

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'glyph-property-input';
                input.dataset.propertyField = `guide-${field}`;
                input.title =
                    field === 'x'
                        ? 'Guideline position on X axis'
                        : field === 'y'
                          ? 'Guideline position on Y axis'
                          : 'Guideline angle in degrees';

                const fieldValue =
                    field === 'angle'
                        ? (guide.pos.angle ?? 0)
                        : guide.pos[field];
                input.value = String(Number(fieldValue.toFixed(4)));

                const arrowInputController = new ArrowAdjustableTextInput({
                    input,
                    getValue: () => {
                        const trimmedValue = input.value.trim();
                        if (isPlainNumericInputValue(trimmedValue)) {
                            return Number(trimmedValue);
                        }

                        return field === 'angle'
                            ? (guide.pos.angle ?? 0)
                            : guide.pos[field];
                    },
                    applyValue: async (nextValue) => {
                        input.dataset.skipNextPropertyCommit = 'true';
                        await this.commitGuidePositionPropertyPanelValue(
                            field,
                            String(nextValue)
                        );
                    },
                    findReplacementInput: () =>
                        this.propertyPanel?.querySelector(
                            `.glyph-property-input[data-property-field="guide-${field}"]`
                        ) as HTMLInputElement | null
                });

                input.addEventListener('change', () => {
                    if (this.outlineEditor.draggingSomething) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitGuidePositionPropertyPanelValue(
                        field,
                        input.value
                    );
                });

                input.addEventListener('keydown', (event) => {
                    if (this.handlePropertyInputUndoRedo(event)) {
                        return;
                    }

                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.restoreCanvasFocusAfterPropertyCommit = true;
                        input.dataset.skipNextPropertyCommit = 'true';
                        void this.commitGuidePositionPropertyPanelValue(
                            field,
                            input.value
                        );
                        input.blur();
                    }
                });

                input.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (this.restoreCanvasFocusAfterPropertyCommit) {
                            this.restoreCanvasFocusAfterPropertyCommit = false;
                            if (!arrowInputController.isApplyingStep) {
                                this.outlineEditor.restoreFocus();
                            }
                            return;
                        }

                        const activeElement =
                            document.activeElement as HTMLElement | null;
                        if (
                            activeElement &&
                            this.isTextInputElement(activeElement)
                        ) {
                            return;
                        }

                        if (!arrowInputController.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                    }, 0);
                });

                wrapper.appendChild(input);
                return wrapper;
            };

            const positionGroup = document.createElement('div');
            positionGroup.className =
                'glyph-component-property-transform-group';

            const positionLabel = document.createElement('span');
            positionLabel.className = 'glyph-property-control-label';
            positionLabel.textContent = 'Position X/Y';
            positionGroup.appendChild(positionLabel);
            positionGroup.appendChild(createGuideNumericControl('x'));
            positionGroup.appendChild(createGuideNumericControl('y'));
            fieldsRow.appendChild(positionGroup);

            const angleControl = createGuideNumericControl('angle');
            const angleLabel = document.createElement('span');
            angleLabel.className = 'glyph-property-control-label';
            angleLabel.textContent = 'Angle';
            angleLabel.title = 'Guideline angle in degrees';
            angleControl.insertBefore(angleLabel, angleControl.firstChild);
            fieldsRow.appendChild(angleControl);

            const globalControl = document.createElement('label');
            globalControl.className =
                'glyph-component-property-control glyph-component-property-checkbox';

            const globalInput = document.createElement('input');
            globalInput.type = 'checkbox';
            globalInput.className = 'glyph-component-property-checkbox-input';
            globalInput.dataset.propertyField = 'guide-global';
            globalInput.checked = isGlobal;
            globalInput.addEventListener('change', () => {
                if (this.outlineEditor.draggingSomething) {
                    this.updatePropertyPanel();
                    return;
                }

                void this.commitGuideGlobalPropertyPanelValue(
                    globalInput.checked
                );
            });

            const globalLabel = document.createElement('span');
            globalLabel.className = 'glyph-property-control-label';
            globalLabel.textContent = 'Global';
            globalLabel.title =
                'Master-level guideline (shared across glyphs for this master)';

            globalControl.appendChild(globalLabel);
            globalControl.appendChild(globalInput);
            fieldsRow.appendChild(globalControl);

            content.appendChild(fieldsRow);
            this.propertyPanel.appendChild(content);
            this.restoreActivePropertyInput(activeInputState);
            return;
        }

        const isComponentOnlySelection = this.hasComponentOnlySelection();
        if (this.hasInspectableSelection() && !isComponentOnlySelection) {
            const placeholder = document.createElement('div');
            placeholder.className = 'glyph-property-panel-placeholder';
            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';

            const currentLayer = this.getCurrentEditingLayerModel();
            const selectedPathIndexes = currentLayer
                ? [
                      ...new Set(
                          this.outlineEditor.selectedPoints
                              .map((point) => point.contourIndex)
                              .filter((index) =>
                                  Boolean(
                                      currentLayer.shapes?.[index]?.isPath?.()
                                  )
                              )
                      )
                  ]
                : [];
            if (
                selectedPathIndexes.length > 0 &&
                currentLayer &&
                !this.outlineEditor.getCurrentLayerDataFromStack()
                    ?.isInterpolated
            ) {
                const allSubtracting = selectedPathIndexes.every((index) =>
                    Boolean(
                        currentLayer.shapes?.[index]?.asPath?.().isSubtraction
                    )
                );
                const subtractControl = document.createElement('label');
                subtractControl.className =
                    'glyph-component-property-control glyph-component-property-checkbox';
                subtractControl.dataset.propertyField = 'path-subtraction';
                subtractControl.title =
                    'Subtract selected paths from shapes below them';

                const subtractInput = document.createElement('input');
                subtractInput.type = 'checkbox';
                subtractInput.className =
                    'glyph-component-property-checkbox-input';
                subtractInput.dataset.propertyField = 'path-subtraction';
                subtractInput.checked = allSubtracting;
                subtractInput.addEventListener('change', () => {
                    this.outlineEditor.setSelectedPathsSubtraction(
                        subtractInput.checked
                    );
                    this.canvas!.focus();
                });

                const subtractLabel = document.createElement('span');
                subtractLabel.className = 'glyph-property-control-label';
                subtractLabel.textContent = 'Subtract';
                subtractLabel.title =
                    'Subtract selected paths from shapes below them';

                subtractControl.appendChild(subtractLabel);
                subtractControl.appendChild(subtractInput);
                content.appendChild(subtractControl);
            }

            if (content.childNodes.length === 0) {
                return;
            }

            placeholder.appendChild(content);
            this.propertyPanel.appendChild(placeholder);
            return;
        }

        if (isComponentOnlySelection) {
            const currentLayer = this.getCurrentEditingLayerModel();
            if (!currentLayer) {
                return;
            }

            const selectedComponents =
                this.getSelectedComponentModels(currentLayer);
            if (selectedComponents.length === 0) {
                return;
            }

            this.propertyPanel.classList.add('component-properties');

            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';
            const translationLocked = !this.canEditSelectedComponentTranslation(
                currentLayer,
                selectedComponents
            );
            const anchorOverrideOptions =
                this.getAutomaticComponentAnchorOverrideOptions(
                    currentLayer,
                    selectedComponents
                );

            const createComponentFieldControl = (
                field: ComponentTransformField,
                labelText?: string
            ) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'glyph-component-property-control';

                const labelTooltips: Record<ComponentTransformField, string> = {
                    translateX: 'Component translation on X axis',
                    translateY: 'Component translation on Y axis',
                    rotation: 'Component rotation in degrees',
                    scaleX: 'Component scale on X axis',
                    scaleY: 'Component scale on Y axis',
                    skewX: 'Component skew on X axis in degrees',
                    skewY: 'Component skew on Y axis in degrees'
                };
                if (labelText) {
                    const label = document.createElement('span');
                    label.className = 'glyph-property-control-label';
                    label.textContent = labelText;
                    label.title = labelTooltips[field];
                    wrapper.appendChild(label);
                }

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'glyph-property-input';
                input.dataset.propertyField = `component-${field}`;

                const sharedValue = getSharedNumericValue(
                    selectedComponents.map((component) =>
                        this.getComponentTransformFieldValue(component, field)
                    )
                );

                if (sharedValue === null) {
                    input.value = '';
                    input.placeholder = 'Multiple values';
                    input.classList.add('glyph-property-input-mixed');
                } else {
                    input.value = String(Number(sharedValue.toFixed(4)));
                }

                const isTranslationField =
                    field === 'translateX' || field === 'translateY';
                if (translationLocked && isTranslationField) {
                    input.disabled = true;
                    input.title =
                        'Automatic component translation is derived from anchor alignment';
                }

                const arrowInputController =
                    translationLocked && isTranslationField
                        ? null
                        : new ArrowAdjustableTextInput({
                              input,
                              getValue: () => {
                                  const trimmedValue = input.value.trim();
                                  if (isPlainNumericInputValue(trimmedValue)) {
                                      return Number(trimmedValue);
                                  }

                                  return (
                                      sharedValue ??
                                      this.getComponentTransformFieldValue(
                                          selectedComponents[0],
                                          field
                                      )
                                  );
                              },
                              applyValue: async (nextValue) => {
                                  input.dataset.skipNextPropertyCommit = 'true';
                                  await this.commitComponentTransformPropertyPanelValue(
                                      field,
                                      String(nextValue)
                                  );
                              },
                              findReplacementInput: () =>
                                  this.propertyPanel?.querySelector(
                                      `.glyph-property-input[data-property-field="component-${field}"]`
                                  ) as HTMLInputElement | null
                          });

                input.addEventListener('change', () => {
                    if (this.outlineEditor.draggingSomething) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitComponentTransformPropertyPanelValue(
                        field,
                        input.value
                    );
                });

                input.addEventListener('keydown', (event) => {
                    if (this.handlePropertyInputUndoRedo(event)) {
                        return;
                    }

                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.restoreCanvasFocusAfterPropertyCommit = true;
                        input.dataset.skipNextPropertyCommit = 'true';
                        void this.commitComponentTransformPropertyPanelValue(
                            field,
                            input.value
                        );
                        input.blur();
                    }
                });

                input.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (this.restoreCanvasFocusAfterPropertyCommit) {
                            this.restoreCanvasFocusAfterPropertyCommit = false;
                            if (!arrowInputController?.isApplyingStep) {
                                this.outlineEditor.restoreFocus();
                            }
                            return;
                        }

                        const activeElement =
                            document.activeElement as HTMLElement | null;
                        if (
                            activeElement &&
                            this.isTextInputElement(activeElement)
                        ) {
                            return;
                        }

                        if (!arrowInputController?.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                    }, 0);
                });

                wrapper.appendChild(input);
                return wrapper;
            };

            const createComponentTransformGroup = (
                labelText: string,
                fields: ComponentTransformField[]
            ) => {
                const group = document.createElement('div');
                group.className = 'glyph-component-property-transform-group';

                const label = document.createElement('span');
                label.className = 'glyph-property-control-label';
                label.textContent = labelText;
                group.appendChild(label);

                for (const field of fields) {
                    group.appendChild(createComponentFieldControl(field));
                }

                return group;
            };

            const fieldsRow = document.createElement('div');
            fieldsRow.className = 'glyph-component-property-grid';

            if (selectedComponents.length === 1) {
                const component = selectedComponents[0];
                const referenceControl = document.createElement('div');
                referenceControl.className =
                    'glyph-component-property-control glyph-component-property-reference';

                const referenceLabel = document.createElement('span');
                referenceLabel.className = 'glyph-property-control-label';
                referenceLabel.textContent = 'Reference';
                referenceControl.appendChild(referenceLabel);

                const referenceBox = document.createElement('div');
                referenceBox.className = 'glyph-component-reference-box';

                const referenceName = document.createElement('span');
                referenceName.className = 'glyph-component-reference-name';
                referenceName.textContent = abbreviateGlyphNameMiddle(
                    component.reference
                );
                referenceName.title = component.reference;
                referenceBox.appendChild(referenceName);

                const replaceButton = document.createElement('button');
                replaceButton.type = 'button';
                replaceButton.className = 'glyph-component-reference-replace';
                replaceButton.title = 'Replace component reference';
                replaceButton.setAttribute(
                    'aria-label',
                    'Replace component reference'
                );
                replaceButton.innerHTML =
                    '<span class="material-symbols-outlined">swap_horiz</span>';
                replaceButton.addEventListener('click', () =>
                    this.openComponentReferencePicker(currentLayer, component)
                );
                referenceBox.appendChild(replaceButton);

                referenceControl.appendChild(referenceBox);
                fieldsRow.appendChild(referenceControl);
            }

            const alignmentState =
                this.getComponentAutoAlignmentState(selectedComponents);
            const alignmentControl = document.createElement('label');
            alignmentControl.className =
                'glyph-component-property-control glyph-component-property-checkbox glyph-component-property-auto-align';

            const alignmentInput = document.createElement('input');
            alignmentInput.type = 'checkbox';
            alignmentInput.className =
                'glyph-component-property-checkbox-input';
            alignmentInput.dataset.propertyField = 'component-auto-alignment';
            alignmentInput.checked = alignmentState === true;
            alignmentInput.indeterminate = alignmentState === 'mixed';

            const alignmentLabel = document.createElement('span');
            alignmentLabel.className = 'glyph-property-control-label';
            alignmentLabel.textContent = 'Auto Align';
            alignmentLabel.title =
                'Enable automatic component alignment for selected components';

            alignmentInput.addEventListener('change', () => {
                void this.commitComponentAutoAlignmentPropertyPanelValue(
                    alignmentInput.checked
                );
                this.canvas!.focus();
            });

            alignmentControl.appendChild(alignmentLabel);
            alignmentControl.appendChild(alignmentInput);
            fieldsRow.appendChild(alignmentControl);

            fieldsRow.appendChild(
                createComponentTransformGroup('Translate X/Y', [
                    'translateX',
                    'translateY'
                ])
            );
            fieldsRow.appendChild(
                createComponentFieldControl('rotation', 'Rotate')
            );
            fieldsRow.appendChild(
                createComponentTransformGroup('Scale X/Y', ['scaleX', 'scaleY'])
            );
            fieldsRow.appendChild(
                createComponentTransformGroup('Skew X/Y', ['skewX', 'skewY'])
            );

            content.appendChild(fieldsRow);

            if (anchorOverrideOptions.length > 1) {
                const anchorWrapper = document.createElement('div');
                anchorWrapper.className = 'glyph-component-property-control';

                const anchorLabel = document.createElement('span');
                anchorLabel.className = 'glyph-property-control-label';
                anchorLabel.textContent = 'Anchor';
                anchorLabel.title =
                    'Choose which eligible target anchor this automatic component attaches to';

                const anchorSelect = document.createElement('select');
                anchorSelect.className = 'glyph-property-input';
                anchorSelect.dataset.propertyField = 'component-anchor';

                const automaticOption = document.createElement('option');
                automaticOption.value = '';
                automaticOption.textContent = 'Automatic';
                anchorSelect.appendChild(automaticOption);

                for (const anchorName of anchorOverrideOptions) {
                    const option = document.createElement('option');
                    option.value = anchorName;
                    option.textContent = anchorName;
                    anchorSelect.appendChild(option);
                }

                anchorSelect.value = selectedComponents[0].anchor || '';
                anchorSelect.addEventListener('change', () => {
                    void this.commitComponentAnchorPropertyPanelValue(
                        anchorSelect.value
                    );
                });

                anchorWrapper.appendChild(anchorLabel);
                anchorWrapper.appendChild(anchorSelect);
                content.appendChild(anchorWrapper);
            }

            this.propertyPanel.appendChild(content);
            this.restoreActivePropertyInput(activeInputState);
            return;
        }

        if (this.outlineEditor.isEditingBackgroundLayer()) {
            this.propertyPanel.classList.add('hidden');
            this.propertyPanel.textContent = '';
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const content = document.createElement('div');
        content.className = 'glyph-property-panel-content';
        const automaticLayer = layer.isAutomaticAlignedLayer();

        const createControl = (side: 'left' | 'right', shortLabel: string) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'glyph-property-control';

            const label = document.createElement('span');
            label.className = 'glyph-property-control-label';
            label.dataset.kerningSide = side === 'left' ? 'second' : 'first';
            label.textContent = shortLabel;
            label.title =
                side === 'left' ? 'Left sidebearing' : 'Right sidebearing';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'glyph-property-input';
            input.dataset.sidebearingSide = side;
            input.dataset.propertyField = `side-${side}`;

            const resolution = layer.resolveMetricsKey(side);
            const storedMetricsKey =
                (side === 'left'
                    ? layer.leftMetricsKey || layer.parent()?.leftMetricsKey
                    : layer.rightMetricsKey ||
                      layer.parent()?.rightMetricsKey) || undefined;
            const metricsKey = resolution.input
                ? storedMetricsKey || resolution.input
                : undefined;
            const showAutoPlaceholder = !metricsKey && automaticLayer;
            const displayedValue = showAutoPlaceholder
                ? ''
                : (metricsKey ??
                  String(side === 'left' ? layer.lsb : layer.rsb));
            input.value = displayedValue;
            if (showAutoPlaceholder) {
                input.placeholder = '=+0 or ==+0';
            }
            if (automaticLayer) {
                input.title =
                    'Automatic layers only accept =+/- or ==+/- sidebearing adjustments';
            }
            if (resolution.error) {
                input.classList.add('invalid');
            }

            const getResolvedValue = () =>
                resolution.value ?? (side === 'left' ? layer.lsb : layer.rsb);

            const arrowInputController = automaticLayer
                ? null
                : new ArrowAdjustableTextInput({
                      input,
                      getValue: () => {
                          const trimmedValue = input.value.trim();
                          return isPlainNumericInputValue(trimmedValue)
                              ? Number(trimmedValue)
                              : getResolvedValue();
                      },
                      applyValue: async (nextValue) => {
                          input.dataset.skipNextPropertyCommit = 'true';
                          await this.commitPropertyPanelValue(
                              side,
                              String(nextValue)
                          );
                      },
                      findReplacementInput: () =>
                          this.propertyPanel?.querySelector(
                              `.glyph-property-input[data-property-field="side-${side}"]`
                          ) as HTMLInputElement | null
                  });

            input.addEventListener('change', () => {
                if (input.dataset.skipNextPropertyCommit === 'true') {
                    delete input.dataset.skipNextPropertyCommit;
                    return;
                }

                void this.commitPropertyPanelValue(side, input.value);
            });
            input.addEventListener('keydown', (event) => {
                if (this.handlePropertyInputUndoRedo(event)) {
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.outlineEditor.restoreFocus();
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.restoreCanvasFocusAfterPropertyCommit = true;
                    input.dataset.skipNextPropertyCommit = 'true';
                    void this.commitPropertyPanelValue(side, input.value);
                    input.blur();
                }
            });
            input.addEventListener('blur', () => {
                setTimeout(() => {
                    if (this.restoreCanvasFocusAfterPropertyCommit) {
                        this.restoreCanvasFocusAfterPropertyCommit = false;
                        if (!arrowInputController?.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                        return;
                    }

                    const activeElement =
                        document.activeElement as HTMLElement | null;
                    if (
                        activeElement &&
                        this.isTextInputElement(activeElement)
                    ) {
                        return;
                    }

                    if (!arrowInputController?.isApplyingStep) {
                        this.outlineEditor.restoreFocus();
                    }
                }, 0);
            });

            const valueLabel = document.createElement('span');
            valueLabel.className = 'glyph-property-value';
            valueLabel.textContent = String(
                resolution.value ?? (side === 'left' ? layer.lsb : layer.rsb)
            );

            wrapper.appendChild(label);
            wrapper.appendChild(input);
            wrapper.appendChild(valueLabel);
            return wrapper;
        };

        const createWidthDisplay = () => {
            const wrapper = document.createElement('div');
            wrapper.className = 'glyph-property-display';

            const label = document.createElement('span');
            label.className = 'glyph-property-control-label';
            label.textContent = 'W';
            label.title = 'Advance width';

            const valueLabel = document.createElement('span');
            valueLabel.className = 'glyph-property-display-value';
            valueLabel.textContent = String(layer.width);

            wrapper.appendChild(label);
            wrapper.appendChild(valueLabel);
            return wrapper;
        };

        content.appendChild(createControl('left', 'LSB'));
        content.appendChild(createWidthDisplay());
        content.appendChild(createControl('right', 'RSB'));

        const rawGlyphName = this.getCurrentGlyphName();
        const fontModel = fontManager.currentFont?.fontModel;
        const glyphName = fontModel?.findGlyph?.(rawGlyphName)
            ? rawGlyphName
            : null;
        const glyphNames = glyphName ? [glyphName] : [];

        this.propertyPanel.classList.add('glyph-kerning-groups-panel');
        renderKerningGroupWidget(this.propertyPanel, {
            startSide: buildEditViewKerningGroupSide(
                'second',
                glyphNames,
                fontModel?.second_kern_groups
            ),
            endSide: buildEditViewKerningGroupSide(
                'first',
                glyphNames,
                fontModel?.first_kern_groups
            ),
            center: content,
            onRemoveChip: (chip) => {
                if (!glyphName) {
                    return;
                }
                this.updateTextModeKerningGroupMembership(
                    chip.pairSide,
                    glyphName,
                    chip.name,
                    false
                );
            },
            onAdd: (pairSide, sideGlyphNames) => {
                this.promptAndAddTextModeKerningGroup(
                    pairSide,
                    sideGlyphNames[0] ?? null,
                    formatKerningGroupKindLabel(pairSide)
                );
            }
        });
        const autoQaWidget = this.renderCurrentGlyphAutoQaWidget();
        if (autoQaWidget) {
            const kerningShell = this.propertyPanel.querySelector(
                '.glyph-kerning-panel-shell'
            );
            (kerningShell ?? this.propertyPanel).appendChild(autoQaWidget);
        }
        this.restoreActivePropertyInput(activeInputState);
    }

    private renderTextModePropertyPanel(
        activeInputState: ActivePropertyInputState | null
    ): void {
        if (!this.propertyPanel || !this.textRunEditor) {
            return;
        }

        this.propertyPanel.classList.remove('hidden');
        this.propertyPanel.classList.add('text-mode-kerning-panel');
        this.propertyPanel.classList.add('glyph-kerning-groups-panel');

        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status === 'no-pair' ||
            context.status === 'bidi-boundary'
        ) {
            const placeholder = document.createElement('div');
            placeholder.className = 'glyph-property-panel-placeholder';

            const message = document.createElement('span');
            message.className = 'glyph-property-value';
            message.textContent = context.message;

            placeholder.appendChild(message);
            this.propertyPanel.appendChild(placeholder);
            return;
        }

        this.propertyPanel.classList.toggle(
            'glyph-kerning-groups-rtl',
            context.isRTL
        );

        const toChip = (option: TextModeKerningOperand): KerningGroupChip => ({
            pairSide: option.side,
            kind: option.kind,
            name: option.name,
            key: option.key,
            label: option.label,
            removable: option.removable,
            participates: option.participates,
            compatible: option.compatible,
            active: option.active
        });

        const center = document.createElement('div');

        if (context.status === 'off-master') {
            const message = document.createElement('span');
            message.className = 'glyph-property-value';
            message.textContent = context.message;
            center.appendChild(message);
        } else {
            const code = document.createElement('div');
            code.className = 'glyph-kerning-code';
            const pairLine = document.createElement('div');
            pairLine.className = 'glyph-kerning-code-line';
            const valueLine = document.createElement('div');
            valueLine.className = 'glyph-kerning-code-line';

            const addCodeToken = (
                parent: HTMLElement,
                text: string,
                className?: string
            ) => {
                const token = document.createElement('span');
                token.className = className || 'glyph-property-value';
                token.textContent = text;
                parent.appendChild(token);
            };

            const pairKey =
                context.selectedFirstKey && context.selectedSecondKey
                    ? `${context.selectedFirstKey}\u0000${context.selectedSecondKey}`
                    : null;
            const draftScopeKey = this.getTextModeKerningDraftScopeKey(
                context.master?.id || null,
                context.isRTL
            );
            const initialValue =
                pairKey &&
                this.textModeKerningDraftPairKey === pairKey &&
                this.textModeKerningDraftScopeKey === draftScopeKey
                    ? this.textModeKerningDraftValue || ''
                    : context.hasSelectedValue && context.selectedValue !== null
                      ? String(context.selectedValue)
                      : '';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'glyph-property-input glyph-kerning-value-input';
            input.dataset.propertyField = 'text-mode-kerning-value';
            input.value = initialValue;
            input.placeholder = '0';

            const arrowInputController = new ArrowAdjustableTextInput({
                input,
                getValue: () => {
                    const trimmedValue = input.value.trim();
                    if (isPlainNumericInputValue(trimmedValue)) {
                        return Number(trimmedValue);
                    }

                    return context.selectedValue ?? 0;
                },
                applyValue: async (nextValue) => {
                    input.dataset.skipNextPropertyCommit = 'true';
                    if (pairKey) {
                        this.textModeKerningDraftPairKey = pairKey;
                        this.textModeKerningDraftScopeKey = draftScopeKey;
                        this.textModeKerningDraftValue = String(nextValue);
                    }
                    await this.commitTextModeKerningValue(
                        String(nextValue),
                        context,
                        false
                    );
                },
                findReplacementInput: () =>
                    this.propertyPanel?.querySelector(
                        '.glyph-property-input[data-property-field="text-mode-kerning-value"]'
                    ) as HTMLInputElement | null
            });

            input.addEventListener('input', () => {
                if (pairKey) {
                    this.textModeKerningDraftPairKey = pairKey;
                    this.textModeKerningDraftScopeKey = draftScopeKey;
                    this.textModeKerningDraftValue = input.value;
                }
            });

            input.addEventListener('change', () => {
                if (input.dataset.skipNextPropertyCommit === 'true') {
                    delete input.dataset.skipNextPropertyCommit;
                    return;
                }

                void this.commitTextModeKerningValue(
                    input.value,
                    context,
                    true,
                    { flushImmediately: true }
                );
            });

            input.addEventListener('keydown', (event) => {
                if (this.handlePropertyInputUndoRedo(event)) {
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.dataset.skipNextPropertyCommit = 'true';
                    void this.commitTextModeKerningValue(
                        input.value,
                        context,
                        true
                    );
                    input.blur();
                }
            });

            addCodeToken(pairLine, 'pos\u00A0');
            addCodeToken(
                pairLine,
                `${context.selectedFirstLabel || ''}\u00A0`,
                'glyph-property-value glyph-kerning-code-first'
            );
            addCodeToken(
                pairLine,
                `${context.selectedSecondLabel || ''}\u00A0`,
                'glyph-property-value glyph-kerning-code-second'
            );

            if (context.isRTL) {
                addCodeToken(valueLine, '<0\u00A00\u00A0');
                valueLine.appendChild(input);
                addCodeToken(valueLine, '\u00A00>;');
            } else {
                valueLine.appendChild(input);
                addCodeToken(valueLine, ';');
            }

            code.appendChild(pairLine);
            code.appendChild(valueLine);

            input.addEventListener('blur', () => {
                setTimeout(() => {
                    const activeElement =
                        document.activeElement as HTMLElement | null;
                    if (
                        activeElement &&
                        this.isTextInputElement(activeElement)
                    ) {
                        return;
                    }

                    if (arrowInputController.isApplyingStep) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitTextModeKerningValue(
                        input.value,
                        context,
                        true,
                        { flushImmediately: true }
                    );
                }, 0);
            });

            center.appendChild(code);
        }

        const firstGlyphNames = context.firstGlyphName
            ? [context.firstGlyphName]
            : [];
        const secondGlyphNames = context.secondGlyphName
            ? [context.secondGlyphName]
            : [];
        const firstHasGroup = context.firstOptions.some(
            (option) => option.kind === 'group'
        );
        const secondHasGroup = context.secondOptions.some(
            (option) => option.kind === 'group'
        );

        renderKerningGroupWidget(this.propertyPanel, {
            startSide: {
                pairSide: 'first',
                title: formatTextModeKerningSideTitle('first', context.isRTL),
                glyphNames: firstGlyphNames,
                missingGlyphNames: firstHasGroup ? [] : firstGlyphNames,
                chips: context.firstOptions.map(toChip)
            },
            endSide: {
                pairSide: 'second',
                title: formatTextModeKerningSideTitle('second', context.isRTL),
                glyphNames: secondGlyphNames,
                missingGlyphNames: secondHasGroup ? [] : secondGlyphNames,
                chips: context.secondOptions.map(toChip)
            },
            center,
            isRTL: context.isRTL,
            onSelectChip: (chip) => {
                this.setTextModeKerningSelection(chip.pairSide, chip.key);
            },
            onRemoveChip: (chip) => {
                const glyphName =
                    chip.pairSide === 'first'
                        ? context.firstGlyphName
                        : context.secondGlyphName;
                if (!glyphName) {
                    return;
                }
                this.updateTextModeKerningGroupMembership(
                    chip.pairSide,
                    glyphName,
                    chip.name,
                    false
                );
            },
            onAdd: (pairSide, glyphNames) => {
                this.promptAndAddTextModeKerningGroup(
                    pairSide,
                    glyphNames[0] ?? null,
                    formatKerningGroupKindLabel(pairSide, context.isRTL)
                );
            }
        });

        this.restoreActivePropertyInput(activeInputState);
    }

    getSortedLayers(layers: any[] | undefined = this.fontData?.layers): any[] {
        if (!this.fontData || !layers || layers.length === 0) {
            return [];
        }

        // Get sorted layers by master order.
        // Within one master, keep default layers first, then brace layers.
        const sortedLayers = [...layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(
                (m: any) => m.id === a._master
            );
            const masterIndexB = this.fontData.masters.findIndex(
                (m: any) => m.id === b._master
            );

            const posA =
                masterIndexA === -1
                    ? this.fontData.masters.length
                    : masterIndexA;
            const posB =
                masterIndexB === -1
                    ? this.fontData.masters.length
                    : masterIndexB;

            if (posA !== posB) {
                return posA - posB;
            }

            // Within same master: default layers (no location) before brace layers
            const isBraceA = !!a.location && Object.keys(a.location).length > 0;
            const isBraceB = !!b.location && Object.keys(b.location).length > 0;
            if (isBraceA !== isBraceB) {
                return isBraceA ? 1 : -1;
            }

            if (isBraceA && isBraceB) {
                const axesOrder =
                    (fontManager.currentFont?.fontModel as any)?.axesOrder ||
                    Object.keys({
                        ...(a.location || {}),
                        ...(b.location || {})
                    }).sort();
                return compareLocationMaps(
                    a.location || {},
                    b.location || {},
                    axesOrder
                );
            }

            return 0;
        });
        return sortedLayers;
    }

    doubleClickOnGlyph(index: number): void {
        if (
            this.outlineEditor.active &&
            index === this.textRunEditor!.selectedGlyphIndex
        ) {
            return;
        }
        void this.textRunEditor!.selectGlyphByIndex(index);
    }

    frameCurrentGlyph(margin: number | null = null): void {
        // Pan and zoom to show the current glyph with margin around it
        // Delegates to ViewportManager.frameGlyph

        if (
            !this.outlineEditor.active ||
            this.textRunEditor!.selectedGlyphIndex < 0
        ) {
            return;
        }

        const bounds = this.outlineEditor.calculateGlyphBoundingBox();
        if (!bounds) {
            return;
        }

        const rect = this.getCanvasContentFrame();
        const frameMargin =
            margin === null ? this.getCmdZeroFrameMargin(rect) : margin;

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor!._getGlyphPosition(
            this.textRunEditor!.selectedGlyphIndex
        );

        // If editing inside a component, transform the bounding box to glyph space
        let transformedBounds = bounds;
        if (this.outlineEditor.isEditingComponent()) {
            const transform = this.outlineEditor.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;

            // Transform all four corners of the bbox
            const corners = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY }
            ];

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const corner of corners) {
                const transformedX = a * corner.x + c * corner.y + tx;
                const transformedY = b * corner.x + d * corner.y + ty;
                minX = Math.min(minX, transformedX);
                minY = Math.min(minY, transformedY);
                maxX = Math.max(maxX, transformedX);
                maxY = Math.max(maxY, transformedY);
            }

            transformedBounds = {
                minX,
                minY,
                maxX,
                maxY,
                width: maxX - minX,
                height: maxY - minY
            };
        }

        // Delegate to ViewportManager
        this.viewportManager!.frameGlyph(
            transformedBounds,
            glyphPosition,
            rect,
            this.render.bind(this),
            frameMargin
        );
    }

    getCmdZeroViewportTarget(
        margin: number | null = null
    ): { scale: number; panX: number; panY: number } | null {
        if (
            !this.outlineEditor.active ||
            this.textRunEditor!.selectedGlyphIndex < 0 ||
            !this.viewportManager ||
            !this.canvas
        ) {
            return null;
        }

        const rootLayerData = this.outlineEditor.layerData;
        if (!rootLayerData) {
            return null;
        }

        // Always frame the root glyph (Cmd+0 behavior), even when editing nested components.
        const bounds = Layer.calculateBoundingBox(rootLayerData, true);
        if (!bounds) {
            return null;
        }

        const rect = this.getCanvasContentFrame();
        const glyphPosition = this.textRunEditor!._getGlyphPosition(
            this.textRunEditor!.selectedGlyphIndex
        );

        const effectiveMargin =
            margin === null ? this.getCmdZeroFrameMargin(rect) : margin;
        const fontSpaceMinX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.minX;
        const fontSpaceMaxX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.maxX;
        const fontSpaceMinY = glyphPosition.yOffset + bounds.minY;
        const fontSpaceMaxY = glyphPosition.yOffset + bounds.maxY;

        const fontSpaceCenterX = (fontSpaceMinX + fontSpaceMaxX) / 2;
        const fontSpaceCenterY = (fontSpaceMinY + fontSpaceMaxY) / 2;

        const scaleX = (rect.width - effectiveMargin * 2) / bounds.width;
        const scaleY = (rect.height - effectiveMargin * 2) / bounds.height;
        const targetScale = Math.min(scaleX, scaleY);
        const clampedScale = Math.max(
            0.01,
            Math.min(
                APP_SETTINGS.OUTLINE_EDITOR.MAX_ZOOM_FOR_CMD_ZERO,
                Number.isFinite(targetScale) ? targetScale : 0.01
            )
        );

        const targetPanX =
            viewportFrameCenterX(rect) - fontSpaceCenterX * clampedScale;
        const targetPanY =
            viewportFrameCenterY(rect) - -fontSpaceCenterY * clampedScale;

        return {
            scale: clampedScale,
            panX: targetPanX,
            panY: targetPanY
        };
    }

    getCmdZeroFrameMargin(frame: ViewportFrame): number {
        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        return Math.max(
            settings.CMD_ZERO_FRAME_MARGIN,
            Math.min(frame.width, frame.height) * 0.12
        );
    }

    getLineOverviewViewportTarget(): {
        scale: number;
        panX: number;
        panY: number;
    } | null {
        if (!this.viewportManager || !this.textRunEditor) {
            return null;
        }

        const rect = this.getCanvasContentFrame();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        const scale = APP_SETTINGS.OUTLINE_EDITOR.CMD_ZERO_LINE_SCALE;
        const band = this.getTextModeVerticalMetricsBand();
        const lineCenterY = (band.lowest + band.highest) / 2;
        let lockX = this.textRunEditor.cursorX;
        if (
            this.outlineEditor.active &&
            this.textRunEditor.selectedGlyphIndex >= 0
        ) {
            const position = this.textRunEditor._getGlyphPosition(
                this.textRunEditor.selectedGlyphIndex
            );
            lockX = position.xPosition + position.xOffset;
        }

        const currentScreenX = this.viewportManager.fontToScreenCoordinates(
            lockX,
            lineCenterY
        ).x;
        return {
            scale,
            panX: currentScreenX - lockX * scale,
            panY: viewportFrameCenterY(rect) + lineCenterY * scale
        };
    }

    private viewportMatchesCmdZeroStage1(): boolean {
        if (this.cmdZeroStage1Pending) {
            return true;
        }
        const target = this.cmdZeroStage1Target;
        const viewport = this.viewportManager;
        if (!target || !viewport) {
            return false;
        }
        return (
            Math.abs(viewport.scale - target.scale) < 0.0005 &&
            Math.abs(viewport.panX - target.panX) < 1 &&
            Math.abs(viewport.panY - target.panY) < 1
        );
    }

    private clearCmdZeroStage1(): void {
        this.cmdZeroStage1Target = null;
        this.cmdZeroStage1Pending = false;
    }

    private applyCmdZeroViewportTarget(
        target: { scale: number; panX: number; panY: number },
        rememberAsStage1: boolean
    ): void {
        this.cmdZeroStage1Target = rememberAsStage1 ? target : null;
        this.cmdZeroStage1Pending = rememberAsStage1;
        this.viewportManager!.animateZoomAndPan(
            target.scale,
            target.panX,
            target.panY,
            this.render.bind(this),
            rememberAsStage1
                ? () => {
                      this.cmdZeroStage1Pending = false;
                  }
                : undefined
        );
    }

    handleCmdZeroFit(): void {
        const inEditMode =
            !!this.outlineEditor.active &&
            (this.textRunEditor?.selectedGlyphIndex ?? -1) >= 0;

        if (this.viewportMatchesCmdZeroStage1()) {
            if (inEditMode) {
                const lineTarget = this.getLineOverviewViewportTarget();
                if (lineTarget) {
                    this.applyCmdZeroViewportTarget(lineTarget, false);
                }
                return;
            }

            this.cmdZeroStage1Target = null;
            this.cmdZeroStage1Pending = false;
            this.fitViewportToCurrentText(undefined, {
                min: APP_SETTINGS.OUTLINE_EDITOR.CMD_ZERO_TEXT_FIT_MIN,
                max: APP_SETTINGS.OUTLINE_EDITOR.CMD_ZERO_TEXT_FIT_MAX
            });
            return;
        }

        if (inEditMode) {
            const frameTarget = this.getCmdZeroViewportTarget();
            if (frameTarget) {
                this.applyCmdZeroViewportTarget(frameTarget, true);
            }
            return;
        }

        const lineTarget = this.getLineOverviewViewportTarget();
        if (lineTarget) {
            this.applyCmdZeroViewportTarget(lineTarget, true);
        }
    }

    async updatePropertiesUI(options?: {
        skipAutoSelectMatchingLayer?: boolean;
    }): Promise<void> {
        if (!this.propertiesSection) return;

        // Prevent overlapping calls
        if (this.isUpdatingPropertiesUI) {
            console.log(
                '[GlyphCanvas] updatePropertiesUI already in progress, skipping'
            );
            editorHealth.notePropertiesUpdateSkipped();
            return;
        }

        this.isUpdatingPropertiesUI = true;
        editorHealth.notePropertiesUpdateStarted();

        try {
            // Check if propertiesSection is still in the DOM
            if (!this.propertiesSection.parentElement) {
                const leftSidebar = document.getElementById(
                    'glyph-properties-sidebar'
                );
                if (leftSidebar) {
                    this.propertiesSection.innerHTML = '';
                    leftSidebar.appendChild(this.propertiesSection);
                } else {
                    return;
                }
            }

            // Update editor title bar with glyph name
            this.outlineEditor.updateEditorTitleBar();

            const nextContent = document.createElement('div');

            // Show unified master/layer list for both text and edit modes
            if (!this.outlineEditor.active) {
                // Text mode
                await this.displayMastersList(nextContent);
                this.propertiesSection.replaceChildren(
                    ...Array.from(nextContent.childNodes)
                );
                this.isUpdatingPropertiesUI = false;
                return;
            }

            // Edit mode
            if (
                this.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.textRunEditor!.selectedGlyphIndex <
                    this.textRunEditor!.shapedGlyphs.length
            ) {
                await this.displayMastersList(nextContent, false); // Build off-DOM first; select after mount
            } else {
                // No glyph selected
                const emptyMessage = document.createElement('div');
                emptyMessage.className = 'editor-empty-message';
                emptyMessage.textContent = 'No glyph selected';
                nextContent.appendChild(emptyMessage);
            }

            this.propertiesSection.replaceChildren(
                ...Array.from(nextContent.childNodes)
            );

            if (
                this.outlineEditor.active &&
                this.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.textRunEditor!.selectedGlyphIndex <
                    this.textRunEditor!.shapedGlyphs.length
            ) {
                if (options?.skipAutoSelectMatchingLayer) {
                    this.outlineEditor.updateLayerSelection();
                    return;
                }
                if (this.outlineEditor.draggingSomething) {
                    console.log(
                        '[DRAG-DEBUG] Skipping autoSelectMatchingLayer from updatePropertiesUI during drag'
                    );
                    return;
                }
                await this.outlineEditor.autoSelectMatchingLayer({
                    skipRender: true
                });
                if (
                    this.outlineEditor.active &&
                    this.textRunEditor!.selectedGlyphIndex >= 0
                ) {
                    this.render();
                    this.outlineEditor.performHitDetection(null);
                }
            }
        } finally {
            this.isUpdatingPropertiesUI = false;
            editorHealth.notePropertiesUpdateFinished();
        }
    }

    onTextChange(): void {
        // shapeText() already updated glyphNameBuffer from current editing-font shaping.

        // Calculate adaptive debounce delay based on typing speed
        const now = Date.now();
        const timeSinceLastKeystroke = now - this.textChangeLastKeystrokeTime;
        this.textChangeLastKeystrokeTime = now;

        // Determine if user is typing fast (burst) or slow
        // Fast typing = keystrokes within burst threshold
        const isBurstTyping =
            timeSinceLastKeystroke < this.textChangeBurstThreshold;
        const debounceDelay = isBurstTyping
            ? this.textChangeFastDelay
            : this.textChangeSlowDelay;

        // Debounce editing font recompilation with subset
        if (this.textChangeDebounceTimer) {
            clearTimeout(this.textChangeDebounceTimer);
        }

        // Cancel any pending deferred full compile — typing is still active
        if (this.textInputFullCompileTimer) {
            clearTimeout(this.textInputFullCompileTimer);
            this.textInputFullCompileTimer = null;
        }

        this.textChangeDebounceTimer = setTimeout(() => {
            if (fontManager && fontManager.currentFont) {
                const textBuffer = this.textRunEditor!.textBuffer;
                if (
                    !fontManager.needsEditingCompileForText(textBuffer) &&
                    Array.isArray(this.textRunEditor!.shapedGlyphs) &&
                    this.textRunEditor!.shapedGlyphs.length > 0
                ) {
                    return;
                }

                const subsetGlyphs =
                    fontManager.deriveSubsetGlyphsFromText(textBuffer);

                // Mark as text-input so the pipeline skips full JSON transfer
                // and skips features/kerning for faster compilation
                fontManager.setEditingCompileContext('text-input', null);

                fontManager
                    .compileEditingFont(
                        textBuffer,
                        [],
                        subsetGlyphs.length > 0 ? subsetGlyphs : undefined
                    )
                    .then(() => {
                        // Schedule a deferred full compile with features/kerning
                        // after typing settles, for correct OT rendering
                        this.scheduleTextInputFullCompile();
                    })
                    .catch((error: any) => {
                        console.error(
                            'Failed to recompile editing font:',
                            error
                        );
                    });
            }
        }, debounceDelay);
    }

    /**
     * Schedule a deferred full compile (with features/kerning) after typing stops.
     * Resets on each call, so rapid typing only triggers one full compile.
     */
    scheduleTextInputFullCompile(): void {
        if (this.textInputFullCompileTimer) {
            clearTimeout(this.textInputFullCompileTimer);
        }
        this.textInputFullCompileTimer = setTimeout(() => {
            this.textInputFullCompileTimer = null;
            if (
                fontManager &&
                fontManager.isReady() &&
                fontManager.lastCompilationMode !== 'full'
            ) {
                fontManager.clearEditingCompileContext();
                fontManager.currentFont?.markDirty('text-input-full-compile');
                window.autoCompileManager.checkAndSchedule();
            }
        }, 500);
    }

    /**
     * Zoom so the given printer-point size matches on-screen em height.
     * Locks the same caret/glyph focus point as Cmd/Ctrl +/−.
     */
    setScaleTowardFocus(targetScale: number): void {
        if (!this.viewportManager) {
            return;
        }

        const clamped = Math.min(
            MAX_VIEWPORT_SCALE,
            Math.max(MIN_VIEWPORT_SCALE, targetScale)
        );
        const currentScale = this.viewportManager.scale;
        if (!Number.isFinite(clamped) || clamped === currentScale) {
            return;
        }

        this.clearCmdZeroStage1();

        const rect = this.getCanvasContentFrame();
        const fontPos = this.getKeyboardResizeContentAnchorFontPosition();
        let centerX = viewportFrameCenterX(rect);
        let centerY = viewportFrameCenterY(rect);
        let lockFontPoint = false;

        if (fontPos) {
            const screenPoint = this.viewportManager.fontToScreenCoordinates(
                fontPos.x,
                fontPos.y
            );
            centerX = screenPoint.x;
            centerY = screenPoint.y;
            lockFontPoint = true;
        }

        const zoomFactor = clamped / currentScale;
        this.viewportManager.zoom(zoomFactor, centerX, centerY);
        if (lockFontPoint && fontPos) {
            applyFontPointScreenLock(
                this.viewportManager,
                { x: centerX, y: centerY },
                fontPos.x,
                fontPos.y,
                { lockY: true }
            );
        }

        this.render();
    }

    startKeyboardZoom(zoomIn: boolean): void {
        // Don't start a new animation if one is already in progress
        if (this.zoomAnimation.active) return;
        this.clearCmdZeroStage1();

        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        const zoomFactor = zoomIn
            ? settings.ZOOM_KEYBOARD_FACTOR
            : 1 / settings.ZOOM_KEYBOARD_FACTOR;

        const rect = this.getCanvasContentFrame();
        const fontPos = this.getKeyboardResizeContentAnchorFontPosition();
        let centerX = viewportFrameCenterX(rect);
        let centerY = viewportFrameCenterY(rect);
        let lockFontPoint = false;

        if (fontPos && this.viewportManager) {
            const screenPoint = this.viewportManager.fontToScreenCoordinates(
                fontPos.x,
                fontPos.y
            );
            centerX = screenPoint.x;
            centerY = screenPoint.y;
            lockFontPoint = true;
        }

        this.zoomAnimation.active = true;
        this.zoomAnimation.currentFrame = 0;
        this.zoomAnimation.totalFrames = 10;
        this.zoomAnimation.startScale = this.viewportManager!.scale;
        this.zoomAnimation.endScale = this.viewportManager!.scale * zoomFactor;
        this.zoomAnimation.centerX = centerX;
        this.zoomAnimation.centerY = centerY;
        this.zoomAnimation.fontX = fontPos?.x ?? 0;
        this.zoomAnimation.fontY = fontPos?.y ?? 0;
        this.zoomAnimation.lockFontPoint = lockFontPoint;

        this.animateKeyboardZoom();
    }

    animateKeyboardZoom(): void {
        if (!this.zoomAnimation.active) return;

        this.zoomAnimation.currentFrame++;

        const progress =
            this.zoomAnimation.currentFrame / this.zoomAnimation.totalFrames;
        const easedProgress =
            progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        const currentScale =
            this.zoomAnimation.startScale +
            (this.zoomAnimation.endScale - this.zoomAnimation.startScale) *
                easedProgress;

        const zoomFactor = currentScale / this.viewportManager!.scale;
        const screen = {
            x: this.zoomAnimation.centerX,
            y: this.zoomAnimation.centerY
        };
        this.viewportManager!.zoom(zoomFactor, screen.x, screen.y);
        if (this.zoomAnimation.lockFontPoint) {
            applyFontPointScreenLock(
                this.viewportManager!,
                screen,
                this.zoomAnimation.fontX,
                this.zoomAnimation.fontY,
                { lockY: true }
            );
        }

        this.render();

        if (this.zoomAnimation.currentFrame < this.zoomAnimation.totalFrames) {
            requestAnimationFrame(() => this.animateKeyboardZoom());
        } else {
            this.zoomAnimation.active = false;
        }
    }

    render(): void {
        if (this.shouldDeferCanvasPaint()) {
            this.hasDeferredRenderRequest = true;
            const deferReason = this.renderSuppressed
                ? 'renderSuppressed'
                : 'pendingIdleViewLock';
            timelineMark(
                this.renderSuppressed
                    ? 'canvas.render.deferredSuppressed'
                    : 'canvas.render.deferredIdleViewLock'
            );
            recordLiveTextDiagnostic(
                'canvas.render.deferred',
                this.textRunEditor,
                {
                    reason: deferReason,
                    viewport: {
                        panX: this.viewportManager?.panX ?? null,
                        panY: this.viewportManager?.panY ?? null,
                        scale: this.viewportManager?.scale ?? null
                    },
                    pendingIdleViewLock: this.hasPendingIdleViewLock(),
                    idleViewLockUsesBbox: this.idleViewLockUsesBbox,
                    idleViewLockUsesRightEdge: this.idleViewLockUsesRightEdge,
                    renderSuppressed: this.renderSuppressed
                }
            );
            return;
        }

        this.hasDeferredRenderRequest = false;
        if (this.pendingCanvasBackingStoreSync) {
            this.syncCanvasBackingStore();
        }
        this.featureChangeAnimator?.applyViewportAnchor(this.viewportManager);
        // Update glyph_stack label if it exists (development mode only, not in test mode)
        if (window.isDevelopment?.() && !window.isTestMode?.()) {
            // If we don't have a reference, try to find it in the DOM (in case it was created asynchronously)
            if (!this.glyphStackLabel) {
                this.glyphStackLabel = this.propertiesSection?.querySelector(
                    '.glyph-stack-debug'
                ) as HTMLElement | null;
            }

            if (this.glyphStackLabel) {
                this.glyphStackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            }
        }

        this.renderer!.render();
        const renderVerticalMetrics =
            this.outlineEditor.renderVerticalMetrics ?? {};
        const renderVerticalMetricEntries = Object.entries(
            renderVerticalMetrics
        );
        const lastRenderState =
            ((window as any).__glyphCanvasRenderState as
                { sequence?: number } | undefined) ?? undefined;
        const nextRenderState = {
            sequence: (lastRenderState?.sequence ?? 0) + 1,
            mode: this.outlineEditor.active ? 'edit' : 'text',
            selectedGlyphIndex: this.textRunEditor?.selectedGlyphIndex ?? -1,
            selectedLayerId: this.outlineEditor.selectedLayerId ?? null,
            glyphStack: this.outlineEditor.glyphStack || '',
            hasLayerData: Boolean(this.outlineEditor.layerData),
            isInterpolated: Boolean(
                this.outlineEditor.layerData?.isInterpolated
            ),
            isPreviewMode: this.outlineEditor.isPreviewMode,
            hasRenderVerticalMetrics: renderVerticalMetricEntries.length > 0,
            renderVerticalMetricCount: renderVerticalMetricEntries.length,
            renderVerticalMetrics
        };
        (window as any).__glyphCanvasRenderState = nextRenderState;
        recordLiveTextDiagnostic('canvas.render', this.textRunEditor, {
            render: nextRenderState,
            viewport: {
                panX: this.viewportManager?.panX ?? null,
                panY: this.viewportManager?.panY ?? null,
                scale: this.viewportManager?.scale ?? null
            },
            pendingIdleViewLock: this.hasPendingIdleViewLock(),
            idleViewLockUsesBbox: this.idleViewLockUsesBbox,
            idleViewLockUsesRightEdge: this.idleViewLockUsesRightEdge,
            renderSuppressed: this.renderSuppressed
        });
        window.dispatchEvent(
            new CustomEvent('glyphCanvasRendered', {
                detail: nextRenderState
            })
        );
        timelineMark('canvas.render.completed');
    }

    requestRepaintAfterCompile(): void {
        this.hasDeferredRenderRequest = true;
        timelineMark('canvas.compileRepaint.requested');
        recordLiveTextDiagnostic(
            'canvas.compileRepaint.requested',
            this.textRunEditor
        );

        let attempts = 0;
        const maxAttempts = 180;

        const tryRepaint = () => {
            if (!this.hasDeferredRenderRequest) {
                return;
            }

            if (this.shouldDeferCanvasPaint()) {
                attempts += 1;
                timelineMark(
                    this.renderSuppressed
                        ? 'canvas.compileRepaint.waitingForUnsuppress'
                        : 'canvas.compileRepaint.waitingForIdleViewLock'
                );
                if (attempts >= maxAttempts) {
                    timelineMark('canvas.compileRepaint.timeout');
                    this.releaseDeferredPaintAfterFailedCompile();
                    this.render();
                    return;
                }

                requestAnimationFrame(tryRepaint);
                return;
            }

            timelineMark('canvas.compileRepaint.executingRender');
            recordLiveTextDiagnostic(
                'canvas.compileRepaint.executingRender',
                this.textRunEditor
            );
            this.render();
            if (this.outlineEditor.active) {
                this.outlineEditor.performHitDetection(null);
            }
            timelineMark('canvas.compileRepaint.completed');
        };

        requestAnimationFrame(tryRepaint);
    }

    destroy(): void {
        this.featureChangeAnimator?.cancel();
        window.removeEventListener(
            'layerFingerprintChanged',
            this.handleLayerFingerprintChanged
        );
        window.removeEventListener('fontModelSync', this.handleFontModelSync);
        window.removeEventListener(
            'editorPreviewAreaChanged',
            this.handlePreviewAreaChanged
        );

        this.clearTextModeKerningLivePreview({ cancelCommit: true });
        this.textModeKerningPreviewFunnel.reset();

        // Clear any pending blur timeout
        if (this.blurTimeoutId) {
            clearTimeout(this.blurTimeoutId);
            this.blurTimeoutId = null;
        }

        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.propertyPanelClassObserver) {
            this.propertyPanelClassObserver.disconnect();
            this.propertyPanelClassObserver = null;
        }

        // Clean up HarfBuzz resources
        this.textRunEditor!.destroyHarfbuzz();

        // Remove canvas
        document.body.classList.remove(
            'has-full-window-glyph-canvas',
            'preview-mode-chrome',
            'preview-area-small',
            'preview-area-medium',
            'preview-area-full'
        );
        document.documentElement.style.removeProperty(
            '--preview-chrome-opacity'
        );

        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }

        if (this.propertyPanel && this.propertyPanel.parentNode) {
            this.propertyPanel.parentNode.removeChild(this.propertyPanel);
        }
    }

    // ==================== Cursor Methods ====================

    onFocus(): void {
        // Cancel any pending blur timeout to prevent flicker
        if (this.blurTimeoutId) {
            clearTimeout(this.blurTimeoutId);
            this.blurTimeoutId = null;
        }
        this.isFocused = true;
        this.cursorVisible = true;
        // Don't render on focus change if in preview mode (no cursor visible)
        if (!this.outlineEditor.isPreviewMode) {
            this.render();
        }
    }

    onBlur(): void {
        // Delay blur to prevent cursor flicker when clicking sidebar elements
        // Focus is typically restored within a few ms, so 100ms is plenty
        this.blurTimeoutId = setTimeout(() => {
            this.blurTimeoutId = null;
            this.isFocused = false;
            // Don't render on blur if in preview mode (no cursor visible)
            if (!this.outlineEditor.isPreviewMode) {
                this.render();
            }
        }, 100);
    }

    onKeyDown(e: KeyboardEvent): void {
        if (this.mouseUpFinalization) {
            e.preventDefault();
            const finalization = this.mouseUpFinalization;
            void finalization.then(() => {
                if (this.mouseUpFinalization !== null) {
                    return;
                }
                this.onKeyDown(e);
            });
            return;
        }

        // Handle Cmd+Plus/Minus for zoom in/out
        if (
            (e.metaKey || e.ctrlKey) &&
            (e.key === '=' || e.key === '+' || e.key === '-')
        ) {
            e.preventDefault();
            const zoomIn = e.key === '=' || e.key === '+';
            this.startKeyboardZoom(zoomIn);
            return;
        }

        // Handle Cmd+Up/Down to cycle through masters in text mode
        if (
            (e.metaKey || e.ctrlKey) &&
            !this.outlineEditor.active &&
            (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
            e.preventDefault();
            this.cycleMasters(e.key === 'ArrowUp');
            return;
        }

        if (
            !this.outlineEditor.active &&
            e.altKey &&
            (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        ) {
            e.preventDefault();
            const magnitude =
                e.metaKey || e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
            const delta = e.key === 'ArrowLeft' ? -magnitude : magnitude;
            void this.nudgeTextModeKerningValue(delta);
            return;
        }

        // Handle arrow keys and spacebar in outline editor.
        // onKeyDown is async and not awaited: tool shortcuts such as T may
        // exit edit mode synchronously before the first await yields, so
        // remember whether we started in edit mode for this keystroke.
        const wasInEditMode = this.outlineEditor.active;
        this.outlineEditor.onKeyDown(e);

        // Handle Cmd+Enter to enter glyph edit mode at cursor position (text editing mode only)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.key === 'Enter' &&
            !this.outlineEditor.active
        ) {
            e.preventDefault();
            this.enterGlyphEditModeAtCursor();
            return;
        }

        // Handle cursor navigation and text editing
        // Note: Escape key is handled globally in constructor for better focus handling

        // Cmd+0 / Ctrl+0 — two-stage zoom-to-fit
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault();
            this.handleCmdZeroFit();
            return;
        }

        // In glyph edit mode: only prevent default for keys we handle
        // Let browser shortcuts (Cmd+R, Cmd+T, Cmd+W, etc.) pass through
        if (this.outlineEditor.active) {
            // Only prevent default for non-modifier keys and arrow keys that we handle
            if (!e.metaKey && !e.ctrlKey) {
                e.preventDefault();
            }
            return;
        }

        // Edit-mode shortcuts (e.g. T → text) preventDefault and exit before
        // the async outline handler resumes; do not also insert that key.
        if (wasInEditMode && e.defaultPrevented) {
            return;
        }

        // Text run selection and editing shortcuts
        this.textRunEditor!.handleKeyDown(e);
    }

    getClickedCursorPosition(
        e: MouseEvent,
        options: {
            ignoreVerticalBounds?: boolean;
        } = {}
    ): number | null {
        // Convert click position to cursor position
        const rect = this.canvas!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        const { x: glyphX, y: glyphY } =
            this.viewportManager!.getFontSpaceCoordinates(mouseX, mouseY);

        // Vertical band gates caret placement / selection start. Drag updates
        // may ignore it so the selection can keep growing when the pointer
        // leaves the line. Horizontal position is unbounded: far left/right
        // snaps to the run ends.
        if (
            !options.ignoreVerticalBounds &&
            !this.isFontYInTextInteractionBand(glyphY)
        ) {
            return null;
        }
        return this.textRunEditor!.getGlyphIndexAtClick(glyphX, glyphY);
    }

    private isFontYInTextInteractionBand(glyphY: number): boolean {
        const textRun = this.textRunEditor;
        const lineCount = textRun?.getLineCount?.() ?? 1;
        const usedLineHeight = textRun?.getUsedLineHeight?.() ?? 0;
        for (let i = 0; i < Math.max(1, lineCount); i++) {
            const baseline = lineBaselineY(i, usedLineHeight);
            if (
                glyphY <= baseline + TEXT_INTERACTION_Y_MAX &&
                glyphY >= baseline + TEXT_INTERACTION_Y_MIN
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * True when the pointer (or given canvas-local coords) sits in the text
     * interaction band used for caret / selection / I-beam cursor.
     */
    private isPointerInTextInteractionBand(
        canvasX: number = this.mouseX,
        canvasY: number = this.mouseY
    ): boolean {
        if (!this.viewportManager) {
            return false;
        }
        const { y: glyphY } = this.viewportManager.getFontSpaceCoordinates(
            canvasX,
            canvasY
        );
        return this.isFontYInTextInteractionBand(glyphY);
    }

    private boundTextSelectionMouseMove = (e: MouseEvent): void => {
        this.updateTextSelectionDrag(e);
    };

    private boundTextSelectionMouseUp = (_e: MouseEvent): void => {
        this.endTextSelectionDrag();
        this.updateCursorStyle();
        this.render();
    };

    private startTextSelectionDrag(
        position: number,
        extendExisting: boolean
    ): void {
        this.isSelectingText = true;
        this.textRunEditor!.beginMouseSelection(position, extendExisting);
        document.addEventListener(
            'mousemove',
            this.boundTextSelectionMouseMove
        );
        document.addEventListener('mouseup', this.boundTextSelectionMouseUp);
    }

    private updateTextSelectionDrag(e: MouseEvent): void {
        if (!this.isSelectingText || !this.textRunEditor) {
            return;
        }

        const position = this.getClickedCursorPosition(e, {
            ignoreVerticalBounds: true
        });
        if (position === null) {
            return;
        }

        this.textRunEditor.extendMouseSelection(position);
        this.canvas!.style.cursor = 'text';
        this.render();
    }

    private endTextSelectionDrag(): void {
        if (!this.isSelectingText) {
            return;
        }
        this.isSelectingText = false;
        document.removeEventListener(
            'mousemove',
            this.boundTextSelectionMouseMove
        );
        document.removeEventListener('mouseup', this.boundTextSelectionMouseUp);
        this.textRunEditor?.finishMouseSelection();
    }

    isCursorVisible(
        leftMargin: number = CURSOR_VIEW_MARGIN,
        rightMargin: number = CURSOR_VIEW_MARGIN,
        topMargin: number = CURSOR_VIEW_MARGIN,
        bottomMargin: number = CURSOR_VIEW_MARGIN
    ): boolean {
        const rect = this.getCanvasContentFrame();
        const screen = this.viewportManager!.fontToScreenCoordinates(
            this.textRunEditor!.cursorX,
            this.textRunEditor!.cursorY || 0
        );

        return (
            screen.x >= rect.left + leftMargin &&
            screen.x <= viewportFrameRight(rect) - rightMargin &&
            screen.y >= rect.top + topMargin &&
            screen.y <= viewportFrameBottom(rect) - bottomMargin
        );
    }

    /**
     * Combined advance of up to `count` shaped glyphs immediately on one
     * visual side of the caret.
     */
    getGlyphAdvancesAdjacentToCursor(
        side: 'left' | 'right',
        count: number
    ): number {
        const editor = this.textRunEditor;
        if (!editor?.clusterMap?.length || !editor.shapedGlyphs?.length) {
            return 0;
        }

        const spans: { x: number; width: number }[] = [];
        for (const cluster of editor.clusterMap as TextRunClusterInfo[]) {
            let glyphX = cluster.x;
            for (let i = 0; i < cluster.glyphCount; i++) {
                const glyph = editor.shapedGlyphs[cluster.glyphIndex + i];
                const width = glyph?.ax || 0;
                spans.push({ x: glyphX, width });
                glyphX += width;
            }
        }

        const cursorX = editor.cursorX;
        const epsilon = 0.5;
        const adjacent =
            side === 'left'
                ? spans.filter(
                      (span) => span.x + span.width <= cursorX + epsilon
                  )
                : spans.filter((span) => span.x >= cursorX - epsilon);
        adjacent.sort((a, b) => a.x - b.x);
        const picked =
            side === 'left' ? adjacent.slice(-count) : adjacent.slice(0, count);
        return picked.reduce((sum, span) => sum + span.width, 0);
    }

    panToCursor(fromBackspace: boolean = false): void {
        // Pan viewport to show cursor with smooth animation
        // Never pan to cursor in edit mode — the cursor position tracks the
        // selected glyph's text-run position and has no relation to what the
        // user is focusing on during outline editing. Spurious pans happen when
        // shapeText dispatches cursormoved after a compile completes post-edit.
        if (this.outlineEditor.active) {
            return;
        }

        const rect = this.getCanvasContentFrame();
        const scale = this.viewportManager!.scale;
        let leftMargin = CURSOR_VIEW_MARGIN;
        let rightMargin = CURSOR_VIEW_MARGIN;

        if (fromBackspace) {
            const maxSafe = rect.width * BACKSPACE_SAFE_VIEWPORT_FRACTION;
            leftMargin = Math.max(
                CURSOR_VIEW_MARGIN,
                Math.min(
                    this.getGlyphAdvancesAdjacentToCursor(
                        'left',
                        BACKSPACE_PRECEDING_GLYPH_COUNT
                    ) * scale,
                    maxSafe
                )
            );
            rightMargin = Math.max(
                CURSOR_VIEW_MARGIN,
                Math.min(
                    this.getGlyphAdvancesAdjacentToCursor(
                        'right',
                        BACKSPACE_PRECEDING_GLYPH_COUNT
                    ) * scale,
                    maxSafe
                )
            );
        }

        if (this.isCursorVisible(leftMargin, rightMargin)) {
            return;
        }

        const screen = this.viewportManager!.fontToScreenCoordinates(
            this.textRunEditor!.cursorX,
            this.textRunEditor!.cursorY || 0
        );
        const topMargin = CURSOR_VIEW_MARGIN;
        const bottomMargin = CURSOR_VIEW_MARGIN;
        let targetPanX = this.viewportManager!.panX;
        let targetPanY = this.viewportManager!.panY;

        if (screen.x < rect.left + leftMargin) {
            targetPanX += rect.left + leftMargin - screen.x;
        } else if (screen.x > viewportFrameRight(rect) - rightMargin) {
            targetPanX += viewportFrameRight(rect) - rightMargin - screen.x;
        }

        if (screen.y < rect.top + topMargin) {
            targetPanY += rect.top + topMargin - screen.y;
        } else if (screen.y > viewportFrameBottom(rect) - bottomMargin) {
            targetPanY += viewportFrameBottom(rect) - bottomMargin - screen.y;
        }

        this.viewportManager!.animatePan(
            targetPanX,
            targetPanY,
            this.render.bind(this)
        );
    }

    /**
     * Font-space lock point for text-mode cursor auto-pan and OT feature
     * clips. Edit-mode feature clips use the selected glyph origin (not
     * outline bbox center — that is layer-switch / interpolation).
     */
    private getViewportAnchorFontPosition(): { x: number; y: number } {
        const textRun = this.textRunEditor;
        if (
            this.outlineEditor.active &&
            textRun &&
            textRun.selectedGlyphIndex >= 0
        ) {
            const position = textRun._getGlyphPosition(
                textRun.selectedGlyphIndex
            );
            return {
                x: position.xPosition + position.xOffset,
                y: position.yOffset
            };
        }
        return { x: textRun?.cursorX ?? 0, y: 0 };
    }

    private cancelFeatureChangeAnimation(): void {
        if (!this.featureChangeAnimator?.isActive()) {
            return;
        }
        this.featureChangeAnimator.applyViewportAnchor(this.viewportManager, 1);
        this.featureChangeAnimator.cancel();
    }

    captureTextModeAutoPanAnchor(): void {
        if (!this.textRunEditor || !this.viewportManager) {
            this.textModeAutoPanAnchorScreen = null;
            return;
        }

        this.textModeAutoPanAnchorScreen =
            this.viewportManager.fontToScreenCoordinates(
                this.textRunEditor.cursorX,
                0
            );
    }

    applyTextModeAutoPanAdjustment(): void {
        if (
            !this.textModeAutoPanAnchorScreen ||
            !this.textRunEditor ||
            !this.viewportManager
        ) {
            return;
        }

        applyFontPointScreenLock(
            this.viewportManager,
            this.textModeAutoPanAnchorScreen,
            this.textRunEditor.cursorX,
            0
        );
    }

    /** Visual font-space X of a cluster's first glyph (advance pen + dx). */
    private getTextModeClusterVisualFontX(cluster: TextRunClusterInfo): number {
        const glyph =
            this.textRunEditor?.shapedGlyphs?.[cluster.glyphIndex] ?? null;
        return cluster.x + (glyph?.dx || 0);
    }

    /** Anchored pair glyph visual X (firstCluster — left in LTR, right in RTL). */
    getTextModeKerningPanAnchorFontX(): number | null {
        const context = this.getCurrentTextModeKerningContext();
        if (context.status === 'ready' && context.firstCluster) {
            return this.getTextModeClusterVisualFontX(context.firstCluster);
        }
        return null;
    }

    captureTextModeKerningPanAnchor(): void {
        const context = this.getCurrentTextModeKerningContext();
        if (
            !this.viewportManager ||
            context.status !== 'ready' ||
            !context.firstCluster
        ) {
            this.textModeKerningPanAnchor = null;
            return;
        }

        const fontX = this.getTextModeClusterVisualFontX(context.firstCluster);
        this.textModeKerningPanAnchor = {
            screenX: this.viewportManager.fontToScreenCoordinates(fontX, 0).x,
            clusterStart: context.firstCluster.start
        };
    }

    applyTextModeKerningPanAdjustment(): void {
        const anchor = this.textModeKerningPanAnchor;
        if (!anchor || !this.viewportManager) {
            return;
        }

        const cluster = (
            this.textRunEditor?.clusterMap as TextRunClusterInfo[] | undefined
        )?.find((entry) => entry.start === anchor.clusterStart);
        if (!cluster) {
            return;
        }

        applyFontPointScreenLock(
            this.viewportManager,
            { x: anchor.screenX, y: 0 },
            this.getTextModeClusterVisualFontX(cluster),
            0
        );
    }

    clearTextModeKerningPanAnchor(): void {
        this.textModeKerningPanAnchor = null;
    }

    /**
     * RTL live-preview caret: ride the moving left side (second right edge −
     * delta). LTR uses the default between-glyph edge.
     */
    getTextModeKerningCursorFontX(): number | null {
        if (this.outlineEditor?.active || !this.textRunEditor) {
            return null;
        }

        const context = this.getCurrentTextModeKerningContext();
        const pending = this.pendingTextModeKerningPreview;
        if (
            context.status !== 'ready' ||
            !context.isRTL ||
            !context.secondCluster ||
            !pending?.isRTL ||
            pending.masterId !== context.master?.id ||
            pending.firstKey !== context.selectedFirstKey ||
            pending.secondKey !== context.selectedSecondKey
        ) {
            return null;
        }

        const secondVisualEdge =
            context.secondCluster.x + context.secondCluster.width;
        const delta = (pending.previewValue ?? 0) - pending.baselineValue;
        return secondVisualEdge - delta;
    }

    /**
     * Frame the current text run (or the caret when the buffer is empty).
     * Used after startup URL restore and for Cmd+0 in text mode.
     */
    fitViewportToCurrentText(
        onComplete?: () => void,
        scaleLimits?: { min: number; max: number }
    ): number | undefined {
        if (!this.canvas || !this.viewportManager || !this.textRunEditor) {
            onComplete?.();
            return;
        }

        const rect = this.getCanvasContentFrame();
        if (rect.width <= 0 || rect.height <= 0) {
            onComplete?.();
            return;
        }

        const band = this.getTextModeVerticalMetricsBand();
        const extraLines = Math.max(
            0,
            (this.textRunEditor.getLineCount?.() ?? 1) - 1
        );
        const usedLineHeight = this.textRunEditor.getUsedLineHeight?.() ?? 0;
        const verticalBounds = {
            minY: band.lowest - extraLines * usedLineHeight,
            maxY: band.highest
        };
        const glyphs = this.textRunEditor.shapedGlyphs;
        if (glyphs && glyphs.length > 0) {
            return this.viewportManager.zoomToFitText(
                glyphs,
                rect,
                this.render.bind(this),
                null,
                onComplete,
                verticalBounds,
                scaleLimits
            );
        }

        return this.viewportManager.zoomToFitCursor(
            this.textRunEditor.cursorX || 0,
            rect,
            this.render.bind(this),
            verticalBounds,
            null,
            onComplete,
            scaleLimits
        );
    }

    /**
     * After URL/state restore has applied the real text buffer, zoom to fit
     * that rendered run. Empty text centers the caret instead.
     */
    applyInitialViewportFit(): Promise<void> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                const snapshot = this.snapshotCurrentViewport();
                if (snapshot) {
                    this.lastStableViewportSnapshot = snapshot;
                }
                resolve();
            };
            this.textRunEditor?.updateCursorVisualPosition();
            const zoom = this.fitViewportToCurrentText(finish);
            if (zoom === undefined) {
                finish();
            }
        });
    }

    resetZoomAndPosition(): void {
        this.fitViewportToCurrentText();
    }

    toGlyphLocal(x: number, y: number): { glyphX: number; glyphY: number } {
        return this.viewportManager!.getGlyphLocalCoordinates(
            x,
            y,
            this.textRunEditor!.shapedGlyphs,
            this.textRunEditor!.selectedGlyphIndex
        );
    }
}

function initCanvas() {
    const editorContent = document.querySelector('#view-editor .view-content');
    if (editorContent) {
        // Create main container with flexbox layout
        const mainContainer = document.createElement('div');
        mainContainer.style.display = 'flex';
        mainContainer.style.width = '100%';
        mainContainer.style.height = '100%';
        mainContainer.style.overflow = 'hidden';

        // Create left sidebar for glyph properties
        const leftSidebar = document.createElement('div');
        leftSidebar.id = 'glyph-properties-sidebar';
        leftSidebar.className = 'view-sidebar view-sidebar-left';

        // Create right sidebar for axes
        const rightSidebar = document.createElement('div');
        rightSidebar.id = 'glyph-editor-sidebar';
        rightSidebar.className = 'view-sidebar view-sidebar-right';

        const rightSidebarScrollContent = document.createElement('div');
        rightSidebarScrollContent.id = 'glyph-editor-scroll-content';
        rightSidebar.appendChild(rightSidebarScrollContent);

        // Create canvas container
        const canvasContainer = document.createElement('div');
        canvasContainer.id = 'glyph-canvas-container';
        canvasContainer.style.flex = '1';
        canvasContainer.style.height = '100%';
        canvasContainer.style.position = 'relative';

        // Assemble layout (left sidebar, canvas, right sidebar)
        mainContainer.appendChild(leftSidebar);
        mainContainer.appendChild(canvasContainer);
        mainContainer.appendChild(rightSidebar);
        editorContent.appendChild(mainContainer);

        const responsiveEditorView = document.getElementById('view-editor');
        if (responsiveEditorView) {
            attachTopRowSidebarInterpolation(responsiveEditorView);
        }

        // Initialize canvas
        window.glyphCanvas = new GlyphCanvas('glyph-canvas-container');

        // Create glyph properties container (initially empty)
        const propertiesSection = document.createElement('div');
        propertiesSection.id = 'glyph-properties-section';
        leftSidebar.appendChild(propertiesSection);

        // Text layout controls in the Editor title bar (left of tools)
        textLayoutControls.createSection();

        // Create variable axes container (initially empty)
        const axesSection = window.glyphCanvas.axesManager!.createAxesSection();
        rightSidebarScrollContent.appendChild(axesSection);

        // Create OpenType features container (initially empty)
        const featuresSection =
            window.glyphCanvas.featuresManager!.createFeaturesSection();
        rightSidebarScrollContent.appendChild(featuresSection);

        // Store reference to sidebars for later updates
        window.glyphCanvas.leftSidebar = leftSidebar;
        window.glyphCanvas.propertiesSection = propertiesSection;
        window.glyphCanvas.rightSidebar = rightSidebar;
        window.glyphCanvas.axesSection = axesSection;

        // Observe when the editor view gains/loses focus (via 'focused' class)
        // CSS handles sidebar background color changes based on .view.focused
        const editorView = document.querySelector('#view-editor');
        if (editorView) {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (
                        mutation.type === 'attributes' &&
                        mutation.attributeName === 'class'
                    ) {
                        // Render when focused class changes
                        window.glyphCanvas.render();
                    }
                });
            });
            observer.observe(editorView, {
                attributes: true,
                attributeFilter: ['class']
            });
        }

        // Listen for font compilation events
        setupFontLoadingListener();

        // Set up editor shortcuts modal
        setupEditorShortcutsModal();

        console.log('Glyph canvas initialized');
    } else {
        setTimeout(initCanvas, 100);
    }
}

if (typeof document !== 'undefined' && document.addEventListener) {
    const startInitCanvas = () => {
        initCanvas();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startInitCanvas);
    } else {
        startInitCanvas();
    }
}

window.addEventListener(
    'fontOpenLifecycle',
    syncLatestOpenSessionIdFromLifecycle
);
window.addEventListener('fontReady', syncLatestOpenSessionId);

// Event handlers stored to prevent duplicate listeners
let editingFontCompiledHandler: ((e: Event) => void) | null = null;
let fontCompiledHandler: ((e: Event) => void) | null = null;
let editingFontApplyQueue: Promise<void> = Promise.resolve();
let latestAppliedEditingRevision: number = -1;

function adoptOwnedFontBytes(bytes: Uint8Array): Uint8Array {
    if (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes;
    }
    return bytes.slice();
}

function arrayBufferFromOwnedBytes(bytes: Uint8Array): ArrayBuffer {
    if (bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

function clearStuckIdleViewLock(): void {
    window.glyphCanvas?.releaseDeferredPaintAfterFailedCompile?.();
}

// Set up listener for compiled fonts
function setupFontLoadingListener() {
    console.log('🔧 Setting up font loading listeners...');

    // Remove any existing listeners to prevent duplicates
    if (editingFontCompiledHandler) {
        window.removeEventListener(
            'editingFontCompiled',
            editingFontCompiledHandler
        );
    }
    if (fontCompiledHandler) {
        window.removeEventListener('fontCompiled', fontCompiledHandler);
    }

    // Listen for editing font compiled by font manager (primary)
    editingFontCompiledHandler = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        let deferredCommittedSidebearingRender = false;
        let deferredIdleViewLock = false;
        timelineMark('canvas.editingFontCompiled.received');
        editingFontApplyQueue = editingFontApplyQueue
            .then(async () => {
                const currentFontPath = window.fontManager?.currentFont?.path;
                if (
                    typeof detail?.fontPath === 'string' &&
                    typeof currentFontPath === 'string' &&
                    detail.fontPath !== currentFontPath
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedMismatchedFontPath'
                    );
                    clearStuckIdleViewLock();
                    return;
                }

                const incomingRevision = Number(detail?.fontRevisionKey);
                const latestRequestedRevision = Number(
                    window.fontManager?.currentFont?.compileRequestVersion
                );
                const isLivePreview =
                    detail?.dataFreshnessMode === 'live-drag-worker-preview';
                if (
                    !isLivePreview &&
                    Number.isFinite(incomingRevision) &&
                    Number.isFinite(latestRequestedRevision) &&
                    incomingRevision < latestRequestedRevision
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedSupersededRevision'
                    );
                    clearStuckIdleViewLock();
                    return;
                }

                if (
                    Number.isFinite(incomingRevision) &&
                    incomingRevision < latestAppliedEditingRevision
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedOutOfOrderRevision'
                    );
                    clearStuckIdleViewLock();
                    return;
                }

                console.log(
                    '[GlyphCanvas]',
                    'Editing font compiled event received'
                );
                console.log('[GlyphCanvas]', '   Event detail:', detail);
                console.log(
                    '[GlyphCanvas]',
                    '   Canvas exists:',
                    !!window.glyphCanvas
                );
                if (window.glyphCanvas && detail && detail.fontBytes) {
                    console.log(
                        '[GlyphCanvas]',
                        '   Loading editing font into canvas...'
                    );
                    const isDragActive = !!detail.dragActive;
                    const compilationMode = detail.compilationMode || 'full';
                    const fontBytesArray = adoptOwnedFontBytes(
                        detail.fontBytes
                    );
                    const arrayBuffer =
                        arrayBufferFromOwnedBytes(fontBytesArray);

                    const gc = window.glyphCanvas;
                    const isSidebearingSession =
                        isLivePreview &&
                        gc.outlineEditor.isLiveSidebearingInteractionActive();
                    deferredCommittedSidebearingRender =
                        !isLivePreview &&
                        !gc.hasPendingIdleViewLock() &&
                        gc.outlineEditor.hasPendingSidebearingBboxCenterAnchor();
                    deferredIdleViewLock =
                        !isLivePreview && gc.hasPendingIdleViewLock();

                    // Live outline previews skip reshaping: the preview font
                    // omits features/kerning for speed, so a reshape would
                    // jump the canvas wherever kerning precedes the active
                    // glyphs. Local preview-backed outline/component/anchor
                    // commits now stamp editType null and compile as full, so
                    // they do not take this incomplete authoritative path.
                    // Remote/inferred outline-only packets may still reshape
                    // here; that path must not become the local commit contract.
                    if (compilationMode === 'outline-only') {
                        gc.fontBytes = fontBytesArray;
                        gc.axesManager!.fontBytes = fontBytesArray;
                        gc.textRunEditor!.swapFontBlob(fontBytesArray);
                        if (
                            detail?.dataFreshnessMode ===
                            'authoritative-worker-yjs'
                        ) {
                            gc.textRunEditor!.shapeText(true);
                            timelineMark(
                                'canvas.editingFontCompiled.outlineOnlyCommittedShaped'
                            );
                        }
                        timelineMark(
                            isLivePreview
                                ? isSidebearingSession
                                    ? 'canvas.editingFontCompiled.outlineOnlySwappedSidebearing'
                                    : 'canvas.editingFontCompiled.outlineOnlySwappedLive'
                                : 'canvas.editingFontCompiled.outlineOnlySwapped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        if (isSidebearingSession) {
                            // Keep live-patched advances; do not reshape or
                            // race the interaction frame with an independent
                            // compile repaint. Re-anchor keyboard sessions
                            // after the blob swap before one owned paint.
                            gc.outlineEditor.reapplyLastLiveSidebearingAdvances();
                            gc.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor();
                            gc.outlineEditor.scheduleSidebearingOwnedRepaint();
                        } else {
                            if (deferredIdleViewLock) {
                                gc.consumeIdleViewLockAfterReshape();
                            }
                            gc.requestRepaintAfterCompile();
                        }
                        return;
                    }

                    // Anchor-only compilation — swap blob + reshape for GPOS mark positions
                    if (compilationMode === 'anchor-only') {
                        gc.fontBytes = fontBytesArray;
                        gc.axesManager!.fontBytes = fontBytesArray;
                        gc.textRunEditor!.swapFontBlob(fontBytesArray);
                        gc.textRunEditor!.shapeText(true);
                        timelineMark(
                            'canvas.editingFontCompiled.anchorOnlySwapped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        if (deferredIdleViewLock) {
                            gc.consumeIdleViewLockAfterReshape();
                        }
                        gc.requestRepaintAfterCompile();
                        return;
                    }

                    if (compilationMode === 'kerning-only') {
                        if (!deferredIdleViewLock) {
                            gc.captureTextModeKerningPanAnchor();
                        }
                        gc.textRunEditor!.setShapingFontBlob(fontBytesArray);
                        gc.textRunEditor!.shapeText(true);
                        gc.reapplyTextModeKerningLivePreviewAfterReshape();
                        if (deferredIdleViewLock) {
                            gc.consumeIdleViewLockAfterReshape();
                        } else {
                            gc.applyTextModeKerningPanAdjustment();
                            gc.clearTextModeKerningPanAnchor();
                        }
                        timelineMark(
                            'canvas.editingFontCompiled.kerningOnlyShaped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        gc.requestRepaintAfterCompile();
                        return;
                    }

                    // Full compilation path — existing behavior
                    if (gc.featuresManager) {
                        gc.featuresManager.editingFontBytes = detail.fontBytes;
                        if (!isDragActive) {
                            const featuresUiSpanId = timelineSpanStart(
                                'canvas.editingFontCompiled.updateFeaturesUI'
                            );
                            await gc.featuresManager.updateFeaturesUI();
                            timelineSpanEnd(featuresUiSpanId);
                        }
                    }

                    if (
                        deferredCommittedSidebearingRender ||
                        deferredIdleViewLock
                    ) {
                        gc.renderSuppressed = true;
                        timelineMark(
                            'canvas.editingFontCompiled.committedSidebearingRenderDeferred'
                        );
                    }

                    const setFontSpanId = timelineSpanStart(
                        'canvas.editingFontCompiled.setFont'
                    );
                    await window.glyphCanvas.setFont(arrayBuffer, {
                        skipInitialShapeRender: true,
                        // The deferred sidebearing path owns the one final
                        // anchored render after recomposition. Updating the
                        // properties UI here would render after setFont's
                        // first shape and before that final render.
                        skipPropertiesUIUpdate:
                            isDragActive ||
                            deferredCommittedSidebearingRender ||
                            deferredIdleViewLock
                    });
                    timelineSpanEnd(setFontSpanId);
                    timelineMark('canvas.editingFontCompiled.fontApplied');
                    console.log(
                        '[GlyphCanvas]',
                        '   ✅ Editing font loaded and text shaped'
                    );

                    const forceShapeTextSpanId = timelineSpanStart(
                        'canvas.editingFontCompiled.forceShapeText'
                    );
                    if (
                        gc.pendingTextModeKerningCursorAnchor &&
                        !deferredIdleViewLock
                    ) {
                        gc.captureTextModeKerningPanAnchor();
                    }
                    gc.textRunEditor!.shapeText(true);
                    gc.reapplyTextModeKerningLivePreviewAfterReshape();
                    if (deferredIdleViewLock) {
                        gc.reapplyIdleViewLock();
                        gc.pendingTextModeKerningCursorAnchor = false;
                    } else if (gc.pendingTextModeKerningCursorAnchor) {
                        gc.applyTextModeKerningPanAdjustment();
                        gc.clearTextModeKerningPanAnchor();
                        gc.pendingTextModeKerningCursorAnchor = false;
                    }
                    timelineSpanEnd(forceShapeTextSpanId);

                    timelineMark('canvas.editingFontCompiled.shapeTextForced');

                    if (Number.isFinite(incomingRevision)) {
                        latestAppliedEditingRevision = incomingRevision;
                    }

                    if (
                        deferredCommittedSidebearingRender ||
                        deferredIdleViewLock
                    ) {
                        gc.renderSuppressed = false;
                        if (deferredCommittedSidebearingRender) {
                            gc.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor();
                        }
                        if (deferredIdleViewLock) {
                            gc.consumeIdleViewLockAfterReshape();
                        }
                        await gc.updatePropertiesUI({
                            skipAutoSelectMatchingLayer: true
                        });
                        gc.render();
                        if (deferredCommittedSidebearingRender) {
                            gc.outlineEditor.clearPendingSidebearingBboxCenterAnchor();
                        }
                        timelineMark(
                            'canvas.editingFontCompiled.committedSidebearingRenderCompleted'
                        );
                    } else {
                        gc.requestRepaintAfterCompile();
                    }
                    if (!isSidebearingSession && gc.hasPendingIdleViewLock()) {
                        gc.consumeIdleViewLockAfterReshape();
                    }
                    gc.renderSuppressed = false;
                } else {
                    console.warn(
                        '[GlyphCanvas]',
                        '   ⚠️ Cannot load font - missing canvas or fontBytes'
                    );
                    timelineMark(
                        'canvas.editingFontCompiled.skippedMissingData'
                    );
                    clearStuckIdleViewLock();
                }
            })
            .catch((error) => {
                const gc = window.glyphCanvas;
                if (deferredCommittedSidebearingRender && gc) {
                    gc.renderSuppressed = false;
                    gc.outlineEditor.clearPendingSidebearingBboxCenterAnchor();
                }
                if (deferredIdleViewLock && gc) {
                    gc.renderSuppressed = false;
                    gc.clearIdleViewLock();
                } else if (gc?.hasPendingIdleViewLock?.()) {
                    gc.releaseDeferredPaintAfterFailedCompile();
                }
                console.error(
                    '[GlyphCanvas] Failed to apply editing font update:',
                    error
                );
                timelineMark('canvas.editingFontCompiled.applyFailed');
            });
    };

    // Legacy: Custom event when font is compiled via compile button
    fontCompiledHandler = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        console.log('[GlyphCanvas]', 'Font compiled event received (legacy)');
        timelineMark('canvas.fontCompiledLegacy.received');
        if (window.glyphCanvas && detail && detail.ttfBytes) {
            const fontBytesArray = adoptOwnedFontBytes(detail.ttfBytes);
            await window.glyphCanvas.setFont(
                arrayBufferFromOwnedBytes(fontBytesArray)
            );
            window.glyphCanvas.requestRepaintAfterCompile();
            timelineMark('canvas.fontCompiledLegacy.fontApplied');
        } else {
            timelineMark('canvas.fontCompiledLegacy.skippedMissingData');
        }
    };

    window.addEventListener('editingFontCompiled', editingFontCompiledHandler);
    window.addEventListener('fontCompiled', fontCompiledHandler);
}

// Set up editor keyboard shortcuts docs entry
function setupEditorShortcutsModal() {
    const infoButton = document.getElementById('editor-info-btn');
    if (!infoButton) return;

    infoButton.addEventListener('click', (event: Event) => {
        event.stopPropagation();
        window.openDocs?.('editor/glyph-editor');
    });
}

export { GlyphCanvas, setupFontLoadingListener };
