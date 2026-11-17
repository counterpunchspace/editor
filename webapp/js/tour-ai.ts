/**
 * The tour’s two AI exercises: a glyph filter described in words, and a
 * question to the Assistant. Each can be tried (with a sign-up when signed
 * out) or skipped on its own; the slides in tour-slides.ts read the
 * outcome to decide what to show next.
 */

import type { AssistantTurnEndReason } from './assistant/chat-session';
import {
    closeGlyphFilterEditor,
    openGlyphFilterEditor,
    revealGlyphFilterEditorGlyphs,
    type GlyphFilterEditorClosedDetail,
    type GlyphFilterTurnFinishedDetail
} from './glyph-filter-editor-modal';
import { trackEditorEvent } from './editor-analytics';
import type { TourAdvanceControls } from './tour-slides';

export type TourAiStep = 'filter' | 'assistant';

/**
 * `trying` after Try it, `failed` when the AI did not finish (the slide
 * then offers to move on), `done` once the result is in.
 */
export type TourAiOutcome =
    'pending' | 'trying' | 'failed' | 'skipped' | 'done';

export const TOUR_FILTER_DESCRIPTION =
    'Show the alternate glyphs of each stylistic set, with each set in its own colored group.';
export const TOUR_ASSISTANT_PROMPT =
    'Can this font write Turkish, Polish and Vietnamese? If letters are missing, list them.';

const SIGN_UP_REASON =
    'Enter your email and we’ll send you a 6-digit code. A new email address creates your free account.';

type StepState = {
    outcome: TourAiOutcome;
    error: string | null;
    signIn: Promise<unknown> | null;
};

const steps: Record<TourAiStep, StepState> = {
    filter: { outcome: 'pending', error: null, signIn: null },
    assistant: { outcome: 'pending', error: null, signIn: null }
};

function track(step: TourAiStep, outcome: TourAiOutcome): void {
    trackEditorEvent('Tour AI step', { step, outcome });
}

export function resetTourAiSteps(): void {
    resetTourAiStep('filter');
    resetTourAiStep('assistant');
}

/** Back to the step’s first slide: close what it opened. */
export function resetTourAiStep(step: TourAiStep): void {
    closeTourAiUi();
    steps[step] = { outcome: 'pending', error: null, signIn: null };
}

export function tourAiOutcome(step: TourAiStep): TourAiOutcome {
    return steps[step].outcome;
}

export function tourAiError(step: TourAiStep): string {
    return steps[step].error ?? 'The Assistant did not finish.';
}

/** Try it, on the step’s first slide. */
export function tryTourAiStep(step: TourAiStep): void {
    steps[step].outcome = 'trying';
    track(step, 'trying');
}

/** Skip, from any slide of the step. A failed step stays failed. */
export function skipTourAiStep(step: TourAiStep): void {
    closeTourAiUi();
    if (step === 'assistant' && window.aiAssistant?.session?.isStreaming) {
        window.aiAssistant.session.stop();
    }
    const state = steps[step];
    if (state.outcome !== 'failed') {
        state.outcome = 'skipped';
        track(step, 'skipped');
    }
}

function finishTourAiStep(step: TourAiStep): void {
    steps[step].outcome = 'done';
    track(step, 'done');
}

function failTourAiStep(step: TourAiStep, reason: AssistantTurnEndReason) {
    steps[step].outcome = 'failed';
    steps[step].error =
        reason === 'connection-lost'
            ? 'The connection to the Assistant was lost.'
            : reason === 'stopped'
              ? 'The Assistant was stopped.'
              : 'The Assistant ran into an error.';
    track(step, 'failed');
}

export function isTourSignedIn(): boolean {
    return isSignedIn();
}

function isSignedIn(): boolean {
    return window.authManager?.isAuthenticated?.() === true;
}

export function needsTourSignUp(step: TourAiStep): boolean {
    return steps[step].outcome === 'trying' && !isSignedIn();
}

/** Lets the tooltip sit beside the filter editor (tour.css). */
const DIALOG_ASIDE_CLASS = 'tour-dialog-aside';

function closeTourAiUi(): void {
    document.body.classList.remove(DIALOG_ASIDE_CLASS);
    closeGlyphFilterEditor();
    document
        .querySelector<HTMLButtonElement>(
            '.sign-in-dialog [data-role="cancel"]'
        )
        ?.click();
}

