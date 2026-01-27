// Glyph Overview
// Displays grid of glyph tiles with selection support

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

    constructor(parentElement: HTMLElement) {
        this.init(parentElement);
    }

    private init(parentElement: HTMLElement): void {
        // Create main container for glyph tiles
        this.container = document.createElement('div');
        this.container.id = 'glyph-overview-container';
        this.container.style.display = 'flex';
        this.container.style.flexWrap = 'wrap';
        this.container.style.gap = '3px';
        this.container.style.padding = '6px';
        this.container.style.alignContent = 'flex-start';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.overflow = 'auto';
        this.container.style.position = 'relative';
        this.container.style.userSelect = 'none';

        parentElement.appendChild(this.container);

        // Set up mouse event listeners for drag selection
        this.container.addEventListener(
            'mousedown',
            this.onMouseDown.bind(this)
        );
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));

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

    private createGlyphTile(glyphId: string, glyphName: string): GlyphTile {
        const tileElement = document.createElement('div');
        tileElement.className = 'glyph-tile';
        tileElement.style.width = '30px';
        tileElement.style.height = '50px';
        tileElement.style.backgroundColor = 'var(--background-secondary)';
        tileElement.style.border = '1px solid var(--border-primary)';
        tileElement.style.borderRadius = '3px';
        tileElement.style.position = 'relative';
        tileElement.style.cursor = 'pointer';
        tileElement.style.display = 'flex';
        tileElement.style.flexDirection = 'column';
        tileElement.style.justifyContent = 'flex-end';
        tileElement.style.padding = '2px';
        tileElement.style.boxSizing = 'border-box';
        tileElement.dataset.glyphId = glyphId;
        tileElement.dataset.glyphName = glyphName;

        // Create label for glyph name (display name, not ID)
        const label = document.createElement('div');
        label.className = 'glyph-tile-label';
        label.textContent = glyphName;
        label.style.fontSize = '6px';
        label.style.fontFamily = 'Inter, sans-serif';
        label.style.color = 'var(--text-primary)';
        label.style.textAlign = 'center';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        label.style.lineHeight = '1';
        label.style.pointerEvents = 'none';

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
        tile.element.style.backgroundColor = 'var(--accent-primary)';
        tile.element.style.borderColor = 'var(--accent-primary)';
    }

    private deselectTile(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || !tile.selected) return;

        tile.selected = false;
        tile.element.style.backgroundColor = 'var(--background-secondary)';
        tile.element.style.borderColor = 'var(--border-primary)';
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
        if (this.container) {
            this.container.remove();
        }
        this.tiles.clear();
    }
}

// Export for use in overview-view
(window as any).GlyphOverview = GlyphOverview;
