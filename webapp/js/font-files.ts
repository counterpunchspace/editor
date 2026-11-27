// Opening and saving font sources: open a path from a filesystem plugin,
// Save As, the startup font named in the URL, and outside changes to a font
// opened from this computer. The launcher picks what to open.

import {
    isPartiallyLoadedFont,
    PARTIAL_FONT_SAVE_AS_MESSAGE
} from './partial-font';
import { campaignQuery } from './campaign-tags';
import { type NativeAdapter } from './file-system-adapter';
import {
    documentKeyFromUrl,
    isLaunchWindow,
    listenForLaunchedFiles,
    noteDocumentIdentity,
    openDiskDocumentFromUrl,
    showFontUnavailable,
    takeOverFromOtherWindow
} from './font-windows/font-window';
import {
    holdLoadingScreen,
    whenLoadingScreenFree
} from './font-windows/loading-hold';

/** A memory URL for a font that is not in the session should open the default
 * font. Disk and cloud URLs still tell the user the file is missing. */
export function missingFontUrlAction(
    pluginId: string
): 'default-font' | 'alert' {
    return pluginId === 'memory' ? 'default-font' : 'alert';
}
import {
    pluginRegistry,
    FilesystemPlugin,
    DiskPlugin
} from './filesystem-plugins';
import { Logger } from './logger';
const { waitForFontEditorReady } = require('./editor-startup-ready.js');
import {
    fontCompilation,
    requestOpenFontConversion,
    requestOpenFontSparse,
    type OpenFontSparseResult
} from './font-compilation';
import {
    buildLocalSparseBootstrap,
    computeLocalWorkingSetNames,
    type LocalSparseBootstrapPayload
} from './local-sparse-hydrator';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import {
    beginLoadingCursor,
    endLoadingCursor,
    withLoadingCursor
} from './loading-cursor';
import { reloadLinkedEditorWindows } from './window-buttons';
import { isLinkedPeerSnapshotSearch } from './window-sync';
import { readUrlState, updateUrlState } from './url-state';
import { TOUR_FUSTAT_PATH, TOUR_SAMPLE_TEXT } from './tour-slides';
import { shouldHandleOpenPathBeforeEditorReady } from './open-font-readiness';
import {
    fileContentsBytes,
    serializeCachedLocalFontForSourceSave,
    serializeFontForSourceSave,
    type BabelfontJsonSource,
    type GlyphsFormatVersion,
    type SourceSnapshot
} from './font-manager';
import {
    FolderSourceState,
    folderSourceFormatForPath,
    folderSourceRoot,
    hashBytes,
    readFolderSource
} from './folder-source';
import { notifyLoadingOverlayHiding } from './welcome-screen';
import {
    cancelManagedFileInternalWrite,
    consumeManagedFileInternalWritePaths,
    markManagedFileInternalWrite
} from './managed-file-events';

const console = new Logger('FontFiles');

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

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type OpenFontOptions = {
    sourcePluginOverride?: FilesystemPlugin;
};

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

