jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

const { AssistantChatSession } = require('../js/assistant/chat-session');
const {
    createToolCallDetailsElement,
    pythonEditTexts
} = require('../js/assistant/chat-view');
const { AcePythonDocumentTarget } = require('../js/assistant/python-target');

/** Just enough of an Ace editor for AcePythonDocumentTarget. */
function fakeAce(initial) {
    let value = initial;
    const handlers = new Set();
    const toIndex = ({ row, column }) => {
        const lines = value.split('\n');
        let index = 0;
        for (let i = 0; i < row; i++) index += lines[i].length + 1;
        return index + column;
    };
    return {
        getValue: () => value,
        session: {
            getDocument: () => ({
                indexToPosition(index) {
                    const before = value.slice(0, index).split('\n');
                    return {
                        row: before.length - 1,
                        column: before[before.length - 1].length
                    };
                },
                replace(range, text) {
                    value =
                        value.slice(0, toIndex(range.start)) +
                        text +
                        value.slice(toIndex(range.end));
                    handlers.forEach((handler) => handler());
                }
            })
        },
        on: (_event, handler) => handlers.add(handler),
        off: (_event, handler) => handlers.delete(handler)
    };
}

const profile = {
    id: 'test',
    tools: [],
    editPermissions: () => ({ fontEdits: false, documentEdits: true }),
    editDisabledHint: 'Enable editing',
    buildSystemPrompt: async () => ''
};

function call(name, args) {
    return { function: { name, arguments: JSON.stringify(args) } };
}

describe('Python document edits', () => {
    let AIAssistant;
    let assistant;
    let editor;
    let target;
    let session;

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
        assistant = new AIAssistant();
        editor = fakeAce(
            'EVENT_TYPES = []\n\ndef classify_glyph(glyph):\n    return False\n'
        );
        target = new AcePythonDocumentTarget(editor, {
            label: 'Filter editor',
            kind: 'glyph-filter',
            path: () => '/Filters/Test.py'
        });
        session = new AssistantChatSession({
            profile,
            host: { executeToolCall: jest.fn() },
            target,
            allowEdits: true
        });
        session.activePromptContext = { allowFontEdits: true };
    });

    test('replace_python_document_in_editor replaces the whole document', async () => {
        session.markDocumentRead(target.getDocumentState().revision);
        const content =
            'EVENT_TYPES = []\n\ndef classify_glyph(glyph):\n    return True\n';

        const result = await assistant.executeToolCall(
            call('replace_python_document_in_editor', { content }),
            session
        );

        expect(editor.getValue()).toBe(content);
        expect(result).toContain('Edited /Filters/Test.py (glyph-filter)');
        expect(result).toContain('Revision: filter-editor-1');
        expect(session.lastKnownDocumentRevision).toBe('filter-editor-1');
    });

    test('an edit without expected_revision uses the revision last read', async () => {
        session.markDocumentRead(target.getDocumentState().revision);

        await assistant.executeToolCall(
            call('replace_python_text_in_editor', {
                old_text: 'return False',
                new_text: 'return True'
            }),
            session
        );

        expect(editor.getValue()).toContain('return True');
    });

    test('an edit without expected_revision still fails after an outside change', async () => {
        session.markDocumentRead(target.getDocumentState().revision);
        editor.session
            .getDocument()
            .replace(
                { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
                '# hand edit\n'
            );

        await expect(
            assistant.executeToolCall(
                call('replace_python_document_in_editor', { content: 'x' }),
                session
            )
        ).rejects.toThrow(
            'The script changed since it was last read (current revision: filter-editor-1). Read it again before editing.'
        );
        expect(editor.getValue()).toContain('# hand edit');
    });

    test('an edit before any read asks for a read', async () => {
        await expect(
            assistant.executeToolCall(
                call('replace_python_document_in_editor', { content: 'x' }),
                session
            )
        ).rejects.toThrow(
            'Read the document with get_active_python_document before editing it.'
        );
    });

    test('the chat keeps the document from before a whole-document edit', async () => {
        const before = editor.getValue();
        const host = {
            streamRound: jest
                .fn()
                .mockResolvedValueOnce({
                    text: '',
                    toolCalls: [
                        {
                            id: 'tool-1',
                            ...call('replace_python_document_in_editor', {
                                content: 'new'
                            })
                        }
                    ]
                })
                .mockResolvedValueOnce({ text: 'Done.', toolCalls: [] }),
            executeToolCall: jest.fn().mockResolvedValue('Revision: r2')
        };
        const chat = new AssistantChatSession({
            profile,
            host,
            target,
            allowEdits: true
        });

        await chat.send('Rewrite it');

        const turn = chat.transcript.find(
            (entry) => entry.kind === 'assistant'
        );
        expect(turn.items[0].call.previousContent).toBe(before);
    });

    test('whole-document edits get the diff texts and can be undone', () => {
        expect(
            pythonEditTexts(
                'replace_python_document_in_editor',
                { content: 'new code' },
                'old code'
            )
        ).toEqual({ old_text: 'old code', new_text: 'new code' });
        expect(
            pythonEditTexts('replace_python_document_in_editor', {
                content: 'new code'
            })
        ).toBeNull();

        session.markDocumentRead(target.getDocumentState().revision);
        const before = editor.getValue();
        target.replaceContent('new code', target.getDocumentState().revision);
        const meta = createToolCallDetailsElement(
            session,
            'replace_python_document_in_editor',
            { content: 'new code' },
            `Edited /Filters/Test.py (glyph-filter)\nRevision: ${target.getDocumentState().revision}\nModified, not saved`,
            '1 ms',
            before
        );

        meta.querySelector('[aria-label="Revert this Assistant edit"]').click();

        expect(editor.getValue()).toBe(before);
        expect(meta.textContent).toContain(
            'Assistant edit reverted, not saved.'
        );
    });
});
