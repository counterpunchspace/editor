import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
import { PATH_FILL_OPACITY_CHANGED_EVENT } from './path-fill-opacity-pref';
import {
    compareGlyphsBySearchRelevance,
    glyphMatchesSearchTerms,
    parseGlyphSearchTerms,
    parseGlyphSearchTermsPreserveCase
} from './glyph-search';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('FindGlyphDialog');

/** In-memory last search query per dialog invocation type (page session only). */
const searchMemoryByInvocationType = new Map<string, string>();

/**
 * In-memory last selected glyph names per invocation type + search query.
 * Key format: `${invocationType}\n${query}`
 */
const selectionMemoryByInvocationTypeAndQuery = new Map<string, string[]>();

function selectionMemoryKey(invocationType: string, query: string): string {
    return `${invocationType}\n${query}`;
}

interface FindableGlyph {
    name: string;
    codepoints?: readonly number[];
}

interface FontGlyphSource {
    glyphs?: readonly FindableGlyph[];
}

interface GlyphOutlineResponse {
    outlinesJson: string;
    error?: string;
}

interface FontCompilationMessenger {
    sendMessage(message: {
        type: 'getGlyphOutlines';
        glyphNames: string[];
        location: Record<string, number>;
        flattenComponents: boolean;
    }): Promise<GlyphOutlineResponse>;
}

export type GlyphSelectionMode = 'single' | 'multiple';

export interface FindGlyphDialogOptions {
    selectionMode?: GlyphSelectionMode;
    selectedGlyphNames?: readonly string[];
    /**
     * Session-memory key for the last search query. Restored on open when no
     * selectedGlyphNames were provided. Typical values: 'find-glyphs',
     * 'add-component'.
     */
    searchMemoryKey?: string;
    title?: string;
    cancelLabel?: string;
    confirmLabel?: string;
    onConfirm?: (glyphNames: string[]) => void;
    onClose?: () => void;
}

type GlyphOutlineData = Parameters<
    typeof fastGlyphTileRenderer.renderToCanvas
>[0];

function isGlyphOutlineData(value: unknown): value is GlyphOutlineData {
    if (!value || typeof value !== 'object' || !('name' in value)) {
        return false;
    }

    return typeof (value as { name?: unknown }).name === 'string';
}

/**
 * Return the current font's glyphs in their stored font order.
 */
function getCurrentFontGlyphs(): FindableGlyph[] {
    const fontModel = (
        window as Window & {
            currentFontModel?: FontGlyphSource;
        }
    ).currentFontModel;
    return fontModel?.glyphs ? Array.from(fontModel.glyphs) : [];
}

/**
 * Format assigned codepoints for the glyph list's secondary label.
 */
function formatUnicodeValue(codepoints?: readonly number[]): string | null {
    const values = codepoints?.filter(Number.isInteger) ?? [];
    if (!values.length) {
        return null;
    }

    return values
        .map(
            (codepoint) =>
                `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`
        )
        .join(' ');
}

/**
 * Clear Find Glyph dialog search session memory (tests).
 */
export function clearFindGlyphSearchMemory(): void {
    searchMemoryByInvocationType.clear();
    selectionMemoryByInvocationTypeAndQuery.clear();
}

/**
 * Scroll offset that places the active row third when two prior rows exist.
 */
export function getPreselectedGlyphScrollTop(
    activeIndex: number,
    rowHeight: number
): number {
    if (activeIndex < 0) {
        return 0;
    }

    return Math.max(0, (activeIndex - 2) * rowHeight);
}

/**
 * A virtualized dialog for finding glyphs in the current font.
 */
