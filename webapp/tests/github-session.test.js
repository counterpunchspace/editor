// One GitHub login for the editor; each account keeps its own list of added
// repositories, and each repository its base branch and one open change,
// shared by every window through IndexedDB.

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
const LOGIN = 'tester';
const PULL_REQUEST = { number: 4, url: 'https://github.com/o/r/pull/4' };

beforeEach(async () => {
    await clear();
});

test('one login serves the editor and outlives its repositories', async () => {
    await saveGitHubCredential({
        token: 'gho_test',
        login: 'tester',
        avatarUrl: 'https://avatars.example/u/1'
    });
    await addGitHubRepository(LOGIN, SPEC, 'main');
    await removeGitHubRepository(LOGIN, SPEC);

    await expect(loadGitHubCredential()).resolves.toEqual({
        token: 'gho_test',
        login: 'tester',
        avatarUrl: 'https://avatars.example/u/1'
    });
    await expect(loadGitHubRepositories(LOGIN)).resolves.toEqual([]);
});

test('a login stored before avatars has none', async () => {
    const { set } = require('idb-keyval');
    await set('github-plugin-credential', { token: 't', login: 'tester' });
    await expect(loadGitHubCredential()).resolves.toEqual({
        token: 't',
        login: 'tester',
        avatarUrl: ''
    });
});

test('signing out keeps the repositories and their open changes', async () => {
    await saveGitHubCredential({ token: 't', login: 'tester', avatarUrl: '' });
    await addGitHubRepository(LOGIN, SPEC, 'main');
    await claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-1');
    await clearGitHubCredential();

    await expect(loadGitHubCredential()).resolves.toBeNull();
    const [repository] = await loadGitHubRepositories(LOGIN);
    expect(repository.workingBranch).toBe('counterpunch-1');
});

test('an added repository reads its base branch until a change starts', async () => {
    const added = await addGitHubRepository(LOGIN, SPEC, 'main');
    expect(added).toEqual({
        ...SPEC,
        baseBranch: 'main',
        workingBranch: null,
        pullRequest: null
    });
    expect(readBranch(added)).toBe('main');

    const claimed = await claimGitHubWorkingBranch(
        LOGIN,
        SPEC,
        'counterpunch-1'
    );
    expect(readBranch(claimed)).toBe('counterpunch-1');
});

test('the first window to start a change wins; the second joins it', async () => {
    await addGitHubRepository(LOGIN, SPEC, 'main');
    const [first, second] = await Promise.all([
        claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-1'),
        claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-2')
    ]);
    expect(first.workingBranch).toBe(second.workingBranch);
    const [stored] = await loadGitHubRepositories(LOGIN);
    expect(stored.workingBranch).toBe(first.workingBranch);
});

test('a pull request is kept only for the branch it belongs to', async () => {
    await addGitHubRepository(LOGIN, SPEC, 'main');
    await claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-1');

    await saveGitHubPullRequest(LOGIN, SPEC, 'counterpunch-9', PULL_REQUEST);
    expect((await loadGitHubRepositories(LOGIN))[0].pullRequest).toBeNull();

    await saveGitHubPullRequest(LOGIN, SPEC, 'counterpunch-1', PULL_REQUEST);
    expect((await loadGitHubRepositories(LOGIN))[0].pullRequest).toEqual(
        PULL_REQUEST
    );
});

test('ending a change returns to the base branch', async () => {
    await addGitHubRepository(LOGIN, SPEC, 'main');
    await claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-1');
    await saveGitHubPullRequest(LOGIN, SPEC, 'counterpunch-1', PULL_REQUEST);

    const ended = await endGitHubChange(LOGIN, SPEC);
    expect(ended).toMatchObject({ workingBranch: null, pullRequest: null });
    expect(readBranch(ended)).toBe('main');
});

test('adding a repository again keeps its open change', async () => {
    await addGitHubRepository(LOGIN, SPEC, 'main');
    await claimGitHubWorkingBranch(LOGIN, SPEC, 'counterpunch-1');
    await addGitHubRepository(LOGIN, { owner: 'O', repo: 'R' }, 'main');

    const repositories = await loadGitHubRepositories(LOGIN);
    expect(repositories).toHaveLength(1);
    expect(repositories[0].workingBranch).toBe('counterpunch-1');
});

test('each account keeps its own repositories across signing out', async () => {
    await addGitHubRepository('tester', SPEC, 'main');
    await addGitHubRepository(
        'someone-else',
        { owner: 'x', repo: 'y' },
        'main'
    );
    await clearGitHubCredential();

    expect(
        (await loadGitHubRepositories('Tester')).map((entry) => entry.repo)
    ).toEqual(['r']);
    expect(
        (await loadGitHubRepositories('someone-else')).map(
            (entry) => entry.repo
        )
    ).toEqual(['y']);
    await expect(loadGitHubRepositories('nobody')).resolves.toEqual([]);
});
