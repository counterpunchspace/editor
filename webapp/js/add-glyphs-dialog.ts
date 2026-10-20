import { Font } from './babelfont-model';
import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
import {
    codepointQuery,
    glyphDataIndex,
    type GlyphDataSearchResult
} from './glyph-data';
import {
    characterSetPluginManager,
    type CharacterSetCoverageLevel,
    type CharacterSetEntry,
    type CharacterSetMembers,
    type CharacterSetNode
} from './character-set-plugin-manager';
import { ccmpDecomposition } from './language-packs/ccmp-shells';
import { arabicFormRules } from './language-packs/arabic-forms';
import { glyphComponentNames } from './language-packs/composition-conversion';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import type { FilesystemPlugin } from './filesystem-plugins/filesystem-plugin';

function glyphComposition(font: Font, name: string): string[] {
    const components = glyphComponentNames(font.findGlyph(name));
    if (components.length) {
        return components;
    }
    const decomposition = ccmpDecomposition(font.features).get(name);
    if (decomposition?.length) {
        return decomposition;
    }
    for (const position of arabicFormRules(font.features).values()) {
        const sequence = position.get(name);
        if (sequence?.length) {
            return sequence;
        }
    }
    return [];
}

const console = new Logger('AddGlyphsDialog');

const COVERAGE_LEVELS: ReadonlyArray<{
    id: CharacterSetCoverageLevel;
    label: string;
}> = [
    { id: 'essential', label: 'Essential' },
    { id: 'recommended', label: 'Recommended' },
    { id: 'optional', label: 'Optional' }
];

const PROVIDER_STORAGE_KEY = 'addGlyphsCharacterSetProvider';

function loadSavedProviderId(): string | null {
    try {
        const saved = localStorage.getItem(PROVIDER_STORAGE_KEY);
        return saved && saved.trim() ? saved : null;
    } catch {
        return null;
    }
}

function saveProviderId(providerId: string): void {
    try {
        localStorage.setItem(PROVIDER_STORAGE_KEY, providerId);
    } catch {
        // Preference storage can be unavailable in private browsing.
    }
}

function selectableSetIds(nodes: CharacterSetNode[]): string[] {
    return nodes.flatMap((node) => [
        ...(node.selectable ? [node.id] : []),
        ...selectableSetIds(node.children || [])
    ]);
}

function indexFontCoverage(font: Font | null | undefined): {
    codepoints: Set<number>;
    names: Set<string>;
} {
    const codepoints = new Set<number>();
    const names = new Set<string>();
    for (const glyph of font?.glyphs || []) {
        if (glyph.name) {
            names.add(glyph.name);
        }
        for (const codepoint of glyph.codepoints || []) {
            if (codepoint >= 0) {
                codepoints.add(codepoint);
            }
        }
    }
    return { codepoints, names };
}

function coverageForSet(
    members: CharacterSetMembers | undefined,
    font: { codepoints: Set<number>; names: Set<string> }
): { present: number; total: number } | null {
    if (!members) {
        return null;
    }
    let present = 0;
    for (const codepoint of members.codepoints) {
        if (font.codepoints.has(codepoint)) {
            present += 1;
        }
    }
    for (const name of members.glyphNames) {
        if (font.names.has(name)) {
            present += 1;
        }
    }
    return {
        present,
        total: members.codepoints.length + members.glyphNames.length
    };
}

type ListedGlyph = GlyphDataSearchResult & {
    coverageLevel?: CharacterSetCoverageLevel;
    categories?: string[];
};

function resultKey(record: { codepoint?: number; glyph_name: string }): string {
    if (typeof record.codepoint === 'number' && record.codepoint >= 0) {
        return `u:${record.codepoint}`;
    }
    return `g:${record.glyph_name}`;
}

/** A new search drops glyphs that left the list and keeps the rest selected. */
export function selectedKeysStillPresent(
    selected: Iterable<string>,
    results: Array<{ codepoint?: number; glyph_name: string }>
): string[] {
    const present = new Set(results.map((record) => resultKey(record)));
    return [...selected].filter((key) => present.has(key));
}

