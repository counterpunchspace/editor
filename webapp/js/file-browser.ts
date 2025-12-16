// File Browser for in-browser memfs
// Shows the Pyodide file system in view 3

let fileSystemCache = { currentPath: '/' };

import { createWorker, OPFSFileSystem } from 'opfs-worker';

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

async function openFont(path: string) {
    if (!window.pyodide) {
        alert('Python not ready yet. Please wait a moment and try again.');
        return;
    }

    try {
        const startTime = performance.now();
        console.log('[FileBrowser]', `Opening font: ${path}`);
        let fs = await getOPFSRoot();
        let contents = await fs.readFile(path);

        // Ensure contents is a string
        if (contents instanceof Uint8Array) {
            contents = new TextDecoder().decode(contents);
        }

        // Determine file extension
        const extension = path.split('.').pop()?.toLowerCase() || '';
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
                    contents
                });
            });

            console.log(
                '[FileBrowser]',
                `Successfully converted ${extension} to babelfont format`
            );
        } else {
            // For .babelfont files, use contents directly
            babelfontJson = contents;
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(
            '[FileBrowser]',
            `Successfully opened font: ${path} (${duration}s)`
        );

        // Clear tracking promise (for save button compatibility)
        window._trackingInitPromise = Promise.resolve();

        // Dispatch fontLoaded event to font manager
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: path,
                    babelfontJson: babelfontJson
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

interface FileInfo {
    path: string;
    is_dir: boolean;
    size: number;
    mtime: string;
    handle?: FileSystemHandle;
}

// OPFS Root handle cache
let fs: OPFSFileSystem | null = null;

async function getOPFSRoot(): Promise<OPFSFileSystem> {
    if (!fs) {
        fs = await createWorker();
    }
    return fs;
}

async function scanDirectory(
    path: string = '/'
): Promise<Record<string, FileInfo>> {
    try {
        const fs = await getOPFSRoot();
        const dirHandle = await fs.readDir(path);
        const items: Record<string, FileInfo> = {};

        for (const dirEnt of dirHandle || []) {
            const is_dir = dirEnt.kind === 'directory';
            let size = 0;
            let mtime = '';
            let name = dirEnt.name;
            const itemPath = path === '/' ? `/${name}` : `${path}/${name}`;

            if (!is_dir) {
                let full_path =
                    path === '/' ? `/${dirEnt.name}` : `${path}/${dirEnt.name}`;
                try {
                    const stat = await fs?.stat(full_path);
                    size = stat!.size;
                    mtime = stat!.mtime;
                } catch (e) {
                    // Skip files we can't access
                    continue;
                }
            }

            items[name] = {
                path: itemPath,
                is_dir,
                size,
                mtime
            };
        }

        return items;
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error scanning directory:', error);
        return {};
    }
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
        const fs = await getOPFSRoot();
        await fs.mkdir(`${currentPath}/${folderName}`, { recursive: true });

        console.log(
            '[FileBrowser]',
            `Created folder: ${currentPath}/${folderName}`
        );

        await refreshFileSystem();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error creating folder:', error);
        alert(`Error creating folder: ${error.message}`);
    }
}

async function downloadFile(filePath: string, fileName: string) {
    try {
        // Parse the path to get directory and filename
        const pathParts = filePath.replace(/^\/+/, '').split('/');
        const fileNameFromPath = pathParts.pop() || fileName;
        const dirPath = '/' + pathParts.join('/');

        // Get the file handle
        const fs = await getOPFSRoot();
        const file = (await fs.readFile(
            filePath,
            'binary'
        )) as Uint8Array<ArrayBuffer>;

        // Create blob and download
        const fileBlob = new Blob([file], { type: 'application/octet-stream' });
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
        const fs = await getOPFSRoot();
        // Remove the item using the full path
        await fs.remove(itemPath, { recursive: isDir });

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
    let folderCount = 0;

    for (const file of files) {
        try {
            // Handle files with relative paths (from folder upload)
            // file.webkitRelativePath contains the full path including folder structure
            const relativePath = file.webkitRelativePath || file.name;
            const fullpath = currentPath + '/' + relativePath;

            // Get or create parent directories
            const fs = await getOPFSRoot();
            let contents = await file.arrayBuffer();
            await fs.writeFile(fullpath, contents);
            console.log(
                '[FileBrowser]',
                `Uploading file: ${currentPath}/${relativePath}`
            );
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

    // Clear cache
    fileSystemCache = { currentPath };

    // Reload current directory
    await navigateToPath(currentPath);

    console.log('[FileBrowser]', 'File system refreshed');
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
    try {
        console.log('[FileBrowser]', 'Initializing file browser with OPFS...');

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

        // Initialize OPFS root
        await getOPFSRoot();

        // Create /user folder if it doesn't exist
        const root = await getOPFSRoot();
        await root.mkdir('/user', { recursive: true });

        // Navigate to /user folder
        await navigateToPath('/user');
        console.log('[FileBrowser]', 'File browser initialized with OPFS');
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
window.downloadFile = downloadFile;