async function openSourceSparseViaWorker(
    path: string,
    extension: string,
    contents: string | Uint8Array | undefined,
    packageEntries: Record<string, Uint8Array> | undefined,
    projectEntries: Record<string, Uint8Array> | undefined,
    sourcePlugin: FilesystemPlugin
): Promise<OpenFontSparseResult> {
    const shouldRetryGlyphsParse = extension === 'glyphs';
    const maxAttempts = shouldRetryGlyphsParse ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await requestOpenFontSparse({
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
                    'Transient glyphs parse failure; retrying sparse open',
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

    throw new Error('Sparse font open failed after retries');
}

async function fetchLocalSparseInitialGlyphs(
    glyphNames: string[]
): Promise<Array<Record<string, unknown>>> {
    if (glyphNames.length === 0) {
        return [];
    }
    const BATCH_SIZE = 256;
    const allGlyphs: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < glyphNames.length; offset += BATCH_SIZE) {
        const chunk = glyphNames.slice(offset, offset + BATCH_SIZE);
        const batch = await fontCompilation.requestGlyphsJsonBatch(chunk);
        if (batch.length > 0) {
            allGlyphs.push(...batch);
        }
    }
    return allGlyphs;
}

let diskFontReloadDebounceTimer: number | null = null;
const pendingDiskChangePaths = new Set<string>();
let memoryFilesystemReadyPromise: Promise<void> | null = null;

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

async function waitForPythonEnvironmentReady(): Promise<void> {
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

/**
 * Hand observed disk changes inside the current font's source to the font
 * manager, which tells external edits from Counterpunch's own saves.
 */
async function handleCurrentFontDiskChanges(
    changedPaths: string[]
): Promise<void> {
    const currentFont = window.fontManager?.currentFont;
    if (
        !changedPaths.length ||
        !currentFont ||
        currentFont.sourcePlugin.getId() !== 'disk' ||
        !changedPathsAffectCurrentFont(changedPaths, currentFont.path)
    ) {
        return;
    }
    await window.fontManager.handleExternalSourceChanges(
        changedPaths.map(normalizeObservedPath)
    );
}

/**
 * Create a file URI from plugin ID and path
 * Format: pluginId:///path/to/file
 */
function createFileUri(pluginId: string, path: string): string {
    const directUriPattern = new RegExp(`^${pluginId}:\/\/\/?`);
    let normalizedPath = directUriPattern.test(path)
        ? path.replace(directUriPattern, '')
        : path;
    normalizedPath = normalizedPath.startsWith('/')
        ? normalizedPath.slice(1)
        : normalizedPath;

    // A disk font's path is `/<name>` inside its document; the URI also
    // names the document, because browsers never reveal where files are.
    if (pluginId === 'disk') {
        const doc = (pluginRegistry.get('disk') as DiskPlugin | undefined)
            ?.document;
        if (doc) {
            return `disk:///${doc.id}/${normalizedPath}`;
        }
    }

    return `${pluginId}:///${normalizedPath}`;
}

function syncEditorFileState(fileUri: string, eventType: string): void {
    updateUrlState({ file: fileUri });
    noteDocumentIdentity(fileUri);

    if (!window.stateManager) {
        return;
    }

    const didChange = window.stateManager.editor_file !== fileUri;
    if (didChange) {
        window.stateManager.editor_file = fileUri;
        window.stateManager.recordEvent(eventType, 'FontFiles', {
            fileUri
        });
    }

    window.stateManager.syncUrlNow?.();
}

export function syncEditorFileStateFromCurrentFont(): void {
    const currentFont = window.fontManager?.currentFont;
    const pluginId = currentFont?.sourcePlugin?.getId?.();
    let path = currentFont?.path;

    if (!pluginId || !path) {
        return;
    }

    // A new font sits on Disk without a document until it is saved; it keeps
    // its `new:///` identity until then.
    if (
        pluginId === 'disk' &&
        !(pluginRegistry.get('disk') as DiskPlugin | undefined)?.document
    ) {
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
            console.warn('Post-open UI refresh failed', error);
        }
    };

    const timeoutId = window.setTimeout(() => {
        finish();
    }, 15000);

    window.addEventListener('fontReady', onFontReady);
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

    whenLoadingScreenFree(() => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (!loadingOverlay || loadingOverlay.classList.contains('hidden')) {
            return;
        }

        loadingOverlay.classList.add('hidden');
        notifyLoadingOverlayHiding();
    });
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
        options.sourcePluginOverride || pluginRegistry.getDefault()!;

    if (isCurrentFontAlreadyOpen(path, sourcePlugin)) {
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
            timelineSpanEnd(openSpan);
            return;
        }

        const pythonReadySpan = timelineSpanStart('font.open.waitForPython');
        const pythonReady = waitForPythonEnvironmentReady().finally(() => {
            timelineSpanEnd(pythonReadySpan);
        });

        const startTime = performance.now();
        console.log(`Opening font: ${path}`);
        const isReplacingOpenFont = !!window.fontManager?.currentFont;
        const sourceAdapter = sourcePlugin.getAdapter() as any;

        const directoryHandleForSource = diskDirectoryHandleOf(sourcePlugin);

        // Determine file extension
        const extension = path.split('.').pop()?.toLowerCase() || '';
        const isGlyphsPackage = extension === 'glyphspackage';
        const isUfoDirectory = extension === 'ufo';
        const isDesignspace = extension === 'designspace';

        let contents: string | Uint8Array | undefined;
        let packageEntries: Record<string, Uint8Array> | undefined;
        let projectEntries: Record<string, Uint8Array> | undefined;
        // What the source holds, recorded before conversion transfers the
        // buffers away, to tell external changes from Counterpunch's saves.
        const sourceSnapshot: SourceSnapshot = {};

        const readSpan = timelineSpanStart('font.open.readSource');
        try {
            if (isGlyphsPackage || isUfoDirectory || isDesignspace) {
                const { entries, state } = await readFolderSource(
                    sourceAdapter,
                    path,
                    isGlyphsPackage
                        ? 'glyphspackage'
                        : isUfoDirectory
                          ? 'ufo'
                          : 'designspace'
                );
                if (
                    isGlyphsPackage &&
                    (!entries['fontinfo.plist'] || !entries['order.plist'])
                ) {
                    throw new Error(
                        'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                    );
                }
                if (isGlyphsPackage) {
                    packageEntries = entries;
                } else {
                    projectEntries = entries;
                }
                sourceSnapshot.folderSource = state;
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
            if (contents !== undefined) {
                sourceSnapshot.sourceFileHash = hashBytes(
                    typeof contents === 'string'
                        ? new TextEncoder().encode(contents)
                        : contents
                );
            }
        } finally {
            timelineSpanEnd(readSpan);
        }

        let babelfontJson = '';
        let localSparse:
            | {
                  bootstrap: LocalSparseBootstrapPayload;
                  initialGlyphs: Array<Record<string, unknown>>;
              }
            | undefined;

        // For non-.babelfont local files, parse into fontc-worker's FONT_CACHE
        // and stream only the core metadata + catalog + initial working set.
        if (
            extension !== 'babelfont' &&
            sourcePluginId !== 'cloud' &&
            typeof Worker !== 'undefined'
        ) {
            const convertSpan = timelineSpanStart(
                'font.open.convertToBabelfont'
            );
            try {
                console.log(
                    `Detected ${extension} format, opening sparse via Rust worker...`
                );

                const sparseResult = await openSourceSparseViaWorker(
                    path,
                    extension,
                    contents,
                    packageEntries,
                    projectEntries,
                    sourcePlugin
                );
                const bootstrap = buildLocalSparseBootstrap(sparseResult);
                const initialText =
                    readUrlState().text ||
                    window.localStorage?.getItem('editor_text_buffer') ||
                    'Hamburgevons';
                const initialNames = bootstrap.isSparse
                    ? computeLocalWorkingSetNames(
                          bootstrap,
                          [],
                          initialText,
                          false
                      )
                    : bootstrap.glyphOrder;
                const initialGlyphs =
                    await fetchLocalSparseInitialGlyphs(initialNames);
                localSparse = { bootstrap, initialGlyphs };
            } finally {
                timelineSpanEnd(convertSpan);
            }

            console.log(
                `Successfully opened ${extension} via Rust sparse path (${localSparse.initialGlyphs.length}/${localSparse.bootstrap.glyphOrder.length} glyphs hydrated)`
            );
        } else if (extension !== 'babelfont') {
            const convertSpan = timelineSpanStart(
                'font.open.convertToBabelfont'
            );
            try {
                console.log(
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
            timelineSpanEnd(openSpan);
            return;
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`Successfully opened font: ${path} (${duration}s)`);

        // Get file handle for disk plugin
        timelineMark('font.open.fontLoadedDispatch');
        let actualFileHandle = fileHandle;
        if (
            !actualFileHandle &&
            sourcePlugin.getId() === 'disk' &&
            directoryHandleForSource
        ) {
            actualFileHandle =
                (await (sourceAdapter as NativeAdapter).getFileHandle(path)) ??
                undefined;
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
                    ...(localSparse ? { localSparse } : undefined),
                    sourcePlugin,
                    fileHandle: actualFileHandle,
                    directoryHandle: directoryHandle,
                    sourceSnapshot
                }
            })
        );

        // Update URL to reflect current file
        const pluginId = sourcePlugin.getId();
        const fileUri = createFileUri(pluginId, path);
        syncEditorFileState(fileUri, 'file_opened');
        window.stateManager?.syncUrlNow?.();

        timelineSpanEnd(openSpan);
    } catch (error: unknown) {
        timelineMark('font.open.failed');
        timelineSpanEnd(openSpan);
        console.error('Error opening font:', error);
        alert(`Error opening font: ${getErrorMessage(error)}`);
        // Reset cursor on error
        endLoadingCursor();
    }
}

