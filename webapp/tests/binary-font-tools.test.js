jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('split binary-font assistant tools', () => {
    let AIAssistant;

    beforeAll(() => {
        document.body.innerHTML = `
            <textarea id="assistant-prompt"></textarea>
            <button id="assistant-send-btn"></button>
            <div id="assistant-messages"></div>
            <div id="assistant-chat-container"></div>
            <div id="assistant-login-container"></div>
            <div id="assistant-subscription-container"></div>
        `;
        window.authManager = {
            checkAuthStatus: jest.fn().mockResolvedValue(null),
            subscription: null,
            onAuthStateChanged: null
        };
        AIAssistant = require('../js/ai-assistant').default;
    });

    beforeEach(() => {
        const inspectionValues = {
            '/tables/head/unitsPerEm': 1000,
            '/tables/maxp/numGlyphs': 42,
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string':
                'Fustat',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=2/string':
                'Regular',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=4/string':
                'Fustat Regular',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=5/string':
                'Version 1.011',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=6/string':
                'Fustat-Regular',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=0/string':
                'Copyright 2022 The Fustat Project Authors (https://github.com/Kief-Type-Foundry/Fustat)',
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=3/string':
                '1.011;1KTF;Fustat-Regular'
        };
        const listedChildren = {
            '/tables/name/records': {
                path: '/tables/name/records',
                children: [
                    {
                        path: '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string',
                        label: 'nameID=1: Fustat',
                        kind: 'nameRecord',
                        value: {
                            platformID: 3,
                            encodingID: 1,
                            languageID: 0x0409,
                            nameID: 1,
                            string: 'Fustat'
                        }
                    },
                    {
                        path: '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=2/string',
                        label: 'nameID=2: Regular',
                        kind: 'nameRecord',
                        value: {
                            platformID: 3,
                            encodingID: 1,
                            languageID: 0x0409,
                            nameID: 2,
                            string: 'Regular'
                        }
                    }
                ],
                truncated: false
            },
            '/tables/fvar/axes': {
                path: '/tables/fvar/axes',
                children: [
                    {
                        path: '/tables/fvar/axes/index=0',
                        label: 'index=0 tag=wght',
                        kind: 'variationAxis',
                        value: {
                            tag: 'wght',
                            minValue: 100,
                            defaultValue: 400,
                            maxValue: 900,
                            flags: 0
                        }
                    }
                ],
                truncated: false
            },
            '/tables/hmtx/metrics': {
                path: '/tables/hmtx/metrics',
                children: [
                    {
                        path: '/tables/hmtx/metrics/gid=0',
                        label: 'gid=0',
                        kind: 'horizontalMetric',
                        value: { advanceWidth: 600, sideBearing: 15 }
                    }
                ],
                truncated: false
            },
            '/tables/glyf': {
                path: '/tables/glyf',
                children: [
                    {
                        path: '/tables/glyf/gid=36',
                        label: 'gid=36',
                        kind: 'glyph',
                        value: { outlinePath: '/tables/glyf/gid=36/outline' }
                    }
                ],
                truncated: false
            }
        };
        const mockSendMessage = function (data) {
            if (!data || data.type !== 'listDebugCachedFontChildren') {
                return Promise.resolve({});
            }

            const request = JSON.parse(data.requestJson);
            const payload = listedChildren[request.path] || {
                path: request.path,
                children: [],
                truncated: false
            };
            return Promise.resolve({
                result: JSON.stringify(payload)
            });
        };
        const mockInspectDebugCachedFont = function (_fontHash, request) {
            return Promise.resolve({
                values: request.paths.map(function (path) {
                    return Object.prototype.hasOwnProperty.call(
                        inspectionValues,
                        path
                    )
                        ? inspectionValues[path]
                        : null;
                })
            });
        };

        window.fontManager = {
            currentFont: {
                sourcePlugin: { getId: jest.fn(() => 'memory') },
                path: 'memory:///font.glyphs',
                changeVersion: 1
            },
            deriveSubsetGlyphsFromText: jest.fn(function () {
                if (!this || !this.currentFont) {
                    throw new TypeError(
                        "Cannot read properties of undefined (reading 'currentFont')"
                    );
                }
                return ['A', 'B'];
            }),
            workerCacheUpdatePromise: null,
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([9, 8, 7]))
        };
        window.fontCompilation = {
            awaitWorkerDocumentSync: jest.fn().mockResolvedValue(),
            hasWorkerCacheDocument: jest.fn(() => true),
            compileBinaryFont: jest.fn(),
            compileCached: jest.fn(),
            compileCommittedDebugFont: jest.fn(),
            storeFontJson: jest.fn()
        };
        window.fullFontCompilation = {};
        window.fullFontCompilation.awaitWorkerDocumentSync = jest
            .fn()
            .mockResolvedValue();
        window.fullFontCompilation.hasWorkerCacheDocument = jest.fn(
            () => false
        );
        window.fullFontCompilation.bootstrapWorkerCacheFromFontState = jest
            .fn()
            .mockResolvedValue();
        window.fullFontCompilation.compileBinaryFont = jest
            .fn()
            .mockResolvedValue({ fontHash: 'binary-hash-1' });
        window.fullFontCompilation.compileCommittedDebugFont = jest
            .fn()
            .mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'debug-font.ttf',
                time_taken: 1,
                fontHash: 'editing-hash-1',
                closureGlyphCount: 2
            });
        window.fullFontCompilation.sendMessage = jest.fn(mockSendMessage);
        window.fullFontCompilation.getDebugCachedFontBytes = jest
            .fn()
            .mockResolvedValue(new Uint8Array([4, 5, 6]));
        window.fullFontCompilation.inspectDebugCachedFont = jest.fn(
            mockInspectDebugCachedFont
        );
        window.shapeTextWithFontDetailed = jest.fn(function () {
            return Promise.resolve({
                glyphs: ['A'],
                gids: [36],
                advances: [600],
                advancesY: [0],
                offsetsX: [0],
                offsetsY: [0],
                clusters: [0]
            });
        });
        window.windowRole = { isMainWindow: jest.fn(() => true) };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: false,
                isPreviewMode: false,
                hasPendingKeyboardPreviewCommit: jest.fn(() => false)
            }
        };
    });

    test('compiles only after worker settlement, seeds the isolated worker, and returns a hash', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const assistant = new AIAssistant();
        const toolCall = assistant.executeToolCall({
            function: {
                name: 'compile_binary_font',
                arguments: JSON.stringify({ target: 'full' })
            }
        });

        await Promise.resolve();
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
        pendingUpdate.resolve();

        await expect(toolCall).resolves.toBe('binary-hash-1');
        expect(
            window.fullFontCompilation.bootstrapWorkerCacheFromFontState
        ).toHaveBeenCalledWith(expect.any(Uint8Array));
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).toHaveBeenCalledWith(
            'full',
            'assistant-binary-font.ttf',
            expect.objectContaining({
                awaitWorkerDocumentSync: expect.any(Function),
                hasWorkerCacheDocument: expect.any(Function)
            })
        );
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
        expect(window.fontCompilation.compileBinaryFont).not.toHaveBeenCalled();
        expect(window.fontCompilation.storeFontJson).not.toHaveBeenCalled();
    });

    test('seeds glyph shards instead of the core snapshot when a document set exists', async () => {
        const shards = [
            { documentId: 'font-core', bytes: new Uint8Array([1]) },
            { documentId: 'glyph:A', bytes: new Uint8Array([2]) }
        ];
        window.fontManager.buildWorkerSeedDocumentSet = jest.fn(() => shards);
        window.fullFontCompilation.seedWorkerDocumentSet = jest
            .fn()
            .mockResolvedValue();
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({ target: 'full', text: '' })
                }
            })
        ).resolves.toBe('binary-hash-1');

        expect(
            window.fullFontCompilation.seedWorkerDocumentSet
        ).toHaveBeenCalledWith(shards);
        expect(
            window.fullFontCompilation.bootstrapWorkerCacheFromFontState
        ).not.toHaveBeenCalled();
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).toHaveBeenCalledWith(
            'full',
            'assistant-binary-font.ttf',
            expect.any(Object)
        );
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('reuses a warm analysis worker for a full compile', async () => {
        const shards = [
            { documentId: 'font-core', bytes: new Uint8Array([1]) },
            { documentId: 'glyph:A', bytes: new Uint8Array([2]) }
        ];
        window.fontManager.buildWorkerSeedDocumentSet = jest.fn(() => shards);
        window.fullFontCompilation.hasWorkerCacheDocument.mockReturnValue(true);
        window.fullFontCompilation.seedWorkerDocumentSet = jest
            .fn()
            .mockResolvedValue();
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({ target: 'full', text: '' })
                }
            })
        ).resolves.toBe('binary-hash-1');

        expect(
            window.fontManager.deriveSubsetGlyphsFromText
        ).not.toHaveBeenCalled();
        expect(
            window.fullFontCompilation.seedWorkerDocumentSet
        ).not.toHaveBeenCalled();
        expect(window.fullFontCompilation.compileBinaryFont).toHaveBeenCalled();
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('shape reads the requested hash and never compiles implicitly', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        text: 'A',
                        features: { kern: true, liga: false },
                        variationLocation: { wght: 500 }
                    })
                }
            })
        );

        expect(result.fontHash).toBe('binary-hash-1');
        expect(result.glyphs).toEqual(['A']);
        expect(
            window.fullFontCompilation.getDebugCachedFontBytes
        ).toHaveBeenCalledWith('binary-hash-1');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('describe_binary_font exposes supported collections and profiles', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'describe_binary_font',
                    arguments: JSON.stringify({ path: '/tables/name' })
                }
            })
        );

        expect(
            result.collections.some(
                (entry) => entry.path === '/tables/name/records'
            )
        ).toBe(true);
        expect(result.snapshotProfiles.map((profile) => profile.name)).toEqual(
            expect.arrayContaining(['summary', 'names', 'variation', 'metrics'])
        );
    });

    test('list_binary_font_children returns actual name records', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'list_binary_font_children',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        path: '/tables/name/records'
                    })
                }
            })
        );

        expect(result.path).toBe('/tables/name/records');
        expect(result.children[0].path).toContain('nameID=1/string');
        expect(window.fullFontCompilation.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'listDebugCachedFontChildren' })
        );
    });

    test('search_binary_font_surface finds supported paths without a hash', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'search_binary_font_surface',
                    arguments: JSON.stringify({
                        query: 'name records'
                    })
                }
            })
        );

        expect(
            result.matches.some(
                (match) => match.path === '/tables/name/records'
            )
        ).toBe(true);
    });

    test('search_binary_font_children finds listed children inside a compiled subtree', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'search_binary_font_children',
                    arguments: JSON.stringify({
                        query: 'nameID=1',
                        fontHash: 'binary-hash-1',
                        path: '/tables/name/records'
                    })
                }
            })
        );

        expect(result.withinPath).toBe('/tables/name/records');
        expect(
            result.matches.some((match) =>
                match.path.includes('/tables/name/records')
            )
        ).toBe(true);
        expect(window.fullFontCompilation.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'listDebugCachedFontChildren' })
        );
    });

    test('snapshot_binary_font bundles summary and names', async () => {
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'snapshot_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        profile: 'names'
                    })
                }
            })
        );

        expect(result.profile).toBe('names');
        expect(result.summary.familyName).toBe('Fustat');
        expect(result.nameRecords.children).toHaveLength(2);
        expect(result.nameRecords.children[0].value.string).toBe('Fustat');
    });

    test('subset target derives subset glyphs from text before compiling', async () => {
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({
                        target: 'subset',
                        text: 'AB'
                    })
                }
            })
        ).resolves.toBe('editing-hash-1');

        expect(
            window.fontManager.deriveSubsetGlyphsFromText
        ).toHaveBeenCalledWith('AB');
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).toHaveBeenCalledWith(
            ['A', 'B'],
            'assistant-binary-font.ttf',
            'editing'
        );
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('subset target requires text', async () => {
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({ target: 'subset' })
                }
            })
        ).rejects.toThrow('target "subset" requires text (string).');
    });

    test('rejects non-object feature input for shape_binary_font', async () => {
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        text: 'A',
                        features: 'kern=1'
                    })
                }
            })
        ).rejects.toThrow('features must be an object when provided.');
    });

    test('inspection requires API docs, then preserves requested path order', async () => {
        const assistant = new AIAssistant();
        const inspection = {
            function: {
                name: 'inspect_binary_font',
                arguments: JSON.stringify({
                    fontHash: 'binary-hash-1',
                    fontIndex: 0,
                    paths: ['/tables/head/unitsPerEm', '/tables/maxp/numGlyphs']
                })
            }
        };

        await expect(assistant.executeToolCall(inspection)).rejects.toThrow(
            'binary_font_api_docs'
        );
        await assistant.executeToolCall({
            function: {
                name: 'binary_font_api_docs',
                arguments: '{}'
            }
        });

        await expect(assistant.executeToolCall(inspection)).resolves.toBe(
            JSON.stringify({ values: [1000, 42] })
        );
        expect(
            window.fullFontCompilation.inspectDebugCachedFont
        ).toHaveBeenCalledWith('binary-hash-1', {
            fontIndex: 0,
            paths: ['/tables/head/unitsPerEm', '/tables/maxp/numGlyphs']
        });
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test.each([
        'compile_binary_font',
        'shape_binary_font',
        'inspect_binary_font'
    ])('rejects %s in a linked window or active preview', async (name) => {
        const assistant = new AIAssistant();
        const args =
            name === 'compile_binary_font'
                ? {}
                : name === 'shape_binary_font'
                  ? { fontHash: 'binary-hash-1', text: 'A' }
                  : {
                        fontHash: 'binary-hash-1',
                        paths: ['/tables/head/unitsPerEm']
                    };

        window.windowRole.isMainWindow.mockReturnValue(false);
        await expect(
            assistant.executeToolCall({
                function: { name, arguments: JSON.stringify(args) }
            })
        ).rejects.toThrow('main window');

        window.windowRole.isMainWindow.mockReturnValue(true);
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        await expect(
            assistant.executeToolCall({
                function: { name, arguments: JSON.stringify(args) }
            })
        ).rejects.toThrow('edit preview');
    });

    test('fails visibly when a requested hash is absent', async () => {
        window.fullFontCompilation.getDebugCachedFontBytes.mockRejectedValue(
            new Error('Debug cached font bytes not found')
        );
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'missing-hash',
                        text: 'A'
                    })
                }
            })
        ).rejects.toThrow('Debug cached font bytes not found');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when committed worker synchronization rejects', async () => {
        window.fontCompilation.awaitWorkerDocumentSync.mockRejectedValue(
            new Error('worker document sync failed')
        );
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: '{}'
                }
            })
        ).rejects.toThrow('worker document sync failed');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when the editing worker cache is not ready', async () => {
        window.fontCompilation.hasWorkerCacheDocument.mockReturnValue(false);
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: '{}'
                }
            })
        ).rejects.toThrow('requires the current font to finish synchronizing');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('rejects a preview that starts while worker state settles', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const assistant = new AIAssistant();
        const toolCall = assistant.executeToolCall({
            function: {
                name: 'compile_binary_font',
                arguments: '{}'
            }
        });

        await Promise.resolve();
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        pendingUpdate.resolve();

        await expect(toolCall).rejects.toThrow(
            'unavailable while an edit preview is active'
        );
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('filters assistant tools by both category and name', () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            `
                <button id="assistant-info-btn"></button>
                <div id="assistant-info-modal" style="display: none">
                    <button id="assistant-info-modal-close-btn"></button>
                    <div id="assistant-info-modal-content"></div>
                </div>
            `
        );
        const assistant = new AIAssistant();
        const modal = document.getElementById('assistant-info-modal');
        const content = document.getElementById('assistant-info-modal-content');

        document.getElementById('assistant-info-btn').click();
        expect(modal.style.display).toBe('flex');
        expect(content.textContent).toContain('Binary Font');
        expect(content.textContent).toContain('shape_binary_font');

        const search = content.querySelector(
            'input[aria-label="Search tool names"]'
        );
        search.value = 'shape';
        search.dispatchEvent(new Event('input'));
        expect(
            [...content.querySelectorAll('.ai-info-section h4')].map(
                (heading) => heading.textContent
            )
        ).toEqual(['shape_binary_font']);

        [...content.querySelectorAll('.assistant-tool-category-chip')]
            .find((chip) => chip.textContent === 'Documentation')
            .click();
        expect(content.textContent).toContain('No matching tools.');

        modal.remove();
        document.getElementById('assistant-info-btn').remove();
        assistant.abortController?.abort();
    });
});
