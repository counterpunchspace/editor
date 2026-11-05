// The glyph filter editor's chat: a profile with filter-only tools, a host that
// adds the dry-run tool, the messages the modal sends on the user's behalf, and
// a registry that keeps each filter's applied chat for the browser session.

import { ASSISTANT_TOOLS, type AssistantTool } from './assistant-config';
import {
    AssistantChatSession,
    type AssistantChatHost,
    type AssistantToolCall
} from './assistant/chat-session';
import type { AssistantProfile } from './assistant/profile';
import type { PythonDocumentTarget } from './assistant/python-target';
import { readFilterDescription } from './glyph-filter-description';
import type { GlyphFilterPreviewResult } from './glyph-overview-filters';

/** Tools from the main Assistant that a filter chat may use. */
const SHARED_FILTER_TOOL_NAMES = [
    'handbook_toc',
    'handbook_topic',
    'python_api_docs',
    'execute_python_code',
    'get_active_python_document',
    'python_authoring_guide',
    'glyph_filter_event_types',
    'replace_python_text_in_editor',
    'validate_python_document'
] as const;

const TEST_FILTER_TOOL: AssistantTool = {
    type: 'function',
    function: {
        name: 'test_filter_on_font',
        description:
            'Dry-run the current filter document on the open font without saving or activating it. Returns whether it ran, the number of matching glyphs, the groups with their colors and counts, up to 30 sample glyph names, and any errors. Call this after validate_python_document succeeds, and use the result in your short reply to the user.',
        parameters: { type: 'object', properties: {}, required: [] }
    }
};

const NAME_FILTER_TOOL: AssistantTool = {
    type: 'function',
    function: {
        name: 'name_filter',
        description:
            'Give the filter a new file name. Call this when the current name is a default such as New Filter or New Filter 2, or when your change makes the current name no longer describe what the filter shows. Do not call it for small adjustments. The name is 1 to 4 words in Title Case, without .py, for example Small Caps or Missing Unicode. The result says whether the name was used; a name the user chose is kept.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        }
    }
};

export const FILTER_CHAT_TOOLS: AssistantTool[] = [
    ...ASSISTANT_TOOLS.filter((tool) =>
        (SHARED_FILTER_TOOL_NAMES as readonly string[]).includes(
            tool.function.name
        )
    ),
    TEST_FILTER_TOOL,
    NAME_FILTER_TOOL
];

const FILTER_SYSTEM_PROMPT = `You are the Assistant inside the glyph filter editor of Counterpunch, a browser-based font editor.

You work on exactly one document: the glyph filter file open in this editor's code pane. get_active_python_document, replace_python_text_in_editor and validate_python_document read and edit that document, not the Script Editor. Nothing is saved until the user presses OK. You may never change the font: use execute_python_code only to inspect it.

A glyph filter decides which glyphs the Glyph Overview shows. Use the simple filter shape only: a literal EVENT_TYPES list, optional is_candidate(glyph), and required classify_glyph(glyph). classify_glyph returns False to hide a glyph, True to show it without groups, or {'groups': [{'name': 'Visible group name', 'color': 'CSS color'}]} to show it in one or more groups. Do not write filter_glyphs, apply_changes, GROUPS, glyph_name, cache code, lifecycle event subscriptions, or font.masters.changed. The app handles glyph creation, deletion, renaming, caching and group cleanup. Subscribe only to glyph-content events that can change the classification (a filter that only reads glyph names uses EVENT_TYPES = []); call glyph_filter_event_types before authoring a filter, and python_api_docs before using unfamiliar model APIs.

The module docstring is the filter's description, in the user's words: what the filter shows and how it sorts glyphs into groups. It describes rules, not their results. When the code creates groups or colors itself (one group per script, random colors), describe the rule and never list the groups or colors it produces. Name groups and colors only when the user chose them.

Keep the description in sync with the code:
- When the user updated the description, the docstring already holds their exact words. Change the code to match it and leave the docstring as it is.
- When you change what the filter shows or how it groups glyphs for any other reason, update the docstring in the same turn.
- When asked to update the description to match the code, change only the docstring.
When you update the description, change only what your edit made untrue, and add only what the user just asked for. Keep everything else word for word, and keep it about as concise or verbose as it was. A small change to the filter is a small change to the description.

Example: the description "Show glyphs that are not exported and glyphs without Unicode, each kind in its own group, in random colors." stays that way after an unrelated code change. Never expand it to "…: Not exported (teal), No Unicode (orange)".

Use names and CSS colors the description asks for. When it asks for random colors, pick distinct, readable named CSS colors.

The file name is how the user finds the filter in the sidebar. When it is a default such as New Filter, or your change makes it wrong, call name_filter with a short descriptive name in the same turn.

Edit with replace_python_text_in_editor using the fresh revision from get_active_python_document. After every edit, call validate_python_document, then test_filter_on_font. Reply in one or two short sentences: what changed and what the filter now finds. No emoji, no code in the reply unless asked.

If a request is not about this glyph filter, the font, or how to use Counterpunch, politely decline and say what you can help with.`;

/**
 * The filter chat profile. It reads the description and file from the
 * session's document on every turn, so forks and renames need no update.
 */
