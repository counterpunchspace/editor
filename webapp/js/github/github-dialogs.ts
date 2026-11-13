// Signing in to GitHub, adding repositories and picking their fonts. The
// launcher shows these; the editor's GitHub plugin only reads, writes and
// publishes saves.

import { GitHubClient, type GitHubWritableRepository } from './github-client';
import { resolveWebsiteURL } from '../website-url';
import { fontSourcesIn, gitHubFontKey } from './github-fonts';
import {
    addGitHubRepository,
    endGitHubChange,
    parseRepositorySpec,
    readBranch,
    removeGitHubRepository,
    repositoryLabel,
    sameRepository,
    writeAccessRefusal,
    type GitHubCredential,
    type GitHubRepository,
    type GitHubRepositorySpec
} from './github-session';
import {
    escapeHtml,
    icon,
    openDialog,
    reportError,
    type FontWindowDialog
} from '../font-windows/dialogs';
import { FONT_FORMATS, fontFormatKind } from '../font-windows/font-formats';
import type { OpenableFont } from '../font-windows/open-documents';

const TOKEN_PAGE_URL = 'https://github.com/settings/personal-access-tokens/new';

/** The last search in the repository picker, offered again next time. */
const REPOSITORY_SEARCH_KEY = 'githubRepositorySearch';

function readRepositorySearch(): string {
    try {
        return localStorage.getItem(REPOSITORY_SEARCH_KEY) ?? '';
    } catch {
        return '';
    }
}

function writeRepositorySearch(query: string): void {
    try {
        if (query) localStorage.setItem(REPOSITORY_SEARCH_KEY, query);
        else localStorage.removeItem(REPOSITORY_SEARCH_KEY);
    } catch {
        // Storage may be unavailable; the search just isn't remembered.
    }
}

/** Every file path in the repository, on its read branch. */
export async function listRepositoryFiles(
    credential: GitHubCredential,
    repository: GitHubRepository
): Promise<string[]> {
    const tree = await new GitHubClient({
        token: credential.token,
        owner: repository.owner,
        repo: repository.repo
    }).getTree(readBranch(repository));
    if (tree.truncated) {
        throw new Error(
            `${repositoryLabel(repository)} has too many files for Counterpunch to list.`
        );
    }
    return tree.entries
        .filter((entry) => entry.type === 'blob')
        .map((entry) => entry.path);
}

/**
 * Run `submit` from the dialog's primary button. While it runs the button
 * shows `busyLabel`; an error is shown in the dialog.
 */
function bindSubmit(
    dialog: FontWindowDialog,
    busyLabel: string,
    submit: () => Promise<void>,
    /** Where Enter submits; the whole dialog unless it has other fields. */
    enterScope: HTMLElement = dialog.body
): void {
    const button =
        dialog.body.querySelector<HTMLButtonElement>('[data-submit]');
    const errorLine = dialog.body.querySelector<HTMLElement>('[data-error]');
    if (!button) return;
    const idleLabel = button.textContent ?? '';
    const run = async () => {
        button.disabled = true;
        button.textContent = busyLabel;
        if (errorLine) errorLine.hidden = true;
        try {
            await submit();
        } catch (error: unknown) {
            if (errorLine) {
                errorLine.textContent =
                    error instanceof Error
                        ? error.message
                        : 'Could not reach GitHub.';
                errorLine.hidden = false;
            }
            button.disabled = false;
            button.textContent = idleLabel;
        }
    };
    button.addEventListener('click', () => void run());
    enterScope.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !button.disabled) void run();
    });
}

/**
 * Sign in through GitHub in a popup. The popup ends on github-login.html on
 * this origin, which stores the login and announces it (onGitHubSignIn).
 */
export function startGitHubSignIn(): void {
    const url = new URL('/api/github/oauth/start', resolveWebsiteURL());
    url.searchParams.set('editor', location.origin);
    window.open(
        url.toString(),
        'counterpunch-github-sign-in',
        'popup,width=560,height=720'
    );
}

/**
 * Sign in with a pasted access token instead, for a site without the
 * GitHub sign-in or an organisation that blocks it. Resolves with the
 * credential, or null when the user cancels.
 */
