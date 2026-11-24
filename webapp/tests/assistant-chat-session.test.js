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

const EDITOR_CONTEXT_LABEL = '[Editor context, not a user request]';

function sseResponse(events) {
    const encoder = new TextEncoder();
    const chunks = events.map((event) =>
        encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    );
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () =>
                    chunks.length
                        ? { done: false, value: chunks.shift() }
                        : { done: true, value: undefined }
            })
        }
    };
}

function errorResponse(status, error) {
    return { ok: false, status, json: async () => ({ error }) };
}

const toolCallEvent = (name = 'read_doc') => ({
    type: 'tool_call',
    tool_calls: [{ id: `call-${name}`, function: { name, arguments: '{}' } }]
});
const done = (extra = {}) => ({ type: 'done', usage: {}, ...extra });
const toolStep = (extra) => sseResponse([toolCallEvent(), done(extra)]);
const textStep = (text, extra) =>
    sseResponse([{ type: 'chunk', content: text }, done(extra)]);

/** A session whose rounds go through the real streamRound and a mocked fetch. */
function createFetchSession(responses) {
    let state = 0;
    const buildSystemPrompt = jest.fn(async () => 'system');
    const fetchProfile = {
        ...profile,
        buildSystemPrompt,
        buildContextMessage: async () => `editor state ${++state}`
    };
    const executeToolCall = jest.fn().mockResolvedValue('document text');
    const session = new AssistantChatSession({
        profile: fetchProfile,
        host: { executeToolCall },
        allowEdits: true
    });
    const requests = [];
    global.fetch = jest.fn(async (url, init) => {
        requests.push(JSON.parse(init.body));
        const next = responses.shift();
        return typeof next === 'function' ? next(session) : next;
    });
    return { session, requests, executeToolCall, buildSystemPrompt };
}

function abortedFetch(session) {
    session.stop();
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
}

