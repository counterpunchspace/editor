import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    keyboardShortcutHtml,
    MENU_SHIFT_SYMBOL,
    pluginMenuSubmenuHtml,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';
import {
    openLinkedEditorWindow,
    triggerRedo,
    triggerUndo
} from './window-buttons';
import { exportBinaryFont, exportBinaryFontAs } from './binary-font-export';
import { fontDestinationPluginManager } from './font-destination-plugin-manager';
import { showFontDestinationPluginManager } from './font-destination-plugin-ui';
import {
    openRunPythonScriptDialog,
    reRunLastPythonScript,
    getLastRunPythonScript
} from './run-python-script-dialog';
import './add-glyphs-dialog';
import './rename-glyphs-dialog';
import './delete-glyphs-dialog';
import './kerning-editor-dialog';
import { canDeleteSelectedGlyphs } from './delete-glyphs-dialog';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { openConvertToCounterpunchDialog } from './convert-to-counterpunch-dialog';
import { openTourIntro } from './tour';
import { isTourKeyEventAllowed } from './tour-spotlight';

const console = new Logger('ToolbarMenus');

type ToolbarMenuItem = {
    label: string;
    icon: string;
    shortcut?: string;
    disabled?: boolean;
    separator?: boolean;
    children?: ToolbarMenuItem[];
    action?: () => Promise<void>;
};

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function createMenuItemsHtml(items: ToolbarMenuItem[], prefix = ''): string {
    return items
        .map((item, index) => {
            if (item.separator) {
                return '<div class="plugin-menu-separator"></div>';
            }

            const menuId = `${prefix}${index}`;

            const disabledClass = item.disabled ? ' disabled' : '';
            const submenuClass = item.children ? ' has-submenu' : '';
            const renderedShortcut = item.shortcut
                ? keyboardShortcutHtml(item.shortcut, 'plugin-menu-shortcut')
                : '';
            const renderedSubmenu = item.children
                ? pluginMenuSubmenuHtml(
                      createMenuItemsHtml(item.children, `${menuId}.`)
                  )
                : '';

            const iconHtml = `<span class="material-symbols-outlined">${escapeHtml(item.icon)}</span>`;

            const submenuAria = item.children ? ' aria-expanded="false"' : '';
            return `
                <div class="plugin-menu-item toolbar-menu-item${disabledClass}${submenuClass}" data-menu-id="${menuId}" data-label="${escapeHtml(item.label)}"${submenuAria}>
                    ${iconHtml}
                    <span>${escapeHtml(item.label)}</span>
                    ${renderedShortcut}
                    ${renderedSubmenu}
                </div>
            `;
        })
        .join('');
}

function createMenuHtml(items: ToolbarMenuItem[], prefix = ''): string {
    return `<div class="plugin-menu toolbar-menu">${createMenuItemsHtml(items, prefix)}</div>`;
}

function getItemByMenuId(
    items: ToolbarMenuItem[],
    menuId: string
): ToolbarMenuItem | null {
    let current: ToolbarMenuItem | undefined;
    let currentItems = items;
    for (const segment of menuId.split('.')) {
        current = currentItems[Number(segment)];
        if (!current) {
            return null;
        }
        currentItems = current.children || [];
    }
    return current || null;
}

function bindToolbarMenuKeyboardNav(instance: TippyInstance): void {
    const menu = instance.popper.querySelector('.toolbar-menu');
    if (menu) {
        setupMenuKeyboardNav(menu);
    }
}

