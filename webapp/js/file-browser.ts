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
    TitleBarMenuItem
} from './filesystem-plugins';

const LAST_CONTEXT_KEY = 'last-filesystem-context';

function getPathStorageKey(pluginId: string): string {
    return `last-path-${pluginId}`;
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

function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

function updatePathDisplay(path: string) {
    const pathTextElement = document.querySelector(
        '.file-path-text'
    ) as HTMLElement;
    if (!pathTextElement) return;

    const availableWidth = pathTextElement.offsetWidth;
    const displayPath = truncatePathMiddle(path, availableWidth, 10);
    pathTextElement.textContent = displayPath;
}

function getFileIcon(filename: string, isDir: boolean): string {
    if (isDir) return '📁';

    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'py':
            return '🐍';
        case 'txt':
            return '📄';
        case 'json':
            return '🔧';
        case 'md':
            return '📝';
        case 'html':
            return '🌐';
        case 'css':
            return '🎨';
        case 'js':
            return '⚡';
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
            return '🖼️';
        case 'pdf':
            return '📕';
        case 'zip':
            return '🗜️';
        case 'ttf':
        case 'otf':
        case 'woff':
        case 'woff2':
            return '🔤';
        case 'babelfont':
        case 'glyphs':
        case 'ufo':
        case 'designspace':
            return '✏️';
        default:
            return '📄';
    }
}

function getFileClass(filename: string, isDir: boolean): string {
    if (isDir) return 'directory';

    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'py') return 'python-file';
    return 'file';
}

function isSupportedFontFormat(name: string, isDir: boolean): boolean {
    // Skip directories
    if (isDir) return false;

    // Check for supported font formats
    const supportedExtensions = [
        '.babelfont', // Native format
        '.glyphs', // Glyphs 2/3
        '.vfj' // FontLab VFJ
        // Available after full file system support:
        // '.ufo', // Unified Font Object
        // '.designspace' // DesignSpace
    ];

    return supportedExtensions.some((ext) => name.endsWith(ext));
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

/**
 * Create or get a backdrop element for modal-like menu behavior
 */
function getOrCreateBackdrop(className: string): HTMLElement {
    let backdrop = document.querySelector(`.${className}`) as HTMLElement;
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = `plugin-menu-backdrop ${className}`;
        document.body.appendChild(backdrop);
    }
    return backdrop;
}

/**
 * Add backdrop and keyboard support to a Tippy instance
 * Returns the backdrop element for further customization
 */
function addTippyBackdropSupport(
    tippyInstance: any,
    backdrop: HTMLElement,
    options?: {
        onEscape?: () => void;
        targetElement?: HTMLElement;
        activeClass?: string;
    }
): void {
    // Handle backdrop clicks
    const handleBackdropClick = () => {
        if (tippyInstance.state.isVisible) {
            tippyInstance.hide();
        }
    };
    backdrop.addEventListener('click', handleBackdropClick);

    // Store handler for potential cleanup
    (backdrop as any)._clickHandler = handleBackdropClick;

    // Add to existing onShow/onShown/onHide handlers
    const originalOnShow = tippyInstance.props.onShow;
    const originalOnShown = tippyInstance.props.onShown;
    const originalOnHide = tippyInstance.props.onHide;

    tippyInstance.setProps({
        onShow: (instance: any) => {
            backdrop.classList.add('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.add(options.activeClass);
            }
            if (originalOnShow) originalOnShow(instance);
        },
        onShown: (instance: any) => {
            // Add keyboard support
            const handleKeydown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    instance.hide();
                    if (options?.onEscape) options.onEscape();
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);
            (instance as any)._keydownHandler = handleKeydown;

            if (originalOnShown) originalOnShown(instance);
        },
        onHide: (instance: any) => {
            backdrop.classList.remove('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.remove(options.activeClass);
            }

            // Clean up keyboard listener
            const handler = (instance as any)._keydownHandler;
            if (handler) {
                document.removeEventListener('keydown', handler);
            }

            if (originalOnHide) originalOnHide(instance);
        }
    });
}

