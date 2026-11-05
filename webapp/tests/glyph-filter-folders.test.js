jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn(() => ({
        props: {},
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }))
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });
jest.mock('../js/ui/confirm-dialog', () => ({ showProceedDialog: jest.fn() }));

const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');
const { settingsFolder } = require('../js/settings-folder');
const { showProceedDialog } = require('../js/ui/confirm-dialog');
const { filterChatRegistry } = require('../js/glyph-filter-chat');

/** Settings Folder in memory: file paths → text, plus folder paths. */
function memoryFolder(files, folders = []) {
    const dirs = new Set(['/Filters', ...folders]);
    const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));
    const childrenOf = (path) => ({
        files: Object.keys(files).filter((file) => parentOf(file) === path),
        dirs: [...dirs].filter((dir) => parentOf(dir) === path)
    });
    return {
        files,
        dirs,
        hasDirectory: () => true,
        initialize: jest.fn(async () => true),
        fileExists: jest.fn(async (path) => path in files || dirs.has(path)),
        readFile: jest.fn(async (path) => files[path]),
        writeFile: jest.fn(async (path, text) => {
            files[path] = text;
        }),
        createFolder: jest.fn(async (path) => {
            dirs.add(path);
        }),
        deleteItem: jest.fn(async (path, isDir) => {
            if (isDir) {
                for (const key of Object.keys(files)) {
                    if (key.startsWith(`${path}/`)) delete files[key];
                }
                for (const dir of [...dirs]) {
                    if (dir === path || dir.startsWith(`${path}/`)) {
                        dirs.delete(dir);
                    }
                }
            } else {
                delete files[path];
            }
        }),
        scanDirectory: jest.fn(async (path) => {
            const { files: inFiles, dirs: inDirs } = childrenOf(path);
            const entries = {};
            for (const file of inFiles) {
                entries[file.slice(path.length + 1)] = { is_dir: false };
            }
            for (const dir of inDirs) {
                entries[dir.slice(path.length + 1)] = { is_dir: true };
            }
            return entries;
        }),
        listFilesRecursive: jest.fn(async (path) =>
            Object.keys(files)
                .filter((file) => file.startsWith(`${path}/`))
                .map((file) => ({ path: file, is_dir: false }))
        )
    };
}

