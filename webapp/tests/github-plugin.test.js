// The GitHub adapter turns repository paths into git tree and contents calls,
// and buffers a save into one commit per repository. These tests drive it
// with a stubbed GitHub API and check the requests, not the UI.

const {
    GitHubAdapter
} = require('../js/filesystem-plugins/plugins/github-adapter');
const { commitMessage } = require('../js/github/github-commit-message');
const {
    fontSourcesIn,
    foldersIn,
    gitHubFontKey
} = require('../js/github/github-fonts');

const API = 'https://api.github.com/repos/o/r';
const CREDENTIAL = { token: 'github_pat_test', login: 'tester' };
const REPOSITORY = {
    owner: 'o',
    repo: 'r',
    baseBranch: 'main',
    workingBranch: null,
    pullRequest: null
};
const CHANGE = { ...REPOSITORY, workingBranch: 'counterpunch-1' };
const REPOSITORY_RECORD = {
    full_name: 'o/r',
    default_branch: 'main',
    permissions: { push: true }
};

const TREE = {
    truncated: false,
    tree: [
        { path: 'sources', type: 'tree', sha: 'tree-sources' },
        {
            path: 'sources/Font.glyphs',
            type: 'blob',
            sha: 'blob-font',
            size: 12
        },
        { path: 'sources/Other.ufo', type: 'tree', sha: 'tree-ufo' },
        {
            path: 'sources/Other.ufo/fontinfo.plist',
            type: 'blob',
            sha: 'blob-plist',
            size: 4
        },
        { path: 'README.md', type: 'blob', sha: 'blob-readme', size: 3 }
    ]
};

/**
 * jsdom has no Response, so these stand in for the parts the client reads:
 * `ok`, `status`, `headers`, `json` and `arrayBuffer`.
 */
function json(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body
    };
}

function raw(bytes) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            )
    };
}

/** Route fetch by `METHOD url`, and record every call. */
function routeGitHub(routes) {
    const calls = [];
    global.fetch = jest.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        const key = `${method} ${url}`;
        calls.push({
            method,
            url,
            body: init.body ? JSON.parse(init.body) : null
        });
        const handler = routes[key];
        if (!handler) {
            throw new Error(`Unexpected request ${key}`);
        }
        return handler();
    });
    return calls;
}

function adapter(repositories = [REPOSITORY]) {
    return new GitHubAdapter({
        credential: CREDENTIAL,
        repositories,
        load: async () => {}
    });
}