export function showGitHubTokenSignIn(): Promise<GitHubCredential | null> {
    return new Promise((resolve) => {
        let result: GitHubCredential | null = null;
        const dialog = openDialog({
            title: 'Use an access token',
            className: 'github-setup-dialog',
            onClose: () => resolve(result)
        });
        dialog.body.innerHTML = `
            <div class="font-window-fields">
                <label>Access token<span class="font-window-control">${icon('key')}<input type="password" data-token autocomplete="off" spellcheck="false"></span></label>
            </div>
            <p class="github-setup-hint">Make a fine-grained token for the repositories you want to edit, with <strong>Contents</strong> and <strong>Pull requests</strong> set to <em>Read and write</em>. One token works for one owner’s repositories. It is stored in this browser, and anyone who can use this browser profile can use it. <a href="${TOKEN_PAGE_URL}" target="_blank" rel="noopener noreferrer">Create a token</a></p>
            <p class="github-setup-error" data-error hidden></p>
            <div class="font-window-dialog-actions">
                <button type="button" class="dialog-button" data-close>Cancel</button>
                <button type="button" class="dialog-button dialog-button-primary" data-submit>Connect</button>
            </div>`;
        const tokenField =
            dialog.body.querySelector<HTMLInputElement>('[data-token]');
        bindSubmit(dialog, 'Connecting…', async () => {
            const token = (tokenField?.value ?? '').trim();
            if (!token) throw new Error('Paste an access token.');
            // The account needs no repository, so the client names none.
            const account = await new GitHubClient({
                token,
                owner: '',
                repo: ''
            }).getAccount();
            result = { token, ...account };
            dialog.close();
        });
        tokenField?.focus();
    });
}

/**
 * The signed-in GitHub account. Resolves true when the user signs out.
 */
export function showGitHubAccount(
    credential: GitHubCredential
): Promise<boolean> {
    return new Promise((resolve) => {
        let signOut = false;
        const dialog = openDialog({
            title: 'GitHub',
            className: 'github-setup-dialog',
            onClose: () => resolve(signOut)
        });
        dialog.body.innerHTML = `
            <p class="github-account">${githubAvatarHtml(credential, 'github-account-avatar')}<span>Signed in as <strong>${escapeHtml(credential.login)}</strong>.</span></p>
            <p>After signing out, fonts from GitHub can’t be saved until someone signs in again; unsaved edits stay in their windows. The repository list of ${escapeHtml(credential.login)} is kept in this browser and comes back when ${escapeHtml(credential.login)} signs in again. Another account gets its own list.</p>
            <p class="github-setup-hint">Signing out removes the sign-in from this browser only. To withdraw Counterpunch’s access to your GitHub account completely, revoke it on <a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">GitHub’s Applications page</a>.</p>
            <div class="font-window-dialog-actions">
                <button type="button" class="dialog-button dialog-button-danger" data-sign-out>Sign out</button>
                <button type="button" class="dialog-button dialog-button-primary" data-close>Done</button>
            </div>`;
        dialog.body
            .querySelector('[data-sign-out]')
            ?.addEventListener('click', () => {
                signOut = true;
                dialog.close();
            });
    });
}

/**
 * The account's picture, loaded without credentials: the launcher is
 * cross-origin isolated, and GitHub serves avatars with CORS.
 */
export function githubAvatarHtml(
    credential: GitHubCredential,
    className: string
): string {
    if (!credential.avatarUrl) return icon('account_circle');
    const url = new URL(credential.avatarUrl);
    url.searchParams.set('s', '64');
    return `<img class="${className}" src="${escapeHtml(url.toString())}" alt="" crossorigin="anonymous" referrerpolicy="no-referrer">`;
}

/**
 * Pick a repository the account can write to, from GitHub's list, and add
 * it. A repository not listed can be typed. Resolves with the added
 * repository, or null when the user cancels.
 */
