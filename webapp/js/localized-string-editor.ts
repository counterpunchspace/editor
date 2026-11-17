import type { Babelfont } from './babelfont';
import {
    DEFAULT_LANGUAGE_SYSTEM_TAG,
    formatLanguageSystemLabel,
    isLanguageSystemOptionTaken,
    LANGUAGE_SYSTEM_OPTIONS
} from './language-system-tags';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

export interface LocalizedStringEditorOptions {
    label: string;
    /** Small technical key under the label, such as `name ID 1`. */
    labelDetail?: string;
    value?: Babelfont.I18NDictionary;
    multiline?: boolean;
    /** Shown in the empty field, e.g. the value written in its place. */
    placeholder?: string;
    /** A lasting note under the field. */
    note?: string;
    onCommit: (nextValue: Babelfont.I18NDictionary) => void;
}

export interface LocalizedStringEditorHandle {
    element: HTMLElement;
    refresh: (nextValue?: Babelfont.I18NDictionary) => void;
    isEditing: () => boolean;
}

export interface LocalizedStringPrimarySelection {
    locale: string;
    value: string;
    isFallback: boolean;
    availableLocaleCount: number;
}

export function normalizeLocalizedStringValue(
    value?: Babelfont.I18NDictionary | null
): Babelfont.I18NDictionary {
    const normalized: Babelfont.I18NDictionary = {};

    if (!value) {
        return normalized;
    }

    Object.entries(value).forEach(([locale, text]) => {
        if (typeof text !== 'string' || text.length === 0) {
            return;
        }
        normalized[locale] = text;
    });

    return normalized;
}

export function areLocalizedStringValuesEqual(
    left?: Babelfont.I18NDictionary | null,
    right?: Babelfont.I18NDictionary | null
): boolean {
    const normalizedLeft = normalizeLocalizedStringValue(left);
    const normalizedRight = normalizeLocalizedStringValue(right);
    const leftKeys = Object.keys(normalizedLeft);
    const rightKeys = Object.keys(normalizedRight);

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every(
        (key) => normalizedLeft[key] === normalizedRight[key]
    );
}

export function getLocalizedStringPrimarySelection(
    value?: Babelfont.I18NDictionary | null
): LocalizedStringPrimarySelection {
    const normalized = normalizeLocalizedStringValue(value);
    const locales = Object.keys(normalized);

    if (normalized[DEFAULT_LANGUAGE_SYSTEM_TAG] !== undefined) {
        return {
            locale: DEFAULT_LANGUAGE_SYSTEM_TAG,
            value: normalized[DEFAULT_LANGUAGE_SYSTEM_TAG],
            isFallback: false,
            availableLocaleCount: locales.length
        };
    }

    if (locales.length > 0) {
        const locale = locales[0];
        return {
            locale,
            value: normalized[locale] ?? '',
            isFallback: true,
            availableLocaleCount: locales.length
        };
    }

    return {
        locale: DEFAULT_LANGUAGE_SYSTEM_TAG,
        value: '',
        isFallback: false,
        availableLocaleCount: 0
    };
}

function cloneLocalizedStringValue(
    value?: Babelfont.I18NDictionary | null
): Babelfont.I18NDictionary {
    return { ...normalizeLocalizedStringValue(value) };
}