function createFileContextMenuHtml(
    path: string,
    name: string,
    isDir: boolean
): string {
    const items: string[] = [];

    // Open (for supported font formats)
    if (!isDir && isSupportedFontFormat(name, false)) {
        items.push(`
            <div class="plugin-menu-item" data-action="open">
                <span class="material-symbols-outlined">folder_open</span>
                <span>Open</span>
            </div>
        `);
        items.push(`
            <div class="plugin-menu-item" data-action="open-new-tab">
                <span class="material-symbols-outlined">open_in_new</span>
                <span>Open in New Tab</span>
            </div>
        `);
    }

    // Download (for files only)
    if (!isDir) {
        items.push(`
            <div class="plugin-menu-item" data-action="download">
                <span class="material-symbols-outlined">download</span>
                <span>Download</span>
            </div>
        `);
    }

    // Delete (for both files and folders)
    items.push(`
        <div class="plugin-menu-item" data-action="delete">
            <span class="material-symbols-outlined">delete</span>
            <span>Delete</span>
        </div>
    `);

    return `<div class="plugin-menu">${items.join('')}</div>`;
}

function setupMenuItemHandlers(
    tippyInstance: TippyInstance,
    menuItems: TitleBarMenuItem[]
): void {
    const menu = tippyInstance.popper.querySelector('.plugin-menu');
    if (!menu) return;

    menu.querySelectorAll('.plugin-menu-item').forEach((item, index) => {
        item.addEventListener('click', async () => {
            tippyInstance.hide();
            await menuItems[index].action();
        });
    });

    // Keyboard navigation
    let focusedIndex = 0;
    const items = Array.from(menu.querySelectorAll('.plugin-menu-item'));

    const updateFocus = () => {
        items.forEach((el, i) => {
            el.classList.toggle('focused', i === focusedIndex);
        });
    };

    menu.addEventListener('keydown', (e: Event) => {
        const keyEvent = e as KeyboardEvent;
        if (keyEvent.key === 'ArrowDown') {
            e.preventDefault();
            focusedIndex = (focusedIndex + 1) % items.length;
            updateFocus();
        } else if (keyEvent.key === 'ArrowUp') {
            e.preventDefault();
            focusedIndex = (focusedIndex - 1 + items.length) % items.length;
            updateFocus();
        } else if (keyEvent.key === 'Enter') {
            e.preventDefault();
            (items[focusedIndex] as HTMLElement).click();
        }
    });

    updateFocus();
    (menu as HTMLElement).focus();
}

