// One Assistant conversation: the model messages, the visible transcript,
// the streaming multi-round tool loop, reconnects, abort and usage totals.
// No DOM: AssistantChatView renders a session from its transcript and events.

import { resolveWebsiteURL } from '../website-url';
import { Logger } from '../logger';
import type { UsageMetrics } from '../assistant-config';
import type { AssistantPromptExecutionContext } from '../assistant-execution-context';
import type { AssistantEditPermissions, AssistantProfile } from './profile';
import type {
    PythonDocumentState,
    PythonDocumentTarget
} from './python-target';

const console = new Logger('AssistantChat');

export const DEFAULT_PROMPT_HISTORY_SUMMARY = 'Assistant changes';
const MAX_RECONNECT_ATTEMPTS = 3;

export type AssistantToolCall = {
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
};

/** A message in the OpenAI-style conversation sent to /api/ai/assistant. */
export type AssistantChatMessage = {
    role: 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: AssistantToolCall[];
    tool_call_id?: string;
    name?: string;
};

export type AssistantRoundResult = {
    text: string;
    toolCalls: AssistantToolCall[] | null;
    done: boolean;
    usage?: UsageMetrics;
    cumulativeUsage?: UsageMetrics;
    generationId?: string | null;
    connectionDropped?: boolean;
    dropError?: string;
};

export type AssistantRoundStreamer = (
    messages: AssistantChatMessage[],
    onChunk: (text: string) => void,
    billingRunId: string,
    signal?: AbortSignal,
    previousGenerationIds?: string[]
) => Promise<AssistantRoundResult>;

export interface AssistantChatHost {
    /** Run one tool call for `session`. Only called for tools in the profile. */
    executeToolCall(
        toolCall: AssistantToolCall,
        session: AssistantChatSession
    ): Promise<string>;
    /** Replaces the network round, e.g. for tests. Defaults to `session.streamRound`. */
    streamRound?: AssistantRoundStreamer;
}

export type ChatToolCallRecord = {
    id: string | null;
    name: string;
    args: Record<string, unknown>;
    /** null while the tool runs. */
    result: string | null;
    failed: boolean;
    timeLabel: string | null;
};

export type ChatTurnItem =
    | { kind: 'text'; round: number; text: string; usage?: UsageMetrics }
    | { kind: 'tool'; call: ChatToolCallRecord }
    | { kind: 'notice'; text: string };

export type ChatUserEntry = { kind: 'user'; text: string; automatic: boolean };
export type ChatAssistantEntry = { kind: 'assistant'; items: ChatTurnItem[] };
export type ChatErrorEntry = { kind: 'error'; text: string };
export type ChatTranscriptEntry =
    ChatUserEntry | ChatAssistantEntry | ChatErrorEntry;

export type AssistantTurnEndReason =
    'done' | 'stopped' | 'error' | 'connection-lost';

export type AssistantChatEventMap = {
    /** A user, assistant or error entry was appended to the transcript. */
    'entry-added': { entry: ChatTranscriptEntry };
    /** Streaming text, a tool call starting, or a notice inside a turn. */
    'item-added': { entry: ChatAssistantEntry; item: ChatTurnItem };
    /** Text grew, a tool call finished, or round usage arrived. */
    'item-updated': { entry: ChatAssistantEntry; item: ChatTurnItem };
    /** Transient status under the transcript; null clears it. */
    'status': { text: string | null };
    'streaming-changed': { streaming: boolean };
    'usage': { totals: UsageMetrics };
    'turn-finished': {
        reason: AssistantTurnEndReason;
        toolCalls: ChatToolCallRecord[];
    };
    /** The transcript was cleared (new chat). */
    'reset': Record<string, never>;
};

type Listener<K extends keyof AssistantChatEventMap> = (
    event: AssistantChatEventMap[K]
) => void;

export type AssistantChatSessionOptions = {
    profile: AssistantProfile;
    host: AssistantChatHost;
    target?: PythonDocumentTarget | null;
    /** Initial state of the session's edit toggle. */
    allowEdits?: boolean;
};