export function showAddGitHubRepository(
    credential: GitHubCredential,
    alreadyAdded: GitHubRepositorySpec[]
): Promise<GitHubRepository | null> {
    return new Promise((resolve) => {
        let added: GitHubRepository | null = null;
        const dialog = openDialog({
            title: 'Add a repository',
            className: 'font-window-folder-fonts github-picker-dialog',
            onClose: () => resolve(added)
        });
        dialog.body.innerHTML = `
            <p>Repositories ${escapeHtml(credential.login)} can write to. Saves go to a new branch and a pull request into the base branch.</p>
            <div class="font-window-fields">
                <label>Search<span class="font-window-control">${icon('search')}<input type="search" data-search placeholder="Filter by name" autocomplete="off" spellcheck="false"></span></label>
            </div>
            <div class="font-window-list" data-list><div class="launcher-empty">Loading your repositories…</div></div>
            <details class="github-picker-more">
                <summary>Not listed, or another base branch</summary>
                <div class="font-window-fields">
                    <label>Repository<span class="font-window-control">${icon('code')}<input type="text" data-repository placeholder="owner/repository" autocomplete="off" spellcheck="false"></span></label>
                    <label>Base branch<span class="font-window-control">${icon('fork_right')}<input type="text" data-branch placeholder="The repository’s default branch" autocomplete="off" spellcheck="false"></span></label>
                </div>
                <p class="github-setup-hint">An organisation that limits apps hides its repositories until an owner approves Counterpunch. You can ask for that on <a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">GitHub’s Applications page</a>.</p>
                <button type="button" class="dialog-button" data-submit>Add this repository</button>
            </details>
            <p class="github-setup-error" data-error hidden></p>
            <div class="font-window-dialog-actions">
                <button type="button" class="dialog-button" data-close>Cancel</button>
            </div>`;
        const field = (name: string) =>
            dialog.body.querySelector<HTMLInputElement>(`[data-${name}]`);
        const list = dialog.body.querySelector('[data-list]') as HTMLElement;
        const errorLine = dialog.body.querySelector(
            '[data-error]'
        ) as HTMLElement;
        let repositories: GitHubWritableRepository[] = [];

        /** Check the repository and base branch with GitHub, then store it. */
        const add = async (spec: GitHubRepositorySpec) => {
            const client = new GitHubClient({
                token: credential.token,
                ...spec
            });
            const repository = await client.getRepository();
            if (!repository.canPush) {
                throw new Error(writeAccessRefusal(credential.login, spec));
            }
            const baseBranch =
                (field('branch')?.value ?? '').trim() ||
                repository.defaultBranch;
            if (!(await client.branchExists(baseBranch))) {
                throw new Error(
                    `${repository.fullName} has no branch ${baseBranch}.`
                );
            }
            // GitHub’s spelling of the names, so paths match the repository.
            added = await addGitHubRepository(
                credential.login,
                parseRepositorySpec(repository.fullName) ?? spec,
                baseBranch
            );
            dialog.close();
        };

        const render = () => {
            const query = (field('search')?.value ?? '').trim().toLowerCase();
            const shown = repositories.filter((repository) =>
                repositoryLabel(repository).toLowerCase().includes(query)
            );
            list.innerHTML = shown.length
                ? ''
                : `<div class="launcher-empty">${repositories.length ? 'No repository matches.' : `${escapeHtml(credential.login)} can’t write to any repository yet.`}</div>`;
            for (const repository of shown) {
                const isAdded = alreadyAdded.some((spec) =>
                    sameRepository(spec, repository)
                );
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'font-window-list-row';
                row.disabled = isAdded;
                row.innerHTML = `${icon(repository.private ? 'lock' : 'code')}<span class="name">${escapeHtml(repositoryLabel(repository))}${repository.description ? `<small>${escapeHtml(repository.description)}</small>` : ''}</span><span class="meta">${isAdded ? 'Added' : escapeHtml(repository.defaultBranch)}</span>`;
                row.addEventListener('click', () => {
                    errorLine.hidden = true;
                    row.disabled = true;
                    void add(repository).catch((error: unknown) => {
                        row.disabled = false;
                        errorLine.textContent =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        errorLine.hidden = false;
                    });
                });
                list.append(row);
            }
        };

        const search = field('search');
        if (search) search.value = readRepositorySearch();
        search?.addEventListener('input', () => {
            writeRepositorySearch(search.value.trim());
            render();
        });
        bindSubmit(
            dialog,
            'Checking…',
            async () => {
                const spec = parseRepositorySpec(
                    field('repository')?.value ?? ''
                );
                if (!spec) {
                    throw new Error('Enter the repository as owner/name.');
                }
                await add(spec);
            },
            dialog.body.querySelector('.github-picker-more') as HTMLElement
        );
        void new GitHubClient({ token: credential.token, owner: '', repo: '' })
            .listWritableRepositories()
            .then((found) => {
                repositories = found;
                render();
            })
            .catch((error: unknown) => {
                list.innerHTML = `<div class="launcher-empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
            });
        search?.focus();
        search?.select();
    });
}

export type GitHubRepositoriesOptions = {
    credential: GitHubCredential;
    repositories: GitHubRepository[];
    openFont: (font: OpenableFont) => void;
    /** Whether a window has a font from the repository open. */
    hasOpenFont: (spec: GitHubRepositorySpec) => boolean;
    /** Called after a repository was added, removed or changed. */
    onChange: () => void;
};

/**
 * The added repositories with their fonts, to open one, and their open
 * changes, to look at the pull request or start a new change.
 */
export function showGitHubRepositories(
    options: GitHubRepositoriesOptions
): void {
    let repositories = [...options.repositories];
    const dialog = openDialog({
        title: 'Open from GitHub',
        className: 'font-window-folder-fonts github-repositories-dialog'
    });

    /** Put `next` in place of `spec` (or add it), or remove it when null. */
    const replace = (
        spec: GitHubRepositorySpec,
        next: GitHubRepository | null
    ) => {
        const index = repositories.findIndex((entry) =>
            sameRepository(entry, spec)
        );
        if (index === -1) {
            if (next) repositories.push(next);
        } else if (next) {
            repositories[index] = next;
        } else {
            repositories.splice(index, 1);
        }
        options.onChange();
        render();
    };

    const repositoryHtml = (repository: GitHubRepository, index: number) => {
        const change = repository.workingBranch
            ? `<span class="meta">Saves go to ${escapeHtml(repository.workingBranch)}${
                  repository.pullRequest
                      ? `, <a href="${escapeHtml(repository.pullRequest.url)}" target="_blank" rel="noopener noreferrer">pull request #${repository.pullRequest.number}</a>`
                      : ''
              }</span>
              <button type="button" class="launcher-link" data-new-change="${index}">Start a new change</button>`
            : `<span class="meta">Reads ${escapeHtml(repository.baseBranch)}</span>`;
        return `
            <div class="github-repository" data-repository="${index}">
                <div class="github-repository-head">
                    ${icon('code')}<b>${escapeHtml(repositoryLabel(repository))}</b>
                    ${change}
                    <button type="button" class="launcher-link" data-remove="${index}">Remove</button>
                </div>
                <div class="font-window-list" data-fonts="${index}"><div class="launcher-empty">Loading fonts…</div></div>
            </div>`;
    };

    const loadFonts = async (repository: GitHubRepository, index: number) => {
        const list = dialog.body.querySelector<HTMLElement>(
            `[data-fonts="${index}"]`
        );
        if (!list) return;
        try {
            const fonts = fontSourcesIn(
                await listRepositoryFiles(options.credential, repository)
            );
            list.innerHTML = fonts.length
                ? ''
                : '<div class="launcher-empty">No font sources in this repository.</div>';
            for (const font of fonts) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'font-window-list-row';
                row.innerHTML = `${icon(fontFormatKind(font.format) === 'package' ? 'deployed_code' : 'description')}<span class="name">${escapeHtml(font.path)}</span><span class="meta">${escapeHtml(FONT_FORMATS[font.format].ext)}</span>`;
                row.addEventListener('click', () => {
                    dialog.close();
                    options.openFont({
                        key: gitHubFontKey(repository, font.path),
                        name: font.path.split('/').pop() ?? font.path,
                        format: font.format
                    });
                });
                list.append(row);
            }
        } catch (error: unknown) {
            list.innerHTML = `<div class="launcher-empty">${escapeHtml(
                error instanceof Error ? error.message : String(error)
            )}</div>`;
        }
    };

    function render(): void {
        dialog.body.innerHTML = `
            ${
                repositories.length
                    ? repositories.map(repositoryHtml).join('')
                    : '<p>No repositories yet. Add one to open its fonts.</p>'
            }
            <div class="font-window-dialog-actions">
                <button type="button" class="dialog-button" data-add>Add repository…</button>
                <button type="button" class="dialog-button" data-close>Close</button>
            </div>`;
        repositories.forEach((repository, index) => {
            void loadFonts(repository, index);
        });
    }

    dialog.body.addEventListener('click', async (event) => {
        const target = event.target as HTMLElement;
        const indexOf = (attribute: string) => {
            const value = target
                .closest(`[${attribute}]`)
                ?.getAttribute(attribute);
            return value === undefined || value === null ? null : Number(value);
        };
        try {
            if (target.closest('[data-add]')) {
                const added = await showAddGitHubRepository(
                    options.credential,
                    repositories
                );
                if (added) replace(added, added);
                return;
            }
            const removeIndex = indexOf('data-remove');
            if (removeIndex !== null) {
                const repository = repositories[removeIndex];
                await removeGitHubRepository(
                    options.credential.login,
                    repository
                );
                replace(repository, null);
                return;
            }
            const changeIndex = indexOf('data-new-change');
            if (changeIndex !== null) {
                const repository = repositories[changeIndex];
                if (options.hasOpenFont(repository)) {
                    throw new Error(
                        `Close the fonts from ${repositoryLabel(repository)} first. They show the change you are closing.`
                    );
                }
                replace(
                    repository,
                    await endGitHubChange(options.credential.login, repository)
                );
            }
        } catch (error: unknown) {
            reportError(error);
        }
    });

    render();
}
