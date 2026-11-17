jest.mock('tippy.js', () => ({ __esModule: true, default: jest.fn() }));

const {
    FILTER_CHAT_PROFILE,
    FILTER_CHAT_TOOLS,
    FilterChatRegistry,
    createFilterChatHost,
    describeFilterToolCall,
    filterChatMessages
} = require('../js/glyph-filter-chat.ts');
const { claimSuggestedFilterName } = require('../js/glyph-filter-names.ts');

function memoryTarget(content, path = 'Filters/Small Caps.py') {
    return {
        label: 'Filter',
        getDocumentState: () => ({
            content,
            kind: 'glyph-filter',
            path,
            revision: 'r1',
            isModified: true
        }),
        replaceExactText: () => {
            throw new Error('not used');
        },
        onDidChange: () => () => {}
    };
}

const preview = {
    ok: true,
    glyphNames: ['a.sc', 'b.sc'],
    results: [],
    groups: [{ name: 'Small caps', color: 'purple', count: 2 }],
    eventTypes: ['glyph.renamed'],
    errors: []
};

describe('glyph filter chat', () => {
    test('offers filter tools only, never font-editing or file tools', () => {
        const names = FILTER_CHAT_TOOLS.map((tool) => tool.function.name);
        expect(names).toContain('replace_python_text_in_editor');
        expect(names).toContain('replace_python_document_in_editor');
        expect(names).toContain('test_filter_on_font');
        // The system prompt carries the authoring guide and its event list.
        expect(names).not.toContain('python_authoring_guide');
        expect(names).not.toContain('glyph_filter_event_types');
        expect(names).not.toContain('create_python_draft_in_editor');
        expect(names).not.toContain('open_python_document_in_editor');
        expect(names).not.toContain('set_editor_text_buffer');
        expect(FILTER_CHAT_PROFILE.editPermissions(false)).toEqual({
            fontEdits: false,
            documentEdits: true
        });
    });

    test('the system prompt carries the description, code and guide', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('# Writing glyph overview filters')
        });
        global.fetch = fetchMock;
        const session = {
            target: memoryTarget('"""Show small caps."""\n'),
            markDocumentRead: jest.fn()
        };
        const prompt = await FILTER_CHAT_PROFILE.buildSystemPrompt({
            session,
            runTool: jest.fn()
        });
        expect(prompt).toContain('CURRENT DESCRIPTION:\nShow small caps.');
        expect(prompt).toContain('FILTER FILE: Filters/Small Caps.py');
        expect(prompt).toContain(
            'CURRENT CODE (revision r1):\n```python\n"""Show small caps."""\n'
        );
        expect(prompt).toContain(
            'FILTER AUTHORING GUIDE:\n# Writing glyph overview filters'
        );
        // The model has seen this revision, so edits may rely on it.
        expect(session.markDocumentRead).toHaveBeenCalledWith('r1');

        // The guide is loaded once.
        await FILTER_CHAT_PROFILE.buildSystemPrompt({
            session,
            runTool: jest.fn()
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        delete global.fetch;
    });

    test('the host runs the dry run itself and passes other tools on', async () => {
        const previewFn = jest.fn().mockResolvedValue(preview);
        const executeSharedTool = jest.fn().mockResolvedValue('shared');
        const nameFilter = jest
            .fn()
            .mockReturnValue('Renamed to “Small Caps”.');
        const host = createFilterChatHost({
            preview: previewFn,
            nameFilter,
            takenNames: () => [],
            executeSharedTool
        });
        const session = { target: memoryTarget('code') };

        const result = JSON.parse(
            await host.executeToolCall(
                { function: { name: 'test_filter_on_font', arguments: '{}' } },
                session
            )
        );
        expect(previewFn).toHaveBeenCalledWith('code');
        expect(result).toMatchObject({
            ok: true,
            matchingGlyphs: 2,
            sample: ['a.sc', 'b.sc']
        });
        expect(result.groups).toEqual([
            { name: 'Small caps', color: 'purple', count: 2 }
        ]);

        await host.executeToolCall(
            {
                function: {
                    name: 'get_active_python_document',
                    arguments: '{}'
                }
            },
            session
        );
        expect(executeSharedTool).toHaveBeenCalledTimes(1);

        await expect(
            host.executeToolCall(
                {
                    function: {
                        name: 'name_filter',
                        arguments: '{"name":"Small Caps"}'
                    }
                },
                session
            )
        ).resolves.toBe('Renamed to “Small Caps”.');
        expect(nameFilter).toHaveBeenCalledWith('Small Caps');
        expect(executeSharedTool).toHaveBeenCalledTimes(1);
    });

    test('the registry hands out forks and keeps only committed chats', () => {
        const registry = new FilterChatRegistry();
        const host = { executeToolCall: jest.fn() };
        const first = registry.checkout(
            'Filters/A.py',
            memoryTarget('a'),
            host
        );
        first.appendEntry({ kind: 'user', text: 'Hello', automatic: false });

        // Not committed: the next checkout starts empty.
        expect(
            registry.checkout('Filters/A.py', memoryTarget('a'), host)
                .transcript
        ).toEqual([]);

        registry.commit('Filters/A.py', first);
        const second = registry.checkout(
            'filters/a.py',
            memoryTarget('a'),
            host
        );
        expect(second).not.toBe(first);
        expect(second.transcript).toHaveLength(1);

        // A cancelled fork leaves the applied chat alone.
        second.appendEntry({
            kind: 'user',
            text: 'Cancelled',
            automatic: false
        });
        expect(
            registry.checkout('Filters/A.py', memoryTarget('a'), host)
                .transcript
        ).toHaveLength(1);

        registry.rename('Filters/A.py', 'Filters/B.py');
        expect(registry.has('Filters/A.py')).toBe(false);
        expect(registry.has('Filters/B.py')).toBe(true);
        registry.remove('Filters/B.py');
        expect(registry.has('Filters/B.py')).toBe(false);
    });

    test('automatic messages use the agreed wording', () => {
        expect(filterChatMessages.descriptionUpdated('X', 'Y')).toBe(
            'The user updated the filter description from “X” to “Y”. Update the underlying Python code.'
        );
        // No second full stop after a description that already ends one.
        expect(filterChatMessages.descriptionWritten('Show small caps.')).toBe(
            'The user described a new filter: “Show small caps.” Write the Python code for it.'
        );
    });

    test('tool calls read as one status line', () => {
        const call = (name, overrides = {}) => ({
            id: null,
            name,
            args: {},
            result: null,
            failed: false,
            timeLabel: null,
            ...overrides
        });
        expect(
            describeFilterToolCall(call('replace_python_document_in_editor'))
        ).toBe('Writing the filter code…');
        expect(describeFilterToolCall(call('test_filter_on_font'))).toBe(
            'Testing the filter on the font…'
        );
        expect(
            describeFilterToolCall(
                call('name_filter', { args: { name: 'Small Caps' } })
            )
        ).toBe('Naming the filter “Small Caps”…');
        expect(
            describeFilterToolCall(
                call('validate_python_document', { result: 'OK' })
            )
        ).toBe('Checking the filter code: done. Thinking about the next step…');
        expect(
            describeFilterToolCall(
                call('execute_python_code', { result: 'Error', failed: true })
            )
        ).toBe('Inspecting the font: failed. Thinking about the next step…');
        expect(describeFilterToolCall(call('some_new_tool'))).toBe(
            'Calling some_new_tool…'
        );
    });

    test('name_filter lists the names other filters have', () => {
        const nameTool = (tools) =>
            tools.find((tool) => tool.function.name === 'name_filter');
        const tools = FILTER_CHAT_PROFILE.toolsFor({
            host: { takenFilterNames: () => ['Small Caps', 'Anchors'] }
        });
        expect(nameTool(tools).function.description).toContain(
            'Other filters already use these names, so do not pick them: “Small Caps”, “Anchors”.'
        );
        expect(tools.map((tool) => tool.function.name)).toEqual(
            FILTER_CHAT_TOOLS.map((tool) => tool.function.name)
        );
        // The shared definition stays unchanged.
        expect(nameTool(FILTER_CHAT_TOOLS).function.description).not.toContain(
            'Other filters already use'
        );
        expect(
            FILTER_CHAT_PROFILE.toolsFor({
                host: { takenFilterNames: () => [] }
            })
        ).toBe(FILTER_CHAT_TOOLS);
    });

    test('a suggested name another filter has gets the next free number', () => {
        expect(claimSuggestedFilterName('Small Caps', ['Anchors'])).toEqual({
            name: 'Small Caps'
        });
        expect(
            claimSuggestedFilterName('small caps.py', [
                'Small Caps',
                'small caps 2'
            ])
        ).toEqual({ name: 'small caps 3' });
        expect(claimSuggestedFilterName('A/B', [])).toEqual({
            error: 'A name cannot contain / \\ : * ? " < > |'
        });
    });
});
