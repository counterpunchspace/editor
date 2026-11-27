/**
 * Reorderable tour script. Insert or move ids in TOUR_SLIDE_ORDER;
 * keep the matching entry in TOUR_SLIDES.
 */

import {
    captureTourDrawArea,
    getDrawAreaFontRect,
    resetTourDrawingSession,
    resetTourHandleProgress,
    type TourAdvanceWhen,
    type TourDrawingGuides
} from './tour-drawing';
import {
    delay,
    fontRectToCutout,
    getFontStations,
    getSelectedGlyphOutlineFontRect,
    getStationDisplayName,
    viewAnimationDelayMs
} from './tour-utils';
import {
    fitTourLetterIntoView,
    getTourComponentCutout,
    getTourLetterCutout
} from './tour-components';
import type { StickyEditTool } from './glyph-canvas/edit-tools';
import {
    bindTourAssistantTurn,
    bindTourFilterNewButton,
    bindTourFilterSave,
    bindTourFilterTurn,
    bindTourSignUp,
    fillTourAssistantPrompt,
    isTourSignedIn,
    needsTourSignUp,
    openTourFilterEditor,
    openTourSignUp,
    resetTourAiStep,
    revealTourFilterGlyphs,
    skipTourAiStep,
    TOUR_FILTER_DESCRIPTION,
    tourAiError,
    tourAiOutcome,
    tryTourAiStep,
    type TourAiOutcome,
    type TourAiStep
} from './tour-ai';

export type TourCutoutRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type TourCutout = {
    id: string;
    padding?: number;
    /**
     * Padding for the click-through hole. Omit to match `padding`.
     * Use `0` so a padded visual hole does not let neighbors receive clicks.
     */
    hitPadding?: number;
    radius?: number;
    /** When true, pointer events pass through the hole to the app. */
    interactive?: boolean;
    resolve: () => TourCutoutRect | null;
};

/** A text button at the bottom of the tooltip. */
export type TourButton = {
    label: string;
    /** `skip` runs the slide’s `onSkip`, then moves on. */
    action: 'continue' | 'skip';
    primary?: boolean;
    /** Runs before the action. */
    onClick?: () => void;
};

export type TourTooltip = {
    title: string;
    /**
     * `**bold**`, `_italic_`, `` `code` ``. Wrap the action sentence in
     * `_..._`. A function is read each time the slide is shown.
     */
    body: string | (() => string);
    targetCutoutId: string;
    continueLabel?: string;
    /** Bottom buttons, left to right; replace `continueLabel`. */
    buttons?: TourButton[] | (() => TourButton[]);
    placement?: 'top' | 'bottom' | 'left' | 'right';
};

/** What a slide’s `advanceOn` binder may do. */
export type TourAdvanceControls = {
    advance: () => void;
    skip: () => void;
};

/**
 * App state a slide starts from. Back and Restart step rebuild it, and the
 * tour restores it when the user leaves it (e.g. opens another glyph).
 */
export type TourStage =
    | {
          kind: 'text';
          ss04: boolean;
          /** Station to preview, or a `wght` location between stations. */
          master?: string;
          wght?: number;
      }
    | {
          /** Edit Mode on the first `l.ss04`. */
          kind: 'edit-l';
          layer: 'interpolated' | 'master';
          selectContour?: boolean;
      }
    | {
          /** Edit Mode on `edieresis`, inside these nested components. */
          kind: 'edieresis';
          components: string[];
      }
    | {
          kind: 'panels';
          focus?: string;
          /** Press the focused panel’s shortcut once more. */
          enlarge?: boolean;
      };

export type TourSlide = {
    id: string;
    stage: TourStage;
    cutouts: TourCutout[];
    tooltip: TourTooltip;
    /**
     * View shortcut keys (the letter, e.g. 'e') that remain active.
     * Empty / omitted blocks every Cmd/Ctrl+Shift view shortcut.
     */
    allowedViewShortcutKeys?: string[];
    /**
     * After one allowed view shortcut (or Cmd+Escape) is handled, block
     * further matches until the next slide.
     */
    consumeViewShortcut?: boolean;
    /** Let Cmd/Ctrl+Escape close the focused panel. */
    allowCmdEscape?: boolean;
    /** Advance when this view receives `viewFocused`. */
    advanceOnViewFocused?: string;
    /** Advance when this view receives `viewResized`. */
    advanceOnViewResized?: string;
    /** Advance when this view is collapsed after `viewResized`. */
    advanceOnViewCollapsed?: string;
    /** Clicking this selector (or its feature row) advances the tour. */
    advanceOnClick?: string;
    /** Feature buttons: wait until the control has `.enabled`. */
    advanceOnClickRequireEnabled?: boolean;
    /** Advance when this range input is released inside [min, max]. */
    advanceOnSlider?: {
        selector: string;
        min: number;
        max: number;
    };
    /**
     * While this slide is up, clamp a range input. Values at or below
     * `latchMaxWhenAtOrBelow` latch the high end so you cannot return to
     * the start station location.
     */
    axisClamp?: {
        selector: string;
        min: number;
        max: number;
        latchMaxWhenAtOrBelow: number;
    };
    /** Double-clicking this sample-text letter (e.g. `m`) advances. */
    advanceOnGlyphDoubleClick?: string;
    /**
     * With `advanceOnGlyphDoubleClick`: only advance once Edit Mode shows
     * this glyph, so a double-click that missed does not skip ahead.
     */
    expectEditGlyph?: string;
    /** Advance after the user drags a node on the letter cutout. */
    advanceOnNodeDrag?: boolean;
    /**
     * Wait after the slide's action before switching. Defaults to the
     * spotlight apply delay (feature / station clicks).
     */
    advanceDelayMs?: number;
    /**
     * When advancing from a click, fade to the sample-text spotlight first.
     * Defaults to true for `advanceOnClick`.
     */
    previewTextBeforeApply?: boolean;
    /** What that spotlight shows instead of the whole sample text. */
    previewCutouts?: TourCutout[];
    /**
     * Let the original click reach the app instead of intercepting and
     * replaying `click()`. Use for drawing rows whose handlers must run.
     */
    advanceOnClickPassThrough?: boolean;
    /**
     * Keep painting this slide’s cutouts while advancing so holes follow
     * interpolation / drawing-switch animation.
     */
    trackCutoutsWhileAdvancing?: boolean;
    /** Unmodified letter keys the tour key lock still lets through (`p`). */
    allowedKeys?: string[];
    /** Gray concentric marks on the glyph canvas. */
    drawingGuides?: TourDrawingGuides;
    /** Advance when this drawing-exercise goal is met. */
    advanceWhen?: TourAdvanceWhen;
    /**
     * Canvas / drawing actions are blocked unless this edit tool is active.
     * Wrong-tool clicks flash the spotlighted tool button.
     */
    requireTool?: StickyEditTool;
    /**
     * Escape while a nested component is open pops one level.
     * `exit-edit` also lets Escape leave Edit Mode.
     */
    escapePolicy?: 'component-levels' | 'exit-edit';
    /** Advance when component nesting depth equals this value. */
    advanceWhenComponentDepth?: number;
    /** Advance when Edit Mode is left. */
    advanceOnEditModeExit?: boolean;
    /**
     * Custom trigger, bound while the slide waits: call `advance` or
     * `skip`. Returns its cleanup.
     */
    advanceOn?: (controls: TourAdvanceControls) => () => void;
    /** Runs when the user skips this slide (button or `advanceOn`). */
    onSkip?: () => void;
    /** Read on every navigation; a slide that returns false is passed over. */
    showIf?: () => boolean;
    /** Back passes over this slide, to the start of its exercise. */
    skipOnBack?: boolean;
    /** Keys typed inside this selector (a dialog in a hole) reach the app. */
    allowTypingIn?: string;
    /** Repaint the holes when this element changes size. */
    watchSelector?: string;
    prepare?: () => void | Promise<void>;
};

