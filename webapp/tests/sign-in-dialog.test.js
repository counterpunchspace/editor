jest.mock('../js/website-url', () => ({
    resolveWebsiteURL: jest.fn(() => 'https://counterpunch.space')
}));

const WEBSITE = 'https://counterpunch.space';
const EMAIL = 'typer@example.com';

/** A website that knows one account and checks codes like the real one. */
function createFakeWebsite() {
    const site = {
        codes: [],
        requests: [],
        verifies: [],
        failures: 0,
        token: null,
        failNextVerifyWithNetworkError: false
    };
    const json = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    });
    site.fetch = jest.fn(async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        const body = init.body ? JSON.parse(init.body) : {};
        if (path === '/api/auth/me') {
            const auth = init.headers?.Authorization;
            return site.token && auth === `Bearer ${site.token}`
                ? json(200, {
                      user: { email: EMAIL },
                      subscription: null,
                      credits: null
                  })
                : json(401, { authenticated: false });
        }
        if (path === '/api/auth/request-code') {
            site.requests.push(body.email);
            const code = String(100000 + site.codes.length * 111111).slice(
                0,
                6
            );
            site.codes.push(code);
            return json(200, { success: true, resendAfterSeconds: 30 });
        }
        if (path === '/api/auth/verify-code') {
            site.verifies.push(body.code);
            if (site.failNextVerifyWithNetworkError) {
                site.failNextVerifyWithNetworkError = false;
                throw new TypeError('Failed to fetch');
            }
            if (site.failures >= 10) {
                return json(429, {
                    code: 'too_many_attempts',
                    error: 'Too many wrong codes.'
                });
            }
            if (!site.codes.slice(-2).includes(body.code)) {
                site.failures += 1;
                return site.failures >= 10
                    ? json(429, { code: 'too_many_attempts' })
                    : json(400, {
                          code: 'invalid_code',
                          error: "That code isn't right.",
                          attemptsRemaining: 10 - site.failures
                      });
            }
            site.token = `token-for-${body.code}`;
            return json(200, {
                success: true,
                user: { email: EMAIL },
                sessionToken: site.token
            });
        }
        throw new Error(`Unexpected fetch ${url}`);
    });
    return site;
}

async function settle() {
    for (let index = 0; index < 30; index += 1) {
        await Promise.resolve();
    }
}

function dialog() {
    return document.querySelector('.sign-in-dialog-overlay');
}

function field(selector) {
    return dialog()?.querySelector(selector);
}

function messageText() {
    const message = field('[data-role="message"]');
    return message && !message.hidden ? message.textContent : '';
}

async function submitEmail(email = EMAIL) {
    field('#sign-in-email').value = email;
    field('[data-step="email"]').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();
}

async function pasteCode(text) {
    const input = field('#sign-in-code');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => text }
    });
    input.dispatchEvent(event);
    await settle();
    return event;
}

async function typeCode(text) {
    const input = field('#sign-in-code');
    for (const character of text) {
        input.value += character;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
    }
}

function pressEscape() {
    document.dispatchEvent(
        new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true
        })
    );
}

