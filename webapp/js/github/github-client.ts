// GitHub REST calls for the GitHub filesystem plugin.
//
// Only what opening a font and publishing a save needs: the git tree for
// browsing, raw file contents, and the git data API for one commit with many
// files. Every request goes through one limiter, because opening a UFO or a
// package reads many small files at once.

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** GitHub asks for fewer than 100 concurrent requests per user. */
const MAX_CONCURRENT_REQUESTS = 4;

export type GitHubRepositoryInfo = {
    fullName: string;
    defaultBranch: string;
};

export type GitHubTreeEntry = {
    /** Path inside the repository, with no leading slash. */
    path: string;
    type: 'blob' | 'tree';
    sha: string;
    size: number;
};

export type GitHubTree = {
    entries: GitHubTreeEntry[];
    truncated: boolean;
};

export type GitHubPullRequestInfo = {
    number: number;
    url: string;
};

export type GitHubClientOptions = {
    token: string;
    owner: string;
    repo: string;
};

export class GitHubApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'GitHubApiError';
        this.status = status;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
    record: Record<string, unknown>,
    key: string,
    context: string
): string {
    const value = record[key];
    if (typeof value !== 'string' || !value) {
        throw new Error(`GitHub returned ${context} without ${key}.`);
    }
    return value;
}

function encodePath(path: string): string {
    return path
        .replace(/^\/+/, '')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

let activeRequests = 0;
const waitingRequests: Array<() => void> = [];

async function withRequestSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        await new Promise<void>((resolve) => waitingRequests.push(resolve));
    }
    activeRequests += 1;
    try {
        return await run();
    } finally {
        activeRequests -= 1;
        waitingRequests.shift()?.();
    }
}

