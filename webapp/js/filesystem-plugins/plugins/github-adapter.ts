// File access for the GitHub plugin.
//
// Paths carry the repository, so every added repository has its own folder
// and a document key stays unique: `/owner/repo/path/inside/repo`. Reads use
// the git tree and the raw contents endpoint on the repository's read branch
// (its open change, else the base branch). Writes buffer in memory per
// repository and become one commit when the save finishes (`commit`).

import { Logger } from '../../logger';
import type { FileInfo, FileSystemAdapter } from '../../file-system-adapter';
import {
    GitHubApiError,
    GitHubClient,
    type GitHubTreeEntry
} from '../../github/github-client';
import {
    readBranch,
    repositoryLabel,
    sameRepository,
    type GitHubCredential,
    type GitHubRepository,
    type GitHubRepositorySpec
} from '../../github/github-session';

const console = new Logger('GitHubPlugins');

/** Keep a UFO's files in memory, but do not grow without a limit. */
const MAX_BLOB_CACHE_BYTES = 64 * 1024 * 1024;

/** Working branches are `counterpunch-1` … `counterpunch-N`. */
const MAX_WORKING_BRANCH_NUMBER = 50;

/** State the plugin fills in; the adapter reads it on every call. */
export type GitHubAdapterState = {
    credential: GitHubCredential | null;
    repositories: GitHubRepository[];
    /**
     * Resolves once the stored login and repositories are read. A window
     * reads and saves without having listed anything first.
     */
    load: () => Promise<void>;
};

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

type Pending = {
    spec: GitHubRepositorySpec;
    /** Files written in the current save, by path inside the repository. */
    writes: Map<string, Uint8Array>;
    /** Files removed in the current save, by path inside the repository. */
    deletes: Set<string>;
};

type ParsedPath = {
    repository: GitHubRepository;
    relative: string;
    prefix: string;
};

function isGitHubApiError(error: unknown): error is GitHubApiError {
    return error instanceof GitHubApiError;
}

function repositoryKey(spec: GitHubRepositorySpec): string {
    return `${spec.owner}/${spec.repo}`.toLowerCase();
}

export class GitHubAdapter implements FileSystemAdapter {
    private readonly state: GitHubAdapterState;
    private trees = new Map<string, Map<string, GitHubTreeEntry>>();
    private blobCache = new Map<string, Uint8Array>();
    private blobCacheBytes = 0;
    private readonly pending = new Map<string, Pending>();

    constructor(state: GitHubAdapterState) {
        this.state = state;
    }

    /** The folder of a repository, e.g. `/owner/repo`. */
    static repoPrefix(spec: GitHubRepositorySpec): string {
        return `/${spec.owner}/${spec.repo}`;
    }

    /** Drop what was read from a repository, after its read branch changed. */
    forget(spec: GitHubRepositorySpec): void {
        const key = repositoryKey(spec);
        for (const treeKey of [...this.trees.keys()]) {
            if (treeKey.startsWith(`${key}@`)) this.trees.delete(treeKey);
        }
    }

    hasPendingChanges(): boolean {
        return [...this.pending.values()].some(
            (entry) => entry.writes.size > 0 || entry.deletes.size > 0
        );
    }

    /** Repositories with writes or deletes waiting for `commit`. */
    pendingRepositories(): GitHubRepositorySpec[] {
        return [...this.pending.values()]
            .filter((entry) => entry.writes.size > 0 || entry.deletes.size > 0)
            .map((entry) => entry.spec);
    }

    private client(spec: GitHubRepositorySpec): GitHubClient {
        const token = this.state.credential?.token;
        if (!token) throw new Error('Connect GitHub first.');
        return new GitHubClient({ token, owner: spec.owner, repo: spec.repo });
    }

    private findRepository(
        spec: GitHubRepositorySpec
    ): GitHubRepository | null {
        return (
            this.state.repositories.find((entry) =>
                sameRepository(entry, spec)
            ) ?? null
        );
    }

    /** Split an adapter path and find the added repository it belongs to. */
    private async parse(path: string): Promise<ParsedPath> {
        await this.state.load();
        const segments = path.split('/').filter(Boolean);
        if (segments.length < 2) {
            throw new Error(
                'Choose a folder inside a repository. GitHub paths start with /owner/repo.'
            );
        }
        const spec = { owner: segments[0], repo: segments[1] };
        const repository = this.findRepository(spec);
        if (!repository) {
            throw new Error(
                `${repositoryLabel(spec)} is not added to Counterpunch. Add it in the launcher’s GitHub group.`
            );
        }
        return {
            repository,
            relative: segments.slice(2).join('/'),
            prefix: GitHubAdapter.repoPrefix(repository)
        };
    }

