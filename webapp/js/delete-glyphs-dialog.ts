/**
 * Confirm dialog for deleting selected glyphs.
 * Reuses .info-popup / .confirm-dialog styling from unsaved-changes.
 *
 * Cleanups are mandatory; the dialog reports what will be cleaned and shows
 * hover preview panels via info buttons.
 */

import type { Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import { attachOutcomePreviewTippy } from './tippy-utils';
import type { GlyphDeletePreflight } from './delete-glyphs-preflight';
import { bindModalEscape } from './ui/modal-escape';

const console = new Logger('DeleteGlyphsDialog');

const FEA_CORE_KEYWORDS = new Set(
    'feature|lookup|script|language|languagesystem|substitute|sub|position|pos|by|from|ignore|lookupflag|markClass|anchor|anchorDef|valueRecordDef|table|include|include_dflt|anon|anonymous|useExtension|subtable|enumerate|enum|reversesub|rsub|cursive|mark|contourpoint|device|nameid|parameters|NULL|required|exclude_dflt|include_dflt|DFLT|dflt'.split(
        '|'
    )
);

const FEA_LOOKUPFLAG_VALUES = new Set(
    'RightToLeft|IgnoreBaseGlyphs|IgnoreLigatures|IgnoreMarks|MarkAttachmentType|UseMarkFilteringSet'.split(
        '|'
    )
);

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Lightweight FEA highlighter approximating the Ace fea mode token colors.
 * When deletedNames is provided, matching glyph tokens get search-hit styling.
 */
export function highlightFeaSource(
    text: string,
    deletedNames?: ReadonlySet<string>
): string {
    let result = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '#') {
            const end = text.indexOf('\n', index);
            const commentEnd = end < 0 ? text.length : end;
            result += `<span class="fea-comment">${escapeHtml(text.slice(index, commentEnd))}</span>`;
            index = commentEnd;
            continue;
        }
        if (char === '"') {
            let cursor = index + 1;
            while (cursor < text.length && text[cursor] !== '"') {
                if (text[cursor] === '\\') {
                    cursor += 2;
                    continue;
                }
                cursor += 1;
            }
            cursor = Math.min(cursor + 1, text.length);
            result += `<span class="fea-string">${escapeHtml(text.slice(index, cursor))}</span>`;
            index = cursor;
            continue;
        }
        if (
            /[0-9]/.test(char) ||
            (char === '-' && /[0-9]/.test(text[index + 1] || ''))
        ) {
            let cursor = index + 1;
            while (cursor < text.length && /[0-9.]/.test(text[cursor])) {
                cursor += 1;
            }
            result += `<span class="fea-number">${escapeHtml(text.slice(index, cursor))}</span>`;
            index = cursor;
            continue;
        }
        if (char === '@') {
            let cursor = index + 1;
            while (
                cursor < text.length &&
                /[A-Za-z0-9_.-]/.test(text[cursor])
            ) {
                cursor += 1;
            }
            result += `<span class="fea-class">${escapeHtml(text.slice(index, cursor))}</span>`;
            index = cursor;
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            let cursor = index + 1;
            while (
                cursor < text.length &&
                /[A-Za-z0-9_.-]/.test(text[cursor])
            ) {
                cursor += 1;
            }
            const token = text.slice(index, cursor);
            const escaped = escapeHtml(token);
            if (FEA_CORE_KEYWORDS.has(token)) {
                result += `<span class="fea-keyword">${escaped}</span>`;
            } else if (FEA_LOOKUPFLAG_VALUES.has(token)) {
                result += `<span class="fea-support">${escaped}</span>`;
            } else if (deletedNames?.has(token)) {
                result += `<span class="fea-ident fea-glyph-hit">${escaped}</span>`;
            } else {
                result += `<span class="fea-ident">${escaped}</span>`;
            }
            index = cursor;
            continue;
        }
        result += escapeHtml(char);
        index += 1;
    }
    return result;
}

function featureHitTitle(kind: string, name: string): string {
    if (kind === 'class') {
        return `@${name}`;
    }
    if (kind === 'prefix') {
        return `prefix ${name}`;
    }
    return name;
}

function buildFeaturesPreviewHtml(
    preflight: GlyphDeletePreflight,
    deletedNames: ReadonlySet<string>
): string {
    if (preflight.featureHits.length === 0) {
        return '<div class="delete-glyphs-preview-empty">No feature references</div>';
    }
    const legend = `<p class="delete-glyphs-preview-legend">
        Glyph names are removed from classes. Matching feature and prefix lines are commented out.
    </p>`;
    const blocks = preflight.featureHits
        .map((hit) => {
            const linesHtml = hit.lines
                .map(
                    (line) => `<div class="delete-glyphs-fea-line">
                        <span class="delete-glyphs-fea-line-number">${line.lineNumber}</span>
                        <code class="delete-glyphs-fea-code">${highlightFeaSource(line.text, deletedNames)}</code>
                    </div>`
                )
                .join('');
            return `<section class="delete-glyphs-fea-block">
                <header class="delete-glyphs-preview-heading">${escapeHtml(featureHitTitle(hit.kind, hit.name))}</header>
                <div class="delete-glyphs-fea-lines">${linesHtml}</div>
            </section>`;
        })
        .join('');
    return legend + blocks;
}