export class FindGlyphDialog {
    private readonly modal: HTMLElement | null;
    private readonly titleElement: HTMLElement | null;
    private readonly closeButton: HTMLButtonElement | null;
    private readonly content: HTMLElement | null;
    private searchInput: HTMLInputElement | null = null;
    private list: HTMLDivElement | null = null;
    private cancelButton: HTMLButtonElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private glyphs: FindableGlyph[] = [];
    private visibleGlyphs: FindableGlyph[] = [];
    private searchTerms: string[] = [];
    private casePreservedSearchTerms: string[] = [];
    private selectionMode: GlyphSelectionMode = 'single';
    private selectedGlyphNames = new Set<string>();
    private activeIndex = -1;
    private selectionAnchorName: string | null = null;
    private searchMemoryKey: string | null = null;
    private remembersSearch = false;
    private lastPersistedQuery = '';
    private onConfirm: ((glyphNames: string[]) => void) | null = null;
    private onClose: (() => void) | null = null;
    private previewCanvases = new Map<string, HTMLCanvasElement>();
    private outlineCache = new Map<string, GlyphOutlineData>();
    private pendingGlyphNames = new Set<string>();
    private previewRenderQueued = false;
    private renderedRange: { start: number; end: number } | null = null;
    private readonly rowHeight = 68;
    private readonly overscanRows = 6;
    private escapeBinding: ModalEscapeBinding | null = null;

    constructor() {
        this.modal = document.getElementById('find-glyph-modal');
        this.titleElement = document.getElementById('find-glyph-modal-title');
        this.closeButton = document.getElementById(
            'find-glyph-modal-close-btn'
        ) as HTMLButtonElement | null;
        this.content = document.getElementById('find-glyph-modal-content');

        this.buildContent();
        this.registerEvents();
        window.addEventListener(PATH_FILL_OPACITY_CHANGED_EVENT, () => {
            this.drawCachedPreviews();
        });
    }

