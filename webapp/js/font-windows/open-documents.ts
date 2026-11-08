// Opening fonts in their own windows, shared by the launcher and font windows.
//
// A font window is named after its document key (the font's file URI), so
// opening a font that is already open brings its window forward instead.

import {
    diskDocumentKey,
    documentFromFolderEntry,
    documentFromHandle,
    fontsInDroppedFolder,
    grantFolderFor,
    type FolderFontEntry,
    type FolderGrantRequest
} from './disk-documents';
import {
    FONT_FORMATS,
    fontFormatKind,
    fontFormatOf,
    type FontFormatKey
} from './font-formats';
import {
    documentOpenState,
    focusWindow,
    fontWindowName,
    rememberOpenedWindow
} from './window-registry';
import {
    escapeHtml,
    FOLDER_PICKER_BUTTON,
    icon,
    OS,
    openDialog,
    reportError
} from './dialogs';
import { announcePendingOpens } from './pending-opens';

const NEW_FONT_PREFIX = 'new:///';

export const newFontKey = () =>
    `${NEW_FONT_PREFIX}${crypto.randomUUID().slice(0, 8)}`;

export const isNewFontKey = (key: string) => key.startsWith(NEW_FONT_PREFIX);

/** A font to open: its document key and what to call it. */
export type OpenableFont = {
    key: string;
    name: string;
    format?: FontFormatKey | null;
};

/** The font window URL for a document key. */
export function fontWindowUrl(
    key: string,
    options: { takeOver?: boolean; sparse?: boolean } = {}
): string {
    const params = new URLSearchParams();
    if (isNewFontKey(key)) {
        params.set('new', key.slice(NEW_FONT_PREFIX.length));
    } else {
        params.set('file', key);
    }
    if (options.takeOver) params.set('takeover', '1');
    // Cloud fonts only: download outlines as glyphs are typed or opened.
    if (options.sparse && key.startsWith('cloud://')) {
        params.set('sparse', 'true');
    }
    return `index.html?${params.toString()}`;
}

/**
 * Open a font in its own window, or bring its window forward. Call it from a
 * click handler (or right after a picker): browsers only open windows then.
 * When the browser refuses, every Counterpunch window asks for a click.
 */
export function openFontWindow(
    font: OpenableFont,
    options: { sparse?: boolean } = {}
): boolean {
    const name = fontWindowName(font.key);
    const state = documentOpenState(font.key);
    if (state === 'linked') {
        focusWindow(name);
        return true;
    }
    // Open in a window we can't reach (restored by the browser, or opened by
    // hand): open it again from here, where it is linked; the other window
    // hands over and closes.
    const win = window.open(
        fontWindowUrl(font.key, {
            takeOver: state === 'unlinked',
            sparse: options.sparse
        }),
        name
    );
    if (!win) {
        announcePendingOpens([
            {
                key: font.key,
                name: font.name,
                format: font.format ?? null,
                via: 'drop'
            }
        ]);
        return false;
    }
    rememberOpenedWindow(name, win);
    return true;
}

export const openDiskDocumentWindow = (doc: {
    id: string;
    name: string;
    format: FontFormatKey;
}) =>
    openFontWindow({
        key: diskDocumentKey(doc),
        name: doc.name,
        format: doc.format
    });

/** The folder step for packages and .designspace, as a dialog. */
export function askForFolder(
    request: FolderGrantRequest,
    onGranted: (doc: Awaited<ReturnType<typeof grantFolderFor>>) => void = (
        doc
    ) => void openDiskDocumentWindow(doc)
): void {
    const { handle, format } = request;
    const isPackage = fontFormatKind(format) === 'package';
    const why = isPackage
        ? `A ${FONT_FORMATS[format].ext} is a folder of many files, but ${OS === 'mac' ? 'your Mac' : 'your system'} shows it as a single file, so the browser can’t see inside it.`
        : 'A .designspace refers to UFO files next to it, and the browser can only read the file you picked.';
    const dialog = openDialog({
        title: `One more step to open ${handle.name}`,
        className: 'font-window-folder-step'
    });
    dialog.body.innerHTML = `
        <p>Browsers can only read files and folders that you pick yourself. ${escapeHtml(why)} Choosing the folder that contains it gives Counterpunch access.</p>
        <ol class="font-window-steps">
            <li><span>1</span>Click <strong>Choose folder</strong>. The window opens in the right place.</li>
            <li><span>2</span>Click <strong>${FOLDER_PICKER_BUTTON}</strong> without selecting anything.${isPackage ? ` ${escapeHtml(handle.name)} may look greyed out there, and that’s expected.` : ''}</li>
        </ol>
        <div class="font-window-dialog-actions">
            <span class="font-window-hint">Asked once per folder</span>
            <button type="button" class="dialog-button" data-close>Cancel</button>
            <button type="button" class="dialog-button dialog-button-primary" data-go>Choose folder…</button>
        </div>`;
    dialog.body
        .querySelector('[data-go]')
        ?.addEventListener('click', async () => {
            try {
                const doc = await grantFolderFor(request);
                dialog.close();
                onGranted(doc);
            } catch (error) {
                reportError(error);
            }
        });
}

/** Fonts found in a folder the user picked or dropped. */
export function showFolderFonts(
    folder: FileSystemDirectoryHandle,
    fonts: FolderFontEntry[]
): void {
    const dialog = openDialog({
        title: `Fonts in ${folder.name}`,
        className: 'font-window-folder-fonts'
    });
    if (!fonts.length) {
        dialog.body.innerHTML = `
            <p>No font sources in “${escapeHtml(folder.name)}”. Counterpunch looks in the folder and the folders directly inside it.</p>
            <div class="font-window-dialog-actions"><button type="button" class="dialog-button" data-close>Close</button></div>`;
        return;
    }
    dialog.body.innerHTML = `<p>Choose a font to open.</p><div class="font-window-list"></div>`;
    const list = dialog.body.querySelector('.font-window-list') as HTMLElement;
    for (const entry of fonts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'font-window-list-row';
        row.innerHTML = `${icon(fontFormatKind(entry.format) === 'package' ? 'deployed_code' : 'description')}<span class="name">${escapeHtml(entry.path)}</span><span class="meta">${escapeHtml(FONT_FORMATS[entry.format].ext)}</span>`;
        row.addEventListener('click', async () => {
            try {
                const doc = await documentFromFolderEntry(entry);
                dialog.close();
                openDiskDocumentWindow(doc);
            } catch (error) {
                reportError(error);
            }
        });
        list.append(row);
    }
}

/**
 * Open handles from a drop or the file manager. Folders that aren't fonts
 * list their fonts; packages and .designspace may need the folder step.
 */
export async function openHandles(
    handles: FileSystemHandle[],
    options: { onOpened?: () => void } = {}
): Promise<void> {
    for (const handle of handles) {
        try {
            const format = fontFormatOf(handle.name);
            if (
                handle instanceof FileSystemDirectoryHandle &&
                !(format && fontFormatKind(format) === 'package')
            ) {
                showFolderFonts(handle, await fontsInDroppedFolder(handle));
                continue;
            }
            const result = await documentFromHandle(handle);
            if (result.needsFolder) {
                askForFolder(result.needsFolder);
            } else {
                openDiskDocumentWindow(result.doc);
            }
            options.onOpened?.();
        } catch (error) {
            reportError(error);
        }
    }
}
