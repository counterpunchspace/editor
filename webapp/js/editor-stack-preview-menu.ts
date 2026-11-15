import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    keyboardShortcutHtml,
    setupMenuKeyboardNav
} from './tippy-utils';
import {
    isOverviewFollowStackScrollEnabled,
    toggleOverviewFollowStackScrollEnabled
} from './glyph-overview-follow-stack-pref';
import {
    isShowAllMetricsEnabled,
    toggleShowAllMetricsEnabled
} from './show-all-metrics-pref';
import {
    isNodeSnappingEnabled,
    toggleNodeSnappingEnabled
} from './node-snapping-pref';
import {
    getPreviewArea,
    setPreviewArea,
    type PreviewArea
} from './editor-preview-area-pref';
import { createPathFillOpacityMenuControl } from './path-fill-opacity-pref';
import { Logger } from './logger';

const console = new Logger('EditorStackPreviewMenu');

let stackPreviewMenuInstance: TippyInstance | null = null;

function isEditorEditMode(): boolean {
    return !!window.glyphCanvas?.outlineEditor?.active;
}

function viewMenuItemClass(enabled: boolean): string {
    return enabled ? '' : ' disabled plugin-menu-item-disabled';
}

function viewMenuItemDisabledAttr(enabled: boolean): string {
    return enabled ? '' : ' aria-disabled="true"';
}

function updateStackPreviewButtonVisibility(button: HTMLElement): void {
    if (button instanceof HTMLButtonElement) {
        button.disabled = false;
    }
    button.removeAttribute('aria-disabled');
    button.classList.remove('inactive');
    button.style.display = 'flex';
}

export function createStackPreviewMenuHtml(): string {
    const isEditMode = isEditorEditMode();
    const stackPreviewActive =
        !!window.glyphCanvas?.stackPreviewAnimator?.isActive &&
        !window.glyphCanvas?.stackPreviewAnimator?.isReversing;
    const stackPreviewCheckmark = stackPreviewActive ? 'check' : '';
    const guidelinesVisible =
        window.glyphCanvas?.outlineEditor?.guidelinesVisible === true;
    const guidelinesCheckmark = guidelinesVisible ? 'check' : '';
    const pairedDrawingVisible =
        window.glyphCanvas?.outlineEditor?.isPairedDrawingVisible() ?? false;
    const pairedDrawingCheckmark = pairedDrawingVisible ? 'check' : '';
    const followStackScroll = isOverviewFollowStackScrollEnabled();
    const followStackCheckmark = followStackScroll ? 'check' : '';
    const showAllMetrics = isShowAllMetricsEnabled();
    const showAllMetricsCheckmark = showAllMetrics ? 'check' : '';
    const nodeSnapping = isNodeSnappingEnabled();
    const nodeSnappingCheckmark = nodeSnapping ? 'check' : '';
    const previewArea = getPreviewArea();
    const previewAreaSegment = (area: PreviewArea, label: string) =>
        `<button type="button" class="plugin-menu-segment${previewArea === area ? ' active' : ''}" data-preview-area="${area}" role="radio" aria-checked="${previewArea === area}">${label}</button>`;

    return `
        <div class="plugin-menu" tabindex="0" role="menu" aria-label="View menu">
            <div class="plugin-menu-setting">
                <span class="plugin-menu-setting-label">Preview Area</span>
                <div class="plugin-menu-segments" role="radiogroup" aria-label="Preview Area">
                    ${previewAreaSegment('small', 'Small')}
                    ${previewAreaSegment('medium', 'Medium')}
                    ${previewAreaSegment('full', 'Full')}
                </div>
            </div>
            <div class="plugin-menu-item" data-action="zoom-in" role="menuitem" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined empty"></span>
                <span>Zoom In</span>
                ${keyboardShortcutHtml('⌘+', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-item" data-action="zoom-out" role="menuitem" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined empty"></span>
                <span>Zoom Out</span>
                ${keyboardShortcutHtml('⌘-', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-item" data-action="zoom-to-fit" role="menuitem" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined empty"></span>
                <span>Zoom to Fit</span>
                ${keyboardShortcutHtml('⌘0 1-2×', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-separator"></div>
            <div class="plugin-menu-fill-host"></div>
            <div class="plugin-menu-separator"></div>
            <div class="plugin-menu-item${viewMenuItemClass(isEditMode)}" data-action="toggle-stack-preview" role="menuitemcheckbox" aria-checked="${stackPreviewActive}"${viewMenuItemDisabledAttr(isEditMode)} tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${stackPreviewActive ? '' : ' empty'}">${stackPreviewCheckmark}</span>
                <span>Stack Preview</span>
                ${keyboardShortcutHtml('⌘⌥S', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-item${viewMenuItemClass(isEditMode)}" data-action="toggle-guidelines" role="menuitemcheckbox" aria-checked="${guidelinesVisible}"${viewMenuItemDisabledAttr(isEditMode)} tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${guidelinesVisible ? '' : ' empty'}">${guidelinesCheckmark}</span>
                <span>Guidelines</span>
                ${keyboardShortcutHtml('⌘⌥G', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-item${viewMenuItemClass(isEditMode)}" data-action="toggle-paired-drawing" role="menuitemcheckbox" aria-checked="${pairedDrawingVisible}"${viewMenuItemDisabledAttr(isEditMode)} tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${pairedDrawingVisible ? '' : ' empty'}">${pairedDrawingCheckmark}</span>
                <span>Show Foreground/Background</span>
                ${keyboardShortcutHtml('⌘⌥B', 'plugin-menu-shortcut')}
            </div>
            <div class="plugin-menu-item${viewMenuItemClass(isEditMode)}" data-action="toggle-show-all-metrics" role="menuitemcheckbox" aria-checked="${showAllMetrics}"${viewMenuItemDisabledAttr(isEditMode)} tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${showAllMetrics ? '' : ' empty'}">${showAllMetricsCheckmark}</span>
                <span>Show All Metrics</span>
            </div>
            <div class="plugin-menu-item${viewMenuItemClass(isEditMode)}" data-action="toggle-node-snapping" role="menuitemcheckbox" aria-checked="${nodeSnapping}"${viewMenuItemDisabledAttr(isEditMode)} tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${nodeSnapping ? '' : ' empty'}">${nodeSnappingCheckmark}</span>
                <span>Node Snapping</span>
            </div>
            <div class="plugin-menu-item" data-action="toggle-follow-stack-scroll" role="menuitemcheckbox" aria-checked="${followStackScroll}" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${followStackScroll ? '' : ' empty'}">${followStackCheckmark}</span>
                <span>Scroll Overview to Active Glyph</span>
            </div>
        </div>
    `;
}

