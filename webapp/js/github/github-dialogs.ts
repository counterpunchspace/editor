// Signing in to GitHub, adding repositories and picking their fonts. The
// launcher shows these; the editor's GitHub plugin only reads, writes and
// publishes saves.

import { GitHubClient } from './github-client';
import { fontSourcesIn, gitHubFontKey } from './github-fonts';
import {
    addGitHubRepository,
    endGitHubChange,
    parseRepositorySpec,
    readBranch,
    removeGitHubRepository,
    repositoryLabel,
    sameRepository,
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
    submit: () => Promise<void>
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
    dialog.body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !button.disabled) void run();
    });
}

/**
 * Ask for a token and check it with GitHub. Resolves with the credential,
 * 'signed-out', or null when the user cancels.
 */
export function showGitHubSignIn(
    current: GitHubCredential | null
): Promise<GitHubCredential | 'signed-out' | null> {
    return new Promise((resolve) => {
        let result: GitHubCredential | 'signed-out' | null = null;
        const dialog = openDialog({
            title: 'Connect GitHub',
            className: 'github-setup-dialog',
            onClose: () => resolve(result)
        });
        dialog.body.innerHTML = `
            <p>${
                current
                    ? `Signed in as <strong>${escapeHtml(current.login)}</strong>. Paste a new token to change it.`
                    : 'Counterpunch opens fonts from your repositories and saves your edits as pull requests.'
            }</p>
            <div class="font-window-fields">
                <label>Access token<span class="font-window-control">${icon('key')}<input type="password" data-token autocomplete="off" spellcheck="false"></span></label>
            </div>
            <p class="github-setup-hint">Make a fine-grained token for the repositories you want to edit, with <strong>Contents</strong> and <strong>Pull requests</strong> set to <em>Read and write</em>. One token works for one owner’s repositories. It is stored in this browser, and anyone who can use this browser profile can use it. <a href="${TOKEN_PAGE_URL}" target="_blank" rel="noopener noreferrer">Create a token</a></p>
            <p class="github-setup-error" data-error hidden></p>
            <div class="font-window-dialog-actions">
                ${current ? '<button type="button" class="dialog-button dialog-button-danger" data-sign-out>Sign out</button>' : ''}
                <button type="button" class="dialog-button" data-close>Cancel</button>
                <button type="button" class="dialog-button dialog-button-primary" data-submit>Connect</button>
            </div>`;
        const tokenField =
            dialog.body.querySelector<HTMLInputElement>('[data-token]');
        dialog.body
            .querySelector('[data-sign-out]')
            ?.addEventListener('click', () => {
                result = 'signed-out';
                dialog.close();
            });
        bindSubmit(dialog, 'Connecting…', async () => {
            const token = (tokenField?.value ?? '').trim();
            if (!token) throw new Error('Paste an access token.');
            // The account needs no repository, so the client names none.
            const login = await new GitHubClient({
                token,
                owner: '',
                repo: ''
            }).getLogin();
            result = { token, login };
            dialog.close();
        });
        tokenField?.focus();
    });
}

/**
 * Ask for a repository and its base branch, check both with GitHub and add
 * the repository. Resolves with it, or null when the user cancels.
 */
export function showAddGitHubRepository(
    credential: GitHubCredential
): Promise<GitHubRepository | null> {
    return new Promise((resolve) => {
        let added: GitHubRepository | null = null;
        const dialog = openDialog({
            title: 'Add a repository',
            className: 'github-setup-dialog',
            onClose: () => resolve(added)
        });
        dialog.body.innerHTML = `
            <p>Its fonts show in the launcher. Saves go to a new branch and a pull request into the base branch.</p>
            <div class="font-window-fields">
                <label>Repository<span class="font-window-control">${icon('code')}<input type="text" data-repository placeholder="owner/repository" autocomplete="off" spellcheck="false"></span></label>
                <label>Base branch<span class="font-window-control">${icon('fork_right')}<input type="text" data-branch placeholder="The repository’s default branch" autocomplete="off" spellcheck="false"></span></label>
            </div>
            <p class="github-setup-error" data-error hidden></p>
            <div class="font-window-dialog-actions">
                <button type="button" class="dialog-button" data-close>Cancel</button>
                <button type="button" class="dialog-button dialog-button-primary" data-submit>Add</button>
            </div>`;
        const field = (name: string) =>
            dialog.body.querySelector<HTMLInputElement>(`[data-${name}]`);
        bindSubmit(dialog, 'Checking…', async () => {
            const spec = parseRepositorySpec(field('repository')?.value ?? '');
            if (!spec) throw new Error('Enter the repository as owner/name.');
            const client = new GitHubClient({
                token: credential.token,
                ...spec
            });
            const repository = await client.getRepository();
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
                parseRepositorySpec(repository.fullName) ?? spec,
                baseBranch
            );
            dialog.close();
        });
        field('repository')?.focus();
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
                const added = await showAddGitHubRepository(options.credential);
                if (added) replace(added, added);
                return;
            }
            const removeIndex = indexOf('data-remove');
            if (removeIndex !== null) {
                const repository = repositories[removeIndex];
                await removeGitHubRepository(repository);
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
                replace(repository, await endGitHubChange(repository));
            }
        } catch (error: unknown) {
            reportError(error);
        }
    });

    render();
}
