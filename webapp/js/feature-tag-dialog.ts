/**
 * Feature tag dialog for adding or renaming a feature: a text field with
 * suggestions from the OpenType registry and a live check of the tag.
 */

import {
    REGISTERED_FEATURE_TAGS,
    getFeatureName,
    validateFeatureTag
} from './opentype-features';
import { mountModalOverlay } from './ui/confirm-dialog';

export type FeatureTagDialogOptions = {
    title: string;
    /** Button label, such as “Add” or “Rename”. */
    confirmLabel: string;
    initialTag?: string;
};

const COMMON_TAGS = [
    'liga',
    'calt',
    'kern',
    'mark',
    'mkmk',
    'ccmp',
    'locl',
    'smcp',
    'c2sc',
    'case',
    'frac',
    'sups',
    'subs',
    'ordn',
    'onum',
    'lnum',
    'pnum',
    'tnum',
    'dlig',
    'salt',
    'swsh',
    'zero'
];

type SuggestionGroup = { title: string; tags: string[] };

function suggestionGroups(): SuggestionGroup[] {
    const all = [...REGISTERED_FEATURE_TAGS];
    const common = new Set(COMMON_TAGS);
    return [
        { title: 'Common', tags: COMMON_TAGS },
        {
            title: 'Stylistic sets',
            tags: all.filter((t) => /^ss\d\d$/.test(t))
        },
        {
            title: 'Character variants',
            tags: all.filter((t) => /^cv\d\d$/.test(t))
        },
        {
            title: 'All registered',
            tags: all
                .filter((t) => !common.has(t) && !/^(ss|cv)\d\d$/.test(t))
                .sort()
        }
    ];
}

const esc = (value: string): string =>
    value.replace(
        /[&<>"]/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c
    );

function matches(tag: string, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
        tag.toLowerCase().startsWith(q) ||
        getFeatureName(tag).toLowerCase().includes(q)
    );
}

/** Resolves with the tag to use, or null when the user cancels. */
export function showFeatureTagDialog(
    options: FeatureTagDialogOptions
): Promise<string | null> {
    return new Promise((resolve) => {
        const { overlay, close } = mountModalOverlay({
            zIndex: '10002',
            closeSelector: '[data-role="close"]',
            onDismiss: () => resolve(null),
            innerHTML: `
            <div class="info-popup feature-tag-dialog" role="dialog" aria-modal="true" aria-labelledby="feature-tag-dialog-title">
                <div class="info-popup-header">
                    <h3 id="feature-tag-dialog-title">${esc(options.title)}</h3>
                    <button type="button" class="info-popup-close" data-role="close" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content feature-tag-dialog-content">
                    <label class="feature-tag-label" for="feature-tag-input">Feature tag</label>
                    <input type="text" id="feature-tag-input" class="feature-tag-input" autocomplete="off" spellcheck="false" role="combobox" aria-controls="feature-tag-suggestions" aria-expanded="true" />
                    <div class="feature-tag-status" data-role="status" aria-live="polite"></div>
                    <div class="feature-tag-suggestions" id="feature-tag-suggestions" role="listbox"></div>
                    <div class="confirm-dialog-actions">
                        <button type="button" class="dialog-button" data-role="cancel">Cancel</button>
                        <button type="button" class="dialog-button dialog-button-primary" data-role="confirm"></button>
                    </div>
                </div>
            </div>`
        });

        const input = overlay.querySelector(
            '#feature-tag-input'
        ) as HTMLInputElement;
        const status = overlay.querySelector(
            '[data-role="status"]'
        ) as HTMLElement;
        const list = overlay.querySelector(
            '.feature-tag-suggestions'
        ) as HTMLElement;
        const confirm = overlay.querySelector(
            '[data-role="confirm"]'
        ) as HTMLButtonElement;
        const groups = suggestionGroups();
        let activeIndex = -1;

        const options_ = (): HTMLElement[] =>
            Array.from(list.querySelectorAll('.feature-tag-option'));

        const renderSuggestions = () => {
            const query = input.value.trim();
            const html = groups
                .map((group) => {
                    const tags = group.tags.filter((tag) =>
                        matches(tag, query)
                    );
                    if (!tags.length) return '';
                    const rows = tags
                        .map(
                            (tag) =>
                                `<div class="feature-tag-option" role="option" data-tag="${esc(tag)}"><code>${esc(tag)}</code><span>${esc(getFeatureName(tag))}</span></div>`
                        )
                        .join('');
                    return `<div class="feature-tag-group">${esc(group.title)}</div>${rows}`;
                })
                .join('');
            list.innerHTML = html;
            list.hidden = !html;
            activeIndex = -1;
        };

        const setActive = (index: number) => {
            const rows = options_();
            if (!rows.length) return;
            activeIndex = Math.max(0, Math.min(index, rows.length - 1));
            rows.forEach((row, i) =>
                row.classList.toggle('active', i === activeIndex)
            );
            rows[activeIndex].scrollIntoView({ block: 'nearest' });
        };

        const updateStatus = () => {
            if (!input.value) {
                status.dataset.level = '';
                status.textContent = '';
                confirm.disabled = true;
                confirm.textContent = options.confirmLabel;
                return;
            }
            const check = validateFeatureTag(input.value);
            status.dataset.level = check.level;
            status.textContent = check.message;
            if (check.suggestion) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'feature-tag-suggestion';
                button.dataset.tag = check.suggestion;
                const name = getFeatureName(check.suggestion);
                button.innerHTML = `Did you mean <code>${esc(check.suggestion)}</code>${name ? ` (${esc(name)})` : ''}?`;
                status.append(' ', button);
            }
            confirm.disabled = check.level === 'error';
            confirm.textContent =
                check.level === 'warning'
                    ? `${options.confirmLabel} anyway`
                    : options.confirmLabel;
        };

        const fill = (tag: string) => {
            input.value = tag;
            renderSuggestions();
            updateStatus();
            input.focus();
        };

        const finish = (tag: string | null) => {
            close();
            resolve(tag);
        };
        const submit = () => {
            if (validateFeatureTag(input.value).level !== 'error') {
                finish(input.value);
            }
        };

        overlay.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const suggestion = target.closest(
                '.feature-tag-option, .feature-tag-suggestion'
            ) as HTMLElement | null;
            if (suggestion?.dataset.tag) {
                fill(suggestion.dataset.tag);
                return;
            }
            const role = target
                .closest('[data-role]')
                ?.getAttribute('data-role');
            if (role === 'cancel') finish(null);
            if (role === 'confirm') submit();
        });
        input.addEventListener('input', () => {
            renderSuggestions();
            updateStatus();
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive(activeIndex + 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(activeIndex - 1);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                const active = options_()[activeIndex];
                if (active?.dataset.tag) {
                    fill(active.dataset.tag);
                } else {
                    submit();
                }
            }
        });

        input.value = options.initialTag ?? '';
        renderSuggestions();
        updateStatus();
        input.focus();
        input.select();
    });
}
