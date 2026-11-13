// The GitHub login and the repositories the GitHub plugin works with.
//
// One token serves the whole editor, like `gh auth login`. Each repository
// added to the editor keeps its base branch and its open change: the working
// branch every save commits to, and that branch's pull request. Everything is
// in IndexedDB, so every window and every font from a repository share one
// change. Nothing here talks to the network.

import { del, get, set, update } from 'idb-keyval';

const CREDENTIAL_KEY = 'github-plugin-credential';
const REPOSITORIES_KEY = 'github-plugin-repositories';

export type GitHubCredential = {
    /** Fine-grained personal access token with Contents and Pull requests write. */
    token: string;
    /** The account the token belongs to. */
    login: string;
};

export type GitHubRepositorySpec = { owner: string; repo: string };

export type GitHubPullRequestRef = { number: number; url: string };

export type GitHubRepository = GitHubRepositorySpec & {
    /** Branch the pull request merges into. */
    baseBranch: string;
    /** Branch of the open change, or null until a save starts one. */
    workingBranch: string | null;
    pullRequest: GitHubPullRequestRef | null;
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

function parseCredential(value: unknown): GitHubCredential | null {
    if (!isRecord(value)) return null;
    const token = readField(value, 'token');
    const login = readField(value, 'login');
    return token && login ? { token, login } : null;
}

function parsePullRequest(value: unknown): GitHubPullRequestRef | null {
    if (!isRecord(value)) return null;
    const number = value.number;
    const url = readField(value, 'url');
    if (typeof number !== 'number' || !url) return null;
    return { number, url };
}

function parseRepository(value: unknown): GitHubRepository | null {
    if (!isRecord(value)) return null;
    const owner = readField(value, 'owner');
    const repo = readField(value, 'repo');
    const baseBranch = readField(value, 'baseBranch');
    if (!owner || !repo || !baseBranch) return null;
    const workingBranch = readField(value, 'workingBranch');
    return {
        owner,
        repo,
        baseBranch,
        workingBranch,
        pullRequest: workingBranch ? parsePullRequest(value.pullRequest) : null
    };
}

function parseRepositories(value: unknown): GitHubRepository[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(parseRepository)
        .filter((repository): repository is GitHubRepository => !!repository);
}

/** GitHub names are case-insensitive. */
export function sameRepository(
    a: GitHubRepositorySpec,
    b: GitHubRepositorySpec
): boolean {
    return (
        a.owner.toLowerCase() === b.owner.toLowerCase() &&
        a.repo.toLowerCase() === b.repo.toLowerCase()
    );
}

/** The branch reads use: the open change's, else the base branch. */
export function readBranch(repository: GitHubRepository): string {
    return repository.workingBranch ?? repository.baseBranch;
}

export async function loadGitHubCredential(): Promise<GitHubCredential | null> {
    try {
        return parseCredential(await get<unknown>(CREDENTIAL_KEY));
    } catch {
        return null;
    }
}

export async function saveGitHubCredential(
    credential: GitHubCredential
): Promise<void> {
    await set(CREDENTIAL_KEY, credential);
}

/** Sign out. The repositories and their open changes stay. */
export async function clearGitHubCredential(): Promise<void> {
    await del(CREDENTIAL_KEY);
}

export async function loadGitHubRepositories(): Promise<GitHubRepository[]> {
    try {
        return parseRepositories(await get<unknown>(REPOSITORIES_KEY));
    } catch {
        return [];
    }
}

/**
 * Change one repository in one IndexedDB transaction, so two windows saving
 * at once do not overwrite each other. `change` gets the stored entry (null
 * when the repository is not added) and returns the new one, or null to
 * remove it. Resolves with what was stored.
 */
async function changeRepository(
    spec: GitHubRepositorySpec,
    change: (current: GitHubRepository | null) => GitHubRepository | null
): Promise<GitHubRepository | null> {
    let result: GitHubRepository | null = null;
    await update<unknown>(REPOSITORIES_KEY, (stored) => {
        const repositories = parseRepositories(stored);
        const index = repositories.findIndex((entry) =>
            sameRepository(entry, spec)
        );
        result = change(index === -1 ? null : repositories[index]);
        if (index === -1) {
            return result ? [...repositories, result] : repositories;
        }
        return result
            ? repositories.map((entry, at) => (at === index ? result : entry))
            : repositories.filter((_, at) => at !== index);
    });
    return result;
}

/** Add a repository, or change its base branch. An open change stays. */
export async function addGitHubRepository(
    spec: GitHubRepositorySpec,
    baseBranch: string
): Promise<GitHubRepository | null> {
    return changeRepository(spec, (current) =>
        current && current.baseBranch === baseBranch
            ? current
            : {
                  owner: spec.owner,
                  repo: spec.repo,
                  baseBranch,
                  workingBranch: null,
                  pullRequest: null
              }
    );
}

export async function removeGitHubRepository(
    spec: GitHubRepositorySpec
): Promise<void> {
    await changeRepository(spec, () => null);
}

/**
 * Make `branch` the repository's working branch, unless another window
 * started a change first: then that change wins and is returned.
 */
export async function claimGitHubWorkingBranch(
    spec: GitHubRepositorySpec,
    branch: string
): Promise<GitHubRepository | null> {
    return changeRepository(spec, (current) =>
        !current || current.workingBranch
            ? current
            : { ...current, workingBranch: branch, pullRequest: null }
    );
}

/** Remember the pull request of the repository's working branch. */
export async function saveGitHubPullRequest(
    spec: GitHubRepositorySpec,
    branch: string,
    pullRequest: GitHubPullRequestRef
): Promise<GitHubRepository | null> {
    return changeRepository(spec, (current) =>
        current?.workingBranch === branch
            ? { ...current, pullRequest }
            : current
    );
}

/** Close the open change; the next save starts a new one. */
export async function endGitHubChange(
    spec: GitHubRepositorySpec
): Promise<GitHubRepository | null> {
    return changeRepository(spec, (current) =>
        current ? { ...current, workingBranch: null, pullRequest: null } : null
    );
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

/** `owner/repo`, for menus and dialogs. */
export function repositoryLabel(spec: GitHubRepositorySpec): string {
    return `${spec.owner}/${spec.repo}`;
}
