import { test, expect } from '@playwright/test';
import { glyphNodeX, nudgeGlyphNode } from './helpers/cloud-collab-e2e';

/**
 * Post-deploy smoke for the rooms a cutover just shipped.
 * Not part of `npm run test:cloud-collab`. Run with:
 *   CLOUD_COLLAB_PREVIEW_SMOKE=1
 *   CLOUD_COLLAB_PREVIEW_OWNER_STORAGE=/path/to/owner.json
 *   CLOUD_COLLAB_PREVIEW_INVITEE_STORAGE=/path/to/invitee.json
 *   CLOUD_COLLAB_PREVIEW_ASSET_URL=https://preview.editor.counterpunch.space/?file=cloud:///ASSET
 *   npm run test:cloud-collab-preview-smoke
 */
test('one nudge between two preview browsers, then the fixture asset is deleted', async ({
    browser
}) => {
    test.setTimeout(300000);
    const editorUrl = process.env.CLOUD_COLLAB_PREVIEW_ASSET_URL || '';
    const ownerStorage = process.env.CLOUD_COLLAB_PREVIEW_OWNER_STORAGE || '';
    const inviteeStorage =
        process.env.CLOUD_COLLAB_PREVIEW_INVITEE_STORAGE || '';
    expect(editorUrl, 'CLOUD_COLLAB_PREVIEW_ASSET_URL').toContain('http');
    expect(ownerStorage, 'CLOUD_COLLAB_PREVIEW_OWNER_STORAGE').not.toBe('');
    expect(inviteeStorage, 'CLOUD_COLLAB_PREVIEW_INVITEE_STORAGE').not.toBe('');

    const ownerContext = await browser.newContext({
        storageState: ownerStorage
    });
    const inviteeContext = await browser.newContext({
        storageState: inviteeStorage
    });
    const ownerPage = await ownerContext.newPage();
    const inviteePage = await inviteeContext.newPage();
    try {
        await ownerPage.goto(editorUrl);
        await inviteePage.goto(editorUrl);
        await ownerPage.waitForFunction(
            () => !!(window as any).currentFontModel?.findGlyph?.('a'),
            null,
            { timeout: 180000 }
        );
        await inviteePage.waitForFunction(
            () => !!(window as any).currentFontModel?.findGlyph?.('a'),
            null,
            { timeout: 180000 }
        );
        const before = await glyphNodeX(ownerPage, 'a');
        await nudgeGlyphNode(ownerPage, 'a', 7, 'Preview smoke nudge');
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 120000 })
            .toBe(before + 7);
        await ownerPage.evaluate(async () => {
            await (window as any).cloudPlugin.deleteAsset();
        });
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus !== 'connected',
            null,
            { timeout: 60000 }
        );
    } finally {
        await ownerContext.close();
        await inviteeContext.close();
    }
});
