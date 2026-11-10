// Explains what makes Counterpunch switch to a downloaded version. Opened
// from the update notices in Preferences and in the launcher.

import { openDialog } from './font-windows/dialogs';

export function showUpdateInfo(): void {
    openDialog({ title: 'How updates work' }).body.innerHTML = `
        <p>A new version downloads in the background and then waits. Counterpunch switches to it in one of two ways:</p>
        <p><strong>You click Update.</strong> All open Counterpunch windows move to the new version. A window with unsaved changes keeps them and offers a reload.</p>
        <p><strong>You close every Counterpunch window.</strong> Once no tab or app window is left open, the new version takes over, and Counterpunch starts with it the next time you open it.</p>
        <p>Reloading a window, or closing only some of them, keeps the version you have.</p>`;
}
