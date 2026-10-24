import path from 'node:path';
import { test, expect } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

/**
 * Minimal post-deploy smoke for production: a real magic-link account loads
 * the editor signed in. wait-for-stack.mjs already checked every commit, the
 * D1 schema and the room wiring. Not part of `npm run test:cloud-collab`.
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

test('a signed-in account loads the editor without page errors', async ({
    browser
}) => {
    test.setTimeout(300000);
    expect(editorOrigin, 'CLOUD_SMOKE_EDITOR_URL').toContain('https://');
    const context = await browser.newContext({
        baseURL: editorOrigin,
        storageState: path.join(sessionsDir, 'owner.json')
    });
    try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('/');
        await waitForCanvasReady(page);
        await page.waitForFunction(
            () => (window as any).authManager?.isAuthenticated?.() === true,
            null,
            { timeout: 60000 }
        );
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
});
