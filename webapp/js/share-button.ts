// Share Button
// Handles share menu with options to copy URL or send by email

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme
} from './tippy-utils';

let shareMenuInstance: TippyInstance | null = null;

/**
 * Get the current URL for sharing
 */
function getCurrentUrl(): string {
    return window.location.href;
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('[ShareButton]', 'Failed to copy to clipboard:', err);
        return false;
    }
}

/**
 * Create HTML for share menu
 */
function createShareMenuHtml(): string {
    const fontName = (window as any).fontManager?.currentFont?.name || 'Font';

    return `
        <div class="plugin-menu">
            <div class="plugin-menu-item" data-action="copy-url">
                <span class="material-symbols-outlined">link</span>
                <span>Copy URL</span>
            </div>
            <div class="plugin-menu-item" data-action="email">
                <span class="material-symbols-outlined">email</span>
                <span>Send by Email</span>
            </div>
        </div>
    `;
}

/**
 * Open email client with pre-filled message
 */
function sendByEmail() {
    const url = getCurrentUrl();
    const fontManager = (window as any).fontManager;
    const currentFont = fontManager?.currentFont;
    const fontName = currentFont?.name || 'Font';
    const fontPath = currentFont?.path || 'Unknown';
    const pluginName = currentFont?.sourcePlugin?.getName() || 'Unknown';

    const subject = encodeURIComponent(`Check out this font: ${fontName}`);
    const body = encodeURIComponent(
        `I wanted to share this font with you:\n\n` +
            `Font: ${fontName}\n` +
            `Path: ${fontPath}\n` +
            `File Plugin: ${pluginName}\n\n` +
            `View and edit in Counterpunch Font Editor:\n` +
            `${url}\n\n` +
            `IMPORTANT: To open this font, you need to have the file at the same path (${fontPath}) in your "${pluginName}" file system. The URL only contains the editor state, not the font file itself.\n\n` +
            `Check out the font editor at https://counterpunch.space\n\n` +
            `Best regards`
    );

    const mailtoLink = `mailto:?subject=${subject}&body=${body}`;

    // Use hidden anchor element
    const anchor = document.createElement('a');
    anchor.href = mailtoLink;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    console.log('[ShareButton]', 'Opened email client');
}

/**
 * Initialize share button and menu
 */
export function initShareButton(): void {
    const shareButton = document.getElementById('share-btn');
    if (!shareButton) {
        console.error('[ShareButton]', 'Share button not found');
        return;
    }

    // Create backdrop
    const backdrop = getOrCreateBackdrop('share-menu-backdrop');

    // Create tippy menu
    shareMenuInstance = tippy(shareButton, {
        content: createShareMenuHtml(),
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
            // Setup click handler using event delegation (only once)
            instance.popper.addEventListener('click', async (e) => {
                const menuItem = (e.target as HTMLElement).closest(
                    '.plugin-menu-item'
                );
                if (!menuItem) return;

                const action = menuItem.getAttribute('data-action');

                // Hide menu and backdrop immediately
                instance.hide();
                backdrop.classList.remove('visible');

                switch (action) {
                    case 'copy-url':
                        {
                            const url = getCurrentUrl();
                            const success = await copyToClipboard(url);
                            if (success) {
                                console.log(
                                    '[ShareButton]',
                                    'URL copied to clipboard'
                                );
                            } else {
                                alert('Failed to copy URL to clipboard');
                            }
                        }
                        break;
                    case 'email':
                        sendByEmail();
                        break;
                }
            });
        }
    });

    // Add backdrop and keyboard support
    addTippyBackdropSupport(shareMenuInstance, backdrop, {
        targetElement: shareButton,
        activeClass: 'share-button-active'
    });

    // Click handler to toggle menu
    shareButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (shareMenuInstance?.state.isVisible) {
            shareMenuInstance.hide();
        } else {
            shareMenuInstance?.show();
        }
    });

    // Set up backdrop click handler
    const handleBackdropClick = () => {
        if (shareMenuInstance?.state.isVisible) {
            shareMenuInstance.hide();
        }
    };

    backdrop.addEventListener('click', handleBackdropClick);
    (backdrop as any)._clickHandler = handleBackdropClick;

    console.log('[ShareButton]', 'Share button initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShareButton);
} else {
    initShareButton();
}
