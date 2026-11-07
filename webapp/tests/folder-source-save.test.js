// Saving folder sources file by file, and following external changes to
// single glyph files, through the font manager and the real WASM serializers.

const fs = require('fs');
const path = require('path');
const fontManager = require('../js/font-manager').default;
const { fontCompilation } = require('../js/font-compilation');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const {
    collectFolderSourceEntries,
    FolderSourceState,
    hashBytes,
    readFolderSource
} = require('../js/folder-source');
const confirmDialog = require('../js/ui/confirm-dialog');
const {
    open_font_file,
    save_font_source_entries
} = require('../wasm-dist/babelfont_fontc_web');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

// Every WASM call runs the real module in a child process.
jest.setTimeout(60000);

// Opening a font seeds the compile worker, which Jest has none of.
beforeAll(() => {
    jest.spyOn(fontCompilation, 'seedWorkerDocumentSet').mockResolvedValue();
});
afterAll(() => {
    jest.restoreAllMocks();
});

/** A disk plugin over an in-memory file tree that records writes. */
function memoryDisk(files) {
    const writes = [];
    const deletions = [];
    const adapter = {
        async scanDirectory(directory) {
            const prefix = `${directory.replace(/\/+$/, '')}/`;
            const items = {};
            for (const file of files.keys()) {
                if (!file.startsWith(prefix)) continue;
                const [first, ...rest] = file.slice(prefix.length).split('/');
                const itemPath = prefix + first;
                items[itemPath] = {
                    path: itemPath,
                    is_dir: rest.length > 0,
                    mtime: ''
                };
            }
            return items;
        },
        async readFile(file) {
            if (!files.has(file)) throw new Error(`No such file: ${file}`);
            return files.get(file);
        },
        async writeFile(file, content) {
            files.set(
                file,
                typeof content === 'string'
                    ? new TextEncoder().encode(content)
                    : content
            );
            writes.push(file);
        },
        async deleteItem(file) {
            files.delete(file);
            deletions.push(file);
        },
        async fileExists(file) {
            return files.has(file);
        }
    };
    return {
        plugin: { getId: () => 'disk', getAdapter: () => adapter },
        writes,
        deletions
    };
}

function loadExampleTree(name, root) {
    const files = new Map();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else {
                files.set(
                    `${root}/${path.relative(path.join(EXAMPLES_DIR, name), fullPath)}`,
                    new Uint8Array(fs.readFileSync(fullPath))
                );
            }
        }
    };
    walk(path.join(EXAMPLES_DIR, name));
    return files;
}

/** Open an example folder source the way the file browser does. */
async function openFolderSource(name, format) {
    const root = `/fonts/${name}`;
    return openFolderFiles(name, format, root, loadExampleTree(name, root));
}

async function openFolderFiles(name, format, root, files) {
    const disk = memoryDisk(files);
    const entries = await collectFolderSourceEntries(
        disk.plugin.getAdapter(),
        root,
        format
    );
    const decoded = Object.fromEntries(
        Object.entries(entries).map(([file, bytes]) => [
            file,
            new TextDecoder().decode(bytes)
        ])
    );
    await fontManager.loadFont(
        open_font_file(name, JSON.stringify(decoded)),
        root,
        disk.plugin
    );
    const font = fontManager.currentFont;
    font.folderSource = new FolderSourceState(format, entries);
    return { font, files, root, ...disk };
}

function layerWidthEntry(glyphName, layerId) {
    return {
        path: `glyphs.${glyphName}:layers.${layerId}:width`,
        op: 'set',
        glyphRenames: []
    };
}

function editWidth(font, glyphName, delta) {
    const glyph = font.babelfontData.glyphs.find((g) => g.name === glyphName);
    glyph.layers[0].width += delta;
    font.folderSaveTracker.recordEntries([
        layerWidthEntry(glyphName, glyph.layers[0].id)
    ]);
    font.hasUnsavedChanges = true;
    return glyph.layers[0].width;
}

