// Glyph Overview
// Displays grid of glyph tiles with selection support
// Uses direct canvas rendering for fast display

import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
// Import filter manager to bundle it with glyph-overview entry point
// It self-registers on window.glyphOverviewFilterManager
import './glyph-overview-filters';

// Use the shared fontCompilation instance from window (set by bootstrap)
// Do NOT import from './font-compilation' as this is a separate webpack entry point
// and would create a separate worker instance with its own cache
declare const window: Window & { fontCompilation?: any };

interface GlyphTile {
    element: HTMLDivElement;
    glyphId: string;
    glyphName: string;
    selected: boolean;
    cachedData?: any; // Cached glyph outline data for resizing
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

class GlyphOverview {
    private container: HTMLDivElement | null = null;
    private tiles: Map<string, GlyphTile> = new Map();
    private isDragging = false;
    private hasDragged = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private selectionBox: HTMLDivElement | null = null;
    private currentLocation: Record<string, number> = {};
    private intersectionObserver: IntersectionObserver | null = null;
    private lazyLoadEnabled: boolean = false;
    // Batched lazy loading
    private pendingGlyphIds: Set<string> = new Set();
    private batchDebounceTimer: number | null = null;
    private isBatchRendering: boolean = false;
    // Cached metrics for tile rendering
    private renderMetrics: {
        ascender: number;
        descender: number;
        upm: number;
    } | null = null;
    // Currently highlighted editing glyph
    private highlightedGlyphName: string | null = null;
    // Tile size control
    private currentSizeStep: number = 2; // Default to middle (step 2 of 11)
    private sizeSlider: HTMLInputElement | null = null;
    // Search control
    private searchInput: HTMLInputElement | null = null;
    private searchTerms: string[] = [];
    // Active filter
    private activeFilterResults: Map<string, FilterResult> | null = null;
    // Error overlay for filter errors
    private errorOverlay: HTMLDivElement | null = null;

    constructor(parentElement: HTMLElement) {
        this.init(parentElement);
        this.initSizeControl();
        this.initSearchControl();
    }

    private init(parentElement: HTMLElement): void {
        // Create main container for glyph tiles
        this.container = document.createElement('div');
        this.container.id = 'glyph-overview-container';

        parentElement.appendChild(this.container);

        // Set up mouse event listeners for drag selection
        this.container.addEventListener(
            'mousedown',
            this.onMouseDown.bind(this)
        );
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));

        // Listen for glyph changes to update tiles
        window.addEventListener('glyphChanged', this.onGlyphChanged.bind(this));

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