/**
 * Save As into a .ufo or .glyphspackage folder: the font then lives there and
 * is saved there file by file. Saving over an existing folder replaces the
 * files the format owns and leaves anything else in it alone.
 */
async function saveCurrentFontAsFolderSource(
    currentFont: NonNullable<typeof window.fontManager.currentFont>,
    plugin: FilesystemPlugin,
    targetPath: string,
    format: NonNullable<ReturnType<typeof folderSourceFormatForPath>>,
    targetExists: boolean
): Promise<void> {
    const adapter = plugin.getAdapter();
    const root = folderSourceRoot(targetPath, format);
    const existing = targetExists
        ? (await readFolderSource(adapter, targetPath, format)).state
        : new FolderSourceState(
              format === 'designspace'
                  ? {
                        format,
                        document: targetPath
                            .slice(root.length)
                            .replace(/^\/+/, ''),
                        ufoDirs: []
                    }
                  : format,
              {}
          );
    const previous = {
        path: currentFont.path,
        sourcePlugin: currentFont.sourcePlugin,
        fileHandle: currentFont.fileHandle,
        directoryHandle: currentFont.directoryHandle,
        folderSource: currentFont.folderSource,
        sourceFileHash: currentFont.sourceFileHash
    };
    currentFont.path = targetPath;
    currentFont.sourcePlugin = plugin;
    currentFont.fileHandle = undefined;
    currentFont.directoryHandle = diskDirectoryHandleOf(plugin);
    currentFont.folderSource = existing;
    currentFont.sourceFileHash = undefined;
    currentFont.folderSaveTracker.requireFullSave();
    try {
        await currentFont.save();
    } catch (error) {
        Object.assign(currentFont, previous);
        throw error;
    }
}

