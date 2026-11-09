// Glyph Overview
// Displays grid of glyph tiles with selection support
// Uses direct canvas rendering for fast display

import tippy, { Instance as TippyInstance } from 'tippy.js';
import { showNotice } from './font-windows/dialogs';
import 'tippy.js/dist/tippy.css';
import { attachGlyphDataPopup } from './glyph-data-popup';
import {
    formatCodepointsHexList,
    parseCodepointsHexList
} from './glyph-search';
// Import filter manager to bundle it with glyph-overview entry point
// It self-registers on window.glyphOverviewFilterManager
import './glyph-overview-filters';
import {
    GlyphOverviewView,
    invalidateSharedGlyphOutlines,
    type FilterResult,
    type GlyphTile
} from './glyph-overview-view';
import { Logger } from './logger';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    keyboardShortcutHtml,
    MENU_SHIFT_SYMBOL,
    setupMenuKeyboardNav
} from './tippy-utils';
import { isOverviewFollowStackScrollEnabled } from './glyph-overview-follow-stack-pref';
import { PATH_FILL_OPACITY_CHANGED_EVENT } from './path-fill-opacity-pref';
import {
    conversionMenuLabel,
    type CompositionOffer
} from './language-packs/composition-conversion';
import {
    appendGlyphOverviewTypeaheadBuffer,
    GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS,
    matchGlyphOverviewTypeahead
} from './glyph-overview-typeahead';
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
        rejected?: boolean;
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

function conversionMenuItem(
    action: string,
    target: 'ccmp' | 'Components',
    count: number,
    reason: string | null,
    canMutate: boolean,
    selectedCount: number
): string {
    const enabled = canMutate && count > 0;
    const disabledClass = enabled ? '' : ' disabled plugin-menu-item-disabled';
    const disabledAttr = enabled ? '' : ' aria-disabled="true"';
    const note = !enabled && canMutate && reason ? reason : '';
    return `
                <div class="plugin-menu-item${disabledClass}" data-action="${action}"${disabledAttr}>
                    <span class="material-symbols-outlined">account_tree</span>
                    <span>${conversionMenuLabel(target, count, selectedCount)}</span>
                    ${note ? `<span class="plugin-menu-shortcut">${note}</span>` : ''}
                </div>`;
}