function setupFileContextMenus() {
    const fileItems = document.querySelectorAll('.file-item');

    // Create shared backdrop for all file context menus
    const backdrop = getOrCreateBackdrop('file-context-menu-backdrop');

    fileItems.forEach((item) => {
        const element = item as HTMLElement;
        const path = element.getAttribute('data-path') || '';
        const name = element.getAttribute('data-name') || '';
        const isDir = element.getAttribute('data-is-dir') === 'true';

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
            zIndex: 9999,
            getReferenceClientRect: null as any, // Will be set on show
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) return;

                // Setup click handlers for menu items
                menu.querySelectorAll('.plugin-menu-item').forEach(
                    (menuItem) => {
                        menuItem.addEventListener('click', async () => {
                            const action = menuItem.getAttribute('data-action');
                            instance.hide();

                            switch (action) {
                                case 'open':
                                    await openFont(path);
                                    break;
                                case 'open-new-tab':
                                    openFontInNewTab(path);
                                    break;
                                case 'download':
                                    await downloadFile(path, name);
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

        // Add backdrop and keyboard support
        addTippyBackdropSupport(tippyInstance, backdrop, {
            targetElement: element,
            activeClass: 'file-item-active'
        });

        // Prevent default context menu and show Tippy menu at mouse position
        element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Set position to mouse cursor
            tippyInstance.setProps({
                getReferenceClientRect: () => ({
                    width: 0,
                    height: 0,
                    top: e.clientY,
                    bottom: e.clientY,
                    left: e.clientX,
                    right: e.clientX,
                    x: e.clientX,
                    y: e.clientY,
                    toJSON: () => ({})
                })
            });

            tippyInstance.show();
        });

        // Store tippy instance for cleanup
        (element as any)._tippy = tippyInstance;
    });
}

function getTheme(): string {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    return theme === 'light' ? 'light' : 'dark';
}

function updatePluginMenuButtonVisibility(plugin: FilesystemPlugin): void {
    const pluginId = plugin.getId();
    const button = document.querySelector(
        `.context-tab[data-plugin-id="${pluginId}"]`
    ) as HTMLElement;

    if (!button || !(button as any)._hasMenu) return;

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
    const params = new URLSearchParams();
    params.set('plugin', pluginId);
    params.set('path', path);

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    window.open(url, '_blank');
    console.log(
        '[FileBrowser]',
        `Opening font in new tab: ${path} (plugin: ${pluginId})`
    );
}

async function openFont(path: string, fileHandle?: FileSystemFileHandle) {
    if (!window.pyodide) {
        alert('Python not ready yet. Please wait a moment and try again.');
        return;
    }

    try {
        const startTime = performance.now();
        console.log('[FileBrowser]', `Opening font: ${path}`);

        let contents = await fileSystemCache.activeAdapter.readFile(path);

        // Determine file extension
        const extension = path.split('.').pop()?.toLowerCase() || '';

        // For text-based formats (.babelfont is JSON), decode from UTF-8
        // For binary formats (.glyphs, .ufo, etc.), keep as Uint8Array - Python/Rust handles format detection
        if (extension === 'babelfont' && contents instanceof Uint8Array) {
            contents = new TextDecoder('utf-8').decode(contents);
        }
        // All other formats: keep as Uint8Array for worker to handle

        let babelfontJson: string;

        // For non-.babelfont files, use Rust loader to convert
        if (extension !== 'babelfont') {
            console.log(
                '[FileBrowser]',
                `Detected ${extension} format, converting via Rust...`
            );

            if (!window.fontCompilation?.worker) {
                throw new Error('Font compilation worker not initialized');
            }

            // Send to worker for conversion
            babelfontJson = await new Promise<string>((resolve, reject) => {
                const id = Math.random().toString(36);
                const timeout = setTimeout(() => {
                    reject(
                        new Error('Font conversion timeout after 30 seconds')
                    );
                }, 30000);

                const handleMessage = (e: MessageEvent) => {
                    if (e.data.id === id && e.data.type === 'openFont') {
                        clearTimeout(timeout);
                        window.fontCompilation!.worker!.removeEventListener(
                            'message',
                            handleMessage
                        );

                        if (e.data.error) {
                            reject(new Error(e.data.error));
                        } else {
                            resolve(e.data.babelfontJson);
                        }
                    }
                };

                window.fontCompilation!.worker!.addEventListener(
                    'message',
                    handleMessage
                );

                window.fontCompilation!.worker!.postMessage({
                    type: 'openFont',
                    id,
                    filename: path.split('/').pop() || path,
                    contents // Uint8Array for binary formats, string for .babelfont
                });
            });

            console.log(
                '[FileBrowser]',
                `Successfully converted ${extension} to babelfont format`
            );
        } else {
            // For .babelfont files, use contents directly (already a string)
            babelfontJson = contents as string;
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(
            '[FileBrowser]',
            `Successfully opened font: ${path} (${duration}s)`
        );

        // Get file handle for disk plugin
        let actualFileHandle = fileHandle;
        if (
            !actualFileHandle &&
            fileSystemCache.currentPlugin.getId() === 'disk'
        ) {
            const diskPlugin = fileSystemCache.currentPlugin as DiskPlugin;
            const adapter = diskPlugin.getAdapter() as any;
            if (adapter.getFileHandle) {
                actualFileHandle = await adapter.getFileHandle(path);
            }
        }

        // Get directory handle for disk plugin
        let directoryHandle: FileSystemDirectoryHandle | undefined;
        if (fileSystemCache.currentPlugin.getId() === 'disk') {
            const diskPlugin = fileSystemCache.currentPlugin as DiskPlugin;
            const adapter = diskPlugin.getAdapter() as any;
            directoryHandle = adapter.directoryHandle;
        }

        // Dispatch fontLoaded event to font manager
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: path,
                    babelfontJson: babelfontJson,
                    sourcePlugin: fileSystemCache.currentPlugin,
                    fileHandle: actualFileHandle,
                    directoryHandle: directoryHandle
                }
            })
        );

        // Play done sound
        if (window.playSound) {
            window.playSound('done');
        }

        // Restore focus to canvas if editor view is active
        const editorView = document.getElementById('view-editor');
        if (
            editorView &&
            editorView.classList.contains('focused') &&
            window.glyphCanvas &&
            window.glyphCanvas.canvas
        ) {
            setTimeout(() => window.glyphCanvas.canvas!.focus(), 0);
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error opening font:', error);
        alert(`Error opening font: ${error.message}`);
    }
}

