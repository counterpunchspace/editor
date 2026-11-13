// The end of a GitHub sign-in: github-login.html trades the one-time code
// from the website for the login, or explains why it can't.

const { finishGitHubSignIn } = require('../js/github/github-sign-in');

function answer(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

const LOGIN = {
    token: 'gho_secret',
    login: 'tester',
    avatarUrl: 'https://avatars.example/u/1'
};

describe('finishing a GitHub sign-in', () => {
    test('trades the code for the login', async () => {
        const exchange = jest.fn(async () => answer(LOGIN));
        const result = await finishGitHubSignIn('?code=c0de', exchange);
        expect(exchange).toHaveBeenCalledWith('c0de');
        expect(result).toEqual({ ok: true, credential: LOGIN });
    });

    test('explains a sign-in the website couldn’t start', async () => {
        const exchange = jest.fn();
        const result = await finishGitHubSignIn('?error=unavailable', exchange);
        expect(exchange).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('access token instead');
    });

    test('a used or expired code asks to start again', async () => {
        const result = await finishGitHubSignIn('?code=old', async () =>
            answer({ error: 'expired' }, 401)
        );
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Start it again');
    });

    test('a page opened without a code does nothing', async () => {
        const exchange = jest.fn();
        const result = await finishGitHubSignIn('', exchange);
        expect(exchange).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
    });

    test('an unreachable website is reported', async () => {
        const result = await finishGitHubSignIn('?code=c0de', async () => {
            throw new TypeError('Failed to fetch');
        });
        expect(result).toEqual({
            ok: false,
            message:
                'Counterpunch couldn’t reach its website to finish the sign-in.'
        });
    });

    test('an answer without a token is not stored', async () => {
        const result = await finishGitHubSignIn('?code=c0de', async () =>
            answer({ login: 'tester' })
        );
        expect(result.ok).toBe(false);
    });
});