describe('sign-in dialog', () => {
    let site;
    let authManager;
    let originalFetch;
    let originalBroadcastChannel;
    let startUrl;

    beforeEach(async () => {
        jest.resetModules();
        document.body.innerHTML = '';
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        localStorage.clear();
        if (window.__modalEscapeRuntime)
            window.__modalEscapeRuntime.stack.length = 0;
        originalFetch = global.fetch;
        originalBroadcastChannel = global.BroadcastChannel;
        delete global.BroadcastChannel;
        site = createFakeWebsite();
        global.fetch = site.fetch;
        require('../js/auth-manager');
        authManager = window.authManager;
        await settle();
        startUrl = window.location.href;
    });

    afterEach(() => {
        jest.useRealTimers();
        document.body.innerHTML = '';
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        global.fetch = originalFetch;
        global.BroadcastChannel = originalBroadcastChannel;
        jest.restoreAllMocks();
    });

    it('signs in from a pasted code without leaving the page', async () => {
        const events = [];
        window.addEventListener('authStateChanged', (event) =>
            events.push(event.detail.isAuthenticated)
        );
        const pending = authManager.ensureCloudSession({
            reason: 'Sign in to save fonts to the cloud.'
        });
        await settle();

        expect(dialog()).not.toBeNull();
        expect(dialog().textContent).toContain(
            'Sign in to save fonts to the cloud.'
        );
        await submitEmail();
        expect(site.requests).toEqual([EMAIL]);
        expect(field('[data-step="code"]').hidden).toBe(false);
        expect(field('[data-role="sent-to"]').textContent).toBe(EMAIL);
        expect(document.activeElement).toBe(field('#sign-in-code'));

        const paste = await pasteCode(
            `${site.codes[0]} is your Counterpunch sign-in code`
        );

        expect(paste.defaultPrevented).toBe(true);
        expect(site.verifies).toEqual([site.codes[0]]);
        const user = await pending;
        expect(user).toMatchObject({ email: EMAIL });
        expect(dialog()).toBeNull();
        expect(document.cookie).toContain(
            `editor_session=token-for-${site.codes[0]}`
        );
        expect(authManager.isAuthenticated()).toBe(true);
        expect(events).toEqual([true]);
        await authManager.checkAuthStatus();
        expect(events).toEqual([true]);
        expect(window.location.href).toBe(startUrl);
        expect(localStorage.getItem('signInEmail')).toBe(EMAIL);
    });

    it('accepts a code split by a space, and an autofilled code', async () => {
        const pending = authManager.signIn();
        await settle();
        await submitEmail();

        const input = field('#sign-in-code');
        input.value = `${site.codes[0].slice(0, 3)} ${site.codes[0].slice(3)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();

        expect(site.verifies).toEqual([site.codes[0]]);
        await expect(pending).resolves.toMatchObject({ email: EMAIL });
    });

    it('keeps the dialog open after a wrong code and takes the next try', async () => {
        const pending = authManager.signIn();
        await settle();
        await submitEmail();
        const input = field('#sign-in-code');
        const select = jest.spyOn(input, 'select');

        await pasteCode('999999');

        expect(dialog()).not.toBeNull();
        expect(messageText()).toBe("That code isn't right. 9 tries left.");
        expect(field('[data-role="message"]').getAttribute('role')).toBe(
            'alert'
        );
        expect(select).toHaveBeenCalled();

        // Pasting the same wrong code again is a deliberate retry.
        await pasteCode('999999');
        expect(site.verifies).toEqual(['999999', '999999']);
        expect(messageText()).toBe("That code isn't right. 8 tries left.");

        input.value = '';
        await typeCode(site.codes[0]);

        expect(site.verifies.at(-1)).toBe(site.codes[0]);
        await expect(pending).resolves.toMatchObject({ email: EMAIL });
    });

    it('does not submit an incomplete code, and says what is missing', async () => {
        authManager.signIn();
        await settle();
        await submitEmail();

        await typeCode('12a3');
        expect(field('#sign-in-code').value).toBe('123');
        expect(site.verifies).toEqual([]);

        field('[data-step="code"]').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true })
        );
        await settle();
        expect(site.verifies).toEqual([]);
        expect(messageText()).toBe('Enter the 6-digit code from the email.');
    });

    it('waits out the resend cooldown, then sends a new code that works', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const pending = authManager.signIn();
        await settle();
        await submitEmail();
        const resend = field('[data-role="resend"]');

        expect(resend.disabled).toBe(true);
        expect(resend.textContent).toBe('Resend in 30s');
        jest.advanceTimersByTime(10_000);
        expect(resend.textContent).toBe('Resend in 20s');
        jest.advanceTimersByTime(20_000);
        expect(resend.disabled).toBe(false);

        resend.click();
        await settle();

        expect(site.requests).toEqual([EMAIL, EMAIL]);
        expect(messageText()).toBe('We sent a new code.');
        expect(resend.disabled).toBe(true);
        await pasteCode(site.codes[1]);
        await expect(pending).resolves.toMatchObject({ email: EMAIL });
    });

    it('lets the user correct the email address', async () => {
        authManager.signIn();
        await settle();
        await submitEmail('typo@example.con');

        field('[data-role="change-email"]').click();
        expect(field('[data-step="email"]').hidden).toBe(false);
        expect(field('#sign-in-email').value).toBe('typo@example.con');

        await submitEmail();
        expect(site.requests).toEqual(['typo@example.con', EMAIL]);
        expect(field('[data-role="sent-to"]').textContent).toBe(EMAIL);
    });

    it('rejects a malformed email before asking the website', async () => {
        authManager.signIn();
        await settle();
        await submitEmail('not-an-email');

        expect(site.requests).toEqual([]);
        expect(messageText()).toBe('Enter a valid email address.');
    });

    it('stops taking codes after too many wrong ones', async () => {
        authManager.signIn();
        await settle();
        await submitEmail();
        site.failures = 9;

        await pasteCode('999999');

        expect(messageText()).toMatch(/Too many wrong codes/);
        expect(field('#sign-in-code').disabled).toBe(true);
        await pasteCode(site.codes[0]);
        expect(site.verifies).toEqual(['999999']);
    });

    it('keeps the code after a network error so the same code can be sent again', async () => {
        const pending = authManager.signIn();
        await settle();
        await submitEmail();
        site.failNextVerifyWithNetworkError = true;

        await pasteCode(site.codes[0]);
        expect(messageText()).toMatch(/Network error/);
        expect(dialog()).not.toBeNull();

        field('[data-step="code"]').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true })
        );
        await settle();
        await expect(pending).resolves.toMatchObject({ email: EMAIL });
    });

    it('resolves null when cancelled, by button or Escape', async () => {
        const byButton = authManager.signIn();
        await settle();
        field('[data-role="cancel"]').click();
        await expect(byButton).resolves.toBeNull();
        expect(dialog()).toBeNull();

        const byEscape = authManager.ensureCloudSession();
        await settle();
        await submitEmail();
        pressEscape();
        await expect(byEscape).resolves.toBeNull();
        expect(dialog()).toBeNull();
        expect(authManager.isAuthenticated()).toBe(false);
    });

    it('shares one dialog between callers that need sign-in at the same time', async () => {
        const first = authManager.signIn();
        const second = authManager.ensureCloudSession();
        await settle();

        expect(
            document.querySelectorAll('.sign-in-dialog-overlay')
        ).toHaveLength(1);
        await submitEmail();
        await pasteCode(site.codes[0]);

        const [a, b] = await Promise.all([first, second]);
        expect(a).toMatchObject({ email: EMAIL });
        expect(b).toMatchObject({ email: EMAIL });
    });

    it('shows the account in Preferences after sign-in, and clears it on sign-out', async () => {
        document.body.innerHTML = `
            <div id="settings-logged-in" style="display: none">
                <span id="settings-user-email"></span>
                <span id="settings-credits"></span>
            </div>
            <div id="settings-logged-out" style="display: none"></div>
        `;
        const loggedIn = document.getElementById('settings-logged-in');
        const loggedOut = document.getElementById('settings-logged-out');

        const pending = authManager.signIn();
        await settle();
        await submitEmail();
        await pasteCode(site.codes[0]);
        await pending;

        expect(loggedIn.style.display).toBe('block');
        expect(loggedOut.style.display).toBe('none');
        expect(document.getElementById('settings-user-email').textContent).toBe(
            `${EMAIL} • No subscription`
        );

        await authManager.logout();
        expect(loggedIn.style.display).toBe('none');
        expect(loggedOut.style.display).toBe('block');
    });

    it('prefills the last email used', async () => {
        localStorage.setItem('signInEmail', EMAIL);
        authManager.signIn();
        await settle();
        expect(field('#sign-in-email').value).toBe(EMAIL);
    });

    it('does not open the dialog when the caller asks not to', async () => {
        const user = await authManager.ensureCloudSession({
            allowSignInPrompt: false
        });
        expect(user).toBeNull();
        expect(dialog()).toBeNull();
    });
});

describe('sign-in across editor tabs', () => {
    let channels;
    let originalBroadcastChannel;
    let originalFetch;

    beforeEach(() => {
        jest.resetModules();
        channels = [];
        originalBroadcastChannel = global.BroadcastChannel;
        originalFetch = global.fetch;
        global.BroadcastChannel = class {
            constructor(name) {
                this.name = name;
                this.onmessage = null;
                channels.push(this);
            }
            postMessage(data) {
                for (const other of channels) {
                    if (other !== this && other.name === this.name) {
                        other.onmessage?.({ data });
                    }
                }
            }
        };
    });

    afterEach(() => {
        global.BroadcastChannel = originalBroadcastChannel;
        global.fetch = originalFetch;
        document.body.innerHTML = '';
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
    });

    it('signs other tabs in and out without a reload', async () => {
        const site = createFakeWebsite();
        global.fetch = site.fetch;
        require('../js/auth-manager');
        const thisTab = window.authManager;
        await settle();

        const { BroadcastChannel: Channel } = global;
        const otherTab = new Channel('counterpunch-auth');
        const received = [];
        otherTab.onmessage = (event) => received.push(event.data);

        const pending = thisTab.signIn();
        await settle();
        await submitEmail();
        await pasteCode(site.codes[0]);
        await pending;
        expect(received).toEqual([{ type: 'signed-in' }]);

        await thisTab.logout();
        expect(received).toEqual([
            { type: 'signed-in' },
            { type: 'signed-out' }
        ]);

        // A message from another tab updates this one.
        site.token = 'token-from-other-tab';
        document.cookie = 'editor_session=token-from-other-tab; Path=/';
        otherTab.postMessage({ type: 'signed-in' });
        await settle();
        expect(thisTab.isAuthenticated()).toBe(true);
        otherTab.postMessage({ type: 'signed-out' });
        expect(thisTab.isAuthenticated()).toBe(false);
    });
});

describe('sign-in code helpers', () => {
    const {
        describeLoginCodeError,
        extractLoginCode,
        parseLoginCodeErrorBody,
        sanitizeLoginCodeInput
    } = require('../js/sign-in-code');

    it('finds the code in whatever the user pastes', () => {
        expect(extractLoginCode('482913')).toBe('482913');
        expect(extractLoginCode(' 482 913\n')).toBe('482913');
        expect(extractLoginCode('482-913')).toBe('482913');
        expect(
            extractLoginCode('482913 is your Counterpunch sign-in code')
        ).toBe('482913');
        expect(extractLoginCode('Code: 482913. Expires in 10 minutes.')).toBe(
            '482913'
        );
        expect(extractLoginCode('1234567')).toBeNull();
        expect(extractLoginCode('')).toBeNull();
        expect(extractLoginCode(null)).toBeNull();
    });

    it('keeps only digits while typing', () => {
        expect(sanitizeLoginCodeInput('12a3 4')).toBe('1234');
        expect(sanitizeLoginCodeInput('123456789')).toBe('123456');
    });

    it('reads only known fields from an error body', () => {
        expect(
            parseLoginCodeErrorBody({
                code: 'invalid_code',
                attemptsRemaining: 2,
                extra: 1
            })
        ).toEqual({
            code: 'invalid_code',
            attemptsRemaining: 2,
            error: undefined,
            retryAfterSeconds: undefined
        });
        expect(parseLoginCodeErrorBody('nope')).toEqual({});
    });

    it('explains each failure', () => {
        expect(
            describeLoginCodeError(
                { code: 'invalid_code', attemptsRemaining: 1 },
                400
            )
        ).toBe("That code isn't right. 1 try left.");
        expect(describeLoginCodeError({ code: 'code_expired' }, 400)).toMatch(
            /expired/
        );
        expect(describeLoginCodeError({}, 503)).toBe(
            'Something went wrong. Try again.'
        );
    });
});
