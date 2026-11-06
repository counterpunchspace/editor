jest.mock('tippy.js', () => ({ __esModule: true, default: jest.fn() }));

const {
    FILTER_CHAT_PROFILE,
    FILTER_CHAT_TOOLS,
    FilterChatRegistry,
    createFilterChatHost,
    filterChatMessages
} = require('../js/glyph-filter-chat.ts');

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
        expect(names).toContain('test_filter_on_font');
        expect(names).not.toContain('create_python_draft_in_editor');
        expect(names).not.toContain('open_python_document_in_editor');
        expect(names).not.toContain('set_editor_text_buffer');
        expect(FILTER_CHAT_PROFILE.editPermissions(false)).toEqual({
            fontEdits: false,
            documentEdits: true
        });
    });

    test('the system prompt carries the current description', async () => {
        const session = {
            target: memoryTarget('"""Show small caps."""\n'),
            isDocumentStale: () => false
        };
        const prompt = await FILTER_CHAT_PROFILE.buildSystemPrompt({
            session,
            runTool: jest.fn()
        });
        expect(prompt).toContain('CURRENT DESCRIPTION:\nShow small caps.');
        expect(prompt).toContain('FILTER FILE: Filters/Small Caps.py');
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
});
