// File access for the GitHub plugin.
//
// Paths carry the repository, so a document key stays unique when the user
// connects a different repository: `/owner/repo/path/inside/repo`. Reads use
// the git tree and the raw contents endpoint; writes buffer in memory and
// become one commit when the save finishes (`commit`).

import { Logger } from '../../logger';
import type { FileInfo, FileSystemAdapter } from '../../file-system-adapter';
import {
    GitHubApiError,
    GitHubClient,
    type GitHubTreeEntry
} from '../../github/github-client';
import type { GitHubSession } from '../../github/github-session';

const console = new Logger('GitHubPlugins');

/** Keep a UFO's files in memory, but do not grow without a limit. */
const MAX_BLOB_CACHE_BYTES = 64 * 1024 * 1024;

/** Working branches are `counterpunch-1` … `counterpunch-N`. */
const MAX_WORKING_BRANCH_NUMBER = 50;

/** A reference that the plugin fills in; the adapter reads it on every call. */
export type GitHubSessionHolder = { current: GitHubSession | null };

export type GitHubCommitResult = {
    branch: string;
    commitSha: string;
    files: number;
    deleted: number;
};

export type GitHubPullRequestResult = {
    number: number;
    url: string;
    created: boolean;
};

type RepoPath = { owner: string; repo: string; path: string };

function isGitHubApiError(error: unknown): error is GitHubApiError {
    return error instanceof GitHubApiError;
}

function splitRepoPath(path: string): RepoPath {
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) {
        throw new Error(
            `"${path}" does not name a GitHub repository. Paths start with /owner/repo.`
        );
    }
    return {
        owner: segments[0],
        repo: segments[1],
        path: segments.slice(2).join('/')
    };
}

export class GitHubAdapter implements FileSystemAdapter {
    private readonly sessionHolder: GitHubSessionHolder;
    private clientCache: { key: string; client: GitHubClient } | null = null;
    private tree: {
        branch: string;
        files: Map<string, GitHubTreeEntry>;
    } | null = null;
    private blobCache = new Map<string, Uint8Array>();
    private blobCacheBytes = 0;
    /** Files written in the current save, by path inside the repository. */
    private readonly writes = new Map<string, Uint8Array>();
    /** Files removed in the current save, by path inside the repository. */
    private readonly deletes = new Set<string>();

    constructor(sessionHolder: GitHubSessionHolder) {
        this.sessionHolder = sessionHolder;
    }

    /** Repository paths this adapter can read, e.g. `/owner/repo`. */
    static repoPrefix(session: { owner: string; repo: string }): string {
        return `/${session.owner}/${session.repo}`;
    }

    /** The branch that reads and commits use. */
    get branch(): string {
        return this.requireSession().branch;
    }

    /** Drop caches after the session (repository or branch) changes. */
    applySession(): void {
        this.tree = null;
        this.blobCache.clear();
        this.blobCacheBytes = 0;
        this.writes.clear();
        this.deletes.clear();
        this.clientCache = null;
    }

    hasPendingChanges(): boolean {
        return this.writes.size > 0 || this.deletes.size > 0;
    }

    private requireSession(): GitHubSession {
        const session = this.sessionHolder.current;
        if (!session) {
            throw new Error('Connect a GitHub repository first.');
        }
        return session;
    }

    private client(session: GitHubSession): GitHubClient {
        const key = `${session.token}\u0000${session.owner}/${session.repo}`;
        if (this.clientCache?.key !== key) {
            this.clientCache = {
                key,
                client: new GitHubClient({
                    token: session.token,
                    owner: session.owner,
                    repo: session.repo
                })
            };
        }
        return this.clientCache.client;
    }

    /** Split an adapter path and check that it belongs to the session. */
    private parse(path: string): { relative: string; prefix: string } {
        const session = this.requireSession();
        const parsed = splitRepoPath(path);
        if (
            parsed.owner.toLowerCase() !== session.owner.toLowerCase() ||
            parsed.repo.toLowerCase() !== session.repo.toLowerCase()
        ) {
            throw new Error(
                `${parsed.owner}/${parsed.repo} is not the connected repository (${session.owner}/${session.repo}).`
            );
        }
        return {
            relative: parsed.path,
            prefix: GitHubAdapter.repoPrefix(session)
        };
    }

    private adapterPath(prefix: string, relative: string): string {
        return relative ? `${prefix}/${relative}` : prefix;
    }

