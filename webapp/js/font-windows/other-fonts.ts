// `OtherFonts()` in Python: the fonts open in the other linked font windows.
//
// Linked windows share one JavaScript thread, so a script here can read and
// change another window's font model directly. Changes still have to land in
// that window's own history, sync and compile: the first time a script asks
// for the other fonts, each of those windows opens an edit session (as it
// does around its own scripts), and the sessions close when the script ends.

import { Logger } from '../logger';
import type { Font } from '../babelfont-model';
import { openPythonEditContext } from '../python-ui-sync';
import { commitPythonExecutionSyntheticChanges } from '../python-post-execution';
import { fontWindows } from './window-registry';

const console = new Logger('FontWindows');

type EditContext = ReturnType<typeof openPythonEditContext>;

/** What a font window offers scripts running in other windows. */
export type PythonGuestApi = {
    begin(code: string): EditContext;
    end(context: EditContext, outcome: { succeeded: boolean }): void;
};

const guest: PythonGuestApi = {
    begin: (code) => openPythonEditContext(code),
    end: (context, outcome) => {
        try {
            commitPythonExecutionSyntheticChanges(
                window.fontManager?.currentFont,
                context,
                window.patchSyncEngine,
                outcome
            );
        } finally {
            context.releaseRecordingSuppression?.();
            void window.fontManager?.updateDirtyIndicator?.();
        }
    }
};

// Edit sessions this window's running script opened in other windows.
const sessions = new Map<
    Window,
    { api: PythonGuestApi; context: EditContext }
>();

function endSessions(outcome: { succeeded: boolean }): void {
    for (const [win, session] of sessions) {
        try {
            if (!win.closed) session.api.end(session.context, outcome);
        } catch (error) {
            console.warn('Could not finish an edit in another window', error);
        }
    }
    sessions.clear();
}

let afterHookInstalled = false;
function closeSessionsAfterScript(): void {
    if (afterHookInstalled) return;
    afterHookInstalled = true;
    const existing = window.afterPythonExecution;
    window.afterPythonExecution = async (outcome, historyContext) => {
        endSessions(outcome ?? { succeeded: true });
        await existing?.(outcome, historyContext);
    };
}

/**
 * The font models of the other font windows, in window order. Called from
 * Python; opens an edit session in each window the first time per script.
 */
function otherFontModels(): Font[] {
    closeSessionsAfterScript();
    const models: Font[] = [];
    for (const win of fontWindows()) {
        try {
            const model = win.currentFontModel;
            const api = win.counterpunchPythonGuest;
            if (!model || !api) continue;
            if (!sessions.has(win)) {
                sessions.set(win, { api, context: api.begin('OtherFonts()') });
            }
            models.push(model);
        } catch (error) {
            console.warn('Skipped a font window', error);
        }
    }
    return models;
}

window.counterpunchPythonGuest = guest;
window.counterpunchOtherFontModels = otherFontModels;
addEventListener('pagehide', () => endSessions({ succeeded: false }));