function buildMetricsTableHtml(
    rows: Array<{
        glyphName: string;
        leftKey?: string | null;
        rightKey?: string | null;
    }>
): string {
    if (rows.length === 0) {
        return '<div class="delete-glyphs-preview-empty">No items</div>';
    }
    const body = rows
        .map(
            (row) => `<tr>
                <td>${escapeHtml(row.glyphName)}</td>
                <td>${row.leftKey ? `<code>${escapeHtml(row.leftKey)}</code>` : ''}</td>
                <td>${row.rightKey ? `<code>${escapeHtml(row.rightKey)}</code>` : ''}</td>
            </tr>`
        )
        .join('');
    return `<table class="delete-glyphs-preview-table">
        <thead>
            <tr>
                <th>Glyph</th>
                <th>Left</th>
                <th>Right</th>
            </tr>
        </thead>
        <tbody>${body}</tbody>
    </table>`;
}

function buildComponentsTableHtml(glyphNames: string[]): string {
    if (glyphNames.length === 0) {
        return '<div class="delete-glyphs-preview-empty">No items</div>';
    }
    const body = glyphNames
        .map((glyphName) => `<tr><td>${escapeHtml(glyphName)}</td></tr>`)
        .join('');
    return `<table class="delete-glyphs-preview-table">
        <thead>
            <tr>
                <th>Glyph</th>
            </tr>
        </thead>
        <tbody>${body}</tbody>
    </table>`;
}

function buildKernPairTableHtml(
    heading: string,
    masters: Array<{ id: string; label: string }>,
    pairs: Array<{
        left: string;
        right: string;
        values: Array<number | null>;
        willRemove: boolean;
    }>
): string {
    if (pairs.length === 0) {
        return `<section class="delete-glyphs-kern-block">
            <header class="delete-glyphs-preview-heading">${escapeHtml(heading)}</header>
            <div class="delete-glyphs-preview-empty">No pairs</div>
        </section>`;
    }
    const masterHeaders = masters
        .map((master) => `<th>${escapeHtml(master.label || master.id)}</th>`)
        .join('');
    const body = pairs
        .map((pair) => {
            const rowClass = pair.willRemove
                ? ' class="delete-glyphs-kern-row-remove"'
                : ' class="delete-glyphs-kern-row-keep"';
            const valueCells = pair.values
                .map((value) => {
                    if (value === null || value === undefined) {
                        return '<td></td>';
                    }
                    return `<td class="delete-glyphs-kern-value">${value}</td>`;
                })
                .join('');
            return `<tr${rowClass}>
                <td>${escapeHtml(pair.left)}</td>
                <td>${escapeHtml(pair.right)}</td>
                ${valueCells}
            </tr>`;
        })
        .join('');
    return `<section class="delete-glyphs-kern-block">
        <header class="delete-glyphs-preview-heading">${escapeHtml(heading)}</header>
        <table class="delete-glyphs-preview-table">
            <thead>
                <tr>
                    <th>Left</th>
                    <th>Right</th>
                    ${masterHeaders}
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    </section>`;
}

function buildKerningPreviewHtml(preflight: GlyphDeletePreflight): string {
    if (
        preflight.kerningLtrHits.length === 0 &&
        preflight.kerningRtlHits.length === 0
    ) {
        return '<div class="delete-glyphs-preview-empty">No kerning pairs</div>';
    }
    const masters = preflight.kerningMasters || [];
    const legend = `<p class="delete-glyphs-preview-legend">
        <span class="delete-glyphs-kern-legend-remove">Bold red</span> pairs are removed.
        Normal pairs keep their class kerning; only the deleted glyph leaves the class.
    </p>`;
    return (
        legend +
        buildKernPairTableHtml('LTR', masters, preflight.kerningLtrHits) +
        buildKernPairTableHtml('RTL', masters, preflight.kerningRtlHits)
    );
}

export class DeleteGlyphsDialog {
    open(names?: string[]): void {
        const rawNames: unknown[] = Array.isArray(names)
            ? names
            : window.glyphOverviewInstance?.getSelectedGlyphNames?.() || [];
        const selectedNames = rawNames.filter(
            (name): name is string =>
                typeof name === 'string' && name.length > 0
        );
        const font = window.currentFontModel;
        if (!font || selectedNames.length === 0) {
            return;
        }

        const uniqueNames = [...new Set(selectedNames)];
        const preflight = font.preflightDeleteGlyphs(uniqueNames);
        void this.showConfirm(uniqueNames, preflight).then((confirmed) => {
            if (!confirmed) {
                return;
            }
            try {
                font.deleteGlyphs(uniqueNames);
            } catch (error) {
                console.error('Failed to delete glyphs', error);
            }
        });
    }