describe('saving folder sources file by file', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
    });

    test('a whole .glyphspackage save rewrites only what differs', async () => {
        const { font, writes, deletions, root } = await openFolderSource(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        font.folderSaveTracker.requireFullSave();
        await font.save();
        // Glyph files and order.plist come out as Glyphs wrote them, except
        // for the few glyphs whose metrics keys opening recomputes, and
        // fontinfo.plist, whose master value arrays wrap differently.
        expect(writes).toContain(`${root}/fontinfo.plist`);
        expect(writes).not.toContain(`${root}/order.plist`);
        expect(writes.length).toBeLessThan(20); // of 676 files
        expect(deletions).toEqual([]);
        expect(font.hasUnsavedChanges).toBe(false);

        // A second whole save finds nothing left to write.
        writes.length = 0;
        font.folderSaveTracker.requireFullSave();
        await font.save();
        expect(writes).toEqual([]);
    });

    test('an edited glyph saves to its own .glyph file', async () => {
        const { font, files, writes, root } = await openFolderSource(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        const width = editWidth(font, 'A', 10);
        await font.save();
        expect(writes).toEqual([`${root}/glyphs/A_.glyph`]);
        expect(
            new TextDecoder().decode(files.get(`${root}/glyphs/A_.glyph`))
        ).toContain(`width = ${width};`);

        // Saving again with nothing changed writes nothing.
        writes.length = 0;
        await font.save();
        expect(writes).toEqual([]);
    });

    test('a deleted glyph loses its file', async () => {
        const { font, files, deletions, root } = await openFolderSource(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        font.babelfontData.glyphs = font.babelfontData.glyphs.filter(
            (glyph) => glyph.name !== 'A'
        );
        font.fontModel = require('../js/babelfont-model').Font.fromData(
            font.babelfontData
        );
        font.folderSaveTracker.recordEntries([
            { path: 'glyphs.A:', op: 'remove', glyphRenames: [] }
        ]);
        font.hasUnsavedChanges = true;
        await font.save();
        expect(deletions).toEqual([`${root}/glyphs/A_.glyph`]);
        expect(files.has(`${root}/glyphs/A_.glyph`)).toBe(false);
    });

    test('an edited UFO glyph saves to its own .glif file, names kept', async () => {
        const { font, writes, deletions, root } = await openFolderSource(
            'YanoneKaffeesatz-Bold.ufo',
            'ufo'
        );
        editWidth(font, 'A', 10);
        await font.save();
        expect(writes).toEqual([`${root}/glyphs/A_.glif`]);

        // A whole save keeps every file: nothing is deleted or renamed.
        font.folderSaveTracker.requireFullSave();
        await font.save();
        expect(deletions).toEqual([]);
    });
});

describe('following external changes to folder sources', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let bridge;
    let showProceedDialog;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
        // The setup file loads the font manager before any jest.mock here.
        showProceedDialog = jest
            .spyOn(confirmDialog, 'showProceedDialog')
            .mockResolvedValue(true);
    });

    afterEach(() => {
        showProceedDialog.mockRestore();
        bridge?.destroy();
        bridge = null;
        window.patchSyncEngine = undefined;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
    });

    async function openWithBridge(name, format) {
        const opened = await openFolderSource(name, format);
        bridge = new ChangeBridge(`folder-source-${format}`);
        bridge.initFromJson(opened.font.babelfontData);
        window.patchSyncEngine = bridge;
        const committed = [];
        bridge.onLocalUpdate((_update, _message, entries) => {
            committed.push(...(entries || []));
        });
        return { ...opened, committed };
    }

    function changeFileOnDisk(files, file, edit) {
        const text = new TextDecoder().decode(files.get(file));
        const changed = edit(text);
        expect(changed).not.toBe(text);
        files.set(file, new TextEncoder().encode(changed));
    }

    test('a changed .glyph file updates that glyph alone', async () => {
        const { font, files, root, committed } = await openWithBridge(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        const reloadSpy = jest.spyOn(
            fontManager,
            'reloadCurrentFontFromSource'
        );
        const glyphFile = `${root}/glyphs/A_.glyph`;
        changeFileOnDisk(files, glyphFile, (text) =>
            text.replace(/width = (\d+);/, (_m, w) => `width = ${+w + 7};`)
        );

        await fontManager.handleExternalSourceChanges([glyphFile]);

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(committed.length).toBeGreaterThan(0);
        for (const entry of committed) {
            expect(entry.path).toMatch(/^glyphs\.A:/);
        }
        expect(font.hasUnsavedChanges).toBe(false);
        // The font now matches the file: saving writes nothing.
        expect(font.folderSaveTracker.plan('glyphspackage', false)).toEqual({
            glyphs: [],
            fontLevel: false,
            full: false
        });

        // The same file reported again (e.g. a second observer record) is a no-op.
        committed.length = 0;
        await fontManager.handleExternalSourceChanges([glyphFile]);
        expect(committed).toEqual([]);
        reloadSpy.mockRestore();
    });

    test('a changed .glif file updates that glyph alone', async () => {
        const { font, files, root, committed } = await openWithBridge(
            'YanoneKaffeesatz-Bold.ufo',
            'ufo'
        );
        const reloadSpy = jest.spyOn(
            fontManager,
            'reloadCurrentFontFromSource'
        );
        const glifFile = `${root}/glyphs/A_.glif`;
        changeFileOnDisk(files, glifFile, (text) =>
            text.replace(
                /<advance width="(\d+)"/,
                (_m, w) => `<advance width="${+w + 7}"`
            )
        );

        await fontManager.handleExternalSourceChanges([glifFile]);

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(committed.map((entry) => entry.path)).toEqual([
            expect.stringMatching(/^glyphs\.A:layers\..*:width$/)
        ]);
        const glyph = font.babelfontData.glyphs.find((g) => g.name === 'A');
        expect(font.hasUnsavedChanges).toBe(false);
        expect(glyph.layers[0].width).toBe(
            Number(
                new TextDecoder()
                    .decode(files.get(glifFile))
                    .match(/<advance width="(\d+)"/)[1]
            )
        );
        reloadSpy.mockRestore();
    });

    test("Counterpunch's own saves are not taken for external changes", async () => {
        const { font, root, writes, committed } = await openWithBridge(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        const reloadSpy = jest.spyOn(
            fontManager,
            'reloadCurrentFontFromSource'
        );
        editWidth(font, 'A', 10);
        await font.save();
        expect(writes).toEqual([`${root}/glyphs/A_.glyph`]);

        await fontManager.handleExternalSourceChanges(writes);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(committed).toEqual([]);
        reloadSpy.mockRestore();
    });

    test('keeping a locally edited glyph over its changed file', async () => {
        const { font, files, root, committed, writes } = await openWithBridge(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        const localWidth = editWidth(font, 'A', 10);
        const glyphFile = `${root}/glyphs/A_.glyph`;
        changeFileOnDisk(files, glyphFile, (text) =>
            text.replace(/width = (\d+);/, (_m, w) => `width = ${+w + 7};`)
        );
        showProceedDialog.mockResolvedValue(false);
        await fontManager.handleExternalSourceChanges([glyphFile]);

        expect(showProceedDialog).toHaveBeenCalledTimes(1);
        expect(committed).toEqual([]);
        await font.save();
        expect(writes).toEqual([glyphFile]);
        expect(new TextDecoder().decode(files.get(glyphFile))).toContain(
            `width = ${localWidth};`
        );
    });

    test('a changed font-level file reloads the whole source', async () => {
        const { files, root } = await openWithBridge(
            'YanoneKaffeesatz.glyphspackage',
            'glyphspackage'
        );
        const reloadSpy = jest
            .spyOn(fontManager, 'reloadCurrentFontFromSource')
            .mockResolvedValue(true);
        changeFileOnDisk(files, `${root}/fontinfo.plist`, (text) =>
            text.replace('unitsPerEm = 1000;', 'unitsPerEm = 2000;')
        );

        await fontManager.handleExternalSourceChanges([
            `${root}/fontinfo.plist`
        ]);

        expect(reloadSpy).toHaveBeenCalledTimes(1);
        reloadSpy.mockRestore();
    });
});

describe('following external changes to single-file sources', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
    });

    test('an unchanged file is not reloaded, a changed one is', async () => {
        const packageRoot = path.join(
            EXAMPLES_DIR,
            'YanoneKaffeesatz.glyphspackage'
        );
        const packageEntries = {};
        for (const file of ['fontinfo.plist', 'order.plist']) {
            packageEntries[file] = fs.readFileSync(
                path.join(packageRoot, file),
                'utf-8'
            );
        }
        for (const file of fs.readdirSync(path.join(packageRoot, 'glyphs'))) {
            packageEntries[`glyphs/${file}`] = fs.readFileSync(
                path.join(packageRoot, 'glyphs', file),
                'utf-8'
            );
        }
        const text = open_font_file(
            'YanoneKaffeesatz.glyphspackage',
            JSON.stringify(packageEntries)
        );
        const file = '/fonts/YanoneKaffeesatz.babelfont';
        const files = new Map([[file, new TextEncoder().encode(text)]]);
        const { plugin } = memoryDisk(files);
        await fontManager.loadFont(text, file, plugin);
        fontManager.currentFont.sourceFileHash = hashBytes(files.get(file));
        const reloadSpy = jest
            .spyOn(fontManager, 'reloadCurrentFontFromSource')
            .mockResolvedValue(true);

        await fontManager.handleExternalSourceChanges([file]);
        expect(reloadSpy).not.toHaveBeenCalled();

        files.set(file, new TextEncoder().encode(`${text}\n`));
        await fontManager.handleExternalSourceChanges([file]);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        reloadSpy.mockRestore();
    });
});

