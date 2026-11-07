// Turning files and folders from pickers, drops and the file manager into
// disk documents, including the extra step packages and .designspace need.
//
// Browsers only read what the user picked. A .designspace refers to UFOs next
// to it, and macOS (with Glyphs or RoboFont installed) hands over a .ufo or
// .glyphspackage as an unreadable "file". Both need the folder around them;
// once the user granted that folder it is remembered and reused.

import {
    allGrantedFolders,
    rememberFolder,
    upsertDiskDocument,
    type DiskDocument
} from './document-store';
import {
    ensurePermission,
    queryPermission,
    resolveInside,
    showDirectoryPicker,
    showOpenFilePicker
} from './file-access';
import {
    FONT_FORMATS,
    FONT_PICKER_TYPES,
    fontFormatKind,
    fontFormatOf,
    type FontFormatKey
} from './font-formats';

/** A font that can only open once the user grants its folder. */
export type FolderGrantRequest = {
    handle: FileSystemHandle;
    format: FontFormatKey;
};

export type HandleResult =
    | { doc: DiskDocument; needsFolder?: undefined }
    | { doc?: undefined; needsFolder: FolderGrantRequest };

/** A font found in a folder the user picked. */
export type FolderFontEntry = {
    name: string;
    path: string;
    format: FontFormatKey;
    parent: FileSystemDirectoryHandle;
};

export const diskDocumentKey = (doc: Pick<DiskDocument, 'id' | 'name'>) =>
    `disk:///${doc.id}/${doc.name}`;

/** The document id inside a disk file URI path (`/<id>/<name>`). */
export function diskDocumentIdFromPath(path: string): string | null {
    const [id] = path.replace(/^\/+/, '').split('/');
    return id || null;
}

async function grantedFolderContaining(
    handle: FileSystemHandle
): Promise<FileSystemDirectoryHandle | null> {
    for (const folder of await allGrantedFolders()) {
        if ((await queryPermission(folder.handle)) !== 'granted') continue;
        const path = await resolveInside(folder.handle, handle);
        if (!path?.length) continue;
        let parent = folder.handle;
        for (const part of path.slice(0, -1)) {
            parent = await parent.getDirectoryHandle(part);
        }
        return parent;
    }
    return null;
}

async function documentInFolder(
    parent: FileSystemDirectoryHandle,
    name: string,
    format: FontFormatKey
): Promise<DiskDocument> {
    const handle =
        fontFormatKind(format) === 'package'
            ? await parent.getDirectoryHandle(name)
            : await parent.getFileHandle(name);
    return upsertDiskDocument({ name, format, handle, parent });
}

/** Make a document of a handle from a picker, a drop or the file manager. */
export async function documentFromHandle(
    handle: FileSystemHandle
): Promise<HandleResult> {
    const format = fontFormatOf(handle.name);
    if (!format) {
        throw new Error(
            `${handle.name} isn’t a font source Counterpunch can open.`
        );
    }
    const kind = fontFormatKind(format);

    if (handle instanceof FileSystemDirectoryHandle) {
        if (kind !== 'package') {
            throw new Error(`${handle.name} is a folder, not a font.`);
        }
        return {
            doc: await upsertDiskDocument({ name: handle.name, format, handle })
        };
    }
    if (kind === 'file' && handle instanceof FileSystemFileHandle) {
        return {
            doc: await upsertDiskDocument({ name: handle.name, format, handle })
        };
    }
    // A package handed over as a "file", or a .designspace.
    const parent = await grantedFolderContaining(handle);
    if (!parent) return { needsFolder: { handle, format } };
    return { doc: await documentInFolder(parent, handle.name, format) };
}

/**
 * The folder step: the user picks the folder that contains the font.
 * Must run inside a click handler.
 */
