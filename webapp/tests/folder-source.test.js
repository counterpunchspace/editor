const {
    FolderSaveTracker,
    FolderSourceState,
    folderSourceFormatForPath,
    folderSourceRoot,
    hashBytes,
    isFolderSourceFile,
    isGlyphFile,
    isManagedFolderSourceFile
} = require('../js/folder-source');

const bytes = (text) => new TextEncoder().encode(text);
const entry = (path, extra = {}) => ({
    path,
    op: 'set',
    glyphRenames: [],
    ...extra
});

describe('folder source files', () => {
    test('formats come from the extension', () => {
        expect(folderSourceFormatForPath('/a/Font.ufo')).toBe('ufo');
        expect(folderSourceFormatForPath('/a/Font.glyphspackage')).toBe(
            'glyphspackage'
        );
        expect(folderSourceFormatForPath('/a/Font.glyphs')).toBeNull();
    });

    test('opening a UFO skips data, images and transient files', () => {
        expect(isFolderSourceFile('ufo', 'glyphs/A_.glif')).toBe(true);
        expect(isFolderSourceFile('ufo', 'features/classes.fea')).toBe(true);
        expect(isFolderSourceFile('ufo', 'images/A.png')).toBe(false);
        expect(isFolderSourceFile('ufo', 'data/com.x/blob')).toBe(false);
        expect(isFolderSourceFile('ufo', 'glyphs/A_.glif.crswap')).toBe(false);
        expect(isFolderSourceFile('ufo', '.DS_Store')).toBe(false);
    });

    test('saving owns only the files it writes', () => {
        expect(isManagedFolderSourceFile('ufo', 'glyphs/A_.glif')).toBe(true);
        expect(
            isManagedFolderSourceFile(
                'ufo',
                'glyphs.public.background/contents.plist'
            )
        ).toBe(true);
        expect(isManagedFolderSourceFile('ufo', 'glyphs/layerinfo.plist')).toBe(
            false
        );
        expect(isManagedFolderSourceFile('ufo', 'features/classes.fea')).toBe(
            false
        );
        expect(isManagedFolderSourceFile('ufo', 'images/A.png')).toBe(false);
        expect(
            isManagedFolderSourceFile('glyphspackage', 'glyphs/A_.glyph')
        ).toBe(true);
        expect(
            isManagedFolderSourceFile('glyphspackage', 'kerning.plist')
        ).toBe(true);
        expect(
            isManagedFolderSourceFile('glyphspackage', 'features/calt.2.fea')
        ).toBe(true);
    });

    test('glyph files are told from font-level files', () => {
        expect(isGlyphFile('ufo', 'glyphs.background/A_.glif')).toBe(true);
        expect(isGlyphFile('ufo', 'glyphs/contents.plist')).toBe(false);
        expect(isGlyphFile('glyphspackage', 'glyphs/A_.glyph')).toBe(true);
        expect(isGlyphFile('glyphspackage', 'order.plist')).toBe(false);
    });
});

describe('designspace projects', () => {
    const layout = {
        format: 'designspace',
        document: 'Font.designspace',
        ufoDirs: ['masters/Font-Bold.ufo', 'Font-Light.ufo']
    };

    test("live in the document's folder", () => {
        expect(folderSourceFormatForPath('/a/Font.designspace')).toBe(
            'designspace'
        );
        expect(folderSourceRoot('/a/b/Font.designspace', 'designspace')).toBe(
            '/a/b'
        );
        expect(folderSourceRoot('/a/Font.ufo/', 'ufo')).toBe('/a/Font.ufo');
    });

    test('are the document and the UFOs it names', () => {
        expect(isFolderSourceFile(layout, 'Font.designspace')).toBe(true);
        expect(
            isFolderSourceFile(layout, 'masters/Font-Bold.ufo/glyphs/A_.glif')
        ).toBe(true);
        expect(isFolderSourceFile(layout, 'Font-Light.ufo/images/x.png')).toBe(
            false
        );
        expect(isFolderSourceFile(layout, 'Other.ufo/glyphs/A_.glif')).toBe(
            false
        );
        expect(isFolderSourceFile(layout, 'Other.designspace')).toBe(false);
        expect(isGlyphFile(layout, 'Font-Light.ufo/glyphs/A_.glif')).toBe(true);
        expect(isGlyphFile(layout, 'Font.designspace')).toBe(false);
        expect(
            isManagedFolderSourceFile(layout, 'Font-Light.ufo/fontinfo.plist')
        ).toBe(true);
        expect(
            isManagedFolderSourceFile(
                layout,
                'Font-Light.ufo/glyphs/layerinfo.plist'
            )
        ).toBe(false);
    });

    test('keep the document and UFO layouts for the serializer', () => {
        const state = new FolderSourceState(layout, {
            'Font.designspace': bytes('<designspace/>'),
            'Font-Light.ufo/layercontents.plist': bytes('<plist/>'),
            'Font-Light.ufo/glyphs/A_.glif': bytes('<glyph/>')
        });
        expect(state.documentText()).toBe('<designspace/>');
        expect(state.layoutEntries()).toEqual({
            'Font-Light.ufo/layercontents.plist': '<plist/>'
        });
    });
});

