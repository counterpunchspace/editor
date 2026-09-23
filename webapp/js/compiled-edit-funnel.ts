/**
 * CompiledEditFunnel — single post-commit reaction owner for all editing compiles.
 *
 * Every committed Yjs packet, local or remote, enters this serialized funnel.
 * The funnel:
 *   1. Builds compile context from the committed packet metadata.
 *   2. Marks the compile request as worker-authoritative once the committed
 *      Yjs update is already in Rust.
 *   3. Requests the editing compile with that explicit context.
 *   4. Arms the deferred full-compile timer.
 *
 * The compile context is stored against the exact compile request revision.
 * After each processed edit, any transient compile or edit-source state is cleaned
 * up so one edit cannot poison the next one (APP.md Document Collaboration rule).
 *
 * Edit types that do not need compilation (guide) are detected
 * and skipped — no compile context is set, no compile is requested.
 */

import { Logger } from './logger';
import type { EditingCompileContext } from './font-manager';
import { compilationPlan, normalizeCompileEditStamp } from './edit-intent';

const console = new Logger('CompiledEditFunnel');

const DEFERRED_FULL_MS = 500;
const COMMITTED_DATA_FRESHNESS_MODE: EditingCompileContext['dataFreshnessMode'] =
    'authoritative-worker-yjs';

/** Edit types that should NOT trigger font recompilation. */
const NON_COMPILING_EDIT_TYPES = new Set<string>(['guide']);

let deferredTimer: number | null = null;

type CommittedCompilingEditType = EditingCompileContext['editType'];

function waitForEditingFontRevision(
    targetRevision: number,
    timeoutMs: number = 4000
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let timeoutId: number | null = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
            window.removeEventListener('editingFontCompiled', handler);
        };

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(true);
        };

        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            const fontRevision = Number(detail?.fontRevisionKey);
            if (!Number.isFinite(fontRevision)) {
                return;
            }
            if (fontRevision >= targetRevision) {
                finish();
            }
        };

        const fail = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(false);
        };

        timeoutId = window.setTimeout(fail, timeoutMs);
        window.addEventListener('editingFontCompiled', handler);
    });
}

function shouldArmDeferredFullCompile(
    changeSource: string,
    editType: string | null
): boolean {
    return compilationPlan({
        changeSource,
        editType: normalizeCompileEditStamp(editType),
        dataFreshnessMode: COMMITTED_DATA_FRESHNESS_MODE
    }).armDeferredFull;
}

/**
 * Process a committed edit through the funnel.
 *
 * @param changeSource Human-readable source label for the edit.
 * @param editType     The fast-path edit type, or null for full compile.
 * @param options      forceTrigger — bypass idle checks for remote/undo/redo;
 *                     waitForCompletion — resolve only after the compile finishes.
 */
