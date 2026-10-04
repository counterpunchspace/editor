/** Shared controls for plugin-declared settings. */

export interface SettingOption {
    value: string;
    label?: string;
}

export interface PluginSetting {
    id: string;
    type: string;
    label?: string;
    help?: string;
    default?: string | number | boolean;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    max_length?: number;
    options?: SettingOption[];
    actions?: Array<{ id: string; label: string }>;
    target?: string;
    regenerates?: boolean;
}

export interface SettingValueSource {
    get(id: string): unknown;
    set(id: string, value: unknown): void;
}

export function isPluginSetting(value: unknown): value is PluginSetting {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const setting = value as PluginSetting;
    const types = [
        'checkbox',
        'radio',
        'select',
        'number',
        'slider',
        'textfield',
        'color'
    ];
    return (
        typeof setting.id === 'string' &&
        types.includes(setting.type) &&
        (setting.type !== 'radio' && setting.type !== 'select'
            ? true
            : Array.isArray(setting.options))
    );
}

export function createPluginSettingControl(
    setting: PluginSetting,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const current = source.get(setting.id);
    const value = current == null ? setting.default : current;
    if (setting.type === 'checkbox') {
        return labeled(
            setting,
            checkbox(setting, Boolean(value), source, onAfterChange)
        );
    }
    if (setting.type === 'slider' || setting.type === 'number') {
        return labeled(
            setting,
            numberControl(setting, Number(value ?? 0), source, onAfterChange)
        );
    }
    if (setting.type === 'textfield') {
        return labeled(
            setting,
            textControl(setting, String(value ?? ''), source, onAfterChange)
        );
    }
    if (setting.type === 'color') {
        return labeled(
            setting,
            colorControl(
                setting,
                String(value || '#000000'),
                source,
                onAfterChange
            )
        );
    }
    if (setting.type === 'select') {
        return labeled(
            setting,
            selectControl(setting, String(value ?? ''), source, onAfterChange)
        );
    }
    return labeled(
        setting,
        radioControl(setting, String(value ?? ''), source, onAfterChange)
    );
}

function labeled(setting: PluginSetting, control: HTMLElement): HTMLElement {
    const container = document.createElement('div');
    container.className = `plugin-ui-${setting.type}`;
    const label = document.createElement('div');
    label.className = 'plugin-ui-label';
    label.textContent = setting.label || setting.id;
    container.appendChild(label);
    if (setting.help) {
        const help = document.createElement('p');
        help.className = 'plugin-setting-help';
        help.textContent = setting.help;
        container.appendChild(help);
    }
    container.appendChild(control);
    return container;
}

function checkbox(
    setting: PluginSetting,
    value: boolean,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'plugin-ui-checkbox-input';
    input.checked = value;
    input.addEventListener('change', () => {
        source.set(setting.id, input.checked);
        onAfterChange?.();
    });
    return input;
}

function numberControl(
    setting: PluginSetting,
    value: number,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const input = document.createElement('input');
    input.type = setting.type === 'slider' ? 'range' : 'number';
    input.className = 'plugin-ui-value';
    if (setting.min != null) input.min = String(setting.min);
    if (setting.max != null) input.max = String(setting.max);
    if (setting.step != null) input.step = String(setting.step);
    input.value = String(value);
    input.addEventListener('change', () => {
        source.set(setting.id, Number(input.value));
        onAfterChange?.();
    });
    return input;
}

function textControl(
    setting: PluginSetting,
    value: string,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'plugin-ui-value';
    input.value = value;
    if (setting.placeholder) input.placeholder = setting.placeholder;
    if (setting.max_length) input.maxLength = setting.max_length;
    input.addEventListener('change', () => {
        source.set(setting.id, input.value);
        onAfterChange?.();
    });
    return input;
}

function colorControl(
    setting: PluginSetting,
    value: string,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'plugin-ui-color-input';
    input.value = value;
    input.addEventListener('input', () => {
        source.set(setting.id, input.value);
        onAfterChange?.();
    });
    return input;
}

function selectControl(
    setting: PluginSetting,
    value: string,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const select = document.createElement('select');
    select.className = 'plugin-ui-value';
    for (const option of setting.options || []) {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label || option.value;
        item.selected = option.value === value;
        select.appendChild(item);
    }
    select.addEventListener('change', () => {
        source.set(setting.id, select.value);
        onAfterChange?.();
    });
    return select;
}

function radioControl(
    setting: PluginSetting,
    value: string,
    source: SettingValueSource,
    onAfterChange?: () => void
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'plugin-ui-radio-options';
    for (const option of setting.options || []) {
        const label = document.createElement('label');
        label.className = 'plugin-ui-radio-label';
        const input = document.createElement('input');
        input.type = 'radio';
        input.className = 'plugin-ui-radio-input';
        input.name = setting.id;
        input.value = option.value;
        input.checked = option.value === value;
        input.addEventListener('change', () => {
            if (input.checked) {
                source.set(setting.id, option.value);
                onAfterChange?.();
            }
        });
        const text = document.createElement('span');
        text.textContent = option.label || option.value;
        label.append(input, text);
        group.appendChild(label);
    }
    return group;
}
