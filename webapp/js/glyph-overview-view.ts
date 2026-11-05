// Glyph Overview View
// Draws a list of glyphs as tiles: Normal and Matrix layouts, lines
// virtualization, the tile cache budget, search, tile size and group tint.
// Hosts supply the glyphs and decide where the view's controls go.
// GlyphOverview (glyph-overview.ts) adds the main window's selection,
// keyboard navigation, menus and font events on top.

import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
import {
    glyphNameMatchesSearchTerms,
    parseGlyphSearchTerms
} from './glyph-search';
import { catalogCodepointsByGlyphName } from './filesystem-plugins/cloud-glyph-catalog';
import { Logger } from './logger';
import { timelineSpanStart, timelineSpanEnd } from './perf-timeline';
import { isCcmpShellGlyph } from './language-packs/ccmp-shells';
import {
    getOverviewDisplayMode,
    getOverviewSize,
    setOverviewDisplayMode,
    setOverviewSize,
    type OverviewDisplayMode
} from './window-ui-state';
import APP_SETTINGS from './settings';

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

export interface GlyphTile {
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

export type OverviewViewMode = 'lines' | 'grid';

export function viewModeFromDisplayMode(
    mode: OverviewDisplayMode
): OverviewViewMode {
    return mode === 'matrix' ? 'grid' : 'lines';
}

export function displayModeFromViewMode(
    mode: OverviewViewMode
): OverviewDisplayMode {
    return mode === 'grid' ? 'matrix' : 'normal';
}

interface GridNameParts {
    baseName: string;
    variantSuffix: string;
}

export interface GridLayoutData {
    columns: string[];
    rows: Array<Array<string | null>>;
    visibleIds: string[];
}

export type ResizeFocusAnchor =
    | {
          type: 'selection';
          glyphIds: string[];
      }
    | {
          type: 'center';
          glyphId: string;
      };

/**
 * Outline data from the compile worker, shared by every overview widget, so
 * a second widget (the filter editor) or rebuilt tiles paint without asking
 * the worker again. Scoped to one font; a glyph's entries are dropped when it
 * changes (`invalidateSharedGlyphOutlines`). Least recently used glyphs go
 * first beyond the cap.
 */
const SHARED_OUTLINE_GLYPH_LIMIT = 20000;
let sharedOutlineFont = '';
const sharedOutlines = new Map<string, Map<string, unknown>>();

function sharedOutlineLocationKey(location: Record<string, number>): string {
    return JSON.stringify(
        Object.keys(location)
            .sort()
            .map((axis) => [axis, location[axis]])
    );
}

function useSharedOutlineFont(fontKey: string): void {
    if (fontKey !== sharedOutlineFont) {
        sharedOutlineFont = fontKey;
        sharedOutlines.clear();
    }
}

function getSharedOutline(
    fontKey: string,
    locationKey: string,
    glyphName: string
): unknown {
    useSharedOutlineFont(fontKey);
    const byLocation = sharedOutlines.get(glyphName);
    const outline = byLocation?.get(locationKey);
    if (byLocation && outline !== undefined) {
        sharedOutlines.delete(glyphName);
        sharedOutlines.set(glyphName, byLocation);
    }
    return outline;
}

function setSharedOutline(
    fontKey: string,
    locationKey: string,
    glyphName: string,
    outline: unknown
): void {
    useSharedOutlineFont(fontKey);
    const byLocation = sharedOutlines.get(glyphName) ?? new Map();
    byLocation.set(locationKey, outline);
    sharedOutlines.delete(glyphName);
    sharedOutlines.set(glyphName, byLocation);
    while (sharedOutlines.size > SHARED_OUTLINE_GLYPH_LIMIT) {
        const oldest = sharedOutlines.keys().next().value;
        if (oldest === undefined) break;
        sharedOutlines.delete(oldest);
    }
}

/** The glyph name of one worker outline, or null. */
function sharedOutlineName(outline: unknown): string | null {
    if (outline && typeof outline === 'object' && 'name' in outline) {
        return typeof outline.name === 'string' ? outline.name : null;
    }
    return null;
}

function storeSharedOutlines(
    fontKey: string,
    locationKey: string,
    outlines: unknown
): void {
    if (!Array.isArray(outlines)) return;
    for (const outline of outlines) {
        const name = sharedOutlineName(outline);
        if (name) setSharedOutline(fontKey, locationKey, name, outline);
    }
}

/** Forget shared outlines of glyphs whose data changed. */
export function invalidateSharedGlyphOutlines(
    glyphNames: Iterable<string>
): void {
    for (const name of glyphNames) {
        sharedOutlines.delete(name);
    }
}

/** One glyph the host asks the view to show. */
export interface OverviewGlyphRecord {
    id: string;
    name: string;
    codepoints?: number[];
}

export interface GlyphOverviewViewOptions {
    /**
     * Where the Normal/Matrix switch, search field and size slider go.
     * Omitted: they go into `controlsElement` (a `.glyph-overview-bar`),
     * which the host places itself.
     */
    controlsHost?: HTMLElement;
    /**
     * Main window only: keep the fixed ids (`glyph-overview-container`,
     * `overview-search-input`, …) and persist mode and size.
     */
    mainWindow?: boolean;
    /** Starting mode and size. Default: the main overview's saved ones. */
    displayMode?: OverviewDisplayMode;
    sizeStep?: number;
    /** Paint outlines as soon as glyphs are set. Default: true. */
    outlinePaintAllowed?: boolean;
    /** Tile cache share in bytes. Default: the app-wide overview budget. */
    tileCacheBudgetBytes?: number;
    /** Axis location the outlines are drawn at. Default: the default location. */
    location?: Record<string, number>;
}

/**
 * Builds `.overview-mode-toggle`, `.overview-search-control` and
 * `.overview-size-control` with the main title bar's markup.
 */
function createOverviewControls(mainWindow: boolean): {
    modeToggle: HTMLDivElement;
    linesModeButton: HTMLButtonElement;
    gridModeButton: HTMLButtonElement;
    searchControl: HTMLDivElement;
    searchInput: HTMLInputElement;
    sizeControl: HTMLDivElement;
    sizeSlider: HTMLInputElement;
} {
    const modeButton = (
        id: string,
        title: string,
        icon: string
    ): HTMLButtonElement => {
        const button = document.createElement('button');
        if (mainWindow) {
            button.id = id;
        }
        button.className = 'view-title-button context-tab overview-mode-btn';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('aria-pressed', 'false');
        const iconElement = document.createElement('span');
        iconElement.className = 'material-symbols-outlined';
        iconElement.textContent = icon;
        button.appendChild(iconElement);
        return button;
    };

    const modeToggle = document.createElement('div');
    modeToggle.className = 'overview-mode-toggle';
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Overview mode');
    const linesModeButton = modeButton(
        'overview-mode-lines',
        'Normal Mode',
        'border_all'
    );
    const gridModeButton = modeButton(
        'overview-mode-grid',
        'Matrix Mode',
        'crossword'
    );
    modeToggle.append(linesModeButton, gridModeButton);

    const searchControl = document.createElement('div');
    searchControl.className = 'view-title-field overview-search-control';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'material-symbols-outlined overview-search-icon';
    searchIcon.textContent = 'search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'overview-search-input';
    if (mainWindow) {
        searchInput.id = 'overview-search-input';
    }
    searchInput.placeholder = 'Search glyphs...';
    searchControl.append(searchIcon, searchInput);

    const sizeControl = document.createElement('div');
    sizeControl.className = 'overview-size-control';
    const sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.className = 'overview-size-slider';
    if (mainWindow) {
        sizeSlider.id = 'overview-size-slider';
    }
    sizeSlider.min = '0';
    sizeSlider.max = '10';
    sizeSlider.step = '1';
    sizeSlider.value = '5';
    sizeControl.appendChild(sizeSlider);

    return {
        modeToggle,
        linesModeButton,
        gridModeButton,
        searchControl,
        searchInput,
        sizeControl,
        sizeSlider
    };
}

/** Group keywords of one filter result (`groups`, else `group`). */
export function filterResultGroups(result: FilterResult): string[] {
    if (Array.isArray(result.groups)) {
        return result.groups;
    }
    return typeof result.group === 'string' ? [result.group] : [];
}

export class GlyphOverviewView {
    protected container: HTMLDivElement | null = null;
    /** Holds the controls unless `controlsHost` was given. */
    public readonly controlsElement: HTMLDivElement;
    protected readonly controlElements: HTMLElement[];
    protected readonly mainWindow: boolean;
    protected readonly tileCacheBudgetOverride: number | null;
    protected resizeObserver: ResizeObserver | null = null;
    protected themeObserver: MutationObserver | null = null;
    protected lastContainerWidth = 0;
    protected lastLinesColumnCount = 0;
    protected lineBreakFocusLock: ResizeFocusAnchor | null = null;
    protected lineBreakFocusLockTimer: number | null = null;
    protected readonly lineBreakFocusLockSettleMs = 250;
    protected tiles: Map<string, GlyphTile> = new Map();
    protected currentLocation: Record<string, number> = {};
    /**
     * When false, block all outline paints (including setActiveFilter / location
     * events). Open path enables this only for the single fontReady paint.
     */
    protected outlinePaintAllowed = false;
    protected outlineRenderGeneration = 0;
    protected intersectionObserver: IntersectionObserver | null = null;
    protected lazyLoadEnabled: boolean = false;
    // Batched lazy loading
    protected pendingGlyphIds: Set<string> = new Set();
    protected batchDebounceTimer: number | null = null;
    protected isBatchRendering: boolean = false;
    protected tileBuildRunId = 0;
    protected tileBuildPromise: Promise<void> = Promise.resolve();
    protected tileBuildResolve: (() => void) | null = null;
    protected deferredTileBuildTimer: number | null = null;
    protected linesVirtualizationActive = false;
    protected virtualizedRenderRafPending = false;
    protected scrollVisibilitySyncRafId: number | null = null;
    protected virtualizedRenderRange: { start: number; end: number } | null =
        null;
    protected readonly linesVirtualizationThreshold = 1200;
    protected readonly linesVirtualizationBufferRows = 6;
    protected readonly tileCacheViewportMarginPx = 100;
    protected tileViewClock = 0;
    protected onContainerScrollBound = this.onContainerScroll.bind(this);
    protected onCapturedScrollBound = this.onCapturedScroll.bind(this);
    protected lastOverviewFontKey = '';
    protected lazyBatchSize = 240;
    protected readonly minLazyBatchSize = 80;
    protected readonly maxLazyBatchSize = 500;
    protected updateGlyphsSpanId: string | null = null;
    // Cached metrics for tile rendering
    protected renderMetrics: {
        ascender: number;
        descender: number;
        upm: number;
    } | null = null;
    // Tile size control
    protected currentSizeStep: number = 5;
    protected sizeSlider: HTMLInputElement | null = null;
    // Search control
    protected searchInput: HTMLInputElement | null = null;
    protected searchTerms: string[] = [];
    // View mode control
    protected viewMode: OverviewViewMode = 'lines';
    protected linesModeButton: HTMLButtonElement | null = null;
    protected gridModeButton: HTMLButtonElement | null = null;
    protected visibleGlyphIds: string[] = [];
    protected glyphOrderIds: string[] = [];
    protected glyphDataById: Map<string, OverviewGlyphRecord> = new Map();
    protected catalogCodepointsByName: Map<string, number[]> | null = null;
    protected totalGlyphDatasetCount = 0;
    protected gridRowsForNavigation: Array<Array<string | null>> = [];
    protected gridColumnCount = 0;
    // Active filter
    protected activeFilterResults: Map<string, FilterResult> | null = null;
    /** Only glyphs in this group are shown (filter results must be set). */
    protected activeGroup: string | null = null;

