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

export function normalizeCloudShardHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const httpUrl = normalizeCloudRoomHttpUrl(roomUrl, websiteBaseUrl);
    const url = new URL(httpUrl);
    const shardPath = documentId.replace(/:/g, '/');
    url.pathname = `/room/${encodeURIComponent(assetId)}/shards/${shardPath}/state`;
    return url.toString();
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

export function normalizeCloudShardPackDiscardUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string
): string {
    const url = new URL(
        normalizeCloudShardPackUrl(roomUrl, websiteBaseUrl, assetId)
    );
    url.pathname = `/room/${encodeURIComponent(assetId)}/pack/discard`;
    return url.toString();
}

export function normalizeCloudShardLiveHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const url = new URL(
        normalizeCloudShardHttpUrl(roomUrl, websiteBaseUrl, assetId, documentId)
    );
    url.pathname = url.pathname.replace(/\/state$/, '/live');
    return url.toString();
}

export function normalizeCloudShardStatusHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const url = new URL(
        normalizeCloudShardHttpUrl(roomUrl, websiteBaseUrl, assetId, documentId)
    );
    url.pathname = url.pathname.replace(/\/state$/, '/status');
    return url.toString();
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
