/**
 * window-buttons.ts — Toolbar buttons for undo/redo and "Open in New Window".
 *
 * Wired up after DOM is ready. The undo/redo buttons reflect state from
 * the patch sync engine; the "new window" button opens the same font URL
 * as a linked editor window.
 */

import { Logger } from './logger';
import { runBridgeUndoRedo } from './change-bridge-init';
import { getUndoRedoContext } from './undo-redo-context';
import {
    encodeFeatures,
    encodeLocation,
    encodeTextForUrl,
    formatUrl
} from './url-state';
import {
    DEFAULT_LINE_HEIGHT_PERCENT,
    DEFAULT_TEXT_ALIGN,
    isTextAlign,
    parseLineHeightPercent
} from './glyph-canvas/text-run-layout';
import { windowRole } from './window-role';
import { SYNC_CHANNEL_QUERY_PARAM } from './window-sync';

const console = new Logger('WindowButtons');
const editorChildWindows = new Set<Window>();
const editorChildOrdinals = new WeakMap<Window, number>();
const editorThemeWindowId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let suppressEditorThemeBroadcast = false;

type ThemePreference = 'light' | 'dark' | 'auto';

interface EditorThemeMessage {
    type: 'editor-theme-sync';
    sourceWindowId: string;
    preference: ThemePreference;
    theme: 'light' | 'dark';
}

export interface LinkedWindowLaunchInfo {
    url: string;
    linkedOrdinal: number;
    sessionId: string;
    fontPath: string;
}

function isThemePreference(value: unknown): value is ThemePreference {
    return value === 'light' || value === 'dark' || value === 'auto';
}

function isEditorThemeMessage(data: unknown): data is EditorThemeMessage {
    if (!data || typeof data !== 'object') {
        return false;
    }

    const msg = data as Partial<EditorThemeMessage>;
    return (
        msg.type === 'editor-theme-sync' &&
        typeof msg.sourceWindowId === 'string' &&
        isThemePreference(msg.preference) &&
        (msg.theme === 'light' || msg.theme === 'dark')
    );
}

function getCurrentEditorTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'light'
        ? 'light'
        : 'dark';
}

function getCurrentThemePreference(): ThemePreference {
    const preference = window.themeSwitcher?.getCurrentTheme?.();
    return isThemePreference(preference) ? preference : 'auto';
}

function postEditorThemeToChildWindows(payload: EditorThemeMessage): void {
    pruneClosedEditorChildWindows();
    for (const win of Array.from(editorChildWindows)) {
        if (win.closed) {
            continue;
        }
        try {
            win.postMessage(payload, window.location.origin);
        } catch {
            // Ignore per-window postMessage failures.
        }
    }
}

function postEditorThemeToOpener(payload: EditorThemeMessage): void {
    if (!window.opener || window.opener.closed) {
        return;
    }
    try {
        window.opener.postMessage(payload, window.location.origin);
    } catch {
        // Ignore opener postMessage failures.
    }
}

function broadcastEditorTheme(preference: ThemePreference): void {
    const payload: EditorThemeMessage = {
        type: 'editor-theme-sync',
        sourceWindowId: editorThemeWindowId,
        preference,
        theme:
            preference === 'light'
                ? 'light'
                : preference === 'dark'
                  ? 'dark'
                  : getCurrentEditorTheme()
    };

    postEditorThemeToChildWindows(payload);
    postEditorThemeToOpener(payload);
}

function pruneClosedEditorChildWindows(): void {
    for (const win of Array.from(editorChildWindows)) {
        if (!win.closed) {
            continue;
        }
        editorChildWindows.delete(win);
        const ordinal = editorChildOrdinals.get(win);
        if (ordinal) {
            windowRole.releaseLinkedOrdinal(ordinal, true);
        }
    }
}