    private pendingFor(spec: GitHubRepositorySpec): Pending {
        const key = repositoryKey(spec);
        let entry = this.pending.get(key);
        if (!entry) {
            entry = { spec, writes: new Map(), deletes: new Set() };
            this.pending.set(key, entry);
        }
        return entry;
    }

    private adapterPath(prefix: string, relative: string): string {
        return relative ? `${prefix}/${relative}` : prefix;
    }

    private async loadTree(
        repository: GitHubRepository
    ): Promise<Map<string, GitHubTreeEntry>> {
        const branch = readBranch(repository);
        const treeKey = `${repositoryKey(repository)}@${branch}`;
        const cached = this.trees.get(treeKey);
        if (cached) return cached;
        const tree = await this.client(repository).getTree(branch);
        if (tree.truncated) {
            throw new Error(
                `${repositoryLabel(repository)} has too many files for Counterpunch to list.`
            );
        }
        const files = new Map<string, GitHubTreeEntry>();
        for (const entry of tree.entries) {
            if (entry.type === 'blob') files.set(entry.path, entry);
        }
        console.log(
            `Loaded ${files.size} files from ${repositoryLabel(repository)}@${branch}`
        );
        this.trees.set(treeKey, files);
        return files;
    }

    /** Files as the user sees them: the branch, with this save applied. */
    private async visibleFiles(
        repository: GitHubRepository
    ): Promise<Map<string, number>> {
        const tree = await this.loadTree(repository);
        const pending = this.pending.get(repositoryKey(repository));
        const files = new Map<string, number>();
        for (const [path, entry] of tree) {
            if (!pending?.deletes.has(path)) files.set(path, entry.size);
        }
        for (const [path, bytes] of pending?.writes ?? []) {
            files.set(path, bytes.length);
        }
        return files;
    }

    /** Repository paths of the file, or every file below the folder. */
    private async pathsUnder(
        repository: GitHubRepository,
        relative: string
    ): Promise<string[]> {
        const files = await this.visibleFiles(repository);
        const prefix = relative ? `${relative}/` : '';
        return [...files.keys()].filter(
            (path) => path === relative || (prefix && path.startsWith(prefix))
        );
    }

    /**
     * `/` holds the owners of the added repositories and `/owner` holds that
     * owner's added repositories. Deeper paths are inside a repository.
     */
    private shallowEntries(path: string): Record<string, FileInfo> | null {
        const segments = path.split('/').filter(Boolean);
        if (segments.length >= 2) return null;
        const folder = (itemPath: string): FileInfo => ({
            path: itemPath,
            is_dir: true,
            size: 0,
            mtime: ''
        });
        const items: Record<string, FileInfo> = {};
        for (const repository of this.state.repositories) {
            if (segments.length === 0) {
                items[repository.owner] = folder(`/${repository.owner}`);
            } else if (
                repository.owner.toLowerCase() === segments[0].toLowerCase()
            ) {
                items[repository.repo] = folder(
                    GitHubAdapter.repoPrefix(repository)
                );
            }
        }
        return items;
    }

