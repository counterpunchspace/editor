import { expect } from '../fixtures';
import { type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    openFileFromFilesView
} from './snapshot-helper';
import { waitForBridgeReady } from './change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cloudCollabOperatorBrowserHeaders,
    makeCloudCollabEmails
} from './cloud-collab-session';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    assertServiceReachable,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './cloud-collab-e2e';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type RoomCensus = {
    ok?: boolean;
    tables: Record<string, number>;
    keys: string[];
    alarm: number | null;
    sockets: number;
};
export type Census = {
    d1: Record<string, number>;
    r2: { count: number; keys: string[] };
    rooms: Record<string, RoomCensus>;
};
// The tombstone is the receipt of the delete and is kept on purpose.
const RETAINED_TABLES = new Set(['font_asset_tombstones']);

export async function api<T>(
    page: Page,
    method: string,
    path: string,
    body?: unknown
): Promise<{ status: number; json: T }> {
    const operatorAuthorization =
        cloudCollabOperatorBrowserHeaders()['X-Counterpunch-E2E-Operator'] ||
        '';
    return page.evaluate(
        async ({
            method,
            path,
            body,
            operatorAuthorization: authorization
        }) => {
            const base = String(
                (window as any).authManager?.websiteURL || ''
            ).replace(/\/$/, '');
            const response = await fetch(`${base}${path}`, {
                method,
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authorization
                        ? { 'X-Counterpunch-E2E-Operator': authorization }
                        : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            return {
                status: response.status,
                json: await response.json().catch(() => ({}))
            };
        },
        { method, path, body, operatorAuthorization }
    ) as Promise<{ status: number; json: T }>;
}

export async function census(
    page: Page,
    assetId: string,
    rooms: string[],
    prefix?: string
): Promise<Census> {
    const query = new URLSearchParams({ rooms: rooms.join(',') });
    if (prefix) query.set('prefix', prefix);
    const result = await api<Census>(
        page,
        'GET',
        `/api/dev/cloud/asset-census/${encodeURIComponent(assetId)}?${query}`
    );
    expect(result.status).toBe(200);
    return result.json;
}

export function d1Total(c: Census): number {
    return Object.entries(c.d1)
        .filter(([table]) => !RETAINED_TABLES.has(table))
        .reduce((sum, [, count]) => sum + count, 0);
}

// workerd bookkeeping that exists for every Durable Object that was touched.
const RUNTIME_TABLES = new Set(['__miniflare_do_name']);

export function roomIsEmpty(room: RoomCensus): boolean {
    return (
        Object.entries(room.tables)
            .filter(([table]) => !RUNTIME_TABLES.has(table))
            .every(([, count]) => count === 0) &&
        room.keys.length === 0 &&
        room.alarm === null
    );
}

export function roomHasData(room: RoomCensus): boolean {
    return Object.entries(room.tables).some(
        ([table, count]) => !RUNTIME_TABLES.has(table) && count > 0
    );
}

/**
 * The undo window must keep every object that existed at the baseline.
 * The delete's own checkpoint can land after that census, so the count
 * may rise. A purge would drop a key or shrink the count.
 */
export function expectR2ObjectsKept(before: Census, after: Census): void {
    expect(after.r2.count).toBeGreaterThanOrEqual(before.r2.count);
    const kept = new Set(after.r2.keys);
    for (const key of before.r2.keys) {
        expect(kept.has(key), key).toBe(true);
    }
}

export async function openAndSaveFustat(
    page: Page,
    name: string
): Promise<string> {
    await page.goto('/?test=true&examples=core');
    await waitForCanvasReady(page);
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForBridgeReady(page);
    const assetId = await saveCurrentFontToCloud(page, name);
    await waitForCloudLiveIdle(page, 120000);
    return assetId;
}

export async function glyphRecords(
    page: Page
): Promise<Array<{ id: string; name: string }>> {
    return page.evaluate(() => {
        const json = (window as any).cloudPlugin._currentFontJson();
        return (json.glyphs as any[]).map((glyph) => ({
            id: String(glyph.id),
            name: String(glyph.name)
        }));
    });
}

export async function startSession(browser: any, request: any, runId: string) {
    const emails = makeCloudCollabEmails(runId);
    const session = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const context = await browser.newContext();
    await attachCloudCollabCookies(context, session);
    const page = await context.newPage();
    return { emails, context, page };
}

export async function assertStack(request: any) {
    await assertServiceReachable(
        request,
        `${LOCAL_EDITOR_ORIGIN}/?test=true`,
        'Editor'
    );
    await assertServiceReachable(
        request,
        `${LOCAL_WEBSITE_ORIGIN}/`,
        'Website'
    );
    await assertServiceReachable(
        request,
        `${LOCAL_ROOM_ORIGIN}/`,
        'Collab room'
    );
}
