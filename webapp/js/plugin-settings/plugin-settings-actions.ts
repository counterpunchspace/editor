/** Host actions a plugin setting can show as a button. */

import { managedInputs } from '../language-packs/managed-features';
import { glyphDataIndex } from '../glyph-data';

export interface PluginSettingActionContext {
    pluginId: string;
    settingId: string;
    value: unknown;
}

type HostAction = {
    run(context: PluginSettingActionContext): void;
    status?(context: PluginSettingActionContext): string;
};

const actions = new Map<string, HostAction>();

actions.set('host:rebuild-composition', {
    run() {
        void import('../language-packs/rebuild-composition-dialog').then(
            ({ openRebuildCompositionDialog }) =>
                openRebuildCompositionDialog({
                    scope: 'recipes',
                    output:
                        window.currentFontModel?.getPluginSetting(
                            'space.counterpunch.ccmp',
                            'composition_output'
                        ) === 'ccmp'
                            ? 'ccmp'
                            : 'materialized'
                })
        );
    },
    status() {
        const font = window.currentFontModel;
        if (!font) {
            return '';
        }
        const output =
            font.getPluginSetting(
                'space.counterpunch.ccmp',
                'composition_output'
            ) === 'ccmp'
                ? 'ccmp'
                : 'materialized';
        const inputs = new Set(
            managedInputs(
                font.features,
                'space.counterpunch.ccmp',
                'decomposition'
            )
        );
        let other = 0;
        for (const glyph of font.glyphs) {
            const codepoint = glyph.codepoints?.[0];
            if (typeof codepoint !== 'number') {
                continue;
            }
            const record = glyphDataIndex.getGlyphDataForUnicode([codepoint]);
            if (!record || record.script !== 'Latin' || !record.decomposition) {
                continue;
            }
            const isCcmp = inputs.has(glyph.name);
            if (
                (output === 'ccmp' && !isCcmp) ||
                (output === 'materialized' && isCcmp)
            ) {
                other += 1;
            }
        }
        if (!other) {
            return '';
        }
        const mode = output === 'ccmp' ? 'materialized' : 'ccmp';
        return `${other} glyphs use ${mode} composition`;
    }
});

export function runPluginSettingAction(
    actionId: string,
    context: PluginSettingActionContext
): void {
    actions.get(actionId)?.run(context);
}

export function pluginSettingActionStatus(
    actionId: string,
    context: PluginSettingActionContext
): string {
    return actions.get(actionId)?.status?.(context) || '';
}
