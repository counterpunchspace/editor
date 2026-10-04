import { Logger } from '../logger';
import {
    createPluginSettingControl,
    isPluginSetting,
    type PluginSetting
} from './plugin-settings-controls';
import {
    pluginSettingActionStatus,
    runPluginSettingAction
} from './plugin-settings-actions';
import { resolvePluginSettingTarget } from './plugin-settings-targets';

const console = new Logger('PluginSettings');

export const PLUGIN_SETTINGS_KEY = 'com.counterpunch.plugin-settings';

interface RegisteredPluginSettings {
    pluginId: string;
    title: string;
    version: string;
    settings: PluginSetting[];
}

const PLUGIN_TITLES: Record<string, string> = {
    'space.counterpunch.ccmp': 'Composition'
};

class PluginSettingsRegistry {
    private plugins = new Map<string, RegisteredPluginSettings>();

    register(pluginId: string, version: string, settings: unknown[]): void {
        const accepted: PluginSetting[] = [];
        for (const value of settings) {
            if (!isPluginSetting(value)) {
                console.warn(`Rejected setting on ${pluginId}`, value);
                continue;
            }
            const target = resolvePluginSettingTarget(value.target);
            if (value.target && target !== value.target) {
                console.warn(
                    `Setting ${pluginId}.${value.id} target ${value.target} fell back to ${target}`
                );
            }
            accepted.push({ ...value, target });
        }
        this.plugins.set(pluginId, {
            pluginId,
            title: PLUGIN_TITLES[pluginId] || pluginId,
            version,
            settings: accepted
        });
    }

    pluginsForTarget(target: string): RegisteredPluginSettings[] {
        return [...this.plugins.values()].filter((plugin) =>
            plugin.settings.some((setting) => setting.target === target)
        );
    }

    /**
     * User-facing description of a feature generator: plugin name, and the
     * current value of each setting. Internal fields stay out.
     */
    describe(pluginId: string): {
        title: string;
        pluginId: string;
        version: string;
        summary: string;
        settings: Array<{ label: string; value: string; help?: string }>;
    } | null {
        const plugin = this.plugins.get(pluginId);
        const font = window.currentFontModel;
        if (!plugin || !font) {
            return null;
        }
        const settings = plugin.settings
            .filter((setting) => setting.target !== 'add-glyphs')
            .map((setting) => {
                const raw =
                    font.getPluginSetting(pluginId, setting.id) ??
                    setting.default;
                return {
                    label: setting.label || setting.id,
                    value: displaySettingValue(setting, raw),
                    help: setting.help
                };
            });
        const summary = [
            plugin.title,
            ...settings.map((setting) => setting.value).filter(Boolean)
        ].join(' · ');
        return {
            title: plugin.title,
            pluginId: plugin.pluginId,
            version: plugin.version,
            summary,
            settings
        };
    }

    renderTarget(container: HTMLElement, target: string): void {
        container.replaceChildren();
        for (const plugin of this.pluginsForTarget(target)) {
            this.appendSettings(
                container,
                plugin,
                plugin.settings.filter((setting) => setting.target === target)
            );
        }
    }

    render(
        container: HTMLElement,
        pluginId: string,
        onChange?: () => void
    ): void {
        const plugin = this.plugins.get(pluginId);
        container.replaceChildren();
        if (!plugin) {
            return;
        }
        this.appendSettings(
            container,
            plugin,
            plugin.settings.filter(
                (setting) => setting.target !== 'add-glyphs'
            ),
            onChange
        );
    }

    private appendSettings(
        container: HTMLElement,
        plugin: RegisteredPluginSettings,
        settings: PluginSetting[],
        onChange?: () => void
    ): void {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        const pluginId = plugin.pluginId;
        for (const setting of settings) {
            container.appendChild(
                createPluginSettingControl(setting, {
                    get: (id) =>
                        font.getPluginSetting(pluginId, id) ?? setting.default,
                    set: (id, value) => {
                        font.setPluginSetting(pluginId, id, value);
                        onChange?.();
                    }
                })
            );
            for (const action of setting.actions || []) {
                if (!action.id.startsWith('host:')) {
                    continue;
                }
                const context = {
                    pluginId,
                    settingId: setting.id,
                    value: font.getPluginSetting(pluginId, setting.id)
                };
                const status = pluginSettingActionStatus(action.id, context);
                if (status) {
                    const line = document.createElement('p');
                    line.className = 'plugin-setting-status';
                    line.textContent = status;
                    container.appendChild(line);
                }
                const actions = document.createElement('div');
                actions.className = 'plugin-setting-actions';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'dialog-button';
                button.textContent = action.label;
                button.addEventListener('click', () =>
                    runPluginSettingAction(action.id, context)
                );
                actions.appendChild(button);
                container.appendChild(actions);
            }
        }
    }
}

function displaySettingValue(setting: PluginSetting, value: unknown): string {
    if (setting.type === 'radio' || setting.type === 'select') {
        const option = setting.options?.find(
            (item) => item.value === String(value ?? '')
        );
        return option?.label || String(value ?? '');
    }
    if (setting.type === 'checkbox') {
        return value ? 'On' : 'Off';
    }
    if (value == null || value === '') {
        return '';
    }
    return String(value);
}

export const pluginSettingsRegistry = new PluginSettingsRegistry();
