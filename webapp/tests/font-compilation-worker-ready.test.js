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
            type: 'applyPreviewDrawingOverlay',
            payload: { drawingUpdates: [], changedGlyphs: [] }
        },
        {
            type: 'clearPreviewDrawingOverlay',
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

    test('a failed worker sync nobody awaits is not an unhandled rejection', async () => {
        const { fontCompilation, getPostedMessage } =
            createReadyFontCompilation();
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const messagePromise = fontCompilation.sendMessage({
                type: 'applyYjsUpdate',
                update: new Uint8Array([4, 5, 6]),
                changedGlyphs: ['a']
            });
            messagePromise.catch(() => undefined);
            fontCompilation.handleWorkerMessage({
                data: {
                    id: getPostedMessage().id,
                    type: 'applyYjsUpdate',
                    error: 'Layer deserialization error'
                }
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(unhandled).not.toHaveBeenCalled();
            // Whoever awaits the sync still learns that it failed.
            await expect(
                fontCompilation.awaitWorkerDocumentSync()
            ).rejects.toThrow('Layer deserialization error');
        } finally {
            process.off('unhandledRejection', unhandled);
        }
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
            fontCompilation.compileEditingFromJsonCached('7', ['a'], {
                compileSource: 'keyboard-outline'
            })
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '7' }));

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_drawing__',
                subsetGlyphs: ['a'],
                subsetKey: 'a',
                layoutClosureKey: 'a\u001e',
                _usePreviewDrawingOverlay: false
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

        await fontCompilation.compileEditingFromJsonCached('8', ['a'], {
            compileSource: 'mouse-drag-outline',
            usePreviewDrawingOverlay: true
        });

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_drawing__',
                _usePreviewDrawingOverlay: true
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
            fontCompilation.compileEditingFromJsonCached('9', ['a'], {
                compileSource: 'feature-code'
            })
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '9' }));

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_drawing__',
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

    test('a queued worker document replace sends the document as it is when the replace runs', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const replaced = [];
        fontCompilation.worker.postMessage = jest.fn((message) => {
            if (message.type === 'replaceYdocDocuments') {
                replaced.push(
                    ...message.documents.map((document) => [
                        document.documentId,
                        [...document.state]
                    ])
                );
            }
            queueMicrotask(() => {
                fontCompilation.handleWorkerMessage({
                    data: { id: message.id, type: message.type, success: true }
                });
            });
        });
        let current = new Uint8Array([1]);
        fontCompilation.scheduleReplaceWorkerDocument(
            'glyph:a',
            current,
            () => current
        );
        // An edit lands before the replace runs; the worker already has it.
        current = new Uint8Array([1, 2]);
        await fontCompilation.workerDocumentReplaceFlush;
        expect(replaced).toEqual([['glyph:a', [1, 2]]]);
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

    describe('mirrored Yjs updates', () => {
        function createMirror() {
            const fontCompilation = new FontCompilation({
                connectInterpolation: false
            });
            const posted = [];
            fontCompilation.worker = {
                postMessage: jest.fn((message) => posted.push(message))
            };
            fontCompilation.isInitialized = true;
            const answer = (index) =>
                fontCompilation.handleWorkerMessage({
                    data: {
                        id: posted[index].id,
                        type: posted[index].type,
                        success: true
                    }
                });
            const settle = () =>
                new Promise((resolve) => setTimeout(resolve, 0));
            return { fontCompilation, posted, answer, settle };
        }

        test('are not sent before the worker holds the bridge documents', async () => {
            const { fontCompilation, posted } = createMirror();
            await fontCompilation.mirrorYjsUpdate({
                update: new Uint8Array([1])
            });
            expect(posted).toEqual([]);
        });

        test('queue behind a seed in flight and behind each other', async () => {
            const { fontCompilation, posted, answer, settle } = createMirror();
            const seed = fontCompilation.seedWorkerDocumentSet([
                { documentId: 'glyph:a', bytes: new Uint8Array([1]) }
            ]);
            await settle();
            expect(posted.map((message) => message.type)).toEqual(['seedYdoc']);

            const first = fontCompilation.mirrorYjsUpdate({
                update: new Uint8Array([2])
            });
            const second = fontCompilation.mirrorYjsUpdate({
                update: new Uint8Array([3])
            });
            await settle();
            // Nothing dropped while the seed is in flight; nothing overtakes it.
            expect(posted).toHaveLength(1);

            answer(0);
            await seed;
            await settle();
            expect(posted.map((message) => message.type)).toEqual([
                'seedYdoc',
                'applyYjsUpdate'
            ]);
            expect(posted[1].update).toEqual(new Uint8Array([2]));

            answer(1);
            await first;
            await settle();
            expect(posted[2].update).toEqual(new Uint8Array([3]));
            answer(2);
            await second;
        });

        test('stop once the documents are no longer the bridge’s', async () => {
            const { fontCompilation, posted, answer, settle } = createMirror();
            const seed = fontCompilation.seedWorkerDocumentSet([
                { documentId: 'glyph:a', bytes: new Uint8Array([1]) }
            ]);
            await settle();
            answer(0);
            await seed;

            fontCompilation.setWorkerCacheDocumentReady(false);
            await fontCompilation.mirrorYjsUpdate({
                update: new Uint8Array([2])
            });
            expect(posted).toHaveLength(1);
        });
    });

    describe('glyph documents and terminal worker errors', () => {
        function createAnsweringFontCompilation(answer) {
            const fontCompilation = new FontCompilation({
                connectInterpolation: false
            });
            const posted = [];
            fontCompilation.worker = {
                postMessage: jest.fn((message) => {
                    posted.push(message);
                    Promise.resolve().then(() =>
                        fontCompilation.handleWorkerMessage({
                            data: {
                                id: message.id,
                                type: message.type,
                                ...answer(message)
                            }
                        })
                    );
                })
            };
            fontCompilation.isInitialized = true;
            return { fontCompilation, posted };
        }

        test('a new glyph document reaches the worker whole before its first update', async () => {
            const { fontCompilation, posted } = createAnsweringFontCompilation(
                () => ({ success: true })
            );
            await fontCompilation.seedWorkerDocumentSet([
                { documentId: 'font-core', bytes: new Uint8Array([0, 0]) }
            ]);
            const wholeState = new Uint8Array([9, 9, 9]);
            const originalBridge = window.patchSyncEngine;
            window.patchSyncEngine = {
                encodeDocumentState: jest.fn(() => wholeState)
            };
            try {
                await fontCompilation.mirrorYjsUpdate({
                    update: new Uint8Array([4, 5, 6]),
                    changedGlyphs: ['a'],
                    documentId: 'glyph:1'
                });
                await fontCompilation.mirrorYjsUpdate({
                    update: new Uint8Array([7, 8]),
                    changedGlyphs: ['a'],
                    documentId: 'glyph:1'
                });
            } finally {
                window.patchSyncEngine = originalBridge;
            }
            expect(posted.map((message) => message.type)).toEqual([
                'seedYdoc',
                'replaceYdocDocuments',
                'applyYjsUpdate',
                'applyYjsUpdate'
            ]);
            expect(posted[1].documents).toEqual([
                { documentId: 'glyph:1', state: wholeState }
            ]);
            expect(fontCompilation.workerHoldsDocument('glyph:1')).toBe(true);
        });

        test('an update for a glyph document the editor cannot send whole is refused', async () => {
            const { fontCompilation, posted } = createAnsweringFontCompilation(
                () => ({ success: true })
            );
            await expect(
                fontCompilation.ensureWorkerHoldsDocument('glyph:2', () => null)
            ).rejects.toThrow(/does not hold that document/);
            expect(posted).toEqual([]);
        });

        test('a ClockGapError marks the named document broken and is not retried', async () => {
            const { fontCompilation, posted } = createAnsweringFontCompilation(
                (message) =>
                    message.type === 'applyYjsUpdate'
                        ? {
                              error: 'apply_yjs_update: ClockGapError: document glyph:3: client 7 needs clock 4, have 2'
                          }
                        : { success: true }
            );
            await fontCompilation.seedWorkerDocumentSet([
                { documentId: 'font-core', bytes: new Uint8Array([0, 0]) },
                { documentId: 'glyph:3', bytes: new Uint8Array([3]) }
            ]);
            const originalBridge = window.patchSyncEngine;
            const markDocumentBroken = jest.fn();
            window.patchSyncEngine = { markDocumentBroken };
            try {
                await expect(
                    fontCompilation.mirrorYjsUpdate({
                        update: new Uint8Array([4, 5, 6]),
                        changedGlyphs: ['a'],
                        documentId: 'glyph:3'
                    })
                ).rejects.toThrow('ClockGapError');
            } finally {
                window.patchSyncEngine = originalBridge;
            }
            expect(markDocumentBroken).toHaveBeenCalledWith(
                'glyph:3',
                expect.any(Error)
            );
            expect(posted.map((message) => message.type)).toEqual([
                'seedYdoc',
                'applyYjsUpdate'
            ]);
        });

        test('a failed catch-up replace is surfaced to the compile that waits for it', async () => {
            const { fontCompilation } = createAnsweringFontCompilation(() => ({
                error: 'seed_ydoc_document: BrokenDocumentError: document glyph:4 is broken: gap'
            }));
            const originalBridge = window.patchSyncEngine;
            const markDocumentBroken = jest.fn();
            window.patchSyncEngine = { markDocumentBroken };
            const errorSpy = jest
                .spyOn(console, 'error')
                .mockImplementation(() => undefined);
            try {
                fontCompilation.scheduleReplaceWorkerDocument(
                    'glyph:4',
                    new Uint8Array([1])
                );
                await expect(
                    fontCompilation.awaitWorkerDocumentReadyForCompile()
                ).rejects.toThrow('BrokenDocumentError');
                await new Promise((resolve) => setTimeout(resolve, 0));
                expect(markDocumentBroken).toHaveBeenCalledWith(
                    'glyph:4',
                    expect.any(Error)
                );
                expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
            } finally {
                window.patchSyncEngine = originalBridge;
                errorSpy.mockRestore();
            }
        });
    });
});
