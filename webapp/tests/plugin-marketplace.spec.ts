import { expect, test, type Page } from '@playwright/test';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    cloudCollabOperatorHeaders,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';

test.describe.configure({ mode: 'serial' });

const website = () =>
    process.env.CLOUD_COLLAB_WEBSITE_URL ||
    'https://staging.counterpunch.space';
const editor = () =>
    process.env.CLOUD_E2E_EDITOR_URL ||
    'https://staging.editor.counterpunch.space';

const FIXTURE_PACKAGES = [
    'fontdestination-example-plugin',
    'counterpunch-harakat'
];

async function prepareEditorPluginStorage(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('welcomeDismissedVersion', '1');
        const storage = window as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
        };
        storage.showDirectoryPicker = async () => {
            const root = await navigator.storage.getDirectory();
            const handle = root as FileSystemDirectoryHandle & {
                queryPermission?: (options?: unknown) => Promise<string>;
                requestPermission?: (options?: unknown) => Promise<string>;
            };
            const allow = async () => 'granted';
            handle.queryPermission = allow;
            handle.requestPermission = allow;
            return root;
        };
    });
}

async function openPluginManager(page: Page) {
    const welcome = page.getByRole('button', { name: 'Got it' });
    if (await welcome.isVisible()) {
        await welcome.click();
    }
    const menuItem = page.locator('[data-label^="Plugin Manager"]');
    if (!(await menuItem.isVisible())) {
        await page.locator('#toolbar-tools-menu-btn').click({ timeout: 20000 });
    }
    await menuItem.click({ timeout: 20000 });
    const search = page.locator('.plugin-manager-search');
    const connect = page.getByRole('button', { name: 'Connect Folder' });
    await expect(search.or(connect)).toBeVisible({ timeout: 20000 });
    if (await connect.isVisible()) {
        await connect.click();
        await expect(search).toBeVisible({ timeout: 20000 });
    }
}

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
    while (Date.now() - started < 360000) {
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
    test.setTimeout(900000);
    const emails = makeCloudCollabEmails(`plugin${Date.now()}`);
    await cleanupCloudCollabUsers(
        request,
        Object.values(emails),
        FIXTURE_PACKAGES
    );
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
            account
                .locator('.plugin-repo-row')
                .filter({ hasText: 'fontdestination-example-plugin' })
        ).toBeVisible();
        await expect(
            account
                .locator('.plugin-repo-row')
                .filter({ hasText: 'counterpunch-harakat-plugin' })
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
        await expect(account.locator('#pluginFormMessage')).toContainText(
            'Registered',
            { timeout: 30000 }
        );
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
        await expect(account.locator('#pluginFormMessage')).toContainText(
            'Registered',
            { timeout: 30000 }
        );
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
        await prepareEditorPluginStorage(editorPage);
        await editorPage.goto(editor());
        await editorPage.waitForFunction(
            () => Boolean((window as any).pyodide),
            null,
            { timeout: 180000 }
        );
        await openPluginManager(editorPage);
        await editorPage.locator('.plugin-manager-search').fill('destination');
        await expect(
            editorPage.locator('.plugin-manager-row:visible')
        ).toHaveCount(1);
        await editorPage.getByRole('button', { name: 'Install' }).click();
        await expect(
            editorPage.getByRole('button', { name: 'Uninstall' })
        ).toBeVisible({ timeout: 60000 });
        const managerClose = editorPage.locator(
            '#plugin-manager-modal-close-btn'
        );
        if (await managerClose.isVisible()) {
            await managerClose.click();
        }
        await editorPage.locator('#toolbar-tools-menu-btn').click({
            timeout: 20000
        });
        await expect(
            editorPage.locator('[data-label="Example Font Destination"]')
        ).toBeVisible();

        await openPluginManager(editorPage);
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
        await editorPage.waitForFunction(
            () => Boolean((window as any).pyodide),
            null,
            { timeout: 180000 }
        );
        await openPluginManager(editorPage);
        await editorPage.locator('.plugin-manager-search').fill('harakat');
        await editorPage.getByRole('button', { name: 'Install' }).click();
        await expect
            .poll(
                async () =>
                    editorPage.evaluate(async () => {
                        const python = (window as any).pyodide;
                        if (!python) return '';
                        return String(
                            await python.runPythonAsync(
                                '_cp_compile_filters_discover()'
                            )
                        );
                    }),
                { timeout: 60000 }
            )
            .toContain('harakat');

        await editorPage.getByRole('button', { name: 'Uninstall' }).click();
        await editorPage.locator('.plugin-manager-search').fill('destination');
        await editorPage.getByRole('button', { name: 'Uninstall' }).click();
    } finally {
        await cleanupCloudCollabUsers(
            request,
            Object.values(emails),
            FIXTURE_PACKAGES
        );
    }
});
