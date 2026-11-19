import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    openMemoryFont
} from './helpers/snapshot-helper';
import { waitForBridgeReady } from './helpers/change-bridge-cross-window';
import {
    glyphNodeX,
    gotoEditorPage,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';

/**
 * Post-deploy smoke for production: a real account (signed in with an emailed
 * code) loads the editor signed in, saves a font to the cloud and opens it
 * again in a fresh browser, which has to load it from the room. wait-for-stack.mjs
 * already checked every commit, the D1 schema and the room wiring. The
 * sessions script's cleanup mode removes the account and its fonts afterwards.
 * Not part of `npm run test:cloud-collab`.
 *   CLOUD_COLLAB_PRODUCT_SMOKE=1
 *   CLOUD_SMOKE_EDITOR_URL=https://editor.counterpunch.space
 *   CLOUD_SMOKE_SESSIONS_DIR=<dir with owner.json>
 *   npx playwright test --project=cloud-collab-product-smoke
 */
const editorOrigin = (process.env.CLOUD_SMOKE_EDITOR_URL || '').replace(
    /\/$/,
    ''
);
const sessionsDir = process.env.CLOUD_SMOKE_SESSIONS_DIR || '';

function uncaughtErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

test('a signed-in account saves a cloud font and opens it again', async ({
    browser
}) => {
    test.setTimeout(420000);
    expect(editorOrigin, 'CLOUD_SMOKE_EDITOR_URL').toContain('https://');
    const storageState = path.join(sessionsDir, 'owner.json');
    const saveContext = await browser.newContext({
        baseURL: editorOrigin,
        storageState
    });
    // Its own context, so nothing cached from the save: the font comes from the room.
    const openContext = await browser.newContext({
        baseURL: editorOrigin,
        storageState
    });
    try {
        const page = await saveContext.newPage();
        const errors = uncaughtErrors(page);
        await page.goto('/?test=true&examples=collab-fixtures');
        await waitForCanvasReady(page);
        await page.waitForFunction(
            () => (window as any).authManager?.isAuthenticated?.() === true,
            null,
            { timeout: 60000 }
        );
        await openMemoryFont(page, 'bbox.glyphs');
        await waitForOpenSessionReady(page, 'bbox.glyphs');
        await waitForBridgeReady(page);
        const assetId = await saveCurrentFontToCloud(
            page,
            `Production smoke ${Date.now()}`
        );
        await waitForCloudLiveIdle(page);
        const savedX = await glyphNodeX(page, 'A');

        const reopened = await openContext.newPage();
        const reopenErrors = uncaughtErrors(reopened);
        await gotoEditorPage(
            reopened,
            `/?test=true&file=${encodeURIComponent(`cloud:///${assetId}`)}`
        );
        await waitForCanvasReady(reopened);
        await waitForOpenSessionReady(reopened, assetId);
        await waitForBridgeReady(reopened);
        await waitForCloudLiveIdle(reopened);
        expect(await glyphNodeX(reopened, 'A')).toBe(savedX);
        expect(reopenErrors).toEqual([]);
        await openContext.close();

        await page.evaluate(async (id) => {
            await (window as any).cloudPlugin.deleteAsset(id);
        }, assetId);
        expect(errors).toEqual([]);
    } finally {
        await saveContext.close();
        await openContext.close();
    }
});
