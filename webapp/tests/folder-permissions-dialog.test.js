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

describe('folder permissions auto-prompt session persistence', () => {
    beforeEach(() => {
        jest.resetModules();
        window.sessionStorage.clear();
        delete window.__folderPermissionsHost;
        document.body.innerHTML = '';
    });

    test('does not re-open automatically on reload after dismissal in the same session', async () => {
        const originalPicker = window.showDirectoryPicker;
        const originalTestMode = window.isTestMode;
        window.showDirectoryPicker = function () {};
        window.isTestMode = () => false;

        try {
            const { settingsFolder } = require('../js/settings-folder');
            jest.spyOn(settingsFolder, 'initialize').mockResolvedValue(true);
            jest.spyOn(settingsFolder, 'getAccessState').mockResolvedValue(
                'needsRenewal'
            );
            jest.spyOn(settingsFolder, 'getFolderName').mockReturnValue(
                'Counterpunch'
            );

            const folderPermissions = require('../js/folder-permissions-dialog');
            await folderPermissions.maybeShowFolderPermissionsDialog();
            expect(
                document.querySelector('.folder-permissions-dialog')
            ).not.toBeNull();

            // Dismiss via Skip button
            document.querySelector('[data-action="skip"]').click();
            expect(
                document.querySelector('.folder-permissions-dialog')
            ).toBeNull();

            // Simulate a reload in the same browser session (in-memory host reset, sessionStorage kept)
            delete window.__folderPermissionsHost;
            jest.resetModules();
            const reloadedSettings = require('../js/settings-folder');
            jest.spyOn(
                reloadedSettings.settingsFolder,
                'initialize'
            ).mockResolvedValue(true);
            jest.spyOn(
                reloadedSettings.settingsFolder,
                'getAccessState'
            ).mockResolvedValue('needsRenewal');
            jest.spyOn(
                reloadedSettings.settingsFolder,
                'getFolderName'
            ).mockReturnValue('Counterpunch');

            const reloadedDialog = require('../js/folder-permissions-dialog');
            await reloadedDialog.maybeShowFolderPermissionsDialog();
            expect(
                document.querySelector('.folder-permissions-dialog')
            ).toBeNull();
        } finally {
            window.showDirectoryPicker = originalPicker;
            window.isTestMode = originalTestMode;
            window.sessionStorage.clear();
            delete window.__folderPermissionsHost;
        }
    });

    test('closes automatically when a new user selects the Settings Folder', async () => {
        const originalPicker = window.showDirectoryPicker;
        const originalTestMode = window.isTestMode;
        window.showDirectoryPicker = function () {};
        window.isTestMode = () => false;

        try {
            const { settingsFolder } = require('../js/settings-folder');
            let state = 'missing';
            jest.spyOn(settingsFolder, 'initialize').mockResolvedValue(false);
            jest.spyOn(settingsFolder, 'getAccessState').mockImplementation(
                async () => state
            );
            jest.spyOn(settingsFolder, 'getFolderName').mockImplementation(
                () => (state === 'ready' ? 'Counterpunch' : null)
            );
            jest.spyOn(settingsFolder, 'selectFolder').mockImplementation(
                async () => {
                    state = 'ready';
                    return true;
                }
            );

            const folderPermissions = require('../js/folder-permissions-dialog');
            await folderPermissions.maybeShowFolderPermissionsDialog();
            expect(
                document.querySelector('.folder-permissions-dialog')
            ).not.toBeNull();
            expect(
                document.querySelector('[data-action="continue"]')
            ).toBeNull();

            document.querySelector('[data-folder-action="select"]').click();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(
                document.querySelector('.folder-permissions-dialog')
            ).toBeNull();
        } finally {
            window.showDirectoryPicker = originalPicker;
            window.isTestMode = originalTestMode;
            window.sessionStorage.clear();
            delete window.__folderPermissionsHost;
        }
    });

    test('closes automatically when a returning user renews Settings Folder access', async () => {
        const originalPicker = window.showDirectoryPicker;
        const originalTestMode = window.isTestMode;
        window.showDirectoryPicker = function () {};
        window.isTestMode = () => false;

        try {
            const { settingsFolder } = require('../js/settings-folder');
            let state = 'needsRenewal';
            jest.spyOn(settingsFolder, 'initialize').mockResolvedValue(true);
            jest.spyOn(settingsFolder, 'getAccessState').mockImplementation(
                async () => state
            );
            jest.spyOn(settingsFolder, 'getFolderName').mockReturnValue(
                'Counterpunch'
            );
            jest.spyOn(settingsFolder, 'renewPermission').mockImplementation(
                async () => {
                    state = 'ready';
                    return true;
                }
            );

            const folderPermissions = require('../js/folder-permissions-dialog');
            await folderPermissions.maybeShowFolderPermissionsDialog();
            expect(
                document.querySelector('.folder-permissions-dialog')
            ).not.toBeNull();

            document.querySelector('[data-folder-action="renew"]').click();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(
                document.querySelector('.folder-permissions-dialog')
            ).toBeNull();
        } finally {
            window.showDirectoryPicker = originalPicker;
            window.isTestMode = originalTestMode;
            window.sessionStorage.clear();
            delete window.__folderPermissionsHost;
        }
    });
});
