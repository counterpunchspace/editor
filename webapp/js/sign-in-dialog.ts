/**
 * Sign-in dialog: email, then the six-digit code from the email. The editor
 * page never navigates, so open fonts stay open. Pasting or autofilling a
 * whole code submits it right away; a wrong code keeps the dialog open with
 * the field selected for the next try.
 */

import { bindModalEscape } from './ui/modal-escape';
import {
    extractLoginCode,
    LOGIN_CODE_LENGTH,
    sanitizeLoginCodeInput
} from './sign-in-code';

export type RequestCodeOutcome =
    | { ok: true; resendAfterSeconds: number; devCode: string | null }
    | { ok: false; message: string; retryAfterSeconds: number | null };

export type VerifyCodeOutcome =
    { ok: true } | { ok: false; message: string; locked: boolean };

export type SignInDialogApi = {
    requestCode: (email: string) => Promise<RequestCodeOutcome>;
    verifyCode: (email: string, code: string) => Promise<VerifyCodeOutcome>;
};

export type SignInDialogOptions = {
    api: SignInDialogApi;
    /** Why sign-in is needed, e.g. "Sign in to save fonts to the cloud." */
    reason?: string;
    initialEmail?: string;
    /** Called with the address a code was sent to, to prefill next time. */
    onEmailUsed?: (email: string) => void;
};