async function switchContext(pluginId: string) {
    console.log('[FileBrowser]', `Switching to ${pluginId} context`);

    const plugin = pluginRegistry.get(pluginId);
    if (!plugin) {
        console.error('[FileBrowser]', `Plugin '${pluginId}' not found`);
        return;
    }

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
    document.querySelectorAll('.context-tab').forEach((tab) => {
        tab.classList.remove('active');
        if (tab.getAttribute('data-plugin-id') === pluginId) {
            tab.classList.add('active');
        }
    });

    // Update dropdown icon visibility for all plugins
    pluginRegistry.getAll().forEach((p) => {
        updatePluginMenuButtonVisibility(p);
    });

    // Try to activate plugin (may fail if setup needed)
    const activated = await plugin.onActivate();
    if (!activated) {
        // Plugin needs setup - let plugin update its own UI
        await plugin.updateUI({
            showOpenFolderUI,
            hideOpenFolderUI,
            showPermissionBanner,
            showUnsupportedBrowserUI,
            hideUnsupportedBrowserUI
        });
        return;
    }

    // Plugin activated successfully - let plugin update UI
    await plugin.updateUI({
        showOpenFolderUI,
        hideOpenFolderUI,
        showPermissionBanner,
        showUnsupportedBrowserUI,
        hideUnsupportedBrowserUI
    });

    // Update dropdown menu button visibility based on plugin capabilities
    updatePluginMenuButtonVisibility(plugin);

    // Restore last visited path for this plugin, or use default path
    let targetPath = plugin.getDefaultPath();
    try {
        const savedPath = localStorage.getItem(getPathStorageKey(pluginId));
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
    await navigateToPath(targetPath);
}

async function selectDiskFolder() {
    try {
        const plugin = fileSystemCache.currentPlugin;
        if (!(plugin instanceof DiskPlugin)) {
            console.error('[FileBrowser]', 'Current plugin is not DiskPlugin');
            return;
        }

        const success = await plugin.showSetupUI();
        if (success) {
            hideOpenFolderUI();
            fileSystemCache.currentPath = '/';
            await navigateToPath('/');
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error selecting folder:', error);
        alert(`Error selecting folder: ${error.message}`);
    }
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

function showUnsupportedBrowserUI() {
    const container = document.getElementById('plugin-message-container');
    if (container) {
        container.innerHTML = `
            <div class="plugin-message-content">
                <span class="material-symbols-outlined plugin-message-icon warning">info</span>
                <h3>Browser Not Supported</h3>
                <p>Your browser doesn't support native file system access for the Disk context.</p>
                <p class="browser-suggestion">Please use Chrome/Chromium 86+, Edge 86+, or Safari 15.2+ for full functionality.<br>You can use the Memory context for browser storage.</p>
            </div>
        `;
        container.classList.add('visible');
    }
    hideFileTree();
}

function hideUnsupportedBrowserUI() {
    const container = document.getElementById('plugin-message-container');
    if (container) {
        container.innerHTML = '';
        container.classList.remove('visible');
    }
    showFileTree();
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
        } else {
            alert('Permission not granted. Please try again.');
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error requesting permission:', error);
        alert(`Error requesting permission: ${error.message}`);
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

    if (openFolderContainer) {
        openFolderContainer.classList.add('visible');
    }
    hideFileTree();
}

function hideOpenFolderUI() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );

    if (openFolderContainer) {
        openFolderContainer.classList.remove('visible');
    }
    showFileTree();
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
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error creating folder:', error);
        alert(`Error creating folder: ${error.message}`);
    }
}

