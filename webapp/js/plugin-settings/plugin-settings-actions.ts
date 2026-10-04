/** Host actions a plugin setting can show as a button. */

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