export const TOUR_FUSTAT_PATH = '/user/Fustat.glyphs';
export const TOUR_SAMPLE_TEXT = 'hëllo مَرْحَباً';
export const TOUR_REGULAR_STATION_NAME = 'Regular';
export const TOUR_EXTRABOLD_STATION_NAME = 'ExtraBold';
export const TOUR_SS04_BUTTON_SELECTOR = 'button[data-feature-tag="ss04"]';
export const TOUR_EXTRABOLD_ITEM_SELECTOR =
    '.editor-drawing-item[data-tour-station="ExtraBold"]';
export const TOUR_WGHT_SLIDER_SELECTOR =
    '.editor-axis-slider[data-axis-tag="wght"]';
export const TOUR_DRAWINGS_WIDGET_SELECTOR =
    '#glyph-properties-section .editor-drawings-widget:not(.editor-feature-variations-widget)';
export const TOUR_SELECT_TOOL_SELECTOR = '#editor-tool-select';
export const TOUR_DRAW_TOOL_SELECTOR = '#editor-tool-pen';
export const TOUR_INSERT_TOOL_SELECTOR = '#editor-tool-insert';
export const TOUR_CONVERT_TOOL_SELECTOR = '#editor-tool-convert';
export const TOUR_TEXT_TOOL_SELECTOR = '#editor-tool-text';
export const TOUR_REQUIRED_TOOL_SELECTOR: Record<StickyEditTool, string> = {
    select: TOUR_SELECT_TOOL_SELECTOR,
    pen: TOUR_DRAW_TOOL_SELECTOR,
    insert: TOUR_INSERT_TOOL_SELECTOR,
    convert: TOUR_CONVERT_TOOL_SELECTOR,
    cut: '#editor-tool-cut'
};
export const TOUR_BREADCRUMB_SELECTOR = '#view-editor .editor-glyph-name';
export const TOUR_BREADCRUMB_BASE_SELECTOR = `${TOUR_BREADCRUMB_SELECTOR} .editor-glyph-chip`;
export const TOUR_EDIERESIS_LETTER = 'ë';
export const TOUR_COMPONENT_E = 'e';
export const TOUR_LETTER_L = 'l';
export const TOUR_COMPONENT_DIERESIS = 'dieresiscomb';
export const TOUR_COMPONENT_DOTACCENT = 'dotaccentcomb';
/** Inside the axis-sliders slide’s 500–700 target range. */
export const TOUR_INTERPOLATED_WGHT = 600;

function tourBody(text: string, action: string): string {
    const wrapped = action.startsWith('_') ? action : `_${action}_`;
    return `${text}\n\n${wrapped}`;
}

function tourAction(action: string): string {
    return action.startsWith('_') ? action : `_${action}_`;
}

async function waitForElement(
    selector: string,
    timeoutMs = 8000
): Promise<Element | null> {
    const started = Date.now();
    let element = document.querySelector(selector);
    while (!element && Date.now() - started < timeoutMs) {
        await delay(50);
        element = document.querySelector(selector);
    }
    return element;
}

function getNearestVerticalScroller(element: HTMLElement): HTMLElement | null {
    const named = element.closest('#glyph-editor-scroll-content');
    if (named instanceof HTMLElement) {
        return named;
    }
    let current = element.parentElement;
    while (current) {
        const style = window.getComputedStyle(current);
        if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            current.scrollHeight > current.clientHeight + 1
        ) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/**
 * Nested overflow:hidden ancestors make Element.scrollIntoView skip the
 * editor sidebar scroller. Move that scroller so the target is on-screen.
 */
function scrollTourTargetIntoView(element: HTMLElement): void {
    const container = getNearestVerticalScroller(element);
    if (container) {
        const elementRect = element.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const fullyVisible =
            elementRect.height > 0 &&
            containerRect.height > 0 &&
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom;
        if (!fullyVisible) {
            const delta =
                elementRect.top +
                elementRect.height / 2 -
                (containerRect.top + containerRect.height / 2);
            const maxTop = Math.max(
                0,
                container.scrollHeight - container.clientHeight
            );
            container.scrollTop = Math.min(
                maxTop,
                Math.max(0, container.scrollTop + delta)
            );
        }
        return;
    }
    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
}

export async function selectTourStationByName(name: string): Promise<void> {
    const canvas = window.glyphCanvas;
    const station = getFontStations().find(
        (entry) => getStationDisplayName(entry) === name
    );
    if (!station?.id || !canvas?.selectStation) {
        return;
    }
    await canvas.selectStation(station.id, station.location || {});
}

function markStationListItem(
    name: string,
    root: ParentNode = document
): HTMLElement | null {
    const items = root.querySelectorAll(
        '.editor-drawing-item[data-station-id]'
    );
    for (const item of items) {
        if (!(item instanceof HTMLElement)) {
            continue;
        }
        const label = item.querySelector('.station-item-name');
        if (label?.textContent?.trim() === name) {
            item.setAttribute('data-tour-station', name);
            return item;
        }
    }
    return null;
}

async function prepareSs04FeatureSlide(): Promise<void> {
    const button = await waitForElement(TOUR_SS04_BUTTON_SELECTOR);
    if (!(button instanceof HTMLElement)) {
        return;
    }
    if (button.classList.contains('enabled')) {
        button.click();
        await delay(0);
    }
    const row = button.closest('.editor-feature-row') || button;
    if (row instanceof HTMLElement) {
        scrollTourTargetIntoView(row);
    }
    await delay(50);
}

async function waitForExtraBoldDrawingItem(
    root: ParentNode = document
): Promise<HTMLElement | null> {
    const started = Date.now();
    let item = markStationListItem(TOUR_EXTRABOLD_STATION_NAME, root);
    while (!item && Date.now() - started < 8000) {
        await delay(50);
        item = markStationListItem(TOUR_EXTRABOLD_STATION_NAME, root);
    }
    return item;
}

async function prepareStationsListSlide(): Promise<void> {
    const item = await waitForExtraBoldDrawingItem();
    if (item) {
        scrollTourTargetIntoView(item);
    }
    await delay(50);
}

async function prepareAxisSlidersSlide(): Promise<void> {
    const scroller = document.getElementById('glyph-editor-scroll-content');
    if (scroller) {
        scroller.scrollTop = 0;
    }
    await waitForElement(TOUR_WGHT_SLIDER_SELECTOR);
    await delay(50);
}

function getTextRunGlyphMetrics(letter: string): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
} | null {
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    const viewport = canvas?.viewportManager;
    if (!canvas || !textRun || !viewport) {
        return null;
    }
    const glyphs = textRun.shapedGlyphs || [];
    const buffer = textRun.textBuffer || TOUR_SAMPLE_TEXT;
    const letterIndex = buffer.indexOf(letter);
    if (letterIndex < 0 || glyphs.length === 0) {
        return null;
    }
    const band = canvas.getTextModeVerticalMetricsBand();
    let xPosition = 0;
    for (const glyph of glyphs) {
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const xAdvance = glyph.ax || 0;
        const cluster = glyph.cl || 0;
        if (cluster === letterIndex) {
            return {
                minX: xPosition + xOffset,
                maxX: xPosition + xOffset + xAdvance,
                minY: band.lowest + yOffset,
                maxY: band.highest + yOffset
            };
        }
        xPosition += xAdvance;
    }
    return null;
}

