/**
 * Spotlight overlay: dimmed mask with cutouts, Tippy callout, and input lock.
 *
 * Visual holes are an SVG luminance mask. Hit-testing uses HTML rectangles
 * that cover the viewport minus interactive cutouts (hit padding may be
 * tighter than the visual hole). Keyboard: capture-phase lock
 * (Cmd/Ctrl+Shift+R reload is allowed); view shortcuts are blocked separately.
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { Logger } from './logger';
import {
    keyboardShortcutHtml,
    shortcutSpecFromHandbook
} from './keyboard-shortcut-display';
import {
    TOUR_REQUIRED_TOOL_SELECTOR,
    TOUR_SAMPLE_TEXT_CUTOUT,
    type TourCutout,
    type TourCutoutRect,
    type TourSlide,
    type TourTooltip
} from './tour-slides';
import type { StickyEditTool } from './glyph-canvas/edit-tools';
import {
    getTourComponentDepth,
    getTourEditRootGlyphName,
    isTourEditingComponent
} from './tour-components';
import {
    clearTourDrawingGuides,
    findTourGuideGateTarget,
    getTourGuideGate,
    isTourDrawingGoalMet,
    nudgeTourDrawingGuides,
    syncTourDrawingGuides
} from './tour-drawing';

const console = new Logger('Tour');

const OVERLAY_Z_INDEX = 13000;
export const TOUR_FADE_MS = 500;
const FADE_MS = TOUR_FADE_MS;
/** After the text-buffer spotlight fades in, pause so the user can refocus. */
export const TOUR_POST_FADE_BEFORE_APPLY_MS = 500;
/** Watch the applied click (feature / master) before the next slide. */
export const TOUR_AFTER_APPLY_MS = 1500;
/** Native slider / glyph reaction: short hold before the next slide. */
export const TOUR_AFTER_SLIDER_MS = 500;
const DEFAULT_CUTOUT_PADDING = 24;
const TOUR_TOOL_FLASH_MS = 420;
const TOUR_TOOL_FLASH_TIMES = 3;
/** How long a glyph double-click may take to open the expected glyph. */
const DOUBLE_CLICK_EDIT_TIMEOUT_MS = 2000;

/** Tooltip actions. Only `onContinue` is required. */
export type TourNavigation = {
    onContinue: () => void;
    onBack?: () => void;
    onRestart?: () => void;
    onCancel?: () => void;
};

let requiredToolFlashToken = 0;
let requiredToolFlashStartedAt = 0;

type FinishReactionOptions = {
    previewTextBeforeApply?: boolean;
    afterApplyMs?: number;
};

type SpotlightHost = {
    root: HTMLElement | null;
    svg: SVGSVGElement | null;
    maskBg: SVGRectElement | null;
    dimmerRect: SVGRectElement | null;
    maskPath: SVGPathElement | null;
    hitLayer: HTMLElement | null;
    tooltip: HTMLElement | null;
    tippy: TippyInstance | null;
    slide: TourSlide | null;
    visible: boolean;
    advancing: boolean;
    previewingSampleText: boolean;
    sampleTextTrackFrame: number;
    onContinue: (() => void) | null;
    navigation: TourNavigation | null;
    /** Back / Restart step is rebuilding app state; input stays blocked. */
    restoring: boolean;
    /** An action happened and the tour is checking it before advancing. */
    pendingAdvance: boolean;
    resizeObserver: ResizeObserver | null;
    listenersBound: boolean;
    slideUnbind: (() => void) | null;
};

function getHost(): SpotlightHost {
    const holder = window as Window & { __tourSpotlightHost?: SpotlightHost };
    if (!holder.__tourSpotlightHost) {
        holder.__tourSpotlightHost = {
            root: null,
            svg: null,
            maskBg: null,
            dimmerRect: null,
            maskPath: null,
            hitLayer: null,
            tooltip: null,
            tippy: null,
            slide: null,
            visible: false,
            advancing: false,
            previewingSampleText: false,
            sampleTextTrackFrame: 0,
            onContinue: null,
            navigation: null,
            restoring: false,
            pendingAdvance: false,
            resizeObserver: null,
            listenersBound: false,
            slideUnbind: null
        };
    }
    return holder.__tourSpotlightHost;
}

let viewShortcutsBlocked = false;
let allowedViewShortcutKeys: string[] = [];
let allowedViewShortcutConsumed = false;

export function isTourBlockingViewShortcuts(): boolean {
    return viewShortcutsBlocked;
}

export function isViewShortcutAllowedDuringTour(key: string): boolean {
    if (!viewShortcutsBlocked) {
        return true;
    }
    return (
        allowedViewShortcutKeys.includes(key) && !allowedViewShortcutConsumed
    );
}

export function isTourCmdEscapeAllowed(): boolean {
    if (!viewShortcutsBlocked) {
        return true;
    }
    return !!getHost().slide?.allowCmdEscape && !allowedViewShortcutConsumed;
}

export function consumeAllowedTourViewShortcut(): void {
    if (getHost().slide?.consumeViewShortcut) {
        allowedViewShortcutConsumed = true;
    }
}

function setViewShortcutLock(slide: TourSlide | null): void {
    viewShortcutsBlocked = !!slide;
    allowedViewShortcutKeys = slide?.allowedViewShortcutKeys || [];
    allowedViewShortcutConsumed = false;
}

