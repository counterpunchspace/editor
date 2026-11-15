// Renaming in a font opened with “Load outlines later”: references are only
// rewritten in loaded glyphs, so a rename waits until every glyph that uses
// the renamed one is loaded.

const { Font } = require('../js/babelfont-model');
const { loadSparseRenameDependents } = require('../js/sparse-rename');

function fontData() {
    const layer = (shapes = []) => ({
        id: 'L1',
        master: { type: 'DefaultForMaster', master: 'm1' },
        width: 500,
        shapes,
        anchors: []
    });
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: [
            { name: 'a', category: 'Base', exported: true, layers: [layer()] },
            {
                name: 'adieresis',
                category: 'Base',
                exported: true,
                layers: [layer([{ Component: { reference: 'a' } }])]
            }
        ],
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    };
}

describe('rename in a partially loaded font', () => {
    afterEach(() => {
        delete window.patchSyncEngine;
        delete window.cloudPlugin;
    });

    test('the model refuses while a glyph using it is not loaded, and changes nothing', () => {
        const font = Font.fromData(fontData());
        window.patchSyncEngine = {
            hasSparseWorkingSet: () => true,
            listSparseWriteBlockers: (names) =>
                names.includes('a') ? ['aring'] : []
        };
        expect(() => font.renameGlyphs(new Map([['a', 'a.ss01']]))).toThrow(
            'aring'
        );
        expect(font.findGlyph('a')).toBeDefined();
        expect(font.findGlyph('a.ss01')).toBeUndefined();
    });

    test('a fully loaded font renames as before', () => {
        const font = Font.fromData(fontData());
        expect(
            require('../js/sparse-rename').sparseRenameBlockers(['a'])
        ).toEqual([]);
        font.renameGlyphs(new Map([['a', 'a.ss01']]));
        expect(font.findGlyph('a.ss01')).toBeDefined();
    });

    test('the dialog loads the glyphs that use it first', async () => {
        let loaded = false;
        window.patchSyncEngine = {
            hasSparseWorkingSet: () => true,
            listSparseWriteBlockers: () => (loaded ? [] : ['aring'])
        };
        window.cloudPlugin = {
            ensureSparseHydration: jest.fn(async () => {
                loaded = true;
            })
        };
        expect(await loadSparseRenameDependents(['a'])).toEqual([]);
        expect(window.cloudPlugin.ensureSparseHydration).toHaveBeenCalledWith({
            glyphNames: ['a'],
            purpose: 'ui'
        });
        // Still missing after loading: the rename stays blocked.
        loaded = false;
        window.cloudPlugin.ensureSparseHydration = jest.fn(async () => {});
        expect(await loadSparseRenameDependents(['a'])).toEqual(['aring']);
    });
});
