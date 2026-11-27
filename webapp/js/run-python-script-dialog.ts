/**
 * Run Python Script dialog — browse and run scripts from the Settings Folder.
 */

import { Logger } from './logger';
import {
    parsePythonScriptHeader,
    type PythonScriptHeader
} from './python-script-header';
import { settingsFolder, SETTINGS_FOLDER_PATHS } from './settings-folder';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('RunPythonScriptDialog');

const SELECTED_SCRIPT_STORAGE_KEY = 'runPythonScriptSelectedPath';
const LAST_RUN_STORAGE_KEY = 'runPythonScriptLastRun';

const SCRIPTS_ROOT = SETTINGS_FOLDER_PATHS.scripts;
const ALL_SCRIPTS_FOLDER = '';

type RunnableScript = {
    path: string;
    relativePath: string;
    folderPath: string;
    title: string;
    description: string;
    keywords: string[];
    content: string;
};

type LastRunInfo = {
    path: string;
    title: string;
};

let scripts: RunnableScript[] = [];
let selectedPath: string | null = null;
let activeKeyword: string | null = null;
let activeFolder: string = ALL_SCRIPTS_FOLDER;
let searchTerm = '';
let isOpen = false;
let isRunning = false;

let modal: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let folderSelect: HTMLSelectElement | null = null;
let keywordChips: HTMLElement | null = null;
let scriptList: HTMLElement | null = null;
let runButton: HTMLButtonElement | null = null;
let emptyNotice: HTMLElement | null = null;
let escapeBinding: ModalEscapeBinding | null = null;

function relativeToScriptsRoot(path: string): string {
    if (path === SCRIPTS_ROOT) {
        return '';
    }
    if (path.startsWith(`${SCRIPTS_ROOT}/`)) {
        return path.slice(SCRIPTS_ROOT.length + 1);
    }
    return path.replace(/^\//, '');
}

function parentFolderPath(path: string): string {
    const index = path.lastIndexOf('/');
    if (index <= 0) {
        return SCRIPTS_ROOT;
    }
    return path.slice(0, index);
}

function isUnderFolder(scriptPath: string, folderPath: string): boolean {
    if (!folderPath || folderPath === ALL_SCRIPTS_FOLDER) {
        return scriptPath.startsWith(`${SCRIPTS_ROOT}/`);
    }
    return scriptPath === folderPath || scriptPath.startsWith(`${folderPath}/`);
}

function displayTitle(script: RunnableScript): string {
    return script.title || script.relativePath || script.path;
}

function loadLastSelectedPath(): string | null {
    return localStorage.getItem(SELECTED_SCRIPT_STORAGE_KEY);
}

function saveLastSelectedPath(path: string | null): void {
    if (!path) {
        localStorage.removeItem(SELECTED_SCRIPT_STORAGE_KEY);
        return;
    }
    localStorage.setItem(SELECTED_SCRIPT_STORAGE_KEY, path);
}

function loadLastRun(): LastRunInfo | null {
    try {
        const raw = localStorage.getItem(LAST_RUN_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<LastRunInfo>;
        if (
            typeof parsed.path === 'string' &&
            typeof parsed.title === 'string' &&
            parsed.path &&
            parsed.title
        ) {
            return { path: parsed.path, title: parsed.title };
        }
    } catch (error) {
        console.warn('Failed to parse last-run script info:', error);
    }
    return null;
}

function saveLastRun(info: LastRunInfo): void {
    localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(info));
}

export function getLastRunPythonScript(): LastRunInfo | null {
    return loadLastRun();
}

function decodeFileContent(data: string | Uint8Array): string {
    if (typeof data === 'string') {
        return data;
    }
    return new TextDecoder().decode(data);
}

function buildScriptFromFile(path: string, content: string): RunnableScript {
    const header: PythonScriptHeader = parsePythonScriptHeader(content);
    const relativePath = relativeToScriptsRoot(path);
    return {
        path,
        relativePath,
        folderPath: parentFolderPath(path),
        title: header.title || relativePath.replace(/\.py$/i, '') || path,
        description: header.description,
        keywords: header.keywords,
        content
    };
}

async function loadScriptsFromSettingsFolder(): Promise<RunnableScript[]> {
    await settingsFolder.initialize();
    if (!settingsFolder.hasFolder()) {
        return [];
    }

    const adapter = settingsFolder.getAdapter();
    if ((await adapter.checkPermission()) !== 'granted') {
        return [];
    }
    if (!(await adapter.fileExists(SCRIPTS_ROOT))) {
        return [];
    }

    const files = await adapter.listFilesRecursive(SCRIPTS_ROOT, 20);
    const pythonFiles = files
        .filter(
            (file) => !file.is_dir && file.path.toLowerCase().endsWith('.py')
        )
        .sort((a, b) => a.path.localeCompare(b.path));

    const loaded: RunnableScript[] = [];
    for (const file of pythonFiles) {
        try {
            const data = await adapter.readFile(file.path);
            loaded.push(
                buildScriptFromFile(file.path, decodeFileContent(data))
            );
        } catch (error) {
            console.warn('Failed to read script:', file.path, error);
        }
    }
    return loaded;
}

function collectFolderOptions(items: RunnableScript[]): string[] {
    const folders = new Set<string>([ALL_SCRIPTS_FOLDER]);
    for (const script of items) {
        let folder = script.folderPath;
        while (folder.startsWith(SCRIPTS_ROOT)) {
            folders.add(relativeToScriptsRoot(folder));
            if (folder === SCRIPTS_ROOT) {
                break;
            }
            const parent = parentFolderPath(folder);
            if (parent === folder) {
                break;
            }
            folder = parent;
        }
    }
    return [...folders].sort((a, b) => {
        if (a === ALL_SCRIPTS_FOLDER) return -1;
        if (b === ALL_SCRIPTS_FOLDER) return 1;
        return a.localeCompare(b);
    });
}

function folderFilterPath(relativeFolder: string): string {
    if (!relativeFolder) {
        return ALL_SCRIPTS_FOLDER;
    }
    return `${SCRIPTS_ROOT}/${relativeFolder}`;
}

function matchesSearch(script: RunnableScript, query: string): boolean {
    if (!query) {
        return true;
    }
    const titleMatch = displayTitle(script).toLowerCase().includes(query);
    const keywordMatch = script.keywords.some((keyword) =>
        keyword.toLowerCase().includes(query)
    );
    return titleMatch || keywordMatch;
}

function getScopedScripts(options?: {
    ignoreKeyword?: boolean;
}): RunnableScript[] {
    const folderPath = folderFilterPath(activeFolder);
    const query = searchTerm.trim().toLowerCase();
    const keyword = options?.ignoreKeyword ? null : activeKeyword;

    return scripts.filter((script) => {
        if (!isUnderFolder(script.path, folderPath)) {
            return false;
        }
        if (keyword) {
            const needle = keyword.toLowerCase();
            if (
                !script.keywords.some((value) => value.toLowerCase() === needle)
            ) {
                return false;
            }
        }
        return matchesSearch(script, query);
    });
}

function getVisibleScripts(): RunnableScript[] {
    return getScopedScripts();
}

function keywordCountsForScope(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const script of getScopedScripts({ ignoreKeyword: true })) {
        for (const keyword of script.keywords) {
            counts.set(keyword, (counts.get(keyword) || 0) + 1);
        }
    }
    return counts;
}

