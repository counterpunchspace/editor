// File Browser for in-browser memfs
// Shows the Pyodide file system in view 3

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    FileSystemAdapter,
    isFileSystemAccessSupported,
    FileInfo
} from './file-system-adapter';
import { showCriticalError } from './critical-error-handler';
import {
    pluginRegistry,
    FilesystemPlugin,
    DiskPlugin,
    TitleBarMenuItem,
    type FileContextAction,
    type FileContextTarget,
    type PluginMessageOptions
} from './filesystem-plugins';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';
const { waitForFontEditorReady } = require('./editor-startup-ready.js');
import { requestOpenFontConversion } from './font-compilation';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import { reloadLinkedEditorWindows } from './window-buttons';
import { readUrlState, updateUrlState } from './url-state';
import { TOUR_FUSTAT_PATH, TOUR_SAMPLE_TEXT } from './tour-slides';
import { shouldHandleOpenPathBeforeEditorReady } from './open-font-readiness';
import { serializeFontForSourceSave } from './font-manager';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { notifyLoadingOverlayHiding } from './welcome-screen';
import {
    createFolderSetupCallout,
    openFolderPermissionsDialog
} from './folder-permissions-dialog';
import {
    cancelManagedFileInternalWrite,
    consumeManagedFileInternalWritePaths,
    markManagedFileInternalWrite
} from './managed-file-events';
import {
    getDefaultDialogSelectionPath as getDefaultDialogSelectionPathForFont,
    getFileDialogHeaderActions,
    getFileDialogPrimaryAction,
    getFileDialogRefreshStatus,
    getFileDialogSaveWarningPresentation,
    isOpenDialogConfirmEnabled,
    shouldOpenFileOnDialogDoubleClick
} from './file-dialog-state';

const console = new Logger('FileBrowser');

const LAST_CONTEXT_KEY = 'lastFilesystemContext';
const FILE_BROWSER_READY_EVENT = 'fileBrowserReady';

function armDefaultStartupRegularLocation(): void {
    if (readUrlState().location) {
        return;
    }
    if (window.stateManager) {
        window.stateManager.editor_variation_location = { wght: 400 };
    }
}

type ChangedPathRecord = {
    path?: unknown;
    relativePath?: unknown;
    changedPath?: unknown;
    oldPath?: unknown;
    newPath?: unknown;
    relativePathComponents?: unknown;
    movedFrom?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
    movedTo?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
};

type MenuElement = HTMLElement & { _handlersSetup?: boolean };
type TippyHostElement = HTMLElement & {
    _tippy?: TippyInstance;
    _hasMenu?: boolean;
};

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Files/folders to hide from the file browser (applies to all plugins)
const HIDDEN_FILES: string[] = ['.DS_Store'];

function isPluginVisibleInUI(
    plugin: FilesystemPlugin | null | undefined
): plugin is FilesystemPlugin {
    return Boolean(plugin?.isVisibleInUI());
}

function getUIVisiblePlugins(): FilesystemPlugin[] {
    return pluginRegistry.getAll().filter((plugin) => plugin.isVisibleInUI());
}

function getPathStorageKey(pluginId: string): string {
    return `lastPath.${pluginId}`;
}

interface FileSystemState {
    currentPath: string;
    currentPlugin: FilesystemPlugin;
    activeAdapter: FileSystemAdapter;
}

let fileSystemCache: FileSystemState = {
    currentPath: '/',
    currentPlugin: pluginRegistry.getDefault()!,
    activeAdapter: pluginRegistry.getDefault()!.getAdapter()
};

type OpenFontOptions = {
    sourcePluginOverride?: FilesystemPlugin;
    closeDialogOnSuccess?: boolean;
};

type FileDialogMode = 'open' | 'save-as';

type ShowFileDialogOptions = {
    mode?: FileDialogMode;
    pluginId?: string;
    path?: string;
    highlightPath?: string;
    suggestedName?: string;
};

type FileDialogBusyOptions = {
    message: string;
    actionLabel: string;
    useLoadingCursor?: boolean;
};

let activeFileDialogMode: FileDialogMode = 'open';
let selectedDialogPath: string | null = null;
let pendingDialogHighlightPath: string | null = null;
let fileDialogBusyDepth = 0;
let fileDialogBusyMessage: string | null = null;
let fileDialogBusyActionLabel: string | null = null;
let fileDialogSaveBlocked = false;
let fileDialogSaveWarningRefreshToken = 0;
let fileDialogEscapeBinding: ModalEscapeBinding | null = null;

type FileDialogSaveWarningState =
    import('./file-dialog-state').FileDialogSaveWarningState;
let lastFileTreeRefreshAt: number | null = null;
let pathDisplayFrame: number | null = null;

function getDefaultDialogSelectionPath(pluginId: string): string | null {
    return getDefaultDialogSelectionPathForFont(
        pluginId,
        window.fontManager?.currentFont
    );
}

function getFooterSelectionPath(): string | null {
    return (
        selectedDialogPath ||
        getDefaultDialogSelectionPath(fileSystemCache.currentPlugin.getId())
    );
}

function getCurrentPluginSelectionPath(): string | null {
    if (!selectedDialogPath) {
        return null;
    }

    return getVisibleFileItem(selectedDialogPath) ? selectedDialogPath : null;
}

function reconcileDialogSelection(): void {
    if (selectedDialogPath && !getVisibleFileItem(selectedDialogPath)) {
        selectedDialogPath = null;
    }
}

function formatDialogSelectionPath(path: string): string {
    return createFileUri(fileSystemCache.currentPlugin.getId(), path);
}

function updateLastRefreshedStatus(): void {
    const statusElement = document.getElementById('file-last-refreshed');
    if (!statusElement) {
        return;
    }

    const status = getFileDialogRefreshStatus(
        fileSystemCache.currentPlugin.showsManualRefreshButton(),
        lastFileTreeRefreshAt
    );
    statusElement.style.display = status.visible ? '' : 'none';
    statusElement.textContent = status.text;
}

function normalizeOpenComparisonPath(pluginId: string, path: string): string {
    if (pluginId === 'cloud') {
        return path.replace(/^cloud:\/\//, '').replace(/^\/+/, '');
    }

    return path;
}

function isCurrentFontAlreadyOpen(
    path: string,
    sourcePlugin: FilesystemPlugin
): boolean {
    const currentFont = window.fontManager?.currentFont;
    const currentPluginId = currentFont?.sourcePlugin?.getId?.();
    if (!currentFont?.path || !currentPluginId) {
        return false;
    }

    const sourcePluginId = sourcePlugin.getId();
    if (currentPluginId !== sourcePluginId) {
        return false;
    }

    return (
        normalizeOpenComparisonPath(sourcePluginId, currentFont.path) ===
        normalizeOpenComparisonPath(sourcePluginId, path)
    );
}

function updateFileDialogBusyUi(): void {
    const dialog = getDialogRoot();
    if (!dialog) {
        return;
    }

    const shell = dialog.querySelector('.file-dialog-shell') as HTMLElement;
    const closeBtn = document.getElementById(
        'font-file-dialog-close-btn'
    ) as HTMLButtonElement | null;
    const cancelBtn = document.getElementById(
        'file-dialog-cancel-btn'
    ) as HTMLButtonElement | null;
    const saveNameInput = document.getElementById(
        'file-dialog-save-name'
    ) as HTMLInputElement | null;
    const isBusy = fileDialogBusyDepth > 0;

    dialog.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    shell?.classList.toggle('is-busy', isBusy);
    closeBtn && (closeBtn.disabled = isBusy);
    cancelBtn && (cancelBtn.disabled = isBusy);
    saveNameInput && (saveNameInput.disabled = isBusy);

    document
        .querySelectorAll('.file-dialog-plugin-tab')
        .forEach((tab: Element) => {
            (tab as HTMLButtonElement).disabled = isBusy;
        });
}

async function withFileDialogBusy<T>(
    options: FileDialogBusyOptions,
    task: () => Promise<T>
): Promise<T> {
    fileDialogBusyDepth += 1;
    fileDialogBusyMessage = options.message;
    fileDialogBusyActionLabel = options.actionLabel;

    if (options.useLoadingCursor) {
        beginLoadingCursor();
    }

    updateFileDialogBusyUi();
    updateFileDialogFooter();

    try {
        return await task();
    } finally {
        if (options.useLoadingCursor) {
            endLoadingCursor();
        }

        fileDialogBusyDepth = Math.max(0, fileDialogBusyDepth - 1);
        if (fileDialogBusyDepth === 0) {
            fileDialogBusyMessage = null;
            fileDialogBusyActionLabel = null;
        }

        updateFileDialogBusyUi();
        updateFileDialogFooter();
    }
}

function getDialogRoot(): HTMLElement | null {
    return document.getElementById('font-file-dialog');
}

function isFileDialogOpen(): boolean {
    return getDialogRoot()?.style.display === 'flex';
}

function getPathBasename(path: string | null | undefined): string {
    if (!path) {
        return '';
    }

    const normalizedPath = path.replace(/\/+$/, '');
    const lastSlash = normalizedPath.lastIndexOf('/');
    return lastSlash >= 0
        ? normalizedPath.slice(lastSlash + 1)
        : normalizedPath;
}

function getSuggestedSaveName(): string {
    const currentFont = window.fontManager?.currentFont;
    const currentPathName = getPathBasename(currentFont?.path);
    if (currentPathName) {
        return currentPathName;
    }

    const fontName = currentFont?.name?.trim();
    if (fontName) {
        return `${fontName}.babelfont`;
    }

    return 'Untitled Font.babelfont';
}

function getVisibleFileItem(path: string): HTMLElement | null {
    return document.querySelector(
        `.file-item[data-path="${CSS.escape(path)}"]`
    ) as HTMLElement | null;
}

function isSelectedPathOpenableFont(): boolean {
    const selectedPath = getCurrentPluginSelectionPath();
    if (!selectedPath) {
        return false;
    }

    const selectedItem = getVisibleFileItem(selectedPath);
    return isOpenDialogConfirmEnabled(selectedItem?.dataset.isFont === 'true');
}

function getSelectedDialogTarget(): FileContextTarget | null {
    const selectedPath = getCurrentPluginSelectionPath();
    if (!selectedPath) {
        return null;
    }

    const selectedItem = getVisibleFileItem(selectedPath);
    if (!selectedItem) {
        return null;
    }

    return {
        path: selectedPath,
        name: selectedItem.dataset.name || '',
        isDir: selectedItem.dataset.isDir === 'true'
    };
}

function updateFileSelectionUi(): void {
    reconcileDialogSelection();

    document.querySelectorAll('.file-item.selected').forEach((item) => {
        item.classList.remove('selected');
    });

    if (!selectedDialogPath) {
        return;
    }

    getVisibleFileItem(selectedDialogPath)?.classList.add('selected');
}

function updateFileDialogFooter(): void {
    const title = document.getElementById('font-file-dialog-title');
    const subtitle = document.getElementById('font-file-dialog-subtitle');
    const selection = document.getElementById('file-dialog-selection');
    const saveFields = document.getElementById('file-dialog-save-fields');
    const saveNameInput = document.getElementById(
        'file-dialog-save-name'
    ) as HTMLInputElement | null;
    const saveWarning = document.getElementById('file-dialog-save-warning');
    const confirmButton = document.getElementById(
        'file-dialog-confirm-btn'
    ) as HTMLButtonElement | null;
    const selectionPath =
        getCurrentPluginSelectionPath() ||
        getDefaultDialogSelectionPath(fileSystemCache.currentPlugin.getId());
    const isBusy = fileDialogBusyDepth > 0;

    if (title) {
        title.textContent =
            activeFileDialogMode === 'open' ? 'Open Font' : 'Save Font As';
    }

    if (subtitle) {
        subtitle.textContent =
            activeFileDialogMode === 'open'
                ? 'Choose a font source and location.'
                : 'Choose a destination and file name.';
    }

    if (selection) {
        let selectionText = selectionPath
            ? formatDialogSelectionPath(selectionPath)
            : activeFileDialogMode === 'open'
              ? 'No file selected.'
              : `Saving into ${fileSystemCache.currentPath}`;

        if (fileDialogBusyMessage) {
            selectionText = selectionPath
                ? `${selectionText} • ${fileDialogBusyMessage}`
                : fileDialogBusyMessage;
        }

        selection.textContent = selectionText;
    }

    if (saveFields) {
        saveFields.style.display =
            activeFileDialogMode === 'save-as' ? 'flex' : 'none';
    }

    if (saveWarning) {
        saveWarning.style.display =
            activeFileDialogMode === 'save-as' ? '' : 'none';
    }

    if (confirmButton) {
        confirmButton.textContent =
            fileDialogBusyActionLabel ||
            (activeFileDialogMode === 'open' ? 'Open' : 'Save As');
        confirmButton.disabled =
            isBusy ||
            (activeFileDialogMode === 'open'
                ? !isSelectedPathOpenableFont()
                : !saveNameInput?.value.trim() || fileDialogSaveBlocked);
    }
}

function setFileDialogSaveWarning(
    warningState: FileDialogSaveWarningState | null
): void {
    const warningElement = document.getElementById('file-dialog-save-warning');
    const iconElement = document.getElementById(
        'file-dialog-save-warning-icon'
    );
    const textElement = document.getElementById(
        'file-dialog-save-warning-text'
    );

    const presentation = getFileDialogSaveWarningPresentation(
        warningState,
        activeFileDialogMode === 'save-as'
    );
    fileDialogSaveBlocked = presentation.blocksSave;

    if (!warningElement || !iconElement || !textElement) {
        updateFileDialogFooter();
        return;
    }

    if (!presentation.visible) {
        warningElement.style.display = 'none';
        warningElement.removeAttribute('title');
        warningElement.dataset.tone = '';
        textElement.textContent = '';
        iconElement.textContent = '';
        updateFileDialogFooter();
        return;
    }

    warningElement.style.display = '';
    warningElement.title = presentation.title;
    warningElement.dataset.tone = presentation.tone;
    textElement.textContent = presentation.label;
    iconElement.textContent = presentation.icon;
    updateFileDialogFooter();
}

async function refreshFileDialogSaveWarning(): Promise<void> {
    const requestToken = ++fileDialogSaveWarningRefreshToken;

    if (
        activeFileDialogMode !== 'save-as' ||
        fileSystemCache.currentPlugin?.getId() !== 'cloud'
    ) {
        setFileDialogSaveWarning(null);
        return;
    }

    const cloudPlugin = (
        window as Window & {
            cloudPlugin?: {
                getCurrentSaveAsWarningState?: () => Promise<FileDialogSaveWarningState | null>;
            };
        }
    ).cloudPlugin;

    if (!cloudPlugin?.getCurrentSaveAsWarningState) {
        setFileDialogSaveWarning(null);
        return;
    }

    try {
        const warningState = await cloudPlugin.getCurrentSaveAsWarningState();
        if (requestToken !== fileDialogSaveWarningRefreshToken) {
            return;
        }
        setFileDialogSaveWarning(warningState);
    } catch (error) {
        if (requestToken !== fileDialogSaveWarningRefreshToken) {
            return;
        }
        console.warn(
            '[FileBrowser]',
            'Failed to compute cloud save warning:',
            error
        );
        setFileDialogSaveWarning(null);
    }
}

function closeFontFileDialog(): void {
    const dialog = getDialogRoot();
    if (!dialog) {
        return;
    }

    fileDialogEscapeBinding?.release();
    fileDialogEscapeBinding = null;
    dialog.style.display = 'none';
    selectedDialogPath = null;
    pendingDialogHighlightPath = null;
    fileDialogSaveWarningRefreshToken += 1;
    setFileDialogSaveWarning(null);
    updateFileDialogFooter();
}

async function showFontFileDialog(
    options: ShowFileDialogOptions = {}
): Promise<void> {
    const dialog = getDialogRoot();
    if (!dialog) {
        return;
    }

    activeFileDialogMode = options.mode || 'open';
    const requestedPlugin = options.pluginId
        ? pluginRegistry.get(options.pluginId)
        : fileSystemCache.currentPlugin;
    const fallbackPlugin = isPluginVisibleInUI(fileSystemCache.currentPlugin)
        ? fileSystemCache.currentPlugin
        : (pluginRegistry.getDefault() ?? fileSystemCache.currentPlugin);
    const targetPlugin = isPluginVisibleInUI(requestedPlugin)
        ? requestedPlugin
        : fallbackPlugin;
    const targetPluginId = targetPlugin.getId();
    selectedDialogPath =
        options.highlightPath || getDefaultDialogSelectionPath(targetPluginId);
    pendingDialogHighlightPath = selectedDialogPath;

    const saveNameInput = document.getElementById(
        'file-dialog-save-name'
    ) as HTMLInputElement | null;
    if (saveNameInput) {
        saveNameInput.value = options.suggestedName || getSuggestedSaveName();
    }

    dialog.style.display = 'flex';
    if (!fileDialogEscapeBinding) {
        fileDialogEscapeBinding = bindModalEscape(closeFontFileDialog, {
            isOpen: () => isFileDialogOpen()
        });
    }

    if (targetPluginId !== fileSystemCache.currentPlugin.getId()) {
        await switchContext(targetPluginId);
    }

    if (options.path) {
        await browseCurrentPluginIfReady(options.path);
    } else if (!document.getElementById('file-path-header')) {
        await browseCurrentPluginIfReady(fileSystemCache.currentPath || '/');
    } else {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                // Reopen can reuse an existing dialog after an async file-tree
                // refresh replaced the file-item DOM while the dialog was
                // hidden. Rebind per-item handlers so context menus and clicks
                // are available immediately on the next open.
                setupFileContextMenus();
                setupFileItemClickHandlers();
                updateFileSelectionUi();
                resolve();
            });
        });
    }

    updateFileDialogFooter();
    updateFileDialogBusyUi();
    void refreshFileDialogSaveWarning();

    if (activeFileDialogMode === 'save-as') {
        setTimeout(() => saveNameInput?.focus(), 0);
    }
}