export async function grantFolderFor(
    request: FolderGrantRequest
): Promise<DiskDocument> {
    const { handle, format } = request;
    const dir = await showDirectoryPicker({
        id: 'counterpunch-open',
        mode: 'readwrite',
        startIn: handle
    });
    // Where a .ufo is a plain folder, the user may pick the package itself.
    if (dir.name === handle.name && fontFormatKind(format) === 'package') {
        return upsertDiskDocument({ name: dir.name, format, handle: dir });
    }
    const path = await resolveInside(dir, handle);
    if (!path?.length) {
        throw new Error(
            `“${dir.name}” doesn’t contain ${handle.name}. Choose the folder it’s in.`
        );
    }
    await rememberFolder(dir);
    let parent = dir;
    for (const part of path.slice(0, -1)) {
        parent = await parent.getDirectoryHandle(part);
    }
    return documentInFolder(parent, handle.name, format);
}

/** Open… : the system file picker. Must run inside a click handler. */
export async function pickFontFile(): Promise<FileSystemFileHandle> {
    const [handle] = await showOpenFilePicker({
        id: 'counterpunch-open',
        types: FONT_PICKER_TYPES,
        excludeAcceptAllOption: false
    });
    return handle;
}

export type FolderPick =
    | { doc: DiskDocument; folder?: undefined; fonts?: undefined }
    | {
          doc?: undefined;
          folder: FileSystemDirectoryHandle;
          fonts: FolderFontEntry[];
      };

/**
 * The folder route: a package itself, or a folder to choose a font from.
 * Must run inside a click handler.
 */
export async function pickFontFolder(): Promise<FolderPick> {
    const dir = await showDirectoryPicker({
        id: 'counterpunch-open',
        mode: 'readwrite'
    });
    const format = fontFormatOf(dir.name);
    if (format && fontFormatKind(format) === 'package') {
        return {
            doc: await upsertDiskDocument({
                name: dir.name,
                format,
                handle: dir
            })
        };
    }
    await rememberFolder(dir);
    return { folder: dir, fonts: await fontsInFolder(dir) };
}

/** Folders dropped on the launcher are remembered like picked ones. */
export async function fontsInDroppedFolder(
    dir: FileSystemDirectoryHandle
): Promise<FolderFontEntry[]> {
    await rememberFolder(dir);
    return fontsInFolder(dir);
}

/** Fonts in a folder and its direct subfolders. */
async function fontsInFolder(
    dir: FileSystemDirectoryHandle,
    depth = 0,
    prefix = ''
): Promise<FolderFontEntry[]> {
    const found: FolderFontEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue;
        const format = fontFormatOf(name);
        const isPackage = !!format && fontFormatKind(format) === 'package';
        if (
            format &&
            ((isPackage && handle.kind === 'directory') ||
                (!isPackage && handle.kind === 'file'))
        ) {
            found.push({ name, format, path: prefix + name, parent: dir });
        } else if (
            handle instanceof FileSystemDirectoryHandle &&
            depth < 1 &&
            found.length < 200
        ) {
            found.push(
                ...(await fontsInFolder(handle, depth + 1, `${prefix}${name}/`))
            );
        }
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
}

export const documentFromFolderEntry = (entry: FolderFontEntry) =>
    documentInFolder(entry.parent, entry.name, entry.format);

/**
 * The folders above a font, as far up as Counterpunch can see: the longest
 * path from a granted folder down to the font's own folder.
 */
export async function folderChain(doc: DiskDocument): Promise<string[]> {
    let best = doc.parent ? [doc.parent.name] : [];
    for (const folder of await allGrantedFolders()) {
        const path = await resolveInside(folder.handle, doc.handle);
        if (!path?.length) continue;
        const chain = [folder.name, ...path.slice(0, -1)];
        if (chain.length > best.length) best = chain;
    }
    return best;
}

/** The handle access has to be granted on to read (and save) the document. */
export const accessHandleOf = (doc: DiskDocument): FileSystemHandle =>
    FONT_FORMATS[doc.format].kind === 'project' && doc.parent
        ? doc.parent
        : doc.handle;

/** Ask for access to a document again. Needs a click when it prompts. */
export const ensureDocumentAccess = (
    doc: DiskDocument,
    mode: 'read' | 'readwrite' = 'readwrite'
) => ensurePermission(accessHandleOf(doc), mode);