export const FILTER_CHAT_PROFILE: AssistantProfile = {
    id: 'glyph-filter',
    tools: FILTER_CHAT_TOOLS,
    editPermissions: () => ({ fontEdits: false, documentEdits: true }),
    editDisabledHint: '',
    async buildSystemPrompt({ session }) {
        const state = session.target?.getDocumentState();
        const description = state ? readFilterDescription(state.content) : '';
        const file = state?.path ? `\n\nFILTER FILE: ${state.path}` : '';
        const stale = session.isDocumentStale()
            ? '\n\nDOCUMENT NOTICE: The filter document changed after you last read it. Read it again before editing.'
            : '';
        return `${FILTER_SYSTEM_PROMPT}${file}\n\nCURRENT DESCRIPTION:\n${description || '(empty)'}${stale}`;
    }
};

/** “text” followed by a full stop, unless the text already ends a sentence. */
function quoted(text: string): string {
    return /[.!?…]$/.test(text) ? `“${text}”` : `“${text}”.`;
}

/** Messages the modal sends for the user (shown as "Sent automatically"). */
export const filterChatMessages = {
    descriptionUpdated: (from: string, to: string): string =>
        `The user updated the filter description from “${from}” to ${quoted(to)} Update the underlying Python code.`,
    descriptionWritten: (to: string): string =>
        `The user described a new filter: ${quoted(to)} Write the Python code for it.`,
    codeEdited: (diff: string): string =>
        `The user edited the code directly. Update the filter description to match the code.\n\n${diff}`,
    descriptionFollowUp: (): string =>
        'Update the description to match the code.'
};

const SAMPLE_SIZE = 30;

/** Summary of a dry run for the model. */
export function summarizeFilterPreview(
    preview: GlyphFilterPreviewResult
): string {
    return JSON.stringify({
        ok: preview.ok,
        matchingGlyphs: preview.glyphNames.length,
        groups: preview.groups.map((group) => ({
            name: group.name,
            color: group.color,
            count: group.count
        })),
        sample: preview.glyphNames.slice(0, SAMPLE_SIZE),
        errors: preview.errors.map((error) => error.message)
    });
}

type FilterChatHostOptions = {
    /** Dry run of unsaved code (GlyphOverviewFilterManager.previewFilter). */
    preview: (code: string) => Promise<GlyphFilterPreviewResult>;
    /** Applies a name from name_filter; returns the result for the model. */
    nameFilter: (name: string) => string;
    /** Runs every other tool; the panel's executor. */
    executeSharedTool: (
        toolCall: AssistantToolCall,
        session: AssistantChatSession
    ) => Promise<string>;
};

export function createFilterChatHost(
    options: FilterChatHostOptions
): AssistantChatHost {
    return {
        async executeToolCall(toolCall, session) {
            if (toolCall.function.name === TEST_FILTER_TOOL.function.name) {
                const state = session.target?.getDocumentState();
                if (!state) {
                    throw new Error('The filter document is not available.');
                }
                return summarizeFilterPreview(
                    await options.preview(state.content)
                );
            }
            if (toolCall.function.name === NAME_FILTER_TOOL.function.name) {
                const args: unknown = JSON.parse(
                    toolCall.function.arguments || '{}'
                );
                const name =
                    args && typeof args === 'object' && 'name' in args
                        ? String(args.name ?? '')
                        : '';
                return options.nameFilter(name);
            }
            return options.executeSharedTool(toolCall, session);
        }
    };
}

/**
 * Each filter's chat as of its last OK, kept while the tab is open and never
 * persisted. The modal works on a fork: OK commits the fork, Cancel drops it.
 */
export class FilterChatRegistry {
    private readonly applied = new Map<string, AssistantChatSession>();

    private key(path: string): string {
        return path.toLowerCase();
    }

    /** A working copy for one modal: a fork of the applied chat, or a new one. */
    checkout(
        path: string | null,
        target: PythonDocumentTarget,
        host: AssistantChatHost
    ): AssistantChatSession {
        const applied = path ? this.applied.get(this.key(path)) : undefined;
        if (applied) {
            return applied.fork({ target, host });
        }
        return new AssistantChatSession({
            profile: FILTER_CHAT_PROFILE,
            host,
            target,
            allowEdits: true
        });
    }

    /**
     * Keep `working` as the filter's chat. The stored copy is detached from
     * the modal's editor, which goes away when the modal closes.
     */
    commit(path: string, working: AssistantChatSession): void {
        const stored = working.fork({ target: null });
        this.applied.get(this.key(path))?.dispose();
        this.applied.set(this.key(path), stored);
    }

    rename(fromPath: string, toPath: string): void {
        const session = this.applied.get(this.key(fromPath));
        if (!session) return;
        this.applied.delete(this.key(fromPath));
        this.applied.set(this.key(toPath), session);
    }

    remove(path: string): void {
        this.applied.get(this.key(path))?.dispose();
        this.applied.delete(this.key(path));
    }

    has(path: string): boolean {
        return this.applied.has(this.key(path));
    }
}

export const filterChatRegistry = new FilterChatRegistry();
