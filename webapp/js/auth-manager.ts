/**
 * Authentication helper for Font Editor
 * Handles cross-domain authentication with fonteditorwebsite
 */

import { resolveWebsiteURL } from './website-url';
import {
    describeLoginCodeError,
    parseLoginCodeErrorBody
} from './sign-in-code';
import {
    showSignInDialog,
    type RequestCodeOutcome,
    type VerifyCodeOutcome
} from './sign-in-dialog';

const SIGN_IN_EMAIL_KEY = 'signInEmail';
const AUTH_CHANNEL_NAME = 'counterpunch-auth';
const NETWORK_ERROR_MESSAGE =
    'Network error. Check your connection and try again.';

type AuthChannelMessage = { type: 'signed-in' | 'signed-out' };

export type SignInOptions = {
    /** Why sign-in is needed, shown in the dialog. */
    reason?: string;
};

type AuthUser = {
    email?: string;
    [key: string]: unknown;
};

type AuthSubscription = {
    isAdvanced?: boolean;
    canUseAssistant?: boolean;
    productId?: string | null;
    [key: string]: unknown;
};

type AuthCapabilities = {
    canUseAssistant?: boolean;
    [key: string]: unknown;
};

type AuthCredits = {
    amountCents?: number;
    overageAllowed?: boolean;
    [key: string]: unknown;
};

type LocalCloudBootstrapResponse = {
    sessionToken: string;
    user: AuthUser & {
        id: string;
        email: string;
        name: string | null;
    };
};

type EnsureCloudSessionOptions = {
    localEmail?: string;
    /** Open the sign-in dialog when nobody is signed in (default true). */
    allowSignInPrompt?: boolean;
    reason?: string;
};

class AuthManager {
    websiteURL: string;
    user: AuthUser | null;
    subscription: AuthSubscription | null;
    credits: AuthCredits | null;
    sessionToken: string | null = null;
    private localCloudBootstrapPromise: Promise<AuthUser | null> | null = null;
    private initialAuthBootstrapPromise: Promise<void> | null = null;
    private signInPromise: Promise<AuthUser | null> | null = null;
    private authChannel: BroadcastChannel | null = null;
    private announcedAuthenticated: boolean | null = null;

