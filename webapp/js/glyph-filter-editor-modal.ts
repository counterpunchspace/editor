// The glyph filter editor: a modal that edits one user filter through its
// description (Simple) or its code and a chat (Expert). It works on a copy of
// the filter and of its chat; OK writes the file and keeps the chat, Cancel
// drops both. See APP.md "User glyph filters".

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import { getTheme } from './tippy-utils';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { AssistantChatView, formatPythonLineDiff } from './assistant/chat-view';
import {
    AcePythonDocumentTarget,
    type AceEditorLike
} from './assistant/python-target';
import type {
    AssistantChatSession,
    AssistantTurnEndReason
} from './assistant/chat-session';
import {
    createFilterChatHost,
    filterChatMessages,
    filterChatRegistry
} from './glyph-filter-chat';
import {
    readFilterDescription,
    writeFilterDescription
} from './glyph-filter-description';
import { normalizeFilterName, validateFilterName } from './glyph-filter-names';
import { createGlyphFilterTemplate } from './glyph-filter-template';
import { GlyphOverviewView } from './glyph-overview-view';
import {
    renderGlyphFilterLegend,
    setGlyphFilterLegendActive
} from './glyph-filter-legend';
import {
    glyphOverviewFilterManager,
    type GlyphFilterPreviewResult,
    type GlyphFilterSourceError
} from './glyph-overview-filters';
import '../css/ui/glyph-filter-editor.css';

const console = new Logger('GlyphFilterEditor');

type EditorMode = 'simple' | 'expert';
type TurnKind = 'description' | 'chat' | 'code-sync' | 'follow-up';

const MODE_STORAGE_KEY = 'glyphFilterEditorMode';
const VALIDATE_DELAY_MS = 300;
const PREVIEW_DELAY_MS = 600;
/** Tile cache share for the modal's glyph view. */
const PREVIEW_TILE_CACHE_BYTES = 48 * 1024 * 1024;

const EXAMPLES: ReadonlyArray<{ text: string; note: string }> = [
    {
        text: 'Show glyphs without a Unicode value.',
        note: 'One condition, no groups'
    },
    {
        text: 'Show empty glyphs that have no outlines or components yet, so I can see what still needs drawing.',
        note: 'Checks the outlines'
    },
    {
        text: 'Show small caps and ligatures. Put small caps in a purple group and ligatures in an orange group.',
        note: 'Two groups by glyph name'
    },
    {
        text: 'Show glyphs that are not exported, and glyphs without a Unicode value. Put each kind in its own group and color the groups randomly.',
        note: 'Groups with random colors'
    }
];

const AI_NOTE_HTML =
    '<div class="info-popup-content"><p><strong>This is an AI chat.</strong> The Assistant turns what you write into the filter\'s code. AI can make mistakes, so check the glyphs it finds before you press OK.</p></div>';

/** Filters whose description may no longer match hand-edited code. */
const staleDescriptions = new Set<string>();

/** The Ace calls the modal uses on top of what the chat target needs. */
interface AceEditorInstance extends AceEditorLike {
    setValue(value: string, cursor?: number): void;
    setTheme(theme: string): void;
    setOptions(options: Record<string, string | number | boolean>): void;
    setReadOnly(readOnly: boolean): void;
    resize(force?: boolean): void;
    focus(): void;
    destroy(): void;
    session: AceEditorLike['session'] & { setMode(mode: string): void };
}

let openEditor: GlyphFilterEditor | null = null;

export type OpenGlyphFilterEditorOptions = {
    /** An existing filter file; omit for a new filter. */
    filePath?: string | null;
};

/** Open the editor for a filter, or for a new one. One at a time. */
export async function openGlyphFilterEditor(
    options: OpenGlyphFilterEditorOptions = {}
): Promise<void> {
    if (openEditor) {
        openEditor.focus();
        return;
    }
    const filePath = options.filePath ?? null;
    const folder = filePath
        ? filePath.slice(0, filePath.lastIndexOf('/'))
        : undefined;
    const existingNames =
        await glyphOverviewFilterManager.listFilterNamesInFolder(folder);
    let name: string;
    let code: string;
    if (filePath) {
        name = normalizeFilterName(
            filePath.slice(filePath.lastIndexOf('/') + 1)
        );
        code = await glyphOverviewFilterManager.readFilterFile(filePath);
    } else {
        name = await glyphOverviewFilterManager.getFreeFilterName();
        code = createGlyphFilterTemplate(name);
    }
    openEditor = new GlyphFilterEditor({
        filePath,
        name,
        code,
        existingNames
    });
    openEditor.mount();
}

function assistantAvailable(): boolean {
    const auth = window.authManager;
    return (
        !!auth &&
        auth.isAuthenticated() &&
        auth.subscription?.canUseAssistant === true
    );
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function icon(name: string): string {
    return `<span class="material-symbols-outlined">${name}</span>`;
}

function accessGateHtml(
    gateIcon: string,
    heading: string,
    message: string,
    action: 'sign-in' | 'account',
    buttonIcon: string,
    buttonLabel: string,
    note?: string
): string {
    return `<div class="folder-setup-callout folder-setup-callout-muted">
        <div class="folder-setup-callout-heading">
            <span class="material-symbols-outlined folder-setup-callout-icon" aria-hidden="true">${gateIcon}</span>
            <h2>${escapeHtml(heading)}</h2>
        </div>
        <p>${escapeHtml(message)}</p>
        <button type="button" class="settings-action-btn" data-gate-action="${action}">${icon(buttonIcon)}${escapeHtml(buttonLabel)}</button>
        ${note ? `<p class="folder-setup-callout-note">${escapeHtml(note)}</p>` : ''}
    </div>`;
}

function readStoredMode(): EditorMode {
    try {
        return localStorage.getItem(MODE_STORAGE_KEY) === 'expert'
            ? 'expert'
            : 'simple';
    } catch {
        return 'simple';
    }
}

function storeMode(mode: EditorMode): void {
    try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
        // Private mode or blocked storage: the mode just isn't remembered.
    }
}