// ── Sign-up ─────────────────────────────────────────────────────────────

export function openTourSignUp(step: TourAiStep): void {
    steps[step].signIn =
        window.authManager?.signIn?.({
            reason: SIGN_UP_REASON
        }) ?? Promise.resolve(null);
}

/** Moves on once signed in; closing the dialog skips the step. */
export function bindTourSignUp(
    step: TourAiStep
): (controls: TourAdvanceControls) => () => void {
    return ({ advance, skip }) => {
        let bound = true;
        void steps[step].signIn?.then((user) => {
            if (!bound) return;
            if (user) advance();
            else skip();
        });
        return () => {
            bound = false;
        };
    };
}

// ── Glyph filter ────────────────────────────────────────────────────────

export async function openTourFilterEditor(): Promise<void> {
    document.body.classList.add(DIALOG_ASIDE_CLASS);
    window.addEventListener(
        'glyphFilterEditorClosed',
        () => document.body.classList.remove(DIALOG_ASIDE_CLASS),
        { once: true }
    );
    await openGlyphFilterEditor({
        description: TOUR_FILTER_DESCRIPTION,
        confirmDiscard: false
    });
}

export function revealTourFilterGlyphs(): void {
    revealGlyphFilterEditorGlyphs();
}

function onFilterEditorCancelled(skip: () => void): (event: Event) => void {
    return (event) => {
        const detail = (event as CustomEvent<GlyphFilterEditorClosedDetail>)
            .detail;
        if (!detail?.saved) skip();
    };
}

/**
 * Moves on when the user clicks the User Filters **+**. The tour opens its
 * own filter editor next, with the description filled in, so the click
 * stops here.
 */
export function bindTourFilterNewButton({
    advance
}: TourAdvanceControls): () => void {
    const onClick = (event: MouseEvent) => {
        const target = event.target;
        if (
            !(target instanceof Element) ||
            !target.closest('.glyph-filter-new-btn')
        ) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        advance();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
}

/** Moves on when the Assistant’s first filter turn ends, however it ended. */
export function bindTourFilterTurn({
    advance,
    skip
}: TourAdvanceControls): () => void {
    const onTurn = (event: Event) => {
        const reason = (event as CustomEvent<GlyphFilterTurnFinishedDetail>)
            .detail?.reason;
        if (!reason) return;
        if (reason !== 'done') failTourAiStep('filter', reason);
        advance();
    };
    const onClosed = onFilterEditorCancelled(skip);
    window.addEventListener('glyphFilterTurnFinished', onTurn);
    window.addEventListener('glyphFilterEditorClosed', onClosed);
    return () => {
        window.removeEventListener('glyphFilterTurnFinished', onTurn);
        window.removeEventListener('glyphFilterEditorClosed', onClosed);
    };
}

/** Moves on when OK saves the filter. */
export function bindTourFilterSave({
    advance,
    skip
}: TourAdvanceControls): () => void {
    const onSaved = () => {
        finishTourAiStep('filter');
        advance();
    };
    const onClosed = onFilterEditorCancelled(skip);
    window.addEventListener('glyphFilterSaved', onSaved);
    window.addEventListener('glyphFilterEditorClosed', onClosed);
    return () => {
        window.removeEventListener('glyphFilterSaved', onSaved);
        window.removeEventListener('glyphFilterEditorClosed', onClosed);
    };
}

// ── Assistant ───────────────────────────────────────────────────────────

/** Put the tour question in the Assistant’s prompt box. */
export function fillTourAssistantPrompt(): void {
    const prompt = document.getElementById('assistant-prompt');
    if (!(prompt instanceof HTMLTextAreaElement)) return;
    if (!prompt.value.trim()) {
        prompt.value = TOUR_ASSISTANT_PROMPT;
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    prompt.focus();
}

/** Moves on when the Assistant’s answer is finished, however it ended. */
export function bindTourAssistantTurn({
    advance
}: TourAdvanceControls): () => void {
    const session = window.aiAssistant?.session;
    if (!session) return () => {};
    return session.on('turn-finished', ({ reason }) => {
        if (reason === 'done') finishTourAiStep('assistant');
        else failTourAiStep('assistant', reason);
        advance();
    });
}
