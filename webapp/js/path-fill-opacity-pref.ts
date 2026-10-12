/**
 * Preference: opacity of editable outline fills, placeholder fills, and subtraction cutter fills.
 * Default comes from APP_SETTINGS.OUTLINE_EDITOR.PATH_FILL_OPACITY.
 * Editing View → View menu owns the Fill slider.
 */

import { createUiSlider } from './ui/slider';

const STORAGE_KEY = 'editorPathFillOpacity';

export const PATH_FILL_OPACITY_CHANGED_EVENT = 'pathFillOpacityChanged';
export const PATH_FILL_OPACITY_MIN = 0;
export const PATH_FILL_OPACITY_MAX = 0.12;
export const PATH_FILL_OPACITY_STEP = 0.001;

function defaultPathFillOpacity(): number {
    const value = window.APP_SETTINGS?.OUTLINE_EDITOR?.PATH_FILL_OPACITY;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.02;
}

function clampPathFillOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return defaultPathFillOpacity();
    }
    return Math.min(
        PATH_FILL_OPACITY_MAX,
        Math.max(PATH_FILL_OPACITY_MIN, value)
    );
}

export function getPathFillOpacity(): number {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) {
            return defaultPathFillOpacity();
        }
        return clampPathFillOpacity(Number(raw));
    } catch {
        return defaultPathFillOpacity();
    }
}

export function setPathFillOpacity(value: number): void {
    const next = clampPathFillOpacity(value);
    try {
        // Outline and subtraction fill alpha (0–0.12).
        localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
        // Ignore localStorage access failures.
    }
    window.dispatchEvent(
        new CustomEvent(PATH_FILL_OPACITY_CHANGED_EVENT, {
            detail: { value: next }
        })
    );
}

export function createPathFillOpacityMenuControl(options?: {
    disabled?: boolean;
}): HTMLElement {
    const disabled = options?.disabled === true;
    const setting = document.createElement('div');
    setting.className = 'plugin-menu-setting plugin-menu-fill-setting';
    setting.title = 'Opacity of outline, placeholder, and subtraction fills';
    if (disabled) {
        setting.classList.add('plugin-menu-item-disabled');
        setting.setAttribute('aria-disabled', 'true');
    }

    const label = document.createElement('span');
    label.className = 'plugin-menu-setting-label';
    label.textContent = 'Fill';
    setting.appendChild(label);

    const slider = createUiSlider({
        min: PATH_FILL_OPACITY_MIN,
        max: PATH_FILL_OPACITY_MAX,
        step: PATH_FILL_OPACITY_STEP,
        value: getPathFillOpacity(),
        ariaLabel: 'Outline fill opacity',
        onInput: (value) => {
            if (disabled) {
                return;
            }
            setPathFillOpacity(value);
        }
    });
    slider.element.disabled = disabled;
    setting.appendChild(slider.element);
    setting.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    return setting;
}
