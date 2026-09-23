/**
 * EditIntent is the only fast-path input for an editing compile.
 * `null` is a real stamp and means a full compile. Omitting the stamp
 * is a writer bug. The committed funnel does not throw and does not
 * infer a type from paths or labels.
 */

export type CompileEditStamp =
    | 'outline'
    | 'anchor'
    | 'sidebearing'
    | 'kerning-value'
    | 'kerning-groups'
    | 'guide'
    | 'feature'
    | 'text-subset'
    | 'master-topology'
    | null;

export type EditingDataFreshnessMode =
    'authoritative-worker-yjs' | 'live-drag-worker-preview' | null;

export type CompilationMode =
    'full' | 'outline-only' | 'anchor-only' | 'kerning-only' | 'text-input';

export type CompileOptionOverrides = {
    skip_features?: boolean;
    skip_kerning?: boolean;
    skip_outlines?: boolean;
    produce_varc_table?: boolean;
};

export type CompilationPlan = {
    skipCompile: boolean;
    compilationMode: CompilationMode;
    optionOverrides?: CompileOptionOverrides;
    armDeferredFull: boolean;
};

const KNOWN_STAMPS = new Set<string>([
    'outline',
    'anchor',
    'sidebearing',
    'kerning-value',
    'kerning-groups',
    'guide',
    'feature',
    'text-subset',
    'master-topology'
]);

const OUTLINE_LIVE_OVERRIDES: CompileOptionOverrides = {
    skip_features: true,
    skip_kerning: true,
    produce_varc_table: false
};

const VARC_OFF: CompileOptionOverrides = {
    produce_varc_table: false
};

export function normalizeCompileEditStamp(
    editType: string | null | undefined
): CompileEditStamp {
    if (editType == null || editType === '') {
        return null;
    }
    return KNOWN_STAMPS.has(editType) ? (editType as CompileEditStamp) : null;
}

export function assertCompileStamp(
    compileChangeSource: string | null | undefined,
    compileEditType: string | null | undefined
): { compileChangeSource: string; compileEditType: CompileEditStamp } {
    if (compileChangeSource == null || compileChangeSource === '') {
        throw new Error(
            'Compile stamp requires compileChangeSource before the Yjs transaction'
        );
    }
    if (compileEditType === undefined) {
        throw new Error(
            'Compile stamp requires compileEditType before the Yjs transaction (null means full)'
        );
    }
    return {
        compileChangeSource,
        compileEditType: normalizeCompileEditStamp(compileEditType)
    };
}

export type StampedCompileContext = {
    editType: CompileEditStamp;
    changeSource: string;
    /** True when the packet had no compileChangeSource and compiled full. */
    unstamped: boolean;
};

/**
 * Read the writer stamp. No path or label classification.
 * A packet with no compileChangeSource compiles full.
 */
export function readCommittedCompileStamp(
    entries: Array<{
        compileChangeSource?: string | null;
        compileEditType?: string | null;
    }>,
    fallbackChangeSource: string
): StampedCompileContext {
    for (const entry of entries) {
        if (!entry.compileChangeSource) {
            continue;
        }
        return {
            changeSource: entry.compileChangeSource,
            editType: normalizeCompileEditStamp(entry.compileEditType),
            unstamped: false
        };
    }
    return {
        changeSource: fallbackChangeSource,
        editType: null,
        unstamped: true
    };
}

export function compilationPlan(input: {
    changeSource: string | null;
    editType: CompileEditStamp;
    dataFreshnessMode?: EditingDataFreshnessMode;
    forceFull?: boolean;
}): CompilationPlan {
    const changeSource = input.changeSource || '';
    const editType = input.editType;
    const live = input.dataFreshnessMode === 'live-drag-worker-preview';
    const remote = changeSource.startsWith('remote-');

    if (editType === 'guide') {
        return {
            skipCompile: true,
            compilationMode: 'full',
            armDeferredFull: false
        };
    }

    if (
        input.forceFull ||
        editType === null ||
        editType === 'feature' ||
        editType === 'master-topology'
    ) {
        const textSubset =
            editType === 'text-subset' || changeSource === 'text-input';
        return {
            skipCompile: false,
            compilationMode: textSubset ? 'text-input' : 'full',
            optionOverrides: textSubset ? VARC_OFF : undefined,
            armDeferredFull: false
        };
    }

    if (editType === 'text-subset') {
        return {
            skipCompile: false,
            compilationMode: 'text-input',
            optionOverrides: VARC_OFF,
            armDeferredFull: false
        };
    }

    const fastPath =
        live ||
        remote ||
        changeSource === 'master-reinterpolate-batch' ||
        changeSource.startsWith('mouse-drag') ||
        changeSource.startsWith('keyboard');

    if (fastPath && (editType === 'outline' || editType === 'sidebearing')) {
        return {
            skipCompile: false,
            compilationMode: 'outline-only',
            optionOverrides: OUTLINE_LIVE_OVERRIDES,
            armDeferredFull: !live && !remote
        };
    }

    if (fastPath && editType === 'anchor') {
        return {
            skipCompile: false,
            compilationMode: 'anchor-only',
            optionOverrides: VARC_OFF,
            armDeferredFull: !live && !remote
        };
    }

    if (
        (live || remote || changeSource.startsWith('keyboard')) &&
        (editType === 'kerning-value' || editType === 'kerning-groups')
    ) {
        return {
            skipCompile: false,
            compilationMode: 'kerning-only',
            optionOverrides: VARC_OFF,
            armDeferredFull: !live && !remote
        };
    }

    return {
        skipCompile: false,
        compilationMode: 'full',
        armDeferredFull: false
    };
}
