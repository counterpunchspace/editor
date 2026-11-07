// Follow a new version in every font window (see app-update.ts): a window
// without unsaved work reloads into it; one with unsaved work keeps it and
// offers a reload.

import { Logger } from '../logger';
import {
    isApplyingUpdate,
    onNewVersionActive,
    shouldReloadForUpdate
} from '../app-update';
import { showNotice } from './dialogs';

const console = new Logger('FontWindows');

/** Unsaved or unsynced font changes, or a save that is still running. */
function hasUnsavedWork(win: Window): boolean {
    try {
        const manager = win.fontManager;
        const font = manager?.currentFont;
        if (win.saveButton?.isSaving) return true;
        if (!manager || !font) return false;
        return (
            manager.shouldShowDirtyState?.(font) === true ||
            manager.hasUnsyncedChanges?.(font) === true
        );
    } catch {
        return false; // the window went away
    }
}

onNewVersionActive(() => {
    const isView = window.windowRole?.isLinkedWindow?.() === true;
    let main: Window | null = null;
    try {
        main =
            isView && window.opener && !window.opener.closed
                ? window.opener
                : null;
    } catch {
        main = null;
    }
    const reload = shouldReloadForUpdate({
        applying: isApplyingUpdate(),
        hasUnsavedWork: hasUnsavedWork(window),
        isView,
        mainHasUnsavedWork: main ? hasUnsavedWork(main) : false
    });
    if (isApplyingUpdate()) return; // this window reloads by itself
    if (reload) {
        console.log('New version active: reloading');
        location.reload();
        return;
    }
    showNotice(
        'Counterpunch was updated in another window. This window keeps your unsaved changes on the previous version; save them, then reload.',
        { label: 'Reload', run: () => location.reload() }
    );
});
