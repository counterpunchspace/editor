jest.mock('tippy.js', () => ({ __esModule: true, default: jest.fn() }));

const { AssistantChatSession } = require('../js/assistant/chat-session.ts');
const { AssistantChatView } = require('../js/assistant/chat-view.ts');

const profile = {
    id: 'test',
    tools: [
        {
            type: 'function',
            function: { name: 'read_doc', description: '', parameters: {} }
        }
    ],
    editPermissions: (toggle) => ({ fontEdits: false, documentEdits: toggle }),
    editDisabledHint: 'Turn editing on',
    buildSystemPrompt: async () => 'system'
};

function toolRound(name) {
    return {
        text: '',
        toolCalls: [
            { id: `call-${name}`, function: { name, arguments: '{}' } }
        ],
        done: true
    };
}

function createSession(rounds) {
    const executeToolCall = jest.fn().mockResolvedValue('document text');
    const streamRound = jest.fn(async (messages, onChunk) => {
        const round = rounds.shift();
        if (round.text) onChunk(round.text);
        return round;
    });
    const session = new AssistantChatSession({
        profile,
        host: { executeToolCall, streamRound },
        allowEdits: true
    });
    return { session, executeToolCall, streamRound };
}

describe('AssistantChatSession', () => {
    test('runs tools from its profile only and commits the turn', async () => {
        const { session, executeToolCall } = createSession([
            toolRound('read_doc'),
            toolRound('execute_python_code'),
            { text: 'Done.', toolCalls: null, done: true }
        ]);
        const finished = jest.fn();
        session.on('turn-finished', finished);

        await expect(session.send('Change it')).resolves.toBe('done');

        expect(executeToolCall).toHaveBeenCalledTimes(1);
        expect(executeToolCall.mock.calls[0][0].function.name).toBe('read_doc');
        const toolMessages = session.conversationMessages.filter(
            (message) => message.role === 'tool'
        );
        expect(toolMessages.map((message) => message.content)).toEqual([
            'document text',
            'Error: Unknown tool: execute_python_code'
        ]);
        // The final message joins every round's text, as the panel always did.
        const finalMessage = session.conversationMessages.at(-1);
        expect(finalMessage.role).toBe('assistant');
        expect(finalMessage.content.trim()).toBe('Done.');
        expect(finished).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'done' })
        );
        expect(session.isStreaming).toBe(false);
        expect(session.activePromptContext).toBeNull();
    });

    test('fork copies the conversation independently', async () => {
        const { session } = createSession([
            { text: 'Hello.', toolCalls: null, done: true }
        ]);
        await session.send('Hi');
        const fork = session.fork();

        fork.conversationMessages.push({ role: 'user', content: 'More' });
        fork.transcript[0].text = 'Changed';

        expect(session.conversationMessages).toHaveLength(2);
        expect(session.transcript[0].text).toBe('Hi');
        expect(fork.allowEdits).toBe(true);
        expect(fork.profile).toBe(profile);
    });
});

describe('AssistantChatView', () => {
    test('renders automatic messages, tool lines and errors without emoji', async () => {
        const { session, streamRound } = createSession([
            toolRound('read_doc'),
            { text: 'Updated.', toolCalls: null, done: true }
        ]);
        const root = document.createElement('div');
        const view = new AssistantChatView(root, session);

        await session.send('Sync the description', { automatic: true });
        streamRound.mockRejectedValueOnce(new Error('Quota exceeded'));
        await session.send('Again');

        expect(root.classList.contains('assistant-chat')).toBe(true);
        const automatic = root.querySelector('.assistant-message-automatic');
        expect(automatic.textContent).toContain('Sent automatically');
        expect(
            root.querySelector('.assistant-tool-call-line').textContent
        ).toBe('Calling read_docⓘ');
        expect(
            root.querySelector('.assistant-message-error').textContent
        ).toContain('Quota exceeded');
        expect(root.querySelector('.assistant-thinking')).toBeNull();

        const replay = document.createElement('div');
        new AssistantChatView(replay, session.fork());
        expect(replay.innerHTML).toBe(root.innerHTML);
        view.dispose();
    });
});
