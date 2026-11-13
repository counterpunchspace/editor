// The end of a GitHub sign-in: github-login.html receives a one-time code
// from the website, trades it for the token and stores the login. See the
// website's utils/github-login.js for the whole flow.

import type { GitHubCredential } from './github-session';

export type GitHubSignInResult =
    { ok: true; credential: GitHubCredential } | { ok: false; message: string };

const ERROR_MESSAGES: Record<string, string> = {
    unavailable:
        'GitHub sign-in isn’t set up on this site yet. In the launcher, use an access token instead.',
    denied: 'The sign-in was cancelled on GitHub.',
    expired:
        'The sign-in took too long or was started in another browser. Start it again from the launcher.',
    github: 'GitHub didn’t finish the sign-in. Try again from the launcher.'
};

function isCredential(value: unknown): value is GitHubCredential {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.token === 'string' &&
        !!record.token &&
        typeof record.login === 'string' &&
        !!record.login &&
        typeof record.avatarUrl === 'string'
    );
}

/**
 * Finish the sign-in this page's URL describes. `exchange` posts the code to
 * the website and returns its answer.
 */
export async function finishGitHubSignIn(
    search: string,
    exchange: (code: string) => Promise<Response>
): Promise<GitHubSignInResult> {
    const params = new URLSearchParams(search);
    const error = params.get('error');
    if (error) {
        return {
            ok: false,
            message: ERROR_MESSAGES[error] ?? ERROR_MESSAGES.github
        };
    }
    const code = params.get('code');
    if (!code) return { ok: false, message: ERROR_MESSAGES.expired };
    let response: Response;
    try {
        response = await exchange(code);
    } catch {
        return {
            ok: false,
            message:
                'Counterpunch couldn’t reach its website to finish the sign-in.'
        };
    }
    if (!response.ok) return { ok: false, message: ERROR_MESSAGES.expired };
    const body: unknown = await response.json();
    if (!isCredential(body))
        return { ok: false, message: ERROR_MESSAGES.github };
    return {
        ok: true,
        credential: {
            token: body.token,
            login: body.login,
            avatarUrl: body.avatarUrl
        }
    };
}
