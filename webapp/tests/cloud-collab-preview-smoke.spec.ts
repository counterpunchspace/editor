import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    openMemoryFont
} from './helpers/snapshot-helper';
import {
    alignEditorCanvas,
    waitForBridgeReady
} from './helpers/change-bridge-cross-window';
import {
    acceptCloudInviteAndGetEditorHref,
    editorHrefWithTestMode,
    glyphNodeX,
    gotoEditorPage,
    nudgeGlyphNode,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';

/**
 * Post-deploy smoke for the preview stack a cutover just shipped, with real
 * real sign-in-code accounts from website/scripts/e2e-product-sessions.mjs.
 * Not part of `npm run test:cloud-collab`. Run with:
 *   CLOUD_COLLAB_PREVIEW_SMOKE=1
 *   CLOUD_SMOKE_EDITOR_URL=https://preview.editor.counterpunch.space
 *   CLOUD_SMOKE_WEBSITE_URL=https://preview.counterpunch.space
 *   CLOUD_SMOKE_SESSIONS_DIR=<dir with owner.json, invitee.json, sessions.json>
 *   npm run test:cloud-collab-preview-smoke
 * The sessions script's cleanup mode removes the accounts and fonts afterwards.
 */
const editorOrigin = (process.env.CLOUD_SMOKE_EDITOR_URL || '').replace(
    /\/$/,
    ''
);
const websiteOrigin = (process.env.CLOUD_SMOKE_WEBSITE_URL || '').replace(
    /\/$/,
    ''
);
const sessionsDir = process.env.CLOUD_SMOKE_SESSIONS_DIR || '';

function uncaughtErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

function sessionEmail(role: string): string {
    const sessions = JSON.parse(
        readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8')
    ) as Array<{ role: string; email: string }>;
    const email = sessions.find((session) => session.role === role)?.email;
    expect(email, `${role} session`).toBeTruthy();
    return email!;
}

type AssistantEvent = {
    type: string;
    error?: string;
    tool_calls?: Array<{ function: { name: string } }>;
    served?: { model: string; provider: string; fallback: boolean };
};

/**
 * One Assistant step through the deployed proxy: DeepSeek Flash on the stored
 * route, or Luna when Flash has no route or failed. Either must make the one
 * tool call asked for. Landing on Luna is reported, not failed: OpenRouter's
 * endpoints are not this release's doing.
 */
test('the Assistant makes a tool call on the deployed stack', async ({
    browser
}) => {
    test.setTimeout(180000);
    expect(websiteOrigin, 'CLOUD_SMOKE_WEBSITE_URL').toContain('https://');
    const context = await browser.newContext({
        baseURL: editorOrigin,
        storageState: path.join(sessionsDir, 'owner.json')
    });
    try {
        const response = await context.request.post(
            `${websiteOrigin}/api/ai/assistant`,
            {
                headers: { Origin: editorOrigin },
                timeout: 150000,
                data: {
                    stream: true,
                    systemPrompt:
                        'You check fonts. Use the tools you are given.',
                    messages: [
                        {
                            role: 'user',
                            content:
                                'How many glyphs does the open font have? Call count_glyphs once.'
                        }
                    ],
                    tools: [
                        {
                            type: 'function',
                            function: {
                                name: 'count_glyphs',
                                description:
                                    'Count the glyphs in the open font.',
                                parameters: {
                                    type: 'object',
                                    properties: {},
                                    required: []
                                }
                            }
                        }
                    ]
                }
            }
        );
        expect(response.status(), await response.text()).toBe(200);
        const events = (await response.text())
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)) as AssistantEvent);
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        const calls = events.flatMap((event) => event.tool_calls ?? []);
        expect(calls.map((call) => call.function.name)).toEqual([
            'count_glyphs'
        ]);
        const served = events.find((event) => event.type === 'done')?.served;
        expect(served?.model).toBeTruthy();
        test.info().annotations.push({
            type: served?.fallback ? 'warning' : 'info',
            description: `Assistant served by ${served?.model} on ${served?.provider}${served?.fallback ? ' (Luna fallback)' : ''}`
        });
        console.log(
            `[preview-smoke] Assistant served by ${served?.model} on ${served?.provider}${served?.fallback ? ' (Luna fallback)' : ''}`
        );
    } finally {
        await context.close();
    }
});

test('a new account saves a font, invites a second account, and a nudge syncs between them', async ({
    browser
}) => {
    test.setTimeout(600000);
    expect(editorOrigin, 'CLOUD_SMOKE_EDITOR_URL').toContain('https://');
    expect(websiteOrigin, 'CLOUD_SMOKE_WEBSITE_URL').toContain('https://');
    const inviteeEmail = sessionEmail('invitee');

    const ownerContext = await browser.newContext({
        baseURL: editorOrigin,
        storageState: path.join(sessionsDir, 'owner.json')
    });
    const inviteeContext = await browser.newContext({
        baseURL: editorOrigin,
        storageState: path.join(sessionsDir, 'invitee.json')
    });
    try {
        const eligibility = await ownerContext.request.get(
            `${websiteOrigin}/api/cloud/eligibility`,
            { headers: { Origin: editorOrigin } }
        );
        expect(eligibility.status()).toBe(200);
        const limits = await eligibility.json();
        expect(limits.cloudHostingEnabled).toBe(true);
        expect(limits.fontsOwnedCount).toBe(0);
        expect(limits.maxFontsOwned === null || limits.maxFontsOwned >= 1).toBe(
            true
        );

        const ownerPage = await ownerContext.newPage();
        const ownerErrors = uncaughtErrors(ownerPage);
        await ownerPage.goto('/?test=true&examples=collab-fixtures');
        await waitForCanvasReady(ownerPage);
        await openMemoryFont(ownerPage, 'bbox.glyphs');
        await waitForOpenSessionReady(ownerPage, 'bbox.glyphs');
        await waitForBridgeReady(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Preview smoke ${Date.now()}`
        );
        await waitForCloudLiveIdle(ownerPage);

        const invite = await ownerPage.evaluate(
            async ({ email, id }) =>
                (window as any).cloudPlugin.inviteUser(email, 'editor', id),
            { email: inviteeEmail, id: assetId }
        );
        expect(invite.inviteUrl).toContain('token=');

        const acceptPage = await inviteeContext.newPage();
        const editorHref = await acceptCloudInviteAndGetEditorHref(
            acceptPage,
            invite.inviteUrl
        );
        const inviteePage = await inviteeContext.newPage();
        const inviteeErrors = uncaughtErrors(inviteePage);
        await gotoEditorPage(inviteePage, editorHrefWithTestMode(editorHref));
        await waitForCanvasReady(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await waitForCloudLiveIdle(inviteePage);

        await alignEditorCanvas(ownerPage, 'A', {});
        await alignEditorCanvas(inviteePage, 'A', {});
        const before = await glyphNodeX(ownerPage, 'A');
        await nudgeGlyphNode(ownerPage, 'A', 7, 'Preview smoke nudge');
        await waitForCloudLiveIdle(ownerPage);
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'A'), {
                timeout: 120000
            })
            .toBe(before + 7);

        await ownerPage.evaluate(async (id) => {
            await (window as any).cloudPlugin.deleteAsset(id);
        }, assetId);
        expect(ownerErrors).toEqual([]);
        expect(inviteeErrors).toEqual([]);
    } finally {
        await ownerContext.close();
        await inviteeContext.close();
    }
});