    constructor() {
        this.websiteURL = this.getWebsiteURL();
        this.user = null;
        this.subscription = null;
        this.credits = null;
        this.initialAuthBootstrapPromise = this.checkURLForSessionToken()
            .catch((error) => {
                console.error('[Auth] URL auth bootstrap failed:', error);
            })
            .finally(() => {
                this.initialAuthBootstrapPromise = null;
            });

        this.checkAuthStatus();
        this.listenToOtherTabs();

        // Re-check auth status when tab becomes visible
        // (in case user subscribed in another tab and returns)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.checkAuthStatus();
            }
        });
    }

    /**
     * Check URL for session token passed from login redirect
     */
    async checkURLForSessionToken(): Promise<void> {
        const urlParams = new URLSearchParams(window.location.search);
        const handoffCode = urlParams.get('handoff');

        if (handoffCode) {
            console.log('[Auth] Auth handoff code found in URL');
            try {
                const response = await fetch(
                    `${this.websiteURL}/api/auth/exchange-handoff`,
                    {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code: handoffCode })
                    }
                );

                if (!response.ok) {
                    const body = await response.text().catch(() => '');
                    throw new Error(
                        `auth handoff exchange failed: ${response.status} ${body}`
                    );
                }

                const data = (await response.json()) as {
                    sessionToken?: string;
                };
                if (typeof data.sessionToken === 'string') {
                    this.storeEditorSessionToken(data.sessionToken);
                }
            } finally {
                urlParams.delete('handoff');
                this.replaceUrlAuthParams(urlParams);
            }
            return;
        }

        console.log('[Auth] No auth handoff code in URL');
    }

    private replaceUrlAuthParams(urlParams: URLSearchParams): void {
        const newURL =
            window.location.pathname +
            (urlParams.toString() ? '?' + urlParams.toString() : '') +
            window.location.hash;
        window.history.replaceState({}, '', newURL);
    }

    private storeEditorSessionToken(sessionToken: string): void {
        const isLocalHost =
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';
        const secureFlag =
            window.location.protocol === 'https:' && !isLocalHost
                ? 'Secure; '
                : '';
        const cookieString = `editor_session=${sessionToken}; ${secureFlag}SameSite=Lax; Max-Age=2592000; Path=/`;

        document.cookie = cookieString;
        this.sessionToken = sessionToken;
    }

    getWebsiteURL(): string {
        return resolveWebsiteURL();
    }

    isLocalWebsiteURL(): boolean {
        return this.websiteURL.startsWith('https://localhost:8788');
    }

    /**
     * Check current authentication status with the website
     */
    async checkAuthStatus(): Promise<AuthUser | null> {
        if (this.initialAuthBootstrapPromise) {
            await this.initialAuthBootstrapPromise;
        }

        try {
            // Use already-set session token or read from cookie
            const sessionToken = this.sessionToken || this.getSessionToken();
            const hasLocalSessionArtifacts = document.cookie
                .split(';')
                .map((cookie) => cookie.trim())
                .some(
                    (cookie) =>
                        cookie.startsWith('editor_session=') ||
                        cookie.startsWith('session=')
                );
            console.log('[Auth] Checking auth status...');
            console.log('[Auth] Website URL:', this.websiteURL);

            const headers: Record<string, string> = {};
            if (sessionToken) {
                headers.Authorization = `Bearer ${sessionToken}`;
            }

            const response = await this.fetchAuthMeWithLocalRetry(headers);

            console.log('[Auth] API response status:', response.status);

            if (response.ok) {
                const data = (await response.json()) as {
                    user: AuthUser;
                    subscription: AuthSubscription;
                    capabilities?: AuthCapabilities;
                    credits: AuthCredits;
                };
                console.log('[Auth] API response data:', data);
                this.user = data.user;
                this.subscription = data.subscription
                    ? {
                          ...data.subscription,
                          ...data.capabilities,
                          canUseAssistant:
                              data.capabilities?.canUseAssistant ??
                              data.subscription.canUseAssistant
                      }
                    : data.capabilities
                      ? {
                            ...data.capabilities,
                            canUseAssistant: data.capabilities.canUseAssistant
                        }
                      : null;
                this.credits = data.credits;
                console.log('[Auth] Subscription:', this.subscription);
                console.log('[Auth] Credits:', this.credits);
                this.onAuthStateChanged(true, this.user, this.subscription);
                return this.user;
            } else {
                const errorData = await response.json().catch(() => ({}));
                console.log('[Auth] Authentication failed:', errorData);
                if (response.status === 401 && hasLocalSessionArtifacts) {
                    this.clearLocalSessionToken();
                }
                this.user = null;
                this.subscription = null;
                this.credits = null;
                this.onAuthStateChanged(false, null, null);
                return null;
            }
        } catch (error) {
            console.error('[Auth] Failed to check auth status:', error);
            const offline =
                (typeof navigator !== 'undefined' &&
                    navigator.onLine === false) ||
                error instanceof TypeError;
            if (offline && this.user) {
                return this.user;
            }
            this.user = null;
            this.subscription = null;
            this.credits = null;
            this.onAuthStateChanged(false, null, null);
            return null;
        }
    }

    async fetchAuthMeWithLocalRetry(
        headers: Record<string, string>
    ): Promise<Response> {
        const isLocalWebsite = this.isLocalWebsiteURL();
        const maxAttempts = isLocalWebsite ? 4 : 1;
        const localWebsiteCandidates = isLocalWebsite
            ? [
                  this.websiteURL,
                  'https://localhost:8788',
                  'https://127.0.0.1:8788',
                  'http://localhost:8788',
                  'http://127.0.0.1:8788',
                  'http://[::1]:8788'
              ].filter((url, index, all) => all.indexOf(url) === index)
            : [this.websiteURL];
        let lastResponse: Response | null = null;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            for (const candidateWebsiteURL of localWebsiteCandidates) {
                const authMeUrl = new URL('/api/auth/me', candidateWebsiteURL);
                if (isLocalWebsite) {
                    authMeUrl.searchParams.set('_ts', String(Date.now()));
                }

                try {
                    const response = await fetch(authMeUrl.toString(), {
                        credentials: 'include',
                        cache: 'no-store',
                        headers
                    });
                    lastError = null;
                    lastResponse = response;

                    // Prefer the first candidate that returns anything other than 404.
                    if (response.status !== 404) {
                        if (this.websiteURL !== candidateWebsiteURL) {
                            console.log(
                                '[Auth] Switched local website endpoint candidate:',
                                candidateWebsiteURL
                            );
                            this.websiteURL = candidateWebsiteURL;
                        }
                        return response;
                    }
                } catch (error) {
                    lastError = error;
                    console.warn(
                        '[Auth] /api/auth/me network error:',
                        candidateWebsiteURL,
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }

            if (!(isLocalWebsite && attempt < maxAttempts)) {
                if (!lastResponse && lastError) {
                    throw lastError;
                }
                return lastResponse as Response;
            }

            console.warn(
                '[Auth] /api/auth/me failed on all local loopback candidates, retrying...',
                `attempt ${attempt}/${maxAttempts}`
            );

            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (!lastResponse && lastError) {
            throw lastError;
        }
        return lastResponse as Response;
    }

    async bootstrapLocalCloudSession(
        email = 'local-dev@counterpunch.test'
    ): Promise<AuthUser | null> {
        if (!this.isLocalWebsiteURL()) {
            return this.checkAuthStatus();
        }

        if (this.sessionToken || this.getSessionToken()) {
            return this.checkAuthStatus();
        }

        if (this.localCloudBootstrapPromise) {
            return this.localCloudBootstrapPromise;
        }

        this.localCloudBootstrapPromise = (async () => {
            const response = await fetch(
                `${this.websiteURL}/api/dev/local-cloud-session`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                }
            );

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `local cloud session bootstrap failed: ${response.status} ${body}`
                );
            }

            const data = (await response.json()) as LocalCloudBootstrapResponse;

            this.storeEditorSessionToken(data.sessionToken);

            return await this.checkAuthStatus();
        })();

        try {
            return await this.localCloudBootstrapPromise;
        } finally {
            this.localCloudBootstrapPromise = null;
        }
    }

    async ensureCloudSession(
        options: EnsureCloudSessionOptions = {}
    ): Promise<AuthUser | null> {
        const currentUser = await this.checkAuthStatus();
        if (currentUser) {
            return currentUser;
        }

        const hasExistingSession = Boolean(
            this.sessionToken || this.getSessionToken()
        );
        if (hasExistingSession && this.isLocalWebsiteURL()) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 150 * attempt)
                );
                const retried = await this.checkAuthStatus();
                if (retried) {
                    return retried;
                }
            }
            return null;
        }

        if (this.isLocalWebsiteURL()) {
            return await this.bootstrapLocalCloudSession(options.localEmail);
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return this.user;
        }

        if (options.allowSignInPrompt !== false) {
            return await this.signIn({ reason: options.reason });
        }

        return null;
    }

    /**
     * Get session token from cookie
     */
    getSessionToken(): string | null {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const trimmedCookie = cookie.trim();
            const separatorIndex = trimmedCookie.indexOf('=');
            if (separatorIndex === -1) {
                continue;
            }

            const name = trimmedCookie.slice(0, separatorIndex);
            const value = trimmedCookie.slice(separatorIndex + 1);
            if (name === 'editor_session') {
                return value;
            }
        }
        return null;
    }

    /**
     * Sign in without leaving the page: a dialog asks for the email, then
     * the emailed code. Resolves with the user, or null when cancelled.
     * Calls while the dialog is open share it.
     */
    signIn(options: SignInOptions = {}): Promise<AuthUser | null> {
        if (this.user) {
            return Promise.resolve(this.user);
        }
        if (!this.signInPromise) {
            this.signInPromise = showSignInDialog({
                reason: options.reason,
                initialEmail: this.rememberedSignInEmail(),
                onEmailUsed: (email) => this.rememberSignInEmail(email),
                api: {
                    requestCode: (email) => this.requestSignInCode(email),
                    verifyCode: (email, code) =>
                        this.verifySignInCode(email, code)
                }
            })
                .then((signedIn) => (signedIn ? this.user : null))
                .finally(() => {
                    this.signInPromise = null;
                });
        }
        return this.signInPromise;
    }

    private async requestSignInCode(
        email: string
    ): Promise<RequestCodeOutcome> {
        try {
            const response = await fetch(
                `${this.websiteURL}/api/auth/request-code`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                }
            );
            const body: unknown = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = parseLoginCodeErrorBody(body);
                return {
                    ok: false,
                    message: describeLoginCodeError(error, response.status),
                    retryAfterSeconds: error.retryAfterSeconds ?? null
                };
            }
            const data =
                body && typeof body === 'object'
                    ? (body as Record<string, unknown>)
                    : {};
            return {
                ok: true,
                resendAfterSeconds:
                    typeof data.resendAfterSeconds === 'number'
                        ? data.resendAfterSeconds
                        : 30,
                devCode: typeof data.devCode === 'string' ? data.devCode : null
            };
        } catch {
            return {
                ok: false,
                message: NETWORK_ERROR_MESSAGE,
                retryAfterSeconds: null
            };
        }
    }

    private async verifySignInCode(
        email: string,
        code: string
    ): Promise<VerifyCodeOutcome> {
        let response: Response;
        let body: unknown;
        try {
            response = await fetch(`${this.websiteURL}/api/auth/verify-code`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code })
            });
            body = await response.json().catch(() => ({}));
        } catch {
            return { ok: false, message: NETWORK_ERROR_MESSAGE, locked: false };
        }
        if (!response.ok) {
            const error = parseLoginCodeErrorBody(body);
            return {
                ok: false,
                message: describeLoginCodeError(error, response.status),
                locked: error.code === 'too_many_attempts'
            };
        }
        const token =
            body && typeof body === 'object'
                ? (body as Record<string, unknown>).sessionToken
                : null;
        if (typeof token !== 'string' || !token) {
            return {
                ok: false,
                message:
                    'The website did not return a session for the editor. Try again.',
                locked: false
            };
        }
        this.storeEditorSessionToken(token);
        const user = await this.checkAuthStatus();
        if (!user) {
            return {
                ok: false,
                message:
                    'Signed in, but the account could not be loaded. Try again.',
                locked: false
            };
        }
        this.postToOtherTabs({ type: 'signed-in' });
        return { ok: true };
    }

    private rememberedSignInEmail(): string {
        try {
            return localStorage.getItem(SIGN_IN_EMAIL_KEY) ?? '';
        } catch {
            return '';
        }
    }

    private rememberSignInEmail(email: string): void {
        try {
            localStorage.setItem(SIGN_IN_EMAIL_KEY, email);
        } catch {
            // Private mode or blocked storage: prefilling is a convenience.
        }
    }

    /** Other editor tabs share the cookie but not the in-memory user. */
    private listenToOtherTabs(): void {
        if (typeof BroadcastChannel === 'undefined') {
            return;
        }
        this.authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
        this.authChannel.onmessage = (
            event: MessageEvent<AuthChannelMessage>
        ) => {
            if (event.data?.type === 'signed-out') {
                this.resetSignedOutState();
            } else if (event.data?.type === 'signed-in') {
                void this.checkAuthStatus();
            }
        };
    }

    private postToOtherTabs(message: AuthChannelMessage): void {
        this.authChannel?.postMessage(message);
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return this.user !== null;
    }

    /**
     * Get current user
     */
    getUser() {
        return this.user;
    }

    /**
     * Callback for auth state changes
     * Override this in your app
     */
    onAuthStateChanged(
        isAuthenticated: boolean,
        user: AuthUser | null,
        subscription: AuthSubscription | null
    ) {
        console.log(
            '[Auth] Auth state changed:',
            isAuthenticated,
            user,
            subscription
        );
        this.updateSettingsUI(isAuthenticated, user, subscription);
        // Only on a change: checkAuthStatus runs on every tab focus.
        if (this.announcedAuthenticated !== isAuthenticated) {
            this.announcedAuthenticated = isAuthenticated;
            window.dispatchEvent(
                new CustomEvent('authStateChanged', {
                    detail: { isAuthenticated }
                })
            );
        }
    }

    /**
     * Update settings panel UI based on auth state
     */
    updateSettingsUI(
        isAuthenticated: boolean,
        user: AuthUser | null,
        subscription: AuthSubscription | null
    ) {
        const loggedIn = document.getElementById('settings-logged-in');
        const loggedOut = document.getElementById('settings-logged-out');
        const userEmail = document.getElementById('settings-user-email');
        const creditsEl = document.getElementById('settings-credits');

        if (!loggedIn || !loggedOut || !userEmail) {
            return; // Settings panel not ready yet
        }

        if (isAuthenticated && user) {
            loggedIn.style.display = 'block';
            loggedOut.style.display = 'none';

            // Display email and subscription status
            let statusText = user.email ?? '';
            if (subscription?.isAdvanced) {
                statusText += ' • Advanced';
            } else if (subscription?.productId) {
                statusText += ' • Basic';
            } else {
                statusText += ' • No subscription';
            }
            userEmail.textContent = statusText;

            // Display credit balance
            if (creditsEl) {
                if (this.credits && this.credits.amountCents !== undefined) {
                    const euros = (this.credits.amountCents / 100).toFixed(2);
                    const overageText = this.credits.overageAllowed
                        ? ' • Overage enabled'
                        : '';
                    creditsEl.textContent = `€${euros} credits remaining${overageText}`;
                } else if (subscription?.isAdvanced) {
                    creditsEl.textContent = 'Loading credits...';
                } else {
                    creditsEl.textContent = '';
                }
            }
        } else {
            loggedIn.style.display = 'none';
            loggedOut.style.display = 'block';
        }
    }

    /**
     * Clear stale editor-domain session tokens after website verification fails.
     */
    clearLocalSessionToken() {
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        document.cookie = 'session=; Max-Age=0; Path=/';
        this.sessionToken = null;
    }

    /**
     * Logout - clears session only on the editor domain
     */
    async logout() {
        this.clearLocalSessionToken();
        this.resetSignedOutState();
        this.postToOtherTabs({ type: 'signed-out' });
    }

    private resetSignedOutState() {
        this.user = null;
        this.subscription = null;
        this.credits = null;
        this.localCloudBootstrapPromise = null;
        window.cloudPlugin?.disconnectFromRoom?.();
        this.onAuthStateChanged(false, null, null);
    }
}

// Create global auth manager instance
window.authManager = new AuthManager();

// Set up settings panel login/logout buttons when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsAuth);
} else {
    initSettingsAuth();
}

function initSettingsAuth() {
    const loginBtn = document.getElementById('settings-login-btn');
    const accountBtn = document.getElementById('settings-account-btn');
    const logoutBtn = document.getElementById('settings-logout-btn');

    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            void window.authManager.signIn();
        });
    }

    if (accountBtn) {
        accountBtn.addEventListener('click', () => {
            window.open(`${window.authManager.websiteURL}/account`, '_blank');
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            window.authManager.logout();
        });
    }

    // Update UI with current auth state
    window.authManager.updateSettingsUI(
        window.authManager.isAuthenticated(),
        window.authManager.getUser(),
        window.authManager.subscription
    );
}