function getTextRunCutout(): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !textRun || !viewport || !canvasEl) {
        return null;
    }

    const glyphs = textRun.shapedGlyphs || [];
    if (glyphs.length === 0) {
        return null;
    }

    const band = canvas.getTextModeVerticalMetricsBand();
    let minX = 0;
    let maxX = 0;
    let minY = band.lowest;
    let maxY = band.highest;
    let xPosition = 0;

    for (const glyph of glyphs) {
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const xAdvance = glyph.ax || 0;
        const glyphX = xPosition + xOffset;
        minX = Math.min(minX, glyphX);
        maxX = Math.max(maxX, glyphX + xAdvance);
        minY = Math.min(minY, band.lowest + yOffset);
        maxY = Math.max(maxY, band.highest + yOffset);
        xPosition += xAdvance;
    }

    return fontRectToCutout({ minX, maxX, minY, maxY });
}

export const TOUR_SAMPLE_TEXT_CUTOUT: TourCutout = {
    id: 'sample-text',
    padding: 28,
    radius: 12,
    resolve: getTextRunCutout
};

/** The glyphs shaped from the first `text` in the sample text. */
function getTextRunSpanCutout(text: string): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    if (!canvas || !textRun) {
        return null;
    }
    const buffer = textRun.textBuffer || TOUR_SAMPLE_TEXT;
    const start = buffer.indexOf(text);
    if (start < 0) {
        return null;
    }
    const end = start + text.length;
    const band = canvas.getTextModeVerticalMetricsBand();
    let minX = Infinity;
    let maxX = -Infinity;
    let xPosition = 0;
    for (const glyph of textRun.shapedGlyphs || []) {
        const cluster = glyph.cl || 0;
        if (cluster >= start && cluster < end) {
            const glyphX = xPosition + (glyph.dx || 0);
            minX = Math.min(minX, glyphX);
            maxX = Math.max(maxX, glyphX + (glyph.ax || 0));
        }
        xPosition += glyph.ax || 0;
    }
    if (!Number.isFinite(minX)) {
        return null;
    }
    return fontRectToCutout({
        minX,
        maxX,
        minY: band.lowest,
        maxY: band.highest
    });
}

function getTextRunLetterCutout(letter: string): TourCutoutRect | null {
    const metrics = getTextRunGlyphMetrics(letter);
    if (!metrics) {
        return null;
    }
    return fontRectToCutout(metrics);
}

/** Outline bounds in edit mode; text-run `m` before that. Follows interpolation. */
function getCurrentGlyphOutlineCutout(): TourCutoutRect | null {
    const outline = getSelectedGlyphOutlineFontRect();
    if (outline) {
        return fontRectToCutout(outline);
    }
    return getTextRunLetterCutout(TOUR_LETTER_L);
}

let frozenEnterEditLetterRect: TourCutoutRect | null = null;

/**
 * Keep the Text Mode first-`l` hole until this slide fades out, even after
 * Edit Mode has already swapped in the smaller outline bounds.
 */
function getEnterEditLetterCutout(): TourCutoutRect | null {
    if (
        window.glyphCanvas?.outlineEditor?.active &&
        frozenEnterEditLetterRect
    ) {
        return frozenEnterEditLetterRect;
    }
    const live = getTextRunLetterCutout(TOUR_LETTER_L);
    if (live) {
        frozenEnterEditLetterRect = live;
        return live;
    }
    return frozenEnterEditLetterRect;
}

function letterLCutout(interactive: boolean): TourCutout {
    return {
        id: 'letter-l',
        padding: 20,
        radius: 12,
        interactive,
        resolve: getCurrentGlyphOutlineCutout
    };
}

function enterEditLetterCutout(): TourCutout {
    return {
        id: 'letter-l',
        padding: 20,
        hitPadding: 0,
        radius: 12,
        interactive: true,
        resolve: getEnterEditLetterCutout
    };
}

function getDrawAreaAboveGlyphCutout(): TourCutoutRect | null {
    const area = getDrawAreaFontRect();
    if (!area) {
        return null;
    }
    return fontRectToCutout(area);
}

function getWghtSliderAreaCutout(): TourCutoutRect | null {
    const slider = document.querySelector(TOUR_WGHT_SLIDER_SELECTOR);
    const area =
        slider instanceof Element
            ? slider.closest('.editor-axis-container') || slider
            : null;
    return getElementCutoutFromElement(area);
}

async function prepareCantEditInterpolationsSlide(): Promise<void> {
    await waitForElement(TOUR_DRAWINGS_WIDGET_SELECTOR);
    const widget =
        document.querySelector(TOUR_DRAWINGS_WIDGET_SELECTOR) || document;
    let item = await waitForExtraBoldDrawingItem(widget);
    if (item) {
        scrollTourTargetIntoView(item);
    }
    window.glyphCanvas?.handleCmdZeroFit?.();
    await delay(200);
    item = markStationListItem(TOUR_EXTRABOLD_STATION_NAME, widget);
    if (item) {
        scrollTourTargetIntoView(item);
    }
    await delay(50);
}

function getElementCutoutFromElement(
    element: Element | null
): TourCutoutRect | null {
    if (!element) {
        return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
    };
}

function getElementCutout(selector: string): TourCutoutRect | null {
    return getElementCutoutFromElement(document.querySelector(selector));
}

function extraBoldDrawingCutout(id: string, rootSelector?: string): TourCutout {
    return {
        id,
        padding: 10,
        hitPadding: 0,
        radius: 8,
        interactive: true,
        resolve: () => {
            const root = rootSelector
                ? document.querySelector(rootSelector) || document
                : document;
            const item = markStationListItem(TOUR_EXTRABOLD_STATION_NAME, root);
            return getElementCutoutFromElement(item);
        }
    };
}

function toolCutout(id: string, selector: string): TourCutout {
    return {
        id,
        padding: 14,
        hitPadding: 0,
        radius: 10,
        interactive: true,
        resolve: () => getElementCutout(selector)
    };
}

function drawAreaCutout(): TourCutout {
    return {
        id: 'draw-area',
        padding: 20,
        radius: 16,
        interactive: true,
        resolve: getDrawAreaAboveGlyphCutout
    };
}

function letterCutout(id: string, letter: string): TourCutout {
    return {
        id,
        padding: 16,
        hitPadding: 0,
        radius: 12,
        interactive: true,
        resolve: () => getTourLetterCutout(letter)
    };
}

function componentCutout(id: string, reference: string): TourCutout {
    return {
        id,
        padding: 12,
        hitPadding: 0,
        radius: 12,
        interactive: true,
        resolve: () => getTourComponentCutout(reference)
    };
}

function breadcrumbCutout(id: string, selector: string): TourCutout {
    return {
        id,
        padding: 10,
        hitPadding: 0,
        radius: 8,
        interactive: true,
        resolve: () => getElementCutout(selector)
    };
}

async function prepareEdieresisSlide(): Promise<void> {
    await fitTourLetterIntoView(TOUR_EDIERESIS_LETTER);
}

async function prepareBreadcrumbSlide(minChips = 2): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const chips = document.querySelectorAll(TOUR_BREADCRUMB_BASE_SELECTOR);
        if (chips.length >= minChips) {
            break;
        }
        await delay(50);
    }
    await delay(50);
}

async function prepareFocusView(viewId: string): Promise<void> {
    window.focusView?.(viewId);
    await delay(viewAnimationDelayMs());
}

function unionCutoutRects(
    rects: Array<TourCutoutRect | null>
): TourCutoutRect | null {
    const valid = rects.filter((rect): rect is TourCutoutRect => !!rect);
    if (valid.length === 0) {
        return null;
    }
    const left = Math.min(...valid.map((rect) => rect.left));
    const top = Math.min(...valid.map((rect) => rect.top));
    const right = Math.max(...valid.map((rect) => rect.left + rect.width));
    const bottom = Math.max(...valid.map((rect) => rect.top + rect.height));
    return {
        left,
        top,
        width: right - left,
        height: bottom - top
    };
}

