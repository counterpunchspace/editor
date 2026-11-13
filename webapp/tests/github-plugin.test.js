// The GitHub adapter turns repository paths into git tree and contents calls,
// and buffers a save into one commit. These tests drive it with a stubbed
// GitHub API and check the requests, not the UI.

const {
    GitHubAdapter
} = require('../js/filesystem-plugins/plugins/github-adapter');

const API = 'https://api.github.com/repos/o/r';
const SESSION = {
    token: 'github_pat_test',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    baseBranch: 'main'
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

function adapter(session = SESSION) {
    return new GitHubAdapter({ current: session });
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

    test('lists the connected owner and repository above the repository root', async () => {
        routeGitHub({});
        const github = adapter();

        expect(Object.keys(await github.scanDirectory('/'))).toEqual(['o']);
        expect(await github.scanDirectory('/o')).toEqual({
            r: { path: '/o/r', is_dir: true, size: 0, mtime: '' }
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

    test('rejects paths that point at another repository', async () => {
        const github = adapter();
        await expect(
            github.readFile('/other/repo/sources/Font.glyphs')
        ).rejects.toThrow('not the connected repository');
    });

    test('publishes one save as one commit with every file', async () => {
        const calls = routeGitHub({
            [`GET ${API}/git/trees/main?recursive=1`]: () => json(TREE),
            [`GET ${API}/git/ref/heads/main`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`GET ${API}/git/commits/head-1`]: () =>
                json({ tree: { sha: 'tree-1' } }),
            [`POST ${API}/git/blobs`]: () => json({ sha: 'new-blob' }),
            [`POST ${API}/git/trees`]: () => json({ sha: 'tree-2' }),
            [`POST ${API}/git/commits`]: () => json({ sha: 'commit-2' }),
            [`PATCH ${API}/git/refs/heads/main`]: () => json({})
        });
        const github = adapter();

        await github.writeFile('/o/r/sources/Font.glyphs', 'one');
        await github.writeFile('/o/r/sources/Other.ufo/fontinfo.plist', 'two');
        const result = await github.commit('Update Font');

        expect(result).toMatchObject({
            branch: 'main',
            commitSha: 'commit-2',
            files: 2,
            deleted: 0
        });

        const treeCall = calls.find((call) => call.url === `${API}/git/trees`);
        expect(treeCall.body.base_tree).toBe('tree-1');
        expect(treeCall.body.tree).toHaveLength(2);
        expect(treeCall.body.tree.map((entry) => entry.path).sort()).toEqual([
            'sources/Font.glyphs',
            'sources/Other.ufo/fontinfo.plist'
        ]);

        const commitCall = calls.find(
            (call) => call.url === `${API}/git/commits`
        );
        expect(commitCall.body.parents).toEqual(['head-1']);
        expect(commitCall.body.tree).toBe('tree-2');

        expect(github.hasPendingChanges()).toBe(false);
    });

    test('removes deleted files with a null tree entry', async () => {
        const calls = routeGitHub({
            [`GET ${API}/git/trees/main?recursive=1`]: () => json(TREE),
            [`GET ${API}/git/ref/heads/main`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`GET ${API}/git/commits/head-1`]: () =>
                json({ tree: { sha: 'tree-1' } }),
            [`POST ${API}/git/trees`]: () => json({ sha: 'tree-2' }),
            [`POST ${API}/git/commits`]: () => json({ sha: 'commit-2' }),
            [`PATCH ${API}/git/refs/heads/main`]: () => json({})
        });
        const github = adapter();

        await github.deleteItem('/o/r/sources/Other.ufo', true);
        await github.commit('Remove UFO');

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
            [`GET ${API}/git/ref/heads/main`]: () =>
                json({ object: { sha: 'head-1' } }),
            [`POST ${API}/git/refs`]: () => json({})
        });
        const github = adapter();

        const branch = await github.createWorkingBranch();
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
            if (method === 'GET') return json({ object: { sha: 'head-1' } });
            attempt += 1;
            if (attempt === 1) {
                return json({ message: 'Reference already exists' }, 422);
            }
            return json({});
        });
        const github = adapter();

        await expect(github.createWorkingBranch()).resolves.toBe(
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

    test('reuses an open pull request for the working branch', async () => {
        routeGitHub({
            [`GET ${API}/pulls?state=open&head=o%3Acounterpunch%2Fedit&per_page=1`]:
                () =>
                    json([
                        { number: 7, html_url: 'https://github.com/o/r/pull/7' }
                    ])
        });
        const github = adapter({
            ...SESSION,
            branch: 'counterpunch/edit'
        });

        const pullRequest = await github.ensurePullRequest({
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
        const github = adapter({
            ...SESSION,
            branch: 'counterpunch/edit'
        });

        const pullRequest = await github.ensurePullRequest({
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

    test('refuses a pull request from the base branch', async () => {
        const github = adapter();
        await expect(
            github.ensurePullRequest({ title: 'Edits', body: 'Body' })
        ).rejects.toThrow('needs a working branch');
    });
});