function mountViewMenuFillSlider(menuRoot: ParentNode | null): void {
    const host = menuRoot?.querySelector('.plugin-menu-fill-host');
    if (!(host instanceof HTMLElement)) {
        return;
    }
    host.replaceWith(
        createPathFillOpacityMenuControl({
            disabled: !isEditorEditMode()
        })
    );
}

function refreshStackPreviewMenuContent(): void {
    stackPreviewMenuInstance?.setContent(createStackPreviewMenuHtml());
    mountViewMenuFillSlider(stackPreviewMenuInstance?.popper ?? null);
}

function toggleStackPreview(): void {
    const glyphCanvas = window.glyphCanvas;
    if (!glyphCanvas) {
        return;
    }

    const animator = glyphCanvas.stackPreviewAnimator;
    if (!animator) {
        return;
    }

    if (animator.isInputBlocked()) {
        return;
    }

    if (animator.isActive && !animator.isAnimating) {
        animator.reverseAnimation();
        return;
    }

    const editorView = document.querySelector('#view-editor');
    const isEditorFocused =
        !!editorView && editorView.classList.contains('focused');

    if (isEditorFocused && glyphCanvas.outlineEditor.active) {
        animator.startAnimation();
    }
}

function initEditorStackPreviewMenu(): void {
    const menuButton = document.getElementById('editor-stack-preview-menu-btn');
    if (!menuButton) {
        return;
    }

    updateStackPreviewButtonVisibility(menuButton);

    const backdrop = getOrCreateBackdrop('editor-stack-preview-menu-backdrop');

    const tippyResult = tippy(menuButton, {
        content: createStackPreviewMenuHtml(),
        allowHTML: true,
        interactive: true,
        trigger: 'manual',
        theme: getTheme(),
        placement: 'bottom-end',
        arrow: false,
        offset: [0, 4],
        appendTo: document.body,
        hideOnClick: false,
        zIndex: 9999,
        onCreate: (instance) => {
            mountViewMenuFillSlider(instance.popper);
            instance.popper.addEventListener('click', (e) => {
                const segment = (e.target as HTMLElement).closest(
                    '.plugin-menu-segment'
                );
                if (segment) {
                    e.preventDefault();
                    e.stopPropagation();
                    const area = segment.getAttribute('data-preview-area');
                    if (
                        area === 'small' ||
                        area === 'medium' ||
                        area === 'full'
                    ) {
                        setPreviewArea(area);
                        refreshStackPreviewMenuContent();
                    }
                    return;
                }

                const item = (e.target as HTMLElement).closest(
                    '.plugin-menu-item'
                );
                if (!item) {
                    return;
                }
                if (
                    item.classList.contains('plugin-menu-item-disabled') ||
                    item.getAttribute('aria-disabled') === 'true'
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                const action = item.getAttribute('data-action');
                instance.hide();

                if (action === 'toggle-stack-preview') {
                    toggleStackPreview();
                } else if (action === 'toggle-guidelines') {
                    window.glyphCanvas?.outlineEditor?.toggleGuidelinesVisible();
                    refreshStackPreviewMenuContent();
                } else if (action === 'toggle-paired-drawing') {
                    window.glyphCanvas?.outlineEditor?.togglePairedDrawingVisible();
                    refreshStackPreviewMenuContent();
                } else if (action === 'toggle-follow-stack-scroll') {
                    toggleOverviewFollowStackScrollEnabled();
                    refreshStackPreviewMenuContent();
                } else if (action === 'toggle-show-all-metrics') {
                    toggleShowAllMetricsEnabled();
                    window.glyphCanvas?.render();
                    refreshStackPreviewMenuContent();
                } else if (action === 'toggle-node-snapping') {
                    toggleNodeSnappingEnabled();
                    window.glyphCanvas?.render();
                    refreshStackPreviewMenuContent();
                } else if (action === 'zoom-in') {
                    window.glyphCanvas?.startKeyboardZoom(true);
                } else if (action === 'zoom-out') {
                    window.glyphCanvas?.startKeyboardZoom(false);
                } else if (action === 'zoom-to-fit') {
                    window.glyphCanvas?.handleCmdZeroFit();
                }
            });
        },
        onShown: (instance) => {
            refreshStackPreviewMenuContent();
            const menu = instance.popper.querySelector('.plugin-menu');
            if (menu) {
                setupMenuKeyboardNav(
                    menu,
                    '.plugin-menu-item:not(.plugin-menu-item-disabled)'
                );
            }
        },
        onHide: () => {
            window.glyphCanvas?.restoreCanvasKeyboardFocus();
        }
    });

    stackPreviewMenuInstance = Array.isArray(tippyResult)
        ? (tippyResult[0] ?? null)
        : tippyResult;

    addTippyBackdropSupport(stackPreviewMenuInstance, backdrop, {
        targetElement: menuButton,
        activeClass: 'editor-stack-preview-menu-active'
    });

    menuButton.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        if (stackPreviewMenuInstance?.state.isVisible) {
            stackPreviewMenuInstance.hide();
        } else {
            refreshStackPreviewMenuContent();
            stackPreviewMenuInstance?.show();
        }
    });

    window.addEventListener('editorModeChanged', () => {
        updateStackPreviewButtonVisibility(menuButton);
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('outlineGuidelinesVisibilityChanged', () => {
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('outlinePairedDrawingVisibilityChanged', () => {
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('overviewFollowStackScrollChanged', () => {
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('showAllMetricsChanged', () => {
        refreshStackPreviewMenuContent();
        window.glyphCanvas?.render();
    });

    window.addEventListener('nodeSnappingChanged', () => {
        refreshStackPreviewMenuContent();
        window.glyphCanvas?.render();
    });

    window.addEventListener('editorPreviewAreaChanged', () => {
        refreshStackPreviewMenuContent();
    });

    console.log('Stack preview menu initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEditorStackPreviewMenu);
} else {
    initEditorStackPreviewMenu();
}
