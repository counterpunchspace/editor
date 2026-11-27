import {
    CloudRoomHttpError,
    cloudRefusalFromBody,
    readRoomErrorBody,
    shouldRetryHydrateTransport
} from './cloud-adapter-support';

export function withCloudAccessToken(wsUrl: string, token: string): string {
    if (!token) {
        return wsUrl;
    }
    const url = new URL(wsUrl);
    url.searchParams.set('access_token', token);
    return url.toString();
}

export function normalizeCloudRoomWebSocketUrl(
    roomUrl: string,
    websiteBaseUrl: string
): string {
    const trimmedRoomUrl = roomUrl.trim();
    if (!trimmedRoomUrl) {
        throw new Error('room-token response returned an empty roomUrl');
    }

    let normalizedUrl: URL;

    try {
        if (/^wss?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (/^https?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (trimmedRoomUrl.startsWith('/')) {
            normalizedUrl = new URL(trimmedRoomUrl, websiteBaseUrl);
        } else {
            normalizedUrl = new URL(`https://${trimmedRoomUrl}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid room URL "${roomUrl}": ${message}`);
    }

    if (normalizedUrl.protocol === 'http:') {
        normalizedUrl.protocol = 'ws:';
    } else if (normalizedUrl.protocol === 'https:') {
        normalizedUrl.protocol = 'wss:';
    }

    if (!/^wss?:$/i.test(normalizedUrl.protocol)) {
        throw new Error(
            `Invalid room URL protocol for "${roomUrl}": ${normalizedUrl.protocol}`
        );
    }

    return normalizedUrl.toString();
}

/** Convert a room URL to its HTTP form for the /state endpoint. */
export function normalizeCloudRoomHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string
): string {
    const wsUrl = normalizeCloudRoomWebSocketUrl(roomUrl, websiteBaseUrl);
    const url = new URL(wsUrl);
    if (url.protocol === 'ws:') {
        url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
        url.protocol = 'https:';
    }
    url.pathname = url.pathname.replace(/\/$/, '') + '/state';
    return url.toString();
}

function normalizeCloudShardEndpointUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string,
    suffix: string
): string {
    const httpUrl = normalizeCloudRoomHttpUrl(roomUrl, websiteBaseUrl);
    const url = new URL(httpUrl);
    const shardPath = documentId.replace(/:/g, '/');
    url.pathname = `/room/${encodeURIComponent(assetId)}/shards/${shardPath}/${suffix}`;
    return url.toString();
}

export function normalizeCloudShardHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    return normalizeCloudShardEndpointUrl(
        roomUrl,
        websiteBaseUrl,
        assetId,
        documentId,
        'state'
    );
}

export function normalizeCloudShardPackUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string
): string {
    const httpUrl = normalizeCloudRoomHttpUrl(roomUrl, websiteBaseUrl);
    const url = new URL(httpUrl);
    url.pathname = `/room/${encodeURIComponent(assetId)}/pack`;
    return url.toString();
}

export function normalizeCloudShardLiveHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    return normalizeCloudShardEndpointUrl(
        roomUrl,
        websiteBaseUrl,
        assetId,
        documentId,
        'live'
    );
}

export function normalizeCloudShardStatusHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    return normalizeCloudShardEndpointUrl(
        roomUrl,
        websiteBaseUrl,
        assetId,
        documentId,
        'status'
    );
}

export function normalizeCloudShardWebSocketUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const wsUrl = normalizeCloudRoomWebSocketUrl(roomUrl, websiteBaseUrl);
    const url = new URL(wsUrl);
    const shardPath = documentId.replace(/:/g, '/');
    url.pathname = `/room/${encodeURIComponent(assetId)}/shards/${shardPath}`;
    return url.toString();
}

/**
 * One room's whole state (checkpoint folded with its live tail) over HTTP,
 * or null when the room has none.
 */
export async function fetchCloudDocumentState(options: {
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
}): Promise<Uint8Array | null> {
    return (await fetchCloudDocumentStateWithLogId(options))?.bytes ?? null;
}

/** The log id an `X-Checkpoint-Log-Id` header names, or null without one. */
export function checkpointLogIdFromHeaders(headers: Headers): number | null {
    const raw = headers.get('X-Checkpoint-Log-Id');
    if (raw === null || !/^\d+$/.test(raw.trim())) {
        return null;
    }
    const logId = Number(raw.trim());
    return Number.isSafeInteger(logId) ? logId : null;
}

/**
 * Like `fetchCloudDocumentState`, with the log id the state holds every row
 * through (`X-Checkpoint-Log-Id`), or null when the room named none.
 */
export async function fetchCloudDocumentStateWithLogId(options: {
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
}): Promise<{ bytes: Uint8Array; logId: number | null } | null> {
    const url = normalizeCloudShardHttpUrl(
        options.roomUrl,
        options.websiteBaseUrl,
        options.assetId,
        options.documentId
    );
    // A state the room is rebuilding or just replaced (503
    // `state_unavailable`, `state_superseded`) is asked for again;
    // `broken_journal` (500) is final.
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
        try {
            response = await fetch(url, {
                cache: 'no-store',
                headers: {
                    Authorization: `Bearer ${options.token}`,
                    Accept: 'application/octet-stream'
                }
            });
            if (response.ok || response.status === 404) {
                break;
            }
            const body = await readRoomErrorBody(response);
            const refusal = cloudRefusalFromBody(
                options.documentId,
                body,
                undefined
            );
            if (refusal) {
                throw refusal;
            }
            throw new CloudRoomHttpError(
                `loading ${options.documentId} failed: ${response.status}${typeof body?.code === 'string' ? ` ${body.code}` : ''}`,
                {
                    status: response.status,
                    code: body?.code,
                    retryable: body?.retryable
                }
            );
        } catch (error) {
            if (!shouldRetryHydrateTransport(error, false, attempt)) {
                throw error;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, 100 * 2 ** attempt)
            );
        }
    }
    if (response.status === 404) {
        return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 2
        ? { bytes, logId: checkpointLogIdFromHeaders(response.headers) }
        : null;
}