type SessionSnapshot = {
    messages: Array<{ role: string; content: string }>;
    conversationMessages: AssistantChatMessage[];
    transcript: ChatTranscriptEntry[];
    sessionTotals: UsageMetrics;
};

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/**
 * Turn an error body from /api/ai/assistant into readable text. `error` may
 * be a string or an OpenRouter-style `{ message, code }` object.
 */
export function assistantErrorMessage(
    body: unknown,
    status?: number,
    fallback = 'Request failed'
): string {
    const record =
        body && typeof body === 'object'
            ? (body as Record<string, unknown>)
            : {};
    const err = record.error;
    if (typeof err === 'string' && err) return err;
    if (err && typeof err === 'object') {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === 'string' && message) return message;
    }
    if (typeof record.message === 'string' && record.message)
        return record.message;
    return status ? `${fallback} (HTTP ${status})` : fallback;
}

function addUsage(totals: UsageMetrics, usage: UsageMetrics): void {
    totals.prompt_tokens =
        (totals.prompt_tokens || 0) + (usage.prompt_tokens || 0);
    totals.completion_tokens =
        (totals.completion_tokens || 0) + (usage.completion_tokens || 0);
    totals.cached_tokens =
        (totals.cached_tokens || 0) + (usage.cached_tokens || 0);
    totals.total_cost = (totals.total_cost || 0) + (usage.total_cost || 0);
    totals.cost_eur_cents =
        (totals.cost_eur_cents || 0) + (usage.cost_eur_cents || 0);
}

export class AssistantChatSession {
    readonly profile: AssistantProfile;
    readonly host: AssistantChatHost;
    readonly target: PythonDocumentTarget | null;

    /** The session's edit toggle; the profile turns it into permissions. */
    allowEdits: boolean;
    /** Final assistant replies, for memory accounting. */
    messages: Array<{ role: string; content: string }> = [];
    /** The committed model conversation (updated when a turn ends). */
    conversationMessages: AssistantChatMessage[] = [];
    /** What the chat shows, including the running turn. */
    transcript: ChatTranscriptEntry[] = [];
    sessionTotals: UsageMetrics = {};
    /** Set while a turn runs; tools read the frozen permission from it. */
    activePromptContext: AssistantPromptExecutionContext | null = null;
    /** Revision of the target the model last read or wrote. */
    lastKnownDocumentRevision: string | null = null;
    /** The target changed after the model last read it. */
    documentStateInvalidated = false;

    private streaming = false;
    /** Bumped by reset() so a turn stopped by New Chat cannot write back. */
    private generation = 0;
    private controller: AbortController | null = null;
    private reconnectAttempts = 0;
    private promptPermissions: AssistantEditPermissions | null = null;
    private statusText: string | null = null;
    private readonly listeners = new Map<
        keyof AssistantChatEventMap,
        Set<(event: never) => void>
    >();
    private readonly unsubscribeTarget: (() => void) | null;

    constructor(options: AssistantChatSessionOptions) {
        this.profile = options.profile;
        this.host = options.host;
        this.target = options.target ?? null;
        this.allowEdits = options.allowEdits ?? false;
        this.unsubscribeTarget =
            this.target?.onDidChange((state) =>
                this.noteDocumentRevision(state.revision)
            ) ?? null;
    }

    get isStreaming(): boolean {
        return this.streaming;
    }

    get abortController(): AbortController | null {
        return this.controller;
    }

    get status(): string | null {
        return this.statusText;
    }

    on<K extends keyof AssistantChatEventMap>(
        type: K,
        listener: Listener<K>
    ): () => void {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(listener as (event: never) => void);
        return () => set!.delete(listener as (event: never) => void);
    }