export function createLocalizedStringEditor(
    options: LocalizedStringEditorOptions
): LocalizedStringEditorHandle {
    const root = document.createElement('div');
    root.className = 'localized-string-editor';

    const header = document.createElement('div');
    header.className = 'localized-string-editor-header';

    const label = document.createElement('label');
    label.className = 'localized-string-label';
    label.textContent = options.label;
    if (options.labelDetail) {
        const detail = document.createElement('small');
        detail.className = 'fontinfo-field-key';
        detail.textContent = options.labelDetail;
        label.appendChild(detail);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'localized-string-toolbar';

    const localesButton = document.createElement('button');
    localesButton.type = 'button';
    localesButton.className = 'localized-string-locales-button';

    const helper = document.createElement('div');
    helper.className = 'localized-string-helper';

    const input = options.multiline
        ? document.createElement('textarea')
        : document.createElement('input');
    input.className = options.multiline
        ? 'localized-string-input localized-string-textarea'
        : 'localized-string-input';
    if (!(input instanceof HTMLTextAreaElement)) {
        input.type = 'text';
    }
    if (options.placeholder) {
        input.placeholder = options.placeholder;
    }

    header.appendChild(label);
    toolbar.appendChild(localesButton);
    header.appendChild(toolbar);
    root.appendChild(header);
    root.appendChild(input);
    root.appendChild(helper);
    if (options.note) {
        const note = document.createElement('div');
        note.className = 'localized-string-helper localized-string-note';
        note.textContent = options.note;
        root.appendChild(note);
    }

    let currentValue = cloneLocalizedStringValue(options.value);
    let modalEl: HTMLElement | null = null;
    let modalOpen = false;
    let escapeBinding: ModalEscapeBinding | null = null;

    const renderInline = (): void => {
        const selection = getLocalizedStringPrimarySelection(currentValue);
        const selectionLabel = formatLanguageSystemLabel(selection.locale);
        const defaultLabel = formatLanguageSystemLabel(
            DEFAULT_LANGUAGE_SYSTEM_TAG
        );

        input.value = selection.value;
        localesButton.textContent = `Localizations (${selection.availableLocaleCount})`;
        helper.textContent = selection.isFallback
            ? `Editing ${selectionLabel} because ${defaultLabel} is not defined.`
            : `Editing ${selectionLabel}.`;
    };

    const commitInline = (): void => {
        const selection = getLocalizedStringPrimarySelection(currentValue);
        const nextValue = cloneLocalizedStringValue(currentValue);
        if (input.value.length > 0) {
            nextValue[selection.locale] = input.value;
        } else {
            delete nextValue[selection.locale];
        }

        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (!areLocalizedStringValuesEqual(currentValue, normalizedNextValue)) {
            currentValue = normalizedNextValue;
            options.onCommit(normalizedNextValue);
        }

        renderInline();
    };

    const closeModal = (): void => {
        escapeBinding?.release();
        escapeBinding = null;
        modalOpen = false;
        modalEl?.remove();
        modalEl = null;
        renderInline();
    };

    const openModal = (): void => {
        if (modalOpen) {
            return;
        }

        modalOpen = true;
        const modal = document.createElement('div');
        modal.className = 'matplotlib-modal localized-string-modal active';
        modal.innerHTML = `
            <div class="matplotlib-modal-content localized-string-modal-content">
                <div class="matplotlib-modal-header localized-string-modal-header">
                    <h3>${options.label}</h3>
                    <button type="button" class="matplotlib-modal-close localized-string-modal-close" aria-label="Close">×</button>
                </div>
                <div class="matplotlib-modal-body localized-string-modal-body">
                    <div class="localized-string-modal-controls">
                        <select class="localized-string-locale-select"></select>
                        <button type="button" class="dialog-button localized-string-add-locale-btn">Add localization</button>
                    </div>
                    <div class="localized-string-modal-rows"></div>
                    <div class="localized-string-modal-actions">
                        <button type="button" class="dialog-button localized-string-cancel-btn">Cancel</button>
                        <button type="button" class="dialog-button dialog-button-primary localized-string-save-btn">Save</button>
                    </div>
                </div>
            </div>
        `;

        modalEl = modal;
        document.body.appendChild(modal);
        escapeBinding?.release();
        escapeBinding = bindModalEscape(closeModal, {
            isOpen: () => modalOpen
        });

        const localeSelect = modal.querySelector(
            '.localized-string-locale-select'
        ) as HTMLSelectElement;
        const rows = modal.querySelector(
            '.localized-string-modal-rows'
        ) as HTMLElement;
        const closeButton = modal.querySelector(
            '.localized-string-modal-close'
        ) as HTMLButtonElement;
        const cancelButton = modal.querySelector(
            '.localized-string-cancel-btn'
        ) as HTMLButtonElement;
        const saveButton = modal.querySelector(
            '.localized-string-save-btn'
        ) as HTMLButtonElement;
        const addButton = modal.querySelector(
            '.localized-string-add-locale-btn'
        ) as HTMLButtonElement;

        const workingValue = cloneLocalizedStringValue(currentValue);
        const inputMap = new Map<
            string,
            HTMLInputElement | HTMLTextAreaElement
        >();

        const rebuildLocaleSelect = (): void => {
            const availableLocales = LANGUAGE_SYSTEM_OPTIONS.filter(
                (option) =>
                    !isLanguageSystemOptionTaken(
                        option.tag,
                        Object.keys(workingValue)
                    )
            );
            localeSelect.innerHTML = '';

            availableLocales.forEach((languageSystem) => {
                const optionEl = document.createElement('option');
                optionEl.value = languageSystem.tag;
                optionEl.textContent = formatLanguageSystemLabel(
                    languageSystem.tag
                );
                localeSelect.appendChild(optionEl);
            });

            localeSelect.disabled = availableLocales.length === 0;
            addButton.disabled = availableLocales.length === 0;
        };

        const rebuildRows = (): void => {
            rows.innerHTML = '';
            inputMap.clear();

            Object.entries(workingValue).forEach(([locale, text]) => {
                const row = document.createElement('div');
                row.className = 'localized-string-modal-row';

                const localeLabel = document.createElement('div');
                localeLabel.className = 'localized-string-modal-locale';
                localeLabel.textContent = formatLanguageSystemLabel(locale);

                const field = options.multiline
                    ? document.createElement('textarea')
                    : document.createElement('input');
                field.className = options.multiline
                    ? 'localized-string-input localized-string-textarea localized-string-modal-input'
                    : 'localized-string-input localized-string-modal-input';
                if (!(field instanceof HTMLTextAreaElement)) {
                    field.type = 'text';
                }
                field.value = text;

                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className =
                    'dialog-button localized-string-remove-locale-btn';
                removeButton.textContent = 'Remove';
                removeButton.addEventListener('click', () => {
                    delete workingValue[locale];
                    rebuildLocaleSelect();
                    rebuildRows();
                });

                row.appendChild(localeLabel);
                row.appendChild(field);
                row.appendChild(removeButton);
                rows.appendChild(row);
                inputMap.set(locale, field);
            });
        };

        addButton.addEventListener('click', () => {
            if (!localeSelect.value) {
                return;
            }
            workingValue[localeSelect.value] = '';
            rebuildLocaleSelect();
            rebuildRows();
            inputMap.get(localeSelect.value)?.focus();
        });

        closeButton.addEventListener('click', closeModal);
        cancelButton.addEventListener('click', closeModal);
        modal.addEventListener('click', (event: MouseEvent) => {
            if (event.target === modal) {
                closeModal();
            }
        });
        saveButton.addEventListener('click', () => {
            inputMap.forEach((field, locale) => {
                if (field.value.length > 0) {
                    workingValue[locale] = field.value;
                } else {
                    delete workingValue[locale];
                }
            });
            const normalizedNextValue =
                normalizeLocalizedStringValue(workingValue);
            if (
                !areLocalizedStringValuesEqual(
                    currentValue,
                    normalizedNextValue
                )
            ) {
                currentValue = normalizedNextValue;
                options.onCommit(normalizedNextValue);
            }
            closeModal();
        });

        rebuildLocaleSelect();
        rebuildRows();
    };

    localesButton.addEventListener('click', openModal);
    input.addEventListener('keydown', (event: Event) => {
        if (!(input instanceof HTMLInputElement)) {
            return;
        }

        const keyEvent = event as KeyboardEvent;

        if (keyEvent.key !== 'Enter' || keyEvent.isComposing) {
            return;
        }

        keyEvent.preventDefault();
        commitInline();
        input.blur();
    });
    input.addEventListener('blur', commitInline);

    renderInline();

    return {
        element: root,
        refresh(nextValue?: Babelfont.I18NDictionary) {
            if (modalOpen || document.activeElement === input) {
                return;
            }
            currentValue = cloneLocalizedStringValue(nextValue);
            renderInline();
        },
        isEditing() {
            return modalOpen || document.activeElement === input;
        }
    };
}
