// What a save to GitHub says when it can't go through: signed out, a
// sign-in GitHub no longer accepts, or an account without write access.

// fake-indexeddb clones stored values with structuredClone, which jsdom lacks.
if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

require('fake-indexeddb/auto');
const { clear } = require('idb-keyval');
const {
    GitHubPlugin
} = require('../js/filesystem-plugins/plugins/github-plugin');
const {
    addGitHubRepository,
    clearGitHubCredential,
    saveGitHubCredential
} = require('../js/github/github-session');

const API = 'https://api.github.com/repos/o/r';
const SUMMARY = { fontName: 'Fustat', glyphs: ['A'], fontLevel: false };

function json(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body
    };
}

/** A signed-in plugin with one pending write to o/r. */
async function pluginWithPendingSave() {
    await saveGitHubCredential({ token: 't', login: 'tester', avatarUrl: '' });
    await addGitHubRepository('tester', { owner: 'o', repo: 'r' }, 'main');
    const plugin = new GitHubPlugin();
    await plugin.getAdapter().writeFile('/o/r/Fustat.glyphs', 'font');
    return plugin;
}

describe('saving to GitHub explains why it can’t', () => {
    beforeEach(async () => {
        await clear();
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('after signing out', async () => {
        const plugin = await pluginWithPendingSave();
        await clearGitHubCredential();
        global.fetch = jest.fn();

        await expect(plugin.afterSave(SUMMARY)).rejects.toThrow(
            'You’re signed out of GitHub'
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('when GitHub no longer accepts the sign-in', async () => {
        const plugin = await pluginWithPendingSave();
        global.fetch = jest.fn(async () =>
            json({ message: 'Bad credentials' }, 401)
        );

        await expect(plugin.afterSave(SUMMARY)).rejects.toThrow(
            'Your GitHub sign-in has expired or was revoked'
        );
    });

    test('when the account can no longer write to the repository', async () => {
        const plugin = await pluginWithPendingSave();
        global.fetch = jest.fn(async (url) =>
            url === API
                ? json({
                      full_name: 'o/r',
                      default_branch: 'main',
                      permissions: { push: false }
                  })
                : json({ message: 'unexpected' }, 500)
        );

        await expect(plugin.afterSave(SUMMARY)).rejects.toThrow(
            'tester can’t write to o/r'
        );
        // Nothing but the access check reached GitHub.
        expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([API]);
    });

    test('a repository another account added', async () => {
        const plugin = await pluginWithPendingSave();
        await saveGitHubCredential({
            token: 't2',
            login: 'someone-else',
            avatarUrl: ''
        });
        global.fetch = jest.fn();

        await expect(plugin.afterSave(SUMMARY)).rejects.toThrow(
            'o/r isn’t in the repositories of someone-else'
        );
    });
});
