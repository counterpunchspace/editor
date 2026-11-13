// The repository, token and working branch the GitHub plugin uses.
//
// The token and the repository are durable, in IndexedDB. The working branch
// and its pull request belong to one browser session, in sessionStorage: a
// new session starts a new branch on its first save, and a reload keeps the
// branch it is already using. Nothing here talks to the network.

import { del, get, set } from 'idb-keyval';

const CONFIG_KEY = 'github-plugin-session';
const WORKING_KEY = 'github-plugin-working';

export type GitHubSession = {
    /** Fine-grained personal access token with Contents and Pull requests write. */
    token: string;
    owner: string;
    repo: string;
    /**
     * Branch that reads and commits use. Equal to `baseBranch` until the first
     * save of the browser session creates the working branch.
     */
    branch: string;
    /** Branch the pull request merges into. */
    baseBranch: string;
};

export type GitHubRepositorySpec = { owner: string; repo: string };

export type GitHubPullRequestRef = { number: number; url: string };

export type GitHubWorkingState = {
    owner: string;
    repo: string;
    branch: string;
    pullRequest: GitHubPullRequestRef | null;
};

type StoredConfig = {
    token: string;
    owner: string;
    repo: string;
    baseBranch: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField(
    record: Record<string, unknown>,
    key: string
): string | null {
    const value = record[key];
    return typeof value === 'string' && value ? value : null;
}

function parseConfig(value: unknown): StoredConfig | null {
    if (!isRecord(value)) return null;
    const token = readField(value, 'token');
    const owner = readField(value, 'owner');
    const repo = readField(value, 'repo');
    const baseBranch = readField(value, 'baseBranch');
    if (!token || !owner || !repo || !baseBranch) return null;
    return { token, owner, repo, baseBranch };
}

function parsePullRequest(value: unknown): GitHubPullRequestRef | null {
    if (!isRecord(value)) return null;
    const number = value.number;
    const url = readField(value, 'url');
    if (typeof number !== 'number' || !url) return null;
    return { number, url };
}

/** The working state of this browser session, if it has one. */
export function loadGitHubWorkingState(): GitHubWorkingState | null {
    try {
        const raw = window.sessionStorage.getItem(WORKING_KEY);
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)) return null;
        const owner = readField(value, 'owner');
        const repo = readField(value, 'repo');
        const branch = readField(value, 'branch');
        if (!owner || !repo || !branch) return null;
        return {
            owner,
            repo,
            branch,
            pullRequest: parsePullRequest(value.pullRequest)
        };
    } catch {
        return null;
    }
}

function writeWorkingState(state: GitHubWorkingState): void {
    try {
        window.sessionStorage.setItem(WORKING_KEY, JSON.stringify(state));
    } catch {
        // Storage may be unavailable; the session still works in memory.
    }
}

/** End the working branch; the next save starts a new one. */
export function clearGitHubWorkingState(): void {
    try {
        window.sessionStorage.removeItem(WORKING_KEY);
    } catch {
        // Storage may be unavailable.
    }
}

function sameRepository(
    working: GitHubWorkingState,
    session: { owner: string; repo: string }
): boolean {
    return (
        working.owner.toLowerCase() === session.owner.toLowerCase() &&
        working.repo.toLowerCase() === session.repo.toLowerCase()
    );
}

/** The pull request of this session's working branch, if one is open. */
export function loadGitHubPullRequest(): GitHubPullRequestRef | null {
    return loadGitHubWorkingState()?.pullRequest ?? null;
}

/** Remember the pull request the working branch was published as. */
export function saveGitHubPullRequest(
    pullRequest: GitHubPullRequestRef | null
): void {
    const working = loadGitHubWorkingState();
    if (!working) return;
    writeWorkingState({ ...working, pullRequest });
}

/**
 * The stored session, or null when GitHub has not been connected. A working
 * branch from an earlier browser session is not reused.
 */
export async function loadGitHubSession(): Promise<GitHubSession | null> {
    let config: StoredConfig | null = null;
    try {
        config = parseConfig(await get<unknown>(CONFIG_KEY));
    } catch {
        return null;
    }
    if (!config) return null;
    const working = loadGitHubWorkingState();
    const branch =
        working && sameRepository(working, config)
            ? working.branch
            : config.baseBranch;
    return { ...config, branch };
}

/** Store the connection, and the working branch this session is using. */
export async function saveGitHubSession(session: GitHubSession): Promise<void> {
    await set(CONFIG_KEY, {
        token: session.token,
        owner: session.owner,
        repo: session.repo,
        baseBranch: session.baseBranch
    });
    const working = loadGitHubWorkingState();
    const keepPullRequest =
        !!working &&
        sameRepository(working, session) &&
        working.branch === session.branch;
    writeWorkingState({
        owner: session.owner,
        repo: session.repo,
        branch: session.branch,
        pullRequest: keepPullRequest ? working.pullRequest : null
    });
}

/** Forget the token, the repository and this session's working branch. */
export async function clearGitHubSession(): Promise<void> {
    clearGitHubWorkingState();
    await del(CONFIG_KEY);
}

/**
 * Read `owner/repo` or a GitHub URL. Returns null when the text names nothing
 * that can be a repository.
 */
export function parseRepositorySpec(
    input: string
): GitHubRepositorySpec | null {
    const trimmed = input.trim();
    const fromUrl = trimmed.match(
        /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i
    );
    const parts = fromUrl
        ? [fromUrl[1], fromUrl[2]]
        : trimmed.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    const valid = /^[A-Za-z0-9_.-]+$/;
    if (!valid.test(owner) || !valid.test(repo)) return null;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
        return null;
    }
    return { owner, repo };
}

/** `owner/repo`, for menus and the file dialog tab. */
export function repositoryLabel(session: GitHubSession): string {
    return `${session.owner}/${session.repo}`;
}
