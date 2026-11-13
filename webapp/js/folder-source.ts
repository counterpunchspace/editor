// Folder font sources (.ufo, .glyphspackage, and a .designspace with its
// UFOs): which files make up the source, what is on disk, and what changed
// since the last save, so that saving and external changes touch single
// files instead of the whole folder.

import {
    deriveGlyphNameFromPath,
    getPathSegments,
    type ChangeLogEntry
} from './change-log';
import type { FileSystemAdapter } from './file-system-adapter';
import {
    CORE_CODEPOINT_INDEX_KEY,
    CORE_GLYPH_CATALOG_KEY
} from './filesystem-plugins/cloud-glyph-catalog';
import * as babelfontWasm from '../wasm-dist/babelfont_fontc_web';
import { ensureWasmInitialized } from './wasm-init';

const { designspace_source_files } = babelfontWasm as object as {
    designspace_source_files: (document: string) => string;
};

export type FolderSourceFormat = 'ufo' | 'glyphspackage' | 'designspace';

/**
 * Which files belong to a folder source. A designspace project is the
 * document and the UFOs it names, in the document's folder, among whatever
 * else that folder holds.
 */
export type FolderSourceLayout = {
    format: FolderSourceFormat;
    /** Designspace: the document's file name. */
    document?: string;
    /** Designspace: its UFOs, by path relative to the document's folder. */
    ufoDirs?: string[];
};

type LayoutLike = FolderSourceFormat | FolderSourceLayout;

function asLayout(layout: LayoutLike): FolderSourceLayout {
    return typeof layout === 'string' ? { format: layout } : layout;
}

const FOLDER_READ_CONCURRENCY = 16;

/** The folder source format of `path`, or null for a single-file source. */
export function folderSourceFormatForPath(
    path: string
): FolderSourceFormat | null {
    const extension = path.split('.').pop()?.toLowerCase() || '';
    if (extension === 'ufo') {
        return 'ufo';
    }
    if (extension === 'glyphspackage' || extension === 'glyphpackage') {
        return 'glyphspackage';
    }
    if (extension === 'designspace') {
        return 'designspace';
    }
    return null;
}

/**
 * The folder a source's file paths are relative to: the source itself, or
 * a designspace document's folder.
 */
export function folderSourceRoot(
    path: string,
    format: FolderSourceFormat
): string {
    if (format !== 'designspace') {
        return path.replace(/\/+$/, '');
    }
    const index = path.lastIndexOf('/');
    return index > 0 ? path.slice(0, index) : '';
}

const UFO_TOP_LEVEL_FILES = new Set([
    'metainfo.plist',
    'fontinfo.plist',
    'groups.plist',
    'kerning.plist',
    'lib.plist',
    'features.fea',
    'layercontents.plist'
]);
const PACKAGE_TOP_LEVEL_FILES = new Set([
    'fontinfo.plist',
    'order.plist',
    'UIState.plist'
]);
// Glyphs 4 packages keep these in their own files.
const PACKAGE_GLYPHS4_FILES = new Set(['kerning.plist', 'note.md']);

/** A layer directory file of a UFO: `glyphs[.name]/<file>`. */
function isUfoLayerFile(relativePath: string): boolean {
    return /^glyphs(\.[^/]+)?\/[^/]+$/.test(relativePath);
}

function isTransientFile(relativePath: string): boolean {
    const baseName = relativePath.split('/').pop() || '';
    // Hidden files and the swap files Chrome writes next to a file in progress.
    return baseName.startsWith('.') || baseName.endsWith('.crswap');
}

/**
 * Where a path of a designspace project lives: the document, a file inside
 * one of its UFOs (with the path inside that UFO), or neither.
 */
function designspacePart(
    layout: FolderSourceLayout,
    relativePath: string
): { document: true } | { ufo: string; inner: string } | null {
    if (relativePath === layout.document) {
        return { document: true };
    }
    for (const ufo of layout.ufoDirs || []) {
        if (relativePath.startsWith(`${ufo}/`)) {
            return { ufo, inner: relativePath.slice(ufo.length + 1) };
        }
    }
    return null;
}

/** Applies a UFO rule to a designspace project's UFO files. */
function forUfoFiles(
    layout: FolderSourceLayout,
    relativePath: string,
    ufoRule: (inner: string) => boolean,
    documentRule: boolean
): boolean {
    if (layout.format !== 'designspace') {
        return ufoRule(relativePath);
    }
    const part = designspacePart(layout, relativePath);
    if (!part) {
        return false;
    }
    return 'document' in part ? documentRule : ufoRule(part.inner);
}