function getFileMenuItems(): ToolbarMenuItem[] {
    const saveButton = window.saveButton;
    const hasFontOpen = !!window.fontManager?.currentFont;

    const items: ToolbarMenuItem[] = [];

    items.push(
        {
            label: 'New',
            icon: 'note_add',
            action: async () => {
                await window.fontManager?.handleNewFont?.();
            }
        },
        {
            label: 'Open…',
            icon: 'folder_open',
            shortcut: '⌘O',
            action: async () => {
                await window.showFontFileDialog?.({ mode: 'open' });
            }
        },
        {
            label: 'Save',
            icon: 'save',
            shortcut: '⌘S',
            disabled: !saveButton?.canSave?.(),
            action: async () => {
                await saveButton?.handleSave?.();
            }
        },
        {
            label: 'Save As…',
            icon: 'save_as',
            shortcut: `⌘${MENU_SHIFT_SYMBOL}S`,
            disabled: !saveButton?.canSaveAs?.(),
            action: async () => {
                await window.showFontFileDialog?.({ mode: 'save-as' });
            }
        },
        {
            label: 'Export binary font',
            icon: 'download',
            shortcut: '⌘E',
            disabled: !hasFontOpen,
            action: exportBinaryFont
        },
        {
            label: 'Export binary font as…',
            icon: 'save_as',
            shortcut: `⌘${MENU_SHIFT_SYMBOL}E`,
            disabled: !hasFontOpen,
            action: exportBinaryFontAs
        }
    );

    return items;
}

function getEditMenuItems(): ToolbarMenuItem[] {
    const hasFontOpen = !!window.fontManager?.currentFont;
    const hasGlyphSelection =
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
        0;
    const canReplaceSelectedPaths = canReplaceSelectedPathsInPlace();
    const canCopy = !!window.glyphCanvas?.canCopyFocusedClipboardSelection?.();
    const canCut = !!window.glyphCanvas?.canCutFocusedClipboardSelection?.();
    const canPaste = !!window.glyphCanvas?.canPasteFocusedClipboard?.();

    return [
        {
            label: 'Undo',
            icon: 'undo',
            shortcut: '⌘Z',
            disabled: !hasFontOpen,
            action: triggerUndo
        },
        {
            label: 'Redo',
            icon: 'redo',
            shortcut: `⌘${MENU_SHIFT_SYMBOL}Z`,
            disabled: !hasFontOpen,
            action: triggerRedo
        },
        { label: '', icon: '', separator: true },
        {
            label: 'Copy',
            icon: 'content_copy',
            shortcut: '⌘C',
            disabled: !canCopy,
            action: async () => {
                window.glyphCanvas?.copyFocusedClipboardSelection?.();
            }
        },
        {
            label: 'Paste',
            icon: 'content_paste',
            shortcut: '⌘V',
            disabled: !canPaste,
            action: async () => {
                await window.glyphCanvas?.pasteFocusedClipboard?.();
            }
        },
        {
            label: 'Cut',
            icon: 'content_cut',
            shortcut: '⌘X',
            disabled: !canCut,
            action: async () => {
                await window.glyphCanvas?.cutFocusedClipboardSelection?.();
            }
        },
        { label: '', icon: '', separator: true },
        {
            label: 'Replace Path(s) In-Place',
            icon: 'swap_horiz',
            disabled: !canReplaceSelectedPaths,
            action: async () => {
                await window.glyphCanvas?.outlineEditor?.replaceSelectedPathsInPlace?.();
            }
        },
        {
            label: 'Rename Glyph(s)…',
            icon: 'edit',
            shortcut: `⌘${MENU_SHIFT_SYMBOL}F`,
            disabled: !hasFontOpen || !hasGlyphSelection,
            action: async () => {
                window.renameGlyphsDialog?.open();
            }
        },
        {
            label: 'Delete Glyph(s)',
            icon: 'delete',
            shortcut: '⌫',
            disabled: !canDeleteSelectedGlyphs(),
            action: async () => {
                window.deleteGlyphsDialog?.open();
            }
        }
    ];
}

function canReplaceSelectedPathsInPlace(): boolean {
    const canvas = window.glyphCanvas;
    const outlineEditor = canvas?.outlineEditor;
    if (!outlineEditor?.active) {
        return false;
    }
    const editorFocused = !!document
        .getElementById('view-editor')
        ?.classList.contains('focused');
    if (!editorFocused) {
        return false;
    }
    const selectedPoints = outlineEditor.selectedPoints;
    if (!Array.isArray(selectedPoints) || selectedPoints.length === 0) {
        return false;
    }
    return true;
}

