/**
 * Unified keyboard shortcut chips (title bars, menus, buttons, docs, tour).
 * Styling baseline is the view title bar: 10px type, icons at 1.2em / top -1px.
 * Mac uses Command; Windows/Linux use Control.
 */

/** Unicode shift glyph in shortcut source strings. */
export const MENU_SHIFT_SYMBOL = '\u21E7';

/** Canonical Command glyph in shortcut source strings. */
export const MENU_COMMAND_SYMBOL = '\u2318';

/** Option/Alt glyph in shortcut source strings. */
export const MENU_OPTION_SYMBOL = '\u2325';

/** Return/Enter glyph in shortcut source strings. */
export const MENU_RETURN_SYMBOL = '\u23CE';

const CONTROL_KEY_SYMBOL = '\u2303';

export function platformUsesCommandKey(): boolean {
    const platform =
        typeof navigator !== 'undefined' ? navigator.platform || '' : '';
    return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function usesCommandModifier(): boolean {
    return platformUsesCommandKey();
}

/** Pointer command gestures. On macOS, Ctrl alone opens the context menu. */
export function isPointerCommandModifier(e: {
    metaKey: boolean;
    ctrlKey: boolean;
}): boolean {
    if (platformUsesCommandKey()) {
        return e.metaKey;
    }
    return e.metaKey || e.ctrlKey;
}

export function commandModifierIconName():
    'keyboard_command_key' | 'keyboard_control_key' {
    return usesCommandModifier()
        ? 'keyboard_command_key'
        : 'keyboard_control_key';
}

function materialIcon(name: string, extraClass = ''): string {
    const cls = extraClass
        ? `material-symbols-outlined ${extraClass}`
        : 'material-symbols-outlined';
    return `<span class="${cls}">${name === '' ? '' : name}</span>`;
}

function commandModifierIconHtml(): string {
    return materialIcon('', 'shortcut-command-modifier');
}

function optionModifierIconHtml(): string {
    return materialIcon('', 'shortcut-option-modifier');
}

function escapeShortcutText(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Inner HTML of a shortcut chip. Command/Ctrl and Option/Alt use CSS
 * ligatures keyed off `data-command-modifier` on `<html>`.
 */
export function formatShortcutHtml(shortcut: string): string {
    let html = '';
    for (const ch of shortcut) {
        if (ch === MENU_SHIFT_SYMBOL) {
            html += materialIcon('arrow_upward');
        } else if (ch === MENU_COMMAND_SYMBOL) {
            html += commandModifierIconHtml();
        } else if (ch === MENU_OPTION_SYMBOL) {
            html += optionModifierIconHtml();
        } else if (ch === MENU_RETURN_SYMBOL) {
            html += materialIcon('keyboard_return');
        } else {
            html += escapeShortcutText(ch);
        }
    }
    return html;
}

/** @deprecated Use formatShortcutHtml */
export function formatMenuShortcut(shortcut: string): string {
    return formatShortcutHtml(shortcut);
}

export function keyboardShortcutHtml(
    shortcut: string,
    extraClass = '',
    extraAttrs = ''
): string {
    const classes = extraClass
        ? `keyboard-shortcut ${extraClass}`
        : 'keyboard-shortcut';
    const attrs = extraAttrs ? ` ${extraAttrs}` : '';
    return `<span class="${classes}"${attrs}>${formatShortcutHtml(shortcut)}</span>`;
}

/** Plain-text shortcut for native `title` attributes. */
export function formatPlainShortcut(shortcut: string): string {
    const command = usesCommandModifier()
        ? MENU_COMMAND_SYMBOL
        : CONTROL_KEY_SYMBOL;
    return shortcut.split(MENU_COMMAND_SYMBOL).join(command);
}

const HANDBOOK_TOKEN_TO_CHAR: Record<string, string> = {
    'Cmd/Ctrl': MENU_COMMAND_SYMBOL,
    'Cmd': MENU_COMMAND_SYMBOL,
    'Ctrl': MENU_COMMAND_SYMBOL,
    'Shift': MENU_SHIFT_SYMBOL,
    'Alt/Option': MENU_OPTION_SYMBOL,
    'Option': MENU_OPTION_SYMBOL,
    'Alt': MENU_OPTION_SYMBOL,
    'Enter': MENU_RETURN_SYMBOL,
    'Return': MENU_RETURN_SYMBOL,
    'Escape': 'Esc',
    'Esc': 'Esc'
};

/**
 * Convert handbook / tour shortcut text (`Cmd/Ctrl+Shift+O`) to the compact
 * spec consumed by `formatShortcutHtml`. Returns null when `raw` is not an
 * OS modifier chord (tool letters, `print()`, etc.).
 */
export function shortcutSpecFromHandbook(raw: string): string | null {
    const trimmed = raw.trim();
    if (
        !trimmed.startsWith('Cmd/Ctrl') &&
        !trimmed.startsWith('Cmd+') &&
        !trimmed.startsWith('Ctrl+') &&
        trimmed !== 'Cmd/Ctrl' &&
        trimmed !== 'Cmd' &&
        trimmed !== 'Ctrl'
    ) {
        return null;
    }

    const parts = trimmed.split('+');
    let htmlSpec = '';
    for (const part of parts) {
        if (part === '') {
            htmlSpec += '+';
            continue;
        }
        htmlSpec += HANDBOOK_TOKEN_TO_CHAR[part] ?? part;
    }
    return htmlSpec;
}

export function hydrateKeyboardShortcuts(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>('[data-keyboard-shortcut]').forEach(
        (el) => {
            const spec = el.getAttribute('data-keyboard-shortcut') || '';
            el.innerHTML = formatShortcutHtml(spec);
            el.classList.add('keyboard-shortcut');
        }
    );
    root.querySelectorAll<HTMLElement>('[title]').forEach((el) => {
        const title = el.getAttribute('title');
        if (title && title.includes(MENU_COMMAND_SYMBOL)) {
            el.setAttribute('title', formatPlainShortcut(title));
        }
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            hydrateKeyboardShortcuts();
        });
    } else {
        hydrateKeyboardShortcuts();
    }
}
