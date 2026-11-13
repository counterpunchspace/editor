// Save in a linked window saves through the font's main window, which holds
// the file, its folder layout and the access to it.

/** A jQuery stand-in: every call returns itself; `ready` runs at once. */
function jqueryStub() {
    const chain = new Proxy(function () {}, {
        get: (_target, key) =>
            key === 'ready' ? (callback) => callback() : () => chain,
        apply: () => chain
    });
    return chain;
}

function mainWindow({ savesCleanly }) {
    const main = {
        windowRole: { isMainWindow: () => true },
        fontManager: {
            currentFont: {
                path: '/o/r/A.glyphspackage',
                hasUnsavedChanges: true
            }
        },
        saveButton: {
            handleSave: jest.fn(async () => {
                if (savesCleanly)
                    main.fontManager.currentFont.hasUnsavedChanges = false;
            })
        }
    };
    return main;
}

function linkedWindow(opener) {
    Object.defineProperty(window, 'opener', {
        value: opener,
        configurable: true
    });
    window.windowRole = {
        isLinkedWindow: () => true,
        isMainWindow: () => false
    };
    window.fontManager = {
        currentFont: {
            path: '/o/r/A.glyphspackage',
            hasUnsavedChanges: true,
            sourcePlugin: { getId: () => 'memory' },
            folderSaveTracker: { reset: jest.fn() }
        },
        updateDirtyIndicator: jest.fn(async () => {}),
        hasUnsyncedChanges: () => true
    };
}

describe('Save in a linked window', () => {
    beforeAll(() => {
        global.$ = jqueryStub();
        require('../js/save-button');
    });

    afterEach(() => {
        delete window.windowRole;
        delete window.fontManager;
        Object.defineProperty(window, 'opener', {
            value: null,
            configurable: true
        });
    });

    test('saves through the main window and is clean afterwards', async () => {
        const main = mainWindow({ savesCleanly: true });
        linkedWindow(main);

        await window.saveButton.handleSave();

        expect(main.saveButton.handleSave).toHaveBeenCalledTimes(1);
        expect(window.fontManager.currentFont.hasUnsavedChanges).toBe(false);
        expect(
            window.fontManager.currentFont.folderSaveTracker.reset
        ).toHaveBeenCalled();
    });

    test('stays changed when the main window could not save', async () => {
        const main = mainWindow({ savesCleanly: false });
        linkedWindow(main);

        await window.saveButton.handleSave();

        expect(main.saveButton.handleSave).toHaveBeenCalledTimes(1);
        expect(window.fontManager.currentFont.hasUnsavedChanges).toBe(true);
    });

    test('finds the main window through another linked window', async () => {
        const main = mainWindow({ savesCleanly: true });
        const middle = {
            windowRole: { isMainWindow: () => false },
            opener: main
        };
        linkedWindow(middle);

        await window.saveButton.handleSave();

        expect(main.saveButton.handleSave).toHaveBeenCalledTimes(1);
    });

    test('a main window showing another font is not used', async () => {
        const main = mainWindow({ savesCleanly: true });
        main.fontManager.currentFont.path = '/o/r/Other.glyphs';
        linkedWindow(main);

        await window.saveButton.handleSave();

        expect(main.saveButton.handleSave).not.toHaveBeenCalled();
    });
});
