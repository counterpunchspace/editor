// File → Save As: name, format and where to save. "This computer" asks for
// the place with the system pickers; Cloud and Browser storage save by name.

import { Logger } from '../logger';
import { pluginRegistry } from '../filesystem-plugins/registry';
import type { DiskPlugin } from '../filesystem-plugins/plugins/disk-plugin';
import type { FilesystemPlugin } from '../filesystem-plugins/filesystem-plugin';
import {
    saveCurrentFontAs,
    syncEditorFileStateFromCurrentFont
} from '../file-browser';
import {
    FONT_FORMATS,
    baseNameOf,
    fontFormatKind,
    fontFormatOf,
    splitFontFileName,
    type FontFormatKey
} from './font-formats';
import {
    rememberFolder,
    upsertDiskDocument,
    type DiskDocument
} from './document-store';
import { diskDocumentKey } from './disk-documents';
import {
    isAbortError,
    showDirectoryPicker,
    showSaveFilePicker,
    supportsFileAccess
} from './file-access';
import { documentOpenState } from './window-registry';
import {
    CLOUD_UNREACHABLE_NOTE,
    chooseSaveDestination,
    cloudEligibilityRefusal,
    cloudStateWithWarning,
    type CloudSaveEligibility,
    type CloudSaveWarning,
    type CloudState,
    type SaveDestination
} from './save-destination';
import { escapeHtml, icon, openDialog, reportError } from './dialogs';
import {
    glyphsFormatVersionOf,
    type GlyphsFormatVersion
} from '../font-manager';

const console = new Logger('FontWindows');

/**
 * The last destination and format a new font was saved with.
 * Values: `disk` | `cloud` | `browser`, and a format key such as `glyphs`.
 */
const LAST_DESTINATION_KEY = 'saveAsLastDestination';
const LAST_FORMAT_KEY = 'saveAsLastFormat';
/** The Glyphs file format version last saved in: `3` or `4`. */
const LAST_GLYPHS_VERSION_KEY = 'saveAsLastGlyphsVersion';

/** The formats with a Glyphs file format version to choose. */
function isGlyphsFormat(format: FontFormatKey): boolean {
    return format === 'glyphs' || format === 'glyphspackage';
}

/**
 * The Glyphs version to offer: the one the font saves in, else the one
 * last chosen, else Glyphs 3, which both Glyphs 3 and 4 open.
 */
function defaultGlyphsVersion(): GlyphsFormatVersion {
    const font = window.fontManager?.currentFont;
    const own =
        font?.glyphsSaveVersion ?? glyphsFormatVersionOf(font?.babelfontData);
    if (own) return own;
    return readSetting(LAST_GLYPHS_VERSION_KEY) === '4' ? 4 : 3;
}

const WRITABLE_FORMATS = (Object.keys(FONT_FORMATS) as FontFormatKey[]).filter(
    (key) => FONT_FORMATS[key].writable
);

function readSetting(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSetting(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be unavailable; the defaults still work.
    }
}

function plugin<T extends FilesystemPlugin>(id: string): T | null {
    const found = pluginRegistry.get(id);
    return found && found.getId() === id ? (found as T) : null;
}

type CloudPluginLike = FilesystemPlugin & {
    handleSaveAs(name: string): Promise<boolean>;
    checkEligibility?: (options?: {
        fresh?: boolean;
    }) => Promise<CloudSaveEligibility | null>;
    getSaveAsBlocker?: () => Promise<{ note: string; title: string } | null>;
    getCurrentSaveAsWarningState?: () => Promise<CloudSaveWarning | null>;
};

/**
 * Whether the cloud can take this font, the same rules as the editor's.
 * Every reason a cloud save would be refused is found here, so the Cloud
 * choice is disabled before the user picks it.
 */
async function cloudState(): Promise<CloudState> {
    const cloud = plugin<CloudPluginLike>('cloud');
    if (!cloud || !cloud.isVisibleInUI()) {
        return { available: false, note: 'Not available in this version' };
    }
    const auth = window.authManager;
    if (navigator.onLine === false) {
        return { available: false, note: 'You’re offline' };
    }
    if (!auth?.isAuthenticated?.()) {
        return auth?.lastAuthCheckUnreachable
            ? { available: false, note: CLOUD_UNREACHABLE_NOTE }
            : { available: false, note: 'Log in to save to the cloud' };
    }
    // Fresh: the number of fonts owned changes with every save and delete.
    const eligibility = await cloud
        .checkEligibility?.({ fresh: true })
        .catch(() => null);
    const refused = cloudEligibilityRefusal(eligibility ?? null);
    if (refused) return refused;
    const blocker = await cloud.getSaveAsBlocker?.().catch(() => null);
    if (blocker) {
        return { available: false, note: blocker.note, blocked: blocker.title };
    }
    try {
        const warning = await cloud.getCurrentSaveAsWarningState?.();
        return cloudStateWithWarning(eligibility ?? null, warning ?? null);
    } catch (error) {
        // The save reads the font the same way and would fail the same way.
        console.warn('Cloud save check failed', error);
        return {
            available: false,
            note: 'This font can’t be saved to the cloud',
            blocked: error instanceof Error ? error.message : String(error)
        };
    }
}

