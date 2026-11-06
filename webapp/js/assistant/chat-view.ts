// Renders one AssistantChatSession into a root element. Every Assistant chat
// (the panel, the filter editor) uses this view, so they all look the same.

import tippy, { type Placement } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import '../../css/assistant-chat.css';
import { getTheme } from '../tippy-utils';
import { rewriteHtmlAnchorsForDocs } from '../link-navigation';
import type { UsageMetrics } from '../assistant-config';
import type {
    AssistantChatSession,
    ChatAssistantEntry,
    ChatToolCallRecord,
    ChatTranscriptEntry,
    ChatTurnItem
} from './chat-session';

export function escapeHtml(text: string): string {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(text));
    return d.innerHTML;
}

export function highlightPython(code: string): string {
    let html = escapeHtml(code);
    // Triple-quoted strings (must come before single-line strings)
    html = html.replace(
        /(&quot;&quot;&quot;[\s\S]*?&quot;&quot;&quot;|&#x27;&#x27;&#x27;[\s\S]*?&#x27;&#x27;&#x27;)/g,
        '<span style="color:var(--accent-orange)">$1</span>'
    );
    html = html.replace(
        /(#[^\n]*)/g,
        '<span style="color:var(--accent-green);font-style:italic">$1</span>'
    );
    // F-strings (before regular strings)
    html = html.replace(
        /(f&quot;[^&]*?&quot;|f&#x27;[^&]*?&#x27;)/g,
        '<span style="color:var(--accent-magenta)">$1</span>'
    );
    html = html.replace(
        /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,
        '<span style="color:var(--accent-orange)">$1</span>'
    );
    html = html.replace(
        /\b(def|class|if|elif|else|for|while|import|from|as|return|yield|try|except|finally|raise|with|pass|break|continue|and|or|not|in|is|lambda|async|await|True|False|None|self|del|global|nonlocal|assert)\b/g,
        '<span style="color:var(--accent-blue);font-weight:bold">$1</span>'
    );
    html = html.replace(
        /\b(print|len|range|int|str|float|list|dict|set|tuple|type|open|map|filter|zip|enumerate|sorted|reversed|abs|min|max|sum|any|all|isinstance|hasattr|getattr|setattr|super|property|staticmethod|classmethod|object|__init__|__str__|__repr__|__len__|__getitem__|__setitem__|__delitem__|__iter__|__next__|__enter__|__exit__)\b/g,
        '<span style="color:var(--accent-cyan)">$1</span>'
    );
    html = html.replace(
        /\b(\d+\.?\d*)\b/g,
        '<span style="color:var(--accent-magenta)">$1</span>'
    );
    return html;
}

/** Dev-mode token and cost summary. */
export function formatUsageMetrics(
    usage: UsageMetrics | null | undefined
): string {
    if (!usage) return '';
    const parts: string[] = [];
    if (usage.prompt_tokens != null) parts.push(`in: ${usage.prompt_tokens}`);
    if (usage.completion_tokens != null)
        parts.push(`out: ${usage.completion_tokens}`);
    if (usage.cached_tokens != null)
        parts.push(`cached: ${usage.cached_tokens}`);
    if (usage.total_cost != null) parts.push(`$${usage.total_cost.toFixed(6)}`);
    else if (usage.cost_eur_cents != null)
        parts.push(`${usage.cost_eur_cents}c`);
    return parts.length > 0 ? parts.join(' · ') : '';
}

function renderMarkdown(text: string): string {
    return typeof marked !== 'undefined'
        ? rewriteHtmlAnchorsForDocs(marked.parse(text))
        : escapeHtml(text);
}

/** A Tippy popup whose content is rebuilt each time it opens. */
export function attachChatPopup(
    button: HTMLElement,
    contentFactory: () => HTMLElement,
    placement: Placement = 'right',
    maxWidth = 520
): void {
    tippy(button, {
        content: contentFactory(),
        allowHTML: true,
        interactive: true,
        appendTo: document.body,
        maxWidth,
        placement,
        zIndex: 99999,
        theme: getTheme(),
        popperOptions: {
            modifiers: [
                {
                    name: 'preventOverflow',
                    options: { boundary: 'viewport', padding: 12 }
                }
            ]
        },
        onShow: (instance) => {
            instance.setContent(contentFactory());
        },
        onMount(instance) {
            const content = instance.popper.querySelector(
                '.tippy-content'
            ) as HTMLElement | null;
            if (content) {
                content.style.maxHeight = '70vh';
                content.style.overflowY = 'auto';
            }
        }
    });
}

function toolCallHasNoArguments(args: Record<string, unknown>): boolean {
    return Object.keys(args).length === 0;
}

function createInfoButton(title: string, extraClass = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `assistant-tool-call-info-btn${extraClass ? ` ${extraClass}` : ''}`;
    button.textContent = 'ⓘ';
    button.title = title;
    return button;
}

/** The ⓘ details of one tool call: arguments, result and edit actions. */
export function createToolCallDetailsElement(
    session: AssistantChatSession,
    toolName: string,
    args: Record<string, unknown>,
    toolResult: string,
    timeLabel: string
): HTMLElement {
    const metaEl = document.createElement('div');
    metaEl.style.cssText =
        'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';

    const argsHtml =
        toolName === 'execute_python_code' && typeof args.code === 'string'
            ? `<b>Arguments:</b><br><pre style="margin:4px 0 0 0;padding:8px;background:var(--background-hover);border-radius:4px;font-size:11px;line-height:1.5;overflow-x:auto;font-family:var(--font-families-mono);tab-size:4">${highlightPython(args.code)}</pre>`
            : `<b>Arguments:</b> ${escapeHtml(JSON.stringify(args, null, 2))}`;

    metaEl.innerHTML = `
        <b>Tool:</b> ${escapeHtml(toolName)}<br>
        ${argsHtml}<br>
        <b>Result:</b> ${toolResult.length} characters<br>
        <b>Time:</b> ${escapeHtml(timeLabel)}<br>
        <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${escapeHtml(toolResult)}</pre>
    `;

    if (
        toolName === 'replace_python_text_in_editor' &&
        typeof args.old_text === 'string' &&
        typeof args.new_text === 'string'
    ) {
        addPythonDocumentToolActions(
            session,
            metaEl,
            { old_text: args.old_text, new_text: args.new_text },
            toolResult
        );
    }
    return metaEl;
}

function addPythonDocumentToolActions(
    session: AssistantChatSession,
    metaEl: HTMLElement,
    args: { old_text: string; new_text: string },
    toolResult: string
): void {
    const revision = toolResult.match(/^Revision: (.+)$/m)?.[1];
    const target = session.target;
    if (!revision || !target) return;

    const actions = document.createElement('div');
    actions.style.cssText =
        'display:flex;gap:4px;margin-top:6px;align-items:center;';
    const status = document.createElement('span');
    status.style.cssText = 'font-size:10px;';

    if (target.reveal) {
        const reveal = target.reveal;
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.title = reveal.label;
        openButton.setAttribute('aria-label', reveal.label);
        openButton.innerHTML = `<span class="material-symbols-outlined">${escapeHtml(reveal.icon)}</span>`;
        openButton.addEventListener('click', () => reveal.run());
        actions.appendChild(openButton);
    }

    const revertButton = document.createElement('button');
    revertButton.type = 'button';
    revertButton.title = 'Revert this Assistant edit';
    revertButton.setAttribute('aria-label', 'Revert this Assistant edit');
    revertButton.innerHTML =
        '<span class="material-symbols-outlined">undo</span>';
    revertButton.addEventListener('click', () => {
        if (!session.editPermissions().documentEdits) {
            status.textContent = `${session.profile.editDisabledHint} before reverting.`;
            return;
        }
        let currentRevision: string | null = null;
        try {
            currentRevision = target.getDocumentState().revision;
        } catch {
            currentRevision = null;
        }
        if (currentRevision !== revision) {
            status.textContent = `The script changed since this Assistant edit. Use the ${target.label} recovery controls instead.`;
            return;
        }
        try {
            const restored = target.replaceExactText(
                args.new_text,
                args.old_text,
                revision
            );
            session.markDocumentRead(restored.revision);
            revertButton.disabled = true;
            status.textContent = 'Assistant edit reverted, not saved.';
        } catch (error) {
            status.textContent = (error as Error).message;
        }
    });

    actions.append(revertButton, status);
    metaEl.appendChild(actions);
}

function createToolCallOutputElement(
    toolName: string,
    toolResult: string,
    timeLabel: string
): HTMLElement {
    const outputEl = document.createElement('div');
    outputEl.style.cssText =
        'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';
    outputEl.innerHTML = `
        <b>Tool:</b> ${escapeHtml(toolName)}<br>
        <b>Time:</b> ${escapeHtml(timeLabel)}<br>
        <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${escapeHtml(toolResult)}</pre>
    `;
    return outputEl;
}

function createTurnToolCallsElement(
    toolCalls: ChatToolCallRecord[]
): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'min-width:260px;max-width:420px;padding:4px;color:var(--text-primary);';

    const title = document.createElement('div');
    title.textContent = 'Tool calls';
    title.style.cssText =
        'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary);';
    wrapper.appendChild(title);

    if (toolCalls.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No tool calls recorded.';
        empty.style.cssText = 'font-size:11px;color:var(--text-tertiary);';
        wrapper.appendChild(empty);
        return wrapper;
    }

    for (const call of toolCalls) {
        const row = document.createElement('div');
        row.style.cssText =
            'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--border-primary);';
        const left = document.createElement('div');
        left.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const name = document.createElement('span');
        name.textContent = call.name;
        name.style.cssText =
            'font-size:11px;font-family:var(--font-families-mono);color:var(--text-primary);';
        left.appendChild(name);

        const noArguments = toolCallHasNoArguments(call.args);
        if (noArguments) {
            const infoBtn = createInfoButton('Show tool output');
            attachChatPopup(infoBtn, () =>
                createToolCallOutputElement(
                    call.name,
                    call.result ?? '',
                    call.timeLabel ?? ''
                )
            );
            left.appendChild(infoBtn);
        }

        const meta = document.createElement('span');
        meta.textContent = noArguments
            ? 'no arguments'
            : `${Object.keys(call.args).length} args`;
        meta.style.cssText =
            'font-size:10px;color:var(--text-tertiary);white-space:nowrap;';
        row.append(left, meta);
        wrapper.appendChild(row);
    }
    return wrapper;
}

type PythonDiffRow = {
    type: 'context' | 'removed' | 'added' | 'omitted';
    oldLine?: number;
    newLine?: number;
    text: string;
};

export function createPythonLineDiffRows(
    oldText: string,
    newText: string
): PythonDiffRow[] {
    const oldLines = oldText.split(/\r?\n/);
    const newLines = newText.split(/\r?\n/);
    const lengths = Array.from(
        { length: oldLines.length + 1 },
        () => Array(newLines.length + 1).fill(0) as number[]
    );
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
            lengths[oldIndex][newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? lengths[oldIndex + 1][newIndex + 1] + 1
                    : Math.max(
                          lengths[oldIndex + 1][newIndex],
                          lengths[oldIndex][newIndex + 1]
                      );
        }
    }

    const rows: PythonDiffRow[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
        if (
            oldIndex < oldLines.length &&
            newIndex < newLines.length &&
            oldLines[oldIndex] === newLines[newIndex]
        ) {
            rows.push({
                type: 'context',
                oldLine: oldIndex + 1,
                newLine: newIndex + 1,
                text: oldLines[oldIndex]
            });
            oldIndex++;
            newIndex++;
        } else if (
            newIndex < newLines.length &&
            (oldIndex >= oldLines.length ||
                lengths[oldIndex][newIndex + 1] >
                    lengths[oldIndex + 1][newIndex])
        ) {
            rows.push({
                type: 'added',
                newLine: newIndex + 1,
                text: newLines[newIndex]
            });
            newIndex++;
        } else {
            rows.push({
                type: 'removed',
                oldLine: oldIndex + 1,
                text: oldLines[oldIndex]
            });
            oldIndex++;
        }
    }
    return collapsePythonDiffContextRows(rows);
}

function collapsePythonDiffContextRows(rows: PythonDiffRow[]): PythonDiffRow[] {
    const contextRadius = 2;
    const changedIndexes = rows
        .map((row, index) => (row.type === 'context' ? -1 : index))
        .filter((index) => index >= 0);
    if (changedIndexes.length === 0) return rows;

    const keep = new Set<number>();
    for (const changedIndex of changedIndexes) {
        for (
            let index = Math.max(0, changedIndex - contextRadius);
            index <= Math.min(rows.length - 1, changedIndex + contextRadius);
            index++
        ) {
            keep.add(index);
        }
    }

    const omitted = (count: number): PythonDiffRow => ({
        type: 'omitted',
        text: `${count} unchanged line${count === 1 ? '' : 's'} hidden`
    });
    const collapsed: PythonDiffRow[] = [];
    let omittedCount = 0;
    for (let index = 0; index < rows.length; index++) {
        if (keep.has(index) || rows[index].type !== 'context') {
            if (omittedCount > 0) {
                collapsed.push(omitted(omittedCount));
                omittedCount = 0;
            }
            collapsed.push(rows[index]);
        } else {
            omittedCount++;
        }
    }
    if (omittedCount > 0) collapsed.push(omitted(omittedCount));
    return collapsed;
}

/** A compact unified-style diff as text, e.g. for a chat message. */
export function formatPythonLineDiff(oldText: string, newText: string): string {
    return createPythonLineDiffRows(oldText, newText)
        .map((row) => {
            if (row.type === 'omitted') return `… ${row.text}`;
            const mark =
                row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
            return `${mark} ${row.text}`;
        })
        .join('\n');
}

function renderPythonLineDiffRows(rows: PythonDiffRow[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'assistant-python-edit-diff-rows';
    for (const row of rows) {
        const line = document.createElement('div');
        line.className = `assistant-python-edit-diff-row assistant-python-edit-diff-row-${row.type}`;
        const marker = document.createElement('span');
        marker.className = 'assistant-python-edit-diff-marker';
        const text = document.createElement('span');
        text.textContent = row.text;
        marker.textContent =
            row.type === 'added'
                ? `+${row.newLine || ''}`
                : row.type === 'removed'
                  ? `-${row.oldLine || ''}`
                  : row.type === 'omitted'
                    ? '...'
                    : ` ${row.oldLine || row.newLine || ''}`;
        line.append(marker, text);
        list.appendChild(line);
    }
    return list;
}

function createInlinePythonEditDiffElement(
    toolResult: string,
    args: Record<string, unknown>
): HTMLElement {
    const outputEl = document.createElement('div');
    outputEl.className = 'assistant-python-edit-diff';

    const diffHeader = /^@@ .+ @@$/m.exec(toolResult);
    const diffStart = diffHeader ? diffHeader.index : -1;
    const summary = diffStart >= 0 ? toolResult.slice(0, diffStart).trim() : '';
    const title = document.createElement('div');
    title.className = 'assistant-python-edit-diff-title';
    title.textContent = 'Python edit diff';
    outputEl.appendChild(title);

    if (summary) {
        const summaryEl = document.createElement('div');
        summaryEl.className = 'assistant-python-edit-diff-summary';
        summaryEl.textContent = summary;
        outputEl.appendChild(summaryEl);
    }

    if (
        typeof args.old_text === 'string' &&
        typeof args.new_text === 'string'
    ) {
        outputEl.appendChild(
            renderPythonLineDiffRows(
                createPythonLineDiffRows(args.old_text, args.new_text)
            )
        );
    } else {
        const pre = document.createElement('pre');
        pre.className = 'assistant-python-edit-diff-raw';
        pre.textContent = (
            diffStart >= 0 ? toolResult.slice(diffStart) : toolResult
        ).trim();
        outputEl.appendChild(pre);
    }
    return outputEl;
}

type TurnElements = {
    header: HTMLElement;
    body: HTMLElement;
    toolCalls: ChatToolCallRecord[];
    toolCallsButton: HTMLButtonElement | null;
};

type ItemElements = { main: HTMLElement; extra: HTMLElement | null };

/**
 * Renders a session's transcript into `root` and follows its events. The
 * root gets the `assistant-chat` class, which scopes the chat stylesheet;
 * the host supplies the input field and buttons.
 */
export class AssistantChatView {
    readonly root: HTMLElement;
    private session: AssistantChatSession;
    private subscriptions: Array<() => void> = [];
    private turns = new WeakMap<ChatAssistantEntry, TurnElements>();
    private items = new WeakMap<ChatTurnItem, ItemElements>();
    private statusEl: HTMLElement | null = null;

    constructor(root: HTMLElement, session: AssistantChatSession) {
        this.root = root;
        this.session = session;
        root.classList.add('assistant-chat');
        this.subscribe();
        this.render();
    }

    get currentSession(): AssistantChatSession {
        return this.session;
    }

    /** Show another session, e.g. a fork, in the same root. */
    setSession(session: AssistantChatSession): void {
        this.unsubscribe();
        this.session = session;
        this.subscribe();
        this.render();
    }

    /** Rebuild the whole transcript from the session. */
    render(): void {
        this.turns = new WeakMap();
        this.items = new WeakMap();
        this.statusEl = null;
        this.root.replaceChildren();
        for (const entry of this.session.transcript) {
            this.appendEntry(entry);
        }
        this.setStatus(this.session.status);
        this.root.scrollTop = this.root.scrollHeight;
    }

    dispose(): void {
        this.unsubscribe();
        this.root.classList.remove('assistant-chat');
    }

    private subscribe(): void {
        const session = this.session;
        this.subscriptions = [
            session.on('entry-added', ({ entry }) => {
                this.appendEntry(entry);
                if (entry.kind === 'assistant') this.scrollToBottomIfNear();
                else this.root.scrollTop = this.root.scrollHeight;
            }),
            session.on('item-added', ({ entry, item }) => {
                this.appendItem(entry, item);
                this.scrollToBottomIfNear();
            }),
            session.on('item-updated', ({ entry, item }) => {
                this.updateItem(entry, item);
                this.scrollToBottomIfNear();
            }),
            session.on('status', ({ text }) => this.setStatus(text)),
            session.on('reset', () => this.render())
        ];
    }

    private unsubscribe(): void {
        this.subscriptions.forEach((off) => off());
        this.subscriptions = [];
    }

    private scrollToBottomIfNear(threshold = 150): void {
        const dist =
            this.root.scrollHeight -
            this.root.scrollTop -
            this.root.clientHeight;
        if (dist < threshold) this.root.scrollTop = this.root.scrollHeight;
    }

    /** Append to the root, keeping the status line last. */
    private appendToRoot(element: HTMLElement): void {
        if (this.statusEl?.parentElement === this.root) {
            this.root.insertBefore(element, this.statusEl);
        } else {
            this.root.appendChild(element);
        }
    }

    private setStatus(text: string | null): void {
        if (!text) {
            this.statusEl?.remove();
            this.statusEl = null;
            return;
        }
        if (!this.statusEl) {
            this.statusEl = document.createElement('div');
            this.statusEl.className = 'assistant-thinking';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            const label = document.createElement('span');
            label.className = 'assistant-thinking-text';
            this.statusEl.append(spinner, label);
            this.root.appendChild(this.statusEl);
        }
        const label = this.statusEl.querySelector('.assistant-thinking-text');
        if (label) label.textContent = text;
        this.root.scrollTop = this.root.scrollHeight;
    }

    private createHeader(icon: string, label: string): HTMLElement {
        const header = document.createElement('div');
        header.className = 'assistant-message-header';
        const iconEl = document.createElement('span');
        iconEl.className = 'material-symbols-outlined';
        iconEl.textContent = icon;
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        header.append(iconEl, labelEl);
        return header;
    }

    private appendEntry(entry: ChatTranscriptEntry): void {
        const messageDiv = document.createElement('div');
        if (entry.kind === 'assistant') {
            messageDiv.className =
                'assistant-message assistant-message-assistant';
            const header = this.createHeader('robot_2', 'Assistant');
            const body = document.createElement('div');
            body.className = 'assistant-message-body';
            messageDiv.append(header, body);
            this.turns.set(entry, {
                header,
                body,
                toolCalls: [],
                toolCallsButton: null
            });
            this.appendToRoot(messageDiv);
            entry.items.forEach((item) => this.appendItem(entry, item));
            return;
        }
        if (entry.kind === 'user') {
            messageDiv.className = `assistant-message assistant-message-user${
                entry.automatic ? ' assistant-message-automatic' : ''
            }`;
            messageDiv.appendChild(
                entry.automatic
                    ? this.createHeader('sync', 'Sent automatically')
                    : this.createHeader('person', 'You')
            );
        } else {
            messageDiv.className = 'assistant-message assistant-message-error';
            messageDiv.appendChild(this.createHeader('error', 'Error'));
        }
        messageDiv.appendChild(document.createTextNode(entry.text));
        this.appendToRoot(messageDiv);
    }

    private appendItem(entry: ChatAssistantEntry, item: ChatTurnItem): void {
        const turn = this.turns.get(entry);
        if (!turn) return;
        if (item.kind === 'text') {
            const textEl = document.createElement('div');
            textEl.className = 'assistant-round-text';
            turn.body.appendChild(textEl);
            this.items.set(item, { main: textEl, extra: null });
            this.updateItem(entry, item);
        } else if (item.kind === 'notice') {
            const notice = document.createElement('div');
            notice.className = 'assistant-connection-dropped';
            notice.textContent = item.text;
            turn.body.appendChild(notice);
            this.items.set(item, { main: notice, extra: null });
        } else {
            const call = item.call;
            const line = document.createElement('div');
            line.className = 'assistant-tool-call-line';
            line.textContent = `Calling ${call.name}`;
            const infoBtn = createInfoButton('Show tool call details');
            line.appendChild(infoBtn);
            attachChatPopup(infoBtn, () =>
                createToolCallDetailsElement(
                    this.session,
                    call.name,
                    call.args,
                    call.result ?? '(running)',
                    call.timeLabel ?? ''
                )
            );
            turn.body.appendChild(line);
            this.items.set(item, { main: line, extra: null });
            if (call.result !== null) this.updateItem(entry, item);
        }
    }

    private updateItem(entry: ChatAssistantEntry, item: ChatTurnItem): void {
        const turn = this.turns.get(entry);
        const elements = this.items.get(item);
        if (!turn || !elements) return;
        if (item.kind === 'text') {
            elements.main.innerHTML = renderMarkdown(item.text);
            const metrics = formatUsageMetrics(item.usage);
            if (metrics && !elements.extra && window.isDevelopment?.()) {
                const metricsEl = document.createElement('div');
                metricsEl.className = 'assistant-round-metrics';
                metricsEl.textContent = metrics;
                elements.main.insertAdjacentElement('afterend', metricsEl);
                elements.extra = metricsEl;
            }
            return;
        }
        if (item.kind !== 'tool') return;
        const call = item.call;
        const result = call.result;
        if (result === null) return;
        if (!turn.toolCalls.includes(call)) {
            turn.toolCalls.push(call);
            this.updateToolCallsButton(turn);
        }
        if (
            !elements.extra &&
            call.name === 'replace_python_text_in_editor' &&
            !result.startsWith('Error:')
        ) {
            elements.extra = createInlinePythonEditDiffElement(
                result,
                call.args
            );
            elements.main.insertAdjacentElement('afterend', elements.extra);
        }
    }

    private updateToolCallsButton(turn: TurnElements): void {
        if (!turn.toolCallsButton) {
            const button = createInfoButton(
                'Show tool calls',
                'assistant-message-info-btn'
            );
            turn.header.appendChild(button);
            attachChatPopup(
                button,
                () => createTurnToolCallsElement(turn.toolCalls),
                'bottom-end',
                440
            );
            turn.toolCallsButton = button;
        }
        turn.toolCallsButton.style.display =
            turn.toolCalls.length > 0 ? 'inline-flex' : 'none';
    }
}
