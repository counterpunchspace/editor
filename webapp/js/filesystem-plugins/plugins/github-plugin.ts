// GitHub: open fonts from a repository and save edits as a pull request.
//
// The user connects one repository with a fine-grained personal access token.
// Reads come from the branch the user is working on; the first save creates a
// working branch from the base branch, commits there, and opens a pull
// request. Every later save commits to the same branch and pull request.

import { Logger } from '../../logger';
import { GitHubClient } from '../../github/github-client';
import {
    clearGitHubSession,
    clearGitHubWorkingState,
    loadGitHubPullRequest,
    loadGitHubSession,
    parseRepositorySpec,
    repositoryLabel,
    saveGitHubPullRequest,
    saveGitHubSession,
    type GitHubPullRequestRef,
    type GitHubSession
} from '../../github/github-session';
import {
    FilesystemPlugin,
    type FileContextAction,
    type FileContextTarget,
    type FilesystemPluginUICallbacks,
    type TitleBarMenuItem
} from '../filesystem-plugin';
import { GitHubAdapter, type GitHubSessionHolder } from './github-adapter';
import {
    bindModalEscape,
    type ModalEscapeBinding
} from '../../ui/modal-escape';

const console = new Logger('GitHubPlugins');

const TOKEN_PAGE_URL = 'https://github.com/settings/personal-access-tokens/new';

export class GitHubPlugin extends FilesystemPlugin {
    private readonly sessionHolder: GitHubSessionHolder;
    private readonly githubAdapter: GitHubAdapter;
    private loading: Promise<GitHubSession | null> | null = null;
    private pullRequest: { number: number; url: string } | null = null;