    private async loadTree(): Promise<{
        branch: string;
        files: Map<string, GitHubTreeEntry>;
    }> {
        const session = this.requireSession();
        if (this.tree?.branch === session.branch) return this.tree;
        const tree = await this.client(session).getTree(session.branch);
        if (tree.truncated) {
            throw new Error(
                `${session.owner}/${session.repo} has too many files for Counterpunch to list.`
            );
        }
        const files = new Map<string, GitHubTreeEntry>();
        for (const entry of tree.entries) {
            if (entry.type === 'blob') files.set(entry.path, entry);
        }
        console.log(
            `Loaded ${files.size} files from ${session.owner}/${session.repo}@${session.branch}`
        );
        this.tree = { branch: session.branch, files };
        return this.tree;
    }

    /** Files as the user sees them: the branch, with this save applied. */
    private async visibleFiles(): Promise<Map<string, number>> {
        const tree = await this.loadTree();
        const files = new Map<string, number>();
        for (const [path, entry] of tree.files) {
            if (!this.deletes.has(path)) files.set(path, entry.size);
        }
        for (const [path, bytes] of this.writes) files.set(path, bytes.length);
        return files;
    }

    /** Repository paths of the file, or every file below the folder. */
    private async pathsUnder(relative: string): Promise<string[]> {
        const files = await this.visibleFiles();
        const prefix = relative ? `${relative}/` : '';
        return [...files.keys()].filter(
            (path) => path === relative || (prefix && path.startsWith(prefix))
        );
    }

    /**
     * `/` holds the connected owner and `/owner` holds the repository, so the
     * path bar can walk up out of the repository. Any other shallow path
     * holds nothing.
     */
    private shallowEntries(path: string): Record<string, FileInfo> | null {
        const segments = path.split('/').filter(Boolean);
        if (segments.length >= 2) return null;
        const session = this.sessionHolder.current;
        if (!session) return {};
        const only = (
            name: string,
            itemPath: string
        ): Record<string, FileInfo> => ({
            [name]: { path: itemPath, is_dir: true, size: 0, mtime: '' }
        });
        if (segments.length === 0) {
            return only(session.owner, `/${session.owner}`);
        }
        return segments[0].toLowerCase() === session.owner.toLowerCase()
            ? only(session.repo, GitHubAdapter.repoPrefix(session))
            : {};
    }

    async scanDirectory(path: string): Promise<Record<string, FileInfo>> {
        const shallow = this.shallowEntries(path);
        if (shallow) return shallow;
        const { relative, prefix } = this.parse(path);
        const files = await this.visibleFiles();
        const base = relative ? `${relative.replace(/\/+$/, '')}/` : '';
        const items: Record<string, FileInfo> = {};
        for (const [filePath, size] of files) {
            if (!filePath.startsWith(base)) continue;
            const rest = filePath.slice(base.length);
            if (!rest) continue;
            const slash = rest.indexOf('/');
            const name = slash === -1 ? rest : rest.slice(0, slash);
            if (items[name]) continue;
            const isDir = slash !== -1;
            items[name] = {
                path: this.adapterPath(prefix, `${base}${name}`),
                is_dir: isDir,
                size: isDir ? 0 : size,
                // Git trees carry no file times.
                mtime: ''
            };
        }
        return items;
    }

    async readFile(path: string): Promise<string | Uint8Array> {
        const { relative } = this.parse(path);
        const pending = this.writes.get(relative);
        if (pending) return pending;
        return this.readRepoFile(relative);
    }

    private async readRepoFile(relative: string): Promise<Uint8Array> {
        const session = this.requireSession();
        const tree = await this.loadTree();
        const entry = tree.files.get(relative);
        if (!entry) {
            throw new Error(
                `${relative} is not in ${session.owner}/${session.repo} on ${session.branch}.`
            );
        }
        const cached = this.blobCache.get(entry.sha);
        if (cached) return cached;
        const bytes = await this.client(session).getFileBytes(
            relative,
            session.branch
        );
        this.cacheBlob(entry.sha, bytes);
        return bytes;
    }

    private cacheBlob(sha: string, bytes: Uint8Array): void {
        if (bytes.length > MAX_BLOB_CACHE_BYTES) return;
        if (this.blobCacheBytes + bytes.length > MAX_BLOB_CACHE_BYTES) {
            this.blobCache.clear();
            this.blobCacheBytes = 0;
        }
        this.blobCache.set(sha, bytes);
        this.blobCacheBytes += bytes.length;
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const { relative } = this.parse(path);
        this.writes.set(
            relative,
            typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content
        );
        this.deletes.delete(relative);
    }

    async createFolder(path: string): Promise<void> {
        // Git stores no empty folders: a folder exists once it holds a file.
        this.parse(path);
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        const { relative } = this.parse(path);
        const targets = isDir ? await this.pathsUnder(relative) : [relative];
        for (const target of targets) {
            this.writes.delete(target);
            this.deletes.add(target);
        }
    }

