/** Host slots where plugin settings are shown. The target chooses the storage scope. */

export type PluginSettingScope = 'font' | 'window';

export interface PluginSettingTarget {
    id: string;
    scope: PluginSettingScope;
    implemented: boolean;
}

export const PLUGIN_SETTING_TARGETS: Record<string, PluginSettingTarget> = {
    'font-info.features': {
        id: 'font-info.features',
        scope: 'font',
        implemented: true
    },
    'canvas.plugins': {
        id: 'canvas.plugins',
        scope: 'window',
        implemented: true
    },
    'font-info.language-packs': {
        id: 'font-info.language-packs',
        scope: 'font',
        implemented: true
    },
    'add-glyphs': {
        id: 'add-glyphs',
        scope: 'font',
        implemented: true
    }
};

export const PLUGIN_SETTING_FALLBACK = 'font-info.language-packs';

export const RESERVED_PLUGIN_SETTING_TARGETS = [
    'font-info.general',
    'glyph-overview.filters'
];

export function resolvePluginSettingTarget(target: string | undefined): string {
    if (target && PLUGIN_SETTING_TARGETS[target]?.implemented) {
        return target;
    }
    return PLUGIN_SETTING_FALLBACK;
}
