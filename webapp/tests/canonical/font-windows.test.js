/**
 * APP.md → "Launcher, Font Windows and Files on Disk".
 */
const fs = require('fs');
const path = require('path');

class FakeBroadcastChannel {
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
}

beforeAll(() => {
    global.BroadcastChannel = global.BroadcastChannel || FakeBroadcastChannel;
    if (!global.crypto?.randomUUID) {
        let n = 0;
        global.crypto = {
            ...(global.crypto || {}),
            randomUUID: () =>
                `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        };
    }
    if (!navigator.locks) {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: () => new Promise(() => {}),
                query: async () => ({ held: [] })
            }
        });
    }
});

jest.mock('../../js/filesystem-plugins/registry', () => ({
    pluginRegistry: { get: () => null }
}));

describe('Counterpunch starts with the launcher', () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf8')
    );

    test('the installed app opens the launcher', () => {
        expect(manifest.start_url).toBe('./launcher.html');
        expect(manifest.launch_handler.client_mode).toBe('navigate-new');
    });

    test('fonts opened from the file manager open a font window, one per launch', () => {
        const [handler] = manifest.file_handlers;
        expect(handler.action).toBe('./index.html?launch=1');
        expect(handler.launch_type).toBe('multiple-clients');
    });
});

describe('every font opens in its own window, found by its document key', () => {
    let openDocuments;
    let fontWindow;
    let registry;

    beforeAll(() => {
        openDocuments = require('../../js/font-windows/open-documents');
        fontWindow = require('../../js/font-windows/font-window');
        registry = require('../../js/font-windows/window-registry');
    });

    test('a font window is named after its document key', () => {
        expect(registry.fontWindowName('disk:///ab12/Font.glyphs')).toBe(
            'cp-font:disk:///ab12/Font.glyphs'
        );
        expect(
            registry.documentKeyOfWindowName('cp-font:memory:///user/A.ufo')
        ).toBe('memory:///user/A.ufo');
        expect(registry.documentKeyOfWindowName('cp-launcher')).toBeNull();
    });

    test('the window URL names the font, and the URL gives the key back', () => {
        const key = 'disk:///ab12/Font.glyphs';
        const url = openDocuments.fontWindowUrl(key);
        expect(url).toBe(`index.html?file=${encodeURIComponent(key)}`);
        expect(
            fontWindow.documentKeyFromUrl(url.slice('index.html'.length))
        ).toBe(key);
    });

    test('a new font has its own key and URL until it is saved', () => {
        const key = openDocuments.newFontKey();
        expect(openDocuments.isNewFontKey(key)).toBe(true);
        const url = openDocuments.fontWindowUrl(key);
        expect(url).toMatch(/^index\.html\?new=[\w-]+$/);
        expect(
            fontWindow.documentKeyFromUrl(url.slice('index.html'.length))
        ).toBe(key);
    });

    test('taking a font over from an unlinked window is part of the URL', () => {
        expect(
            openDocuments.fontWindowUrl('cloud:///asset', { takeOver: true })
        ).toContain('takeover=1');
    });

    test('a font that is not open anywhere has no open state', () => {
        expect(registry.documentOpenState('disk:///none/X.glyphs')).toBeNull();
    });
});

describe('fonts on this computer', () => {
    let disk;
    let formats;

    beforeAll(() => {
        disk = require('../../js/font-windows/disk-documents');
        formats = require('../../js/font-windows/font-formats');
    });

    test('a disk font is keyed by its document id and name', () => {
        const key = disk.diskDocumentKey({ id: 'ab12', name: 'My Font.ufo' });
        expect(key).toBe('disk:///ab12/My Font.ufo');
        expect(disk.diskDocumentIdFromPath('/ab12/My Font.ufo')).toBe('ab12');
    });

    test('formats know whether they are files, packages or projects', () => {
        expect(formats.fontFormatOf('Font.UFO')).toBe('ufo');
        expect(formats.fontFormatKind('ufo')).toBe('package');
        expect(formats.fontFormatKind('glyphspackage')).toBe('package');
        expect(formats.fontFormatKind('designspace')).toBe('project');
        expect(formats.fontFormatKind('glyphs')).toBe('file');
        expect(formats.fontFormatOf('notes.txt')).toBeNull();
    });

    test('a pasted file name gives Save As its name and format', () => {
        expect(formats.splitFontFileName('My Font.UFO')).toEqual({
            name: 'My Font',
            format: 'ufo'
        });
        expect(
            formats.splitFontFileName('/Users/me/Fonts/Sans.glyphspackage ')
        ).toEqual({ name: 'Sans', format: 'glyphspackage' });
        expect(formats.splitFontFileName('C:\\Fonts\\Sans.glyphs')).toEqual({
            name: 'Sans',
            format: 'glyphs'
        });
        // No extension, one Save As can't write, or nothing before it.
        expect(formats.splitFontFileName('Sans Bold')).toBeNull();
        expect(formats.splitFontFileName('Sans.vfj')).toBeNull();
        expect(formats.splitFontFileName('.glyphs')).toBeNull();
    });

    test('Save As offers only formats Counterpunch can write', () => {
        const writable = Object.entries(formats.FONT_FORMATS)
            .filter(([, format]) => format.writable)
            .map(([key]) => key)
            .sort();
        expect(writable).toEqual(
            [
                'babelfont',
                'designspace',
                'glyphs',
                'glyphspackage',
                'ufo'
            ].sort()
        );
    });
});

describe('Save As starts where the font lives', () => {
    const {
        chooseSaveDestination
    } = require('../../js/font-windows/save-destination');
    const all = { fileAccess: true, cloud: true };

    test('a saved font starts at its own place', () => {
        expect(chooseSaveDestination('cloud', 'disk', all)).toBe('cloud');
        expect(chooseSaveDestination('browser', 'disk', all)).toBe('browser');
    });

    test('a new font starts at the last destination, else this computer', () => {
        expect(chooseSaveDestination(null, 'browser', all)).toBe('browser');
        expect(chooseSaveDestination(null, null, all)).toBe('disk');
        expect(chooseSaveDestination(null, 'nonsense', all)).toBe('disk');
    });

    test('an unavailable place falls back to this computer, then browser storage', () => {
        expect(
            chooseSaveDestination('cloud', null, {
                fileAccess: true,
                cloud: false
            })
        ).toBe('disk');
        expect(
            chooseSaveDestination('cloud', null, {
                fileAccess: false,
                cloud: false
            })
        ).toBe('browser');
        expect(
            chooseSaveDestination(null, 'disk', {
                fileAccess: false,
                cloud: true
            })
        ).toBe('browser');
    });
});

describe('OtherFonts() reads and edits the fonts of the other windows', () => {
    const fakeWindows = [];

    beforeAll(() => {
        jest.doMock('../../js/font-windows/window-registry', () => ({
            fontWindows: () => fakeWindows
        }));
        jest.doMock('../../js/python-ui-sync', () => ({
            openPythonEditContext: jest.fn()
        }));
        jest.doMock('../../js/python-post-execution', () => ({
            commitPythonExecutionSyntheticChanges: jest.fn()
        }));
        jest.isolateModules(() => {
            require('../../js/font-windows/other-fonts');
        });
    });

    function fakeFontWindow(model) {
        return {
            closed: false,
            currentFontModel: model,
            counterpunchPythonGuest: {
                begin: jest.fn(() => ({ code: 'OtherFonts()' })),
                end: jest.fn()
            }
        };
    }

    test('returns the other fonts and opens one edit session per window and script', async () => {
        const a = fakeFontWindow({ name: 'A' });
        const b = fakeFontWindow({ name: 'B' });
        const empty = fakeFontWindow(null);
        fakeWindows.splice(0, fakeWindows.length, a, b, empty);

        expect(window.counterpunchOtherFontModels()).toEqual([
            { name: 'A' },
            { name: 'B' }
        ]);
        window.counterpunchOtherFontModels();
        expect(a.counterpunchPythonGuest.begin).toHaveBeenCalledTimes(1);
        expect(b.counterpunchPythonGuest.begin).toHaveBeenCalledTimes(1);
        expect(empty.counterpunchPythonGuest.begin).not.toHaveBeenCalled();

        // The script ends: each window records the edit in its own history.
        await window.afterPythonExecution({ succeeded: true });
        expect(a.counterpunchPythonGuest.end).toHaveBeenCalledWith(
            { code: 'OtherFonts()' },
            { succeeded: true }
        );
        expect(b.counterpunchPythonGuest.end).toHaveBeenCalledTimes(1);

        // The next script opens new sessions.
        window.counterpunchOtherFontModels();
        expect(a.counterpunchPythonGuest.begin).toHaveBeenCalledTimes(2);
    });
});

describe('updates reach every window', () => {
    const { shouldReloadForUpdate } = require('../../js/app-update');

    test('a window without unsaved work reloads into the new version', () => {
        expect(
            shouldReloadForUpdate({ applying: false, hasUnsavedWork: false })
        ).toBe(true);
    });

    test('a window with unsaved work keeps it and asks instead', () => {
        expect(
            shouldReloadForUpdate({ applying: false, hasUnsavedWork: true })
        ).toBe(false);
    });

    test('the window that asked for the update reloads by itself', () => {
        expect(
            shouldReloadForUpdate({ applying: true, hasUnsavedWork: false })
        ).toBe(false);
    });

    test('a same-font view window follows its main window', () => {
        expect(
            shouldReloadForUpdate({
                applying: false,
                hasUnsavedWork: false,
                isView: true,
                mainHasUnsavedWork: true
            })
        ).toBe(false);
        expect(
            shouldReloadForUpdate({
                applying: false,
                hasUnsavedWork: false,
                isView: true,
                mainHasUnsavedWork: false
            })
        ).toBe(true);
    });
});

describe('only windows of the same build link', () => {
    let registry;

    beforeAll(() => {
        jest.isolateModules(() => {
            // The OtherFonts() tests above mock this module.
            registry = jest.requireActual(
                '../../js/font-windows/window-registry'
            );
        });
    });

    function fakeWindow(name, build) {
        return {
            name,
            closed: false,
            document: { title: name },
            counterpunchWindows: {
                instance: `instance-${name}`,
                build,
                role: 'font',
                documentKey: registry.documentKeyOfWindowName(name),
                peers: new Map(),
                register() {},
                peerChanged() {},
                peerLeaving() {}
            }
        };
    }

    test('a window of the same build links', () => {
        const own = window.counterpunchWindows.build;
        window.counterpunchWindows.register(
            fakeWindow('cp-font:memory:///user/Same.glyphs', own)
        );
        expect(registry.documentOpenState('memory:///user/Same.glyphs')).toBe(
            'linked'
        );
    });

    test('a window of another version is open but not linked', () => {
        window.counterpunchWindows.register(
            fakeWindow('cp-font:memory:///user/Old.glyphs', 'v0.0.1+old')
        );
        expect(registry.documentOpenState('memory:///user/Old.glyphs')).toBe(
            'unlinked'
        );
        expect(registry.fontWindows().map((w) => w.name)).not.toContain(
            'cp-font:memory:///user/Old.glyphs'
        );
    });

    test('a linked window that reloads into another version stops being linked', () => {
        const win = fakeWindow(
            'cp-font:memory:///user/Reloaded.glyphs',
            window.counterpunchWindows.build
        );
        window.counterpunchWindows.register(win);
        expect(
            registry.documentOpenState('memory:///user/Reloaded.glyphs')
        ).toBe('linked');
        win.counterpunchWindows = {
            ...win.counterpunchWindows,
            build: 'v9.9.9+new'
        };
        expect(
            registry.documentOpenState('memory:///user/Reloaded.glyphs')
        ).toBe('unlinked');
    });
});
