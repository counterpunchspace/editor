// Glyph Overview
// Displays grid of glyph tiles with selection support
// Uses direct canvas rendering for fast display

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
import {
    glyphNameMatchesSearchTerms,
    parseGlyphSearchTerms,
    formatCodepointsHexList,
    parseCodepointsHexList
} from './glyph-search';
// Import filter manager to bundle it with glyph-overview entry point
// It self-registers on window.glyphOverviewFilterManager
import './glyph-overview-filters';
import { catalogCodepointsByGlyphName } from './filesystem-plugins/cloud-glyph-catalog';
import { Logger } from './logger';
import { timelineSpanStart, timelineSpanEnd } from './perf-timeline';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    keyboardShortcutHtml,
    MENU_SHIFT_SYMBOL,
    setupMenuKeyboardNav
} from './tippy-utils';
import { isOverviewFollowStackScrollEnabled } from './glyph-overview-follow-stack-pref';
import {
    getOverviewDisplayMode,
    getOverviewSize,
    setOverviewDisplayMode,
    setOverviewSize,
    type OverviewDisplayMode
} from './window-ui-state';
import {
    appendGlyphOverviewTypeaheadBuffer,
    GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS,
    matchGlyphOverviewTypeahead
} from './glyph-overview-typeahead';
import APP_SETTINGS from './settings';
import { getGlyphRenamePreflightErrors } from './rename-glyphs-preflight';
import { ArrowAdjustableTextInput } from './arrow-adjustable-text-input';
import {
    applyKerningGroupMembership,
    buildEditViewKerningGroupSide,
    formatKerningGroupKindLabel,
    renderKerningGroupWidget,
    type KerningPairSide
} from './glyph-canvas/kerning-group-widget';
import {
    getSidebearingTransactionLabel,
    type SidebearingSide
} from './sidebearing-utils';

const console = new Logger('GlyphOverview');

// Use the shared fontCompilation instance from window (set by bootstrap)
// Do NOT import from './font-compilation' as this is a separate webpack entry point
// and would create a separate worker instance with its own cache
declare const window: Window & { fontCompilation?: any };

/**
 * Must match `#glyph-overview-container` gap and padding in glyph-overview.css.
 */
export const OVERVIEW_TILE_GAP_PX = 2;
export const OVERVIEW_TILE_PADDING_PX = 2;

/**
 * Line-break from the slider's base tile width, then stretch each tile so a
 * full row fills the content box (padding already subtracted via clientWidth).
 */
export function computeLinesModeTileLayout(
    containerClientWidth: number,
    baseTileWidth: number,
    gap: number = OVERVIEW_TILE_GAP_PX,
    paddingPerSide: number = OVERVIEW_TILE_PADDING_PX
): { columns: number; filledWidth: number } {
    const availableWidth = Math.max(
        0,
        containerClientWidth - paddingPerSide * 2
    );
    if (baseTileWidth <= 0) {
        return { columns: 1, filledWidth: Math.max(0, availableWidth) };
    }
    const columns = Math.max(
        1,
        Math.floor((availableWidth + gap) / (baseTileWidth + gap))
    );
    const filledWidth =
        columns === 1
            ? availableWidth
            : (availableWidth - (columns - 1) * gap) / columns;
    return {
        columns,
        filledWidth: Math.max(0, filledWidth)
    };
}

/**
 * Backing-store bytes for an overview tile canvas.
 * Unused tiles keep the HTML default 300×150 without a style size and
 * have never been painted; those do not get a real bitmap until render.
 */
export function overviewTileCanvasBackingBytes(
    canvas: HTMLCanvasElement
): number {
    if (canvas.width <= 0 || canvas.height <= 0) {
        return 0;
    }
    const unusedHtmlDefault =
        canvas.width === 300 &&
        canvas.height === 150 &&
        canvas.style.width === '' &&
        canvas.style.height === '';
    if (unusedHtmlDefault) {
        return 0;
    }
    return canvas.width * canvas.height * 4;
}

interface GlyphTile {
    element: HTMLDivElement;
    glyphId: string;
    glyphName: string;
    selected: boolean;
    cachedData?: any; // Cached glyph outline data for resize / LRU
    lastViewedAt?: number;
    canvas?: HTMLCanvasElement; // Reusable canvas element
    filterColor?: string; // Primary background overlay color from active filter
    filterColors?: string[]; // All unique colors for multi-group display
}

/**
 * Filter result from glyph filter plugins
 */
export interface FilterResult {
    glyph_name: string;
    group?: string; // Single group keyword
    groups?: string[]; // Array of group keywords for multi-group support
    color?: string; // Primary color for display
    colors?: string[]; // All colors for multi-group
}

type OverviewViewMode = 'lines' | 'grid';

function viewModeFromDisplayMode(mode: OverviewDisplayMode): OverviewViewMode {
    return mode === 'matrix' ? 'grid' : 'lines';
}

function displayModeFromViewMode(mode: OverviewViewMode): OverviewDisplayMode {
    return mode === 'grid' ? 'matrix' : 'normal';
}

interface GridNameParts {
    baseName: string;
    variantSuffix: string;
}

interface GridLayoutData {
    columns: string[];
    rows: Array<Array<string | null>>;
    visibleIds: string[];
}

type ResizeFocusAnchor =
    | {
          type: 'selection';
          glyphIds: string[];
      }
    | {
          type: 'center';
          glyphId: string;
      };

type OverviewPropertyInputState = {
    fieldKey: string;
    selectionStart: number | null;
    selectionEnd: number | null;
};

type OverviewSidebearingLayer = {
    lsb: number;
    rsb: number;
    width: number;
    leftMetricsKey?: string;
    rightMetricsKey?: string;
    isAutomaticAlignedLayer: () => boolean;
    getBoundingBox?: (includeAnchors?: boolean) => {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    } | null;
    resolveMetricsKey: (side: SidebearingSide) => {
        input: string;
        value: number | null;
        error: string | null;
    };
    applySidebearingInput: (
        side: SidebearingSide,
        value: string
    ) => {
        error: string | null;
        value: number | null;
        affectedGlyphNames?: string[];
    };
    parent?: () =>
        | {
              name?: string;
              leftMetricsKey?: string;
              rightMetricsKey?: string;
          }
        | null
        | undefined;
};

type OverviewSidebearingDisplayState = {
    displayedValue: string;
    resolvedValue: number;
    automaticLayer: boolean;
    showAutoPlaceholder: boolean;
    error: string | null;
};

type OverviewSidebearingSideSummary = {
    sharedDisplay: string | null;
    sharedResolved: number | null;
    allAutomatic: boolean;
    anyError: boolean;
    showAutoPlaceholder: boolean;
    /** First-layer state for arrow-adjust fallback when values are shared. */
    sampleState: OverviewSidebearingDisplayState | null;
};

type DragTileRect = {
    glyphId: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
};