function characterRecord(
    character: CharacterSetEntry
): GlyphDataSearchResult | undefined {
    if (typeof character.codepoint === 'number') {
        return glyphDataIndex.getGlyphDataForUnicode([character.codepoint]);
    }
    if (!character.glyph_name) {
        return undefined;
    }
    return {
        codepoint: -1,
        glyph_name: character.glyph_name,
        name: character.glyph_name,
        general_category: character.category === 'Mark' ? 'Mn' : 'Lo',
        script: 'Arabic',
        character: ''
    };
}

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
    private compositionSettings: HTMLElement | null = null;
    private list: HTMLElement | null = null;
    private setDetail: HTMLElement | null = null;
    private categoryFilters: HTMLElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private quotaError: HTMLParagraphElement | null = null;
    private results: ListedGlyph[] = [];
    private selectedKeys = new Set<string>();
    private activeIndex = -1;
    private selectionAnchor = -1;
    private activeProviderId = 'unicode';
    private selectedSetIds = new Set<string>();
    private disabledCategories = new Set<string>();
    private presenceFilter: 'all' | 'present' | 'missing' = 'all';
    private categoryChips: HTMLElement | null = null;
    private searchTimer: number | null = null;
    private activeSetIndex = -1;
    private setSelectionAnchor = -1;
    private setMembers = new Map<string, CharacterSetMembers>();
    private setMembersProviderId = '';
    private setMembersRequest = 0;
    private searchVersion = 0;
    private samplePreviewVersion = 0;
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
                characterSetPluginManager.ensureReady(),
                this.refreshCompositionSettings()
            ]);
            this.restoreSavedProvider();
            this.renderProviderOptions();
            this.updateProviderLayout();
            await this.ensureSetMembers();
            this.renderSetTree();
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
        if (this.searchTimer !== null) {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = null;
        }
        this.escapeBinding?.release();
        this.escapeBinding = null;
        this.clearQuotaError();
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    private async refreshCompositionSettings(): Promise<void> {
        if (!this.compositionSettings) {
            return;
        }
        try {
            const { featureGeneratorEngine } =
                await import('./language-packs/feature-generator-engine');
            await featureGeneratorEngine.ensureReady();
            const { pluginSettingsRegistry } =
                await import('./plugin-settings/plugin-settings-registry');
            pluginSettingsRegistry.renderTarget(
                this.compositionSettings,
                'add-glyphs'
            );
        } catch (error) {
            console.error('Could not load composition settings', error);
            this.compositionSettings.replaceChildren();
        }
        this.compositionSettings.hidden =
            this.compositionSettings.childElementCount === 0;
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

        this.compositionSettings = document.createElement('div');
        this.compositionSettings.className = 'add-glyphs-composition';
        this.compositionSettings.hidden = true;

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

        this.setPanel = document.createElement('section');
        this.setPanel.className = 'add-glyph-set-panel';
        const setHeading = document.createElement('h3');
        setHeading.textContent = 'Glyph Sets';
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
        this.setSearchInput.placeholder = 'Search glyph sets';
        this.setSearchInput.setAttribute('aria-label', 'Search glyph sets');
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
        new ResizeObserver(() => this.syncAbbreviatedTitles()).observe(
            this.list
        );

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
        const resultsHeading = document.createElement('h3');
        resultsHeading.textContent = 'Glyphs';
        const resultsToolbar = document.createElement('div');
        resultsToolbar.className = 'add-glyph-results-toolbar';
        resultsToolbar.append(search);
        this.categoryFilters = document.createElement('div');
        this.categoryFilters.className = 'add-glyph-category-filters';
        this.categoryFilters.hidden = true;
        const presence = document.createElement('div');
        presence.className = 'add-glyph-presence';
        presence.setAttribute('role', 'radiogroup');
        presence.setAttribute('aria-label', 'Which glyphs to show');
        for (const option of [
            ['all', 'All'],
            ['present', 'Present'],
            ['missing', 'Missing']
        ] as const) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.presence = option[0];
            button.textContent = option[1];
            button.setAttribute('aria-pressed', String(option[0] === 'all'));
            if (option[0] === 'all') {
                button.classList.add('is-selected');
            }
            presence.appendChild(button);
        }
        this.categoryChips = document.createElement('div');
        this.categoryChips.className = 'add-glyph-category-chips';
        this.categoryFilters.append(presence, this.categoryChips);
        resultsPanel.append(
            resultsHeading,
            resultsToolbar,
            this.categoryFilters,
            this.list
        );
        this.setDetail = document.createElement('aside');
        this.setDetail.className = 'add-glyph-set-detail';
        this.setDetail.hidden = true;
        resultsPanel.appendChild(this.setDetail);
        body.append(this.setPanel, resultsPanel);
        this.content.replaceChildren(
            providerBar,
            this.compositionSettings,
            body,
            actions
        );
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
        window.addEventListener('pluginSettingsRegistered', () => {
            if (this.isOpen()) {
                void this.refreshCompositionSettings();
            }
        });
        this.searchInput?.addEventListener('input', () => {
            if (this.searchTimer !== null) {
                window.clearTimeout(this.searchTimer);
            }
            this.searchTimer = window.setTimeout(() => {
                this.searchTimer = null;
                void this.updateResults();
            }, 200);
        });
        this.providerSelect?.addEventListener('change', () => {
            void this.changeProvider(this.providerSelect?.value || 'unicode');
        });
        this.setSearchInput?.addEventListener('input', () =>
            this.renderSetTree()
        );
        this.categoryFilters?.addEventListener('click', (event) => {
            const presenceButton = (
                event.target as HTMLElement | null
            )?.closest('[data-presence]');
            if (presenceButton instanceof HTMLButtonElement) {
                const presence = presenceButton.dataset.presence;
                if (
                    presence === 'all' ||
                    presence === 'present' ||
                    presence === 'missing'
                ) {
                    this.presenceFilter = presence;
                    this.renderResults();
                }
                return;
            }
            const chip = (event.target as HTMLElement | null)?.closest(
                '[data-category]'
            );
            if (
                !(chip instanceof HTMLButtonElement) ||
                !chip.dataset.category
            ) {
                return;
            }
            const category = chip.dataset.category;
            if (this.disabledCategories.has(category)) {
                this.disabledCategories.delete(category);
            } else {
                this.disabledCategories.add(category);
            }
            this.renderResults();
        });
        this.list?.addEventListener('change', (event) => {
            const input = event.target;
            if (
                !(input instanceof HTMLInputElement) ||
                !input.dataset.selectAll
            ) {
                return;
            }
            this.setColumnSelection(
                input.dataset.selectAll as CharacterSetCoverageLevel,
                input.checked
            );
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
                    const target = event.target;
                    if (
                        target instanceof HTMLInputElement ||
                        target instanceof HTMLTextAreaElement ||
                        (target instanceof HTMLElement &&
                            target.isContentEditable)
                    ) {
                        return;
                    }
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
                COVERAGE_LEVELS.map((level) => level.id)
            );
            if (version !== this.searchVersion) {
                return;
            }
            this.results = COVERAGE_LEVELS.flatMap((level) =>
                characters.flatMap((character) => {
                    if (character.level !== level.id) {
                        return [];
                    }
                    const record = characterRecord(character);
                    return record && this.matchesSearch(record, query)
                        ? [
                              {
                                  ...record,
                                  coverageLevel: character.level,
                                  categories: character.categories || []
                              }
                          ]
                        : [];
                })
            );
        }
        const kept = selectedKeysStillPresent(this.selectedKeys, this.results);
        this.selectedKeys = new Set(kept);
        const active = this.results[this.activeIndex];
        if (!active || (kept.length > 0 && !kept.includes(resultKey(active)))) {
            const next = this.results.findIndex((record) =>
                kept.includes(resultKey(record))
            );
            this.activeIndex = next >= 0 ? next : this.results.length ? 0 : -1;
            this.selectionAnchor = this.activeIndex;
        }
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
            record.codepoint.toString(16).startsWith(codepointQuery(normalized))
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

    private restoreSavedProvider(): void {
        const saved = loadSavedProviderId();
        if (!saved) {
            return;
        }
        const known =
            saved === 'unicode' ||
            characterSetPluginManager
                .getProviders()
                .some((provider) => provider.id === saved);
        if (known) {
            this.activeProviderId = saved;
        }
    }

    private async changeProvider(providerId: string): Promise<void> {
        this.activeProviderId = providerId;
        saveProviderId(providerId);
        this.selectedSetIds.clear();
        this.disabledCategories.clear();
        this.activeSetIndex = -1;
        this.setSelectionAnchor = -1;
        this.updateProviderLayout();
        await this.ensureSetMembers();
        this.renderSetTree();
        await this.updateResults();
    }

    private updateProviderLayout(): void {
        const provider = this.getActiveProvider();
        const hasSetTree = Boolean(provider?.tree.length);
        if (this.setPanel) {
            this.setPanel.hidden = !hasSetTree;
        }
        if (this.searchInput) {
            this.searchInput.placeholder = provider
                ? 'Search selected characters'
                : 'Search glyph names, Unicode names, characters, or U+ codepoints.';
        }
        this.content
            ?.closest('.add-glyphs-popup')
            ?.classList.toggle('has-character-set-tree', hasSetTree);
        this.content
            ?.closest('.add-glyphs-popup')
            ?.classList.toggle(
                'has-coverage-columns',
                Boolean(provider) && !hasSetTree
            );
    }

    private getActiveProvider() {
        if (this.activeProviderId === 'unicode') {
            return undefined;
        }
        return characterSetPluginManager
            .getProviders()
            .find((candidate) => candidate.id === this.activeProviderId);
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
        const fontCoverage = indexFontCoverage(window.currentFontModel);
        const fragment = document.createDocumentFragment();
        sets.forEach((set, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'add-glyph-set-row';
            const label = document.createElement('span');
            label.className = 'add-glyph-set-label';
            label.textContent = set.label;
            row.appendChild(label);
            const coverage = coverageForSet(
                this.setMembers.get(set.id),
                fontCoverage
            );
            if (coverage) {
                const chip = document.createElement('span');
                chip.className = 'add-glyph-set-coverage';
                chip.classList.toggle(
                    'is-complete',
                    coverage.total > 0 && coverage.present === coverage.total
                );
                chip.textContent = `${coverage.present}/${coverage.total}`;
                chip.title = `${coverage.present} of ${coverage.total} glyphs from this character set are in the font`;
                row.appendChild(chip);
                row.setAttribute(
                    'aria-label',
                    `${set.label}, ${coverage.present} of ${coverage.total}`
                );
            }
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
        this.renderSetDetail();
    }

    private async ensureSetMembers(): Promise<void> {
        const provider = this.getActiveProvider();
        if (!provider || this.setMembersProviderId === provider.id) {
            return;
        }
        const request = ++this.setMembersRequest;
        try {
            const grouped = await characterSetPluginManager.getMembersBySet(
                provider.id,
                selectableSetIds(provider.tree),
                []
            );
            if (
                request !== this.setMembersRequest ||
                this.activeProviderId !== provider.id
            ) {
                return;
            }
            this.setMembersProviderId = provider.id;
            this.setMembers = new Map(Object.entries(grouped));
        } catch (error) {
            console.error('Could not load character set coverage', error);
        }
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
        const rows = this.results.map((record, index) =>
            this.createGlyphRow(record, index, font)
        );
        this.renderCategoryFilters();
        if (this.getActiveProvider()) {
            this.list.className = 'add-glyph-columns';
            this.list.removeAttribute('role');
            const columns = document.createDocumentFragment();
            for (const level of COVERAGE_LEVELS) {
                columns.appendChild(
                    this.createLevelColumn(
                        level,
                        rows.filter((_, index) => {
                            const record = this.results[index];
                            return (
                                record?.coverageLevel === level.id &&
                                this.recordIsShown(record)
                            );
                        })
                    )
                );
            }
            this.list.replaceChildren(columns);
        } else {
            this.list.className = 'add-glyph-list';
            this.list.setAttribute('role', 'listbox');
            this.list.replaceChildren(
                ...rows.filter((_, index) =>
                    this.recordIsShown(this.results[index])
                )
            );
        }
        this.syncConfirmButton();
        this.syncAbbreviatedTitles();
        this.renderSetDetail();
        void this.paintSamplePreviews();
    }

    private renderSetDetail(): void {
        if (!this.setDetail) {
            return;
        }
        const provider = this.getActiveProvider();
        const sets = this.getVisibleSets(
            provider?.tree || [],
            this.setSearchInput?.value.trim().toLowerCase() || ''
        );
        const active = sets[this.activeSetIndex];
        const detail =
            active && this.selectedSetIds.has(active.id)
                ? provider?.setDetails[active.id]
                : undefined;
        if (!detail) {
            this.setDetail.hidden = true;
            this.setDetail.replaceChildren();
            return;
        }
        this.setDetail.hidden = false;
        const text = document.createElement('div');
        text.className = 'add-glyph-set-detail-text';
        const title = document.createElement('h4');
        title.textContent = detail.title;
        const description = document.createElement('p');
        description.textContent = detail.description;
        text.append(title, description);
        const image = document.createElement('img');
        image.alt = '';
        image.src = detail.image.trim().startsWith('<svg')
            ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(detail.image)}`
            : detail.image;
        this.setDetail.replaceChildren(text, image);
    }

    private renderCategoryFilters(): void {
        if (!this.categoryFilters) {
            return;
        }
        const definitions = this.getActiveProvider()?.glyphCategories || [];
        const counts = new Map<string, number>();
        for (const record of this.results) {
            if (!this.matchesPresence(record)) {
                continue;
            }
            for (const category of record.categories || []) {
                counts.set(category, (counts.get(category) || 0) + 1);
            }
        }
        const categories = definitions.filter(
            (category) => (counts.get(category.id) || 0) > 0
        );
        this.categoryFilters.hidden = this.results.length === 0;
        for (const button of this.categoryFilters.querySelectorAll<HTMLButtonElement>(
            '[data-presence]'
        )) {
            const selected = button.dataset.presence === this.presenceFilter;
            button.classList.toggle('is-selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        }
        if (!this.categoryChips) {
            return;
        }
        if (categories.length === 0) {
            this.categoryChips.replaceChildren();
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const category of categories) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'add-glyph-category-chip';
            chip.dataset.category = category.id;
            const selected = !this.disabledCategories.has(category.id);
            chip.classList.toggle('is-selected', selected);
            chip.setAttribute('aria-pressed', String(selected));
            const label = document.createElement('span');
            label.textContent = category.label;
            const count = document.createElement('span');
            count.className = 'add-glyph-set-coverage';
            count.textContent = String(counts.get(category.id) || 0);
            chip.append(label, count);
            fragment.appendChild(chip);
        }
        this.categoryChips.replaceChildren(fragment);
    }

    private recordIsPresent(record: ListedGlyph): boolean {
        const font = window.currentFontModel;
        if (typeof record.codepoint === 'number' && record.codepoint >= 0) {
            return Boolean(font?.findGlyphByCodepoint(record.codepoint));
        }
        return Boolean(font?.findGlyph(record.glyph_name));
    }

    private matchesPresence(record: ListedGlyph): boolean {
        if (this.presenceFilter === 'all') {
            return true;
        }
        const present = this.recordIsPresent(record);
        return this.presenceFilter === 'present' ? present : !present;
    }

    private recordIsShown(record: ListedGlyph | undefined): boolean {
        if (!record || !this.matchesPresence(record)) {
            return false;
        }
        return this.matchesGlyphCategories(record);
    }

    /** A glyph with several plugin categories stays visible while any of them is selected. */
    private matchesGlyphCategories(record: ListedGlyph): boolean {
        const categories = record.categories;
        if (!categories?.length) {
            return true;
        }
        return categories.some(
            (category) => !this.disabledCategories.has(category)
        );
    }

    private glyphCategoryLabel(id: string): string {
        return (
            this.getActiveProvider()?.glyphCategories.find(
                (category) => category.id === id
            )?.label || id
        );
    }

    private syncAbbreviatedTitles(): void {
        if (!this.list) {
            return;
        }
        for (const label of this.list.querySelectorAll<HTMLElement>(
            '.add-glyph-details strong, .add-glyph-unicode-name'
        )) {
            const text = label.textContent || '';
            if (text && label.scrollWidth > label.clientWidth + 1) {
                label.title = text;
            } else {
                label.removeAttribute('title');
            }
        }
    }

    private async paintSamplePreviews(): Promise<void> {
        const version = ++this.samplePreviewVersion;
        const previews = [
            ...(this.list?.querySelectorAll<HTMLElement>(
                '[data-sample-glyph]'
            ) || [])
        ];
        const names = [
            ...new Set(
                previews
                    .map((preview) => preview.dataset.sampleGlyph || '')
                    .filter(Boolean)
            )
        ];
        if (!names.length) {
            return;
        }
        const { languagePackManager } =
            await import('./language-packs/language-pack-manager');
        const drawings = await languagePackManager.drawings(names);
        if (version !== this.samplePreviewVersion || !this.list) {
            return;
        }
        const metrics = this.sampleTileMetrics();
        for (const preview of previews) {
            if (!preview.isConnected) {
                continue;
            }
            const name = preview.dataset.sampleGlyph || '';
            const drawing = drawings[name];
            if (!drawing?.paths?.length) {
                continue;
            }
            const scale =
                metrics.upm / (drawing.upm > 0 ? drawing.upm : metrics.upm);
            const display = 44;
            const canvas = fastGlyphTileRenderer.renderToCanvas(
                {
                    name,
                    width: drawing.width * scale,
                    shapes: drawing.paths.map((path) => ({
                        closed: path.closed,
                        nodes: path.nodes.map((node) => ({
                            ...node,
                            x: node.x * scale,
                            y: node.y * scale
                        }))
                    }))
                },
                metrics,
                display,
                display,
                undefined,
                {
                    fill: getComputedStyle(preview).color,
                    sample: true
                }
            );
            canvas.style.width = `${display}px`;
            canvas.style.height = `${display}px`;
            preview.replaceChildren(canvas);
        }
    }

    private sampleTileMetrics(): {
        ascender: number;
        descender: number;
        upm: number;
    } {
        const font = window.currentFontModel;
        const master = font?.masters?.[0];
        const upm = font?.upm && font.upm > 0 ? font.upm : 1000;
        return {
            upm,
            ascender: master?.metrics?.Ascender ?? upm * 0.8,
            descender: master?.metrics?.Descender ?? -upm * 0.2
        };
    }

    private createLevelColumn(
        level: (typeof COVERAGE_LEVELS)[number],
        rows: HTMLButtonElement[]
    ): HTMLElement {
        const column = document.createElement('section');
        column.className = rows.length
            ? 'add-glyph-column'
            : 'add-glyph-column is-empty';
        const header = document.createElement('div');
        header.className = 'add-glyph-column-header';
        const titleGroup = document.createElement('div');
        titleGroup.className = 'add-glyph-column-title';
        const title = document.createElement('h4');
        title.textContent = level.label;
        const present = rows.filter((row) =>
            row.classList.contains('is-existing')
        ).length;
        const coverage = document.createElement('span');
        coverage.className = 'add-glyph-set-coverage';
        coverage.classList.toggle(
            'is-complete',
            rows.length > 0 && present === rows.length
        );
        coverage.textContent = `${present}/${rows.length}`;
        coverage.title = `${present} of ${rows.length} glyphs in this column are in the font`;
        titleGroup.append(title, coverage);
        const selectAll = document.createElement('label');
        selectAll.className = 'add-glyph-select-all';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.selectAll = level.id;
        const keys = rows.map((row) => row.dataset.resultKey || '');
        const selectedCount = keys.filter((key) =>
            this.selectedKeys.has(key)
        ).length;
        input.checked = keys.length > 0 && selectedCount === keys.length;
        input.indeterminate = selectedCount > 0 && selectedCount < keys.length;
        input.disabled = keys.length === 0;
        input.setAttribute('aria-label', `Select all ${level.label} glyphs`);
        selectAll.append(input, 'Select all');
        header.append(titleGroup, selectAll);
        const list = document.createElement('div');
        list.className = 'add-glyph-list';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', level.label);
        list.setAttribute('aria-multiselectable', 'true');
        list.replaceChildren(...rows);
        column.append(header, list);
        return column;
    }

    private createGlyphRow(
        record: ListedGlyph,
        index: number,
        font: Font | null | undefined
    ): HTMLButtonElement {
        const existing =
            typeof record.codepoint === 'number' && record.codepoint >= 0
                ? font?.findGlyphByCodepoint(record.codepoint)
                : font?.findGlyph(record.glyph_name);
        const nameCollision = font?.findGlyph(record.glyph_name);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'add-glyph-row';
        row.dataset.resultIndex = String(index);
        row.dataset.resultKey = resultKey(record);
        row.classList.toggle('is-active', index === this.activeIndex);
        row.classList.toggle('is-existing', Boolean(existing));
        row.classList.toggle(
            'is-selected',
            this.selectedKeys.has(resultKey(record))
        );
        row.setAttribute('role', 'option');
        row.setAttribute(
            'aria-selected',
            String(this.selectedKeys.has(resultKey(record)))
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
        const unencoded =
            typeof record.codepoint !== 'number' || record.codepoint < 0;
        if (unencoded) {
            preview.dataset.sampleGlyph = record.glyph_name;
        }
        const previewChar = document.createElement('span');
        previewChar.className = 'add-glyph-preview-char';
        previewChar.textContent = record.general_category.startsWith('M')
            ? `\u25cc${record.character}`
            : record.character || '—';
        preview.appendChild(previewChar);
        row.appendChild(preview);

        const details = document.createElement('span');
        details.className = 'add-glyph-details';
        const name = document.createElement('strong');
        name.textContent = record.glyph_name;
        details.appendChild(name);

        const status = document.createElement('span');
        status.className = 'add-glyph-status';
        const extras = [
            record.script,
            record.joining_type ? `join ${record.joining_type}` : ''
        ].filter(Boolean);
        if (existing) {
            const chip = document.createElement('span');
            chip.className =
                'add-glyph-set-coverage is-complete add-glyph-present';
            const mark = document.createElement('span');
            mark.className = 'material-symbols-outlined';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = 'check';
            chip.append(mark, 'Already in font');
            status.appendChild(chip);
        } else {
            status.textContent = nameCollision
                ? 'Glyph name already in font'
                : extras.join(' · ');
        }
        const unicodeName = document.createElement('span');
        unicodeName.className = 'add-glyph-unicode-name';
        if (typeof record.codepoint === 'number' && record.codepoint >= 0) {
            const codepoint = document.createElement('span');
            codepoint.className = 'add-glyph-codepoint';
            codepoint.textContent = `0x${record.codepoint
                .toString(16)
                .toUpperCase()
                .padStart(4, '0')}`;
            unicodeName.append(codepoint, ` ${record.name}`);
        } else {
            unicodeName.textContent = record.name;
        }
        details.appendChild(unicodeName);
        row.appendChild(details);

        const meta = document.createElement('span');
        meta.className = 'add-glyph-meta';
        meta.appendChild(status);

        const category = document.createElement('span');
        category.className = 'add-glyph-category';
        if (record.categories?.length) {
            category.textContent = record.categories
                .map((id) => this.glyphCategoryLabel(id))
                .join(' · ');
        } else {
            const categoryName =
                GENERAL_CATEGORY_LABELS[record.general_category] ||
                'Unicode Character';
            category.textContent = `${categoryName} (${record.general_category})`;
        }
        meta.appendChild(category);
        row.appendChild(meta);
        return row;
    }

    private setColumnSelection(
        level: CharacterSetCoverageLevel,
        selected: boolean
    ): void {
        for (const record of this.results) {
            if (
                record.coverageLevel !== level ||
                !this.matchesGlyphCategories(record) ||
                !this.matchesPresence(record)
            ) {
                continue;
            }
            const key = resultKey(record);
            if (selected) {
                this.selectedKeys.add(key);
            } else {
                this.selectedKeys.delete(key);
            }
        }
        this.syncSelectionState();
    }

    private selectRow(index: number, range: boolean, toggle: boolean): void {
        const record = this.results[index];
        if (!record) {
            return;
        }
        this.activeIndex = index;
        if (range && this.selectionAnchor >= 0) {
            const anchor = this.results[this.selectionAnchor];
            const level = anchor?.coverageLevel;
            if (
                level &&
                record.coverageLevel &&
                level !== record.coverageLevel
            ) {
                this.selectedKeys = new Set([resultKey(record)]);
                this.selectionAnchor = index;
            } else {
                this.selectedKeys.clear();
                const [start, end] = [this.selectionAnchor, index].sort(
                    (a, b) => a - b
                );
                for (let candidate = start; candidate <= end; candidate += 1) {
                    const item = this.results[candidate];
                    if (
                        !item ||
                        !this.matchesGlyphCategories(item) ||
                        !this.matchesPresence(item) ||
                        (level && item.coverageLevel !== level)
                    ) {
                        continue;
                    }
                    this.selectedKeys.add(resultKey(item));
                }
            }
        } else if (toggle) {
            const key = resultKey(record);
            if (this.selectedKeys.has(key)) {
                this.selectedKeys.delete(key);
            } else {
                this.selectedKeys.add(key);
            }
            this.selectionAnchor = index;
        } else {
            this.selectedKeys = new Set([resultKey(record)]);
            this.selectionAnchor = index;
        }
        this.syncSelectionState();
    }

    private syncSelectionState(): void {
        if (!this.list) {
            return;
        }
        for (const row of this.list.querySelectorAll<HTMLElement>(
            '.add-glyph-row'
        )) {
            const key = row.dataset.resultKey || '';
            const selected = this.selectedKeys.has(key);
            row.classList.toggle('is-selected', selected);
            row.classList.toggle(
                'is-active',
                Number(row.dataset.resultIndex) === this.activeIndex
            );
            row.setAttribute('aria-selected', String(selected));
        }
        for (const input of this.list.querySelectorAll<HTMLInputElement>(
            '[data-select-all]'
        )) {
            const rows = [
                ...(input
                    .closest('.add-glyph-column')
                    ?.querySelectorAll<HTMLElement>('.add-glyph-row') || [])
            ];
            const selectedCount = rows.filter((row) =>
                this.selectedKeys.has(row.dataset.resultKey || '')
            ).length;
            input.checked = rows.length > 0 && selectedCount === rows.length;
            input.indeterminate =
                selectedCount > 0 && selectedCount < rows.length;
        }
        this.syncConfirmButton();
    }

    private moveActive(delta: number, extend: boolean): void {
        const current = this.results[this.activeIndex];
        let next = this.activeIndex + delta;
        if (current?.coverageLevel) {
            const indexes = this.results.flatMap((record, index) =>
                record.coverageLevel === current.coverageLevel &&
                this.recordIsShown(record)
                    ? [index]
                    : []
            );
            const position = indexes.indexOf(this.activeIndex);
            next = indexes[position + delta] ?? -1;
        }
        if (next < 0 || next >= this.results.length) {
            return;
        }
        this.selectRow(next, extend, false);
        this.list
            ?.querySelector<HTMLElement>(`[data-result-index="${next}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    private toggleActive(): void {
        if (this.activeIndex >= 0) {
            this.selectRow(this.activeIndex, false, true);
        }
    }

    private selectAllResults(): void {
        const visible = this.results.filter((record) =>
            this.recordIsShown(record)
        );
        if (visible.length === 0) {
            return;
        }
        this.selectedKeys = new Set(visible.map((record) => resultKey(record)));
        this.activeIndex = 0;
        this.selectionAnchor = 0;
        this.syncSelectionState();
    }

    private syncConfirmButton(): void {
        if (!this.confirmButton) {
            return;
        }
        const count = this.selectedKeys.size;
        this.confirmButton.disabled = count === 0;
        this.confirmButton.textContent =
            count === 1 ? 'Add Glyph' : `Add ${count} Glyphs`;
    }

    private async addSelected(): Promise<void> {
        const font = window.currentFontModel as Font | null;
        if (!font || this.selectedKeys.size === 0) {
            return;
        }
        this.clearQuotaError();
        const selected = this.results.filter((record) =>
            this.selectedKeys.has(resultKey(record))
        );
        const existingNames = new Set(font.glyphs.map((glyph) => glyph.name));
        const additions = selected.filter((record) => {
            const encoded =
                typeof record.codepoint === 'number' &&
                record.codepoint >= 0 &&
                font.findGlyphByCodepoint(record.codepoint);
            return !encoded && !existingNames.has(record.glyph_name);
        });
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
            const { languagePackManager } =
                await import('./language-packs/language-pack-manager');
            const { compositionOutputSetting, planGlyphAdditions } =
                await import('./language-packs/composition-planner');
            const { applyCompositionPlan } =
                await import('./language-packs/composition-applicator');
            const { managedInputs } =
                await import('./language-packs/managed-features');
            const output = compositionOutputSetting(
                font.getPluginSetting(
                    'space.counterpunch.ccmp',
                    'composition_output'
                )
            );
            const plan = await planGlyphAdditions(
                additions.map((record) => ({
                    codepoint:
                        typeof record.codepoint === 'number' &&
                        record.codepoint >= 0
                            ? record.codepoint
                            : undefined,
                    glyph_name: record.glyph_name,
                    general_category: record.general_category,
                    category: record.general_category.startsWith('M')
                        ? 'Mark'
                        : 'Base'
                })),
                output,
                {
                    glyphNameForCodepoint: (codepoint) =>
                        font.findGlyphByCodepoint(codepoint)?.name,
                    hasGlyph: (name) => Boolean(font.findGlyph(name)),
                    masters: (font.masters || []).map((master) => ({
                        id: master.id,
                        metrics: {
                            xheight: master.metrics?.XHeight ?? 500,
                            capheight: master.metrics?.CapHeight ?? 700,
                            ascender: master.metrics?.Ascender ?? 800,
                            descender: master.metrics?.Descender ?? -200,
                            upm: font.upm ?? 1000,
                            italic_angle: master.metrics?.ItalicAngle ?? 0
                        }
                    })),
                    glyphNames: () =>
                        (font.glyphs || []).map((glyph) => glyph.name),
                    composition: (name: string) => glyphComposition(font, name)
                },
                languagePackManager,
                managedInputs(
                    font.features,
                    'space.counterpunch.ccmp',
                    'decomposition'
                )
            );
            if (plan.supportingCount && this.confirmButton) {
                this.confirmButton.textContent = `Add ${additions.length} Glyphs + ${plan.supportingCount} supporting`;
            }
            const gateCount = plan.create.length || additions.length;
            if (plugin) {
                const supportGate = await plugin.canAddGlyphs(gateCount);
                if (!supportGate.allowed) {
                    this.showQuotaError(
                        supportGate.reason ||
                            'Glyph limit reached for this font.'
                    );
                    return;
                }
            }
            applyCompositionPlan(font, plan, 'Add glyphs');
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