function isTransientGlyphsParseError(errorMessage: string): boolean {
    return (
        errorMessage.includes('Failed to load .glyphs file') &&
        errorMessage.includes('PlistParse("Missing \'=\' at line 1, column 2")')
    );
}

function describeBinaryPrefix(
    contents: string | Uint8Array | undefined
): string {
    if (contents === undefined) {
        return 'contents=undefined';
    }

    if (typeof contents === 'string') {
        const prefix = contents.slice(0, 32).replace(/\n/g, '\\n');
        return `contents=string len=${contents.length} prefix="${prefix}"`;
    }

    const prefixBytes = Array.from(contents.slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join(' ');
    return `contents=uint8 len=${contents.length} bytes=${prefixBytes}`;
}

async function convertSourceToBabelfontViaWorker(
    path: string,
    extension: string,
    contents: string | Uint8Array | undefined,
    packageEntries: Record<string, Uint8Array> | undefined,
    projectEntries: Record<string, Uint8Array> | undefined,
    sourcePlugin: FilesystemPlugin
): Promise<string> {
    const shouldRetryGlyphsParse = extension === 'glyphs';
    const maxAttempts = shouldRetryGlyphsParse ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await requestOpenFontConversion({
                filename: path.split('/').pop() || path,
                contents,
                packageEntries,
                projectEntries
            });
        } catch (error: unknown) {
            const errorMessage = getErrorMessage(error);

            if (
                attempt < maxAttempts &&
                isTransientGlyphsParseError(errorMessage)
            ) {
                console.warn(
                    '[FileBrowser]',
                    'Transient glyphs parse failure; retrying conversion',
                    {
                        attempt,
                        maxAttempts,
                        pluginId: sourcePlugin.getId(),
                        path,
                        extension,
                        debugPrefix: describeBinaryPrefix(contents)
                    }
                );
                await new Promise((resolve) => setTimeout(resolve, 150));
                continue;
            }

            throw error;
        }
    }

    throw new Error('Font conversion failed after retries');
}

let detachedLaunchFilename: string | null = null;
let detachedLaunchFileHandle: FileSystemFileHandle | null = null;

let diskFontReloadDebounceTimer: number | null = null;
const pendingDiskChangePaths = new Set<string>();
let fileBrowserReady = false;
let resolveFileBrowserReady: (() => void) | null = null;
const fileBrowserReadyPromise = new Promise<void>((resolve) => {
    resolveFileBrowserReady = resolve;
});
let memoryFilesystemReadyPromise: Promise<void> | null = null;
const PYTHON_READY_POLL_INTERVAL_MS = 100;

async function ensureMemoryFilesystemReady(): Promise<void> {
    if (!memoryFilesystemReadyPromise) {
        memoryFilesystemReadyPromise = (async () => {
            const memoryPlugin = pluginRegistry.get('memory');
            if (memoryPlugin) {
                await memoryPlugin.getAdapter().createFolder('/user');
            }
        })();
    }
    await memoryFilesystemReadyPromise;
}

function markFileBrowserReady(): void {
    if (fileBrowserReady) {
        return;
    }

    fileBrowserReady = true;
    resolveFileBrowserReady?.();
    resolveFileBrowserReady = null;
    window.dispatchEvent(new CustomEvent(FILE_BROWSER_READY_EVENT));
}

async function waitForFileBrowserReady(timeoutMs = 30000): Promise<void> {
    if (fileBrowserReady) {
        return;
    }

    await Promise.race([
        fileBrowserReadyPromise,
        new Promise<void>((_, reject) => {
            window.setTimeout(() => {
                reject(
                    new Error(
                        `Timed out waiting for ${FILE_BROWSER_READY_EVENT}`
                    )
                );
            }, timeoutMs);
        })
    ]);
}

async function waitForPythonEnvironmentReady(): Promise<void> {
    if (!window.pyodide) {
        await new Promise<void>((resolve) => {
            const checkReadiness = () => {
                if (window.pyodide) {
                    resolve();
                    return;
                }

                window.setTimeout(
                    checkReadiness,
                    PYTHON_READY_POLL_INTERVAL_MS
                );
            };

            checkReadiness();
        });
    }

    await waitForFontEditorReady();
}

function normalizeObservedPath(path: string): string {
    const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/${cleaned}`.replace(/\/+/g, '/');
}

function extractChangedPathsFromRecords(records: unknown[]): string[] {
    const paths = new Set<string>();

    const addPath = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            paths.add(normalizeObservedPath(value));
        }
    };

    for (const record of records || []) {
        if (!record || typeof record !== 'object') {
            continue;
        }

        const changedRecord = record as ChangedPathRecord;
        addPath(changedRecord.path);
        addPath(changedRecord.relativePath);
        addPath(changedRecord.changedPath);
        addPath(changedRecord.oldPath);
        addPath(changedRecord.newPath);

        const relComps = changedRecord.relativePathComponents;
        if (Array.isArray(relComps) && relComps.length > 0) {
            addPath(relComps.join('/'));
        }

        const movedFrom = changedRecord.movedFrom;
        if (movedFrom && typeof movedFrom === 'object') {
            addPath(movedFrom.path);
            const comps = movedFrom.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }

        const movedTo = changedRecord.movedTo;
        if (movedTo && typeof movedTo === 'object') {
            addPath(movedTo.path);
            const comps = movedTo.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }
    }

    return Array.from(paths);
}

function getFontWatchRoots(fontPath: string): string[] {
    const extension = fontPath.split('.').pop()?.toLowerCase() || '';

    if (
        extension === 'ufo' ||
        extension === 'glyphspackage' ||
        extension === 'glyphpackage'
    ) {
        return [fontPath];
    }

    if (extension === 'designspace') {
        const parent = fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
        return [parent];
    }

    return [fontPath];
}

function isPathWithinRoot(path: string, root: string): boolean {
    const normalizedPath = normalizeObservedPath(path);
    const normalizedRoot = normalizeObservedPath(root);

    if (normalizedPath === normalizedRoot) {
        return true;
    }

    return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function changedPathsAffectCurrentFont(
    changedPaths: string[],
    currentFontPath: string
): boolean {
    const watchRoots = getFontWatchRoots(currentFontPath);
    return changedPaths.some((changedPath) =>
        watchRoots.some((root) => isPathWithinRoot(changedPath, root))
    );
}

function hasUnsavedFontChanges(
    currentFont: { hasUnsavedChanges?: boolean } | null
): boolean {
    if (!currentFont) {
        return false;
    }

    if (currentFont.hasUnsavedChanges === true) {
        return true;
    }

    const dirtyIndicator = document.getElementById('file-dirty-indicator');
    return !!dirtyIndicator?.classList.contains('visible');
}

function confirmExternalFontReload(): boolean {
    return window.confirm(
        'External font changes detected with unsaved local changes. OK = reload external (discard local unsaved); Cancel = keep local changes.'
    );
}

async function maybeReloadCurrentFontFromDisk(
    changedPaths: string[]
): Promise<void> {
    if (!changedPaths.length) {
        return;
    }

    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        return;
    }

    if (currentFont.sourcePlugin.getId() !== 'disk') {
        return;
    }

    if (!changedPathsAffectCurrentFont(changedPaths, currentFont.path)) {
        return;
    }

    if (window.fontManager.isExternalReloading) {
        return;
    }

    if (hasUnsavedFontChanges(currentFont)) {
        const shouldReloadExternal = confirmExternalFontReload();
        if (!shouldReloadExternal) {
            return;
        }
    }

    try {
        await window.fontManager.reloadCurrentFontFromSource({
            preserveUiState: true
        });
        console.log('[FileBrowser]', 'External font reload completed');
    } catch (error) {
        console.error('[FileBrowser]', 'External font reload failed:', error);
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        alert(`Failed to reload externally changed font: ${errorMessage}`);
    }
}

function formatFileSize(bytes: number | undefined): string {
    if (bytes === undefined || bytes < 0) return '—';
    if (bytes === 0) return '0 kB';
    return `${Math.max(1, Math.ceil(bytes / 1024))} kB`;
}

function truncatePathMiddle(
    path: string,
    availableWidth: number,
    fontSize = 10
): string {
    // Estimate characters that fit (using average character width for Inter font)
    // Inter at 10px has roughly 5px average character width (narrower than 0.6 ratio)
    const avgCharWidth = fontSize * 0.52;
    const maxChars = Math.floor(availableWidth / avgCharWidth);

    if (path.length <= maxChars || maxChars < 10) return path;

    // Calculate how much to show on each side
    const ellipsis = '...';
    const charsToShow = maxChars - ellipsis.length;
    const charsStart = Math.ceil(charsToShow * 0.4); // 40% at start
    const charsEnd = Math.floor(charsToShow * 0.6); // 60% at end

    const start = path.substring(0, charsStart);
    const end = path.substring(path.length - charsEnd);

    return `${start}${ellipsis}${end}`;
}

/**
 * Create a file URI from plugin ID and path
 * Format: pluginId:///path/to/file
 */
function createFileUri(pluginId: string, path: string): string {
    const directUriPattern = new RegExp(`^${pluginId}:\/\/\/?`);
    const normalizedPath = directUriPattern.test(path)
        ? path.replace(directUriPattern, '')
        : path;

    return `${pluginId}:///${normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath}`;
}

function syncEditorFileState(fileUri: string, eventType: string): void {
    updateUrlState({ file: fileUri });

    if (!window.stateManager) {
        return;
    }

    const didChange = window.stateManager.editor_file !== fileUri;
    if (didChange) {
        window.stateManager.editor_file = fileUri;
        window.stateManager.recordEvent(eventType, 'FileBrowser', {
            fileUri
        });
    }

    window.stateManager.syncUrlNow?.();
}

function syncEditorFileStateFromCurrentFont(): void {
    const currentFont = window.fontManager?.currentFont;
    const pluginId = currentFont?.sourcePlugin?.getId?.();
    let path = currentFont?.path;

    if (!pluginId || !path) {
        return;
    }

    // Cloud paths may be stored as 'cloud://assetId' but createFileUri expects
    // just the assetId portion (without the scheme prefix).
    if (pluginId === 'cloud' && path.startsWith('cloud://')) {
        path = path.slice('cloud://'.length);
    }

    syncEditorFileState(createFileUri(pluginId, path), 'file_opened');
}

/**
 * Parse a file URI into plugin ID and path
 * Format: pluginId:///path/to/file
 */
function parseFileUri(uri: string): { pluginId: string; path: string } | null {
    if (uri.startsWith('cloud://') && !uri.startsWith('cloud:///')) {
        return {
            pluginId: 'cloud',
            path: '/' + uri.slice('cloud://'.length)
        };
    }

    const match = uri.match(/^([^:]+):\/\/\/(.*)$/);
    if (!match) return null;
    return {
        pluginId: match[1],
        path: '/' + match[2]
    };
}

function schedulePathDisplayUpdate(path: string): void {
    const pathTextElement = document.querySelector(
        '.file-path-text'
    ) as HTMLElement | null;
    if (!pathTextElement) {
        return;
    }

    if (pathDisplayFrame !== null) {
        cancelAnimationFrame(pathDisplayFrame);
    }

    pathDisplayFrame = requestAnimationFrame(() => {
        pathDisplayFrame = null;
        const availableWidth = pathTextElement.offsetWidth;
        const displayPath = truncatePathMiddle(path, availableWidth, 10);
        if (pathTextElement.textContent !== displayPath) {
            pathTextElement.textContent = displayPath;
        }
    });
}

function fileTypeIcon(iconName: string): string {
    return `<span class="material-symbols-outlined file-type-icon">${iconName}</span>`;
}

function isFontPackageDirectory(filename: string, isDir: boolean): boolean {
    if (!isDir) return false;
    const lowerName = filename.toLowerCase();
    return lowerName.endsWith('.glyphspackage') || lowerName.endsWith('.ufo');
}

function getFileIcon(filename: string, isDir: boolean): string {
    const lowerName = filename.toLowerCase();

    if (isDir) {
        return isFontPackageDirectory(filename, isDir)
            ? fileTypeIcon('folder_zip')
            : fileTypeIcon('folder');
    }

    const ext = lowerName.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'py':
            return fileTypeIcon('code');
        case 'txt':
            return fileTypeIcon('description');
        case 'json':
            return fileTypeIcon('data_object');
        case 'md':
            return fileTypeIcon('article');
        case 'html':
            return fileTypeIcon('language');
        case 'css':
            return fileTypeIcon('palette');
        case 'js':
            return fileTypeIcon('code');
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
            return fileTypeIcon('image');
        case 'pdf':
            return fileTypeIcon('picture_as_pdf');
        case 'zip':
            return fileTypeIcon('folder_zip');
        case 'ttf':
        case 'otf':
        case 'woff':
        case 'woff2':
            return fileTypeIcon('font_download');
        case 'babelfont':
        case 'glyphs':
        case 'glyphspackage':
        case 'vfj':
        case 'sfd':
        case 'ufo':
        case 'designspace':
            return fileTypeIcon('format_shapes');
        default:
            return fileTypeIcon('draft');
    }
}

function getFileClass(filename: string, isDir: boolean): string {
    if (isDir) return 'directory';

    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'py') return 'python-file';
    return 'file';
}

function isSupportedFontFormat(name: string, isDir: boolean): boolean {
    const lowerName = name.toLowerCase();

    if (isFontPackageDirectory(name, isDir)) {
        return true;
    }

    if (isDir) {
        return false;
    }

    // Check for supported font formats
    const supportedExtensions = [
        '.babelfont', // Native format
        '.glyphs', // Glyphs 2/3
        '.vfj', // FontLab VFJ
        '.sfd', // FontForge SFD
        '.designspace' // DesignSpace
    ];

    return supportedExtensions.some((ext) => lowerName.endsWith(ext));
}

function hasOpenFontInCurrentWindow(): boolean {
    return !!window.fontManager?.currentFont;
}

// Helper functions for plugin menu dropdowns
function createPluginMenuHtml(menuItems: TitleBarMenuItem[]): string {
    const items = menuItems
        .map(
            (item) => `
        <div class="plugin-menu-item" data-action="${item.label}">
            ${item.icon ? `<span class="material-symbols-outlined">${item.icon}</span>` : ''}
            <span>${item.label}</span>
        </div>
    `
        )
        .join('');
    return `<div class="plugin-menu">${items}</div>`;
}