    private showConfirm(
        names: string[],
        preflight: GlyphDeletePreflight
    ): Promise<boolean> {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'info-popup-overlay';
            overlay.style.display = 'flex';
            overlay.style.zIndex = '10002';

            const title =
                names.length === 1
                    ? `Delete glyph “${names[0]}”?`
                    : `Delete ${names.length} glyphs?`;

            const kerningRelatedCount =
                preflight.kerningLtrHits.length +
                preflight.kerningRtlHits.length;
            const categories = (
                [
                    {
                        id: 'features' as const,
                        label: 'Features & classes',
                        count: preflight.featureReferences,
                        visible: preflight.featureReferences > 0
                    },
                    {
                        id: 'metrics' as const,
                        label: 'Metrics keys',
                        count: preflight.metricsKeyReferences,
                        visible: preflight.metricsKeyReferences > 0
                    },
                    {
                        id: 'components' as const,
                        label: 'Components',
                        count: preflight.componentReferences,
                        visible: preflight.componentReferences > 0
                    },
                    {
                        id: 'kerning' as const,
                        label: 'Kerning pairs',
                        count: preflight.kerningPairReferences,
                        visible: kerningRelatedCount > 0
                    }
                ] as const
            ).filter((category) => category.visible);

            const reportHtml =
                categories.length === 0
                    ? ''
                    : `<div class="confirm-dialog-options">
                        <p>Will also clean:</p>
                        <ul class="confirm-dialog-report">
                            ${categories
                                .map((category) => {
                                    const label =
                                        category.id === 'kerning' &&
                                        category.count === 0
                                            ? category.label
                                            : `${category.label} (${category.count})`;
                                    return `<li class="confirm-dialog-report-item">
                                            <span>${escapeHtml(label)}</span>
                                            <button type="button" class="confirm-dialog-info-btn material-symbols-outlined" data-preview="${category.id}" aria-label="Preview ${escapeHtml(category.label)}">info</button>
                                        </li>`;
                                })
                                .join('')}
                        </ul>
                    </div>`;

            overlay.innerHTML = `
                <div class="info-popup confirm-dialog">
                    <div class="info-popup-header">
                        <h3>Delete Glyph(s)</h3>
                        <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="info-popup-content confirm-dialog-content">
                        <p>${escapeHtml(title)} This can be undone.</p>
                        ${reportHtml}
                        <div class="confirm-dialog-actions">
                            <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                            <button type="button" class="dialog-button dialog-button-danger" data-action="delete">Delete</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const deletedNameSet = new Set(names);
            const previewTippyInstances: TippyInstance[] = [];
            overlay
                .querySelectorAll<HTMLButtonElement>('[data-preview]')
                .forEach((button) => {
                    const previewId = button.dataset.preview;
                    let content = '';
                    if (previewId === 'features') {
                        content = `<div class="delete-glyphs-preview delete-glyphs-fea-preview">${buildFeaturesPreviewHtml(preflight, deletedNameSet)}</div>`;
                    } else if (previewId === 'metrics') {
                        content = `<div class="delete-glyphs-preview">${buildMetricsTableHtml(preflight.metricsHits)}</div>`;
                    } else if (previewId === 'components') {
                        content = `<div class="delete-glyphs-preview">${buildComponentsTableHtml(preflight.componentGlyphNames)}</div>`;
                    } else if (previewId === 'kerning') {
                        content = `<div class="delete-glyphs-preview">${buildKerningPreviewHtml(preflight)}</div>`;
                    }
                    previewTippyInstances.push(
                        attachOutcomePreviewTippy(button, content)
                    );
                });

            let escapeBinding: ReturnType<typeof bindModalEscape> | null = null;

            const cleanup = () => {
                for (const instance of previewTippyInstances) {
                    instance.destroy();
                }
                escapeBinding?.release();
                escapeBinding = null;
                overlay.remove();
            };

            const finish = (confirmed: boolean) => {
                cleanup();
                resolve(confirmed);
            };

            escapeBinding = bindModalEscape(() => finish(false), {
                isOpen: () => overlay.isConnected
            });

            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    finish(false);
                }
            });
            overlay
                .querySelector('.confirm-dialog-close-btn')
                ?.addEventListener('click', () => finish(false));
            overlay
                .querySelector('[data-action="cancel"]')
                ?.addEventListener('click', () => finish(false));
            overlay
                .querySelector('[data-action="delete"]')
                ?.addEventListener('click', () => finish(true));

            queueMicrotask(() => {
                (
                    overlay.querySelector(
                        '[data-action="delete"]'
                    ) as HTMLElement | null
                )?.focus();
            });
        });
    }
}

export function canDeleteSelectedGlyphs(): boolean {
    return (
        !!window.fontManager?.currentFont &&
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
            0
    );
}

window.deleteGlyphsDialog = new DeleteGlyphsDialog();