function setSelectedPath(path: string | null, persist = true): void {
    selectedPath = path;
    if (persist && path) {
        saveLastSelectedPath(path);
    }
    updateRunButtonState();
    renderScriptList();
}

function updateRunButtonState(): void {
    if (!runButton) {
        return;
    }
    const canRun =
        !!selectedPath &&
        !isRunning &&
        !!scripts.find((s) => s.path === selectedPath);
    runButton.disabled = !canRun;
}

function renderFolderSelect(): void {
    if (!folderSelect) {
        return;
    }
    const previous = activeFolder;
    const options = collectFolderOptions(scripts);
    folderSelect.replaceChildren();

    for (const folder of options) {
        const option = document.createElement('option');
        option.value = folder;
        option.textContent = folder ? folder : 'All Scripts';
        folderSelect.appendChild(option);
    }

    if (options.includes(previous)) {
        folderSelect.value = previous;
        activeFolder = previous;
    } else {
        folderSelect.value = ALL_SCRIPTS_FOLDER;
        activeFolder = ALL_SCRIPTS_FOLDER;
    }
}

function renderKeywordChips(): void {
    if (!keywordChips) {
        return;
    }
    keywordChips.replaceChildren();
    const counts = keywordCountsForScope();
    const keywords = [...counts.keys()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    const allCount = getScopedScripts({ ignoreKeyword: true }).length;

    const appendChip = (
        label: string,
        keyword: string | null,
        count: number
    ) => {
        const chip = document.createElement('button');
        chip.className = 'assistant-tool-category-chip';
        chip.type = 'button';
        chip.textContent = `${label} (${count})`;
        chip.setAttribute('aria-pressed', String(activeKeyword === keyword));
        chip.addEventListener('click', () => {
            activeKeyword = keyword;
            ensureSelectionVisible();
            renderKeywordChips();
            renderScriptList();
        });
        keywordChips!.appendChild(chip);
    };

    appendChip('All', null, allCount);
    for (const keyword of keywords) {
        appendChip(keyword, keyword, counts.get(keyword) || 0);
    }
}

function renderScriptList(): void {
    if (!scriptList) {
        return;
    }
    scriptList.replaceChildren();
    const visible = getVisibleScripts();

    if (visible.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'assistant-tool-empty';
        empty.textContent = settingsFolder.hasFolder()
            ? 'No matching scripts.'
            : 'Select a Settings Folder to browse scripts.';
        scriptList.appendChild(empty);
        return;
    }

    for (const script of visible) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'run-python-script-item';
        if (script.path === selectedPath) {
            item.classList.add('selected');
        }
        item.setAttribute(
            'aria-selected',
            String(script.path === selectedPath)
        );
        item.dataset.path = script.path;

        const title = document.createElement('div');
        title.className = 'run-python-script-item-title';
        title.textContent = displayTitle(script);
        item.appendChild(title);

        const path = document.createElement('div');
        path.className = 'run-python-script-item-path';
        path.textContent = script.relativePath;
        item.appendChild(path);

        if (script.description) {
            const description = document.createElement('div');
            description.className = 'run-python-script-item-description';
            description.textContent = script.description
                .replace(/\s*\n\s*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            item.appendChild(description);
        }

        if (script.keywords.length > 0) {
            const keywords = document.createElement('div');
            keywords.className = 'run-python-script-item-keywords';
            for (const keyword of script.keywords) {
                const code = document.createElement('code');
                code.textContent = keyword;
                keywords.appendChild(code);
            }
            item.appendChild(keywords);
        }

        item.addEventListener('click', () => {
            setSelectedPath(script.path);
        });

        item.addEventListener('dblclick', () => {
            setSelectedPath(script.path);
            void runSelectedScript();
        });

        scriptList.appendChild(item);
    }
}

function ensureSelectionVisible(): void {
    const visible = getVisibleScripts();
    if (
        selectedPath &&
        visible.some((script) => script.path === selectedPath)
    ) {
        return;
    }
    selectedPath = visible[0]?.path ?? null;
    updateRunButtonState();
}

function renderAll(): void {
    if (emptyNotice) {
        emptyNotice.hidden = settingsFolder.hasFolder();
    }
    renderFolderSelect();
    ensureSelectionVisible();
    renderKeywordChips();
    renderScriptList();
    updateRunButtonState();
}

async function refreshScripts(): Promise<void> {
    scripts = await loadScriptsFromSettingsFolder();
    const remembered = loadLastSelectedPath();
    if (remembered && scripts.some((script) => script.path === remembered)) {
        selectedPath = remembered;
    } else if (
        selectedPath &&
        !scripts.some((script) => script.path === selectedPath)
    ) {
        selectedPath = null;
    }
    renderAll();
}

async function executePython(code: string, title: string): Promise<void> {
    if (!window.pyodide && typeof window.ensurePyodideReady === 'function') {
        isRunning = true;
        updateRunButtonState();
        try {
            await window.ensurePyodideReady();
        } finally {
            isRunning = false;
            updateRunButtonState();
        }
    }
    if (!window.pyodide) {
        alert('Python environment not ready yet');
        return;
    }

    isRunning = true;
    updateRunButtonState();

    try {
        if (window.term) {
            window.term.echo('---');
            window.term.echo(`🚀 Running ${title}...`);
            await window.pyodide.runPythonAsync(code);
            window.term.echo('✅ Script completed');
        } else {
            await window.pyodide.runPythonAsync(code);
            console.log('Script executed successfully:', title);
        }
    } catch (error: unknown) {
        console.error('Script execution error:', error);
        const err = error as {
            constructor?: { name?: string };
            message?: string;
        };
        const fullTraceback =
            err?.constructor?.name === 'PythonError' && err.message
                ? window.cleanPythonTraceback(err.message)
                : err?.message || String(error);

        if (window.consoleError) {
            window.consoleError(fullTraceback);
        } else if (window.term) {
            try {
                if (window.term.paused) {
                    window.term.resume();
                }
                window.term.error(fullTraceback);
            } catch (displayError) {
                console.error(
                    'Failed to display error in terminal:',
                    displayError
                );
            }
        }
    } finally {
        isRunning = false;
        updateRunButtonState();
    }
}

async function runScriptByPath(path: string): Promise<boolean> {
    let script = scripts.find((item) => item.path === path);
    if (!script) {
        await settingsFolder.initialize();
        if (!settingsFolder.hasFolder()) {
            alert('Select a Settings Folder to run scripts');
            return false;
        }
        try {
            const data = await settingsFolder.getAdapter().readFile(path);
            script = buildScriptFromFile(path, decodeFileContent(data));
        } catch (error) {
            console.error('Failed to load script for run:', path, error);
            alert('Failed to load script.');
            return false;
        }
    }

    const title = displayTitle(script);
    saveLastSelectedPath(script.path);
    saveLastRun({ path: script.path, title });
    selectedPath = script.path;
    await executePython(script.content, title);
    return true;
}

async function runSelectedScript(): Promise<void> {
    if (!selectedPath) {
        return;
    }
    closeDialog();
    await runScriptByPath(selectedPath);
}

export async function reRunLastPythonScript(): Promise<void> {
    const lastRun = loadLastRun();
    if (!lastRun) {
        await openRunPythonScriptDialog();
        return;
    }
    await runScriptByPath(lastRun.path);
}

function closeDialog(): void {
    if (!modal) {
        return;
    }
    escapeBinding?.release();
    escapeBinding = null;
    modal.style.display = 'none';
    isOpen = false;
}

export async function openRunPythonScriptDialog(): Promise<void> {
    ensureDom();
    if (!modal) {
        return;
    }

    isOpen = true;
    modal.style.display = 'flex';
    escapeBinding?.release();
    escapeBinding = bindModalEscape(() => closeDialog(), {
        isOpen: () => isOpen && modal?.style.display === 'flex'
    });
    searchTerm = searchInput?.value || '';
    await refreshScripts();
    requestAnimationFrame(() => searchInput?.focus());
}

function onDialogKeyDown(event: KeyboardEvent): void {
    if (!isOpen || !modal || modal.style.display !== 'flex') {
        return;
    }

    if (event.key === 'Enter' && selectedPath) {
        const target = event.target as HTMLElement | null;
        if (target && target.tagName === 'SELECT') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void runSelectedScript();
    }
}

function ensureDom(): void {
    if (modal && contentEl) {
        return;
    }

    modal = document.getElementById('run-python-script-modal');
    contentEl = document.getElementById('run-python-script-modal-content');
    const closeBtn = document.getElementById(
        'run-python-script-modal-close-btn'
    );
    if (!modal || !contentEl || !closeBtn) {
        console.error('Run Python Script modal markup missing');
        return;
    }

    const search = document.createElement('div');
    search.className = 'find-glyph-search overview-search-control';

    const searchIcon = document.createElement('span');
    searchIcon.className = 'material-symbols-outlined overview-search-icon';
    searchIcon.textContent = 'search';
    search.appendChild(searchIcon);

    searchInput = document.createElement('input');
    searchInput.className = 'find-glyph-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search titles and keywords';
    searchInput.setAttribute('aria-label', 'Search titles and keywords');
    search.appendChild(searchInput);

    emptyNotice = document.createElement('p');
    emptyNotice.className = 'assistant-tool-empty';
    emptyNotice.textContent =
        'Select a Settings Folder in Preferences to enable Run Python Script.';
    emptyNotice.hidden = true;

    folderSelect = document.createElement('select');
    folderSelect.className = 'run-python-script-folder-select';
    folderSelect.setAttribute('aria-label', 'Scripts folder');

    keywordChips = document.createElement('div');
    keywordChips.className = 'assistant-tool-category-chips';
    keywordChips.setAttribute('aria-label', 'Script keywords');
    keywordChips.setAttribute('role', 'group');

    scriptList = document.createElement('div');
    scriptList.className = 'run-python-script-list';

    const actions = document.createElement('div');
    actions.className = 'run-python-script-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'dialog-button';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', closeDialog);

    runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'dialog-button dialog-button-primary';
    runButton.textContent = 'Run Script';
    runButton.disabled = true;
    runButton.addEventListener('click', () => {
        void runSelectedScript();
    });

    actions.append(cancelButton, runButton);

    contentEl.replaceChildren(
        search,
        emptyNotice,
        folderSelect,
        keywordChips,
        scriptList,
        actions
    );

    searchInput.addEventListener('input', () => {
        searchTerm = searchInput?.value || '';
        ensureSelectionVisible();
        renderKeywordChips();
        renderScriptList();
    });

    folderSelect.addEventListener('change', () => {
        activeFolder = folderSelect?.value || ALL_SCRIPTS_FOLDER;
        ensureSelectionVisible();
        renderKeywordChips();
        renderScriptList();
    });

    closeBtn.addEventListener('click', closeDialog);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeDialog();
        }
    });
    document.addEventListener('keydown', onDialogKeyDown);

    window.addEventListener('settingsFolderAccessChanged', () => {
        if (isOpen) {
            void refreshScripts();
        }
    });
}

export function initRunPythonScriptDialog(): void {
    ensureDom();
}

window.runPythonScriptDialog = {
    open: openRunPythonScriptDialog,
    reRunLast: reRunLastPythonScript,
    getLastRun: getLastRunPythonScript
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRunPythonScriptDialog);
} else {
    initRunPythonScriptDialog();
}