/** The directory handle a Disk plugin's adapter is rooted at. */
function diskDirectoryHandleOf(
    plugin: FilesystemPlugin
): FileSystemDirectoryHandle | undefined {
    if (plugin.getId() !== 'disk') {
        return undefined;
    }
    const adapter = plugin.getAdapter() as Partial<NativeAdapter>;
    return adapter.getDirectoryHandle?.() ?? undefined;
}

/**
 * Save the current font as `path` in `plugin`'s storage; that becomes the
 * font’s home. Used by the Save As dialog.
 */
export async function saveCurrentFontAs(
    plugin: FilesystemPlugin,
    path: string,
    options: {
        exists: boolean;
        /** For a Glyphs file or package: the file format version to save in. */
        glyphsVersion?: GlyphsFormatVersion;
    }
): Promise<void> {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        return;
    }
    if (isPartiallyLoadedFont()) {
        throw new Error(PARTIAL_FONT_SAVE_AS_MESSAGE);
    }
    const previousGlyphsVersion = currentFont.glyphsSaveVersion;
    if (options.glyphsVersion) {
        // Later saves keep the version; a package changing it is written whole.
        currentFont.glyphsSaveVersion = options.glyphsVersion;
    }
    try {
        // After any location picker: Save As to every destination.
        await withLoadingCursor(() =>
            saveCurrentFontAsIn(currentFont, plugin, path, options)
        );
    } catch (error) {
        currentFont.glyphsSaveVersion = previousGlyphsVersion;
        throw error;
    }
}

