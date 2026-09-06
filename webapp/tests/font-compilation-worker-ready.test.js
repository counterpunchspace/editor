const { FontCompilation } = require('../js/font-compilation');

describe('FontCompilation worker document readiness', () => {
    function createReadyFontCompilation() {
        const fontCompilation = new FontCompilation({
            connectInterpolation: false
        });
        let postedMessage = null;
        fontCompilation.worker = {
            postMessage: jest.fn((message) => {
                postedMessage = message;
            })
        };
        fontCompilation.isInitialized = true;
        fontCompilation.workerCacheDocumentReady = true;

        return {
            fontCompilation,
            getPostedMessage: () => postedMessage
        };
    }

    test.each([
        {
            type: 'storeFontJson',
            payload: { babelfontJson: '{"glyphs":[]}', forceStore: true }
        },
        {
            type: 'seedYdoc',
            payload: { state: new Uint8Array([1, 2, 3]) }
        },
        {
            type: 'applyYjsUpdate',
            payload: { update: new Uint8Array([4, 5, 6]), changedGlyphs: [] }
        }
    ])(
        '$type closes the ready gate before worker response',
        async ({ type, payload }) => {
            const { fontCompilation, getPostedMessage } =
                createReadyFontCompilation();

            const messagePromise = fontCompilation.sendMessage({
                type,
                ...payload
            });

            expect(fontCompilation.worker.postMessage).toHaveBeenCalledTimes(1);
            expect(fontCompilation.workerCacheDocumentReady).toBe(false);

            fontCompilation.handleWorkerMessage({
                data: {
                    id: getPostedMessage().id,
                    type,
                    success: true
                }
            });

            await expect(messagePromise).resolves.toEqual(
                expect.objectContaining({ success: true })
            );
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);
        }
    );

    test.each([
        {
            type: 'applyPreviewLayerOverlay',
            payload: { layerUpdates: [], changedGlyphs: [] }
        },
        {
            type: 'clearPreviewLayerOverlay',
            payload: {}
        }
    ])(
        '$type does not close the authoritative ready gate',
        async ({ type, payload }) => {
            const { fontCompilation, getPostedMessage } =
                createReadyFontCompilation();

            const messagePromise = fontCompilation.sendMessage({
                type,
                ...payload
            });

            expect(fontCompilation.worker.postMessage).toHaveBeenCalledTimes(1);
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);

            fontCompilation.handleWorkerMessage({
                data: {
                    id: getPostedMessage().id,
                    type,
                    success: true
                }
            });

            await expect(messagePromise).resolves.toEqual(
                expect.objectContaining({ success: true })
            );
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);
        }
    );

    test('seedYdoc transfers the state ArrayBuffer instead of structured-cloning it', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const state = new Uint8Array([1, 2, 3, 4]);

        const messagePromise = fontCompilation.sendMessage({
            type: 'seedYdoc',
            state
        });

        expect(fontCompilation.worker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'seedYdoc',
                state: expect.any(Uint8Array)
            }),
            [state.buffer]
        );

        const posted = fontCompilation.worker.postMessage.mock.calls[0][0];
        fontCompilation.handleWorkerMessage({
            data: {
                id: posted.id,
                type: 'seedYdoc',
                success: true
            }
        });

        await expect(messagePromise).resolves.toEqual(
            expect.objectContaining({ success: true })
        );
    });

    test('applyYjsUpdate does not transfer the update ArrayBuffer', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const update = new Uint8Array([4, 5, 6, 7]);

        const messagePromise = fontCompilation.sendMessage({
            type: 'applyYjsUpdate',
            update,
            changedGlyphs: ['a']
        });

        expect(fontCompilation.worker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                update
            })
        );
        expect(
            fontCompilation.worker.postMessage.mock.calls[0][1]
        ).toBeUndefined();

        const posted = fontCompilation.worker.postMessage.mock.calls[0][0];
        fontCompilation.handleWorkerMessage({
            data: {
                id: posted.id,
                type: 'applyYjsUpdate',
                success: true
            }
        });

        await expect(messagePromise).resolves.toEqual(
            expect.objectContaining({ success: true })
        );
    });

    test('applyYjsUpdate does not transfer a 2-byte no-op update', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const update = new Uint8Array([0, 0]);

        const messagePromise = fontCompilation.sendMessage({
            type: 'applyYjsUpdate',
            update,
            changedGlyphs: ['a']
        });

        expect(fontCompilation.worker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate'
            })
        );
        expect(
            fontCompilation.worker.postMessage.mock.calls[0][1]
        ).toBeUndefined();

        const posted = fontCompilation.worker.postMessage.mock.calls[0][0];
        fontCompilation.handleWorkerMessage({
            data: {
                id: posted.id,
                type: 'applyYjsUpdate',
                success: true
            }
        });

        await expect(messagePromise).resolves.toEqual(
            expect.objectContaining({ success: true })
        );
    });

    test('failed applyYjsUpdate keeps the worker document sync rejected and not ready', async () => {
        const { fontCompilation, getPostedMessage } =
            createReadyFontCompilation();

        const messagePromise = fontCompilation.sendMessage({
            type: 'applyYjsUpdate',
            update: new Uint8Array([4, 5, 6]),
            changedGlyphs: ['a']
        });

        expect(fontCompilation.workerCacheDocumentReady).toBe(false);

        fontCompilation.handleWorkerMessage({
            data: {
                id: getPostedMessage().id,
                type: 'applyYjsUpdate',
                error: 'RuntimeError: unreachable'
            }
        });

        await expect(messagePromise).rejects.toThrow(
            'RuntimeError: unreachable'
        );
        await expect(fontCompilation.awaitWorkerDocumentSync()).rejects.toThrow(
            'RuntimeError: unreachable'
        );
        expect(fontCompilation.workerCacheDocumentReady).toBe(false);
    });

    test('cached editing compiles send the incremental sentinel when the worker document is ready', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing-font.ttf',
                time_taken: 1,
                fontRevisionKey: '7'
            });

        await expect(
            fontCompilation.compileEditingFromJsonCached(
                '{"glyphs":[{"name":"a"}]}',
                '7',
                ['a'],
                { compileSource: 'keyboard-outline' }
            )
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '7' }));

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                subsetGlyphs: ['a'],
                subsetKey: 'a',
                layoutClosureKey: 'a\u001e',
                _usePreviewLayerOverlay: false
            })
        );
    });

    test('cached editing compiles forward the preview layer overlay flag', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing-font.ttf',
                time_taken: 1,
                fontRevisionKey: '8'
            });

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[{"name":"a"}]}',
            '8',
            ['a'],
            {
                compileSource: 'mouse-drag-outline',
                usePreviewLayerOverlay: true
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                _usePreviewLayerOverlay: true
            })
        );
    });

    test('feature-code editing compiles stay on the cached incremental worker path', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'editing-font.ttf',
                time_taken: 2,
                fontRevisionKey: '9'
            });

        await expect(
            fontCompilation.compileEditingFromJsonCached(
                '{"glyphs":[]}',
                '9',
                ['a'],
                { compileSource: 'feature-code' }
            )
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '9' }));

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                subsetGlyphs: ['a'],
                _compileSource: 'feature-code'
            })
        );
    });

    test('committed debug compiles use the dedicated worker lane with normalized subset glyphs', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([7, 8, 9]),
                filename: 'debug-font.ttf',
                time_taken: 3,
                fontHash: 'abc123',
                closureGlyphCount: 5
            });

        await expect(
            fontCompilation.compileCommittedDebugFont(['b', 'a', 'a'])
        ).resolves.toEqual(
            expect.objectContaining({
                filename: 'debug-font.ttf',
                fontHash: 'abc123',
                closureGlyphCount: 5
            })
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileDebugCached',
                subsetGlyphs: ['a', 'b'],
                filename: 'debug-font.ttf',
                memoryBudgetBytes: expect.any(Number)
            })
        );
    });

    test('cached editing compiles wait for queued worker document replaces', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const postedTypes = [];
        fontCompilation.worker.postMessage = jest.fn((message) => {
            postedTypes.push(message.type);
            queueMicrotask(() => {
                fontCompilation.handleWorkerMessage({
                    data: {
                        id: message.id,
                        type: message.type,
                        success: true,
                        result:
                            message.type === 'compileEditingCached'
                                ? new Uint8Array([1, 2, 3])
                                : undefined,
                        filename: 'editing-font.ttf',
                        time_taken: 1
                    }
                });
            });
        });

        fontCompilation.scheduleReplaceWorkerDocument(
            'glyph:adieresis',
            new Uint8Array([9, 10, 11])
        );

        await expect(
            fontCompilation.compileEditingFromJsonCached(
                '{"glyphs":[]}',
                '7',
                ['a', 'adieresis'],
                { compileSource: 'text-input' }
            )
        ).resolves.toEqual(
            expect.objectContaining({ filename: 'editing-font.ttf' })
        );

        expect(postedTypes).toEqual([
            'replaceYdocDocuments',
            'compileEditingCached'
        ]);
    });
});