    async renameItem(
        oldPath: string,
        newName: string,
        isDir: boolean
    ): Promise<void> {
        const { relative } = this.parse(oldPath);
        const parent = relative.includes('/')
            ? relative.slice(0, relative.lastIndexOf('/'))
            : '';
        const target = parent ? `${parent}/${newName}` : newName;
        const sources = isDir ? await this.pathsUnder(relative) : [relative];
        for (const source of sources) {
            const bytes =
                this.writes.get(source) ?? (await this.readRepoFile(source));
            const moved = `${target}${source.slice(relative.length)}`;
            this.writes.set(moved, bytes);
            this.writes.delete(source);
            this.deletes.add(source);
        }
    }

    async fileExists(path: string): Promise<boolean> {
        const shallow = this.shallowEntries(path);
        if (shallow) return Object.keys(shallow).length > 0;
        const { relative } = this.parse(path);
        const files = await this.visibleFiles();
        if (files.has(relative)) return true;
        const prefix = relative ? `${relative}/` : '';
        if (!prefix) return false;
        for (const key of files.keys()) {
            if (key.startsWith(prefix)) return true;
        }
        return false;
    }

    /**
     * Send every buffered write and delete as one commit on the current
     * branch. Returns null when the save changed nothing.
     */
    async commit(message: string): Promise<GitHubCommitResult | null> {
        const session = this.requireSession();
        const writes = new Map(this.writes);
        const deletes = new Set(this.deletes);
        if (writes.size === 0 && deletes.size === 0) return null;
        const client = this.client(session);

        const headSha = await client.getBranchHead(session.branch);
        const baseTree = await client.getCommitTree(headSha);
        const entries: Array<{ path: string; sha: string | null }> = [];
        const blobs = await Promise.all(
            [...writes].map(async ([path, bytes]) => ({
                path,
                sha: await client.createBlob(bytes)
            }))
        );
        entries.push(...blobs);
        for (const path of deletes) {
            if (!writes.has(path)) entries.push({ path, sha: null });
        }

        const treeSha = await client.createTree(baseTree, entries);
        const commitSha = await client.createCommit(message, treeSha, [
            headSha
        ]);
        await client.updateBranch(session.branch, commitSha);

        for (const [path, bytes] of writes) {
            if (this.writes.get(path) === bytes) this.writes.delete(path);
        }
        for (const path of deletes) this.deletes.delete(path);
        this.tree = null;
        this.blobCache.clear();
        this.blobCacheBytes = 0;

        console.log(
            `Committed ${writes.size} file(s) and removed ${deletes.size} on ${session.branch}`
        );
        return {
            branch: session.branch,
            commitSha,
            files: writes.size,
            deleted: deletes.size
        };
    }

    /**
     * Create the branch a browser session publishes from, based on the base
     * branch: the first free `counterpunch-1`, `counterpunch-2`, … Returns
     * the branch the session already uses when it has one.
     */
    async createWorkingBranch(): Promise<string> {
        const session = this.requireSession();
        if (session.branch !== session.baseBranch) return session.branch;
        const client = this.client(session);
        const baseSha = await client.getBranchHead(session.baseBranch);
        for (let index = 1; index <= MAX_WORKING_BRANCH_NUMBER; index += 1) {
            const branch = `counterpunch-${index}`;
            try {
                await client.createBranch(branch, baseSha);
                return branch;
            } catch (error: unknown) {
                // 422: the reference already exists. Take the next number.
                if (isGitHubApiError(error) && error.status === 422) continue;
                throw error;
            }
        }
        throw new Error(
            `Could not create a working branch: counterpunch-1 to counterpunch-${MAX_WORKING_BRANCH_NUMBER} are all taken.`
        );
    }

    /** The open pull request for the working branch, created when missing. */
    async ensurePullRequest(options: {
        title: string;
        body: string;
    }): Promise<GitHubPullRequestResult> {
        const session = this.requireSession();
        if (session.branch === session.baseBranch) {
            throw new Error(
                'A pull request needs a working branch. Save the font first.'
            );
        }
        const client = this.client(session);
        const existing = await client.findOpenPullRequest(session.branch);
        if (existing) return { ...existing, created: false };
        try {
            const created = await client.createPullRequest({
                title: options.title,
                body: options.body,
                head: session.branch,
                base: session.baseBranch
            });
            return { ...created, created: true };
        } catch (error: unknown) {
            if (isGitHubApiError(error) && error.status === 422) {
                throw new Error(
                    `GitHub could not open a pull request from ${session.branch} to ${session.baseBranch}. If that branch was already merged, start a new change and save again.`
                );
            }
            throw error;
        }
    }
}
