import { getCloudRequestHeaders } from './cloud-website-api';

export const CLOUD_DELETE_MAX_MS = 15 * 60 * 1000;
const POLL_DELAY_MS = 150;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 5;

export interface DeleteCloudAssetOptions {
    websiteBaseUrl: string;
    assetId: string;
    maxMs?: number;
    pollDelayMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/**
 * Deletes a cloud asset. The server purges in bounded batches (rooms, then R2
 * objects, then D1 rows) and answers `complete: false` until it is done, so
 * the client keeps calling until the server reports completion. Gives up only
 * on a server error, repeated transport failures, or when the time budget is
 * spent (the hourly cron then finishes the purge).
 */
export async function deleteCloudAssetUntilComplete(
    options: DeleteCloudAssetOptions
): Promise<void> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep =
        options.sleep ??
        ((ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    const deadline = now() + (options.maxMs ?? CLOUD_DELETE_MAX_MS);
    const url = `${options.websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(options.assetId)}`;
    let transportFailures = 0;
    for (let attempt = 0; now() < deadline; attempt += 1) {
        if (attempt > 0) {
            await sleep(options.pollDelayMs ?? POLL_DELAY_MS);
        }
        let resp: Response;
        try {
            resp = await fetchImpl(url, {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: '{}'
            });
        } catch (error) {
            transportFailures += 1;
            if (transportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
                throw error;
            }
            continue;
        }
        transportFailures = 0;
        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            complete?: boolean;
            success?: boolean;
        };
        if (!resp.ok && resp.status !== 202) {
            throw new Error(
                data.error || `Failed to delete cloud asset (${resp.status})`
            );
        }
        if (data.complete !== false) {
            return;
        }
    }
    throw new Error(
        'Cloud delete is still running on the server; it will finish in the background'
    );
}