describe('AssistantChatSession requests', () => {
    afterEach(() => {
        delete global.fetch;
    });

    test('sends the editor context last, outside the stored history', async () => {
        const { session, requests, buildSystemPrompt } = createFetchSession([
            toolStep(),
            textStep('Done.'),
            textStep('Again.')
        ]);
        await session.send('Change it');
        await session.send('Once more');

        expect(requests).toHaveLength(3);
        expect(new Set(requests.map((r) => r.systemPrompt))).toEqual(
            new Set(['system'])
        );
        expect(buildSystemPrompt).toHaveBeenCalledTimes(1);
        expect(requests.map((r) => r.messages.at(-1))).toEqual(
            [1, 2, 3].map((n) => ({
                role: 'user',
                content: `${EDITOR_CONTEXT_LABEL}\n\neditor state ${n}`
            }))
        );
        // Each request extends the previous one's history unchanged.
        for (let i = 1; i < requests.length; i++) {
            const previous = requests[i - 1].messages.slice(0, -1);
            expect(requests[i].messages.slice(0, previous.length)).toEqual(
                previous
            );
        }
        expect(JSON.stringify(session.conversationMessages)).not.toContain(
            EDITOR_CONTEXT_LABEL
        );
    });

    test('keeps the provider pin with the chat, outside the conversation', async () => {
        const { session, requests } = createFetchSession([
            toolStep({ providerPin: 'deepinfra/fp8' }),
            textStep('Done.'),
            textStep('Fallback answer.'),
            textStep('Later.', { providerPin: 'novita/fp8' })
        ]);
        await session.send('Change it');
        await session.send('Again');

        expect(requests.map((r) => r.providerPin)).toEqual([
            undefined,
            'deepinfra/fp8',
            // A done without a pin (the fallback served) keeps it.
            'deepinfra/fp8'
        ]);
        expect(session.providerPin).toBe('deepinfra/fp8');
        expect(JSON.stringify(session.conversationMessages)).not.toContain(
            'deepinfra'
        );

        const fork = session.fork();
        expect(fork.providerPin).toBe('deepinfra/fp8');
        await fork.send('In the fork');
        expect(requests[3].providerPin).toBe('deepinfra/fp8');
        expect(fork.providerPin).toBe('novita/fp8');
        expect(session.providerPin).toBe('deepinfra/fp8');

        session.reset();
        expect(session.providerPin).toBeNull();
    });

    test('retries 503 and 504 but not 429 or 502', async () => {
        const { session, requests } = createFetchSession([
            errorResponse(503, 'Upstream unavailable'),
            errorResponse(504, 'Gateway timeout'),
            textStep('Done.')
        ]);
        await expect(session.send('Hi')).resolves.toBe('done');
        expect(requests).toHaveLength(3);
        expect(session.conversationMessages.at(-1).content).toBe('Done.');

        for (const [status, error] of [
            [429, 'Rate limit exceeded'],
            // Also a bad provider key, after the server tried every model.
            [502, 'Invalid API key']
        ]) {
            const failed = createFetchSession([
                errorResponse(status, error),
                textStep('Never sent.')
            ]);
            await expect(failed.session.send('Hi')).resolves.toBe('error');
            expect(failed.requests).toHaveLength(1);
            expect(failed.session.transcript.at(-1)).toEqual({
                kind: 'error',
                text: error
            });
        }
    }, 10000);

    test('gives up after three retries', async () => {
        const { session, requests } = createFetchSession([
            errorResponse(503, 'Upstream unavailable'),
            errorResponse(503, 'Upstream unavailable'),
            errorResponse(503, 'Upstream unavailable'),
            errorResponse(503, 'Upstream unavailable')
        ]);
        await expect(session.send('Hi')).resolves.toBe('connection-lost');
        expect(requests).toHaveLength(4);
        expect(session.transcript.at(-1).items.at(-1)).toEqual({
            kind: 'notice',
            text: 'Connection lost after 3 retries (Upstream unavailable). Type “continue” to resume.'
        });
    }, 10000);

    test('retries a stream that ends without done, unless tool calls arrived', async () => {
        const { session, requests, executeToolCall } = createFetchSession([
            sseResponse([toolCallEvent()]),
            sseResponse([]),
            textStep('Done.')
        ]);
        await expect(session.send('Hi')).resolves.toBe('done');
        expect(requests).toHaveLength(3);
        expect(executeToolCall).toHaveBeenCalledTimes(1);
        expect(session.conversationMessages.map((m) => m.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
    });

    test('retries a step afresh after an error event, with the context last', async () => {
        const half = () =>
            sseResponse([
                {
                    type: 'chunk',
                    content: 'The glyph a has',
                    generationId: 'gen-1'
                },
                { type: 'error', error: 'Provider failed' }
            ]);
        const { session, requests } = createFetchSession([
            toolStep(),
            half(),
            half(),
            textStep('The glyph a has two contours.')
        ]);
        await expect(session.send('Hi')).resolves.toBe('done');
        expect(requests).toHaveLength(4);
        expect(requests[3].previousGenerationIds).toEqual(['gen-1', 'gen-1']);
        // Each retry repeats the step's request, with fresh editor context.
        for (const retry of requests.slice(2)) {
            expect(retry.messages.slice(0, -1)).toEqual(
                requests[1].messages.slice(0, -1)
            );
            expect(
                retry.messages.at(-1).content.startsWith(EDITOR_CONTEXT_LABEL)
            ).toBe(true);
        }
        expect(session.conversationMessages.map((m) => m.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        expect(session.conversationMessages.at(-1).content.trim()).toBe(
            'The glyph a has two contours.'
        );
        const texts = session.transcript
            .at(-1)
            .items.filter((item) => item.kind === 'text');
        expect(texts.map((item) => item.text)).toEqual([
            'The glyph a has two contours.'
        ]);
    }, 10000);

    test('keeps only the dropped step’s text when it gives up', async () => {
        const half = () =>
            sseResponse([
                { type: 'chunk', content: 'Partial' },
                { type: 'error', error: 'Provider failed' }
            ]);
        const { session } = createFetchSession([
            sseResponse([
                { type: 'chunk', content: 'Reading.' },
                toolCallEvent(),
                done()
            ]),
            half(),
            half(),
            half(),
            half()
        ]);
        await expect(session.send('Hi')).resolves.toBe('connection-lost');
        expect(session.conversationMessages).toEqual([
            { role: 'user', content: 'Hi' },
            expect.objectContaining({ role: 'assistant', content: 'Reading.' }),
            expect.objectContaining({ role: 'tool' }),
            { role: 'assistant', content: 'Partial' }
        ]);
    }, 10000);

    test.each([
        ['error', () => errorResponse(400, 'Bad request')],
        ['stopped', () => abortedFetch]
    ])(
        'a failed round 3 keeps the two finished rounds (%s)',
        async (reason, third) => {
            const { session } = createFetchSession([
                toolStep(),
                toolStep(),
                third()
            ]);
            await expect(session.send('Hi')).resolves.toBe(reason);
            expect(session.conversationMessages.map((m) => m.role)).toEqual([
                'user',
                'assistant',
                'tool',
                'assistant',
                'tool'
            ]);
        }
    );
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