function registerEditorChildWindow(win: Window, linkedOrdinal?: number): void {
    editorChildWindows.add(win);
    if (linkedOrdinal && linkedOrdinal > 0) {
        editorChildOrdinals.set(win, linkedOrdinal);
    }

    const pushTheme = () => {
        if (win.closed) {
            pruneClosedEditorChildWindows();
            return;
        }

        const payload: EditorThemeMessage = {
            type: 'editor-theme-sync',
            sourceWindowId: editorThemeWindowId,
            preference: getCurrentThemePreference(),
            theme: getCurrentEditorTheme()
        };

        try {
            win.postMessage(payload, window.location.origin);
        } catch {
            // Ignore per-window postMessage failures.
        }
    };

    win.addEventListener('load', pushTheme);
    window.setTimeout(pushTheme, 200);
}

function buildLinkedWindowReloadUrl(childWindow: Window): string {
    const url = new URL(window.location.href);
    const childUrl = new URL(childWindow.location.href);
    const linkedOrdinal = childUrl.searchParams.get('linked');
    const sessionId = childUrl.searchParams.get('windowSession');

    applyCurrentEditorStateToUrl(url);

    if (linkedOrdinal) {
        url.searchParams.set('linked', linkedOrdinal);
    }
    if (sessionId) {
        url.searchParams.set('windowSession', sessionId);
    }

    url.searchParams.set('sync', 'true');
    applyMainSyncChannelToUrl(url);
    url.searchParams.set('theme', getCurrentThemePreference());
    return formatUrl(url);
}

/** Linked windows join this window's document channel, whatever the font path. */
function applyMainSyncChannelToUrl(url: URL): void {
    const channelName = window.windowSync?.channelName;
    if (channelName) {
        url.searchParams.set(SYNC_CHANNEL_QUERY_PARAM, channelName);
    } else {
        url.searchParams.delete(SYNC_CHANNEL_QUERY_PARAM);
    }
}

function applyCurrentEditorStateToUrl(url: URL): void {
    const currentFont = window.fontManager?.currentFont;
    const currentFontPluginId = currentFont?.sourcePlugin?.getId?.();
    const currentFontPath = currentFont?.path ?? null;
    const editorFile = window.stateManager?.editor_file;
    const textBuffer = window.stateManager?.editor_text_buffer;
    const cursorPosition = window.stateManager?.editor_cursor_position;
    const editorMode = window.stateManager?.editor_mode;
    const variationLocation = window.stateManager?.editor_variation_location;
    const activeFeatures = Object.entries(
        window.stateManager?.editor_opentype_features_in_subset || {}
    )
        .filter(([, enabled]) => enabled)
        .map(([tag]) => tag);

    if (typeof editorFile === 'string' && editorFile.length > 0) {
        url.searchParams.set('file', editorFile);
    } else if (currentFontPluginId && currentFontPath) {
        url.searchParams.set(
            'file',
            `${currentFontPluginId}:///${currentFontPath.startsWith('/') ? currentFontPath.slice(1) : currentFontPath}`
        );
    } else {
        url.searchParams.delete('file');
    }

    if (typeof textBuffer === 'string') {
        url.searchParams.set('text', encodeTextForUrl(textBuffer));
    } else {
        url.searchParams.delete('text');
    }

    if (typeof cursorPosition === 'number' && Number.isFinite(cursorPosition)) {
        url.searchParams.set('cursor', String(cursorPosition));
    } else {
        url.searchParams.delete('cursor');
    }

    if (editorMode === 'text' || editorMode === 'edit') {
        url.searchParams.set('mode', editorMode);
    } else {
        url.searchParams.delete('mode');
    }

    if (
        variationLocation &&
        typeof variationLocation === 'object' &&
        Object.keys(variationLocation).length > 0
    ) {
        url.searchParams.set('location', encodeLocation(variationLocation));
    } else {
        url.searchParams.delete('location');
    }

    if (activeFeatures.length > 0) {
        url.searchParams.set('features', encodeFeatures(activeFeatures));
    } else {
        url.searchParams.delete('features');
    }

    const lineHeight = parseLineHeightPercent(
        window.stateManager?.editor_line_height
    );
    if (lineHeight !== null && lineHeight !== DEFAULT_LINE_HEIGHT_PERCENT) {
        url.searchParams.set('lineheight', String(lineHeight));
    } else {
        url.searchParams.delete('lineheight');
    }

    const textAlign = window.stateManager?.editor_text_align;
    if (isTextAlign(textAlign) && textAlign !== DEFAULT_TEXT_ALIGN) {
        url.searchParams.set('align', textAlign);
    } else {
        url.searchParams.delete('align');
    }
}