async function downloadFile(filePath: string, fileName: string) {
    try {
        // Get the file content
        const fileContent =
            await fileSystemCache.activeAdapter.readFile(filePath);

        // Ensure we have Uint8Array for blob creation
        let fileData: Uint8Array;
        if (typeof fileContent === 'string') {
            fileData = new TextEncoder().encode(fileContent);
        } else {
            fileData = new Uint8Array(fileContent as any);
        }

        // Create blob and download
        const fileBlob = new Blob([fileData as any], {
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
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error downloading file:', error);
        alert(`Error downloading file: ${error.message}`);
    }
}

async function deleteItem(itemPath: string, itemName: string, isDir: boolean) {
    const confirmMsg = isDir
        ? `Delete folder "${itemName}" and all its contents?`
        : `Delete file "${itemName}"?`;

    if (!confirm(confirmMsg)) return;

    try {
        await fileSystemCache.activeAdapter.deleteItem(itemPath, isDir);
        console.log('[FileBrowser]', `Deleted: ${itemPath}`);
        await refreshFileSystem();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error deleting item:', error);
        alert(`Error deleting item: ${error.message}`);
    }
}

async function uploadFiles(
    files: File[] | FileList,
    directory: string | null = null
) {
    const startTime = performance.now();
    const currentPath = directory || fileSystemCache.currentPath || '/';
    let uploadedCount = 0;

    for (const file of files) {
        try {
            // Handle files with relative paths (from folder upload)
            // file.webkitRelativePath contains the full path including folder structure
            const relativePath = file.webkitRelativePath || file.name;
            const fullpath = currentPath + '/' + relativePath;

            // Write file using adapter
            const contents = await file.arrayBuffer();
            await fileSystemCache.activeAdapter.writeFile(
                fullpath,
                new Uint8Array(contents)
            );
            console.log('[FileBrowser]', `Uploading file: ${fullpath}`);
            uploadedCount++;
        } catch (error: any) {
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

        const msg = `Uploaded ${uploadedCount} file(s) in ${duration} seconds`;

        console.log('[FileBrowser]', msg);
        if (window.term) {
            window.term.echo(`[[;lime;]${msg}]`);
        }

        await refreshFileSystem();

        // Play done sound
        if (window.playSound) {
            window.playSound('done');
        }
    }
}
async function buildFileTree(rootPath = '/') {
    const items = await scanDirectory(rootPath);
    let html = '';

    // Hidden file inputs for upload functionality
    html += `<input type="file" id="file-upload-input" multiple style="display: none;" 
           onchange="handleFileUpload(event)">
    <input type="file" id="folder-upload-input" webkitdirectory directory multiple style="display: none;" 
           onchange="handleFileUpload(event)">`;

    // Sort: directories first, then files
    const sortedItems = Object.entries(items).sort(([a, aData], [b, bData]) => {
        if (aData.is_dir && !bData.is_dir) return -1;
        if (!aData.is_dir && bData.is_dir) return 1;
        return a.localeCompare(b);
    });

    // Get current font path for highlighting
    const currentFontPath = window.fontManager?.currentFont?.path || null;

    for (const [name, data] of sortedItems) {
        const icon = getFileIcon(name, data.is_dir);
        const fileClass = getFileClass(name, data.is_dir);
        const sizeText = data.is_dir
            ? ''
            : `<span class="file-size">${formatFileSize(data.size)}</span>`;

        const clickHandler = data.is_dir
            ? `navigateToPath('${data.path}')`
            : `selectFile('${data.path}')`;

        // Add 'current-font' class if this is the opened font
        const isCurrentFont = !data.is_dir && currentFontPath === data.path;
        const currentFontClass = isCurrentFont ? 'current-font' : '';

        // Add 'in-font-path' class if this is a directory in the path to the current font
        const isInFontPath =
            data.is_dir &&
            currentFontPath &&
            currentFontPath.startsWith(data.path + '/');
        const fontPathClass = isInFontPath ? 'in-font-path' : '';

        html += `<div class="file-item ${fileClass} ${currentFontClass} ${fontPathClass}" onclick="${clickHandler}" data-path="${data.path}" data-name="${name}" data-is-dir="${data.is_dir}">
            <span class="file-name">${icon} ${name}</span>${sizeText}
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

async function navigateToPath(path: string, highlightFolder?: string) {
    try {
        const fileTree = document.getElementById('file-tree');

        // Build content first (off-screen)
        const html = await buildFileTree(path);

        // Update path header with toolbar buttons
        let pathHeader = document.getElementById('file-path-header');
        if (!pathHeader) {
            pathHeader = document.createElement('div');
            pathHeader.id = 'file-path-header';
            const fileBrowser = document.getElementById('file-browser');
            fileBrowser!.insertBefore(pathHeader, fileBrowser!.firstChild);
        }

        // Generate toolbar buttons
        const parentBtn =
            path !== '/'
                ? `<button onclick="navigateToParent()" class="file-header-btn" title="Go to parent directory">
                <span class="material-symbols-outlined">arrow_upward</span>
            </button>`
                : '';

        pathHeader.innerHTML = `
            <span class="file-path-text" title="${path}" data-full-path="${path}">${path}</span>
            <div class="file-header-actions">
                ${parentBtn}
                <button onclick="createFolder()" class="file-header-btn" title="Create new folder">
                    <span class="material-symbols-outlined">create_new_folder</span>
                </button>
                <button onclick="document.getElementById('file-upload-input').click()" class="file-header-btn" title="Upload files">
                    <span class="material-symbols-outlined">upload_file</span>
                </button>
                <button onclick="document.getElementById('folder-upload-input').click()" class="file-header-btn" title="Upload folder">
                    <span class="material-symbols-outlined">drive_folder_upload</span>
                </button>
                <button onclick="refreshFileSystem()" class="file-header-btn" title="Refresh">
                    <span class="material-symbols-outlined">refresh</span>
                </button>
            </div>
        `;

        // Update path display after DOM is ready
        setTimeout(() => updatePathDisplay(path), 0);

        // Set up ResizeObserver to update path on container resize
        const pathTextElement = pathHeader.querySelector(
            '.file-path-text'
        ) as HTMLElement;
        if (pathTextElement && !(pathTextElement as any)._resizeObserver) {
            const resizeObserver = new ResizeObserver(() => {
                const fullPath =
                    pathTextElement.getAttribute('data-full-path') || path;
                updatePathDisplay(fullPath);
            });
            resizeObserver.observe(pathTextElement);
            (pathTextElement as any)._resizeObserver = resizeObserver;
        }

        // Update file tree content in a single frame to prevent flickering
        requestAnimationFrame(() => {
            fileTree!.innerHTML = html;

            // Setup context menus for file items (defer to next frame to ensure DOM is ready)
            requestAnimationFrame(() => {
                setupFileContextMenus();

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
                } else {
                    // Only scroll to in-path folder if there's a current font open
                    const currentFont = window.fontManager?.currentFont;
                    if (currentFont) {
                        const inPathItem = fileTree!.querySelector(
                            '.file-item.in-font-path'
                        );
                        if (inPathItem) {
                            inPathItem.scrollIntoView({
                                block: 'center',
                                behavior: 'auto'
                            });
                        }
                    } else {
                        // No font open - reset scroll to top
                        fileTree!.scrollTop = 0;
                    }
                }
            });
        });

        // Cache the current path
        fileSystemCache.currentPath = path;

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

        // Setup drag & drop on the file tree
        setupDragAndDrop();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error navigating to path:', error);
        document.getElementById('file-tree')!.innerHTML = `
            <div style="color: #ff3300;">Error loading directory: ${error.message}</div>
        `;
    }
}

function setupDragAndDrop() {
    const fileBrowser = document.getElementById('file-browser')!;
    let dragCounter = 0;

    fileBrowser.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        fileBrowser.classList.add('drag-over');
    });

    fileBrowser.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    fileBrowser.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
            fileBrowser.classList.remove('drag-over');
        }
    });

    fileBrowser.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        fileBrowser.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer!.files);
        if (files.length > 0) {
            await uploadFiles(files);
        }
    });
}

function selectFile(filePath: string) {
    console.log('[FileBrowser]', 'Selected file:', filePath);
    // TODO: Add file selection handling (e.g., show content, download, etc.)
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
    const homeBtn = document.getElementById('file-browser-home-btn');
    if (!homeBtn) return;

    const currentFont = window.fontManager?.currentFont;
    homeBtn.style.display = currentFont ? 'flex' : 'none';
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
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
        const memoryPlugin = pluginRegistry.get('memory');
        if (memoryPlugin) {
            await memoryPlugin.getAdapter().createFolder('/user');
        }

        // Generate context tabs dynamically from plugin registry
        const titleBarRight = document.querySelector(
            '.view-files .view-title-right'
        );
        if (titleBarRight) {
            // Clear existing content
            titleBarRight.innerHTML = '';

            // Add home button (navigate to current font)
            const homeBtn = document.createElement('button');
            homeBtn.id = 'file-browser-home-btn';
            homeBtn.className = 'view-title-button';
            homeBtn.title = 'Go to opened font';
            homeBtn.innerHTML = `<span class="material-symbols-outlined">location_on</span>`;
            homeBtn.style.display = 'none'; // Initially hidden
            homeBtn.addEventListener('click', navigateToCurrentFont);
            titleBarRight.appendChild(homeBtn);

            const plugins = pluginRegistry.getAll();
            plugins.forEach((plugin) => {
                const button = document.createElement('button');
                button.className = 'view-title-button context-tab';
                button.setAttribute('data-plugin-id', plugin.getId());
                button.innerHTML = `${plugin.getIcon()} ${plugin.getName()}`;

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
                if (restoredPlugin) {
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
            document.querySelectorAll('.context-tab').forEach((tab) => {
                tab.classList.remove('active');
                if (
                    tab.getAttribute('data-plugin-id') === defaultPlugin.getId()
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
                hideUnsupportedBrowserUI
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

            await navigateToPath(startPath);

            // Update plugin menu button visibility
            updatePluginMenuButtonVisibility(defaultPlugin);

            // Update home button visibility
            updateHomeButtonVisibility();
        }

        console.log('[FileBrowser]', 'File browser initialized');
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
    setTimeout(initFileBrowser, 1500); // Wait a bit longer for Pyodide to be ready

    // Handle URL parameters for opening fonts in new tabs
    const urlParams = new URLSearchParams(window.location.search);
    const pluginId = urlParams.get('plugin');
    const fontPath = urlParams.get('path');

    if (pluginId && fontPath) {
        console.log(
            '[FileBrowser]',
            `URL params detected: plugin=${pluginId}, path=${fontPath}`
        );

        // Wait for everything to initialize before switching and opening
        setTimeout(async () => {
            try {
                // Switch to the specified plugin
                await switchContext(pluginId);

                // Navigate to the directory containing the font
                const dirPath =
                    fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
                await navigateToPath(dirPath);

                // Open the font
                await openFont(fontPath);

                // Show home button since we opened from URL
                updateHomeButtonVisibility();

                // Scroll the opened file into view
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
                }, 100); // Small delay to ensure DOM is updated
            } catch (error) {
                console.error(
                    '[FileBrowser]',
                    'Failed to open font from URL params:',
                    error
                );
            }
        }, 3000); // Wait for plugins and Pyodide to be ready
    }
});

// Close any open Tippy menu on Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        const allButtons = document.querySelectorAll('.context-tab');
        allButtons.forEach((button) => {
            const tippyInstance = (button as any)._tippy;
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
            hideUnsupportedBrowserUI
        });
        updatePluginMenuButtonVisibility(currentPlugin);
    }
});

// Listen for font loaded event to refresh file browser highlighting
window.addEventListener('fontLoaded', () => {
    // Refresh current directory to update highlighting
    const currentPath = fileSystemCache.currentPath || '/';
    navigateToPath(currentPath);
});

// Listen for fontReady event (fires after FontManager.loadFont completes)
window.addEventListener('fontReady', () => {
    updateHomeButtonVisibility();
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
window.createFolder = createFolder;
window.navigateToCurrentFont = navigateToCurrentFont;
window.updateHomeButtonVisibility = updateHomeButtonVisibility;
window.deleteItem = deleteItem;
window.uploadFiles = uploadFiles;
window.handleFileUpload = handleFileUpload;
window.openFont = openFont;
(window as any).openFontWithHandle = openFontWithHandle;
(window as any).switchContext = switchContext;
(window as any).selectDiskFolder = selectDiskFolder;
(window as any).reEnableAccess = reEnableAccess;
window.downloadFile = downloadFile;