/**
 * Whether opening the source reads this file. A UFO's `data/` and `images/`
 * are never read: saving leaves them alone, so they need not be loaded.
 */
export function isFolderSourceFile(
    layoutLike: LayoutLike,
    relativePath: string
): boolean {
    const layout = asLayout(layoutLike);
    if (isTransientFile(relativePath)) {
        return false;
    }
    if (layout.format === 'glyphspackage') {
        return (
            PACKAGE_TOP_LEVEL_FILES.has(relativePath) ||
            PACKAGE_GLYPHS4_FILES.has(relativePath) ||
            /^glyphs\/[^/]+\.glyph$/.test(relativePath) ||
            /^features\/[^/]+\.fea$/.test(relativePath)
        );
    }
    return forUfoFiles(
        layout,
        relativePath,
        (inner) => !/^(data|images)\//.test(inner),
        true
    );
}

/** Whether a directory can hold files opening the source reads. */
function isFolderSourceDirectory(
    format: FolderSourceFormat,
    relativePath: string
): boolean {
    if (isTransientFile(relativePath)) {
        return false;
    }
    if (format === 'glyphspackage') {
        return relativePath === 'glyphs' || relativePath === 'features';
    }
    return relativePath !== 'data' && relativePath !== 'images';
}

/**
 * Whether saving owns this file: a full save that no longer writes it
 * deletes it. Feature files a UFO includes are written but never deleted,
 * nor is anything else Counterpunch does not model.
 */
export function isManagedFolderSourceFile(
    layoutLike: LayoutLike,
    relativePath: string
): boolean {
    const layout = asLayout(layoutLike);
    if (layout.format === 'glyphspackage') {
        return isFolderSourceFile(layout, relativePath);
    }
    return forUfoFiles(
        layout,
        relativePath,
        (inner) =>
            UFO_TOP_LEVEL_FILES.has(inner) ||
            // Not layerinfo.plist: layer colors and libs are not modelled, so
            // a save never writes it, and must not delete it either.
            (isUfoLayerFile(inner) &&
                (inner.endsWith('.glif') ||
                    inner.endsWith('/contents.plist')) &&
                !isTransientFile(inner)),
        true
    );
}

/** Whether a change to this file is a change to one glyph alone. */
export function isGlyphFile(
    layoutLike: LayoutLike,
    relativePath: string
): boolean {
    const layout = asLayout(layoutLike);
    if (layout.format === 'glyphspackage') {
        return /^glyphs\/[^/]+\.glyph$/.test(relativePath);
    }
    return forUfoFiles(
        layout,
        relativePath,
        (inner) => isUfoLayerFile(inner) && inner.endsWith('.glif'),
        false
    );
}

/**
 * Files whose text the WASM side needs: a UFO's `layercontents.plist` and
 * `contents.plist` to keep its names, a package's `fontinfo.plist` and a
 * designspace document to load single glyphs.
 */
function isLayoutFile(layout: FolderSourceLayout, relativePath: string) {
    if (layout.format === 'glyphspackage') {
        return relativePath === 'fontinfo.plist';
    }
    return forUfoFiles(
        layout,
        relativePath,
        (inner) =>
            inner === 'layercontents.plist' ||
            (isUfoLayerFile(inner) && inner.endsWith('/contents.plist')),
        true
    );
}

/**
 * A 53-bit content hash (cyrb53) combined with the length. A collision would
 * hide one change from one save or reload; at these odds that is acceptable
 * for keeping every file's text out of memory.
 */