function createFileContextMenuHtml(
    path: string,
    name: string,
    isDir: boolean
): string {
    const target: FileContextTarget = { path, name, isDir };
    const supportsAction = (action: FileContextAction): boolean =>
        fileSystemCache.currentPlugin.supportsFileContextAction(action, target);
    const items: string[] = [];

    // Open (for supported font formats)
    if (isSupportedFontFormat(name, isDir) && supportsAction('open')) {
        items.push(`
            <div class="plugin-menu-item" data-action="open">
                <span class="material-symbols-outlined">folder_open</span>
                <span>Open</span>
            </div>
        `);
    }

    if (isSupportedFontFormat(name, isDir) && supportsAction('open-new-tab')) {
        items.push(`
            <div class="plugin-menu-item" data-action="open-new-tab">
                <span class="material-symbols-outlined">open_in_new</span>
                <span>Open in New Window</span>
            </div>
        `);
    }

    // Open in Script Editor (for Python files)
    if (supportsAction('open-in-script-editor')) {
        items.push(`
            <div class="plugin-menu-item" data-action="open-in-script-editor">
                <span class="material-symbols-outlined">code</span>
                <span>Open in Script Editor</span>
            </div>
        `);
    }

    // Download (for files only)
    if (supportsAction('download')) {
        items.push(`
            <div class="plugin-menu-item" data-action="download">
                <span class="material-symbols-outlined">download</span>
                <span>Download</span>
            </div>
        `);
    }

    // Rename (for both files and folders)
    if (supportsAction('rename')) {
        items.push(`
            <div class="plugin-menu-item" data-action="rename">
                <span class="material-symbols-outlined">edit</span>
                <span>Rename</span>
            </div>
        `);
    }

    // Delete (for both files and folders)
    if (supportsAction('delete')) {
        items.push(`
            <div class="plugin-menu-item" data-action="delete">
                <span class="material-symbols-outlined">delete</span>
                <span>Delete</span>
            </div>
        `);
    }

    return `<div class="plugin-menu">${items.join('')}</div>`;
}

function setupMenuItemHandlers(
    tippyInstance: TippyInstance,
    menuItems: TitleBarMenuItem[]
): void {
    const menu = tippyInstance.popper.querySelector('.plugin-menu');
    if (!menu) return;

    menu.querySelectorAll('.plugin-menu-item').forEach(
        (item: Element, index: number) => {
            item.addEventListener('click', async () => {
                tippyInstance.hide();
                await menuItems[index].action();
            });
        }
    );

    // Use shared keyboard navigation utility
    setupMenuKeyboardNav(menu);
}

// Track file context menu tippy instances for cleanup
let fileContextMenuTippyInstances: TippyInstance[] = [];
const FILE_DIALOG_CONTEXT_MENU_Z_INDEX = 11099;

function setupFileContextMenus() {
    // Destroy old tippy instances to prevent orphaned poppers
    fileContextMenuTippyInstances.forEach((instance) => {
        try {
            instance.destroy();
        } catch (e) {
            // Ignore errors from already-destroyed instances
        }
    });
    fileContextMenuTippyInstances = [];

    const fileItems = document.querySelectorAll('.file-item');

    // Create shared backdrop for all file context menus
    const backdrop = getOrCreateBackdrop('file-context-menu-backdrop');

    fileItems.forEach((item: Element) => {
        const element = item as HTMLElement;
        const path = element.getAttribute('data-path') || '';
        const name = element.getAttribute('data-name') || '';
        const isDir = element.getAttribute('data-is-dir') === 'true';

        element.dataset.hasContextMenu = 'true';

        // Create Tippy context menu
        const tippyInstance = tippy(element, {
            content: createFileContextMenuHtml(path, name, isDir),
            allowHTML: true,
            interactive: true,
            trigger: 'manual',
            theme: getTheme(),
            placement: 'right-start',
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: FILE_DIALOG_CONTEXT_MENU_Z_INDEX,
            getReferenceClientRect: null as any, // Will be set on show
            onShown: (instance) => {
                const menu = instance.popper.querySelector(
                    '.plugin-menu'
                ) as MenuElement | null;
                if (!menu) return;

                // Skip if handlers already set up
                if (menu._handlersSetup) return;
                menu._handlersSetup = true;

                // Setup click handlers for menu items
                menu.querySelectorAll('.plugin-menu-item').forEach(
                    (menuItem: Element) => {
                        menuItem.addEventListener('click', async () => {
                            const action = menuItem.getAttribute('data-action');

                            // Hide menu and backdrop immediately
                            instance.hide();
                            backdrop.classList.remove('visible');
                            element.classList.remove('file-item-active');

                            // Wait for menu to fully hide before executing action
                            // This ensures the DOM is clean before rename input is shown
                            await new Promise((resolve) =>
                                requestAnimationFrame(resolve)
                            );

                            switch (action) {
                                case 'open':
                                    await openFont(path);
                                    break;
                                case 'open-new-tab':
                                    openFontInNewTab(path);
                                    break;
                                case 'open-in-script-editor':
                                    await openInScriptEditor(path);
                                    break;
                                case 'download':
                                    await downloadFile(path, name);
                                    break;
                                case 'rename':
                                    await renameItem(path, name, isDir);
                                    break;
                                case 'delete':
                                    await deleteItem(path, name, isDir);
                                    break;
                            }
                        });
                    }
                );
            }
        });

        // Add to instances array for cleanup
        fileContextMenuTippyInstances.push(tippyInstance);

        // Add backdrop and keyboard support
        addTippyBackdropSupport(tippyInstance, backdrop, {
            targetElement: element,
            activeClass: 'file-item-active'
        });

        const showContextMenuAtEvent = (event: MouseEvent): void => {
            event.preventDefault();
            event.stopPropagation();

            if (!isDir) {
                selectFile(path);
            }

            tippyInstance.hide();

            // Refresh content and anchor point on every open so reused file rows
            // keep their current action set and menu position.
            tippyInstance.setProps({
                content: createFileContextMenuHtml(path, name, isDir),
                getReferenceClientRect: () => ({
                    width: 0,
                    height: 0,
                    top: event.clientY,
                    bottom: event.clientY,
                    left: event.clientX,
                    right: event.clientX,
                    x: event.clientX,
                    y: event.clientY,
                    toJSON: () => ({})
                })
            });

            tippyInstance.show();
        };

        element.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 2) {
                return;
            }

            showContextMenuAtEvent(event);
        });

        // Prevent default context menu and show Tippy menu at mouse position
        element.addEventListener('contextmenu', (e) => {
            showContextMenuAtEvent(e);
        });

        // Store tippy instance on element (for debugging access)
        (element as TippyHostElement)._tippy = tippyInstance;
    });
}

function updatePluginMenuButtonVisibility(plugin: FilesystemPlugin): void {
    const pluginId = plugin.getId();
    const button = document.querySelector(
        `.context-tab[data-plugin-id="${pluginId}"]`
    ) as HTMLElement;

    refreshPluginTabLabel(plugin);

    const hostButton = button as TippyHostElement;
    if (!hostButton || !hostButton._hasMenu) return;

    const dropdownIcon = button.querySelector(
        '.plugin-dropdown-icon'
    ) as HTMLElement;
    if (!dropdownIcon) return;

    // Show dropdown icon only if plugin is active and ready
    const isActive = button.classList.contains('active');
    if (isActive) {
        plugin.isReady().then((isReady) => {
            dropdownIcon.style.display = isReady ? 'inline-flex' : 'none';
        });
    } else {
        dropdownIcon.style.display = 'none';
    }
}

function openFontInNewTab(path: string) {
    const pluginId = fileSystemCache.currentPlugin.getId();
    const fileUri = createFileUri(pluginId, path);
    const params = new URLSearchParams();
    params.set('file', fileUri);

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    window.open(url, '_blank');
    console.log('[FileBrowser]', `Opening font in new tab: ${fileUri}`);
}

function getPluginTabDescription(plugin: FilesystemPlugin): string {
    const pluginId = plugin.getId();

    if (pluginId === 'memory') {
        return 'Browser storage';
    }

    if (pluginId === 'disk') {
        const adapter = plugin.getAdapter() as {
            directoryHandle?: { name?: string };
        };
        const folderName = adapter.directoryHandle?.name;
        return folderName ? `Folder: ${folderName}` : 'Local folder access';
    }

    if (pluginId === 'cloud') {
        const authMgr = (window as any).authManager;
        const user = authMgr?.user ?? null;
        return user ? 'Cloud storage' : 'Log in to access';
    }

    return 'Filesystem plugin';
}

function refreshPluginTabLabel(plugin: FilesystemPlugin): void {
    const pluginId = plugin.getId();
    const descriptionElement = document.querySelector(
        `.context-tab[data-plugin-id="${pluginId}"] .file-dialog-plugin-tab-description`
    ) as HTMLElement | null;

    if (!descriptionElement) {
        return;
    }

    descriptionElement.textContent = getPluginTabDescription(plugin);
}

function queuePostOpenUiRefresh(
    fontPath: string,
    options: { reloadLinkedWindows: boolean }
): void {
    let settled = false;

    const finish = () => {
        if (settled) {
            return;
        }
        settled = true;
        window.removeEventListener('fontReady', onFontReady);
        window.clearTimeout(timeoutId);
    };

    const onFontReady = async (event: Event) => {
        const detail = (event as CustomEvent<{ path?: string }>).detail;
        if (detail?.path !== fontPath) {
            return;
        }

        finish();

        try {
            const glyphCanvas = window.glyphCanvas;
            if (glyphCanvas) {
                await glyphCanvas.updatePropertiesUI();
                await glyphCanvas.featuresManager?.updateFeaturesUI?.();
                glyphCanvas.render();
            }

            await window.fontManager?.updateFontDisplay?.();
            await window.fontManager?.updateDirtyIndicator?.();

            if (
                options.reloadLinkedWindows &&
                window.windowRole?.isMainWindow?.()
            ) {
                reloadLinkedEditorWindows();
            }
        } catch (error) {
            console.warn('[FileBrowser]', 'Post-open UI refresh failed', error);
        }
    };

    const timeoutId = window.setTimeout(() => {
        finish();
    }, 15000);

    window.addEventListener('fontReady', onFontReady);
}

/**
 * Open a Python file in the Script Editor
 */
async function openInScriptEditor(path: string) {
    const pluginId = fileSystemCache.currentPlugin.getId();

    if (window.scriptEditor && window.scriptEditor.openFile) {
        try {
            await window.scriptEditor.openFile(path, pluginId);
            console.log(
                '[FileBrowser]',
                `Opened ${path} in Script Editor (plugin: ${pluginId})`
            );
        } catch (error) {
            console.error(
                '[FileBrowser]',
                'Error opening in Script Editor:',
                error
            );
            alert(
                'Failed to open file in Script Editor: ' +
                    (error as Error).message
            );
        }
    } else {
        console.error('[FileBrowser]', 'Script Editor not available');
        alert('Script Editor not available');
    }
}

async function collectDirectoryEntries(
    rootPath: string
): Promise<Record<string, Uint8Array>> {
    const entries: Record<string, Uint8Array> = {};
    const requiredTopLevelFiles = new Set([
        'fontinfo.plist',
        'order.plist',
        'UIState.plist'
    ]);

    const walk = async (currentPath: string) => {
        const items =
            await fileSystemCache.activeAdapter.scanDirectory(currentPath);

        for (const [, data] of Object.entries(items)) {
            const itemPath = data.path;
            if (data.is_dir) {
                await walk(itemPath);
                continue;
            }

            const content =
                await fileSystemCache.activeAdapter.readFile(itemPath);
            const bytes =
                typeof content === 'string'
                    ? new TextEncoder().encode(content)
                    : new Uint8Array(content as any);

            const relativePath = itemPath
                .slice(rootPath.length)
                .replace(/^\/+/, '');

            const isGlyphFile =
                relativePath.startsWith('glyphs/') &&
                relativePath.endsWith('.glyph');
            const isRequiredTopLevel = requiredTopLevelFiles.has(relativePath);

            if (!isGlyphFile && !isRequiredTopLevel) {
                continue;
            }

            entries[relativePath] = bytes;
        }
    };

    await walk(rootPath);
    return entries;
}

async function collectAllDirectoryEntries(
    rootPath: string
): Promise<Record<string, Uint8Array>> {
    const entries: Record<string, Uint8Array> = {};

    const walk = async (currentPath: string) => {
        const items =
            await fileSystemCache.activeAdapter.scanDirectory(currentPath);

        for (const [, data] of Object.entries(items)) {
            const itemPath = data.path;
            if (data.is_dir) {
                await walk(itemPath);
                continue;
            }

            const content =
                await fileSystemCache.activeAdapter.readFile(itemPath);
            const bytes =
                typeof content === 'string'
                    ? new TextEncoder().encode(content)
                    : new Uint8Array(content as any);

            const relativePath = itemPath
                .slice(rootPath.length)
                .replace(/^\/+/, '');
            entries[relativePath] = bytes;
        }
    };

    await walk(rootPath);
    return entries;
}

function getParentPath(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
}

function hideLoadingOverlayForUrlOpen(): void {
    const extendedWindow = window as Window & {
        __unsupportedBrowserWarningRequired?: boolean;
        __unsupportedBrowserWarningAcknowledged?: boolean;
    };

    if (
        extendedWindow.__unsupportedBrowserWarningRequired === true &&
        extendedWindow.__unsupportedBrowserWarningAcknowledged !== true
    ) {
        return;
    }

    const loadingOverlay = document.getElementById('loading-overlay');
    if (!loadingOverlay || loadingOverlay.classList.contains('hidden')) {
        return;
    }

    loadingOverlay.classList.add('hidden');
    notifyLoadingOverlayHiding();
}

function hasPendingPwaLaunchFiles(): boolean {
    const pending = (window as any).__pendingLaunchFileHandles;
    return Array.isArray(pending) && pending.length > 0;
}

async function revealUrlOpenedFontInFileBrowser(
    fontPath: string
): Promise<void> {
    await waitForFileBrowserReady();
    await switchContext('memory');
    const dirPath = fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
    try {
        await navigateToPath(dirPath);
    } catch (navError) {
        console.error(
            '[FileBrowser]',
            `Cannot navigate to directory: ${dirPath}`,
            navError
        );
    }
    updateHomeButtonVisibility();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fileTree = document.getElementById('file-tree');
    const currentFontItem = fileTree?.querySelector('.file-item.current-font');
    if (currentFontItem) {
        (currentFontItem as HTMLElement).scrollIntoView({
            block: 'center',
            behavior: 'auto'
        });
    }
}

async function openMemoryUrlFont(fontPath: string): Promise<void> {
    timelineMark('app.startupMemoryUrlOpen.started');
    await ensureMemoryFilesystemReady();
    const memoryPlugin = pluginRegistry.get('memory');
    if (!memoryPlugin || !memoryPlugin.isVisibleInUI()) {
        throw new Error('Memory plugin is not available');
    }

    const urlOpenReadyPromise = waitForUrlOpenFontReady(fontPath);
    await openFont(fontPath, undefined, {
        sourcePluginOverride: memoryPlugin
    });
    await urlOpenReadyPromise;
    timelineMark('app.startupMemoryUrlOpen.ready');
    updateHomeButtonVisibility();
    void revealUrlOpenedFontInFileBrowser(fontPath).catch((error) => {
        console.error(
            '[FileBrowser]',
            'Failed to reveal URL-opened memory font in file browser:',
            error
        );
    });
}

function waitForUrlOpenFontReady(fontPath: string): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('fontReady', onFontReady);
            clearTimeout(timeoutId);
            resolve();
        };

        const onFontReady = (event: Event) => {
            const detail = (event as CustomEvent<{ path?: string }>).detail;
            if (detail?.path !== fontPath) {
                return;
            }

            hideLoadingOverlayForUrlOpen();
            finish();
        };

        const timeoutId = window.setTimeout(() => {
            finish();
        }, 12000);

        window.addEventListener('fontReady', onFontReady);
    });
}