function formatSourceError(error: GlyphFilterSourceError): string {
    return error.line ? `Line ${error.line}: ${error.message}` : error.message;
}

class GlyphFilterEditor {
    private readonly isNew: boolean;
    private filePath: string | null;
    private readonly appliedName: string;
    private readonly appliedCode: string;
    private readonly existingNames: string[];

    private name: string;
    /** The Simple text box; differs from the docstring until sent. */
    private draft: string;
    /** The docstring the Simple box last showed. */
    private shownDescription: string;
    /** Code whose docstring is known to describe it. */
    private syncedCode: string;
    private mode: EditorMode;
    private ai: boolean;
    private conversationOpen = false;
    private glyphsOpen = false;
    private activeGroup: string | null = null;
    private asking: 'cancel' | 'ok' | null = null;
    /** The user typed a name in this dialog; the Assistant keeps it. */
    private nameChosenByUser = false;
    private saving = false;
    private saveError: string | null = null;
    private sourceErrors: GlyphFilterSourceError[] = [];
    /** EVENT_TYPES of the last valid check; null until checked. */
    private eventTypes: readonly string[] | null = null;
    private preview: GlyphFilterPreviewResult | null = null;
    private currentTurn: Promise<AssistantTurnEndReason | null> | null = null;

    private overlay!: HTMLDivElement;
    private root!: HTMLDivElement;
    private ace!: AceEditorInstance;
    private target!: AcePythonDocumentTarget;
    private session!: AssistantChatSession;
    private stripChatView: AssistantChatView | null = null;
    private expertChatView: AssistantChatView | null = null;
    private glyphView: GlyphOverviewView | null = null;
    /** What the glyph view was last given, to skip unchanged updates. */
    private viewGlyphsKey: string | null = null;
    private viewGroupsKey: string | null = null;
    private escapeBinding: ModalEscapeBinding | null = null;
    private readonly tippies: TippyInstance[] = [];
    private readonly unsubscribers: Array<() => void> = [];
    private validateTimer: number | undefined;
    private previewTimer: number | undefined;
    private previewGeneration = 0;
    private closed = false;

    constructor(init: {
        filePath: string | null;
        name: string;
        code: string;
        existingNames: string[];
    }) {
        this.isNew = init.filePath === null;
        this.filePath = init.filePath;
        this.appliedName = init.name;
        this.appliedCode = init.code;
        this.existingNames = init.existingNames;
        this.name = init.name;
        this.draft = readFilterDescription(init.code);
        this.shownDescription = this.draft;
        this.syncedCode = init.code;
        this.ai = assistantAvailable();
        this.mode = this.ai ? readStoredMode() : 'expert';
    }

    // ── Derived state ──────────────────────────────────────────────────

    private get code(): string {
        return this.ace.getValue();
    }

    private get description(): string {
        return readFilterDescription(this.code);
    }

    private get streaming(): boolean {
        return this.session.isStreaming;
    }

    private unsentDescription(): boolean {
        return (
            this.ai &&
            this.draft.trim() !== '' &&
            this.draft.trim() !== this.description.trim()
        );
    }

    private handEdited(): boolean {
        return this.code !== this.syncedCode;
    }

    private nameError(): string | null {
        return validateFilterName(
            this.name,
            this.existingNames,
            this.isNew ? undefined : this.appliedName
        );
    }

    private isDirty(): boolean {
        return (
            this.isNew ||
            normalizeFilterName(this.name) !== this.appliedName ||
            this.code !== this.appliedCode ||
            this.unsentDescription()
        );
    }

    private blockingError(): string | null {
        const nameError = this.nameError();
        if (nameError) return nameError;
        if (this.sourceErrors.length) {
            return formatSourceError(this.sourceErrors[0]);
        }
        return null;
    }

    // ── Building ───────────────────────────────────────────────────────

    mount(): void {
        this.overlay = document.createElement('div');
        this.overlay.className = 'info-popup-overlay';
        this.overlay.style.display = 'flex';
        this.overlay.innerHTML = this.template();
        this.root = this.overlay.querySelector('.gfe') as HTMLDivElement;
        document.body.appendChild(this.overlay);

        this.setupAce();
        this.setupSession();
        this.bindEvents();
        // Signing in from the dialog unlocks the Assistant without reopening.
        const onAuthChanged = () => {
            this.ai = assistantAvailable();
            this.render();
        };
        window.addEventListener('authStateChanged', onAuthChanged);
        this.unsubscribers.push(() =>
            window.removeEventListener('authStateChanged', onAuthChanged)
        );
        // Opened while a font was still loading: check again once it is in.
        const onFontLoaded = () => {
            this.scheduleValidation(0);
            this.schedulePreview(0);
        };
        window.addEventListener('fontLoaded', onFontLoaded);
        this.unsubscribers.push(() =>
            window.removeEventListener('fontLoaded', onFontLoaded)
        );
        let legendWidth = 0;
        const legend = this.$('[data-ref="legend"]');
        const widthObserver = new ResizeObserver(() => {
            // Only width changes move chips between rows.
            if (legend.clientWidth !== legendWidth) {
                legendWidth = legend.clientWidth;
                if (!this.glyphsOpen) this.clampLegend();
            }
        });
        widthObserver.observe(legend);
        this.unsubscribers.push(() => widthObserver.disconnect());
        this.escapeBinding = bindModalEscape(() => this.cancel(), {
            isOpen: () => !this.closed
        });

        this.render();
        this.scheduleValidation(0);
        this.schedulePreview(0);
        requestAnimationFrame(() => this.focusFirstField());
    }

    focus(): void {
        this.focusFirstField();
    }

    private focusFirstField(): void {
        if (this.mode === 'simple' && this.ai) {
            this.$<HTMLTextAreaElement>('[data-ref="desc"]').focus();
        } else {
            this.ace.focus();
        }
    }

