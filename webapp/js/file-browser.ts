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

    // Navigate to plugin's default path
    const defaultPath = plugin.getDefaultPath();
    fileSystemCache.currentPath = defaultPath;
    await navigateToPath(defaultPath);
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

    // Parent directory button (if not at root)
    const parentBtn =
        rootPath !== '/'
            ? (() => {
                  const parentPath =
                      rootPath.substring(0, rootPath.lastIndexOf('/')) || '/';
                  return `<button onclick="navigateToPath('${parentPath}')" class="file-action-btn" title="Go to parent directory">
                <span class="material-symbols-outlined">arrow_upward</span> Up
            </button>`;
              })()
            : '';

    // Toolbar with actions
    html += `<div class="file-toolbar">
        ${parentBtn}
        <button onclick="createFolder()" class="file-action-btn" title="Create new folder">
            <span class="material-symbols-outlined">create_new_folder</span> New Folder
        </button>
        <button onclick="document.getElementById('file-upload-input').click()" class="file-action-btn" title="Upload files">
            <span class="material-symbols-outlined">upload_file</span> Upload Files
        </button>
        <button onclick="document.getElementById('folder-upload-input').click()" class="file-action-btn" title="Upload folder with structure">
            <span class="material-symbols-outlined">drive_folder_upload</span> Upload Folder
        </button>
        <button onclick="refreshFileSystem()" class="file-action-btn" title="Refresh">
            <span class="material-symbols-outlined">refresh</span> Refresh
        </button>
    </div>
    <input type="file" id="file-upload-input" multiple style="display: none;" 
           onchange="handleFileUpload(event)">
    <input type="file" id="folder-upload-input" webkitdirectory directory multiple style="display: none;" 
           onchange="handleFileUpload(event)">`;

    // Sort: directories first, then files
    const sortedItems = Object.entries(items).sort(([a, aData], [b, bData]) => {
        if (aData.is_dir && !bData.is_dir) return -1;
        if (!aData.is_dir && bData.is_dir) return 1;
        return a.localeCompare(b);
    });

    for (const [name, data] of sortedItems) {
        const icon = getFileIcon(name, data.is_dir);
        const fileClass = getFileClass(name, data.is_dir);
        const sizeText = data.is_dir
            ? ''
            : `<span class="file-size">${formatFileSize(data.size)}</span>`;

        const clickHandler = data.is_dir
            ? `navigateToPath('${data.path}')`
            : `selectFile('${data.path}')`;

        // Add download button for files
        const downloadBtn = !data.is_dir
            ? `<button class="download-btn" onclick="event.stopPropagation(); downloadFile('${data.path}', '${name}')" title="Download"><span class="material-symbols-outlined">download</span></button>`
            : '';

        const deleteBtn = `<button class="delete-btn" onclick="event.stopPropagation(); deleteItem('${data.path}', '${name}', ${data.is_dir})" title="Delete"><span class="material-symbols-outlined">delete</span></button>`;

        // Add "Open" button for supported font formats
        const isSupported = isSupportedFontFormat(name, data.is_dir);
        const openBtn = isSupported
            ? `<button class="open-font-btn" onclick="event.stopPropagation(); openFont('${data.path}')" title="Open font"><span class="material-symbols-outlined">folder_open</span> Open</button>`
            : '';

        html += `<div class="file-item ${fileClass}" onclick="${clickHandler}">
            <span class="file-name">${icon} ${name}</span>${sizeText}${openBtn}${downloadBtn}${deleteBtn}
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

async function navigateToPath(path: string) {
    try {
        const fileTree = document.getElementById('file-tree');
        fileTree!.innerHTML = '<div style="color: #888;">Loading...</div>';

        const html = await buildFileTree(path);
        fileTree!.innerHTML = `
            <div class="file-path">Current path: ${path}</div>
            ${html}
        `;

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
                    const backdrop = document.createElement('div');
                    backdrop.className = 'plugin-menu-backdrop';
                    backdrop.addEventListener('click', () => {
                        const tippyInstance = (button as any)._tippy;
                        if (tippyInstance) {
                            tippyInstance.hide();
                        }
                    });
                    document.body.appendChild(backdrop);

                    // Create tippy menu on the button itself
                    const menuHtml = createPluginMenuHtml(menuItems);
                    const tippyInstance = tippy(button, {
                        content: menuHtml,
                        allowHTML: true,
                        trigger: 'manual', // We'll control it manually
                        interactive: true,
                        placement: 'bottom-end',
                        theme: getTheme(),
                        arrow: false,
                        offset: [0, 0],
                        hideOnClick: false, // Prevent automatic hiding
                        zIndex: 9999, // Above backdrop
                        onShow: () => {
                            backdrop.classList.add('visible');
                        },
                        onShown: (instance) => {
                            setupMenuItemHandlers(instance, menuItems);
                        },
                        onHide: () => {
                            backdrop.classList.remove('visible');
                        }
                    });

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
window.selectFile = selectFile;
window.initFileBrowser = initFileBrowser;
window.createFolder = createFolder;
window.deleteItem = deleteItem;
window.uploadFiles = uploadFiles;
window.handleFileUpload = handleFileUpload;
window.openFont = openFont;
(window as any).openFontWithHandle = openFontWithHandle;
(window as any).switchContext = switchContext;
(window as any).selectDiskFolder = selectDiskFolder;
(window as any).reEnableAccess = reEnableAccess;
window.downloadFile = downloadFile;