async function openFont(
    path: string,
    fileHandle?: FileSystemFileHandle,
    options: OpenFontOptions = {}
) {
    const sourcePlugin =
        options.sourcePluginOverride || fileSystemCache.currentPlugin;

    if (isCurrentFontAlreadyOpen(path, sourcePlugin)) {
        if (options.closeDialogOnSuccess) {
            closeFontFileDialog();
        }
        return;
    }

    // Set loading cursor
    beginLoadingCursor();
    const openSpan = timelineSpanStart('font.open');
    timelineMark('font.open.requested');

    try {
        const sourcePluginId = sourcePlugin.getId();
        const shouldHandleOpenPathEarly = shouldHandleOpenPathBeforeEditorReady(
            sourcePluginId,
            path
        );

        if (
            shouldHandleOpenPathEarly &&
            (await sourcePlugin.handleOpenPath(path))
        ) {
            const normalizedPath = path.startsWith('cloud://')
                ? path.slice('cloud://'.length)
                : path;
            const fileUri = createFileUri(sourcePluginId, normalizedPath);
            syncEditorFileState(fileUri, 'file_opened');
            if (options.closeDialogOnSuccess) {
                closeFontFileDialog();
            }
            timelineSpanEnd(openSpan);
            return;
        }

        const pythonReadySpan = timelineSpanStart('font.open.waitForPython');
        const pythonReady = waitForPythonEnvironmentReady().finally(() => {
            timelineSpanEnd(pythonReadySpan);
        });

        const startTime = performance.now();
        console.log('[FileBrowser]', `Opening font: ${path}`);
        const isReplacingOpenFont = !!window.fontManager?.currentFont;
        const sourceAdapter = sourcePlugin.getAdapter() as any;

        const directoryHandleForSource: FileSystemDirectoryHandle | undefined =
            sourcePlugin.getId() === 'disk'
                ? sourceAdapter.directoryHandle
                : undefined;

        const isDetachedDiskLaunch =
            sourcePlugin.getId() === 'disk' &&
            !!fileHandle &&
            !directoryHandleForSource;

        // Determine file extension
        const extension = path.split('.').pop()?.toLowerCase() || '';
        const isGlyphsPackage = extension === 'glyphspackage';
        const isUfoDirectory = extension === 'ufo';
        const isDesignspace = extension === 'designspace';

        if (
            isDetachedDiskLaunch &&
            (isGlyphsPackage || isUfoDirectory || isDesignspace)
        ) {
            throw new Error(
                'This source format requires folder context. Please attach the containing folder in Disk context and open it from there.'
            );
        }

        let contents: string | Uint8Array | undefined;
        let packageEntries: Record<string, Uint8Array> | undefined;
        let projectEntries: Record<string, Uint8Array> | undefined;

        const readSpan = timelineSpanStart('font.open.readSource');
        try {
            if (isDetachedDiskLaunch) {
                const launchedFile = await fileHandle!.getFile();
                const launchedBytes = new Uint8Array(
                    await launchedFile.arrayBuffer()
                );
                contents =
                    extension === 'babelfont'
                        ? new TextDecoder('utf-8').decode(launchedBytes)
                        : launchedBytes;
            } else if (isGlyphsPackage) {
                packageEntries = await collectDirectoryEntries(path);

                if (
                    !packageEntries['fontinfo.plist'] ||
                    !packageEntries['order.plist']
                ) {
                    throw new Error(
                        'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                    );
                }
            } else if (isUfoDirectory) {
                projectEntries = await collectAllDirectoryEntries(path);
            } else if (isDesignspace) {
                const projectRoot = getParentPath(path);
                projectEntries = await collectAllDirectoryEntries(projectRoot);
            } else {
                contents = await sourceAdapter.readFile(path);

                // For text-based formats (.babelfont is JSON), decode from UTF-8
                // For binary formats (.glyphs, .ufo, etc.), keep as Uint8Array - Python/Rust handles format detection
                if (
                    extension === 'babelfont' &&
                    contents instanceof Uint8Array
                ) {
                    contents = new TextDecoder('utf-8').decode(contents);
                }
                // All other formats: keep as Uint8Array for worker to handle
            }
        } finally {
            timelineSpanEnd(readSpan);
        }

        let babelfontJson: string;

        // For non-.babelfont files, use Rust loader to convert
        if (extension !== 'babelfont') {
            const convertSpan = timelineSpanStart(
                'font.open.convertToBabelfont'
            );
            try {
                console.log(
                    '[FileBrowser]',
                    `Detected ${extension} format, converting via Rust...`
                );

                babelfontJson = await convertSourceToBabelfontViaWorker(
                    path,
                    extension,
                    contents,
                    packageEntries,
                    projectEntries,
                    sourcePlugin
                );
            } finally {
                timelineSpanEnd(convertSpan);
            }

            console.log(
                '[FileBrowser]',
                `Successfully converted ${extension} to babelfont format`
            );
        } else {
            // For .babelfont files, use contents directly (already a string)
            babelfontJson = contents as string;
        }

        await pythonReady;

        if (await sourcePlugin.handleOpenPath(path)) {
            const normalizedPath =
                sourcePluginId === 'cloud' && path.startsWith('cloud://')
                    ? path.slice('cloud://'.length)
                    : path;
            const fileUri = createFileUri(sourcePluginId, normalizedPath);
            syncEditorFileState(fileUri, 'file_opened');
            if (options.closeDialogOnSuccess) {
                closeFontFileDialog();
            }
            timelineSpanEnd(openSpan);
            return;
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(
            '[FileBrowser]',
            `Successfully opened font: ${path} (${duration}s)`
        );

        // Get file handle for disk plugin
        timelineMark('font.open.fontLoadedDispatch');
        let actualFileHandle = fileHandle;
        if (
            !actualFileHandle &&
            sourcePlugin.getId() === 'disk' &&
            directoryHandleForSource
        ) {
            const diskPlugin = sourcePlugin as DiskPlugin;
            const adapter = diskPlugin.getAdapter() as any;
            if (adapter.getFileHandle) {
                actualFileHandle = await adapter.getFileHandle(path);
            }
        }

        const directoryHandle = directoryHandleForSource;

        queuePostOpenUiRefresh(path, {
            reloadLinkedWindows: isReplacingOpenFont
        });

        // Dispatch fontLoaded event to font manager
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: path,
                    babelfontJson: babelfontJson,
                    sourcePlugin,
                    fileHandle: actualFileHandle,
                    directoryHandle: directoryHandle
                }
            })
        );

        // Update URL to reflect current file
        const pluginId = sourcePlugin.getId();
        const fileUri = createFileUri(pluginId, path);
        syncEditorFileState(fileUri, 'file_opened');
        window.stateManager?.syncUrlNow?.();

        if (options.closeDialogOnSuccess) {
            closeFontFileDialog();
        }

        timelineSpanEnd(openSpan);
    } catch (error: unknown) {
        timelineMark('font.open.failed');
        timelineSpanEnd(openSpan);
        console.error('[FileBrowser]', 'Error opening font:', error);
        if (fileSystemCache.currentPlugin?.getId() === 'cloud') {
            showPluginMessage({
                icon: 'cloud_off',
                title: 'Cloud Open Failed',
                message: getErrorMessage(error),
                tone: 'warning'
            });
        } else {
            alert(`Error opening font: ${getErrorMessage(error)}`);
        }
        // Reset cursor on error
        endLoadingCursor();
    }
}

async function getDiskFileHandleForPath(
    plugin: FilesystemPlugin,
    path: string
): Promise<FileSystemFileHandle | undefined> {
    if (plugin.getId() !== 'disk') {
        return undefined;
    }

    const adapter = plugin.getAdapter() as {
        getFileHandle?: (
            filePath: string
        ) => Promise<FileSystemFileHandle | null>;
        directoryHandle?: FileSystemDirectoryHandle;
    };

    if (!adapter.getFileHandle) {
        return undefined;
    }

    return (await adapter.getFileHandle(path)) || undefined;
}

async function saveCurrentFontAsToPath(): Promise<void> {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        return;
    }

    const saveNameInput = document.getElementById(
        'file-dialog-save-name'
    ) as HTMLInputElement | null;
    const rawFileName = saveNameInput?.value.trim() || '';
    if (!rawFileName) {
        updateFileDialogFooter();
        return;
    }

    if (rawFileName.includes('/') || rawFileName.includes('\\')) {
        alert('File name cannot contain / or \\');
        return;
    }

    if (fileDialogSaveBlocked) {
        updateFileDialogFooter();
        return;
    }

    try {
        await withFileDialogBusy(
            {
                message: 'Saving font…',
                actionLabel: 'Saving…',
                useLoadingCursor: true
            },
            async () => {
                // If the active plugin handles Save As itself (e.g. cloud),
                // delegate and close the dialog — no writeFile needed.
                if (fileSystemCache.currentPlugin?.interceptsSaveAs) {
                    const handled =
                        await fileSystemCache.currentPlugin.handleSaveAs(
                            rawFileName
                        );
                    if (handled) {
                        closeFontFileDialog();
                        try {
                            syncEditorFileStateFromCurrentFont();
                        } catch (error) {
                            console.error(
                                '[FileBrowser]',
                                'Cloud Save As succeeded but editor state sync failed:',
                                error
                            );
                        }
                        void refreshFileSystem().catch((error) => {
                            console.error(
                                '[FileBrowser]',
                                'Cloud Save As succeeded but dialog refresh failed:',
                                error
                            );
                        });
                    }
                    return;
                }

                const targetPath =
                    fileSystemCache.currentPath === '/'
                        ? `/${rawFileName}`
                        : `${fileSystemCache.currentPath.replace(/\/+$/, '')}/${rawFileName}`;

                const fileExists =
                    await fileSystemCache.activeAdapter.fileExists(targetPath);
                if (
                    fileExists &&
                    !confirm(`Overwrite existing file "${rawFileName}"?`)
                ) {
                    return;
                }

                currentFont.syncJsonFromModel();
                const sourcePlugin = currentFont.sourcePlugin;
                const destinationPlugin = fileSystemCache.currentPlugin;
                let babelfontJson = currentFont.babelfontJson;
                if (
                    sourcePlugin &&
                    destinationPlugin &&
                    sourcePlugin.getId() !== destinationPlugin.getId() &&
                    typeof sourcePlugin.stripOwnedFontData === 'function'
                ) {
                    const parsed = JSON.parse(babelfontJson) as Record<
                        string,
                        unknown
                    >;
                    babelfontJson = JSON.stringify(
                        sourcePlugin.stripOwnedFontData(parsed)
                    );
                }
                const serializedFont = await serializeFontForSourceSave(
                    targetPath,
                    babelfontJson
                );
                const pluginId = fileSystemCache.currentPlugin.getId();
                if (pluginId === 'disk') {
                    markManagedFileInternalWrite(pluginId, targetPath);
                }
                try {
                    await fileSystemCache.activeAdapter.writeFile(
                        targetPath,
                        serializedFont
                    );
                } catch (error) {
                    if (pluginId === 'disk') {
                        cancelManagedFileInternalWrite(pluginId, targetPath);
                    }
                    throw error;
                }

                currentFont.path = targetPath;
                currentFont.sourcePlugin = fileSystemCache.currentPlugin;
                currentFont.fileHandle = await getDiskFileHandleForPath(
                    fileSystemCache.currentPlugin,
                    targetPath
                );
                currentFont.directoryHandle =
                    fileSystemCache.currentPlugin.getId() === 'disk'
                        ? (
                              fileSystemCache.currentPlugin.getAdapter() as {
                                  directoryHandle?: FileSystemDirectoryHandle;
                              }
                          ).directoryHandle
                        : undefined;
                currentFont.needsRecompile = false;
                currentFont.hasUnsavedChanges = false;

                const fileUri = createFileUri(pluginId, targetPath);
                syncEditorFileState(fileUri, 'file_saved_as');

                await window.fontManager.updateFontDisplay();
                await window.fontManager.updateDirtyIndicator();
                window.saveButton?.updateButtonState?.();

                await refreshFileSystem();
                selectedDialogPath = targetPath;
                updateFileSelectionUi();
                closeFontFileDialog();
            }
        );
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error saving font:', error);
        if (fileSystemCache.currentPlugin?.getId() === 'cloud') {
            showPluginMessage({
                icon: 'cloud_off',
                title: 'Cloud Save Failed',
                message: getErrorMessage(error),
                tone: 'warning'
            });
            return;
        }
        alert(`Error saving font: ${getErrorMessage(error)}`);
    }
}

async function confirmFileDialogPrimaryAction(): Promise<void> {
    const action = getFileDialogPrimaryAction(
        activeFileDialogMode,
        selectedDialogPath,
        isSelectedPathOpenableFont(),
        fileSystemCache.currentPlugin.getId(),
        window.fontManager?.currentFont
    );

    if (action === 'save') {
        await saveCurrentFontAsToPath();
        return;
    }

    if (action === 'none') {
        updateFileDialogFooter();
        return;
    }

    if (action === 'close') {
        closeFontFileDialog();
        return;
    }

    if (!selectedDialogPath) {
        updateFileDialogFooter();
        return;
    }

    const fileHandle = (window as any)._fileHandles?.[selectedDialogPath];
    await withFileDialogBusy(
        {
            message: 'Opening font…',
            actionLabel: 'Opening…'
        },
        async () => {
            await openFont(selectedDialogPath!, fileHandle, {
                closeDialogOnSuccess: true
            });
        }
    );
}

async function locatePathInFileDialog(
    pluginId: string,
    fullPath: string
): Promise<void> {
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/';
    await showFontFileDialog({
        mode: 'open',
        pluginId,
        path: dirPath,
        highlightPath: fullPath
    });
}

async function switchContext(pluginId: string) {
    console.log('[FileBrowser]', `Switching to ${pluginId} context`);

    const plugin = pluginRegistry.get(pluginId);
    if (!plugin) {
        console.error('[FileBrowser]', `Plugin '${pluginId}' not found`);
        return;
    }
    if (!plugin.isVisibleInUI()) {
        console.warn(
            '[FileBrowser]',
            `Plugin '${pluginId}' is disabled in the editor UI`
        );
        return;
    }

    showPluginMessage({
        icon: 'progress_activity',
        title: `Loading ${plugin.getName()}…`,
        message: 'Fetching files and plugin state.',
        tone: 'info',
        spinning: true
    });

    try {
        await withFileDialogBusy(
            {
                message: `Loading ${plugin.getName()}…`,
                actionLabel: 'Loading…'
            },
            async () => {
                selectedDialogPath = getDefaultDialogSelectionPath(pluginId);
                pendingDialogHighlightPath = selectedDialogPath;
                updateFileSelectionUi();
                updateFileDialogFooter();

                // Deactivate old plugin
                await fileSystemCache.currentPlugin.onDeactivate();

                // Activate new plugin
                fileSystemCache.currentPlugin = plugin;
                fileSystemCache.activeAdapter = plugin.getAdapter();

                // Save to localStorage
                try {
                    localStorage.setItem(LAST_CONTEXT_KEY, pluginId);
                } catch (e) {
                    console.warn(
                        '[FileBrowser]',
                        'Failed to save context to localStorage:',
                        e
                    );
                }

                // Update tab UI
                document
                    .querySelectorAll('.context-tab[data-plugin-id]')
                    .forEach((tab: Element) => {
                        tab.classList.remove('active');
                        if (tab.getAttribute('data-plugin-id') === pluginId) {
                            tab.classList.add('active');
                        }
                    });

                // Update dropdown icon visibility for all plugins
                getUIVisiblePlugins().forEach((p) => {
                    updatePluginMenuButtonVisibility(p);
                });

                // Try to activate plugin (may fail if setup needed)
                const activated = await plugin.onActivate();
                if (!activated) {
                    fileSystemCache.currentPath = plugin.getDefaultPath();
                    await plugin.updateUI({
                        showOpenFolderUI,
                        hideOpenFolderUI,
                        showPermissionBanner,
                        showUnsupportedBrowserUI,
                        hideUnsupportedBrowserUI,
                        showPluginMessage,
                        hidePluginMessage
                    });
                    updateDiskRelinkButton();
                    return;
                }

                // Plugin activated successfully - let plugin update UI
                await plugin.updateUI({
                    showOpenFolderUI,
                    hideOpenFolderUI,
                    showPermissionBanner,
                    showUnsupportedBrowserUI,
                    hideUnsupportedBrowserUI,
                    showPluginMessage,
                    hidePluginMessage
                });

                // Update dropdown menu button visibility based on plugin capabilities
                updatePluginMenuButtonVisibility(plugin);
                updateDiskRelinkButton();

                // Restore last visited path for this plugin, or use default path
                let targetPath = plugin.getDefaultPath();
                try {
                    const savedPath = localStorage.getItem(
                        getPathStorageKey(pluginId)
                    );
                    if (savedPath) {
                        targetPath = savedPath;
                        console.log(
                            '[FileBrowser]',
                            `Restored last path for ${pluginId}: ${savedPath}`
                        );
                    }
                } catch (e) {
                    console.warn(
                        '[FileBrowser]',
                        'Failed to restore path from localStorage:',
                        e
                    );
                }

                fileSystemCache.currentPath = targetPath;
                showPluginMessage({
                    icon: 'progress_activity',
                    title: `Loading ${plugin.getName()}…`,
                    message: `Opening ${targetPath}`,
                    tone: 'info',
                    spinning: true
                });
                await navigateToPath(targetPath);
                const loadingMessageStillVisible = document.querySelector(
                    '#plugin-message-container .plugin-message-icon.spinning'
                );
                if (loadingMessageStillVisible) {
                    hidePluginMessage();
                }
            }
        );
    } catch (error) {
        console.error('[FileBrowser]', 'Error switching file plugin:', error);
        showPluginMessage({
            icon: pluginId === 'cloud' ? 'cloud_off' : 'folder_off',
            title: `${plugin.getName()} Unavailable`,
            message:
                pluginId === 'cloud' &&
                /failed to fetch/i.test(getErrorMessage(error))
                    ? 'The local cloud server is not reachable right now.'
                    : `Could not load files from ${plugin.getName()}.`,
            detail:
                pluginId === 'cloud'
                    ? 'Start the local cloud services and retry.'
                    : getErrorMessage(error),
            tone: 'warning',
            actionLabel: 'Retry',
            onAction: () => {
                void switchContext(pluginId);
            }
        });
    }
}