    constructor(
        parentElement: HTMLElement,
        options: GlyphOverviewViewOptions = {}
    ) {
        this.mainWindow = options.mainWindow === true;
        this.tileCacheBudgetOverride =
            typeof options.tileCacheBudgetBytes === 'number'
                ? options.tileCacheBudgetBytes
                : null;
        if (options.location) {
            this.currentLocation = { ...options.location };
        }
        if (!this.mainWindow) {
            this.outlinePaintAllowed = options.outlinePaintAllowed !== false;
        }

        // Create main container for glyph tiles
        this.container = document.createElement('div');
        this.container.className = 'glyph-overview-container';
        if (this.mainWindow) {
            this.container.id = 'glyph-overview-container';
        }
        parentElement.appendChild(this.container);
        this.setupResizeObserver();

        window.addEventListener('scroll', this.onCapturedScrollBound, {
            capture: true,
            passive: true
        });

        // Listen for theme changes to re-render tiles
        this.themeObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (
                    mutation.type === 'attributes' &&
                    mutation.attributeName === 'data-theme'
                ) {
                    this.onThemeChanged();
                }
            });
        });
        this.themeObserver.observe(document.documentElement, {
            attributes: true
        });

        const controls = createOverviewControls(this.mainWindow);
        this.linesModeButton = controls.linesModeButton;
        this.gridModeButton = controls.gridModeButton;
        this.searchInput = controls.searchInput;
        this.sizeSlider = controls.sizeSlider;
        this.controlElements = [
            controls.modeToggle,
            controls.searchControl,
            controls.sizeControl
        ];
        this.controlsElement = document.createElement('div');
        this.controlsElement.className = 'glyph-overview-bar';
        (options.controlsHost ?? this.controlsElement).append(
            ...this.controlElements
        );

        this.initSizeControl(options.sizeStep);
        this.initSearchControl();
        this.initViewModeControl(options.displayMode);
    }

    private initSizeControl(sizeStep: number | undefined): void {
        this.currentSizeStep =
            typeof sizeStep === 'number' ? sizeStep : getOverviewSize();

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
                if (this.mainWindow) {
                    setOverviewSize(newSize);
                }
            });
        }

        this.applyOverviewTileLayout();
    }

    private initSearchControl(): void {
        if (this.searchInput) {
            // Listen for input changes
            this.searchInput.addEventListener('input', (e) => {
                this.searchTerms = parseGlyphSearchTerms(
                    (e.target as HTMLInputElement).value
                );
                this.applySearchFilter();
            });
        }
    }

    private initViewModeControl(
        displayMode: OverviewDisplayMode | undefined
    ): void {
        this.viewMode = viewModeFromDisplayMode(
            displayMode ?? getOverviewDisplayMode()
        );

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

    /** The scrolling element that holds the tiles. */
    public getContainer(): HTMLDivElement | null {
        return this.container;
    }

    public getDisplayMode(): OverviewDisplayMode {
        return displayModeFromViewMode(this.viewMode);
    }

    public getSizeStep(): number {
        return this.currentSizeStep;
    }

    public getCurrentLocation(): Record<string, number> {
        return { ...this.currentLocation };
    }

    /** Glyph names currently shown, after group, filter and search. */
    public getVisibleGlyphNames(): string[] {
        return this.visibleGlyphIds.map(
            (glyphId) => this.tiles.get(glyphId)?.glyphName ?? glyphId
        );
    }

    /**
     * Show these glyphs (font order) and paint them at the view's location
     * when outline paints are allowed.
     */
    public async setGlyphs(glyphs: OverviewGlyphRecord[]): Promise<void> {
        await this.updateGlyphs(glyphs);
        if (this.outlinePaintAllowed) {
            await this.renderGlyphOutlines(this.currentLocation);
        }
    }

    /** Group membership and colors per glyph; null clears the tint. */
    public setGroups(results: FilterResult[] | null): void {
        this.setActiveFilter(results);
    }

    /** Show only glyphs in this group; null shows every glyph again. */
    public setActiveGroup(group: string | null): void {
        if (this.activeGroup === group) {
            return;
        }
        this.activeGroup = group;
        this.applySearchFilter();
    }

    public getActiveGroup(): string | null {
        return this.activeGroup;
    }

    /**
     * Drop every painted tile bitmap and cached outline, e.g. while the view
     * is hidden. `repaint()` brings the visible tiles back.
     */
    public releaseTileCaches(): void {
        this.outlineRenderGeneration += 1;
        this.pendingGlyphIds.clear();
        this.evictAllTileCaches();
    }

    public repaint(): Promise<void> {
        return this.renderGlyphOutlines(this.currentLocation, { force: true });
    }

    /** Selection-free view: no glyph is selected. Main overview overrides. */
    protected getCurrentActiveGlyphName(): string | null {
        return null;
    }

    /** Main overview adds click handlers and the editing highlight. */
    protected onTileCreated(_tile: GlyphTile): void {}

    /** Called after syncGlyphs / updateGlyphs rebuilt the visible tiles. */
    protected onGlyphsSynced(): void {}

    /** Called when the tile container scrolls (drag-select cache reset). */
    protected onTilesScrolled(): void {}

    /** Called before a tile-size change re-lays out the tiles. */
    protected onBeforeTileResize(): void {}

    protected setupResizeObserver(): void {
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

    protected lockLineBreakFocusAnchor(
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

    protected applyLineBreakFocusLock(anchor: ResizeFocusAnchor | null): void {
        if (!anchor) {
            return;
        }

        const glyphIds =
            anchor.type === 'selection' ? anchor.glyphIds : [anchor.glyphId];
        this.centerGlyphIdsInView(glyphIds);
    }

    protected updateSliderProgress(): void {
        if (!this.sizeSlider) return;
        const percent = (this.currentSizeStep / 10) * 100;
        this.sizeSlider.style.setProperty('--value-percent', `${percent}%`);
    }

    protected setViewMode(
        mode: OverviewViewMode,
        persist: boolean = true,
        force: boolean = false
    ): void {
        if (!force && this.viewMode === mode) return;

        this.viewMode = mode;
        if (persist && this.mainWindow) {
            setOverviewDisplayMode(displayModeFromViewMode(mode));
        }
        this.updateViewModeButtonState();
        this.renderByViewMode();
        this.applyOverviewTileLayout();
    }

    protected updateViewModeButtonState(): void {
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

    protected applySearchFilter(): void {
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

    protected computeVisibleGlyphIds(): string[] {
        const visibleIds: string[] = [];

        // Walk font order (glyphOrderIds), not Map insertion order — new
        // tiles are appended to the Map and would otherwise appear last.
        for (const glyphId of this.glyphOrderIds) {
            const tile = this.tiles.get(glyphId);
            if (!tile) {
                continue;
            }

            const filterResult =
                this.activeFilterResults === null
                    ? undefined
                    : this.activeFilterResults.get(tile.glyphName);
            const passesFilter =
                this.activeFilterResults === null ||
                (filterResult !== undefined &&
                    (this.activeGroup === null ||
                        filterResultGroups(filterResult).includes(
                            this.activeGroup
                        )));

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

    protected renderByViewMode(): void {
        if (!this.container) return;

        if (this.viewMode === 'grid') {
            this.renderGridMode();
            return;
        }

        this.renderLinesMode();
    }

    protected renderLinesMode(): void {
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

    protected renderGridMode(): void {
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

    protected shouldVirtualizeLinesMode(): boolean {
        return (
            this.viewMode === 'lines' &&
            this.visibleGlyphIds.length >= this.linesVirtualizationThreshold
        );
    }

    protected enableLinesVirtualization(): void {
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

    protected detachLinesVirtualization(): void {
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

    protected onContainerScroll(): void {
        this.onTilesScrolled();
        if (!this.linesVirtualizationActive || !this.container) {
            return;
        }

        this.scheduleScrollVisibilitySync();
    }

    protected onCapturedScroll(event: Event): void {
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

        this.onTilesScrolled();

        this.scheduleScrollVisibilitySync();
    }

    protected scheduleScrollVisibilitySync(): void {
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

    protected queueVisibleUncachedTiles(): number {
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

            if (isCcmpShellGlyph(tile.glyphName)) {
                this.syncCcmpTile(tile);
                continue;
            }

            if (tile.cachedData || this.pendingGlyphIds.has(tile.glyphId)) {
                continue;
            }

            this.pendingGlyphIds.add(tile.glyphId);
            queuedCount += 1;
        }

        return queuedCount;
    }

    protected renderVirtualizedLinesWindow(force: boolean = false): void {
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

    protected buildGridLayoutData(visibleIds: string[]): GridLayoutData {
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

    protected parseGridName(glyphName: string): GridNameParts {
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

    protected getTileDimensions(): { width: number; height: number } {
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
    protected applyOverviewTileLayout(): void {
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
    protected syncLinesModeColumnsFromContainer(): boolean {
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

    protected getTileCacheBudgetBytes(): number {
        if (this.tileCacheBudgetOverride !== null) {
            return this.tileCacheBudgetOverride;
        }
        return APP_SETTINGS.GLYPH_OVERVIEW.TILE_CACHE_MAX_BYTES;
    }

    protected isTileInOverscan(
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

    protected touchTileViewed(tile: GlyphTile): void {
        this.tileViewClock += 1;
        tile.lastViewedAt = this.tileViewClock;
    }

    protected evictTileCache(tile: GlyphTile): void {
        if (tile.canvas) {
            tile.canvas.width = 0;
            tile.canvas.height = 0;
            tile.canvas.style.width = '';
            tile.canvas.style.height = '';
        }
        tile.cachedData = undefined;
    }

    protected evictAllTileCaches(): void {
        for (const tile of this.tiles.values()) {
            this.evictTileCache(tile);
        }
    }

    protected tileCacheBytes(tile: GlyphTile): number {
        return tile.canvas ? overviewTileCanvasBackingBytes(tile.canvas) : 0;
    }

    protected tileHoldsCache(tile: GlyphTile): boolean {
        return Boolean(tile.cachedData) || this.tileCacheBytes(tile) > 0;
    }

    protected enforceTileCacheBudget(): void {
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

    protected updateTileSize(): void {
        const columnsForVisibility =
            this.lastLinesColumnCount > 0
                ? this.lastLinesColumnCount
                : Math.max(1, this.getGridColumns());
        const resizeFocusAnchor =
            this.getResizeFocusAnchor(columnsForVisibility);
        this.lastLinesColumnCount = 0;
        this.applyOverviewTileLayout();

        this.onBeforeTileResize();

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

    protected getResizeFocusAnchor(
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

    protected findVisibleTileIdByGlyphName(glyphName: string): string | null {
        for (const glyphId of this.visibleGlyphIds) {
            const tile = this.tiles.get(glyphId);
            if (tile?.glyphName === glyphName) {
                return glyphId;
            }
        }
        return null;
    }

    protected isGlyphIdInOverviewViewport(
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

    protected getGlyphIdNearestOverviewViewportCenter(
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

    protected applyResizeFocusAnchor(anchor: ResizeFocusAnchor | null): void {
        if (!anchor) {
            return;
        }

        if (anchor.type === 'selection') {
            this.ensureGlyphIdsInView(anchor.glyphIds);
            return;
        }

        this.centerGlyphIdsInView([anchor.glyphId]);
    }

    protected centerGlyphIdsInView(glyphIds: string[]): void {
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
    protected ensureGlyphIdsInView(
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

    protected getVisibleGlyphIdsContentBounds(
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
    protected getConnectedTileContentBounds(
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

    protected setCenteredScrollTop(contentCenterY: number): void {
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

    /**
     * Normalize overview glyph records to stable name-keyed ids.
     */
    protected normalizeGlyphRecords(
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

        this.onGlyphsSynced();

        if (removedIds.length > 0 || addedIds.length > 0) {
            console.log(
                `Synced overview glyphs (+${addedIds.length} / -${removedIds.length}, reused ${this.tiles.size - addedIds.length})`
            );
        }

        return Promise.resolve();
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

            this.onGlyphsSynced();
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
                this.onGlyphsSynced();
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

    protected primeInitialVisibleTileBatch(): number {
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

    protected async renderOutlinesInChunks(
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
    protected updateRenderMetrics(): void {
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
    protected renderTileCanvas(
        tile: GlyphTile,
        glyphData: any,
        width?: number,
        height?: number
    ): boolean {
        // Use provided dimensions or get current size
        const dims =
            width && height ? { width, height } : this.getTileDimensions();

        if (isCcmpShellGlyph(tile.glyphName)) {
            this.syncCcmpTile(tile);
            return true;
        }

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
    protected renderTile(
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

    protected async refreshChangedGlyphTiles(
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
            storeSharedOutlines(
                this.overviewFontIdentityKey(),
                sharedOutlineLocationKey(this.currentLocation),
                outlines
            );

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
    protected onThemeChanged(): void {
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

    protected isTileFullyVisible(element: HTMLElement): boolean {
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
    protected scrollToTile(
        element: HTMLElement,
        animate: boolean = true
    ): void {
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

    protected scrollToGlyphId(
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

    protected setupLazyLoading(): void {
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

    protected scheduleBatchRender(): void {
        // Debounce: wait 16ms (one frame) to collect more tiles before rendering
        if (this.batchDebounceTimer !== null) {
            return; // Already scheduled
        }
        this.batchDebounceTimer = window.setTimeout(() => {
            this.batchDebounceTimer = null;
            this.processBatchRender();
        }, 16);
    }

    protected async processBatchRender(
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

        const fontKey = this.overviewFontIdentityKey();
        const locationKey = sharedOutlineLocationKey(batchLocation);
        const sharedHits: unknown[] = [];
        const fetchNames: string[] = [];
        for (const glyphName of glyphNames) {
            const shared = getSharedOutline(fontKey, locationKey, glyphName);
            if (shared !== undefined) {
                sharedHits.push(shared);
            } else {
                fetchNames.push(glyphName);
            }
        }

        const fontComp = window.fontCompilation;
        try {
            let fetched: unknown = [];
            if (fetchNames.length > 0) {
                if (!fontComp) {
                    throw new Error('fontCompilation not available on window');
                }
                const fetchBatchSpanId = timelineSpanStart(
                    'overview.outlines.fetchBatch',
                    {
                        glyphCount: fetchNames.length
                    }
                );
                let response;
                try {
                    response = await fontComp.sendMessage({
                        type: 'getGlyphOutlines',
                        glyphNames: fetchNames,
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
                        glyphCount: fetchNames.length
                    }
                );
                try {
                    fetched = JSON.parse(response.outlinesJson);
                } finally {
                    timelineSpanEnd(parseBatchSpanId);
                }
                storeSharedOutlines(fontKey, locationKey, fetched);
            }
            const outlines = [
                ...sharedHits,
                ...(Array.isArray(fetched) ? fetched : [])
            ];

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

    protected createGlyphTile(glyphId: string, glyphName: string): GlyphTile {
        const tileElement = document.createElement('div');
        tileElement.className = 'glyph-tile';
        tileElement.dataset.glyphId = glyphId;
        tileElement.dataset.glyphName = glyphName;

        // Pre-create canvas to avoid DOM insertion during render.
        // HTML defaults to 300×150; keep unused tiles at 0×0 so they
        // do not allocate a backing store or inflate memory accounting.
        const canvas = document.createElement('canvas');
        canvas.className = 'glyph-tile-canvas';
        canvas.width = 0;
        canvas.height = 0;
        tileElement.appendChild(canvas);

        const ccmpStandIn = document.createElement('div');
        ccmpStandIn.className = 'glyph-tile-ccmp';
        ccmpStandIn.hidden = true;
        const ccmpChar = document.createElement('span');
        ccmpChar.className = 'glyph-tile-ccmp-char';
        const ccmpBadge = document.createElement('span');
        ccmpBadge.className = 'glyph-tile-ccmp-badge';
        ccmpBadge.textContent = 'ccmp';
        ccmpStandIn.append(ccmpChar, ccmpBadge);
        tileElement.appendChild(ccmpStandIn);

        const cloudIcon = document.createElement('span');
        cloudIcon.className = 'glyph-tile-cloud-icon material-symbols-outlined';
        cloudIcon.textContent = 'cloud';
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

        const tile: GlyphTile = {
            element: tileElement,
            glyphId: glyphId,
            glyphName: glyphName,
            selected: false,
            lastViewedAt: 0,
            canvas: canvas
        };
        if (this.isGlyphHydrated(glyphName)) {
            this.applyTileHydrationAppearance(tile);
        } else {
            this.applyUnhydratedTileAppearance(tile);
        }
        this.syncCcmpTile(tile);
        this.onTileCreated(tile);
        return tile;
    }

    protected refreshCcmpTiles(): void {
        for (const tile of this.tiles.values()) {
            this.syncCcmpTile(tile);
        }
        if (!this.outlinePaintAllowed) {
            return;
        }
        if (this.queueVisibleUncachedTiles() > 0) {
            this.scheduleBatchRender();
        }
    }

    protected syncCcmpTile(tile: GlyphTile): void {
        const standIn = tile.element.querySelector(
            '.glyph-tile-ccmp'
        ) as HTMLElement | null;
        if (!standIn) {
            return;
        }
        const shell = isCcmpShellGlyph(tile.glyphName);
        const wasShell = tile.element.classList.contains(
            'glyph-tile-ccmp-shell'
        );
        standIn.hidden = !shell;
        tile.element.classList.toggle('glyph-tile-ccmp-shell', shell);
        if (!shell) {
            if (wasShell) {
                tile.cachedData = undefined;
                this.pendingGlyphIds.delete(tile.glyphId);
            }
            return;
        }
        const character = standIn.querySelector('.glyph-tile-ccmp-char');
        const codepoint = this.getOverviewCodepoints(tile.glyphName).find(
            (value) =>
                Number.isInteger(value) &&
                value >= 0 &&
                value <= 0x10ffff &&
                (value < 0xd800 || value > 0xdfff)
        );
        if (character) {
            character.textContent =
                codepoint == null ? '' : String.fromCodePoint(codepoint);
        }
        if (
            tile.canvas &&
            (tile.canvas.width !== 0 || tile.canvas.height !== 0)
        ) {
            tile.canvas.width = 0;
            tile.canvas.height = 0;
        }
        tile.cachedData = undefined;
    }

    protected overviewFontIdentityKey(): string {
        const font = window.fontManager?.currentFont;
        return [
            window.fontManager?.currentFontId ?? '',
            font?.sourcePlugin?.getId?.() ?? '',
            font?.path ?? ''
        ].join('|');
    }

    protected isCloudSourceFont(): boolean {
        return (
            window.fontManager?.currentFont?.sourcePlugin?.getId?.() === 'cloud'
        );
    }

    protected isGlyphHydrated(glyphName: string): boolean {
        return !!(
            window.fontManager?.currentFont?.fontModel ??
            window.currentFontModel
        )?.findGlyph?.(glyphName);
    }

    /**
     * Metrics-key (and similar) support glyphs are resident for compile
     * but are not in the sparse working set. Show a faint outline, not a
     * full working tile and not the unhydrated cloud.
     */
    protected isSparseHiddenSupportGlyph(glyphName: string): boolean {
        const bridge = window.patchSyncEngine;
        if (!bridge?.hasSparseWorkingSet?.()) {
            return false;
        }
        if (!this.isGlyphHydrated(glyphName)) {
            return false;
        }
        if (typeof bridge.isSparseWorkingGlyphName !== 'function') {
            return false;
        }
        return !bridge.isSparseWorkingGlyphName(glyphName);
    }

    protected applyTileHydrationAppearance(tile: GlyphTile): void {
        if (!this.isGlyphHydrated(tile.glyphName)) {
            this.applyUnhydratedTileAppearance(tile);
            return;
        }
        if (this.isSparseHiddenSupportGlyph(tile.glyphName)) {
            this.applyHiddenSupportTileAppearance(tile);
            return;
        }
        this.applyHydratedTileAppearance(tile);
    }

    protected getCatalogCodepointsMap(): Map<string, number[]> {
        if (!this.catalogCodepointsByName) {
            this.catalogCodepointsByName = catalogCodepointsByGlyphName(
                window.fontManager?.currentFont?.babelfontData as
                    Record<string, unknown> | undefined
            );
        }
        return this.catalogCodepointsByName;
    }

    protected getOverviewCodepoints(glyphName: string): number[] {
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

    protected applyUnhydratedTileAppearance(tile: GlyphTile): void {
        this.evictTileCache(tile);
        tile.element.classList.add('glyph-tile-unhydrated');
        tile.element.classList.remove('glyph-tile-hidden-support');
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

    protected applyHiddenSupportTileAppearance(tile: GlyphTile): void {
        tile.element.classList.remove('glyph-tile-unhydrated');
        tile.element.classList.add('glyph-tile-hidden-support');
        const icon = tile.element.querySelector('.glyph-tile-cloud-icon');
        if (icon) {
            icon.setAttribute('hidden', '');
        }
    }

    protected applyHydratedTileAppearance(tile: GlyphTile): void {
        tile.element.classList.remove(
            'glyph-tile-unhydrated',
            'glyph-tile-hidden-support'
        );
        const icon = tile.element.querySelector('.glyph-tile-cloud-icon');
        if (icon) {
            icon.setAttribute('hidden', '');
        }
    }

    protected reconcileTileHydration(): void {
        this.catalogCodepointsByName = null;
        const newlyHydrated: string[] = [];
        for (const tile of this.tiles.values()) {
            const wasUnhydrated = tile.element.classList.contains(
                'glyph-tile-unhydrated'
            );
            this.applyTileHydrationAppearance(tile);
            if (
                wasUnhydrated &&
                this.isGlyphHydrated(tile.glyphName) &&
                !tile.element.classList.contains('glyph-tile-unhydrated')
            ) {
                newlyHydrated.push(tile.glyphId);
            }
        }
        for (const glyphId of newlyHydrated) {
            this.pendingGlyphIds.add(glyphId);
        }
        if (newlyHydrated.length) {
            this.scheduleBatchRender();
        }
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

    protected getSelectedGlyphs(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphId);
    }

    /**
     * Get the number of columns in the grid based on container width
     */
    protected getGridColumns(): number {
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
    protected getVisibleGlyphIds(): string[] {
        return [...this.visibleGlyphIds];
    }

    /**
     * Find the first visible tile in the grid
     */
    protected findFirstVisibleTile(): GlyphTile | null {
        if (this.visibleGlyphIds.length === 0) {
            return null;
        }
        return this.tiles.get(this.visibleGlyphIds[0]) ?? null;
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
    protected applyFilterColors(): void {
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
    protected buildStripeGradient(colors: string[], alpha: number): string {
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
    protected clearFilterColors(): void {
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
    protected cssColorToRgba(color: string, alpha: number): string {
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
        this.outlineRenderGeneration += 1;
        this.tileBuildRunId += 1;
        if (this.deferredTileBuildTimer !== null) {
            clearTimeout(this.deferredTileBuildTimer);
            this.deferredTileBuildTimer = null;
        }
        if (this.batchDebounceTimer !== null) {
            clearTimeout(this.batchDebounceTimer);
            this.batchDebounceTimer = null;
        }
        if (this.tileBuildResolve) {
            this.tileBuildResolve();
            this.tileBuildResolve = null;
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.themeObserver?.disconnect();
        this.themeObserver = null;
        this.detachLinesVirtualization();
        window.removeEventListener('scroll', this.onCapturedScrollBound, {
            capture: true
        } as EventListenerOptions);
        this.evictAllTileCaches();
        this.pendingGlyphIds.clear();
        if (this.container) {
            this.container.remove();
        }
        if (!this.mainWindow) {
            this.controlElements.forEach((element) => element.remove());
            this.controlsElement.remove();
        }
        this.tiles.clear();
    }
}