    private emit<K extends keyof AssistantChatEventMap>(
        type: K,
        event: AssistantChatEventMap[K]
    ): void {
        this.listeners.get(type)?.forEach((listener) => {
            try {
                (listener as Listener<K>)(event);
            } catch (error) {
                console.error(`Chat listener for ${type} failed:`, error);
            }
        });
    }

    // ── Permissions and the Python document ──

    /** Permissions from the edit toggle right now (manual tool runs, revert). */
    editPermissions(): AssistantEditPermissions {
        return this.profile.editPermissions(this.allowEdits);
    }

    /** Whether the running prompt may edit the Python document. */
    promptAllowsDocumentEdits(): boolean {
        const context = this.activePromptContext;
        if (!context) return false;
        return this.promptPermissions?.documentEdits ?? context.allowFontEdits;
    }

    /** Record that the model has seen (or written) this revision. */
    markDocumentRead(revision: string): void {
        this.lastKnownDocumentRevision = revision;
        this.documentStateInvalidated = false;
    }

    private noteDocumentRevision(revision: string): void {
        if (
            this.lastKnownDocumentRevision &&
            revision !== this.lastKnownDocumentRevision
        ) {
            this.documentStateInvalidated = true;
        }
    }

    /** True when the target changed after the model last read it. */
    isDocumentStale(): boolean {
        let state: PythonDocumentState | null = null;
        try {
            state = this.target?.getDocumentState() ?? null;
        } catch {
            state = null;
        }
        if (state) this.noteDocumentRevision(state.revision);
        return this.documentStateInvalidated;
    }

    // ── Transcript ──

    appendEntry(entry: ChatTranscriptEntry): void {
        this.transcript.push(entry);
        this.emit('entry-added', { entry });
    }

    setStatus(text: string | null): void {
        if (this.statusText === text) return;
        this.statusText = text;
        this.emit('status', { text });
    }

    private addItem(entry: ChatAssistantEntry, item: ChatTurnItem): void {
        entry.items.push(item);
        this.emit('item-added', { entry, item });
    }

    // ── Turns ──

