import { pathToFileURL } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

/**
 * Real sign-in with emailed codes on the staging website and editor: the
 * code is read from the real inbox over IMAP, typed wrong once, then pasted.
 * The editor signs in from the dialog without a reload, keeps the open font,
 * shows the account in Preferences, opens the Assistant with the free AI
 * credit, and a second editor tab follows. Not part of any other project.
 *
 *   SIGN_IN_LIVE_E2E=1
 *   SIGN_IN_LIVE_WEBSITE_URL=https://staging.counterpunch.space
 *   SIGN_IN_LIVE_EDITOR_URL=https://staging.editor.counterpunch.space
 *   SIGN_IN_LIVE_MAILBOX_MODULE=<website>/scripts/mailbox-imap.mjs
 *   SIGNUP_E2E_IMAP_USER, SIGNUP_E2E_IMAP_PASS, GITHUB_RUN_ID
 *   npx playwright test --project=sign-in-live
 *
 * Afterwards `node scripts/e2e-login-code-signup.mjs cleanup --roles
 * website,editor` in the website repo deletes both accounts and their mail.
 */

type WaitForLoginCode = (options: {
    user: string;
    pass: string;
    to: string;
    sinceMs: number;
    exactRecipient?: boolean;
    exclude?: string[];
}) => Promise<string>;

const websiteOrigin = (process.env.SIGN_IN_LIVE_WEBSITE_URL || '').replace(
    /\/$/,
    ''
);
const editorOrigin = (process.env.SIGN_IN_LIVE_EDITOR_URL || '').replace(
    /\/$/,
    ''
);
const imapUser = (process.env.SIGNUP_E2E_IMAP_USER || '').trim().toLowerCase();
const imapPass = (process.env.SIGNUP_E2E_IMAP_PASS || '').replace(/\s+/g, '');
const runId = process.env.GITHUB_RUN_ID || '';

/** Same address as roleEmail() in website/scripts/e2e-login-code-signup.mjs. */
function roleEmail(role: string): string {
    const at = imapUser.lastIndexOf('@');
    if (at < 1 || !/^[0-9]+$/.test(runId)) {
        throw new Error(
            'SIGNUP_E2E_IMAP_USER and a numeric GITHUB_RUN_ID are required'
        );
    }
    return `${imapUser.slice(0, at)}+cp-e2e-${runId}-${role}@${imapUser.slice(at + 1)}`;
}

async function mailbox(): Promise<WaitForLoginCode> {
    const modulePath = process.env.SIGN_IN_LIVE_MAILBOX_MODULE || '';
    const loaded: { waitForLoginCode?: WaitForLoginCode } = await import(
        pathToFileURL(modulePath).href
    );
    if (typeof loaded.waitForLoginCode !== 'function') {
        throw new Error(`${modulePath} has no waitForLoginCode`);
    }
    return loaded.waitForLoginCode;
}

function wrongCodeFor(code: string): string {
    return code === '000000' ? '111111' : '000000';
}

/** A real paste event, as when the user pastes from the email. */
async function pasteInto(page: Page, selector: string, text: string) {
    await page.locator(selector).evaluate((input, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        (input as HTMLInputElement).focus();
        input.dispatchEvent(
            new ClipboardEvent('paste', {
                clipboardData: data,
                bubbles: true,
                cancelable: true
            })
        );
    }, text);
}

/** A fresh browser gets the folder prompt and the welcome note; close both. */
async function dismissStartupDialogs(page: Page) {
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, {
        timeout: 180_000
    });
    const skipFolders = page.locator(
        '.folder-permissions-overlay [data-action="skip"]'
    );
    const welcome = page.getByRole('button', { name: 'Got it' });
    const quietUntil = Date.now() + 10_000;
    while (Date.now() < quietUntil) {
        if (await skipFolders.isVisible()) {
            await skipFolders.click();
        } else if (await welcome.isVisible()) {
            await welcome.click();
        } else {
            await page.waitForTimeout(500);
        }
    }
}

/** What the Preferences and Assistant panels show about the account. */
async function accountPanels(page: Page) {
    return page.evaluate(() => {
        const shown = (id: string) => {
            const element = document.getElementById(id);
            return !!element && getComputedStyle(element).display !== 'none';
        };
        const prompt = document.getElementById(
            'assistant-prompt'
        ) as HTMLTextAreaElement | null;
        return {
            preferencesSignedIn: shown('settings-logged-in'),
            preferencesSignedOut: shown('settings-logged-out'),
            preferencesEmail:
                document.getElementById('settings-user-email')?.textContent ??
                '',
            assistantSignInBox: shown('assistant-login-container'),
            assistantSubscriptionBox: shown('assistant-subscription-container'),
            assistantInputEnabled: !!prompt && !prompt.disabled
        };
    });
}

/** Signed in as `email`: Preferences shows it, and the Assistant is open. */
async function expectAccountPanelsSignedIn(page: Page, email: string) {
    await expect
        .poll(() => accountPanels(page), { timeout: 30_000 })
        .toMatchObject({
            preferencesSignedIn: true,
            preferencesSignedOut: false,
            assistantSignInBox: false,
            assistantSubscriptionBox: false,
            assistantInputEnabled: true
        });
    expect((await accountPanels(page)).preferencesEmail).toContain(email);
}

/**
 * A new account has its free AI credit right after sign-in: Preferences
 * shows a positive balance, and the Assistant endpoint accepts the editor's
 * token and credit. The probe sends an empty conversation, which is refused
 * only for being empty, so no AI call is made or billed.
 */