async function saveCurrentFontAsIn(
    currentFont: NonNullable<typeof window.fontManager.currentFont>,
    plugin: FilesystemPlugin,
    path: string,
    options: { exists: boolean }
): Promise<void> {
    const pluginId = plugin.getId();
    const adapter = plugin.getAdapter();
    if (pluginId === 'cloud' && window.fontManager?.isLocalSparseFont?.()) {
        await window.fontManager.hydrateAllLocalGlyphs();
    }
    const targetFolderFormat = folderSourceFormatForPath(path);
    if (targetFolderFormat) {
        await saveCurrentFontAsFolderSource(
            currentFont,
            plugin,
            path,
            targetFolderFormat,
            options.exists
        );
    } else {
        const sourcePlugin = currentFont.sourcePlugin;
        const needsStripOwned =
            Boolean(sourcePlugin) &&
            sourcePlugin.getId() !== pluginId &&
            typeof sourcePlugin.stripOwnedFontData === 'function';
        let serializedFont: string | Uint8Array<ArrayBuffer>;
        if (
            pluginId !== 'cloud' &&
            !needsStripOwned &&
            window.fontManager?.isLocalSparseFont?.()
        ) {
            serializedFont = await serializeCachedLocalFontForSourceSave(path);
        } else {
            currentFont.syncJsonFromModel();
            let babelfontJson: BabelfontJsonSource =
                currentFont.babelfontJsonSource();
            if (needsStripOwned) {
                babelfontJson = JSON.stringify(
                    sourcePlugin.stripOwnedFontData!(
                        currentFont.serializedFontData()
                    )
                );
            }
            serializedFont = await serializeFontForSourceSave(
                path,
                babelfontJson,
                currentFont.glyphsSaveVersion
            );
        }
        if (pluginId === 'disk') {
            markManagedFileInternalWrite(pluginId, path);
        }
        try {
            await adapter.writeFile(path, serializedFont);
        } catch (error) {
            if (pluginId === 'disk') {
                cancelManagedFileInternalWrite(pluginId, path);
            }
            throw error;
        }

        currentFont.path = path;
        currentFont.sourcePlugin = plugin;
        currentFont.fileHandle =
            pluginId === 'disk'
                ? ((await (adapter as NativeAdapter).getFileHandle(path)) ??
                  undefined)
                : undefined;
        currentFont.directoryHandle = diskDirectoryHandleOf(plugin);
        currentFont.folderSource = undefined;
        currentFont.sourceFileHash = hashBytes(
            fileContentsBytes(serializedFont)
        );
        await plugin.afterSave({
            fontName: currentFont.name,
            glyphs: null,
            fontLevel: true
        });
        currentFont.folderSaveTracker.reset();
    }
    currentFont.needsRecompile = false;
    currentFont.hasUnsavedChanges = false;

    syncEditorFileState(createFileUri(pluginId, path), 'file_saved_as');

    await window.fontManager.updateFontDisplay();
    await window.fontManager.updateDirtyIndicator();
    window.saveButton?.updateButtonState?.();
}

/** Write `files` into `pluginId`'s storage, below `directory`. */
async function uploadFiles(
    files: File[] | FileList,
    options: { directory?: string | null; pluginId: string }
) {
    const targetPlugin = pluginRegistry.get(options.pluginId);
    if (!targetPlugin) {
        throw new Error(`Upload target plugin '${options.pluginId}' not found`);
    }
    const targetAdapter = targetPlugin.getAdapter();
    const basePath = options.directory || targetPlugin.getDefaultPath() || '/';
    const normalizedBasePath =
        basePath === '/' ? '/' : basePath.replace(/\/+$/, '') || '/';

    for (const file of files) {
        try {
            // A folder upload keeps its structure in webkitRelativePath.
            const relativePath = file.webkitRelativePath || file.name;
            const normalizedRelativePath = relativePath.replace(/^\/+/, '');
            const fullpath =
                normalizedBasePath === '/'
                    ? `/${normalizedRelativePath}`
                    : `${normalizedBasePath}/${normalizedRelativePath}`;
            const contents = await file.arrayBuffer();
            await targetAdapter.writeFile(fullpath, new Uint8Array(contents));
        } catch (error: unknown) {
            console.error(`Error uploading ${file.name}:`, error);
        }
    }
}

