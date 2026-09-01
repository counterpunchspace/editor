import { Font } from './babelfont-model';
import { glyphDataIndex, type GlyphDataSearchResult } from './glyph-data';
import {
    characterSetPluginManager,
    type CharacterSetCoverageLevel,
    type CharacterSetNode
} from './character-set-plugin-manager';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import type { FilesystemPlugin } from './filesystem-plugins/filesystem-plugin';

const console = new Logger('AddGlyphsDialog');

const GENERAL_CATEGORY_LABELS: Record<string, string> = {
    Lu: 'Uppercase Letter',
    Ll: 'Lowercase Letter',
    Lt: 'Titlecase Letter',
    Lm: 'Modifier Letter',
    Lo: 'Other Letter',
    Mn: 'Nonspacing Mark',
    Mc: 'Spacing Mark',
    Me: 'Enclosing Mark',
    Nd: 'Decimal Number',
    Nl: 'Letter Number',
    No: 'Other Number',
    Pc: 'Connector Punctuation',
    Pd: 'Dash Punctuation',
    Ps: 'Open Punctuation',
    Pe: 'Close Punctuation',
    Pi: 'Initial Punctuation',
    Pf: 'Final Punctuation',
    Po: 'Other Punctuation',
    Sm: 'Math Symbol',
    Sc: 'Currency Symbol',
    Sk: 'Modifier Symbol',
    So: 'Other Symbol',
    Zs: 'Space Separator',
    Zl: 'Line Separator',
    Zp: 'Paragraph Separator',
    Cc: 'Control',
    Cf: 'Format Control',
    Cs: 'Surrogate',
    Co: 'Private Use',
    Cn: 'Unassigned'
};

/**
 * Searches the active Character Set provider and adds selected records to the font.
 * This intentionally has independent state from Find Glyph, whose list is
 * limited to glyphs already present in the current font.
 */
export class AddGlyphsDialog {
    private readonly modal = document.getElementById('add-glyphs-modal');
    private readonly content = document.getElementById(
        'add-glyphs-modal-content'
    );
    private searchInput: HTMLInputElement | null = null;
    private providerSelect: HTMLSelectElement | null = null;
    private setSearchInput: HTMLInputElement | null = null;
    private setTree: HTMLElement | null = null;
    private setPanel: HTMLElement | null = null;
    private coverageControls: HTMLElement | null = null;
    private list: HTMLElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private quotaError: HTMLParagraphElement | null = null;
    private results: GlyphDataSearchResult[] = [];
    private selectedCodepoints = new Set<number>();
    private activeIndex = -1;
    private selectionAnchor = -1;
    private activeProviderId = 'unicode';
    private selectedSetIds = new Set<string>();
    private activeSetIndex = -1;
    private setSelectionAnchor = -1;
    private enabledLevels = new Set<CharacterSetCoverageLevel>();
    private searchVersion = 0;
    private escapeBinding: ModalEscapeBinding | null = null;

    constructor() {
        this.buildContent();
        this.registerEvents();
    }

