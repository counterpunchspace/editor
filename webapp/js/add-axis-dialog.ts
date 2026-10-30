/**
 * Add axis dialog: three steps (axis, new masters, details) with a ladder
 * preview and summary that stay visible. Resolves with what to commit; the
 * caller writes it.
 */

import {
    AddAxisModel,
    CUSTOM_AXIS_KEY,
    axisMenuEntries,
    clipText,
    listNames,
    listShort,
    namesOrCount,
    type AxisDialogFont,
    type DefaultChoice,
    type Direction,
    type Notes,
    type Side
} from './add-axis-plan';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

export type AddAxisDialogResult =
    | { kind: 'cancel' }
    | { kind: 'axis-only'; model: AddAxisModel }
    | { kind: 'with-masters'; model: AddAxisModel };

export type AddAxisDialogOptions = {
    font: AxisDialogFont;
    /** Shown on step 2 when masters can't be added right now (e.g. a partly downloaded cloud font). */
    blockedNotice?: HTMLElement | null;
};

type Page = 1 | 2 | 3;

const esc = (value: unknown): string =>
    String(value).replace(
        /[&<>"]/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c
    );
const fmt = (value: number): string =>
    Number.isFinite(value) ? String(value) : '–';
const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

const DIALOG_HTML = `
<div class="info-popup add-axis-dialog" role="dialog" aria-modal="true" aria-labelledby="add-axis-title">
    <div class="info-popup-header">
        <h3 id="add-axis-title">Add axis</h3>
        <button type="button" class="info-popup-close" data-role="close" aria-label="Cancel">
            <span class="material-symbols-outlined">close</span>
        </button>
    </div>
    <div class="add-axis-main">
        <div class="add-axis-left">
            <div class="add-axis-tabs" role="tablist" aria-label="Steps">
                <button type="button" role="tab" data-page="1"><span class="add-axis-tab-n">1</span>Axis<i class="add-axis-tab-err" hidden></i></button>
                <span class="add-axis-tabs-optional" aria-hidden="true">Optional</span>
                <button type="button" role="tab" data-page="2" aria-description="Optional"><span class="add-axis-tab-n">2</span>New masters<i class="add-axis-tab-err" hidden></i></button>
                <button type="button" role="tab" data-page="3" aria-description="Optional"><span class="add-axis-tab-n">3</span>Details<i class="add-axis-tab-err" hidden></i></button>
            </div>
            <div class="add-axis-pages">
                <section class="add-axis-page add-axis-page-1" data-page="1" role="tabpanel">
                    <div class="add-axis-cols">
                        <div class="add-axis-field">
                            <label for="add-axis-type">Axis type</label>
                            <select id="add-axis-type" class="dialog-input" data-role="axis-type"></select>
                            <span class="add-axis-note">Ranges, defaults and style names from the Google Fonts axis registry.</span>
                        </div>
                        <div class="add-axis-name-tag">
                            <div class="add-axis-field"><label for="add-axis-name">Name</label><input type="text" id="add-axis-name" class="dialog-input add-axis-w-name" data-role="name"></div>
                            <div class="add-axis-field"><label for="add-axis-tag">Tag</label><input type="text" id="add-axis-tag" class="dialog-input add-axis-w-tag" maxlength="4" data-role="tag"></div>
                        </div>
                    </div>
                    <div class="add-axis-notes" data-notes="1"></div>
                    <div class="add-axis-explain" data-role="explain"></div>
                </section>
                <section class="add-axis-page" data-page="2" role="tabpanel">
                    <div data-role="blocked"></div>
                    <div class="add-axis-cols">
                        <div class="add-axis-col add-axis-col-hint">
                            <div class="add-axis-subtitle">Direction</div>
                            <div class="add-axis-seg" role="group" aria-label="Where new masters go" data-role="direction">
                                <button type="button" data-dir="below"></button>
                                <button type="button" data-dir="both">Both</button>
                                <button type="button" data-dir="above"></button>
                            </div>
                            <p class="add-axis-hint" data-role="direction-hint"></p>
                        </div>
                        <div class="add-axis-col">
                            <div class="add-axis-subtitle">Positions on the axis</div>
                            <div class="add-axis-field-row">
                                <div class="add-axis-field" data-role="field-min">
                                    <label for="add-axis-pos-min" data-role="label-min">New masters at</label>
                                    <div class="add-axis-pos"><input type="number" step="any" id="add-axis-pos-min" class="dialog-input add-axis-num" data-role="pos-min"><span class="add-axis-stylename" data-role="name-min"></span></div>
                                </div>
                                <div class="add-axis-field">
                                    <label for="add-axis-pos-existing">Your masters stay at</label>
                                    <div class="add-axis-pos"><input type="number" step="any" id="add-axis-pos-existing" class="dialog-input add-axis-num" data-role="pos-existing"><span class="add-axis-stylename" data-role="name-existing"></span></div>
                                </div>
                                <div class="add-axis-field" data-role="field-max">
                                    <label for="add-axis-pos-max" data-role="label-max">New masters at</label>
                                    <div class="add-axis-pos"><input type="number" step="any" id="add-axis-pos-max" class="dialog-input add-axis-num" data-role="pos-max"><span class="add-axis-stylename" data-role="name-max"></span></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="add-axis-table-scroll"><table class="add-axis-table" data-role="grid"></table></div>
                    <div class="add-axis-notes" data-notes="2"></div>
                </section>
                <section class="add-axis-page" data-page="3" role="tabpanel">
                    <div class="add-axis-block">
                        <div class="add-axis-subtitle">Default master</div>
                        <div class="add-axis-cols add-axis-default-row">
                            <div class="add-axis-seg" role="group" aria-label="Default master" data-role="default"></div>
                            <p class="add-axis-hint" data-role="default-hint"></p>
                        </div>
                    </div>
                    <div class="add-axis-cols">
                        <div class="add-axis-block add-axis-grow">
                            <div class="add-axis-subtitle">What to copy from each original</div>
                            <label class="add-axis-opt"><input type="checkbox" data-role="opt-kerning"><span>Kerning and guides<small>Without this, the copies start with empty kerning. Metrics are always copied.</small></span></label>
                            <label class="add-axis-opt"><input type="checkbox" data-role="opt-brace"><span>Intermediate layers <span class="add-axis-count" data-role="brace-count"></span><small>Also called brace layers. Copying them keeps their corrections working on the new side.</small></span></label>
                            <label class="add-axis-opt"><input type="checkbox" data-role="opt-instances"><span>Instances<small>Adds a copy of each instance at the new side’s position.</small></span></label>
                        </div>
                        <div class="add-axis-block add-axis-grow">
                            <div class="add-axis-subtitle">What apps show</div>
                            <label class="add-axis-opt"><input type="checkbox" data-role="opt-separate"><span>Set userspace values separately<small>Positions are designspace values: where you draw. Userspace values are what apps show, such as Width 100 and 125. Normally they are the same.</small></span></label>
                            <div class="add-axis-table-scroll"><table class="add-axis-map" data-role="map"></table></div>
                        </div>
                    </div>
                    <div class="add-axis-notes" data-notes="3"></div>
                </section>
            </div>
        </div>
        <aside class="add-axis-side" aria-label="Preview">
            <div class="add-axis-plot">
                <div class="add-axis-plot-scroll"><svg data-role="plot" viewBox="0 0 300 120" role="img" aria-label="Preview: each of your masters and its new copies"></svg></div>
                <div class="add-axis-legend"><span><i class="add-axis-dot add-axis-dot-exist"></i>Your masters</span><span><i class="add-axis-dot add-axis-dot-new"></i>New</span><span><i class="add-axis-dot add-axis-dot-off"></i>Not added</span><span><i class="add-axis-dot add-axis-dot-def"></i>Default master</span></div>
            </div>
            <div class="add-axis-summary" data-role="summary" aria-live="polite"></div>
        </aside>
    </div>
    <div class="add-axis-foot">
        <div class="add-axis-foot-group">
            <button type="button" class="dialog-button" data-role="back"><span aria-hidden="true">←</span> Back</button>
            <button type="button" class="dialog-button" data-role="next">Next <span aria-hidden="true">→</span></button>
        </div>
        <div class="add-axis-foot-group add-axis-foot-end">
            <span class="add-axis-foot-why" data-role="why"></span>
            <button type="button" class="dialog-button" data-role="cancel">Cancel</button>
            <button type="button" class="dialog-button" data-role="axis-only">Add axis without masters</button>
            <button type="button" class="dialog-button dialog-button-primary" data-role="commit"></button>
        </div>
    </div>
</div>`;

export function openAddAxisDialog(
    options: AddAxisDialogOptions
): Promise<AddAxisDialogResult> {
    const model = new AddAxisModel(options.font);
    const font = options.font;
    const hasMasters = font.masters.length > 0;
    const mastersBlocked = !!options.blockedNotice || !hasMasters;
    if (mastersBlocked) {
        model.setColumnOn('min', false);
        model.setColumnOn('max', false);
    }

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay add-axis-overlay';
        overlay.innerHTML = DIALOG_HTML;
        const root = overlay.querySelector('.add-axis-dialog') as HTMLElement;
        const $ = <T extends Element = HTMLElement>(role: string): T =>
            root.querySelector(`[data-role="${role}"]`) as T;
        const input = (role: string) => $<HTMLInputElement>(role);

        let page: Page = 1;
        // Errors appear once a field is left, not on every keystroke.
        let shown: Notes = model.validate();
        let gridKey = '';
        let mapKey = '';
        let escapeBinding: ModalEscapeBinding | null = null;

        if (options.blockedNotice) {
            $('blocked').appendChild(options.blockedNotice);
        } else if (!hasMasters) {
            $('blocked').innerHTML =
                '<p class="add-axis-hint">This font has no masters yet, so there is nothing to copy. The axis is added on its own.</p>';
        }
        $('brace-count').textContent = font.braceGlyphCount
            ? `(${plural(font.braceGlyphCount, 'glyph has', 'glyphs have')} them)`
            : '(none in this font)';
        input('opt-brace').disabled = !font.braceGlyphCount;

        const buildAxisMenu = () => {
            const { opentype, others } = axisMenuEntries();
            const option = (axis: { tag: string; name: string }) => {
                const inFont = model.isTagInFont(axis.tag);
                return `<option value="${esc(axis.tag)}"${inFont ? ' disabled' : ''}>${esc(axis.name)} (${esc(axis.tag)})${inFont ? ' · already in font' : ''}</option>`;
            };
            $<HTMLSelectElement>('axis-type').innerHTML =
                `<option value="${CUSTOM_AXIS_KEY}">Custom axis</option><hr>` +
                `<optgroup label="Registered OpenType axes">${opentype.map(option).join('')}</optgroup>` +
                `<optgroup label="Google Fonts axis registry">${others.map(option).join('')}</optgroup>`;
        };

        const setVal = (
            el: HTMLInputElement | null,
            value: number | string
        ) => {
            if (!el || el === document.activeElement) {
                return;
            }
            const text =
                typeof value === 'number' && !Number.isFinite(value)
                    ? ''
                    : String(value);
            if (el.value !== text) {
                el.value = text;
            }
        };

        // ---------- step 1 ----------
        const renderAxisStep = () => {
            setVal(input('name'), model.name);
            setVal(input('tag'), model.tag);
            $<HTMLSelectElement>('axis-type').value = model.key;
            const word = model
                .directionWords()
                [model.direction === 'below' ? 0 : 1].toLowerCase();
            const names = model.sortedMasters().map((m) => m.name);
            const axisCount = font.axes.length;
            const masterCount = font.masters.length;
            const newCount = mastersBlocked ? 0 : model.newMasters().length;
            let intro: string;
            if (!hasMasters) {
                intro =
                    'Your font has no masters yet, so the axis is added on its own.';
            } else if (axisCount === 0) {
                intro = `Your font has one master, ${esc(names[0])}. Adding an axis turns it into a variable font: ${esc(names[0])} gets a copy at the other end of the new axis, for example a ${word} one.`;
            } else if (axisCount === 1) {
                intro = `Your font has a ${esc(font.axes[0].name)} axis with ${esc(namesOrCount(names, 'masters'))}. A new axis needs masters at its other end too, so each of your masters gets a copy there, for example a ${word} one.`;
            } else {
                intro = `Your font has ${axisCount} axes (${esc(listNames(font.axes.map((a) => a.name)))}) and ${masterCount} masters. A new axis needs masters at its other end too, so each master gets a copy there, for example a ${word} one.`;
            }
            const work = newCount
                ? `<p>You will have <b>${masterCount + newCount}</b> masters to draw instead of <b>${masterCount}</b>.${masterCount > 1 ? ' You can untick masters on step 2 to add fewer.' : ''}</p>`
                : '';
            $('explain').innerHTML = `
                <p><b>What happens.</b> ${intro}</p>
                <p><b>The copies start identical to their originals.</b> After adding them, you redraw each copy to match its new position on the ${esc(model.name || 'new')} axis. Until then, moving along the axis appears to change nothing.</p>
                ${work}
                <p>The next two steps are optional. The defaults suit most fonts, so you can add the axis right away.</p>`;
        };

        // ---------- step 2 ----------
        const renderMastersStep = () => {
            const words = model.directionWords();
            root.querySelectorAll<HTMLButtonElement>(
                '[data-role="direction"] button'
            ).forEach((button) => {
                const dir = button.dataset.dir as Direction;
                button.textContent =
                    dir === 'below'
                        ? words[0]
                        : dir === 'above'
                          ? words[1]
                          : 'Both';
                button.setAttribute(
                    'aria-pressed',
                    String(dir === model.direction)
                );
                button.disabled = !model.directionAllowed(dir);
                button.title = button.disabled
                    ? `The registry doesn’t allow ${model.registry.name} values ${dir === 'above' ? 'above' : 'below'} ${fmt(model.existingUserValue())}.`
                    : '';
            });
            const one = font.masters.length === 1;
            const lower = words[0].toLowerCase();
            const higher = words[1].toLowerCase();
            const single = (
                model.direction === 'above' ? words[1] : words[0]
            ).toLowerCase();
            $('direction-hint').innerHTML =
                model.direction === 'both'
                    ? one
                        ? `${esc(model.defaultMaster.name)} gets two copies, one ${lower} and one ${higher}.`
                        : `Each of your masters gets two copies, one ${lower} and one ${higher}. That is up to <b>${font.masters.length * 2}</b> new masters.`
                    : one
                      ? `${esc(model.defaultMaster.name)} gets one ${single} copy.`
                      : `Each of your masters gets one ${single} copy. Untick masters in the table to add fewer.`;
            const sides = model.sides();
            $('field-min').hidden = !sides.includes('min');
            $('field-max').hidden = !sides.includes('max');
            $('label-min').textContent =
                model.direction === 'both'
                    ? `${words[0]} copies at`
                    : 'New masters at';
            $('label-max').textContent =
                model.direction === 'both'
                    ? `${words[1]} copies at`
                    : 'New masters at';
            setVal(input('pos-existing'), model.existingAt);
            setVal(input('pos-min'), model.columnValue('min'));
            setVal(input('pos-max'), model.columnValue('max'));
            $('name-existing').textContent = model.styleName(
                model.existingUserValue()
            );
            $('name-min').textContent = model.styleName(
                model.columnUser('min')
            );
            $('name-max').textContent = model.styleName(
                model.columnUser('max')
            );
            renderGrid();
        };

        // The table is rebuilt only when its structure changes; values are
        // patched in place so typing never loses focus.
        const renderGrid = () => {
            const sides = model.sides();
            const masters = model.sortedMasters();
            const key = JSON.stringify([
                sides,
                mastersBlocked,
                sides.map((side) =>
                    masters.map((m) => model.cell(m.id, side).on)
                )
            ]);
            const grid = $('grid');
            if (key !== gridKey) {
                gridKey = key;
                const head = sides
                    .map(
                        (side) => `<th><div class="add-axis-col-head">
                        <div class="add-axis-col-top"><input type="checkbox" data-colchk="${side}" ${mastersBlocked ? 'disabled' : ''} aria-label="Add all ${side} copies"><span data-colhead="${side}"></span></div>
                        <div class="add-axis-col-sub">Name ending <input type="text" class="dialog-input" data-suffix="${side}" aria-label="Name ending for ${side} copies"></div>
                    </div></th>`
                    )
                    .join('');
                const rows = masters
                    .map((master) => {
                        const cells = sides
                            .map((side) => {
                                const k = `${master.id}:${side}`;
                                const on = model.cell(master.id, side).on;
                                return `<td><div class="add-axis-cell${on ? '' : ' is-off'}">
                                <input type="checkbox" data-on="${k}" ${on ? 'checked' : ''} ${mastersBlocked ? 'disabled' : ''} aria-label="Add a copy of ${esc(master.name)}">
                                <input type="text" class="dialog-input add-axis-cell-name" data-name="${k}" ${on ? '' : 'disabled'} aria-label="Name">
                                <input type="number" step="any" class="dialog-input add-axis-num" data-val="${k}" ${on ? '' : 'disabled'} aria-label="Position">
                                <button type="button" class="add-axis-reset" data-reset="${k}" hidden>Reset</button>
                            </div></td>`;
                            })
                            .join('');
                        return `<tr><td><div class="add-axis-src-name">${esc(master.name)}</div><div class="add-axis-src-loc">${esc(model.locationText(master))}</div></td>${cells}</tr>`;
                    })
                    .join('');
                grid.innerHTML = `<thead><tr><th>Copy of</th>${head}</tr></thead><tbody>${rows}</tbody>`;
            }
            const q = <T extends Element>(selector: string) =>
                grid.querySelector(selector) as T;
            for (const side of sides) {
                const ons = font.masters.filter(
                    (m) => model.cell(m.id, side).on
                ).length;
                const check = q<HTMLInputElement>(`[data-colchk="${side}"]`);
                check.checked = ons === font.masters.length;
                check.indeterminate = ons > 0 && ons < font.masters.length;
                q<HTMLElement>(`[data-colhead="${side}"]`).innerHTML =
                    `${esc(model.sideWord(side))} copies <span class="add-axis-muted">at ${fmt(model.columnValue(side))}</span>`;
                const suffix = q<HTMLInputElement>(`[data-suffix="${side}"]`);
                setVal(suffix, model.suffix(side));
                suffix.classList.toggle(
                    'is-custom',
                    model.suffixEdited[side] !== undefined
                );
                for (const master of font.masters) {
                    const k = `${master.id}:${side}`;
                    const cell = model.cell(master.id, side);
                    const custom = model.isCustomValue(master.id, side);
                    const bad = shown.bad.has(k);
                    const nameEl = q<HTMLInputElement>(`[data-name="${k}"]`);
                    const valueEl = q<HTMLInputElement>(`[data-val="${k}"]`);
                    setVal(nameEl, model.cellName(master, side));
                    nameEl.classList.toggle('is-custom', cell.name !== null);
                    nameEl.classList.toggle('is-bad', shown.bad.has(`n:${k}`));
                    setVal(valueEl, model.cellValue(master.id, side));
                    valueEl.classList.toggle('is-bad', bad);
                    valueEl.classList.toggle('is-custom', !bad && custom);
                    q<HTMLElement>(`[data-reset="${k}"]`).hidden = !(
                        cell.on &&
                        (custom || cell.name !== null || cell.user !== null)
                    );
                }
            }
        };

        // ---------- step 3 ----------
        const renderDetailsStep = () => {
            const choiceOption = (side: Side) => {
                const name = model.cellName(model.defaultMaster, side);
                return {
                    value: side as DefaultChoice,
                    label: `${clipText(name, 24)} · new`,
                    full: name
                };
            };
            const sides = model.sides();
            const options = [
                ...(sides.includes('min') ? [choiceOption('min')] : []),
                {
                    value: 'existing' as DefaultChoice,
                    label: `${clipText(model.defaultMaster.name, 24)} · current`,
                    full: model.defaultMaster.name
                },
                ...(sides.includes('max') ? [choiceOption('max')] : [])
            ];
            const current = model.effectiveDefaultChoice();
            if (!hasMasters) {
                $('default').innerHTML = '';
                $('default-hint').textContent =
                    'There is nothing to choose: the font has no masters yet.';
            }
            $('default').innerHTML = !hasMasters
                ? ''
                : options
                      .map((option) => {
                          const valid = model.defaultChoiceValid(option.value);
                          const title = !valid
                              ? 'This copy is not being added'
                              : option.full !== option.label
                                ? option.full
                                : '';
                          return `<button type="button" data-def="${option.value}" aria-pressed="${current === option.value}" ${valid ? '' : 'disabled'} ${title ? `title="${esc(title)}"` : ''}>${esc(option.label)}</button>`;
                      })
                      .join('');
            if (!hasMasters) {
                // Hint already set above.
            } else if (current === 'existing') {
                $('default-hint').innerHTML =
                    `The default master is the one apps show when they ignore variations, and the one the compiled font is built from. <b>${esc(model.defaultMaster.name)}</b> stays the default, so your font keeps its current look. Keep this unless you have a reason to change it.`;
            } else {
                const name = esc(model.cellName(model.defaultMaster, current));
                $('default-hint').innerHTML =
                    `<b>${name}</b> becomes the default master: apps that ignore variations show ${name}, and the compiled font is built from it. Your existing instances keep their position.`;
            }
            input('opt-kerning').checked = model.copyKerning;
            input('opt-brace').checked =
                model.copyIntermediateLayers && !!font.braceGlyphCount;
            input('opt-instances').checked = model.copyInstances;
            input('opt-instances').disabled = !font.instanceCount;
            input('opt-separate').checked = model.separate;

            const rows = model.mapRows();
            const key = JSON.stringify([
                rows.map((row) => row.key),
                model.separate
            ]);
            const map = $('map');
            if (key !== mapKey) {
                mapKey = key;
                map.innerHTML = `<thead><tr><th>Masters</th><th>Position</th><th>Userspace</th><th></th></tr></thead><tbody>${rows
                    .map(
                        (
                            row
                        ) => `<tr><td class="add-axis-who" data-who="${row.key}"></td><td class="add-axis-mono" data-pos="${row.key}"></td>
                        <td><input type="number" step="any" class="dialog-input add-axis-num" data-mapu="${row.key}" ${model.separate ? '' : 'disabled title="Tick “Set userspace values separately” to change this."'} aria-label="Userspace value"></td>
                        <td class="add-axis-stylename" data-style="${row.key}"></td></tr>`
                    )
                    .join('')}</tbody>`;
            }
            for (const row of rows) {
                const cell = (attr: string) =>
                    map.querySelector(`[${attr}="${row.key}"]`) as HTMLElement;
                const who = cell('data-who');
                who.textContent =
                    row.all && row.names.length > 3
                        ? `All ${row.names.length} of your masters`
                        : listShort(row.names, 2);
                who.title = row.names.length > 3 ? row.names.join(', ') : '';
                cell('data-pos').textContent = fmt(row.position);
                setVal(cell('data-mapu') as HTMLInputElement, row.user);
                cell('data-style').textContent = model.styleName(row.user);
            }
        };

        // ---------- ladder preview ----------
        const renderPlot = () => {
            const W = 300,
                G = 112,
                R = 14,
                ROW = 20,
                HEAD = 18,
                TOP = 22;
            const masters = model.sortedMasters();
            const e = model.existingAt;
            const values = [e];
            for (const side of model.sides()) {
                for (const master of masters) {
                    values.push(model.cellValue(master.id, side));
                }
            }
            const finite = values.filter(Number.isFinite);
            const svg = $('plot');
            if (!finite.length) {
                svg.innerHTML = '';
                return;
            }
            const xmin = Math.min(...finite);
            const xmax = Math.max(...finite);
            const span = xmax - xmin || 1;
            const X0 = G + 16;
            const X1 = W - R - 16;
            const x = (v: number) => X0 + ((v - xmin) / span) * (X1 - X0);

            // Rows, grouped under the first axis when there are two or more.
            type Item = {
                head?: string;
                master?: (typeof masters)[number];
                label: string;
                y: number;
            };
            const items: Item[] = [];
            let y = TOP;
            let lastGroup: number | undefined;
            for (const master of masters) {
                if (font.axes.length >= 2) {
                    const group = master.location[font.axes[0].tag] ?? 0;
                    if (group !== lastGroup) {
                        items.push({
                            head: `${font.axes[0].name} ${group}`,
                            label: '',
                            y: y + 12
                        });
                        y += HEAD;
                        lastGroup = group;
                    }
                }
                items.push({ master, label: master.name, y: y + ROW / 2 });
                y += ROW;
            }
            // Under a heading, drop the leading words the whole group shares
            // and move them into the heading ("Thin · Weight 100").
            if (font.axes.length >= 2) {
                const groups: Array<{ head: Item; rows: Item[] }> = [];
                for (const item of items) {
                    if (item.head !== undefined) {
                        groups.push({ head: item, rows: [] });
                    } else {
                        groups[groups.length - 1]?.rows.push(item);
                    }
                }
                for (const { head, rows } of groups) {
                    if (rows.length < 2) {
                        continue;
                    }
                    const words = rows.map((row) => row.label.split(/\s+/));
                    let k = 0;
                    while (
                        words.every(
                            (w) => w.length > k + 1 && w[k] === words[0][k]
                        )
                    ) {
                        k += 1;
                    }
                    if (!k) {
                        continue;
                    }
                    rows.forEach((row, i) => {
                        row.label = words[i].slice(k).join(' ');
                    });
                    head.head = `${words[0].slice(0, k).join(' ')} · ${head.head}`;
                }
            }
            const base = y + 8;
            const H = base + (model.separate ? 36 : 24);
            const font10 = 'font-size="10" font-family="Inter, sans-serif"';
            const mono10 =
                'font-size="10" font-family="IBM Plex Mono, monospace"';
            let s = `<text x="4" y="12" class="add-axis-plot-muted" ${font10}>Your masters</text>
                <text x="${X1}" y="12" class="add-axis-plot-muted" text-anchor="end" ${font10}>${esc(clipText(model.name || model.tag, 22))} →</text>`;
            const ticks: Array<{ d: number; u: number }> = [];
            [
                { d: e, u: model.existingUserValue() },
                ...model.newMasters().map(({ master, side }) => ({
                    d: model.cellValue(master.id, side),
                    u: model.cellUser(master.id, side)
                }))
            ].forEach((tick) => {
                if (
                    Number.isFinite(tick.d) &&
                    !ticks.some((t) => t.d === tick.d)
                ) {
                    ticks.push(tick);
                }
            });
            ticks.sort((a, b) => a.d - b.d);
            let lastLabelX = -Infinity;
            for (const tick of ticks) {
                const tx = x(tick.d);
                s += `<line x1="${tx}" y1="${TOP - 2}" x2="${tx}" y2="${base}" class="add-axis-plot-guide" />
                    <line x1="${tx}" y1="${base}" x2="${tx}" y2="${base + 4}" class="add-axis-plot-axis" />`;
                if (tx - lastLabelX >= 26) {
                    s += `<text x="${tx}" y="${base + 14}" class="add-axis-plot-text" text-anchor="middle" ${mono10}>${tick.d}</text>`;
                    if (model.separate) {
                        s += `<text x="${tx}" y="${base + 26}" class="add-axis-plot-accent" text-anchor="middle" ${mono10}>${fmt(tick.u)}</text>`;
                    }
                    lastLabelX = tx;
                }
            }
            s += `<line x1="${G}" y1="${base}" x2="${W - R}" y2="${base}" class="add-axis-plot-axis" />
                <text x="4" y="${base + 14}" class="add-axis-plot-faint" font-size="9" font-family="Inter, sans-serif">position</text>`;
            if (model.separate) {
                s += `<text x="4" y="${base + 26}" class="add-axis-plot-accent" font-size="9" font-family="Inter, sans-serif">userspace</text>`;
            }
            const choice = model.effectiveDefaultChoice();
            const defX =
                choice === 'existing'
                    ? e
                    : model.cellValue(model.defaultMaster.id, choice);
            for (const item of items) {
                if (item.head !== undefined) {
                    s += `<text x="4" y="${item.y}" class="add-axis-plot-faint" font-size="9" letter-spacing=".04em" font-family="Inter, sans-serif">${esc(item.head.toUpperCase())}</text>`;
                    continue;
                }
                const master = item.master!;
                const rowY = item.y;
                const isDefault = master.id === model.defaultMaster.id;
                s += `<g><title>${esc(master.name)} (${esc(model.locationText(master))})</title>
                    <text x="4" y="${rowY + 3.5}" class="${isDefault ? 'add-axis-plot-text' : 'add-axis-plot-muted'}" ${font10}>${esc(clipText(item.label, 19))}</text></g>`;
                if (!Number.isFinite(e)) {
                    continue;
                }
                for (const side of model.sides()) {
                    const value = model.cellValue(master.id, side);
                    if (!Number.isFinite(value)) {
                        continue;
                    }
                    const on =
                        model.cell(master.id, side).on && !mastersBlocked;
                    s += `<line x1="${x(e)}" y1="${rowY}" x2="${x(value)}" y2="${rowY}" class="${on ? 'add-axis-plot-link' : 'add-axis-plot-link-off'}" />`;
                }
                s += `<circle cx="${x(e)}" cy="${rowY}" r="4" class="add-axis-plot-dot-exist" />`;
                for (const side of model.sides()) {
                    const value = model.cellValue(master.id, side);
                    if (!Number.isFinite(value)) {
                        continue;
                    }
                    const on =
                        model.cell(master.id, side).on && !mastersBlocked;
                    const name = model.cellName(master, side);
                    s += `<g><title>${esc(on ? name : `${name} (not added)`)} at ${value}</title>${
                        on
                            ? `<circle cx="${x(value)}" cy="${rowY}" r="5" class="add-axis-plot-dot-new" />`
                            : `<circle cx="${x(value)}" cy="${rowY}" r="4" class="add-axis-plot-dot-off" />`
                    }</g>`;
                }
                if (isDefault && Number.isFinite(defX)) {
                    s += `<circle cx="${x(defX)}" cy="${rowY}" r="${page === 3 ? 8.5 : 7.5}" class="add-axis-plot-ring" stroke-width="${page === 3 ? 3 : 2}" />`;
                }
            }
            svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
            svg.innerHTML = s;
        };

        // ---------- summary ----------
        const renderSummary = () => {
            const added = mastersBlocked ? [] : model.newMasters();
            const axis = model.deriveAxis();
            const lines: string[] = [];
            lines.push(
                added.length
                    ? `<p>Adds <b>${added.length}</b> master${added.length > 1 ? 's' : ''}: ${esc(listShort(added.map((m) => m.name)))}.</p>`
                    : `<p>No masters selected. The axis is added on its own.</p>`
            );
            lines.push(
                `<p>The ${esc(model.name)} axis runs from <b>${fmt(axis.min)}</b> to <b>${fmt(axis.max)}</b>, default <b>${fmt(axis.default)}</b>.</p>`
            );
            const choice = model.effectiveDefaultChoice();
            if (added.length && choice !== 'existing') {
                lines.push(
                    `<p class="add-axis-flag">Default master changes to ${esc(model.cellName(model.defaultMaster, choice))}.</p>`
                );
            }
            if (added.length && model.separate) {
                const pairs = axis.map.map((p) => `${fmt(p.d)} → ${fmt(p.u)}`);
                lines.push(
                    `<p>Userspace map: ${pairs.length > 5 ? `${pairs.slice(0, 4).join(', ')} and ${pairs.length - 4} more` : pairs.join(', ')}.</p>`
                );
            }
            if (added.length && !model.copyKerning) {
                lines.push(
                    '<p class="add-axis-flag">Kerning and guides are not copied.</p>'
                );
            }
            if (
                added.length &&
                !model.copyIntermediateLayers &&
                font.braceGlyphCount
            ) {
                lines.push(
                    '<p class="add-axis-flag">Intermediate layers are not copied.</p>'
                );
            }
            if (added.length && model.copyInstances && font.instanceCount) {
                const columns = model
                    .sides()
                    .filter((side) =>
                        font.masters.some((m) => model.cell(m.id, side).on)
                    ).length;
                lines.push(
                    `<p>Also adds ${plural(font.instanceCount * columns, 'instance', 'instances')}.</p>`
                );
            }
            if (added.length) {
                const braceShare = model.copyIntermediateLayers
                    ? Math.round(
                          (font.braceLayerCount * added.length) /
                              font.masters.length
                      )
                    : 0;
                const layers = added.length * font.glyphCount + braceShare;
                lines.push(
                    `<p>About ${layers.toLocaleString('en-US')} layers across ${font.glyphCount.toLocaleString('en-US')} glyphs, one undo step.</p>`
                );
            }
            $('summary').innerHTML = lines.join('');
        };

        const render = (typing: boolean) => {
            const live = model.validate();
            if (!typing) {
                shown = live;
            }
            renderAxisStep();
            renderMastersStep();
            renderDetailsStep();
            renderPlot();
            renderSummary();
            for (const p of [1, 2, 3] as Page[]) {
                const tab = root.querySelector(
                    `.add-axis-tabs [data-page="${p}"]`
                ) as HTMLElement;
                tab.setAttribute('aria-selected', String(page === p));
                tab.tabIndex = page === p ? 0 : -1;
                (tab.querySelector('.add-axis-tab-err') as HTMLElement).hidden =
                    !shown.errors[p].length;
                root.querySelector(
                    `.add-axis-page[data-page="${p}"]`
                )?.classList.toggle('is-active', page === p);
                const warnings = live.warnings[p];
                (
                    root.querySelector(`[data-notes="${p}"]`) as HTMLElement
                ).innerHTML =
                    shown.errors[p]
                        .map(
                            (m) =>
                                `<div class="add-axis-note-err">${esc(m)}</div>`
                        )
                        .join('') +
                    warnings
                        .map(
                            (m) =>
                                `<div class="add-axis-note-warn">${esc(m)}</div>`
                        )
                        .join('');
            }
            const liveErrors =
                live.errors[1].length +
                live.errors[2].length +
                live.errors[3].length;
            const firstBad = ([1, 2, 3] as Page[]).find(
                (p) => shown.errors[p].length
            );
            $('why').textContent = firstBad
                ? `Check step ${firstBad} to continue.`
                : '';
            const count = mastersBlocked ? 0 : model.newMasters().length;
            const commit = $<HTMLButtonElement>('commit');
            commit.textContent = count
                ? `Add axis and ${count} master${count > 1 ? 's' : ''}`
                : 'Add axis';
            commit.disabled =
                liveErrors > 0 && (count > 0 || live.errors[1].length > 0);
            const axisOnly = $<HTMLButtonElement>('axis-only');
            axisOnly.hidden = count === 0;
            axisOnly.disabled =
                live.errors[1].length > 0 || !Number.isFinite(model.existingAt);
            $<HTMLButtonElement>('back').disabled = page === 1;
            $<HTMLButtonElement>('next').disabled = page === 3;
        };

        const goTo = (p: number) => {
            page = Math.max(1, Math.min(3, p)) as Page;
            render(false);
        };

        const close = (result: AddAxisDialogResult) => {
            escapeBinding?.release();
            escapeBinding = null;
            overlay.remove();
            resolve(result);
        };

        // ---------- events ----------
        root.addEventListener('click', (event) => {
            const target = (event.target as Element).closest('button');
            if (!target || target.disabled) {
                return;
            }
            const role = target.dataset.role;
            if (target.dataset.page && target.closest('.add-axis-tabs')) {
                goTo(Number(target.dataset.page));
            } else if (role === 'back') {
                goTo(page - 1);
            } else if (role === 'next') {
                goTo(page + 1);
            } else if (target.dataset.dir) {
                model.setDirection(target.dataset.dir as Direction);
                render(false);
            } else if (target.dataset.def) {
                model.defaultChoice = target.dataset.def as DefaultChoice;
                render(false);
            } else if (target.dataset.reset) {
                const [masterId, side] = target.dataset.reset.split(':');
                model.resetCell(masterId, side as Side);
                render(false);
            } else if (role === 'close' || role === 'cancel') {
                close({ kind: 'cancel' });
            } else if (role === 'axis-only') {
                close({ kind: 'axis-only', model });
            } else if (role === 'commit') {
                const count = mastersBlocked ? 0 : model.newMasters().length;
                close(
                    count
                        ? { kind: 'with-masters', model }
                        : { kind: 'axis-only', model }
                );
            }
        });
        root.querySelector('.add-axis-tabs')?.addEventListener(
            'keydown',
            (event) => {
                const key = (event as KeyboardEvent).key;
                if (key !== 'ArrowRight' && key !== 'ArrowLeft') {
                    return;
                }
                goTo(page + (key === 'ArrowRight' ? 1 : -1));
                (
                    root.querySelector(
                        `.add-axis-tabs [data-page="${page}"]`
                    ) as HTMLElement
                ).focus();
            }
        );

        const number = (el: HTMLInputElement) =>
            el.value === '' ? Number.NaN : Number(el.value);
        // Text and number fields update on every keystroke; errors show once the field is left.
        const onEdit = (event: Event) => {
            const target = event.target as HTMLInputElement | HTMLSelectElement;
            const typed = target.matches(
                'input[type=text], input[type=number]'
            );
            if (event.type === 'input' && !typed) {
                return;
            }
            if (target.dataset.role === 'axis-type') {
                model.loadAxis(target.value);
                if (mastersBlocked) {
                    model.setColumnOn('min', false);
                    model.setColumnOn('max', false);
                }
                gridKey = '';
                mapKey = '';
                render(false);
                return;
            }
            if (typed && event.type === 'change') {
                render(false);
                return;
            }
            const el = target as HTMLInputElement;
            const role = el.dataset.role;
            if (el.dataset.on) {
                const [masterId, side] = el.dataset.on.split(':');
                model.cell(masterId, side as Side).on = el.checked;
            } else if (el.dataset.colchk) {
                model.setColumnOn(el.dataset.colchk as Side, el.checked);
            } else if (el.dataset.val) {
                const [masterId, side] = el.dataset.val.split(':');
                model.setCellValue(masterId, side as Side, number(el));
            } else if (el.dataset.name) {
                const [masterId, side] = el.dataset.name.split(':');
                model.setCellName(masterId, side as Side, el.value);
            } else if (el.dataset.suffix) {
                model.setSuffix(el.dataset.suffix as Side, el.value);
            } else if (el.dataset.mapu) {
                model.setMapUser(el.dataset.mapu, number(el));
            } else if (role === 'opt-kerning') {
                model.copyKerning = el.checked;
            } else if (role === 'opt-brace') {
                model.copyIntermediateLayers = el.checked;
            } else if (role === 'opt-instances') {
                model.copyInstances = el.checked;
            } else if (role === 'opt-separate') {
                model.setSeparate(el.checked);
            } else if (role === 'pos-existing') {
                model.existingAt = number(el);
            } else if (role === 'pos-min') {
                model.newAt.min = number(el);
            } else if (role === 'pos-max') {
                model.newAt.max = number(el);
            } else if (role === 'name') {
                model.name = el.value;
            } else if (role === 'tag') {
                model.tag = el.value;
            } else {
                return;
            }
            render(event.type === 'input');
        };
        root.addEventListener('input', onEdit);
        root.addEventListener('change', onEdit);
        root.addEventListener('keydown', (event) => {
            if (
                event.key === 'Enter' &&
                event.target instanceof HTMLInputElement &&
                event.target.type !== 'checkbox'
            ) {
                event.preventDefault();
                const commit = $<HTMLButtonElement>('commit');
                if (!commit.disabled) {
                    commit.click();
                }
            }
        });
        overlay.addEventListener('mousedown', (event) => {
            if (event.target === overlay) {
                close({ kind: 'cancel' });
            }
        });

        buildAxisMenu();
        render(false);
        escapeBinding = bindModalEscape(() => close({ kind: 'cancel' }), {
            isOpen: () => overlay.isConnected
        });
        requestAnimationFrame(() => {
            document.body.appendChild(overlay);
            $<HTMLSelectElement>('axis-type').focus();
        });
    });
}