describe('user filter folders', () => {
    let manager;
    let adapter;

    function setup(files, folders) {
        adapter = memoryFolder(files, folders);
        jest.spyOn(settingsFolder, 'getAdapter').mockReturnValue(adapter);
        manager = new GlyphOverviewFilterManager();
        jest.spyOn(manager, 'discoverUserFilters').mockResolvedValue();
        // The sidebar refresh is covered elsewhere; only file effects matter.
        jest.spyOn(
            GlyphOverviewFilterManager.prototype,
            'queueUserFilterFileChangeRefresh'
        ).mockImplementation(() => {});
    }

    afterEach(() => {
        jest.restoreAllMocks();
        showProceedDialog.mockReset();
    });

    test('lists empty folders and nested ones, down to the nesting limit', async () => {
        setup({ '/Filters/A/x.py': 'x' }, [
            '/Filters/A',
            '/Filters/A/B',
            '/Filters/A/B/Too Deep',
            '/Filters/Empty'
        ]);
        expect((await manager.listUserFilterFolders()).sort()).toEqual([
            'A',
            'A/B',
            'Empty'
        ]);
    });

    test('creates a folder and refuses a taken name ignoring case', async () => {
        setup({}, ['/Filters/Latin']);
        await expect(
            manager.createUserFilterFolder('/Filters', 'latin')
        ).rejects.toThrow('A folder named “latin” already exists.');
        await expect(
            manager.createUserFilterFolder('/Filters', 'Arabic')
        ).resolves.toBe('/Filters/Arabic');
        expect(adapter.dirs.has('/Filters/Arabic')).toBe(true);
    });

    test('moves a filter into a folder and keeps its chat', async () => {
        setup({ '/Filters/Caps.py': 'code' }, ['/Filters/Latin']);
        const rename = jest.spyOn(filterChatRegistry, 'rename');

        await expect(
            manager.moveUserFilter('/Filters/Caps.py', '/Filters/Latin')
        ).resolves.toBe('/Filters/Latin/Caps.py');
        expect(adapter.files).toEqual({ '/Filters/Latin/Caps.py': 'code' });
        expect(rename).toHaveBeenCalledWith(
            '/Filters/Caps.py',
            '/Filters/Latin/Caps.py'
        );
        expect(showProceedDialog).not.toHaveBeenCalled();
    });

    test('asks before replacing a filter with the same name at the destination', async () => {
        setup({ '/Filters/Caps.py': 'new', '/Filters/Latin/caps.py': 'old' }, [
            '/Filters/Latin'
        ]);

        showProceedDialog.mockResolvedValueOnce(false);
        await expect(
            manager.moveUserFilter('/Filters/Caps.py', '/Filters/Latin')
        ).resolves.toBeNull();
        expect(adapter.files['/Filters/Latin/caps.py']).toBe('old');
        expect(adapter.files['/Filters/Caps.py']).toBe('new');

        showProceedDialog.mockResolvedValueOnce(true);
        await manager.moveUserFilter('/Filters/Caps.py', '/Filters/Latin');
        expect(adapter.files).toEqual({ '/Filters/Latin/Caps.py': 'new' });
        expect(showProceedDialog.mock.calls[1][2]).toMatchObject({
            proceedLabel: 'Replace',
            danger: true
        });
    });

    test('deletes an empty folder at once and asks for one with contents', async () => {
        setup({ '/Filters/Full/a.py': 'a', '/Filters/Full/Sub/b.py': 'b' }, [
            '/Filters/Empty',
            '/Filters/Full',
            '/Filters/Full/Sub'
        ]);
        const node = (path) => ({
            path,
            displayName: path.split('/').pop(),
            children: new Map(),
            plugins: [],
            expanded: true
        });

        await manager.deleteUserFilterFolder(node('user/Empty'));
        expect(showProceedDialog).not.toHaveBeenCalled();
        expect(adapter.dirs.has('/Filters/Empty')).toBe(false);

        showProceedDialog.mockResolvedValueOnce(false);
        await manager.deleteUserFilterFolder(node('user/Full'));
        expect(showProceedDialog.mock.calls[0][1]).toBe(
            'It contains 2 filters and 1 subfolder, which will be deleted with it. This cannot be undone.'
        );
        expect(adapter.files['/Filters/Full/a.py']).toBe('a');

        showProceedDialog.mockResolvedValueOnce(true);
        await manager.deleteUserFilterFolder(node('user/Full'));
        expect(adapter.files).toEqual({});
        expect(adapter.dirs.has('/Filters/Full')).toBe(false);
    });

    test('the sidebar shows folders, a folder button and draggable filters that drop into folders', async () => {
        setup({ '/Filters/Caps.py': 'x' }, ['/Filters/Latin']);
        jest.spyOn(settingsFolder, 'hasFolder').mockReturnValue(true);
        const move = jest
            .spyOn(manager, 'moveUserFilter')
            .mockResolvedValue(null);
        const caps = {
            path: 'user',
            keyword: 'user.Caps',
            display_name: 'Caps',
            isUserFilter: true,
            filePath: '/Filters/Caps.py',
            groups: {},
            eventTypes: [],
            classifications: new Map()
        };
        manager.userFilters = [caps];
        manager.addUserFilterToTree(caps, '');
        manager.addUserFolderToTree('Latin');
        manager.sidebarContainer = document.createElement('div');
        manager.renderSidebar();
        const sidebar = manager.sidebarContainer;

        expect(
            sidebar.querySelector('.glyph-filter-new-folder-btn')
        ).not.toBeNull();
        const folder = sidebar.querySelector('.glyph-filter-user-folder');
        expect(folder.textContent).toContain('Latin');
        const item = sidebar.querySelector('[data-plugin-keyword="user.Caps"]');
        expect(item.draggable).toBe(true);

        const drop = new Event('drop', { bubbles: true, cancelable: true });
        drop.dataTransfer = {
            types: ['application/x-counterpunch-user-filter'],
            getData: () => '/Filters/Caps.py'
        };
        folder.dispatchEvent(drop);
        expect(move).toHaveBeenCalledWith('/Filters/Caps.py', '/Filters/Latin');
    });
});
