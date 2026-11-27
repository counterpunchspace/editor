// Title-bar health chip: delayed warnings for wedged editing, not slow compiles.

import { Logger } from './logger';
import { escapeHtml } from './ui/escape-html';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('EditorHealth');

export const UI_BLOCK_REVEAL_MS = 1000;
export const STACK_STALL_REVEAL_MS = 1200;
export const INTERPOLATE_SILENCE_REVEAL_MS = 4000;
export const UNMATCHED_REPLY_REVEAL_MS = 1000;
export const PROCESS_SUSPICION_WINDOW_MS = 5000;

const POLL_MS = 250;
const SESSION_FLAG = 'cp-editor-health-unhealthy';

export type EditorHealthIssueId =
    | 'ui-blocked'
    | 'stack-stall'
    | 'worker-silent'
    | 'unmatched-interpolate'
    | 'process-suspicion';

export type EditorHealthIssue = {
    id: EditorHealthIssueId;
    title: string;
    explanation: string;
    recovery: string;
};

export type EditorHealthSnapshot = {
    now: number;
    propertiesUpdateStartedAt: number | null;
    propertiesUpdateSkipCount: number;
    editMode: boolean;
    selectedGlyphName: string | null;
    glyphStack: string;
    drawingDataPresent: boolean;
    glyphSelectedAt: number | null;
    pendingInterpolateCount: number;
    oldestPendingInterpolateAt: number | null;
    pendingCompileCount: number;
    lastWorkerMessageAt: number | null;
    unmatchedInterpolateCount: number;
    unmatchedInterpolateAt: number | null;
    pageLoadedAt: number;
    priorSessionWasUnhealthy: boolean;
};