function panelCutout(id: string, selector: string, padding = 8): TourCutout {
    return {
        id,
        padding,
        radius: 8,
        resolve: () => getElementCutout(selector)
    };
}

function getBuiltInFiltersCutout(): TourCutoutRect | null {
    return unionCutoutRects([
        getElementCutout(
            '#overview-filters > .editor-section-title:not(.glyph-filter-user-header)'
        ),
        getElementCutout(
            '#overview-filters > .glyph-filter-tree:not(.glyph-filter-user-tree)'
        )
    ]);
}

function getUserFiltersCutout(): TourCutoutRect | null {
    return unionCutoutRects([
        getElementCutout('#overview-filters .glyph-filter-user-header'),
        getElementCutout('#overview-filters .glyph-filter-user-tree')
    ]);
}

async function prepareOverviewFiltersSlide(): Promise<void> {
    await waitForElement('#overview-filters .editor-section-title');
    const target = document.querySelector('#overview-filters');
    if (target instanceof HTMLElement) {
        scrollTourTargetIntoView(target);
    }
    await delay(50);
}

async function prepareUserFiltersSlide(): Promise<void> {
    await waitForElement('#overview-filters .glyph-filter-user-header');
    const target = document.querySelector(
        '#overview-filters .glyph-filter-user-header'
    );
    if (target instanceof HTMLElement) {
        scrollTourTargetIntoView(target);
    }
    await delay(50);
}

function prepareEnterEditModeSlide(): void {
    frozenEnterEditLetterRect = null;
}

function prepareDrawToolSlide(): void {
    resetTourDrawingSession();
    captureTourDrawArea();
}

function prepareBackgroundGuideSlide(): void {
    if (!getDrawAreaFontRect()) {
        captureTourDrawArea();
    }
}

function prepareHandlesSlide(): void {
    resetTourHandleProgress();
    prepareBackgroundGuideSlide();
}

const OVERVIEW_ENLARGED: TourStage = {
    kind: 'panels',
    focus: 'view-overview',
    enlarge: true
};
const ASSISTANT_PANEL: TourStage = { kind: 'panels', focus: 'view-assistant' };
const FILTER_EDITOR_SELECTOR = '.info-popup.gfe';
const SIGN_IN_DIALOG_SELECTOR = '.sign-in-dialog';
const ACTIVE_USER_FILTER_SELECTOR =
    '#overview-filters .glyph-filter-user-tree .glyph-filter-item.active';
const SKIP_BUTTON: TourButton = { label: 'Skip', action: 'skip' };

function isOutcome(step: TourAiStep, ...outcomes: TourAiOutcome[]): boolean {
    return outcomes.includes(tourAiOutcome(step));
}

/** Signed-in users came for the AI: they get no Skip. */
function skipButtons(): TourButton[] {
    return isTourSignedIn() ? [] : [SKIP_BUTTON];
}

function tryOrSkipButtons(step: TourAiStep): () => TourButton[] {
    return () => [
        ...skipButtons(),
        {
            label: 'Try It',
            action: 'continue',
            primary: true,
            onClick: () => tryTourAiStep(step)
        }
    ];
}

function userFiltersCutout(): TourCutout {
    return {
        id: 'user-filters',
        padding: 10,
        radius: 8,
        resolve: getUserFiltersCutout
    };
}

/** A dialog the user works in, on top of the dimmed app. */
function dialogCutout(id: string, selector: string): TourCutout {
    return {
        id,
        padding: 6,
        radius: 10,
        interactive: true,
        resolve: () => getElementCutout(selector)
    };
}

function signUpSlide(
    id: string,
    step: TourAiStep,
    stage: TourStage
): TourSlide {
    return {
        id,
        stage,
        tooltip: {
            title: 'Assistant Usage Needs an Account',
            body: 'The Assistant runs on AI models in the cloud, and every answer costs real money. With a free account you get AI credit every month at no cost to you, enough for this tour and plenty more.\n\nYou don’t enter your payment details. Just your email address to sign in.',
            targetCutoutId: 'sign-in',
            buttons: [SKIP_BUTTON],
            placement: 'left'
        },
        showIf: () => needsTourSignUp(step),
        skipOnBack: true,
        prepare: async () => {
            openTourSignUp(step);
            await waitForElement(SIGN_IN_DIALOG_SELECTOR);
        },
        advanceOn: bindTourSignUp(step),
        onSkip: () => skipTourAiStep(step),
        allowTypingIn: SIGN_IN_DIALOG_SELECTOR,
        watchSelector: SIGN_IN_DIALOG_SELECTOR,
        cutouts: [dialogCutout('sign-in', SIGN_IN_DIALOG_SELECTOR)]
    };
}

const EDIT_L_STATION: TourStage = { kind: 'edit-l', layer: 'master' };