/** Bytes as base64, in chunks so long files do not overflow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + chunkSize)
        );
    }
    return btoa(binary);
}

async function describeFailure(response: Response): Promise<string> {
    let detail = '';
    try {
        const body: unknown = await response.json();
        if (isRecord(body) && typeof body.message === 'string') {
            detail = body.message;
        }
        if (
            isRecord(body) &&
            Array.isArray(body.errors) &&
            body.errors.length > 0
        ) {
            const first: unknown = body.errors[0];
            if (isRecord(first) && typeof first.message === 'string') {
                detail = `${detail} ${first.message}`.trim();
            }
        }
    } catch {
        // No JSON body; the status text below is all there is.
    }
    if (response.status === 401) {
        return 'GitHub rejected the token. Check that it has not expired.';
    }
    if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
            const reset = Number(response.headers.get('x-ratelimit-reset'));
            const when =
                Number.isFinite(reset) && reset > 0
                    ? new Date(reset * 1000).toLocaleTimeString()
                    : 'shortly';
            return `GitHub rate limit reached; it resets at ${when}.`;
        }
        return detail || 'GitHub refused the request.';
    }
    if (response.status === 404) {
        return 'GitHub could not find that repository, branch or file.';
    }
    return `GitHub request failed (${response.status})${detail ? `: ${detail}` : '.'}`;
}

export class GitHubClient {
    private readonly token: string;
    private readonly owner: string;
    private readonly repo: string;

    constructor(options: GitHubClientOptions) {
        this.token = options.token;
        this.owner = options.owner;
        this.repo = options.repo;
    }

    /** `owner/repo` of the repository this client works with. */
    get repository(): string {
        return `${this.owner}/${this.repo}`;
    }

    private repoPath(suffix: string): string {
        return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
            this.repo
        )}${suffix}`;
    }

    private refPath(branch: string): string {
        return this.repoPath(`/git/ref/heads/${encodePath(branch)}`);
    }

    /** Update and create use the plural reference path. */
    private refsPath(branch: string): string {
        return this.repoPath(`/git/refs/heads/${encodePath(branch)}`);
    }

    private async request(
        method: string,
        path: string,
        options: { body?: unknown; accept?: string } = {}
    ): Promise<Response> {
        const response = await withRequestSlot(() =>
            fetch(`${API_BASE}${path}`, {
                method,
                headers: {
                    'Accept': options.accept ?? 'application/vnd.github+json',
                    'Authorization': `Bearer ${this.token}`,
                    'X-GitHub-Api-Version': API_VERSION,
                    ...(options.body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' })
                },
                body:
                    options.body === undefined
                        ? undefined
                        : JSON.stringify(options.body)
            })
        );
        if (!response.ok) {
            throw new GitHubApiError(
                response.status,
                await describeFailure(response)
            );
        }
        return response;
    }

    private async json(
        method: string,
        path: string,
        parse: (value: unknown) => unknown,
        body?: unknown
    ): Promise<unknown> {
        const response = await this.request(method, path, { body });
        return parse(await response.json());
    }

    async getRepository(): Promise<GitHubRepositoryInfo> {
        const value = await this.json('GET', this.repoPath(''), (body) => body);
        if (!isRecord(value)) {
            throw new Error('GitHub returned an unexpected repository record.');
        }
        return {
            fullName: requireString(value, 'full_name', 'the repository'),
            defaultBranch: requireString(
                value,
                'default_branch',
                'the repository'
            )
        };
    }

    async branchExists(branch: string): Promise<boolean> {
        try {
            await this.request('GET', this.refPath(branch));
            return true;
        } catch (error: unknown) {
            if (error instanceof GitHubApiError && error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    async getBranchHead(branch: string): Promise<string> {
        const value = await this.json(
            'GET',
            this.refPath(branch),
            (body) => body
        );
        if (!isRecord(value) || !isRecord(value.object)) {
            throw new Error(`GitHub returned no head for branch ${branch}.`);
        }
        return requireString(value.object, 'sha', 'the branch');
    }

    async createBranch(branch: string, fromSha: string): Promise<void> {
        await this.request('POST', this.repoPath('/git/refs'), {
            body: { ref: `refs/heads/${branch}`, sha: fromSha }
        });
    }

    async updateBranch(branch: string, sha: string): Promise<void> {
        await this.request('PATCH', this.refsPath(branch), {
            body: { sha, force: false }
        });
    }

    async getCommitTree(commitSha: string): Promise<string> {
        const value = await this.json(
            'GET',
            this.repoPath(`/git/commits/${commitSha}`),
            (body) => body
        );
        if (!isRecord(value) || !isRecord(value.tree)) {
            throw new Error('GitHub returned a commit without a tree.');
        }
        return requireString(value.tree, 'sha', 'the commit');
    }

    async getTree(ref: string): Promise<GitHubTree> {
        const value = await this.json(
            'GET',
            this.repoPath(`/git/trees/${encodePath(ref)}?recursive=1`),
            (body) => body
        );
        if (!isRecord(value) || !Array.isArray(value.tree)) {
            throw new Error('GitHub returned no file tree.');
        }
        const entries: GitHubTreeEntry[] = [];
        for (const item of value.tree) {
            if (!isRecord(item)) continue;
            const path = item.path;
            const sha = item.sha;
            const type = item.type;
            if (typeof path !== 'string' || typeof sha !== 'string') continue;
            if (type !== 'blob' && type !== 'tree') continue;
            entries.push({
                path,
                sha,
                type,
                size: typeof item.size === 'number' ? item.size : 0
            });
        }
        return { entries, truncated: value.truncated === true };
    }

    /** The file's bytes at `ref`, read through the raw contents endpoint. */
    async getFileBytes(path: string, ref: string): Promise<Uint8Array> {
        const response = await this.request(
            'GET',
            this.repoPath(
                `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
            ),
            { accept: 'application/vnd.github.raw' }
        );
        return new Uint8Array(await response.arrayBuffer());
    }

    async createBlob(bytes: Uint8Array): Promise<string> {
        const value = await this.json(
            'POST',
            this.repoPath('/git/blobs'),
            (body) => body,
            { content: bytesToBase64(bytes), encoding: 'base64' }
        );
        if (!isRecord(value)) {
            throw new Error('GitHub returned no blob for the uploaded file.');
        }
        return requireString(value, 'sha', 'the new blob');
    }

    /** A tree with `baseTree` as its parent. A null sha deletes that path. */
    async createTree(
        baseTree: string,
        entries: Array<{ path: string; sha: string | null }>
    ): Promise<string> {
        const tree = entries.map((entry) => ({
            path: entry.path,
            mode: '100644',
            type: 'blob',
            sha: entry.sha
        }));
        const value = await this.json(
            'POST',
            this.repoPath('/git/trees'),
            (body) => body,
            { base_tree: baseTree, tree }
        );
        if (!isRecord(value)) {
            throw new Error('GitHub returned no tree for the commit.');
        }
        return requireString(value, 'sha', 'the new tree');
    }

    async createCommit(
        message: string,
        treeSha: string,
        parentShas: string[]
    ): Promise<string> {
        const value = await this.json(
            'POST',
            this.repoPath('/git/commits'),
            (body) => body,
            { message, tree: treeSha, parents: parentShas }
        );
        if (!isRecord(value)) {
            throw new Error('GitHub returned no commit.');
        }
        return requireString(value, 'sha', 'the new commit');
    }

    async findOpenPullRequest(
        branch: string
    ): Promise<GitHubPullRequestInfo | null> {
        const query = new URLSearchParams({
            state: 'open',
            head: `${this.owner}:${branch}`,
            per_page: '1'
        });
        const value = await this.json(
            'GET',
            this.repoPath(`/pulls?${query.toString()}`),
            (body) => body
        );
        if (!Array.isArray(value) || value.length === 0) return null;
        const first: unknown = value[0];
        if (!isRecord(first)) return null;
        const number = first.number;
        const url = first.html_url;
        if (typeof number !== 'number' || typeof url !== 'string') return null;
        return { number, url };
    }

    async createPullRequest(options: {
        title: string;
        body: string;
        head: string;
        base: string;
    }): Promise<GitHubPullRequestInfo> {
        const value = await this.json(
            'POST',
            this.repoPath('/pulls'),
            (body) => body,
            options
        );
        if (!isRecord(value)) {
            throw new Error('GitHub returned no pull request.');
        }
        const number = value.number;
        const url = value.html_url;
        if (typeof number !== 'number' || typeof url !== 'string') {
            throw new Error('GitHub returned no pull request.');
        }
        return { number, url };
    }
}