    private $<T extends HTMLElement = HTMLElement>(selector: string): T {
        const element = this.root.querySelector<T>(selector);
        if (!element) {
            throw new Error(`Filter editor element missing: ${selector}`);
        }
        return element;
    }

    private template(): string {
        const examples = EXAMPLES.map(
            (example, index) =>
                `<button type="button" class="gfe-example" data-example="${index}"><span class="gfe-example-text">${escapeHtml(example.text)}</span><span class="gfe-example-note">${escapeHtml(example.note)}</span></button>`
        ).join('');
        const aiNote = `<button type="button" class="gfe-ai-note" data-ref="ai-note" aria-label="About the AI">AI${icon('info')}</button>`;
        return `
<div class="info-popup gfe" role="dialog" aria-modal="true" aria-label="Glyph filter editor">
    <div class="gfe-head">
        <div class="gfe-head-row">
            <span class="gfe-chip">${icon('filter_alt')}User filter</span>
            <label class="gfe-name" data-ref="name-field" title="Rename the filter">
                ${icon('edit')}
                <input data-ref="name" aria-label="Filter name" spellcheck="false" autocomplete="off">
                <span class="gfe-name-suffix">.py</span>
            </label>
            <div class="gfe-mode" role="group" aria-label="Editor mode">
                <button type="button" data-mode="simple">${icon('notes')}Simple</button>
                <button type="button" data-mode="expert">${icon('code')}Expert</button>
            </div>
            <button type="button" class="info-popup-close" data-ref="close" aria-label="Cancel" title="Cancel">${icon('close')}</button>
        </div>
        <div class="gfe-name-error" data-ref="name-error" hidden>${icon('error')}<span data-ref="name-error-text"></span></div>
    </div>

    <div class="gfe-body" data-ref="simple">
        <div>
            <div class="gfe-field-top">
                <label class="gfe-label" for="gfe-desc">What should this filter show?</label>
                <button type="button" class="gfe-toggle" data-ref="examples">${icon('lightbulb')}Examples</button>
            </div>
            <p class="gfe-help">Describe which glyphs to include, for example by name, Unicode or outlines. To sort them into groups, describe each group.</p>
        </div>
        <textarea class="gfe-desc" id="gfe-desc" data-ref="desc" spellcheck="true" placeholder="For example: Show small caps and ligatures. Put small caps in a purple group."></textarea>
        <div class="assistant-access-gate" data-ref="gate-simple" hidden></div>
        <div class="gfe-actions" data-ref="simple-actions">
            ${aiNote}
            <button type="button" class="dialog-button dialog-button-primary" data-ref="update" title="Cmd/Ctrl+Enter"></button>
        </div>
    </div>

    <div class="gfe-strip" data-ref="conversation">
        <div class="gfe-strip-head">
            <span class="gfe-status-slot" data-ref="conv-icon"></span>
            <span class="gfe-status" data-ref="conv-status"></span>
            <button type="button" class="gfe-toggle" data-ref="conv-toggle">${icon('forum')}<span data-ref="conv-toggle-label"></span></button>
        </div>
        <div class="gfe-strip-body gfe-conversation" data-ref="conv-body" hidden></div>
    </div>

    <div class="gfe-body gfe-expert" data-ref="expert">
        <div class="gfe-expert-grid">
            <div class="gfe-pane">
                <div class="gfe-desc-strip">
                    <div class="gfe-pane-head">${icon('notes')}<span class="gfe-pane-label">Description</span><span class="gfe-badge" data-ref="desc-badge" hidden></span></div>
                    <div class="gfe-desc-text" data-ref="desc-text"></div>
                </div>
                <div class="gfe-pane-head">${icon('code')}<span class="gfe-pane-label">Code</span><span class="gfe-pane-file" data-ref="file"></span></div>
                <div class="gfe-code"><div data-ref="ace"></div></div>
            </div>
            <div class="gfe-pane">
                <div class="gfe-chat">
                    <div class="gfe-pane-head">${icon('forum')}<span class="gfe-pane-label">Chat</span></div>
                    <div class="gfe-chat-transcript" data-ref="chat-transcript"></div>
                    <div class="gfe-chat-input" data-ref="chat-input">
                        <textarea data-ref="prompt" rows="2" placeholder="Ask for a change, for example: Also show ligatures"></textarea>
                        <div class="gfe-actions">${aiNote}<button type="button" class="assistant-send-button" data-ref="send" title="Cmd/Ctrl+Enter"></button></div>
                    </div>
                    <div class="assistant-access-gate" data-ref="gate-expert" hidden></div>
                </div>
            </div>
        </div>
    </div>

    <div class="gfe-strip" data-ref="results">
        <div class="gfe-strip-head">
            <span class="gfe-count" data-ref="count"></span>
            <div class="glyph-filter-legend" data-ref="legend" aria-label="Groups"></div>
            <span class="gfe-spacer"></span>
            <button type="button" class="gfe-toggle" data-ref="glyphs-toggle">${icon('grid_view')}<span data-ref="glyphs-toggle-label"></span></button>
        </div>
        <div class="gfe-glyphs" data-ref="glyphs" hidden>
            <div class="gfe-glyphs-tiles" data-ref="tiles"></div>
            <div class="gfe-glyphs-empty" data-ref="glyphs-empty" hidden>No glyphs match.</div>
        </div>
    </div>

    <div class="gfe-foot">
        <div class="gfe-facts" data-ref="facts">
            <span class="gfe-error" data-ref="error" hidden></span>
            <span data-ref="pending"></span>
            <span class="gfe-hint" data-ref="events-hint" hidden>This filter updates only when glyphs are added, renamed or removed.</span>
        </div>
        <div class="gfe-confirm" data-ref="confirm-cancel" hidden>
            <span>Discard your changes and this part of the chat?</span>
            <button type="button" class="dialog-button" data-ref="keep-editing">Keep editing</button>
            <button type="button" class="dialog-button dialog-button-danger" data-ref="discard">Discard</button>
        </div>
        <div class="gfe-confirm" data-ref="confirm-ok" hidden>
            <span>Update the filter from your new description before saving?</span>
            <button type="button" class="dialog-button" data-ref="ok-back">Cancel</button>
            <button type="button" class="dialog-button dialog-button-primary" data-ref="ok-go">Update and save</button>
        </div>
        <button type="button" class="dialog-button" data-ref="cancel">Cancel</button>
        <button type="button" class="dialog-button dialog-button-primary" data-ref="ok">OK</button>
    </div>
    <template data-ref="examples-content"><div class="gfe-examples"><p class="gfe-examples-title">Start from an example</p>${examples}</div></template>
</div>`;
    }