export const TOUR_SLIDES: Record<string, TourSlide> = {
    'text-mode': {
        id: 'text-mode',
        stage: { kind: 'text', ss04: false, master: TOUR_REGULAR_STATION_NAME },
        tooltip: {
            title: 'Text Mode',
            body: 'In **Text Mode** you type the letters and words you want to design.',
            targetCutoutId: 'text-tool',
            continueLabel: 'Continue',
            placement: 'bottom'
        },
        cutouts: [
            TOUR_SAMPLE_TEXT_CUTOUT,
            {
                id: 'text-tool',
                padding: 14,
                radius: 10,
                resolve: () => getElementCutout('#editor-tool-text')
            }
        ]
    },
    'ss04-features': {
        id: 'ss04-features',
        stage: { kind: 'text', ss04: false, master: TOUR_REGULAR_STATION_NAME },
        tooltip: {
            title: 'Active OpenType features',
            body: tourBody(
                'The OpenType feature buttons will substitute or position glyphs according to features definitions in the font.',
                'Click on Stylistic Set 4 (**ss04**) to activate it.'
            ),
            targetCutoutId: 'ss04-feature',
            placement: 'left'
        },
        advanceOnClick: TOUR_SS04_BUTTON_SELECTOR,
        advanceOnClickRequireEnabled: true,
        // ss04 only swaps the l’s; the whole text would hide the change.
        previewCutouts: [
            {
                id: 'ss04-ls',
                padding: 20,
                radius: 12,
                resolve: () => getTextRunSpanCutout('ll')
            }
        ],
        prepare: prepareSs04FeatureSlide,
        cutouts: [
            {
                id: 'ss04-feature',
                padding: 12,
                radius: 8,
                interactive: true,
                resolve: () => {
                    const button = document.querySelector(
                        TOUR_SS04_BUTTON_SELECTOR
                    );
                    const row = button?.closest('.editor-feature-row');
                    if (row instanceof Element) {
                        return getElementCutoutFromElement(row);
                    }
                    return getElementCutout(TOUR_SS04_BUTTON_SELECTOR);
                }
            }
        ]
    },
    'stations-list': {
        id: 'stations-list',
        stage: { kind: 'text', ss04: true, master: TOUR_REGULAR_STATION_NAME },
        tooltip: {
            title: 'Stations List',
            body: tourBody(
                'Choosing another station in the **Stations List** will preview the font at that designspace location.',
                'Click on the ExtraBold station.'
            ),
            targetCutoutId: 'extrabold-station',
            placement: 'right'
        },
        advanceOnClick: TOUR_EXTRABOLD_ITEM_SELECTOR,
        prepare: prepareStationsListSlide,
        cutouts: [extraBoldDrawingCutout('extrabold-station')]
    },
    'axis-sliders': {
        id: 'axis-sliders',
        stage: {
            kind: 'text',
            ss04: true,
            master: TOUR_EXTRABOLD_STATION_NAME
        },
        tooltip: {
            title: 'Axis Sliders',
            body: tourBody(
                'The **Axis Sliders** allow fine-grained interpolation preview.',
                'Move the slider just a little bit to preview.'
            ),
            targetCutoutId: 'wght-slider',
            placement: 'left'
        },
        prepare: prepareAxisSlidersSlide,
        advanceOnSlider: {
            selector: TOUR_WGHT_SLIDER_SELECTOR,
            min: 500,
            max: 700
        },
        axisClamp: {
            selector: TOUR_WGHT_SLIDER_SELECTOR,
            min: 500,
            max: 700,
            latchMaxWhenAtOrBelow: 700
        },
        cutouts: [
            {
                id: 'wght-slider',
                padding: 16,
                radius: 8,
                interactive: true,
                resolve: getWghtSliderAreaCutout
            }
        ]
    },
    'enter-edit-mode': {
        id: 'enter-edit-mode',
        stage: { kind: 'text', ss04: true, wght: TOUR_INTERPOLATED_WGHT },
        tooltip: {
            title: 'Enter Edit Mode',
            body: tourBody(
                'In **Text Mode** you double-click on glyphs to edit them in **Edit Mode**.',
                'Double-click the first **l.ss04** to edit it.'
            ),
            targetCutoutId: 'letter-l',
            placement: 'top'
        },
        advanceOnGlyphDoubleClick: TOUR_LETTER_L,
        expectEditGlyph: 'l.ss04',
        advanceDelayMs: 1000,
        prepare: prepareEnterEditModeSlide,
        cutouts: [enterEditLetterCutout()]
    },
    'cant-edit-interpolations': {
        id: 'cant-edit-interpolations',
        stage: { kind: 'edit-l', layer: 'interpolated' },
        tooltip: {
            title: 'Can’t Edit Interpolations',
            body: tourBody(
                'Gray nodes mean that this is an **interpolation**, not a drawing, so you **can’t edit** this here. You need to return to a real drawing to edit.',
                'Click on the ExtraBold drawing.'
            ),
            targetCutoutId: 'letter-l',
            placement: 'right'
        },
        prepare: prepareCantEditInterpolationsSlide,
        advanceOnClick: TOUR_EXTRABOLD_ITEM_SELECTOR,
        advanceOnClickPassThrough: true,
        trackCutoutsWhileAdvancing: true,
        previewTextBeforeApply: false,
        advanceDelayMs: 500,
        cutouts: [
            letterLCutout(false),
            extraBoldDrawingCutout(
                'extrabold-drawing',
                TOUR_DRAWINGS_WIDGET_SELECTOR
            )
        ]
    },
    'select-tool': {
        id: 'select-tool',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Select Tool',
            body: tourBody(
                'The Select tool (shortcut `v`) is on by default when you enter.',
                'Select a node by mouse and move it a bit.'
            ),
            targetCutoutId: 'select-tool',
            placement: 'bottom'
        },
        allowedKeys: ['v'],
        requireTool: 'select',
        advanceOnNodeDrag: true,
        advanceDelayMs: 500,
        cutouts: [
            letterLCutout(true),
            toolCutout('select-tool', TOUR_SELECT_TOOL_SELECTOR)
        ]
    },
    'select-contour': {
        id: 'select-contour',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Select Contour',
            body: tourBody(
                'You can select a specific contour by double-clicking on any of the line or curve segments.',
                'Double-click on the gray spot to select the contour.'
            ),
            targetCutoutId: 'letter-l',
            placement: 'right'
        },
        allowedKeys: ['v'],
        requireTool: 'select',
        drawingGuides: 'contour-stem',
        advanceWhen: 'contour-selected',
        advanceDelayMs: 500,
        prepare: prepareBackgroundGuideSlide,
        cutouts: [
            letterLCutout(true),
            toolCutout('select-tool', TOUR_SELECT_TOOL_SELECTOR)
        ]
    },
    'delete-objects': {
        id: 'delete-objects',
        stage: { kind: 'edit-l', layer: 'master', selectContour: true },
        tooltip: {
            title: 'Delete Objects',
            body: tourBody(
                'You can delete selected objects using either the `Delete` or `Backspace` keys.',
                'Press `Delete` or `Backspace`'
            ),
            targetCutoutId: 'letter-l',
            placement: 'right'
        },
        allowedKeys: ['delete', 'backspace'],
        requireTool: 'select',
        advanceWhen: 'path-deleted',
        advanceDelayMs: 500,
        cutouts: [
            letterLCutout(true),
            toolCutout('select-tool', TOUR_SELECT_TOOL_SELECTOR)
        ]
    },
    'draw-tool': {
        id: 'draw-tool',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Draw Tool',
            body: tourBody(
                'The Draw tool (shortcut `p`) places nodes one by one to build a contour.',
                'Select the Draw tool and click the gray mark. After each node, the next mark appears. Close the shape by returning to the first node — a red crosshair appears when you hover it.'
            ),
            targetCutoutId: 'draw-area',
            placement: 'right'
        },
        allowedKeys: ['p'],
        requireTool: 'pen',
        drawingGuides: 'lss04-oncurves',
        advanceWhen: 'closed-path',
        advanceDelayMs: 500,
        prepare: prepareDrawToolSlide,
        cutouts: [
            drawAreaCutout(),
            toolCutout('draw-tool', TOUR_DRAW_TOOL_SELECTOR)
        ]
    },
    'convert-tool': {
        id: 'convert-tool',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Convert Tool',
            body: tourBody(
                'The Convert tool (shortcut `c`) turns a straight segment into a curve.',
                'Select the Convert tool and click the gray mark on each of the two segments that should be curves.'
            ),
            targetCutoutId: 'convert-tool',
            placement: 'bottom'
        },
        allowedKeys: ['c'],
        requireTool: 'convert',
        drawingGuides: 'lss04-segments',
        advanceWhen: 'segments-converted',
        advanceDelayMs: 500,
        prepare: prepareBackgroundGuideSlide,
        cutouts: [
            drawAreaCutout(),
            toolCutout('convert-tool', TOUR_CONVERT_TOOL_SELECTOR)
        ]
    },
    'smooth-curve-toggle': {
        id: 'smooth-curve-toggle',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Smooth Curve Toggle',
            body: tourBody(
                'Double-clicking an on-curve node with the **Select** tool toggles **smooth** connections so the handles stay in a line.',
                'Select the Select tool, then double-click the two gray-marked nodes.'
            ),
            targetCutoutId: 'select-tool',
            placement: 'bottom'
        },
        allowedKeys: ['v'],
        drawingGuides: 'lss04-smooth',
        advanceWhen: 'nodes-smoothed',
        advanceDelayMs: 500,
        requireTool: 'select',
        prepare: prepareBackgroundGuideSlide,
        cutouts: [
            drawAreaCutout(),
            toolCutout('select-tool', TOUR_SELECT_TOOL_SELECTOR)
        ]
    },
    'place-handles': {
        id: 'place-handles',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Curve Handles',
            body: tourBody(
                'Off-curve handles shape the curve between on-curve nodes.',
                'Drag the handle along the arrow onto the gray marks, then do the same with the second handle.'
            ),
            targetCutoutId: 'select-tool',
            placement: 'bottom'
        },
        allowedKeys: ['v'],
        requireTool: 'select',
        drawingGuides: 'lss04-handles',
        advanceWhen: 'handles-placed',
        advanceDelayMs: 500,
        prepare: prepareHandlesSlide,
        cutouts: [
            drawAreaCutout(),
            toolCutout('select-tool', TOUR_SELECT_TOOL_SELECTOR)
        ]
    },
    'component-glyphs': {
        id: 'component-glyphs',
        stage: EDIT_L_STATION,
        tooltip: {
            title: 'Component Glyphs',
            body: tourAction('Double-click a component glyph to edit it.'),
            targetCutoutId: 'edieresis',
            placement: 'top'
        },
        advanceOnGlyphDoubleClick: TOUR_EDIERESIS_LETTER,
        expectEditGlyph: 'edieresis',
        advanceDelayMs: 1000,
        prepare: prepareEdieresisSlide,
        cutouts: [letterCutout('edieresis', TOUR_EDIERESIS_LETTER)]
    },
    'component-e': {
        id: 'component-e',
        stage: { kind: 'edieresis', components: [] },
        tooltip: {
            title: 'Component Glyphs',
            body: tourBody(
                'This glyph is composed of references to other glyphs, called **components**. Manually aligned components are colored faint orange, automatically aligned components are colored faint blue.',
                "Double-click on the 'e' component to edit it in place."
            ),
            targetCutoutId: 'component-e',
            placement: 'right'
        },
        advanceOnGlyphDoubleClick: TOUR_COMPONENT_E,
        advanceWhenComponentDepth: 1,
        advanceDelayMs: 1000,
        cutouts: [componentCutout('component-e', TOUR_COMPONENT_E)]
    },
    'exit-components': {
        id: 'exit-components',
        stage: { kind: 'edieresis', components: [TOUR_COMPONENT_E] },
        tooltip: {
            title: 'Exit Components',
            body: tourAction(
                'Press `Escape` or click the base glyph in the navigation breadcrumb to return to the base glyph.'
            ),
            targetCutoutId: 'breadcrumb-base',
            placement: 'bottom'
        },
        escapePolicy: 'component-levels',
        advanceWhenComponentDepth: 0,
        advanceDelayMs: 500,
        prepare: () => prepareBreadcrumbSlide(2),
        cutouts: [
            breadcrumbCutout('breadcrumb-base', TOUR_BREADCRUMB_BASE_SELECTOR)
        ]
    },
    'enter-another-component': {
        id: 'enter-another-component',
        stage: { kind: 'edieresis', components: [] },
        tooltip: {
            title: 'Enter Another Component',
            body: tourAction(
                'Double-click on the dots to enter another component.'
            ),
            targetCutoutId: 'dieresiscomb',
            placement: 'top'
        },
        advanceOnGlyphDoubleClick: TOUR_COMPONENT_DIERESIS,
        advanceWhenComponentDepth: 1,
        advanceDelayMs: 1000,
        cutouts: [componentCutout('dieresiscomb', TOUR_COMPONENT_DIERESIS)]
    },
    'nested-components': {
        id: 'nested-components',
        stage: { kind: 'edieresis', components: [TOUR_COMPONENT_DIERESIS] },
        tooltip: {
            title: 'Nested Components',
            body: tourBody(
                'Components may be **nested**, meaning they may be composed of more component references. These two dots are composed of two single-dot components.',
                'Double-click again to enter the next nesting level.'
            ),
            targetCutoutId: 'dotaccentcomb',
            placement: 'right'
        },
        advanceOnGlyphDoubleClick: TOUR_COMPONENT_DOTACCENT,
        advanceWhenComponentDepth: 2,
        advanceDelayMs: 1000,
        cutouts: [componentCutout('dotaccentcomb', TOUR_COMPONENT_DOTACCENT)]
    },
    'exit-nested-components': {
        id: 'exit-nested-components',
        stage: {
            kind: 'edieresis',
            components: [TOUR_COMPONENT_DIERESIS, TOUR_COMPONENT_DOTACCENT]
        },
        tooltip: {
            title: 'Exit Nested Components',
            body: tourBody(
                'The so-called **breadcrumb** shows the nesting levels you have entered. The base glyph is the first glyph on the left, the nested glyph you’re currently editing is the last glyph on the right.',
                'Return to the base glyph by clicking on the first glyph in the breadcrumb or by pressing `Escape` multiple times.'
            ),
            targetCutoutId: 'breadcrumb',
            placement: 'bottom'
        },
        escapePolicy: 'component-levels',
        advanceWhenComponentDepth: 0,
        advanceDelayMs: 500,
        prepare: () => prepareBreadcrumbSlide(3),
        cutouts: [breadcrumbCutout('breadcrumb', TOUR_BREADCRUMB_SELECTOR)]
    },
    'exit-edit-mode': {
        id: 'exit-edit-mode',
        stage: { kind: 'edieresis', components: [] },
        tooltip: {
            title: 'Exit Edit Mode',
            body: tourAction(
                'Use the Text tool (shortcut `t`) or press `Escape` again to return to Text Mode.'
            ),
            targetCutoutId: 'text-tool',
            placement: 'bottom'
        },
        allowedKeys: ['t'],
        escapePolicy: 'exit-edit',
        advanceOnEditModeExit: true,
        advanceDelayMs: 1000,
        cutouts: [toolCutout('text-tool', TOUR_TEXT_TOOL_SELECTOR)]
    },
    'glyph-overview-panel': {
        id: 'glyph-overview-panel',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Glyph Overview Panel',
            body: tourBody(
                'The **Glyph Overview** panel contains all glyphs with glyph filters. You can click on the collapsed panel to open it, but it also opens with the `Cmd/Ctrl+Shift+O` keyboard shortcut.',
                'Press `Cmd/Ctrl+Shift+O` to open it.'
            ),
            targetCutoutId: 'overview-title',
            placement: 'left'
        },
        allowedViewShortcutKeys: ['o'],
        consumeViewShortcut: true,
        advanceOnViewFocused: 'view-overview',
        advanceDelayMs: 500,
        cutouts: [panelCutout('overview-title', '#view-overview')]
    },
    'enlarge-panel-keyboard': {
        id: 'enlarge-panel-keyboard',
        stage: { kind: 'panels', focus: 'view-overview' },
        tooltip: {
            title: 'Enlarge Panel by Keyboard',
            body: tourBody(
                'All panels can be enlarged by pressing their keyboard shortcut several times. Some panels have up to three size stages.',
                'Press `Cmd/Ctrl+Shift+O` again.'
            ),
            targetCutoutId: 'overview-title-controls',
            placement: 'bottom'
        },
        allowedViewShortcutKeys: ['o'],
        consumeViewShortcut: true,
        advanceOnViewResized: 'view-overview',
        advanceDelayMs: 500,
        cutouts: [
            panelCutout(
                'overview-title-controls',
                '#view-overview .view-title-left'
            )
        ]
    },
    'glyph-filters': {
        id: 'glyph-filters',
        stage: { kind: 'panels', focus: 'view-overview', enlarge: true },
        tooltip: {
            title: 'Glyph Filters',
            body: 'The sidebar contains filters that show certain subsets of the font. The filters in the upper section ship with the app by default.',
            targetCutoutId: 'built-in-filters',
            continueLabel: 'Continue',
            placement: 'right'
        },
        prepare: prepareOverviewFiltersSlide,
        cutouts: [
            {
                id: 'built-in-filters',
                padding: 10,
                radius: 8,
                resolve: getBuiltInFiltersCutout
            }
        ]
    },
    'user-filters': {
        id: 'user-filters',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'User Filters',
            body: 'The lower section is for your own filters. They are Python scripts, but you don’t have to write the code: describe what the filter should show, and the Assistant writes it for you.\n\nWant to try it? You need a free account for this.',
            targetCutoutId: 'user-filters',
            buttons: tryOrSkipButtons('filter'),
            placement: 'right'
        },
        prepare: async () => {
            resetTourAiStep('filter');
            await prepareUserFiltersSlide();
        },
        onSkip: () => skipTourAiStep('filter'),
        cutouts: [userFiltersCutout()]
    },
    'ai-filter-sign-up': signUpSlide(
        'ai-filter-sign-up',
        'filter',
        OVERVIEW_ENLARGED
    ),
    'ai-filter-new': {
        id: 'ai-filter-new',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'New Filter',
            body: tourBody(
                'You create a new filter with the **+** button in the User Filters title.',
                'Click **+** to create a new filter.'
            ),
            targetCutoutId: 'new-filter-button',
            buttons: skipButtons,
            placement: 'right'
        },
        showIf: () => tourAiOutcome('filter') === 'trying',
        skipOnBack: true,
        prepare: prepareUserFiltersSlide,
        advanceOn: bindTourFilterNewButton,
        advanceDelayMs: 0,
        onSkip: () => skipTourAiStep('filter'),
        cutouts: [
            {
                id: 'new-filter-button',
                padding: 6,
                radius: 6,
                interactive: true,
                resolve: () =>
                    getElementCutout('#overview-filters .glyph-filter-new-btn')
            }
        ]
    },
    'ai-filter-describe': {
        id: 'ai-filter-describe',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'Describe a Filter',
            body: tourBody(
                'The filter editor is open, with a description already filled in. You can change it if you like.\n\nBehind the scenes, an AI model writes the filter’s code and checks it against the font. That takes a moment. The tour moves on by itself when it’s done.',
                'Click **Update filter** to let the Assistant write the filter.'
            ),
            targetCutoutId: 'filter-editor',
            buttons: skipButtons,
            placement: 'left'
        },
        showIf: () => tourAiOutcome('filter') === 'trying',
        skipOnBack: true,
        prepare: async () => {
            await openTourFilterEditor();
            await waitForElement(FILTER_EDITOR_SELECTOR);
        },
        advanceOn: bindTourFilterTurn,
        onSkip: () => skipTourAiStep('filter'),
        allowTypingIn: '.gfe',
        watchSelector: FILTER_EDITOR_SELECTOR,
        cutouts: [dialogCutout('filter-editor', FILTER_EDITOR_SELECTOR)]
    },
    'ai-filter-result': {
        id: 'ai-filter-result',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'Check the Result',
            body: () =>
                tourAiOutcome('filter') === 'failed'
                    ? `${tourAiError('filter')} The filter wasn’t written this time.`
                    : tourBody(
                          'The Assistant wrote the filter. Below the description, it lists the glyphs it found.',
                          'Check the glyphs, then click **OK** to save the filter.'
                      ),
            targetCutoutId: 'filter-editor',
            buttons: () =>
                tourAiOutcome('filter') === 'failed'
                    ? [{ label: 'Continue', action: 'skip', primary: true }]
                    : skipButtons(),
            placement: 'left'
        },
        showIf: () => isOutcome('filter', 'trying', 'failed'),
        skipOnBack: true,
        prepare: async () => {
            revealTourFilterGlyphs();
            await delay(300);
        },
        advanceOn: bindTourFilterSave,
        onSkip: () => skipTourAiStep('filter'),
        allowTypingIn: '.gfe',
        watchSelector: FILTER_EDITOR_SELECTOR,
        cutouts: [dialogCutout('filter-editor', FILTER_EDITOR_SELECTOR)]
    },
    'ai-filter-in-sidebar': {
        id: 'ai-filter-in-sidebar',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'Your New Filter',
            body: () =>
                [
                    'Here is your filter, in the User Filters section. It’s turned on, so the glyph overview shows only its glyphs, in their colored groups.',
                    document.querySelector(
                        '#overview-filters .folder-setup-callout'
                    )
                        ? 'Without a Settings Folder, filters are kept in this browser. Set one up to keep them as files.'
                        : ''
                ]
                    .filter(Boolean)
                    .join('\n\n'),
            targetCutoutId: 'new-filter',
            continueLabel: 'Continue',
            placement: 'right'
        },
        showIf: () => tourAiOutcome('filter') === 'done',
        skipOnBack: true,
        prepare: async () => {
            const item = await waitForElement(ACTIVE_USER_FILTER_SELECTOR);
            if (item instanceof HTMLElement) {
                scrollTourTargetIntoView(item);
            }
            await delay(50);
        },
        cutouts: [
            {
                id: 'new-filter',
                padding: 6,
                radius: 8,
                resolve: () =>
                    getElementCutout(ACTIVE_USER_FILTER_SELECTOR) ??
                    getUserFiltersCutout()
            }
        ]
    },
    'ai-filter-skipped': {
        id: 'ai-filter-skipped',
        stage: OVERVIEW_ENLARGED,
        tooltip: {
            title: 'Filters in Words',
            body: () =>
                `${tourAiOutcome('filter') === 'failed' ? 'Had it worked' : 'Had you tried it'}, the Assistant would have turned one sentence into a working filter: “${TOUR_FILTER_DESCRIPTION}” The filter would have found Fustat’s stylistic-set alternates and sorted them into one colored group per set.\n\nYou can do this any time from the User Filters section.`,
            targetCutoutId: 'user-filters',
            continueLabel: 'Continue',
            placement: 'right'
        },
        showIf: () => isOutcome('filter', 'skipped', 'failed'),
        skipOnBack: true,
        prepare: prepareUserFiltersSlide,
        cutouts: [userFiltersCutout()]
    },
    'font-info-panel': {
        id: 'font-info-panel',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Font Info Panel',
            body: tourBody(
                'The **Font Info** panel contains the OpenType features, names, stations and axes and other metadata that are important for a font.',
                'Press `Cmd/Ctrl+Shift+I` to open it.'
            ),
            targetCutoutId: 'fontinfo-title',
            placement: 'right'
        },
        allowedViewShortcutKeys: ['i'],
        consumeViewShortcut: true,
        advanceOnViewFocused: 'view-fontinfo',
        advanceDelayMs: 500,
        cutouts: [panelCutout('fontinfo-title', '#view-fontinfo')]
    },
    'font-info-sections': {
        id: 'font-info-sections',
        stage: { kind: 'panels', focus: 'view-fontinfo' },
        tooltip: {
            title: 'Font Info Sections',
            body: 'Use the dropdown menu in the title bar to switch between the different sections.',
            targetCutoutId: 'fontinfo-sections',
            continueLabel: 'Continue',
            placement: 'bottom'
        },
        cutouts: [
            panelCutout(
                'fontinfo-sections',
                '#view-fontinfo .fontinfo-section-button',
                6
            )
        ]
    },
    'close-panels-keyboard': {
        id: 'close-panels-keyboard',
        stage: { kind: 'panels', focus: 'view-fontinfo' },
        tooltip: {
            title: 'Close Panels by Keyboard',
            body: tourBody(
                'All focussed panels may be closed by pressing `Cmd/Ctrl+Escape`.',
                'Press `Cmd/Ctrl+Escape`.'
            ),
            targetCutoutId: 'fontinfo-close',
            placement: 'bottom'
        },
        allowCmdEscape: true,
        consumeViewShortcut: true,
        advanceOnViewCollapsed: 'view-fontinfo',
        advanceDelayMs: 500,
        cutouts: [
            panelCutout(
                'fontinfo-close',
                '#view-fontinfo .view-title-collapse-btn',
                6
            )
        ]
    },
    'auxiliary-panels': {
        id: 'auxiliary-panels',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Auxiliary Panels',
            body: tourBody(
                'The lower line of panels is not always used for creating a font, but may be important in certain cases.',
                'Press `Cmd/Ctrl+Shift+A` to open the assistant.'
            ),
            targetCutoutId: 'bottom-row',
            placement: 'top'
        },
        allowedViewShortcutKeys: ['a'],
        consumeViewShortcut: true,
        advanceOnViewFocused: 'view-assistant',
        advanceDelayMs: 500,
        cutouts: [panelCutout('bottom-row', '.bottom-row', 4)]
    },
    'assistant': {
        id: 'assistant',
        stage: ASSISTANT_PANEL,
        tooltip: {
            title: 'Assistant',
            body: 'The Assistant is an AI chat. It finds and fixes technical problems in the font, writes glyph filters and other Python scripts, and answers questions about the editor.\n\nWant to try it? You need a free account for this.',
            targetCutoutId: 'assistant-panel',
            buttons: tryOrSkipButtons('assistant'),
            placement: 'top'
        },
        prepare: () => resetTourAiStep('assistant'),
        onSkip: () => skipTourAiStep('assistant'),
        cutouts: [panelCutout('assistant-panel', '#view-assistant', 6)]
    },
    'ai-assistant-sign-up': signUpSlide(
        'ai-assistant-sign-up',
        'assistant',
        ASSISTANT_PANEL
    ),
    'ai-assistant-ask': {
        id: 'ai-assistant-ask',
        stage: ASSISTANT_PANEL,
        tooltip: {
            title: 'Ask a Question',
            body: tourBody(
                'The question is already in the prompt box: can Fustat write Turkish, Polish and Vietnamese?\n\nThe answer can take a minute. The tour continues when it’s complete.',
                'Click **Ask Assistant** to send the question.'
            ),
            targetCutoutId: 'assistant-panel',
            buttons: skipButtons,
            placement: 'top'
        },
        showIf: () => tourAiOutcome('assistant') === 'trying',
        skipOnBack: true,
        prepare: fillTourAssistantPrompt,
        advanceOn: bindTourAssistantTurn,
        onSkip: () => skipTourAiStep('assistant'),
        allowTypingIn: '#view-assistant',
        cutouts: [
            {
                ...panelCutout('assistant-panel', '#view-assistant', 6),
                interactive: true
            }
        ]
    },
    'ai-assistant-result': {
        id: 'ai-assistant-result',
        stage: ASSISTANT_PANEL,
        tooltip: {
            title: 'Read the Answer',
            body: () =>
                tourAiOutcome('assistant') === 'failed'
                    ? `${tourAiError('assistant')} There’s no answer this time.`
                    : 'This is where you read the Assistant’s answers. Scroll up in the chat if the answer is longer than the panel.',
            targetCutoutId: 'assistant-panel',
            buttons: () =>
                tourAiOutcome('assistant') === 'failed'
                    ? [{ label: 'Continue', action: 'skip', primary: true }]
                    : [
                          {
                              label: 'Continue',
                              action: 'continue',
                              primary: true
                          }
                      ],
            placement: 'top'
        },
        showIf: () => isOutcome('assistant', 'done', 'failed'),
        skipOnBack: true,
        onSkip: () => skipTourAiStep('assistant'),
        cutouts: [
            {
                ...panelCutout('assistant-panel', '#view-assistant', 6),
                interactive: true
            }
        ]
    },
    'ai-assistant-skipped': {
        id: 'ai-assistant-skipped',
        stage: ASSISTANT_PANEL,
        tooltip: {
            title: 'Questions About Your Font',
            body: () =>
                `${tourAiOutcome('assistant') === 'failed' ? 'Had it worked' : 'Had you tried it'}, the Assistant would have checked Fustat’s glyphs and answered: Turkish and Polish are fully supported. Vietnamese is not, because the font lacks ơ and ư and the letters with a dot below or a hook above, like ạ and ả.\n\nYou can ask the Assistant anything about your font or the editor here.`,
            targetCutoutId: 'assistant-panel',
            continueLabel: 'Continue',
            placement: 'top'
        },
        showIf: () => isOutcome('assistant', 'skipped', 'failed'),
        skipOnBack: true,
        cutouts: [panelCutout('assistant-panel', '#view-assistant', 6)]
    },
    'allow-font-edits': {
        id: 'allow-font-edits',
        stage: { kind: 'panels', focus: 'view-assistant' },
        tooltip: {
            title: 'Allow Font Edits',
            body: 'You may prohibit or allow the assistant to make changes to your font or Python scripts. Toggle the permission with this button.',
            targetCutoutId: 'assistant-edit',
            continueLabel: 'Continue',
            placement: 'bottom'
        },
        cutouts: [panelCutout('assistant-edit', '#assistant-edit-toggle', 6)]
    },
    'script-editor': {
        id: 'script-editor',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Script Editor',
            body: 'The **Script Editor** is used to manually edit reusable Python scripts or glyph filters (which are also Python scripts).',
            targetCutoutId: 'scripts-panel',
            continueLabel: 'Continue',
            placement: 'top'
        },
        prepare: () => prepareFocusView('view-scripts'),
        cutouts: [panelCutout('scripts-panel', '#view-scripts', 6)]
    },
    'konsole': {
        id: 'konsole',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Konsole',
            body: 'The **Konsole** panel is a Python terminal used for quick font introspection or command execution. It’s also used for outputting `print()` commands from Python scripts.',
            targetCutoutId: 'konsole-panel',
            continueLabel: 'Continue',
            placement: 'top'
        },
        prepare: () => prepareFocusView('view-console'),
        cutouts: [panelCutout('konsole-panel', '#view-console', 6)]
    },
    'history': {
        id: 'history',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'History',
            body: 'The **History** panel contains a timeline of all edits. You can undo them with `Cmd/Ctrl+Z`. Each edit has a context, called **undo surface**, and you can undo edits only from within the same undo surface. Example: Edits to a drawing can only be undone when you’re back in the same drawing.',
            targetCutoutId: 'history-panel',
            continueLabel: 'Continue',
            placement: 'top'
        },
        prepare: () => prepareFocusView('view-history'),
        cutouts: [panelCutout('history-panel', '#view-history', 6)]
    },
    'find-help': {
        id: 'find-help',
        stage: { kind: 'panels' },
        tooltip: {
            title: 'Find Help',
            body: 'The Help menu contains a link to the complete Documentation (and you can repeat the tour here), and various panels contain buttons that take you directly to the relevant documentation sections.\n\nHave fun making fonts.',
            targetCutoutId: 'help-menu',
            continueLabel: 'Thank you',
            placement: 'bottom'
        },
        prepare: () => prepareFocusView('view-editor'),
        cutouts: [
            panelCutout('help-menu', '#toolbar-help-menu-btn', 8),
            panelCutout('editor-help', '#editor-info-btn', 6),
            panelCutout('assistant-help', '#assistant-info-btn', 6),
            panelCutout('scripts-help', '#script-api-docs-btn', 6)
        ]
    }
};

