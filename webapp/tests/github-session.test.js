// The GitHub connection is durable; the working branch and its pull request
// belong to one browser session (sessionStorage).

// fake-indexeddb clones stored values with structuredClone, which jsdom lacks.
if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

require('fake-indexeddb/auto');

const {
    clearGitHubSession,
    loadGitHubPullRequest,
    loadGitHubSession,
    loadGitHubWorkingState,
    saveGitHubPullRequest,
    saveGitHubSession
} = require('../js/github/github-session');

const CONFIG = {
    token: 'github_pat_test',
    owner: 'o',
    repo: 'r',
    baseBranch: 'main'
};

const WORKING_KEY = 'github-plugin-working';

beforeEach(() => {
    window.sessionStorage.clear();
});

test('a connected repository with no save yet starts on the base branch', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'main' });
    await expect(loadGitHubSession()).resolves.toEqual({
        ...CONFIG,
        branch: 'main'
    });
});

test('the working branch and its pull request last for the browser session', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-1' });
    saveGitHubPullRequest({
        number: 4,
        url: 'https://github.com/o/r/pull/4'
    });

    await expect(loadGitHubSession()).resolves.toEqual({
        ...CONFIG,
        branch: 'counterpunch-1'
    });
    expect(loadGitHubPullRequest()).toEqual({
        number: 4,
        url: 'https://github.com/o/r/pull/4'
    });
});

test('a new browser session does not reuse the branch', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-1' });
    saveGitHubPullRequest({ number: 4, url: 'https://github.com/o/r/pull/4' });
    window.sessionStorage.clear();

    const loaded = await loadGitHubSession();
    expect(loaded?.branch).toBe('main');
    expect(loadGitHubPullRequest()).toBeNull();
});

test('a working branch from another repository is ignored', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'main' });
    window.sessionStorage.setItem(
        WORKING_KEY,
        JSON.stringify({
            owner: 'someone',
            repo: 'else',
            branch: 'counterpunch-9',
            pullRequest: null
        })
    );

    const loaded = await loadGitHubSession();
    expect(loaded?.branch).toBe('main');
});

test('saving the connection again keeps the pull request of the same branch', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-1' });
    saveGitHubPullRequest({ number: 4, url: 'https://github.com/o/r/pull/4' });
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-1' });
    expect(loadGitHubPullRequest()?.number).toBe(4);
});

test('a new branch drops the previous pull request', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-1' });
    saveGitHubPullRequest({ number: 4, url: 'https://github.com/o/r/pull/4' });
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-2' });
    expect(loadGitHubPullRequest()).toBeNull();
});

test('disconnecting forgets the repository and the branch', async () => {
    await saveGitHubSession({ ...CONFIG, branch: 'counterpunch-2' });
    await clearGitHubSession();

    await expect(loadGitHubSession()).resolves.toBeNull();
    expect(loadGitHubWorkingState()).toBeNull();
});
