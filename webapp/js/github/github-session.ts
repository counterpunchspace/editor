// The GitHub login and the repositories the GitHub plugin works with.
//
// One token serves the whole editor, like `gh auth login`. Each account has
// its own list of added repositories, kept when it signs out, and each
// repository keeps its base branch and its open change: the working branch
// every save commits to, and that branch's pull request. Everything is in
// IndexedDB, so every window and every font from a repository share one
// change. Nothing here talks to the network.

import { del, get, set, update } from 'idb-keyval';

const CREDENTIAL_KEY = 'github-plugin-credential';
/** `{ [login]: GitHubRepository[] }`: each account keeps its own list. */
const REPOSITORIES_KEY = 'github-plugin-account-repositories';

export type GitHubCredential = {
    /**
     * An OAuth token from signing in through the website (scope `repo`), or
     * a pasted fine-grained token with Contents and Pull requests write.
     */
    token: string;
    /** The account the token belongs to. */
    login: string;
    /** The account's picture, or '' when GitHub sent none. */
    avatarUrl: string;
};

const SIGN_IN_CHANNEL = 'counterpunch-github-sign-in';

/** Tell the other pages of this editor that the GitHub login changed. */
export function announceGitHubSignIn(): void {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.postMessage('changed');
    channel.close();
}

/** Run `listener` when another page signs in to GitHub or out. */
export function onGitHubSignIn(listener: () => void): void {
    new BroadcastChannel(SIGN_IN_CHANNEL).onmessage = () => listener();
}

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
    const avatarUrl = readField(value, 'avatarUrl') ?? '';
    return token && login ? { token, login, avatarUrl } : null;
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

/**
 * Sign out. The account's repository list stays, and comes back when the
 * same account signs in again.
 */
export async function clearGitHubCredential(): Promise<void> {
    await del(CREDENTIAL_KEY);
}

/** GitHub account names are case-insensitive. */
const accountKey = (login: string) => login.toLowerCase();

function readAccounts(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

/** The repositories an account added, in the order it added them. */
export async function loadGitHubRepositories(
    login: string
): Promise<GitHubRepository[]> {
    try {
        const accounts = readAccounts(await get<unknown>(REPOSITORIES_KEY));
        return parseRepositories(accounts[accountKey(login)]);
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
    login: string,
    spec: GitHubRepositorySpec,
    change: (current: GitHubRepository | null) => GitHubRepository | null
): Promise<GitHubRepository | null> {
    let result: GitHubRepository | null = null;
    await update<unknown>(REPOSITORIES_KEY, (stored) => {
        const accounts = readAccounts(stored);
        const key = accountKey(login);
        const repositories = parseRepositories(accounts[key]);
        const index = repositories.findIndex((entry) =>
            sameRepository(entry, spec)
        );
        result = change(index === -1 ? null : repositories[index]);
        const next =
            index === -1
                ? result
                    ? [...repositories, result]
                    : repositories
                : result
                  ? repositories.map((entry, at) =>
                        at === index ? result : entry
                    )
                  : repositories.filter((_, at) => at !== index);
        return { ...accounts, [key]: next };
    });
    return result;
}

/** Add a repository, or change its base branch. An open change stays. */
export async function addGitHubRepository(
    login: string,
    spec: GitHubRepositorySpec,
    baseBranch: string
): Promise<GitHubRepository | null> {
    return changeRepository(login, spec, (current) =>
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
    login: string,
    spec: GitHubRepositorySpec
): Promise<void> {
    await changeRepository(login, spec, () => null);
}

/**
 * Make `branch` the repository's working branch, unless another window
 * started a change first: then that change wins and is returned.
 */
export async function claimGitHubWorkingBranch(
    login: string,
    spec: GitHubRepositorySpec,
    branch: string
): Promise<GitHubRepository | null> {
    return changeRepository(login, spec, (current) =>
        !current || current.workingBranch
            ? current
            : { ...current, workingBranch: branch, pullRequest: null }
    );
}

/** Remember the pull request of the repository's working branch. */
export async function saveGitHubPullRequest(
    login: string,
    spec: GitHubRepositorySpec,
    branch: string,
    pullRequest: GitHubPullRequestRef
): Promise<GitHubRepository | null> {
    return changeRepository(login, spec, (current) =>
        current?.workingBranch === branch
            ? { ...current, pullRequest }
            : current
    );
}

/** Close the open change; the next save starts a new one. */
export async function endGitHubChange(
    login: string,
    spec: GitHubRepositorySpec
): Promise<GitHubRepository | null> {
    return changeRepository(login, spec, (current) =>
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

/**
 * Why Counterpunch can't use a repository the account can only read: every
 * save goes to a branch of the repository itself, with a pull request.
 */
export function writeAccessRefusal(
    login: string,
    spec: GitHubRepositorySpec
): string {
    return `${login} can’t write to ${repositoryLabel(spec)}. Counterpunch saves your edits on a branch of the repository and opens a pull request from it, so it needs write access. Ask the repository’s owner to add you as a collaborator.`;
}

/** `owner/repo`, for menus and dialogs. */
export function repositoryLabel(spec: GitHubRepositorySpec): string {
    return `${spec.owner}/${spec.repo}`;
}
