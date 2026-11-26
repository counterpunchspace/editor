// Python-UI Synchronization Hooks
// These functions control when UI updates are paused/resumed during Python execution

import { getActiveAssistantPythonExecution } from './assistant-execution-context';

// Flag to skip dirty checks during font loading operations
let isLoadingFont = false;

// Debounce timer for dirty indicator updates
let dirtyCheckTimeout: ReturnType<typeof setTimeout> | null = null;

type LocalSparseFontManager = {
    isLocalSparseFont?: () => boolean;
    ensureLocalGlyphsHydrated?: (names: string[]) => Promise<void>;
    hydrateAllLocalGlyphs?: () => Promise<void>;
};

export type LocalSparseHydrationPlan = {
    mode: 'none' | 'named' | 'all';
    names: string[];
};

function getLocalSparseFontManager(): LocalSparseFontManager | null {
    const manager = window.fontManager as LocalSparseFontManager | undefined;
    return manager ?? null;
}

/**
 * Inspect Python source to decide which unhydrated local glyphs (if any) must
 * be fetched from `fontc-worker` before synchronous Python execution begins.
 */
export function planLocalSparseHydrationForPython(
    code: string | undefined
): LocalSparseHydrationPlan {
    if (!code || !code.trim()) {
        return { mode: 'none', names: [] };
    }

    // Strip single-line comments outside quotes conservatively by line.
    const stripped = code
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            return trimmed.startsWith('#') ? '' : line;
        })
        .join('\n');

    if (
        /\bOtherFonts\s*\(/.test(stripped) ||
        /\.(?:renameGlyphs|deleteGlyphs|duplicateGlyph|removeGlyph|addGlyph)\s*\(/.test(
            stripped
        )
    ) {
        return { mode: 'all', names: [] };
    }

    const literalNames = new Set<string>();

    // Collect literal findGlyph("...") / findGlyph('...') calls; any dynamic
    // argument forces full hydration.
    const findGlyphRegex = /\bfindGlyph\s*\(([^)]*)\)/g;
    let findMatch: RegExpExecArray | null;
    while ((findMatch = findGlyphRegex.exec(stripped)) !== null) {
        const arg = findMatch[1].trim();
        const literal = /^(['"])([^'"\\]+)\1$/.exec(arg);
        if (literal) {
            literalNames.add(literal[2]);
        } else {
            return { mode: 'all', names: [] };
        }
    }

    // Check `.glyphs` accesses: literal string subscripts (`glyphs["A"]`)
    // hydrate only those names; any other `.glyphs` access (iteration, `len`,
    // numeric index, dynamic subscript) hydrates all local glyphs.
    const literalSubscriptRegex = /\.glyphs\s*\[\s*(['"])([^'"\\]+)\1\s*\]/g;
    let subMatch: RegExpExecArray | null;
    while ((subMatch = literalSubscriptRegex.exec(stripped)) !== null) {
        literalNames.add(subMatch[2]);
    }
    const withoutLiteralSubscripts = stripped.replace(
        literalSubscriptRegex,
        ''
    );
    if (/\.glyphs\b/.test(withoutLiteralSubscripts)) {
        return { mode: 'all', names: [] };
    }

    if (literalNames.size > 0) {
        return { mode: 'named', names: [...literalNames] };
    }

    return { mode: 'none', names: [] };
}

/**
 * Hydrate any unhydrated local glyphs that `code` will access synchronously.
 * No-op for cloud sparse fonts (preserves exact cloud behavior) and fully
 * resident local fonts.
 */
export async function ensureLocalGlyphsHydratedForPython(
    code?: string
): Promise<void> {
    const manager = getLocalSparseFontManager();
    if (!manager?.isLocalSparseFont?.()) {
        return;
    }

    const plan = planLocalSparseHydrationForPython(code);
    if (plan.mode === 'named' && plan.names.length > 0) {
        await manager.ensureLocalGlyphsHydrated?.(plan.names);
    } else if (plan.mode === 'all') {
        await manager.hydrateAllLocalGlyphs?.();
    }
}

export function serializeFontCoreWithoutGlyphs(
    fontData: Record<string, unknown>
): string {
    const core: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fontData)) {
        if (key === 'glyphs') {
            continue;
        }
        core[key] = value;
    }
    return JSON.stringify(core);
}

export function snapshotResidentGlyphsByName(
    glyphs: unknown
): Map<string, string> {
    const snapshots = new Map<string, string>();
    if (!Array.isArray(glyphs)) {
        return snapshots;
    }
    for (const glyph of glyphs) {
        if (!glyph || typeof glyph !== 'object') {
            continue;
        }
        const name = (glyph as { name?: unknown }).name;
        if (typeof name === 'string' && name.length > 0) {
            snapshots.set(name, JSON.stringify(glyph));
        }
    }
    return snapshots;
}

function isCloudFontActive(): boolean {
    const cloudPlugin = window.cloudPlugin as
        { isConnected?: () => boolean } | undefined;
    return Boolean(cloudPlugin?.isConnected?.());
}

function createScopedOrFullFontSnapshot(): {
    beforeFontDataJson: string | null;
    beforeCoreJson: string | null;
    beforeGlyphJsonByName: Map<string, string> | null;
} {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        return {
            beforeFontDataJson: null,
            beforeCoreJson: null,
            beforeGlyphJsonByName: null
        };
    }

    currentFont.syncJsonFromModel();

    // For large or sparse local fonts with structured `babelfontData`, snapshot
    // font-core + per-glyph JSON strings separately so we never allocate a
    // single 100 MB concatenated string or JSON.parse untouched glyphs after
    // Python runs. Small fonts keep `beforeFontDataJson` directly.
    const fontData = currentFont.babelfontData as
        Record<string, unknown> | undefined;
    const isSparseLocal = Boolean(
        getLocalSparseFontManager()?.isLocalSparseFont?.()
    );
    if (
        !isCloudFontActive() &&
        fontData &&
        typeof fontData === 'object' &&
        Array.isArray(fontData.glyphs) &&
        (isSparseLocal || fontData.glyphs.length > 64)
    ) {
        return {
            beforeFontDataJson: null,
            beforeCoreJson: serializeFontCoreWithoutGlyphs(fontData),
            beforeGlyphJsonByName: snapshotResidentGlyphsByName(fontData.glyphs)
        };
    }

    return {
        beforeFontDataJson: currentFont.babelfontJson || null,
        beforeCoreJson: null,
        beforeGlyphJsonByName: null
    };
}

/**
 * Called before any Python code execution begins.
 * On local sparse fonts, pre-hydrates any glyphs the script will access before
 * snapshotting and pausing live UI updates.
 */
function beforePythonExecution(code?: string) {
    console.log(
        '[PythonUISync]',
        '🔒 UI updates paused (Python execution starting)'
    );
    const manager = getLocalSparseFontManager();
    if (manager?.isLocalSparseFont?.()) {
        return ensureLocalGlyphsHydratedForPython(code).then(() => {
            const historyContext = openPythonEditContext(code);
            window.pythonExecutionHistoryContext = historyContext;
            return historyContext;
        });
    }
    const historyContext = openPythonEditContext(code);
    window.pythonExecutionHistoryContext = historyContext;
    return historyContext;
}

/**
 * Start recording a Python edit of this window's font: snapshot it, open an
 * undo transaction and pause live recording. Close it with
 * `commitPythonExecutionSyntheticChanges` (python-post-execution.ts).
 * A script in another window that edits this font through `OtherFonts()`
 * uses this too.
 */
export function openPythonEditContext(code?: string) {
    const assistantExecution = getActiveAssistantPythonExecution();
    const bridge = window.patchSyncEngine;
    const snapshot = createScopedOrFullFontSnapshot();
    // Returned to the caller. A second overlapping run must not replace the
    // context the first run will close.
    const historyContext = {
        beforeFontDataJson: snapshot.beforeFontDataJson,
        beforeCoreJson: snapshot.beforeCoreJson,
        beforeGlyphJsonByName: snapshot.beforeGlyphJsonByName,
        code: code ?? null,
        label: 'Python script',
        startedAt: Date.now(),
        historySummary: assistantExecution?.historySummary ?? null,
        transactionStarted: false,
        releaseRecordingSuppression: null as (() => void) | null
    };
    bridge?.beginTransaction(
        assistantExecution?.historySummary ?? 'Python script',
        null,
        {
            historyItemId: assistantExecution?.id ?? null,
            promptGroupId: assistantExecution?.id ?? null,
            historySummary: assistantExecution?.historySummary ?? null,
            compileChangeSource: assistantExecution ? 'assistant' : 'python',
            compileEditType: null
        }
    );
    if (bridge) {
        historyContext.transactionStarted = true;
        historyContext.releaseRecordingSuppression =
            typeof bridge.beginRecordingSuppression === 'function'
                ? bridge.beginRecordingSuppression()
                : () => bridge.setRecordingSuppressed(false);
        if (typeof bridge.beginRecordingSuppression !== 'function') {
            bridge.setRecordingSuppressed(true);
        }
    }
    return historyContext;
}

/**
 * Called after Python code execution completes (success or failure).
 * Use this to resume UI updates and debounce dirty-indicator refreshes. The
 * committed-change funnel owns compilation after Python edits.
 */
function afterPythonExecution() {
    console.log(
        '[PythonUISync]',
        '🔓 UI updates resumed (Python execution finished)'
    );

    // Skip dirty checks if we're loading a font or font manager not ready
    if (isLoadingFont || !window.fontManager) {
        console.log(
            '[PythonUISync]',
            '⏭️ Skipping dirty checks (loading font or manager not ready)'
        );
        return;
    }

    // Debounce dirty indicator updates to avoid excessive calls
    if (dirtyCheckTimeout) {
        clearTimeout(dirtyCheckTimeout);
    }
    dirtyCheckTimeout = setTimeout(() => {
        if (window.fontManager) {
            window.fontManager.updateDirtyIndicator();
        }
    }, 100); // Wait 100ms after last execution before checking
}

// Make functions globally available
window.pythonExecutionHistoryContext = null;
window.beforePythonExecution = beforePythonExecution;
{
    const existingAfter = window.afterPythonExecution;
    window.afterPythonExecution = async function afterPythonExecutionChained(
        outcome?: {
            succeeded: boolean;
        },
        historyContext?: Window['pythonExecutionHistoryContext']
    ) {
        afterPythonExecution();
        if (typeof existingAfter === 'function') {
            await existingAfter(outcome, historyContext);
        }
    };
}

// Expose flag control for font loading operations
window.setFontLoadingState = function (loading: boolean) {
    isLoadingFont = loading;
    if (!loading) {
        // After font loading completes, check dirty state once
        if (dirtyCheckTimeout) {
            clearTimeout(dirtyCheckTimeout);
        }
        dirtyCheckTimeout = setTimeout(() => {
            if (window.fontManager) {
                window.fontManager.updateDirtyIndicator();
            }
        }, 200);
    }
};
