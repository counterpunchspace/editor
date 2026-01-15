/**
 * Authentication helper for Font Editor
 * Handles cross-domain authentication with fonteditorwebsite
 */

class AuthManager {
    constructor() {
        this.websiteURL = this.getWebsiteURL();
        this.user = null;
        this.subscription = null;
        this.credits = null;
        this.checkURLForSessionToken();

        this.checkAuthStatus();

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
    checkURLForSessionToken() {
        const urlParams = new URLSearchParams(window.location.search);
        const sessionToken = urlParams.get('session');

        if (sessionToken) {
            console.log(
                '[Auth] Session token found in URL:',
                sessionToken.substring(0, 20) + '...'
            );

            // Store token in cookie for this domain
            // Use Secure only on HTTPS, otherwise it will fail
            const isSecure = window.location.protocol === 'https:';
            const secureFlag = isSecure ? 'Secure; ' : '';
            const cookieString = `editor_session=${sessionToken}; ${secureFlag}SameSite=Lax; Max-Age=2592000; Path=/`;

            document.cookie = cookieString;
            this.sessionToken = sessionToken;

            console.log('[Auth] Cookie set, verifying...');
            const verification = this.getSessionToken();
            console.log(
                '[Auth] Cookie verified:',
                verification ? 'SUCCESS' : 'FAILED'
            );

            // Clean up URL
            urlParams.delete('session');
            const newURL =
                window.location.pathname +
                (urlParams.toString() ? '?' + urlParams.toString() : '') +
                window.location.hash;
            window.history.replaceState({}, '', newURL);
        } else {
            console.log('[Auth] No session token in URL');
        }
    }

    getWebsiteURL() {
        // Detect environment and return appropriate website URL
        const hostname = window.location.hostname;

        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'http://localhost:8788'; // Local development
        }

        // Production/preview font editor URLs
        if (
            hostname === 'editor.counterpunch.space' ||
            hostname === 'preview.editor.counterpunch.space'
        ) {
            return 'https://counterpunch.space';
        }

        // Default to production
        return 'https://counterpunch.space';
    }

    /**
     * Check current authentication status with the website
     */
    async checkAuthStatus() {
        try {
            // Use already-set session token or read from cookie
            const sessionToken = this.sessionToken || this.getSessionToken();
            console.log('[Auth] Checking auth status...');
            console.log(
                '[Auth] Session token:',
                sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE'
            );
            console.log('[Auth] Website URL:', this.websiteURL);

            if (!sessionToken) {
                console.log('[Auth] No session token found');
                this.user = null;
                this.subscription = null;
                this.onAuthStateChanged(false, null, null);
                return null;
            }

            const response = await fetch(`${this.websiteURL}/api/auth/me`, {
                credentials: 'include', // Include cookies for cross-domain
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });

            console.log('[Auth] API response status:', response.status);

            if (response.ok) {
                const data = await response.json();
                console.log('[Auth] API response data:', data);
                this.user = data.user;
                this.subscription = data.subscription;
                this.credits = data.credits;
                console.log('[Auth] User authenticated:', this.user.email);
                console.log('[Auth] Subscription:', this.subscription);
                console.log('[Auth] Credits:', this.credits);
                this.onAuthStateChanged(true, this.user, this.subscription);
                return this.user;
            } else {
                const errorData = await response.json().catch(() => ({}));
                console.log('[Auth] Authentication failed:', errorData);
                this.user = null;
                this.subscription = null;
                this.credits = null;
                this.onAuthStateChanged(false, null, null);
                return null;
            }
        } catch (error) {
            console.error('[Auth] Failed to check auth status:', error);
            this.user = null;
            this.subscription = null;
            this.credits = null;
            this.onAuthStateChanged(false, null, null);
            return null;
        }
    }

    /**
     * Get session token from cookie
     */
    getSessionToken() {
        console.log('[Auth] All cookies:', document.cookie);
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'editor_session') {
                console.log(
                    '[Auth] Found editor session cookie:',
                    value.substring(0, 20) + '...'
                );
                return value;
            }
        }
        console.log('[Auth] Editor session cookie not found');
        return null;
    }

    /**
     * Redirect to website for login
     */
    async login() {
        const returnURL = encodeURIComponent(window.location.href);
        window.location.href = `${this.websiteURL}/login?returnTo=${returnURL}`;
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
    onAuthStateChanged(isAuthenticated, user, subscription) {
        console.log(
            '[Auth] Auth state changed:',
            isAuthenticated,
            user,
            subscription
        );
        this.updateSettingsUI(isAuthenticated, user, subscription);
    }

    /**
     * Update settings panel UI based on auth state
     */
    updateSettingsUI(isAuthenticated, user, subscription) {
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
            let statusText = user.email;
            if (subscription && subscription.isAdvanced) {
                statusText += ' • Advanced';
            } else if (subscription) {
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
                } else if (subscription && subscription.isAdvanced) {
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
     * Logout - clears session only on the editor domain
     */
    async logout() {
        // Clear editor session cookie only
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        this.sessionToken = null;
        this.user = null;
        this.subscription = null;
        this.credits = null;
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
            window.authManager.login();
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
