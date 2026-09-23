import { ArrowAdjustableTextInput } from './arrow-adjustable-text-input';
import type { Master } from './babelfont-model';
import { forEachKerningPair } from './delete-glyphs-preflight';
import {
    getKerningPairValue,
    getMasterDisplayLabel,
    setKerningPairValueOnMaster,
    type KerningContainer
} from './kerning-utils';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('KerningEditorDialog');

type KerningDirection = 'ltr' | 'rtl';
type SortColumn = 'first' | 'second';
type SortDirection = 'asc' | 'desc';

type KerningPairRow = {
    first: string;
    second: string;
    values: Array<number | null>;
};

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function compareStrings(left: string, right: string): number {
    return left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

function isSamePair(
    first: string | null,
    second: string | null,
    otherFirst: string,
    otherSecond: string
): boolean {
    return first === otherFirst && second === otherSecond;
}

function formatPairSideHtml(sideKey: string): string {
    const escaped = escapeHtml(sideKey);
    if (sideKey.startsWith('@')) {
        return `<strong class="kerning-editor-class-name">${escaped}</strong>`;
    }
    return escaped;
}

export class KerningEditorDialog {
    private readonly modal = document.getElementById('kerning-editor-modal');
    private readonly content = document.getElementById(
        'kerning-editor-modal-content'
    );
    private escapeBinding: ModalEscapeBinding | null = null;
    private direction: KerningDirection = 'ltr';
    private sortColumn: SortColumn = 'first';
    private sortDirection: SortDirection = 'asc';
    private selectedFirst: string | null = null;
    private selectedSecond: string | null = null;
    private searchQuery = '';
    private tableWrap: HTMLElement | null = null;
    private deleteButton: HTMLButtonElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private arrowInputs: ArrowAdjustableTextInput[] = [];
    private readonly handleFontModelSync = () => {
        if (this.isOpen()) {
            this.renderTable({ preserveScroll: true });
        }
    };
    private readonly handleKeyDown = (event: KeyboardEvent) => {
        if (!this.isOpen()) {
            return;
        }
        if (event.key !== 'Delete' && event.key !== 'Backspace') {
            return;
        }
        const target = event.target;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        ) {
            return;
        }
        if (this.selectedFirst === null || this.selectedSecond === null) {
            return;
        }
        if (!this.hasVisibleSelectedRow()) {
            return;
        }
        event.preventDefault();
        this.deleteSelectedRow();
    };

    constructor() {
        this.buildContent();
        this.registerEvents();
    }

    open(): void {
        if (!this.modal || !this.content) {
            return;
        }
        if (!window.currentFontModel) {
            console.warn('No font open; cannot open Kerning Editor');
            return;
        }

        const textModePair =
            window.glyphCanvas?.getActiveTextModeKerningPairSelection?.() ??
            null;
        let scrollSelectedToCenter = false;
        if (textModePair) {
            this.applyDirection(textModePair.isRTL ? 'rtl' : 'ltr', {
                clearSelection: false
            });
            this.selectedFirst = textModePair.firstKey;
            this.selectedSecond = textModePair.secondKey;
            // Clear search so the property-panel pair is not filtered out.
            this.searchQuery = '';
            if (this.searchInput) {
                this.searchInput.value = '';
            }
            scrollSelectedToCenter = true;
        }

        this.modal.style.display = 'flex';
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.close(), {
            isOpen: () => this.isOpen()
        });
        window.addEventListener('fontModelSync', this.handleFontModelSync);
        window.addEventListener('keydown', this.handleKeyDown);
        if (this.searchInput) {
            this.searchInput.value = this.searchQuery;
        }
        this.renderTable({
            preserveScroll: false,
            scrollSelectedToCenter
        });
        this.updateDeleteEnabled();
        if (!scrollSelectedToCenter) {
            requestAnimationFrame(() => this.searchInput?.focus());
        }
    }

    isOpen(): boolean {
        return this.modal?.style.display === 'flex';
    }

    private close(): void {
        this.escapeBinding?.release();
        this.escapeBinding = null;
        window.removeEventListener('fontModelSync', this.handleFontModelSync);
        window.removeEventListener('keydown', this.handleKeyDown);
        this.arrowInputs = [];
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    private buildContent(): void {
        if (!this.content) {
            return;
        }

        this.content.innerHTML = `
            <div class="kerning-editor-toolbar">
                <div class="kerning-editor-toolbar-start">
                    <div class="kerning-editor-direction" role="group" aria-label="Kerning direction">
                        <button type="button" class="kerning-editor-direction-btn active" data-direction="ltr">LTR</button>
                        <button type="button" class="kerning-editor-direction-btn" data-direction="rtl">RTL</button>
                    </div>
                    <div class="find-glyph-search overview-search-control kerning-editor-search">
                        <span class="material-symbols-outlined overview-search-icon">search</span>
                        <input
                            type="search"
                            class="find-glyph-search-input"
                            id="kerning-editor-search-input"
                            placeholder="Search classes or glyphs in classes"
                            aria-label="Search kerning classes or glyphs in classes"
                            spellcheck="false"
                        >
                    </div>
                </div>
                <button type="button" class="dialog-button dialog-button-danger" id="kerning-editor-delete-btn" disabled>Delete</button>
            </div>
            <div class="kerning-editor-table-wrap" id="kerning-editor-table-wrap"></div>
        `;

        this.tableWrap = this.content.querySelector(
            '#kerning-editor-table-wrap'
        );
        this.deleteButton = this.content.querySelector(
            '#kerning-editor-delete-btn'
        );
        this.searchInput = this.content.querySelector(
            '#kerning-editor-search-input'
        );
    }

    private registerEvents(): void {
        const closeBtn = document.getElementById(
            'kerning-editor-modal-close-btn'
        );
        closeBtn?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });

        this.searchInput?.addEventListener('input', () => {
            this.searchQuery = this.searchInput?.value || '';
            this.renderTable({ preserveScroll: true });
        });

        this.content?.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const directionBtn = target.closest(
                '.kerning-editor-direction-btn'
            );
            if (directionBtn instanceof HTMLElement) {
                const next = directionBtn.dataset.direction;
                if (next === 'ltr' || next === 'rtl') {
                    this.setDirection(next);
                }
                return;
            }

            if (target.closest('#kerning-editor-delete-btn')) {
                this.deleteSelectedRow();
                return;
            }

            const sortHeader = target.closest('th.kerning-editor-sortable');
            if (sortHeader instanceof HTMLElement) {
                const column = sortHeader.dataset.sortColumn;
                if (column === 'first' || column === 'second') {
                    this.toggleSort(column);
                }
                return;
            }

            const row = target.closest('tr[data-first][data-second]');
            if (row instanceof HTMLElement && !target.closest('input')) {
                this.selectedFirst = row.dataset.first || null;
                this.selectedSecond = row.dataset.second || null;
                this.syncRowSelection();
                this.updateDeleteEnabled();
            }
        });
    }

    private setDirection(direction: KerningDirection): void {
        if (this.direction === direction) {
            return;
        }
        this.applyDirection(direction, { clearSelection: true });
        this.renderTable();
        this.updateDeleteEnabled();
    }

    private applyDirection(
        direction: KerningDirection,
        options: { clearSelection: boolean }
    ): void {
        this.direction = direction;
        if (options.clearSelection) {
            this.selectedFirst = null;
            this.selectedSecond = null;
        }
        this.content
            ?.querySelectorAll('.kerning-editor-direction-btn')
            .forEach((button) => {
                button.classList.toggle(
                    'active',
                    button instanceof HTMLElement &&
                        button.dataset.direction === direction
                );
            });
    }

    private toggleSort(column: SortColumn): void {
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = column;
            this.sortDirection = 'asc';
        }
        this.renderTable({ preserveScroll: true });
    }

    private getMasters(): Master[] {
        const font = window.currentFontModel;
        if (!font?.masters) {
            return [];
        }
        return [...font.masters];
    }

    private collectRows(masters: Master[]): KerningPairRow[] {
        const isRTL = this.direction === 'rtl';
        const byPair = new Map<string, KerningPairRow>();

        for (let masterIndex = 0; masterIndex < masters.length; masterIndex++) {
            const master = masters[masterIndex];
            const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
                KerningContainer | undefined;
            forEachKerningPair(kerning, (first, second) => {
                const key = `${first}\u0000${second}`;
                let row = byPair.get(key);
                if (!row) {
                    row = {
                        first,
                        second,
                        values: masters.map(() => null)
                    };
                    byPair.set(key, row);
                }
            });
        }

        for (const row of byPair.values()) {
            for (
                let masterIndex = 0;
                masterIndex < masters.length;
                masterIndex++
            ) {
                const master = masters[masterIndex];
                const kerning = (
                    isRTL ? master.kerning_rtl : master.kerning
                ) as KerningContainer | undefined;
                row.values[masterIndex] = getKerningPairValue(
                    kerning,
                    row.first,
                    row.second
                );
            }
        }

        const rows = [...byPair.values()].filter((row) =>
            this.rowMatchesSearch(row.first, row.second)
        );
        const directionFactor = this.sortDirection === 'asc' ? 1 : -1;
        rows.sort((left, right) => {
            const primary =
                this.sortColumn === 'first'
                    ? compareStrings(left.first, right.first)
                    : compareStrings(left.second, right.second);
            if (primary !== 0) {
                return primary * directionFactor;
            }
            const secondary =
                this.sortColumn === 'first'
                    ? compareStrings(left.second, right.second)
                    : compareStrings(left.first, right.first);
            return secondary * directionFactor;
        });
        return rows;
    }

    private rowMatchesSearch(first: string, second: string): boolean {
        const query = this.searchQuery.trim();
        if (!query) {
            return true;
        }
        const font = window.currentFontModel;
        return (
            this.sideMatchesSearch(first, query, font?.first_kern_groups) ||
            this.sideMatchesSearch(second, query, font?.second_kern_groups)
        );
    }

    private sideMatchesSearch(
        sideKey: string,
        query: string,
        groups: Record<string, string[]> | undefined
    ): boolean {
        if (sideKey.includes(query)) {
            return true;
        }

        if (!sideKey.startsWith('@') || !groups) {
            return false;
        }

        const groupName = sideKey.slice(1);
        if (groupName.includes(query)) {
            return true;
        }

        const members = groups[groupName];
        if (!Array.isArray(members)) {
            return false;
        }

        return members.some((member) => String(member).includes(query));
    }

    private sortIndicator(column: SortColumn): string {
        if (this.sortColumn !== column) {
            return '';
        }
        return this.sortDirection === 'asc' ? ' ▲' : ' ▼';
    }

    private renderTable(
        options: {
            preserveScroll?: boolean;
            scrollSelectedToCenter?: boolean;
        } = {}
    ): void {
        if (!this.tableWrap) {
            return;
        }

        const scrollTop = options.preserveScroll ? this.tableWrap.scrollTop : 0;
        const scrollLeft = options.preserveScroll
            ? this.tableWrap.scrollLeft
            : 0;

        const masters = this.getMasters();
        const rows = this.collectRows(masters);
        let hasSelectedRow =
            this.selectedFirst !== null &&
            this.selectedSecond !== null &&
            rows.some((row) =>
                isSamePair(
                    this.selectedFirst,
                    this.selectedSecond,
                    row.first,
                    row.second
                )
            );

        if (
            options.scrollSelectedToCenter &&
            this.selectedFirst !== null &&
            this.selectedSecond !== null &&
            !hasSelectedRow
        ) {
            // Property-panel pair is not defined in this direction's table.
            this.selectedFirst = null;
            this.selectedSecond = null;
        }

        hasSelectedRow =
            this.selectedFirst !== null &&
            this.selectedSecond !== null &&
            rows.some((row) =>
                isSamePair(
                    this.selectedFirst,
                    this.selectedSecond,
                    row.first,
                    row.second
                )
            );

        this.arrowInputs = [];

        if (masters.length === 0) {
            this.tableWrap.innerHTML =
                '<div class="kerning-editor-empty">No masters in this font.</div>';
            this.updateDeleteEnabled(false);
            return;
        }

        if (rows.length === 0) {
            const emptyMessage = this.searchQuery.trim()
                ? 'No kerning pairs match this search.'
                : `No ${this.direction.toUpperCase()} kerning pairs defined.`;
            this.tableWrap.innerHTML = `<div class="kerning-editor-empty">${emptyMessage}</div>`;
            this.updateDeleteEnabled(false);
            return;
        }

        const masterHeaders = masters
            .map(
                (master) =>
                    `<th class="kerning-editor-value-col" title="${escapeHtml(master.id)}">${escapeHtml(getMasterDisplayLabel(master))}</th>`
            )
            .join('');

        const body = rows
            .map((row) => {
                const selectedClass = isSamePair(
                    this.selectedFirst,
                    this.selectedSecond,
                    row.first,
                    row.second
                )
                    ? ' selected'
                    : '';
                const valueCells = row.values
                    .map((value, masterIndex) => {
                        const display =
                            value === null || value === undefined
                                ? ''
                                : String(value);
                        return `<td class="kerning-editor-value-col"><input type="text" class="kerning-editor-value-input" inputmode="numeric" data-master-index="${masterIndex}" data-first="${escapeHtml(row.first)}" data-second="${escapeHtml(row.second)}" value="${escapeHtml(display)}" spellcheck="false"></td>`;
                    })
                    .join('');
                return `<tr class="${selectedClass.trim()}" data-first="${escapeHtml(row.first)}" data-second="${escapeHtml(row.second)}"><td class="kerning-editor-pair-col">${formatPairSideHtml(row.first)}</td><td class="kerning-editor-pair-col">${formatPairSideHtml(row.second)}</td>${valueCells}</tr>`;
            })
            .join('');

        this.tableWrap.innerHTML = `
            <table class="kerning-editor-table">
                <thead>
                    <tr>
                        <th class="kerning-editor-pair-col kerning-editor-sortable" data-sort-column="first">First${this.sortIndicator('first')}</th>
                        <th class="kerning-editor-pair-col kerning-editor-sortable" data-sort-column="second">Second${this.sortIndicator('second')}</th>
                        ${masterHeaders}
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        `;

        this.bindValueInputs();
        this.updateDeleteEnabled(hasSelectedRow);

        if (options.preserveScroll) {
            this.tableWrap.scrollTop = scrollTop;
            this.tableWrap.scrollLeft = scrollLeft;
        } else if (options.scrollSelectedToCenter && hasSelectedRow) {
            this.scrollSelectedRowToCenter();
        }
    }

    private scrollSelectedRowToCenter(): void {
        const wrap = this.tableWrap;
        if (!wrap) {
            return;
        }
        const row = wrap.querySelector('tr.selected');
        if (!(row instanceof HTMLElement)) {
            return;
        }

        // Jump (no animation): place the row in the vertical middle of the wrap.
        requestAnimationFrame(() => {
            const wrapRect = wrap.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            const delta =
                rowRect.top -
                wrapRect.top -
                (wrap.clientHeight - rowRect.height) / 2;
            wrap.scrollTop += delta;
        });
    }

    private bindValueInputs(): void {
        if (!this.tableWrap) {
            return;
        }

        const inputs = this.tableWrap.querySelectorAll(
            '.kerning-editor-value-input'
        );
        inputs.forEach((element) => {
            if (!(element instanceof HTMLInputElement)) {
                return;
            }

            element.addEventListener('focus', () => {
                this.selectedFirst = element.dataset.first || null;
                this.selectedSecond = element.dataset.second || null;
                this.syncRowSelection();
                this.updateDeleteEnabled();
            });

            element.addEventListener('change', () => {
                if (element.dataset.skipNextCommit === 'true') {
                    delete element.dataset.skipNextCommit;
                    return;
                }
                void this.commitCellValue(element);
            });
            element.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    element.dataset.skipNextCommit = 'true';
                    void this.commitCellValue(element).then(() => {
                        element.blur();
                    });
                }
            });

            const masterIndex = Number(element.dataset.masterIndex);
            const first = element.dataset.first || '';
            const second = element.dataset.second || '';

            this.arrowInputs.push(
                new ArrowAdjustableTextInput({
                    input: element,
                    getValue: () => {
                        const trimmed = element.value.trim();
                        if (
                            trimmed !== '' &&
                            Number.isFinite(Number(trimmed))
                        ) {
                            return Number(trimmed);
                        }
                        const masters = this.getMasters();
                        const master = masters[masterIndex];
                        if (!master) {
                            return 0;
                        }
                        const isRTL = this.direction === 'rtl';
                        const kerning = (
                            isRTL ? master.kerning_rtl : master.kerning
                        ) as KerningContainer | undefined;
                        return getKerningPairValue(kerning, first, second) ?? 0;
                    },
                    applyValue: async (nextValue) => {
                        element.dataset.skipNextCommit = 'true';
                        element.value = String(nextValue);
                        await this.commitCellValue(element, nextValue);
                    },
                    findReplacementInput: () => {
                        const inputs = this.tableWrap?.querySelectorAll(
                            `.kerning-editor-value-input[data-master-index="${masterIndex}"]`
                        );
                        if (!inputs) {
                            return null;
                        }
                        for (const candidate of inputs) {
                            if (
                                candidate instanceof HTMLInputElement &&
                                candidate.dataset.first === first &&
                                candidate.dataset.second === second
                            ) {
                                return candidate;
                            }
                        }
                        return null;
                    }
                })
            );
        });
    }

    private syncRowSelection(): void {
        this.tableWrap
            ?.querySelectorAll('tr[data-first][data-second]')
            .forEach((row) => {
                if (!(row instanceof HTMLElement)) {
                    return;
                }
                row.classList.toggle(
                    'selected',
                    isSamePair(
                        this.selectedFirst,
                        this.selectedSecond,
                        row.dataset.first || '',
                        row.dataset.second || ''
                    )
                );
            });
    }

    private updateDeleteEnabled(forceEnabled?: boolean): void {
        if (!this.deleteButton) {
            return;
        }
        if (typeof forceEnabled === 'boolean') {
            this.deleteButton.disabled = !forceEnabled;
            return;
        }
        this.deleteButton.disabled = !this.hasVisibleSelectedRow();
    }

    private hasVisibleSelectedRow(): boolean {
        if (this.selectedFirst === null || this.selectedSecond === null) {
            return false;
        }
        return !!this.tableWrap?.querySelector(
            'tr.selected[data-first][data-second]'
        );
    }

    private async commitCellValue(
        input: HTMLInputElement,
        forcedValue?: number | null
    ): Promise<void> {
        const masters = this.getMasters();
        const masterIndex = Number(input.dataset.masterIndex);
        const master = masters[masterIndex];
        const first = input.dataset.first || '';
        const second = input.dataset.second || '';
        if (!master || !first || !second) {
            return;
        }

        let nextValue: number | null;
        if (forcedValue !== undefined) {
            nextValue = forcedValue;
        } else {
            const trimmed = input.value.trim();
            if (trimmed === '') {
                nextValue = null;
            } else {
                const parsed = Number(trimmed);
                if (!Number.isFinite(parsed)) {
                    this.renderTable({ preserveScroll: true });
                    return;
                }
                nextValue = parsed;
            }
        }

        const isRTL = this.direction === 'rtl';
        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            KerningContainer | undefined;
        const currentValue = getKerningPairValue(kerning, first, second);
        if (currentValue === nextValue) {
            input.value = nextValue === null ? '' : String(nextValue);
            return;
        }

        window.patchSyncEngine?.beginTransaction('Edit kerning pair', null, {
            compileChangeSource: 'keyboard-kerning-value',
            compileEditType: 'kerning-value'
        });
        try {
            setKerningPairValueOnMaster(
                master,
                first,
                second,
                nextValue,
                isRTL
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.selectedFirst = first;
        this.selectedSecond = second;
        this.renderTable({ preserveScroll: true });
    }

    private deleteSelectedRow(): void {
        if (this.selectedFirst === null || this.selectedSecond === null) {
            return;
        }
        if (!this.hasVisibleSelectedRow()) {
            return;
        }

        const first = this.selectedFirst;
        const second = this.selectedSecond;
        const masters = this.getMasters();
        if (masters.length === 0) {
            return;
        }

        const isRTL = this.direction === 'rtl';
        window.patchSyncEngine?.beginTransaction('Delete kerning pair', null, {
            compileChangeSource: 'keyboard-kerning-value',
            compileEditType: 'kerning-value'
        });
        try {
            for (const master of masters) {
                setKerningPairValueOnMaster(master, first, second, null, isRTL);
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.renderTable({ preserveScroll: true });
    }
}

window.kerningEditorDialog = new KerningEditorDialog();