function formatNameList(names: readonly string[]): string {
    const shown = names.slice(0, 6);
    const extra = names.length - shown.length;
    const body =
        shown.length <= 1
            ? shown[0] || ''
            : shown.length === 2
              ? `${shown[0]} and ${shown[1]}`
              : `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
    return extra > 0 ? `${body}, and ${extra} more` : body;
}

class GlyphOverview extends GlyphOverviewView {
    private propertyPanel: HTMLElement | null = null;
    private glyphDataPopup: TippyInstance | null = null;
    private propertyPanelUpdateRafId: number | null = null;
    private propertyPanelDeferredUntilDragEnd = false;
    private selectionUiFlushPending = false;
    private dragTileRects: DragTileRect[] | null = null;
    private isDragging = false;
    private hasDragged = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private selectionBox: HTMLDivElement | null = null;
    private tileContextMenu: TippyInstance | null = null;
    private contextMenuRequest = 0;
    private fontModelSyncFrame: number | null = null;
    // A cloud commit fetches or publishes one glyph shard at a time, and
    // each one fires fontModelSync. Every refresh walks all tiles, so
    // refresh once per frame instead of once per shard.
    private onFontModelSyncBound = (): void => {
        if (this.fontModelSyncFrame !== null) {
            return;
        }
        const schedule =
            typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (callback: FrameRequestCallback) =>
                      setTimeout(() => callback(performance.now()), 16);
        this.fontModelSyncFrame = schedule(() => {
            this.fontModelSyncFrame = null;
            if (window.cloudPlugin?.isHydratingOverviewGlyphs?.()) {
                return;
            }
            this.reconcileTileHydration();
            this.refreshCcmpTiles();
            this.updatePropertyPanel();
        }) as unknown as number;
    };
    // Currently highlighted editing glyph
    private highlightedGlyphName: string | null = null;
    private highlightScrollSyncRafId: number | null = null;
    private highlightScrollSyncAttempts = 0;
    private readonly maxHighlightScrollSyncAttempts = 8;
    private pendingChangedGlyphNames: Set<string> = new Set();
    private pendingChangedGlyphRefreshTimer: number | null = null;
    private readonly deferredGlyphRefreshDelayMs = 16;
    private readonly activeDragGlyphRefreshDelayMs = 120;
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
        // The Overview title bar holds the view's mode switch, search and size.
        const titleBarRight = document.querySelector<HTMLElement>(
            '#view-overview .view-title-right'
        );
        super(parentElement, {
            mainWindow: true,
            controlsHost: titleBarRight ?? undefined
        });
        this.init();
        this.initKeyboardShortcuts();
    }

    /**
     * Attach the overview property panel (created by overview-view under
     * `#overview-main`) and render the initial empty state.
     */
    public attachPropertyPanel(panel: HTMLElement): void {
        this.propertyPanel = panel;
        this.updatePropertyPanel();
    }

    private init(): void {
        if (!this.container) {
            return;
        }
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
        window.addEventListener('generatedFeaturesChanged', () =>
            this.refreshCcmpTiles()
        );
        window.addEventListener('placeholderOutlinesReady', () => {
            if (!this.outlinePaintAllowed) {
                return;
            }
            void this.renderGlyphOutlines(this.currentLocation);
        });
        window.addEventListener(PATH_FILL_OPACITY_CHANGED_EVENT, () => {
            if (!this.outlinePaintAllowed) {
                return;
            }
            void this.renderGlyphOutlines(this.currentLocation);
        });

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
    }

    private initKeyboardShortcuts(): void {
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

    protected override getCurrentActiveGlyphName(): string | null {
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

    public isViewActive(): boolean {
        const overviewView = document.querySelector('#view-overview');
        return overviewView?.classList.contains('focused') ?? false;
    }

    /**
     * Set the active filter and apply visibility/colors
     * @param results - Array of filter results or null to clear filter
     */
    public override setActiveFilter(results: FilterResult[] | null): void {
        // Clear any previous error
        this.clearFilterError();
        super.setActiveFilter(results);
    }

    protected override onGlyphsSynced(): void {
        this.reconcileSelectionAfterGlyphSync();
    }

    protected override onTilesScrolled(): void {
        if (this.isDragging && this.hasDragged) {
            this.dragTileRects = null;
        }
    }

    protected override onBeforeTileResize(): void {
        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;
    }

    protected override onTileCreated(tile: GlyphTile): void {
        const tileElement = tile.element;
        const glyphId = tile.glyphId;
        const glyphName = tile.glyphName;
        if (glyphName === this.highlightedGlyphName) {
            tileElement.style.boxShadow = 'inset 0 0 0 2px var(--accent-blue)';
        }

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

        // Every overview widget shares outline data; drop the stale copies
        // even for glyphs this overview has no tile for.
        invalidateSharedGlyphOutlines(glyphNames);

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
                this.applyTileHydrationAppearance(targetTile);
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

    private needsSparseDownload(glyphName: string): boolean {
        return (
            !this.isGlyphHydrated(glyphName) ||
            this.isSparseHiddenSupportGlyph(glyphName) ||
            (window.patchSyncEngine?.listSparseWriteBlockers?.([glyphName])
                ?.length ?? 0) > 0
        );
    }

    /**
     * Sparse sessions: a hidden support glyph, or a glyph whose composites
     * or metrics-key inheritors are not resident, must not be edited here.
     * The cascade would skip the missing dependents and leave them stale.
     */
    private canEditSparseGlyphs(glyphNames: string[]): boolean {
        return !glyphNames.some((name) => this.needsSparseDownload(name));
    }

    private async hydrateSelectedUnhydratedGlyphs(): Promise<void> {
        const seedNames = this.getSelectedGlyphNames().filter((name) =>
            this.needsSparseDownload(name)
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
            onCreate: (instance) => {
                instance.popper.addEventListener('click', (event) => {
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
                    } else if (action === 'convert-to-ccmp') {
                        void this.convertSelection('ccmp');
                    } else if (action === 'convert-to-components') {
                        void this.convertSelection('materialized');
                    }
                });
            },
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) return;
                setupMenuKeyboardNav(menu);
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
            const hasUnhydrated =
                selectedNames.some((name) => !this.isGlyphHydrated(name)) ||
                !this.canEditSparseGlyphs(selectedNames);
            const canHydrate =
                selectedNames.some((name) => this.needsSparseDownload(name)) &&
                window.fontManager?.currentFont?.sourcePlugin?.getId?.() ===
                    'cloud';
            const point = { x: event.clientX, y: event.clientY };
            void this.presentTileContextMenu(
                canAct,
                canHydrate,
                hasUnhydrated,
                selectedNames,
                point
            );
        });
    }

    private async presentTileContextMenu(
        canAct: boolean,
        canHydrate: boolean,
        hasUnhydrated: boolean,
        selectedNames: string[],
        point: { x: number; y: number }
    ): Promise<void> {
        if (!this.tileContextMenu) {
            return;
        }
        const request = ++this.contextMenuRequest;
        const canMutate = canAct && !hasUnhydrated;
        let offer: CompositionOffer | null = null;
        if (canMutate) {
            const { loadCompositionOffer } =
                await import('./language-packs/composition-conversion');
            offer = await loadCompositionOffer(selectedNames);
        }
        if (request !== this.contextMenuRequest || !this.tileContextMenu) {
            return;
        }
        this.tileContextMenu.hide();
        this.tileContextMenu.setContent(
            this.createTileContextMenuHtml(
                canAct,
                canHydrate,
                hasUnhydrated,
                offer,
                selectedNames.length
            )
        );
        this.tileContextMenu.setProps({
            getReferenceClientRect: () => ({
                width: 0,
                height: 0,
                top: point.y,
                bottom: point.y,
                left: point.x,
                right: point.x,
                x: point.x,
                y: point.y,
                toJSON: () => ({})
            })
        });
        this.tileContextMenu.show();
    }

    private async convertSelection(
        output: 'ccmp' | 'materialized'
    ): Promise<void> {
        const names = this.getSelectedGlyphNames();
        const { loadCompositionOffer, convertSelectedGlyphs } =
            await import('./language-packs/composition-conversion');
        const offer = await loadCompositionOffer(names);
        const targets = output === 'ccmp' ? offer.toCcmp : offer.toComponents;
        const drawn =
            output === 'ccmp'
                ? offer.outlinesLostByCcmp
                : offer.outlinesLostByComponents;
        if (!targets.length) {
            return;
        }
        if (drawn.length) {
            const { showProceedDialog } = await import('./ui/confirm-dialog');
            const proceed = await showProceedDialog(
                output === 'ccmp' ? 'Convert to ccmp' : 'Convert to Components',
                `Replace the outlines of ${formatNameList(drawn)}?`
            );
            if (!proceed) {
                return;
            }
        }
        const kept = await convertSelectedGlyphs(targets, output);
        if (kept.length) {
            const { showProceedDialog: showKept } =
                await import('./ui/confirm-dialog');
            await showKept(
                'Kept glyphs',
                `${formatNameList(kept)} stayed in the font because another glyph, feature, or kerning pair uses them.`
            );
        }
    }

    private createTileContextMenuHtml(
        canAct = true,
        canHydrate = false,
        hasUnhydrated = false,
        offer: CompositionOffer | null = null,
        selectedCount = 0
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
                ${conversionMenuItem(
                    'convert-to-ccmp',
                    'ccmp',
                    offer?.toCcmp.length || 0,
                    offer?.ccmpReason || null,
                    canMutate,
                    selectedCount
                )}
                ${conversionMenuItem(
                    'convert-to-components',
                    'Components',
                    offer?.toComponents.length || 0,
                    offer?.componentsReason || null,
                    canMutate,
                    selectedCount
                )}
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
        this.glyphDataPopup?.destroy();
        this.glyphDataPopup = null;
        this.propertyPanel.textContent = '';
        this.propertyPanel.classList.remove('glyph-kerning-groups-panel');

        const content = document.createElement('div');
        content.className = 'glyph-property-panel-content';

        const selectedNames = this.getSelectedGlyphNames();
        const singleGlyph =
            selectedNames.length === 1 ? this.getSelectedGlyphModel() : null;
        const nameEditable = Boolean(singleGlyph);
        const sparseEditable = this.canEditSparseGlyphs(selectedNames);
        const unicodeEditable =
            nameEditable &&
            sparseEditable &&
            this.isGlyphHydrated(singleGlyph?.name || '');
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
        const unicodeLabelRow = document.createElement('div');
        unicodeLabelRow.className = 'glyph-property-control-label-row';
        unicodeLabelRow.appendChild(unicodeLabel);
        const glyphDataButton = document.createElement('button');
        glyphDataButton.type = 'button';
        glyphDataButton.className =
            'glyph-property-info-btn material-symbols-outlined';
        glyphDataButton.textContent = 'info';
        glyphDataButton.title = 'Glyph data';
        glyphDataButton.setAttribute('aria-label', 'Show glyph data');
        glyphDataButton.disabled = !singleGlyph;
        const glyphDataName = singleGlyph?.name ?? null;
        this.glyphDataPopup = attachGlyphDataPopup(
            glyphDataButton,
            () => glyphDataName
        );
        unicodeLabelRow.appendChild(glyphDataButton);
        unicodeControl.appendChild(unicodeLabelRow);

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
                layers.length > 0 && sparseEditable,
                sidebearingSummary.left
            )
        );
        content.appendChild(nameControl);
        content.appendChild(unicodeControl);
        content.appendChild(
            this.createOverviewSidebearingControl(
                'right',
                'RSB',
                layers.length > 0 && sparseEditable,
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
                          void this.commitOverviewSidebearing(
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
            void this.commitOverviewSidebearing(side, input.value);
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

    private async commitOverviewSidebearing(
        side: SidebearingSide,
        rawValue: string
    ): Promise<void> {
        const trimmed = rawValue.trim();
        if (
            trimmed &&
            !isPlainNumericInputValue(trimmed) &&
            window.cloudPlugin?.prepareMetricsKeyInput &&
            !(await window.cloudPlugin.prepareMetricsKeyInput(trimmed))
        ) {
            this.updatePropertyPanel();
            return;
        }
        const layers = this.getSelectedOverviewLayers();
        if (
            layers.length === 0 ||
            !this.canEditSparseGlyphs(this.getSelectedGlyphNames())
        ) {
            this.updatePropertyPanel();
            return;
        }

        window.fontManager?.setEditingCompileContext?.(
            'keyboard-sidebearing',
            null
        );

        const bridge = window.patchSyncEngine;
        const label = getSidebearingTransactionLabel(side);
        bridge?.beginTransaction(label, null, {
            compileChangeSource: 'keyboard-sidebearing',
            compileEditType: null
        });
        try {
            for (const layer of layers) {
                const resolution = layer.applySidebearingInput(side, rawValue);
                if (resolution?.rejected) {
                    // The same key is refused for every layer.
                    if (resolution.error) {
                        showNotice(resolution.error);
                    }
                    break;
                }
            }
        } finally {
            bridge?.endTransaction();
        }

        this.updatePropertyPanel();
    }

    private commitOverviewGlyphName(rawValue: string): void {
        const singleGlyph = this.getSelectedGlyphModel();
        const fontModel = window.currentFontModel;
        if (
            !singleGlyph ||
            !fontModel ||
            !this.canEditSparseGlyphs([singleGlyph.name])
        ) {
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

        window.patchSyncEngine?.beginTransaction('Set glyph Unicode', null, {
            compileChangeSource: 'font-info',
            compileEditType: null
        });
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
                : 'Remove kern group membership',
            null,
            {
                compileChangeSource: 'keyboard-kerning-groups',
                compileEditType: 'kerning-groups'
            }
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

    public destroy(): void {
        if (this.pendingChangedGlyphRefreshTimer !== null) {
            clearTimeout(this.pendingChangedGlyphRefreshTimer);
            this.pendingChangedGlyphRefreshTimer = null;
        }
        window.removeEventListener(
            'glyphChanged',
            this.onGlyphChanged.bind(this)
        );
        window.removeEventListener('fontModelSync', this.onFontModelSyncBound);
        super.destroy();
    }
}

export {
    OVERVIEW_TILE_GAP_PX,
    OVERVIEW_TILE_PADDING_PX,
    computeLinesModeTileLayout,
    overviewTileCanvasBackingBytes,
    type FilterResult
} from './glyph-overview-view';

// Export for use in overview-view
(window as any).GlyphOverview = GlyphOverview;
