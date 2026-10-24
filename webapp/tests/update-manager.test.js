const {
    parseSwVersions,
    changelogUrlForUpdate,
    pendingUpdateFromSw,
    hasAvailableUpdate,
    pickLatestGitHubRelease,
    shouldShowForceUpdate,
    isAppWindowActive,
    didAppWindowBecomeActive,
    isPreviewReleaseId,
    shouldForceReinstallFromUrl,
    updateReadiness
} = require('../js/update-manager.ts');

describe('update-manager version helpers', () => {
    test('parses cache-bust tag and display version', () => {
        const info = parseSwVersions(`
            const VERSION = 'v0.0.0-preview.20260816.1';
            const DISPLAY_VERSION = '20260816-build-1';
        `);
        expect(info).toEqual({
            tag: 'v0.0.0-preview.20260816.1',
            displayVersion: '20260816-build-1',
            isPreview: true
        });
        expect(pendingUpdateFromSw(info)).toEqual({
            version: '20260816-build-1',
            tag: 'v0.0.0-preview.20260816.1',
            isPreview: true
        });
        expect(changelogUrlForUpdate(pendingUpdateFromSw(info))).toBe(
            'https://github.com/counterpunchspace/editor/releases/tag/v0.0.0-preview.20260816.1'
        );
    });

    test('parses webpack-minified concatenated const declarations', () => {
        const info = parseSwVersions(
            'let coepCredentialless=!1;const VERSION="v0.0.0-preview.20260822.6",DISPLAY_VERSION="20260822-build-6",CACHE_NAME="counterpunch-pwa-"+VERSION;'
        );
        expect(info).toEqual({
            tag: 'v0.0.0-preview.20260822.6',
            displayVersion: '20260822-build-6',
            isPreview: true
        });
    });

    test('falls back to VERSION when DISPLAY_VERSION is missing', () => {
        const info = parseSwVersions(`const VERSION = 'v0.2.1';`);
        expect(info).toEqual({
            tag: 'v0.2.1',
            displayVersion: 'v0.2.1',
            isPreview: false
        });
    });

    test('does not treat DISPLAY_VERSION as VERSION', () => {
        const info = parseSwVersions(
            `const DISPLAY_VERSION = 'v0.2.1'; const VERSION = 'v0.2.1';`
        );
        expect(info.tag).toBe('v0.2.1');
        expect(info.displayVersion).toBe('v0.2.1');
    });

    test('detects a newer preview from the running display version', () => {
        const published = parseSwVersions(
            'const VERSION="v0.0.0-preview.20260822.6",DISPLAY_VERSION="20260822-build-6";'
        );
        expect(hasAvailableUpdate(published, '20260821-build-5', null)).toBe(
            true
        );
        expect(hasAvailableUpdate(published, '20260822-build-6', null)).toBe(
            false
        );
        expect(
            hasAvailableUpdate(
                published,
                '20260822-build-6',
                'v0.0.0-preview.20260822.6'
            )
        ).toBe(false);
    });

    test('treats window activation as visible plus hasFocus', () => {
        expect(isAppWindowActive('visible', true)).toBe(true);
        expect(isAppWindowActive('visible', false)).toBe(false);
        expect(isAppWindowActive('hidden', true)).toBe(false);
        expect(didAppWindowBecomeActive(false, true)).toBe(true);
        expect(didAppWindowBecomeActive(true, true)).toBe(false);
        expect(didAppWindowBecomeActive(false, false)).toBe(false);
    });

    test('offers force update only after a manual check with no pending build', () => {
        expect(shouldShowForceUpdate(null, false)).toBe(false);
        expect(shouldShowForceUpdate(null, true)).toBe(true);
        expect(
            shouldShowForceUpdate(
                {
                    version: '20260822-build-6',
                    tag: 'v0.0.0-preview.20260822.6',
                    isPreview: true
                },
                true
            )
        ).toBe(false);
    });

    test('picks the latest GitHub prerelease on the preview channel', () => {
        const picked = pickLatestGitHubRelease(
            [
                {
                    tag_name: 'v0.0.0-preview.20260822.6',
                    name: '20260822-build-6',
                    prerelease: true
                },
                {
                    tag_name: 'v0.0.0-preview.20260821.5',
                    name: '20260821-build-5',
                    prerelease: true
                },
                { tag_name: 'v0.2.1', name: 'v0.2.1', prerelease: false }
            ],
            true
        );
        expect(picked).toEqual({
            tag: 'v0.0.0-preview.20260822.6',
            displayVersion: 'v0.0.0-preview.20260822.6',
            isPreview: true
        });
        expect(
            pickLatestGitHubRelease(
                [{ tag_name: 'v0.2.1', name: 'v0.2.1', prerelease: false }],
                false
            )
        ).toEqual({
            tag: 'v0.2.1',
            displayVersion: 'v0.2.1',
            isPreview: false
        });
    });

    test('treats v0.0.N-pre.DATE as a preview id', () => {
        expect(isPreviewReleaseId('v0.0.11-pre.20260822')).toBe(true);
        expect(isPreviewReleaseId('v0.2.1')).toBe(false);
        const info = parseSwVersions(
            'const VERSION="v0.0.11-pre.20260822",DISPLAY_VERSION="v0.0.11-pre.20260822";'
        );
        expect(info).toEqual({
            tag: 'v0.0.11-pre.20260822',
            displayVersion: 'v0.0.11-pre.20260822',
            isPreview: true
        });
        expect(
            pickLatestGitHubRelease(
                [
                    {
                        tag_name: 'v0.0.11-pre.20260822',
                        name: 'v0.0.11-pre.20260822',
                        prerelease: true
                    }
                ],
                true
            )
        ).toEqual({
            tag: 'v0.0.11-pre.20260822',
            displayVersion: 'v0.0.11-pre.20260822',
            isPreview: true
        });
    });

    test('offers Update only for an installed waiting worker', () => {
        expect(
            updateReadiness({
                hasWaitingWorker: true,
                hasInstallingWorker: false,
                publishedIsNewer: false
            })
        ).toBe('ready');
        expect(
            updateReadiness({
                hasWaitingWorker: false,
                hasInstallingWorker: true,
                publishedIsNewer: true
            })
        ).toBe('downloading');
        expect(
            updateReadiness({
                hasWaitingWorker: false,
                hasInstallingWorker: false,
                publishedIsNewer: true
            })
        ).toBe('downloading');
        expect(
            updateReadiness({
                hasWaitingWorker: false,
                hasInstallingWorker: false,
                publishedIsNewer: false
            })
        ).toBe('none');
    });

    test('treats ?update as a force-reinstall trigger except the reload marker', () => {
        expect(shouldForceReinstallFromUrl('')).toBe(false);
        expect(shouldForceReinstallFromUrl('update')).toBe(true);
        expect(shouldForceReinstallFromUrl('?update')).toBe(true);
        expect(shouldForceReinstallFromUrl('?update=true')).toBe(true);
        expect(shouldForceReinstallFromUrl('?test=true&update')).toBe(true);
        expect(shouldForceReinstallFromUrl('?update=1734567890123')).toBe(
            false
        );
    });
});
