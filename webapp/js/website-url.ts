export function resolveWebsiteURL(hostname?: string): string {
    const effectiveHostname = hostname ?? window.location.hostname;

    if (
        effectiveHostname === 'localhost' ||
        effectiveHostname === '127.0.0.1'
    ) {
        return 'https://localhost:8788';
    }

    if (effectiveHostname === 'preview.editor.counterpunch.space') {
        return 'https://preview.counterpunch.space';
    }

    return 'https://counterpunch.space';
}