describe('Glyphs 4 packages', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
    });

    test('a removed feature loses its file', async () => {
        // A Glyphs 4 package: the example package saved as format 4.
        const name = 'YanoneKaffeesatz.glyphspackage';
        const root = `/fonts/${name}`;
        const v3 = Object.fromEntries(
            [...loadExampleTree(name, root)].map(([file, bytes]) => [
                file.slice(root.length + 1),
                new TextDecoder().decode(bytes)
            ])
        );
        const font4 = JSON.parse(open_font_file(name, JSON.stringify(v3)));
        font4.format_specific['com.schriftgestalt.Glyphs.formatVersion'] = 4;
        const v4 = JSON.parse(
            save_font_source_entries(
                'glyphspackage',
                JSON.stringify(font4),
                '{}'
            )
        ).files;
        expect(v4).toHaveProperty(['kerning.plist']);
        const featureFiles = Object.keys(v4).filter((file) =>
            file.startsWith('features/')
        );
        expect(featureFiles.length).toBeGreaterThan(1);

        const { font, writes, deletions } = await openFolderFiles(
            name,
            'glyphspackage',
            root,
            new Map(
                Object.entries(v4).map(([file, text]) => [
                    `${root}/${file}`,
                    new TextEncoder().encode(text)
                ])
            )
        );
        font.babelfontData.features.features.pop();
        font.fontModel = require('../js/babelfont-model').Font.fromData(
            font.babelfontData
        );
        font.folderSaveTracker.recordEntries([
            { path: 'features', op: 'set', glyphRenames: [] }
        ]);
        font.hasUnsavedChanges = true;
        await font.save();

        expect(deletions).toHaveLength(1);
        expect(deletions[0]).toMatch(/\/features\/[^/]+\.fea$/);
        expect(writes).toContain(`${root}/fontinfo.plist`);
        expect(writes.some((file) => file.includes('/glyphs/'))).toBe(false);
    });
});