function formatAge(ms: number): string {
    if (ms < 1500) {
        return `${Math.round(ms)} ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }
    return `${Math.round(ms / 1000)} s`;
}

function hasExplainedWork(snapshot: EditorHealthSnapshot): boolean {
    return (
        snapshot.pendingCompileCount > 0 ||
        snapshot.pendingInterpolateCount > 0 ||
        snapshot.propertiesUpdateStartedAt != null
    );
}

export function evaluateEditorHealth(
    snapshot: EditorHealthSnapshot
): EditorHealthIssue[] {
    const issues: EditorHealthIssue[] = [];
    const { now } = snapshot;

    if (
        snapshot.propertiesUpdateStartedAt != null &&
        now - snapshot.propertiesUpdateStartedAt >= UI_BLOCK_REVEAL_MS
    ) {
        const skips =
            snapshot.propertiesUpdateSkipCount > 0
                ? ` ${snapshot.propertiesUpdateSkipCount} later glyph switch(es) were skipped while it was held.`
                : '';
        issues.push({
            id: 'ui-blocked',
            title: 'Properties update did not finish',
            explanation: `The editor is still inside a properties-panel update that started ${formatAge(now - snapshot.propertiesUpdateStartedAt)} ago. Glyph switches clear the stack first and then skip rebuilding it until that update ends.${skips}`,
            recovery:
                'Reload this tab. If outlines still do not follow glyph switches, close every other Counterpunch window and reload again.'
        });
    }

    const glyphName = snapshot.selectedGlyphName;
    const glyphLooksReal =
        Boolean(glyphName) &&
        glyphName !== 'undefined' &&
        !glyphName!.startsWith('GID ');

    if (
        snapshot.editMode &&
        glyphLooksReal &&
        !snapshot.glyphStack &&
        !snapshot.drawingDataPresent &&
        !hasExplainedWork(snapshot) &&
        snapshot.glyphSelectedAt != null &&
        now - snapshot.glyphSelectedAt >= STACK_STALL_REVEAL_MS
    ) {
        issues.push({
            id: 'stack-stall',
            title: 'Glyph stack never rebuilt',
            explanation: `Edit mode is on “${glyphName}”, but the glyph stack is empty and no compile, interpolate, or properties update is in flight. That usually means the switch cleared the stack and the follow-up UI update never ran.`,
            recovery:
                'Click another glyph, then click this one again. If the stack stays (none), reload this tab.'
        });
    }

    if (
        snapshot.pendingInterpolateCount > 0 &&
        snapshot.pendingCompileCount === 0 &&
        snapshot.oldestPendingInterpolateAt != null &&
        now - snapshot.oldestPendingInterpolateAt >=
            INTERPOLATE_SILENCE_REVEAL_MS
    ) {
        const lastMsg = snapshot.lastWorkerMessageAt;
        const silent =
            lastMsg == null || now - lastMsg >= INTERPOLATE_SILENCE_REVEAL_MS;
        if (silent) {
            issues.push({
                id: 'worker-silent',
                title: 'Interpolation has no worker reply',
                explanation: `An outline interpolate has been waiting ${formatAge(now - snapshot.oldestPendingInterpolateAt)} with no compile in progress and no font-engine messages. Compiles of large fonts are treated as busy, not stuck. A silent interpolate usually means the worker reply was dropped or the worker thread is no longer running the event loop.`,
                recovery:
                    'Reload this tab. If it comes back immediately, quit Chrome fully or close other Counterpunch windows first.'
            });
        }
    }

    if (
        snapshot.unmatchedInterpolateCount > 0 &&
        snapshot.unmatchedInterpolateAt != null &&
        now - snapshot.unmatchedInterpolateAt >= UNMATCHED_REPLY_REVEAL_MS
    ) {
        issues.push({
            id: 'unmatched-interpolate',
            title: 'Worker replied to a request the editor already forgot',
            explanation: `The font worker sent ${snapshot.unmatchedInterpolateCount} interpolate result(s) that did not match a pending request. Ignoring those replies without finishing the waiting promise can leave the properties update hanging.`,
            recovery:
                'Reload this tab. Switching glyphs after a reload should request a fresh interpolate.'
        });
    }

    if (
        snapshot.priorSessionWasUnhealthy &&
        now - snapshot.pageLoadedAt <= PROCESS_SUSPICION_WINDOW_MS &&
        issues.length > 0
    ) {
        issues.push({
            id: 'process-suspicion',
            title: 'This tab came back already unhealthy',
            explanation:
                'The previous visit in this profile already showed an editor-health warning, and a warning appeared again within a few seconds of load. That pattern is more like a Chrome process problem than a slow compile. This page cannot see other origins, so this is only a suspicion.',
            recovery:
                'Close every Counterpunch window (preview, official, and localhost), then open only the one you need. A Chrome Guest window is a clean check that it is this profile.'
        });
    }

    return issues;
}

class EditorHealthMonitor {
    propertiesUpdateStartedAt: number | null = null;
    propertiesUpdateSkipCount = 0;
    unmatchedInterpolateCount = 0;
    unmatchedInterpolateAt: number | null = null;
    lastWorkerMessageAt: number | null = null;
    pageLoadedAt = Date.now();
    priorSessionWasUnhealthy = false;

    private lastGlyphKey = '';
    private glyphSelectedAt: number | null = null;
    private button: HTMLButtonElement | null = null;
    private overlay: HTMLElement | null = null;
    private escapeBinding: ModalEscapeBinding | null = null;
    private visibleIssues: EditorHealthIssue[] = [];
    private started = false;

    init() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.priorSessionWasUnhealthy = this.readSessionFlag();
        this.installChrome();
        setInterval(() => this.tick(), POLL_MS);
        window.addEventListener('beforeunload', () => {
            this.writeSessionFlag(this.visibleIssues.length > 0);
        });
        console.log('Editor health monitor started');
    }

    notePropertiesUpdateStarted() {
        if (this.propertiesUpdateStartedAt == null) {
            this.propertiesUpdateStartedAt = Date.now();
            this.propertiesUpdateSkipCount = 0;
        }
    }

    notePropertiesUpdateFinished() {
        this.propertiesUpdateStartedAt = null;
        this.propertiesUpdateSkipCount = 0;
    }

    notePropertiesUpdateSkipped() {
        if (this.propertiesUpdateStartedAt != null) {
            this.propertiesUpdateSkipCount += 1;
        }
    }

    noteWorkerMessage() {
        this.lastWorkerMessageAt = Date.now();
    }

    noteUnmatchedInterpolateReply() {
        this.unmatchedInterpolateCount += 1;
        if (this.unmatchedInterpolateAt == null) {
            this.unmatchedInterpolateAt = Date.now();
        }
        this.noteWorkerMessage();
    }

    private readSessionFlag(): boolean {
        try {
            return sessionStorage.getItem(SESSION_FLAG) === '1';
        } catch {
            return false;
        }
    }

    private writeSessionFlag(unhealthy: boolean) {
        try {
            if (unhealthy) {
                sessionStorage.setItem(SESSION_FLAG, '1');
            } else {
                sessionStorage.removeItem(SESSION_FLAG);
            }
        } catch {
            /* private mode */
        }
    }

    private collectSnapshot(now: number): EditorHealthSnapshot {
        const canvas = window.glyphCanvas;
        const interpolation = window.fontInterpolation;
        const compilation = window.fontCompilation;
        const editMode = Boolean(canvas?.outlineEditor?.active);
        let selectedGlyphName: string | null = null;
        try {
            const name = canvas?.getCurrentGlyphName?.();
            selectedGlyphName =
                typeof name === 'string' && name.length > 0 ? name : null;
        } catch {
            selectedGlyphName = canvas?.outlineEditor?.currentGlyphName ?? null;
        }

        const glyphKey = `${editMode ? 'e' : 't'}:${selectedGlyphName ?? ''}`;
        if (glyphKey !== this.lastGlyphKey) {
            this.lastGlyphKey = glyphKey;
            this.glyphSelectedAt = now;
        }

        let oldestPendingInterpolateAt: number | null = null;
        const pending = interpolation?.pendingRequests;
        if (pending && pending.size > 0) {
            for (const request of pending.values()) {
                const queuedAt = request.queuedAt;
                if (
                    typeof queuedAt === 'number' &&
                    (oldestPendingInterpolateAt == null ||
                        queuedAt < oldestPendingInterpolateAt)
                ) {
                    oldestPendingInterpolateAt = queuedAt;
                }
            }
            if (oldestPendingInterpolateAt == null) {
                oldestPendingInterpolateAt = now;
            }
        } else {
            this.unmatchedInterpolateCount = 0;
            this.unmatchedInterpolateAt = null;
        }

        return {
            now,
            propertiesUpdateStartedAt: this.propertiesUpdateStartedAt,
            propertiesUpdateSkipCount: this.propertiesUpdateSkipCount,
            editMode,
            selectedGlyphName,
            glyphStack: canvas?.outlineEditor?.glyphStack || '',
            drawingDataPresent: Boolean(canvas?.outlineEditor?.drawingData),
            glyphSelectedAt: this.glyphSelectedAt,
            pendingInterpolateCount: pending?.size ?? 0,
            oldestPendingInterpolateAt,
            pendingCompileCount: compilation?.pendingCompilations?.size ?? 0,
            lastWorkerMessageAt: this.lastWorkerMessageAt,
            unmatchedInterpolateCount: this.unmatchedInterpolateCount,
            unmatchedInterpolateAt: this.unmatchedInterpolateAt,
            pageLoadedAt: this.pageLoadedAt,
            priorSessionWasUnhealthy: this.priorSessionWasUnhealthy
        };
    }

    private tick() {
        const issues = evaluateEditorHealth(this.collectSnapshot(Date.now()));
        this.visibleIssues = issues;
        this.syncButton(issues);
        if (this.overlay?.style.display === 'flex') {
            this.renderModalBody(issues);
        }
    }

    private installChrome() {
        const actions = document.querySelector(
            '#view-editor .view-title-actions'
        );
        if (!actions) {
            console.warn('Editor title bar not found');
            return;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'editor-health-chip';
        button.className = 'editor-health-chip';
        button.hidden = true;
        button.tabIndex = -1;
        button.setAttribute('aria-hidden', 'true');
        button.title = 'Editor health';
        button.innerHTML =
            '<span class="material-symbols-outlined" aria-hidden="true">warning</span>';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.openModal();
        });
        actions.insertBefore(button, actions.firstChild);
        this.button = button;

        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.id = 'editor-health-popup';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="info-popup editor-health-popup" role="dialog" aria-labelledby="editor-health-title">
                <div class="info-popup-header">
                    <h3 id="editor-health-title">Editor health</h3>
                    <button type="button" class="info-popup-close" id="editor-health-close" aria-label="Close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content" id="editor-health-body"></div>
            </div>
        `;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                this.closeModal();
            }
        });
        overlay
            .querySelector('#editor-health-close')
            ?.addEventListener('click', () => this.closeModal());
        document.body.appendChild(overlay);
        this.overlay = overlay;
    }

    private syncButton(issues: EditorHealthIssue[]) {
        const button = this.button;
        if (!button) {
            return;
        }
        const show = issues.length > 0;
        button.hidden = !show;
        button.tabIndex = show ? 0 : -1;
        button.setAttribute('aria-hidden', show ? 'false' : 'true');
        if (!show) {
            return;
        }
        const lead = issues[0];
        button.title = lead.title;
        button.setAttribute('aria-label', `Editor health: ${lead.title}`);
        button.classList.toggle(
            'editor-health-chip-process',
            issues.some((issue) => issue.id === 'process-suspicion')
        );
    }

    private openModal() {
        const overlay = this.overlay;
        if (!overlay) {
            return;
        }
        this.renderModalBody(this.visibleIssues);
        overlay.style.display = 'flex';
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.closeModal(), {
            isOpen: () => overlay.style.display === 'flex'
        });
    }

    private closeModal() {
        this.escapeBinding?.release();
        this.escapeBinding = null;
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
    }

    private renderModalBody(issues: EditorHealthIssue[]) {
        const body = this.overlay?.querySelector('#editor-health-body');
        if (!body) {
            return;
        }
        if (issues.length === 0) {
            body.innerHTML =
                '<p>No current health warnings. In-flight compiles are treated as busy, not stuck.</p>';
            return;
        }
        body.innerHTML = issues
            .map(
                (issue) => `
            <section class="editor-health-issue" data-issue="${issue.id}">
                <h4>${escapeHtml(issue.title)}</h4>
                <p>${escapeHtml(issue.explanation)}</p>
                <p class="editor-health-recovery"><strong>What to do:</strong> ${escapeHtml(issue.recovery)}</p>
            </section>`
            )
            .join('');
    }
}

export const editorHealth = new EditorHealthMonitor();

function startEditorHealthMonitor() {
    editorHealth.init();
}

const runningUnderJest =
    typeof process !== 'undefined' && Boolean(process.env.JEST_WORKER_ID);

if (!runningUnderJest) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(startEditorHealthMonitor, 100);
        });
    } else {
        setTimeout(startEditorHealthMonitor, 100);
    }
}

window.editorHealth = editorHealth;