export async function processCommittedEdit(
    changeSource: string,
    editType: string | null,
    options?: {
        forceTrigger?: boolean;
        waitForCompletion?: boolean;
    }
): Promise<void> {
    const fm = window.fontManager;
    if (!fm?.currentFont) {
        return;
    }

    // Bootstrap guard: skip no-data commits before the first editing font exists.
    if (
        changeSource === 'change-bridge-local' &&
        fm.currentFont.changeVersion === 0 &&
        !fm.editingFont
    ) {
        return;
    }

    // Edit types that don't need compilation: skip entirely.
    if (editType && NON_COMPILING_EDIT_TYPES.has(editType)) {
        return;
    }

    // Cancel any pending deferred full compile from a prior edit.
    // A stale deferred timer must not fire after a newer committed
    // edit has entered the funnel: the deferred compile would produce
    // a font blob based on the older model state, and its
    // editingFontCompiled event would overwrite the correct post-undo
    // (or post-redo) font on the canvas, causing the rendered output
    // to differ from what a fresh forward compile would produce for
    // the same model state.
    cancelDeferredFullCompile();

    // Cast is safe: non-compiling edit types already filtered above.
    const compileContext: EditingCompileContext = {
        changeSource,
        editType: editType as CommittedCompilingEditType,
        dataFreshnessMode: COMMITTED_DATA_FRESHNESS_MODE
    };

    // Request the editing compile.
    fm.currentFont.requestRecompileWithoutDataChange({ compileContext });
    fm.clearEditingCompileContext?.();
    window.autoCompileManager?.checkAndSchedule?.();

    const canForceTrigger =
        typeof window.autoCompileManager?.forceTrigger === 'function';
    const targetRevision = fm.currentFont.compileRequestVersion;
    const completionPromise =
        options?.waitForCompletion && canForceTrigger
            ? waitForEditingFontRevision(targetRevision)
            : null;

    // Force-trigger for remote, undo, redo.
    if (options?.forceTrigger && canForceTrigger) {
        try {
            await window.autoCompileManager.forceTrigger();
        } catch {
            // Compile errors are reported through normal error handling.
        }
    }

    if (completionPromise) {
        const completed = await completionPromise;
        if (!completed) {
            console.warn(
                `Timed out waiting for editing font revision ${targetRevision}; retrying committed compile with a fresh revision.`
            );

            let retryRevision = fm.currentFont.compileRequestVersion;
            if (retryRevision <= targetRevision) {
                fm.forceFullEditingCacheRefresh = true;
                fm.currentFont.requestRecompileWithoutDataChange({
                    compileContext
                });
                fm.clearEditingCompileContext?.();
                retryRevision = fm.currentFont.compileRequestVersion;
                window.autoCompileManager?.checkAndSchedule?.();
            }

            const retryCompletionPromise =
                waitForEditingFontRevision(retryRevision);

            if (canForceTrigger) {
                fm.forceFullEditingCacheRefresh = true;
                try {
                    await window.autoCompileManager.forceTrigger();
                } catch {
                    // Compile errors are reported through normal error handling.
                }
            }

            const retryCompleted = await retryCompletionPromise;
            if (!retryCompleted) {
                throw new Error(
                    `Timed out waiting for editing font revision ${retryRevision} after committed retry`
                );
            }
        }
    }

    // Arm the deferred full-compile timer for local fast-path edit types.
    // The main window owns the trailing correctness pass; linked windows only
    // run the immediate remote editing compile.
    if (
        shouldArmDeferredFullCompile(changeSource, editType) &&
        !options?.forceTrigger
    ) {
        armDeferredFullCompile();
    }
}

function shouldPostponeDeferredFullCompile(): boolean {
    const canvas = window.glyphCanvas;
    if (!canvas) {
        return false;
    }

    return (
        !!canvas.outlineEditor?.draggingSomething ||
        !!canvas.hasActiveTextModeKerningPreviewBurst?.()
    );
}

/**
 * Arm (or re-arm) the deferred full-compile timer.
 * This is the only deferred editing-compile timer.
 */
function armDeferredFullCompile(): void {
    if (deferredTimer !== null) {
        clearTimeout(deferredTimer);
    }

    deferredTimer = window.setTimeout(() => {
        deferredTimer = null;

        // Don't fire while a drag or live kerning burst is in progress —
        // re-arm instead. A trailing full reshape must not clobber an
        // uncommitted kerning preview the way a drag-time full compile
        // must not serialize mid-drag.
        if (shouldPostponeDeferredFullCompile()) {
            console.log(
                '[CompiledEditFunnel] Deferred full compile postponed until interaction settles'
            );
            armDeferredFullCompile();
            return;
        }

        const fm = window.fontManager;
        if (!fm?.currentFont) {
            return;
        }

        // Skip if the last compile was already 'full'.
        if (fm.lastCompilationMode === 'full') {
            return;
        }

        console.log(
            '[CompiledEditFunnel] Deferred full compile triggered after interactive editing'
        );

        // Request full compile through the same funnel.
        // Passing editType = null signals 'full' compilation mode.
        void processCommittedEdit('deferred-full', null);
    }, DEFERRED_FULL_MS);
}

/**
 * Cancel the deferred full-compile timer.
 */
export function cancelDeferredFullCompile(): void {
    if (deferredTimer !== null) {
        clearTimeout(deferredTimer);
        deferredTimer = null;
    }
}

/**
 * Reset internal timer state (for tests).
 */
export function reset(): void {
    cancelDeferredFullCompile();
}