describe('designspace projects', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let bridge;
    let showProceedDialog;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
        showProceedDialog = jest
            .spyOn(confirmDialog, 'showProceedDialog')
            .mockResolvedValue(true);
    });

    afterEach(() => {
        showProceedDialog.mockRestore();
        bridge?.destroy();
        bridge = null;
        window.patchSyncEngine = undefined;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
    });

    const DOCUMENT = 'YanoneKaffeesatz.designspace';
    const ROOT = '/fonts/examples';

    /** The examples folder: the project among other fonts. */
    function examplesFolder() {
        const files = new Map();
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else {
                    files.set(
                        `${ROOT}/${path.relative(EXAMPLES_DIR, fullPath)}`,
                        new Uint8Array(fs.readFileSync(fullPath))
                    );
                }
            }
        };
        walk(EXAMPLES_DIR);
        return files;
    }

    async function openProject() {
        const files = examplesFolder();
        const disk = memoryDisk(files);
        const { entries, state } = await readFolderSource(
            disk.plugin.getAdapter(),
            `${ROOT}/${DOCUMENT}`,
            'designspace'
        );
        expect(
            Object.keys(entries).some((p) => p.includes('glyphspackage'))
        ).toBe(false);
        const decoded = Object.fromEntries(
            Object.entries(entries).map(([file, bytes]) => [
                file,
                new TextDecoder().decode(bytes)
            ])
        );
        await fontManager.loadFont(
            open_font_file(DOCUMENT, JSON.stringify(decoded)),
            `${ROOT}/${DOCUMENT}`,
            disk.plugin
        );
        const font = fontManager.currentFont;
        font.folderSource = state;
        bridge = new ChangeBridge('folder-source-designspace');
        bridge.initFromJson(font.babelfontData);
        window.patchSyncEngine = bridge;
        const committed = [];
        bridge.onLocalUpdate((_update, _message, entries) => {
            committed.push(...(entries || []));
        });
        return { font, files, committed, ...disk };
    }

    test('saves file by file and keeps every layer', async () => {
        const { font, writes, deletions } = await openProject();
        expect(font.babelfontData.masters).toHaveLength(2);
        font.folderSaveTracker.requireFullSave();
        await font.save();
        // Nothing of the UFOs is lost, history layers included.
        expect(deletions).toEqual([]);
        expect(writes).toContain(`${ROOT}/${DOCUMENT}`);

        writes.length = 0;
        font.folderSaveTracker.requireFullSave();
        await font.save();
        expect(writes).toEqual([]);

        const bold = font.babelfontData.masters[1].id;
        const glyph = font.babelfontData.glyphs.find((g) => g.name === 'A');
        const layer = glyph.layers.find(
            (l) =>
                l.master?.type === 'DefaultForMaster' &&
                l.master.master === bold
        );
        layer.width += 10;
        font.folderSaveTracker.recordEntries([
            {
                path: `glyphs.A:layers.${layer.id}:width`,
                op: 'set',
                glyphRenames: []
            }
        ]);
        font.hasUnsavedChanges = true;
        await font.save();
        expect(writes).toEqual([
            `${ROOT}/YanoneKaffeesatz-Bold.ufo/glyphs/A_.glif`
        ]);
    });

    test("a changed .glif in one master's UFO updates that glyph alone", async () => {
        const { font, files, committed } = await openProject();
        const reloadSpy = jest.spyOn(
            fontManager,
            'reloadCurrentFontFromSource'
        );
        const glif = `${ROOT}/YanoneKaffeesatz-Bold.ufo/glyphs/A_.glif`;
        const text = new TextDecoder().decode(files.get(glif));
        const changed = text.replace(
            /<advance width="(\d+)"/,
            (_m, w) => `<advance width="${+w + 7}"`
        );
        expect(changed).not.toBe(text);
        files.set(glif, new TextEncoder().encode(changed));

        await fontManager.handleExternalSourceChanges([glif]);

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(committed.map((entry) => entry.path)).toEqual([
            expect.stringMatching(/^glyphs\.A:layers\..*:width$/)
        ]);
        expect(font.hasUnsavedChanges).toBe(false);
        reloadSpy.mockRestore();
    });

    test('files beside the project are not part of it', async () => {
        const { files, committed } = await openProject();
        const reloadSpy = jest.spyOn(
            fontManager,
            'reloadCurrentFontFromSource'
        );
        const other = `${ROOT}/YanoneKaffeesatz.glyphspackage/glyphs/A_.glyph`;
        files.set(other, new TextEncoder().encode('{}'));

        await fontManager.handleExternalSourceChanges([other]);

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(committed).toEqual([]);
        reloadSpy.mockRestore();
    });
});