async function expectFreeAiCreditUsable(page: Page) {
    const credits = page.locator('#settings-credits');
    await expect(credits).toHaveText(/^€\d+\.\d{2} credits remaining/, {
        timeout: 30_000
    });
    const euros = Number(
        (await credits.textContent())?.match(/€(\d+\.\d{2})/)?.[1]
    );
    expect(euros).toBeGreaterThan(0);

    const probe = await page.evaluate(async (website) => {
        const token = (window as any).authManager.getSessionToken();
        const response = await fetch(`${website}/api/ai/assistant`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ messages: [] })
        });
        return {
            status: response.status,
            body: await response.json().catch(() => null)
        };
    }, websiteOrigin);
    expect(probe).toEqual({
        status: 400,
        body: { error: 'Messages are required' }
    });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
    expect(websiteOrigin, 'SIGN_IN_LIVE_WEBSITE_URL').toContain('https://');
    expect(editorOrigin, 'SIGN_IN_LIVE_EDITOR_URL').toContain('https://');
    expect(imapPass, 'SIGNUP_E2E_IMAP_PASS').not.toBe('');
});

test('the website signs in with the emailed code', async ({ browser }) => {
    test.setTimeout(240_000);
    const waitForLoginCode = await mailbox();
    const email = roleEmail('website');
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(`${websiteOrigin}/login`);
        await page.fill('#email', email);
        const sentAt = Date.now();
        await page.click('#submitBtn');
        await expect(page.locator('#loginCodeForm')).toBeVisible();
        await expect(page.locator('#loginCodeEmail')).toHaveText(email);

        const code = await waitForLoginCode({
            user: imapUser,
            pass: imapPass,
            to: email,
            sinceMs: sentAt,
            exactRecipient: true
        });

        await pasteInto(page, '#loginCode', wrongCodeFor(code));
        await expect(page.locator('#messageContainer')).toContainText(
            'tries left'
        );
        await expect(page.locator('#loginCode')).toBeEnabled();

        await pasteInto(page, '#loginCode', code);
        await page.waitForURL(/\/account/, { timeout: 30_000 });
        await expect(page.locator('#authSection')).toContainText(email);
    } finally {
        await context.close();
    }
});

test('the editor signs in from the dialog and keeps the open font', async ({
    browser
}) => {
    test.setTimeout(480_000);
    const waitForLoginCode = await mailbox();
    const email = roleEmail('editor');
    const context = await browser.newContext({ baseURL: editorOrigin });
    try {
        const page = await context.newPage();
        const otherTab = await context.newPage();
        for (const tab of [page, otherTab]) {
            await tab.goto('/');
            await waitForCanvasReady(tab);
        }
        await page.evaluate(() => {
            const win = window as any;
            win.__fontBeforeSignIn = win.currentFontModel;
            win.__pageBeforeSignIn = true;
        });
        expect(
            await page.evaluate(() => !!(window as any).currentFontModel)
        ).toBe(true);

        await dismissStartupDialogs(page);
        expect(await accountPanels(page)).toMatchObject({
            preferencesSignedIn: false,
            preferencesSignedOut: true,
            assistantSignInBox: true,
            assistantInputEnabled: false
        });
        // A signed-out user opening Cloud gets the dialog, not a redirect.
        void page.evaluate(() =>
            (window as any).showFontFileDialog({ mode: 'open' })
        );
        await page.locator('.context-tab[data-plugin-id="cloud"]').click();
        const dialog = page.locator('.sign-in-dialog');
        await expect(dialog).toBeVisible();
        await page.fill('#sign-in-email', email);
        const firstSentAt = Date.now();
        await dialog.locator('[data-role="send"]').click();
        await expect(page.locator('#sign-in-code')).toBeFocused();
        const firstCode = await waitForLoginCode({
            user: imapUser,
            pass: imapPass,
            to: email,
            sinceMs: firstSentAt,
            exactRecipient: true
        });

        // Resend after the cooldown; the first code must still work, as for
        // a user whose first email arrives late.
        const resend = dialog.locator('[data-role="resend"]');
        await expect(resend).toBeEnabled({ timeout: 60_000 });
        const resentAt = Date.now();
        await resend.click();
        await expect(dialog.locator('[data-role="message"]')).toHaveText(
            'We sent a new code.'
        );
        await waitForLoginCode({
            user: imapUser,
            pass: imapPass,
            to: email,
            sinceMs: resentAt,
            exactRecipient: true,
            exclude: [firstCode]
        });

        await pasteInto(page, '#sign-in-code', wrongCodeFor(firstCode));
        await expect(dialog.locator('[data-role="message"]')).toContainText(
            'tries left'
        );
        await expect(dialog).toBeVisible();

        await pasteInto(page, '#sign-in-code', firstCode);
        await expect(dialog).toBeHidden({ timeout: 30_000 });

        expect(
            await page.evaluate(() => {
                const win = window as any;
                return {
                    signedIn: win.authManager.isAuthenticated(),
                    email: win.authManager.getUser()?.email,
                    sameFont: win.currentFontModel === win.__fontBeforeSignIn,
                    noReload: win.__pageBeforeSignIn === true
                };
            })
        ).toEqual({ signedIn: true, email, sameFont: true, noReload: true });
        await expect(page.locator('#cloud-panel')).not.toHaveClass(/visible/);

        await expectAccountPanelsSignedIn(page, email);
        await expectFreeAiCreditUsable(page);

        await otherTab.waitForFunction(
            () => (window as any).authManager?.isAuthenticated?.() === true,
            null,
            { timeout: 30_000 }
        );
        await expectAccountPanelsSignedIn(otherTab, email);
    } finally {
        await context.close();
    }
});
