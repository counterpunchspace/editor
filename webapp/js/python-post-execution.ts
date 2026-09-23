/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to translate snapshot
 * diffs into bridge operations. The shared committed-change funnel owns worker
 * sync, compilation, and overview refresh after the resulting Yjs commit.
 */

import { Logger } from './logger';
import type { WorkerReplayTarget } from './change-log';
import {
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    normalizeWorkerReplayTargets
} from './change-log';
import {
    createNamedChangePairFromJsonPatchPair,
    createSyntheticChangeOperationsFromNamedChangePairs,
    type JsonPatchOperation,
    type NamedChangePair
} from './collaboration-message';
import { getCommittedChangeRefreshPromise } from './change-bridge-init';
import {
    isAssistantPythonExecutionActive,
    setActiveAssistantPythonExecutionCommit
} from './assistant-execution-context';
import { diffFontDataToPatchPairs } from './font-data-diff';

const console = new Logger('PythonPostExecution');

type SyntheticChangeOperation = {
    op: 'set' | 'add' | 'remove';
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    editSource?: string | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

type PythonExecutionCommitContext = {
    beforeFontDataJson: string | null;
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

type JsonPatchPair = {
    forward: JsonPatchOperation;
    inverse: JsonPatchOperation;
};

function toJsonPointerPath(path: (string | number)[]): string {
    if (!path.length) {
        return '';
    }

    return `/${path
        .map((segment) =>
            String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
        )
        .join('/')}`;
}

function diffFontDataToJsonPatchPairs(
    beforeValue: unknown,
    afterValue: unknown
): JsonPatchPair[] {
    return diffFontDataToPatchPairs(beforeValue, afterValue).map(
        ({ forward, inverse }) => ({
            forward: {
                op: forward.op,
                path: toJsonPointerPath(forward.path),
                value: forward.value
            },
            inverse: {
                op: inverse.op,
                path: toJsonPointerPath(inverse.path),
                value: inverse.value
            }
        })
    );
}

function createNamedPatchPairsFromJsonSnapshots(
    beforeSnapshot: Record<string, unknown>,
    afterSnapshot: Record<string, unknown>,
    workerReplayTargets: WorkerReplayTarget[]
): NamedChangePair[] {
    const jsonPatchPairs = diffFontDataToJsonPatchPairs(
        beforeSnapshot,
        afterSnapshot
    );

    return jsonPatchPairs.map((patchPair) => {
        const namedPair = createNamedChangePairFromJsonPatchPair(
            patchPair.forward,
            patchPair.inverse,
            {
                forwardSnapshot:
                    patchPair.forward.op === 'remove'
                        ? beforeSnapshot
                        : afterSnapshot,
                inverseSnapshot:
                    patchPair.inverse.op === 'remove'
                        ? afterSnapshot
                        : beforeSnapshot,
                replayOldValue:
                    patchPair.inverse.op === 'remove'
                        ? undefined
                        : patchPair.inverse.value,
                replayNewValue:
                    patchPair.forward.op === 'remove'
                        ? undefined
                        : patchPair.forward.value,
                workerReplayTargets
            }
        );
        const inferredGlyph = deriveGlyphNameFromPath(namedPair.forward.path);
        const inferredLayer = deriveLayerIdFromPath(namedPair.forward.path);
        const inferredTargets = normalizeWorkerReplayTargets(
            workerReplayTargets.length > 0
                ? workerReplayTargets
                : inferredGlyph && inferredLayer
                  ? [{ glyphName: inferredGlyph, layerId: inferredLayer }]
                  : []
        );
        return {
            ...namedPair,
            workerReplayTargets: inferredTargets
        };
    });
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

        const beforeFontDataJson = historyContext?.beforeFontDataJson;
        if (!beforeFontDataJson || !bridge) {
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
        const directOperations =
            createSyntheticChangeOperationsFromNamedChangePairs(
                createNamedPatchPairsFromJsonSnapshots(
                    beforeSnapshot,
                    afterSnapshot,
                    []
                )
            );

        if (directOperations.length) {
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
        outcome: PythonExecutionOutcome = { succeeded: true }
    ) {
        try {
            commitPythonExecutionSyntheticChanges(
                window.fontManager?.currentFont,
                window.pythonExecutionHistoryContext,
                window.patchSyncEngine,
                outcome
            );
        } finally {
            window.pythonExecutionHistoryContext?.releaseRecordingSuppression?.();
            window.pythonExecutionHistoryContext = null;
        }

        if (typeof existingHook === 'function') {
            await existingHook(outcome);
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
