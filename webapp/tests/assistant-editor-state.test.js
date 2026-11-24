jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

describe('get_editor_state text-buffer interpretation', () => {
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
        localStorage.removeItem('assistantAllowFontEdits');
        window.__counterpunchPythonPostExecutionHookInstalled = true;
        window.patchSyncEngine = {};
        window.fontManager = { currentFontModel: { axes: [] } };
        window.stateManager = {
            getStateSnapshot: jest.fn(() => ({
                state: {
                    editor_text_buffer: '0/10',
                    editor_cursor_position: 0,
                    editor_harfbuzz_glyph_names: '',
                    editor_harfbuzz_gids: '',
                    editor_harfbuzz_ax: '',
                    editor_harfbuzz_cl: '',
                    editor_opentype_features_in_subset: {},
                    editor_opentype_features_not_in_subset: {}
                }
            }))
        };
        window.glyphCanvas = {
            getCurrentGlyphName: jest.fn(() => 'undefined'),
            outlineEditor: {
                active: false,
                currentGlyphName: null
            },
            textRunEditor: {
                textBuffer: '0/10',
                displayTextBuffer: '0/10',
                explicitGlyphTokens: [],
                glyphNameBuffer: [],
                shapedGlyphs: [],
                cursorPosition: 0
            }
        };
    });

    test('forbids font editing by default for a new user', () => {
        const assistant = new AIAssistant();

        expect(assistant.allowFontEdits).toBe(false);
        expect(localStorage.getItem('assistantAllowFontEdits')).toBeNull();
    });

    test('reports a single slash exactly as raw state rather than inferring an escape pair', async () => {
        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.textBuffer).toBeUndefined();
        expect(result).toMatchObject({
            textBufferRaw: '0/10',
            textBufferDisplay: '0/10',
            textBufferInterpretationIsCurrent: true,
            explicitGlyphTokens: [],
            activeGlyphName: null,
            cursorPosition: 0
        });
        expect(result.textBufferRaw).not.toContain('//');
        expect(result.textBufferSyntax).toContain('Never infer //');
    });

    test('reports the active glyph and text-run cursor position', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: 'Hamburgevons',
                editor_cursor_position: 1,
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'a.ss04');
        window.glyphCanvas.outlineEditor = {
            active: true,
            currentGlyphName: 'a.ss04'
        };
        window.glyphCanvas.textRunEditor = {
            textBuffer: 'Hamburgevons',
            displayTextBuffer: 'Hamburgevons',
            explicitGlyphTokens: [],
            glyphNameBuffer: ['H', 'a.ss04'],
            shapedGlyphs: [
                { g: 1, ax: 500, cl: 0 },
                { g: 2, ax: 400, cl: 1 }
            ],
            cursorPosition: 1
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.activeGlyphName).toBe('a.ss04');
        expect(result.cursorPosition).toBe(1);
    });

    test('uses nested-component glyph name while editing and snapshot cursor when live caret is missing', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: 'A',
                editor_cursor_position: 0,
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'Adieresis');
        window.glyphCanvas.outlineEditor = {
            active: true,
            currentGlyphName: 'dieresiscomb.case'
        };
        window.glyphCanvas.textRunEditor = {
            textBuffer: 'A',
            displayTextBuffer: 'A',
            explicitGlyphTokens: []
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.activeGlyphName).toBe('dieresiscomb.case');
        expect(result.cursorPosition).toBe(0);
        expect(result.textBufferInterpretationIsCurrent).toBe(true);
    });

    test('explains which OpenType features are reachable in the current subset', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: 'fi',
                editor_opentype_features_in_subset: {
                    kern: true,
                    dlig: false
                },
                editor_opentype_features_not_in_subset: {
                    liga: true,
                    ss01: false
                }
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: 'fi',
            displayTextBuffer: 'fi',
            explicitGlyphTokens: [],
            glyphNameBuffer: ['f', 'i'],
            shapedGlyphs: [
                { g: 1, ax: 500, cl: 0 },
                { g: 2, ax: 400, cl: 1 }
            ]
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.opentypeFeaturesExplanation).toContain(
            'availableToActivate false'
        );
        expect(result.featureStateByTag).toEqual({
            dlig: false,
            kern: true,
            liga: false,
            ss01: false
        });
        expect(result.features).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    tag: 'kern',
                    active: true,
                    enabled: true,
                    availableToActivate: true,
                    inSubset: true,
                    status: 'Active now in the current editing subset.'
                }),
                expect.objectContaining({
                    tag: 'dlig',
                    active: false,
                    enabled: false,
                    availableToActivate: true,
                    inSubset: true,
                    status: 'Available to activate now in the current editing subset.'
                }),
                expect.objectContaining({
                    tag: 'liga',
                    active: false,
                    enabled: true,
                    availableToActivate: false,
                    inSubset: false,
                    status: expect.stringContaining('greyed out')
                }),
                expect.objectContaining({
                    tag: 'ss01',
                    active: false,
                    enabled: false,
                    availableToActivate: false,
                    inSubset: false,
                    note: expect.stringContaining(
                        'recommend enabling it with set_editor_opentype_features'
                    )
                })
            ])
        );
    });

    test('distinguishes raw escaped slashes from displayed text', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0//10',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0//10',
            displayTextBuffer: '0/10',
            explicitGlyphTokens: []
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.textBufferRaw).toBe('0//10');
        expect(result.textBufferDisplay).toBe('0/10');
        expect(result.explicitGlyphTokens).toEqual([]);
    });

    test('reports the current explicit glyph token interpretation', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0/ten',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0/ten',
            displayTextBuffer: '0/ten',
            explicitGlyphTokens: [{ name: 'ten', start: 1, end: 5 }]
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.explicitGlyphTokens).toEqual([
            { name: 'ten', start: 1, end: 5 }
        ]);
    });

    test('prefers the live shaping buffers after a skip-render feature reorder', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0/10',
                editor_harfbuzz_glyph_names:
                    'zero.numr fraction one.dnom zero.dnom',
                editor_harfbuzz_gids: '10 11 12 13',
                editor_harfbuzz_ax: '500 200 300 400',
                editor_harfbuzz_cl: '0 1 2 3',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0/10',
            displayTextBuffer: '0/10',
            explicitGlyphTokens: [],
            glyphNameBuffer: ['zero.zero', 'fraction', 'one.dnom', 'zero.zero'],
            shapedGlyphs: [
                { g: 20, ax: 600, cl: 0 },
                { g: 21, ax: 210, cl: 1 },
                { g: 22, ax: 310, cl: 2 },
                { g: 23, ax: 610, cl: 3 }
            ]
        };

        const assistant = new AIAssistant();
        const result = JSON.parse(
            await assistant.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result).toMatchObject({
            glyphs: 'zero.zero fraction one.dnom zero.zero',
            gids: '20 21 22 23',
            advances: '600 210 310 610',
            clusters: '0 1 2 3',
            shapingStateSource: 'live-text-run'
        });
    });

    test('stores a prompt summary for the next grouped Python transaction', async () => {
        window.patchSyncEngine = {
            updatePromptHistorySummary: jest.fn()
        };
        const assistant = new AIAssistant();
        assistant.activePromptContext = {
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'set_prompt_history_summary',
                    arguments: JSON.stringify({ summary: 'Update glyphs' })
                }
            })
        ).resolves.toBe(
            'Prompt history summary will be used for subsequent edits.'
        );

        expect(assistant.activePromptContext.historySummary).toBe(
            'Update glyphs'
        );
    });

    test('executes direct Python through the font-mutation lifecycle', async () => {
        const code = 'font = Font()\nprint(font.upm)';
        const wrappedRunPythonAsync = jest.fn().mockResolvedValue(undefined);
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('1000\n');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const assistant = new AIAssistant();
        assistant.activePromptContext = {
            id: 'prompt-direct-python',
            allowFontEdits: true,
            historySummary: 'Inspect font'
        };

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code })
                }
            })
        ).resolves.toBe('1000\n');

        expect(wrappedRunPythonAsync).toHaveBeenCalledWith(code);
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(2);
    });

    test('allows direct Python inspection when the prompt forbids font edits', async () => {
        const wrappedRunPythonAsync = jest.fn();
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('1000\n');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const assistant = new AIAssistant();
        assistant.activePromptContext = {
            id: 'prompt-read-only',
            allowFontEdits: false,
            historySummary: 'Inspect font'
        };

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print(Font().upm)' })
                }
            })
        ).resolves.toBe('1000\n');

        expect(wrappedRunPythonAsync).toHaveBeenCalledWith('print(Font().upm)');
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(2);
    });

    test('creates a read-only execution context for manual Python calls', async () => {
        const {
            getActiveAssistantPythonExecution
        } = require('../js/assistant-execution-context.ts');
        const wrappedRunPythonAsync = jest.fn(async () => {
            expect(getActiveAssistantPythonExecution()).toEqual(
                expect.objectContaining({
                    allowFontEdits: false,
                    historySummary: 'Manual Assistant tool call'
                })
            );
        });
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('1000\n');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const assistant = new AIAssistant();
        assistant.allowFontEdits = false;

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print(Font().upm)' })
                }
            })
        ).resolves.toBe('1000\n');

        expect(getActiveAssistantPythonExecution()).toBeNull();
    });

    test('waits for the committed Python edit refresh before returning output', async () => {
        let releaseCommittedRefresh;
        const committedRefresh = new Promise((resolve) => {
            releaseCommittedRefresh = resolve;
        });
        const {
            setActiveAssistantPythonExecutionCommit
        } = require('../js/assistant-execution-context.ts');
        const wrappedRunPythonAsync = jest.fn(async () => {
            setActiveAssistantPythonExecutionCommit(
                'committed',
                committedRefresh
            );
        });
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('updated shaping');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const assistant = new AIAssistant();
        assistant.activePromptContext = {
            id: 'prompt-settle',
            allowFontEdits: true,
            historySummary: 'Update shaping'
        };

        let resolved = false;
        const result = assistant
            .executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({
                        code: 'font.names.family_name = "Updated"'
                    })
                }
            })
            .then((output) => {
                resolved = true;
                return output;
            });

        await Promise.resolve();
        await Promise.resolve();
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(1);
        expect(resolved).toBe(false);

        releaseCommittedRefresh();
        await expect(result).resolves.toBe('updated shaping');
    });

    test('loads the detailed Python authoring guide for each document kind', async () => {
        const originalFetch = global.fetch;
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: jest.fn().mockResolvedValue('authoring guide')
        });
        global.fetch = fetchMock;
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'general-script' })
                }
            })
        ).resolves.toBe('authoring guide');
        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'glyph-filter' })
                }
            })
        ).resolves.toBe('authoring guide');
        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'other' })
                }
            })
        ).rejects.toThrow(
            'Choose general-script or glyph-filter for the Python authoring guide.'
        );

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/handbook/python/04-writing-general-scripts.md'
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            '/handbook/python/05-writing-glyph-overview-filters.md'
        );
        global.fetch = originalFetch;
    });

    test('renders every enum parameter as a selectable tool-executor field', () => {
        const { ASSISTANT_TOOLS } = require('../js/assistant-config.ts');
        const assistant = new AIAssistant();
        const toolsWithEnums = ASSISTANT_TOOLS.filter(({ function: tool }) =>
            Object.values(tool.parameters.properties || {}).some((schema) =>
                Array.isArray(schema.enum)
            )
        );

        for (const tool of toolsWithEnums) {
            const popup = assistant.createToolInvocationPopup(tool);
            for (const [name, schema] of Object.entries(
                tool.function.parameters.properties
            )) {
                if (!Array.isArray(schema.enum)) continue;
                const selector = popup.querySelector(`select[name="${name}"]`);
                expect(selector).not.toBeNull();
                expect(
                    Array.from(selector.options).map((option) => option.value)
                ).toEqual(['', ...schema.enum]);
            }
        }
    });

    test('uses neutral invocation wording in the manual tool executor', () => {
        const { ASSISTANT_TOOLS } = require('../js/assistant-config.ts');
        const authoringGuide = ASSISTANT_TOOLS.find(
            ({ function: tool }) => tool.name === 'python_authoring_guide'
        );
        const assistant = new AIAssistant();
        const popup = assistant.createToolInvocationPopup(authoringGuide);

        expect(popup.textContent).toContain(
            'Fill parameters, then invoke this tool.'
        );
        expect(popup.textContent).not.toContain('live tool call');
    });

    test('renders replace_python_text_in_editor diffs inline in chat', async () => {
        const assistant = new AIAssistant();
        await Promise.resolve();
        assistant.isAuthenticated = true;
        assistant.subscription = { canUseAssistant: true };
        assistant.updateAuthUI();
        assistant.promptInput.value = 'Update script';
        assistant.messagesContainer =
            document.getElementById('assistant-messages');
        const oldText = [
            '# Show init/medi/fina glyphs',
            '# Keywords: arabic, positional, initial, medial, final',
            '',
            'GROUPS = {',
            "    'init': {'description': 'Initial forms (.init)', 'color': '#E65100'},",
            "    'medi': {'description': 'Medial forms (.medi)', 'color': '#1565C0'},",
            "    'fina': {'description': 'Final forms (.fina)', 'color': '#2E7D32'}",
            '}',
            '',
            '',
            'def filter_glyphs(font):',
            '    for glyph in font.glyphs:'
        ].join('\n');
        const newText = [
            '# Show init/medi/fina/isol glyphs',
            '# Keywords: arabic, positional, initial, medial, final, isolated',
            '',
            'GROUPS = {',
            "    'init': {'description': 'Initial forms (.init)', 'color': '#E65100'},",
            "    'medi': {'description': 'Medial forms (.medi)', 'color': '#1565C0'},",
            "    'fina': {'description': 'Final forms (.fina)', 'color': '#2E7D32'},",
            "    'isol': {'description': 'Isolated forms (.isol)', 'color': '#6A1B9A'}",
            '}',
            '',
            '',
            'def filter_glyphs(font):',
            '    for glyph in font.glyphs:'
        ].join('\n');
        assistant.streamRound = jest
            .fn()
            .mockResolvedValueOnce({
                text: '',
                toolCalls: [
                    {
                        id: 'tool-1',
                        function: {
                            name: 'replace_python_text_in_editor',
                            arguments: JSON.stringify({
                                old_text: oldText,
                                new_text: newText,
                                expected_revision: 'revision-before-edit'
                            })
                        }
                    }
                ],
                done: true
            })
            .mockResolvedValueOnce({
                text: 'Done.',
                toolCalls: [],
                done: true
            });
        assistant.executeToolCall = jest
            .fn()
            .mockResolvedValue(
                [
                    'Edited /Counterpunch/Scripts/example.py (general-script)',
                    'Revision: revision-after-edit',
                    'Modified, not saved',
                    '',
                    '@@ Script Editor @@',
                    '-raw fallback should not be displayed',
                    '+raw fallback should not be displayed'
                ].join('\n')
            );

        await assistant.sendPrompt();

        const inlineDiff = assistant.messagesContainer.querySelector(
            '.assistant-python-edit-diff'
        );
        expect(inlineDiff).not.toBeNull();
        expect(inlineDiff.textContent).toContain('Python edit diff');
        expect(inlineDiff.textContent).toContain(
            '# Show init/medi/fina glyphs'
        );
        expect(inlineDiff.textContent).toContain(
            '# Show init/medi/fina/isol glyphs'
        );
        expect(inlineDiff.textContent).toContain(
            "    'isol': {'description': 'Isolated forms (.isol)', 'color': '#6A1B9A'}"
        );
        expect(inlineDiff.textContent).toContain('unchanged lines hidden');
        expect(inlineDiff.textContent).not.toContain(
            'raw fallback should not be displayed'
        );
        expect(
            inlineDiff.querySelectorAll('.assistant-python-edit-diff-row-added')
                .length
        ).toBeGreaterThan(0);
        expect(
            inlineDiff.querySelectorAll(
                '.assistant-python-edit-diff-row-removed'
            ).length
        ).toBeGreaterThan(0);
    });

    test('validates Python syntax without running the document', async () => {
        const globals = new Map();
        const originalRunPython = jest.fn(() =>
            JSON.stringify({ valid: true, message: 'Python syntax is valid.' })
        );
        const wrappedRunPython = jest.fn();
        const wrappedRunPythonAsync = jest.fn();
        window.pyodide = {
            _originalRunPython: originalRunPython,
            runPython: wrappedRunPython,
            runPythonAsync: wrappedRunPythonAsync,
            globals: {
                set: jest.fn((key, value) => globals.set(key, value)),
                delete: jest.fn((key) => globals.delete(key))
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'general-script',
                path: '/Counterpunch/Scripts/example.py',
                revision: 'revision-valid',
                content: 'print("not run during validation")'
            }))
        };
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(result).toMatchObject({
            valid: true,
            syntaxChecked: true,
            syntaxValid: true,
            structureValid: true,
            kind: 'general-script',
            editorKind: 'general-script',
            kindConfidence: 'saved-path',
            message:
                'Python syntax and static structure are valid. Python was not run.'
        });
        expect(originalRunPython).toHaveBeenCalledWith(
            expect.stringContaining(
                'compile(source, "<script-editor>", "exec")'
            )
        );
        expect(
            globals.get('__counterpunch_assistant_python_validation_source')
        ).toBe(undefined);
        expect(wrappedRunPython).not.toHaveBeenCalled();
        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
    });

    test('reports pathless default Python buffers as unclassified', async () => {
        window.pyodide = {
            _originalRunPython: jest.fn(() =>
                JSON.stringify({
                    valid: true,
                    message: 'Python syntax is valid.'
                })
            ),
            globals: {
                set: jest.fn(),
                delete: jest.fn()
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'general-script',
                path: null,
                revision: 'script-0',
                content: 'print("unsaved")'
            }))
        };
        const assistant = new AIAssistant();

        const activeDocument = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'get_active_python_document',
                    arguments: '{}'
                }
            })
        );
        const validation = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(activeDocument).toMatchObject({
            kind: null,
            editorKind: 'general-script',
            kindConfidence: 'unclassified-unsaved'
        });
        expect(activeDocument.kindMessage).toContain(
            'editor fallback is general-script'
        );
        expect(validation).toMatchObject({
            kind: null,
            editorKind: 'general-script',
            kindConfidence: 'unclassified-unsaved',
            valid: true,
            syntaxValid: true,
            structureValid: true
        });
        expect(validation.message).toContain(
            'editor fallback is general-script'
        );
        expect(validation.message).toContain(
            'must not treat that as authoritative'
        );
    });

    test('reports Python syntax errors from validation', async () => {
        const globals = new Map();
        window.pyodide = {
            _originalRunPython: jest.fn(() =>
                JSON.stringify({
                    valid: false,
                    message: "expected ':'",
                    line: 1,
                    offset: 23,
                    text: 'def filter_glyphs(font)'
                })
            ),
            globals: {
                set: jest.fn((key, value) => globals.set(key, value)),
                delete: jest.fn((key) => globals.delete(key))
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'glyph-filter',
                revision: 'revision-invalid',
                content: 'def filter_glyphs(font)\n    yield {}'
            }))
        };
        const assistant = new AIAssistant();

        const result = JSON.parse(
            await assistant.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(result).toMatchObject({
            valid: false,
            syntaxChecked: true,
            syntaxValid: false,
            structureValid: false,
            syntaxError: {
                message: "expected ':'",
                line: 1,
                offset: 23,
                text: 'def filter_glyphs(font)'
            }
        });
        expect(result.message).toContain(
            "Python syntax error on line 1, column 23: expected ':'"
        );
        expect(result.message).toContain(
            'Glyph filters must define classify_glyph(glyph).'
        );
    });

    test('executes Python manually without an active prompt', async () => {
        const wrappedRunPythonAsync = jest.fn().mockResolvedValue(undefined);
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('test\n');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const assistant = new AIAssistant();

        await expect(
            assistant.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print("test")' })
                }
            })
        ).resolves.toBe('test\n');

        expect(wrappedRunPythonAsync).toHaveBeenCalledWith('print("test")');
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(2);
    });

    test('reverts a Python tool edit only with the current revision and permission', () => {
        const replaceExactText = jest.fn(() => ({
            revision: 'revision-after-revert'
        }));
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                revision: 'revision-after-edit'
            })),
            replaceExactText
        };
        const assistant = new AIAssistant();
        assistant.allowFontEdits = true;
        const meta = assistant.createToolCallMetaElement(
            'replace_python_text_in_editor',
            { old_text: 'old text', new_text: 'new text' },
            'Edited /Counterpunch/Scripts/example.py (general-script)\nRevision: revision-after-edit\nModified, not saved',
            '1 ms'
        );

        meta.querySelector('[aria-label="Revert this Assistant edit"]').click();

        expect(replaceExactText).toHaveBeenCalledWith(
            'new text',
            'old text',
            'revision-after-edit'
        );
        expect(meta.textContent).toContain(
            'Assistant edit reverted, not saved.'
        );
    });

    test('does not revert a Python tool edit while Assistant editing is disabled', () => {
        const replaceExactText = jest.fn();
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                revision: 'revision-after-edit'
            })),
            replaceExactText
        };
        const assistant = new AIAssistant();
        assistant.allowFontEdits = false;
        const meta = assistant.createToolCallMetaElement(
            'replace_python_text_in_editor',
            { old_text: 'old text', new_text: 'new text' },
            'Edited /Counterpunch/Scripts/example.py (general-script)\nRevision: revision-after-edit\nModified, not saved',
            '1 ms'
        );

        meta.querySelector('[aria-label="Revert this Assistant edit"]').click();

        expect(replaceExactText).not.toHaveBeenCalled();
        expect(meta.textContent).toContain(
            'Enable editing in the Assistant title bar before reverting.'
        );
    });
});