function updateOpenFolderPromptForDetachedLaunch() {
    renderOpenFolderWidget();
}

function renderOpenFolderWidget(): void {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );
    if (!openFolderContainer) {
        return;
    }

    const message = detachedLaunchFilename
        ? `Opened ${detachedLaunchFilename}. Attach its folder to enable full disk browsing and external reload.`
        : undefined;
    openFolderContainer.replaceChildren(
        createFolderSetupCallout(message, 'project')
    );
}

function isDiskProjectFolderLinked(): boolean {
    const plugin = pluginRegistry.get('disk');
    if (!(plugin instanceof DiskPlugin)) {
        return false;
    }
    const adapter = plugin.getAdapter() as { hasDirectory?: () => boolean };
    return adapter.hasDirectory?.() === true;
}

function shouldShowFilePathHeader(): boolean {
    if (!(fileSystemCache.currentPlugin instanceof DiskPlugin)) {
        return true;
    }
    return isDiskProjectFolderLinked();
}

function syncFilePathHeaderVisibility(): void {
    const pathHeader = document.getElementById('file-path-header');
    if (!pathHeader) {
        return;
    }
    pathHeader.style.display = shouldShowFilePathHeader() ? 'flex' : 'none';
}

async function browseCurrentPluginIfReady(
    path: string,
    highlightFolder?: string
): Promise<void> {
    if (!shouldShowFilePathHeader()) {
        syncFilePathHeaderVisibility();
        return;
    }
    await navigateToPath(path, highlightFolder);
}

function ensureDiskRelinkButton(): HTMLButtonElement | null {
    const tabs = document.getElementById('file-dialog-plugin-tabs');
    if (!tabs) {
        return null;
    }
    const existing = document.getElementById(
        'disk-relink-project-folder-btn'
    ) as HTMLButtonElement | null;
    if (existing) {
        return existing;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'disk-relink-project-folder-btn';
    button.className = 'dialog-button file-dialog-disk-relink-btn';
    button.textContent = 'Link another project folder';
    button.hidden = true;
    button.addEventListener('click', () => {
        void openFolderPermissionsDialog();
    });
    tabs.appendChild(button);
    return button;
}

function updateDiskRelinkButton(): void {
    const button = ensureDiskRelinkButton();
    if (!button) {
        return;
    }
    const diskActive =
        fileSystemCache.currentPlugin?.getId() === 'disk' &&
        isFileSystemAccessSupported();
    button.hidden = !(diskActive && isDiskProjectFolderLinked());
}

/**
 * Refresh Disk UI after the Fonts folder handle is already selected.
 * Does not open a picker — call this after DiskPlugin.showSetupUI succeeds.
 */
export async function applyFontsFolderSelection(options?: {
    source?: 'attach' | 'settings';
}): Promise<void> {
    const plugin = pluginRegistry.get('disk');
    if (!(plugin instanceof DiskPlugin)) {
        return;
    }

    let targetPath = '/';
    const currentFont = window.fontManager?.currentFont;
    const currentFontHandle = currentFont?.fileHandle;

    if (
        currentFont &&
        currentFont.sourcePlugin.getId() === 'disk' &&
        currentFontHandle
    ) {
        const resolvedPath =
            await resolveDiskPathForLaunchedFileHandle(currentFontHandle);

        if (resolvedPath) {
            currentFont.path = resolvedPath;
            const adapter = plugin.getAdapter() as {
                directoryHandle?: FileSystemDirectoryHandle;
                getDirectoryHandle?: () => FileSystemDirectoryHandle | null;
            };
            currentFont.directoryHandle =
                adapter.getDirectoryHandle?.() ??
                adapter.directoryHandle ??
                null;

            targetPath =
                resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';

            const fileUri = createFileUri('disk', resolvedPath);
            if (window.stateManager) {
                window.stateManager.editor_file = fileUri;
                window.stateManager.recordEvent('file_opened', 'FileBrowser', {
                    fileUri
                });
            }
        }
    }

    detachedLaunchFilename = null;
    detachedLaunchFileHandle = null;
    updateOpenFolderPromptForDetachedLaunch();
    hideOpenFolderUI();

    window.dispatchEvent(
        new CustomEvent('fontsFolderAccessChanged', {
            detail: {
                hasFontsFolderAccess: true,
                source: options?.source || 'attach'
            }
        })
    );

    if (fileSystemCache.currentPlugin.getId() === 'disk') {
        fileSystemCache.currentPath = targetPath;
        await navigateToPath(targetPath);

        setTimeout(() => {
            const fileTree = document.getElementById('file-tree');
            const currentFontItem = fileTree?.querySelector(
                '.file-item.current-font'
            );
            if (currentFontItem) {
                (currentFontItem as HTMLElement).scrollIntoView({
                    block: 'center',
                    behavior: 'auto'
                });
            }
        }, 100);
    }
}

/**
 * Change the selected Fonts folder (Disk plugin root) while preserving the
 * current Disk-context refresh, observer setup, and dependent-view notifications.
 * This does not affect the Settings Folder used for Plugins/Filters/Scripts.
 */
export async function changeFontsFolder(options?: {
    startIn?: FileSystemHandle;
    source?: 'attach' | 'settings';
}): Promise<boolean> {
    try {
        const plugin = pluginRegistry.get('disk');
        if (!(plugin instanceof DiskPlugin)) {
            console.error('[FileBrowser]', 'DiskPlugin is not available');
            return false;
        }

        const success = await plugin.showSetupUI({ startIn: options?.startIn });
        if (success) {
            await applyFontsFolderSelection(options);
        }
        return success;
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error selecting Fonts folder:', error);
        alert(`Error selecting folder: ${getErrorMessage(error)}`);
        return false;
    }
}

/** @deprecated Use changeFontsFolder */
export const changeDiskRootFolder = changeFontsFolder;

/** Open the Fonts folder picker from the File Browser. */
async function selectDiskFolder(): Promise<void> {
    await changeFontsFolder({
        startIn: detachedLaunchFileHandle || undefined,
        source: 'attach'
    });
}

function showFileTree() {
    const fileTree = document.getElementById('file-tree');
    if (fileTree) {
        fileTree.style.display = 'block';
        console.log('[FileBrowser]', 'File tree shown');
    }
}

function hideFileTree() {
    const fileTree = document.getElementById('file-tree');
    if (fileTree) {
        fileTree.style.display = 'none';
        console.log('[FileBrowser]', 'File tree hidden');
    }
}

function showPluginMessage(options: PluginMessageOptions) {
    const container = document.getElementById('plugin-message-container');
    if (!container) {
        return;
    }

    const toneClass =
        options.tone && options.tone !== 'info' ? ` ${options.tone}` : '';
    const spinningClass = options.spinning ? ' spinning' : '';

    container.innerHTML = `
        <div class="plugin-message-content">
            <span class="material-symbols-outlined plugin-message-icon${toneClass}${spinningClass}">${options.icon}</span>
            <h3>${options.title}</h3>
            <p>${options.message}</p>
            ${options.detail ? `<p class="browser-suggestion">${options.detail}</p>` : ''}
            ${options.actionLabel ? `<button class="open-folder-button plugin-message-button" type="button">${options.actionLabel}</button>` : ''}
        </div>
    `;
    container.classList.add('visible');

    if (options.actionLabel && options.onAction) {
        const actionButton = container.querySelector(
            '.plugin-message-button'
        ) as HTMLButtonElement | null;
        actionButton?.addEventListener('click', () => {
            options.onAction?.();
        });
    }

    hideFileTree();
}

function hidePluginMessage() {
    const container = document.getElementById('plugin-message-container');
    if (!container) {
        return;
    }

    container.innerHTML = '';
    container.classList.remove('visible');

    const openFolderVisible = document
        .getElementById('open-folder-container')
        ?.classList.contains('visible');
    const cloudPanelVisible = document
        .getElementById('cloud-panel')
        ?.classList.contains('visible');

    if (!openFolderVisible && !cloudPanelVisible) {
        showFileTree();
    }
}

function showUnsupportedBrowserUI() {
    showPluginMessage({
        icon: 'info',
        title: 'Browser Not Supported',
        message:
            "Your browser doesn't support native file system access for the Disk context.",
        detail: 'Please use Chrome/Chromium 86+, Edge 86+, or Safari 15.2+ for full functionality. You can use the Memory context for browser storage.',
        tone: 'warning'
    });
}

function hideUnsupportedBrowserUI() {
    hidePluginMessage();
}

async function reEnableAccess() {
    try {
        const plugin = fileSystemCache.currentPlugin;
        if (!(plugin instanceof DiskPlugin)) {
            console.error('[FileBrowser]', 'Current plugin is not DiskPlugin');
            return;
        }

        const permission = await plugin.requestPermission();
        if (permission) {
            showPermissionBanner(false);
            await refreshFileSystem();
            window.dispatchEvent(
                new CustomEvent('fontsFolderAccessChanged', {
                    detail: {
                        hasFontsFolderAccess: true,
                        source: 'renew'
                    }
                })
            );
        } else {
            alert('Permission not granted. Please try again.');
        }
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error requesting permission:', error);
        alert(`Error requesting permission: ${getErrorMessage(error)}`);
    }
}

function showPermissionBanner(show: boolean) {
    const banner = document.getElementById('permission-banner');
    if (banner) {
        banner.style.display = show ? 'flex' : 'none';
    }
}

function showOpenFolderUI() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );

    renderOpenFolderWidget();

    if (openFolderContainer) {
        openFolderContainer.classList.add('visible');
    }
    hideFileTree();
    syncFilePathHeaderVisibility();
    updateDiskRelinkButton();
}

function hideOpenFolderUI() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );

    if (openFolderContainer) {
        openFolderContainer.classList.remove('visible');
    }
    showFileTree();
    syncFilePathHeaderVisibility();
    updateDiskRelinkButton();
}

async function scanDirectory(
    path: string = '/'
): Promise<Record<string, FileInfo>> {
    return await fileSystemCache.activeAdapter.scanDirectory(path);
}

async function createFolder() {
    const currentPath = fileSystemCache.currentPath || '/';
    const folderName = prompt('Enter folder name:');

    if (!folderName) return;

    // Validate folder name
    if (folderName.includes('/') || folderName.includes('\\')) {
        alert('Folder name cannot contain / or \\');
        return;
    }

    try {
        const newPath = `${currentPath}/${folderName}`;
        await fileSystemCache.activeAdapter.createFolder(newPath);
        console.log('[FileBrowser]', `Created folder: ${newPath}`);
        await refreshFileSystem();
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error creating folder:', error);
        alert(`Error creating folder: ${getErrorMessage(error)}`);
    }
}

async function createFile() {
    const currentPath = fileSystemCache.currentPath || '/';
    const fileName = prompt('Enter file name:');

    if (!fileName) return;

    // Validate file name
    if (fileName.includes('/') || fileName.includes('\\')) {
        alert('File name cannot contain / or \\');
        return;
    }

    try {
        const newPath = `${currentPath}/${fileName}`;
        // Create empty file
        await fileSystemCache.activeAdapter.writeFile(
            newPath,
            new Uint8Array(0)
        );
        console.log('[FileBrowser]', `Created file: ${newPath}`);
        await refreshFileSystem();
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error creating file:', error);
        alert(`Error creating file: ${getErrorMessage(error)}`);
    }
}

async function downloadFile(filePath: string, fileName: string) {
    try {
        // Get the file content
        const fileContent =
            await fileSystemCache.activeAdapter.readFile(filePath);

        // Ensure we have Uint8Array for blob creation
        let fileData: Uint8Array<ArrayBuffer>;
        if (typeof fileContent === 'string') {
            fileData = Uint8Array.from(new TextEncoder().encode(fileContent));
        } else {
            const byteSource =
                fileContent instanceof Uint8Array
                    ? fileContent
                    : new Uint8Array(fileContent as ArrayBuffer);
            fileData = Uint8Array.from(byteSource);
        }

        // Create blob and download
        const fileBlob = new Blob([fileData], {
            type: 'application/octet-stream'
        });
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        console.log('[FileBrowser]', `Downloaded: ${fileName}`);

        if (window.term) {
            window.term.echo(`[[;lime;]📥 Downloaded: ${fileName}]`);
        }
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error downloading file:', error);
        alert(`Error downloading file: ${getErrorMessage(error)}`);
    }
}