// Open the font the URL names, or start the way the URL asks.
document.addEventListener('DOMContentLoaded', () => {
    void ensureMemoryFilesystemReady();

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
            console.log(`URL file param detected: ${fileParam}`);
        }
    } else if (legacyPluginId && legacyPath) {
        // Fall back to legacy format
        pluginId = legacyPluginId;
        fontPath = legacyPath;
        console.log(
            `Legacy URL params detected: plugin=${pluginId}, path=${fontPath}`
        );
    }

    // A font from this computer may need the user first (access, a
    // folder): the loading screen stays up until it is open.
    const releaseStartupHold =
        isLaunchWindow() || (pluginId === 'disk' && fontPath)
            ? holdLoadingScreen()
            : () => {};

    const launched = listenForLaunchedFiles(openFont);
    if (isLaunchWindow()) {
        void launched.finally(releaseStartupHold);
        return;
    }

    (async () => {
        const applyDefaultStartupText = () => {
            if (readUrlState().text || readUrlState().sparse === true) {
                return;
            }
            if (window.stateManager) {
                window.stateManager.editor_text_buffer = TOUR_SAMPLE_TEXT;
            }
            window.glyphCanvas?.textRunEditor?.setTextBuffer?.(
                TOUR_SAMPLE_TEXT
            );
        };

        // Cold start, and every fallback when a URL font cannot be opened,
        // opens a new empty font (File → New).
        const openDefaultStartupFont = async (reason: string) => {
            if (window.fontManager?.currentFont) {
                return;
            }
            await waitForFontEditorReady();
            console.log(reason);
            await window.fontManager?.handleNewFont?.();
        };

        // `?file=memory:///user/Fustat.glyphs` is the sample-font link (the
        // website's "Try a sample font"): Regular plus the sample text, unless
        // `?text=` or `?location=` say otherwise. Playwright (`?test=true`)
        // opens Fustat as-is.
        const openMemoryUrlFontFromUrl = async (path: string) => {
            const isSampleFont =
                path === TOUR_FUSTAT_PATH && !window.isTestMode?.();
            if (!isSampleFont) {
                await openMemoryUrlFont(path);
                return;
            }
            applyDefaultStartupText();
            armDefaultStartupRegularLocation();
            await openMemoryUrlFont(path);
            applyDefaultStartupText();
        };

        try {
            if (
                isLinkedPeerSnapshotSearch(window.location.search) &&
                pluginId &&
                fontPath
            ) {
                const plugin = pluginRegistry.get(pluginId);
                window.dispatchEvent(
                    new CustomEvent('linkedWindowPeerOpen', {
                        detail: {
                            path: fontPath,
                            sourcePlugin: plugin ?? null
                        }
                    })
                );
                return;
            }

            if (pluginId === 'memory' && fontPath) {
                try {
                    await openMemoryUrlFontFromUrl(fontPath);
                    if (window.fontManager?.currentFont) {
                        return;
                    }
                } catch (error: any) {
                    const errorMessage = error?.message || String(error);
                    alert(`Error opening file from URL:\n\n${errorMessage}`);
                    console.error(
                        'Failed to open memory font from URL params:',
                        error
                    );
                    await openDefaultStartupFont(
                        'URL font inaccessible; opening a new font'
                    );
                    return;
                }
            }

            await ensureMemoryFilesystemReady();

            // The launcher reopened a font from a window it couldn't reach:
            // that window steps aside, unless it has unsaved changes.
            const documentKey = documentKeyFromUrl();
            if (
                documentKey &&
                new URLSearchParams(window.location.search).has('takeover') &&
                !(await takeOverFromOtherWindow(documentKey))
            ) {
                showFontUnavailable(
                    'This font has unsaved changes in another window',
                    'Save it there first, then click it in the launcher again.'
                );
                return;
            }

            if (pluginId === 'disk' && fontPath) {
                await openDiskDocumentFromUrl(fontPath, openFont);
                return;
            }

            // The launcher signs in and picks GitHub fonts; the window reads
            // the font straight from the repository.
            const githubPlugin =
                pluginId === 'github' ? pluginRegistry.get('github') : null;
            if (githubPlugin && fontPath) {
                try {
                    const ready = waitForUrlOpenFontReady(fontPath);
                    await openFont(fontPath, undefined, {
                        sourcePluginOverride: githubPlugin
                    });
                    await ready;
                } catch (error: unknown) {
                    console.error(
                        'Failed to open GitHub font from URL params:',
                        error
                    );
                    showFontUnavailable(
                        'This font couldn’t be opened from GitHub',
                        getErrorMessage(error)
                    );
                }
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
                            `Plugin '${pluginId}' is not available for URL param`
                        );
                    } else {
                        if (pluginId === 'cloud') {
                            // Cloud open hydrates over HTTP before the Python
                            // editor is required. Waiting for fontEditorReady
                            // here deadlocks URL/linked-window opens that also
                            // wait for a font to become current.
                            window.cloudPlugin?.setPendingSparseHydration?.(
                                readUrlState().sparse === true ||
                                    window.windowRole?.isLinkedWindow?.() ===
                                        true
                            );
                            await openFont(
                                `cloud://${fontPath.replace(/^\/+/, '')}`,
                                undefined,
                                { sourcePluginOverride: plugin }
                            );
                            openedFromUrl = true;
                            // Limits and capabilities apply from the start.
                            void window.cloudPlugin
                                ?.checkEligibility?.()
                                .catch((error: unknown) => {
                                    console.warn(
                                        'Cloud eligibility check after URL open failed:',
                                        error
                                    );
                                });
                        } else {
                            const exists = await plugin
                                .getAdapter()
                                .fileExists(fontPath);
                            if (!exists) {
                                if (
                                    missingFontUrlAction(pluginId) ===
                                    'default-font'
                                ) {
                                    console.warn(
                                        `Memory font not found: ${fontPath}; opening a new font`
                                    );
                                    await openDefaultStartupFont(
                                        'URL memory font missing'
                                    );
                                    return;
                                }
                                alert(
                                    `Error: File not found at "${fontPath}" in "${plugin.getName()}" plugin.\n\nThe requested file does not exist or is not accessible.`
                                );
                                console.error(`File not found: ${fontPath}`);
                            } else {
                                const urlOpenReadyPromise =
                                    waitForUrlOpenFontReady(fontPath);
                                await openFont(fontPath, undefined, {
                                    sourcePluginOverride: plugin
                                });
                                await urlOpenReadyPromise;
                                openedFromUrl = true;
                            }
                        }
                    }
                } catch (error: any) {
                    const errorMessage = error?.message || String(error);
                    (
                        window as Window & {
                            __urlFontOpenError?: string;
                        }
                    ).__urlFontOpenError = errorMessage;
                    console.error(
                        'Failed to open font from URL params:',
                        error
                    );
                    if (!window.isTestMode?.()) {
                        alert(
                            `Error opening file from URL:\n\n${errorMessage}`
                        );
                    }
                }

                if (openedFromUrl || window.fontManager?.currentFont) {
                    return;
                }

                if (pluginId === 'cloud' && window.isTestMode?.()) {
                    return;
                }

                // URL pointed at an inaccessible file — keep the alert above,
                // then open the same default sample font as a cold start.
                await openDefaultStartupFont(
                    'URL font inaccessible; opening a new font'
                );
                return;
            }

            // A new font (File → New, the launcher's New font). Tests start
            // with one too.
            if (
                new URLSearchParams(window.location.search).has('new') ||
                window.isTestMode?.()
            ) {
                await openDefaultStartupFont('Starting a new font');
                return;
            }

            // No font asked for: this window becomes the launcher, keeping
            // the campaign it was opened with.
            window.location.replace(`launcher.html${campaignQuery()}`);
        } catch (error: any) {
            console.error('Failed during startup font open:', error);
            try {
                await openDefaultStartupFont(
                    'Startup font open failed; opening a new font'
                );
            } catch (fallbackError) {
                console.error(
                    'Failed to open default startup font:',
                    fallbackError
                );
            }
        } finally {
            releaseStartupHold();
        }
    })();
});