    /**
     * Send a user message and run the turn until the model stops calling
     * tools. `automatic` marks messages the app sent on the user's behalf.
     * Resolves when the turn has ended; does nothing while a turn runs.
     */
    async send(
        text: string,
        options: { automatic?: boolean } = {}
    ): Promise<AssistantTurnEndReason | null> {
        const prompt = text.trim();
        if (!prompt || this.streaming) return null;

        const permissions = this.editPermissions();
        this.promptPermissions = permissions;
        this.activePromptContext = {
            id: `assistant-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            allowFontEdits: permissions.fontEdits,
            historySummary: DEFAULT_PROMPT_HISTORY_SUMMARY
        };
        this.setStreaming(true);

        this.appendEntry({
            kind: 'user',
            text: prompt,
            automatic: options.automatic === true
        });
        const conversationMessages: AssistantChatMessage[] = [
            ...this.conversationMessages,
            { role: 'user', content: prompt }
        ];
        this.setStatus('Understanding your question...');

        const controller = new AbortController();
        this.controller = controller;
        const roundTexts: string[] = [];
        const billingRunId = `assistant-billing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Generation IDs of dropped legs, for cumulative cost on the retry.
        const previousGenerationIds: string[] = [];
        const executedToolCalls: ChatToolCallRecord[] = [];
        let entry: ChatAssistantEntry | null = null;
        const ensureEntry = (): ChatAssistantEntry => {
            if (!entry) {
                entry = { kind: 'assistant', items: [] };
                this.appendEntry(entry);
            }
            return entry;
        };
        const streamRound: AssistantRoundStreamer =
            this.host.streamRound ?? this.streamRound.bind(this);
        const generation = this.generation;
        const commit = (finalText?: string) => {
            if (generation !== this.generation) return;
            this.conversationMessages = conversationMessages;
            if (finalText !== undefined) {
                this.messages.push({ role: 'assistant', content: finalText });
            }
        };

        let reason: AssistantTurnEndReason = 'done';
        try {
            let round = -1;
            while (true) {
                round++;
                const currentRound = round;
                const result = await streamRound(
                    conversationMessages,
                    (chunk) => {
                        this.setStatus(null);
                        const turn = ensureEntry();
                        roundTexts[currentRound] =
                            (roundTexts[currentRound] || '') + chunk;
                        const last = turn.items[turn.items.length - 1];
                        if (
                            last?.kind === 'text' &&
                            last.round === currentRound &&
                            !last.usage
                        ) {
                            last.text = roundTexts[currentRound];
                            this.emit('item-updated', {
                                entry: turn,
                                item: last
                            });
                        } else {
                            this.addItem(turn, {
                                kind: 'text',
                                round: currentRound,
                                text: roundTexts[currentRound]
                            });
                        }
                    },
                    billingRunId,
                    controller.signal,
                    previousGenerationIds.length > 0
                        ? [...previousGenerationIds]
                        : undefined
                );

                this.reconnectAttempts = 0;
                this.recordRoundUsage(result, previousGenerationIds);
                if (entry && result.usage) {
                    const turn: ChatAssistantEntry = entry;
                    const last = turn.items[turn.items.length - 1];
                    if (last?.kind === 'text' && last.round === currentRound) {
                        last.usage = result.usage;
                        this.emit('item-updated', { entry: turn, item: last });
                    }
                }

                if (result.connectionDropped) {
                    const partialText =
                        roundTexts.filter(Boolean).join(' ').trim() ||
                        result.text ||
                        '';
                    if (partialText) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: partialText
                        });
                        commit();
                    }
                    if (result.generationId) {
                        previousGenerationIds.push(result.generationId);
                    }
                    this.reconnectAttempts++;
                    if (this.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        this.setStatus(
                            `Reconnecting... (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
                        );
                        await new Promise((resolve) =>
                            setTimeout(resolve, 500 * this.reconnectAttempts)
                        );
                        this.setStatus(null);
                        // Retry the same round; the conversation now ends
                        // with the partial reply, so the model continues it.
                        round--;
                        continue;
                    }
                    this.addItem(ensureEntry(), {
                        kind: 'notice',
                        text: `Connection lost after ${MAX_RECONNECT_ATTEMPTS} retries. Type "continue" to resume.`
                    });
                    reason = 'connection-lost';
                    break;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    const turn = ensureEntry();
                    conversationMessages.push({
                        role: 'assistant',
                        content: result.text || null,
                        tool_calls: result.toolCalls
                    });
                    for (const toolCall of result.toolCalls) {
                        const record: ChatToolCallRecord = {
                            id: toolCall.id ?? null,
                            name: toolCall.function.name,
                            args: parseToolArguments(
                                toolCall.function.arguments
                            ),
                            result: null,
                            failed: false,
                            timeLabel: null
                        };
                        const item: ChatTurnItem = {
                            kind: 'tool',
                            call: record
                        };
                        this.addItem(turn, item);
                        let toolResult: string;
                        try {
                            toolResult = await this.runToolCall(toolCall);
                        } catch (error) {
                            toolResult = `Error: ${errorMessage(error, String(error))}`;
                            record.failed = true;
                        }
                        record.result = toolResult;
                        record.timeLabel = new Date().toLocaleTimeString();
                        executedToolCalls.push(record);
                        this.emit('item-updated', { entry: turn, item });
                        conversationMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResult
                        });
                    }
                    continue;
                }

                const finalText = roundTexts.join(' ') || result.text || '';
                conversationMessages.push({
                    role: 'assistant',
                    content: finalText
                });
                commit(finalText);
                break;
            }
        } catch (error) {
            this.setStatus(null);
            if (isAbortError(error)) {
                // Keep what streamed so "continue" can pick it up.
                const partialText = roundTexts.filter(Boolean).join(' ').trim();
                if (partialText) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: partialText
                    });
                    commit();
                }
                reason = 'stopped';
            } else {
                this.appendEntry({
                    kind: 'error',
                    text: errorMessage(error, 'Network error')
                });
                console.error('Request failed:', error);
                reason = 'error';
            }
        }

        this.setStatus(null);
        this.controller = null;
        this.activePromptContext = null;
        this.promptPermissions = null;
        this.setStreaming(false);
        this.emit('turn-finished', { reason, toolCalls: executedToolCalls });
        return reason;
    }

    /** Abort the running turn. Text streamed so far is kept. */
    stop(): void {
        if (!this.streaming) return;
        this.controller?.abort();
        this.controller = null;
    }

    /** Stop and forget the conversation (New Chat). */
    reset(): void {
        this.stop();
        this.generation++;
        this.messages = [];
        this.conversationMessages = [];
        this.transcript = [];
        this.sessionTotals = {};
        this.reconnectAttempts = 0;
        this.setStatus(null);
        this.emit('reset', {});
        this.emit('usage', { totals: this.sessionTotals });
    }

    /**
     * An independent copy of the conversation, transcript and edit state,
     * e.g. for a dialog that can be cancelled. Listeners are not copied.
     */
    fork(
        overrides: {
            target?: PythonDocumentTarget | null;
            host?: AssistantChatHost;
        } = {}
    ): AssistantChatSession {
        if (this.streaming) {
            throw new Error(
                'Cannot fork a chat while the Assistant is working.'
            );
        }
        const copy = new AssistantChatSession({
            profile: this.profile,
            host: overrides.host ?? this.host,
            target:
                overrides.target !== undefined ? overrides.target : this.target,
            allowEdits: this.allowEdits
        });
        const snapshot: SessionSnapshot = JSON.parse(
            JSON.stringify({
                messages: this.messages,
                conversationMessages: this.conversationMessages,
                transcript: this.transcript,
                sessionTotals: this.sessionTotals
            } satisfies SessionSnapshot)
        );
        copy.messages = snapshot.messages;
        copy.conversationMessages = snapshot.conversationMessages;
        copy.transcript = snapshot.transcript;
        copy.sessionTotals = snapshot.sessionTotals;
        copy.lastKnownDocumentRevision = this.lastKnownDocumentRevision;
        copy.documentStateInvalidated = this.documentStateInvalidated;
        return copy;
    }

    /** Stop any turn and detach from the target. */
    dispose(): void {
        this.stop();
        this.unsubscribeTarget?.();
        this.listeners.clear();
    }

    private setStreaming(streaming: boolean): void {
        this.streaming = streaming;
        this.emit('streaming-changed', { streaming });
    }

    /** Run a tool the profile offers; anything else is refused. */
    private runToolCall(toolCall: AssistantToolCall): Promise<string> {
        const name = toolCall.function.name;
        if (!this.profile.tools.some((tool) => tool.function.name === name)) {
            return Promise.reject(new Error(`Unknown tool: ${name}`));
        }
        return this.host.executeToolCall(toolCall, this);
    }

    /**
     * On retry legs the server reports cumulativeUsage over every dropped leg
     * plus this one; add the dropped part separately so nothing is counted twice.
     */
    private recordRoundUsage(
        result: AssistantRoundResult,
        previousGenerationIds: string[]
    ): void {
        const roundUsage = result.usage;
        const cumulative = result.cumulativeUsage;
        if (cumulative && roundUsage) {
            const droppedPrompt =
                (cumulative.prompt_tokens || 0) -
                (roundUsage.prompt_tokens || 0);
            const droppedCompletion =
                (cumulative.completion_tokens || 0) -
                (roundUsage.completion_tokens || 0);
            if (droppedPrompt > 0 || droppedCompletion > 0) {
                addUsage(this.sessionTotals, {
                    prompt_tokens: droppedPrompt,
                    completion_tokens: droppedCompletion,
                    total_tokens: droppedPrompt + droppedCompletion,
                    cached_tokens:
                        (cumulative.cached_tokens || 0) -
                        (roundUsage.cached_tokens || 0),
                    total_cost:
                        (cumulative.total_cost || 0) -
                        (roundUsage.total_cost || 0)
                });
            }
            addUsage(this.sessionTotals, roundUsage);
            previousGenerationIds.length = 0;
        } else if (roundUsage) {
            addUsage(this.sessionTotals, roundUsage);
        }
        this.emit('usage', { totals: this.sessionTotals });
    }

    // ── One streaming round against /api/ai/assistant ──

    async streamRound(
        messages: AssistantChatMessage[],
        onChunk: (text: string) => void,
        billingRunId: string,
        signal?: AbortSignal,
        previousGenerationIds?: string[]
    ): Promise<AssistantRoundResult> {
        const sessionToken = window.authManager?.getSessionToken();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

        const systemPrompt = await this.profile.buildSystemPrompt({
            session: this,
            runTool: (name, args = {}) =>
                this.host.executeToolCall(
                    { function: { name, arguments: JSON.stringify(args) } },
                    this
                )
        });
        const body: Record<string, unknown> = {
            messages,
            tools: this.profile.tools,
            systemPrompt,
            stream: true,
            billingRunId
        };
        if (previousGenerationIds && previousGenerationIds.length > 0) {
            body.previousGenerationIds = previousGenerationIds;
        }

        let response: Response;
        try {
            response = await fetch(`${resolveWebsiteURL()}/api/ai/assistant`, {
                method: 'POST',
                credentials: 'include',
                headers,
                signal,
                body: JSON.stringify(body)
            });
        } catch (error) {
            // The stop button relies on AbortError reaching send().
            if (isAbortError(error)) throw error;
            return {
                text: '',
                toolCalls: null,
                done: false,
                connectionDropped: true,
                dropError: errorMessage(error, 'Network request failed')
            };
        }

        if (!response.ok) {
            const errBody: unknown = await response
                .json()
                .catch(() => ({ error: 'Request failed' }));
            throw new Error(assistantErrorMessage(errBody, response.status));
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');

        const decoder = new TextDecoder();
        let buf = '';
        let streamedText = '';
        let toolCalls: AssistantToolCall[] | null = null;
        let generationId: string | null = null;

        while (true) {
            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
                readResult = await reader.read();
            } catch (error) {
                if (isAbortError(error)) throw error;
                // Dropped mid-stream: return the partial text so send()
                // can retry and the model continues from it.
                return {
                    text: streamedText,
                    toolCalls,
                    done: false,
                    connectionDropped: true,
                    dropError: errorMessage(error, 'Connection lost'),
                    generationId
                };
            }
            const { done, value } = readResult;
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                let parsed: Record<string, unknown>;
                try {
                    const value: unknown = JSON.parse(trimmed.slice(6));
                    if (!value || typeof value !== 'object') continue;
                    parsed = value as Record<string, unknown>;
                } catch {
                    continue;
                }
                if (typeof parsed.generationId === 'string') {
                    generationId = parsed.generationId;
                }
                if (
                    parsed.type === 'chunk' &&
                    typeof parsed.content === 'string' &&
                    parsed.content
                ) {
                    streamedText += parsed.content;
                    onChunk(parsed.content);
                } else if (
                    parsed.type === 'tool_call' &&
                    Array.isArray(parsed.tool_calls)
                ) {
                    toolCalls = parsed.tool_calls as AssistantToolCall[];
                } else if (parsed.type === 'done') {
                    return {
                        text: streamedText,
                        toolCalls,
                        usage: parsed.usage as UsageMetrics | undefined,
                        generationId,
                        cumulativeUsage: parsed.cumulativeUsage as
                            UsageMetrics | undefined,
                        done: true
                    };
                } else if (parsed.type === 'error') {
                    throw new Error(
                        assistantErrorMessage(parsed, undefined, 'Stream error')
                    );
                }
            }
        }
        return { text: streamedText, toolCalls, done: false, generationId };
    }
}
