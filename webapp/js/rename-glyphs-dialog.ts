import { collectGlyphRenameReferences } from './babelfont-model';
import { Logger } from './logger';
import { getGlyphRenamePreflightErrors } from './rename-glyphs-preflight';
import { planRenameRewires } from './rename-glyphs-rewire';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('RenameGlyphsDialog');

function commonSubstring(names: string[]): string {
    if (names.length === 0) return '';
    const [first, ...rest] = names;
    let best = '';
    for (let start = 0; start < first.length; start++) {
        for (let end = first.length; end > start + best.length; end--) {
            const candidate = first.slice(start, end);
            if (rest.every((name) => name.includes(candidate)))
                return candidate;
        }
    }
    return best;
}

/** Append `text` with each occurrence of `term` wrapped in a colored mark span. */
function appendMarkedText(
    parent: HTMLElement,
    text: string,
    term: string,
    markClass: string
): void {
    if (!term) {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    const parts = text.split(term);
    parts.forEach((part, index) => {
        if (part) parent.appendChild(document.createTextNode(part));
        if (index < parts.length - 1) {
            const mark = document.createElement('span');
            mark.className = markClass;
            mark.textContent = term;
            parent.appendChild(mark);
        }
    });
}

/**
 * Build the after-name display by mirroring search/replace, so only the
 * substituted segments are marked (not incidental occurrences of `replace`).
 */
function appendReplacedMarkedText(
    parent: HTMLElement,
    name: string,
    search: string,
    replace: string
): void {
    if (!search) {
        parent.appendChild(document.createTextNode(name));
        return;
    }
    const parts = name.split(search);
    parts.forEach((part, index) => {
        if (part) parent.appendChild(document.createTextNode(part));
        if (index < parts.length - 1) {
            if (replace) {
                const mark = document.createElement('span');
                mark.className = 'rename-glyphs-replace-mark';
                mark.textContent = replace;
                parent.appendChild(mark);
            }
        }
    });
}

function appendRewiredReference(
    parent: HTMLElement,
    ref: string,
    candidate: string,
    search: string,
    replace: string
): void {
    parent.appendChild(document.createTextNode(ref));
    parent.appendChild(document.createTextNode(' -> '));
    if (
        search &&
        ref.includes(search) &&
        ref.split(search).join(replace) === candidate
    ) {
        appendReplacedMarkedText(parent, ref, search, replace);
        return;
    }
    if (replace && candidate === ref + replace) {
        parent.appendChild(document.createTextNode(ref));
        const mark = document.createElement('span');
        mark.className = 'rename-glyphs-replace-mark';
        mark.textContent = replace;
        parent.appendChild(mark);
        return;
    }
    parent.appendChild(document.createTextNode(candidate));
}

export class RenameGlyphsDialog {
    private readonly modal = document.getElementById('rename-glyphs-modal');
    private readonly content = document.getElementById(
        'rename-glyphs-modal-content'
    );
    private searchInput: HTMLInputElement | null = null;
    private replaceInput: HTMLInputElement | null = null;
    private rewireRow: HTMLLabelElement | null = null;
    private rewireInput: HTMLInputElement | null = null;
    private previewTable: HTMLTableElement | null = null;
    private preview: HTMLTableSectionElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private selectedNames: string[] = [];
    private escapeBinding: ModalEscapeBinding | null = null;

    constructor() {
        this.buildContent();
        this.registerEvents();
    }

    open(): void {
        const glyphOverview = window.glyphOverviewInstance;
        this.selectedNames = glyphOverview?.getSelectedGlyphNames?.() || [];
        if (!this.modal || this.selectedNames.length === 0) return;
        this.searchInput!.value = commonSubstring(this.selectedNames);
        this.replaceInput!.value = '';
        if (this.rewireInput) {
            this.rewireInput.checked = true;
        }
        this.updatePreview();
        this.modal.style.display = 'flex';
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.close(), {
            isOpen: () => this.modal?.style.display === 'flex'
        });
        requestAnimationFrame(() => this.searchInput?.focus());
    }

    private close(): void {
        this.escapeBinding?.release();
        this.escapeBinding = null;
        if (this.modal) this.modal.style.display = 'none';
    }

    private buildContent(): void {
        if (!this.content) return;
        const fields = document.createElement('div');
        fields.className = 'rename-glyphs-fields';
        const addField = (labelText: string): HTMLInputElement => {
            const label = document.createElement('label');
            label.textContent = labelText;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'rename-glyphs-input';
            label.appendChild(input);
            fields.appendChild(label);
            return input;
        };
        this.searchInput = addField('Search');
        this.replaceInput = addField('Replace');
        this.rewireRow = document.createElement('label');
        this.rewireRow.className = 'rename-glyphs-rewire';
        this.rewireRow.hidden = true;
        this.rewireInput = document.createElement('input');
        this.rewireInput.type = 'checkbox';
        this.rewireInput.className = 'rename-glyphs-rewire-input';
        this.rewireInput.checked = true;
        this.rewireRow.append(
            this.rewireInput,
            document.createTextNode(
                'Re-wire components and metrics keys to renamed counterparts'
            )
        );
        const previewWrap = document.createElement('div');
        previewWrap.className = 'rename-glyphs-preview-wrap';
        const table = document.createElement('table');
        table.className = 'rename-glyphs-preview';
        table.innerHTML =
            '<colgroup><col><col></colgroup><thead><tr><th>Before</th><th>After</th></tr></thead>';
        this.previewTable = table;
        this.preview = document.createElement('tbody');
        table.appendChild(this.preview);
        previewWrap.appendChild(table);
        const actions = document.createElement('div');
        actions.className = 'find-glyph-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dialog-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.close());
        this.confirmButton = document.createElement('button');
        this.confirmButton.type = 'button';
        this.confirmButton.className = 'dialog-button dialog-button-primary';
        this.confirmButton.disabled = true;
        this.confirmButton.addEventListener('click', () => this.rename());
        actions.append(cancel, this.confirmButton);
        this.content.replaceChildren(
            fields,
            this.rewireRow,
            previewWrap,
            actions
        );
    }

    private registerEvents(): void {
        document
            .getElementById('rename-glyphs-modal-close-btn')
            ?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) this.close();
        });
        this.searchInput?.addEventListener('input', () => this.updatePreview());
        this.replaceInput?.addEventListener('input', () =>
            this.updatePreview()
        );
        this.rewireInput?.addEventListener('change', () =>
            this.updatePreview()
        );
    }

    private getRenames(): Map<string, string> {
        const search = this.searchInput?.value || '';
        const replace = this.replaceInput?.value || '';
        return new Map(
            this.selectedNames
                .map(
                    (name) =>
                        [
                            name,
                            search ? name.split(search).join(replace) : name
                        ] as const
                )
                .filter(([before, after]) => before !== after)
        );
    }

    /** Preflight conflicts keyed by current glyph name. */
    private getPreflightErrors(
        renames: Map<string, string>
    ): Map<string, string> {
        const existingNames =
            window.currentFontModel?.glyphs.map((glyph) => glyph.name) || [];
        const errors = getGlyphRenamePreflightErrors(renames, existingNames);
        if (!this.searchInput?.value) {
            for (const name of this.selectedNames) {
                errors.set(name, 'Enter text to search for.');
            }
        }
        return errors;
    }

    private canConfirm(
        renames: Map<string, string>,
        errors: Map<string, string>
    ): boolean {
        return renames.size > 0 && errors.size === 0;
    }

    private getReferenceRewires(
        renames: Map<string, string>
    ): Map<string, Map<string, string>> {
        const font = window.currentFontModel;
        const search = this.searchInput?.value || '';
        const replace = this.replaceInput?.value || '';
        if (!font || !search || renames.size === 0) {
            return new Map();
        }
        const postRenameNames = new Set(font.glyphs.map((glyph) => glyph.name));
        for (const [oldName, newName] of renames) {
            postRenameNames.delete(oldName);
            postRenameNames.add(newName);
        }
        const cache = new Map<
            string,
            { references: string[]; components: string[] }
        >();
        const load = (glyphName: string) => {
            let found = cache.get(glyphName);
            if (!found) {
                found = collectGlyphRenameReferences(font, glyphName);
                cache.set(glyphName, found);
            }
            return found;
        };
        return planRenameRewires(search, replace, renames, {
            postRenameNames,
            referencesOf: (glyphName) => load(glyphName).references,
            componentsOf: (glyphName) => load(glyphName).components
        });
    }

    private showReferenceColumn(
        rewires: Map<string, Map<string, string>>,
        errors: Map<string, string>
    ): boolean {
        if (errors.size > 0) {
            return false;
        }
        for (const refs of rewires.values()) {
            if (refs.size > 0) {
                return true;
            }
        }
        return false;
    }

    private updatePreview(): void {
        const renames = this.getRenames();
        const errors = this.getPreflightErrors(renames);
        const rewires = this.getReferenceRewires(renames);
        const showReferences = this.showReferenceColumn(rewires, errors);
        const search = this.searchInput?.value || '';
        const replace = this.replaceInput?.value || '';
        const rewireActive = this.rewireInput?.checked === true;
        if (this.rewireRow) {
            this.rewireRow.hidden = !showReferences;
        }
        if (this.previewTable) {
            this.previewTable.classList.toggle(
                'has-references',
                showReferences
            );
            const colgroup = this.previewTable.querySelector('colgroup');
            if (colgroup) {
                colgroup.replaceChildren(
                    ...Array.from({ length: showReferences ? 3 : 2 }, () =>
                        document.createElement('col')
                    )
                );
            }
            const headRow = this.previewTable.querySelector('thead tr');
            if (headRow) {
                headRow.replaceChildren(
                    ...[
                        'Before',
                        'After',
                        ...(showReferences ? ['References'] : [])
                    ].map((label) => {
                        const cell = document.createElement('th');
                        cell.textContent = label;
                        return cell;
                    })
                );
            }
        }
        this.preview?.replaceChildren(
            ...this.selectedNames.map((name) => {
                const row = document.createElement('tr');
                const before = document.createElement('td');
                appendMarkedText(
                    before,
                    name,
                    search,
                    'rename-glyphs-search-mark'
                );
                const after = document.createElement('td');
                const glyphName = document.createElement('span');
                glyphName.className = 'rename-glyphs-result';
                if (renames.has(name)) {
                    appendReplacedMarkedText(glyphName, name, search, replace);
                } else {
                    glyphName.textContent = name;
                }
                const error = errors.get(name);
                if (error) {
                    glyphName.classList.add('has-error');
                    const comment = document.createElement('small');
                    comment.className = 'rename-glyphs-comment';
                    comment.textContent = error;
                    after.append(glyphName, comment);
                } else {
                    after.appendChild(glyphName);
                }
                row.append(before, after);
                if (showReferences) {
                    const refsCell = document.createElement('td');
                    const glyphRewires = rewires.get(name);
                    if (glyphRewires) {
                        for (const [ref, candidate] of glyphRewires) {
                            const entry = document.createElement('span');
                            entry.className = 'rename-glyphs-rewire-entry';
                            if (!rewireActive) {
                                entry.classList.add('is-inactive');
                            }
                            appendRewiredReference(
                                entry,
                                ref,
                                candidate,
                                search,
                                replace
                            );
                            refsCell.appendChild(entry);
                        }
                    }
                    row.appendChild(refsCell);
                }
                return row;
            })
        );
        if (this.confirmButton) {
            this.confirmButton.disabled = !this.canConfirm(renames, errors);
            this.confirmButton.textContent = `Rename ${renames.size} Glyph${renames.size === 1 ? '' : 's'}`;
        }
    }

    private rename(): void {
        const renames = this.getRenames();
        const errors = this.getPreflightErrors(renames);
        if (!this.canConfirm(renames, errors) || !window.currentFontModel)
            return;
        const rewires = this.getReferenceRewires(renames);
        const applyRewires =
            this.rewireRow?.hidden === false &&
            this.rewireInput?.checked === true &&
            this.showReferenceColumn(rewires, errors);
        try {
            window.currentFontModel.renameGlyphs(
                renames,
                applyRewires ? { referenceRewires: rewires } : undefined
            );
            this.close();
        } catch (error) {
            console.error('Could not rename glyphs', error);
        }
    }
}

window.renameGlyphsDialog = new RenameGlyphsDialog();