function roundedRectPath(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
): string {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (r <= 0) {
        return `M${x},${y} H${x + width} V${y + height} H${x} Z`;
    }
    return [
        `M${x + r},${y}`,
        `H${x + width - r}`,
        `A${r},${r} 0 0 1 ${x + width},${y + r}`,
        `V${y + height - r}`,
        `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
        `H${x + r}`,
        `A${r},${r} 0 0 1 ${x},${y + height - r}`,
        `V${y + r}`,
        `A${r},${r} 0 0 1 ${x + r},${y} Z`
    ].join(' ');
}

function padRect(rect: TourCutoutRect, padding: number): TourCutoutRect {
    return {
        left: rect.left - padding,
        top: rect.top - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2
    };
}

function visualRectForCutout(
    cutout: TourSlide['cutouts'][number],
    raw: TourCutoutRect
): TourCutoutRect {
    return padRect(raw, cutout.padding ?? DEFAULT_CUTOUT_PADDING);
}

function hitRectForCutout(
    cutout: TourSlide['cutouts'][number],
    raw?: TourCutoutRect | null
): TourCutoutRect | null {
    const source = raw ?? cutout.resolve();
    if (!source) {
        return null;
    }
    return padRect(
        source,
        cutout.hitPadding ?? cutout.padding ?? DEFAULT_CUTOUT_PADDING
    );
}

function clientPointInRect(
    x: number,
    y: number,
    rect: TourCutoutRect
): boolean {
    return (
        x >= rect.left &&
        x <= rect.left + rect.width &&
        y >= rect.top &&
        y <= rect.top + rect.height
    );
}

function isTourChromeEvent(event: Event): boolean {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) {
        return false;
    }
    return Boolean(
        eventTarget.closest('.tippy-box[data-theme="tour"]') ||
        eventTarget.closest('.tour-tooltip') ||
        eventTarget.closest('[data-tour-action]')
    );
}

function isRequiredToolButtonEvent(
    event: Event,
    tool: StickyEditTool
): boolean {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) {
        return false;
    }
    return Boolean(eventTarget.closest(TOUR_REQUIRED_TOOL_SELECTOR[tool]));
}

function isRequiredToolActive(tool: StickyEditTool): boolean {
    const snapshot =
        window.glyphCanvas?.outlineEditor?.getEditToolUiSnapshot?.();
    if (!snapshot) {
        return true;
    }
    return snapshot.stickyTool === tool;
}

function flashRequiredTourTool(tool: StickyEditTool): void {
    const now = Date.now();
    if (now - requiredToolFlashStartedAt < 80) {
        return;
    }
    requiredToolFlashStartedAt = now;
    requiredToolFlashToken += 1;
    const token = requiredToolFlashToken;
    for (let i = 0; i < TOUR_TOOL_FLASH_TIMES; i++) {
        window.setTimeout(() => {
            if (token !== requiredToolFlashToken) {
                return;
            }
            window.dispatchEvent(
                new CustomEvent('editorEditToolFlash', {
                    detail: { toolId: tool }
                })
            );
        }, i * TOUR_TOOL_FLASH_MS);
    }
}

function shouldFlashRequiredTool(event: Event): boolean {
    return event.type === 'pointerdown' || event.type === 'mousedown';
}

function subtractRect(
    base: TourCutoutRect,
    hole: TourCutoutRect
): TourCutoutRect[] {
    const a = {
        left: base.left,
        top: base.top,
        right: base.left + base.width,
        bottom: base.top + base.height
    };
    const b = {
        left: hole.left,
        top: hole.top,
        right: hole.left + hole.width,
        bottom: hole.top + hole.height
    };
    const ix = Math.max(a.left, b.left);
    const iy = Math.max(a.top, b.top);
    const ir = Math.min(a.right, b.right);
    const ib = Math.min(a.bottom, b.bottom);
    if (ix >= ir || iy >= ib) {
        return [base];
    }
    const pieces: TourCutoutRect[] = [];
    if (a.top < iy) {
        pieces.push({
            left: a.left,
            top: a.top,
            width: a.right - a.left,
            height: iy - a.top
        });
    }
    if (ib < a.bottom) {
        pieces.push({
            left: a.left,
            top: ib,
            width: a.right - a.left,
            height: a.bottom - ib
        });
    }
    if (a.left < ix) {
        pieces.push({
            left: a.left,
            top: iy,
            width: ix - a.left,
            height: ib - iy
        });
    }
    if (ir < a.right) {
        pieces.push({
            left: ir,
            top: iy,
            width: a.right - ir,
            height: ib - iy
        });
    }
    return pieces.filter((piece) => piece.width > 0 && piece.height > 0);
}

function coverViewportMinusHoles(
    width: number,
    height: number,
    holes: TourCutoutRect[]
): TourCutoutRect[] {
    let pieces: TourCutoutRect[] = [{ left: 0, top: 0, width, height }];
    for (const hole of holes) {
        pieces = pieces.flatMap((piece) => subtractRect(piece, hole));
    }
    return pieces;
}

function isTourViewCollapsed(viewId: string): boolean {
    const view = document.getElementById(viewId);
    if (!view) {
        return false;
    }
    return (
        view.classList.contains('collapsed') ||
        view.classList.contains('collapsed-width')
    );
}

function usesCommandModifier(): boolean {
    return navigator.platform.toUpperCase().includes('MAC');
}

function localizeTourModifiers(text: string): string {
    const command = usesCommandModifier() ? 'Cmd' : 'Ctrl';
    const option = usesCommandModifier() ? 'Option' : 'Alt';
    return text
        .replaceAll('Cmd/Ctrl', command)
        .replaceAll('Alt/Option', option);
}

function appendPreChip(parent: HTMLElement, raw: string): void {
    const spec = shortcutSpecFromHandbook(raw);
    const pre = document.createElement('pre');
    pre.className = 'tour-shortcut';
    if (spec !== null) {
        pre.innerHTML = keyboardShortcutHtml(spec);
        parent.append(pre);
        return;
    }
    pre.textContent = localizeTourModifiers(raw);
    parent.append(pre);
}

function appendBouncySentence(parent: HTMLElement, text: string): void {
    const paragraph = document.createElement('p');
    paragraph.className = 'tour-bounce-line';
    for (const character of text) {
        if (character === ' ') {
            paragraph.append(document.createTextNode(' '));
            continue;
        }
        const letter = document.createElement('span');
        letter.className = 'tour-bounce-letter';
        letter.textContent = character;
        letter.style.animationDelay = `${(-Math.random() * 0.7).toFixed(3)}s`;
        letter.style.animationDuration = `${(0.38 + Math.random() * 0.28).toFixed(3)}s`;
        letter.style.setProperty(
            '--tour-bounce-lift',
            `${(-0.26 - Math.random() * 0.12).toFixed(3)}em`
        );
        paragraph.append(letter);
    }
    parent.append(paragraph);
}
function appendInlineMarkup(parent: HTMLElement, text: string): void {
    const codeParts = text.split(/`(.+?)`/);
    codeParts.forEach((part, codeIndex) => {
        if (codeIndex % 2 === 1) {
            appendPreChip(parent, part);
            return;
        }
        const parts = part.split(/\*\*(.+?)\*\*/);
        parts.forEach((chunk, index) => {
            if (index % 2 === 1) {
                const strong = document.createElement('strong');
                strong.textContent = chunk;
                parent.append(strong);
                return;
            }
            if (chunk) {
                parent.append(document.createTextNode(chunk));
            }
        });
    });
}

/** Inline markup: `**bold**` and `_italic_`. Italic wraps the action sentence. */
function renderInlineEmphasis(text: string): HTMLElement {
    const paragraph = document.createElement('p');
    const parts = text.split(/_(.+?)_/);
    parts.forEach((part, index) => {
        if (!part) {
            return;
        }
        if (index % 2 === 1) {
            const em = document.createElement('em');
            appendInlineMarkup(em, part);
            paragraph.append(em);
            return;
        }
        appendInlineMarkup(paragraph, part);
    });
    return paragraph;
}

function appendTooltipBody(container: HTMLElement, body: string): void {
    const blocks = body
        .split(/\n\n+/)
        .map((block) => block.trim())
        .filter(Boolean);
    for (const block of blocks) {
        if (block === 'Have fun making fonts.') {
            appendBouncySentence(container, block);
            continue;
        }
        container.append(renderInlineEmphasis(block));
    }
}

function resolveAdvanceClickTarget(
    event: Event,
    selector: string
): HTMLElement | null {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) {
        return null;
    }
    const direct = eventTarget.closest(selector);
    if (direct instanceof HTMLElement) {
        return direct;
    }
    const row = eventTarget.closest('.editor-feature-row');
    const nested = row?.querySelector(selector);
    if (nested instanceof HTMLElement && row?.contains(eventTarget)) {
        return nested;
    }
    return null;
}

function unbindSlideInteraction(): void {
    const host = getHost();
    host.slideUnbind?.();
    host.slideUnbind = null;
}

function setCutoutsVisible(visible: boolean): void {
    getHost().root?.classList.toggle('is-cutouts-visible', visible);
}

function setTooltipVisible(visible: boolean): void {
    getHost().root?.classList.toggle('is-tooltip-visible', visible);
}

async function fadeOutCutoutsAndTooltip(): Promise<void> {
    setCutoutsVisible(false);
    setTooltipVisible(false);
    await wait(FADE_MS);
}

async function fadeInTextBufferSpotlight(): Promise<void> {
    const host = getHost();
    if (!host.slide) {
        return;
    }
    host.previewingSampleText = true;
    paintSampleTextPreview();
    startSampleTextTracking();
    await wait(0);
    setCutoutsVisible(true);
    await wait(FADE_MS);
}

function paintSampleTextPreview(): void {
    const host = getHost();
    if (!host.slide) {
        return;
    }
    paintSpotlight(host.slide, {
        punchHits: false,
        cutouts: [TOUR_SAMPLE_TEXT_CUTOUT],
        showTooltip: false
    });
}

function shouldPaintTourGeometry(host: SpotlightHost): boolean {
    if (!host.slide || !host.visible || host.restoring) {
        return false;
    }
    if (!host.advancing) {
        return true;
    }
    return (
        host.previewingSampleText ||
        host.slide.trackCutoutsWhileAdvancing === true
    );
}

async function waitUntilLayerSwitchSettled(): Promise<true> {
    const editor = window.glyphCanvas?.outlineEditor;
    if (typeof editor?.isLayerSwitchAnimating !== 'boolean') {
        return true;
    }
    const started = Date.now();
    while (Date.now() - started < 400) {
        if (editor.isLayerSwitchAnimating) {
            break;
        }
        await wait(16);
    }
    while (editor.isLayerSwitchAnimating && Date.now() - started < 4000) {
        await wait(16);
    }
    return true;
}

function startAdvancingCutoutTracking(): void {
    const host = getHost();
    stopSampleTextTracking();
    const tick = () => {
        const current = getHost();
        if (
            !current.visible ||
            !current.slide ||
            !current.advancing ||
            !current.slide.trackCutoutsWhileAdvancing
        ) {
            current.sampleTextTrackFrame = 0;
            return;
        }
        paintSpotlight(current.slide);
        current.sampleTextTrackFrame = window.requestAnimationFrame(tick);
    };
    host.sampleTextTrackFrame = window.requestAnimationFrame(tick);
}

function startSampleTextTracking(): void {
    const host = getHost();
    stopSampleTextTracking();
    const tick = () => {
        const current = getHost();
        if (
            !current.previewingSampleText ||
            !current.visible ||
            !current.slide
        ) {
            current.sampleTextTrackFrame = 0;
            return;
        }
        paintSampleTextPreview();
        current.sampleTextTrackFrame = window.requestAnimationFrame(tick);
    };
    host.sampleTextTrackFrame = window.requestAnimationFrame(tick);
}

function stopSampleTextTracking(): void {
    const host = getHost();
    if (host.sampleTextTrackFrame) {
        window.cancelAnimationFrame(host.sampleTextTrackFrame);
        host.sampleTextTrackFrame = 0;
    }
}

function restoreSlideChrome(slide: TourSlide): void {
    paintSpotlight(slide);
    setCutoutsVisible(true);
    setTooltipVisible(true);
    bindSlideInteraction(slide);
}

async function finishWithReaction(
    applyReaction?: () => boolean | void | Promise<boolean | void>,
    options?: FinishReactionOptions
): Promise<void> {
    const host = getHost();
    if (!host.visible || host.advancing) {
        return;
    }
    host.advancing = true;
    unbindSlideInteraction();
    if (host.slide?.trackCutoutsWhileAdvancing) {
        startAdvancingCutoutTracking();
    }
    try {
        if (options?.previewTextBeforeApply) {
            await fadeOutCutoutsAndTooltip();
            if (!host.visible) {
                return;
            }
            await fadeInTextBufferSpotlight();
            if (!host.visible) {
                return;
            }
            await wait(TOUR_POST_FADE_BEFORE_APPLY_MS);
            if (!host.visible) {
                return;
            }
        }
        const applied = await applyReaction?.();
        if (applied === false) {
            if (host.visible && host.slide) {
                restoreSlideChrome(host.slide);
            }
            return;
        }
        await wait(options?.afterApplyMs ?? TOUR_AFTER_APPLY_MS);
        if (!host.visible) {
            return;
        }
        host.onContinue?.();
    } finally {
        stopSampleTextTracking();
        host.previewingSampleText = false;
        host.advancing = false;
    }
}

function setHitPassthrough(active: boolean): void {
    getHost().root?.classList.toggle('is-hit-passthrough', active);
}

function bindSlideInteraction(slide: TourSlide): void {
    unbindSlideInteraction();
    const host = getHost();
    const cleanups: Array<() => void> = [];

    const lockPointer = (event: Event) => {
        if (!host.visible || host.slide !== slide || host.advancing) {
            return;
        }
        if (!(event instanceof MouseEvent)) {
            return;
        }
        if (isTourChromeEvent(event)) {
            return;
        }
        if (event.type === 'contextmenu') {
            // Context menus can delete, decompose or switch glyphs.
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const interactiveHoles = resolvedCutouts(slide.cutouts).filter(
            ({ cutout }) => cutout.interactive
        );
        const inHole = interactiveHoles.some(({ hitRect }) =>
            clientPointInRect(event.clientX, event.clientY, hitRect)
        );
        const hasClientPoint = event.clientX !== 0 || event.clientY !== 0;
        if (hasClientPoint && interactiveHoles.length > 0 && !inHole) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const required = slide.requireTool;
        if (required) {
            if (isRequiredToolButtonEvent(event, required)) {
                return;
            }
            if (!isRequiredToolActive(required)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (shouldFlashRequiredTool(event)) {
                    flashRequiredTourTool(required);
                }
                return;
            }
        }
        if (event.type === 'pointerdown' || event.type === 'mousedown') {
            setHitPassthrough(true);
        }
    };
    const endPassthrough = () => {
        setHitPassthrough(false);
    };
    document.addEventListener('pointerdown', lockPointer, true);
    document.addEventListener('mousedown', lockPointer, true);
    document.addEventListener('click', lockPointer, true);
    document.addEventListener('dblclick', lockPointer, true);
    document.addEventListener('contextmenu', lockPointer, true);
    window.addEventListener('pointerup', endPassthrough, true);
    window.addEventListener('pointercancel', endPassthrough, true);
    window.addEventListener('mouseup', endPassthrough, true);
    cleanups.push(() => {
        document.removeEventListener('pointerdown', lockPointer, true);
        document.removeEventListener('mousedown', lockPointer, true);
        document.removeEventListener('click', lockPointer, true);
        document.removeEventListener('dblclick', lockPointer, true);
        document.removeEventListener('contextmenu', lockPointer, true);
        window.removeEventListener('pointerup', endPassthrough, true);
        window.removeEventListener('pointercancel', endPassthrough, true);
        window.removeEventListener('mouseup', endPassthrough, true);
        setHitPassthrough(false);
    });

    const gate = getTourGuideGate(slide.drawingGuides);
    if (gate && slide.drawingGuides) {
        const kind = slide.drawingGuides;
        /** Client point a snapped press was moved to, until its mouseup. */
        let snappedPress: { x: number; y: number } | null = null;
        /** Presses replayed on the mark; they pass the gate untouched. */
        const replayed = new WeakSet<Event>();
        const block = (event: Event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const dispatchAt = (
            type: 'mousemove' | 'mousedown' | 'mouseup',
            point: { x: number; y: number },
            source: MouseEvent
        ) => {
            const replay = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
                button: source.button,
                buttons: source.buttons,
                detail: source.detail,
                shiftKey: source.shiftKey,
                altKey: source.altKey,
                metaKey: source.metaKey,
                ctrlKey: source.ctrlKey
            });
            replayed.add(replay);
            window.glyphCanvas?.canvas?.dispatchEvent(replay);
        };
        const isLiveCanvasEvent = (event: MouseEvent) =>
            !replayed.has(event) &&
            host.visible &&
            host.slide === slide &&
            !host.advancing &&
            !!window.glyphCanvas?.canvas &&
            event.target === window.glyphCanvas.canvas;
        const onDown = (event: MouseEvent) => {
            if (!isLiveCanvasEvent(event)) {
                return;
            }
            if (snappedPress) {
                // The previous press was released outside the window.
                dispatchAt('mouseup', snappedPress, event);
                snappedPress = null;
            }
            if (event.button !== 0) {
                block(event);
                return;
            }
            if (slide.requireTool && !isRequiredToolActive(slide.requireTool)) {
                // The pointer lock flashes the tool the user needs first.
                return;
            }
            const target = findTourGuideGateTarget(kind, {
                x: event.clientX,
                y: event.clientY
            });
            if (!target) {
                block(event);
                nudgeTourDrawingGuides();
                return;
            }
            revealTourRestart();
            if (gate === 'grab') {
                return;
            }
            block(event);
            snappedPress = target;
            dispatchAt('mousemove', target, event);
            dispatchAt('mousedown', target, event);
        };
        const onMove = (event: MouseEvent) => {
            // A drag would pull handles out of new nodes or move them.
            if (snappedPress && !replayed.has(event)) {
                block(event);
            }
        };
        const onUp = (event: MouseEvent) => {
            if (!snappedPress || replayed.has(event)) {
                return;
            }
            block(event);
            const point = snappedPress;
            snappedPress = null;
            dispatchAt('mouseup', point, event);
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
        cleanups.push(() => {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
        });
    }

    const selector = slide.advanceOnClick;
    if (selector) {
        let ignoreClick = false;
        const handler = (event: Event) => {
            if (!host.visible || host.slide !== slide || host.advancing) {
                return;
            }
            if (ignoreClick) {
                return;
            }
            const button = resolveAdvanceClickTarget(event, selector);
            if (!button) {
                return;
            }
            if (button instanceof HTMLButtonElement && button.disabled) {
                return;
            }
            if (slide.advanceOnClickPassThrough) {
                void finishWithReaction(
                    slide.trackCutoutsWhileAdvancing
                        ? waitUntilLayerSwitchSettled
                        : undefined,
                    {
                        previewTextBeforeApply: false,
                        afterApplyMs:
                            slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
                    }
                );
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void finishWithReaction(
                async () => {
                    ignoreClick = true;
                    button.click();
                    ignoreClick = false;
                    if (
                        slide.advanceOnClickRequireEnabled &&
                        !button.classList.contains('enabled')
                    ) {
                        return false;
                    }
                    return true;
                },
                {
                    previewTextBeforeApply:
                        slide.previewTextBeforeApply !== false,
                    afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
                }
            );
        };
        document.addEventListener('click', handler, true);
        cleanups.push(() => {
            document.removeEventListener('click', handler, true);
        });
    }

    if (slide.axisClamp) {
        const clamp = slide.axisClamp;
        let ceilingLatched = false;
        const handler = (event: Event) => {
            if (!host.visible || host.slide !== slide) {
                return;
            }
            const slider = event.target;
            if (!(slider instanceof HTMLInputElement)) {
                return;
            }
            if (!slider.matches(clamp.selector)) {
                return;
            }
            let value = parseFloat(slider.value);
            if (!Number.isFinite(value)) {
                return;
            }
            if (value <= clamp.latchMaxWhenAtOrBelow) {
                ceilingLatched = true;
            }
            if (value < clamp.min) {
                value = clamp.min;
            }
            if (ceilingLatched && value > clamp.max) {
                value = clamp.max;
            }
            if (slider.value !== String(value)) {
                slider.value = String(value);
            }
        };
        document.addEventListener('input', handler, true);
        cleanups.push(() => {
            document.removeEventListener('input', handler, true);
        });
    }

    if (slide.advanceOnSlider) {
        const config = slide.advanceOnSlider;
        let advanced = false;
        const maybeAdvance = (event: Event) => {
            if (advanced || !host.visible || host.slide !== slide) {
                return;
            }
            const eventTarget = event.target;
            if (!(eventTarget instanceof Element)) {
                return;
            }
            const slider = eventTarget.closest(config.selector);
            if (!(slider instanceof HTMLInputElement)) {
                return;
            }
            const value = parseFloat(slider.value);
            if (value >= config.min && value <= config.max) {
                advanced = true;
                void finishWithReaction(undefined, {
                    afterApplyMs: TOUR_AFTER_SLIDER_MS
                });
            }
        };
        document.addEventListener('change', maybeAdvance, false);
        document.addEventListener('pointerup', maybeAdvance, false);
        cleanups.push(() => {
            document.removeEventListener('change', maybeAdvance, false);
            document.removeEventListener('pointerup', maybeAdvance, false);
        });
    }

    if (slide.advanceOnGlyphDoubleClick) {
        const letterCutout = slide.cutouts.find(
            (cutout) => cutout.id === slide.tooltip.targetCutoutId
        );
        let advanced = false;
        const handler = (event: MouseEvent) => {
            if (!host.visible || host.slide !== slide) {
                return;
            }
            const hitRect = letterCutout
                ? hitRectForCutout(letterCutout)
                : null;
            if (
                !hitRect ||
                !clientPointInRect(event.clientX, event.clientY, hitRect)
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (advanced || slide.advanceWhenComponentDepth !== undefined) {
                // Component slides advance when the nesting depth changes.
                return;
            }
            advanced = true;
            void (async () => {
                const expected = slide.expectEditGlyph;
                if (expected) {
                    host.pendingAdvance = true;
                    const opened = await waitForCondition(
                        () => getTourEditRootGlyphName() === expected,
                        DOUBLE_CLICK_EDIT_TIMEOUT_MS
                    );
                    host.pendingAdvance = false;
                    if (!opened) {
                        // Missed the glyph: stay on this slide.
                        advanced = false;
                        return;
                    }
                }
                if (!host.visible || host.slide !== slide) {
                    return;
                }
                void finishWithReaction(undefined, {
                    afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
                });
            })();
        };
        document.addEventListener('dblclick', handler, true);
        cleanups.push(() => {
            document.removeEventListener('dblclick', handler, true);
        });
    }

    if (slide.advanceOnNodeDrag) {
        const letterCutout = slide.cutouts.find(
            (cutout) => cutout.id === 'letter-l'
        );
        let origin: { x: number; y: number } | null = null;
        let moved = false;
        let advanced = false;
        const onPointerDown = (event: MouseEvent) => {
            if (!host.visible || host.slide !== slide || host.advancing) {
                return;
            }
            const hitRect = letterCutout
                ? hitRectForCutout(letterCutout)
                : null;
            if (
                !hitRect ||
                !clientPointInRect(event.clientX, event.clientY, hitRect)
            ) {
                origin = null;
                moved = false;
                return;
            }
            origin = { x: event.clientX, y: event.clientY };
            moved = false;
        };
        const onPointerMove = (event: MouseEvent) => {
            if (!origin || advanced) {
                return;
            }
            if (
                Math.hypot(
                    event.clientX - origin.x,
                    event.clientY - origin.y
                ) >= 6
            ) {
                moved = true;
            }
        };
        const onPointerUp = () => {
            if (advanced || !moved) {
                origin = null;
                moved = false;
                return;
            }
            advanced = true;
            origin = null;
            moved = false;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_SLIDER_MS
            });
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('mousemove', onPointerMove, true);
        document.addEventListener('mouseup', onPointerUp, true);
        cleanups.push(() => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('mousemove', onPointerMove, true);
            document.removeEventListener('mouseup', onPointerUp, true);
        });
    }

    if (slide.advanceWhen) {
        const goal = slide.advanceWhen;
        let advanced = false;
        const maybeAdvance = () => {
            if (
                advanced ||
                !host.visible ||
                host.slide !== slide ||
                host.advancing
            ) {
                return;
            }
            if (!isTourDrawingGoalMet(goal)) {
                return;
            }
            advanced = true;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_SLIDER_MS
            });
        };
        const onPointerUp = () => {
            window.requestAnimationFrame(() => {
                maybeAdvance();
            });
        };
        document.addEventListener('mouseup', onPointerUp, true);
        document.addEventListener('keyup', maybeAdvance, true);
        document.addEventListener('dblclick', maybeAdvance, true);
        // The outline can update after mouseup; goals ignore drags in progress.
        window.addEventListener('glyphCanvasRendered', maybeAdvance);
        cleanups.push(() => {
            document.removeEventListener('mouseup', onPointerUp, true);
            document.removeEventListener('keyup', maybeAdvance, true);
            document.removeEventListener('dblclick', maybeAdvance, true);
            window.removeEventListener('glyphCanvasRendered', maybeAdvance);
        });
        maybeAdvance();
    }

    if (slide.advanceWhenComponentDepth !== undefined) {
        const targetDepth = slide.advanceWhenComponentDepth;
        let advanced = false;
        const maybeAdvance = () => {
            if (
                advanced ||
                !host.visible ||
                host.slide !== slide ||
                host.advancing
            ) {
                return;
            }
            if (getTourComponentDepth() !== targetDepth) {
                return;
            }
            advanced = true;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_SLIDER_MS
            });
        };
        window.addEventListener('glyphStackChanged', maybeAdvance);
        cleanups.push(() => {
            window.removeEventListener('glyphStackChanged', maybeAdvance);
        });
    }

    if (slide.advanceOnEditModeExit) {
        let advanced = false;
        const maybeAdvance = (event: Event) => {
            if (
                advanced ||
                !host.visible ||
                host.slide !== slide ||
                host.advancing
            ) {
                return;
            }
            const detail = (event as CustomEvent<{ mode?: string }>).detail;
            if (detail?.mode !== 'text') {
                return;
            }
            advanced = true;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
            });
        };
        window.addEventListener('editorModeChanged', maybeAdvance);
        cleanups.push(() => {
            window.removeEventListener('editorModeChanged', maybeAdvance);
        });
    }

    const bindViewAdvance = (
        type: 'viewFocused' | 'viewResized',
        viewId: string | undefined,
        collapsedOnly = false
    ) => {
        if (!viewId) {
            return;
        }
        let advanced = false;
        const maybeAdvance = (event: Event) => {
            if (
                advanced ||
                !host.visible ||
                host.slide !== slide ||
                host.advancing
            ) {
                return;
            }
            const detail = (event as CustomEvent<{ viewId?: string }>).detail;
            if (detail?.viewId !== viewId) {
                return;
            }
            if (collapsedOnly && !isTourViewCollapsed(viewId)) {
                return;
            }
            advanced = true;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_SLIDER_MS
            });
        };
        window.addEventListener(type, maybeAdvance);
        cleanups.push(() => {
            window.removeEventListener(type, maybeAdvance);
        });
    };
    bindViewAdvance('viewFocused', slide.advanceOnViewFocused);
    bindViewAdvance('viewResized', slide.advanceOnViewResized);
    bindViewAdvance('viewResized', slide.advanceOnViewCollapsed, true);

    host.slideUnbind = () => {
        for (const cleanup of cleanups) {
            cleanup();
        }
    };
}

function cutoutToClientRect(rect: TourCutoutRect): DOMRect {
    if (
        typeof DOMRect !== 'undefined' &&
        typeof DOMRect.fromRect === 'function'
    ) {
        return DOMRect.fromRect({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
        });
    }
    const left = rect.left;
    const top = rect.top;
    const width = rect.width;
    const height = rect.height;
    return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON() {
            return this;
        }
    } as DOMRect;
}

function positionTooltip(
    target: TourCutoutRect,
    placement: TourTooltip['placement']
): void {
    const host = getHost();
    if (!host.tippy) {
        return;
    }
    host.tippy.setProps({
        getReferenceClientRect: () => cutoutToClientRect(target),
        placement: placement || 'bottom'
    });
    if (!host.tippy.state.isVisible) {
        host.tippy.show();
    } else {
        host.tippy.popperInstance?.update();
    }
}

function resolvedCutouts(cutouts: TourCutout[]): Array<{
    cutout: TourCutout;
    rect: TourCutoutRect;
    hitRect: TourCutoutRect;
}> {
    const resolved: Array<{
        cutout: TourCutout;
        rect: TourCutoutRect;
        hitRect: TourCutoutRect;
    }> = [];
    for (const cutout of cutouts) {
        const raw = cutout.resolve();
        if (!raw) {
            continue;
        }
        const hitRect = hitRectForCutout(cutout, raw);
        if (!hitRect) {
            continue;
        }
        resolved.push({
            cutout,
            rect: visualRectForCutout(cutout, raw),
            hitRect
        });
    }
    return resolved;
}

function paintSpotlight(
    slide: TourSlide,
    options?: {
        punchHits?: boolean;
        cutouts?: TourCutout[];
        showTooltip?: boolean;
    }
): void {
    const host = getHost();
    if (
        !host.svg ||
        !host.maskPath ||
        !host.maskBg ||
        !host.dimmerRect ||
        !host.hitLayer ||
        !host.tippy
    ) {
        return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    host.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    host.svg.setAttribute('width', String(width));
    host.svg.setAttribute('height', String(height));
    host.maskBg.setAttribute('width', String(width));
    host.maskBg.setAttribute('height', String(height));
    host.dimmerRect.setAttribute('width', String(width));
    host.dimmerRect.setAttribute('height', String(height));

    const holes = resolvedCutouts(options?.cutouts ?? slide.cutouts);
    const holePaths = holes
        .map(({ cutout, rect }) =>
            roundedRectPath(
                rect.left,
                rect.top,
                rect.width,
                rect.height,
                cutout.radius ?? 8
            )
        )
        .join(' ');
    host.maskPath.setAttribute('d', holePaths);

    const punchHits = options?.punchHits !== false;
    const interactiveHoles = punchHits
        ? holes
              .filter(({ cutout }) => cutout.interactive)
              .map(({ hitRect }) => hitRect)
        : [];
    host.hitLayer.replaceChildren();
    for (const piece of coverViewportMinusHoles(
        width,
        height,
        interactiveHoles
    )) {
        const el = document.createElement('div');
        el.className = 'tour-spotlight-hit-piece';
        el.style.position = 'absolute';
        el.style.pointerEvents = 'auto';
        el.style.left = `${piece.left}px`;
        el.style.top = `${piece.top}px`;
        el.style.width = `${piece.width}px`;
        el.style.height = `${piece.height}px`;
        host.hitLayer.append(el);
    }

    if (options?.showTooltip === false) {
        host.tippy.hide();
        return;
    }

    const target = holes.find(
        (entry) => entry.cutout.id === slide.tooltip.targetCutoutId
    );
    if (target) {
        positionTooltip(target.rect, slide.tooltip.placement);
    } else if (!host.tippy.state.isVisible) {
        host.tippy.show();
    }
    syncTourDrawingGuides(slide.drawingGuides, host.root);
}

function isBrowserReloadShortcut(event: KeyboardEvent): boolean {
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    return (
        cmdOrCtrl && event.shiftKey && !event.altKey && event.code === 'KeyR'
    );
}

/**
 * While the spotlight is visible, only keys the current slide asks for
 * (plus hard-reload) may reach the rest of the app.
 */
export function isTourKeyEventAllowed(event: KeyboardEvent): boolean {
    const host = getHost();
    if (!host.visible) {
        return true;
    }
    if (isBrowserReloadShortcut(event)) {
        return true;
    }
    if (host.restoring) {
        return false;
    }
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (
        cmdOrCtrl &&
        event.shiftKey &&
        !event.altKey &&
        isViewShortcutAllowedDuringTour(key)
    ) {
        return true;
    }
    if (
        cmdOrCtrl &&
        event.code === 'Escape' &&
        !event.shiftKey &&
        !event.altKey &&
        isTourCmdEscapeAllowed()
    ) {
        return true;
    }
    if (event.key === 'Escape' && !cmdOrCtrl) {
        const policy = host.slide?.escapePolicy;
        if (policy === 'exit-edit') {
            return true;
        }
        if (policy === 'component-levels' && isTourEditingComponent()) {
            return true;
        }
    }
    const code = typeof event.code === 'string' ? event.code.toLowerCase() : '';
    if (
        host.slide?.allowedKeys?.includes(event.key.toLowerCase()) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
    ) {
        return true;
    }
    if (
        host.slide?.allowedKeys?.includes(code) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
    ) {
        return true;
    }
    const target = event.target as HTMLElement | null;
    if (
        target?.closest?.('[data-tour-action]') &&
        (event.key === 'Enter' || event.key === ' ')
    ) {
        return true;
    }
    return false;
}

function onTourKeyDown(event: KeyboardEvent): void {
    if (isTourKeyEventAllowed(event)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function bindSpotlightChrome(): void {
    const host = getHost();
    if (host.root) {
        return;
    }

    const root = document.createElement('div');
    root.className = 'tour-spotlight-root';
    root.style.zIndex = String(OVERLAY_Z_INDEX);

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.classList.add('tour-spotlight-svg');
    svg.setAttribute('aria-hidden', 'true');

    const defs = document.createElementNS(svgNs, 'defs');
    const mask = document.createElementNS(svgNs, 'mask');
    mask.id = 'tour-cutout-mask';
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'luminance');

    const maskBg = document.createElementNS(svgNs, 'rect');
    maskBg.classList.add('tour-spotlight-mask-bg');
    maskBg.setAttribute('x', '0');
    maskBg.setAttribute('y', '0');
    maskBg.setAttribute('fill', '#fff');

    const path = document.createElementNS(svgNs, 'path');
    path.classList.add('tour-spotlight-holes');
    path.setAttribute('fill', '#000');
    mask.append(maskBg, path);
    defs.append(mask);

    const dimmerRect = document.createElementNS(svgNs, 'rect');
    dimmerRect.classList.add('tour-spotlight-dimmer-rect');
    dimmerRect.setAttribute('x', '0');
    dimmerRect.setAttribute('y', '0');
    dimmerRect.setAttribute('mask', 'url(#tour-cutout-mask)');
    svg.append(defs, dimmerRect);

    const hitLayer = document.createElement('div');
    hitLayer.className = 'tour-spotlight-hit';

    const anchor = document.createElement('div');
    anchor.className = 'tour-tooltip-anchor';

    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-modal', 'true');

    root.append(svg, hitLayer, anchor);
    document.body.append(root);

    host.root = root;
    host.svg = svg;
    host.maskBg = maskBg;
    host.dimmerRect = dimmerRect;
    host.maskPath = path;
    host.hitLayer = hitLayer;
    host.tooltip = tooltip;
    host.tippy = tippy(anchor, {
        content: tooltip,
        interactive: true,
        trigger: 'manual',
        hideOnClick: false,
        theme: 'tour',
        arrow: true,
        animation: false,
        maxWidth: 340,
        offset: [0, 16],
        zIndex: OVERLAY_Z_INDEX + 1,
        appendTo: () => root,
        popperOptions: {
            strategy: 'fixed'
        }
    });
}

function tooltipButton(
    action: string,
    label: string,
    onClick: () => void,
    primary = false
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary
        ? 'dialog-button dialog-button-primary'
        : 'dialog-button';
    button.dataset.tourAction = action;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function tooltipIconButton(
    action: string,
    label: string,
    icon: string,
    onClick: () => void
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tour-tooltip-icon';
    button.dataset.tourAction = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    const symbol = document.createElement('span');
    symbol.className = 'material-symbols-outlined';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = icon;
    button.append(symbol);
    button.addEventListener('click', onClick);
    return button;
}

/** Show Restart Step once the user has started the exercise. */
function revealTourRestart(): void {
    const restart = getHost().tooltip?.querySelector<HTMLButtonElement>(
        '[data-tour-action="restart"]'
    );
    if (restart) {
        restart.hidden = false;
    }
}

/** Tooltip buttons only act while their slide is up and idle. */
function guardSlideAction(slide: TourSlide, action: () => void): () => void {
    return () => {
        const host = getHost();
        if (
            host.slide !== slide ||
            !host.visible ||
            host.advancing ||
            host.restoring
        ) {
            return;
        }
        action();
    };
}

function fillTooltip(slide: TourSlide): void {
    const host = getHost();
    if (!host.tooltip) {
        return;
    }
    const navigation = host.navigation;
    const titleId = 'tour-tooltip-title';
    host.tooltip.setAttribute('aria-labelledby', titleId);
    host.tooltip.replaceChildren();

    const header = document.createElement('div');
    header.className = 'tour-tooltip-header';
    const title = document.createElement('h3');
    title.id = titleId;
    title.textContent = slide.tooltip.title;
    header.append(title);
    const tools = document.createElement('div');
    tools.className = 'tour-tooltip-tools';
    if (navigation?.onBack) {
        tools.append(
            tooltipIconButton(
                'back',
                'Back',
                'arrow_back',
                guardSlideAction(slide, navigation.onBack)
            )
        );
    }
    // Only multi-action drawing exercises restart; the button shows once
    // the first press counts (see `revealTourRestart`).
    if (getTourGuideGate(slide.drawingGuides) && navigation?.onRestart) {
        const restart = tooltipIconButton(
            'restart',
            'Restart Step',
            'restart_alt',
            guardSlideAction(slide, navigation.onRestart)
        );
        restart.hidden = true;
        tools.append(restart);
    }
    if (navigation?.onCancel) {
        const onCancel = navigation.onCancel;
        // Ending the tour works even while a step is advancing.
        tools.append(
            tooltipIconButton('cancel', 'End Tour', 'close', () => {
                if (host.slide === slide && host.visible) {
                    onCancel();
                }
            })
        );
    }
    if (tools.childElementCount > 0) {
        header.append(tools);
    }
    host.tooltip.append(header);
    appendTooltipBody(host.tooltip, slide.tooltip.body);

    const buttons: HTMLButtonElement[] = [];
    if (slide.tooltip.continueLabel) {
        buttons.push(
            tooltipButton(
                'continue',
                slide.tooltip.continueLabel,
                guardSlideAction(slide, () => {
                    host.onContinue?.();
                }),
                true
            )
        );
    }
    if (buttons.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'tour-tooltip-actions';
        actions.append(...buttons);
        host.tooltip.append(actions);
    }
}

function toNavigation(
    navigation: TourNavigation | (() => void)
): TourNavigation {
    return typeof navigation === 'function'
        ? { onContinue: navigation }
        : navigation;
}

export async function showTourSlide(
    slide: TourSlide,
    navigation: TourNavigation | (() => void),
    options?: { keepCutouts?: boolean }
): Promise<void> {
    bindSpotlightChrome();
    const host = getHost();
    const nav = toNavigation(navigation);
    host.slide = slide;
    host.navigation = nav;
    host.onContinue = nav.onContinue;
    host.visible = true;
    host.advancing = false;
    host.restoring = false;
    host.pendingAdvance = false;
    host.previewingSampleText = false;
    stopSampleTextTracking();
    setViewShortcutLock(slide);
    if (!host.listenersBound) {
        window.addEventListener('keydown', onTourKeyDown, true);
        window.addEventListener('resize', onTourGeometryChange);
        window.addEventListener('glyphCanvasRendered', onTourGeometryChange);
        window.addEventListener('editorModeChanged', onTourGeometryChange);
        host.listenersBound = true;
    }
    fillTooltip(slide);
    await slide.prepare?.();
    const keepCutouts = options?.keepCutouts === true;
    paintSpotlight(slide, { punchHits: keepCutouts });

    if (!host.resizeObserver && typeof ResizeObserver !== 'undefined') {
        host.resizeObserver = new ResizeObserver(() => {
            if (shouldPaintTourGeometry(host) && host.slide) {
                paintSpotlight(host.slide);
            }
        });
        host.resizeObserver.observe(document.documentElement);
    }

    host.root?.classList.add('is-visible');
    requestAnimationFrame(() => {
        if (host.slide) {
            // A throttled frame can land after the slide became interactive.
            paintSpotlight(host.slide, {
                punchHits: keepCutouts || host.slideUnbind !== null
            });
        }
        host.root?.classList.add('is-cutouts-visible');
        host.root?.classList.add('is-tooltip-visible');
        const continueBtn = host.tooltip?.querySelector(
            '[data-tour-action="continue"]'
        ) as HTMLElement | null;
        continueBtn?.focus();
    });
    await wait(FADE_MS);
    if (host.slide !== slide || !host.visible) {
        return;
    }
    paintSpotlight(slide, { punchHits: true });
    bindSlideInteraction(slide);
}

let geometryFrame = 0;

function onTourGeometryChange(): void {
    if (geometryFrame) {
        return;
    }
    geometryFrame = window.requestAnimationFrame(() => {
        geometryFrame = 0;
        const host = getHost();
        if (shouldPaintTourGeometry(host) && host.slide) {
            if (host.previewingSampleText) {
                paintSampleTextPreview();
            } else {
                paintSpotlight(host.slide);
            }
        }
    });
}

export async function transitionTourSlide(
    slide: TourSlide,
    navigation: TourNavigation | (() => void)
): Promise<void> {
    const previous = getHost().slide;
    const keepCutouts = Boolean(
        previous?.cutouts.some((cutout) =>
            slide.cutouts.some((next) => next.id === cutout.id)
        )
    );
    unbindSlideInteraction();
    setTooltipVisible(false);
    if (!keepCutouts) {
        setCutoutsVisible(false);
    }
    await wait(FADE_MS);
    await showTourSlide(slide, navigation, { keepCutouts });
}

/**
 * Fade the current slide out and block all input while Back or Restart
 * step rebuilds app state. `showTourSlide` ends the block.
 */
export async function beginTourSlideRestore(): Promise<void> {
    const host = getHost();
    if (!host.visible) {
        return;
    }
    host.restoring = true;
    unbindSlideInteraction();
    stopSampleTextTracking();
    setHitPassthrough(false);
    setTooltipVisible(false);
    setCutoutsVisible(false);
    clearTourDrawingGuides();
    host.hitLayer?.replaceChildren();
    const blocker = document.createElement('div');
    blocker.className = 'tour-spotlight-hit-piece';
    blocker.style.inset = '0';
    host.hitLayer?.append(blocker);
    await wait(FADE_MS);
}

/** True while a slide waits for the user (not advancing or restoring). */
export function isTourSlideIdle(): boolean {
    const host = getHost();
    return (
        host.visible &&
        !!host.slide &&
        !host.advancing &&
        !host.restoring &&
        !host.pendingAdvance &&
        host.slideUnbind !== null
    );
}

export function getCurrentTourSlide(): TourSlide | null {
    return getHost().slide;
}

export function hideTourSpotlight(): void {
    const host = getHost();
    host.visible = false;
    host.slide = null;
    host.onContinue = null;
    host.navigation = null;
    host.advancing = false;
    host.restoring = false;
    host.pendingAdvance = false;
    host.previewingSampleText = false;
    stopSampleTextTracking();
    setHitPassthrough(false);
    unbindSlideInteraction();
    setViewShortcutLock(null);
    window.removeEventListener('keydown', onTourKeyDown, true);
    window.removeEventListener('resize', onTourGeometryChange);
    window.removeEventListener('glyphCanvasRendered', onTourGeometryChange);
    window.removeEventListener('editorModeChanged', onTourGeometryChange);
    host.listenersBound = false;
    host.resizeObserver?.disconnect();
    host.resizeObserver = null;
    host.root?.classList.remove('is-cutouts-visible');
    host.root?.classList.remove('is-tooltip-visible');
    host.root?.classList.remove('is-visible');
    host.tippy?.hide();
    clearTourDrawingGuides();
    window.setTimeout(() => {
        if (host.visible) {
            // The tour was started again during the fade.
            return;
        }
        host.tippy?.destroy();
        host.tippy = null;
        host.root?.remove();
        host.root = null;
        host.svg = null;
        host.maskBg = null;
        host.dimmerRect = null;
        host.maskPath = null;
        host.hitLayer = null;
        host.tooltip = null;
    }, FADE_MS);
}

async function waitForCondition(
    condition: () => boolean,
    timeoutMs: number
): Promise<boolean> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started >= timeoutMs) {
            return false;
        }
        await wait(50);
    }
    return true;
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}