describe('FolderSourceState', () => {
    test('tells changed content from what was read or written', () => {
        const state = new FolderSourceState('ufo', {
            'glyphs/A_.glif': bytes('<glyph/>'),
            'layercontents.plist': bytes('<plist/>'),
            'images/A.png': bytes('png')
        });
        expect(state.isUnchanged('glyphs/A_.glif', '<glyph/>')).toBe(true);
        expect(state.isUnchanged('glyphs/A_.glif', '<glyph />')).toBe(false);
        state.record('glyphs/A_.glif', '<glyph />');
        expect(state.isUnchanged('glyphs/A_.glif', bytes('<glyph />'))).toBe(
            true
        );
        expect(state.layoutEntries()).toEqual({
            'layercontents.plist': '<plist/>'
        });
        expect(state.managedPaths().sort()).toEqual([
            'glyphs/A_.glif',
            'layercontents.plist'
        ]);
        state.forget('glyphs/A_.glif');
        expect(state.has('glyphs/A_.glif')).toBe(false);
    });

    test('hashes include the length', () => {
        expect(hashBytes(bytes('ab'))).not.toBe(hashBytes(bytes('ba')));
        expect(hashBytes(bytes(''))).toMatch(/^0:/);
    });
});

describe('FolderSaveTracker', () => {
    test('a layer edit makes one glyph dirty', () => {
        const tracker = new FolderSaveTracker();
        tracker.recordEntries([entry('glyphs.A:layers.L1:shapes.0.nodes.2.x')]);
        expect(tracker.plan('ufo', true)).toEqual({
            glyphs: ['A'],
            fontLevel: false,
            full: false
        });
        expect(tracker.isGlyphDirty('A')).toBe(true);
        expect(tracker.isGlyphDirty('B')).toBe(false);
    });

    test('glyph-level properties and the order touch font-level files', () => {
        const tracker = new FolderSaveTracker();
        tracker.recordEntries([entry('glyphs.A:production_name')]);
        tracker.recordEntries([entry('glyphOrder')]);
        expect(tracker.plan('ufo', true)).toEqual({
            glyphs: ['A'],
            fontLevel: true,
            full: false
        });
    });

    test('renames dirty both names', () => {
        const tracker = new FolderSaveTracker();
        tracker.recordEntries([
            entry('glyphs.A:name', {
                glyphRenames: [{ oldName: 'A', newName: 'A.alt' }]
            })
        ]);
        expect(tracker.plan('glyphspackage', true).glyphs.sort()).toEqual([
            'A',
            'A.alt'
        ]);
    });

    test('masters, axes and package kerning groups save everything', () => {
        const masters = new FolderSaveTracker();
        masters.recordEntries([entry('masters.0.metrics.ascender')]);
        expect(masters.plan('ufo', true)).toMatchObject({
            fontLevel: true,
            full: false
        });
        masters.recordEntries([entry('masters.1', { op: 'add' })]);
        expect(masters.plan('ufo', true).full).toBe(true);

        const axes = new FolderSaveTracker();
        axes.recordEntries([entry('axes.0.max')]);
        expect(axes.plan('ufo', true).full).toBe(true);

        const groups = new FolderSaveTracker();
        groups.recordEntries([entry('first_kern_groups.O')]);
        expect(groups.plan('ufo', true)).toMatchObject({
            fontLevel: true,
            full: false
        });
        expect(groups.plan('glyphspackage', true).full).toBe(true);
    });

    test('bookkeeping keys are ignored, unrecorded edits save everything', () => {
        const tracker = new FolderSaveTracker();
        tracker.recordEntries([entry('glyphRevisions.A')]);
        expect(tracker.plan('ufo', false)).toEqual({
            glyphs: [],
            fontLevel: false,
            full: false
        });
        expect(tracker.plan('ufo', true).full).toBe(true);
    });

    test('undo rows count their original entries', () => {
        const tracker = new FolderSaveTracker();
        tracker.recordEntries([
            entry('font', {
                historyAction: 'undo',
                semanticChangeLogEntries: [entry('glyphs.B:layers.L1:width')]
            })
        ]);
        expect(tracker.plan('ufo', true).glyphs).toEqual(['B']);
        tracker.reset();
        expect(tracker.plan('ufo', false).glyphs).toEqual([]);
    });
});
