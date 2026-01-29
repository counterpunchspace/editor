/**
 * Tippy.js Utilities
 * Shared utilities for tippy menus across the application
 */

/**
 * Create or get a backdrop element for modal-like menu behavior
 */
export function getOrCreateBackdrop(className: string): HTMLElement {
    let backdrop = document.querySelector(`.${className}`) as HTMLElement;
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = `plugin-menu-backdrop ${className}`;
        document.body.appendChild(backdrop);
    }
    return backdrop;
}

/**
 * Get current theme for tippy menus
 */
export function getTheme(): string {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    return theme === 'light' ? 'light' : 'dark';
}

/**
 * Add backdrop and keyboard support to a Tippy instance
 */
export function addTippyBackdropSupport(
    tippyInstance: any,
    backdrop: HTMLElement,
    options?: {
        onEscape?: () => void;
        targetElement?: HTMLElement;
        activeClass?: string;
    }
): void {
    const originalOnShow = tippyInstance.props.onShow;
    const originalOnShown = tippyInstance.props.onShown;
    const originalOnHide = tippyInstance.props.onHide;

    // Add backdrop click handler to close menu
    const handleBackdropClick = () => {
        if (tippyInstance.state.isVisible) {
            tippyInstance.hide();
        }
    };

    tippyInstance.setProps({
        onShow: (instance: any) => {
            backdrop.classList.add('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.add(options.activeClass);
            }

            // Add backdrop click handler
            backdrop.addEventListener('click', handleBackdropClick);

            if (originalOnShow) originalOnShow(instance);
        },
        onShown: (instance: any) => {
            // Add keyboard support
            const handleKeydown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    instance.hide();
                    if (options?.onEscape) options.onEscape();
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);
            (instance as any)._keydownHandler = handleKeydown;

            if (originalOnShown) originalOnShown(instance);
        },
        onHide: (instance: any) => {
            backdrop.classList.remove('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.remove(options.activeClass);
            }

            // Clean up keyboard listener
            const handler = (instance as any)._keydownHandler;
            if (handler) {
                document.removeEventListener('keydown', handler);
            }

            // Remove backdrop click handler
            backdrop.removeEventListener('click', handleBackdropClick);

            if (originalOnHide) originalOnHide(instance);
        }
    });
}
