// GitHub: read fonts from repositories and save edits as pull requests.
//
// The launcher signs the editor in (one token, like `gh auth login`) and
// adds repositories (github/github-dialogs.ts); a font window gets its font
// by URL and never shows a file dialog. Each repository has at most one open
// change, shared by every font and window that uses it: the first save
// creates a working branch from the base branch, commits there and opens a
// pull request; every later save adds a commit to that branch.

import { Logger } from '../../logger';
import { commitMessage } from '../../github/github-commit-message';
import { foldersIn } from '../../github/github-fonts';
import {
    claimGitHubWorkingBranch,
    loadGitHubCredential,
    loadGitHubRepositories,
    readBranch,
    repositoryLabel,
    sameRepository,
    saveGitHubPullRequest,
    type GitHubPullRequestRef,
    type GitHubRepository,
    type GitHubRepositorySpec
} from '../../github/github-session';
import {
    FilesystemPlugin,
    type FileContextAction,
    type FileContextTarget,
    type SaveSummary
} from '../filesystem-plugin';
import { GitHubAdapter, type GitHubAdapterState } from './github-adapter';
import { escapeHtml, openDialog } from '../../font-windows/dialogs';

const console = new Logger('GitHubPlugins');

const PULL_REQUEST_BODY = [
    'This pull request was opened from Counterpunch. Every save adds a commit to it.',
    '',
    'Review the change, then merge it.'
].join('\n');

export class GitHubPlugin extends FilesystemPlugin {
    private readonly state: GitHubAdapterState;
    private readonly githubAdapter: GitHubAdapter;
    private loading: Promise<void> | null = null;

    constructor() {
        const state: GitHubAdapterState = {
            credential: null,
            repositories: [],
            load: () => Promise.resolve()
        };
        super(new GitHubAdapter(state));
        state.load = () => this.load();
        this.state = state;
        this.githubAdapter = this.adapter as GitHubAdapter;
    }

    getId(): string {
        return 'github';
    }

    getName(): string {
        return 'GitHub';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">code</span>';
    }

    /** No file dialog tab: the launcher opens GitHub fonts, Save As saves them. */
    isVisibleInUI(): boolean {
        return false;
    }

    requiresPermission(): boolean {
        return true;
    }

    supportsUpload(): boolean {
        return false;
    }

    supportsNewFolder(): boolean {
        return false;
    }

    supportsNewFile(): boolean {
        return false;
    }

