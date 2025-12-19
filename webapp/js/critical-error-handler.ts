/**
 * Critical Error Handler
 * Displays blocking error messages that require user action
 *
 * Usage:
 * - Automatically triggered when WebAssembly memory allocation fails during Pyodide initialization
 * - Can be manually tested in the browser console:
 *   window.showCriticalError('Test Title', 'Test message', 'Test instructions')
 * - To simulate the WebAssembly error:
 *   const err = new RangeError('WebAssembly.Memory(): could not allocate memory');
 *   if (window.isWebAssemblyMemoryError(err)) { window.showCriticalError(...) }
 */

/**
 * Show a critical error overlay that blocks all interaction
 * @param title - Error title
 * @param message - Error message
 * @param instructions - Instructions for the user
 */
export function showCriticalError(
    title: string,
    message: string,
    instructions: string
): void {
    // Remove any existing critical error overlay
    const existing = document.getElementById('critical-error-overlay');
    if (existing) {
        existing.remove();
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'critical-error-overlay';
    overlay.innerHTML = `
        <div class="critical-error-content">
            <div class="critical-error-icon">⚠️</div>
            <h1 class="critical-error-title">${escapeHtml(title)}</h1>
            <p class="critical-error-message">${escapeHtml(message)}</p>
            <div class="critical-error-instructions">
                <p><strong>Required Action:</strong></p>
                <p>${escapeHtml(instructions)}</p>
            </div>
            <div class="critical-error-details">
                <p>This error typically occurs when the browser's WebAssembly memory limit has been reached.</p>
                <p>Closing all tabs and reopening them will free up the memory.</p>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Log the error
    console.error('[CriticalError]', title, message);
}

/**
 * Simple HTML escape to prevent XSS
 */
function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Check if an error is a WebAssembly memory allocation error
 */
export function isWebAssemblyMemoryError(error: Error): boolean {
    return (
        error instanceof RangeError &&
        (error.message.includes('could not allocate memory') ||
            error.message.includes('WebAssembly.Memory'))
    );
}

// Make functions available globally for testing and debugging
declare global {
    interface Window {
        showCriticalError: typeof showCriticalError;
        isWebAssemblyMemoryError: typeof isWebAssemblyMemoryError;
    }
}

window.showCriticalError = showCriticalError;
window.isWebAssemblyMemoryError = isWebAssemblyMemoryError;
