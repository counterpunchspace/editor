/**
 * Convert to Counterpunch — opt-in conversions of a font that came from
 * another editor: glyph names, implicit component alignment, and
 * Counterpunch-generated OpenType features.
 */

import type { Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import { attachOutcomePreviewTippy } from './tippy-utils';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import {
    buildTakeoverPreviewHtml,
    escapeHtml,
    takeoverCounts
} from './automatic-features-takeover';
import {
    planGlyphRenamesForFont,
    type GlyphRenamePlan
} from './counterpunch-glyph-renames';
import {
    featureGeneratorEngine,
    type TakeoverPreview
} from './language-packs/feature-generator-engine';

const console = new Logger('ConvertToCounterpunch');

export interface ConvertSummary {
    renamedCount?: number;
    convertedCount?: number;
    compositeCount?: number;
    replacedFeatureCount?: number;
}

export function formatConvertToCounterpunchSummary(
    summary: ConvertSummary
): string {
    const parts: string[] = [];
    if (summary.renamedCount !== undefined) {
        parts.push(
            `Renamed ${summary.renamedCount} ${summary.renamedCount === 1 ? 'glyph' : 'glyphs'}.`
        );
    }
    if (
        summary.convertedCount !== undefined &&
        summary.compositeCount !== undefined
    ) {
        const glyphWord = summary.compositeCount === 1 ? 'glyph' : 'glyphs';
        parts.push(
            `Converted ${summary.convertedCount} of ${summary.compositeCount} composite ${glyphWord} to automatic.`
        );
    }
    if (summary.replacedFeatureCount !== undefined) {
        parts.push(
            `Replaced ${summary.replacedFeatureCount} automatic ${summary.replacedFeatureCount === 1 ? 'feature' : 'features'}.`
        );
    }
    return parts.join(' ') || 'Nothing to convert.';
}

type OptionId = 'rename' | 'components' | 'features';

interface Preflights {
    rename: GlyphRenamePlan | null;
    components: {
        convertibleGlyphNames: string[];
        compositeGlyphCount: number;
    } | null;
    features: TakeoverPreview | null;
}

const COMPONENTS_EXPLANATION =
    'Glyphs.app usually does not store whether components are automatically aligned. A glyph turns automatic only when the composition engine can place every component (by anchors, as an unattached-letter ligature including kerning, or as a single non-mark component) and the result matches the existing positions and layer width on every layer. Components that would move, or layers whose advance would change, stay manual.';

function table(headers: string[], rows: string[][]): string {
    if (!rows.length) {
        return '<div class="delete-glyphs-preview-empty">No items</div>';
    }
    const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const body = rows
        .map(
            (row) =>
                `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
        )
        .join('');
    return `<table class="delete-glyphs-preview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renamePreviewHtml(plan: GlyphRenamePlan): string {
    const renamed = table(
        ['Current', 'Counterpunch'],
        [...plan.renames].map(([from, to]) => [from, to])
    );
    const skipped = plan.skipped.length
        ? `<p class="delete-glyphs-preview-legend">Skipped (${plan.skipped.length})</p>${table(
              ['Glyph', 'Target', 'Reason'],
              plan.skipped.map((s) => [s.name, s.target, s.reason])
          )}`
        : '';
    return `<div class="delete-glyphs-preview">${renamed}${skipped}</div>`;
}

function componentsPreviewHtml(
    result: NonNullable<Preflights['components']>
): string {
    const staying =
        result.compositeGlyphCount - result.convertibleGlyphNames.length;
    return `<div class="delete-glyphs-preview">
        <p class="delete-glyphs-preview-legend">${escapeHtml(COMPONENTS_EXPLANATION)}</p>
        ${table(
            ['Glyphs turning automatic'],
            result.convertibleGlyphNames.map((name) => [name])
        )}
        <p class="delete-glyphs-preview-legend">${staying} composite or already automatic glyph${staying === 1 ? '' : 's'} stay unchanged.</p>
    </div>`;
}

async function computePreflights(): Promise<Preflights> {
    const font = window.currentFontModel;
    const result: Preflights = {
        rename: null,
        components: null,
        features: null
    };
    if (!font) {
        return result;
    }
    result.components = font.preflightManualComponentConversion();
    const [rename, features] = await Promise.all([
        planGlyphRenamesForFont(font).catch((error) => {
            console.warn('Rename preflight failed', error);
            return null;
        }),
        featureGeneratorEngine
            .ensureReady()
            .then(() => featureGeneratorEngine.previewTakeover())
            .catch((error) => {
                console.warn('Feature preflight failed', error);
                return null;
            })
    ]);
    result.rename = rename;
    result.features = features;
    return result;
}

async function runConvertToCounterpunch(
    selected: ReadonlySet<OptionId>
): Promise<void> {
    const fontModel = window.currentFontModel;
    if (!fontModel) {
        return;
    }
    const summary: ConvertSummary = {};
    const renames =
        selected.has('rename') && fontModel
            ? (await planGlyphRenamesForFont(fontModel)).renames
            : null;

    window.patchSyncEngine?.beginTransaction('Convert to Counterpunch', null, {
        compileChangeSource: 'model-edit',
        compileEditType: null
    });
    try {
        // Rename first so components and generators see the final names.
        if (renames) {
            if (renames.size) {
                fontModel.renameGlyphs(renames);
            }
            summary.renamedCount = renames.size;
        }
        if (selected.has('components')) {
            const result =
                fontModel.convertMatchingManualComponentsToAutomatic();
            summary.convertedCount = result.convertedGlyphNames.size;
            summary.compositeCount = result.compositeGlyphCount;
        }
        if (selected.has('features')) {
            await featureGeneratorEngine.ensureReady();
            const preview = featureGeneratorEngine.previewTakeover();
            fontModel.setCounterpunchManagesFeatures(true);
            if (preview && featureGeneratorEngine.applyTakeover()) {
                summary.replacedFeatureCount = preview.removed.length;
            }
        }
        console.log(formatConvertToCounterpunchSummary(summary));
    } finally {
        window.patchSyncEngine?.endTransaction();
    }

    void window.glyphCanvas?.outlineEditor?.fetchLayerData?.(true);
    window.glyphCanvas?.updatePropertyPanel?.();
    window.glyphCanvas?.render?.();

    await window.showSystemNotification('Convert to Counterpunch', {
        body: formatConvertToCounterpunchSummary(summary),
        tag: 'convert-to-counterpunch'
    });
}

const OPTION_ROWS: Array<{
    id: OptionId;
    title: string;
    description: string;
    checked: boolean;
}> = [
    {
        id: 'rename',
        title: 'Rename glyphs',
        description:
            'Give encoded glyphs Counterpunch names and fix legacy names such as fathatan-ar.',
        checked: true
    },
    {
        id: 'components',
        title: 'Automatic components',
        description:
            'Mark components automatic where Counterpunch already places them exactly as they are.',
        checked: true
    },
    {
        id: 'features',
        title: 'Automatic OpenType features and classes',
        description:
            'Remove features and classes marked automatic and replace them with those generated by Counterpunch, which keeps them up to date.',
        checked: true
    }
];

const OPTIONS_STORAGE_KEY = 'convertToCounterpunchOptions';

function loadSavedOptions(): Partial<Record<OptionId, boolean>> {
    try {
        const parsed: unknown = JSON.parse(
            localStorage.getItem(OPTIONS_STORAGE_KEY) || '{}'
        );
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        const saved: Partial<Record<OptionId, boolean>> = {};
        for (const row of OPTION_ROWS) {
            const value = (parsed as Record<string, unknown>)[row.id];
            if (typeof value === 'boolean') {
                saved[row.id] = value;
            }
        }
        return saved;
    } catch {
        return {};
    }
}

function saveOptions(options: Record<OptionId, boolean>): void {
    try {
        localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options));
    } catch {
        // Storage unavailable: the choice just is not remembered.
    }
}