    /**
     * Open the dialog with configurable single or multiple glyph selection.
     */
    public open(options: FindGlyphDialogOptions = {}): void {
        if (!this.modal) {
            return;
        }

        this.glyphs = getCurrentFontGlyphs();
        this.selectionMode = options.selectionMode ?? 'single';
        const providedSelection = (options.selectedGlyphNames ?? []).filter(
            (glyphName) => this.glyphs.some((glyph) => glyph.name === glyphName)
        );
        const hasProvidedSelection = providedSelection.length > 0;
        this.selectedGlyphNames = new Set(providedSelection);
        if (
            this.selectionMode === 'single' &&
            this.selectedGlyphNames.size > 1
        ) {
            const [firstSelectedGlyphName] = this.selectedGlyphNames;
            if (firstSelectedGlyphName) {
                this.selectedGlyphNames = new Set([firstSelectedGlyphName]);
            }
        }
        this.onConfirm = options.onConfirm ?? null;
        this.onClose = options.onClose ?? null;
        this.searchMemoryKey = options.searchMemoryKey ?? null;
        this.remembersSearch =
            !hasProvidedSelection && this.searchMemoryKey !== null;
        if (this.titleElement) {
            this.titleElement.textContent = options.title ?? 'Find Glyph';
        }
        if (this.cancelButton) {
            this.cancelButton.textContent = options.cancelLabel ?? 'Cancel';
        }
        this.confirmButton!.textContent = options.confirmLabel ?? 'Select';

        const restoredQuery =
            this.remembersSearch && this.searchMemoryKey
                ? (searchMemoryByInvocationType.get(this.searchMemoryKey) ?? '')
                : '';
        this.applySearchQuery(restoredQuery);
        this.lastPersistedQuery = restoredQuery;
        this.visibleGlyphs = this.getVisibleGlyphs();

        if (hasProvidedSelection) {
            this.activeIndex = this.visibleGlyphs.findIndex((glyph) =>
                this.selectedGlyphNames.has(glyph.name)
            );
            this.selectionAnchorName =
                this.activeIndex >= 0
                    ? this.visibleGlyphs[this.activeIndex]!.name
                    : null;
        } else {
            this.restoreSelectionForCurrentQuery({ render: false });
        }

        this.syncConfirmButton();
        this.outlineCache.clear();
        this.pendingGlyphNames.clear();

        const selectedGlyphScrollTop = getPreselectedGlyphScrollTop(
            this.activeIndex,
            this.rowHeight
        );
        this.renderedRange = null;
        this.modal.style.display = 'flex';
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.close(), {
            isOpen: () => this.isOpen()
        });
        this.renderVisibleWindow(true, selectedGlyphScrollTop);
        this.list!.scrollTop = selectedGlyphScrollTop;
        setTimeout(() => {
            if (!this.searchInput) {
                return;
            }

            this.searchInput.focus();
            if (restoredQuery) {
                this.searchInput.select();
            }
        }, 50);
    }

    /**
     * Close the Find Glyph dialog.
     */
    public close(): void {
        this.persistSearchMemory();
        this.escapeBinding?.release();
        this.escapeBinding = null;
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        this.onClose?.();
        this.onClose = null;
    }

    /**
     * Whether the Find Glyph dialog is currently visible.
     */
    private isOpen(): boolean {
        return !!this.modal?.isConnected && this.modal.style.display === 'flex';
    }

    /**
     * Persist the current search query and selection for this invocation type.
     */
    private persistSearchMemory(): void {
        if (
            !this.remembersSearch ||
            !this.searchMemoryKey ||
            !this.searchInput
        ) {
            return;
        }

        const query = this.searchInput.value;
        searchMemoryByInvocationType.set(this.searchMemoryKey, query);
        this.persistSelectionMemory(query);
    }

    /**
     * Persist the current selection for a specific search query.
     */
    private persistSelectionMemory(query: string): void {
        if (!this.remembersSearch || !this.searchMemoryKey) {
            return;
        }

        const selectedNames = Array.from(this.selectedGlyphNames);
        const key = selectionMemoryKey(this.searchMemoryKey, query);
        if (!selectedNames.length) {
            selectionMemoryByInvocationTypeAndQuery.delete(key);
            return;
        }

        selectionMemoryByInvocationTypeAndQuery.set(key, selectedNames);
    }

    /**
     * Restore remembered selection for the current query, or select the first match.
     */
    private restoreSelectionForCurrentQuery(
        options: { render?: boolean; scrollIntoView?: boolean } = {}
    ): void {
        const { render = true, scrollIntoView = false } = options;
        if (!this.visibleGlyphs.length) {
            this.selectIndex(-1, { render, scrollIntoView });
            return;
        }

        const query = this.searchInput?.value ?? '';
        const remembered =
            this.remembersSearch && this.searchMemoryKey
                ? selectionMemoryByInvocationTypeAndQuery.get(
                      selectionMemoryKey(this.searchMemoryKey, query)
                  )
                : undefined;
        const restoredNames = (remembered ?? []).filter((glyphName) =>
            this.visibleGlyphs.some((glyph) => glyph.name === glyphName)
        );

        if (!restoredNames.length) {
            this.selectIndex(0, { render, scrollIntoView });
            return;
        }

        if (this.selectionMode === 'single') {
            this.selectedGlyphNames = new Set([restoredNames[0]!]);
            this.selectionAnchorName = restoredNames[0]!;
        } else {
            this.selectedGlyphNames = new Set(restoredNames);
            this.selectionAnchorName = restoredNames[0]!;
        }
        this.activeIndex = this.visibleGlyphs.findIndex((glyph) =>
            this.selectedGlyphNames.has(glyph.name)
        );
        this.syncConfirmButton();
        if (scrollIntoView) {
            this.list!.scrollTop = getPreselectedGlyphScrollTop(
                this.activeIndex,
                this.rowHeight
            );
        }
        if (render) {
            this.renderVisibleWindow(true);
        }
    }

    /**
     * Apply a search query string to the input and parsed term state.
     */
    private applySearchQuery(query: string): void {
        if (this.searchInput) {
            this.searchInput.value = query;
        }
        this.casePreservedSearchTerms =
            parseGlyphSearchTermsPreserveCase(query);
        this.searchTerms = parseGlyphSearchTerms(query);
    }

    /**
     * Filter and rank glyphs for the current search terms.
     * Empty search keeps font order; active search ranks by relevance.
     */
    private getVisibleGlyphs(): FindableGlyph[] {
        if (!this.searchTerms.length) {
            return [...this.glyphs];
        }

        return this.glyphs
            .filter((glyph) => glyphMatchesSearchTerms(glyph, this.searchTerms))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(
                    left,
                    right,
                    this.searchTerms,
                    this.casePreservedSearchTerms
                )
            );
    }

    /**
     * Select the glyph at the given visible-list index as the sole selection.
     */
    private selectIndex(
        index: number,
        options: { scrollIntoView?: boolean; render?: boolean } = {}
    ): void {
        const { scrollIntoView = true, render = true } = options;
        if (!this.visibleGlyphs.length || index < 0) {
            this.activeIndex = -1;
            this.selectionAnchorName = null;
            this.selectedGlyphNames = new Set();
            this.syncConfirmButton();
            if (render) {
                this.renderVisibleWindow(true);
            }
            return;
        }

        const clamped = Math.max(
            0,
            Math.min(index, this.visibleGlyphs.length - 1)
        );
        this.activeIndex = clamped;
        const glyphName = this.visibleGlyphs[clamped]!.name;
        this.selectedGlyphNames = new Set([glyphName]);
        this.selectionAnchorName = glyphName;
        this.syncConfirmButton();
        if (scrollIntoView) {
            this.ensureActiveRowVisible();
        }
        if (render) {
            this.renderVisibleWindow(true);
        }
    }

    /**
     * Return visible-list indices of currently selected glyphs, ascending.
     */
    private getSelectedIndices(): number[] {
        const indices: number[] = [];
        this.visibleGlyphs.forEach((glyph, index) => {
            if (this.selectedGlyphNames.has(glyph.name)) {
                indices.push(index);
            }
        });
        return indices;
    }

    /**
     * Handle a list-row click using overview-style modifiers.
     */
    private handleRowClick(
        glyphName: string,
        index: number,
        event: MouseEvent
    ): void {
        this.activeIndex = index;

        if (this.selectionMode === 'single') {
            this.selectedGlyphNames = new Set([glyphName]);
            this.selectionAnchorName = glyphName;
        } else if (event.shiftKey) {
            this.applyMouseRangeSelection(index);
            this.selectionAnchorName = glyphName;
        } else if (event.metaKey || event.ctrlKey) {
            if (this.selectedGlyphNames.has(glyphName)) {
                this.selectedGlyphNames.delete(glyphName);
            } else {
                this.selectedGlyphNames.add(glyphName);
            }
            this.selectionAnchorName = glyphName;
        } else {
            this.selectedGlyphNames = new Set([glyphName]);
            this.selectionAnchorName = glyphName;
        }

        this.syncConfirmButton();
        this.renderVisibleWindow(true);
        this.searchInput?.focus();
    }

    /**
     * Shift+click range selection: add every glyph between the last selected
     * visible item and the clicked index (overview behavior).
     */
    private applyMouseRangeSelection(targetIndex: number): void {
        const selectedIndices = this.getSelectedIndices();
        const fromIndex =
            selectedIndices.length > 0
                ? selectedIndices[selectedIndices.length - 1]!
                : targetIndex;
        const [from, to] =
            fromIndex < targetIndex
                ? [fromIndex, targetIndex]
                : [targetIndex, fromIndex];

        for (let index = from; index <= to; index += 1) {
            this.selectedGlyphNames.add(this.visibleGlyphs[index]!.name);
        }
    }

    /**
     * Shift+arrow range selection from the keyboard anchor to the target.
     */
    private applyKeyboardRangeSelection(targetName: string): void {
        if (!this.selectionAnchorName) {
            const selectedIndices = this.getSelectedIndices();
            this.selectionAnchorName =
                selectedIndices.length > 0
                    ? this.visibleGlyphs[selectedIndices[0]!]!.name
                    : targetName;
        }

        const anchorIndex = this.visibleGlyphs.findIndex(
            (glyph) => glyph.name === this.selectionAnchorName
        );
        const targetIndex = this.visibleGlyphs.findIndex(
            (glyph) => glyph.name === targetName
        );
        if (anchorIndex < 0 || targetIndex < 0) {
            return;
        }

        const [from, to] =
            anchorIndex < targetIndex
                ? [anchorIndex, targetIndex]
                : [targetIndex, anchorIndex];
        this.selectedGlyphNames = new Set();
        for (let index = from; index <= to; index += 1) {
            this.selectedGlyphNames.add(this.visibleGlyphs[index]!.name);
        }
    }

    /**
     * Move keyboard selection by a delta within the visible match list.
     * ArrowDown continues from the bottom of the selection; ArrowUp from the top.
     */
    private moveSelection(delta: number, shiftKey: boolean = false): void {
        if (!this.visibleGlyphs.length) {
            return;
        }

        const selectedIndices = this.getSelectedIndices();
        let currentIndex: number;
        if (selectedIndices.length > 0) {
            currentIndex =
                delta > 0
                    ? selectedIndices[selectedIndices.length - 1]!
                    : selectedIndices[0]!;
        } else if (this.activeIndex >= 0) {
            currentIndex = this.activeIndex;
        } else {
            currentIndex = delta > 0 ? -1 : this.visibleGlyphs.length;
        }

        const targetIndex = currentIndex + delta;
        if (targetIndex < 0 || targetIndex >= this.visibleGlyphs.length) {
            return;
        }

        const targetName = this.visibleGlyphs[targetIndex]!.name;
        this.activeIndex = targetIndex;

        if (this.selectionMode === 'multiple' && shiftKey) {
            this.applyKeyboardRangeSelection(targetName);
            this.syncConfirmButton();
            this.ensureActiveRowVisible();
            this.renderVisibleWindow(true);
            return;
        }

        this.selectIndex(targetIndex);
    }

    /**
     * Scroll the list so the active row stays in view.
     */
    private ensureActiveRowVisible(): void {
        if (!this.list || this.activeIndex < 0) {
            return;
        }

        const rowTop = this.activeIndex * this.rowHeight;
        const rowBottom = rowTop + this.rowHeight;
        const viewTop = this.list.scrollTop;
        const viewBottom = viewTop + this.list.clientHeight;

        if (rowTop < viewTop) {
            this.list.scrollTop = rowTop;
        } else if (rowBottom > viewBottom) {
            this.list.scrollTop = rowBottom - this.list.clientHeight;
        }
    }

    /**
     * Build the reusable dialog's search and virtual-list content.
     */
    private buildContent(): void {
        if (!this.content) {
            return;
        }

        const search = document.createElement('div');
        search.className = 'find-glyph-search overview-search-control';

        const searchIcon = document.createElement('span');
        searchIcon.className = 'material-symbols-outlined overview-search-icon';
        searchIcon.textContent = 'search';
        search.appendChild(searchIcon);

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'find-glyph-search-input';
        this.searchInput.type = 'search';
        this.searchInput.placeholder =
            'Search glyph names, characters, or hex Unicodes.';
        this.searchInput.setAttribute(
            'aria-label',
            'Search glyph names, characters, or hex Unicodes.'
        );
        search.appendChild(this.searchInput);

        this.list = document.createElement('div');
        this.list.className = 'find-glyph-list';
        this.list.setAttribute('role', 'listbox');

        this.content.replaceChildren(search, this.list);

        const actions = document.createElement('div');
        actions.className = 'find-glyph-actions';

        const cancel = document.createElement('button');
        cancel.className = 'dialog-button';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.close());
        this.cancelButton = cancel;
        actions.appendChild(cancel);

        this.confirmButton = document.createElement('button');
        this.confirmButton.className = 'dialog-button dialog-button-primary';
        this.confirmButton.type = 'button';
        this.confirmButton.addEventListener('click', () =>
            this.confirmSelection()
        );
        actions.appendChild(this.confirmButton);

        this.content.replaceChildren(search, this.list, actions);
    }

    /**
     * Connect dialog controls and keyboard behavior.
     */
    private registerEvents(): void {
        this.closeButton?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });
        this.searchInput?.addEventListener('input', () => {
            this.persistSelectionMemory(this.lastPersistedQuery);
            const query = this.searchInput!.value;
            this.applySearchQuery(query);
            this.lastPersistedQuery = query;
            if (this.remembersSearch && this.searchMemoryKey) {
                searchMemoryByInvocationType.set(this.searchMemoryKey, query);
            }
            this.visibleGlyphs = this.getVisibleGlyphs();
            this.restoreSelectionForCurrentQuery({
                render: false,
                scrollIntoView: false
            });
            const scrollTop = getPreselectedGlyphScrollTop(
                this.activeIndex,
                this.rowHeight
            );
            this.list!.scrollTop = scrollTop;
            this.renderedRange = null;
            this.renderVisibleWindow(true, scrollTop);
        });
        this.list?.addEventListener('scroll', () => this.renderVisibleWindow());
        document.addEventListener(
            'keydown',
            (event) => {
                if (!this.isOpen()) {
                    return;
                }

                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.moveSelection(1, event.shiftKey);
                    return;
                }

                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.moveSelection(-1, event.shiftKey);
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.confirmSelection();
                }
            },
            true
        );
    }

    /**
     * Mount only the visible rows, preserving total scroll height with spacers.
     */
    private renderVisibleWindow(
        force: boolean = false,
        scrollTop: number = this.list?.scrollTop ?? 0
    ): void {
        if (!this.list) {
            return;
        }

        const total = this.visibleGlyphs.length;
        if (!total) {
            this.renderedRange = { start: 0, end: 0 };
            this.list.replaceChildren(this.createEmptyState());
            return;
        }

        const start = Math.max(
            0,
            Math.floor(scrollTop / this.rowHeight) - this.overscanRows
        );
        const end = Math.min(
            total,
            Math.ceil((scrollTop + this.list.clientHeight) / this.rowHeight) +
                this.overscanRows
        );

        if (
            !force &&
            this.renderedRange?.start === start &&
            this.renderedRange.end === end
        ) {
            return;
        }

        this.renderedRange = { start, end };
        this.previewCanvases.clear();
        const fragment = document.createDocumentFragment();
        this.appendSpacer(fragment, start * this.rowHeight);

        for (let index = start; index < end; index += 1) {
            fragment.appendChild(
                this.createGlyphRow(this.visibleGlyphs[index]!, index)
            );
        }

        this.appendSpacer(fragment, (total - end) * this.rowHeight);
        this.list.replaceChildren(fragment);
        this.queueVisiblePreviewRender();
    }

    /**
     * Add a virtual-list spacer only when it has height.
     */
    private appendSpacer(fragment: DocumentFragment, height: number): void {
        if (height <= 0) {
            return;
        }

        const spacer = document.createElement('div');
        spacer.className = 'find-glyph-spacer';
        spacer.style.height = `${height}px`;
        fragment.appendChild(spacer);
    }

    /**
     * Create one glyph's preview and metadata row.
     */
    private createGlyphRow(
        glyph: FindableGlyph,
        index: number
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'find-glyph-row';
        row.dataset.glyphName = glyph.name;
        row.setAttribute('role', 'option');
        row.tabIndex = -1;
        const selected = this.selectedGlyphNames.has(glyph.name);
        row.setAttribute('aria-selected', String(selected));
        row.addEventListener('click', (event) =>
            this.handleRowClick(glyph.name, index, event)
        );
        row.addEventListener('dblclick', () => {
            this.activeIndex = index;
            this.selectedGlyphNames = new Set([glyph.name]);
            this.selectionAnchorName = glyph.name;
            this.syncConfirmButton();
            this.confirmSelection();
        });

        const canvas = document.createElement('canvas');
        canvas.className = 'find-glyph-preview';
        canvas.setAttribute('aria-hidden', 'true');
        row.appendChild(canvas);
        this.previewCanvases.set(glyph.name, canvas);

        const details = document.createElement('div');
        details.className = 'find-glyph-details';

        const name = document.createElement('div');
        name.className = 'find-glyph-name';
        name.textContent = glyph.name;
        details.appendChild(name);

        const unicode = formatUnicodeValue(glyph.codepoints);
        if (unicode) {
            const value = document.createElement('div');
            value.className = 'find-glyph-unicode';
            value.textContent = unicode;
            details.appendChild(value);
        }

        row.appendChild(details);
        return row;
    }

    /**
     * Enable confirmation only when the user has selected at least one glyph.
     */
    private syncConfirmButton(): void {
        if (this.confirmButton) {
            this.confirmButton.disabled = this.selectedGlyphNames.size === 0;
        }
    }

    /**
     * Confirm selected glyphs in their stored font order and close the dialog.
     */
    private confirmSelection(): void {
        const glyphNames = this.glyphs
            .filter((glyph) => this.selectedGlyphNames.has(glyph.name))
            .map((glyph) => glyph.name);
        if (!glyphNames.length) {
            return;
        }

        this.onConfirm?.(glyphNames);
        this.close();
    }

    /**
     * Create the list state shown when no glyph names match the search.
     */
    private createEmptyState(): HTMLDivElement {
        const empty = document.createElement('div');
        empty.className = 'find-glyph-empty';
        empty.textContent = 'No matching glyphs';
        return empty;
    }

    /**
     * Schedule one frame of preview work for currently mounted glyph rows.
     */
    private queueVisiblePreviewRender(): void {
        if (this.previewRenderQueued) {
            return;
        }

        this.previewRenderQueued = true;
        requestAnimationFrame(() => {
            this.previewRenderQueued = false;
            void this.renderVisiblePreviews();
        });
    }

    /**
     * Fetch and draw outlines only for glyph rows currently mounted in the list.
     */
    private async renderVisiblePreviews(): Promise<void> {
        const glyphNames = Array.from(this.previewCanvases.keys()).filter(
            (glyphName) =>
                !this.outlineCache.has(glyphName) &&
                !this.pendingGlyphNames.has(glyphName)
        );
        if (!glyphNames.length) {
            this.drawCachedPreviews();
            return;
        }

        const fontCompilation = (
            window as Window & {
                fontCompilation?: FontCompilationMessenger;
            }
        ).fontCompilation;
        if (!fontCompilation) {
            return;
        }

        glyphNames.forEach((glyphName) =>
            this.pendingGlyphNames.add(glyphName)
        );
        try {
            const response = await fontCompilation.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames,
                location: {},
                flattenComponents: false
            });
            if (response.error) {
                throw new Error(response.error);
            }

            const parsed: unknown = JSON.parse(response.outlinesJson);
            const outlines = Array.isArray(parsed)
                ? parsed.filter(isGlyphOutlineData)
                : [];
            outlines.forEach((outline) =>
                this.outlineCache.set(outline.name, outline)
            );
            this.drawCachedPreviews();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn('Could not render glyph previews', message);
        } finally {
            glyphNames.forEach((glyphName) =>
                this.pendingGlyphNames.delete(glyphName)
            );
        }
    }

    /**
     * Draw cached outlines into the canvases that remain mounted in the list.
     */
    private drawCachedPreviews(): void {
        this.previewCanvases.forEach((canvas, glyphName) => {
            const outline = this.outlineCache.get(glyphName);
            if (!outline || !canvas.isConnected) {
                return;
            }

            fastGlyphTileRenderer.renderToCanvas(
                outline,
                undefined,
                67,
                67,
                canvas
            );
        });
    }
}

window.findGlyphDialog = new FindGlyphDialog();
