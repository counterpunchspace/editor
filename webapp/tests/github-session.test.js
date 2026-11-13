// One GitHub login for the editor; each added repository keeps its base
// branch and one open change, shared by every window through IndexedDB.

// fake-indexeddb clones stored values with structuredClone, which jsdom lacks.
if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

require('fake-indexeddb/auto');
const { clear } = require('idb-keyval');

const {
    addGitHubRepository,
    claimGitHubWorkingBranch,
    clearGitHubCredential,
    endGitHubChange,
    loadGitHubCredential,
    loadGitHubRepositories,
    readBranch,
    removeGitHubRepository,
    saveGitHubCredential,
    saveGitHubPullRequest
} = require('../js/github/github-session');

const SPEC = { owner: 'o', repo: 'r' };
const PULL_REQUEST = { number: 4, url: 'https://github.com/o/r/pull/4' };

beforeEach(async () => {
    await clear();
});

test('one login serves the editor and outlives its repositories', async () => {
    await saveGitHubCredential({ token: 'github_pat_test', login: 'tester' });
    await addGitHubRepository(SPEC, 'main');
    await removeGitHubRepository(SPEC);

    await expect(loadGitHubCredential()).resolves.toEqual({
        token: 'github_pat_test',
        login: 'tester'
    });
    await expect(loadGitHubRepositories()).resolves.toEqual([]);
});

test('signing out keeps the repositories and their open changes', async () => {
    await saveGitHubCredential({ token: 'github_pat_test', login: 'tester' });
    await addGitHubRepository(SPEC, 'main');
    await claimGitHubWorkingBranch(SPEC, 'counterpunch-1');
    await clearGitHubCredential();

    await expect(loadGitHubCredential()).resolves.toBeNull();
    const [repository] = await loadGitHubRepositories();
    expect(repository.workingBranch).toBe('counterpunch-1');
});

test('an added repository reads its base branch until a change starts', async () => {
    const added = await addGitHubRepository(SPEC, 'main');
    expect(added).toEqual({
        ...SPEC,
        baseBranch: 'main',
        workingBranch: null,
        pullRequest: null
    });
    expect(readBranch(added)).toBe('main');

    const claimed = await claimGitHubWorkingBranch(SPEC, 'counterpunch-1');
    expect(readBranch(claimed)).toBe('counterpunch-1');
});

test('the first window to start a change wins; the second joins it', async () => {
    await addGitHubRepository(SPEC, 'main');
    const [first, second] = await Promise.all([
        claimGitHubWorkingBranch(SPEC, 'counterpunch-1'),
        claimGitHubWorkingBranch(SPEC, 'counterpunch-2')
    ]);
    expect(first.workingBranch).toBe(second.workingBranch);
    const [stored] = await loadGitHubRepositories();
    expect(stored.workingBranch).toBe(first.workingBranch);
});

test('a pull request is kept only for the branch it belongs to', async () => {
    await addGitHubRepository(SPEC, 'main');
    await claimGitHubWorkingBranch(SPEC, 'counterpunch-1');

    await saveGitHubPullRequest(SPEC, 'counterpunch-9', PULL_REQUEST);
    expect((await loadGitHubRepositories())[0].pullRequest).toBeNull();

    await saveGitHubPullRequest(SPEC, 'counterpunch-1', PULL_REQUEST);
    expect((await loadGitHubRepositories())[0].pullRequest).toEqual(
        PULL_REQUEST
    );
});

test('ending a change returns to the base branch', async () => {
    await addGitHubRepository(SPEC, 'main');
    await claimGitHubWorkingBranch(SPEC, 'counterpunch-1');
    await saveGitHubPullRequest(SPEC, 'counterpunch-1', PULL_REQUEST);

    const ended = await endGitHubChange(SPEC);
    expect(ended).toMatchObject({ workingBranch: null, pullRequest: null });
    expect(readBranch(ended)).toBe('main');
});

test('adding a repository again keeps its open change', async () => {
    await addGitHubRepository(SPEC, 'main');
    await claimGitHubWorkingBranch(SPEC, 'counterpunch-1');
    await addGitHubRepository({ owner: 'O', repo: 'R' }, 'main');

    const repositories = await loadGitHubRepositories();
    expect(repositories).toHaveLength(1);
    expect(repositories[0].workingBranch).toBe('counterpunch-1');
});