    constructor() {
        const holder: GitHubSessionHolder = { current: null };
        super(new GitHubAdapter(holder));
        this.sessionHolder = holder;
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

    /** `owner/repo`, or what the tab says before a repository is connected. */
    getRepositoryLabel(): string {
        const session = this.sessionHolder.current;
        return session ? repositoryLabel(session) : 'Connect a repository';
    }

    getDefaultPath(): string {
        const session = this.sessionHolder.current;
        return session ? GitHubAdapter.repoPrefix(session) : '/';
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

    /** The stored folder belongs to the connected repository, if any. */
    isPathInCurrentRoot(path: string): boolean {
        const session = this.sessionHolder.current;
        if (!session) return path === '/';
        return (
            path === '/' || path.startsWith(GitHubAdapter.repoPrefix(session))
        );
    }

    private async session(): Promise<GitHubSession | null> {
        if (this.sessionHolder.current) return this.sessionHolder.current;
        this.loading ??= loadGitHubSession().then((session) => {
            if (session) {
                this.sessionHolder.current = session;
                this.pullRequest = loadGitHubPullRequest();
            }
            return session;
        });
        return this.loading;
    }

    async isReady(): Promise<boolean> {
        return (await this.session()) !== null;
    }

    async onActivate(): Promise<boolean> {
        return (await this.session()) !== null;
    }

    async showSetupUI(): Promise<boolean> {
        const current = await this.session();
        const next = await showGitHubSetupDialog(current, () => this.close());
        if (!next) return false;
        await this.applySession(next);
        return true;
    }

    private async applySession(session: GitHubSession): Promise<void> {
        const previous = this.sessionHolder.current;
        const sameRepository =
            previous?.owner === session.owner &&
            previous.repo === session.repo &&
            previous.branch === session.branch;
        this.sessionHolder.current = session;
        this.loading = Promise.resolve(session);
        if (!sameRepository) {
            this.githubAdapter.applySession();
        }
        if (session.branch === session.baseBranch) {
            clearGitHubWorkingState();
            this.pullRequest = null;
        }
        await saveGitHubSession(session);
        this.pullRequest = loadGitHubPullRequest();
        this.redrawTitleBarButtons();
    }

    async updateUI(uiCallbacks: FilesystemPluginUICallbacks): Promise<void> {
        uiCallbacks.hideUnsupportedBrowserUI();
        if (await this.session()) {
            uiCallbacks.hidePluginMessage();
            return;
        }
        uiCallbacks.showPluginMessage({
            icon: 'code',
            title: 'Connect GitHub',
            message:
                'Open a font from a GitHub repository and save your edits as a pull request.',
            tone: 'info',
            actionLabel: 'Connect GitHub…',
            onAction: () => {
                void this.connectAndReload();
            }
        });
    }

    /** After connecting, list the repository in the open file dialog. */
    async connectAndReload(): Promise<void> {
        const connected = await this.showSetupUI();
        if (!connected) return;
        const session = this.sessionHolder.current;
        if (!session) return;
        const current = window.fileBrowser?.getCurrentPlugin?.() as {
            getId?: () => string;
        } | null;
        if (current?.getId?.() === this.getId()) {
            try {
                await window.navigateToPath(GitHubAdapter.repoPrefix(session));
                window.hidePluginMessage?.();
            } catch (error: unknown) {
                console.error(
                    'Could not list the repository in the file dialog:',
                    error
                );
            }
        }
    }

    getTitleBarMenuItems(): TitleBarMenuItem[] {
        const session = this.sessionHolder.current;
        const items: TitleBarMenuItem[] = [
            {
                label: session
                    ? `Repository: ${repositoryLabel(session)}`
                    : 'Connect a repository…',
                icon: 'code',
                action: () => this.connectAndReload()
            }
        ];
        if (!session) return items;

        if (session.branch !== session.baseBranch) {
            items.push({
                label: `Working branch: ${session.branch}`,
                icon: 'fork_right',
                action: async () => this.openPullRequestOrExplain()
            });
            items.push({
                label: 'Start a new change',
                icon: 'restart_alt',
                action: () => this.startNewChange()
            });
        }
        return items;
    }

    private openPullRequestOrExplain(): void {
        if (this.pullRequest) {
            window.open(this.pullRequest.url, '_blank', 'noopener,noreferrer');
            return;
        }
        const session = this.sessionHolder.current;
        if (!session) return;
        const url = `https://github.com/${session.owner}/${session.repo}/pulls`;
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    /**
     * Show a new pull request. A tab opened after the save's network work may
     * be blocked, so the fallback is a dialog with a link.
     */
    private revealPullRequest(pullRequest: GitHubPullRequestRef): void {
        const tab = window.open(pullRequest.url, '_blank');
        if (tab) {
            try {
                tab.opener = null;
            } catch {
                // The tab is cross-origin; leaving its opener is harmless.
            }
            return;
        }
        showPullRequestDialog(pullRequest, this.pullRequestBranch());
    }

    private pullRequestBranch(): string {
        return this.sessionHolder.current?.branch ?? '';
    }

    /** Forget the working branch; the next save starts a new pull request. */
    private async startNewChange(): Promise<void> {
        const session = this.sessionHolder.current;
        if (!session) return;
        if (window.fontManager?.currentFont?.hasUnsavedChanges) {
            window.alert(
                'Save your changes before you start a new change. The next save updates the pull request you have open.'
            );
            return;
        }
        const next: GitHubSession = {
            ...session,
            branch: session.baseBranch
        };
        clearGitHubWorkingState();
        await this.applySession(next);
        window.location.reload();
    }

    canClose(): boolean {
        return true;
    }

    /** Disconnect: forget the token and the repository. */
    async close(): Promise<void> {
        await clearGitHubSession();
        this.sessionHolder.current = null;
        this.loading = Promise.resolve(null);
        this.pullRequest = null;
        this.githubAdapter.applySession();
        this.redrawTitleBarButtons();
    }

    /**
     * Publish the save: one commit on the working branch, and the pull
     * request that carries it.
     */
    async afterSave(): Promise<void> {
        if (!this.githubAdapter.hasPendingChanges()) return;
        let session = this.sessionHolder.current;
        if (!session) return;

        if (session.branch === session.baseBranch) {
            const branch = await this.githubAdapter.createWorkingBranch();
            session = { ...session, branch };
            this.sessionHolder.current = session;
            await saveGitHubSession(session);
        }

        const font = window.fontManager?.currentFont;
        const fontName = font?.name || 'font';
        const fontPath = font?.path || '';
        const result = await this.githubAdapter.commit(
            `Update ${fontName} from Counterpunch`
        );
        if (!result) return;
        console.log(
            `Committed ${result.commitSha} to ${result.branch} (${result.files} file(s), ${result.deleted} removed)`
        );
        try {
            const pullRequest = await this.githubAdapter.ensurePullRequest({
                title: `Counterpunch edits: ${fontName}`,
                body: [
                    'This pull request was opened from Counterpunch.',
                    '',
                    `- Font: \`${fontPath}\``,
                    `- Files changed: ${result.files}`,
                    `- Files removed: ${result.deleted}`,
                    '',
                    'Review the change, then merge it.'
                ].join('\n')
            });
            this.pullRequest = {
                number: pullRequest.number,
                url: pullRequest.url
            };
            saveGitHubPullRequest(this.pullRequest);
            if (pullRequest.created) this.revealPullRequest(this.pullRequest);
        } finally {
            this.redrawTitleBarButtons();
        }
    }
}

// --- Pull request dialog ----------------------------------------------------

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Fallback when the browser refuses a new tab for a pull request the save
 * just opened: show where the work is, with a link that always works.
 */
function showPullRequestDialog(
    pullRequest: GitHubPullRequestRef,
    branch: string
): void {
    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '12000';
    overlay.innerHTML = `
        <div class="info-popup confirm-dialog github-setup-dialog">
            <div class="info-popup-header">
                <h3>Pull request opened</h3>
                <button type="button" class="info-popup-close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content">
                <p>Your edits are on <strong>${escapeHtml(branch)}</strong>, in pull request #${pullRequest.number}. The browser did not open a tab for it.</p>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button" data-close>Close</button>
                    <a class="dialog-button dialog-button-primary" style="text-decoration: none" href="${escapeHtml(pullRequest.url)}" target="_blank" rel="noopener noreferrer">Open pull request</a>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    let escapeBinding: ModalEscapeBinding | null = null;
    const close = () => {
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
    };
    escapeBinding = bindModalEscape(close, {
        isOpen: () => overlay.isConnected
    });
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });
    overlay.querySelector('[data-close]')?.addEventListener('click', close);
    overlay
        .querySelector('.info-popup-close')
        ?.addEventListener('click', close);
}

// --- Setup dialog -----------------------------------------------------------

/**
 * Ask for the repository, the base branch and the token. Resolves with the
 * new session, or null when the user cancels. A token is only kept once
 * GitHub accepts it.
 */
export function showGitHubSetupDialog(
    current: GitHubSession | null,
    onDisconnect: () => Promise<void>
): Promise<GitHubSession | null> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.style.display = 'flex';
        // Above Open/Save (`.file-dialog-overlay` is 11000): the file dialog
        // is where an unconnected user is asked to connect.
        overlay.style.zIndex = '12000';
        overlay.innerHTML = `
            <div class="info-popup confirm-dialog github-setup-dialog">
                <div class="info-popup-header">
                    <h3>Connect GitHub</h3>
                    <button type="button" class="info-popup-close" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content">
                    <p>Counterpunch reads fonts from a repository and saves your edits to a new branch. Each save updates the same pull request.</p>
                    <label class="github-setup-field">Repository
                        <input class="dialog-input" data-field="repository" type="text"
                            placeholder="owner/repository" autocomplete="off">
                    </label>
                    <label class="github-setup-field">Base branch
                        <input class="dialog-input" data-field="branch" type="text"
                            placeholder="main" autocomplete="off">
                    </label>
                    <label class="github-setup-field">Access token
                        <input class="dialog-input" data-field="token" type="password"
                            autocomplete="off" spellcheck="false">
                    </label>
                    <p class="github-setup-hint">Make a fine-grained token for this repository with <strong>Contents</strong> and <strong>Pull requests</strong> set to <em>Read and write</em>. It stays in this browser.
                        <a href="${TOKEN_PAGE_URL}" target="_blank" rel="noopener noreferrer">Create a token</a></p>
                    <p class="github-setup-error" data-error hidden></p>
                    <div class="confirm-dialog-actions">
                        ${current ? '<button type="button" class="dialog-button dialog-button-danger" data-action="disconnect">Disconnect</button>' : ''}
                        <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                        <button type="button" class="dialog-button dialog-button-primary" data-action="connect">Connect</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let escapeBinding: ModalEscapeBinding | null = null;
        const field = (name: string) =>
            overlay.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
        // Fill the fields from the session in JavaScript: the token never
        // becomes part of an HTML string.
        const repositoryField = field('repository');
        const branchField = field('branch');
        const tokenField = field('token');
        if (repositoryField && current) {
            repositoryField.value = repositoryLabel(current);
        }
        if (branchField && current) {
            branchField.value = current.baseBranch;
        }
        if (tokenField && current) {
            tokenField.value = current.token;
        }
        const errorLine = overlay.querySelector<HTMLElement>('[data-error]');
        const connectButton = overlay.querySelector<HTMLButtonElement>(
            '[data-action="connect"]'
        );

        function finish(session: GitHubSession | null) {
            escapeBinding?.release();
            escapeBinding = null;
            overlay.remove();
            resolve(session);
        }

        function showError(message: string) {
            if (!errorLine) return;
            errorLine.textContent = message;
            errorLine.hidden = false;
        }

        escapeBinding = bindModalEscape(() => finish(null), {
            isOpen: () => overlay.isConnected
        });

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) finish(null);
        });
        overlay
            .querySelector('[data-action="cancel"]')
            ?.addEventListener('click', () => finish(null));
        overlay
            .querySelector('[data-action="disconnect"]')
            ?.addEventListener('click', () => {
                void onDisconnect().finally(() => finish(null));
            });

