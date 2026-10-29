import {
    awaitStableWorkerState,
    fontCompilation,
    fullFontCompilation
} from './font-compilation';
import { seedCompilerFromCommittedFont } from './committed-font-seed';
import { del, get, set } from 'idb-keyval';
import { fontDestinationPluginManager } from './font-destination-plugin-manager';
import { prepareCompileFilters } from './compile-filter-host';
import { Logger } from './logger';
import { showProceedDialog } from './ui/confirm-dialog';

const console = new Logger('BinaryFontExport');

type SaveFilePickerOptions = {
    suggestedName: string;
    types: Array<{
        description: string;
        accept: Record<string, string[]>;
    }>;
};

type SaveFilePickerWindow = Window & {
    showSaveFilePicker?: (
        options: SaveFilePickerOptions
    ) => Promise<FileSystemFileHandle>;
};

type ExportedBinaryFontMetadata = {
    byteLength: number;
    changeVersion: number;
    filename: string;
    format: 'ttf';
    mimeType: 'font/ttf';
    timeTakenMs: number;
};

type CurrentFont = {
    changeVersion: number;
    path?: string;
    sourcePlugin?: {
        getId?: () => string;
    };
} & object;

type WritableFileSystemHandle = FileSystemFileHandle & {
    queryPermission?: (options: {
        mode: 'readwrite';
    }) => Promise<PermissionState>;
    requestPermission?: (options: {
        mode: 'readwrite';
    }) => Promise<PermissionState>;
};

let destination: {
    storageKey: string | null;
    handle: FileSystemFileHandle;
} | null = null;
let exportInProgress = false;
let exportFeedbackReset: (() => void) | null = null;

/** Return the active font or stop export before it touches the file system. */
function getCurrentFont(): CurrentFont {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        throw new Error('Open a font before exporting a binary font.');
    }
    return currentFont;
}

function getSuggestedFilename(path: string | undefined): string {
    const sourceName = path?.split('/').pop() || 'font';
    const dotIndex = sourceName.lastIndexOf('.');
    const baseName = dotIndex > 0 ? sourceName.slice(0, dotIndex) : sourceName;
    return `${baseName || 'font'}.ttf`;
}

/** Build the stable plugin-qualified URI used to retain an export destination. */
function getExportDestinationStorageKey(
    currentFont: CurrentFont
): string | null {
    const pluginId = currentFont.sourcePlugin?.getId?.();
    if (!pluginId || !currentFont.path) {
        return null;
    }

    const pluginPrefix = `${pluginId}://`;
    const sourcePath = currentFont.path.startsWith(pluginPrefix)
        ? currentFont.path.slice(pluginPrefix.length)
        : currentFont.path;
    return `${pluginId}:///${sourcePath.replace(/^\/+/, '')}`;
}

/** Check or request permission before reusing a restored destination handle. */
async function canWriteToDestination(
    handle: FileSystemFileHandle
): Promise<boolean> {
    const writableHandle = handle as WritableFileSystemHandle;
    if (!writableHandle.queryPermission || !writableHandle.requestPermission) {
        return true;
    }

    const permission = await writableHandle.queryPermission({
        mode: 'readwrite'
    });
    if (permission === 'granted') {
        return true;
    }

    return (
        (await writableHandle.requestPermission({ mode: 'readwrite' })) ===
        'granted'
    );
}

/** Remove an unusable cached destination from memory and durable storage. */
async function forgetExportDestination(
    storageKey: string | null
): Promise<void> {
    if (destination?.storageKey === storageKey) {
        destination = null;
    }
    if (!storageKey) {
        return;
    }

    try {
        await del(storageKey);
    } catch (error: unknown) {
        console.warn(
            'Could not clear export destination:',
            getErrorMessage(error)
        );
    }
}

/** Cache a successful destination in memory and retain its handle across reloads. */
async function rememberExportDestination(
    storageKey: string | null,
    handle: FileSystemFileHandle
): Promise<void> {
    destination = { storageKey, handle };
    if (!storageKey) {
        return;
    }

    try {
        await set(storageKey, handle);
    } catch (error: unknown) {
        console.warn(
            'Could not persist export destination:',
            getErrorMessage(error)
        );
    }
}

/** Restore the cached destination for the active source URI when it remains writable. */
async function getExportDestinationForFont(
    currentFont: CurrentFont
): Promise<FileSystemFileHandle | null> {
    const storageKey = getExportDestinationStorageKey(currentFont);
    if (destination?.storageKey === storageKey) {
        return destination.handle;
    }
    destination = null;

    if (!storageKey) {
        return null;
    }

    try {
        const handle = await get<FileSystemFileHandle>(storageKey);
        if (!handle) {
            return null;
        }
        if (!(await canWriteToDestination(handle))) {
            await forgetExportDestination(storageKey);
            return null;
        }

        destination = { storageKey, handle };
        return handle;
    } catch (error: unknown) {
        console.warn(
            'Could not restore export destination:',
            getErrorMessage(error)
        );
        return null;
    }
}