describe('saving in another Glyphs version', () => {
    const {
        glyphsFormatVersionOf,
        serializeFontForSourceSave
    } = require('../js/font-manager');
    const wasm = require('../wasm-dist/babelfont_fontc_web');
    const KEY = 'com.schriftgestalt.Glyphs.saveFormatVersion';

    test('a font knows the Glyphs version it was read in', () => {
        const of = (version) =>
            glyphsFormatVersionOf({
                format_specific: {
                    'com.schriftgestalt.Glyphs.formatVersion': version
                }
            });
        expect(of(4)).toBe(4);
        expect(of(3)).toBe(3);
        // Glyphs 2 is saved as the oldest version Counterpunch writes.
        expect(of(2)).toBe(3);
        expect(glyphsFormatVersionOf({ format_specific: {} })).toBeNull();
    });

    test('the chosen version reaches the Glyphs writer', async () => {
        const json = JSON.stringify({ glyphs: [], format_specific: {} });
        wasm.save_font_as_glyphs.mockClear();
        await serializeFontForSourceSave('/Font.glyphs', json, 3);
        const input = JSON.parse(wasm.save_font_as_glyphs.mock.calls[0][0]);
        expect(input.format_specific[KEY]).toBe(3);

        wasm.save_font_as_glyphs.mockClear();
        await serializeFontForSourceSave('/Font.glyphs', json);
        const asRead = JSON.parse(wasm.save_font_as_glyphs.mock.calls[0][0]);
        expect(asRead.format_specific[KEY]).toBeUndefined();
    });
});