async function deleteItem(itemPath: string, itemName: string, isDir: boolean) {
    const target: FileContextTarget = {
        path: itemPath,
        name: itemName,
        isDir
    };
    if (
        !fileSystemCache.currentPlugin.supportsFileContextAction(
            'delete',
            target
        )
    ) {
        return;
    }

    const confirmMsg = isDir
        ? `Delete folder "${itemName}" and all its contents?`
        : `Delete file "${itemName}"?`;

    if (!confirm(confirmMsg)) return;

    try {
        await withFileDialogBusy(
            {
                message: isDir
                    ? `Deleting folder ${itemName}...`
                    : `Deleting file ${itemName}...`,
                actionLabel: 'Deleting...',
                useLoadingCursor: true
            },
            async () => {
                await fileSystemCache.activeAdapter.deleteItem(itemPath, isDir);
                if (
                    fileSystemCache.currentPlugin.getId() === 'cloud' &&
                    !isDir
                ) {
                    const assetId = itemPath.replace(/^cloud:\/\//, '').trim();
                    if (assetId) {
                        window.cloudPlugin?.handleDeletedAsset?.(
                            assetId,
                            undefined,
                            {
                                suppressAlert: true
                            }
                        );
                    }
                }
                console.log('[FileBrowser]', `Deleted: ${itemPath}`);
                await refreshFileSystem();
            }
        );
    } catch (error: unknown) {
        console.error('[FileBrowser]', 'Error deleting item:', error);
        alert(`Error deleting item: ${getErrorMessage(error)}`);
    }
}

async function renameItem(itemPath: string, itemName: string, isDir: boolean) {
    const target: FileContextTarget = {
        path: itemPath,
        name: itemName,
        isDir
    };
    if (
        !fileSystemCache.currentPlugin.supportsFileContextAction(
            'rename',
            target
        )
    ) {
        return;
    }

    // Find the file item element
    const fileItem = document.querySelector(
        `.file-item[data-path="${itemPath}"]`
    ) as HTMLElement;
    if (!fileItem) {
        console.error('[FileBrowser]', 'File item not found for rename');
        return;
    }

    // Find the name element
    const nameElement = fileItem.querySelector('.file-name') as HTMLElement;
    if (!nameElement) {
        console.error('[FileBrowser]', 'File name element not found');
        return;
    }

    // Store original name for cancel
    const originalName = itemName;

    // Create inline input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-rename-input';
    input.value = itemName;

    // For files with extension, select only the name part
    const lastDotIndex = itemName.lastIndexOf('.');
    const hasExtension = !isDir && lastDotIndex > 0;

    // Replace name element with input
    nameElement.style.display = 'none';
    nameElement.parentNode!.insertBefore(input, nameElement.nextSibling);
    input.focus();

    // Select filename without extension
    if (hasExtension) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    // Prevent click from propagating to parent
    input.addEventListener('click', (e) => e.stopPropagation());

    // Handle rename completion
    const completeRename = async () => {
        const newName = input.value.trim();

        // Remove input, restore name element
        input.remove();
        nameElement.style.display = '';

        if (!newName || newName === originalName) {
            return;
        }

        // Validate new name
        if (newName.includes('/') || newName.includes('\\')) {
            alert('Name cannot contain / or \\ characters');
            return;
        }

        try {
            await fileSystemCache.activeAdapter.renameItem(
                itemPath,
                newName,
                isDir
            );
            console.log('[FileBrowser]', `Renamed: ${itemPath} -> ${newName}`);

            // If this file is open in the script editor, update the path there
            if (!isDir && window.scriptEditor) {
                const pluginId = fileSystemCache.currentPlugin.getId();
                if (
                    window.scriptEditor.currentFilePath === itemPath &&
                    window.scriptEditor.currentPluginId === pluginId
                ) {
                    // Compute new path
                    const parentPath = itemPath.substring(
                        0,
                        itemPath.lastIndexOf('/')
                    );
                    const newPath = parentPath + '/' + newName;
                    window.scriptEditor.updateFilePath(newPath);
                    console.log(
                        '[FileBrowser]',
                        'Updated script editor file path to:',
                        newPath
                    );
                }
            }

            await refreshFileSystem();
        } catch (error: unknown) {
            console.error('[FileBrowser]', 'Error renaming item:', error);
            alert(`Error renaming item: ${getErrorMessage(error)}`);
        }
    };

    // Handle cancel
    const cancelRename = () => {
        input.remove();
        nameElement.style.display = '';
    };

    // Enter to confirm, Escape to cancel
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            completeRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    });

    // Blur to confirm (like most file browsers)
    input.addEventListener('blur', () => {
        // Small delay to allow for click on other elements
        setTimeout(() => {
            if (document.body.contains(input)) {
                completeRename();
            }
        }, 100);
    });
}

async function uploadFiles(
    files: File[] | FileList,
    directoryOrOptions:
        | string
        | null
        | {
              directory?: string | null;
              pluginId?: string;
              skipRefresh?: boolean;
          } = null
) {
    const startTime = performance.now();
    const options =
        typeof directoryOrOptions === 'string' || directoryOrOptions === null
            ? { directory: directoryOrOptions, pluginId: undefined }
            : directoryOrOptions;

    const targetPlugin = options.pluginId
        ? pluginRegistry.get(options.pluginId)
        : null;

    if (options.pluginId && !targetPlugin) {
        throw new Error(`Upload target plugin '${options.pluginId}' not found`);
    }

    const targetAdapter = targetPlugin
        ? targetPlugin.getAdapter()
        : fileSystemCache.activeAdapter;

    const basePath =
        options.directory ||
        (targetPlugin
            ? targetPlugin.getDefaultPath() || '/'
            : fileSystemCache.currentPath || '/');

    const normalizedBasePath =
        basePath === '/'
            ? '/'
            : (basePath as string).replace(/\/+$/, '') || '/';

    let uploadedCount = 0;

    for (const file of files) {
        try {
            // Handle files with relative paths (from folder upload)
            // file.webkitRelativePath contains the full path including folder structure
            const relativePath = file.webkitRelativePath || file.name;
            const normalizedRelativePath = relativePath.replace(/^\/+/, '');
            const fullpath =
                normalizedBasePath === '/'
                    ? `/${normalizedRelativePath}`
                    : `${normalizedBasePath}/${normalizedRelativePath}`;

            // Write file using adapter
            const contents = await file.arrayBuffer();
            await targetAdapter.writeFile(fullpath, new Uint8Array(contents));
            console.log('[FileBrowser]', `Uploading file: ${fullpath}`);
            uploadedCount++;
        } catch (error: unknown) {
            console.error(
                '[FileBrowser]',
                `Error uploading ${file.name}:`,
                error
            );
        }
    }

    if (uploadedCount > 0) {
        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        const uploadedToCurrentPlugin =
            !targetPlugin ||
            targetPlugin.getId() === fileSystemCache.currentPlugin.getId();

        const msg = `Uploaded ${uploadedCount} file(s) in ${duration} seconds`;

        console.log('[FileBrowser]', msg);

        if (uploadedToCurrentPlugin && !options.skipRefresh) {
            await refreshFileSystem();
        }
    }
}

function getCloudRoleBadgeMarkup(role: FileInfo['cloudRole']): string {
    if (role === 'editor') {
        return `<span class="file-cloud-role-badge role-editor" title="Editor access"><span class="material-symbols-outlined">edit</span></span>`;
    }
    if (role === 'viewer') {
        return `<span class="file-cloud-role-badge role-viewer" title="Viewer access"><span class="material-symbols-outlined">visibility</span></span>`;
    }
    return '';
}

function getCloudConnectedPeersMarkup(
    role: FileInfo['cloudRole'],
    connectedPeers: FileInfo['cloudConnectedPeers']
): string {
    if (role !== 'owner' || typeof connectedPeers !== 'number') {
        return '';
    }

    const label =
        connectedPeers === 1 ? '1 connected' : `${connectedPeers} connected`;
    return `<span class="file-cloud-presence-badge" title="${label}"><span class="material-symbols-outlined">group</span><span class="file-cloud-presence-count">${connectedPeers}</span></span>`;
}

async function buildFileTree(rootPath = '/') {
    const items = await scanDirectory(rootPath);
    let html = '';

    // Hidden file inputs for upload functionality
    html += `<input type="file" id="file-upload-input" multiple style="display: none;" 
           onchange="handleFileUpload(event)">
    <input type="file" id="folder-upload-input" webkitdirectory directory multiple style="display: none;" 
           onchange="handleFileUpload(event)">`;

    // Filter out hidden files, then sort: directories first, then files
    const sortedItems = Object.entries(items)
        .filter(([name]) => !HIDDEN_FILES.includes(name))
        .sort(([a, aData], [b, bData]) => {
            const aIsFontPackageDirectory = isFontPackageDirectory(
                a,
                aData.is_dir
            );
            const bIsFontPackageDirectory = isFontPackageDirectory(
                b,
                bData.is_dir
            );
            const aIsDirectory = aData.is_dir && !aIsFontPackageDirectory;
            const bIsDirectory = bData.is_dir && !bIsFontPackageDirectory;

            if (aIsDirectory && !bIsDirectory) return -1;
            if (!aIsDirectory && bIsDirectory) return 1;
            return a.localeCompare(b);
        });

    // Get current font path for highlighting
    const currentFontPath = window.fontManager?.currentFont?.path || null;

    for (const [name, data] of sortedItems) {
        const isPackageDirectory = isFontPackageDirectory(name, data.is_dir);
        const displayIsDir = data.is_dir && !isPackageDirectory;

        const icon = getFileIcon(name, displayIsDir);
        const fileClass = getFileClass(name, displayIsDir);
        const sizeText = displayIsDir
            ? ''
            : `<span class="file-size">${formatFileSize(data.size)}</span>`;

        // Check if this is a supported font file
        const isFontFile = isSupportedFontFormat(name, data.is_dir);
        const fontSourceClass = isFontFile ? 'font-source' : '';

        // Add 'current-font' class if this is the opened font
        const isCurrentFont =
            isFontFile &&
            (currentFontPath === data.path ||
                // Cloud: currentFont.path may be bare assetId while data.path
                // uses the cloud:// prefix, or vice-versa.
                'cloud://' + currentFontPath === data.path ||
                currentFontPath === 'cloud://' + data.path);
        const currentFontClass = isCurrentFont ? 'current-font' : '';

        // Add 'in-font-path' class if this is a directory in the path to the current font
        const isInFontPath =
            displayIsDir &&
            currentFontPath &&
            currentFontPath.startsWith(data.path + '/');
        const fontPathClass = isInFontPath ? 'in-font-path' : '';
        const cloudRoleBadge = getCloudRoleBadgeMarkup(data.cloudRole);
        const cloudConnectedPeers = getCloudConnectedPeersMarkup(
            data.cloudRole,
            data.cloudConnectedPeers
        );

        html += `<div class="file-item ${fileClass} ${fontSourceClass} ${currentFontClass} ${fontPathClass}" data-path="${data.path}" data-name="${name}" data-is-dir="${data.is_dir}" data-is-font="${isFontFile}">
            <span class="file-name"><span class="file-name-text">${icon} ${name}</span>${cloudConnectedPeers}${cloudRoleBadge}</span>${sizeText}
        </div>`;
    }

    return html;
}

function handleFileUpload(event: Event) {
    const files: FileList = (event.target as HTMLInputElement).files!;
    if (files.length > 0) {
        uploadFiles(files);
    }
    // Reset input so same file can be uploaded again
    (event.target as HTMLInputElement).value = '';
}

async function navigateToParent() {
    const currentPath = fileSystemCache.currentPath || '/';
    const parentPath =
        currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    const previousFolderName = currentPath.substring(
        currentPath.lastIndexOf('/') + 1
    );
    await navigateToPath(parentPath, previousFolderName);
}

function renderFilePathHeader(path: string): HTMLElement | null {
    let pathHeader = document.getElementById('file-path-header');
    if (!pathHeader) {
        pathHeader = document.createElement('div');
        pathHeader.id = 'file-path-header';
        const fileBrowser = document.getElementById('file-browser');
        fileBrowser!.insertBefore(pathHeader, fileBrowser!.firstChild);
    }

    const parentBtn =
        path !== '/'
            ? `<button onclick="navigateToParent()" class="file-header-btn" title="Go to parent directory">
                <span class="material-symbols-outlined">arrow_upward</span>
                <span class="file-header-btn-label">Parent</span>
            </button>`
            : '';

    const currentPlugin = fileSystemCache.currentPlugin;
    const headerActions = getFileDialogHeaderActions(
        currentPlugin.getId(),
        currentPlugin.supportsNewFolder(),
        currentPlugin.showsManualRefreshButton()
    );
    const uploadButtons = headerActions.showsUploadButtons
        ? `
            <button onclick="document.getElementById('file-upload-input').click()" class="file-header-btn" title="Upload files">
                <span class="material-symbols-outlined">upload_file</span>
                <span class="file-header-btn-label">Upload Files</span>
            </button>
            <button onclick="document.getElementById('folder-upload-input').click()" class="file-header-btn" title="Upload folder">
                <span class="material-symbols-outlined">drive_folder_upload</span>
                <span class="file-header-btn-label">Upload Folder</span>
            </button>
        `
        : '';

    const newFolderBtn = headerActions.showsNewFolderButton
        ? `<button onclick="createFolder()" class="file-header-btn" title="Create new folder">
                <span class="material-symbols-outlined">create_new_folder</span>
                <span class="file-header-btn-label">New Folder</span>
            </button>`
        : '';

    const refreshBtn = headerActions.showsRefreshButton
        ? `<button onclick="refreshFileSystem()" class="file-header-btn" title="Refresh">
                <span class="material-symbols-outlined">refresh</span>
                <span class="file-header-btn-label">Refresh</span>
            </button>`
        : '';

    pathHeader.innerHTML = `
        <div class="file-path-meta">
            <span class="file-path-text" title="${path}" data-full-path="${path}">${path}</span>
            <span class="file-last-refreshed" id="file-last-refreshed"></span>
        </div>
        <div class="file-header-actions">
            ${parentBtn}
            ${newFolderBtn}
            ${uploadButtons}
            ${refreshBtn}
        </div>
    `;

    schedulePathDisplayUpdate(path);
    updateLastRefreshedStatus();
    syncFilePathHeaderVisibility();

    const pathTextElement = pathHeader.querySelector(
        '.file-path-text'
    ) as HTMLElement | null;
    const pathMetaElement = pathHeader.querySelector(
        '.file-path-meta'
    ) as HTMLElement | null;
    if (
        pathTextElement &&
        pathMetaElement &&
        !(pathMetaElement as any)._resizeObserver
    ) {
        const resizeObserver = new ResizeObserver(() => {
            const fullPath =
                pathTextElement.getAttribute('data-full-path') || path;
            schedulePathDisplayUpdate(fullPath);
        });
        resizeObserver.observe(pathHeader);
        resizeObserver.observe(pathMetaElement);
        (pathMetaElement as any)._resizeObserver = resizeObserver;
    }

    return pathHeader;
}

async function navigateToPath(path: string, highlightFolder?: string) {
    try {
        const fileTree = document.getElementById('file-tree');

        // Build content first (off-screen)
        const html = await buildFileTree(path);

        renderFilePathHeader(path);

        // Update file tree content in a single frame to prevent flickering
        requestAnimationFrame(() => {
            fileTree!.innerHTML = html;

            // Reset scroll to top immediately when no font is open (before any other scroll logic)
            const currentFont = window.fontManager?.currentFont;
            if (!currentFont && !highlightFolder) {
                fileTree!.scrollTop = 0;
            }

            // Setup context menus for file items (defer to next frame to ensure DOM is ready)
            requestAnimationFrame(() => {
                setupFileContextMenus();
                setupFileItemClickHandlers();
                updateFileSelectionUi();
                updateFileDialogFooter();

                // Highlight and scroll to specific folder if provided
                if (highlightFolder) {
                    const folderItem = Array.from(
                        fileTree!.querySelectorAll('.file-item')
                    ).find(
                        (item) =>
                            item.getAttribute('data-name') ===
                                highlightFolder &&
                            item.getAttribute('data-is-dir') === 'true'
                    ) as HTMLElement;

                    if (folderItem) {
                        folderItem.scrollIntoView({
                            block: 'center',
                            behavior: 'auto'
                        });
                        folderItem.classList.add('folder-highlight');
                        setTimeout(() => {
                            folderItem.classList.remove('folder-highlight');
                        }, 600);
                    }
                } else if (pendingDialogHighlightPath) {
                    const highlightedItem = getVisibleFileItem(
                        pendingDialogHighlightPath
                    );
                    if (highlightedItem) {
                        highlightedItem.scrollIntoView({
                            block: 'center',
                            behavior: 'auto'
                        });
                        highlightedItem.classList.add('folder-highlight');
                        selectedDialogPath = pendingDialogHighlightPath;
                        updateFileSelectionUi();
                        updateFileDialogFooter();
                        setTimeout(() => {
                            highlightedItem.classList.remove(
                                'folder-highlight'
                            );
                        }, 600);
                    }
                    pendingDialogHighlightPath = null;
                } else if (currentFont) {
                    // Only scroll to in-path folder if there's a current font open
                    const inPathItem = fileTree!.querySelector(
                        '.file-item.in-font-path'
                    );
                    if (inPathItem) {
                        inPathItem.scrollIntoView({
                            block: 'center',
                            behavior: 'auto'
                        });
                    }
                }
            });
        });

        // Cache the current path
        fileSystemCache.currentPath = path;
        lastFileTreeRefreshAt = Date.now();
        updateLastRefreshedStatus();

        // Save path to localStorage for current plugin
        try {
            const pluginId = fileSystemCache.currentPlugin.getId();
            localStorage.setItem(getPathStorageKey(pluginId), path);
        } catch (e) {
            console.warn(
                '[FileBrowser]',
                'Failed to save path to localStorage:',
                e
            );
        }

        // Setup drag & drop on the file tree (only if plugin supports upload)
        if (fileSystemCache.currentPlugin.supportsUpload()) {
            setupDragAndDrop();
        } else {
            teardownDragAndDrop();
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error navigating to path:', error);
        showPluginMessage({
            icon: 'folder_off',
            title: 'Could Not Load Files',
            message: `Failed to load files from ${fileSystemCache.currentPlugin.getName()}.`,
            detail: getErrorMessage(error),
            tone: 'warning',
            actionLabel: 'Retry',
            onAction: () => {
                void refreshFileSystem();
            }
        });
    }
}

let dragCounter = 0;
let dragHandlers: {
    dragenter: (e: DragEvent) => void;
    dragover: (e: DragEvent) => void;
    dragleave: (e: DragEvent) => void;
    drop: (e: DragEvent) => void;
} | null = null;

function setupDragAndDrop() {
    const fileBrowser = document.getElementById('file-browser')!;

    // Remove existing handlers if any
    teardownDragAndDrop();

    dragCounter = 0;

    const handlers = {
        dragenter: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            fileBrowser.classList.add('drag-over');
        },
        dragover: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
        },
        dragleave: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter === 0) {
                fileBrowser.classList.remove('drag-over');
            }
        },
        drop: async (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            fileBrowser.classList.remove('drag-over');

            const files = Array.from(e.dataTransfer!.files);
            if (files.length > 0) {
                await uploadFiles(files);
            }
        }
    };

    fileBrowser.addEventListener('dragenter', handlers.dragenter);
    fileBrowser.addEventListener('dragover', handlers.dragover);
    fileBrowser.addEventListener('dragleave', handlers.dragleave);
    fileBrowser.addEventListener('drop', handlers.drop);

    dragHandlers = handlers;
}