function currentDestination(): SaveDestination | null {
    const id = window.fontManager?.currentFont?.sourcePlugin?.getId?.();
    if (id === 'disk') return 'disk';
    if (id === 'cloud') return 'cloud';
    if (id === 'memory') return 'browser';
    return null;
}

function defaultDestination(cloud: CloudState): SaveDestination {
    return chooseSaveDestination(
        currentDestination(),
        readSetting(LAST_DESTINATION_KEY),
        {
            fileAccess: supportsFileAccess,
            cloud: cloud.available
        }
    );
}

function defaultNameAndFormat(): { name: string; format: FontFormatKey } {
    const font = window.fontManager?.currentFont;
    // A new font only has a placeholder path until it is saved.
    const isNew =
        window.counterpunchWindows?.documentKey?.startsWith('new:///');
    const fileName = isNew ? '' : (font?.path?.split('/').pop() ?? '');
    const format = fontFormatOf(fileName);
    if (format && FONT_FORMATS[format].writable) {
        return { name: baseNameOf(fileName), format };
    }
    const last = readSetting(LAST_FORMAT_KEY) as FontFormatKey | null;
    return {
        name: font?.name || 'Untitled',
        format: last && WRITABLE_FORMATS.includes(last) ? last : 'glyphs'
    };
}

// --- Saving -------------------------------------------------------------

/** Ask where on this computer to save; returns the font's new document. */
async function chooseDiskLocation(
    fileName: string,
    format: FontFormatKey
): Promise<{ doc: DiskDocument; exists: boolean }> {
    const startIn = (diskPlugin()?.document?.parent ??
        diskPlugin()?.document?.handle ??
        'documents') as FileSystemHandle | 'documents';
    if (fontFormatKind(format) === 'file') {
        const { ext, label } = FONT_FORMATS[format];
        const handle = await showSaveFilePicker({
            id: 'cp-save',
            suggestedName: fileName,
            startIn,
            types: [
                {
                    description: label,
                    accept: { 'application/octet-stream': [ext] }
                }
            ]
        });
        const doc = await upsertDiskDocument({
            name: handle.name,
            format: fontFormatOf(handle.name) ?? format,
            handle
        });
        return { doc, exists: false };
    }
    // Packages and .designspace: there is no "save a folder" picker, so the
    // user picks the folder to save into and the font is created inside.
    const folder = await showDirectoryPicker({
        id: 'cp-save',
        mode: 'readwrite',
        startIn
    });
    await rememberFolder(folder);
    const isPackage = fontFormatKind(format) === 'package';
    const exists = await entryExists(folder, fileName, isPackage);
    if (
        exists &&
        !confirm(
            `“${fileName}” already exists in “${folder.name}”. Replace it?`
        )
    ) {
        throw new DOMException('Replace declined', 'AbortError');
    }
    const handle = isPackage
        ? await folder.getDirectoryHandle(fileName, { create: true })
        : await folder.getFileHandle(fileName, { create: true });
    const doc = await upsertDiskDocument({
        name: fileName,
        format,
        handle,
        parent: folder
    });
    return { doc, exists };
}

async function entryExists(
    folder: FileSystemDirectoryHandle,
    name: string,
    isDirectory: boolean
): Promise<boolean> {
    try {
        if (isDirectory) await folder.getDirectoryHandle(name);
        else await folder.getFileHandle(name);
        return true;
    } catch {
        return false;
    }
}

function diskPlugin(): DiskPlugin | null {
    return plugin<DiskPlugin>('disk');
}

function ensureNotOpenElsewhere(key: string, name: string): void {
    const own = window.counterpunchWindows?.documentKey;
    if (key !== own && documentOpenState(key)) {
        throw new Error(
            `${name} is open in another window. Close it there first, or save under a different name.`
        );
    }
}

