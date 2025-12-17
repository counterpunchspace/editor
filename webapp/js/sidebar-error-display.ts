// Sidebar Error Display
// Shows/hides error messages in the right sidebar when font compilation fails

export class SidebarErrorDisplay {
    private rightSidebar: HTMLElement | null = null;
    private errorContainer: HTMLElement | null = null;
    private normalContent: HTMLElement[] = [];
    private initialized: boolean = false;

    constructor() {
        // Don't initialize here - wait until first use
    }

    private initialize() {
        if (this.initialized) {
            return;
        }

        // Get reference to right sidebar
        this.rightSidebar = document.getElementById('glyph-editor-sidebar');
        if (!this.rightSidebar) {
            console.warn('[SidebarError] Right sidebar not found yet');
            return;
        }

        // Create error container (hidden by default)
        this.errorContainer = document.createElement('div');
        this.errorContainer.id = 'sidebar-error-display';
        this.errorContainer.style.display = 'none';
        // this.errorContainer.style.padding = '20px';
        this.errorContainer.style.textAlign = 'center';
        this.errorContainer.style.color = 'var(--text-primary)';
        this.rightSidebar.appendChild(this.errorContainer);

        this.initialized = true;
        console.log('[SidebarError] Initialized successfully');
    }

    /**
     * Show error message and hide normal sidebar content
     */
    showError(errorMessage: string) {
        // Initialize on first use
        this.initialize();

        if (!this.rightSidebar || !this.errorContainer) {
            console.warn(
                '[SidebarError] Cannot show error - sidebar not available yet'
            );
            return;
        }

        console.log('[SidebarError] Showing error in sidebar');

        // Store references to normal content
        this.normalContent = Array.from(
            this.rightSidebar.children
        ) as HTMLElement[];

        // Hide all normal content
        this.normalContent.forEach((child) => {
            if (child !== this.errorContainer) {
                child.style.display = 'none';
            }
        });

        // Create error display
        this.errorContainer.innerHTML = `
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 16px;
                margin-top: 60px;
            ">
                <div style="
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    background-color: var(--bg-secondary);
                    border: 2px solid var(--border-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 32px;
                ">⚠️</div>
                
                <div style="
                    font-weight: 600;
                    font-size: 14px;
                    color: var(--text-primary);
                    text-align: center;
                ">Compilation Error</div>
                
                <div style="
                    font-size: 12px;
                    color: var(--text-secondary);
                    line-height: 1.5;
                    text-align: center;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                    hyphens: auto;
                ">»${this.formatErrorMessage(errorMessage)}«</div>
                
                <div style="
                    font-size: 12px;
                    color: var(--text-muted);
                    margin-top: 8px;
                    text-align: center;
                    line-height: 1.4;
                ">The font cannot be displayed until the compilation issue is resolved. Check the browser console for detailed error information.</div>
            </div>
        `;

        // Show error container
        this.errorContainer.style.display = 'block';
    }

    /**
     * Hide error message and restore normal sidebar content
     */
    hideError() {
        // Initialize if needed (in case hideError is called first)
        this.initialize();

        if (!this.rightSidebar || !this.errorContainer) {
            console.log(
                '[SidebarError] No error to hide (not initialized yet)'
            );
            return;
        }

        console.log('[SidebarError] Hiding error, restoring normal sidebar');

        // Hide error container
        this.errorContainer.style.display = 'none';

        // Restore all normal content
        this.normalContent.forEach((child) => {
            if (child !== this.errorContainer) {
                child.style.display = '';
            }
        });

        this.normalContent = [];
    }

    /**
     * Format and escape error message for display
     */
    private formatErrorMessage(text: string): string {
        // Escape HTML
        const escaped = this.escapeHtml(text);

        // // Simplify common error messages
        // if (escaped.includes('RuntimeError: unreachable')) {
        //     return 'Internal compilation error (WASM panic)';
        // }
        // if (escaped.includes('cycle or something')) {
        //     return 'Cyclic dependency detected in font structure';
        // }

        // Truncate very long messages
        if (escaped.length > 200) {
            return escaped.substring(0, 200) + '...';
        }

        return escaped;
    }

    /**
     * Escape HTML to prevent XSS
     */
    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Create global instance
export const sidebarErrorDisplay = new SidebarErrorDisplay();