    private setupAce(): void {
        const host = this.$('[data-ref="ace"]');
        this.ace = window.ace.edit(host) as AceEditorInstance;
        this.ace.setTheme(
            getTheme() === 'light'
                ? 'ace/theme/tomorrow'
                : 'ace/theme/tomorrow_night'
        );
        this.ace.session.setMode('ace/mode/python');
        // Same options as the Script Editor (script-editor.ts).
        window.ace.require('ace/ext/language_tools');
        this.ace.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            tabSize: 4,
            useSoftTabs: true,
            wrap: false
        });
        this.ace.setValue(this.appliedCode, -1);
        this.target = new AcePythonDocumentTarget(this.ace, {
            label: 'Filter editor',
            kind: 'glyph-filter',
            path: () =>
                this.filePath ??
                `/Filters/${normalizeFilterName(this.name)}.py`,
            isModified: () => this.code !== this.appliedCode,
            validate: () =>
                glyphOverviewFilterManager
                    .validateFilterSource(this.code)
                    .errors.map(formatSourceError)
        });
        this.ace.on('change', () => this.onCodeChanged());
    }

    private setupSession(): void {
        const host = createFilterChatHost({
            preview: (code) => glyphOverviewFilterManager.previewFilter(code),
            nameFilter: (name) => this.applySuggestedName(name),
            executeSharedTool: (call, session) =>
                window.aiAssistant.executeToolCall(call, session)
        });
        this.session = filterChatRegistry.checkout(
            this.filePath,
            this.target,
            host
        );
        this.stripChatView = new AssistantChatView(
            this.$('[data-ref="conv-body"]'),
            this.session
        );
        this.expertChatView = new AssistantChatView(
            this.$('[data-ref="chat-transcript"]'),
            this.session
        );
        for (const type of [
            'entry-added',
            'item-added',
            'item-updated',
            'status',
            'streaming-changed'
        ] as const) {
            this.unsubscribers.push(
                this.session.on(type, () => this.renderActivity())
            );
        }
    }

    private bindEvents(): void {
        const nameInput = this.$<HTMLInputElement>('[data-ref="name"]');
        nameInput.value = this.name;
        nameInput.addEventListener('input', () => {
            this.nameChosenByUser = true;
            this.name = nameInput.value;
            this.render();
        });

        this.root
            .querySelectorAll<HTMLButtonElement>('[data-mode]')
            .forEach((button) =>
                button.addEventListener('click', () =>
                    this.setMode(button.dataset.mode as EditorMode)
                )
            );
        this.$('[data-ref="close"]').addEventListener('click', () =>
            this.cancel()
        );

        const desc = this.$<HTMLTextAreaElement>('[data-ref="desc"]');
        desc.value = this.draft;
        desc.addEventListener('input', () => {
            this.draft = desc.value;
            this.render();
        });
        desc.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void this.updateFromDescription();
            }
        });
        this.$('[data-ref="update"]').addEventListener('click', () => {
            if (this.streaming) this.session.stop();
            else void this.updateFromDescription();
        });

        const prompt = this.$<HTMLTextAreaElement>('[data-ref="prompt"]');
        const send = () => {
            if (this.streaming) {
                this.session.stop();
                return;
            }
            const text = prompt.value.trim();
            if (!text) return;
            prompt.value = '';
            void this.runTurn('chat', text);
        };
        prompt.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
            }
        });
        this.$('[data-ref="send"]').addEventListener('click', send);
        this.root.addEventListener('click', (event) => {
            const action = (event.target as HTMLElement).closest<HTMLElement>(
                '[data-gate-action]'
            )?.dataset.gateAction;
            if (action === 'sign-in') {
                void window.authManager?.signIn({
                    reason: 'Sign in to use the Assistant in the filter editor.'
                });
            } else if (action === 'account') {
                // A new tab, so open fonts stay open.
                window.open(
                    `${window.authManager?.websiteURL ?? ''}/account`,
                    '_blank'
                );
            }
        });

        this.$('[data-ref="conv-toggle"]').addEventListener('click', () => {
            this.conversationOpen = !this.conversationOpen;
            this.renderActivity();
        });
        this.$('[data-ref="glyphs-toggle"]').addEventListener('click', () => {
            this.glyphsOpen = !this.glyphsOpen;
            void this.renderGlyphs();
        });

        this.$('[data-ref="cancel"]').addEventListener('click', () =>
            this.cancel()
        );
        this.$('[data-ref="keep-editing"]').addEventListener('click', () => {
            this.asking = null;
            this.renderFooter();
        });
        this.$('[data-ref="discard"]').addEventListener('click', () =>
            this.cancel(true)
        );
        this.$('[data-ref="ok"]').addEventListener('click', () => {
            void this.applyOK(false);
        });
        this.$('[data-ref="ok-back"]').addEventListener('click', () => {
            this.asking = null;
            this.renderFooter();
            this.$('[data-ref="ok"]').focus();
        });
        this.$('[data-ref="ok-go"]').addEventListener('click', () => {
            void this.applyOK(true);
        });

        this.setupTippies();
    }

    private setupTippies(): void {
        const examplesTemplate = this.$<HTMLTemplateElement>(
            '[data-ref="examples-content"]'
        );
        const examplesContent = examplesTemplate.content.firstElementChild;
        if (examplesContent instanceof HTMLElement) {
            const examples = tippy(this.$('[data-ref="examples"]'), {
                content: examplesContent,
                interactive: true,
                trigger: 'click',
                theme: getTheme(),
                appendTo: () => document.body,
                placement: 'bottom-end',
                maxWidth: 400,
                zIndex: 10001
            });
            examplesContent.addEventListener('click', (event) => {
                const button = (
                    event.target as HTMLElement
                ).closest<HTMLElement>('[data-example]');
                if (!button) return;
                const example = EXAMPLES[Number(button.dataset.example)];
                if (!example) return;
                this.draft = example.text;
                const desc = this.$<HTMLTextAreaElement>('[data-ref="desc"]');
                desc.value = example.text;
                examples.hide();
                desc.focus();
                this.render();
            });
            this.tippies.push(examples);
        }

        this.root
            .querySelectorAll<HTMLElement>('[data-ref="ai-note"]')
            .forEach((button) => {
                this.tippies.push(
                    tippy(button, {
                        content: AI_NOTE_HTML,
                        allowHTML: true,
                        interactive: true,
                        trigger: 'click',
                        theme: getTheme(),
                        appendTo: () => document.body,
                        maxWidth: 360,
                        placement: 'top',
                        zIndex: 10001,
                        onShow: (instance) =>
                            instance.reference.setAttribute(
                                'aria-expanded',
                                'true'
                            ),
                        onHide: (instance) =>
                            instance.reference.setAttribute(
                                'aria-expanded',
                                'false'
                            )
                    })
                );
            });
    }

    /** name_filter from the Assistant. */
    private applySuggestedName(suggested: string): string {
        const name = normalizeFilterName(suggested);
        if (this.nameChosenByUser) {
            return `Not renamed: the user chose the name “${normalizeFilterName(this.name)}”.`;
        }
        const error = validateFilterName(
            name,
            this.existingNames,
            this.isNew ? undefined : this.appliedName
        );
        if (error) {
            return `Not renamed: ${error} Pick another name.`;
        }
        this.name = name;
        this.$<HTMLInputElement>('[data-ref="name"]').value = name;
        this.render();
        return `Renamed to “${name}”. It is saved with the filter on OK.`;
    }

    // ── Changes ────────────────────────────────────────────────────────

    private onCodeChanged(): void {
        if (this.closed) return;
        this.followDescription();
        this.saveError = null;
        this.scheduleValidation(VALIDATE_DELAY_MS);
        // Dry runs wait for the Assistant's turn to finish.
        if (!this.streaming) this.schedulePreview(PREVIEW_DELAY_MS);
        this.render();
    }

    /**
     * The Simple box follows the docstring, whoever changed it (the chat, a
     * hand edit, a code sync), unless it holds words the user has not sent.
     */
    private followDescription(): void {
        const description = this.description;
        if (description === this.shownDescription) return;
        if (this.draft.trim() === this.shownDescription.trim()) {
            this.setDraft(description);
        }
        this.shownDescription = description;
    }

    private setDraft(text: string): void {
        this.draft = text;
        const box = this.$<HTMLTextAreaElement>('[data-ref="desc"]');
        if (box.value !== text) box.value = text;
    }

    private scheduleValidation(delay: number): void {
        window.clearTimeout(this.validateTimer);
        this.validateTimer = window.setTimeout(() => {
            if (this.closed) return;
            try {
                const validation =
                    glyphOverviewFilterManager.validateFilterSource(this.code);
                this.sourceErrors = validation.errors;
                this.eventTypes = validation.errors.length
                    ? null
                    : validation.eventTypes;
            } catch (error) {
                this.eventTypes = null;
                this.sourceErrors = [
                    {
                        kind: 'runtime',
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    }
                ];
            }
            this.renderFooter();
        }, delay);
    }

    private schedulePreview(delay: number): void {
        window.clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => {
            void this.runPreview();
        }, delay);
    }

    private async runPreview(): Promise<void> {
        if (this.closed) return;
        const generation = ++this.previewGeneration;
        const result = await glyphOverviewFilterManager.previewFilter(
            this.code
        );
        if (this.closed || generation !== this.previewGeneration) return;
        this.preview = result;
        if (
            this.activeGroup &&
            !result.groups.some((group) => group.name === this.activeGroup)
        ) {
            this.activeGroup = null;
        }
        this.renderResults();
        await this.renderGlyphs();
    }

    private setMode(mode: EditorMode): void {
        if (mode === this.mode) return;
        this.tippies.forEach((instance) => instance.hide());
        this.mode = mode;
        storeMode(mode);
        this.render();
        if (mode === 'expert') {
            this.ace.resize(true);
        } else if (this.ai && this.handEdited() && !this.streaming) {
            void this.syncCodeEdits();
        }
    }

    // ── Assistant turns ────────────────────────────────────────────────

    /** One turn; returns how it ended, or null when another turn runs. */
    private async runTurn(
        kind: TurnKind,
        text: string
    ): Promise<AssistantTurnEndReason | null> {
        if (!this.ai || this.streaming) return null;
        const codeBefore = this.code;
        const descriptionBefore = this.description;
        this.ace.setReadOnly(true);
        this.render();

        const turn = this.session.send(text, { automatic: kind !== 'chat' });
        this.currentTurn = turn;
        let reason: AssistantTurnEndReason | null;
        try {
            reason = await turn;
        } finally {
            this.currentTurn = null;
            if (!this.closed) this.ace.setReadOnly(false);
        }
        if (this.closed) return reason;

        if (reason === 'done') {
            const changedCodeOnly =
                kind === 'chat' &&
                this.code !== codeBefore &&
                this.description === descriptionBefore;
            this.syncedCode = this.code;
            if (changedCodeOnly) {
                const followUp = await this.runTurn(
                    'follow-up',
                    filterChatMessages.descriptionFollowUp()
                );
                if (followUp !== 'done') this.syncedCode = codeBefore;
            }
        }
        this.schedulePreview(0);
        this.render();
        return reason;
    }

    /** Simple mode: put the user's words in the docstring, then ask for code. */
    private async updateFromDescription(): Promise<AssistantTurnEndReason | null> {
        const typed = this.draft;
        const next = typed.trim();
        if (!this.unsentDescription() || this.streaming) return null;
        const codeBefore = this.code;
        const previous = this.description.trim();
        this.ace.setValue(writeFilterDescription(codeBefore, next), -1);
        const reason = await this.runTurn(
            'description',
            previous
                ? filterChatMessages.descriptionUpdated(previous, next)
                : filterChatMessages.descriptionWritten(next)
        );
        if (reason !== 'done' && !this.closed) {
            // Nothing applied: the code goes back, the words stay in the box.
            this.ace.setValue(codeBefore, -1);
            this.setDraft(typed);
            this.render();
        }
        return reason;
    }

    /** Hand edits: have the Assistant describe the code as it is now. */
    private async syncCodeEdits(): Promise<AssistantTurnEndReason | null> {
        if (!this.ai || !this.handEdited()) return 'done';
        return this.runTurn(
            'code-sync',
            filterChatMessages.codeEdited(
                formatPythonLineDiff(this.syncedCode, this.code)
            )
        );
    }

    // ── OK and Cancel ──────────────────────────────────────────────────

    private async applyOK(confirmed: boolean): Promise<void> {
        if (this.saving || this.blockingError()) return;
        if (!this.isDirty()) {
            this.close();
            return;
        }
        // An unsent description costs an Assistant request: ask first.
        // Cancel there only closes the question.
        if (!confirmed && this.unsentDescription()) {
            this.asking = 'ok';
            this.renderFooter();
            this.$('[data-ref="ok-go"]').focus();
            return;
        }
        this.asking = null;
        this.saving = true;
        this.saveError = null;
        this.render();
        try {
            if (this.currentTurn) await this.currentTurn;
            if (this.unsentDescription()) {
                if ((await this.updateFromDescription()) !== 'done') return;
            }
            if (this.ai && this.handEdited()) {
                if ((await this.syncCodeEdits()) !== 'done') return;
            }
            if (this.closed) return;

            const errors = glyphOverviewFilterManager.validateFilterSource(
                this.code
            ).errors;
            if (errors.length) {
                this.sourceErrors = errors;
                return;
            }

            const name = normalizeFilterName(this.name);
            const savedPath = this.filePath
                ? await glyphOverviewFilterManager.saveFilterFile(
                      this.filePath,
                      this.code,
                      name
                  )
                : await glyphOverviewFilterManager.createFilterFile(
                      name,
                      this.code
                  );

            if (!this.ai && this.handEdited()) {
                staleDescriptions.add(savedPath.toLowerCase());
            } else if (this.ai) {
                staleDescriptions.delete(savedPath.toLowerCase());
            }
            if (this.filePath && savedPath !== this.filePath) {
                if (staleDescriptions.delete(this.filePath.toLowerCase())) {
                    staleDescriptions.add(savedPath.toLowerCase());
                }
            }
            filterChatRegistry.commit(savedPath, this.session);
            if (this.isNew) {
                glyphOverviewFilterManager.activateUserFilterByPath(savedPath);
            }
            this.filePath = savedPath;
            console.log('Saved filter', savedPath);
            this.close();
        } catch (error) {
            this.saveError =
                error instanceof Error ? error.message : String(error);
        } finally {
            this.saving = false;
            if (!this.closed) this.render();
        }
    }

    private cancel(force = false): void {
        if (this.saving) return;
        if (!force && this.isDirty() && (!this.isNew || this.hasNewWork())) {
            this.asking = 'cancel';
            this.renderFooter();
            this.$('[data-ref="keep-editing"]').focus();
            return;
        }
        this.session.stop();
        this.close();
    }

    /** A new filter only asks before Cancel once there is something to lose. */
    private hasNewWork(): boolean {
        return (
            this.draft.trim() !== '' ||
            this.session.transcript.length > 0 ||
            this.code !== this.appliedCode
        );
    }

    private close(): void {
        if (this.closed) return;
        this.closed = true;
        window.clearTimeout(this.validateTimer);
        window.clearTimeout(this.previewTimer);
        this.escapeBinding?.release();
        this.tippies.forEach((instance) => instance.destroy());
        this.unsubscribers.forEach((unsubscribe) => unsubscribe());
        this.stripChatView?.dispose();
        this.expertChatView?.dispose();
        this.session.dispose();
        this.target.dispose();
        this.glyphView?.destroy();
        this.ace.destroy();
        this.overlay.remove();
        openEditor = null;
    }

    // ── Rendering ──────────────────────────────────────────────────────

    private render(): void {
        if (this.closed) return;
        this.renderHeader();
        this.renderSimple();
        this.renderExpert();
        this.renderActivity();
        this.renderResults();
        this.renderFooter();
    }

    private renderHeader(): void {
        const error = this.nameError();
        this.$('[data-ref="name-field"]').classList.toggle('invalid', !!error);
        this.$('[data-ref="name-error"]').hidden = !error;
        this.$('[data-ref="name-error-text"]').textContent = error ?? '';
        this.root
            .querySelectorAll<HTMLButtonElement>('[data-mode]')
            .forEach((button) => {
                button.setAttribute(
                    'aria-pressed',
                    String(button.dataset.mode === this.mode)
                );
            });
    }

    /** The Assistant panel's sign-in or subscription callout, same markup. */
    private renderAccessGate(ref: string, message: string): void {
        const gate = this.$(`[data-ref="${ref}"]`);
        gate.hidden = this.ai;
        if (this.ai) return;
        const signedIn = window.authManager?.isAuthenticated() === true;
        const html = signedIn
            ? accessGateHtml(
                  'workspace_premium',
                  'Advanced Subscription Required',
                  message,
                  'account',
                  'manage_accounts',
                  'Manage Account',
                  'Upgrade to Advanced to access the Assistant.'
              )
            : accessGateHtml(
                  'lock',
                  'Sign In Required',
                  message,
                  'sign-in',
                  'login',
                  'Sign In'
              );
        if (gate.dataset.html !== html) {
            gate.innerHTML = html;
            gate.dataset.html = html;
        }
    }

    private renderSimple(): void {
        const simple = this.mode === 'simple';
        this.$('[data-ref="simple"]').hidden = !simple;
        if (!simple) return;
        const desc = this.$<HTMLTextAreaElement>('[data-ref="desc"]');
        desc.readOnly = this.streaming || this.saving || !this.ai;
        this.renderAccessGate(
            'gate-simple',
            'Turning a description into code needs the Assistant. You can still switch to Expert mode and edit the code yourself.'
        );
        this.$('[data-ref="simple-actions"]').hidden = !this.ai;
        this.$<HTMLButtonElement>('[data-ref="examples"]').disabled =
            this.streaming || !this.ai;
        const update = this.$<HTMLButtonElement>('[data-ref="update"]');
        update.innerHTML = this.streaming
            ? `${icon('stop')}Stop`
            : `${icon('auto_fix_high')}Update filter`;
        update.classList.toggle('dialog-button-primary', !this.streaming);
        update.disabled =
            !this.streaming && (!this.unsentDescription() || this.saving);
    }

    private renderExpert(): void {
        const expert = this.mode === 'expert';
        this.$('[data-ref="expert"]').hidden = !expert;
        if (!expert) return;
        this.$('[data-ref="desc-text"]').textContent =
            this.description || 'No description yet.';
        const badge = this.$('[data-ref="desc-badge"]');
        const stale =
            (this.filePath !== null &&
                staleDescriptions.has(this.filePath.toLowerCase())) ||
            (!this.ai && this.handEdited());
        badge.hidden = !stale;
        badge.className = 'gfe-badge warn';
        badge.textContent = 'May be out of date';
        this.$('[data-ref="file"]').textContent =
            `Filters/${normalizeFilterName(this.name) || 'Untitled'}.py`;

        this.$('[data-ref="chat-input"]').hidden = !this.ai;
        this.$('[data-ref="chat-transcript"]').hidden = !this.ai;
        this.renderAccessGate(
            'gate-expert',
            'The filter chat needs the Assistant. You can still edit the code. The description will be marked as possibly out of date.'
        );
        const prompt = this.$<HTMLTextAreaElement>('[data-ref="prompt"]');
        prompt.readOnly = this.streaming || this.saving;
        const send = this.$<HTMLButtonElement>('[data-ref="send"]');
        send.innerHTML = this.streaming
            ? `${icon('stop')}Stop`
            : `${icon('send')}Send`;
        send.disabled = this.saving && !this.streaming;
    }

    private lastAssistantText(): string | null {
        const transcript = this.session.transcript;
        for (let index = transcript.length - 1; index >= 0; index--) {
            const entry = transcript[index];
            if (entry.kind === 'error') return null;
            if (entry.kind !== 'assistant') continue;
            for (let item = entry.items.length - 1; item >= 0; item--) {
                const turnItem = entry.items[item];
                if (turnItem.kind === 'text' && turnItem.text.trim()) {
                    return turnItem.text.trim();
                }
            }
        }
        return null;
    }

    private renderActivity(): void {
        if (this.closed) return;
        const strip = this.$('[data-ref="conversation"]');
        strip.hidden = this.mode !== 'simple' || !this.ai;
        if (strip.hidden) return;
        const transcript = this.session.transcript;
        const lastEntry = transcript[transcript.length - 1];
        let status: string;
        if (this.streaming) {
            status = this.session.status || 'The Assistant is working…';
        } else if (lastEntry?.kind === 'error') {
            status = 'Something went wrong. Open the conversation for details.';
        } else if (lastEntry?.kind === 'user') {
            status = 'Stopped before the Assistant answered.';
        } else {
            status =
                this.lastAssistantText() ??
                "No conversation yet. The Assistant's work on this filter shows up here.";
        }
        this.$('[data-ref="conv-icon"]').innerHTML = this.streaming
            ? '<span class="gfe-spinner" aria-hidden="true"></span>'
            : `<span class="material-symbols-outlined gfe-status-icon">${lastEntry?.kind === 'error' ? 'error' : 'forum'}</span>`;
        this.$('[data-ref="conv-status"]').textContent = status;
        this.$('[data-ref="conv-body"]').hidden = !this.conversationOpen;
        const toggle = this.$<HTMLButtonElement>('[data-ref="conv-toggle"]');
        toggle.disabled = transcript.length === 0;
        toggle.setAttribute('aria-expanded', String(this.conversationOpen));
        this.$('[data-ref="conv-toggle-label"]').textContent = this
            .conversationOpen
            ? 'Hide conversation'
            : `Show conversation${transcript.length ? ` (${transcript.length})` : ''}`;
        // The rest of the dialog follows the streaming state too.
        if (this.mode === 'simple') this.renderSimple();
        else this.renderExpert();
    }

    private renderResults(): void {
        if (this.closed) return;
        const count = this.$('[data-ref="count"]');
        const legend = this.$('[data-ref="legend"]');
        const toggle = this.$<HTMLButtonElement>('[data-ref="glyphs-toggle"]');
        const preview = this.preview;
        const total = window.currentFontModel?.glyphs?.length ?? 0;
        if (this.sourceErrors.length || (preview && !preview.ok)) {
            // Code problems are listed in the footer; anything else (no
            // font yet, a runtime error) is said here.
            const runtime = !this.sourceErrors.length && preview?.errors[0];
            count.textContent = runtime
                ? `No preview: ${formatSourceError(runtime)}`
                : 'No preview until the filter is fixed';
            renderGlyphFilterLegend(legend, [], () => {});
            toggle.hidden = true;
            return;
        }
        if (!preview) {
            count.textContent = 'Checking the filter…';
            toggle.hidden = true;
            return;
        }
        count.innerHTML = `<b>${preview.glyphNames.length}</b> of ${total} glyphs`;
        renderGlyphFilterLegend(
            legend,
            preview.groups.length > 1
                ? preview.groups.map((group) => ({
                      keyword: group.name,
                      description: group.name,
                      color: group.color,
                      count: group.count
                  }))
                : [],
            (keyword) => {
                this.activeGroup =
                    this.activeGroup === keyword ? null : keyword;
                this.glyphsOpen = true;
                this.renderResults();
                void this.renderGlyphs();
            }
        );
        setGlyphFilterLegendActive(
            legend,
            new Set(this.activeGroup ? [this.activeGroup] : [])
        );
        this.clampLegend();
        toggle.hidden = preview.glyphNames.length === 0;
        toggle.setAttribute('aria-expanded', String(this.glyphsOpen));
        this.$('[data-ref="glyphs-toggle-label"]').textContent = this.glyphsOpen
            ? 'Hide glyphs'
            : 'Show glyphs';
    }

    /**
     * With the glyphs hidden, the group chips stop after two rows and a
     * "+N more" chip opens the glyphs, which show every chip.
     */
    private clampLegend(): void {
        const legend = this.$('[data-ref="legend"]');
        legend.querySelector('.gfe-legend-more')?.remove();
        const items = [
            ...legend.querySelectorAll<HTMLElement>('.glyph-filter-legend-item')
        ];
        items.forEach((item) => (item.hidden = false));
        if (this.glyphsOpen || items.length === 0) return;
        const rowTops = [...new Set(items.map((item) => item.offsetTop))].sort(
            (a, b) => a - b
        );
        if (rowTops.length <= 2) return;
        const lastRowTop = rowTops[1];
        let hiddenCount = 0;
        for (const item of items) {
            if (item.offsetTop > lastRowTop) {
                item.hidden = true;
                hiddenCount++;
            }
        }
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'glyph-filter-legend-item gfe-legend-more';
        more.title = 'Show all groups and their glyphs';
        more.addEventListener('click', () => {
            this.glyphsOpen = true;
            void this.renderGlyphs();
        });
        legend.appendChild(more);
        const visible = items.filter((item) => !item.hidden);
        const label = () => {
            more.textContent = `+${hiddenCount} more`;
        };
        label();
        // Make room for the chip itself on the second row.
        while (more.offsetTop > lastRowTop && visible.length > 0) {
            const item = visible.pop();
            if (item) item.hidden = true;
            hiddenCount++;
            label();
        }
    }

    private async renderGlyphs(): Promise<void> {
        if (this.closed) return;
        this.renderResults();
        const panel = this.$('[data-ref="glyphs"]');
        const preview = this.preview;
        const show =
            this.glyphsOpen &&
            !!preview?.ok &&
            preview.glyphNames.length > 0 &&
            !this.sourceErrors.length;
        // Hiding keeps the painted tiles, so showing them again is instant;
        // destroy() releases them when the dialog closes.
        panel.hidden = !show;
        if (!show) return;
        if (!this.glyphView) {
            const tiles = this.$('[data-ref="tiles"]');
            this.glyphView = new GlyphOverviewView(tiles, {
                tileCacheBudgetBytes: PREVIEW_TILE_CACHE_BYTES
            });
            panel.insertBefore(this.glyphView.controlsElement, tiles);
        }
        // Like the main overview: switching groups only filters the tiles
        // that are there. Glyphs and groups are pushed only when the dry run
        // gave a different answer.
        const glyphsKey = preview.glyphNames.join('\n');
        if (glyphsKey !== this.viewGlyphsKey) {
            this.viewGlyphsKey = glyphsKey;
            const names = new Set(preview.glyphNames);
            const records = (window.currentFontModel?.glyphs ?? [])
                .filter((glyph) => names.has(glyph.name))
                .map((glyph) => ({
                    id: glyph.name,
                    name: glyph.name,
                    codepoints: glyph.codepoints ?? []
                }));
            await this.glyphView.setGlyphs(records);
            if (this.closed) return;
        }
        const groupsKey = JSON.stringify(preview.results);
        if (groupsKey !== this.viewGroupsKey) {
            this.viewGroupsKey = groupsKey;
            this.glyphView.setGroups(preview.results);
        }
        this.glyphView.setActiveGroup(this.activeGroup);
    }

    private renderFooter(): void {
        if (this.closed) return;
        const error = this.saveError ?? this.blockingError();
        const errorElement = this.$('[data-ref="error"]');
        errorElement.hidden = !error;
        errorElement.innerHTML = error
            ? `${icon('error')}${escapeHtml(error)}`
            : '';

        let pending = '';
        if (this.saving) pending = 'Saving…';
        else if (this.streaming)
            pending = 'The Assistant is working. OK waits for it to finish.';
        else if (this.ai && this.handEdited() && this.code !== this.appliedCode)
            pending =
                'OK updates the description from your code edits, then saves.';
        else if (this.unsentDescription())
            pending = 'The new description is not applied yet.';
        else if (this.isDirty())
            pending = this.isNew
                ? `OK creates Filters/${normalizeFilterName(this.name)}.py`
                : 'Unsaved changes';
        this.$('[data-ref="pending"]').textContent = pending;

        const asking = this.asking !== null;
        this.$('[data-ref="confirm-cancel"]').hidden = this.asking !== 'cancel';
        this.$('[data-ref="confirm-ok"]').hidden = this.asking !== 'ok';
        this.$('[data-ref="cancel"]').hidden = asking;
        this.$('[data-ref="pending"]').hidden = asking;
        // EVENT_TYPES = [] is valid, but a filter that reads outlines or
        // Unicode values would then go stale: say what it reacts to.
        this.$('[data-ref="events-hint"]').hidden =
            asking ||
            !!error ||
            this.eventTypes === null ||
            this.eventTypes.length > 0;
        const ok = this.$<HTMLButtonElement>('[data-ref="ok"]');
        ok.hidden = asking;
        ok.disabled = !!this.blockingError() || this.saving;
    }
}