function isPlainNumericInputValue(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function locationsMatchWithinTolerance(
    masterLocation: Record<string, number> | undefined,
    currentLocation: Record<string, number>,
    tolerance = 0.001
): boolean {
    if (!masterLocation) {
        return false;
    }
    for (const tag in masterLocation) {
        const masterValue = Number(masterLocation[tag]);
        const currentValue =
            currentLocation[tag] === undefined
                ? undefined
                : Number(currentLocation[tag]);
        if (
            currentValue === undefined ||
            Math.abs(masterValue - currentValue) > tolerance
        ) {
            return false;
        }
    }
    return true;
}

class GlyphOverview {
    private container: HTMLDivElement | null = null;
    private propertyPanel: HTMLElement | null = null;
    private propertyPanelUpdateRafId: number | null = null;
    private propertyPanelDeferredUntilDragEnd = false;
    private selectionUiFlushPending = false;
    private dragTileRects: DragTileRect[] | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private lastContainerWidth = 0;
    private lastLinesColumnCount = 0;
    private lineBreakFocusLock: ResizeFocusAnchor | null = null;
    private lineBreakFocusLockTimer: number | null = null;
    private readonly lineBreakFocusLockSettleMs = 250;
    private tiles: Map<string, GlyphTile> = new Map();
    private isDragging = false;
    private hasDragged = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private selectionBox: HTMLDivElement | null = null;
    private currentLocation: Record<string, number> = {};
    /**
     * When false, block all outline paints (including setActiveFilter / location
     * events). Open path enables this only for the single fontReady paint.
     */
    private outlinePaintAllowed = false;
    private outlineRenderGeneration = 0;
    private intersectionObserver: IntersectionObserver | null = null;
    private lazyLoadEnabled: boolean = false;
    // Batched lazy loading
    private pendingGlyphIds: Set<string> = new Set();
    private batchDebounceTimer: number | null = null;
    private isBatchRendering: boolean = false;
    private tileBuildRunId = 0;
    private tileBuildPromise: Promise<void> = Promise.resolve();
    private tileBuildResolve: (() => void) | null = null;
    private deferredTileBuildTimer: number | null = null;
    private linesVirtualizationActive = false;
    private virtualizedRenderRafPending = false;
    private scrollVisibilitySyncRafId: number | null = null;
    private virtualizedRenderRange: { start: number; end: number } | null =
        null;
    private readonly linesVirtualizationThreshold = 1200;
    private readonly linesVirtualizationBufferRows = 6;
    private readonly tileCacheViewportMarginPx = 100;
    private tileViewClock = 0;
    private tileContextMenu: TippyInstance | null = null;
    private onContainerScrollBound = this.onContainerScroll.bind(this);
    private onCapturedScrollBound = this.onCapturedScroll.bind(this);
    private onFontModelSyncBound = (): void => {
        this.reconcileTileHydration();
        this.updatePropertyPanel();
    };
    private lastOverviewFontKey = '';
    private lazyBatchSize = 240;
    private readonly minLazyBatchSize = 80;
    private readonly maxLazyBatchSize = 500;
    private updateGlyphsSpanId: string | null = null;
    // Cached metrics for tile rendering
    private renderMetrics: {
        ascender: number;
        descender: number;
        upm: number;
    } | null = null;
    // Currently highlighted editing glyph
    private highlightedGlyphName: string | null = null;
    private highlightScrollSyncRafId: number | null = null;
    private highlightScrollSyncAttempts = 0;
    private readonly maxHighlightScrollSyncAttempts = 8;
    private pendingChangedGlyphNames: Set<string> = new Set();
    private pendingChangedGlyphRefreshTimer: number | null = null;
    private readonly deferredGlyphRefreshDelayMs = 16;
    private readonly activeDragGlyphRefreshDelayMs = 120;
    // Tile size control
    private currentSizeStep: number = 5;
    private sizeSlider: HTMLInputElement | null = null;
    // Search control
    private searchInput: HTMLInputElement | null = null;
    private searchTerms: string[] = [];
    // View mode control
    private viewMode: OverviewViewMode = 'lines';
    private linesModeButton: HTMLButtonElement | null = null;
    private gridModeButton: HTMLButtonElement | null = null;
    private visibleGlyphIds: string[] = [];
    private glyphOrderIds: string[] = [];
    private glyphDataById: Map<
        string,
        { id: string; name: string; codepoints?: number[] }
    > = new Map();
    private catalogCodepointsByName: Map<string, number[]> | null = null;
    private totalGlyphDatasetCount = 0;
    private gridRowsForNavigation: Array<Array<string | null>> = [];
    private gridColumnCount = 0;
    // Active filter
    private activeFilterResults: Map<string, FilterResult> | null = null;
    // Error overlay for filter errors
    private errorOverlay: HTMLDivElement | null = null;
    // Track the last glyph clicked by mouse (for keyboard navigation reference)
    private lastClickedGlyphId: string | null = null;
    // Track anchor point for shift+keyboard selection
    private keyboardAnchorGlyphId: string | null = null;
    // Snapshot of selection before last plain single-click (used to restore on double-click)
    private preDoubleClickSelectionGlyphIds: string[] = [];
    private preDoubleClickGlyphId: string | null = null;
    private preDoubleClickTimestamp = 0;
    /** Names to select after the next overview rebuild (paste / duplicate). */
    private pendingSelectGlyphNames: string[] | null = null;
    /** Bumps to cancel stale post-layout selection reveals. */
    private selectionRevealGeneration = 0;
    /** Bumps only when a new paste/duplicate force-reveal supersedes another. */
    private forceRevealGeneration = 0;
    /** Type-to-select buffer (codepoint when length 1; name prefix when longer). */
    private typeaheadBuffer = '';
    private typeaheadLastKeyAtMs = 0;
    private typeaheadClearTimer: number | null = null;

    constructor(parentElement: HTMLElement) {
        this.init(parentElement);
        this.initSizeControl();
        this.initSearchControl();
        this.initViewModeControl();
    }

    /**
     * Attach the overview property panel (created by overview-view under
     * `#overview-main`) and render the initial empty state.
     */
    public attachPropertyPanel(panel: HTMLElement): void {
        this.propertyPanel = panel;
        this.updatePropertyPanel();
    }

    private init(parentElement: HTMLElement): void {
        // Create main container for glyph tiles
        this.container = document.createElement('div');
        this.container.id = 'glyph-overview-container';

        parentElement.appendChild(this.container);
        this.setupResizeObserver();

        // Set up mouse event listeners for drag selection
        this.container.addEventListener(
            'mousedown',
            this.onMouseDown.bind(this)
        );
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));
        this.initTileContextMenu();

        // Listen for glyph changes to update tiles
        window.addEventListener('glyphChanged', this.onGlyphChanged.bind(this));
        window.addEventListener('fontModelSync', this.onFontModelSyncBound);

        // Listen for glyph stack changes to update highlight immediately
        window.addEventListener(
            'glyphStackChanged',
            this.onGlyphStackChanged.bind(this)
        );

        // Listen for mode changes to clear border when switching to text mode
        window.addEventListener(
            'editorModeChanged',
            this.onModeChanged.bind(this)
        );
        window.addEventListener('scroll', this.onCapturedScrollBound, {
            capture: true,
            passive: true
        });

        // Listen for variation location changes to re-render tiles.
        // Blocked until overview-view allows paints after the fontReady open render.
        window.addEventListener('variationLocationChanged', ((
            e: CustomEvent
        ) => {
            if (!this.outlinePaintAllowed) {
                return;
            }
            void this.renderGlyphOutlines(e.detail.location);
        }) as EventListener);

        // Listen for theme changes to re-render tiles
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (
                    mutation.type === 'attributes' &&
                    mutation.attributeName === 'data-theme'
                ) {
                    this.onThemeChanged();
                }
            });
        });
        observer.observe(document.documentElement, { attributes: true });
    }

    private setupResizeObserver(): void {
        if (!this.container) {
            return;
        }

        this.lastContainerWidth = this.container.clientWidth;
        this.resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !this.container) {
                return;
            }

            const nextWidth = Math.round(entry.contentRect.width);
            if (nextWidth <= 0 || nextWidth === this.lastContainerWidth) {
                return;
            }

            const previousWidth = this.lastContainerWidth;
            this.lastContainerWidth = nextWidth;
            if (!this.container || this.viewMode !== 'lines') {
                return;
            }

            const anchor = this.lockLineBreakFocusAnchor(previousWidth);
            const nextColumns = computeLinesModeTileLayout(
                this.container.clientWidth,
                this.getTileDimensions().width
            ).columns;
            if (nextColumns === this.lastLinesColumnCount) {
                return;
            }

            this.lastLinesColumnCount = nextColumns;
            this.container.style.setProperty(
                '--tile-columns',
                String(nextColumns)
            );
            this.applyLineBreakFocusLock(anchor);
        });
        this.resizeObserver.observe(this.container);
    }

    private lockLineBreakFocusAnchor(
        previousWidth: number = 0
    ): ResizeFocusAnchor | null {
        if (!this.lineBreakFocusLock) {
            let columnsForVisibility = this.lastLinesColumnCount;
            if (columnsForVisibility <= 0 && previousWidth > 0) {
                columnsForVisibility = computeLinesModeTileLayout(
                    previousWidth,
                    this.getTileDimensions().width
                ).columns;
            }
            if (columnsForVisibility <= 0) {
                columnsForVisibility = Math.max(1, this.getGridColumns());
            }
            this.lineBreakFocusLock =
                this.getResizeFocusAnchor(columnsForVisibility);
        }

        if (this.lineBreakFocusLockTimer !== null) {
            window.clearTimeout(this.lineBreakFocusLockTimer);
        }
        this.lineBreakFocusLockTimer = window.setTimeout(() => {
            this.lineBreakFocusLockTimer = null;
            this.lineBreakFocusLock = null;
        }, this.lineBreakFocusLockSettleMs);

        return this.lineBreakFocusLock;
    }

    private applyLineBreakFocusLock(anchor: ResizeFocusAnchor | null): void {
        if (!anchor) {
            return;
        }

        const glyphIds =
            anchor.type === 'selection' ? anchor.glyphIds : [anchor.glyphId];
        this.centerGlyphIdsInView(glyphIds);
    }

    private initSizeControl(): void {
        this.currentSizeStep = getOverviewSize();

        // Find slider in DOM
        this.sizeSlider = document.getElementById(
            'overview-size-slider'
        ) as HTMLInputElement;
        if (this.sizeSlider) {
            this.sizeSlider.value = String(this.currentSizeStep);
            this.updateSliderProgress();

            // Listen for size changes
            this.sizeSlider.addEventListener('input', (e) => {
                const newSize = parseInt(
                    (e.target as HTMLInputElement).value,
                    10
                );
                this.currentSizeStep = newSize;
                this.updateSliderProgress();
                this.updateTileSize();
                setOverviewSize(newSize);
            });
        }

        this.applyOverviewTileLayout();
    }

    private updateSliderProgress(): void {
        if (!this.sizeSlider) return;
        const percent = (this.currentSizeStep / 10) * 100;
        this.sizeSlider.style.setProperty('--value-percent', `${percent}%`);
    }

    private initSearchControl(): void {
        // Find search input in DOM
        this.searchInput = document.getElementById(
            'overview-search-input'
        ) as HTMLInputElement;

        if (this.searchInput) {
            // Listen for input changes
            this.searchInput.addEventListener('input', (e) => {
                this.searchTerms = parseGlyphSearchTerms(
                    (e.target as HTMLInputElement).value
                );
                this.applySearchFilter();
            });
        }

        // Listen for keyboard shortcut (Cmd+F; Cmd+Shift+F is Rename Glyphs)
        document.addEventListener('keydown', (e) => {
            if (
                (e.metaKey || e.ctrlKey) &&
                !e.shiftKey &&
                e.key.toLowerCase() === 'f' &&
                this.isViewActive()
            ) {
                e.preventDefault();
                if (this.searchInput) {
                    this.searchInput.focus();
                    this.searchInput.select();
                }
            } else if (e.key === 'Escape' && this.isViewActive()) {
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA' ||
                        target.isContentEditable)
                ) {
                    return;
                }
                // Clear all glyph and group selections
                e.preventDefault();
                this.clearTypeaheadBuffer();
                this.clearSelection();
                // Also clear keyboard anchor
                this.keyboardAnchorGlyphId = null;
                if (window.glyphOverviewFilterManager) {
                    window.glyphOverviewFilterManager.clearGroupSelection();
                }
            } else if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                this.isViewActive()
            ) {
                e.preventDefault();
                this.insertSelectedGlyphTokens();
            } else if (
                (e.key === 'Backspace' || e.key === 'Delete') &&
                this.isViewActive()
            ) {
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA' ||
                        target.isContentEditable)
                ) {
                    return;
                }
                if (this.typeaheadBuffer.length > 0) {
                    e.preventDefault();
                    this.clearTypeaheadBuffer();
                    return;
                }
                if (
                    this.getSelectedGlyphNames().length > 0 &&
                    window.fontManager?.currentFont
                ) {
                    e.preventDefault();
                    window.deleteGlyphsDialog?.open();
                }
            } else if (
                (e.metaKey || e.ctrlKey) &&
                !e.shiftKey &&
                !e.altKey &&
                e.key.toLowerCase() === 'd' &&
                this.isViewActive()
            ) {
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA' ||
                        target.isContentEditable)
                ) {
                    return;
                }
                if (
                    this.getSelectedGlyphNames().length > 0 &&
                    window.fontManager?.currentFont
                ) {
                    e.preventDefault();
                    this.duplicateSelectedGlyphs();
                }
            } else if (
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
                    e.key
                )
            ) {
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA' ||
                        target.isContentEditable)
                ) {
                    return;
                }
                // Handle arrow key navigation for glyph selection
                if (this.isViewActive()) {
                    e.preventDefault();
                    this.clearTypeaheadBuffer();
                    this.handleArrowKeyNavigation(e.key, e.shiftKey);
                }
            } else if (this.isViewActive()) {
                this.handleTypeaheadKeydown(e);
            }
        });
    }

    private initViewModeControl(): void {
        this.viewMode = viewModeFromDisplayMode(getOverviewDisplayMode());

        this.linesModeButton = document.getElementById(
            'overview-mode-lines'
        ) as HTMLButtonElement;
        this.gridModeButton = document.getElementById(
            'overview-mode-grid'
        ) as HTMLButtonElement;

        if (this.linesModeButton) {
            this.linesModeButton.addEventListener('click', () => {
                this.setViewMode('lines');
            });
        }

        if (this.gridModeButton) {
            this.gridModeButton.addEventListener('click', () => {
                this.setViewMode('grid');
            });
        }

        this.setViewMode(this.viewMode, false, true);
    }

    /**
     * Type-to-select while the overview is focused.
     * One key → Unicode codepoint; rapid keys within 1s → glyph-name prefix.
     */
    private handleTypeaheadKeydown(event: KeyboardEvent): void {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (
            target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable)
        ) {
            return;
        }
        if (event.key.length !== 1) {
            return;
        }

        const now = performance.now();
        const elapsed =
            this.typeaheadLastKeyAtMs > 0
                ? now - this.typeaheadLastKeyAtMs
                : Number.POSITIVE_INFINITY;
        this.typeaheadBuffer = appendGlyphOverviewTypeaheadBuffer(
            this.typeaheadBuffer,
            event.key,
            elapsed,
            GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS
        );
        this.typeaheadLastKeyAtMs = now;
        this.scheduleTypeaheadBufferClear();

        const matchName = matchGlyphOverviewTypeahead(
            this.typeaheadBuffer,
            this.collectTypeaheadGlyphs()
        );
        // Consume the key once a multi-character typeahead session is active,
        // even if the current prefix has no match yet.
        if (matchName || this.typeaheadBuffer.length > 1) {
            event.preventDefault();
        }
        if (!matchName) {
            return;
        }

        this.selectGlyphsByNames([matchName]);
    }

    private collectTypeaheadGlyphs(): Array<{
        name: string;
        codepoints?: readonly number[] | null;
    }> {
        const glyphs: Array<{
            name: string;
            codepoints?: readonly number[] | null;
        }> = [];
        for (const glyphId of this.visibleGlyphIds) {
            const tile = this.tiles.get(glyphId);
            if (!tile) {
                continue;
            }
            glyphs.push({
                name: tile.glyphName,
                codepoints: this.getOverviewCodepoints(tile.glyphName)
            });
        }
        return glyphs;
    }

    private scheduleTypeaheadBufferClear(): void {
        if (this.typeaheadClearTimer !== null) {
            window.clearTimeout(this.typeaheadClearTimer);
        }
        this.typeaheadClearTimer = window.setTimeout(() => {
            this.typeaheadClearTimer = null;
            this.typeaheadBuffer = '';
            this.typeaheadLastKeyAtMs = 0;
        }, GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS);
    }

    private clearTypeaheadBuffer(): void {
        if (this.typeaheadClearTimer !== null) {
            window.clearTimeout(this.typeaheadClearTimer);
            this.typeaheadClearTimer = null;
        }
        this.typeaheadBuffer = '';
        this.typeaheadLastKeyAtMs = 0;
    }

    private setViewMode(
        mode: OverviewViewMode,
        persist: boolean = true,
        force: boolean = false
    ): void {
        if (!force && this.viewMode === mode) return;

        this.viewMode = mode;
        if (persist) {
            setOverviewDisplayMode(displayModeFromViewMode(mode));
        }
        this.updateViewModeButtonState();
        this.renderByViewMode();
        this.applyOverviewTileLayout();
    }

    private updateViewModeButtonState(): void {
        const isLines = this.viewMode === 'lines';

        if (this.linesModeButton) {
            this.linesModeButton.classList.toggle('active', isLines);
            this.linesModeButton.setAttribute(
                'aria-pressed',
                isLines ? 'true' : 'false'
            );
        }

        if (this.gridModeButton) {
            this.gridModeButton.classList.toggle('active', !isLines);
            this.gridModeButton.setAttribute(
                'aria-pressed',
                isLines ? 'false' : 'true'
            );
        }
    }

    private applySearchFilter(): void {
        if (
            this.searchTerms.length === 0 &&
            this.activeFilterResults === null
        ) {
            this.visibleGlyphIds = [...this.glyphOrderIds];
        } else {
            this.visibleGlyphIds = this.computeVisibleGlyphIds();
        }
        // Always rebuild DOM from visibleGlyphIds. The old no-relayout path
        // left Map-insertion order in place after incremental syncGlyphs.
        this.renderByViewMode();
    }

    private computeVisibleGlyphIds(): string[] {
        const visibleIds: string[] = [];

        // Walk font order (glyphOrderIds), not Map insertion order — new
        // tiles are appended to the Map and would otherwise appear last.
        for (const glyphId of this.glyphOrderIds) {
            const tile = this.tiles.get(glyphId);
            if (!tile) {
                continue;
            }

            const passesFilter =
                this.activeFilterResults === null ||
                this.activeFilterResults.has(tile.glyphName);

            const passesSearch = glyphNameMatchesSearchTerms(
                tile.glyphName,
                this.searchTerms
            );

            if (passesFilter && passesSearch) {
                visibleIds.push(glyphId);
            }
        }

        return visibleIds;
    }

    private renderByViewMode(): void {
        if (!this.container) return;

        if (this.viewMode === 'grid') {
            this.renderGridMode();
            return;
        }

        this.renderLinesMode();
    }

    private renderLinesMode(): void {
        if (!this.container) return;

        if (this.shouldVirtualizeLinesMode()) {
            this.enableLinesVirtualization();
            this.renderVirtualizedLinesWindow(true);
            return;
        }

        this.detachLinesVirtualization();

        const visibleSet = new Set(this.visibleGlyphIds);
        this.container.classList.remove('glyph-overview-grid-mode');
        this.container.classList.add('glyph-overview-lines-mode');
        this.applyOverviewTileLayout();
        this.gridRowsForNavigation = [];
        this.gridColumnCount = 0;

        const fragment = document.createDocumentFragment();
        // Walk font/filter order — not Map insertion order — so incremental
        // syncGlyphs inserts land next to their namesake instead of at the end.
        for (const glyphId of this.visibleGlyphIds) {
            const tile = this.tiles.get(glyphId);
            if (!tile) {
                continue;
            }
            tile.element.style.display = '';
            fragment.appendChild(tile.element);
        }
        this.tiles.forEach((tile, glyphId) => {
            if (visibleSet.has(glyphId)) {
                return;
            }
            tile.element.style.display = 'none';
            fragment.appendChild(tile.element);
        });

        this.container.innerHTML = '';
        this.container.appendChild(fragment);
    }

    private renderGridMode(): void {
        if (!this.container) return;

        this.detachLinesVirtualization();

        const layout = this.buildGridLayoutData(this.visibleGlyphIds);
        this.container.classList.remove('glyph-overview-lines-mode');
        this.container.classList.add('glyph-overview-grid-mode');
        this.applyOverviewTileLayout();
        this.gridRowsForNavigation = layout.rows;
        this.gridColumnCount = layout.columns.length;

        const visibleSet = new Set(layout.visibleIds);
        this.tiles.forEach((tile, glyphId) => {
            tile.element.style.display = visibleSet.has(glyphId) ? '' : 'none';
        });

        const fragment = document.createDocumentFragment();

        const headerRowElement = document.createElement('div');
        headerRowElement.className = 'glyph-grid-row glyph-grid-header-row';
        headerRowElement.style.gridTemplateColumns = `repeat(${layout.columns.length}, var(--tile-width))`;

        layout.columns.forEach((columnSuffix) => {
            const headerCellElement = document.createElement('div');
            headerCellElement.className = 'glyph-grid-header-cell';
            headerCellElement.textContent = columnSuffix;
            headerCellElement.title = columnSuffix;
            headerRowElement.appendChild(headerCellElement);
        });

        fragment.appendChild(headerRowElement);

        layout.rows.forEach((row) => {
            const rowElement = document.createElement('div');
            rowElement.className = 'glyph-grid-row';
            rowElement.style.gridTemplateColumns = `repeat(${layout.columns.length}, var(--tile-width))`;

            row.forEach((glyphId) => {
                const cellElement = document.createElement('div');
                cellElement.className = 'glyph-grid-cell';

                if (glyphId) {
                    const tile = this.tiles.get(glyphId);
                    if (tile) {
                        cellElement.appendChild(tile.element);
                    }
                } else {
                    cellElement.classList.add('empty');
                }

                rowElement.appendChild(cellElement);
            });

            fragment.appendChild(rowElement);
        });

        this.container.innerHTML = '';
        this.container.appendChild(fragment);
    }

    private shouldVirtualizeLinesMode(): boolean {
        return (
            this.viewMode === 'lines' &&
            this.visibleGlyphIds.length >= this.linesVirtualizationThreshold
        );
    }

    private enableLinesVirtualization(): void {
        if (!this.container) return;

        if (!this.linesVirtualizationActive) {
            this.linesVirtualizationActive = true;
            this.container.addEventListener(
                'scroll',
                this.onContainerScrollBound,
                {
                    passive: true
                }
            );
        }

        this.container.classList.remove('glyph-overview-grid-mode');
        this.container.classList.add('glyph-overview-lines-mode');
        this.applyOverviewTileLayout();
    }

    private detachLinesVirtualization(): void {
        if (!this.container || !this.linesVirtualizationActive) {
            return;
        }

        this.linesVirtualizationActive = false;
        this.virtualizedRenderRafPending = false;
        this.virtualizedRenderRange = null;
        this.container.removeEventListener(
            'scroll',
            this.onContainerScrollBound
        );
    }

    private onContainerScroll(): void {
        if (this.isDragging && this.hasDragged) {
            this.dragTileRects = null;
        }
        if (!this.linesVirtualizationActive || !this.container) {
            return;
        }

        this.scheduleScrollVisibilitySync();
    }

    private onCapturedScroll(event: Event): void {
        if (!this.lazyLoadEnabled || !this.container) {
            return;
        }

        const target = event.target;
        const isRelevantScrollTarget =
            target === this.container ||
            (target instanceof Node &&
                (target.contains(this.container) ||
                    this.container.contains(target)));

        if (!isRelevantScrollTarget) {
            return;
        }

        if (this.isDragging && this.hasDragged) {
            this.dragTileRects = null;
        }

        this.scheduleScrollVisibilitySync();
    }

    private scheduleScrollVisibilitySync(): void {
        if (this.scrollVisibilitySyncRafId !== null) {
            return;
        }

        this.scrollVisibilitySyncRafId = requestAnimationFrame(() => {
            this.scrollVisibilitySyncRafId = null;

            if (!this.container || !this.lazyLoadEnabled) {
                return;
            }

            if (this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow();
            }

            const queuedVisibleTileCount = this.queueVisibleUncachedTiles();
            this.enforceTileCacheBudget();
            if (queuedVisibleTileCount > 0) {
                this.scheduleBatchRender();
            }
        });
    }

    private queueVisibleUncachedTiles(): number {
        if (!this.container) {
            return 0;
        }

        const containerRect = this.container.getBoundingClientRect();
        if (containerRect.width <= 0 || containerRect.height <= 0) {
            return 0;
        }

        let queuedCount = 0;

        for (const tile of this.tiles.values()) {
            if (!this.isTileInOverscan(tile, containerRect)) {
                continue;
            }

            this.touchTileViewed(tile);

            if (tile.cachedData || this.pendingGlyphIds.has(tile.glyphId)) {
                continue;
            }

            this.pendingGlyphIds.add(tile.glyphId);
            queuedCount += 1;
        }

        return queuedCount;
    }

    private renderVirtualizedLinesWindow(force: boolean = false): void {
        if (!this.container) return;
        // Lines virtualization only: in grid mode the container holds a
        // base×variant table, not a flat flex flow. Rebuilding a windowed
        // spacer layout here would wipe the grid rows and wreck scroll math.
        if (!this.linesVirtualizationActive) return;

        const total = this.visibleGlyphIds.length;
        if (total === 0) {
            this.virtualizedRenderRange = { start: 0, end: 0 };
            this.container.innerHTML = '';
            return;
        }

        const dims = this.getTileDimensions();
        const columns = Math.max(1, this.getGridColumns());
        const rowHeight = dims.height + 2;
        const totalRows = Math.ceil(total / columns);
        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;

        const startRow = Math.max(
            0,
            Math.floor(viewportTop / rowHeight) -
                this.linesVirtualizationBufferRows
        );
        const endRow = Math.min(
            totalRows - 1,
            Math.ceil(viewportBottom / rowHeight) +
                this.linesVirtualizationBufferRows
        );

        const start = Math.min(total, startRow * columns);
        const end = Math.min(total, (endRow + 1) * columns);

        if (
            !force &&
            this.virtualizedRenderRange &&
            this.virtualizedRenderRange.start === start &&
            this.virtualizedRenderRange.end === end
        ) {
            return;
        }

        this.virtualizedRenderRange = { start, end };

        const topSpacerHeight = startRow * rowHeight;
        const bottomSpacerHeight = Math.max(
            0,
            (totalRows - endRow - 1) * rowHeight
        );
        let queuedVisibleTileCount = 0;

        const fragment = document.createDocumentFragment();

        if (topSpacerHeight > 0) {
            const topSpacer = document.createElement('div');
            topSpacer.style.width = '100%';
            topSpacer.style.height = `${topSpacerHeight}px`;
            topSpacer.dataset.role = 'virtual-spacer-top';
            fragment.appendChild(topSpacer);
        }

        for (let index = start; index < end; index += 1) {
            const glyphId = this.visibleGlyphIds[index];
            let tile = this.tiles.get(glyphId);
            if (!tile) {
                const glyphData = this.glyphDataById.get(glyphId);
                if (glyphData) {
                    tile = this.createGlyphTile(glyphData.id, glyphData.name);
                    this.tiles.set(glyphId, tile);
                }
            }
            if (!tile) continue;
            tile.element.style.display = '';
            fragment.appendChild(tile.element);
            this.touchTileViewed(tile);
            if (!tile.cachedData && !this.pendingGlyphIds.has(glyphId)) {
                if (this.isGlyphHydrated(tile.glyphName)) {
                    this.pendingGlyphIds.add(glyphId);
                    queuedVisibleTileCount += 1;
                }
            }
            if (this.intersectionObserver) {
                this.intersectionObserver.observe(tile.element);
            }
        }

        if (bottomSpacerHeight > 0) {
            const bottomSpacer = document.createElement('div');
            bottomSpacer.style.width = '100%';
            bottomSpacer.style.height = `${bottomSpacerHeight}px`;
            bottomSpacer.dataset.role = 'virtual-spacer-bottom';
            fragment.appendChild(bottomSpacer);
        }

        this.container.innerHTML = '';
        this.container.appendChild(fragment);
        this.enforceTileCacheBudget();

        if (queuedVisibleTileCount > 0) {
            this.scheduleBatchRender();
        }
    }

    private buildGridLayoutData(visibleIds: string[]): GridLayoutData {
        const rowByBase = new Map<string, Map<string, string>>();
        const baseOrder: string[] = [];
        const variantSuffixes = new Set<string>();

        visibleIds.forEach((glyphId) => {
            const tile = this.tiles.get(glyphId);
            if (!tile) return;

            const { baseName, variantSuffix } = this.parseGridName(
                tile.glyphName
            );

            if (!rowByBase.has(baseName)) {
                rowByBase.set(baseName, new Map());
                baseOrder.push(baseName);
            }

            rowByBase.get(baseName)!.set(variantSuffix, glyphId);

            if (variantSuffix) {
                variantSuffixes.add(variantSuffix);
            }
        });

        const sortedVariantSuffixes = Array.from(variantSuffixes).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        );
        const columns = ['', ...sortedVariantSuffixes];

        const rows: Array<Array<string | null>> = baseOrder.map((baseName) => {
            const rowMap = rowByBase.get(baseName)!;
            return columns.map(
                (columnSuffix) => rowMap.get(columnSuffix) ?? null
            );
        });

        return {
            columns,
            rows,
            visibleIds
        };
    }

    private parseGridName(glyphName: string): GridNameParts {
        if (glyphName.startsWith('.')) {
            return {
                baseName: glyphName,
                variantSuffix: ''
            };
        }

        const dotIndex = glyphName.indexOf('.');
        if (dotIndex <= 0) {
            return {
                baseName: glyphName,
                variantSuffix: ''
            };
        }

        return {
            baseName: glyphName.slice(0, dotIndex),
            variantSuffix: glyphName.slice(dotIndex)
        };
    }

    private getTileDimensions(): { width: number; height: number } {
        // Smallest: 25x42 (a bit smaller than current 30x50)
        // Largest: 200x250
        // Interpolate between them
        const minWidth = 25;
        const maxWidth = 200;
        const minHeight = 42;
        const maxHeight = 250;

        const t = this.currentSizeStep / 10; // 0 to 1
        const width = Math.round(minWidth + (maxWidth - minWidth) * t);
        const height = Math.round(minHeight + (maxHeight - minHeight) * t);

        return { width, height };
    }

    /**
     * Slider size stays on --tile-width/--tile-height (bitmap + matrix cells).
     * Lines mode only updates --tile-columns; CSS 1fr stretches the chrome.
     */
    private applyOverviewTileLayout(): void {
        if (!this.container) {
            return;
        }

        const dims = this.getTileDimensions();
        this.container.style.setProperty('--tile-width', `${dims.width}px`);
        this.container.style.setProperty('--tile-height', `${dims.height}px`);
        this.lastLinesColumnCount = 0;
        this.syncLinesModeColumnsFromContainer();
    }

    /**
     * @returns true when the integer column count changed (line-breaking).
     */
    private syncLinesModeColumnsFromContainer(): boolean {
        if (!this.container || this.viewMode !== 'lines') {
            return false;
        }

        const { columns } = computeLinesModeTileLayout(
            this.container.clientWidth,
            this.getTileDimensions().width
        );
        if (columns === this.lastLinesColumnCount) {
            return false;
        }

        this.lastLinesColumnCount = columns;
        this.container.style.setProperty('--tile-columns', String(columns));
        return true;
    }

    private getTileCacheBudgetBytes(): number {
        return APP_SETTINGS.GLYPH_OVERVIEW.TILE_CACHE_MAX_BYTES;
    }

    private isTileInOverscan(
        tile: GlyphTile,
        containerRect?: DOMRect
    ): boolean {
        if (!this.container || !tile.element.isConnected) {
            return false;
        }
        const viewport =
            containerRect ?? this.container.getBoundingClientRect();
        if (viewport.width <= 0 || viewport.height <= 0) {
            return false;
        }
        const tileRect = tile.element.getBoundingClientRect();
        if (tileRect.width <= 0 || tileRect.height <= 0) {
            return false;
        }
        const margin = this.tileCacheViewportMarginPx;
        return (
            tileRect.bottom >= viewport.top - margin &&
            tileRect.top <= viewport.bottom + margin &&
            tileRect.right >= viewport.left - margin &&
            tileRect.left <= viewport.right + margin
        );
    }

    private touchTileViewed(tile: GlyphTile): void {
        this.tileViewClock += 1;
        tile.lastViewedAt = this.tileViewClock;
    }

    private evictTileCache(tile: GlyphTile): void {
        if (tile.canvas) {
            tile.canvas.width = 0;
            tile.canvas.height = 0;
            tile.canvas.style.width = '';
            tile.canvas.style.height = '';
        }
        tile.cachedData = undefined;
    }

    private evictAllTileCaches(): void {
        for (const tile of this.tiles.values()) {
            this.evictTileCache(tile);
        }
    }

    private tileCacheBytes(tile: GlyphTile): number {
        return tile.canvas ? overviewTileCanvasBackingBytes(tile.canvas) : 0;
    }

    private tileHoldsCache(tile: GlyphTile): boolean {
        return Boolean(tile.cachedData) || this.tileCacheBytes(tile) > 0;
    }

    private enforceTileCacheBudget(): void {
        const budget = this.getTileCacheBudgetBytes();
        const cached: GlyphTile[] = [];
        let used = 0;
        for (const tile of this.tiles.values()) {
            if (!this.tileHoldsCache(tile)) {
                continue;
            }
            cached.push(tile);
            used += this.tileCacheBytes(tile);
        }
        if (used <= budget) {
            return;
        }

        cached.sort((a, b) => (a.lastViewedAt ?? 0) - (b.lastViewedAt ?? 0));

        const evictFrom = (candidates: GlyphTile[]) => {
            for (const tile of candidates) {
                if (used <= budget || !this.tileHoldsCache(tile)) {
                    continue;
                }
                used -= this.tileCacheBytes(tile);
                this.evictTileCache(tile);
            }
        };

        evictFrom(cached.filter((tile) => !this.isTileInOverscan(tile)));
        if (used > budget) {
            evictFrom(cached);
        }
    }

    private updateTileSize(): void {
        const columnsForVisibility =
            this.lastLinesColumnCount > 0
                ? this.lastLinesColumnCount
                : Math.max(1, this.getGridColumns());
        const resizeFocusAnchor =
            this.getResizeFocusAnchor(columnsForVisibility);
        this.lastLinesColumnCount = 0;
        this.applyOverviewTileLayout();

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        requestAnimationFrame(() => {
            this.evictAllTileCaches();

            if (this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow(true);
            }

            const queuedVisibleTileCount = this.queueVisibleUncachedTiles();
            if (queuedVisibleTileCount > 0) {
                this.scheduleBatchRender();
            }

            this.applyResizeFocusAnchor(resizeFocusAnchor);
        });
    }

    private getResizeFocusAnchor(
        columnsForVisibility?: number
    ): ResizeFocusAnchor | null {
        const selectedGlyphIds = this.getSelectedGlyphs().filter((glyphId) =>
            this.visibleGlyphIds.includes(glyphId)
        );
        if (selectedGlyphIds.length > 0) {
            return {
                type: 'selection',
                glyphIds: selectedGlyphIds
            };
        }

        const columns = Math.max(
            1,
            columnsForVisibility && columnsForVisibility > 0
                ? columnsForVisibility
                : this.getGridColumns()
        );

        const activeGlyphName = this.getCurrentActiveGlyphName();
        const activeGlyphId = activeGlyphName
            ? this.findVisibleTileIdByGlyphName(activeGlyphName)
            : null;
        if (
            activeGlyphId &&
            this.isGlyphIdInOverviewViewport(activeGlyphId, columns)
        ) {
            return {
                type: 'center',
                glyphId: activeGlyphId
            };
        }

        const viewportGlyphId =
            this.getGlyphIdNearestOverviewViewportCenter(columns);
        if (!viewportGlyphId) {
            return null;
        }

        return {
            type: 'center',
            glyphId: viewportGlyphId
        };
    }

    private findVisibleTileIdByGlyphName(glyphName: string): string | null {
        for (const glyphId of this.visibleGlyphIds) {
            const tile = this.tiles.get(glyphId);
            if (tile?.glyphName === glyphName) {
                return glyphId;
            }
        }
        return null;
    }

    private isGlyphIdInOverviewViewport(
        glyphId: string,
        columns: number
    ): boolean {
        if (!this.container || this.container.clientHeight <= 0) {
            return false;
        }

        const bounds = this.getVisibleGlyphIdsContentBounds([glyphId], columns);
        if (!bounds) {
            return false;
        }

        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;
        return bounds.bottom > viewportTop && bounds.top < viewportBottom;
    }

    private getGlyphIdNearestOverviewViewportCenter(
        columns: number
    ): string | null {
        if (!this.container || this.visibleGlyphIds.length === 0) {
            return null;
        }

        const dims = this.getTileDimensions();
        const rowHeight = dims.height + 2;
        const total = this.visibleGlyphIds.length;
        const totalRows = Math.max(1, Math.ceil(total / columns));
        const centerY =
            this.container.scrollTop + this.container.clientHeight / 2;
        const centerRow = Math.min(
            totalRows - 1,
            Math.max(0, Math.floor(centerY / rowHeight))
        );
        const centerCol = Math.min(columns - 1, Math.floor(columns / 2));
        const index = Math.min(total - 1, centerRow * columns + centerCol);
        return this.visibleGlyphIds[index] ?? null;
    }

    private getCurrentActiveGlyphName(): string | null {
        const glyphCanvas = (window as any).glyphCanvas;
        const isEditMode = glyphCanvas?.outlineEditor?.active;
        if (!isEditMode) {
            return this.highlightedGlyphName;
        }

        if (glyphCanvas?.outlineEditor?.parseGlyphStack) {
            const parsed = glyphCanvas.outlineEditor.parseGlyphStack();
            if (parsed.length > 0) {
                return parsed[parsed.length - 1].glyphName;
            }
        }

        return this.highlightedGlyphName;
    }

    private applyResizeFocusAnchor(anchor: ResizeFocusAnchor | null): void {
        if (!anchor) {
            return;
        }

        if (anchor.type === 'selection') {
            this.ensureGlyphIdsInView(anchor.glyphIds);
            return;
        }

        this.centerGlyphIdsInView([anchor.glyphId]);
    }

    private centerGlyphIdsInView(glyphIds: string[]): void {
        if (!this.container || !glyphIds.length) {
            return;
        }

        const bounds = this.getVisibleGlyphIdsContentBounds(glyphIds);
        if (!bounds) {
            return;
        }

        this.setCenteredScrollTop(bounds.centerY);
    }

    /**
     * Bring selected glyphs into view with minimal disruption:
     * - fully on-screen → no scroll
     * - partially clipped → minimal scroll to reveal
     * - fully off-screen → center
     */
    private ensureGlyphIdsInView(
        glyphIds: string[],
        allowLayoutRetry: boolean = true
    ): void {
        if (!this.container || !glyphIds.length) {
            return;
        }

        if (this.container.clientHeight <= 0) {
            if (allowLayoutRetry) {
                requestAnimationFrame(() => {
                    this.ensureGlyphIdsInView(glyphIds, false);
                });
            }
            return;
        }

        const bounds = this.getVisibleGlyphIdsContentBounds(glyphIds);
        if (!bounds) {
            if (allowLayoutRetry) {
                requestAnimationFrame(() => {
                    this.ensureGlyphIdsInView(glyphIds, false);
                });
            }
            return;
        }

        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;

        if (bounds.top >= viewportTop && bounds.bottom <= viewportBottom) {
            return;
        }

        const fullyOffScreen =
            bounds.bottom <= viewportTop || bounds.top >= viewportBottom;
        if (fullyOffScreen) {
            this.setCenteredScrollTop(bounds.centerY);
            return;
        }

        // Partially clipped: scroll the least amount that reveals the selection.
        let nextScrollTop = viewportTop;
        if (bounds.top < viewportTop) {
            nextScrollTop = bounds.top;
        } else if (bounds.bottom > viewportBottom) {
            nextScrollTop = bounds.bottom - this.container.clientHeight;
        }

        const maxScroll = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight
        );
        this.container.scrollTop = Math.min(
            Math.max(0, nextScrollTop),
            maxScroll
        );
        this.renderVirtualizedLinesWindow(true);
    }

    private getVisibleGlyphIdsContentBounds(
        glyphIds: string[],
        columnsOverride?: number
    ): { top: number; bottom: number; centerY: number } | null {
        // Lines mode: index math is authoritative (DOM rects are often stale
        // right after syncGlyphs reorders tiles and restores scrollTop).
        // Grid mode: rows aren't a flat flow — use mounted tile geometry.
        if (this.viewMode === 'grid') {
            return this.getConnectedTileContentBounds(glyphIds);
        }

        const visibleSelectedGlyphIds = glyphIds.filter((glyphId) =>
            this.visibleGlyphIds.includes(glyphId)
        );
        if (!visibleSelectedGlyphIds.length) {
            return null;
        }

        const visibleIndexes = visibleSelectedGlyphIds
            .map((glyphId) => this.visibleGlyphIds.indexOf(glyphId))
            .filter((index) => index !== -1)
            .sort((a, b) => a - b);
        if (!visibleIndexes.length) {
            return null;
        }

        const dims = this.getTileDimensions();
        const columns = Math.max(
            1,
            columnsOverride && columnsOverride > 0
                ? columnsOverride
                : this.getGridColumns()
        );
        const rowHeight = dims.height + 2;
        const firstRow = Math.floor(visibleIndexes[0] / columns);
        const lastRow = Math.floor(
            visibleIndexes[visibleIndexes.length - 1] / columns
        );
        const top = firstRow * rowHeight;
        const bottom = lastRow * rowHeight + dims.height;
        return {
            top,
            bottom,
            centerY: (top + bottom) / 2
        };
    }

    /**
     * Content-space Y bounds from mounted tile elements (works for grid + lines).
     */
    private getConnectedTileContentBounds(
        glyphIds: string[]
    ): { top: number; bottom: number; centerY: number } | null {
        if (!this.container) {
            return null;
        }

        const containerRect = this.container.getBoundingClientRect();
        if (containerRect.height <= 0) {
            return null;
        }

        let top = Infinity;
        let bottom = -Infinity;
        let found = false;

        for (const glyphId of glyphIds) {
            const tile = this.tiles.get(glyphId);
            const element = tile?.element;
            if (!element?.isConnected || element.style.display === 'none') {
                continue;
            }

            const rect = element.getBoundingClientRect();
            if (rect.height <= 0 || rect.width <= 0) {
                continue;
            }

            const elementTop =
                rect.top - containerRect.top + this.container.scrollTop;
            const elementBottom = elementTop + rect.height;
            top = Math.min(top, elementTop);
            bottom = Math.max(bottom, elementBottom);
            found = true;
        }

        if (!found) {
            return null;
        }

        return {
            top,
            bottom,
            centerY: (top + bottom) / 2
        };
    }

    private setCenteredScrollTop(contentCenterY: number): void {
        if (!this.container) {
            return;
        }

        const targetScroll = Math.max(
            0,
            contentCenterY - this.container.clientHeight / 2
        );
        const maxScroll = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight
        );
        this.container.scrollTop = Math.min(targetScroll, maxScroll);
        this.renderVirtualizedLinesWindow(true);
    }

    public isViewActive(): boolean {
        const overviewView = document.querySelector('#view-overview');
        return overviewView?.classList.contains('focused') ?? false;
    }

    /**
     * Normalize overview glyph records to stable name-keyed ids.
     */
    private normalizeGlyphRecords(
        glyphs: Array<{ id: string; name: string; codepoints?: number[] }>
    ): Array<{ id: string; name: string; codepoints?: number[] }> {
        return glyphs
            .map((glyph) => {
                const name =
                    typeof glyph.name === 'string' && glyph.name.length > 0
                        ? glyph.name
                        : typeof glyph.id === 'string'
                          ? glyph.id
                          : '';
                return {
                    id: name,
                    name,
                    ...(Array.isArray(glyph.codepoints)
                        ? { codepoints: glyph.codepoints }
                        : {})
                };
            })
            .filter((glyph) => glyph.name.length > 0);
    }

    /**
     * Incrementally sync the overview tile list to the font glyph order.
     * Reuses existing tiles (and cached outlines) keyed by glyph name; only
     * creates/removes tiles that changed. Preserves scrollTop.
     */
    public syncGlyphs(
        glyphs: Array<{ id: string; name: string }>
    ): Promise<void> {
        if (!this.container) {
            return Promise.resolve();
        }

        const nextGlyphs = this.normalizeGlyphRecords(glyphs);
        this.catalogCodepointsByName = null;
        const fontKey = this.overviewFontIdentityKey();
        if (
            this.tiles.size === 0 ||
            (this.lastOverviewFontKey && this.lastOverviewFontKey !== fontKey)
        ) {
            return this.updateGlyphs(nextGlyphs);
        }

        // Migrate off legacy index-based tile ids with one full rebuild.
        for (const tile of this.tiles.values()) {
            if (tile.glyphId !== tile.glyphName) {
                return this.updateGlyphs(nextGlyphs);
            }
        }

        const savedScrollTop = this.container.scrollTop;
        const nextIds = nextGlyphs.map((glyph) => glyph.id);
        const nextIdSet = new Set(nextIds);
        const previousIds = [...this.glyphOrderIds];
        const removedIds: string[] = [];
        const addedIds: string[] = [];

        for (const previousId of previousIds) {
            if (nextIdSet.has(previousId)) {
                continue;
            }
            const tile = this.tiles.get(previousId);
            if (tile) {
                this.intersectionObserver?.unobserve(tile.element);
                tile.element.remove();
                this.tiles.delete(previousId);
            }
            this.pendingGlyphIds.delete(previousId);
            removedIds.push(previousId);
        }

        this.totalGlyphDatasetCount = nextGlyphs.length;
        this.glyphOrderIds = nextIds;
        this.glyphDataById = new Map(
            nextGlyphs.map((glyph) => [glyph.id, glyph])
        );

        for (const glyph of nextGlyphs) {
            if (this.tiles.has(glyph.id)) {
                continue;
            }
            const tile = this.createGlyphTile(glyph.id, glyph.name);
            this.tiles.set(glyph.id, tile);
            if (this.isGlyphHydrated(glyph.name)) {
                this.pendingGlyphIds.add(glyph.id);
            } else {
                this.applyUnhydratedTileAppearance(tile);
            }
            addedIds.push(glyph.id);
        }

        // Reconcile visibility + DOM from font order (not Map insertion order).
        this.visibleGlyphIds =
            this.searchTerms.length === 0 && this.activeFilterResults === null
                ? [...this.glyphOrderIds]
                : this.computeVisibleGlyphIds();
        this.renderByViewMode();

        if (this.intersectionObserver) {
            for (const id of addedIds) {
                const tile = this.tiles.get(id);
                if (tile?.element.isConnected) {
                    this.intersectionObserver.observe(tile.element);
                }
            }
        }

        this.container.scrollTop = savedScrollTop;

        if (addedIds.length > 0) {
            this.scheduleBatchRender();
        }

        this.reconcileSelectionAfterGlyphSync();

        if (removedIds.length > 0 || addedIds.length > 0) {
            console.log(
                `Synced overview glyphs (+${addedIds.length} / -${removedIds.length}, reused ${this.tiles.size - addedIds.length})`
            );
        }

        return Promise.resolve();
    }

    /** Keep selection visibility consistent after either incremental or full sync. */
    private reconcileSelectionAfterGlyphSync(): void {
        if (this.applyPendingGlyphSelection()) {
            // Paste/duplicate: force-center the new glyph after the overview
            // has rebuilt its DOM and restored the previous scroll position.
            this.forceRevealSelectedGlyphs();
            return;
        }

        // Concurrent identity sync: keep an existing selection visible.
        this.scheduleSelectedGlyphsReveal();
    }

    public updateGlyphs(
        glyphs: Array<{ id: string; name: string }>
    ): Promise<void> {
        if (!this.container) return Promise.resolve();

        glyphs = this.normalizeGlyphRecords(glyphs);
        this.catalogCodepointsByName = null;
        this.lastOverviewFontKey = this.overviewFontIdentityKey();

        this.totalGlyphDatasetCount = glyphs.length;
        this.glyphOrderIds = glyphs.map((glyph) => glyph.id);
        this.glyphDataById = new Map(glyphs.map((glyph) => [glyph.id, glyph]));

        if (this.updateGlyphsSpanId) {
            timelineSpanEnd(this.updateGlyphsSpanId);
            this.updateGlyphsSpanId = null;
        }

        this.updateGlyphsSpanId = timelineSpanStart('overview.updateGlyphs', {
            glyphCount: glyphs.length
        });

        if (this.tileBuildResolve) {
            this.tileBuildResolve();
            this.tileBuildResolve = null;
        }

        this.tileBuildPromise = new Promise<void>((resolve) => {
            this.tileBuildResolve = resolve;
        });

        if (this.deferredTileBuildTimer !== null) {
            clearTimeout(this.deferredTileBuildTimer);
            this.deferredTileBuildTimer = null;
        }

        this.tileBuildRunId += 1;
        const currentBuildRunId = this.tileBuildRunId;

        const finishBuild = () => {
            if (currentBuildRunId !== this.tileBuildRunId) {
                return;
            }

            this.applySearchFilter();

            if (this.updateGlyphsSpanId) {
                timelineSpanEnd(this.updateGlyphsSpanId);
                this.updateGlyphsSpanId = null;
            }

            if (this.tileBuildResolve) {
                this.tileBuildResolve();
                this.tileBuildResolve = null;
            }

            this.reconcileSelectionAfterGlyphSync();
        };

        // Clear existing tiles
        this.container.innerHTML = '';
        this.tiles.clear();
        this.pendingGlyphIds.clear();

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        const totalGlyphs = glyphs.length;
        if (totalGlyphs === 0) {
            finishBuild();
            return this.tileBuildPromise;
        }

        // Small fonts: build synchronously for immediate interaction.
        if (totalGlyphs <= 1000) {
            const fragment = document.createDocumentFragment();
            glyphs.forEach((glyph) => {
                const tile = this.createGlyphTile(glyph.id, glyph.name);
                this.tiles.set(glyph.id, tile);
                fragment.appendChild(tile.element);
            });
            this.container.appendChild(fragment);
            finishBuild();
            return this.tileBuildPromise;
        }

        const buildVirtualizedOnly =
            totalGlyphs >= this.linesVirtualizationThreshold;

        // Large fonts: create tile objects in chunks. When virtualization is
        // active, do not attach all tiles to DOM (windowed mount handles that).
        const initialVisibleTarget = Math.min(totalGlyphs, 720);
        let initialChunkReady = false;

        const buildChunk = (startIndex: number) => {
            if (!this.container || currentBuildRunId !== this.tileBuildRunId) {
                return;
            }

            const chunkSize =
                totalGlyphs > 5000 ? 80 : totalGlyphs > 2500 ? 100 : 120;
            const endIndex = Math.min(startIndex + chunkSize, totalGlyphs);
            const shouldAttachChunk =
                !buildVirtualizedOnly || !initialChunkReady;
            const fragment = shouldAttachChunk
                ? document.createDocumentFragment()
                : null;
            const attachedTiles: GlyphTile[] = [];

            for (let index = startIndex; index < endIndex; index += 1) {
                const glyph = glyphs[index];
                let tile = this.tiles.get(glyph.id);
                if (!tile) {
                    tile = this.createGlyphTile(glyph.id, glyph.name);
                    this.tiles.set(glyph.id, tile);
                }
                if (fragment) {
                    fragment.appendChild(tile.element);
                }
                attachedTiles.push(tile);
            }

            if (fragment) {
                this.container.appendChild(fragment);
            }

            if (this.intersectionObserver && shouldAttachChunk) {
                attachedTiles.forEach((tile) => {
                    this.intersectionObserver!.observe(tile.element);
                });
            }

            if (
                buildVirtualizedOnly &&
                !initialChunkReady &&
                endIndex >= initialVisibleTarget
            ) {
                initialChunkReady = true;
                finishBuild();
            }

            if (buildVirtualizedOnly && this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow(true);
            }

            if (endIndex < totalGlyphs) {
                this.deferredTileBuildTimer = window.setTimeout(() => {
                    this.deferredTileBuildTimer = null;
                    requestAnimationFrame(() => buildChunk(endIndex));
                }, 0);
                return;
            }

            if (!initialChunkReady) {
                initialChunkReady = true;
                finishBuild();
            } else {
                // Glyphs added after the interaction-ready chunk were not in
                // the first pending-selection pass. Render the completed list,
                // then resolve and reveal them once their tiles exist.
                this.applySearchFilter();
                this.reconcileSelectionAfterGlyphSync();
            }
        };

        requestAnimationFrame(() => buildChunk(0));

        return this.tileBuildPromise;
    }

    /**
     * Allow/deny glyph-outline paints. Kept off during font open so only the
     * forced fontReady path paints once at the final location.
     */
    public setOutlinePaintAllowed(allowed: boolean): void {
        this.outlinePaintAllowed = allowed;
    }

    /** @deprecated Use setOutlinePaintAllowed */
    public setLocationDrivenRendersEnabled(enabled: boolean): void {
        this.setOutlinePaintAllowed(enabled);
    }

    /**
     * Render glyph outlines at a specific location in designspace
     * @param location - Axis location object, e.g., { wght: 400 }. Empty object uses default location.
     */
    public async renderGlyphOutlines(
        location: Record<string, number> = {},
        options?: { force?: boolean }
    ): Promise<void> {
        if (!this.container) {
            console.warn('[GlyphOverview]', 'No container, cannot render');
            return;
        }

        if (!this.outlinePaintAllowed && !options?.force) {
            return;
        }

        const renderGeneration = ++this.outlineRenderGeneration;

        await this.tileBuildPromise;
        if (renderGeneration !== this.outlineRenderGeneration) {
            return;
        }

        this.currentLocation = { ...location };

        // Invalidate cached outline data so tiles re-fetch at the new location
        this.tiles.forEach((tile) => {
            tile.cachedData = undefined;
        });
        this.pendingGlyphIds.clear();

        // Cache metrics from font model for consistent tile sizing
        this.updateRenderMetrics();

        const glyphCount = this.tiles.size;

        const totalSpanId = timelineSpanStart('overview.renderGlyphOutlines', {
            glyphCount
        });

        // Use lazy loading for all fonts for consistent behavior.
        this.lazyLoadEnabled = true;
        this.setupLazyLoading();

        // Prime initial visible tiles immediately so first render is not empty
        // when screenshots/tests run right after open.
        let primedCount = this.queueVisibleUncachedTiles();
        if (primedCount === 0) {
            primedCount = this.primeInitialVisibleTileBatch();
        }
        if (primedCount > 0) {
            // Wait out any superseded in-flight batch so we don't skip priming.
            while (
                this.isBatchRendering &&
                renderGeneration === this.outlineRenderGeneration
            ) {
                await new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                });
            }
            if (renderGeneration !== this.outlineRenderGeneration) {
                timelineSpanEnd(totalSpanId);
                return;
            }
            await this.processBatchRender(renderGeneration);
        }

        timelineSpanEnd(totalSpanId);
    }

    private primeInitialVisibleTileBatch(): number {
        if (!this.container) {
            return 0;
        }

        const maxInitialTiles = 480;
        let queued = 0;

        this.tiles.forEach((tile, glyphId) => {
            if (queued >= maxInitialTiles) {
                return;
            }

            if (!tile.element.isConnected) {
                return;
            }

            if (tile.cachedData) {
                return;
            }
            if (!this.isGlyphHydrated(tile.glyphName)) {
                this.applyUnhydratedTileAppearance(tile);
                return;
            }

            this.pendingGlyphIds.add(glyphId);
            queued += 1;
        });

        return queued;
    }

    private async renderOutlinesInChunks(
        outlines: any[],
        glyphNames: string[],
        dims: { width: number; height: number }
    ): Promise<void> {
        const chunkSize = 48;

        const glyphNameToTile = new Map<string, GlyphTile>();
        this.tiles.forEach((tile) => {
            glyphNameToTile.set(tile.glyphName, tile);
        });

        await new Promise<void>((resolve) => {
            let index = 0;
            let chunkIndex = 0;

            const renderChunk = () => {
                const end = Math.min(index + chunkSize, outlines.length);
                const frameSpanId = timelineSpanStart(
                    'overview.outlines.renderChunkFrame',
                    {
                        chunkIndex,
                        startIndex: index,
                        endIndex: end,
                        count: end - index,
                        mode: 'initial'
                    }
                );

                for (let i = index; i < end; i += 1) {
                    const glyphData = outlines[i];
                    const glyphName = glyphData?.name;
                    let tile = glyphName
                        ? glyphNameToTile.get(glyphName)
                        : undefined;
                    if (!tile && glyphNames[i]) {
                        tile = glyphNameToTile.get(glyphNames[i]);
                    }
                    if (!tile) {
                        continue;
                    }

                    const rendered = this.renderTileCanvas(
                        tile,
                        glyphData,
                        dims.width,
                        dims.height
                    );
                    if (rendered) {
                        tile.cachedData = glyphData;
                    }
                }

                index = end;
                chunkIndex += 1;
                timelineSpanEnd(frameSpanId);

                if (index < outlines.length) {
                    requestAnimationFrame(renderChunk);
                } else {
                    this.enforceTileCacheBudget();
                    resolve();
                }
            };

            requestAnimationFrame(renderChunk);
        });
    }

    /**
     * Update cached render metrics from font model
     */
    private updateRenderMetrics(): void {
        const font = (window as any).currentFontModel;
        if (!font) {
            this.renderMetrics = null;
            return;
        }

        const upm = font.upm || 1000;
        // Default ascender/descender fallback from UPM
        let fallbackAscender = upm * 0.8;
        let fallbackDescender = -(upm * 0.2);

        const customParams = font.custom_opentype_values || [];
        if (Array.isArray(customParams)) {
            const hheaAsc = customParams.find(
                (entry: any) => entry?.name === 'hheaAscender'
            )?.value;
            const hheaDesc = customParams.find(
                (entry: any) => entry?.name === 'hheaDescender'
            )?.value;
            if (typeof hheaAsc === 'number' && Number.isFinite(hheaAsc)) {
                fallbackAscender = hheaAsc;
            }
            if (typeof hheaDesc === 'number' && Number.isFinite(hheaDesc)) {
                fallbackDescender = hheaDesc;
            }
        }

        let ascender = fallbackAscender;
        let descender = fallbackDescender;

        // Try to get metrics from first master
        const master = font.masters?.[0];
        if (master?.metrics) {
            // Look for Ascender/Descender in metrics (case may vary)
            const metrics = master.metrics;
            if (
                metrics.Ascender !== undefined &&
                Number.isFinite(metrics.Ascender)
            ) {
                ascender = metrics.Ascender;
            } else if (
                metrics.ascender !== undefined &&
                Number.isFinite(metrics.ascender)
            ) {
                ascender = metrics.ascender;
            }
            if (
                metrics.Descender !== undefined &&
                Number.isFinite(metrics.Descender)
            ) {
                descender = metrics.Descender;
            } else if (
                metrics.descender !== undefined &&
                Number.isFinite(metrics.descender)
            ) {
                descender = metrics.descender;
            }
        }

        const metricsHeight = ascender - descender;
        const minExpectedHeight = upm * 0.5;
        const maxExpectedHeight = upm * 2.0;
        if (
            !Number.isFinite(metricsHeight) ||
            metricsHeight < minExpectedHeight ||
            metricsHeight > maxExpectedHeight
        ) {
            ascender = fallbackAscender;
            descender = fallbackDescender;
        }

        this.renderMetrics = { ascender, descender, upm };
    }

    /**
     * Render glyph data to tile's pre-existing canvas (no DOM manipulation)
     */
    private renderTileCanvas(
        tile: GlyphTile,
        glyphData: any,
        width?: number,
        height?: number
    ): boolean {
        // Use provided dimensions or get current size
        const dims =
            width && height ? { width, height } : this.getTileDimensions();

        // Render directly to the tile's pre-existing canvas
        if (tile.canvas) {
            try {
                fastGlyphTileRenderer.renderToCanvas(
                    glyphData,
                    this.renderMetrics || undefined,
                    dims.width,
                    dims.height,
                    tile.canvas
                );
                this.touchTileViewed(tile);
                return true;
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.warn(
                    `[GlyphOverview] Failed to render tile ${tile.glyphName}: ${message}`
                );
                return false;
            }
        }

        return false;
    }

    /**
     * Legacy renderTile for compatibility - updates cache and calls renderTileCanvas
     */
    private renderTile(
        tile: GlyphTile,
        glyphData: any,
        width?: number,
        height?: number
    ): void {
        const rendered = this.renderTileCanvas(tile, glyphData, width, height);
        if (rendered) {
            // Cache data for future resizing
            tile.cachedData = glyphData;
        }
    }

    /**
     * Handle glyph change events - re-render the affected tile
     */
    private async onGlyphChanged(event: Event): Promise<void> {
        const detail = (event as CustomEvent).detail;
        const forceImmediateRefresh = detail?.forceImmediateRefresh === true;
        const glyphNames = Array.isArray(detail?.glyphNames)
            ? detail.glyphNames.filter(
                  (glyphName: unknown): glyphName is string =>
                      typeof glyphName === 'string' && glyphName.length > 0
              )
            : typeof detail?.glyphName === 'string' && detail.glyphName.length
              ? [detail.glyphName]
              : [];
        if (!glyphNames.length) {
            return;
        }

        let queuedAnyGlyph = false;
        const immediateGlyphNames = new Set<string>();

        for (const glyphName of glyphNames) {
            let targetTile: GlyphTile | undefined;
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    targetTile = tile;
                    break;
                }
            }

            if (!targetTile) {
                continue;
            }

            if (this.isGlyphHydrated(glyphName)) {
                this.applyHydratedTileAppearance(targetTile);
            }
            targetTile.cachedData = undefined;
            if (forceImmediateRefresh) {
                immediateGlyphNames.add(glyphName);
                this.pendingChangedGlyphNames.delete(glyphName);
            } else {
                this.pendingChangedGlyphNames.add(glyphName);
            }
            queuedAnyGlyph = true;
        }

        if (!queuedAnyGlyph) {
            return;
        }

        const selectedNames = new Set(this.getSelectedGlyphNames());
        if (glyphNames.some((name: string) => selectedNames.has(name))) {
            this.updatePropertyPanel();
        }

        if (forceImmediateRefresh) {
            void this.refreshChangedGlyphTiles(Array.from(immediateGlyphNames));
            return;
        }

        this.schedulePendingChangedGlyphRefresh();
    }

    /**
     * Handle glyph stack change events for immediate highlight updates
     */
    private onGlyphStackChanged(event: Event): void {
        const detail = (event as CustomEvent).detail;
        const glyphStack = detail?.glyphStack;
        if (!glyphStack) {
            this.setEditingHighlight(null);
            return;
        }

        this.syncActiveGlyphFocus();
    }

    public syncActiveGlyphFocus(options?: { forceScroll?: boolean }): void {
        const glyphCanvas = (window as any).glyphCanvas;
        const isEditMode = glyphCanvas?.outlineEditor?.active;

        if (!isEditMode) {
            // In text mode, don't show the editing border
            this.setEditingHighlight(null);
            return;
        }

        // Parse the stack to get the last glyph (deepest component being edited)
        if (glyphCanvas?.outlineEditor?.parseGlyphStack) {
            const parsed = glyphCanvas.outlineEditor.parseGlyphStack();
            if (parsed.length > 0) {
                const stackedGlyphName = parsed[parsed.length - 1].glyphName;
                const editingGlyph =
                    glyphCanvas.outlineEditor.getAuthoringGlyphName?.(
                        stackedGlyphName
                    ) ?? stackedGlyphName;
                // Scrolls when the editing glyph name changes, or when
                // forceScroll is set (overview open/render after URL edit restore).
                this.setEditingHighlight(editingGlyph, options);
            } else {
                this.setEditingHighlight(null);
            }
        }
    }

    /**
     * Handle mode changes to clear border when switching to text mode
     */
    private onModeChanged(event: Event): void {
        const detail = (event as CustomEvent).detail;
        const mode = detail?.mode;

        if (mode === 'text') {
            // Clear editing highlight when switching to text mode
            this.setEditingHighlight(null);
            this.schedulePendingChangedGlyphRefresh(true);
        }
    }

    private isOutlineDragActive(): boolean {
        return !!(window as any).glyphCanvas?.outlineEditor?.draggingSomething;
    }

    private schedulePendingChangedGlyphRefresh(forceImmediate = false): void {
        if (this.pendingChangedGlyphRefreshTimer !== null) {
            clearTimeout(this.pendingChangedGlyphRefreshTimer);
        }

        const delay = forceImmediate
            ? 0
            : this.isOutlineDragActive()
              ? this.activeDragGlyphRefreshDelayMs
              : this.deferredGlyphRefreshDelayMs;

        this.pendingChangedGlyphRefreshTimer = window.setTimeout(() => {
            this.pendingChangedGlyphRefreshTimer = null;

            if (!forceImmediate && this.isOutlineDragActive()) {
                this.schedulePendingChangedGlyphRefresh();
                return;
            }

            void this.flushPendingChangedGlyphRefreshes();
        }, delay);
    }

    private async flushPendingChangedGlyphRefreshes(): Promise<void> {
        if (!this.pendingChangedGlyphNames.size) {
            return;
        }

        const glyphNames = Array.from(this.pendingChangedGlyphNames);
        this.pendingChangedGlyphNames.clear();
        await this.refreshChangedGlyphTiles(glyphNames);
    }

    private async refreshChangedGlyphTiles(
        glyphNames: string[]
    ): Promise<void> {
        if (!glyphNames.length) {
            return;
        }

        const glyphNameToTile: Map<string, GlyphTile> = new Map();
        for (const glyphName of glyphNames) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    glyphNameToTile.set(glyphName, tile);
                    break;
                }
            }
        }

        const refreshGlyphNames = Array.from(glyphNameToTile.keys());

        if (!refreshGlyphNames.length) {
            return;
        }

        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                return;
            }

            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: refreshGlyphNames,
                location: this.currentLocation,
                flattenComponents: false
            });

            if (response.error) {
                console.error(
                    '[GlyphOverview]',
                    'Failed to refresh changed glyph tiles:',
                    response.error
                );
                return;
            }

            const outlines = JSON.parse(response.outlinesJson || '[]');
            if (!Array.isArray(outlines) || !outlines.length) {
                return;
            }

            const dims = this.getTileDimensions();
            for (const outline of outlines) {
                if (!outline?.name) {
                    continue;
                }

                const tile = glyphNameToTile.get(outline.name);
                if (!tile) {
                    continue;
                }

                this.renderTile(tile, outline, dims.width, dims.height);
            }
        } catch (error) {
            console.error(
                '[GlyphOverview]',
                'Error refreshing changed glyph tiles:',
                error
            );
        }
    }

    /**
     * Handle theme changes to re-render tiles with new colors
     */
    private onThemeChanged(): void {
        // Update theme colors in renderer
        fastGlyphTileRenderer.updateThemeColors();

        // Re-render all tiles with cached data in a single frame
        const dims = this.getTileDimensions();
        requestAnimationFrame(() => {
            this.tiles.forEach((tile) => {
                if (tile.cachedData) {
                    this.renderTileCanvas(
                        tile,
                        tile.cachedData,
                        dims.width,
                        dims.height
                    );
                }
            });
            this.enforceTileCacheBudget();
        });
    }

    /**
     * Set the editing highlight on a specific glyph tile.
     * Optionally scrolls into view when the highlighted glyph changes, if
     * Editing View → View → Scroll Overview to Active Glyph is enabled.
     * Pass forceScroll after overview open/render so a glyph already marked
     * during URL edit-mode restore still scrolls once tiles exist.
     */
    private setEditingHighlight(
        glyphName: string | null,
        options?: { forceScroll?: boolean }
    ): void {
        const forceScroll = options?.forceScroll === true;

        if (glyphName === this.highlightedGlyphName) {
            if (!glyphName) {
                return;
            }

            for (const tile of this.tiles.values()) {
                if (tile.glyphName !== glyphName) {
                    continue;
                }

                tile.element.style.boxShadow =
                    'inset 0 0 0 2px var(--accent-blue)';
                if (forceScroll && isOverviewFollowStackScrollEnabled()) {
                    this.scheduleHighlightedGlyphVisibilitySync();
                }
                return;
            }

            return;
        }

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        // Remove highlight from previous tile
        if (this.highlightedGlyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === this.highlightedGlyphName) {
                    tile.element.style.boxShadow = '';
                    break;
                }
            }
        }

        // Add highlight to new tile; optionally scroll when the preference is on
        this.highlightedGlyphName = glyphName;
        if (glyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    tile.element.style.boxShadow =
                        'inset 0 0 0 2px var(--accent-blue)';
                    if (isOverviewFollowStackScrollEnabled()) {
                        this.scheduleHighlightedGlyphVisibilitySync();
                    }
                    break;
                }
            }
        }
    }

    private scheduleHighlightedGlyphVisibilitySync(): void {
        if (!this.highlightedGlyphName || !this.container) {
            return;
        }

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        const syncStep = () => {
            if (!this.highlightedGlyphName || !this.container) {
                this.highlightScrollSyncRafId = null;
                return;
            }

            let highlightedTile: GlyphTile | null = null;
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === this.highlightedGlyphName) {
                    highlightedTile = tile;
                    break;
                }
            }

            if (!highlightedTile) {
                this.highlightScrollSyncRafId = null;
                return;
            }

            if (!this.isTileFullyVisible(highlightedTile.element)) {
                this.scrollToTile(highlightedTile.element);
            }

            this.highlightScrollSyncAttempts += 1;
            if (
                this.highlightScrollSyncAttempts <
                this.maxHighlightScrollSyncAttempts
            ) {
                this.highlightScrollSyncRafId = requestAnimationFrame(syncStep);
                return;
            }

            this.highlightScrollSyncRafId = null;
        };

        this.highlightScrollSyncRafId = requestAnimationFrame(syncStep);
    }

    private isTileFullyVisible(element: HTMLElement): boolean {
        if (!this.container || !element.isConnected) {
            return false;
        }

        const containerRect = this.container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        if (
            containerRect.height <= 0 ||
            elementRect.height <= 0 ||
            elementRect.width <= 0
        ) {
            return false;
        }

        return (
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom
        );
    }

    /**
     * Fast smooth scroll to tile element
     */
    private scrollToTile(element: HTMLElement, animate: boolean = true): void {
        if (!this.container) return;

        const glyphId = element.dataset.glyphId;

        // If the tile isn't mounted (or has no measurable box yet), use index-based
        // scrolling to avoid bad geometry reads that can jump to the top.
        if (!element.isConnected) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
            }
            return;
        }

        if (this.container.clientHeight <= 0) {
            return;
        }

        if (this.linesVirtualizationActive) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
                return;
            }
        }

        const containerRect = this.container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        if (
            containerRect.height <= 0 ||
            elementRect.height <= 0 ||
            elementRect.width <= 0
        ) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
            }
            return;
        }

        // Check if element is already fully visible
        if (
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom
        ) {
            return;
        }

        // Calculate target scroll position
        const elementTop =
            elementRect.top - containerRect.top + this.container.scrollTop;
        const targetScroll =
            elementTop - containerRect.height / 2 + elementRect.height / 2;

        if (!animate) {
            const maxScroll = Math.max(
                0,
                this.container.scrollHeight - this.container.clientHeight
            );
            this.container.scrollTop = Math.min(
                Math.max(0, targetScroll),
                maxScroll
            );
            this.renderVirtualizedLinesWindow(true);
            return;
        }

        // Animate scroll with 150ms duration
        const startScroll = this.container.scrollTop;
        const distance = targetScroll - startScroll;
        const duration = 150;
        const startTime = performance.now();

        const animateScroll = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out quad
            const eased = 1 - (1 - progress) * (1 - progress);
            this.container!.scrollTop = startScroll + distance * eased;
            if (progress < 1) {
                requestAnimationFrame(animateScroll);
            }
        };

        requestAnimationFrame(animateScroll);
    }

    private scrollToGlyphId(
        glyphId: string,
        forceCenter: boolean = false
    ): void {
        if (!this.container) return;
        if (this.container.clientHeight <= 0) return;

        // Grid mode lays tiles out as a base×variant table, not a flat flow,
        // so flat index→row math lands at the wrong scroll position. Fall back
        // to mounted-tile geometry, which is authoritative in grid mode.
        if (this.viewMode === 'grid') {
            this.centerGlyphIdsInView([glyphId]);
            return;
        }

        const index = this.visibleGlyphIds.indexOf(glyphId);
        if (index === -1) return;

        const dims = this.getTileDimensions();
        const columns = Math.max(1, this.getGridColumns());
        const row = Math.floor(index / columns);
        const rowHeight = dims.height + 2;
        const tileTop = row * rowHeight;
        const tileBottom = tileTop + dims.height;
        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;

        if (
            !forceCenter &&
            tileTop >= viewportTop &&
            tileBottom <= viewportBottom
        ) {
            return;
        }

        const targetScroll = Math.max(
            0,
            tileTop - this.container.clientHeight / 2 + dims.height / 2
        );
        const maxScroll = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight
        );
        this.container.scrollTop = Math.min(targetScroll, maxScroll);
        this.renderVirtualizedLinesWindow(true);
    }

    private setupLazyLoading(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }

        this.intersectionObserver = new IntersectionObserver(
            (entries) => {
                let addedCount = 0;
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        const glyphId = (entry.target as HTMLElement).dataset
                            .glyphId;
                        if (glyphId) {
                            const tile = this.tiles.get(glyphId);
                            if (tile) {
                                this.touchTileViewed(tile);
                            }
                            // Only add if not already rendered (check for cachedData instead of canvas presence)
                            if (
                                tile &&
                                !tile.cachedData &&
                                this.isGlyphHydrated(tile.glyphName)
                            ) {
                                this.pendingGlyphIds.add(glyphId);
                                addedCount++;
                            }
                        }
                    }
                });
                this.enforceTileCacheBudget();
                if (addedCount > 0) {
                    this.scheduleBatchRender();
                }
            },
            { root: this.container, rootMargin: '100px' }
        );

        // Observe all tiles
        this.tiles.forEach((tile) => {
            this.intersectionObserver!.observe(tile.element);
        });
    }

    private scheduleBatchRender(): void {
        // Debounce: wait 16ms (one frame) to collect more tiles before rendering
        if (this.batchDebounceTimer !== null) {
            return; // Already scheduled
        }
        this.batchDebounceTimer = window.setTimeout(() => {
            this.batchDebounceTimer = null;
            this.processBatchRender();
        }, 16);
    }

    private async processBatchRender(
        renderGeneration: number = this.outlineRenderGeneration
    ): Promise<void> {
        if (this.isBatchRendering || this.pendingGlyphIds.size === 0) {
            return;
        }

        if (renderGeneration !== this.outlineRenderGeneration) {
            return;
        }

        const batchSpanId = timelineSpanStart(
            'overview.outlines.processBatchRender',
            {
                pendingCount: this.pendingGlyphIds.size,
                batchSize: this.lazyBatchSize
            }
        );

        this.isBatchRendering = true;
        const batchLocation = { ...this.currentLocation };

        const batchSize = this.lazyBatchSize;
        const glyphIds = Array.from(this.pendingGlyphIds).slice(0, batchSize);
        glyphIds.forEach((id) => this.pendingGlyphIds.delete(id));

        // Build glyph name list
        const glyphNames: string[] = [];
        const glyphNameToTile: Map<string, GlyphTile> = new Map();
        for (const glyphId of glyphIds) {
            const tile = this.tiles.get(glyphId);
            // Check cachedData instead of canvas presence (canvas is now pre-created)
            if (tile && !tile.cachedData) {
                if (!this.isGlyphHydrated(tile.glyphName)) {
                    this.applyUnhydratedTileAppearance(tile);
                    continue;
                }
                glyphNames.push(tile.glyphName);
                glyphNameToTile.set(tile.glyphName, tile);
            }
        }

        if (glyphNames.length === 0) {
            this.isBatchRendering = false;
            if (
                this.pendingGlyphIds.size > 0 &&
                renderGeneration === this.outlineRenderGeneration
            ) {
                this.scheduleBatchRender();
            }
            timelineSpanEnd(batchSpanId);
            return;
        }

        const fontComp = window.fontCompilation;
        try {
            if (!fontComp) {
                throw new Error('fontCompilation not available on window');
            }
            const fetchBatchSpanId = timelineSpanStart(
                'overview.outlines.fetchBatch',
                {
                    glyphCount: glyphNames.length
                }
            );
            let response;
            try {
                response = await fontComp.sendMessage({
                    type: 'getGlyphOutlines',
                    glyphNames: glyphNames,
                    location: batchLocation,
                    flattenComponents: false // Don't flatten - preserve component structure with layerData
                });
            } finally {
                timelineSpanEnd(fetchBatchSpanId);
            }

            if (renderGeneration !== this.outlineRenderGeneration) {
                return;
            }

            if (response.error) {
                throw new Error(response.error);
            }

            const parseBatchSpanId = timelineSpanStart(
                'overview.outlines.parseBatch',
                {
                    jsonBytes: response.outlinesJson.length,
                    glyphCount: glyphNames.length
                }
            );
            let outlines;
            try {
                outlines = JSON.parse(response.outlinesJson);
            } finally {
                timelineSpanEnd(parseBatchSpanId);
            }

            if (renderGeneration !== this.outlineRenderGeneration) {
                return;
            }

            // Batch all renders in a single animation frame
            const dims = this.getTileDimensions();
            let renderDurationMs = 0;
            const renderBatchSpanId = timelineSpanStart(
                'overview.outlines.renderBatch',
                {
                    glyphCount: outlines.length
                }
            );
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    if (renderGeneration !== this.outlineRenderGeneration) {
                        resolve();
                        return;
                    }

                    const renderBatchFrameSpanId = timelineSpanStart(
                        'overview.outlines.renderBatchFrame',
                        {
                            glyphCount: outlines.length
                        }
                    );
                    const renderStart = performance.now();
                    outlines.forEach((glyphData: any) => {
                        const tile = glyphNameToTile.get(glyphData.name);
                        if (!tile) {
                            return;
                        }

                        const rendered = this.renderTileCanvas(
                            tile,
                            glyphData,
                            dims.width,
                            dims.height
                        );
                        if (rendered) {
                            tile.cachedData = glyphData; // Cache for resizing
                        } else {
                            this.pendingGlyphIds.add(tile.glyphId);
                        }
                    });

                    renderDurationMs = performance.now() - renderStart;
                    this.enforceTileCacheBudget();
                    timelineSpanEnd(renderBatchFrameSpanId);
                    resolve();
                });
            });
            timelineSpanEnd(renderBatchSpanId);

            if (renderGeneration !== this.outlineRenderGeneration) {
                return;
            }

            const returnedNames = new Set(
                (Array.isArray(outlines) ? outlines : []).map(
                    (glyphData: { name?: string }) => glyphData?.name
                )
            );
            const omitted = glyphNames.filter(
                (glyphName) => !returnedNames.has(glyphName)
            );
            if (omitted.length && fontComp) {
                for (const glyphName of omitted) {
                    const tile = glyphNameToTile.get(glyphName);
                    if (!tile || tile.cachedData) {
                        continue;
                    }
                    try {
                        const single = await fontComp.sendMessage({
                            type: 'getGlyphOutlines',
                            glyphNames: [glyphName],
                            location: batchLocation,
                            flattenComponents: false
                        });
                        if (single?.error) {
                            console.warn(
                                `[GlyphOverview] Failed to render tile ${glyphName}: ${single.error}`
                            );
                            continue;
                        }
                        const singleOutlines = JSON.parse(
                            single.outlinesJson || '[]'
                        );
                        const glyphData = Array.isArray(singleOutlines)
                            ? singleOutlines[0]
                            : null;
                        if (!glyphData) {
                            continue;
                        }
                        const dims = this.getTileDimensions();
                        if (
                            this.renderTileCanvas(
                                tile,
                                glyphData,
                                dims.width,
                                dims.height
                            )
                        ) {
                            tile.cachedData = glyphData;
                        }
                    } catch (inner) {
                        const innerMsg =
                            inner instanceof Error
                                ? inner.message
                                : String(inner);
                        console.warn(
                            `[GlyphOverview] Failed to render tile ${glyphName}: ${innerMsg}`
                        );
                    }
                }
            }

            if (renderDurationMs > 18) {
                this.lazyBatchSize = Math.max(
                    this.minLazyBatchSize,
                    Math.floor(this.lazyBatchSize * 0.8)
                );
            } else if (renderDurationMs < 8) {
                this.lazyBatchSize = Math.min(
                    this.maxLazyBatchSize,
                    Math.ceil(this.lazyBatchSize * 1.15)
                );
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[GlyphOverview]', `Batch render failed: ${msg}`);
            if (glyphNames.length > 1 && fontComp) {
                for (const glyphName of glyphNames) {
                    const tile = glyphNameToTile.get(glyphName);
                    if (!tile || tile.cachedData) {
                        continue;
                    }
                    try {
                        const single = await fontComp.sendMessage({
                            type: 'getGlyphOutlines',
                            glyphNames: [glyphName],
                            location: batchLocation,
                            flattenComponents: false
                        });
                        if (single?.error) {
                            console.warn(
                                `[GlyphOverview] Failed to render tile ${glyphName}: ${single.error}`
                            );
                            continue;
                        }
                        const outlines = JSON.parse(
                            single.outlinesJson || '[]'
                        );
                        const glyphData = Array.isArray(outlines)
                            ? outlines[0]
                            : null;
                        if (!glyphData) {
                            continue;
                        }
                        const dims = this.getTileDimensions();
                        if (
                            this.renderTileCanvas(
                                tile,
                                glyphData,
                                dims.width,
                                dims.height
                            )
                        ) {
                            tile.cachedData = glyphData;
                        }
                    } catch (inner) {
                        const innerMsg =
                            inner instanceof Error
                                ? inner.message
                                : String(inner);
                        console.warn(
                            `[GlyphOverview] Failed to render tile ${glyphName}: ${innerMsg}`
                        );
                    }
                }
            }
        } finally {
            this.isBatchRendering = false;
        }

        // Process remaining pending glyphs
        if (
            this.pendingGlyphIds.size > 0 &&
            renderGeneration === this.outlineRenderGeneration
        ) {
            this.scheduleBatchRender();
        }

        timelineSpanEnd(batchSpanId);
    }

    private createGlyphTile(glyphId: string, glyphName: string): GlyphTile {
        const tileElement = document.createElement('div');
        tileElement.className = 'glyph-tile';
        tileElement.dataset.glyphId = glyphId;
        tileElement.dataset.glyphName = glyphName;
        if (glyphName === this.highlightedGlyphName) {
            tileElement.style.boxShadow = 'inset 0 0 0 2px var(--accent-blue)';
        }

        // Pre-create canvas to avoid DOM insertion during render.
        // HTML defaults to 300×150; keep unused tiles at 0×0 so they
        // do not allocate a backing store or inflate memory accounting.
        const canvas = document.createElement('canvas');
        canvas.className = 'glyph-tile-canvas';
        canvas.width = 0;
        canvas.height = 0;
        tileElement.appendChild(canvas);

        const cloudIcon = document.createElement('span');
        cloudIcon.className = 'glyph-tile-cloud-icon material-symbols-outlined';
        cloudIcon.textContent = 'cloud_download';
        cloudIcon.setAttribute('aria-hidden', 'true');
        cloudIcon.setAttribute('hidden', '');
        tileElement.appendChild(cloudIcon);

        // Create label for glyph name (display name, not ID)
        const label = document.createElement('div');
        label.className = 'glyph-tile-label';
        const modelGlyph = (
            window.fontManager?.currentFont?.fontModel ??
            window.currentFontModel
        )?.findGlyph?.(glyphName);
        const catalogCodepoints = this.getOverviewCodepoints(glyphName);
        if (modelGlyph?.codepoints?.length || catalogCodepoints.length) {
            label.classList.add('glyph-tile-label-encoded');
        }
        label.textContent = glyphName;
        label.title = glyphName; // Tooltip for truncated names

        tileElement.appendChild(label);

        // Click handler for selection
        tileElement.addEventListener('click', (e) => {
            // Don't handle click if a drag just occurred
            if (this.hasDragged) {
                return;
            }

            // Keep click immediate (no lag). For plain clicks, capture selection snapshot
            // so a following double-click can restore it.
            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                this.preDoubleClickSelectionGlyphIds = this.getSelectedGlyphs();
                this.preDoubleClickGlyphId = glyphId;
                this.preDoubleClickTimestamp = Date.now();
            }

            this.handleTileClick(glyphId, e);
        });

        // Double-click inserts explicit glyph token into text buffer
        tileElement.addEventListener('dblclick', (e) => {
            if (this.hasDragged) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (e.altKey) {
                this.insertSelectedGlyphsAsUnicode();
                return;
            }

            if (this.shouldRestoreSelectionForDoubleClick(glyphId)) {
                this.applySelectionByGlyphIds(
                    this.preDoubleClickSelectionGlyphIds
                );
            }

            this.insertGlyphToken(glyphName);
        });

        const tile: GlyphTile = {
            element: tileElement,
            glyphId: glyphId,
            glyphName: glyphName,
            selected: false,
            lastViewedAt: 0,
            canvas: canvas
        };
        if (this.isGlyphHydrated(glyphName)) {
            this.applyHydratedTileAppearance(tile);
        } else {
            this.applyUnhydratedTileAppearance(tile);
        }
        return tile;
    }

    private overviewFontIdentityKey(): string {
        const font = window.fontManager?.currentFont;
        return [
            window.fontManager?.currentFontId ?? '',
            font?.sourcePlugin?.getId?.() ?? '',
            font?.path ?? ''
        ].join('|');
    }

    private isCloudSourceFont(): boolean {
        return (
            window.fontManager?.currentFont?.sourcePlugin?.getId?.() === 'cloud'
        );
    }

    private isGlyphHydrated(glyphName: string): boolean {
        return !!(
            window.fontManager?.currentFont?.fontModel ??
            window.currentFontModel
        )?.findGlyph?.(glyphName);
    }

    private getCatalogCodepointsMap(): Map<string, number[]> {
        if (!this.catalogCodepointsByName) {
            this.catalogCodepointsByName = catalogCodepointsByGlyphName(
                window.fontManager?.currentFont?.babelfontData as
                    Record<string, unknown> | undefined
            );
        }
        return this.catalogCodepointsByName;
    }

    private getOverviewCodepoints(glyphName: string): number[] {
        const modelGlyph = (
            window.fontManager?.currentFont?.fontModel ??
            window.currentFontModel
        )?.findGlyph?.(glyphName);
        if (
            Array.isArray(modelGlyph?.codepoints) &&
            modelGlyph.codepoints.length
        ) {
            return modelGlyph.codepoints;
        }
        const listed = this.glyphDataById.get(glyphName);
        if (Array.isArray(listed?.codepoints) && listed.codepoints.length) {
            return listed.codepoints;
        }
        return this.getCatalogCodepointsMap().get(glyphName) || [];
    }

    private applyUnhydratedTileAppearance(tile: GlyphTile): void {
        this.evictTileCache(tile);
        tile.element.classList.add('glyph-tile-unhydrated');
        const icon = tile.element.querySelector('.glyph-tile-cloud-icon');
        if (!icon) {
            return;
        }
        if (this.isCloudSourceFont()) {
            icon.removeAttribute('hidden');
        } else {
            icon.setAttribute('hidden', '');
        }
    }

    private applyHydratedTileAppearance(tile: GlyphTile): void {
        tile.element.classList.remove('glyph-tile-unhydrated');
        const icon = tile.element.querySelector('.glyph-tile-cloud-icon');
        if (icon) {
            icon.setAttribute('hidden', '');
        }
    }

    private reconcileTileHydration(): void {
        this.catalogCodepointsByName = null;
        const newlyHydrated: string[] = [];
        for (const tile of this.tiles.values()) {
            const hydrated = this.isGlyphHydrated(tile.glyphName);
            if (hydrated) {
                if (tile.element.classList.contains('glyph-tile-unhydrated')) {
                    newlyHydrated.push(tile.glyphId);
                }
                this.applyHydratedTileAppearance(tile);
            } else {
                this.applyUnhydratedTileAppearance(tile);
            }
        }
        for (const glyphId of newlyHydrated) {
            this.pendingGlyphIds.add(glyphId);
        }
        if (newlyHydrated.length) {
            this.scheduleBatchRender();
        }
    }

    private async hydrateSelectedUnhydratedGlyphs(): Promise<void> {
        const seedNames = this.getSelectedGlyphNames().filter(
            (name) => !this.isGlyphHydrated(name)
        );
        if (!seedNames.length) {
            return;
        }
        try {
            await window.cloudPlugin?.hydrateOverviewGlyphs?.(seedNames);
            this.reconcileTileHydration();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error('[GlyphOverview] Failed to hydrate glyphs:', message);
        }
    }

    private initTileContextMenu(): void {
        if (!this.container) {
            return;
        }

        const backdrop = getOrCreateBackdrop(
            'glyph-overview-tile-context-menu-backdrop'
        );
        this.tileContextMenu = tippy(this.container, {
            content: this.createTileContextMenuHtml(),
            allowHTML: true,
            trigger: 'manual',
            interactive: true,
            placement: 'right-start',
            theme: getTheme(),
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            getReferenceClientRect: null as any,
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) return;
                setupMenuKeyboardNav(menu);
                if ((menu as { _handlersSetup?: boolean })._handlersSetup) {
                    return;
                }
                (menu as { _handlersSetup?: boolean })._handlersSetup = true;
                menu.addEventListener('click', (event) => {
                    const menuItem = (
                        event.target as HTMLElement | null
                    )?.closest('.plugin-menu-item');
                    if (
                        !menuItem ||
                        menuItem.classList.contains('disabled') ||
                        menuItem.classList.contains('plugin-menu-item-disabled')
                    ) {
                        return;
                    }
                    const action = menuItem.getAttribute('data-action');
                    instance.hide();
                    backdrop.classList.remove('visible');
                    if (action === 'insert-as-unicode') {
                        this.insertSelectedGlyphsAsUnicode();
                    } else if (action === 'hydrate-glyphs') {
                        void this.hydrateSelectedUnhydratedGlyphs();
                    } else if (action === 'rename-glyphs') {
                        window.renameGlyphsDialog?.open();
                    } else if (action === 'delete-glyphs') {
                        window.deleteGlyphsDialog?.open();
                    } else if (action === 'duplicate-glyphs') {
                        this.duplicateSelectedGlyphs();
                    }
                });
            }
        });

        addTippyBackdropSupport(this.tileContextMenu, backdrop);

        this.container.addEventListener('contextmenu', (event) => {
            const target = event.target as HTMLElement | null;
            const tileElement = target?.closest(
                '.glyph-tile'
            ) as HTMLElement | null;
            if (!tileElement || !this.tileContextMenu) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const glyphId = tileElement.dataset.glyphId;
            if (!glyphId) {
                return;
            }

            const tile = this.tiles.get(glyphId);
            if (!tile) {
                return;
            }

            // Right-click on an unselected tile selects it alone; keep
            // multi-selection when right-clicking an already-selected tile.
            if (!tile.selected) {
                this.clearSelection(false);
                this.selectTile(glyphId, false);
                this.flushSelectionUi();
                this.lastClickedGlyphId = glyphId;
                this.keyboardAnchorGlyphId = glyphId;
            }

            const selectedNames = this.getSelectedGlyphNames();
            const canAct =
                !!window.fontManager?.currentFont && selectedNames.length > 0;
            const hasUnhydrated = selectedNames.some(
                (name) => !this.isGlyphHydrated(name)
            );
            const canHydrate =
                hasUnhydrated &&
                window.fontManager?.currentFont?.sourcePlugin?.getId?.() ===
                    'cloud';
            this.tileContextMenu.hide();
            this.tileContextMenu.setContent(
                this.createTileContextMenuHtml(
                    canAct,
                    canHydrate,
                    hasUnhydrated
                )
            );
            this.tileContextMenu.setProps({
                getReferenceClientRect: () => ({
                    width: 0,
                    height: 0,
                    top: event.clientY,
                    bottom: event.clientY,
                    left: event.clientX,
                    right: event.clientX,
                    x: event.clientX,
                    y: event.clientY,
                    toJSON: () => ({})
                })
            });
            this.tileContextMenu.show();
        });
    }

    private createTileContextMenuHtml(
        canAct = true,
        canHydrate = false,
        hasUnhydrated = false
    ): string {
        const canMutate = canAct && !hasUnhydrated;
        const disabledClass = canMutate
            ? ''
            : ' disabled plugin-menu-item-disabled';
        const disabledAttr = canMutate ? '' : ' aria-disabled="true"';
        const hasSelectedCodepoints =
            this.getSelectedGlyphUnicodeText().length > 0;
        const insertAsUnicodeItem = hasSelectedCodepoints
            ? `
                <div class="plugin-menu-item" data-action="insert-as-unicode">
                    <span class="material-symbols-outlined">text_fields</span>
                    <span>Insert as Unicode</span>
                    ${keyboardShortcutHtml(
                        'Alt + Double-click',
                        'plugin-menu-shortcut'
                    )}
                </div>`
            : '';
        const hydrateItem = canHydrate
            ? `
                <div class="plugin-menu-item" data-action="hydrate-glyphs">
                    <span class="material-symbols-outlined">cloud_download</span>
                    <span>Download Glyph(s)</span>
                </div>`
            : '';
        return `
            <div class="plugin-menu">
                ${hydrateItem}
                ${insertAsUnicodeItem}
                <div class="plugin-menu-item${disabledClass}" data-action="duplicate-glyphs"${disabledAttr}>
                    <span class="material-symbols-outlined">content_copy</span>
                    <span>Duplicate Glyph(s)</span>
                    ${keyboardShortcutHtml('⌘D', 'plugin-menu-shortcut')}
                </div>
                <div class="plugin-menu-item${disabledClass}" data-action="rename-glyphs"${disabledAttr}>
                    <span class="material-symbols-outlined">edit</span>
                    <span>Rename Glyph(s)…</span>
                    ${keyboardShortcutHtml(`⌘${MENU_SHIFT_SYMBOL}F`, 'plugin-menu-shortcut')}
                </div>
                <div class="plugin-menu-item${disabledClass}" data-action="delete-glyphs"${disabledAttr}>
                    <span class="material-symbols-outlined">delete</span>
                    <span>Delete Glyph(s)</span>
                    ${keyboardShortcutHtml('⌫', 'plugin-menu-shortcut')}
                </div>
            </div>
        `;
    }

    private handleTileClick(glyphId: string, event: MouseEvent): void {
        const tile = this.tiles.get(glyphId);
        if (!tile) return;

        // Track this glyph as the last clicked (for keyboard navigation reference)
        this.lastClickedGlyphId = glyphId;
        // Also set as keyboard anchor for shift+keyboard selection
        this.keyboardAnchorGlyphId = glyphId;

        if (event.shiftKey) {
            // Shift+click: range selection
            this.handleRangeSelection(glyphId);
        } else if (event.metaKey || event.ctrlKey) {
            // Cmd/Ctrl+click: toggle selection
            this.toggleSelection(glyphId);
        } else {
            // Regular click: select only this tile
            this.clearSelection(false);
            this.selectTile(glyphId, false);
            this.flushSelectionUi();
        }
    }

    private shouldRestoreSelectionForDoubleClick(glyphId: string): boolean {
        const maxDelayMs = 500;
        return (
            this.preDoubleClickGlyphId === glyphId &&
            Date.now() - this.preDoubleClickTimestamp <= maxDelayMs
        );
    }

    private applySelectionByGlyphIds(glyphIds: string[]): void {
        const selectedSet = new Set(glyphIds);
        this.tiles.forEach((tile) => {
            const shouldBeSelected = selectedSet.has(tile.glyphId);
            if (tile.selected === shouldBeSelected) {
                return;
            }

            tile.selected = shouldBeSelected;
            tile.element.classList.toggle('selected', shouldBeSelected);
        });
        this.updateSelectedGlyphGroups();
    }

    public getSelectedGlyphNames(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphName);
    }

    getMemoryInspectionSnapshot(): {
        tileCount: number;
        paintedCount: number;
        canvasBytes: number;
        cachedOutlines: unknown[];
    } {
        let canvasBytes = 0;
        let paintedCount = 0;
        const cachedOutlines: unknown[] = [];
        for (const tile of this.tiles.values()) {
            const canvas = tile.canvas;
            if (canvas) {
                const bytes = overviewTileCanvasBackingBytes(canvas);
                if (bytes > 0) {
                    paintedCount += 1;
                    canvasBytes += bytes;
                }
            }
            if (tile.cachedData) {
                cachedOutlines.push(tile.cachedData);
            }
        }
        return {
            tileCount: this.tiles.size,
            paintedCount,
            canvasBytes,
            cachedOutlines
        };
    }

    public selectGlyphsByNames(
        names: string[],
        scheduleReveal: boolean = true
    ): void {
        const nameSet = new Set(
            names.filter((name) => typeof name === 'string' && name.length > 0)
        );
        this.clearSelection(false);
        const selectedIds: string[] = [];
        this.tiles.forEach((tile) => {
            if (!nameSet.has(tile.glyphName)) {
                return;
            }
            this.selectTile(tile.glyphId, false);
            selectedIds.push(tile.glyphId);
        });
        this.flushSelectionUi();
        if (selectedIds.length > 0) {
            this.lastClickedGlyphId = selectedIds[selectedIds.length - 1];
            this.keyboardAnchorGlyphId = this.lastClickedGlyphId;
            if (scheduleReveal) {
                this.scheduleGlyphIdsReveal(selectedIds);
            }
        }
    }

    /**
     * Select by name and keep revealing across post-sync layout frames.
     * Safe to call before tiles exist — names stay pending until sync.
     * Clears the prior selection immediately so we never scroll to old tiles.
     */
    public selectAndRevealGlyphNames(names: string[]): void {
        const cleaned = names.filter(
            (name) => typeof name === 'string' && name.length > 0
        );
        if (cleaned.length === 0) {
            return;
        }
        this.clearSelection(false);
        this.pendingSelectGlyphNames = cleaned;
        if (this.applyPendingGlyphSelection()) {
            this.forceRevealSelectedGlyphs();
        } else if (this.selectionUiFlushPending) {
            this.flushSelectionUi();
        }
    }

    /**
     * Hard reveal for paste/duplicate: center the new glyphs. Lines mode uses
     * index math (ignores stale DOM); grid mode uses mounted-tile geometry
     * because the variant grid is not a flat flow.
     */
    private forceRevealSelectedGlyphs(): void {
        const selectedIds = this.getSelectedGlyphs();
        if (!selectedIds.length) {
            return;
        }
        const generation = ++this.forceRevealGeneration;
        const reveal = () => {
            if (generation !== this.forceRevealGeneration) {
                return;
            }

            const tile = this.tiles.get(selectedIds[0]);
            if (
                tile?.element.isConnected &&
                typeof tile.element.scrollIntoView === 'function'
            ) {
                // Let the browser resolve the real scroll container and tile
                // geometry after layout. Manual index/row estimates are only
                // reliable for virtualized, unmounted lines tiles.
                tile.element.scrollIntoView({
                    block: 'center',
                    inline: 'nearest'
                });
                return;
            }

            this.scrollToGlyphId(selectedIds[0], true);
        };
        reveal();
        requestAnimationFrame(() => {
            reveal();
            requestAnimationFrame(reveal);
        });
    }

    private scheduleSelectedGlyphsReveal(): void {
        this.scheduleGlyphIdsReveal(this.getSelectedGlyphs());
    }

    /**
     * Reveal immediately, then again after one and two animation frames so
     * post-sync DOM reorder / scrollHeight updates cannot leave selection hidden.
     */
    private scheduleGlyphIdsReveal(glyphIds: string[]): void {
        if (!glyphIds.length) {
            return;
        }
        const generation = ++this.selectionRevealGeneration;
        const ids = [...glyphIds];
        const reveal = () => {
            if (generation !== this.selectionRevealGeneration) {
                return;
            }
            this.ensureGlyphIdsInView(ids, false);
        };
        reveal();
        requestAnimationFrame(() => {
            reveal();
            requestAnimationFrame(reveal);
        });
    }

    /**
     * Select glyphs after the next overview rebuild (or immediately if tiles exist).
     */
    public queueSelectGlyphsByNames(names: string[]): void {
        this.selectAndRevealGlyphNames(names);
    }

    private applyPendingGlyphSelection(): boolean {
        if (!this.pendingSelectGlyphNames?.length) {
            return false;
        }
        const nameSet = new Set(this.pendingSelectGlyphNames);
        // Wait until every requested glyph exists — "any present" cleared pending
        // too early on multi-glyph pastes and skipped later reveals.
        const allPresent = [...nameSet].every((name) =>
            Array.from(this.tiles.values()).some(
                (tile) => tile.glyphName === name
            )
        );
        if (!allPresent) {
            return false;
        }
        this.selectGlyphsByNames(this.pendingSelectGlyphNames, false);
        this.pendingSelectGlyphNames = null;
        return true;
    }

    /**
     * Duplicate selected overview glyphs with Glyphs-style .001 names.
     * Direct model clone — not clipboard copy/paste.
     */
    public duplicateSelectedGlyphs(): Array<{ name: string }> {
        const names = this.getSelectedGlyphNames();
        if (names.length === 0) {
            return [];
        }
        const fontModel =
            window.fontManager?.currentFont?.fontModel ??
            window.currentFontModel;
        if (!fontModel?.duplicateGlyphs) {
            return [];
        }
        const created = fontModel.duplicateGlyphs(names) || [];
        const createdNames = created
            .map((glyph: { name?: string }) => glyph?.name)
            .filter((name: string | undefined): name is string => !!name);
        if (createdNames.length > 0) {
            this.queueSelectGlyphsByNames(createdNames);
        }
        return created;
    }

    private insertSelectedGlyphTokens(fallbackGlyphName?: string): void {
        const selectedGlyphNames = this.getSelectedGlyphNames();
        const glyphNamesToInsert =
            selectedGlyphNames.length > 0
                ? selectedGlyphNames
                : fallbackGlyphName
                  ? [fallbackGlyphName]
                  : [];

        if (!glyphNamesToInsert.length) {
            return;
        }

        const tokenText = glyphNamesToInsert
            .map((glyphName) => `/${glyphName}`)
            .join(' ');
        this.insertExplicitGlyphTokenText(`${tokenText} `);
    }

    private insertGlyphToken(glyphName: string): void {
        this.insertExplicitGlyphTokenText(`/${glyphName} `);
    }

    /** Return Unicode characters for selected glyphs that have valid codepoints. */
    private getSelectedGlyphUnicodeText(): string {
        return this.getSelectedGlyphNames()
            .flatMap((glyphName) => {
                const codepoints = this.getOverviewCodepoints(glyphName);
                return Array.isArray(codepoints) ? codepoints : [];
            })
            .filter(
                (codepoint): codepoint is number =>
                    Number.isInteger(codepoint) &&
                    codepoint >= 0 &&
                    codepoint <= 0x10ffff &&
                    (codepoint < 0xd800 || codepoint > 0xdfff)
            )
            .map((codepoint) => String.fromCodePoint(codepoint))
            .join('');
    }

    /** Insert selected encoded glyphs as Unicode characters at the text cursor. */
    private insertSelectedGlyphsAsUnicode(): void {
        const unicodeText = this.getSelectedGlyphUnicodeText();
        if (!unicodeText) {
            return;
        }

        const glyphCanvas = window.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!textRunEditor) {
            console.warn(
                'Cannot insert Unicode text: textRunEditor unavailable'
            );
            return;
        }

        if (
            glyphCanvas?.outlineEditor?.active &&
            typeof textRunEditor.insertTextPreservingSelectedGlyph ===
                'function'
        ) {
            textRunEditor.insertTextPreservingSelectedGlyph(unicodeText);
        } else {
            textRunEditor.insertText(unicodeText);
        }
        console.log('Inserted Unicode text:', unicodeText);
    }

    private insertExplicitGlyphTokenText(tokenText: string): void {
        const glyphCanvas = window.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!textRunEditor) {
            console.warn(
                '[GlyphOverview]',
                'Cannot insert explicit glyph token: textRunEditor unavailable'
            );
            return;
        }

        textRunEditor.insertText(tokenText);
        console.log(
            '[GlyphOverview]',
            'Inserted explicit glyph token text:',
            tokenText
        );
    }

    private handleRangeSelection(glyphId: string): void {
        const selectedGlyphs = this.getSelectedGlyphs();
        if (selectedGlyphs.length === 0) {
            // No previous selection, just select this one
            this.selectTile(glyphId);
            return;
        }

        // Find range between last selected and current
        const glyphArray = this.getVisibleGlyphIds();
        const lastSelected = [...selectedGlyphs]
            .reverse()
            .find((id) => glyphArray.includes(id));
        if (!lastSelected) return;
        const startIdx = glyphArray.indexOf(lastSelected);
        const endIdx = glyphArray.indexOf(glyphId);

        if (startIdx === -1 || endIdx === -1) return;

        const [from, to] =
            startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

        for (let i = from; i <= to; i++) {
            this.selectTile(glyphArray[i], false);
        }
        this.flushSelectionUi();
    }

    private toggleSelection(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile) return;

        if (tile.selected) {
            this.deselectTile(glyphId);
        } else {
            this.selectTile(glyphId);
        }
    }

    private selectTile(glyphId: string, notify: boolean = true): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || tile.selected) return;

        tile.selected = true;
        tile.element.classList.add('selected');

        if (notify) {
            this.flushSelectionUi();
        } else {
            this.selectionUiFlushPending = true;
        }
    }

    private deselectTile(glyphId: string, notify: boolean = true): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || !tile.selected) return;

        tile.selected = false;
        tile.element.classList.remove('selected');

        if (notify) {
            this.flushSelectionUi();
        } else {
            this.selectionUiFlushPending = true;
        }
    }

    private clearSelection(notify: boolean = true): void {
        this.tiles.forEach((tile) => {
            if (tile.selected) {
                tile.selected = false;
                tile.element.classList.remove('selected');
                this.selectionUiFlushPending = true;
            }
        });

        if (notify) {
            this.flushSelectionUi();
        }
    }

    private flushSelectionUi(): void {
        this.selectionUiFlushPending = false;
        this.updateSelectedGlyphGroups();
    }

    private getSelectedGlyphs(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphId);
    }

    /**
     * Handle arrow key navigation for glyph selection
     * Navigates to adjacent glyphs based on visual grid layout
     * When shift is held, performs range selection from the anchor point
     */
    private handleArrowKeyNavigation(
        key: string,
        shiftKey: boolean = false
    ): void {
        const selectedGlyphs = this.getSelectedGlyphs();

        // Get the current glyph to navigate from
        let currentGlyphId: string | null = null;

        if (selectedGlyphs.length === 0) {
            // No selection yet, select the first visible glyph
            const firstVisibleTile = this.findFirstVisibleTile();
            if (firstVisibleTile) {
                if (shiftKey) {
                    // With shift, set anchor and select
                    this.keyboardAnchorGlyphId = firstVisibleTile.glyphId;
                }
                this.selectTile(firstVisibleTile.glyphId);
                this.scrollToTile(firstVisibleTile.element);
            }
            return;
        } else {
            // Use the appropriate selected glyph as reference based on direction
            if (key === 'ArrowLeft') {
                // When moving left, use the leftmost (first) selected glyph
                currentGlyphId = selectedGlyphs[0];
            } else if (key === 'ArrowRight') {
                // When moving right, use the rightmost (last) selected glyph
                currentGlyphId = selectedGlyphs[selectedGlyphs.length - 1];
            } else {
                // For up/down, prefer the last clicked glyph if it's in the selection
                // This handles shift+click range selections properly
                if (
                    this.lastClickedGlyphId &&
                    selectedGlyphs.includes(this.lastClickedGlyphId)
                ) {
                    currentGlyphId = this.lastClickedGlyphId;
                } else {
                    // Fall back to the rightmost selected glyph
                    currentGlyphId = selectedGlyphs[selectedGlyphs.length - 1];
                }
            }
        }

        if (!currentGlyphId) return;

        // Get all visible glyph IDs in order
        const visibleGlyphIds = this.getVisibleGlyphIds();
        if (visibleGlyphIds.length === 0) return;

        let targetGlyphId: string | null = null;

        if (this.viewMode === 'grid') {
            targetGlyphId = this.getGridNavigationTarget(currentGlyphId, key);
        } else {
            const columns = this.getGridColumns();
            if (columns === 0) return;

            const currentIndex = visibleGlyphIds.indexOf(currentGlyphId);
            if (currentIndex === -1) return;

            let targetIndex = -1;
            switch (key) {
                case 'ArrowRight':
                    targetIndex = currentIndex + 1;
                    break;
                case 'ArrowLeft':
                    targetIndex = currentIndex - 1;
                    break;
                case 'ArrowDown':
                    targetIndex = currentIndex + columns;
                    break;
                case 'ArrowUp':
                    targetIndex = currentIndex - columns;
                    break;
            }

            if (targetIndex >= 0 && targetIndex < visibleGlyphIds.length) {
                targetGlyphId = visibleGlyphIds[targetIndex];
            }
        }

        if (targetGlyphId) {
            const targetTile = this.tiles.get(targetGlyphId);
            if (!targetTile) return;

            if (shiftKey) {
                this.handleKeyboardRangeSelection(
                    targetGlyphId,
                    visibleGlyphIds
                );
            } else {
                this.clearSelection(false);
                this.selectTile(targetGlyphId, false);
                this.flushSelectionUi();
                this.keyboardAnchorGlyphId = targetGlyphId;
            }

            this.lastClickedGlyphId = targetGlyphId;
            this.scrollToTile(targetTile.element);
        }
    }

    private getGridNavigationTarget(
        currentGlyphId: string,
        key: string
    ): string | null {
        const position = this.findGridPosition(currentGlyphId);
        if (!position) return null;

        const { row, column } = position;

        if (key === 'ArrowRight' || key === 'ArrowLeft') {
            const step = key === 'ArrowRight' ? 1 : -1;
            for (
                let col = column + step;
                col >= 0 && col < this.gridColumnCount;
                col += step
            ) {
                const glyphId = this.gridRowsForNavigation[row]?.[col] ?? null;
                if (glyphId) {
                    return glyphId;
                }
            }

            const visibleGlyphIds = this.getVisibleGlyphIds();
            const currentIndex = visibleGlyphIds.indexOf(currentGlyphId);
            if (currentIndex === -1) return null;
            const fallbackIndex =
                key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1;
            return visibleGlyphIds[fallbackIndex] ?? null;
        }

        const rowStep = key === 'ArrowDown' ? 1 : -1;
        for (
            let targetRow = row + rowStep;
            targetRow >= 0 && targetRow < this.gridRowsForNavigation.length;
            targetRow += rowStep
        ) {
            const glyphId =
                this.gridRowsForNavigation[targetRow]?.[column] ?? null;
            if (glyphId) {
                return glyphId;
            }
        }

        return null;
    }

    private findGridPosition(
        glyphId: string
    ): { row: number; column: number } | null {
        for (let row = 0; row < this.gridRowsForNavigation.length; row++) {
            const column = this.gridRowsForNavigation[row].indexOf(glyphId);
            if (column !== -1) {
                return { row, column };
            }
        }
        return null;
    }

    /**
     * Handle range selection for keyboard navigation (shift+arrow keys)
     * Selects all glyphs between the anchor and target, following the linear order
     * (like text selection: goes along the line, then wraps to next line)
     */
    private handleKeyboardRangeSelection(
        targetGlyphId: string,
        visibleGlyphIds: string[]
    ): void {
        // If no anchor is set, use the last clicked glyph or first selected
        if (!this.keyboardAnchorGlyphId) {
            const selectedGlyphs = this.getSelectedGlyphs();
            if (selectedGlyphs.length > 0) {
                this.keyboardAnchorGlyphId = selectedGlyphs[0];
            } else {
                // No anchor and no selection, just select the target
                this.selectTile(targetGlyphId);
                this.keyboardAnchorGlyphId = targetGlyphId;
                return;
            }
        }

        const anchorIndex = visibleGlyphIds.indexOf(this.keyboardAnchorGlyphId);
        const targetIndex = visibleGlyphIds.indexOf(targetGlyphId);

        if (anchorIndex === -1 || targetIndex === -1) return;

        // Clear current selection
        this.clearSelection(false);

        // Select all glyphs between anchor and target (inclusive)
        const [from, to] =
            anchorIndex < targetIndex
                ? [anchorIndex, targetIndex]
                : [targetIndex, anchorIndex];

        for (let i = from; i <= to; i++) {
            this.selectTile(visibleGlyphIds[i], false);
        }
        this.flushSelectionUi();
    }

    /**
     * Get the number of columns in the grid based on container width
     */
    private getGridColumns(): number {
        if (this.viewMode === 'grid' && this.gridColumnCount > 0) {
            return this.gridColumnCount;
        }

        if (!this.container) return 0;

        const layout = computeLinesModeTileLayout(
            this.container.clientWidth,
            this.getTileDimensions().width
        );
        return layout.columns;
    }

    /**
     * Get an array of all visible (not hidden) glyph IDs in order
     */
    private getVisibleGlyphIds(): string[] {
        return [...this.visibleGlyphIds];
    }

    /**
     * Find the first visible tile in the grid
     */
    private findFirstVisibleTile(): GlyphTile | null {
        if (this.visibleGlyphIds.length === 0) {
            return null;
        }
        return this.tiles.get(this.visibleGlyphIds[0]) ?? null;
    }

    /**
     * Update the filter manager with groups of currently selected glyphs
     */
    public updateSelectedGlyphGroups(): void {
        if (!this.activeFilterResults) {
            // No filter active, nothing to update
            if (window.glyphOverviewFilterManager) {
                window.glyphOverviewFilterManager.updateSelectedGlyphGroups(
                    new Set()
                );
            }
            this.schedulePropertyPanelUpdate();
            return;
        }

        // Build set of all groups that selected glyphs belong to
        const selectedGroups = new Set<string>();

        this.tiles.forEach((tile) => {
            if (tile.selected) {
                const result = this.activeFilterResults!.get(tile.glyphName);
                if (result && result.groups) {
                    result.groups.forEach((group) => selectedGroups.add(group));
                }
            }
        });

        // Notify filter manager
        if (window.glyphOverviewFilterManager) {
            window.glyphOverviewFilterManager.updateSelectedGlyphGroups(
                selectedGroups
            );
        }
        this.schedulePropertyPanelUpdate();
    }

    /**
     * Coalesce property-panel rebuilds to one animation frame. During an active
     * drag-select, defer until mouseup so selection stays responsive.
     */
    private schedulePropertyPanelUpdate(): void {
        if (this.isDragging && this.hasDragged) {
            this.propertyPanelDeferredUntilDragEnd = true;
            return;
        }

        if (this.propertyPanelUpdateRafId !== null) {
            return;
        }

        if (typeof window.requestAnimationFrame !== 'function') {
            this.updatePropertyPanel();
            return;
        }

        this.propertyPanelUpdateRafId = window.requestAnimationFrame(() => {
            this.propertyPanelUpdateRafId = null;
            this.updatePropertyPanel();
        });
    }

    private flushDeferredPropertyPanelUpdate(): void {
        if (this.propertyPanelUpdateRafId !== null) {
            window.cancelAnimationFrame(this.propertyPanelUpdateRafId);
            this.propertyPanelUpdateRafId = null;
        }
        if (
            this.propertyPanelDeferredUntilDragEnd ||
            this.selectionUiFlushPending
        ) {
            this.propertyPanelDeferredUntilDragEnd = false;
            if (this.selectionUiFlushPending) {
                this.flushSelectionUi();
                return;
            }
        }
        this.updatePropertyPanel();
    }

    private getActiveOverviewPropertyInputState(): OverviewPropertyInputState | null {
        const activeElement = document.activeElement as HTMLElement | null;
        if (
            !activeElement ||
            !(activeElement instanceof HTMLInputElement) ||
            !this.propertyPanel ||
            !this.propertyPanel.contains(activeElement) ||
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

    private restoreActiveOverviewPropertyInput(
        activeInputState: OverviewPropertyInputState | null
    ): void {
        if (!activeInputState || !this.propertyPanel) {
            return;
        }

        const replacementInput = this.propertyPanel.querySelector(
            `.glyph-property-input[data-property-field="${activeInputState.fieldKey}"]`
        ) as HTMLInputElement | null;
        if (!replacementInput || replacementInput.disabled) {
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

    private getSelectedGlyphModel(): {
        name: string;
        codepoints?: number[];
    } | null {
        const selectedNames = this.getSelectedGlyphNames();
        if (selectedNames.length !== 1) {
            return null;
        }

        const glyphName = selectedNames[0];
        const codepoints = this.getOverviewCodepoints(glyphName);
        const fontModel = window.currentFontModel;
        const glyph =
            typeof fontModel?.findGlyph === 'function'
                ? fontModel.findGlyph(glyphName)
                : fontModel?.glyphs?.find(
                      (candidate: { name?: string }) =>
                          candidate.name === glyphName
                  );
        if (!glyph) {
            return {
                name: glyphName,
                ...(codepoints.length ? { codepoints } : {})
            };
        }
        return {
            name: glyph.name || glyphName,
            codepoints: codepoints.length ? codepoints : glyph.codepoints
        };
    }

    private resolveOverviewMasterId(): string | null {
        const selectedMasterId =
            window.glyphCanvas?.textRunEditor?.selectedMasterId;
        if (typeof selectedMasterId === 'string' && selectedMasterId) {
            return selectedMasterId;
        }

        const masters = window.currentFontModel?.masters;
        if (!Array.isArray(masters) || masters.length === 0) {
            return null;
        }

        for (const master of masters) {
            const masterLocation = master?.location as
                Record<string, number> | undefined;
            if (
                locationsMatchWithinTolerance(
                    masterLocation,
                    this.currentLocation
                )
            ) {
                return master.id || null;
            }
        }

        return masters[0]?.id || null;
    }

    private resolveOverviewLayerForGlyph(
        glyphName: string
    ): OverviewSidebearingLayer | null {
        const fontModel = window.currentFontModel;
        if (!fontModel || typeof fontModel.findGlyph !== 'function') {
            return null;
        }

        const glyph = fontModel.findGlyph(glyphName);
        if (!glyph) {
            return null;
        }

        const masterId = this.resolveOverviewMasterId();
        if (masterId && typeof glyph.findLayerByMasterId === 'function') {
            const masterLayer = glyph.findLayerByMasterId(masterId);
            if (masterLayer) {
                return masterLayer;
            }
        }

        const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
        const defaultLayer = layers.find(
            (layer: { master?: { type?: string } }) =>
                layer?.master?.type === 'DefaultForMaster'
        );
        return defaultLayer || layers[0] || null;
    }

    private getSelectedOverviewLayers(): OverviewSidebearingLayer[] {
        const layers: OverviewSidebearingLayer[] = [];
        for (const glyphName of this.getSelectedGlyphNames()) {
            const layer = this.resolveOverviewLayerForGlyph(glyphName);
            if (layer) {
                layers.push(layer);
            }
        }
        return layers;
    }

    private getStoredSidebearingKey(
        layer: OverviewSidebearingLayer,
        side: SidebearingSide
    ): string | undefined {
        const parent =
            typeof layer.parent === 'function' ? layer.parent() : null;
        return (
            (side === 'left'
                ? layer.leftMetricsKey || parent?.leftMetricsKey
                : layer.rightMetricsKey || parent?.rightMetricsKey) || undefined
        );
    }

    private getDirectSidebearingsFromLayer(
        layer: OverviewSidebearingLayer,
        bboxCache: WeakMap<
            OverviewSidebearingLayer,
            { lsb: number; rsb: number }
        >
    ): { lsb: number; rsb: number } {
        const cached = bboxCache.get(layer);
        if (cached) {
            return cached;
        }

        let pair: { lsb: number; rsb: number };
        if (typeof layer.getBoundingBox === 'function') {
            const bbox = layer.getBoundingBox(false);
            const width = Number(layer.width) || 0;
            if (!bbox) {
                pair = { lsb: 0, rsb: Math.round(width) };
            } else {
                pair = {
                    lsb: Math.round(bbox.minX),
                    rsb: Math.round(width - bbox.maxX)
                };
            }
        } else {
            // Fallback: layer.lsb/rsb each recompute bbox independently.
            pair = { lsb: Number(layer.lsb) || 0, rsb: Number(layer.rsb) || 0 };
        }
        bboxCache.set(layer, pair);
        return pair;
    }

    /**
     * Build LSB/RSB panel summaries with early mixed-value exit and one shared
     * bbox per layer when numeric sidebearings are needed.
     */
    private summarizeOverviewSidebearings(layers: OverviewSidebearingLayer[]): {
        left: OverviewSidebearingSideSummary;
        right: OverviewSidebearingSideSummary;
    } {
        const bboxCache = new WeakMap<
            OverviewSidebearingLayer,
            { lsb: number; rsb: number }
        >();

        const summarizeSide = (
            side: SidebearingSide
        ): OverviewSidebearingSideSummary => {
            if (layers.length === 0) {
                return {
                    sharedDisplay: null,
                    sharedResolved: null,
                    allAutomatic: false,
                    anyError: false,
                    showAutoPlaceholder: false,
                    sampleState: null
                };
            }

            let sharedDisplay: string | null = null;
            let mixed = false;
            let allAutomatic = true;
            let showAutoPlaceholder = true;
            let anyError = false;
            let sampleState: OverviewSidebearingDisplayState | null = null;

            for (let index = 0; index < layers.length; index++) {
                const layer = layers[index];
                const automaticLayer = layer.isAutomaticAlignedLayer();
                if (!automaticLayer) {
                    allAutomatic = false;
                }

                const storedKey = this.getStoredSidebearingKey(layer, side);
                let displayedValue: string;
                let resolvedValue: number;
                let error: string | null = null;

                if (!storedKey && automaticLayer) {
                    displayedValue = '';
                    // Avoid bbox for auto placeholders unless we need a shared
                    // resolved value later for a non-mixed single-path case.
                    resolvedValue = Number.NaN;
                } else if (storedKey) {
                    // Prefer the stored key string for display identity. Only
                    // resolve when we still have a shared candidate and need
                    // arrow-adjust / invalid state (after the loop for sample).
                    displayedValue = storedKey;
                    resolvedValue = Number.NaN;
                } else {
                    const pair = this.getDirectSidebearingsFromLayer(
                        layer,
                        bboxCache
                    );
                    displayedValue = String(
                        side === 'left' ? pair.lsb : pair.rsb
                    );
                    resolvedValue = side === 'left' ? pair.lsb : pair.rsb;
                }

                const showAutoPlaceholderForLayer =
                    !storedKey && automaticLayer;
                if (!showAutoPlaceholderForLayer) {
                    showAutoPlaceholder = false;
                }

                if (sharedDisplay === null) {
                    sharedDisplay = displayedValue;
                    sampleState = {
                        displayedValue,
                        resolvedValue,
                        automaticLayer,
                        showAutoPlaceholder: showAutoPlaceholderForLayer,
                        error
                    };
                } else if (displayedValue !== sharedDisplay) {
                    mixed = true;
                    // Still finish the automatic/placeholder scan without more
                    // numeric bbox work when the display fingerprint already
                    // diverged.
                    for (let rest = index + 1; rest < layers.length; rest++) {
                        if (!layers[rest].isAutomaticAlignedLayer()) {
                            allAutomatic = false;
                        }
                        if (
                            this.getStoredSidebearingKey(layers[rest], side) ||
                            !layers[rest].isAutomaticAlignedLayer()
                        ) {
                            showAutoPlaceholder = false;
                        }
                    }
                    break;
                }
            }

            if (mixed) {
                return {
                    sharedDisplay: null,
                    sharedResolved: null,
                    allAutomatic,
                    anyError: false,
                    showAutoPlaceholder: false,
                    sampleState: null
                };
            }

            // Shared display: resolve metrics / bbox once on the sample layer
            // for arrow-adjust and invalid marking.
            const sampleLayer = layers[0];
            if (sampleLayer && sampleState) {
                const storedKey = this.getStoredSidebearingKey(
                    sampleLayer,
                    side
                );
                if (storedKey) {
                    const resolution = sampleLayer.resolveMetricsKey(side);
                    sampleState = {
                        ...sampleState,
                        resolvedValue:
                            resolution.value ??
                            this.getDirectSidebearingsFromLayer(
                                sampleLayer,
                                bboxCache
                            )[side === 'left' ? 'lsb' : 'rsb'],
                        error: resolution.error
                    };
                    anyError = Boolean(resolution.error);
                } else if (
                    !sampleState.showAutoPlaceholder &&
                    !Number.isFinite(sampleState.resolvedValue)
                ) {
                    const pair = this.getDirectSidebearingsFromLayer(
                        sampleLayer,
                        bboxCache
                    );
                    sampleState = {
                        ...sampleState,
                        resolvedValue: side === 'left' ? pair.lsb : pair.rsb
                    };
                }
            }

            return {
                sharedDisplay,
                sharedResolved: sampleState ? sampleState.resolvedValue : null,
                allAutomatic,
                anyError,
                showAutoPlaceholder:
                    showAutoPlaceholder && allAutomatic && sharedDisplay === '',
                sampleState
            };
        };

        return {
            left: summarizeSide('left'),
            right: summarizeSide('right')
        };
    }

    updatePropertyPanel(): void {
        if (!this.propertyPanel) {
            return;
        }

        const activeInputState = this.getActiveOverviewPropertyInputState();
        this.propertyPanel.textContent = '';
        this.propertyPanel.classList.remove('glyph-kerning-groups-panel');

        const content = document.createElement('div');
        content.className = 'glyph-property-panel-content';

        const selectedNames = this.getSelectedGlyphNames();
        const singleGlyph =
            selectedNames.length === 1 ? this.getSelectedGlyphModel() : null;
        const nameEditable = Boolean(singleGlyph);
        const unicodeEditable =
            nameEditable && this.isGlyphHydrated(singleGlyph?.name || '');
        const layers = this.getSelectedOverviewLayers();
        const sidebearingSummary = this.summarizeOverviewSidebearings(layers);
        const fontModel = window.currentFontModel;

        const nameControl = document.createElement('div');
        nameControl.className =
            'glyph-property-control glyph-overview-property-name';

        const nameLabel = document.createElement('span');
        nameLabel.className = 'glyph-property-control-label';
        nameLabel.textContent = 'Name';
        nameLabel.title = 'Glyph name';
        nameControl.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'glyph-property-input';
        nameInput.dataset.propertyField = 'glyph-name';
        nameInput.spellcheck = false;
        nameInput.disabled = !nameEditable || !unicodeEditable;
        nameInput.value = singleGlyph?.name || '';
        if (selectedNames.length > 1) {
            nameInput.placeholder = 'Multiple';
        }
        this.bindOverviewPropertyInput(nameInput, () => {
            this.commitOverviewGlyphName(nameInput.value);
        });
        nameControl.appendChild(nameInput);

        const unicodeControl = document.createElement('div');
        unicodeControl.className =
            'glyph-property-control glyph-overview-property-unicode';

        const unicodeLabel = document.createElement('span');
        unicodeLabel.className = 'glyph-property-control-label';
        unicodeLabel.textContent = 'Unicode';
        unicodeLabel.title = 'Unicode codepoints (comma-separated hex)';
        unicodeControl.appendChild(unicodeLabel);

        const unicodeInput = document.createElement('input');
        unicodeInput.type = 'text';
        unicodeInput.className = 'glyph-property-input';
        unicodeInput.dataset.propertyField = 'glyph-unicode';
        unicodeInput.spellcheck = false;
        unicodeInput.disabled = !unicodeEditable;
        unicodeInput.value =
            selectedNames.length === 1
                ? formatCodepointsHexList(singleGlyph?.codepoints)
                : '';
        if (selectedNames.length > 1) {
            unicodeInput.placeholder = 'Multiple';
        } else if (nameEditable) {
            unicodeInput.placeholder = '0041, 00E4';
        }
        this.bindOverviewPropertyInput(unicodeInput, () => {
            this.commitOverviewGlyphCodepoints(unicodeInput.value);
        });
        unicodeControl.appendChild(unicodeInput);

        content.appendChild(
            this.createOverviewSidebearingControl(
                'left',
                'LSB',
                layers.length > 0,
                sidebearingSummary.left
            )
        );
        content.appendChild(nameControl);
        content.appendChild(unicodeControl);
        content.appendChild(
            this.createOverviewSidebearingControl(
                'right',
                'RSB',
                layers.length > 0,
                sidebearingSummary.right
            )
        );

        const startSide = buildEditViewKerningGroupSide(
            'second',
            selectedNames,
            fontModel?.second_kern_groups
        );
        const endSide = buildEditViewKerningGroupSide(
            'first',
            selectedNames,
            fontModel?.first_kern_groups
        );

        this.propertyPanel.classList.add('glyph-kerning-groups-panel');
        renderKerningGroupWidget(this.propertyPanel, {
            startSide,
            endSide,
            center: content,
            onSelectChip: (chip) => {
                if (chip.kind !== 'group') {
                    return;
                }
                const missingGlyphNames =
                    chip.pairSide === 'second'
                        ? startSide.missingGlyphNames
                        : endSide.missingGlyphNames;
                this.updateOverviewKerningGroupMembership(
                    chip.pairSide,
                    missingGlyphNames,
                    chip.name,
                    true
                );
            },
            onRemoveChip: (chip) => {
                this.updateOverviewKerningGroupMembership(
                    chip.pairSide,
                    selectedNames,
                    chip.name,
                    false
                );
            },
            onAdd: (pairSide, glyphNames) => {
                this.promptAndAddOverviewKerningGroup(
                    pairSide,
                    glyphNames,
                    formatKerningGroupKindLabel(pairSide)
                );
            }
        });
        this.restoreActiveOverviewPropertyInput(activeInputState);
    }

    private createOverviewSidebearingControl(
        side: SidebearingSide,
        shortLabel: string,
        editable: boolean,
        summary: OverviewSidebearingSideSummary
    ): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'glyph-property-control';

        const label = document.createElement('span');
        label.className = 'glyph-property-control-label';
        label.dataset.kerningSide = side === 'left' ? 'second' : 'first';
        label.textContent = shortLabel;
        label.title =
            side === 'left' ? 'Left sidebearing' : 'Right sidebearing';
        wrapper.appendChild(label);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'glyph-property-input';
        input.dataset.sidebearingSide = side;
        input.dataset.propertyField = `side-${side}`;
        input.spellcheck = false;
        input.disabled = !editable;

        if (!editable) {
            input.value = '';
        } else if (summary.sharedDisplay === null) {
            input.value = '';
            input.placeholder = 'Multiple values';
            input.classList.add('glyph-property-input-mixed');
        } else {
            input.value = summary.sharedDisplay;
            if (summary.showAutoPlaceholder) {
                input.placeholder = '=+0 or ==+0';
            }
        }

        if (summary.allAutomatic) {
            input.title =
                'Automatic layers only accept =+/- or ==+/- sidebearing adjustments';
        }
        if (summary.anyError) {
            input.classList.add('invalid');
        }

        const arrowInputController =
            editable && !summary.allAutomatic
                ? new ArrowAdjustableTextInput({
                      input,
                      getValue: () => {
                          const trimmedValue = input.value.trim();
                          if (isPlainNumericInputValue(trimmedValue)) {
                              return Number(trimmedValue);
                          }
                          return (
                              summary.sharedResolved ??
                              summary.sampleState?.resolvedValue ??
                              Number.NaN
                          );
                      },
                      applyValue: (nextValue) => {
                          input.dataset.skipNextPropertyCommit = 'true';
                          this.commitOverviewSidebearing(
                              side,
                              String(nextValue)
                          );
                      },
                      findReplacementInput: () =>
                          this.propertyPanel?.querySelector(
                              `.glyph-property-input[data-property-field="side-${side}"]`
                          ) as HTMLInputElement | null
                  })
                : null;

        this.bindOverviewPropertyInput(input, () => {
            if (arrowInputController?.isApplyingStep) {
                return;
            }
            this.commitOverviewSidebearing(side, input.value);
        });

        wrapper.appendChild(input);
        return wrapper;
    }

    private bindOverviewPropertyInput(
        input: HTMLInputElement,
        commit: () => void
    ): void {
        input.addEventListener('change', () => {
            if (input.dataset.skipNextPropertyCommit === 'true') {
                delete input.dataset.skipNextPropertyCommit;
                return;
            }
            commit();
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.updatePropertyPanel();
                input.blur();
                window.restoreFocusedViewDomFocus?.();
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                input.dataset.skipNextPropertyCommit = 'true';
                commit();
                input.blur();
                window.restoreFocusedViewDomFocus?.();
            }
        });
    }

    private commitOverviewSidebearing(
        side: SidebearingSide,
        rawValue: string
    ): void {
        const layers = this.getSelectedOverviewLayers();
        if (layers.length === 0) {
            this.updatePropertyPanel();
            return;
        }

        window.fontManager?.setEditingCompileContext?.(
            'keyboard-sidebearing',
            null
        );

        const bridge = window.patchSyncEngine;
        const label = getSidebearingTransactionLabel(side);
        bridge?.beginTransaction(label);
        try {
            for (const layer of layers) {
                layer.applySidebearingInput(side, rawValue);
            }
        } finally {
            bridge?.endTransaction();
        }

        this.updatePropertyPanel();
    }

    private commitOverviewGlyphName(rawValue: string): void {
        const singleGlyph = this.getSelectedGlyphModel();
        const fontModel = window.currentFontModel;
        if (!singleGlyph || !fontModel) {
            this.updatePropertyPanel();
            return;
        }

        const oldName = singleGlyph.name;
        const newName = rawValue.trim();
        if (!newName || newName === oldName) {
            this.updatePropertyPanel();
            return;
        }

        const renames = new Map([[oldName, newName]]);
        const existingNames =
            fontModel.glyphs?.map(
                (glyph: { name?: string }) => glyph.name || ''
            ) || [];
        const errors = getGlyphRenamePreflightErrors(renames, existingNames, {
            requireSourcesExist: true
        });
        if (errors.size > 0) {
            const nameInput = this.propertyPanel?.querySelector(
                '.glyph-property-input[data-property-field="glyph-name"]'
            ) as HTMLInputElement | null;
            if (nameInput) {
                nameInput.classList.add('invalid');
            }
            console.warn(
                'Could not rename glyph',
                errors.get(oldName) || 'Rename failed'
            );
            return;
        }

        try {
            this.pendingSelectGlyphNames = [newName];
            fontModel.renameGlyphs(renames);
        } catch (error) {
            console.error('Could not rename glyph', error);
            this.pendingSelectGlyphNames = null;
            this.updatePropertyPanel();
        }
    }

    private commitOverviewGlyphCodepoints(rawValue: string): void {
        const singleGlyph = this.getSelectedGlyphModel();
        const fontModel = window.currentFontModel;
        if (!singleGlyph || !fontModel) {
            this.updatePropertyPanel();
            return;
        }

        const parsed = parseCodepointsHexList(rawValue);
        if (parsed === null) {
            const unicodeInput = this.propertyPanel?.querySelector(
                '.glyph-property-input[data-property-field="glyph-unicode"]'
            ) as HTMLInputElement | null;
            if (unicodeInput) {
                unicodeInput.classList.add('invalid');
            }
            return;
        }

        const glyph =
            typeof fontModel.findGlyph === 'function'
                ? fontModel.findGlyph(singleGlyph.name)
                : null;
        if (!glyph) {
            this.updatePropertyPanel();
            return;
        }

        const previous = Array.isArray(glyph.codepoints)
            ? glyph.codepoints.filter(
                  (value: unknown): value is number =>
                      typeof value === 'number' && Number.isFinite(value)
              )
            : [];
        const next = parsed;
        if (
            previous.length === next.length &&
            previous.every((value, index) => value === next[index])
        ) {
            this.updatePropertyPanel();
            return;
        }

        window.patchSyncEngine?.beginTransaction('Set glyph Unicode');
        try {
            glyph.codepoints = next.length > 0 ? next : undefined;
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.updatePropertyPanel();
    }

    private updateOverviewKerningGroupMembership(
        pairSide: KerningPairSide,
        glyphNames: string[],
        groupName: string,
        include: boolean
    ): void {
        const fontModel = window.currentFontModel;
        if (!fontModel || glyphNames.length === 0) {
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
                    pairSide,
                    glyphNames,
                    groupName,
                    include
                )
            ) {
                return;
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.updatePropertyPanel();
    }

    private promptAndAddOverviewKerningGroup(
        pairSide: KerningPairSide,
        glyphNames: string[],
        sideTitle: string
    ): void {
        if (glyphNames.length === 0) {
            return;
        }

        const groupName = window.prompt(
            glyphNames.length === 1
                ? `Add ${glyphNames[0]} to ${sideTitle}`
                : `Add ${sideTitle}`
        );
        if (groupName === null) {
            return;
        }

        this.updateOverviewKerningGroupMembership(
            pairSide,
            glyphNames,
            groupName,
            true
        );
    }

    // Drag selection handlers
    private onMouseDown(e: MouseEvent): void {
        this.isDragging = true;
        this.hasDragged = false;
        this.dragTileRects = null;
        const rect = this.container!.getBoundingClientRect();
        this.dragStartX = e.clientX - rect.left + this.container!.scrollLeft;
        this.dragStartY = e.clientY - rect.top + this.container!.scrollTop;

        // Clear selection if no modifier key (but only if we're dragging, not clicking a tile)
        // We'll handle this in onMouseMove when we know it's actually a drag
    }

    private onMouseMove(e: MouseEvent): void {
        if (!this.isDragging || !this.container) return;

        const rect = this.container.getBoundingClientRect();
        const currentX = e.clientX - rect.left + this.container.scrollLeft;
        const currentY = e.clientY - rect.top + this.container.scrollTop;

        // Check if we've moved enough to consider this a drag (not just a click)
        const deltaX = Math.abs(currentX - this.dragStartX);
        const deltaY = Math.abs(currentY - this.dragStartY);
        if (deltaX > 3 || deltaY > 3) {
            if (!this.hasDragged) {
                this.hasDragged = true;

                // Clear selection if no modifier key (now that we know it's a drag)
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    this.clearSelection(false);
                }
                this.ensureDragTileRectCache();
            }

            // Create selection box on first movement
            if (!this.selectionBox) {
                this.selectionBox = document.createElement('div');
                this.selectionBox.style.position = 'absolute';
                this.selectionBox.style.border =
                    '1px solid var(--accent-primary)';
                this.selectionBox.style.backgroundColor =
                    'rgba(var(--accent-primary-rgb), 0.1)';
                this.selectionBox.style.pointerEvents = 'none';
                this.container!.appendChild(this.selectionBox);
            }
        }

        if (!this.selectionBox) return;

        const left = Math.min(this.dragStartX, currentX);
        const top = Math.min(this.dragStartY, currentY);
        const width = Math.abs(currentX - this.dragStartX);
        const height = Math.abs(currentY - this.dragStartY);

        this.selectionBox.style.left = `${left}px`;
        this.selectionBox.style.top = `${top}px`;
        this.selectionBox.style.width = `${width}px`;
        this.selectionBox.style.height = `${height}px`;

        // Update selection based on intersection with tiles
        this.updateDragSelection(left, top, width, height);
    }

    private onMouseUp(_e: MouseEvent): void {
        if (this.isDragging) {
            this.isDragging = false;
            if (this.selectionBox) {
                this.selectionBox.remove();
                this.selectionBox = null;
            }
            this.dragTileRects = null;
            if (this.hasDragged) {
                this.flushDeferredPropertyPanelUpdate();
            } else if (this.selectionUiFlushPending) {
                this.flushSelectionUi();
            }
        }
    }

    private ensureDragTileRectCache(): void {
        if (this.dragTileRects || !this.container) {
            return;
        }

        const containerRect = this.container.getBoundingClientRect();
        const scrollLeft = this.container.scrollLeft;
        const scrollTop = this.container.scrollTop;
        const rects: DragTileRect[] = [];

        this.tiles.forEach((tile) => {
            if (!tile.element.isConnected) {
                return;
            }
            const rect = tile.element.getBoundingClientRect();
            const left = rect.left - containerRect.left + scrollLeft;
            const top = rect.top - containerRect.top + scrollTop;
            rects.push({
                glyphId: tile.glyphId,
                left,
                top,
                right: left + rect.width,
                bottom: top + rect.height
            });
        });

        this.dragTileRects = rects;
    }

    private updateDragSelection(
        boxLeft: number,
        boxTop: number,
        boxWidth: number,
        boxHeight: number
    ): void {
        this.ensureDragTileRectCache();
        if (!this.dragTileRects) {
            return;
        }

        const boxRight = boxLeft + boxWidth;
        const boxBottom = boxTop + boxHeight;
        let changed = false;

        for (const tileRect of this.dragTileRects) {
            const intersects = !(
                boxRight < tileRect.left ||
                boxLeft > tileRect.right ||
                boxBottom < tileRect.top ||
                boxTop > tileRect.bottom
            );

            if (!intersects) {
                continue;
            }

            const tile = this.tiles.get(tileRect.glyphId);
            if (!tile || tile.selected) {
                continue;
            }

            this.selectTile(tileRect.glyphId, false);
            changed = true;
        }

        if (changed) {
            this.selectionUiFlushPending = true;
            this.propertyPanelDeferredUntilDragEnd = true;
        }
    }

    /**
     * Show a filter error overlay instead of glyphs
     * @param pluginName - Name of the plugin that errored
     * @param error - Error message or object
     */
    /**
     * Show a filter error overlay instead of glyphs
     * @param pluginName - Name of the plugin that errored
     * @param error - Error message or object
     * @param lineOffset - Number of wrapper lines to subtract from line numbers (for user code errors)
     * @param filePath - Optional file path for user filters (to enable "Fix with AI" button)
     * @param pythonCode - Optional Python code that caused the error
     */
    public showFilterError(
        pluginName: string,
        error: any,
        lineOffset: number = 0,
        filePath?: string,
        pythonCode?: string
    ): void {
        this.clearFilterError();

        // Create error overlay
        this.errorOverlay = document.createElement('div');
        this.errorOverlay.className = 'glyph-overview-error-overlay';

        const errorContent = document.createElement('div');
        errorContent.className = 'glyph-overview-error-content';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined glyph-overview-error-icon';
        icon.textContent = 'error';

        const title = document.createElement('div');
        title.className = 'glyph-overview-error-title';
        title.textContent = `Filter "${pluginName}" Error`;

        const message = document.createElement('pre');
        message.className = 'glyph-overview-error-message';
        // Extract error message
        let errorText = '';
        if (error instanceof Error) {
            // For PythonError from Pyodide, message already contains full Python traceback
            // Don't append stack (which contains JS/WASM traces)
            errorText = error.message;
            if (error.stack && error.constructor.name !== 'PythonError') {
                errorText += '\n\n' + error.stack;
            }
            // Clean Python traceback to remove Pyodide internal frames and adjust line numbers
            if (error.constructor.name === 'PythonError') {
                const tracebackCleaner =
                    typeof window !== 'undefined' &&
                    typeof window.cleanPythonTraceback === 'function'
                        ? window.cleanPythonTraceback
                        : null;
                if (tracebackCleaner) {
                    errorText = tracebackCleaner(errorText, {
                        lineOffset,
                        skipExecFrames: true
                    });
                }
            }
        } else if (typeof error === 'string') {
            errorText = error;
        } else if (error && error.toString) {
            errorText = error.toString();
        } else {
            errorText = JSON.stringify(error, null, 2);
        }
        message.textContent = errorText;

        errorContent.appendChild(icon);
        errorContent.appendChild(title);
        errorContent.appendChild(message);

        this.errorOverlay.appendChild(errorContent);

        // Hide tiles and show error
        if (this.container) {
            this.container.style.display = 'none';
            this.container.parentElement?.appendChild(this.errorOverlay);
        }
    }

    /**
     * Show a filter notice overlay (info, not error)
     * @param pluginName - Name of the plugin
     * @param message - Notice message to display
     * @param type - 'info' or 'warning'
     */
    public showFilterNotice(
        pluginName: string,
        message: string,
        type: 'info' | 'warning' = 'info'
    ): void {
        this.clearFilterError();

        // Create notice overlay
        this.errorOverlay = document.createElement('div');
        this.errorOverlay.className = `glyph-overview-error-overlay glyph-overview-notice-${type}`;

        const noticeContent = document.createElement('div');
        noticeContent.className = 'glyph-overview-error-content';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined glyph-overview-error-icon';
        icon.textContent = type === 'warning' ? 'warning' : 'info';

        const title = document.createElement('div');
        title.className = 'glyph-overview-error-title';
        title.textContent = `Filter "${pluginName}"`;

        const messageEl = document.createElement('div');
        messageEl.className =
            'glyph-overview-error-message glyph-overview-notice-message';
        messageEl.textContent = message;

        noticeContent.appendChild(icon);
        noticeContent.appendChild(title);
        noticeContent.appendChild(messageEl);
        this.errorOverlay.appendChild(noticeContent);

        // Hide tiles and show notice
        if (this.container) {
            this.container.style.display = 'none';
            this.container.parentElement?.appendChild(this.errorOverlay);
        }
    }

    /**
     * Clear the filter error overlay and show tiles again
     */
    public clearFilterError(): void {
        if (this.errorOverlay) {
            this.errorOverlay.remove();
            this.errorOverlay = null;
        }
        if (this.container) {
            this.container.style.display = '';
        }
    }

    /**
     * Set the active filter and apply visibility/colors
     * @param results - Array of filter results or null to clear filter
     */
    public setActiveFilter(results: FilterResult[] | null): void {
        const filterSpanId = timelineSpanStart('overview.setActiveFilter', {
            resultCount: results?.length ?? 0,
            tileCount: this.tiles.size
        });

        // Clear any previous error
        this.clearFilterError();

        if (results === null) {
            if (this.activeFilterResults === null) {
                timelineSpanEnd(filterSpanId);
                return;
            }

            // Clear filter
            this.activeFilterResults = null;
            this.clearFilterColors();
        } else {
            // Build map for fast lookup by glyph name
            this.activeFilterResults = new Map();
            for (const result of results) {
                this.activeFilterResults.set(result.glyph_name, result);
            }
            this.applyFilterColors();
        }

        // Re-apply combined filter + search
        this.applySearchFilter();

        const hasRenderedTiles = Array.from(this.tiles.values()).some(
            (tile) => !!tile.cachedData
        );
        if (this.tiles.size > 0 && !hasRenderedTiles) {
            void this.renderGlyphOutlines(this.currentLocation);
        }

        timelineSpanEnd(filterSpanId);
    }

    /**
     * Apply filter colors to tiles as background overlay
     * For glyphs with multiple groups, displays horizontal stripes
     */
    private applyFilterColors(): void {
        if (!this.activeFilterResults) return;

        this.tiles.forEach((tile) => {
            const result = this.activeFilterResults!.get(tile.glyphName);
            if (result && result.colors && result.colors.length > 0) {
                // Deduplicate colors while preserving order
                const uniqueColors = [...new Set(result.colors)];
                tile.filterColors = uniqueColors;
                tile.filterColor = uniqueColors[0];

                if (uniqueColors.length === 1) {
                    // Single color - use solid background
                    tile.element.style.setProperty(
                        '--filter-color',
                        this.cssColorToRgba(uniqueColors[0], 0.25)
                    );
                    tile.element.style.backgroundImage = 'none';
                } else {
                    // Multiple colors - create horizontal stripe gradient
                    const stripeGradient = this.buildStripeGradient(
                        uniqueColors,
                        0.25
                    );
                    tile.element.style.setProperty(
                        '--filter-color',
                        'transparent'
                    );
                    tile.element.style.backgroundImage = stripeGradient;
                }
            } else if (result && result.color) {
                // Fallback to single color if colors array not present
                tile.filterColor = result.color;
                tile.filterColors = [result.color];
                tile.element.style.setProperty(
                    '--filter-color',
                    this.cssColorToRgba(result.color, 0.25)
                );
                tile.element.style.backgroundImage = 'none';
            } else {
                tile.filterColor = undefined;
                tile.filterColors = undefined;
                tile.element.style.setProperty('--filter-color', 'transparent');
                tile.element.style.backgroundImage = 'none';
            }
        });
    }

    /**
     * Build a horizontal stripe gradient from multiple colors
     */
    private buildStripeGradient(colors: string[], alpha: number): string {
        const stripeCount = colors.length;
        const stripePercent = 100 / stripeCount;
        const stops: string[] = [];

        colors.forEach((color, index) => {
            const rgbaColor = this.cssColorToRgba(color, alpha);
            const startPercent = index * stripePercent;
            const endPercent = (index + 1) * stripePercent;
            // Hard stops for crisp stripes (no blending between colors)
            stops.push(`${rgbaColor} ${startPercent}%`);
            stops.push(`${rgbaColor} ${endPercent}%`);
        });

        return `linear-gradient(to right, ${stops.join(', ')})`;
    }

    /**
     * Clear filter colors from all tiles
     */
    private clearFilterColors(): void {
        this.tiles.forEach((tile) => {
            tile.filterColor = undefined;
            tile.filterColors = undefined;
            tile.element.style.setProperty('--filter-color', 'transparent');
            tile.element.style.backgroundImage = 'none';
        });
    }

    /**
     * Convert any CSS color to rgba with alpha
     * Handles: hex (#fff, #ffffff), rgb(), rgba(), hsl(), hsla(), named colors (red, blue, etc.)
     */
    private cssColorToRgba(color: string, alpha: number): string {
        // Use a temporary element to parse CSS colors
        const tempEl = document.createElement('div');
        tempEl.style.color = color;
        document.body.appendChild(tempEl);

        // Get computed color (always returns rgb/rgba format)
        const computedColor = getComputedStyle(tempEl).color;
        document.body.removeChild(tempEl);

        // Parse rgb/rgba values
        const match = computedColor.match(
            /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
        );

        if (match) {
            const r = match[1];
            const g = match[2];
            const b = match[3];
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Fallback: return transparent if parsing fails
        return 'transparent';
    }

    public getRenderStatus(): {
        tileCount: number;
        renderedTileCount: number;
        pendingGlyphCount: number;
        isBatchRendering: boolean;
    } {
        const renderedTileCount = Array.from(this.tiles.values()).filter(
            (tile) => !!tile.cachedData
        ).length;

        return {
            tileCount: this.tiles.size,
            renderedTileCount,
            pendingGlyphCount: this.pendingGlyphIds.size,
            isBatchRendering: this.isBatchRendering
        };
    }

    public async ensureTilesRendered(
        minRenderedTiles: number = 3
    ): Promise<void> {
        if (!this.container || this.tiles.size === 0) {
            return;
        }

        const target = Math.max(1, minRenderedTiles);
        const timeoutMs = 10000;
        const start = performance.now();

        while (performance.now() - start < timeoutMs) {
            const status = this.getRenderStatus();
            if (status.renderedTileCount >= target) {
                return;
            }

            await this.processBatchRender();

            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        }
    }

    public destroy(): void {
        if (this.lineBreakFocusLockTimer !== null) {
            window.clearTimeout(this.lineBreakFocusLockTimer);
            this.lineBreakFocusLockTimer = null;
        }
        this.lineBreakFocusLock = null;
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        if (this.pendingChangedGlyphRefreshTimer !== null) {
            clearTimeout(this.pendingChangedGlyphRefreshTimer);
            this.pendingChangedGlyphRefreshTimer = null;
        }
        window.removeEventListener(
            'glyphChanged',
            this.onGlyphChanged.bind(this)
        );
        window.removeEventListener('fontModelSync', this.onFontModelSyncBound);
        window.removeEventListener('scroll', this.onCapturedScrollBound, {
            capture: true
        } as EventListenerOptions);
        if (this.container) {
            this.container.remove();
        }
        this.tiles.clear();
    }
}

// Export for use in overview-view
(window as any).GlyphOverview = GlyphOverview;