async function saveToDisk(
    fileName: string,
    format: FontFormatKey,
    glyphsVersion: GlyphsFormatVersion | undefined
): Promise<void> {
    const disk = diskPlugin();
    if (!disk) throw new Error('Saving to this computer is not available.');
    const { doc, exists } = await chooseDiskLocation(fileName, format);
    ensureNotOpenElsewhere(diskDocumentKey(doc), doc.name);
    const previous = disk.document;
    disk.attachDocument(doc);
    try {
        await saveCurrentFontAs(disk, `/${doc.name}`, {
            exists,
            glyphsVersion
        });
    } catch (error) {
        if (previous) disk.attachDocument(previous);
        else disk.detachDocument();
        throw error;
    }
}

async function saveToBrowser(
    fileName: string,
    glyphsVersion: GlyphsFormatVersion | undefined
): Promise<void> {
    const memory = plugin<FilesystemPlugin>('memory');
    if (!memory) throw new Error('Browser storage is not available.');
    const path = `/user/${fileName}`;
    const key = `memory://${path}`;
    ensureNotOpenElsewhere(key, fileName);
    const exists = await memory.getAdapter().fileExists(path);
    if (
        exists &&
        !confirm(`“${fileName}” already exists in browser storage. Replace it?`)
    ) {
        throw new DOMException('Replace declined', 'AbortError');
    }
    await saveCurrentFontAs(memory, path, { exists, glyphsVersion });
}

async function saveToCloud(name: string): Promise<boolean> {
    const cloud = plugin<CloudPluginLike>('cloud');
    if (!cloud) throw new Error('The cloud is not available.');
    const saved = await cloud.handleSaveAs(name);
    if (saved) syncEditorFileStateFromCurrentFont();
    return saved;
}

// --- The dialog ---------------------------------------------------------

let open = false;

