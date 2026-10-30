/**
 * Sign-in code input helpers. The website login page has its own copy in
 * website/webapp/js/login-code.js; keep the two in step.
 */

export const LOGIN_CODE_LENGTH = 6;

const STANDALONE_CODE = new RegExp(`(?<!\\d)\\d{${LOGIN_CODE_LENGTH}}(?!\\d)`);
const WHOLE_CODE = new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`);

/**
 * The code in pasted text: the digits alone ("123456", "123 456",
 * "123-456"), or the one six-digit number in a longer text such as an
 * email line. Null when there is none.
 */
export function extractLoginCode(
    text: string | null | undefined
): string | null {
    const value = String(text ?? '').trim();
    const compact = value.replace(/[\s-]/g, '');
    if (WHOLE_CODE.test(compact)) {
        return compact;
    }
    return value.match(STANDALONE_CODE)?.[0] ?? null;
}

/** What the code field may hold while typing: digits only, at most six. */
export function sanitizeLoginCodeInput(value: string): string {
    return value.replace(/\D/g, '').slice(0, LOGIN_CODE_LENGTH);
}

export type LoginCodeErrorBody = {
    error?: string;
    code?: string;
    attemptsRemaining?: number;
    retryAfterSeconds?: number;
};

/** Narrows a parsed website error body. */
export function parseLoginCodeErrorBody(value: unknown): LoginCodeErrorBody {
    if (!value || typeof value !== 'object') {
        return {};
    }
    const record = value as Record<string, unknown>;
    return {
        error: typeof record.error === 'string' ? record.error : undefined,
        code: typeof record.code === 'string' ? record.code : undefined,
        attemptsRemaining:
            typeof record.attemptsRemaining === 'number'
                ? record.attemptsRemaining
                : undefined,
        retryAfterSeconds:
            typeof record.retryAfterSeconds === 'number'
                ? record.retryAfterSeconds
                : undefined
    };
}

/** The message for a failed request-code or verify-code answer. */
export function describeLoginCodeError(
    data: LoginCodeErrorBody,
    status: number
): string {
    switch (data.code) {
        case 'invalid_code': {
            const left = data.attemptsRemaining;
            return typeof left === 'number'
                ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
                : "That code isn't right.";
        }
        case 'code_expired':
            return 'This code has expired. Send a new one.';
        case 'too_many_attempts':
            return 'Too many wrong codes. Wait a while, then send a new code.';
        case 'resend_too_soon':
        case 'too_many_requests':
        case 'invalid_email':
        case 'invalid_code_format':
        case 'mail_failed':
            return data.error ?? 'Sign-in failed. Try again.';
        default:
            return status >= 500
                ? 'Something went wrong. Try again.'
                : (data.error ?? 'Sign-in failed. Try again.');
    }
}