function teardownDragAndDrop() {
    const fileBrowser = document.getElementById('file-browser');
    if (!fileBrowser || !dragHandlers) return;

    fileBrowser.removeEventListener('dragenter', dragHandlers.dragenter);
    fileBrowser.removeEventListener('dragover', dragHandlers.dragover);
    fileBrowser.removeEventListener('dragleave', dragHandlers.dragleave);
    fileBrowser.removeEventListener('drop', dragHandlers.drop);

    fileBrowser.classList.remove('drag-over');
    dragCounter = 0;
    dragHandlers = null;
}

function selectFile(filePath: string) {
    selectedDialogPath = filePath;
    updateFileSelectionUi();
    updateFileDialogFooter();
    console.log('[FileBrowser]', 'Selected file:', filePath);
}

function setupFileItemClickHandlers() {
    const fileTree = document.getElementById('file-tree');
    if (!fileTree) return;

    const fileItems = fileTree.querySelectorAll('.file-item');
    fileItems.forEach((item: Element) => {
        const element = item as HTMLElement;
        if (element.dataset.clickHandlersBound === 'true') {
            return;
        }

        element.dataset.clickHandlersBound = 'true';
        const path = element.dataset.path!;
        const isDir = element.dataset.isDir === 'true';
        const isFont = element.dataset.isFont === 'true';

        element.addEventListener('click', (e: Event) => {
            e.preventDefault();
            e.stopPropagation();

            if (isDir && !isFont) {
                void navigateToPath(path);
            } else {
                selectFile(path);
            }
        });

        element.addEventListener('dblclick', (e: Event) => {
            e.preventDefault();
            e.stopPropagation();

            if (
                !shouldOpenFileOnDialogDoubleClick(activeFileDialogMode, isFont)
            ) {
                return;
            }

            if (isFont) {
                console.log(
                    '[FileBrowser]',
                    'Double-click opening font:',
                    path
                );
                selectFile(path);
                void openFont(path, undefined, {
                    closeDialogOnSuccess: true
                });
            } else if (isDir) {
                void navigateToPath(path);
            }
        });
    });
}

async function refreshFileSystem() {
    const currentPath = fileSystemCache.currentPath || '/';
    console.log('[FileBrowser]', 'Refreshing file system...');

    // Preserve current plugin and adapter references
    const currentPlugin = fileSystemCache.currentPlugin;
    const activeAdapter = fileSystemCache.activeAdapter;

    fileSystemCache = {
        currentPath,
        currentPlugin,
        activeAdapter
    };

    // Reload current directory
    await navigateToPath(currentPath);

    console.log('[FileBrowser]', 'File system refreshed');
}

async function navigateToCurrentFont() {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        console.warn('[FileBrowser]', 'No font currently open');
        return;
    }

    const fontPath = currentFont.path;
    const fontPlugin = currentFont.sourcePlugin;

    // Switch to the plugin if needed
    if (fileSystemCache.currentPlugin.getId() !== fontPlugin.getId()) {
        await switchContext(fontPlugin.getId());
    }

    // Navigate to the directory containing the font
    const dirPath = fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
    await navigateToPath(dirPath);

    // Scroll the current font into view with smooth scrolling
    setTimeout(() => {
        const fileTree = document.getElementById('file-tree');
        const currentFontItem = fileTree?.querySelector(
            '.file-item.current-font'
        );
        if (currentFontItem) {
            (currentFontItem as HTMLElement).scrollIntoView({
                block: 'center',
                behavior: 'smooth'
            });
        }
    }, 100); // Small delay to ensure DOM is updated
}

function updateHomeButtonVisibility() {
    return;
}

function consumePendingLaunchFileHandles(): FileSystemFileHandle[] {
    const pending = (window as any).__pendingLaunchFileHandles;
    if (!Array.isArray(pending) || pending.length === 0) {
        return [];
    }

    (window as any).__pendingLaunchFileHandles = [];
    return pending.filter((handle) => handle?.kind === 'file');
}

async function resolveDiskPathForLaunchedFileHandle(
    fileHandle: FileSystemFileHandle
): Promise<string | null> {
    const diskPlugin = pluginRegistry.get('disk') as DiskPlugin | undefined;
    if (!diskPlugin) {
        return null;
    }

    const isReady = await diskPlugin.isReady();
    if (!isReady) {
        return null;
    }

    const adapter = diskPlugin.getAdapter() as {
        listFilesRecursive?: (path: string, depth: number) => Promise<any[]>;
        checkPermission?: () => Promise<'granted' | 'denied' | 'prompt'>;
    };
    if (!adapter.listFilesRecursive || !adapter.checkPermission) {
        return null;
    }

    const permission = await adapter.checkPermission();
    if (permission !== 'granted') {
        return null;
    }

    const files = await adapter.listFilesRecursive('/', 20);
    for (const file of files) {
        const candidateHandle = file.handle;
        if (
            !candidateHandle ||
            typeof candidateHandle.isSameEntry !== 'function'
        ) {
            continue;
        }

        try {
            const isSame = await candidateHandle.isSameEntry(fileHandle);
            if (isSame) {
                return file.path;
            }
        } catch (error) {
            console.warn('[FileBrowser]', 'Failed handle comparison:', error);
        }
    }

    return null;
}

function createDetachedLaunchPath(fileHandle: FileSystemFileHandle): string {
    const sanitizedName = fileHandle.name.replace(/[\\/]/g, '_');
    return `/__launched__/${sanitizedName}`;
}

async function openLaunchedFileHandle(
    fileHandle: FileSystemFileHandle
): Promise<void> {
    const diskPlugin = pluginRegistry.get('disk') as DiskPlugin | undefined;
    if (!diskPlugin) {
        throw new Error('Disk plugin is not available');
    }

    const resolvedPath = await resolveDiskPathForLaunchedFileHandle(fileHandle);
    if (resolvedPath) {
        detachedLaunchFilename = null;
        detachedLaunchFileHandle = null;
        await switchContext('disk');
        const dirPath =
            resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';
        await navigateToPath(dirPath);
        await openFont(resolvedPath, fileHandle, {
            sourcePluginOverride: diskPlugin
        });
        return;
    }

    detachedLaunchFilename = fileHandle.name;
    detachedLaunchFileHandle = fileHandle;
    await switchContext('disk');
    await openFont(createDetachedLaunchPath(fileHandle), fileHandle, {
        sourcePluginOverride: diskPlugin
    });
}

async function processPendingPwaLaunchFiles() {
    const launchHandles = consumePendingLaunchFileHandles();
    if (!launchHandles.length) {
        return;
    }

    for (const fileHandle of launchHandles) {
        try {
            await openLaunchedFileHandle(fileHandle);
            updateHomeButtonVisibility();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            alert(`Error opening launched file ${fileHandle.name}: ${message}`);
            console.error(
                '[FileBrowser]',
                `Failed opening launched file ${fileHandle.name}:`,
                error
            );
        }
    }
}

function initFileDialogModal(): void {
    const dialog = getDialogRoot();
    const closeBtn = document.getElementById('font-file-dialog-close-btn');
    const cancelBtn = document.getElementById('file-dialog-cancel-btn');
    const confirmBtn = document.getElementById('file-dialog-confirm-btn');
    const saveNameInput = document.getElementById(
        'file-dialog-save-name'
    ) as HTMLInputElement | null;

    if (!dialog || !closeBtn || !cancelBtn || !confirmBtn) {
        return;
    }

    closeBtn.addEventListener('click', closeFontFileDialog);
    cancelBtn.addEventListener('click', closeFontFileDialog);
    confirmBtn.addEventListener('click', () => {
        void confirmFileDialogPrimaryAction();
    });

    dialog.addEventListener('click', (event: Event) => {
        if (event.target === dialog) {
            closeFontFileDialog();
        }
    });

    dialog.addEventListener(
        'contextmenu',
        (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        },
        true
    );

    saveNameInput?.addEventListener('input', () => {
        updateFileDialogFooter();
    });

    saveNameInput?.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void confirmFileDialogPrimaryAction();
        }
    });
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
    if (fileBrowserReady) {
        return;
    }

    try {
        console.log('[FileBrowser]', 'Initializing file browser...');

        // Check if OPFS is supported
        if (!navigator.storage?.getDirectory) {
            console.error(
                '[FileBrowser]',
                'OPFS not supported in this browser'
            );
            alert(
                'File system not supported in this browser. Please use a modern browser like Chrome or Edge.'
            );
            return;
        }

        // Check if File System Access API is supported for disk context
        const diskApiSupported = isFileSystemAccessSupported();
        if (!diskApiSupported) {
            console.warn(
                '[FileBrowser]',
                'File System Access API not supported - disk context will show info message'
            );
        }

        // Initialize disk plugin (restore directory handle)
        const diskPlugin = pluginRegistry.get('disk') as DiskPlugin;
        if (diskPlugin) {
            // Mark disk plugin as unsupported if needed
            if (!diskApiSupported) {
                (diskPlugin as any)._unsupported = true;
            }

            const adapter = diskPlugin.getAdapter() as any;
            if (adapter.initialize) {
                await adapter.initialize();
            }
        }

        // Create /user folder in memory context if it doesn't exist
        await ensureMemoryFilesystemReady();

        initFileDialogModal();

        // Generate context tabs dynamically from plugin registry
        const titleBarRight = document.getElementById(
            'file-dialog-plugin-tabs'
        );
        if (titleBarRight) {
            // Clear existing content
            titleBarRight.innerHTML = '';

            const plugins = getUIVisiblePlugins();
            plugins.forEach((plugin) => {
                const button = document.createElement('button');
                button.className = 'file-dialog-plugin-tab context-tab';
                button.setAttribute('data-plugin-id', plugin.getId());
                button.innerHTML = `
                    <span class="file-dialog-plugin-tab-icon">${plugin.getIcon()}</span>
                    <span class="file-dialog-plugin-tab-copy">
                        <span class="file-dialog-plugin-tab-title">${plugin.getName()}</span>
                        <span class="file-dialog-plugin-tab-description">${getPluginTabDescription(plugin)}</span>
                    </span>
                `;

                // Mark default plugin as active
                if (plugin.getId() === pluginRegistry.getDefaultId()) {
                    button.classList.add('active');
                }

                // Add dropdown menu button if plugin has menu items
                const menuItems = plugin.getTitleBarMenuItems();
                if (menuItems.length > 0) {
                    // Add dropdown icon to button
                    const dropdownIcon = document.createElement('span');
                    dropdownIcon.className =
                        'material-symbols-outlined plugin-dropdown-icon';
                    dropdownIcon.textContent = 'expand_more';
                    dropdownIcon.style.display = 'none'; // Initially hidden
                    button.appendChild(dropdownIcon);

                    // Create backdrop for modal-like behavior
                    const backdrop = getOrCreateBackdrop(
                        `plugin-menu-backdrop-${plugin.getId()}`
                    );

                    // Create tippy menu on the button itself
                    const menuHtml = createPluginMenuHtml(menuItems);
                    const tippyInstance = tippy(button, {
                        content: menuHtml,
                        allowHTML: true,
                        trigger: 'manual',
                        interactive: true,
                        placement: 'bottom-end',
                        theme: getTheme(),
                        arrow: false,
                        offset: [0, 0],
                        hideOnClick: false,
                        zIndex: 9999,
                        onShown: (instance) => {
                            setupMenuItemHandlers(instance, menuItems);
                        }
                    });

                    // Add backdrop and keyboard support
                    addTippyBackdropSupport(tippyInstance, backdrop);

                    // Store tippy instance and menu items
                    (button as any)._tippy = tippyInstance;
                    (button as any)._hasMenu = true;

                    // Handle clicks: show menu on dropdown icon, switch context on button area
                    button.addEventListener('click', async (e) => {
                        const target = e.target as HTMLElement;
                        const isDropdownIcon =
                            target.classList.contains('plugin-dropdown-icon') ||
                            target.closest('.plugin-dropdown-icon');

                        if (
                            isDropdownIcon &&
                            button.classList.contains('active')
                        ) {
                            // Click on dropdown icon when active - toggle menu
                            e.preventDefault();
                            e.stopImmediatePropagation();

                            // Capture state immediately
                            const wasVisible = tippyInstance.state.isVisible;

                            if (wasVisible) {
                                tippyInstance.hide();
                            } else {
                                tippyInstance.show();
                            }
                            return;
                        } else if (!isDropdownIcon) {
                            // Click on button area - switch context
                            await switchContext(plugin.getId());
                        }
                    });
                } else {
                    // No menu items - simple click to switch context
                    button.addEventListener('click', async () => {
                        await switchContext(plugin.getId());
                    });
                }

                titleBarRight.appendChild(button);
            });

            console.log(
                '[FileBrowser]',
                `Generated ${plugins.length} context tabs`
            );
        }

        // Restore last used context from localStorage
        let startPlugin: FilesystemPlugin | null = null;
        try {
            const lastContextId = localStorage.getItem(LAST_CONTEXT_KEY);
            if (lastContextId) {
                const restoredPlugin = pluginRegistry.get(lastContextId);
                if (isPluginVisibleInUI(restoredPlugin)) {
                    // Check if plugin is ready (important for disk plugin)
                    const isReady = await restoredPlugin.isReady();
                    if (isReady) {
                        // Activate the plugin to check permissions and setup
                        const activated = await restoredPlugin.onActivate();
                        if (activated) {
                            startPlugin = restoredPlugin;
                            console.log(
                                '[FileBrowser]',
                                `Restored last context: ${lastContextId}`
                            );
                        } else {
                            console.log(
                                '[FileBrowser]',
                                `Last context ${lastContextId} failed to activate, using default`
                            );
                        }
                    } else {
                        console.log(
                            '[FileBrowser]',
                            `Last context ${lastContextId} not ready, using default`
                        );
                    }
                }
            }
        } catch (e) {
            console.warn(
                '[FileBrowser]',
                'Failed to restore context from localStorage:',
                e
            );
        }

        // Navigate to restored or default plugin's default path
        const defaultPlugin = startPlugin || pluginRegistry.getDefault();
        if (defaultPlugin) {
            // Update file system cache to use the restored/default plugin
            fileSystemCache.currentPlugin = defaultPlugin;
            fileSystemCache.activeAdapter = defaultPlugin.getAdapter();

            // Update tab UI to reflect the active plugin
            document
                .querySelectorAll('.context-tab[data-plugin-id]')
                .forEach((tab: any) => {
                    tab.classList.remove('active');
                    if (
                        tab.getAttribute('data-plugin-id') ===
                        defaultPlugin.getId()
                    ) {
                        tab.classList.add('active');
                    }
                });

            // Let plugin update its UI state
            await defaultPlugin.updateUI({
                showOpenFolderUI,
                hideOpenFolderUI,
                showPermissionBanner,
                showUnsupportedBrowserUI,
                hideUnsupportedBrowserUI,
                showPluginMessage,
                hidePluginMessage
            });

            // Restore last visited path for this plugin
            let startPath = defaultPlugin.getDefaultPath();
            try {
                const pluginId = defaultPlugin.getId();
                const savedPath = localStorage.getItem(
                    getPathStorageKey(pluginId)
                );
                if (savedPath) {
                    startPath = savedPath;
                    console.log(
                        '[FileBrowser]',
                        `Restored last path for ${pluginId}: ${savedPath}`
                    );
                }
            } catch (e) {
                console.warn(
                    '[FileBrowser]',
                    'Failed to restore path from localStorage:',
                    e
                );
            }

            await browseCurrentPluginIfReady(startPath);

            // Update plugin menu button visibility
            updatePluginMenuButtonVisibility(defaultPlugin);
            updateDiskRelinkButton();

            // Update home button visibility
            updateHomeButtonVisibility();
        }

        console.log('[FileBrowser]', 'File browser initialized');
        markFileBrowserReady();
    } catch (error: any) {
        console.error(
            '[FileBrowser]',
            'Error initializing file browser:',
            error
        );
    }
}