export function prepareLinkedWindowOpen(): LinkedWindowLaunchInfo {
    pruneClosedEditorChildWindows();
    const url = new URL(window.location.href);
    const fontPath = window.fontManager?.currentFont?.path ?? 'unsaved';
    applyCurrentEditorStateToUrl(url);

    windowRole.configureLinkedWindowUrl(url, fontPath);
    applyMainSyncChannelToUrl(url);
    url.searchParams.set('theme', getCurrentThemePreference());

    const linkedOrdinal = Number.parseInt(
        url.searchParams.get('linked') || '',
        10
    );

    if (!Number.isFinite(linkedOrdinal) || linkedOrdinal <= 0) {
        throw new Error('Failed to allocate linked window ordinal');
    }

    return {
        url: formatUrl(url),
        linkedOrdinal,
        sessionId: windowRole.sessionId,
        fontPath
    };
}

export function openLinkedEditorWindow(
    launchInfo?: LinkedWindowLaunchInfo
): Window | null {
    const preparedLaunch = launchInfo || prepareLinkedWindowOpen();
    const childWindow = window.open(preparedLaunch.url, '_blank');
    if (childWindow) {
        registerEditorChildWindow(childWindow, preparedLaunch.linkedOrdinal);
    } else {
        windowRole.releaseLinkedOrdinal(preparedLaunch.linkedOrdinal, true);
    }
    return childWindow;
}

export function reloadLinkedEditorWindows(): void {
    pruneClosedEditorChildWindows();
    for (const childWindow of Array.from(editorChildWindows)) {
        if (childWindow.closed) {
            continue;
        }

        try {
            childWindow.location.replace(
                buildLinkedWindowReloadUrl(childWindow)
            );
        } catch (error) {
            console.warn('Failed to reload linked editor window', error);
        }
    }
}

function applyRemoteThemePreference(preference: ThemePreference): void {
    const switcher = window.themeSwitcher;
    if (!switcher || typeof switcher.setTheme !== 'function') {
        return;
    }

    if (switcher.getCurrentTheme?.() === preference) {
        return;
    }

    suppressEditorThemeBroadcast = true;
    try {
        switcher.setTheme(preference);
    } finally {
        suppressEditorThemeBroadcast = false;
    }
}

window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
        return;
    }

    if (!isEditorThemeMessage(event.data)) {
        return;
    }

    if (event.data.sourceWindowId === editorThemeWindowId) {
        return;
    }

    applyRemoteThemePreference(event.data.preference);
    postEditorThemeToChildWindows(event.data);
});

const themeObserver = new MutationObserver(() => {
    if (!suppressEditorThemeBroadcast) {
        broadcastEditorTheme(getCurrentThemePreference());
    }
});
themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
});

async function triggerUndoRedo(direction: 'undo' | 'redo'): Promise<void> {
    const bridge = window.patchSyncEngine;
    if (!bridge) {
        return;
    }

    const oe = window.glyphCanvas?.outlineEditor;
    const {
        rootGlyphName,
        undoGlyphName,
        undoLayerId,
        historyTargetKey,
        surface
    } = getUndoRedoContext();
    if (oe?.active && (!rootGlyphName || !undoGlyphName)) {
        if (undoGlyphName || undoLayerId) {
            console.warn(
                `Skipping ${direction}: active outline editor has incomplete glyph stack`
            );
            return;
        }
    }

    await runBridgeUndoRedo(
        direction,
        undoGlyphName,
        rootGlyphName,
        undoLayerId,
        historyTargetKey,
        surface
    );
}

export async function triggerUndo(): Promise<void> {
    await triggerUndoRedo('undo');
}

export async function triggerRedo(): Promise<void> {
    await triggerUndoRedo('redo');
}

function initWindowButtons(): void {
    (window as any).toolbarWindowActions = {
        undo: triggerUndo,
        redo: triggerRedo,
        openLinkedEditorWindow
    };
}

// Initialize after DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWindowButtons);
} else {
    initWindowButtons();
}