export function hashBytes(bytes: Uint8Array): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        h1 = Math.imul(h1 ^ byte, 2654435761);
        h2 = Math.imul(h2 ^ byte, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${bytes.length}:${hash.toString(36)}`;
}

function toBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;
}

/** Joins a folder source root and a path relative to it. */
export function joinSourcePath(root: string, relativePath: string): string {
    return `${root.replace(/\/+$/, '')}/${relativePath}`;
}

/**
 * Reads the files opening a UFO or package needs, by path relative to
 * `rootPath`, several at a time.
 */
export async function collectFolderSourceEntries(
    adapter: FileSystemAdapter,
    rootPath: string,
    format: Exclude<FolderSourceFormat, 'designspace'>
): Promise<Record<string, Uint8Array>> {
    const root = rootPath.replace(/\/+$/, '');
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        const items = await adapter.scanDirectory(directory);
        const subdirectories: string[] = [];
        for (const item of Object.values(items)) {
            const relativePath = item.path
                .slice(root.length)
                .replace(/^\/+/, '');
            if (item.is_dir) {
                if (isFolderSourceDirectory(format, relativePath)) {
                    subdirectories.push(item.path);
                }
            } else if (isFolderSourceFile(format, relativePath)) {
                files.push(relativePath);
            }
        }
        await Promise.all(subdirectories.map(walk));
    };
    await walk(root);

    const entries: Record<string, Uint8Array> = {};
    let next = 0;
    const readNext = async (): Promise<void> => {
        while (next < files.length) {
            const relativePath = files[next++];
            entries[relativePath] = toBytes(
                await adapter.readFile(joinSourcePath(root, relativePath))
            );
        }
    };
    await Promise.all(
        Array.from({ length: FOLDER_READ_CONCURRENCY }, () => readNext())
    );
    return entries;
}

/** The UFOs a designspace document names, relative to its folder. */
export async function designspaceUfoDirs(document: string): Promise<string[]> {
    await ensureWasmInitialized();
    return JSON.parse(designspace_source_files(document)) as string[];
}

/**
 * Reads a folder source the way opening it needs: for a designspace, the
 * document and its UFOs, by path relative to the document's folder. Returns
 * the files and what they hold on disk.
 */
export async function readFolderSource(
    adapter: FileSystemAdapter,
    path: string,
    format: FolderSourceFormat
): Promise<{ entries: Record<string, Uint8Array>; state: FolderSourceState }> {
    if (format !== 'designspace') {
        const entries = await collectFolderSourceEntries(adapter, path, format);
        return { entries, state: new FolderSourceState(format, entries) };
    }
    const root = folderSourceRoot(path, format);
    const document = path.slice(root.length).replace(/^\/+/, '');
    const documentBytes = toBytes(await adapter.readFile(path));
    const ufoDirs = await designspaceUfoDirs(
        new TextDecoder().decode(documentBytes)
    );
    const entries: Record<string, Uint8Array> = { [document]: documentBytes };
    for (const ufo of ufoDirs) {
        const ufoEntries = await collectFolderSourceEntries(
            adapter,
            joinSourcePath(root, ufo),
            'ufo'
        );
        for (const [inner, bytes] of Object.entries(ufoEntries)) {
            entries[`${ufo}/${inner}`] = bytes;
        }
    }
    return {
        entries,
        state: new FolderSourceState({ format, document, ufoDirs }, entries)
    };
}

/**
 * What a folder source holds on disk, as Counterpunch last read or wrote it:
 * a hash per file, plus the text of the few files the serializer needs.
 */
export class FolderSourceState {
    readonly format: FolderSourceFormat;
    readonly layout: FolderSourceLayout;
    private hashes = new Map<string, string>();
    private layoutTexts = new Map<string, string>();

    constructor(layout: LayoutLike, entries: Record<string, Uint8Array>) {
        this.layout = { ...asLayout(layout) };
        this.format = this.layout.format;
        for (const [relativePath, bytes] of Object.entries(entries)) {
            this.record(relativePath, bytes);
        }
    }

    /** A designspace project's UFOs changed, e.g. after saving a new one. */
    setUfoDirs(ufoDirs: string[]): void {
        this.layout.ufoDirs = ufoDirs;
    }

    /** Whether `content` is what the file held when last read or written. */
    isUnchanged(relativePath: string, content: string | Uint8Array): boolean {
        return this.hashes.get(relativePath) === hashBytes(toBytes(content));
    }

    has(relativePath: string): boolean {
        return this.hashes.has(relativePath);
    }

    /** Remember that the file now holds `content`. */
    record(relativePath: string, content: string | Uint8Array): void {
        const bytes = toBytes(content);
        this.hashes.set(relativePath, hashBytes(bytes));
        if (isLayoutFile(this.layout, relativePath)) {
            this.layoutTexts.set(
                relativePath,
                typeof content === 'string'
                    ? content
                    : new TextDecoder().decode(bytes)
            );
        }
    }

    /** Remember that the file is gone. */
    forget(relativePath: string): void {
        this.hashes.delete(relativePath);
        this.layoutTexts.delete(relativePath);
    }

    /** The files a full save owns, so that one not written again is stale. */
    managedPaths(): string[] {
        return [...this.hashes.keys()].filter((relativePath) =>
            isManagedFolderSourceFile(this.layout, relativePath)
        );
    }

    /** `layercontents.plist` and `contents.plist` texts (UFO, designspace). */
    layoutEntries(): Record<string, string> {
        return Object.fromEntries(
            [...this.layoutTexts].filter(
                ([path]) => path !== this.layout.document
            )
        );
    }

    /** The package's `fontinfo.plist` text (.glyphspackage). */
    fontinfoText(): string | undefined {
        return this.layoutTexts.get('fontinfo.plist');
    }

    /** The designspace document's text. */
    documentText(): string | undefined {
        return this.layout.document
            ? this.layoutTexts.get(this.layout.document)
            : undefined;
    }
}

const IGNORED_TOP_LEVEL_KEYS = new Set([
    'glyphRevisions',
    CORE_GLYPH_CATALOG_KEY,
    CORE_CODEPOINT_INDEX_KEY
]);

/** Which files the next save has to rewrite. */
export type FolderSavePlan = {
    /** Glyphs whose files to write; a name the font lost is deleted. */
    glyphs: string[];
    /** Also write the font-level files. */
    fontLevel: boolean;
    /** Rewrite the whole source (writing only files that changed). */
    full: boolean;
};

/**
 * Collects committed changes since the last save into the files they touch.
 * It errs towards bigger saves: anything it cannot place in one glyph's file
 * makes the font-level files or the whole source dirty.
 */
export class FolderSaveTracker {
    private glyphs = new Set<string>();
    private fontLevel = false;
    private kerningGroups = false;
    private full = false;

    recordEntries(entries: ChangeLogEntry[]): void {
        for (const entry of entries) {
            if (entry.semanticChangeLogEntries?.length) {
                this.recordEntries(entry.semanticChangeLogEntries);
                continue;
            }
            this.recordEntry(entry);
        }
    }

    private recordEntry(entry: ChangeLogEntry): void {
        for (const rename of entry.glyphRenames || []) {
            this.glyphs.add(rename.oldName);
            this.glyphs.add(rename.newName);
            this.fontLevel = true;
        }
        const segments = getPathSegments(entry.path);
        const topLevel = segments[0];
        if (topLevel === undefined) {
            this.full = true;
            return;
        }
        if (IGNORED_TOP_LEVEL_KEYS.has(String(topLevel))) {
            return;
        }
        if (topLevel === 'glyphs') {
            const glyphName = deriveGlyphNameFromPath(entry.path);
            if (!glyphName) {
                this.full = true;
                return;
            }
            this.glyphs.add(glyphName);
            // Adding or removing a glyph changes the glyph order, and a UFO
            // keeps categories, production names and export flags in lib.plist.
            if (segments[2] !== 'layers') {
                this.fontLevel = true;
            }
            return;
        }
        if (
            topLevel === 'first_kern_groups' ||
            topLevel === 'second_kern_groups'
        ) {
            this.kerningGroups = true;
            this.fontLevel = true;
            return;
        }
        if (topLevel === 'masters') {
            // Master metrics and kerning are font-level; adding or removing a
            // master changes every glyph.
            if (segments.length > 2) {
                this.fontLevel = true;
            } else {
                this.full = true;
            }
            return;
        }
        if (topLevel === 'axes') {
            this.full = true;
            return;
        }
        this.fontLevel = true;
    }

    /** Make the next save write the whole source, e.g. into a new folder. */
    requireFullSave(): void {
        this.full = true;
    }

    /** Forget a glyph that now matches its file again. */
    markGlyphClean(glyphName: string): void {
        this.glyphs.delete(glyphName);
    }

    isGlyphDirty(glyphName: string): boolean {
        return this.full || this.glyphs.has(glyphName);
    }

    /**
     * The save to make. `hasUnsavedChanges` covers edits that bypassed the
     * change log: unsaved changes with nothing recorded save everything.
     */
    plan(
        format: FolderSourceFormat,
        hasUnsavedChanges: boolean
    ): FolderSavePlan {
        const nothingRecorded = this.glyphs.size === 0 && !this.fontLevel;
        // A .glyphspackage keeps kerning group membership in the glyph files.
        const full =
            this.full ||
            (this.kerningGroups && format === 'glyphspackage') ||
            (nothingRecorded && hasUnsavedChanges);
        return {
            glyphs: [...this.glyphs],
            fontLevel: this.fontLevel,
            full
        };
    }

    /**
     * What a save of the recorded changes covers, to describe it. Like
     * `plan`, unsaved changes with nothing recorded count as everything.
     */
    summary(hasUnsavedChanges: boolean): {
        glyphs: string[] | null;
        fontLevel: boolean;
    } {
        const nothingRecorded = this.glyphs.size === 0 && !this.fontLevel;
        if (this.full || (nothingRecorded && hasUnsavedChanges)) {
            return { glyphs: null, fontLevel: true };
        }
        return { glyphs: [...this.glyphs].sort(), fontLevel: this.fontLevel };
    }

    reset(): void {
        this.glyphs.clear();
        this.fontLevel = false;
        this.kerningGroups = false;
        this.full = false;
    }
}
