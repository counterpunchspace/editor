describe('Font Destination plugins', () => {
    let originalFetch;
    let originalOpen;

    const createInstallManifest = () => ({
        packageName: 'example-package',
        entryPoint: 'example',
        pluginId: 'example',
        name: 'Example',
        description: 'Example destination',
        destinationUrl: 'https://example.com/receiver',
        targetOrigin: 'https://example.com',
        repositoryUrl: 'https://github.com/example/repository',
        imageUrl: null,
        releaseRepository: 'example/repository',
        wheelAssetPrefix: 'example-',
        checksumAssetSuffix: '.sha256'
    });

    const installSettingsFolderAdapter = (overrides = {}) => ({
        deleteItem: jest.fn().mockResolvedValue(undefined),
        fileExists: jest.fn().mockResolvedValue(true),
        requestPermission: jest.fn().mockResolvedValue('granted'),
        scanDirectory: jest.fn().mockResolvedValue({}),
        writeFile: jest.fn().mockResolvedValue(undefined),
        ...overrides
    });

    const mockSettingsFolder = (adapter, { ready = true } = {}) => {
        const { settingsFolder } = require('../js/settings-folder.ts');
        const originals = {
            getAdapter: settingsFolder.getAdapter,
            isReady: settingsFolder.isReady,
            selectFolder: settingsFolder.selectFolder
        };
        settingsFolder.getAdapter = jest.fn(() => adapter);
        settingsFolder.isReady = jest.fn().mockResolvedValue(ready);
        return {
            settingsFolder,
            restore() {
                settingsFolder.getAdapter = originals.getAdapter;
                settingsFolder.isReady = originals.isReady;
                settingsFolder.selectFolder = originals.selectFolder;
            }
        };
    };

    beforeEach(() => {
        jest.resetModules();
        originalFetch = global.fetch;
        originalOpen = window.open;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        window.open = originalOpen;
    });

    test('accepts manifests carrying the exact Font Destination marker', () => {
        const {
            FONT_DESTINATION_PLUGIN_MARKER,
            parseFontDestinationManifest
        } = require('../js/font-destination-plugin-manager.ts');

        const manifest = parseFontDestinationManifest({
            schema: 'counterpunch-plugin-manifest:v1',
            package: 'example-package',
            provides: [FONT_DESTINATION_PLUGIN_MARKER],
            fontDestination: {
                entryPoint: 'example',
                pluginId: 'example',
                name: 'Example',
                description: 'Example destination',
                destinationUrl: 'https://example.com/receiver',
                targetOrigin: 'https://example.com',
                repositoryUrl: 'https://github.com/example/repository',
                imageUrl: 'https://example.com/plugin-preview.png'
            },
            release: {
                repository: 'example/repository',
                wheelAssetPrefix: 'example-',
                checksumAssetSuffix: '.sha256'
            }
        });

        expect(manifest.pluginId).toBe('example');
        expect(manifest.targetOrigin).toBe('https://example.com');
        expect(manifest.imageUrl).toBe(
            'https://example.com/plugin-preview.png'
        );
    });

    test('rejects manifests whose destination origin does not match its URL', () => {
        const {
            FONT_DESTINATION_PLUGIN_MARKER,
            parseFontDestinationManifest
        } = require('../js/font-destination-plugin-manager.ts');

        expect(() =>
            parseFontDestinationManifest({
                schema: 'counterpunch-plugin-manifest:v1',
                package: 'example-package',
                provides: [FONT_DESTINATION_PLUGIN_MARKER],
                fontDestination: {
                    entryPoint: 'example',
                    pluginId: 'example',
                    name: 'Example',
                    description: 'Example destination',
                    destinationUrl: 'https://example.com/receiver',
                    targetOrigin: 'https://elsewhere.example',
                    repositoryUrl: 'https://github.com/example/repository'
                },
                release: {
                    repository: 'example/repository',
                    wheelAssetPrefix: 'example-',
                    checksumAssetSuffix: '.sha256'
                }
            })
        ).toThrow('targetOrigin');
    });

    test('discovers GitHub-wide marker-validated manifests via the code-search API', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    items: [
                        {
                            path: 'counterpunch-plugin.json',
                            repository: {
                                fullName:
                                    'counterpunchspace/fontdestination-example-plugin',
                                defaultBranch: 'main'
                            }
                        },
                        {
                            path: 'counterpunch-plugin.json',
                            repository: {
                                fullName: 'another-author/another-plugin',
                                defaultBranch: 'trunk'
                            }
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    schema: 'counterpunch-plugin-manifest:v1',
                    package: 'fontdestination-example-plugin',
                    provides: ['counterpunch-plugin:font-destination:v1'],
                    fontDestination: {
                        entryPoint: 'example_fontdestination',
                        pluginId: 'example-font-destination',
                        name: 'Example Font Destination',
                        description: 'Example destination',
                        destinationUrl:
                            'https://counterpunchspace.github.io/fontdestination-example-plugin/',
                        targetOrigin: 'https://counterpunchspace.github.io',
                        repositoryUrl:
                            'https://github.com/counterpunchspace/fontdestination-example-plugin'
                    },
                    release: {
                        repository:
                            'counterpunchspace/fontdestination-example-plugin',
                        wheelAssetPrefix: 'fontdestination_example_plugin-',
                        checksumAssetSuffix: '.sha256'
                    }
                })
            })
            .mockResolvedValueOnce({ ok: false, status: 404 });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        const catalogue =
            await new FontDestinationPluginManager().discoverCatalogue();

        expect(catalogue).toHaveLength(1);
        expect(catalogue[0].pluginId).toBe('example-font-destination');
        expect(global.fetch.mock.calls[0][0]).toBe(
            'https://localhost:8788/api/github/code-search?q=%22counterpunch-plugin%3Afont-destination%3Av1%22+filename%3Acounterpunch-plugin.json&per_page=100'
        );
        expect(global.fetch.mock.calls[0][1].cache).toBe('no-store');
    });

    test('downloads release assets through the website proxy into the Settings Folder Plugins directory', async () => {
        const originalCrypto = Object.getOwnPropertyDescriptor(
            global,
            'crypto'
        );
        const originalPyodide = window.pyodide;
        const adapter = {
            fileExists: jest.fn().mockResolvedValue(true),
            requestPermission: jest.fn().mockResolvedValue('granted'),
            scanDirectory: jest.fn().mockResolvedValue({
                '/Plugins/example-1.0.0.whl': {
                    is_dir: false,
                    path: '/Plugins/example-1.0.0.whl'
                }
            }),
            writeFile: jest.fn().mockResolvedValue(undefined)
        };
        const settingsFolderMock = mockSettingsFolder(adapter);

        window.pyodide = {
            FS: { mkdirTree: jest.fn(), writeFile: jest.fn() },
            runPythonAsync: jest
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce([
                    {
                        pluginId: 'example',
                        name: 'Example',
                        description: 'Example destination',
                        destinationUrl: 'https://example.com/receiver',
                        targetOrigin: 'https://example.com',
                        repositoryUrl: 'https://github.com/example/repository',
                        imageUrl: null
                    }
                ])
        };
        const checksum =
            '039058c6f2c0cb492c533b0a4d14ef77a9c0cba4c3973c0c1e9945b39d6f5a3f';
        Object.defineProperty(global, 'crypto', {
            configurable: true,
            value: {
                subtle: {
                    digest: jest
                        .fn()
                        .mockResolvedValue(
                            new Uint8Array(
                                checksum
                                    .match(/.{2}/g)
                                    .map((value) => Number.parseInt(value, 16))
                            ).buffer
                        )
                }
            }
        });
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    assets: [
                        {
                            name: 'example-1.0.0.whl',
                            browser_download_url: 'https://example.com/wheel'
                        },
                        {
                            name: 'example-1.0.0.whl.sha256',
                            browser_download_url: 'https://example.com/checksum'
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            })
            .mockResolvedValueOnce({ ok: true, text: async () => checksum });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            const manager = new FontDestinationPluginManager();
            await manager.install({
                packageName: 'example-package',
                entryPoint: 'example',
                pluginId: 'example',
                name: 'Example',
                description: 'Example destination',
                destinationUrl: 'https://example.com/receiver',
                targetOrigin: 'https://example.com',
                repositoryUrl: 'https://github.com/example/repository',
                imageUrl: null,
                releaseRepository: 'example/repository',
                wheelAssetPrefix: 'example-',
                checksumAssetSuffix: '.sha256'
            });

            expect(global.fetch.mock.calls[1]).toEqual([
                'https://localhost:8788/api/github/release-asset?asset=example-1.0.0.whl&repository=example%2Frepository',
                { cache: 'no-store' }
            ]);
            expect(adapter.writeFile).toHaveBeenCalledWith(
                '/Plugins/example-1.0.0.whl',
                new Uint8Array([1, 2, 3])
            );
            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'await micropip.install("emfs:/tmp/counterpunch-plugins/example-1.0.0.whl", reinstall=True)'
            );
            expect(window.pyodide.runPythonAsync.mock.calls[1][0]).toContain(
                'importlib.invalidate_caches()'
            );
            expect(manager.getInstalledDestinations()).toEqual([
                expect.objectContaining({
                    pluginId: 'example',
                    name: 'Example'
                })
            ]);
        } finally {
            settingsFolderMock.restore();
            window.pyodide = originalPyodide;
            if (originalCrypto) {
                Object.defineProperty(global, 'crypto', originalCrypto);
            } else {
                delete global.crypto;
            }
        }
    });

    test('reports a contextual error when a manifest has no GitHub release yet', async () => {
        const adapter = installSettingsFolderAdapter();
        const settingsFolderMock = mockSettingsFolder(adapter);

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: false,
            status: 404
        });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().install(
                    createInstallManifest()
                )
            ).rejects.toThrow('Could not read the latest GitHub release');
            expect(adapter.writeFile).not.toHaveBeenCalled();
        } finally {
            settingsFolderMock.restore();
        }
    });

    test('reports when the latest release has no matching wheel', async () => {
        const adapter = installSettingsFolderAdapter();
        const settingsFolderMock = mockSettingsFolder(adapter);

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ assets: [] })
        });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().install(
                    createInstallManifest()
                )
            ).rejects.toThrow('does not contain a wheel whose filename starts');
            expect(adapter.writeFile).not.toHaveBeenCalled();
        } finally {
            settingsFolderMock.restore();
        }
    });

    test('reports when the latest release has no checksum asset', async () => {
        const adapter = installSettingsFolderAdapter();
        const settingsFolderMock = mockSettingsFolder(adapter);

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                assets: [
                    {
                        name: 'example-1.0.0.whl',
                        browser_download_url: 'https://example.com/wheel'
                    }
                ]
            })
        });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().install(
                    createInstallManifest()
                )
            ).rejects.toThrow('required checksum asset');
            expect(adapter.writeFile).not.toHaveBeenCalled();
        } finally {
            settingsFolderMock.restore();
        }
    });

    test('reports checksum mismatches before writing the wheel', async () => {
        const originalCrypto = Object.getOwnPropertyDescriptor(
            global,
            'crypto'
        );
        const adapter = installSettingsFolderAdapter();
        const settingsFolderMock = mockSettingsFolder(adapter);

        Object.defineProperty(global, 'crypto', {
            configurable: true,
            value: {
                subtle: {
                    digest: jest
                        .fn()
                        .mockResolvedValue(new Uint8Array([0]).buffer)
                }
            }
        });
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    assets: [
                        {
                            name: 'example-1.0.0.whl',
                            browser_download_url: 'https://example.com/wheel'
                        },
                        {
                            name: 'example-1.0.0.whl.sha256',
                            browser_download_url: 'https://example.com/checksum'
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            })
            .mockResolvedValueOnce({ ok: true, text: async () => 'ff' });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().install(
                    createInstallManifest()
                )
            ).rejects.toThrow('Checksum mismatch');
            expect(adapter.writeFile).not.toHaveBeenCalled();
        } finally {
            settingsFolderMock.restore();
            if (originalCrypto) {
                Object.defineProperty(global, 'crypto', originalCrypto);
            } else {
                delete global.crypto;
            }
        }
    });

    test('rolls back the stored wheel when Python installation fails', async () => {
        const originalCrypto = Object.getOwnPropertyDescriptor(
            global,
            'crypto'
        );
        const originalPyodide = window.pyodide;
        const adapter = installSettingsFolderAdapter();
        const settingsFolderMock = mockSettingsFolder(adapter);

        window.pyodide = {
            FS: { mkdirTree: jest.fn(), writeFile: jest.fn() },
            runPythonAsync: jest
                .fn()
                .mockRejectedValueOnce(new Error('bad wheel'))
                .mockRejectedValueOnce(new Error('not installed'))
        };
        const checksum =
            '039058c6f2c0cb492c533b0a4d14ef77a9c0cba4c3973c0c1e9945b39d6f5a3f';
        Object.defineProperty(global, 'crypto', {
            configurable: true,
            value: {
                subtle: {
                    digest: jest
                        .fn()
                        .mockResolvedValue(
                            new Uint8Array(
                                checksum
                                    .match(/.{2}/g)
                                    .map((value) => Number.parseInt(value, 16))
                            ).buffer
                        )
                }
            }
        });
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    assets: [
                        {
                            name: 'example-1.0.0.whl',
                            browser_download_url: 'https://example.com/wheel'
                        },
                        {
                            name: 'example-1.0.0.whl.sha256',
                            browser_download_url: 'https://example.com/checksum'
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            })
            .mockResolvedValueOnce({ ok: true, text: async () => checksum });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().install(
                    createInstallManifest()
                )
            ).rejects.toThrow('Could not install Example: bad wheel');
            expect(adapter.writeFile).toHaveBeenCalledWith(
                '/Plugins/example-1.0.0.whl',
                new Uint8Array([1, 2, 3])
            );
            expect(adapter.deleteItem).toHaveBeenCalledWith(
                '/Plugins/example-1.0.0.whl',
                false
            );
        } finally {
            settingsFolderMock.restore();
            window.pyodide = originalPyodide;
            if (originalCrypto) {
                Object.defineProperty(global, 'crypto', originalCrypto);
            } else {
                delete global.crypto;
            }
        }
    });

    test('continues restoring stored wheels after one wheel fails', async () => {
        const originalPyodide = window.pyodide;
        const adapter = installSettingsFolderAdapter({
            checkPermission: jest.fn().mockResolvedValue('granted'),
            readFile: jest
                .fn()
                .mockResolvedValueOnce(new Uint8Array([1]))
                .mockResolvedValueOnce(new Uint8Array([2])),
            scanDirectory: jest.fn().mockResolvedValue({
                '/Plugins/bad-1.0.0.whl': {
                    is_dir: false,
                    path: '/Plugins/bad-1.0.0.whl'
                },
                '/Plugins/good-1.0.0.whl': {
                    is_dir: false,
                    path: '/Plugins/good-1.0.0.whl'
                }
            })
        });
        const settingsFolderMock = mockSettingsFolder(adapter);
        window.pyodide = {
            FS: { mkdirTree: jest.fn(), writeFile: jest.fn() },
            runPythonAsync: jest
                .fn()
                .mockRejectedValueOnce(new Error('bad wheel'))
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({
                    destinations: [
                        {
                            pluginId: 'good',
                            name: 'Good',
                            description: 'Good destination',
                            destinationUrl: 'https://example.com/good',
                            targetOrigin: 'https://example.com',
                            repositoryUrl:
                                'https://github.com/example/repository',
                            imageUrl: null
                        }
                    ],
                    errors: []
                })
        };
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            const manager = new FontDestinationPluginManager();
            await manager.reinstallStoredPlugins();
            expect(manager.getInstalledDestinations()).toEqual([
                expect.objectContaining({ pluginId: 'good' })
            ]);
            expect(manager.getDiagnostics()).toEqual([
                expect.stringContaining('/Plugins/bad-1.0.0.whl')
            ]);
        } finally {
            settingsFolderMock.restore();
            window.pyodide = originalPyodide;
        }
    });

    test('reports missing Plugins storage and creates it inside the Settings Folder', async () => {
        const adapter = {
            createFolder: jest.fn().mockResolvedValue(undefined),
            fileExists: jest.fn().mockResolvedValue(false),
            requestPermission: jest.fn().mockResolvedValue('granted')
        };
        const settingsFolderMock = mockSettingsFolder(adapter);

        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            const manager = new FontDestinationPluginManager();
            await expect(manager.getPluginStorageStatus()).resolves.toBe(
                'plugins-folder-missing'
            );
            await manager.createPluginsDirectory();
            expect(adapter.createFolder).toHaveBeenCalledWith('/Plugins');
        } finally {
            settingsFolderMock.restore();
        }
    });

    test('reports when no Settings Folder is connected', async () => {
        const settingsFolderMock = mockSettingsFolder(
            { fileExists: jest.fn() },
            { ready: false }
        );

        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().getPluginStorageStatus()
            ).resolves.toBe('settings-folder-not-connected');
        } finally {
            settingsFolderMock.restore();
        }
    });

    test('uninstalls the Pyodide distribution before removing its wheel from disk', async () => {
        const originalPyodide = window.pyodide;
        const adapter = {
            deleteItem: jest.fn().mockResolvedValue(undefined),
            scanDirectory: jest.fn().mockResolvedValue({})
        };
        const settingsFolderMock = mockSettingsFolder(adapter);

        window.pyodide = {
            runPythonAsync: jest.fn().mockResolvedValue([])
        };
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await new FontDestinationPluginManager().uninstall(
                '/Plugins/example_plugin-1.0.0-py3-none-any.whl'
            );

            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'micropip.uninstall(installed_name)'
            );
            expect(
                window.pyodide.runPythonAsync.mock.calls[0][0]
            ).not.toContain('await micropip.uninstall');
            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'target_distribution = "example-plugin"'
            );
            expect(adapter.deleteItem).toHaveBeenCalledWith(
                '/Plugins/example_plugin-1.0.0-py3-none-any.whl',
                false
            );
        } finally {
            settingsFolderMock.restore();
            window.pyodide = originalPyodide;
        }
    });

    test('delivers through ready destination bridges and skips closed windows', () => {
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');
        const createBridge = (closed = false) => {
            const bridge = new EventTarget();
            bridge.closed = closed;
            bridge.postMessage = jest.fn();
            return bridge;
        };
        const bridge = createBridge();
        const secondBridge = createBridge();
        const closedBridge = createBridge(true);
        window.open = jest
            .fn()
            .mockReturnValueOnce(bridge)
            .mockReturnValueOnce(secondBridge)
            .mockReturnValueOnce(closedBridge);
        const manager = new FontDestinationPluginManager();
        const destination = {
            pluginId: 'example',
            name: 'Example',
            description: 'Example destination',
            destinationUrl: 'https://example.com/receiver',
            targetOrigin: 'https://example.com',
            repositoryUrl: 'https://github.com/example/repository',
            imageUrl: null
        };

        manager.openDestination(destination);
        manager.openDestination({
            ...destination,
            pluginId: 'second',
            destinationUrl: 'https://second.example/receiver',
            targetOrigin: 'https://second.example'
        });
        manager.openDestination({
            ...destination,
            pluginId: 'closed',
            destinationUrl: 'https://closed.example/receiver',
            targetOrigin: 'https://closed.example'
        });
        manager.deliverExportedFont(new Uint8Array([1, 2, 3]), {
            byteLength: 3,
            changeVersion: 1,
            filename: 'Example.ttf',
            format: 'ttf',
            mimeType: 'font/ttf',
            timeTakenMs: 1
        });

        const openedBridgeUrl = new URL(window.open.mock.calls[0][0]);
        expect(window.open).toHaveBeenCalledWith(
            openedBridgeUrl.href,
            'counterpunch-font-destination-example'
        );
        expect(openedBridgeUrl.origin).toBe(window.location.origin);
        expect(openedBridgeUrl.pathname).toBe('/font-destination-bridge.html');
        expect(openedBridgeUrl.searchParams.get('destinationUrl')).toBe(
            destination.destinationUrl
        );
        expect(bridge.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'counterpunch:binary-font-exported',
                bytes: expect.any(ArrayBuffer)
            }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
        expect(secondBridge.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ bytes: expect.any(ArrayBuffer) }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
        expect(closedBridge.postMessage).not.toHaveBeenCalled();
    });

    test('skips scanning Plugins when Settings Folder permission is not granted', async () => {
        const adapter = installSettingsFolderAdapter({
            checkPermission: jest.fn().mockResolvedValue('prompt')
        });
        const { restore } = mockSettingsFolder(adapter);
        try {
            const {
                fontDestinationPluginManager
            } = require('../js/font-destination-plugin-manager.ts');
            await expect(
                fontDestinationPluginManager.getInstalledWheelFiles()
            ).resolves.toEqual([]);
            expect(adapter.scanDirectory).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    test('NativeAdapter.checkPermission falls back to prompt when queryPermission hangs', async () => {
        jest.useFakeTimers();
        const warnSpy = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            const { NativeAdapter } = require('../js/file-system-adapter.ts');
            const adapter = new NativeAdapter('test-handle');
            const queryPermission = jest.fn(() => new Promise(() => undefined));
            adapter.directoryHandle = { queryPermission };

            const firstCheck = adapter.checkPermission();
            const concurrentCheck = adapter.checkPermission();
            await jest.advanceTimersByTimeAsync(2100);

            await expect(firstCheck).resolves.toBe('prompt');
            await expect(concurrentCheck).resolves.toBe('prompt');
            expect(queryPermission).toHaveBeenCalledTimes(1);

            // Subsequent check during cooldown resolves immediately without re-querying.
            await expect(adapter.checkPermission()).resolves.toBe('prompt');
            expect(queryPermission).toHaveBeenCalledTimes(1);
        } finally {
            warnSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('NativeAdapter.checkPermission waits for Pyodide load before arming its timeout', async () => {
        jest.useFakeTimers();
        const originalPyodide = window.pyodide;
        const originalPyodideLoad = window.__pyodideLoadPromise;
        let resolvePyodide;
        let resolvePermission;
        window.pyodide = undefined;
        window.__pyodideLoadPromise = new Promise((resolve) => {
            resolvePyodide = resolve;
        });
        try {
            const { NativeAdapter } = require('../js/file-system-adapter.ts');
            const adapter = new NativeAdapter('test-handle');
            adapter.directoryHandle = {
                queryPermission: jest.fn(
                    () =>
                        new Promise((resolve) => {
                            resolvePermission = resolve;
                        })
                )
            };

            const checkPromise = adapter.checkPermission();
            // Even after 10s while Pyodide is still loading, it must not time out.
            await jest.advanceTimersByTimeAsync(10_000);
            resolvePyodide({});
            await Promise.resolve();
            resolvePermission('granted');

            await expect(checkPromise).resolves.toBe('granted');
        } finally {
            window.pyodide = originalPyodide;
            window.__pyodideLoadPromise = originalPyodideLoad;
            jest.useRealTimers();
        }
    });

    test('scans and loads stored Python wheels when Settings Folder permission is renewed', async () => {
        const originalPyodide = window.pyodide;
        const originalCanvas = window.canvasPluginManager;
        const originalOverview = window.glyphOverviewFilterManager;
        const runPythonAsync = jest.fn().mockResolvedValue(undefined);
        const loadPackage = jest.fn().mockResolvedValue(undefined);
        window.pyodide = {
            loadPackage,
            runPythonAsync,
            FS: {
                mkdirTree: jest.fn(),
                writeFile: jest.fn(),
                unlink: jest.fn()
            }
        };
        const discoverCanvas = jest.fn().mockResolvedValue(undefined);
        const discoverPythonFilters = jest.fn().mockResolvedValue(undefined);
        window.canvasPluginManager = { discoverPlugins: discoverCanvas };
        window.glyphOverviewFilterManager = {
            discoverPythonPlugins: discoverPythonFilters
        };
        global.fetch = jest.fn(async (url) => {
            const href = String(url);
            if (href.includes('wheels.json')) {
                return { ok: true, json: async () => ({ wheels: [] }) };
            }
            if (href.includes('fonteditor.py')) {
                return { ok: true, text: async () => '' };
            }
            return {
                ok: true,
                json: async () => ({ plugins: [], blocked: [], revoked: [] })
            };
        });

        try {
            const {
                fontDestinationPluginManager
            } = require('../js/font-destination-plugin-manager.ts');
            const compileFilterHost = require('../js/compile-filter-host.ts');
            const reinstallSpy = jest
                .spyOn(fontDestinationPluginManager, 'reinstallStoredPlugins')
                .mockResolvedValue(undefined);
            const compileDiscoverSpy = jest
                .spyOn(compileFilterHost, 'discoverCompileFilters')
                .mockResolvedValue([]);

            const fonteditor = require('../js/fonteditor.ts');
            await window.ensurePyodideReady();
            reinstallSpy.mockClear();
            discoverCanvas.mockClear();
            discoverPythonFilters.mockClear();
            compileDiscoverSpy.mockClear();

            await fonteditor.restoreStoredPythonPluginsOnFolderAccess();

            expect(reinstallSpy).toHaveBeenCalledTimes(1);
            expect(discoverCanvas).toHaveBeenCalledTimes(1);
            expect(discoverPythonFilters).toHaveBeenCalledTimes(1);
            expect(compileDiscoverSpy).toHaveBeenCalledTimes(1);
        } finally {
            window.pyodide = originalPyodide;
            window.canvasPluginManager = originalCanvas;
            window.glyphOverviewFilterManager = originalOverview;
        }
    });
});