    async scanDirectory(path: string): Promise<Record<string, FileInfo>> {
        await this.state.load();
        const shallow = this.shallowEntries(path);
        if (shallow) return shallow;
        const { repository, relative, prefix } = await this.parse(path);
        const files = await this.visibleFiles(repository);
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

    /** Every file path in an added repository, as the user sees it. */
    async filePaths(spec: GitHubRepositorySpec): Promise<string[]> {
        await this.state.load();
        const repository = this.findRepository(spec);
        if (!repository) {
            throw new Error(
                `${repositoryLabel(spec)} is not added to Counterpunch.`
            );
        }
        return [...(await this.visibleFiles(repository)).keys()];
    }

    async readFile(path: string): Promise<string | Uint8Array> {
        const { repository, relative } = await this.parse(path);
        const pending = this.pending
            .get(repositoryKey(repository))
            ?.writes.get(relative);
        if (pending) return pending;
        return this.readRepoFile(repository, relative);
    }

    private async readRepoFile(
        repository: GitHubRepository,
        relative: string
    ): Promise<Uint8Array> {
        const tree = await this.loadTree(repository);
        const entry = tree.get(relative);
        const branch = readBranch(repository);
        if (!entry) {
            throw new Error(
                `${relative} is not in ${repositoryLabel(repository)} on ${branch}.`
            );
        }
        const cached = this.blobCache.get(entry.sha);
        if (cached) return cached;
        const bytes = await this.client(repository).getFileBytes(
            relative,
            branch
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
        const { repository, relative } = await this.parse(path);
        if (!relative) {
            throw new Error(
                'Choose a folder inside the repository to save in.'
            );
        }
        const pending = this.pendingFor(repository);
        pending.writes.set(
            relative,
            typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content
        );
        pending.deletes.delete(relative);
    }

    async createFolder(path: string): Promise<void> {
        // Git stores no empty folders: a folder exists once it holds a file.
        await this.parse(path);
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        const { repository, relative } = await this.parse(path);
        const targets = isDir
            ? await this.pathsUnder(repository, relative)
            : [relative];
        const pending = this.pendingFor(repository);
        for (const target of targets) {
            pending.writes.delete(target);
            pending.deletes.add(target);
        }
    }

    async renameItem(
        oldPath: string,
        newName: string,
        isDir: boolean
    ): Promise<void> {
        const { repository, relative } = await this.parse(oldPath);
        const parent = relative.includes('/')
            ? relative.slice(0, relative.lastIndexOf('/'))
            : '';
        const target = parent ? `${parent}/${newName}` : newName;
        const sources = isDir
            ? await this.pathsUnder(repository, relative)
            : [relative];
        const pending = this.pendingFor(repository);
        for (const source of sources) {
            const bytes =
                pending.writes.get(source) ??
                (await this.readRepoFile(repository, source));
            const moved = `${target}${source.slice(relative.length)}`;
            pending.writes.set(moved, bytes);
            pending.writes.delete(source);
            pending.deletes.add(source);
        }
    }

    async fileExists(path: string): Promise<boolean> {
        await this.state.load();
        const shallow = this.shallowEntries(path);
        if (shallow) {
            return (
                path.split('/').filter(Boolean).length === 0 ||
                Object.keys(shallow).length > 0
            );
        }
        let parsed: ParsedPath;
        try {
            parsed = await this.parse(path);
        } catch {
            return false;
        }
        const files = await this.visibleFiles(parsed.repository);
        if (files.has(parsed.relative)) return true;
        const prefix = parsed.relative ? `${parsed.relative}/` : '';
        if (!prefix) return true;
        for (const key of files.keys()) {
            if (key.startsWith(prefix)) return true;
        }
        return false;
    }

    /**
     * Send the repository's buffered writes and deletes as one commit on its
     * working branch. Returns null when the save changed nothing there.
     */
    async commit(
        repository: GitHubRepository,
        message: string
    ): Promise<GitHubCommitResult | null> {
        const branch = repository.workingBranch;
        if (!branch) {
            throw new Error(
                `${repositoryLabel(repository)} has no working branch to commit to.`
            );
        }
        const pending = this.pending.get(repositoryKey(repository));
        if (!pending || (!pending.writes.size && !pending.deletes.size)) {
            return null;
        }
        const writes = new Map(pending.writes);
        const deletes = new Set(pending.deletes);
        const client = this.client(repository);

        const headSha = await client.getBranchHead(branch);
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
        await client.updateBranch(branch, commitSha);

        for (const [path, bytes] of writes) {
            if (pending.writes.get(path) === bytes) pending.writes.delete(path);
        }
        for (const path of deletes) pending.deletes.delete(path);
        this.forget(repository);

        console.log(
            `Committed ${writes.size} file(s) and removed ${deletes.size} on ${repositoryLabel(repository)}@${branch}`
        );
        return {
            branch,
            commitSha,
            files: writes.size,
            deleted: deletes.size
        };
    }

    /**
     * Create a branch for a new change from the base branch: the first free
     * `counterpunch-1`, `counterpunch-2`, …
     */
    async createWorkingBranch(repository: GitHubRepository): Promise<string> {
        const client = this.client(repository);
        const baseSha = await client.getBranchHead(repository.baseBranch);
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
    async ensurePullRequest(
        repository: GitHubRepository,
        options: { title: string; body: string }
    ): Promise<GitHubPullRequestResult> {
        const branch = repository.workingBranch;
        if (!branch) {
            throw new Error(
                'A pull request needs a working branch. Save the font first.'
            );
        }
        const client = this.client(repository);
        const existing = await client.findOpenPullRequest(branch);
        if (existing) return { ...existing, created: false };
        try {
            const created = await client.createPullRequest({
                title: options.title,
                body: options.body,
                head: branch,
                base: repository.baseBranch
            });
            return { ...created, created: true };
        } catch (error: unknown) {
            if (isGitHubApiError(error) && error.status === 422) {
                throw new Error(
                    `GitHub could not open a pull request from ${branch} to ${repository.baseBranch}. If that branch was already merged, start a new change and save again.`
                );
            }
            throw error;
        }
    }
}