        connectButton?.addEventListener('click', async () => {
            const repositoryText = field('repository')?.value ?? '';
            const token = (field('token')?.value ?? '').trim();
            const branchText = (field('branch')?.value ?? '').trim();
            const spec = parseRepositorySpec(repositoryText);
            if (!spec) {
                showError('Enter the repository as owner/name.');
                return;
            }
            if (!token) {
                showError('Paste an access token for this repository.');
                return;
            }
            connectButton.disabled = true;
            connectButton.textContent = 'Connecting…';
            if (errorLine) errorLine.hidden = true;
            try {
                const client = new GitHubClient({ token, ...spec });
                const repository = await client.getRepository();
                const baseBranch = branchText || repository.defaultBranch;
                if (!(await client.branchExists(baseBranch))) {
                    throw new Error(
                        `${repository.fullName} has no branch ${baseBranch}.`
                    );
                }
                const keepWorkingBranch =
                    current &&
                    current.owner.toLowerCase() === spec.owner.toLowerCase() &&
                    current.repo.toLowerCase() === spec.repo.toLowerCase() &&
                    current.branch !== current.baseBranch;
                finish({
                    token,
                    owner: spec.owner,
                    repo: spec.repo,
                    branch: keepWorkingBranch ? current.branch : baseBranch,
                    baseBranch
                });
            } catch (error: unknown) {
                showError(
                    error instanceof Error
                        ? error.message
                        : 'Could not connect to GitHub.'
                );
                connectButton.disabled = false;
                connectButton.textContent = 'Connect';
            }
        });

        field('repository')?.focus();
    });
}
