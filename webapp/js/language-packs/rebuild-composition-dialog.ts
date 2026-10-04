import { bindModalEscape } from '../ui/modal-escape';
import { glyphDataIndex } from '../glyph-data';
import { languagePackManager } from './language-pack-manager';
import { applyCompositionPlan } from './composition-applicator';
import {
    planRebuild,
    type CompositionOutput,
    type GlyphRecord
} from './composition-planner';
import { managedInputs } from './managed-features';

export async function openRebuildCompositionDialog(options?: {
    scope?: 'selected' | 'recipes';
    output?: CompositionOutput;
    glyphNames?: string[];
}): Promise<void> {
    const font = window.currentFontModel;
    if (!font) {
        return;
    }
    const output = options?.output || 'materialized';
    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
        <div class="info-popup confirm-dialog rebuild-composition-dialog">
            <div class="info-popup-header">
                <h3>Rebuild Composition</h3>
                <button type="button" class="info-popup-close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                <p>Replace composition for glyphs that have a Latin recipe. Materialized glyphs use components. ccmp glyphs stay empty and are composed by the shaper.</p>
                <div class="rebuild-composition-fields">
                    <label class="rebuild-composition-field">
                        <span>Scope</span>
                        <select class="dialog-input" data-scope>
                            <option value="selected">Selected glyphs</option>
                            <option value="recipes">All glyphs with recipes</option>
                        </select>
                    </label>
                    <label class="rebuild-composition-field">
                        <span>Output</span>
                        <select class="dialog-input" data-output>
                            <option value="materialized">Components in the glyph</option>
                            <option value="ccmp">ccmp shells</option>
                        </select>
                    </label>
                    <label class="confirm-dialog-option">
                        <input type="checkbox" data-clear checked />
                        Clear outlines from ccmp shells
                    </label>
                </div>
                <ul class="confirm-dialog-report rebuild-composition-preview" data-preview></ul>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button" data-cancel>Cancel</button>
                    <button type="button" class="dialog-button dialog-button-primary" data-apply>Rebuild</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const scope = overlay.querySelector('[data-scope]') as HTMLSelectElement;
    const outputSelect = overlay.querySelector(
        '[data-output]'
    ) as HTMLSelectElement;
    const clear = overlay.querySelector('[data-clear]') as HTMLInputElement;
    const preview = overlay.querySelector('[data-preview]') as HTMLElement;
    scope.value = options?.scope || 'selected';
    outputSelect.value = output;
    const escape = bindModalEscape(() => overlay.remove(), {
        isOpen: () => overlay.isConnected
    });
    const close = () => {
        escape.release();
        overlay.remove();
    };
    overlay
        .querySelector('.info-popup-close')
        ?.addEventListener('click', close);
    overlay.querySelector('[data-cancel]')?.addEventListener('click', close);
    const refresh = async () => {
        const records = recordsForScope(
            scope.value === 'recipes' ? 'recipes' : 'selected',
            options?.glyphNames
        );
        const plan = await planRebuild(
            records,
            outputSelect.value === 'ccmp' ? 'ccmp' : 'materialized',
            fontView(),
            provider(),
            managedInputs(
                font.features,
                'space.counterpunch.ccmp',
                'decomposition'
            ),
            clear.checked
        );
        preview.replaceChildren();
        const lines = [
            ...plan.composites.map(
                (item) => `${item.name} from ${item.components.join(' + ')}`
            ),
            ...plan.ccmpAdd.map((name) => `${name} as a ccmp shell`),
            ...plan.create.map((item) => `Add ${item.name}`),
            ...plan.skipped.map((name) => `${name} has no recipe`)
        ];
        const shown = lines.slice(0, 8);
        if (!shown.length) {
            const item = document.createElement('li');
            item.className = 'confirm-dialog-report-item';
            item.textContent = 'Nothing to change.';
            preview.appendChild(item);
        }
        for (const line of shown) {
            const item = document.createElement('li');
            item.className = 'confirm-dialog-report-item';
            item.textContent = line;
            preview.appendChild(item);
        }
        if (lines.length > shown.length) {
            const item = document.createElement('li');
            item.className = 'confirm-dialog-report-item';
            item.textContent = `${lines.length - shown.length} more`;
            preview.appendChild(item);
        }
    };
    scope.addEventListener('change', () => void refresh());
    outputSelect.addEventListener('change', () => void refresh());
    clear.addEventListener('change', () => void refresh());
    overlay
        .querySelector('[data-apply]')
        ?.addEventListener('click', async () => {
            const records = recordsForScope(
                scope.value === 'recipes' ? 'recipes' : 'selected',
                options?.glyphNames
            );
            const plan = await planRebuild(
                records,
                outputSelect.value === 'ccmp' ? 'ccmp' : 'materialized',
                fontView(),
                provider(),
                managedInputs(
                    font.features,
                    'space.counterpunch.ccmp',
                    'decomposition'
                ),
                clear.checked
            );
            applyCompositionPlan(font, plan, 'Rebuild composition');
            close();
        });
    await refresh();
}

function fontView() {
    const font = window.currentFontModel!;
    return {
        glyphNameForCodepoint: (codepoint: number) =>
            font.findGlyphByCodepoint(codepoint)?.name,
        hasGlyph: (name: string) => Boolean(font.findGlyph(name)),
        masters: (font.masters || []).map((master) => ({
            id: master.id,
            metrics: masterMetrics(
                master.metrics as unknown as Record<string, number> | undefined
            )
        }))
    };
}

function provider() {
    return {
        recipe: (codepoint: number) => languagePackManager.recipe(codepoint),
        anchors: (codepoint: number) => languagePackManager.anchors(codepoint),
        anchorPositions: (
            requests: Parameters<typeof languagePackManager.anchorPositions>[0]
        ) => languagePackManager.anchorPositions(requests),
        glyphNameForCodepoint: (codepoint: number) =>
            languagePackManager.glyphNameForCodepoint(codepoint),
        categoryForCodepoint: (codepoint: number) =>
            languagePackManager.categoryForCodepoint(codepoint)
    };
}

function recordsForScope(
    scope: 'selected' | 'recipes',
    glyphNames?: string[]
): GlyphRecord[] {
    const font = window.currentFontModel!;
    const names =
        scope === 'selected'
            ? glyphNames || []
            : font.glyphs.map((glyph) => glyph.name);
    const records: GlyphRecord[] = [];
    for (const name of names) {
        const glyph = font.findGlyph(name);
        const codepoint = glyph?.codepoints?.[0];
        if (!glyph || typeof codepoint !== 'number') {
            continue;
        }
        const data = glyphDataIndex.getGlyphDataForUnicode([codepoint]);
        records.push({
            codepoint,
            glyph_name: data?.glyph_name || glyph.name,
            general_category: data?.general_category || 'Lu'
        });
    }
    return records;
}

function masterMetrics(
    metrics: Record<string, number> | undefined
): Record<string, number> {
    const value = metrics || {};
    return {
        xheight: value.XHeight ?? value.xheight ?? 500,
        capheight: value.CapHeight ?? value.capheight ?? 700,
        ascender: value.Ascender ?? value.ascender ?? 800,
        descender: value.Descender ?? value.descender ?? -200,
        upm: value.upm ?? 1000,
        italic_angle: value.ItalicAngle ?? value.italic_angle ?? 0
    };
}
