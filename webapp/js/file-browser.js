// File Browser for in-browser memfs
// Shows the Pyodide file system in view 3

let fileSystemCache = {};

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(filename, isDir) {
    if (isDir) return '📁';

    const ext = filename.split('.').pop().toLowerCase();
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

function getFileClass(filename, isDir) {
    if (isDir) return 'directory';

    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'py') return 'python-file';
    return 'file';
}

function isSupportedFontFormat(name, isDir) {
    // Check if it's a .babelfont file (JSON format, not a folder)
    if (!isDir && name.endsWith('.babelfont')) {
        return true;
    }
    return false;
}

async function openFont(path) {
    if (!window.pyodide) {
        alert('Python not ready yet. Please wait a moment and try again.');
        return;
    }

    try {
        const startTime = performance.now();
        console.log(`Opening font: ${path}`);

        // Call Python's OpenFont function (loads font quickly)
        const fontData = await window.pyodide.runPythonAsync(`
import time
import json
start_time = time.time()
font = OpenFont('${path}')
# Try to get font name from font.names.familyName['dflt']
font_name = 'Untitled'
if hasattr(font, 'names') and hasattr(font.names, 'familyName') and isinstance(font.names.familyName, dict) and 'dflt' in font.names.familyName:
    font_name = font.names.familyName['dflt']
duration = time.time() - start_time
print(f"✅ Font loaded: {font_name} ({duration:.2f}s)")
print("⏳ Initializing dirty tracking...")

# Get the current font ID for tracking init
font_id = GetCurrentFontId()
json.dumps({"font_name": font_name, "font_id": font_id, "load_time": duration})
        `);

        const data = JSON.parse(fontData);
        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`Successfully opened font: ${path} (${duration}s)`);

        // Initialize dirty tracking synchronously (blocks UI, but simpler)
        console.log('⏳ Initializing dirty tracking...');
        const trackingStart = performance.now();

        try {
            const resultJson = await window.pyodide.runPythonAsync(`
import json
result = InitializeTracking('${data.font_id}')
json.dumps(result)
`);

            const result = JSON.parse(resultJson);

            if (result.error) {
                console.error(`Error initializing tracking: ${result.error}`);
            }
        } catch (error) {
            console.error('Error initializing tracking:', error);
        }

        const trackingEnd = performance.now();
        const trackingDuration = ((trackingEnd - trackingStart) / 1000).toFixed(
            2
        );
        console.log(`✅ Dirty tracking ready (${trackingDuration}s)`);

        // Update the font dropdown and dirty indicator
        if (window.fontDropdownManager) {
            await window.fontDropdownManager.updateDropdown();
            if (window.saveButton) {
                window.saveButton.updateButtonState();
            }
            if (window.compileFontButton) {
                window.compileFontButton.updateState();
            }
            await window.fontDropdownManager.updateDirtyIndicator();
        }

        // Clear tracking promise (for save button compatibility)
        window._trackingInitPromise = Promise.resolve();

        // Dispatch fontLoaded event
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: { fontId: data.font_id, path }
            })
        );

        // Play done sound
        if (window.playSound) {
            window.playSound('done');
        }
    } catch (error) {
        console.error('Error opening font:', error);
        alert(`Error opening font: ${error.message}`);
    }
}

async function scanDirectory(path = '/') {
    if (!window.pyodide) {
        console.error('Pyodide not available');
        return {};
    }

    try {
        const result = await window.pyodide.runPython(`
import os
import json

def scan_directory(path='/'):
    items = {}
    try:
        if not os.path.exists(path):
            return items
            
        for item in sorted(os.listdir(path)):
            item_path = os.path.join(path, item)
            try:
                stat = os.stat(item_path)
                is_dir = os.path.isdir(item_path)
                items[item] = {
                    'path': item_path,
                    'is_dir': is_dir,
                    'size': stat.st_size if not is_dir else 0,
                    'mtime': stat.st_mtime
                }
            except (OSError, IOError) as e:
                # Skip items we can't access
                continue
    except (OSError, IOError) as e:
        # Skip directories we can't access
        pass
    
    return items

json.dumps(scan_directory('${path}'))
        `);

        return JSON.parse(result);
    } catch (error) {
        console.error('Error scanning directory:', error);
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
        await window.pyodide.runPython(`
import os
path = '${currentPath}/${folderName}'
os.makedirs(path, exist_ok=True)
        `);

        console.log(`Created folder: ${currentPath}/${folderName}`);

        await refreshFileSystem();
    } catch (error) {
        console.error('Error creating folder:', error);
        alert(`Error creating folder: ${error.message}`);
    }
}