    private initSizeControl(): void {
        // Load saved size from localStorage
        const savedSize = localStorage.getItem('glyphOverviewSize');
        if (savedSize !== null) {
            const parsedSize = parseInt(savedSize, 10);
            if (!isNaN(parsedSize) && parsedSize >= 0 && parsedSize <= 10) {
                this.currentSizeStep = parsedSize;
            }
        }

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
                localStorage.setItem('glyphOverviewSize', String(newSize));
            });
        }

        // Set initial tile dimensions
        const dims = this.getTileDimensions();
        if (this.container) {
            this.container.style.setProperty('--tile-width', `${dims.width}px`);
            this.container.style.setProperty(
                '--tile-height',
                `${dims.height}px`
            );
        }
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
                const value = (e.target as HTMLInputElement).value.trim();
                this.searchTerms = value
                    .split(/\s+/)
                    .filter((term) => term.length > 0)
                    .map((term) => term.toLowerCase());
                this.applySearchFilter();
            });
        }

        // Listen for keyboard shortcut (Cmd+F)
        document.addEventListener('keydown', (e) => {
            if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'f' &&
                this.isViewActive()
            ) {
                e.preventDefault();
                if (this.searchInput) {
                    this.searchInput.focus();
                    this.searchInput.select();
                }
            }
        });
    }

    private applySearchFilter(): void {
        if (!this.container) return;

        this.tiles.forEach((tile) => {
            // Check filter first
            const passesFilter =
                this.activeFilterResults === null ||
                this.activeFilterResults.has(tile.glyphName);

            // Check search terms
            let passesSearch = true;
            if (this.searchTerms.length > 0) {
                const glyphNameLower = tile.glyphName.toLowerCase();
                passesSearch = this.searchTerms.every((term) =>
                    glyphNameLower.includes(term)
                );
            }

            // Must pass both filter AND search
            tile.element.style.display =
                passesFilter && passesSearch ? '' : 'none';
        });
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

    private updateTileSize(): void {
        const dims = this.getTileDimensions();

        // Update CSS custom properties for tile sizing
        if (this.container) {
            this.container.style.setProperty('--tile-width', `${dims.width}px`);
            this.container.style.setProperty(
                '--tile-height',
                `${dims.height}px`
            );
        }

        // Re-render all tiles with new size in a single frame
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
        });
    }

    private isViewActive(): boolean {
        const overviewView = document.querySelector('#view-overview');
        return overviewView?.classList.contains('focused') ?? false;
    }

    public updateGlyphs(glyphs: Array<{ id: string; name: string }>): void {
        if (!this.container) return;

        // Clear existing tiles
        this.container.innerHTML = '';
        this.tiles.clear();

        // Create tile for each glyph
        glyphs.forEach((glyph) => {
            const tile = this.createGlyphTile(glyph.id, glyph.name);
            this.tiles.set(glyph.id, tile);
            this.container!.appendChild(tile.element);
        });

        // Apply search filter to new glyphs
        this.applySearchFilter();
    }

    /**
     * Render glyph outlines at a specific location in designspace
     * @param location - Axis location object, e.g., { wght: 400 }. Empty object uses default location.
     */
    public async renderGlyphOutlines(
        location: Record<string, number> = {}
    ): Promise<void> {
        if (!this.container) {
            console.warn('[GlyphOverview]', 'No container, cannot render');
            return;
        }

        this.currentLocation = location;

        // Cache metrics from font model for consistent tile sizing
        this.updateRenderMetrics();

        const glyphIds = Array.from(this.tiles.keys());
        const glyphNames = Array.from(this.tiles.values()).map(
            (t) => t.glyphName
        );

        // Enable lazy loading for large fonts
        if (glyphNames.length > 1000) {
            this.lazyLoadEnabled = true;
            this.setupLazyLoading();
            return;
        }

        try {
            // Use worker to get glyph outlines (font is already cached in worker)
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                throw new Error('fontCompilation not available on window');
            }
            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: glyphNames,
                location: location,
                flattenComponents: false // Don't flatten - preserve component structure with layerData
            });

            if (response.error) {
                throw new Error(response.error);
            }

            console.log(
                '[GlyphOverview]',
                `Received outlines JSON from worker, length: ${response.outlinesJson.length} bytes`
            );
            const outlines = JSON.parse(response.outlinesJson);
            console.log(
                '[GlyphOverview]',
                `Parsed ${outlines.length} glyph outlines`
            );

            // Batch all renders in a single animation frame for smooth painting
            const dims = this.getTileDimensions();
            requestAnimationFrame(() => {
                outlines.forEach((glyphData: any, index: number) => {
                    const glyphId = glyphIds[index];
                    const tile = this.tiles.get(glyphId);
                    if (tile) {
                        tile.cachedData = glyphData;
                        this.renderTileCanvas(
                            tile,
                            glyphData,
                            dims.width,
                            dims.height
                        );
                    }
                });
            });
        } catch (error) {
            console.error(
                '[GlyphOverview]',
                'Failed to render glyph outlines:',
                error
            );
        }
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
        // Default ascender/descender: 75%/25% of upm
        let ascender = upm * 0.75;
        let descender = -(upm * 0.25);

        // Try to get metrics from first master
        const master = font.masters?.[0];
        if (master?.metrics) {
            // Look for Ascender/Descender in metrics (case may vary)
            const metrics = master.metrics;
            if (metrics.Ascender !== undefined) {
                ascender = metrics.Ascender;
            } else if (metrics.ascender !== undefined) {
                ascender = metrics.ascender;
            }
            if (metrics.Descender !== undefined) {
                descender = metrics.Descender;
            } else if (metrics.descender !== undefined) {
                descender = metrics.descender;
            }
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
    ): void {
        // Use provided dimensions or get current size
        const dims =
            width && height ? { width, height } : this.getTileDimensions();

        // Render directly to the tile's pre-existing canvas
        if (tile.canvas) {
            fastGlyphTileRenderer.renderToCanvas(
                glyphData,
                this.renderMetrics || undefined,
                dims.width,
                dims.height,
                tile.canvas
            );
        }
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
        // Cache data for future resizing
        tile.cachedData = glyphData;
        this.renderTileCanvas(tile, glyphData, width, height);
    }

    /**
     * Handle glyph change events - re-render the affected tile
     */
    private async onGlyphChanged(event: Event): Promise<void> {
        const detail = (event as CustomEvent).detail;
        const glyphName = detail?.glyphName;
        if (!glyphName) return;

        // Find tile by glyph name
        let targetTile: GlyphTile | undefined;
        for (const tile of this.tiles.values()) {
            if (tile.glyphName === glyphName) {
                targetTile = tile;
                break;
            }
        }

        if (!targetTile) return;

        // Re-fetch and render the glyph outline
        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) return;

            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: [glyphName],
                location: this.currentLocation,
                flattenComponents: false // Don't flatten - preserve component structure with layerData
            });

            if (response.error) {
                console.error(
                    '[GlyphOverview]',
                    `Failed to refresh tile for ${glyphName}:`,
                    response.error
                );
                return;
            }

            const outlines = JSON.parse(response.outlinesJson);
            if (outlines.length > 0) {
                const dims = this.getTileDimensions();
                this.renderTile(
                    targetTile,
                    outlines[0],
                    dims.width,
                    dims.height
                );
            }
        } catch (error) {
            console.error(
                '[GlyphOverview]',
                `Error refreshing tile for ${glyphName}:`,
                error
            );
        }
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

        // Only show editing highlight when in edit mode (outline editor active)
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
                const editingGlyph = parsed[parsed.length - 1].glyphName;
                this.setEditingHighlight(editingGlyph);
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
        });
    }

    /**
     * Set the editing highlight on a specific glyph tile
     */
    private setEditingHighlight(glyphName: string | null): void {
        if (glyphName === this.highlightedGlyphName) return;

        // Remove highlight from previous tile
        if (this.highlightedGlyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === this.highlightedGlyphName) {
                    tile.element.style.boxShadow = '';
                    break;
                }
            }
        }

        // Add highlight to new tile and scroll into view
        this.highlightedGlyphName = glyphName;
        if (glyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    tile.element.style.boxShadow =
                        'inset 0 0 0 2px var(--accent-blue)';
                    this.scrollToTile(tile.element);
                    break;
                }
            }
        }
    }

    /**
     * Fast smooth scroll to tile element
     */
    private scrollToTile(element: HTMLElement): void {
        if (!this.container) return;

        const containerRect = this.container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

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
                            // Only add if not already rendered (check for cachedData instead of canvas presence)
                            if (tile && !tile.cachedData) {
                                this.pendingGlyphIds.add(glyphId);
                                addedCount++;
                            }
                        }
                    }
                });
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

    private async processBatchRender(): Promise<void> {
        if (this.isBatchRendering || this.pendingGlyphIds.size === 0) {
            return;
        }

        this.isBatchRendering = true;

        // Large batch size - Rust processes efficiently and layer cache persists
        // Larger batches reduce worker message passing overhead
        const batchSize = 500;
        const glyphIds = Array.from(this.pendingGlyphIds).slice(0, batchSize);
        glyphIds.forEach((id) => this.pendingGlyphIds.delete(id));

        // Build glyph name list
        const glyphNames: string[] = [];
        const glyphIdToName: Map<string, string> = new Map();
        for (const glyphId of glyphIds) {
            const tile = this.tiles.get(glyphId);
            // Check cachedData instead of canvas presence (canvas is now pre-created)
            if (tile && !tile.cachedData) {
                glyphNames.push(tile.glyphName);
                glyphIdToName.set(glyphId, tile.glyphName);
            }
        }

        if (glyphNames.length === 0) {
            this.isBatchRendering = false;
            if (this.pendingGlyphIds.size > 0) {
                this.scheduleBatchRender();
            }
            return;
        }

        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                throw new Error('fontCompilation not available on window');
            }
            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: glyphNames,
                location: this.currentLocation,
                flattenComponents: false // Don't flatten - preserve component structure with layerData
            });

            if (response.error) {
                throw new Error(response.error);
            }

            const outlines = JSON.parse(response.outlinesJson);

            // Batch all renders in a single animation frame
            const dims = this.getTileDimensions();
            requestAnimationFrame(() => {
                outlines.forEach((glyphData: any) => {
                    // Find tile by glyph name
                    for (const [glyphId, name] of glyphIdToName) {
                        if (name === glyphData.name) {
                            const tile = this.tiles.get(glyphId);
                            if (tile) {
                                tile.cachedData = glyphData; // Cache for resizing
                                this.renderTileCanvas(
                                    tile,
                                    glyphData,
                                    dims.width,
                                    dims.height
                                );
                            }
                            break;
                        }
                    }
                });
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[GlyphOverview]', `Batch render failed: ${msg}`);
        }

        this.isBatchRendering = false;

        // Process remaining pending glyphs
        if (this.pendingGlyphIds.size > 0) {
            this.scheduleBatchRender();
        }
    }

    private createGlyphTile(glyphId: string, glyphName: string): GlyphTile {
        const tileElement = document.createElement('div');
        tileElement.className = 'glyph-tile';
        tileElement.dataset.glyphId = glyphId;
        tileElement.dataset.glyphName = glyphName;

        // Pre-create canvas to avoid DOM insertion during render
        const canvas = document.createElement('canvas');
        canvas.className = 'glyph-tile-canvas';
        tileElement.appendChild(canvas);

        // Create label for glyph name (display name, not ID)
        const label = document.createElement('div');
        label.className = 'glyph-tile-label';
        label.textContent = glyphName;
        label.title = glyphName; // Tooltip for truncated names

        tileElement.appendChild(label);

        // Click handler for selection
        tileElement.addEventListener('click', (e) => {
            // Don't handle click if view is not active
            if (!this.isViewActive()) {
                return;
            }
            // Don't handle click if a drag just occurred
            if (this.hasDragged) {
                return;
            }
            this.handleTileClick(glyphId, e);
        });

        return {
            element: tileElement,
            glyphId: glyphId,
            glyphName: glyphName,
            selected: false,
            canvas: canvas
        };
    }

    private handleTileClick(glyphName: string, event: MouseEvent): void {
        const tile = this.tiles.get(glyphName);
        if (!tile) return;

        if (event.shiftKey) {
            // Shift+click: range selection
            this.handleRangeSelection(glyphName);
        } else if (event.metaKey || event.ctrlKey) {
            // Cmd/Ctrl+click: toggle selection
            this.toggleSelection(glyphName);
        } else {
            // Regular click: select only this tile
            this.clearSelection();
            this.selectTile(glyphName);
        }
    }

    private handleRangeSelection(glyphId: string): void {
        const selectedGlyphs = this.getSelectedGlyphs();
        if (selectedGlyphs.length === 0) {
            // No previous selection, just select this one
            this.selectTile(glyphId);
            return;
        }

        // Find range between last selected and current
        const glyphArray = Array.from(this.tiles.keys());
        const lastSelected = selectedGlyphs[selectedGlyphs.length - 1];
        const startIdx = glyphArray.indexOf(lastSelected);
        const endIdx = glyphArray.indexOf(glyphId);

        if (startIdx === -1 || endIdx === -1) return;

        const [from, to] =
            startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

        for (let i = from; i <= to; i++) {
            this.selectTile(glyphArray[i]);
        }
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

    private selectTile(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || tile.selected) return;

        tile.selected = true;
        tile.element.classList.add('selected');
    }

    private deselectTile(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || !tile.selected) return;

        tile.selected = false;
        tile.element.classList.remove('selected');
    }

    private clearSelection(): void {
        this.tiles.forEach((tile) => {
            if (tile.selected) {
                this.deselectTile(tile.glyphId);
            }
        });
    }

    private getSelectedGlyphs(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphId);
    }

    // Drag selection handlers
    private onMouseDown(e: MouseEvent): void {
        // Don't allow drag selection if view is not active
        if (!this.isViewActive()) {
            return;
        }

        this.isDragging = true;
        this.hasDragged = false;
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
                    this.clearSelection();
                }
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

    private onMouseUp(e: MouseEvent): void {
        if (this.isDragging) {
            this.isDragging = false;
            if (this.selectionBox) {
                this.selectionBox.remove();
                this.selectionBox = null;
            }
        }
    }

    private updateDragSelection(
        boxLeft: number,
        boxTop: number,
        boxWidth: number,
        boxHeight: number
    ): void {
        const boxRight = boxLeft + boxWidth;
        const boxBottom = boxTop + boxHeight;

        this.tiles.forEach((tile) => {
            const rect = tile.element.getBoundingClientRect();
            const containerRect = this.container!.getBoundingClientRect();

            const tileLeft =
                rect.left - containerRect.left + this.container!.scrollLeft;
            const tileTop =
                rect.top - containerRect.top + this.container!.scrollTop;
            const tileRight = tileLeft + rect.width;
            const tileBottom = tileTop + rect.height;

            // Check if tile intersects with selection box
            const intersects = !(
                boxRight < tileLeft ||
                boxLeft > tileRight ||
                boxBottom < tileTop ||
                boxTop > tileBottom
            );

            if (intersects && !tile.selected) {
                this.selectTile(tile.glyphId);
            }
        });
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
                errorText = window.cleanPythonTraceback(errorText, {
                    lineOffset,
                    skipExecFrames: true
                });
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

        // Add "Fix error with assistant" button for user filters
        if (filePath && pythonCode) {
            const fixButton = document.createElement('button');
            fixButton.className = 'glyph-overview-fix-error-btn ai-btn';
            fixButton.innerHTML =
                '<span class="material-symbols-outlined">auto_fix_high</span>Fix error with assistant';
            fixButton.addEventListener('click', async () => {
                await this.fixFilterErrorWithAssistant(
                    filePath,
                    pythonCode,
                    errorText
                );
            });
            errorContent.appendChild(fixButton);
        }

        this.errorOverlay.appendChild(errorContent);

        // Hide tiles and show error
        if (this.container) {
            this.container.style.display = 'none';
            this.container.parentElement?.appendChild(this.errorOverlay);
        }
    }

    /**
     * Fix a filter error using the AI assistant
     */
    private async fixFilterErrorWithAssistant(
        filePath: string,
        pythonCode: string,
        errorTraceback: string
    ): Promise<void> {
        // Check if AI assistant is available
        if (!window.aiAssistant || !window.aiAssistant.sessionManager) {
            alert('AI Assistant not available');
            return;
        }

        const aiAssistant = window.aiAssistant;
        const sessionManager = aiAssistant.sessionManager;

        // Check if there's already a session linked to this file
        const currentLinkedPath = sessionManager.getLinkedFilePath();
        const hasExistingSession =
            currentLinkedPath === filePath && sessionManager.currentChatId;

        if (!hasExistingSession) {
            // Start a new chat session for this file
            // Confirm if there's an active chat
            if (
                sessionManager.currentChatId &&
                aiAssistant.messages.length > 0
            ) {
                if (
                    !confirm(
                        'Start a new chat for this filter? The current chat will be saved.'
                    )
                ) {
                    return;
                }
            }

            // Reset chat state
            sessionManager.currentChatId = null;
            sessionManager.isContextLocked = true;
            sessionManager.setLinkedFilePath(filePath);
            aiAssistant.messages = [];
            aiAssistant.messagesContainer.innerHTML = '';
            localStorage.removeItem('ai_last_chat_id');

            // Set context to glyphfilter
            aiAssistant.setContext('glyphfilter');

            // Add a system message indicating the linked file
            const messageDiv = document.createElement('div');
            messageDiv.className = 'ai-message ai-message-system';

            const fileName = filePath.split('/').pop();
            messageDiv.innerHTML = `
                <div class="ai-system-message">
                    <span class="ai-context-display-icon ai-context-tag-glyphfilter"><span class="material-symbols-outlined">filter_alt</span></span>
                    <div>
                        <strong>Glyph Filter Context selected</strong>
                        <p>Creating or editing glyph filter: ${fileName}</p>
                    </div>
                </div>
            `;

            aiAssistant.messagesContainer.appendChild(messageDiv);
            sessionManager.updateFilePathDisplay();
            aiAssistant.scrollToBottom();
        }

        // Switch to assistant view
        const assistantView = document.getElementById('view-assistant');
        if (assistantView) {
            assistantView.click();
        }

        // Send error fix message
        const fixPrompt = `The filter script has an error. Here is the current code:\n\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nError traceback:\n\`\`\`\n${errorTraceback}\n\`\`\`\n\nPlease fix the error and provide the corrected code.`;

        // Set the prompt and trigger send
        aiAssistant.promptInput.value = fixPrompt;
        await aiAssistant.sendMessage();

        console.log('[GlyphOverview] Sent error fix request to AI assistant');
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
        // Clear any previous error
        this.clearFilterError();

        if (results === null) {
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

    public destroy(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        window.removeEventListener(
            'glyphChanged',
            this.onGlyphChanged.bind(this)
        );
        if (this.container) {
            this.container.remove();
        }
        this.tiles.clear();
    }
}

// Export for use in overview-view
(window as any).GlyphOverview = GlyphOverview;
