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
        localStorage.setItem('tourSkipped', 'true');
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

async function linkStartupFolders(page: Page, waitForDialog: boolean) {
    // The overlay fades with opacity and keeps its box, so Playwright still
    // treats it as visible. The hidden class is what drops pointer events.
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, {
        timeout: 180000
    });
    const dialog = page.locator('.folder-permissions-overlay');
    const visible = waitForDialog
        ? await dialog
              .waitFor({ state: 'visible', timeout: 20000 })
              .then(() => true)
              .catch(() => false)
        : await dialog.isVisible();
    if (!visible) {
        return;
    }
    await dialog.locator('[data-folder-kind="settings"]').click();
    await expect(dialog).toContainText('Access granted', { timeout: 20000 });
    await dialog.locator('[data-folder-kind="project"]').click();
    const continueButton = dialog.locator('[data-action="continue"]');
    await expect(continueButton).toBeEnabled({ timeout: 20000 });
    await continueButton.click();
    await expect(dialog).toBeHidden();
}

async function openPluginManager(page: Page, waitForFolderDialog = false) {
    await linkStartupFolders(page, waitForFolderDialog);
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

function pluginRow(page: Page, name: string) {
    return page.locator('.plugin-manager-row').filter({ hasText: name });
}

async function expectReleasePackage(page: Page, packageName: string) {
    await expect
        .poll(
            async () => {
                const value = await page.locator('#pluginPackage').inputValue();
                if (value) return value;
                const status = (
                    await page.locator('#pluginReleaseStatus').innerText()
                ).trim();
                if (
                    status &&
                    !status.startsWith('Checking the latest release')
                ) {
                    throw new Error(status);
                }
                return '';
            },
            { timeout: 90000 }
        )
        .toBe(packageName);
}

async function searchPlugins(page: Page, query: string) {
    const search = page.locator('.plugin-manager-search');
    await search.fill(query, { timeout: 20000 });
    await search.dispatchEvent('input');
}

const cleanupEmails: { current: string[] } = { current: [] };

test.afterEach(async ({ request }, testInfo) => {
    testInfo.setTimeout(testInfo.timeout + 60000);
    if (process.env.PLUGIN_E2E_KEEP === '1' || !cleanupEmails.current.length) {
        return;
    }
    const emails = cleanupEmails.current;
    cleanupEmails.current = [];
    await cleanupCloudCollabUsers(request, emails, FIXTURE_PACKAGES);
});

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
    test.setTimeout(600000);
    const resume =
        process.env.PLUGIN_E2E_KEEP === '1' &&
        Boolean(process.env.PLUGIN_E2E_RUN_ID);
    const emails = makeCloudCollabEmails(
        process.env.PLUGIN_E2E_RUN_ID || `plugin${Date.now()}`
    );
    cleanupEmails.current = Object.values(emails);
    if (!resume) {
        await cleanupCloudCollabUsers(
            request,
            cleanupEmails.current,
            FIXTURE_PACKAGES
        );
    }
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
    if (resume) {
        const body = await pluginOverview(request, creator.sessionToken);
        const owned = new Set(
            (body.plugins || []).map((item: any) => item.package)
        );
        const missing = FIXTURE_PACKAGES.filter((name) => !owned.has(name));
        if (missing.length) {
            await cleanupCloudCollabUsers(request, [], missing);
        }
    }
    const headers = {
        ...cloudCollabOperatorHeaders(),
        Origin: editor()
    };
    {
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

        const creatorPlugin = async (packageName: string) => {
            const body = await pluginOverview(request, creator.sessionToken);
            const plugin = (body.plugins || []).find(
                (item: any) => item.package === packageName
            );
            const version = plugin?.versions?.[0];
            return {
                body,
                plugin,
                settled:
                    plugin?.status === 'live' ||
                    version?.status === 'ready' ||
                    version?.status === 'published'
            };
        };

        let free = await creatorPlugin('fontdestination-example-plugin');
        if (!free.plugin) {
            await account.locator('#pluginRepo').selectOption({
                label: 'counterpunchspace/fontdestination-example-plugin'
            });
            await expectReleasePackage(
                account,
                'fontdestination-example-plugin'
            );
            await expect(account.locator('#pluginName')).not.toBeEditable();
            await expect(
                account.locator('#pluginDescription')
            ).not.toBeEditable();
            await expect(
                account.getByRole('button', { name: 'Register plugin' })
            ).toBeEnabled();
            await account.locator('#pluginTerms').check();
            await account
                .getByRole('button', { name: 'Register plugin' })
                .click();
            await expect(
                account
                    .locator('.plugin-card')
                    .filter({ hasText: 'fontdestination-example-plugin' })
            ).toBeVisible({ timeout: 30000 });
        }
        if (!free.settled) {
            await waitForReady(
                request,
                creator.sessionToken,
                'fontdestination-example-plugin'
            );
            free = await creatorPlugin('fontdestination-example-plugin');
        }
        if (free.plugin?.status !== 'live') {
            await account.reload();
            await account
                .getByRole('button', { name: 'Publish' })
                .click({ timeout: 20000 });
            await expect
                .poll(
                    async () => {
                        return (
                            await creatorPlugin(
                                'fontdestination-example-plugin'
                            )
                        ).plugin?.status;
                    },
                    { timeout: 30000 }
                )
                .toBe('live');
        }

        const payoutReady = Boolean(
            free.body?.payout?.payouts_enabled &&
            free.body?.payout?.transfers_active
        );
        if (!payoutReady) {
            if (!free.body?.payout) {
                await account.locator('#payoutsTab').click();
                await expect(account.locator('.message.warning')).toContainText(
                    'cannot be changed'
                );
                await account.locator('#payoutCountry').selectOption('DE');
                await account
                    .getByRole('button', { name: 'Set up payouts' })
                    .click();
                await expect(
                    account.locator('iframe[src*="stripe.com"]')
                ).toBeVisible({
                    timeout: 60000
                });
            }
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
        }

        let harakat = await creatorPlugin('counterpunch-harakat');
        if (!harakat.plugin) {
            await account.reload();
            await account
                .locator('#pluginRepo')
                .selectOption({ label: 'yanone/counterpunch-harakat-plugin' });
            await expectReleasePackage(account, 'counterpunch-harakat');
            await account.locator('#pluginKind').selectOption('commercial');
            await account.locator('#pluginPricing').selectOption('ppp');
            await account.locator('#pluginPrice').fill('5.00');
            await account.locator('#pluginFloor').fill('1.00');
            await expect(account.locator('#pluginPricePreview')).toContainText(
                'Cheapest:'
            );
            await expect(account.locator('#pluginPricePreview')).toContainText(
                'Highest:'
            );
            await expect(account.locator('#pluginIds')).toHaveValue(
                /de\.yanone\.harakat/
            );
            await expect(account.locator('#pluginName')).not.toBeEditable();
            await expect(
                account.locator('#pluginDescription')
            ).not.toBeEditable();
            await expect(
                account.getByRole('button', { name: 'Register plugin' })
            ).toBeEnabled();
            await account.locator('#pluginTerms').check();
            await account
                .getByRole('button', { name: 'Register plugin' })
                .click();
            await expect(
                account
                    .locator('.plugin-card')
                    .filter({ hasText: 'counterpunch-harakat' })
            ).toBeVisible({ timeout: 30000 });
        }
        if (!harakat.settled) {
            await waitForReady(
                request,
                creator.sessionToken,
                'counterpunch-harakat'
            );
            harakat = await creatorPlugin('counterpunch-harakat');
        }
        if (harakat.plugin?.status !== 'live') {
            await account.reload();
            await account
                .getByRole('button', { name: 'Publish' })
                .click({ timeout: 20000 });
        }

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
        await openPluginManager(editorPage, true);
        await searchPlugins(editorPage, 'destination');
        const destination = pluginRow(editorPage, 'Example Font Destination');
        await expect(destination).toBeVisible();
        await destination
            .getByRole('button', { name: 'Install' })
            .click({ timeout: 20000 });
        await expect(
            destination.getByRole('button', { name: 'Uninstall' })
        ).toBeVisible({ timeout: 60000 });
        const managerClose = editorPage.locator(
            '#plugin-manager-modal-close-btn'
        );
        if (await managerClose.isVisible()) {
            await managerClose.click({ timeout: 20000 });
        }
        const destinationMenu = editorPage.locator(
            '[data-label="Example Font Destination"]'
        );
        const destinationsMenu = editorPage.locator(
            '[data-label="Font Destinations"]'
        );
        if (!(await destinationsMenu.isVisible())) {
            await editorPage.locator('#toolbar-tools-menu-btn').click({
                timeout: 20000
            });
        }
        await destinationsMenu.hover({ timeout: 20000 });
        await expect(destinationMenu).toBeVisible();

        await openPluginManager(editorPage);
        await searchPlugins(editorPage, 'harakat');
        const harakatRow = pluginRow(editorPage, 'Harakat');
        const owned = await request.get(`${website()}/api/plugins/purchases`, {
            headers: { cookie: `session=${buyer.sessionToken}` },
            failOnStatusCode: false
        });
        const ownedPackages = owned.ok()
            ? ((await owned.json()) as { packages?: string[] }).packages || []
            : [];
        if (!ownedPackages.includes('counterpunch-harakat')) {
            await expect(
                editorPage.locator('.plugin-manager-banner')
            ).toContainText('Add a payment method');
            await expect(
                harakatRow.getByRole('button', { name: 'Buy' })
            ).toHaveCount(0);
            const popupPromise = editorContext.waitForEvent('page');
            await editorPage
                .locator('.plugin-manager-banner')
                .getByRole('button', { name: 'Add payment method' })
                .click();
            const accountPage = await popupPromise;
            await accountPage
                .getByRole('button', { name: 'Add payment method' })
                .click();
            await accountPage.waitForURL(/checkout\.stripe\.com/, {
                timeout: 60000
            });
            await accountPage.locator('#cardNumber').fill('4242424242424242');
            await accountPage.locator('#cardExpiry').fill('12 / 34');
            await accountPage.locator('#cardCvc').fill('123');
            await accountPage.locator('#billingName').fill('Plugin Buyer');
            await accountPage.locator('#billingCountry').selectOption('DE');
            await accountPage
                .locator('#billingAddressLine1')
                .fill('Alexanderplatz 1');
            await accountPage.locator('#billingPostalCode').fill('10115');
            await accountPage.locator('#billingLocality').fill('Berlin');
            await accountPage.locator('button[type="submit"]').click();
            await expect(accountPage.locator('#paymentInfo')).toContainText(
                '4242',
                {
                    timeout: 60000
                }
            );
            await editorPage.bringToFront();
            await openPluginManager(editorPage);
            await searchPlugins(editorPage, 'harakat');
            const priced = pluginRow(editorPage, 'Harakat');
            await expect(priced).toContainText('incl.');
            await expect(priced).toContainText('VAT');
            await priced.getByRole('button', { name: 'Buy' }).click();
            await editorPage
                .locator('.plugin-purchase-card')
                .getByRole('button', { name: /^Pay / })
                .click();
            await expect(
                editorPage.locator('.plugin-purchase-card')
            ).toContainText('Purchased');
            await expect(
                editorPage.locator('.plugin-purchase-card').getByRole('link', {
                    name: 'View invoice'
                })
            ).toBeVisible();
            await editorPage
                .locator('.plugin-purchase-card')
                .getByRole('button', { name: 'Done' })
                .click();
        }
        const receiptResponse = await request.get(
            `${website()}/api/dev/plugin-test/receipt?email=${encodeURIComponent(emails.invitee)}&package=counterpunch-harakat`,
            { headers, failOnStatusCode: false }
        );
        expect(receiptResponse.ok(), await receiptResponse.text()).toBeTruthy();
        const receipt = await receiptResponse.json();
        expect(receipt.invoice.status).toBe('paid');
        expect(
            receipt.transfers.filter((row) => row.kind === 'sale')
        ).toHaveLength(1);
        await editorPage.reload();
        await editorPage.waitForFunction(
            () => Boolean((window as any).pyodide),
            null,
            { timeout: 180000 }
        );
        await openPluginManager(editorPage);
        await searchPlugins(editorPage, 'harakat');
        const harakatInstalled = pluginRow(editorPage, 'Harakat');
        const install = harakatInstalled.getByRole('button', {
            name: 'Install'
        });
        if (await install.isVisible()) {
            await install.click({ timeout: 20000 });
        }
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

        const purchases = await editorContext.newPage();
        await purchases.goto(`${website()}/account#purchases`);
        const purchaseRow = purchases
            .locator('li')
            .filter({ hasText: 'Harakat' });
        await expect(purchaseRow).toContainText('Refundable until');
        purchases.once('dialog', (dialog) => dialog.accept());
        await purchaseRow
            .getByRole('button', { name: /Refundable until/ })
            .click();
        await expect(purchaseRow).toContainText('Refunded');
        const again = await request.post(`${website()}/api/plugins/refund`, {
            headers: {
                'cookie': `session=${buyer.sessionToken}`,
                'Origin': website(),
                'content-type': 'application/json'
            },
            data: { package: 'counterpunch-harakat' },
            failOnStatusCode: false
        });
        expect(again.status()).toBe(409);
        const foreign = await request.post(
            `${website()}/api/plugins/counterpunch-harakat/purchase`,
            {
                headers: {
                    'cookie': `session=${buyer.sessionToken}`,
                    'Origin': 'https://evil.example',
                    'content-type': 'application/json'
                },
                data: { expectedGrossCents: 1 },
                failOnStatusCode: false
            }
        );
        expect(foreign.status()).toBe(403);
        const unconfirmed = await request.post(
            `${website()}/api/plugins/counterpunch-harakat/purchase`,
            {
                headers: {
                    'cookie': `session=${buyer.sessionToken}`,
                    'Origin': editor(),
                    'content-type': 'application/json'
                },
                data: {},
                failOnStatusCode: false
            }
        );
        expect(unconfirmed.status()).toBe(400);
        await editorPage.bringToFront();
        await expect(editorPage.locator('.plugin-removed-toast')).toContainText(
            'removed after your refund',
            { timeout: 60000 }
        );

        await searchPlugins(editorPage, 'destination');
        await pluginRow(editorPage, 'Example Font Destination')
            .getByRole('button', { name: 'Uninstall' })
            .click({ timeout: 20000 });
    }
});