describe('GitHub adapter', () => {
    afterEach(() => {
        delete global.fetch;
    });

    test('lists a repository folder and its subfolders', async () => {
        routeGitHub({
            [`GET ${API}/git/trees/main?recursive=1`]: () => json(TREE)
        });
        const github = adapter();

        const root = await github.scanDirectory('/o/r');
        expect(Object.keys(root).sort()).toEqual(['README.md', 'sources']);
        expect(root.sources).toEqual({
            path: '/o/r/sources',
            is_dir: true,
            size: 0,
            mtime: ''
        });
        expect(root['README.md'].is_dir).toBe(false);

        const sources = await github.scanDirectory('/o/r/sources');
        expect(Object.keys(sources).sort()).toEqual([
            'Font.glyphs',
            'Other.ufo'
        ]);
        expect(sources['Font.glyphs'].size).toBe(12);
        expect(sources['Other.ufo'].is_dir).toBe(true);

        const ufo = await github.scanDirectory('/o/r/sources/Other.ufo');
        expect(Object.keys(ufo)).toEqual(['fontinfo.plist']);
    });

    test('lists the owners and repositories that are added', async () => {
        routeGitHub({});
        const github = adapter([
            REPOSITORY,
            { ...REPOSITORY, repo: 'second' },
            { ...REPOSITORY, owner: 'foundry', repo: 'family' }
        ]);

        expect(Object.keys(await github.scanDirectory('/')).sort()).toEqual([
            'foundry',
            'o'
        ]);
        expect(await github.scanDirectory('/o')).toEqual({
            r: { path: '/o/r', is_dir: true, size: 0, mtime: '' },
            second: { path: '/o/second', is_dir: true, size: 0, mtime: '' }
        });
        expect(await github.scanDirectory('/elsewhere')).toEqual({});
        expect(await github.fileExists('/o')).toBe(true);
        expect(await github.fileExists('/elsewhere')).toBe(false);
    });

    test('reads a file through the raw contents endpoint', async () => {
        const bytes = new TextEncoder().encode('font bytes');
        const calls = routeGitHub({
            [`GET ${API}/git/trees/main?recursive=1`]: () => json(TREE),
            [`GET ${API}/contents/sources/Font.glyphs?ref=main`]: () =>
                raw(bytes)
        });
        const github = adapter();

        const read = await github.readFile('/o/r/sources/Font.glyphs');
        expect(Buffer.from(read).toString('utf8')).toBe('font bytes');
        // A second read comes from the blob cache.
        await github.readFile('/o/r/sources/Font.glyphs');
        expect(
            calls.filter((call) => call.url.includes('/contents/')).length
        ).toBe(1);
    });

    test('reads the open change’s branch instead of the base branch', async () => {
        const calls = routeGitHub({
            [`GET ${API}/git/trees/counterpunch-1?recursive=1`]: () =>
                json(TREE)
        });
        const github = adapter([CHANGE]);

        await github.scanDirectory('/o/r/sources');
        expect(calls.map((call) => call.url)).toEqual([
            `${API}/git/trees/counterpunch-1?recursive=1`
        ]);
    });

    test('rejects paths in a repository that is not added', async () => {
        const github = adapter();
        await expect(
            github.readFile('/other/repo/sources/Font.glyphs')
        ).rejects.toThrow('is not added to Counterpunch');
    });

    test('publishes one save as one commit with every file', async () => {
        const calls = routeGitHub({
            [`GET ${API}/git/ref/heads/counterpunch-1`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`GET ${API}/git/commits/head-1`]: () =>
                json({ tree: { sha: 'tree-1' } }),
            [`POST ${API}/git/blobs`]: () => json({ sha: 'new-blob' }),
            [`POST ${API}/git/trees`]: () => json({ sha: 'tree-2' }),
            [`POST ${API}/git/commits`]: () => json({ sha: 'commit-2' }),
            [`PATCH ${API}/git/refs/heads/counterpunch-1`]: () => json({})
        });
        const github = adapter([CHANGE]);

        await github.writeFile('/o/r/sources/Font.glyphs', 'one');
        await github.writeFile('/o/r/sources/Other.ufo/fontinfo.plist', 'two');
        expect(github.pendingRepositories()).toEqual([CHANGE]);
        const result = await github.commit(CHANGE, 'Update Font');

        expect(result).toMatchObject({
            branch: 'counterpunch-1',
            commitSha: 'commit-2',
            files: 2,
            deleted: 0
        });

        const treeCall = calls.find((call) => call.url === `${API}/git/trees`);
        expect(treeCall.body.base_tree).toBe('tree-1');
        expect(treeCall.body.tree.map((entry) => entry.path).sort()).toEqual([
            'sources/Font.glyphs',
            'sources/Other.ufo/fontinfo.plist'
        ]);

        const commitCall = calls.find(
            (call) => call.url === `${API}/git/commits`
        );
        expect(commitCall.body.message).toBe('Update Font');
        expect(commitCall.body.parents).toEqual(['head-1']);

        expect(github.hasPendingChanges()).toBe(false);
    });

    test('never commits to the base branch', async () => {
        const github = adapter();
        await github.writeFile('/o/r/sources/Font.glyphs', 'one');
        await expect(github.commit(REPOSITORY, 'Update Font')).rejects.toThrow(
            'no working branch'
        );
    });

    test('waits for the stored repositories before the first write', async () => {
        // A linked window saves without having listed anything first.
        const state = { credential: null, repositories: [] };
        state.load = async () => {
            state.credential = CREDENTIAL;
            state.repositories = [CHANGE];
        };
        const github = new GitHubAdapter(state);
        await github.writeFile('/o/r/sources/Font.glyphs', 'one');
        expect(github.pendingRepositories()).toEqual([CHANGE]);
    });

    test('keeps the saves of two repositories apart', async () => {
        const second = { ...CHANGE, repo: 'second' };
        const github = adapter([CHANGE, second]);
        await github.writeFile('/o/r/a.glyphs', 'one');
        await github.writeFile('/o/second/b.glyphs', 'two');
        expect(
            github
                .pendingRepositories()
                .map((spec) => spec.repo)
                .sort()
        ).toEqual(['r', 'second']);
    });

    test('removes deleted files with a null tree entry', async () => {
        const calls = routeGitHub({
            [`GET ${API}/git/trees/counterpunch-1?recursive=1`]: () =>
                json(TREE),
            [`GET ${API}/git/ref/heads/counterpunch-1`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`GET ${API}/git/commits/head-1`]: () =>
                json({ tree: { sha: 'tree-1' } }),
            [`POST ${API}/git/trees`]: () => json({ sha: 'tree-2' }),
            [`POST ${API}/git/commits`]: () => json({ sha: 'commit-2' }),
            [`PATCH ${API}/git/refs/heads/counterpunch-1`]: () => json({})
        });
        const github = adapter([CHANGE]);

        await github.deleteItem('/o/r/sources/Other.ufo', true);
        await github.commit(CHANGE, 'Remove UFO');

        const treeCall = calls.find((call) => call.url === `${API}/git/trees`);
        expect(treeCall.body.tree).toEqual([
            {
                path: 'sources/Other.ufo/fontinfo.plist',
                mode: '100644',
                type: 'blob',
                sha: null
            }
        ]);
    });

    test('creates the first free working branch from the base branch', async () => {
        const calls = routeGitHub({
            [`GET ${API}`]: () => json(REPOSITORY_RECORD),
            [`GET ${API}/git/ref/heads/main`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`POST ${API}/git/refs`]: () => json({})
        });
        const github = adapter();

        const branch = await github.createWorkingBranch(REPOSITORY);
        expect(branch).toBe('counterpunch-1');
        const create = calls.find((call) => call.url === `${API}/git/refs`);
        expect(create.body).toEqual({
            ref: `refs/heads/${branch}`,
            sha: 'head-1'
        });
    });

    test('takes the next branch number when the name is taken', async () => {
        const calls = routeGitHub({});
        let attempt = 0;
        global.fetch = jest.fn(async (url, init = {}) => {
            const method = init.method ?? 'GET';
            calls.push({
                method,
                url,
                body: init.body ? JSON.parse(init.body) : null
            });
            if (method === 'GET' && url === API) {
                return json(REPOSITORY_RECORD);
            }
            if (method === 'GET') return json({ object: { sha: 'head-1' } });
            attempt += 1;
            if (attempt === 1) {
                return json({ message: 'Reference already exists' }, 422);
            }
            return json({});
        });
        const github = adapter();

        await expect(github.createWorkingBranch(REPOSITORY)).resolves.toBe(
            'counterpunch-2'
        );
        const created = calls
            .filter((call) => call.method === 'POST')
            .map((call) => call.body.ref);
        expect(created).toEqual([
            'refs/heads/counterpunch-1',
            'refs/heads/counterpunch-2'
        ]);
    });

    test('refuses a repository the account can only read', async () => {
        const calls = routeGitHub({
            [`GET ${API}`]: () =>
                json({ ...REPOSITORY_RECORD, permissions: { push: false } })
        });
        const github = adapter();

        await expect(github.requireWriteAccess(REPOSITORY)).rejects.toThrow(
            'tester can’t write to o/r'
        );
        expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    test('a private repository GitHub hides counts as no access', async () => {
        routeGitHub({
            [`GET ${API}`]: () => json({ message: 'Not Found' }, 404)
        });
        await expect(adapter().requireWriteAccess(REPOSITORY)).rejects.toThrow(
            'tester can’t write to o/r'
        );
    });

    test('lists only repositories the account can push to, over every page', async () => {
        const page = (items, next) => ({
            ok: true,
            status: 200,
            headers: {
                get: (name) =>
                    name.toLowerCase() === 'link' && next
                        ? `<https://api.github.com${next}>; rel="next"`
                        : null
            },
            json: async () => items
        });
        const record = (name, push) => ({
            name,
            owner: { login: 'o' },
            default_branch: 'main',
            private: false,
            description: null,
            permissions: { push }
        });
        const first =
            '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100';
        routeGitHub({
            [`GET https://api.github.com${first}`]: () =>
                page(
                    [record('mine', true), record('read-only', false)],
                    '/user/repos?page=2'
                ),
            ['GET https://api.github.com/user/repos?page=2']: () =>
                page([record('theirs', true)], null)
        });
        const { GitHubClient } = require('../js/github/github-client');
        const found = await new GitHubClient({
            token: 't',
            owner: '',
            repo: ''
        }).listWritableRepositories();
        expect(found.map((entry) => entry.repo)).toEqual(['mine', 'theirs']);
        expect(found[0]).toEqual({
            owner: 'o',
            repo: 'mine',
            defaultBranch: 'main',
            private: false,
            description: ''
        });
    });

    test('reuses an open pull request for the working branch', async () => {
        routeGitHub({
            [`GET ${API}/pulls?state=open&head=o%3Acounterpunch%2Fedit&per_page=1`]:
                () =>
                    json([
                        { number: 7, html_url: 'https://github.com/o/r/pull/7' }
                    ])
        });
        const change = { ...REPOSITORY, workingBranch: 'counterpunch/edit' };
        const github = adapter([change]);

        const pullRequest = await github.ensurePullRequest(change, {
            title: 'Edits',
            body: 'Body'
        });
        expect(pullRequest).toEqual({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            created: false
        });
    });

    test('opens a pull request when the branch has none', async () => {
        const calls = routeGitHub({
            [`GET ${API}/pulls?state=open&head=o%3Acounterpunch%2Fedit&per_page=1`]:
                () => json([]),
            [`POST ${API}/pulls`]: () =>
                json({ number: 8, html_url: 'https://github.com/o/r/pull/8' })
        });
        const change = { ...REPOSITORY, workingBranch: 'counterpunch/edit' };
        const github = adapter([change]);

        const pullRequest = await github.ensurePullRequest(change, {
            title: 'Edits',
            body: 'Body'
        });
        expect(pullRequest.created).toBe(true);
        const create = calls.find((call) => call.url === `${API}/pulls`);
        expect(create.body).toMatchObject({
            head: 'counterpunch/edit',
            base: 'main'
        });
    });

    test('refuses a pull request without a working branch', async () => {
        const github = adapter();
        await expect(
            github.ensurePullRequest(REPOSITORY, {
                title: 'Edits',
                body: 'Body'
            })
        ).rejects.toThrow('needs a working branch');
    });
});

describe('GitHub fonts in a repository', () => {
    const FILES = [
        'README.md',
        'sources/Family.glyphs',
        'sources/Family.designspace',
        'sources/Family-Regular.ufo/fontinfo.plist',
        'sources/Family-Regular.ufo/glyphs/a.glif',
        'sources/Package.glyphspackage/fontinfo.plist',
        'fonts/ttf/Family-Regular.ttf'
    ];

    test('lists font files and font folders once', () => {
        expect(fontSourcesIn(FILES)).toEqual([
            { path: 'fonts/ttf/Family-Regular.ttf', format: 'ttf' },
            { path: 'sources/Family-Regular.ufo', format: 'ufo' },
            { path: 'sources/Family.designspace', format: 'designspace' },
            { path: 'sources/Family.glyphs', format: 'glyphs' },
            {
                path: 'sources/Package.glyphspackage',
                format: 'glyphspackage'
            }
        ]);
    });

    test('offers folders to save into, but not inside a font', () => {
        expect(foldersIn(FILES)).toEqual(['', 'fonts', 'fonts/ttf', 'sources']);
    });

    test('a font’s key names its repository', () => {
        expect(
            gitHubFontKey({ owner: 'o', repo: 'r' }, 'sources/Family.glyphs')
        ).toBe('github:///o/r/sources/Family.glyphs');
    });
});

describe('GitHub commit messages', () => {
    const font = { fontName: 'Fustat' };

    test('name a few glyphs', () => {
        expect(
            commitMessage({
                ...font,
                glyphs: ['A', 'B', 'aacute'],
                fontLevel: false
            })
        ).toBe('Edit A, B and aacute in Fustat');
        expect(
            commitMessage({ ...font, glyphs: ['A'], fontLevel: false })
        ).toBe('Edit A in Fustat');
    });

    test('count many glyphs, and mention font data', () => {
        expect(
            commitMessage({
                ...font,
                glyphs: ['a', 'b', 'c', 'd', 'e', 'f'],
                fontLevel: true
            })
        ).toBe('Edit 6 glyphs and font data in Fustat');
        expect(commitMessage({ ...font, glyphs: [], fontLevel: true })).toBe(
            'Edit font data in Fustat'
        );
    });

    test('a whole-font save updates the font', () => {
        expect(commitMessage({ ...font, glyphs: null, fontLevel: true })).toBe(
            'Update Fustat'
        );
    });
});