async function chooseDestination(
    suggestedName: string
): Promise<FileSystemFileHandle | null> {
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (!picker) {
        throw new Error(
            'Binary font export requires a browser with the File System Access API.'
        );
    }

    try {
        return await picker({
            suggestedName,
            types: [
                {
                    description: 'TrueType font',
                    accept: { 'font/ttf': ['.ttf'] }
                }
            ]
        });
    } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

async function compileFullFont(): Promise<{
    bytes: Uint8Array;
    filename: string;
    timeTakenMs: number;
}> {
    const fontManager = window.fontManager;
    const currentFont = getCurrentFont();

    await awaitStableWorkerState(
        {
            awaitWorkerDocumentSync: () =>
                fontCompilation.awaitWorkerDocumentSync(),
            hasWorkerCacheDocument: () =>
                fontCompilation.hasWorkerCacheDocument(),
            getWorkerCacheUpdatePromise: () =>
                fontManager.workerCacheUpdatePromise,
            getFontRevisionKey: () =>
                `${currentFont.path ?? ''}\u0000${currentFont.changeVersion}`
        },
        {
            unavailable:
                'Binary font export is unavailable until the compiler worker is ready.',
            notReady:
                'Binary font export requires the current font to finish synchronizing to the compiler worker.',
            unstable:
                'Binary font export could not stabilize the current font revision. Retry after editing settles.'
        }
    );

    await seedCompilerFromCommittedFont(fontManager, fullFontCompilation, {
        unavailable:
            'Binary font export is unavailable until the compiler worker is ready.',
        noSnapshot:
            'Binary font export could not snapshot the committed font state.'
    });
    const compileFilters = await prepareCompileFilters(null);
    if (compileFilters.layerUpdates.length > 0) {
        await fullFontCompilation.sendMessage({
            type: 'applyPreviewLayerOverlay',
            layerUpdates: compileFilters.layerUpdates,
            changedGlyphs: compileFilters.layerUpdates.map(
                (update) => update.glyphName
            ),
            nonGlyphChangeHints: [],
            invalidateLayoutClosure: true
        });
    }
    fullFontCompilation.setCompileFeatureOverlay(compileFilters.features || '');

    const filename = getSuggestedFilename(currentFont.path);
    const compiled = await fullFontCompilation.compileCached('user', filename);
    return {
        bytes: compiled.result,
        filename: compiled.filename || filename,
        timeTakenMs: compiled.time_taken
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getDirtyIndicator(): HTMLElement | null {
    return document.getElementById('file-dirty-indicator');
}

function beginExportFeedback(): (() => void) | null {
    const dirtyIndicator = getDirtyIndicator();
    if (!dirtyIndicator) {
        return null;
    }

    const wasVisible = dirtyIndicator.classList.contains('visible');
    dirtyIndicator.classList.add('visible', 'exporting');

    return () => {
        dirtyIndicator.classList.remove('exporting');
        if (!wasVisible) {
            dirtyIndicator.classList.remove('visible');
        }
    };
}

/**
 * Block an export with no glyphs and let the user decide on a partial one.
 * Sparse cloud sessions compile only the glyphs they have loaded.
 */
async function confirmExportableGlyphs(): Promise<boolean> {
    const { resident, total } = window.fontManager.getGlyphResidency();
    if (resident === 0) {
        throw new Error('The font has no glyphs to export.');
    }
    if (resident >= total) {
        return true;
    }
    return showProceedDialog(
        'Export partial font',
        `Only ${resident} of ${total} glyphs are loaded in this session. The exported font will contain just these glyphs.`
    );
}

async function runBinaryFontExport(
    alwaysChooseDestination: boolean
): Promise<void> {
    if (exportInProgress) {
        return;
    }

    exportInProgress = true;
    exportFeedbackReset?.();
    exportFeedbackReset = beginExportFeedback();
    try {
        const currentFont = getCurrentFont();
        if (!(await confirmExportableGlyphs())) {
            return;
        }
        const storageKey = getExportDestinationStorageKey(currentFont);
        const previousDestination = alwaysChooseDestination
            ? null
            : await getExportDestinationForFont(currentFont);
        const handle = previousDestination
            ? previousDestination
            : await chooseDestination(getSuggestedFilename(currentFont.path));
        if (!handle) {
            return;
        }

        const compiled = await compileFullFont();
        try {
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array(compiled.bytes).buffer);
            await writable.close();
        } catch (error: unknown) {
            if (previousDestination) {
                await forgetExportDestination(storageKey);
            }
            throw error;
        }

        await rememberExportDestination(storageKey, handle);

        const metadata: ExportedBinaryFontMetadata = {
            byteLength: compiled.bytes.byteLength,
            changeVersion: currentFont.changeVersion,
            filename: handle.name || compiled.filename,
            format: 'ttf',
            mimeType: 'font/ttf',
            timeTakenMs: compiled.timeTakenMs
        };
        const messageBytes = compiled.bytes.slice();
        window.postMessage(
            {
                type: 'counterpunch:binary-font-exported',
                version: 1,
                bytes: messageBytes.buffer,
                metadata
            },
            window.location.origin,
            [messageBytes.buffer]
        );
        fontDestinationPluginManager.deliverExportedFont(
            compiled.bytes,
            metadata
        );
        console.log('Exported binary font:', metadata.filename);
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error('Binary font export failed:', message);
        window.alert(`Unable to export binary font: ${message}`);
    } finally {
        exportFeedbackReset?.();
        exportFeedbackReset = null;
        exportInProgress = false;
    }
}

export function exportBinaryFont(): Promise<void> {
    return runBinaryFontExport(false);
}

export function exportBinaryFontAs(): Promise<void> {
    return runBinaryFontExport(true);
}