// A font opened from this computer follows outside changes to its files.
window.addEventListener('diskFilesChanged', (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    const changedPaths = extractChangedPathsFromRecords(detail.records || []);

    const internallyWrittenPaths = new Set(
        consumeManagedFileInternalWritePaths('disk', changedPaths)
    );
    const reloadablePaths = changedPaths.filter(
        (path) => !internallyWrittenPaths.has(path)
    );

    // Debounced, targeted by the changed paths.
    for (const changedPath of reloadablePaths) {
        pendingDiskChangePaths.add(changedPath);
    }
    if (diskFontReloadDebounceTimer !== null) {
        window.clearTimeout(diskFontReloadDebounceTimer);
    }
    diskFontReloadDebounceTimer = window.setTimeout(() => {
        diskFontReloadDebounceTimer = null;
        const pathsToProcess = Array.from(pendingDiskChangePaths);
        pendingDiskChangePaths.clear();
        void handleCurrentFontDiskChanges(pathsToProcess);
    }, 400);
});

// fontReady fires after fontManager.loadFont completes and currentFont is set.
window.addEventListener('fontReady', () => {
    const fontReadyFileStateSpanId = timelineSpanStart(
        'fontFiles.fontReadySync'
    );
    try {
        syncEditorFileStateFromCurrentFont();
    } finally {
        timelineSpanEnd(fontReadyFileStateSpanId);
    }
});

window.addEventListener('cloudAssetLocalizedToMemory', () => {
    syncEditorFileStateFromCurrentFont();
});

window.uploadFiles = uploadFiles;
window.openFont = openFont;
(window as any).parseFileUri = parseFileUri;
(window as any).pluginRegistry = pluginRegistry;