    async open(): Promise<void> {
        if (!this.modal || !this.searchInput) {
            return;
        }
        this.modal.style.display = 'flex';
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.close(), {
            isOpen: () => this.isOpen()
        });
        this.searchInput.disabled = true;
        this.searchInput.placeholder = 'Loading Glyph Data…';
        try {
            await Promise.all([
                glyphDataIndex.ensureReady(),
                characterSetPluginManager.ensureReady()
            ]);
            this.renderProviderOptions();
            this.updateProviderLayout();
            this.searchInput.disabled = false;
            this.searchInput.placeholder =
                'Search glyph names, Unicode names, characters, or U+ codepoints.';
            await this.updateResults();
            requestAnimationFrame(() => this.searchInput?.focus());
        } catch (error) {
            console.error('Could not load Character Set providers', error);
            this.searchInput.placeholder =
                'Character Sets could not be loaded.';
        }
    }

    isOpen(): boolean {
        return this.modal?.style.display === 'flex';
    }

    private close(): void {
        this.escapeBinding?.release();
        this.escapeBinding = null;
        this.clearQuotaError();
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    private clearQuotaError(): void {
        if (!this.quotaError) {
            return;
        }
        this.quotaError.hidden = true;
        this.quotaError.textContent = '';
    }

    private showQuotaError(message: string): void {
        if (!this.quotaError) {
            return;
        }
        this.quotaError.hidden = false;
        this.quotaError.textContent = message;
    }

    private getSourcePlugin(): FilesystemPlugin | null {
        const plugin = window.fontManager?.currentFont?.sourcePlugin;
        if (plugin && typeof plugin.canAddGlyphs === 'function') {
            return plugin as FilesystemPlugin;
        }
        return null;
    }

    private buildContent(): void {
        if (!this.content) {
            return;
        }
        const providerBar = document.createElement('label');
        providerBar.className = 'add-glyph-provider-control';
        providerBar.textContent = 'Character Set Provider';
        this.providerSelect = document.createElement('select');
        this.providerSelect.className = 'add-glyph-provider-select';
        this.providerSelect.setAttribute(
            'aria-label',
            'Character Set Provider'
        );
        providerBar.appendChild(this.providerSelect);

        const search = document.createElement('div');
        search.className = 'find-glyph-search overview-search-control';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined overview-search-icon';
        icon.textContent = 'search';
        search.appendChild(icon);

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'find-glyph-search-input';
        this.searchInput.type = 'search';
        this.searchInput.setAttribute('aria-label', 'Search glyph data');
        search.appendChild(this.searchInput);

        this.coverageControls = document.createElement('fieldset');
        this.coverageControls.className = 'add-glyph-coverage-controls';

        this.setPanel = document.createElement('section');
        this.setPanel.className = 'add-glyph-set-panel';
        const setHeading = document.createElement('h3');
        setHeading.textContent = 'Character Sets';
        const setSearch = document.createElement('div');
        setSearch.className = 'find-glyph-search overview-search-control';
        const setSearchIcon = document.createElement('span');
        setSearchIcon.className =
            'material-symbols-outlined overview-search-icon';
        setSearchIcon.textContent = 'search';
        setSearch.appendChild(setSearchIcon);
        this.setSearchInput = document.createElement('input');
        this.setSearchInput.className = 'find-glyph-search-input';
        this.setSearchInput.type = 'search';
        this.setSearchInput.placeholder = 'Search character sets';
        this.setSearchInput.setAttribute('aria-label', 'Search character sets');
        setSearch.appendChild(this.setSearchInput);
        this.setTree = document.createElement('div');
        this.setTree.className = 'add-glyph-set-tree';
        this.setTree.setAttribute('role', 'listbox');
        this.setTree.setAttribute('aria-multiselectable', 'true');
        this.setPanel.append(setHeading, setSearch, this.setTree);

        this.list = document.createElement('div');
        this.list.className = 'add-glyph-list';
        this.list.setAttribute('role', 'listbox');
        this.list.setAttribute('aria-multiselectable', 'true');

        const actions = document.createElement('div');
        actions.className = 'find-glyph-actions';
        this.quotaError = document.createElement('p');
        this.quotaError.className = 'add-glyphs-quota-error';
        this.quotaError.setAttribute('role', 'alert');
        this.quotaError.hidden = true;
        const cancel = document.createElement('button');
        cancel.className = 'dialog-button';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.close());
        actions.append(this.quotaError, cancel);

        this.confirmButton = document.createElement('button');
        this.confirmButton.className = 'dialog-button dialog-button-primary';
        this.confirmButton.type = 'button';
        this.confirmButton.addEventListener('click', () => {
            void this.addSelected();
        });
        actions.appendChild(this.confirmButton);
        const body = document.createElement('div');
        body.className = 'add-glyph-body';
        const resultsPanel = document.createElement('section');
        resultsPanel.className = 'add-glyph-results-panel';
        resultsPanel.append(search, this.coverageControls, this.list);
        body.append(this.setPanel, resultsPanel);
        this.content.replaceChildren(providerBar, body, actions);
        this.updateProviderLayout();
        this.syncConfirmButton();
    }

    private registerEvents(): void {
        const close = document.getElementById('add-glyphs-modal-close-btn');
        close?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });
        this.searchInput?.addEventListener('input', () => {
            void this.updateResults();
        });
        this.providerSelect?.addEventListener('change', () => {
            void this.changeProvider(this.providerSelect?.value || 'unicode');
        });
        this.setSearchInput?.addEventListener('input', () =>
            this.renderSetTree()
        );
        this.coverageControls?.addEventListener('change', (event) => {
            const input = event.target;
            if (
                !(input instanceof HTMLInputElement) ||
                !input.dataset.coverageLevel
            ) {
                return;
            }
            const level = input.dataset
                .coverageLevel as CharacterSetCoverageLevel;
            if (input.checked) {
                this.enabledLevels.add(level);
            } else {
                this.enabledLevels.delete(level);
            }
            void this.updateResults();
        });
        document.addEventListener(
            'keydown',
            (event) => {
                if (!this.isOpen()) {
                    return;
                }
                if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key.toLowerCase() === 'a' &&
                    !event.shiftKey &&
                    !event.altKey
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.selectAllResults();
                } else if (
                    event.key === 'ArrowDown' ||
                    event.key === 'ArrowUp'
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.moveActive(
                        event.key === 'ArrowDown' ? 1 : -1,
                        event.shiftKey
                    );
                } else if (event.key === ' ') {
                    if (
                        event.target instanceof HTMLInputElement ||
                        event.target instanceof HTMLSelectElement
                    ) {
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.toggleActive();
                } else if (event.key === 'Enter') {
                    if (
                        event.target instanceof HTMLInputElement ||
                        event.target instanceof HTMLSelectElement
                    ) {
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.addSelected();
                }
            },
            true
        );
    }

    private async updateResults(): Promise<void> {
        const version = ++this.searchVersion;
        const query = this.searchInput?.value || '';
        if (this.activeProviderId === 'unicode') {
            this.results = glyphDataIndex.search(query);
        } else {
            const characters = await characterSetPluginManager.getCharacters(
                this.activeProviderId,
                [...this.selectedSetIds],
                [...this.enabledLevels]
            );
            if (version !== this.searchVersion) {
                return;
            }
            this.results = characters
                .map((character) =>
                    glyphDataIndex.getGlyphDataForUnicode([character.codepoint])
                )
                .filter(
                    (record): record is GlyphDataSearchResult =>
                        record !== undefined &&
                        this.matchesSearch(record, query)
                );
        }
        this.selectedCodepoints.clear();
        this.activeIndex = this.results.length ? 0 : -1;
        this.selectionAnchor = this.activeIndex;
        this.renderResults();
    }

    private matchesSearch(
        record: GlyphDataSearchResult,
        query: string
    ): boolean {
        const normalized = query.trim().toLowerCase();
        return (
            !normalized ||
            record.character === query ||
            record.glyph_name.toLowerCase().includes(normalized) ||
            record.name.toLowerCase().includes(normalized) ||
            record.codepoint
                .toString(16)
                .startsWith(normalized.replace(/^u\+|^0x/, ''))
        );
    }

    private renderProviderOptions(): void {
        if (!this.providerSelect) {
            return;
        }
        const fragment = document.createDocumentFragment();
        const unicode = document.createElement('option');
        unicode.value = 'unicode';
        unicode.textContent = 'Unicode';
        fragment.appendChild(unicode);
        for (const provider of characterSetPluginManager.getProviders()) {
            const option = document.createElement('option');
            option.value = provider.id;
            option.textContent = provider.name;
            fragment.appendChild(option);
        }
        this.providerSelect.replaceChildren(fragment);
        this.providerSelect.value = this.activeProviderId;
    }

    private async changeProvider(providerId: string): Promise<void> {
        this.activeProviderId = providerId;
        this.selectedSetIds.clear();
        this.activeSetIndex = -1;
        this.setSelectionAnchor = -1;
        const provider = this.getActiveProvider();
        this.enabledLevels = new Set(
            provider?.coverageLevels
                .filter((level) => level.default)
                .map((level) => level.id) || []
        );
        this.renderCoverageControls();
        this.updateProviderLayout();
        this.renderSetTree();
        await this.updateResults();
    }

    private updateProviderLayout(): void {
        const provider = this.getActiveProvider();
        const hasSetTree = Boolean(provider?.tree.length);
        const hasCoverageLevels = Boolean(provider?.coverageLevels.length);
        if (this.setPanel) {
            this.setPanel.hidden = !hasSetTree;
        }
        if (this.coverageControls) {
            this.coverageControls.hidden = !hasCoverageLevels;
        }
        if (this.searchInput) {
            this.searchInput.placeholder = provider
                ? 'Search selected characters'
                : 'Search glyph names, Unicode names, characters, or U+ codepoints.';
        }
        this.content
            ?.closest('.add-glyphs-popup')
            ?.classList.toggle('has-character-set-tree', hasSetTree);
    }

    private getActiveProvider() {
        if (this.activeProviderId === 'unicode') {
            return undefined;
        }
        return characterSetPluginManager
            .getProviders()
            .find((candidate) => candidate.id === this.activeProviderId);
    }

    private renderCoverageControls(): void {
        if (!this.coverageControls) {
            return;
        }
        const provider = this.getActiveProvider();
        if (!provider?.coverageLevels.length) {
            this.coverageControls.replaceChildren();
            return;
        }
        const legend = document.createElement('legend');
        legend.textContent = 'Include';
        const fragment = document.createDocumentFragment();
        fragment.appendChild(legend);
        for (const level of provider.coverageLevels) {
            const option = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = this.enabledLevels.has(level.id);
            input.dataset.coverageLevel = level.id;
            option.append(input, document.createTextNode(level.label));
            fragment.appendChild(option);
        }
        this.coverageControls.replaceChildren(fragment);
    }

    private renderSetTree(): void {
        if (!this.setTree || this.activeProviderId === 'unicode') {
            return;
        }
        const provider = this.getActiveProvider();
        if (!provider) {
            this.setTree.replaceChildren();
            return;
        }
        const query = this.setSearchInput?.value.trim().toLowerCase() || '';
        const sets = this.getVisibleSets(provider.tree, query);
        this.activeSetIndex = sets.length
            ? Math.min(this.activeSetIndex, sets.length - 1)
            : -1;
        const fragment = document.createDocumentFragment();
        sets.forEach((set, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'add-glyph-set-row';
            row.textContent = set.label;
            row.classList.toggle('is-active', index === this.activeSetIndex);
            row.classList.toggle(
                'is-selected',
                this.selectedSetIds.has(set.id)
            );
            row.setAttribute('role', 'option');
            row.setAttribute(
                'aria-selected',
                String(this.selectedSetIds.has(set.id))
            );
            row.addEventListener('click', (event) => {
                this.selectSet(
                    sets,
                    index,
                    event.shiftKey,
                    event.metaKey || event.ctrlKey
                );
            });
            fragment.appendChild(row);
        });
        this.setTree.replaceChildren(fragment);
    }

    private getVisibleSets(
        nodes: CharacterSetNode[],
        query: string,
        ancestors: string[] = []
    ): CharacterSetNode[] {
        return nodes.flatMap((node) => {
            const label = [...ancestors, node.label].join(' - ');
            if (node.selectable) {
                return !query || label.toLowerCase().includes(query)
                    ? [{ ...node, label }]
                    : [];
            }
            return this.getVisibleSets(node.children || [], query, [
                ...ancestors,
                node.label
            ]);
        });
    }

    private selectSet(
        sets: CharacterSetNode[],
        index: number,
        range: boolean,
        toggle: boolean
    ): void {
        const set = sets[index];
        if (!set) {
            return;
        }
        this.activeSetIndex = index;
        if (range && this.setSelectionAnchor >= 0) {
            this.selectedSetIds.clear();
            const [start, end] = [this.setSelectionAnchor, index].sort(
                (left, right) => left - right
            );
            for (let candidate = start; candidate <= end; candidate += 1) {
                this.selectedSetIds.add(sets[candidate]!.id);
            }
        } else if (toggle) {
            if (this.selectedSetIds.has(set.id)) {
                this.selectedSetIds.delete(set.id);
            } else {
                this.selectedSetIds.add(set.id);
            }
            this.setSelectionAnchor = index;
        } else {
            this.selectedSetIds = new Set([set.id]);
            this.setSelectionAnchor = index;
        }
        this.renderSetTree();
        void this.updateResults();
    }

    private renderResults(): void {
        if (!this.list) {
            return;
        }
        const font = window.currentFontModel;
        const fragment = document.createDocumentFragment();
        this.results.forEach((record, index) => {
            const existing = font?.findGlyphByCodepoint(record.codepoint);
            const nameCollision = font?.findGlyph(record.glyph_name);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'add-glyph-row';
            row.classList.toggle('is-active', index === this.activeIndex);
            row.classList.toggle('is-existing', Boolean(existing));
            row.classList.toggle(
                'is-selected',
                this.selectedCodepoints.has(record.codepoint)
            );
            row.setAttribute('role', 'option');
            row.setAttribute(
                'aria-selected',
                String(this.selectedCodepoints.has(record.codepoint))
            );
            row.addEventListener('click', (event) =>
                this.selectRow(
                    index,
                    event.shiftKey,
                    event.metaKey || event.ctrlKey
                )
            );
            row.addEventListener('dblclick', () => {
                this.selectRow(index, false, false);
                this.addSelected();
            });

            const preview = document.createElement('span');
            preview.className = 'add-glyph-preview';
            preview.textContent = record.general_category.startsWith('M')
                ? `\u25cc${record.character}`
                : record.character || '—';
            row.appendChild(preview);

            const details = document.createElement('span');
            details.className = 'add-glyph-details';
            const name = document.createElement('strong');
            name.textContent = record.glyph_name;
            details.appendChild(name);
            row.appendChild(details);

            const properties = document.createElement('span');
            properties.className = 'add-glyph-properties';
            const extras = [
                `U+${record.codepoint.toString(16).toUpperCase().padStart(4, '0')}`,
                record.script,
                record.joining_type ? `join ${record.joining_type}` : ''
            ].filter(Boolean);
            const metadata = document.createElement('span');
            metadata.textContent = existing
                ? 'Already in font'
                : nameCollision
                  ? 'Glyph name already in font'
                  : extras.join(' · ');
            properties.appendChild(metadata);
            const category = document.createElement('span');
            category.className = 'add-glyph-category';
            const categoryName =
                GENERAL_CATEGORY_LABELS[record.general_category] ||
                'Unicode Character';
            category.textContent = `${categoryName} (${record.general_category})`;
            properties.appendChild(category);
            row.appendChild(properties);

            const unicodeName = document.createElement('span');
            unicodeName.className = 'add-glyph-unicode-name';
            unicodeName.textContent = record.name;
            row.appendChild(unicodeName);
            fragment.appendChild(row);
        });
        this.list.replaceChildren(fragment);
        this.syncConfirmButton();
    }

    private selectRow(index: number, range: boolean, toggle: boolean): void {
        const record = this.results[index];
        if (!record) {
            return;
        }
        this.activeIndex = index;
        if (range && this.selectionAnchor >= 0) {
            this.selectedCodepoints.clear();
            const [start, end] = [this.selectionAnchor, index].sort(
                (a, b) => a - b
            );
            for (let candidate = start; candidate <= end; candidate += 1) {
                const codepoint = this.results[candidate]!.codepoint;
                this.selectedCodepoints.add(codepoint);
            }
        } else if (toggle) {
            if (this.selectedCodepoints.has(record.codepoint)) {
                this.selectedCodepoints.delete(record.codepoint);
            } else {
                this.selectedCodepoints.add(record.codepoint);
            }
            this.selectionAnchor = index;
        } else {
            this.selectedCodepoints = new Set([record.codepoint]);
            this.selectionAnchor = index;
        }
        this.renderResults();
    }

    private moveActive(delta: number, extend: boolean): void {
        const next = this.activeIndex + delta;
        if (next < 0 || next >= this.results.length) {
            return;
        }
        this.selectRow(next, extend, false);
        this.list?.children[next]?.scrollIntoView({ block: 'nearest' });
    }

    private toggleActive(): void {
        if (this.activeIndex >= 0) {
            this.selectRow(this.activeIndex, false, true);
        }
    }

    private selectAllResults(): void {
        if (this.results.length === 0) {
            return;
        }
        this.selectedCodepoints = new Set(
            this.results.map((record) => record.codepoint)
        );
        this.activeIndex = 0;
        this.selectionAnchor = 0;
        this.renderResults();
    }

    private syncConfirmButton(): void {
        if (!this.confirmButton) {
            return;
        }
        const count = this.selectedCodepoints.size;
        this.confirmButton.disabled = count === 0;
        this.confirmButton.textContent =
            count === 1 ? 'Add Glyph' : `Add ${count} Glyphs`;
    }

    private async addSelected(): Promise<void> {
        const font = window.currentFontModel as Font | null;
        if (!font || this.selectedCodepoints.size === 0) {
            return;
        }
        this.clearQuotaError();
        const selected = this.results.filter((record) =>
            this.selectedCodepoints.has(record.codepoint)
        );
        const existingNames = new Set(font.glyphs.map((glyph) => glyph.name));
        const additions = selected.filter(
            (record) =>
                !font.findGlyphByCodepoint(record.codepoint) &&
                !existingNames.has(record.glyph_name)
        );
        if (additions.length === 0) {
            this.close();
            return;
        }
        const plugin = this.getSourcePlugin();
        if (plugin) {
            const gate = await plugin.canAddGlyphs(additions.length);
            if (!gate.allowed) {
                this.showQuotaError(
                    gate.reason || 'Glyph limit reached for this font.'
                );
                return;
            }
        }
        try {
            font.addGlyphs(
                additions.map((record) => ({
                    name: record.glyph_name,
                    codepoints: [record.codepoint],
                    category: record.general_category.startsWith('M')
                        ? 'Mark'
                        : 'Base'
                }))
            );
            this.close();
        } catch (error) {
            this.showQuotaError(
                error instanceof Error
                    ? error.message
                    : 'Glyph limit reached for this font.'
            );
        }
    }
}

window.addGlyphsDialog = new AddGlyphsDialog();
