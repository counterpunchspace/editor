// A cloud font opened with “Load outlines later” holds only the loaded
// glyphs; Save As would write a copy without the others, so it is refused.

function jqueryStub() {
    const chain = new Proxy(function () {}, {
        get: (_target, key) =>
            key === 'ready' ? (callback) => callback() : () => chain,
        apply: () => chain
    });
    return chain;
}

describe('Save As of a partially loaded font', () => {
    beforeAll(() => {
        global.$ = jqueryStub();
        require('../js/save-button');
    });

    beforeEach(() => {
        window.fontManager = {
            currentFont: {
                path: 'cloud:///asset-1',
                hasUnsavedChanges: false,
                sourcePlugin: { getId: () => 'cloud' }
            }
        };
    });

    afterEach(() => {
        delete window.patchSyncEngine;
        delete window.fontManager;
    });

    test('the menu offers Save As only for a fully loaded font', () => {
        window.patchSyncEngine = { hasSparseWorkingSet: () => false };
        expect(window.saveButton.canSaveAs()).toBe(true);
        window.patchSyncEngine = { hasSparseWorkingSet: () => true };
        expect(window.saveButton.canSaveAs()).toBe(false);
    });

    test('saving as refuses before anything is written', async () => {
        const { saveCurrentFontAs } = require('../js/font-files');
        const writeFile = jest.fn();
        window.patchSyncEngine = { hasSparseWorkingSet: () => true };
        const plugin = {
            getId: () => 'disk',
            getAdapter: () => ({ writeFile })
        };
        await expect(
            saveCurrentFontAs(plugin, '/Copy.glyphs', { exists: false })
        ).rejects.toThrow('Load outlines later');
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('the Save As dialog explains instead of opening', async () => {
        const dialogs = require('../js/font-windows/dialogs');
        const notice = jest
            .spyOn(dialogs, 'showNotice')
            .mockImplementation(() => {});
        const {
            showSaveAsDialog
        } = require('../js/font-windows/save-as-dialog');
        window.patchSyncEngine = { hasSparseWorkingSet: () => true };
        await showSaveAsDialog();
        expect(notice).toHaveBeenCalledWith(
            expect.stringContaining('Load outlines later')
        );
        expect(document.querySelector('.dialog-overlay, dialog')).toBeNull();
    });
});
