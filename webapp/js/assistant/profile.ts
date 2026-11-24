// What a chat session is for: its system prompt, its tools and what it may
// edit. The main Assistant panel uses MAIN_ASSISTANT_PROFILE; other chats
// (the glyph filter editor) define their own.

import {
    ASSISTANT_SYSTEM_PROMPT,
    ASSISTANT_TOOLS,
    type AssistantTool
} from '../assistant-config';
import type { AssistantChatSession } from './chat-session';

export type AssistantEditPermissions = {
    /** Font data may change (execute_python_code edits, font tools). */
    fontEdits: boolean;
    /** The session's Python document may change. */
    documentEdits: boolean;
};

export type AssistantSystemPromptContext = {
    session: AssistantChatSession;
    /** Run one of the host's tools, e.g. `get_editor_state`. */
    runTool(name: string, args?: Record<string, unknown>): Promise<string>;
};

export interface AssistantProfile {
    readonly id: string;
    /** Sent to the model, and the only tools the session will run. */
    readonly tools: AssistantTool[];
    /** The tools as sent for one round, e.g. with session details in a description. Same names as `tools`. */
    toolsFor?(session: AssistantChatSession): AssistantTool[];
    /**
     * The edit rule. `editToggle` is the session's own edit switch
     * (`AssistantChatSession.allowEdits`); profiles without a switch ignore it.
     */
    editPermissions(editToggle: boolean): AssistantEditPermissions;
    /** Completes "… before changing Python code." when document edits are off. */
    readonly editDisabledHint: string;
    /**
     * The same text every round of a chat, so the provider can cache it
     * together with the history behind it. Per-round state belongs in
     * `buildContextMessage`.
     */
    buildSystemPrompt(context: AssistantSystemPromptContext): Promise<string>;
    /**
     * Editor state for this round. The session sends it as the last user
     * message of the request, after EDITOR_CONTEXT_LABEL, and never stores it
     * in the conversation.
     */
    buildContextMessage?(
        context: AssistantSystemPromptContext
    ): Promise<string | null>;
}

/** Starts the per-round context message, so the model never reads it as the user’s words. */
export const EDITOR_CONTEXT_LABEL = '[Editor context, not a user request]';

const STALE_SCRIPT_NOTICE =
    'SCRIPT STATE NOTICE: The Script Editor changed after the Assistant last read it. The buffer is authoritative; read the active Python document before proposing or applying another script edit.';

export const MAIN_ASSISTANT_PROFILE: AssistantProfile = {
    id: 'assistant',
    tools: ASSISTANT_TOOLS,
    editPermissions: (editToggle) => ({
        fontEdits: editToggle,
        documentEdits: editToggle
    }),
    editDisabledHint: 'Enable editing in the Assistant title bar',
    async buildSystemPrompt() {
        return ASSISTANT_SYSTEM_PROMPT;
    },
    async buildContextMessage({ session, runTool }) {
        const editorState = await runTool('get_editor_state');
        const editing = session.activePromptContext?.allowFontEdits
            ? 'allowed'
            : 'disabled';
        const parts = [
            `CURRENT PROMPT PERMISSION: Assistant editing is ${editing} for this prompt.`
        ];
        if (session.isDocumentStale()) parts.push(STALE_SCRIPT_NOTICE);
        parts.push(`CURRENT EDITOR STATE:\n${editorState}`);
        return parts.join('\n\n');
    }
};
