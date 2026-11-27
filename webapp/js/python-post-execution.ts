/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to translate snapshot
 * diffs into bridge operations. The shared committed-change funnel owns worker
 * sync, compilation, and overview refresh after the resulting Yjs commit.
 */

import { Logger } from './logger';
import type { WorkerReplayTarget } from './change-log';
import { normalizeWorkerReplayTargets } from './change-log';
import { getCommittedChangeRefreshPromise } from './change-bridge-init';
import {
    isAssistantPythonExecutionActive,
    setActiveAssistantPythonExecutionCommit
} from './assistant-execution-context';
import {
    diffFontDataToPatchPairs,
    type FontDataPatchPair
} from './font-data-diff';
import { serializeFontCoreWithoutGlyphs } from './python-utils';

const console = new Logger('PythonPostExecution');

type SyntheticChangeOperation = {
    op: 'set' | 'add' | 'remove';
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    editSource?: string | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

type PythonExecutionCommitContext = {
    beforeFontDataJson: string | null;
    beforeCoreJson?: string | null;
    beforeGlyphJsonByName?: Map<string, string> | null;
    code?: string | null;
    label?: string | null;
    transactionStarted?: boolean;
    releaseRecordingSuppression?: (() => void) | null;
};

type PythonExecutionCommitFont = {
    babelfontJson?: string | null;
    babelfontData?: unknown;
    syncJsonFromModel: () => void;
};

type PythonExecutionCommitBridge = {
    setRecordingSuppressed?: (suppressed: boolean) => void;
    applySyntheticChangeSet: (
        label: string,
        operations: SyntheticChangeOperation[],
        options?: {
            ignoreRecordingSuppression?: boolean;
            compileChangeSource?: string | null;
            compileEditType?: string | null;
        }
    ) => void;
    endTransaction: () => { changeLogEntries: unknown[] } | null;
};

export type PythonExecutionOutcome = {
    succeeded: boolean;
};

/**
 * Turn the snapshot diff into bridge operations. The diff already names
 * glyphs and drawings (`['glyphs', name, 'layers', id, …]`), so its paths
 * are used as they are. They never pass through a JSON pointer, whose
 * segments read back as array indices: a glyph named “1” would become the
 * second glyph of the snapshot.
 */
function patchPairsToSyntheticOperations(
    pairs: FontDataPatchPair[]
): SyntheticChangeOperation[] {
    return pairs.map(({ forward, inverse }) => {
        const path = [...forward.path];
        const oldValue = inverse.op === 'remove' ? undefined : inverse.value;
        const newValue = forward.op === 'remove' ? undefined : forward.value;
        const glyphName =
            path[0] === 'glyphs' && path.length >= 2 ? String(path[1]) : null;
        const drawingId =
            glyphName !== null && path[2] === 'layers' && path.length >= 4
                ? String(path[3])
                : null;
        return {
            op:
                forward.op === 'replace'
                    ? 'set'
                    : forward.op === 'add'
                      ? 'add'
                      : 'remove',
            path,
            oldValue,
            newValue,
            replayOldValue: oldValue,
            replayNewValue: newValue,
            workerReplayTargets: normalizeWorkerReplayTargets(
                glyphName !== null && drawingId !== null
                    ? [{ glyphName, layerId: drawingId }]
                    : []
            )
        };
    });
}

function createSyntheticOperationsFromJsonSnapshots(
    beforeSnapshot: Record<string, unknown>,
    afterSnapshot: Record<string, unknown>
): SyntheticChangeOperation[] {
    return patchPairsToSyntheticOperations(
        diffFontDataToPatchPairs(beforeSnapshot, afterSnapshot)
    );
}

/**
 * Diff only changed font-core fields and changed/added/removed glyphs using
 * per-glyph string equality before parsing, avoiding full-font JSON parse on
 * large local fonts.
 */
function createSyntheticOperationsFromScopedSnapshots(
    beforeCoreJson: string,
    beforeGlyphJsonByName: Map<string, string>,
    afterData: Record<string, unknown>
): SyntheticChangeOperation[] {
    const patchPairs: FontDataPatchPair[] = [];

    const afterCoreJson = serializeFontCoreWithoutGlyphs(afterData);
    if (afterCoreJson !== beforeCoreJson) {
        const beforeCore = JSON.parse(beforeCoreJson) as Record<
            string,
            unknown
        >;
        const afterCore = JSON.parse(afterCoreJson) as Record<string, unknown>;
        diffFontDataToPatchPairs(beforeCore, afterCore, [], null, patchPairs);
    }

    const afterGlyphs = Array.isArray(afterData.glyphs) ? afterData.glyphs : [];
    const seenAfterNames = new Set<string>();
    for (const glyph of afterGlyphs) {
        if (!glyph || typeof glyph !== 'object') {
            continue;
        }
        const name = (glyph as { name?: unknown }).name;
        if (typeof name !== 'string' || !name.length) {
            continue;
        }
        seenAfterNames.add(name);
        const afterGlyphJson = JSON.stringify(glyph);
        const beforeGlyphJson = beforeGlyphJsonByName.get(name);
        if (beforeGlyphJson === afterGlyphJson) {
            continue;
        }
        const beforeGlyph =
            beforeGlyphJson !== undefined
                ? (JSON.parse(beforeGlyphJson) as Record<string, unknown>)
                : undefined;
        const afterGlyph = JSON.parse(afterGlyphJson) as Record<
            string,
            unknown
        >;
        diffFontDataToPatchPairs(
            beforeGlyph,
            afterGlyph,
            ['glyphs', name],
            null,
            patchPairs
        );
    }

    for (const [name, beforeGlyphJson] of beforeGlyphJsonByName) {
        if (seenAfterNames.has(name)) {
            continue;
        }
        const beforeGlyph = JSON.parse(beforeGlyphJson) as Record<
            string,
            unknown
        >;
        diffFontDataToPatchPairs(
            beforeGlyph,
            undefined,
            ['glyphs', name],
            null,
            patchPairs
        );
    }

    return patchPairsToSyntheticOperations(patchPairs);
}

function createCanonicalSerializedFontSnapshot(
    currentFont: PythonExecutionCommitFont | null | undefined
): Record<string, unknown> | null {
    if (!currentFont?.babelfontJson) {
        return null;
    }

    return JSON.parse(currentFont.babelfontJson) as Record<string, unknown>;
}

export function commitPythonExecutionSyntheticChanges(
    currentFont: PythonExecutionCommitFont | null | undefined,
    historyContext: PythonExecutionCommitContext | null | undefined,
    bridge: PythonExecutionCommitBridge | null | undefined,
    outcome: PythonExecutionOutcome = { succeeded: true }
): void {
    let didApplyOperations = false;
    const releaseRecordingSuppression = () => {
        if (historyContext?.releaseRecordingSuppression) {
            historyContext.releaseRecordingSuppression();
        } else {
            bridge?.setRecordingSuppressed?.(false);
        }
    };
    try {
        if (!currentFont) {
            return;
        }

        // Python mutates the live wrapper/model graph directly. Canonicalize that
        // already-committed state in place, refresh the serialized snapshot, then
        // derive the authoritative synthetic diff from that post-sync serialization.
        currentFont.syncJsonFromModel();

        if (!bridge) {
            return;
        }

        let directOperations: SyntheticChangeOperation[];
        const beforeCoreJson = historyContext?.beforeCoreJson;
        const beforeGlyphJsonByName = historyContext?.beforeGlyphJsonByName;
        if (
            beforeCoreJson != null &&
            beforeGlyphJsonByName &&
            currentFont.babelfontData &&
            typeof currentFont.babelfontData === 'object'
        ) {
            directOperations = createSyntheticOperationsFromScopedSnapshots(
                beforeCoreJson,
                beforeGlyphJsonByName,
                currentFont.babelfontData as Record<string, unknown>
            );
        } else {
            const beforeFontDataJson = historyContext?.beforeFontDataJson;
            if (!beforeFontDataJson) {
                return;
            }
            if (currentFont.babelfontJson === beforeFontDataJson) {
                return;
            }
            const afterSnapshot =
                createCanonicalSerializedFontSnapshot(currentFont);
            if (!afterSnapshot) {
                return;
            }
            const beforeSnapshot = JSON.parse(beforeFontDataJson) as Record<
                string,
                unknown
            >;
            directOperations = createSyntheticOperationsFromJsonSnapshots(
                beforeSnapshot,
                afterSnapshot
            );
        }

        const readOnly =
            window.cloudPlugin?.canMutateCurrentAsset?.() === false;
        const hostPython = /_cp_/.test(historyContext.code || '');
        if (directOperations.length && readOnly) {
            // Host calls such as compile filters snapshot the font and then
            // wait. A remote update in that gap is not a script edit. A real
            // script on a read-only font is told it was not saved.
            if (!hostPython) {
                window.alert(
                    'This cloud font is read-only. The Python edit was not saved.'
                );
            }
        } else if (directOperations.length) {
            // Live Python setters remain suppressed, but the canonical diff is
            // the one intentional bridge operation that must be recorded.
            releaseRecordingSuppression();
            const editSource = isAssistantPythonExecutionActive()
                ? 'assistant'
                : 'python';
            bridge.applySyntheticChangeSet(
                historyContext?.label ?? 'Python script',
                directOperations.map((operation) => ({
                    ...operation,
                    editSource
                })),
                {
                    ignoreRecordingSuppression: true,
                    compileChangeSource: editSource,
                    compileEditType: null
                }
            );
            didApplyOperations = true;
        }
    } finally {
        if (historyContext?.transactionStarted) {
            releaseRecordingSuppression();
            const commitResult = bridge?.endTransaction();
            if (didApplyOperations && commitResult) {
                window.dispatchEvent(new CustomEvent('fontModelSync'));
            }
            if (
                didApplyOperations &&
                commitResult &&
                isAssistantPythonExecutionActive()
            ) {
                setActiveAssistantPythonExecutionCommit(
                    outcome.succeeded ? 'committed' : 'partial',
                    getCommittedChangeRefreshPromise()
                );
            }
        }
    }
}

console.log('🔧 Module loaded, setting up post-execution hooks...');

// Wait for required globals to be available
function setupHooks() {
    if ((window as any).__counterpunchPythonPostExecutionHookInstalled) {
        return;
    }

    // Save any existing hook so we can call it too (chaining). Do not wait
    // for autoCompileManager: the committed-change funnel owns compile, and
    // delaying this wrap lets python-ui-sync stay as the only after-hook.
    const existingHook = window.afterPythonExecution;

    /**
     * Hook that runs after every Python code execution
     * Triggers font recompilation
     */
    window.afterPythonExecution = async function (
        outcome: PythonExecutionOutcome = { succeeded: true },
        historyContext?: Window['pythonExecutionHistoryContext']
    ) {
        const executionContext =
            historyContext ?? window.pythonExecutionHistoryContext;
        try {
            commitPythonExecutionSyntheticChanges(
                window.fontManager?.currentFont,
                executionContext,
                window.patchSyncEngine,
                outcome
            );
        } finally {
            executionContext?.releaseRecordingSuppression?.();
            if (window.pythonExecutionHistoryContext === executionContext) {
                window.pythonExecutionHistoryContext = null;
            }
        }

        if (typeof existingHook === 'function') {
            await existingHook(outcome, executionContext);
        }
    };
    (window as any).__counterpunchPythonPostExecutionHookInstalled = true;

    console.log(
        '[PythonPostExec]',
        '✅ Post-execution hooks installed successfully'
    );
    console.log(
        '[PythonPostExec]',
        'window.afterPythonExecution is now:',
        typeof window.afterPythonExecution
    );
}

// Start setup when DOM is ready
console.log('[PythonPostExec]', 'Document ready state:', document.readyState);
if (document.readyState === 'loading') {
    console.log('[PythonPostExec]', 'Adding DOMContentLoaded listener...');
    document.addEventListener('DOMContentLoaded', setupHooks);
} else {
    console.log(
        '[PythonPostExec]',
        'DOM already ready, calling setupHooks immediately...'
    );
    setupHooks();
}

console.log('[PythonPostExec]', '📦 Module initialization complete');

// Immediately invoke setup to ensure this code runs
// (prevents webpack from tree-shaking this module)
(function () {
    console.log('[PythonPostExec]', '🚀 IIFE executing...');
})();