function getFontMenuItems(): ToolbarMenuItem[] {
    const hasFontOpen = !!window.fontManager?.currentFont;
    const hasGlyphSelection =
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
        0;
    return [
        {
            label: 'Add Glyph(s)…',
            icon: 'add_circle',
            shortcut: `⌘${MENU_SHIFT_SYMBOL}G`,
            disabled: !hasFontOpen,
            action: async () => {
                await window.addGlyphsDialog?.open();
            }
        },
        {
            label: 'Duplicate Glyph(s)',
            icon: 'content_copy',
            shortcut: '⌘D',
            disabled: !hasFontOpen || !hasGlyphSelection,
            action: async () => {
                window.glyphOverviewInstance?.duplicateSelectedGlyphs?.();
            }
        },
        {
            label: 'Kerning Editor…',
            icon: 'space_bar',
            disabled: !hasFontOpen,
            action: async () => {
                window.kerningEditorDialog?.open();
            }
        },
        {
            label: 'Convert to Counterpunch…',
            icon: 'sync',
            disabled: !hasFontOpen,
            action: async () => {
                openConvertToCounterpunchDialog();
            }
        }
    ];
}

function getWindowMenuItems(): ToolbarMenuItem[] {
    return [
        {
            label: 'Open In New Window',
            icon: 'open_in_new',
            action: async () => {
                openLinkedEditorWindow();
            }
        }
    ];
}

function getToolsMenuItems(): ToolbarMenuItem[] {
    const destinations =
        fontDestinationPluginManager.getInstalledDestinations();
    const items: ToolbarMenuItem[] = [
        {
            label: 'Plugin Manager',
            icon: 'extension',
            action: showFontDestinationPluginManager
        }
    ];

    if (destinations.length) {
        items.push({ label: '', icon: '', separator: true });
        items.push({
            label: 'Font Destinations',
            icon: 'send',
            children: destinations.map((destination) => ({
                label: destination.name,
                icon: 'open_in_new',
                action: async () => {
                    fontDestinationPluginManager.openDestination(destination);
                }
            }))
        });
    }

    items.push({ label: '', icon: '', separator: true });
    items.push({
        label: 'Run Python Script',
        icon: 'play_arrow',
        shortcut: '⌘R',
        action: async () => {
            await openRunPythonScriptDialog();
        }
    });

    const lastRun = getLastRunPythonScript();
    if (lastRun) {
        items.push({
            label: `Re-run ${lastRun.title}`,
            icon: 'replay',
            shortcut: '⌘⌥R',
            action: async () => {
                await reRunLastPythonScript();
            }
        });
    }

    return items;
}

function isCurrentFontCloudBacked(): boolean {
    return window.fontManager?.currentFont?.isCloudBacked?.() === true;
}

function rebuildFontDepsMenuItem(): ToolbarMenuItem {
    return {
        label: 'Rebuild Font-Deps',
        icon: 'account_tree',
        action: async () => {
            if (!window.cloudPlugin) {
                alert('Cloud plugin is not available.');
                return;
            }
            window.cloudPlugin.rebuildFontDepsFromLoadedGlyphs();
        }
    };
}

function getDeveloperMenuItems(): ToolbarMenuItem[] {
    const items: ToolbarMenuItem[] = [];

    if (window.cloudPlugin?.isVisibleInUI?.() !== false) {
        items.push({
            label: 'Copy Cloud Debug Snapshot',
            icon: 'content_copy',
            action: async () => {
                if (!window.cloudPlugin) {
                    alert('Cloud plugin is not available.');
                    return;
                }

                await window.cloudPlugin.copyCloudDebugSnapshot();
            }
        });
    }

    if (isCurrentFontCloudBacked()) {
        items.push(rebuildFontDepsMenuItem());
    }

    items.push({
        label: 'Copy History Items (Debug)',
        icon: 'content_copy',
        action: async () => {
            const engine = window.patchSyncEngine;
            if (!engine) {
                alert('Patch sync engine is not available.');
                return;
            }

            const items = engine.getCollaborationLog();
            if (!items.length) {
                alert('No history items to copy.');
                return;
            }

            const text = JSON.stringify(items, null, 2);
            try {
                await navigator.clipboard.writeText(text);
            } catch (error) {
                console.error(
                    'Failed to copy history items to clipboard:',
                    error
                );
                alert('Clipboard access failed while copying history items.');
                throw error;
            }
        }
    });

    return items;
}