const DEFAULT_REASON =
    "Enter your email and we'll send you a 6-digit code. Your open fonts stay open.";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function requireElement<T extends Element>(
    root: ParentNode,
    selector: string
): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Sign-in dialog is missing ${selector}`);
    }
    return element;
}

/** Resolves true once signed in, false when the user cancels. */
export function showSignInDialog(
    options: SignInDialogOptions
): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay sign-in-dialog-overlay';
        overlay.style.display = 'flex';
        // Above the file dialog (11000+), which opens it from the Cloud tab.
        overlay.style.zIndex = '11500';
        overlay.innerHTML = `
            <div class="info-popup confirm-dialog sign-in-dialog" role="dialog" aria-modal="true" aria-labelledby="sign-in-dialog-title">
                <div class="info-popup-header">
                    <h3 id="sign-in-dialog-title">Sign In</h3>
                    <button type="button" class="info-popup-close" data-role="close" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content confirm-dialog-content">
                    <form class="sign-in-step" data-step="email" novalidate>
                        <p>${escapeHtml(options.reason ?? DEFAULT_REASON)}</p>
                        <label class="sign-in-label" for="sign-in-email">Email</label>
                        <input id="sign-in-email" class="dialog-input sign-in-input" type="email" name="email" autocomplete="email" placeholder="you@example.com" />
                        <div class="confirm-dialog-actions">
                            <button type="button" class="dialog-button" data-role="cancel">Cancel</button>
                            <button type="submit" class="dialog-button dialog-button-primary" data-role="send">Send Code</button>
                        </div>
                    </form>
                    <form class="sign-in-step" data-step="code" novalidate hidden>
                        <p>We sent a code to <strong data-role="sent-to"></strong>. <button type="button" class="sign-in-link" data-role="change-email">Change email</button></p>
                        <label class="sign-in-label" for="sign-in-code">Sign-in code</label>
                        <input id="sign-in-code" class="dialog-input sign-in-input sign-in-code-input" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" placeholder="000000" />
                        <div class="confirm-dialog-actions">
                            <button type="button" class="dialog-button sign-in-resend" data-role="resend">Resend Code</button>
                            <button type="submit" class="dialog-button dialog-button-primary" data-role="verify">Sign In</button>
                        </div>
                    </form>
                    <p class="sign-in-message" data-role="message" aria-live="polite" hidden></p>
                </div>
            </div>
        `;

        const emailForm = requireElement<HTMLFormElement>(
            overlay,
            '[data-step="email"]'
        );
        const codeForm = requireElement<HTMLFormElement>(
            overlay,
            '[data-step="code"]'
        );
        const emailInput = requireElement<HTMLInputElement>(
            overlay,
            '#sign-in-email'
        );
        const codeInput = requireElement<HTMLInputElement>(
            overlay,
            '#sign-in-code'
        );
        const sendButton = requireElement<HTMLButtonElement>(
            overlay,
            '[data-role="send"]'
        );
        const verifyButton = requireElement<HTMLButtonElement>(
            overlay,
            '[data-role="verify"]'
        );
        const resendButton = requireElement<HTMLButtonElement>(
            overlay,
            '[data-role="resend"]'
        );
        const sentTo = requireElement<HTMLElement>(
            overlay,
            '[data-role="sent-to"]'
        );
        const message = requireElement<HTMLElement>(
            overlay,
            '[data-role="message"]'
        );

        emailInput.value = options.initialEmail ?? '';

        let email = '';
        let sending = false;
        let verifying = false;
        let locked = false;
        let finished = false;
        let lastSubmitted = '';
        let resendTimer: ReturnType<typeof setInterval> | null = null;

        const showMessage = (kind: 'error' | 'info' | '', text: string) => {
            message.textContent = text;
            message.hidden = !text;
            message.className = `sign-in-message${kind ? ` sign-in-message-${kind}` : ''}`;
            message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        };

        const stopResendCooldown = () => {
            if (resendTimer !== null) clearInterval(resendTimer);
            resendTimer = null;
            resendButton.disabled = false;
            resendButton.textContent = 'Resend Code';
        };

        const startResendCooldown = (seconds: number) => {
            if (resendTimer !== null) clearInterval(resendTimer);
            const until = Date.now() + Math.max(0, seconds) * 1000;
            const tick = () => {
                const left = Math.ceil((until - Date.now()) / 1000);
                if (left <= 0) {
                    stopResendCooldown();
                    return;
                }
                resendButton.disabled = true;
                resendButton.textContent = `Resend in ${left}s`;
            };
            tick();
            if (resendButton.disabled) resendTimer = setInterval(tick, 1000);
        };

        const finish = (signedIn: boolean) => {
            if (finished) return;
            finished = true;
            if (resendTimer !== null) clearInterval(resendTimer);
            escapeBinding.release();
            overlay.remove();
            resolve(signedIn);
        };

        const escapeBinding = bindModalEscape(() => finish(false), {
            isOpen: () => overlay.isConnected
        });

        const showCodeStep = () => {
            emailForm.hidden = true;
            codeForm.hidden = false;
            sentTo.textContent = email;
            locked = false;
            lastSubmitted = '';
            codeInput.disabled = false;
            codeInput.value = '';
            codeInput.focus();
        };

        const requestCode = async (): Promise<boolean> => {
            if (sending) return false;
            sending = true;
            sendButton.disabled = true;
            sendButton.textContent = 'Sending…';
            resendButton.disabled = true;
            try {
                const outcome = await options.api.requestCode(email);
                if (finished) return false;
                if (!outcome.ok) {
                    showMessage('error', outcome.message);
                    if (outcome.retryAfterSeconds) {
                        startResendCooldown(outcome.retryAfterSeconds);
                    } else {
                        stopResendCooldown();
                    }
                    return false;
                }
                options.onEmailUsed?.(email);
                startResendCooldown(outcome.resendAfterSeconds);
                showMessage(
                    'info',
                    outcome.devCode
                        ? `Local development: your code is ${outcome.devCode}.`
                        : "Check your inbox, and the spam folder if it isn't there."
                );
                return true;
            } finally {
                sending = false;
                sendButton.disabled = false;
                sendButton.textContent = 'Send Code';
            }
        };

        const verify = async (code: string) => {
            if (verifying || locked || finished) return;
            verifying = true;
            lastSubmitted = code;
            codeInput.readOnly = true;
            verifyButton.disabled = true;
            verifyButton.textContent = 'Signing in…';
            try {
                const outcome = await options.api.verifyCode(email, code);
                if (finished) return;
                if (outcome.ok) {
                    finish(true);
                    return;
                }
                showMessage('error', outcome.message);
                if (outcome.locked) {
                    locked = true;
                    codeInput.disabled = true;
                }
            } finally {
                verifying = false;
                if (!finished) {
                    codeInput.readOnly = false;
                    verifyButton.disabled = false;
                    verifyButton.textContent = 'Sign In';
                    if (!locked) codeInput.select();
                }
            }
        };

        const submitIfComplete = () => {
            const code = codeInput.value;
            if (code.length === LOGIN_CODE_LENGTH && code !== lastSubmitted) {
                void verify(code);
            }
        };

        emailForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const value = emailInput.value.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                showMessage('error', 'Enter a valid email address.');
                emailInput.focus();
                return;
            }
            email = value;
            void requestCode().then((sent) => {
                if (sent) showCodeStep();
            });
        });

        codeInput.addEventListener('paste', (event) => {
            const code = extractLoginCode(event.clipboardData?.getData('text'));
            if (!code) return;
            event.preventDefault();
            codeInput.value = code;
            // Pasting again is a deliberate retry, even with the same code.
            lastSubmitted = '';
            submitIfComplete();
        });

        codeInput.addEventListener('input', () => {
            const clean = sanitizeLoginCodeInput(codeInput.value);
            if (clean !== codeInput.value) codeInput.value = clean;
            if (clean.length < LOGIN_CODE_LENGTH) lastSubmitted = '';
            submitIfComplete();
        });

        codeForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const code = sanitizeLoginCodeInput(codeInput.value);
            if (code.length !== LOGIN_CODE_LENGTH) {
                showMessage(
                    'error',
                    `Enter the ${LOGIN_CODE_LENGTH}-digit code from the email.`
                );
                codeInput.focus();
                return;
            }
            void verify(code);
        });

        resendButton.addEventListener('click', () => {
            void requestCode().then((sent) => {
                if (!sent) return;
                showCodeStep();
                showMessage('info', 'We sent a new code.');
            });
        });

        requireElement<HTMLButtonElement>(
            overlay,
            '[data-role="change-email"]'
        ).addEventListener('click', () => {
            stopResendCooldown();
            codeForm.hidden = true;
            emailForm.hidden = false;
            showMessage('', '');
            emailInput.focus();
            emailInput.select();
        });

        for (const selector of [
            '[data-role="cancel"]',
            '[data-role="close"]'
        ]) {
            requireElement<HTMLButtonElement>(
                overlay,
                selector
            ).addEventListener('click', () => finish(false));
        }

        document.body.appendChild(overlay);
        emailInput.focus();
        if (emailInput.value) emailInput.select();
    });
}
