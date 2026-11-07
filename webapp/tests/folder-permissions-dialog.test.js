describe('folder access classification', () => {
    let folderPermissions;

    beforeEach(() => {
        jest.resetModules();
        folderPermissions = require('../js/folder-permissions-dialog');
    });

    test('missing when no handle is stored', () => {
        expect(folderPermissions.classifyFolderAccess(false, null)).toBe(
            'missing'
        );
        expect(folderPermissions.classifyFolderAccess(false, 'granted')).toBe(
            'missing'
        );
    });

    test('needs renewal when a handle exists without granted permission', () => {
        expect(folderPermissions.classifyFolderAccess(true, 'prompt')).toBe(
            'needsRenewal'
        );
        expect(folderPermissions.classifyFolderAccess(true, 'denied')).toBe(
            'needsRenewal'
        );
        expect(folderPermissions.classifyFolderAccess(true, null)).toBe(
            'needsRenewal'
        );
    });

    test('ready only when the handle is granted', () => {
        expect(folderPermissions.classifyFolderAccess(true, 'granted')).toBe(
            'ready'
        );
    });

    test('setup is complete only when the settings folder is ready', () => {
        expect(
            folderPermissions.isFolderSetupComplete({
                settings: { state: 'ready', name: 'Counterpunch' }
            })
        ).toBe(true);
        expect(
            folderPermissions.isFolderSetupComplete({
                settings: { state: 'needsRenewal', name: 'Counterpunch' }
            })
        ).toBe(false);
        expect(
            folderPermissions.isFolderSetupComplete({
                settings: { state: 'missing', name: null }
            })
        ).toBe(false);
    });
});

describe('File System Access detection', () => {
    test('requires showDirectoryPicker to be a function', () => {
        jest.resetModules();
        const adapter = require('../js/file-system-adapter');
        const original = window.showDirectoryPicker;
        try {
            window.showDirectoryPicker = undefined;
            expect(adapter.isFileSystemAccessSupported()).toBe(false);
            window.showDirectoryPicker = function () {};
            expect(adapter.isFileSystemAccessSupported()).toBe(true);
        } finally {
            window.showDirectoryPicker = original;
        }
    });
});

describe('folder permissions unavailable copy', () => {
    test('explains that Brave and Firefox cannot link folders', () => {
        jest.resetModules();
        const folderPermissions = require('../js/folder-permissions-dialog');
        const missingStatus = {
            settings: { state: 'missing', name: null }
        };
        const copy = folderPermissions.getFolderPermissionsDialogCopy(
            missingStatus,
            false
        );
        expect(copy.title).toBe(
            folderPermissions.FOLDER_ACCESS_UNAVAILABLE_COPY.title
        );
        expect(copy.intro).toMatch(/Brave/);
        expect(copy.intro).toMatch(/Firefox/);
        expect(copy.intro).toMatch(
            /<strong>Chrome\/Chromium, Safari, or Edge<\/strong>/
        );
        expect(
            folderPermissions.getFolderPermissionsDialogCopy(
                missingStatus,
                true
            ).title
        ).toBe('Link Settings Folder');
    });
});