/** Authoritative sequence. Insert new slide ids here. */
export const TOUR_SLIDE_ORDER: string[] = [
    'text-mode',
    'ss04-features',
    'stations-list',
    'axis-sliders',
    'enter-edit-mode',
    'cant-edit-interpolations',
    'select-tool',
    'select-contour',
    'delete-objects',
    'draw-tool',
    'convert-tool',
    'smooth-curve-toggle',
    'place-handles',
    'component-glyphs',
    'component-e',
    'exit-components',
    'enter-another-component',
    'nested-components',
    'exit-nested-components',
    'exit-edit-mode',
    'glyph-overview-panel',
    'enlarge-panel-keyboard',
    'glyph-filters',
    'user-filters',
    'ai-filter-sign-up',
    'ai-filter-new',
    'ai-filter-describe',
    'ai-filter-result',
    'ai-filter-in-sidebar',
    'ai-filter-skipped',
    'font-info-panel',
    'font-info-sections',
    'close-panels-keyboard',
    'auxiliary-panels',
    'assistant',
    'ai-assistant-sign-up',
    'ai-assistant-ask',
    'ai-assistant-result',
    'ai-assistant-skipped',
    'allow-font-edits',
    'script-editor',
    'konsole',
    'history',
    'find-help'
];

export function getTourSlide(id: string): TourSlide | null {
    return TOUR_SLIDES[id] || null;
}

export function getTourSlideByIndex(index: number): TourSlide | null {
    const id = TOUR_SLIDE_ORDER[index];
    return id ? getTourSlide(id) : null;
}
