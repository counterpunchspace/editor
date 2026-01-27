// Glyph Overview
// Displays grid of glyph tiles with selection support

import { glyphTileRenderer } from './glyph-tile-renderer';

// Use the shared fontCompilation instance from window (set by bootstrap)
// Do NOT import from './font-compilation' as this is a separate webpack entry point
// and would create a separate worker instance with its own cache
declare const window: Window & { fontCompilation?: any };

console.log('[GlyphOverview]', 'glyph-overview.ts loaded');

interface GlyphTile {
    element: HTMLDivElement;
    glyphId: string;
    glyphName: string;
    selected: boolean;
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

    constructor(parentElement: HTMLElement) {
        this.init(parentElement);
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

        console.log('[GlyphOverview]', 'Glyph overview container initialized');
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

        console.log('[GlyphOverview]', `Created ${glyphs.length} glyph tiles`);
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

        console.log(
            '[GlyphOverview]',
            `Starting renderGlyphOutlines for ${glyphNames.length} glyphs`
        );

        // Enable lazy loading for large fonts
        if (glyphNames.length > 1000) {
            this.lazyLoadEnabled = true;
            this.setupLazyLoading();
            console.log(
                '[GlyphOverview]',
                `Font has ${glyphNames.length} glyphs, using lazy loading`
            );
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
                flattenComponents: true
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

            outlines.forEach((glyphData: any, index: number) => {
                const glyphId = glyphIds[index];
                const tile = this.tiles.get(glyphId);
                if (tile) {
                    this.renderTile(tile, glyphData);
                }
            });

            console.log(
                '[GlyphOverview]',
                `Rendered ${outlines.length} glyph outlines`
            );
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
        console.log('[GlyphOverview]', 'Render metrics:', this.renderMetrics);
    }

    private renderTile(tile: GlyphTile, glyphData: any): void {
        // Remove existing canvas if any
        const existingCanvas = tile.element.querySelector('canvas');
        if (existingCanvas) {
            existingCanvas.remove();
        }

        // Render new canvas with metrics
        const canvas = glyphTileRenderer.renderGlyph(
            glyphData,
            this.renderMetrics || undefined
        );

        // Insert before label
        const label = tile.element.querySelector('.glyph-tile-label');
        if (label) {
            tile.element.insertBefore(canvas, label);
        } else {
            tile.element.appendChild(canvas);
        }
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
                flattenComponents: true
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
                this.renderTile(targetTile, outlines[0]);
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

        console.log(
            '[GlyphOverview]',
            'Setting up lazy loading with Intersection Observer (batched)'
        );

        this.intersectionObserver = new IntersectionObserver(
            (entries) => {
                let addedCount = 0;
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        const glyphId = (entry.target as HTMLElement).dataset
                            .glyphId;
                        if (glyphId) {
                            const tile = this.tiles.get(glyphId);
                            // Only add if not already rendered
                            if (tile && !tile.element.querySelector('canvas')) {
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
        console.log('[GlyphOverview]', `Observing ${this.tiles.size} tiles`);
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

        // Take a batch of pending glyphs (max 50 at a time for memory)
        const batchSize = 50;
        const glyphIds = Array.from(this.pendingGlyphIds).slice(0, batchSize);
        glyphIds.forEach((id) => this.pendingGlyphIds.delete(id));

        // Build glyph name list
        const glyphNames: string[] = [];
        const glyphIdToName: Map<string, string> = new Map();
        for (const glyphId of glyphIds) {
            const tile = this.tiles.get(glyphId);
            if (tile && !tile.element.querySelector('canvas')) {
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

        const startTime = performance.now();
        console.log(
            '[GlyphOverview]',
            `Batch rendering ${glyphNames.length} glyphs...`
        );

        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                throw new Error('fontCompilation not available on window');
            }
            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: glyphNames,
                location: this.currentLocation,
                flattenComponents: true
            });

            if (response.error) {
                throw new Error(response.error);
            }

            const outlines = JSON.parse(response.outlinesJson);
            const elapsed = performance.now() - startTime;
            console.log(
                '[GlyphOverview]',
                `Batch received ${outlines.length} outlines in ${elapsed.toFixed(1)}ms (${(elapsed / outlines.length).toFixed(1)}ms/glyph)`
            );

            // Render each tile
            outlines.forEach((glyphData: any) => {
                // Find tile by glyph name
                for (const [glyphId, name] of glyphIdToName) {
                    if (name === glyphData.name) {
                        const tile = this.tiles.get(glyphId);
                        if (tile) {
                            this.renderTile(tile, glyphData);
                        }
                        break;
                    }
                }
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

        // Create label for glyph name (display name, not ID)
        const label = document.createElement('div');
        label.className = 'glyph-tile-label';
        label.textContent = glyphName;

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
            selected: false
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

        console.log(
            '[GlyphOverview]',
            'Selected glyphs:',
            this.getSelectedGlyphs()
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