/** Show the Save As dialog for the current font. */
export async function showSaveAsDialog(
    options: { destination?: SaveDestination } = {}
): Promise<void> {
    const font = window.fontManager?.currentFont;
    if (!font || open) return;
    open = true;

    const cloudPromise = cloudState();
    const initial = defaultNameAndFormat();
    const initialGlyphsVersion = defaultGlyphsVersion();
    let cloud: CloudState = { available: false, note: 'Checking…' };
    let dest: SaveDestination =
        options.destination ?? defaultDestination(cloud);
    const fileAccess = supportsFileAccess;

    const dialog = openDialog({
        title: `Save ${font.name || 'font'} as`,
        className: 'font-window-save-as',
        onClose: () => {
            open = false;
        }
    });
    dialog.body.innerHTML = `
        <div class="font-window-fields">
            <label>Name<span class="font-window-control font-window-name">${icon('edit')}<input type="text" data-name spellcheck="false" value="${escapeHtml(initial.name)}"><span class="font-window-ext" data-ext aria-hidden="true"></span></span></label>
            <div class="font-window-field-row">
                <label data-format-field>Format<span class="font-window-control">${icon('description')}<select data-format>${WRITABLE_FORMATS.map(
                    (key) =>
                        `<option value="${key}"${key === initial.format ? ' selected' : ''}>${escapeHtml(FONT_FORMATS[key].label)}</option>`
                ).join('')}</select></span></label>
                <label data-glyphs-version-field>Glyphs version<span class="font-window-control">${icon('history')}<select data-glyphs-version>${(
                    [3, 4] as const
                )
                    .map(
                        (version) =>
                            `<option value="${version}"${version === initialGlyphsVersion ? ' selected' : ''}>Glyphs ${version}</option>`
                    )
                    .join('')}</select></span></label>
            </div>
        </div>
        <div class="font-window-destinations" role="radiogroup" aria-label="Where to save">
            <button type="button" class="font-window-destination" role="radio" data-dest="disk"${fileAccess ? '' : ' disabled'}>${icon('computer')}<span><b>This computer</b><small data-hint="disk"></small></span><span class="font-window-radio"></span></button>
            <button type="button" class="font-window-destination" role="radio" data-dest="cloud" disabled>${icon('cloud')}<span><b>Cloud</b><small data-hint="cloud">${escapeHtml(cloud.note)}</small></span><span class="font-window-radio"></span></button>
            <button type="button" class="font-window-destination" role="radio" data-dest="browser">${icon('web')}<span><b>Browser storage</b><small>Stays in this browser only</small></span><span class="font-window-radio"></span></button>
        </div>
        <div class="font-window-dialog-actions">
            <button type="button" class="dialog-button" data-close>Cancel</button>
            <button type="button" class="dialog-button dialog-button-primary" data-go></button>
        </div>`;

    const body = dialog.body;
    const nameInput = body.querySelector('[data-name]') as HTMLInputElement;
    const formatSelect = body.querySelector(
        '[data-format]'
    ) as HTMLSelectElement;
    const glyphsVersionSelect = body.querySelector(
        '[data-glyphs-version]'
    ) as HTMLSelectElement;
    const go = body.querySelector('[data-go]') as HTMLButtonElement;
    const cloudButton = body.querySelector(
        '[data-dest="cloud"]'
    ) as HTMLButtonElement;

    const baseName = () => nameInput.value.trim() || 'Untitled';
    const format = () => formatSelect.value as FontFormatKey;
    const glyphsVersion = (): GlyphsFormatVersion | undefined =>
        dest !== 'cloud' && isGlyphsFormat(format())
            ? (Number(glyphsVersionSelect.value) as GlyphsFormatVersion)
            : undefined;

    const update = () => {
        const kind = fontFormatKind(format());
        const fileName = baseName() + FONT_FORMATS[format()].ext;
        body.querySelectorAll<HTMLElement>('[data-dest]').forEach((el) => {
            const on = el.dataset.dest === dest;
            el.classList.toggle('is-selected', on);
            el.setAttribute('aria-checked', String(on));
        });
        (body.querySelector('[data-hint="disk"]') as HTMLElement).textContent =
            !fileAccess
                ? 'This browser can’t save to your computer'
                : kind === 'file'
                  ? 'Choose where to save in the next window'
                  : kind === 'package'
                    ? `Pick a folder; ${fileName} is created inside it`
                    : `Pick a folder; ${fileName} and its UFOs are created inside it`;
        (body.querySelector('[data-hint="cloud"]') as HTMLElement).textContent =
            cloud.note;
        // The cloud saves by name alone, without an extension.
        (body.querySelector('[data-ext]') as HTMLElement).textContent =
            dest === 'cloud' ? '' : FONT_FORMATS[format()].ext;
        cloudButton.disabled = !cloud.available;
        cloudButton.title = cloud.blocked ?? '';
        (body.querySelector('[data-format-field]') as HTMLElement).hidden =
            dest === 'cloud';
        (
            body.querySelector('[data-glyphs-version-field]') as HTMLElement
        ).hidden = dest === 'cloud' || !isGlyphsFormat(format());
        go.textContent =
            dest === 'disk'
                ? kind === 'file'
                    ? 'Choose location…'
                    : 'Choose folder…'
                : dest === 'cloud'
                  ? 'Save to cloud'
                  : 'Save';
        go.disabled =
            (dest === 'cloud' && !cloud.available) ||
            (dest === 'disk' && !fileAccess);
    };

    body.querySelectorAll<HTMLButtonElement>('[data-dest]').forEach((el) =>
        el.addEventListener('click', () => {
            dest = el.dataset.dest as SaveDestination;
            update();
        })
    );
    formatSelect.addEventListener('change', update);
    glyphsVersionSelect.addEventListener('change', update);
    nameInput.addEventListener('input', (event) => {
        // A pasted or dropped file name chooses its format and loses its
        // extension, which the field shows after the name.
        const { inputType } = event as InputEvent;
        if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
            const pasted = splitFontFileName(nameInput.value);
            if (pasted) {
                nameInput.value = pasted.name;
                formatSelect.value = pasted.format;
            }
        }
        update();
    });
    nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') go.click();
    });
    update();
    nameInput.select();

    void cloudPromise.then((state) => {
        cloud = state;
        if (!options.destination) dest = defaultDestination(cloud);
        update();
    });

    go.addEventListener('click', async () => {
        if (baseName().includes('/') || baseName().includes('\\')) {
            reportError(new Error('A name can’t contain / or \\.'));
            return;
        }
        const fileName = baseName() + FONT_FORMATS[format()].ext;
        // The pickers must open in this click's turn: no awaits before them.
        const version = glyphsVersion();
        const saving =
            dest === 'disk'
                ? saveToDisk(fileName, format(), version)
                : dest === 'cloud'
                  ? saveToCloud(baseName())
                  : saveToBrowser(fileName, version);
        go.disabled = true;
        try {
            await saving;
            writeSetting(LAST_DESTINATION_KEY, dest);
            if (dest !== 'cloud') writeSetting(LAST_FORMAT_KEY, format());
            if (version) writeSetting(LAST_GLYPHS_VERSION_KEY, String(version));
            dialog.close();
        } catch (error) {
            if (!isAbortError(error)) console.error('Save As failed', error);
            reportError(error);
        } finally {
            go.disabled = false;
        }
    });
}

window.saveFontAs = showSaveAsDialog;
