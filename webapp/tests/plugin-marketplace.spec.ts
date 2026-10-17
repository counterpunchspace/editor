import { expect, test } from '@playwright/test';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    cloudCollabOperatorHeaders,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';

test.describe.configure({ mode: 'serial' });
test.skip(
    process.env.PLUGIN_MARKETPLACE_SHARD === '0',
    'The plugin marketplace run is pinned to cloud-collab shard 1.'
);

const website = () =>
    process.env.CLOUD_COLLAB_WEBSITE_URL ||
    'https://staging.counterpunch.space';
const editor = () =>
    process.env.CLOUD_E2E_EDITOR_URL ||
    'https://staging.editor.counterpunch.space';

async function pluginOverview(request: any, sessionToken: string) {
    const response = await request.get(`${website()}/api/creator/plugins`, {
        headers: { cookie: `session=${sessionToken}` }
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
}

async function waitForReady(
    request: any,
    sessionToken: string,
    packageName: string
) {
    const started = Date.now();
    let latest: any = null;
    while (Date.now() - started < 240000) {
        const body = await pluginOverview(request, sessionToken);
        const plugin = (body.plugins || []).find(
            (item: any) => item.package === packageName
        );
        latest = plugin?.versions?.[0] || null;
        if (latest?.status === 'ready') return latest;
        if (
            latest?.status === 'static_failed' ||
            latest?.status === 'preflight_failed'
        ) {
            throw new Error(
                `${packageName} preflight failed: ${JSON.stringify(latest.report)}`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(
        `${packageName} did not become ready: ${JSON.stringify(latest)}`
    );
}

test('register, buy, and install the free and commercial plugins', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const emails = makeCloudCollabEmails(`plugin${Date.now()}`);
    await cleanupCloudCollabUsers(request, Object.values(emails));
    const creator = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const buyer = await bootstrapCloudCollabSession(
        request,
        emails.invitee,
        'invitee'
    );
    const headers = {
        ...cloudCollabOperatorHeaders(),
        Origin: editor()
    };
    try {
        for (const repository of [
            'counterpunchspace/fontdestination-example-plugin',
            'yanone/counterpunch-harakat-plugin'
        ]) {
            const linked = await request.post(
                `${website()}/api/dev/plugin-test/installation`,
                {
                    data: { email: emails.owner, repository },
                    headers,
                    failOnStatusCode: false
                }
            );
            if (!linked.ok()) {
                test.skip(
                    true,
                    `Staging fixture is not ready for ${repository}: ${await linked.text()}`
                );
            }
        }

        const creatorContext = await browser.newContext();
        await attachCloudCollabCookies(creatorContext, creator);
        const account = await creatorContext.newPage();
        await account.goto(`${website()}/account#plugins`);
        await expect(
            account.getByRole('tab', { name: 'Plugins' })
        ).toHaveAttribute('aria-selected', 'true');
        await expect(account.locator('#accountPanel')).toBeHidden();
        await expect(
            account.getByText('fontdestination-example-plugin')
        ).toBeVisible();
        await expect(
            account.getByText('counterpunch-harakat-plugin')
        ).toBeVisible();

        await account.locator('#pluginRepo').selectOption({
            label: 'counterpunchspace/fontdestination-example-plugin'
        });
        await account
            .locator('#pluginPackage')
            .fill('fontdestination-example-plugin');
        await account.locator('#pluginName').fill('Example Font Destination');
        await account
            .locator('#pluginDescription')
            .fill('A free example destination');
        await account.locator('#pluginTerms').check();
        await account.getByRole('button', { name: 'Register plugin' }).click();
        await waitForReady(
            request,
            creator.sessionToken,
            'fontdestination-example-plugin'
        );
        await account.reload();
        await account.getByRole('button', { name: 'Publish' }).click();
        await expect
            .poll(async () => {
                const body = await pluginOverview(
                    request,
                    creator.sessionToken
                );
                return body.plugins.find(
                    (item: any) =>
                        item.package === 'fontdestination-example-plugin'
                )?.status;
            })
            .toBe('live');

        const payout = await request.post(
            `${website()}/api/dev/plugin-test/creator-account`,
            {
                data: { email: emails.owner },
                headers,
                failOnStatusCode: false
            }
        );
        expect(payout.ok(), await payout.text()).toBeTruthy();
        await expect
            .poll(
                async () => {
                    const body = await pluginOverview(
                        request,
                        creator.sessionToken
                    );
                    return Boolean(
                        body.payout?.payouts_enabled &&
                        body.payout?.transfers_active
                    );
                },
                { timeout: 120000 }
            )
            .toBeTruthy();

        await account.reload();
        await account.locator('#pluginKind').selectOption('commercial');
        await account.locator('#pluginPrice').fill('5.00');
        await account
            .locator('#pluginRepo')
            .selectOption({ label: 'yanone/counterpunch-harakat-plugin' });
        await account.locator('#pluginPackage').fill('counterpunch-harakat');
        await account.locator('#pluginName').fill('Harakat');
        await account.locator('#pluginDescription').fill('Arabic vowel marks');
        await account.locator('#pluginTerms').check();
        await account.getByRole('button', { name: 'Register plugin' }).click();
        await waitForReady(
            request,
            creator.sessionToken,
            'counterpunch-harakat'
        );
        await account.reload();
        await account.getByRole('button', { name: 'Publish' }).click();

        const editorContext = await browser.newContext();
        await attachCloudCollabCookies(editorContext, buyer);
        const editorPage = await editorContext.newPage();
        await editorPage.goto(editor());
        await editorPage.waitForFunction(
            () => Boolean((window as any).pyodide),
            null,
            { timeout: 180000 }
        );
        await editorPage.locator('#toolbar-tools-menu-btn').click();
        await editorPage.locator('[data-label^="Plugin Manager"]').click();
        await editorPage.locator('.plugin-manager-search').fill('destination');
        await expect(
            editorPage.locator('.plugin-manager-row:visible')
        ).toHaveCount(1);
        await editorPage.getByRole('button', { name: 'Install' }).click();
        await expect(
            editorPage.getByRole('button', { name: 'Uninstall' })
        ).toBeVisible();
        await editorPage.locator('#toolbar-tools-menu-btn').click();
        await expect(
            editorPage.locator('[data-label="Example Font Destination"]')
        ).toBeVisible();

        await editorPage.locator('#toolbar-tools-menu-btn').click();
        await editorPage.locator('[data-label^="Plugin Manager"]').click();
        await editorPage.locator('.plugin-manager-search').fill('harakat');
        await expect(
            editorPage.getByRole('button', { name: 'Buy' })
        ).toBeVisible();
        const purchased = await request.post(
            `${website()}/api/dev/plugin-test/purchase`,
            {
                data: {
                    email: emails.invitee,
                    package: 'counterpunch-harakat'
                },
                headers,
                failOnStatusCode: false
            }
        );
        expect(purchased.ok(), await purchased.text()).toBeTruthy();
        const receipt = await purchased.json();
        expect(receipt.amount).toBe(
            Math.floor(((receipt.gross - receipt.tax - receipt.fee) * 70) / 100)
        );
        expect(receipt.destination).toBeTruthy();
        await editorPage.reload();
        await editorPage.locator('#toolbar-tools-menu-btn').click();
        await editorPage.locator('[data-label^="Plugin Manager"]').click();
        await editorPage.locator('.plugin-manager-search').fill('harakat');
        await editorPage.getByRole('button', { name: 'Install' }).click();
        await expect
            .poll(async () =>
                editorPage.evaluate(async () => {
                    const python = (window as any).pyodide;
                    if (!python) return '';
                    return String(
                        await python.runPythonAsync(
                            '_cp_compile_filters_discover()'
                        )
                    );
                })
            )
            .toContain('harakat');

        await editorPage.getByRole('button', { name: 'Uninstall' }).click();
        await editorPage.locator('.plugin-manager-search').fill('destination');
        await editorPage.getByRole('button', { name: 'Uninstall' }).click();
    } finally {
        await cleanupCloudCollabUsers(request, Object.values(emails));
    }
});