let privacyPolicyEscapeBinding: ModalEscapeBinding | null = null;

function closePrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    privacyPolicyEscapeBinding?.release();
    privacyPolicyEscapeBinding = null;
    if (modal) {
        modal.style.display = 'none';
    }
}

function openPrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    if (!modal) {
        return;
    }
    modal.style.display = 'flex';
    if (!privacyPolicyEscapeBinding) {
        privacyPolicyEscapeBinding = bindModalEscape(closePrivacyPolicyModal, {
            isOpen: () =>
                document.getElementById('privacy-policy-modal')?.style
                    .display === 'flex'
        });
    }
}

function getHelpMenuItems(): ToolbarMenuItem[] {
    return [
        {
            label: 'Take a Tour',
            icon: 'tour',
            action: async () => {
                openTourIntro();
            }
        },
        {
            label: 'Documentation',
            icon: 'menu_book',
            action: async () => {
                window.openDocs?.();
            }
        },
        {
            label: 'Keyboard Shortcuts',
            icon: 'keyboard',
            action: async () => {
                window.openDocs?.('reference/keyboard-shortcuts');
            }
        },
        {
            label: 'Privacy Policy',
            icon: 'privacy_tip',
            action: async () => {
                openPrivacyPolicyModal();
            }
        }
    ];
}

type ToolbarMenuEntry = {
    button: HTMLElement;
    instance: TippyInstance;
};

const toolbarMenus: ToolbarMenuEntry[] = [];

function isAnyToolbarMenuOpen(): boolean {
    return toolbarMenus.some((entry) => entry.instance.state.isVisible);
}

function showToolbarMenu(target: ToolbarMenuEntry): void {
    for (const entry of toolbarMenus) {
        if (entry !== target && entry.instance.state.isVisible) {
            entry.instance.hide();
        }
    }
    if (!target.instance.state.isVisible) {
        target.instance.show();
    }
}

function createToolbarMenu(
    buttonId: string,
    backdropClassName: string,
    itemFactory: () => ToolbarMenuItem[],
    refresh?: () => Promise<void>
): void {
    const button = document.getElementById(buttonId) as HTMLElement | null;
    if (!button) {
        return;
    }
    button.removeAttribute('title');

    const backdrop = getOrCreateBackdrop(backdropClassName);
    // Latest items for delegated clicks — updated every time the menu opens.
    let currentItems: ToolbarMenuItem[] = itemFactory();
    let clickHandlerBound = false;

    const instance = tippy(button, {
        content: createMenuHtml(currentItems),
        allowHTML: true,
        trigger: 'manual',
        interactive: true,
        placement: 'bottom-start',
        theme: getTheme(),
        arrow: false,
        offset: [0, 4],
        hideOnClick: false,
        appendTo: () => document.body,
        zIndex: 10001,
        onShow: (currentInstance) => {
            currentItems = itemFactory();
            currentInstance.setContent(createMenuHtml(currentItems));
            // Bind delegated click handling once on the tippy popper. Attaching
            // per-item listeners on every show stacked handlers on reused nodes
            // and queued duplicate alerts (e.g. Replace Path(s) In-Place errors).
            if (!clickHandlerBound) {
                clickHandlerBound = true;
                currentInstance.popper.addEventListener('click', (event) => {
                    const target = event.target as HTMLElement | null;
                    const element = target?.closest(
                        '.toolbar-menu-item'
                    ) as HTMLElement | null;
                    if (
                        !element ||
                        !currentInstance.popper.contains(element) ||
                        element.classList.contains('disabled')
                    ) {
                        return;
                    }
                    const item = getItemByMenuId(
                        currentItems,
                        element.dataset.menuId || ''
                    );
                    if (!item) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    if (item.children) {
                        const isOpen = element.classList.toggle('submenu-open');
                        element.setAttribute('aria-expanded', String(isOpen));
                        return;
                    }
                    currentInstance.hide();
                    void item.action?.();
                });
            }
            window.requestAnimationFrame(() =>
                bindToolbarMenuKeyboardNav(currentInstance)
            );
            if (refresh) {
                void refresh().then(() => {
                    if (!currentInstance.state.isVisible) {
                        return;
                    }
                    currentItems = itemFactory();
                    currentInstance.setContent(createMenuHtml(currentItems));
                    window.requestAnimationFrame(() =>
                        bindToolbarMenuKeyboardNav(currentInstance)
                    );
                });
            }
        }
    });

    addTippyBackdropSupport(instance, backdrop, {
        targetElement: button,
        activeClass: 'menu-active'
    });

    const entry: ToolbarMenuEntry = { button, instance };
    toolbarMenus.push(entry);

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (instance.state.isVisible) {
            instance.hide();
        } else {
            showToolbarMenu(entry);
        }
    });

    button.addEventListener('mouseenter', () => {
        if (!isAnyToolbarMenuOpen() || instance.state.isVisible) {
            return;
        }
        showToolbarMenu(entry);
    });
}

function setupPrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    const closeBtn = document.getElementById('privacy-policy-modal-close-btn');
    if (!modal) return;

    closeBtn?.addEventListener('click', closePrivacyPolicyModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closePrivacyPolicyModal();
    });
}

function installGlobalShortcuts(): void {
    document.addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }
            if (!isTourKeyEventAllowed(event)) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }

            const isMac = navigator.platform.toUpperCase().includes('MAC');
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            if (!cmdKey || event.altKey) {
                return;
            }

            const key = event.key.toLowerCase();
            if (!event.shiftKey && key === 'o') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'open' });
                return;
            }

            if (
                event.shiftKey &&
                key === 'g' &&
                window.fontManager?.currentFont
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.addGlyphsDialog?.open();
                return;
            }

            if (
                event.shiftKey &&
                key === 'f' &&
                window.fontManager?.currentFont &&
                (window.glyphOverviewInstance?.getSelectedGlyphNames?.()
                    .length || 0) > 0
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                window.renameGlyphsDialog?.open();
                return;
            }

            if (event.shiftKey && key === 's') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'save-as' });
                return;
            }

            if (key === 'e' && window.fontManager?.currentFont) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void (event.shiftKey
                    ? exportBinaryFontAs()
                    : exportBinaryFont());
            }
        },
        true
    );
}

function initToolbarMenus(): void {
    createToolbarMenu(
        'toolbar-file-menu-btn',
        'toolbar-file-menu-backdrop',
        getFileMenuItems
    );
    createToolbarMenu(
        'toolbar-edit-menu-btn',
        'toolbar-edit-menu-backdrop',
        getEditMenuItems,
        () =>
            window.glyphCanvas?.refreshClipboardPasteKind?.() ??
            Promise.resolve()
    );
    createToolbarMenu(
        'toolbar-font-menu-btn',
        'toolbar-font-menu-backdrop',
        getFontMenuItems
    );
    createToolbarMenu(
        'toolbar-window-menu-btn',
        'toolbar-window-menu-backdrop',
        getWindowMenuItems
    );
    createToolbarMenu(
        'toolbar-tools-menu-btn',
        'toolbar-tools-menu-backdrop',
        getToolsMenuItems,
        () => fontDestinationPluginManager.discoverInstalledDestinations()
    );
    if (window.isProduction?.()) {
        document.getElementById('toolbar-developer-menu-btn')?.remove();
    } else {
        createToolbarMenu(
            'toolbar-developer-menu-btn',
            'toolbar-developer-menu-backdrop',
            getDeveloperMenuItems
        );
    }
    createToolbarMenu(
        'toolbar-help-menu-btn',
        'toolbar-help-menu-backdrop',
        getHelpMenuItems
    );

    setupPrivacyPolicyModal();
    installGlobalShortcuts();

    console.log('[ToolbarMenus] Toolbar menus initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToolbarMenus);
} else {
    initToolbarMenus();
}