async function downloadFile(filePath, fileName) {
    try {
        // Read file from Pyodide filesystem
        const fileData = window.pyodide.FS.readFile(filePath);

        // Create blob and download
        const blob = new Blob([fileData]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        console.log(`Downloaded: ${fileName}`);

        if (window.term) {
            window.term.echo(`[[;lime;]📥 Downloaded: ${fileName}]`);
        }
    } catch (error) {
        console.error('Error downloading file:', error);
        alert(`Error downloading file: ${error.message}`);
    }
}

async function deleteItem(itemPath, itemName, isDir) {
    const confirmMsg = isDir
        ? `Delete folder "${itemName}" and all its contents?`
        : `Delete file "${itemName}"?`;

    if (!confirm(confirmMsg)) return;

    try {
        await window.pyodide.runPython(`
import os
import shutil

path = '${itemPath}'
if os.path.isdir(path):
    shutil.rmtree(path)
else:
    os.remove(path)
        `);

        console.log(`Deleted: ${itemPath}`);

        await refreshFileSystem();
    } catch (error) {
        console.error('Error deleting item:', error);
        alert(`Error deleting item: ${error.message}`);
    }
}

async function uploadFiles(files) {
    const startTime = performance.now();
    const currentPath = fileSystemCache.currentPath || '/';
    let uploadedCount = 0;
    let folderCount = 0;

    for (const file of files) {
        try {
            const content = await file.arrayBuffer();
            const uint8Array = new Uint8Array(content);

            // Handle files with relative paths (from folder upload)
            // file.webkitRelativePath contains the full path including folder structure
            const relativePath = file.webkitRelativePath || file.name;
            const fullPath = `${currentPath}/${relativePath}`;

            // Create all parent directories
            await window.pyodide.runPython(`
import os
path = '${fullPath}'
parent_dir = os.path.dirname(path)
if parent_dir:
    os.makedirs(parent_dir, exist_ok=True)
            `);

            // Write file to Pyodide filesystem
            window.pyodide.FS.writeFile(fullPath, uint8Array);
            uploadedCount++;

            // Count unique folders created
            const pathParts = relativePath.split('/');
            if (pathParts.length > 1) {
                folderCount = Math.max(folderCount, pathParts.length - 1);
            }
        } catch (error) {
            console.error(`Error uploading ${file.name}:`, error);
        }
    }

    if (uploadedCount > 0) {
        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        if (folderCount > 0) {
            await window.pyodide.runPythonAsync(
                `print("Uploaded ${uploadedCount} file(s) with folder structure preserved in ${duration} seconds")`
            );
        } else {
            await window.pyodide.runPythonAsync(
                `print("Uploaded ${uploadedCount} file(s) in ${duration} seconds")`
            );
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

    // Toolbar with actions
    html += `<div class="file-toolbar">
        <button onclick="createFolder()" class="file-action-btn" title="Create new folder">
            📁 New Folder
        </button>
        <button onclick="document.getElementById('file-upload-input').click()" class="file-action-btn" title="Upload files">
            📤 Upload Files
        </button>
        <button onclick="document.getElementById('folder-upload-input').click()" class="file-action-btn" title="Upload folder with structure">
            📂 Upload Folder
        </button>
        <button onclick="refreshFileSystem()" class="file-action-btn" title="Refresh">
            🔄 Refresh
        </button>
    </div>
    <input type="file" id="file-upload-input" multiple style="display: none;" 
           onchange="handleFileUpload(event)">
    <input type="file" id="folder-upload-input" webkitdirectory directory multiple style="display: none;" 
           onchange="handleFileUpload(event)">`;

    if (rootPath !== '/') {
        const parentPath =
            rootPath.substring(0, rootPath.lastIndexOf('/')) || '/';
        html += `<div class="file-item directory" onclick="navigateToPath('${parentPath}')">
            📁 .. (parent directory)
        </div>`;
    }

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
            ? `<button class="download-btn" onclick="event.stopPropagation(); downloadFile('${data.path}', '${name}')" title="Download">💾</button>`
            : '';

        const deleteBtn = `<button class="delete-btn" onclick="event.stopPropagation(); deleteItem('${data.path}', '${name}', ${data.is_dir})" title="Delete">🗑️</button>`;

        // Add "Open" button for supported font formats
        const isSupported = isSupportedFontFormat(name, data.is_dir);
        const openBtn = isSupported
            ? `<button class="open-font-btn" onclick="event.stopPropagation(); openFont('${data.path}')" title="Open font">📂 Open</button>`
            : '';

        html += `<div class="file-item ${fileClass}" onclick="${clickHandler}">
            <span class="file-name">${icon} ${name}</span>${sizeText}${openBtn}${downloadBtn}${deleteBtn}
        </div>`;
    }

    return html;
}

function handleFileUpload(event) {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
        uploadFiles(files);
    }
    // Reset input so same file can be uploaded again
    event.target.value = '';
}

async function navigateToPath(path) {
    try {
        const fileTree = document.getElementById('file-tree');
        fileTree.innerHTML = '<div style="color: #888;">Loading...</div>';

        const html = await buildFileTree(path);
        fileTree.innerHTML = `
            <div class="file-path">Current path: ${path}</div>
            ${html}
        `;

        // Cache the current path
        fileSystemCache.currentPath = path;

        // Setup drag & drop on the file tree
        setupDragAndDrop();
    } catch (error) {
        console.error('Error navigating to path:', error);
        document.getElementById('file-tree').innerHTML = `
            <div style="color: #ff3300;">Error loading directory: ${error.message}</div>
        `;
    }
}

function setupDragAndDrop() {
    const fileTree = document.getElementById('file-tree');

    fileTree.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileTree.classList.add('drag-over');
    });

    fileTree.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileTree.classList.remove('drag-over');
    });

    fileTree.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileTree.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            await uploadFiles(files);
        }
    });
}

function selectFile(filePath) {
    console.log('Selected file:', filePath);
    // TODO: Add file selection handling (e.g., show content, download, etc.)
}

async function refreshFileSystem() {
    const currentPath = fileSystemCache.currentPath || '/';
    console.log('Refreshing file system...');

    // Clear cache
    fileSystemCache = { currentPath };

    // Reload current directory
    await navigateToPath(currentPath);

    console.log('File system refreshed');
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
    try {
        if (!window.pyodide) {
            setTimeout(initFileBrowser, 500);
            return;
        }

        console.log('Initializing file browser...');

        // Create /user folder if it doesn't exist
        await window.pyodide.runPython(`
import os
if not os.path.exists('/user'):
    os.makedirs('/user')
        `);

        // Navigate to /user folder
        await navigateToPath('/user');
        console.log('File browser initialized');
    } catch (error) {
        console.error('Error initializing file browser:', error);
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