// Auto-initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    void initFileBrowser();

    // Handle URL parameters for opening fonts in new tabs
    const urlParams = new URLSearchParams(window.location.search);
    const fileParam = urlParams.get('file');

    // Also support legacy format for backwards compatibility
    const legacyPluginId = urlParams.get('plugin');
    const legacyPath = urlParams.get('path');

    let pluginId: string | null = null;
    let fontPath: string | null = null;

    // Try new format first
    if (fileParam) {
        const parsed = parseFileUri(fileParam);
        if (parsed) {
            pluginId = parsed.pluginId;
            fontPath = parsed.path;
            console.log(
                '[FileBrowser]',
                `URL file param detected: ${fileParam}`
            );
        }
    } else if (legacyPluginId && legacyPath) {
        // Fall back to legacy format
        pluginId = legacyPluginId;
        fontPath = legacyPath;
        console.log(
            '[FileBrowser]',
            `Legacy URL params detected: plugin=${pluginId}, path=${fontPath}`
        );
    }

    (async () => {
        const applyDefaultStartupText = () => {
            if (readUrlState().text) {
                return;
            }
            if (window.stateManager) {
                window.stateManager.editor_text_buffer = TOUR_SAMPLE_TEXT;
            }
            window.glyphCanvas?.textRunEditor?.setTextBuffer?.(
                TOUR_SAMPLE_TEXT
            );
        };

        const openDefaultStartupFont = async (reason: string) => {
            if (window.fontManager?.currentFont) {
                return;
            }
            await waitForFontEditorReady();
            console.log('[FileBrowser]', reason);

            // Playwright (`?test=true`) keeps File → New so suites that open a
            // font themselves are not racing a Fustat compile.
            if (window.isTestMode?.()) {
                await window.fontManager?.handleNewFont?.();
                return;
            }

            try {
                applyDefaultStartupText();
                armDefaultStartupRegularLocation();
                await openMemoryUrlFont(TOUR_FUSTAT_PATH);
                applyDefaultStartupText();
            } catch (error) {
                console.error(
                    '[FileBrowser]',
                    'Failed to open default Fustat.glyphs; falling back to empty font:',
                    error
                );
                if (!window.fontManager?.currentFont) {
                    await window.fontManager?.handleNewFont?.();
                }
            }
        };

        try {
            if (
                pluginId === 'memory' &&
                fontPath &&
                !hasPendingPwaLaunchFiles()
            ) {
                try {
                    await openMemoryUrlFont(fontPath);
                    if (window.fontManager?.currentFont) {
                        return;
                    }
                } catch (error: any) {
                    const errorMessage = error?.message || String(error);
                    alert(`Error opening file from URL:\n\n${errorMessage}`);
                    console.error(
                        '[FileBrowser]',
                        'Failed to open memory font from URL params:',
                        error
                    );
                    await openDefaultStartupFont(
                        'URL font inaccessible; opening default Fustat.glyphs'
                    );
                    return;
                }
            }

            await waitForFileBrowserReady();
            await processPendingPwaLaunchFiles();

            // PWA launch (or anything else) may already have opened a font.
            if (window.fontManager?.currentFont) {
                return;
            }

            if (pluginId && fontPath) {
                let openedFromUrl = false;

                try {
                    // Check if plugin exists
                    const plugin = pluginRegistry.get(pluginId);
                    if (!plugin || !plugin.isVisibleInUI()) {
                        alert(
                            `Error: File system plugin "${pluginId}" not found.\n\nThe requested file cannot be loaded because the plugin is not available.`
                        );
                        console.error(
                            '[FileBrowser]',
                            `Plugin '${pluginId}' is not available for URL param`
                        );
                    } else {
                        // Switch to the specified plugin
                        await switchContext(pluginId);

                        if (pluginId === 'cloud') {
                            await openFont(
                                `cloud://${fontPath.replace(/^\/+/, '')}`
                            );
                            openedFromUrl = true;
                        } else {
                            // Navigate to the directory containing the font
                            const dirPath =
                                fontPath.substring(
                                    0,
                                    fontPath.lastIndexOf('/')
                                ) || '/';

                            let canOpenFile = true;
                            try {
                                await navigateToPath(dirPath);
                            } catch (navError) {
                                canOpenFile = false;
                                alert(
                                    `Error: Cannot access directory "${dirPath}" in "${plugin.getName()}" plugin.\n\nThe requested directory does not exist or is not accessible.`
                                );
                                console.error(
                                    '[FileBrowser]',
                                    `Cannot navigate to directory: ${dirPath}`,
                                    navError
                                );
                            }

                            if (canOpenFile) {
                                const exists =
                                    await fileSystemCache.activeAdapter.fileExists(
                                        fontPath
                                    );
                                if (!exists) {
                                    alert(
                                        `Error: File not found at "${fontPath}" in "${plugin.getName()}" plugin.\n\nThe requested file does not exist or is not accessible.`
                                    );
                                    console.error(
                                        '[FileBrowser]',
                                        `File not found: ${fontPath}`
                                    );
                                } else {
                                    const urlOpenReadyPromise =
                                        waitForUrlOpenFontReady(fontPath);
                                    await openFont(fontPath);
                                    await urlOpenReadyPromise;
                                    openedFromUrl = true;

                                    // Show home button since we opened from URL
                                    updateHomeButtonVisibility();

                                    // Wait a bit for the fontLoaded event handler to refresh the file list,
                                    // then scroll the opened file into view
                                    await new Promise((resolve) =>
                                        setTimeout(resolve, 200)
                                    );

                                    const fileTree =
                                        document.getElementById('file-tree');
                                    const currentFontItem =
                                        fileTree?.querySelector(
                                            '.file-item.current-font'
                                        );
                                    if (currentFontItem) {
                                        (
                                            currentFontItem as HTMLElement
                                        ).scrollIntoView({
                                            block: 'center',
                                            behavior: 'auto'
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (error: any) {
                    const errorMessage = error?.message || String(error);
                    alert(`Error opening file from URL:\n\n${errorMessage}`);
                    console.error(
                        '[FileBrowser]',
                        'Failed to open font from URL params:',
                        error
                    );
                }

                if (openedFromUrl || window.fontManager?.currentFont) {
                    return;
                }

                // URL pointed at an inaccessible file — keep the alert above,
                // then open the same default sample font as a cold start.
                await openDefaultStartupFont(
                    'URL font inaccessible; opening default Fustat.glyphs'
                );
                return;
            }

            // No URL/PWA font — open the memory sample font, not File → New.
            await openDefaultStartupFont(
                'No URL font attached; opening default Fustat.glyphs'
            );
        } catch (error: any) {
            console.error(
                '[FileBrowser]',
                'Failed during startup font open:',
                error
            );
            try {
                await openDefaultStartupFont(
                    'Startup font open failed; opening default Fustat.glyphs'
                );
            } catch (fallbackError) {
                console.error(
                    '[FileBrowser]',
                    'Failed to open default startup font:',
                    fallbackError
                );
            }
        }
    })();
});

window.addEventListener('pwaLaunchFilesPending', () => {
    (async () => {
        try {
            await waitForFileBrowserReady();
            await processPendingPwaLaunchFiles();
        } catch (error) {
            console.error(
                '[FileBrowser]',
                'Cannot process PWA launch files before file browser readiness:',
                error
            );
        }
    })();
});

// Close any open Tippy menu on Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        const allButtons = document.querySelectorAll('.context-tab');
        allButtons.forEach((button: Element) => {
            const tippyInstance = (button as TippyHostElement)._tippy;
            if (tippyInstance && tippyInstance.state.isVisible) {
                tippyInstance.hide();
            }
        });
    }
});

// Listen for plugin folder closed event
window.addEventListener('pluginFolderClosed', async () => {
    console.log('[FileBrowser]', 'Plugin folder closed, updating UI...');
    const { currentPlugin } = fileSystemCache;
    if (currentPlugin) {
        await currentPlugin.updateUI({
            showOpenFolderUI,
            hideOpenFolderUI,
            showPermissionBanner,
            showUnsupportedBrowserUI,
            hideUnsupportedBrowserUI,
            showPluginMessage,
            hidePluginMessage
        });
        updatePluginMenuButtonVisibility(currentPlugin);
        updateDiskRelinkButton();
    }

    window.dispatchEvent(
        new CustomEvent('fontsFolderAccessChanged', {
            detail: {
                hasFontsFolderAccess: false,
                source: 'detach'
            }
        })
    );
});

window.addEventListener('folderPermissionsDialogClosed', async () => {
    const plugin = fileSystemCache.currentPlugin;
    if (!(plugin instanceof DiskPlugin)) {
        updateDiskRelinkButton();
        return;
    }

    const adapter = plugin.getAdapter() as { hasDirectory?: () => boolean };
    if (!adapter.hasDirectory?.()) {
        await plugin.updateUI({
            showOpenFolderUI,
            hideOpenFolderUI,
            showPermissionBanner,
            showUnsupportedBrowserUI,
            hideUnsupportedBrowserUI
        });
        updateDiskRelinkButton();
        return;
    }

    hideOpenFolderUI();
    fileSystemCache.currentPath = plugin.getDefaultPath();
    await refreshFileSystem();
    refreshPluginTabLabel(plugin);
    updateDiskRelinkButton();
});

// Listen for disk file system changes (FileSystemObserver)
window.addEventListener('diskFilesChanged', async (event: Event) => {
    const { currentPlugin, currentPath, activeAdapter } = fileSystemCache;

    const detail = (event as CustomEvent).detail || {};
    const changedPaths = extractChangedPathsFromRecords(detail.records || []);

    // Only respond if we're currently in disk context
    if (currentPlugin.getId() !== 'disk') {
        return;
    }

    const internallyWrittenPaths = new Set(
        consumeManagedFileInternalWritePaths('disk', changedPaths)
    );
    const reloadablePaths = changedPaths.filter(
        (path) => !internallyWrittenPaths.has(path)
    );

    console.log('[FileBrowser]', 'Disk files changed, refreshing...');

    // Check if current path still exists, walk up if not
    let targetPath = currentPath;
    while (targetPath !== '/') {
        try {
            const exists = await activeAdapter.fileExists(targetPath);
            if (exists) {
                break;
            }
        } catch {
            // Path doesn't exist or error checking
        }
        // Walk up to parent
        targetPath =
            targetPath.substring(0, targetPath.lastIndexOf('/')) || '/';
        console.log(
            '[FileBrowser]',
            `Current folder gone, trying parent: ${targetPath}`
        );
    }

    // Update cached path if we had to walk up
    if (targetPath !== currentPath) {
        fileSystemCache.currentPath = targetPath;
        try {
            localStorage.setItem(
                getPathStorageKey(currentPlugin.getId()),
                targetPath
            );
        } catch (e) {
            // Ignore localStorage errors
        }
    }

    // Refresh the view
    await navigateToPath(targetPath);

    // Debounced external font hot reload (targeted by changed paths)
    for (const changedPath of reloadablePaths) {
        pendingDiskChangePaths.add(changedPath);
    }

    if (diskFontReloadDebounceTimer !== null) {
        window.clearTimeout(diskFontReloadDebounceTimer);
    }

    diskFontReloadDebounceTimer = window.setTimeout(async () => {
        const pathsToProcess = Array.from(pendingDiskChangePaths);
        pendingDiskChangePaths.clear();
        await maybeReloadCurrentFontFromDisk(pathsToProcess);
    }, 400);
});

// Listen for font ready event to refresh file browser highlighting
// (fontReady fires after fontManager.loadFont completes and currentFont is set)
function updateCurrentFontHighlightInFileTree(): void {
    const fileTree = document.getElementById('file-tree');
    if (!fileTree) {
        return;
    }

    const currentFontPath = window.fontManager?.currentFont?.path || null;
    const fileItems = fileTree.querySelectorAll('.file-item');

    fileItems.forEach((item: any) => {
        const element = item as HTMLElement;
        const itemPath = element.dataset.path || '';
        const isDir = element.dataset.isDir === 'true';
        const isFontFile = element.dataset.isFont === 'true';

        const isCurrentFont =
            !!currentFontPath &&
            isFontFile &&
            !isDir &&
            itemPath === currentFontPath;
        element.classList.toggle('current-font', isCurrentFont);

        const isInFontPath =
            !!currentFontPath &&
            isDir &&
            currentFontPath.startsWith(itemPath + '/');
        element.classList.toggle('in-font-path', isInFontPath);
    });
}

window.addEventListener('fontReady', async () => {
    const fontReadyFileRefreshSpanId = timelineSpanStart(
        'fileBrowser.fontReadyRefresh'
    );
    try {
        syncEditorFileStateFromCurrentFont();
        updateCurrentFontHighlightInFileTree();
    } finally {
        timelineSpanEnd(fontReadyFileRefreshSpanId);
    }
});

window.addEventListener('fontReady', async () => {
    updateHomeButtonVisibility();
});

window.addEventListener('cloudAssetLocalizedToMemory', async () => {
    syncEditorFileStateFromCurrentFont();
    updateCurrentFontHighlightInFileTree();

    if (fileSystemCache.currentPlugin.getId() === 'cloud') {
        await switchContext('memory');
    } else {
        updateFileDialogFooter();
    }
});

// Listen for plugin title bar redraw event
window.addEventListener('pluginTitleBarRedraw', ((e: CustomEvent) => {
    const { pluginId } = e.detail;
    const plugin = pluginRegistry.get(pluginId);
    if (plugin) {
        console.log(
            '[FileBrowser]',
            `Redrawing title bar for plugin: ${pluginId}`
        );
        updatePluginMenuButtonVisibility(plugin);
    }
}) as EventListener);

// Wrapper function to get file handle from global map
async function openFontWithHandle(path: string) {
    const fileHandle = (window as any)._fileHandles?.[path];
    await openFont(path, fileHandle);
}

// Export functions for global access
window.refreshFileSystem = refreshFileSystem;
window.navigateToPath = navigateToPath;
window.navigateToParent = navigateToParent;
window.selectFile = selectFile;
window.initFileBrowser = initFileBrowser;
window.waitForFileBrowserReady = waitForFileBrowserReady;
window.createFolder = createFolder;
window.createFile = createFile;
window.deleteItem = deleteItem;
window.uploadFiles = uploadFiles;
window.handleFileUpload = handleFileUpload;
window.openFont = openFont;
window.showFontFileDialog = showFontFileDialog;
window.closeFontFileDialog = closeFontFileDialog;
window.locatePathInFileDialog = locatePathInFileDialog;
(window as any).openFontWithHandle = openFontWithHandle;
(window as any).switchContext = switchContext;
(window as any).selectDiskFolder = selectDiskFolder;
(window as any).reEnableAccess = reEnableAccess;
(window as any).parseFileUri = parseFileUri;
window.downloadFile = downloadFile;

// Export plugin registry and current plugin getter for script editor
(window as any).pluginRegistry = pluginRegistry;
(window as any).fileBrowser = {
    getCurrentPlugin: () => fileSystemCache.currentPlugin,
    getCurrentPath: () => fileSystemCache.currentPath
};
// Bridge for folder-permissions-dialog (also bundled into glyph-overview).
// Keep as a window callback so that entry does not dynamic-import this module
// and pull a second Yjs copy into the page (yjs#438).
window.applyFontsFolderSelection = applyFontsFolderSelection;
