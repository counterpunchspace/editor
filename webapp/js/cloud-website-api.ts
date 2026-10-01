import { Logger } from './logger';

const console = new Logger('CloudWebsiteApi');

export function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

export async function cloudWebsiteFetch(
    url: string,
    init: RequestInit = {}
): Promise<Response> {
    const headers = getCloudRequestHeaders(
        (init.headers as Record<string, string> | undefined) || {}
    );
    try {
        return await fetch(url, {
            ...init,
            headers,
            credentials: init.credentials ?? 'include',
            cache: init.cache ?? 'no-store'
        });
    } catch (error) {
        console.warn('Cloud website fetch failed', url, error);
        throw error;
    }
}
