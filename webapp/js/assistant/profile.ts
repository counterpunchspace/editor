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
    /**
     * The edit rule. `editToggle` is the session's own edit switch
     * (`AssistantChatSession.allowEdits`); profiles without a switch ignore it.
     */
    editPermissions(editToggle: boolean): AssistantEditPermissions;
    /** Completes "… before changing Python code." when document edits are off. */
    readonly editDisabledHint: string;
    buildSystemPrompt(context: AssistantSystemPromptContext): Promise<string>;
}

const STALE_SCRIPT_NOTICE =
    '\n\nSCRIPT STATE NOTICE: The Script Editor changed after the Assistant last read it. The buffer is authoritative; read the active Python document before proposing or applying another script edit.';

export const MAIN_ASSISTANT_PROFILE: AssistantProfile = {
    id: 'assistant',
    tools: ASSISTANT_TOOLS,
    editPermissions: (editToggle) => ({
        fontEdits: editToggle,
        documentEdits: editToggle
    }),
    editDisabledHint: 'Enable editing in the Assistant title bar',
    async buildSystemPrompt({ session, runTool }) {
        const editorState = await runTool('get_editor_state');
        const staleScriptNotice = session.isDocumentStale()
            ? STALE_SCRIPT_NOTICE
            : '';
        const editing = session.activePromptContext?.allowFontEdits
            ? 'allowed'
            : 'disabled';
        return `${ASSISTANT_SYSTEM_PROMPT}\n\nCURRENT PROMPT PERMISSION: Assistant editing is ${editing} for this prompt.${staleScriptNotice}\n\nCURRENT EDITOR STATE:\n${editorState}`;
    }
};