export function openConvertToCounterpunchDialog(): void {
    if (!window.fontManager?.currentFont || !window.currentFontModel) {
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '10002';

    const saved = loadSavedOptions();
    const rowsHtml = OPTION_ROWS.map((row) => ({
        ...row,
        checked: saved[row.id] ?? row.checked
    }))
        .map(
            (row) => `
        <div class="confirm-dialog-option-row" data-row="${row.id}">
            <label class="confirm-dialog-option">
                <input type="checkbox" data-option="${row.id}" ${row.checked ? 'checked' : ''} disabled />
                <span class="confirm-dialog-option-text">
                    <span class="confirm-dialog-option-title">${escapeHtml(row.title)}</span>
                    <span class="confirm-dialog-option-description">${escapeHtml(row.description)}</span>
                    <span class="confirm-dialog-option-count" data-count="${row.id}">Checking…</span>
                </span>
            </label>
            <button type="button" class="confirm-dialog-info-btn material-symbols-outlined" data-preview="${row.id}" aria-label="Preview ${escapeHtml(row.title)}" hidden>info</button>
        </div>`
        )
        .join('');

    overlay.innerHTML = `
        <div class="info-popup confirm-dialog">
            <div class="info-popup-header">
                <h3>Convert to Counterpunch</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                <p>Choose what to convert. Everything happens in one undo step.</p>
                <div class="confirm-dialog-options">${rowsHtml}</div>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                    <button type="button" class="dialog-button dialog-button-primary" data-action="convert" disabled>Convert</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    let escapeBinding: ModalEscapeBinding | null = null;
    const tippies: TippyInstance[] = [];

    const checkbox = (id: OptionId) =>
        overlay.querySelector(
            `[data-option="${id}"]`
        ) as HTMLInputElement | null;
    const convertButton = overlay.querySelector(
        '[data-action="convert"]'
    ) as HTMLButtonElement;

    function selected(): Set<OptionId> {
        return new Set(
            OPTION_ROWS.filter((row) => checkbox(row.id)?.checked).map(
                (row) => row.id
            )
        );
    }

    function rememberChoices() {
        // A disabled row has nothing to convert here; keep its saved choice.
        const choice = (id: OptionId): boolean => {
            const box = checkbox(id);
            if (!box || box.disabled) {
                return (
                    saved[id] ?? OPTION_ROWS.find((r) => r.id === id)!.checked
                );
            }
            return box.checked;
        };
        const next = {
            rename: choice('rename'),
            components: choice('components'),
            features: choice('features')
        };
        Object.assign(saved, next);
        saveOptions(next);
    }

    function refreshConvertEnabled() {
        convertButton.disabled = selected().size === 0;
    }

    function fillRow(
        id: OptionId,
        count: number,
        label: string,
        previewHtml: string
    ) {
        const box = checkbox(id);
        const countEl = overlay.querySelector(`[data-count="${id}"]`);
        const info = overlay.querySelector(
            `[data-preview="${id}"]`
        ) as HTMLElement | null;
        if (!box || !countEl) {
            return;
        }
        countEl.textContent = count === 0 ? 'Nothing to convert' : label;
        if (count === 0) {
            box.checked = false;
            box.disabled = true;
        } else {
            box.disabled = false;
        }
        if (info) {
            info.hidden = false;
            tippies.push(attachOutcomePreviewTippy(info, previewHtml));
        }
    }

    function cleanup() {
        for (const instance of tippies) {
            instance.destroy();
        }
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
    }

    function cancel() {
        cleanup();
    }

    function convert() {
        const chosen = selected();
        cleanup();
        void runConvertToCounterpunch(chosen);
    }

    void computePreflights().then((pre) => {
        if (!overlay.isConnected) {
            return;
        }
        if (pre.rename) {
            fillRow(
                'rename',
                pre.rename.renames.size,
                `${pre.rename.renames.size} to rename`,
                renamePreviewHtml(pre.rename)
            );
        } else {
            fillRow('rename', 0, '', '');
        }
        if (pre.components) {
            const n = pre.components.convertibleGlyphNames.length;
            fillRow(
                'components',
                n,
                `${n} of ${pre.components.compositeGlyphCount} composites`,
                componentsPreviewHtml(pre.components)
            );
        }
        if (pre.features) {
            const counts = takeoverCounts(pre.features);
            fillRow(
                'features',
                counts.removed + counts.generated,
                counts.summary,
                buildTakeoverPreviewHtml(pre.features)
            );
        } else {
            fillRow('features', 0, '', '');
        }
        refreshConvertEnabled();
        convertButton.focus();
    });

    overlay.addEventListener('change', () => {
        rememberChoices();
        refreshConvertEnabled();
    });

    escapeBinding = bindModalEscape(cancel, {
        isOpen: () => overlay.isConnected
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            cancel();
        }
    });

    overlay
        .querySelector('.confirm-dialog-close-btn')
        ?.addEventListener('click', cancel);

    overlay.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = (btn as HTMLElement).dataset.action;
            if (action === 'convert') {
                convert();
                return;
            }
            cancel();
        });
    });
}
