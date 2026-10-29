describe('binary font export', () => {
    let awaitStableWorkerStateMock;
    let bootstrapWorkerCacheFromFontStateMock;
    let seedWorkerDocumentSetMock;
    let showProceedDialogMock;
    let alertSpy;
    let documentSet;
    let compileCachedMock;
    let resolvePicker;
    let createWritableMock;
    let showSaveFilePickerMock;
    let postMessageSpy;
    let currentFont;
    let persistedDestinations;
    let getPersistedDestinationMock;
    let setPersistedDestinationMock;
    let deletePersistedDestinationMock;
    let deliverExportedFontMock;

    async function flushAsyncWork() {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML =
            '<span id="file-dirty-indicator" class="file-dirty-indicator">●</span>';

        currentFont = {
            path: '/fonts/Example.babelfont',
            changeVersion: 7,
            sourcePlugin: {
                getId: () => 'disk'
            }
        };
        persistedDestinations = new Map();
        getPersistedDestinationMock = jest.fn((key) =>
            Promise.resolve(persistedDestinations.get(key))
        );
        setPersistedDestinationMock = jest.fn((key, value) => {
            persistedDestinations.set(key, value);
            return Promise.resolve();
        });
        deletePersistedDestinationMock = jest.fn((key) => {
            persistedDestinations.delete(key);
            return Promise.resolve();
        });
        deliverExportedFontMock = jest.fn();
        awaitStableWorkerStateMock = jest.fn().mockResolvedValue(undefined);
        bootstrapWorkerCacheFromFontStateMock = jest
            .fn()
            .mockResolvedValue(undefined);
        seedWorkerDocumentSetMock = jest.fn().mockResolvedValue(undefined);
        showProceedDialogMock = jest.fn().mockResolvedValue(true);
        alertSpy = jest.spyOn(window, 'alert').mockImplementation();
        documentSet = [
            { documentId: 'font-core', bytes: new Uint8Array([4, 5, 6]) },
            { documentId: 'font-deps', bytes: new Uint8Array([7]) },
            { documentId: 'glyph:a', bytes: new Uint8Array([8]) }
        ];
        compileCachedMock = jest.fn().mockResolvedValue({
            result: new Uint8Array([1, 2, 3]),
            filename: 'Example.ttf',
            time_taken: 12
        });
        createWritableMock = jest.fn().mockResolvedValue({
            write: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined)
        });
        showSaveFilePickerMock = jest.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePicker = resolve;
                })
        );
        postMessageSpy = jest.spyOn(window, 'postMessage').mockImplementation();

        window.fontManager = {
            currentFont,
            workerCacheUpdatePromise: null,
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([4, 5, 6])),
            buildWorkerSeedDocumentSet: jest.fn(() => documentSet),
            getGlyphResidency: jest.fn(() => ({ resident: 3, total: 3 }))
        };
        window.showSaveFilePicker = showSaveFilePickerMock;

        jest.doMock('../js/font-compilation', () => ({
            awaitStableWorkerState: awaitStableWorkerStateMock,
            fontCompilation: {
                awaitWorkerDocumentSync: jest.fn(),
                hasWorkerCacheDocument: jest.fn()
            },
            fullFontCompilation: {
                bootstrapWorkerCacheFromFontState:
                    bootstrapWorkerCacheFromFontStateMock,
                seedWorkerDocumentSet: seedWorkerDocumentSetMock,
                compileCached: compileCachedMock,
                setCompileFeatureOverlay: jest.fn(),
                sendMessage: jest.fn().mockResolvedValue(undefined)
            }
        }));
        jest.doMock('../js/logger', () => ({
            Logger: class {
                log() {}
                warn() {}
                error() {}
            }
        }));
        jest.doMock('idb-keyval', () => ({
            get: getPersistedDestinationMock,
            set: setPersistedDestinationMock,
            del: deletePersistedDestinationMock
        }));
        jest.doMock('../js/font-destination-plugin-manager', () => ({
            fontDestinationPluginManager: {
                deliverExportedFont: deliverExportedFontMock
            }
        }));
        jest.doMock('../js/ui/confirm-dialog', () => ({
            showProceedDialog: showProceedDialogMock
        }));
    });

    afterEach(() => {
        postMessageSpy.mockRestore();
        alertSpy.mockRestore();
        delete window.showSaveFilePicker;
        delete window.fontManager;
        jest.dontMock('../js/font-compilation');
        jest.dontMock('../js/logger');
        jest.dontMock('idb-keyval');
        jest.dontMock('../js/font-destination-plugin-manager');
        jest.dontMock('../js/ui/confirm-dialog');
    });

    function finishPicker() {
        resolvePicker({
            name: 'Example.ttf',
            createWritable: createWritableMock
        });
    }

    test('reuses the selected destination and publishes each exported binary', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const firstExport = exportBinaryFont();
        await flushAsyncWork();

        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await firstExport;

        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
        expect(dirtyIndicator.classList.contains('visible')).toBe(false);

        const secondExport = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await secondExport;

        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(1);
        expect(awaitStableWorkerStateMock).toHaveBeenCalledTimes(2);
        expect(seedWorkerDocumentSetMock).toHaveBeenCalledTimes(2);
        expect(compileCachedMock).toHaveBeenNthCalledWith(
            1,
            'user',
            'Example.ttf'
        );
        expect(createWritableMock).toHaveBeenCalledTimes(2);
        expect(postMessageSpy).toHaveBeenCalledTimes(2);
        expect(postMessageSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: 'counterpunch:binary-font-exported',
                version: 1,
                bytes: expect.any(ArrayBuffer),
                metadata: expect.objectContaining({
                    byteLength: 3,
                    changeVersion: 7,
                    filename: 'Example.ttf'
                })
            }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
        expect(setPersistedDestinationMock).toHaveBeenCalledWith(
            'disk:///fonts/Example.babelfont',
            expect.objectContaining({ name: 'Example.ttf' })
        );
        expect(deliverExportedFontMock).toHaveBeenCalledTimes(2);
    });

    test('restores the plugin-qualified destination after switching sources', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');
        const originalFont = currentFont;

        const firstExport = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await firstExport;

        currentFont = {
            path: '/fonts/Other.babelfont',
            changeVersion: 8,
            sourcePlugin: {
                getId: () => 'disk'
            }
        };
        window.fontManager.currentFont = currentFont;
        const otherExport = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await otherExport;

        window.fontManager.currentFont = originalFont;
        await exportBinaryFont();

        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(2);
        expect(getPersistedDestinationMock).toHaveBeenLastCalledWith(
            'disk:///fonts/Example.babelfont'
        );
        expect(createWritableMock).toHaveBeenCalledTimes(3);
    });

    test('replaces a restored destination when write permission is denied', async () => {
        persistedDestinations.set('disk:///fonts/Example.babelfont', {
            name: 'Unavailable.ttf',
            createWritable: createWritableMock,
            queryPermission: jest.fn().mockResolvedValue('denied'),
            requestPermission: jest.fn().mockResolvedValue('denied')
        });

        const { exportBinaryFont } = require('../js/binary-font-export.ts');
        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        await flushAsyncWork();
        finishPicker();
        await exportPromise;

        expect(deletePersistedDestinationMock).toHaveBeenCalledWith(
            'disk:///fonts/Example.babelfont'
        );
        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(1);
    });

    test('delivers a binary only after its writable stream closes', async () => {
        const closeMock = jest.fn().mockResolvedValue(undefined);
        createWritableMock.mockResolvedValueOnce({
            write: jest.fn().mockResolvedValue(undefined),
            close: closeMock
        });
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await exportPromise;

        expect(closeMock).toHaveBeenCalledTimes(1);
        expect(deliverExportedFontMock).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            expect.objectContaining({ filename: 'Example.ttf' })
        );
        expect(closeMock.mock.invocationCallOrder[0]).toBeLessThan(
            deliverExportedFontMock.mock.invocationCallOrder[0]
        );
    });

    test('export as always chooses a new destination', async () => {
        const { exportBinaryFontAs } = require('../js/binary-font-export.ts');

        const firstExport = exportBinaryFontAs();
        await flushAsyncWork();
        finishPicker();
        await firstExport;

        const secondExport = exportBinaryFontAs();
        await flushAsyncWork();
        finishPicker();
        await secondExport;

        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(2);
    });

    test('restores a hidden dirty dot after export feedback', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();

        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await exportPromise;

        expect(dirtyIndicator.classList.contains('visible')).toBe(false);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
    });

    test('returns a visible dirty dot to red after export feedback', async () => {
        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        dirtyIndicator.classList.add('visible');

        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await exportPromise;

        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
    });
    test('seeds the export compiler with every glyph shard, not the core snapshot', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await exportPromise;

        expect(seedWorkerDocumentSetMock).toHaveBeenCalledWith(documentSet);
        expect(bootstrapWorkerCacheFromFontStateMock).not.toHaveBeenCalled();
        expect(
            seedWorkerDocumentSetMock.mock.invocationCallOrder[0]
        ).toBeLessThan(compileCachedMock.mock.invocationCallOrder[0]);
        expect(showProceedDialogMock).not.toHaveBeenCalled();
    });

    test('seeds the single snapshot when no sync bridge exists', async () => {
        window.fontManager.buildWorkerSeedDocumentSet.mockReturnValue(null);
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await exportPromise;

        expect(bootstrapWorkerCacheFromFontStateMock).toHaveBeenCalledWith(
            new Uint8Array([4, 5, 6])
        );
        expect(seedWorkerDocumentSetMock).not.toHaveBeenCalled();
    });

    test('blocks exporting a font without glyphs', async () => {
        window.fontManager.getGlyphResidency.mockReturnValue({
            resident: 0,
            total: 0
        });
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        await exportBinaryFont();

        expect(alertSpy).toHaveBeenCalledWith(
            'Unable to export binary font: The font has no glyphs to export.'
        );
        expect(showSaveFilePickerMock).not.toHaveBeenCalled();
        expect(compileCachedMock).not.toHaveBeenCalled();
    });

    test('asks before exporting a partially loaded font', async () => {
        window.fontManager.getGlyphResidency.mockReturnValue({
            resident: 2,
            total: 5
        });
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        await flushAsyncWork();
        finishPicker();
        await exportPromise;

        expect(showProceedDialogMock).toHaveBeenCalledWith(
            'Export partial font',
            expect.stringContaining('Only 2 of 5 glyphs are loaded')
        );
        expect(showProceedDialogMock.mock.invocationCallOrder[0]).toBeLessThan(
            showSaveFilePickerMock.mock.invocationCallOrder[0]
        );
        expect(compileCachedMock).toHaveBeenCalledTimes(1);
    });

    test('cancelling the partial export prompt exports nothing', async () => {
        window.fontManager.getGlyphResidency.mockReturnValue({
            resident: 2,
            total: 5
        });
        showProceedDialogMock.mockResolvedValue(false);
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        await exportBinaryFont();

        expect(showSaveFilePickerMock).not.toHaveBeenCalled();
        expect(compileCachedMock).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(
            document
                .getElementById('file-dirty-indicator')
                .classList.contains('exporting')
        ).toBe(false);
    });
});