    /** Git only holds files, so rename and delete wait for a save. */
    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        if (
            action === 'rename' ||
            action === 'delete' ||
            action === 'leave' ||
            action === 'open-in-script-editor'
        ) {
            return false;
        }
        return super.supportsFileContextAction(action, target);
    }

    private find(spec: GitHubRepositorySpec): GitHubRepository | null {
        return (
            this.state.repositories.find((entry) =>
                sameRepository(entry, spec)
            ) ?? null
        );
    }

    /** Take a stored repository; drop what was read from an old branch. */
    private setRepository(repository: GitHubRepository): void {
        const before = this.find(repository);
        if (!before || readBranch(before) !== readBranch(repository)) {
            this.githubAdapter.forget(repository);
        }
        this.state.repositories = before
            ? this.state.repositories.map((entry) =>
                  entry === before ? repository : entry
              )
            : [...this.state.repositories, repository];
    }

    /**
     * Read the login and repositories again. Every window keeps its own copy,
     * and the launcher or another window may have signed in, added a
     * repository or started a change.
     */
    private async refresh(): Promise<void> {
        const [credential, repositories] = await Promise.all([
            loadGitHubCredential(),
            loadGitHubRepositories()
        ]);
        this.state.credential = credential;
        for (const repository of repositories) this.setRepository(repository);
        this.state.repositories = repositories;
    }

    private load(): Promise<void> {
        this.loading ??= this.refresh();
        return this.loading;
    }

    async isReady(): Promise<boolean> {
        await this.load();
        return this.state.credential !== null;
    }

    async onActivate(): Promise<boolean> {
        this.loading = this.refresh();
        await this.loading;
        return this.state.credential !== null;
    }

    /** The repositories Save As can write to, read fresh. */
    async repositoriesForSave(): Promise<GitHubRepository[]> {
        this.loading = this.refresh();
        await this.loading;
        return this.state.credential ? [...this.state.repositories] : [];
    }

    /** Whether a save to GitHub can work now, and why not. */
    async saveAvailability(): Promise<{ available: boolean; note: string }> {
        const repositories = await this.repositoriesForSave();
        if (!this.state.credential) {
            return {
                available: false,
                note: 'Connect GitHub in the launcher first'
            };
        }
        if (!repositories.length) {
            return {
                available: false,
                note: 'Add a repository in the launcher first'
            };
        }
        return {
            available: true,
            note: 'Saves to a branch and opens a pull request'
        };
    }

    /** Folders of a repository, for choosing where Save As writes. */
    async foldersOf(spec: GitHubRepositorySpec): Promise<string[]> {
        return foldersIn(await this.githubAdapter.filePaths(spec));
    }

    /**
     * Publish the save: one commit per repository it wrote to, on that
     * repository's working branch, and the pull request that carries it.
     */
    async afterSave(summary: SaveSummary): Promise<void> {
        const specs = this.githubAdapter.pendingRepositories();
        if (!specs.length) return;
        await this.refresh();
        for (const spec of specs) await this.publish(spec, summary);
    }

    private async publish(
        spec: GitHubRepositorySpec,
        summary: SaveSummary
    ): Promise<void> {
        let repository = this.find(spec);
        if (!repository) {
            throw new Error(
                `${repositoryLabel(spec)} is no longer added to Counterpunch.`
            );
        }
        if (!repository.workingBranch) {
            const branch =
                await this.githubAdapter.createWorkingBranch(repository);
            const claimed = await claimGitHubWorkingBranch(repository, branch);
            if (!claimed?.workingBranch) {
                throw new Error(
                    `${repositoryLabel(spec)} is no longer added to Counterpunch.`
                );
            }
            if (claimed.workingBranch !== branch) {
                console.log(
                    `Another window started ${claimed.workingBranch} first; ${branch} stays unused.`
                );
            }
            repository = claimed;
            this.setRepository(repository);
        }

        const message = commitMessage(summary);
        const result = await this.githubAdapter.commit(repository, message);
        if (!result) return;
        console.log(
            `Committed ${result.commitSha} to ${result.branch} (${result.files} file(s), ${result.deleted} removed)`
        );

        const pullRequest = await this.githubAdapter.ensurePullRequest(
            repository,
            { title: message, body: PULL_REQUEST_BODY }
        );
        if (repository.pullRequest?.number !== pullRequest.number) {
            const stored = await saveGitHubPullRequest(
                repository,
                result.branch,
                { number: pullRequest.number, url: pullRequest.url }
            );
            if (stored) this.setRepository(stored);
        }
        if (pullRequest.created) {
            revealPullRequest(pullRequest, result.branch);
        }
    }
}

/**
 * Show a new pull request. A tab opened after the save's network work may
 * be blocked, so the fallback is a dialog with a link.
 */
function revealPullRequest(
    pullRequest: GitHubPullRequestRef,
    branch: string
): void {
    const tab = window.open(pullRequest.url, '_blank');
    if (tab) {
        try {
            tab.opener = null;
        } catch {
            // The tab is cross-origin; leaving its opener is harmless.
        }
        return;
    }
    const dialog = openDialog({ title: 'Pull request opened' });
    dialog.body.innerHTML = `
        <p>Your edits are on <strong>${escapeHtml(branch)}</strong>, in pull request #${pullRequest.number}. The browser did not open a tab for it.</p>
        <div class="font-window-dialog-actions">
            <button type="button" class="dialog-button" data-close>Close</button>
            <a class="dialog-button dialog-button-primary" style="text-decoration: none" href="${escapeHtml(pullRequest.url)}" target="_blank" rel="noopener noreferrer" data-close>Open pull request</a>
        </div>`;
}
