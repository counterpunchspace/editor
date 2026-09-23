// AI Assistant for Font Editing Knowledge
// Streaming multi-round tool calling entirely on the client.
// Each round is one streaming request per tool-call cycle.
// Tools and instructions live in assistant-config.ts.

import { resolveWebsiteURL } from './website-url';
import { Logger } from './logger';
import { rewriteHtmlAnchorsForDocs } from './link-navigation';
import {
    ASSISTANT_TOOLS,
    ASSISTANT_TOOL_CATEGORIES,
    ASSISTANT_SYSTEM_PROMPT,
    AssistantTool,
    AssistantToolCategory,
    UsageMetrics
} from './assistant-config';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { getTheme } from './tippy-utils';
import {
    getFeatureDescription,
    getFeatureExecutionOrder,
    isDiscretionary,
    SCRIPT_TO_SHAPER
} from './opentype-features';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import {
    AssistantPromptExecutionContext,
    awaitActiveAssistantPythonExecutionSettled,
    getActiveAssistantPythonExecution,
    runAssistantPythonExecution
} from './assistant-execution-context';
import { awaitStableWorkerState } from './font-compilation';
import { SETTINGS_FOLDER_PATHS, settingsFolder } from './settings-folder';
import {
    getPythonDocumentKindInfo,
    type PythonDocumentKindInfo
} from './python-document-kind';
import { getGlyphFilterEventAssistantView } from './glyph-filter-events';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

type HandbookManifestNode = {
    id: string;
    title: string;
    kind: 'section' | 'page';
    path?: string;
    children?: HandbookManifestNode[];
};

function formatHandbookToc(nodes: HandbookManifestNode[], indent = ''): string {
    return nodes
        .map((node) => {
            if (node.kind === 'section') {
                const nested = formatHandbookToc(
                    node.children || [],
                    `${indent}  `
                );
                return `${indent}${node.title}/\n${nested}`;
            }
            return `${indent}${node.id} — ${node.title} (docs://${node.id})`;
        })
        .join('\n');
}

function normalizeHandbookTopic(topic: string): string {
    return topic
        .replace(/^docs:\/\//i, '')
        .replace(/^#docs=/i, '')
        .replace(/\.\.\//g, '')
        .replace(/^\/+/, '')
        .replace(/#.*$/, '')
        .trim();
}

function findHandbookPath(
    nodes: HandbookManifestNode[],
    topic: string
): string | null {
    const clean = normalizeHandbookTopic(topic);
    for (const node of nodes) {
        if (node.path && (node.id === clean || node.path === clean)) {
            return node.path;
        }
        if (node.children) {
            const nested = findHandbookPath(node.children, clean);
            if (nested) {
                return nested;
            }
        }
    }
    return null;
}

const console = new Logger('AIAssistant');
const DEFAULT_PROMPT_HISTORY_SUMMARY = 'Assistant changes';

type BinaryFontWorkerState = {
    awaitWorkerDocumentSync?: () => Promise<void>;
    hasWorkerCacheDocument?: () => boolean;
    bootstrapWorkerCacheFromFontState?: (
        state: Uint8Array | ArrayBufferLike
    ) => Promise<void>;
    seedWorkerDocumentSet?: (
        documents: Array<{ documentId: string; bytes: Uint8Array }>
    ) => Promise<void>;
    compileCached?: (
        target: string,
        filename: string
    ) => Promise<{ result: Uint8Array }>;
    compileCommittedDebugFont?: (
        subsetGlyphs: string[],
        filename?: string,
        target?: string
    ) => Promise<{
        result: Uint8Array;
        filename: string;
        time_taken: number;
        fontHash: string;
        closureGlyphCount: number;
    }>;
};

type BinaryFontManagerState = {
    workerCacheUpdatePromise?: Promise<void> | null;
    buildWorkerSeedYjsState?: () => Uint8Array | null;
    buildWorkerSeedDocumentSet?: () => Array<{
        documentId: string;
        bytes: Uint8Array;
    }> | null;
    deriveSubsetGlyphsFromText?: (text: string) => string[];
    resolveEditingTextForCompile?: (text?: string) => string;
    getEditingSubsetSnapshot?: () => string[];
    currentFont?: {
        sourcePlugin?: { getId?: () => string };
        path?: string;
        changeVersion?: number;
    };
};

type BinaryFontAnalysisWorkerState = BinaryFontWorkerState & {
    compileBinaryFont?: (
        target: string,
        filename: string,
        workerState: {
            awaitWorkerDocumentSync: () => Promise<void>;
            hasWorkerCacheDocument: () => boolean;
            getWorkerCacheUpdatePromise: () => Promise<void> | null;
            getFontRevisionKey: () => string;
        }
    ) => Promise<{ fontHash: string }>;
    getDebugCachedFontBytes?: (fontHash: string) => Promise<Uint8Array>;
    sendMessage?: (
        data: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    inspectDebugCachedFont?: (
        fontHash: string,
        request: { fontIndex?: number; paths: string[] }
    ) => Promise<{ values: unknown[] }>;
};

type BinaryFontChildrenRequest = {
    fontIndex?: number;
    path: string;
    limit?: number;
};

type BinaryFontChildEntry = {
    path: string;
    label: string;
    kind: string;
    value: unknown;
};

type BinaryFontChildrenResult = {
    path: string;
    children: BinaryFontChildEntry[];
    truncated: boolean;
    note?: string;
};

type BinaryFontSurfaceEntry = {
    path: string;
    label: string;
    kind: 'collection' | 'leaf' | 'profile';
    description: string;
    pathTemplate?: string;
};

type BinaryFontSnapshotProfile = {
    name: string;
    description: string;
    inspectPaths: string[];
    listPaths: Array<{
        path: string;
        limit?: number;
    }>;
};

type PythonSyntaxCheck = {
    checked: boolean;
    valid: boolean;
    message: string;
    line?: number;
    offset?: number;
    text?: string;
};

const BINARY_FONT_SUMMARY_PATHS = [
    '/tables/head/unitsPerEm',
    '/tables/maxp/numGlyphs',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=2/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=4/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=5/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=6/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=0/string',
    '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=3/string'
];

const BINARY_FONT_SURFACE_COLLECTIONS: BinaryFontSurfaceEntry[] = [
    {
        path: '/tables',
        label: 'tables',
        kind: 'collection',
        description:
            'Top-level OpenType tables visible to the binary-font tools.'
    },
    {
        path: '/tables/name/records',
        label: 'name records',
        kind: 'collection',
        description:
            'Immediate `name` table records. Each child path is the exact leaf string path.',
        pathTemplate:
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string'
    },
    {
        path: '/tables/fvar/axes',
        label: 'variation axes',
        kind: 'collection',
        description:
            'Immediate `fvar` axis records. Use the axis index to inspect leaf fields.',
        pathTemplate: '/tables/fvar/axes/index=0'
    },
    {
        path: '/tables/hmtx/metrics',
        label: 'horizontal metrics',
        kind: 'collection',
        description:
            'Glyph advance-width and side-bearing entries, addressed by glyph id.',
        pathTemplate: '/tables/hmtx/metrics/gid=42'
    },
    {
        path: '/tables/glyf',
        label: 'glyph outlines',
        kind: 'collection',
        description: 'Glyph ids that can be inspected for outline data.',
        pathTemplate: '/tables/glyf/gid=36/outline'
    }
];

const BINARY_FONT_SURFACE_LEAVES: BinaryFontSurfaceEntry[] = [
    {
        path: '/tables/head/unitsPerEm',
        label: 'unitsPerEm',
        kind: 'leaf',
        description: 'The head table units-per-em value.'
    },
    {
        path: '/tables/maxp/numGlyphs',
        label: 'numGlyphs',
        kind: 'leaf',
        description: 'The total glyph count from maxp.'
    },
    {
        path: '/tables/name/records/.../string',
        label: 'name string',
        kind: 'leaf',
        description:
            'Exact `name` string leaf values addressed by platform, encoding, language, and nameID.',
        pathTemplate:
            '/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string'
    },
    {
        path: '/tables/fvar/axes/index=0/tag|minValue|defaultValue|maxValue|flags',
        label: 'axis fields',
        kind: 'leaf',
        description:
            'The individual leaf fields available beneath a variation axis node.',
        pathTemplate: '/tables/fvar/axes/index=0'
    },
    {
        path: '/tables/hmtx/metrics/gid=42/advanceWidth|sideBearing',
        label: 'metric fields',
        kind: 'leaf',
        description:
            'The individual advance-width and side-bearing leaves available for a metric node.',
        pathTemplate: '/tables/hmtx/metrics/gid=42'
    },
    {
        path: '/tables/cmap/codepoint=U+0041/gid',
        label: 'cmap gid',
        kind: 'leaf',
        description: 'Exact codepoint lookup for the cmap table.'
    },
    {
        path: '/tables/glyf/gid=36/outline',
        label: 'outline',
        kind: 'leaf',
        description: 'Exact glyph outline inspection by glyph id.'
    }
];

const BINARY_FONT_SNAPSHOT_PROFILES: BinaryFontSnapshotProfile[] = [
    {
        name: 'summary',
        description:
            'Small overview: unitsPerEm, glyph count, and the common name IDs.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: []
    },
    {
        name: 'names',
        description: 'Summary plus the full set of name records.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: [{ path: '/tables/name/records' }]
    },
    {
        name: 'variation',
        description: 'Summary plus the variation axis inventory.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: [{ path: '/tables/fvar/axes' }]
    },
    {
        name: 'metrics',
        description:
            'Summary plus a bounded sample of glyph metrics and outlines.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: [
            { path: '/tables/hmtx/metrics', limit: 32 },
            { path: '/tables/glyf', limit: 32 }
        ]
    },
    {
        name: 'review',
        description: 'Summary plus names and variation axes.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: [
            { path: '/tables/name/records' },
            { path: '/tables/fvar/axes' }
        ]
    },
    {
        name: 'full',
        description:
            'Summary plus names, variation axes, metrics, and a bounded glyph sample.',
        inspectPaths: BINARY_FONT_SUMMARY_PATHS,
        listPaths: [
            { path: '/tables/name/records' },
            { path: '/tables/fvar/axes' },
            { path: '/tables/hmtx/metrics', limit: 32 },
            { path: '/tables/glyf', limit: 32 }
        ]
    }
];

function getBinaryFontSurfaceDescription(path?: string): {
    collections: BinaryFontSurfaceEntry[];
    leaves: BinaryFontSurfaceEntry[];
    snapshotProfiles: BinaryFontSnapshotProfile[];
} {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) {
        return {
            collections: BINARY_FONT_SURFACE_COLLECTIONS,
            leaves: BINARY_FONT_SURFACE_LEAVES,
            snapshotProfiles: BINARY_FONT_SNAPSHOT_PROFILES
        };
    }

    const prefix = normalizedPath.endsWith('/')
        ? normalizedPath
        : `${normalizedPath}/`;
    return {
        collections: BINARY_FONT_SURFACE_COLLECTIONS.filter(
            (entry) =>
                entry.path === normalizedPath || entry.path.startsWith(prefix)
        ),
        leaves: BINARY_FONT_SURFACE_LEAVES.filter(
            (entry) =>
                entry.path === normalizedPath || entry.path.startsWith(prefix)
        ),
        snapshotProfiles: BINARY_FONT_SNAPSHOT_PROFILES
    };
}

function searchBinaryFontSurface(
    query: string,
    withinPath?: string
): Array<Record<string, unknown>> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return [];
    }

    const scopePrefix = withinPath ? withinPath.trim() : '';
    const entries = [
        ...BINARY_FONT_SURFACE_COLLECTIONS,
        ...BINARY_FONT_SURFACE_LEAVES,
        ...BINARY_FONT_SNAPSHOT_PROFILES.map((profile) => ({
            path: `snapshot:${profile.name}`,
            label: profile.name,
            kind: 'profile' as const,
            description: profile.description,
            pathTemplate: profile.inspectPaths[0] || ''
        }))
    ].filter((entry) => {
        if (!scopePrefix) {
            return true;
        }
        return (
            entry.path === scopePrefix ||
            entry.path.startsWith(`${scopePrefix}/`)
        );
    });

    return entries
        .filter((entry) => {
            const haystack = [
                entry.path,
                entry.label,
                entry.kind,
                entry.description,
                entry.pathTemplate || ''
            ]
                .join('\n')
                .toLowerCase();
            return haystack.includes(normalizedQuery);
        })
        .map((entry) => ({
            kind: entry.kind,
            path: entry.path,
            label: entry.label,
            description: entry.description,
            pathTemplate: entry.pathTemplate
        }));
}

async function searchBinaryFontChildren(
    analysisCompiler: BinaryFontAnalysisWorkerState,
    fontHash: string,
    path: string,
    query: string,
    fontIndex: number,
    limit?: number
): Promise<{
    query: string;
    fontHash: string;
    withinPath: string;
    matches: Array<Record<string, unknown>>;
}> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return {
            query,
            fontHash,
            withinPath: path,
            matches: []
        };
    }

    const listed = await fetchBinaryFontChildren(
        analysisCompiler,
        fontHash,
        path,
        fontIndex,
        limit
    );
    const matches = listed.children
        .filter((child) =>
            JSON.stringify(child).toLowerCase().includes(normalizedQuery)
        )
        .map((child) => ({
            kind: child.kind,
            path: child.path,
            label: child.label,
            value: child.value
        }));

    return {
        query,
        fontHash,
        withinPath: path,
        matches
    };
}

async function fetchBinaryFontChildren(
    analysisCompiler: BinaryFontAnalysisWorkerState,
    fontHash: string,
    path: string,
    fontIndex: number,
    limit?: number
): Promise<BinaryFontChildrenResult> {
    if (typeof analysisCompiler.sendMessage !== 'function') {
        throw new Error(
            'list_binary_font_children is not available in the analysis compiler.'
        );
    }

    const result = await analysisCompiler.sendMessage({
        type: 'listDebugCachedFontChildren',
        fontHash,
        requestJson: JSON.stringify({
            fontIndex,
            path,
            limit
        })
    });

    if (typeof result?.result !== 'string') {
        throw new Error(
            `Worker returned no child-list result for font hash ${fontHash}`
        );
    }

    try {
        return JSON.parse(result.result) as BinaryFontChildrenResult;
    } catch (error) {
        throw new Error(
            `Worker returned invalid child-list JSON: ${String(error)}`
        );
    }
}

async function buildBinaryFontSnapshot(
    analysisCompiler: BinaryFontAnalysisWorkerState,
    fontHash: string,
    profileName: string,
    fontIndex: number
): Promise<string> {
    const normalizedProfile = profileName.trim().toLowerCase();
    const profile = BINARY_FONT_SNAPSHOT_PROFILES.find(
        (entry) => entry.name === normalizedProfile
    );
    if (!profile) {
        throw new Error(`Unknown snapshot profile: ${profileName}`);
    }

    if (typeof analysisCompiler.inspectDebugCachedFont !== 'function') {
        throw new Error(
            'snapshot_binary_font requires the binary inspection compiler.'
        );
    }

    const summary = await analysisCompiler.inspectDebugCachedFont(fontHash, {
        fontIndex,
        paths: profile.inspectPaths
    });
    const summaryValues = summary.values;
    const summaryRecord = {
        unitsPerEm: summaryValues[0] ?? null,
        numGlyphs: summaryValues[1] ?? null,
        familyName: summaryValues[2] ?? null,
        subfamilyName: summaryValues[3] ?? null,
        fullName: summaryValues[4] ?? null,
        version: summaryValues[5] ?? null,
        postScriptName: summaryValues[6] ?? null,
        copyright: summaryValues[7] ?? null,
        uniqueId: summaryValues[8] ?? null
    };

    const result: Record<string, unknown> = {
        fontHash,
        profile: profile.name,
        summary: summaryRecord
    };

    for (const listRequest of profile.listPaths) {
        const listed = await fetchBinaryFontChildren(
            analysisCompiler,
            fontHash,
            listRequest.path,
            fontIndex,
            listRequest.limit
        );
        if (listRequest.path === '/tables/name/records') {
            result.nameRecords = listed;
        } else if (listRequest.path === '/tables/fvar/axes') {
            result.variationAxes = listed;
        } else if (listRequest.path === '/tables/hmtx/metrics') {
            result.horizontalMetrics = listed;
        } else if (listRequest.path === '/tables/glyf') {
            result.glyphs = listed;
        } else {
            result[listRequest.path] = listed;
        }
    }

    return JSON.stringify(result);
}

const BINARY_FONT_API_DOCS = `Binary font tools use a discover -> inspect workflow.

1. Call compile_binary_font first. It returns only a stable 16-hex-digit fontHash, not a glyph count. Target "full" compiles every glyph in the committed font. Target "subset" requires text and compiles the layout closure of that text.
2. Use describe_binary_font to see which path families, child collections, and snapshot profiles are supported. This is static guidance only; it does not require a fontHash.
3. Use search_binary_font_surface to search the static binary-font surface metadata, path families, and snapshot profiles by keyword. Use this before compiling when you are still discovering the tool surface.
4. Use list_binary_font_children to enumerate the immediate children of a compiled font collection path such as /tables/name/records or /tables/fvar/axes. This requires a fontHash because it reads the compiled font.
5. Use search_binary_font_children to search actual child entries inside one compiled font subtree. It requires both fontHash and a collection path; use it after listing or when you already know the subtree you want to inspect. The legacy search_binary_font name is kept only for compatibility.
6. Use snapshot_binary_font to fetch curated bundles. Profiles are exact: summary (unitsPerEm, numGlyphs, and the common name IDs), names (summary + all name records), variation (summary + all variation axes), metrics (summary + bounded glyph metrics and glyph samples), review (summary + names + variation), and full (summary + names + variation + metrics + glyph samples).
7. Pass a fontHash to inspect_binary_font only when you already know the exact leaf paths you want. inspect_binary_font never compiles implicitly and returns {"values": [...]} in request order.

Supported exact inspection paths include:
- /tables/head/unitsPerEm
- /tables/maxp/numGlyphs
- /tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string
- /tables/fvar/axes/index=0 and /tables/fvar/axes/index=0/tag|minValue|defaultValue|maxValue|flags
- /tables/hmtx/metrics/gid=42/advanceWidth|sideBearing
- /tables/cmap/codepoint=U+0041/gid
- /tables/glyf/gid=36/outline

The discovery and inspection helpers are bounded to 64 exact inspection paths, 256 list entries, 4096 raw string bytes, 256 KiB request bytes, and 64 KiB serialized output. Missing tables, records, glyphs, and cmap entries return null. Malformed fonts, invalid indexes, unknown paths, and exceeded limits fail visibly.

shape_binary_font accepts text plus an optional HarfBuzz feature map, for example {"liga": false, "kern": true}, and a userspace variationLocation. It returns glyph names, gids, advances, offsets, and clusters for the compiled hash.`;

/** Wait until the committed Yjs worker state and visible font revision settle. */
async function awaitStableBinaryFontWorkerState(
    fontManager: BinaryFontManagerState,
    fontCompilation: BinaryFontWorkerState,
    getFontRevisionKey: () => string
): Promise<void> {
    if (
        typeof fontCompilation.awaitWorkerDocumentSync !== 'function' ||
        typeof fontCompilation.hasWorkerCacheDocument !== 'function'
    ) {
        throw new Error(
            'Binary-font analysis worker synchronization is not available yet.'
        );
    }

    await awaitStableWorkerState(
        {
            awaitWorkerDocumentSync: () =>
                fontCompilation.awaitWorkerDocumentSync!(),
            hasWorkerCacheDocument: () =>
                fontCompilation.hasWorkerCacheDocument!(),
            getWorkerCacheUpdatePromise: () =>
                fontManager.workerCacheUpdatePromise,
            getFontRevisionKey
        },
        {
            unavailable:
                'Binary-font analysis worker synchronization is not available yet.',
            notReady:
                'Binary-font analysis requires the current font to finish synchronizing to the compiler worker.',
            unstable:
                'Binary-font analysis could not stabilize the current font revision. Retry after editing settles.'
        }
    );
}

type BinaryFontRuntime = {
    fontManager?: BinaryFontManagerState;
    fontCompilation?: BinaryFontWorkerState;
    fullFontCompilation?: BinaryFontAnalysisWorkerState;
    shapeTextWithFontDetailed?: (
        fontBytes: Uint8Array,
        text: string,
        options?: {
            features?:
                string | string[] | Record<string, boolean | number | string>;
            variationLocation?: Record<string, number>;
        }
    ) => Promise<{
        glyphs: string[];
        gids: number[];
        advances: number[];
        advancesY: number[];
        offsetsX: number[];
        offsetsY: number[];
        clusters: number[];
    }>;
};

function getBinaryFontRuntime(): BinaryFontRuntime {
    return window as unknown as BinaryFontRuntime;
}

function isAssistantEditPreviewActive(): boolean {
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    return Boolean(
        outlineEditor?.draggingSomething ||
        outlineEditor?.isPreviewMode ||
        outlineEditor?.hasPendingKeyboardPreviewCommit()
    );
}

function assertBinaryFontMainWindow(toolName: string): void {
    if (window.windowRole && !window.windowRole.isMainWindow()) {
        throw new Error(`${toolName} is only available in the main window.`);
    }
    if (isAssistantEditPreviewActive()) {
        throw new Error(
            `${toolName} is unavailable while an edit preview is active. Retry after the edit commits.`
        );
    }
}

async function prepareBinaryFontAnalysisWorker(
    fontManager: BinaryFontManagerState,
    editingCompiler: BinaryFontWorkerState,
    analysisCompiler: BinaryFontAnalysisWorkerState,
    getFontRevisionKey: () => string
): Promise<void> {
    await awaitStableBinaryFontWorkerState(
        fontManager,
        editingCompiler,
        getFontRevisionKey
    );
    if (isAssistantEditPreviewActive()) {
        throw new Error(
            'Binary-font analysis is unavailable while an edit preview is active. Retry after the edit commits.'
        );
    }

    if (analysisCompiler.hasWorkerCacheDocument?.()) {
        // The analysis worker is seeded once, then kept current by the same
        // incremental Yjs mirror as the editing worker. Rebuilding every
        // glyph shard here is what made each compile far slower than typing.
        return;
    }

    const documentSet = fontManager.buildWorkerSeedDocumentSet?.() || null;
    if (
        documentSet?.length &&
        typeof analysisCompiler.seedWorkerDocumentSet === 'function'
    ) {
        // Glyph outlines live in per-glyph shards. The core snapshot has
        // features and masters but no glyph bodies, so a core-only seed
        // compiles an empty glyph set and traps in the metrics pass.
        await analysisCompiler.seedWorkerDocumentSet(documentSet);
        return;
    }

    if (
        typeof analysisCompiler.bootstrapWorkerCacheFromFontState !== 'function'
    ) {
        throw new Error(
            'Binary-font analysis isolated compiler is not ready yet.'
        );
    }
    const workerSeedState = fontManager.buildWorkerSeedYjsState?.();
    if (!workerSeedState?.length) {
        throw new Error(
            'Binary-font analysis could not snapshot the committed font state.'
        );
    }
    await analysisCompiler.bootstrapWorkerCacheFromFontState(workerSeedState);
}

function getBinaryFontAnalysisWorkerState(
    analysisCompiler: BinaryFontAnalysisWorkerState
) {
    if (
        typeof analysisCompiler.awaitWorkerDocumentSync !== 'function' ||
        typeof analysisCompiler.hasWorkerCacheDocument !== 'function'
    ) {
        throw new Error(
            'Binary-font analysis isolated compiler synchronization is not ready yet.'
        );
    }
    return {
        awaitWorkerDocumentSync: () =>
            analysisCompiler.awaitWorkerDocumentSync!(),
        hasWorkerCacheDocument: () =>
            analysisCompiler.hasWorkerCacheDocument!(),
        getWorkerCacheUpdatePromise: () => null,
        getFontRevisionKey: () => 'binary-analysis-worker'
    };
}

class AIAssistant {
    [key: string]: any;

    messagesContainer: HTMLElement | null;
    promptInput: HTMLTextAreaElement | null;
    sendButton: HTMLElement | null;
    chatContainer: HTMLElement | null;
    loginContainer: HTMLElement | null;
    subscriptionContainer: HTMLElement | null;

    isAuthenticated: boolean;
    subscription: any;
    isStreaming: boolean;
    abortController: AbortController | null;
    _reconnectAttempts: number;
    messages: Array<{ role: string; content: string }>;
    conversationMessages: Array<any>;
    roundUsage: UsageMetrics[];
    sessionTotals: UsageMetrics;
    binaryFontApiDocsViewed: boolean;
    allowFontEdits: boolean;
    activePromptContext: AssistantPromptExecutionContext | null;
    promptTransactionOpen: boolean;
    promptInterrupted: boolean;
    lastKnownScriptRevision: string | null;
    scriptStateInvalidated: boolean;

    constructor() {
        this.messagesContainer = null;
        this.promptInput = null;
        this.sendButton = null;
        this.chatContainer = null;
        this.loginContainer = null;
        this.subscriptionContainer = null;
        this.isAuthenticated = false;
        this.subscription = null;
        this.isStreaming = false;
        this.abortController = null;
        this._reconnectAttempts = 0;
        this.messages = [];
        this.conversationMessages = [];
        this.roundUsage = [];
        this.sessionTotals = {};
        this.binaryFontApiDocsViewed = false;
        this.allowFontEdits =
            localStorage.getItem('assistantAllowFontEdits') === 'true';
        this.activePromptContext = null;
        this.promptTransactionOpen = false;
        this.promptInterrupted = false;
        this.lastKnownScriptRevision = null;
        this.scriptStateInvalidated = false;

        this.initUI();
        this.checkAuthenticationStatus();
    }

    canUseAssistant() {
        return this.subscription?.canUseAssistant === true;
    }

    getWebsiteURL() {
        return resolveWebsiteURL();
    }

    async checkAuthenticationStatus() {
        if (!window.authManager) {
            setTimeout(() => this.checkAuthenticationStatus(), 100);
            return;
        }
        const originalCallback = window.authManager.onAuthStateChanged;
        window.authManager.onAuthStateChanged = (
            isAuthenticated: boolean,
            user: any,
            subscription: any
        ) => {
            this.isAuthenticated = isAuthenticated;
            this.subscription = subscription;
            this.updateAuthUI();
            if (originalCallback)
                originalCallback.call(
                    window.authManager,
                    isAuthenticated,
                    user,
                    subscription
                );
        };
        const user = await window.authManager.checkAuthStatus();
        this.isAuthenticated = !!user;
        this.subscription = window.authManager.subscription;
        this.updateAuthUI();
    }

    updateAuthUI() {
        const chatContainer = document.getElementById(
            'assistant-chat-container'
        );
        const loginContainer = document.getElementById(
            'assistant-login-container'
        );
        const subscriptionContainer = document.getElementById(
            'assistant-subscription-container'
        );
        if (!chatContainer || !loginContainer || !subscriptionContainer) return;

        if (!this.isAuthenticated) {
            chatContainer.style.display = 'flex';
            chatContainer.classList.add('assistant-input-only');
            loginContainer.style.display = 'flex';
            subscriptionContainer.style.display = 'none';
            this.lockAssistantInput(true);
        } else if (!this.canUseAssistant()) {
            chatContainer.style.display = 'none';
            chatContainer.classList.remove('assistant-input-only');
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'flex';
            this.lockAssistantInput(true);
        } else {
            chatContainer.style.display = 'flex';
            chatContainer.classList.remove('assistant-input-only');
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'none';
            this.lockAssistantInput(false);
        }
    }

    lockAssistantInput(locked: boolean) {
        if (this.promptInput) {
            this.promptInput.disabled = locked;
            if (locked) {
                this.promptInput.blur();
            }
        }
        if (this.sendButton) {
            (this.sendButton as HTMLButtonElement).disabled =
                locked || this.isStreaming;
        }
    }

    initUI() {
        this.promptInput = document.getElementById(
            'assistant-prompt'
        ) as HTMLTextAreaElement | null;
        this.sendButton = document.getElementById('assistant-send-btn');
        this.messagesContainer = document.getElementById('assistant-messages');
        this.chatContainer = document.getElementById(
            'assistant-chat-container'
        );
        this.loginContainer = document.getElementById(
            'assistant-login-container'
        );
        this.subscriptionContainer = document.getElementById(
            'assistant-subscription-container'
        );
        if (!this.sendButton || !this.promptInput || !this.messagesContainer) {
            console.warn('Assistant UI elements not found');
            return;
        }

        this.sendButton.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            this.sendPrompt();
        });
        this.promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.sendPrompt();
            }
        });

        const loginBtn = document.getElementById('assistant-login-btn');
        if (loginBtn)
            loginBtn.addEventListener('click', () => {
                window.location.href =
                    this.getWebsiteURL() +
                    '/login?returnTo=' +
                    encodeURIComponent(window.location.href);
            });

        const accountBtn = document.getElementById('assistant-account-btn');
        if (accountBtn)
            accountBtn.addEventListener('click', () => {
                window.location.href =
                    this.getWebsiteURL() +
                    '/account?returnTo=' +
                    encodeURIComponent(window.location.href);
            });

        document
            .getElementById('assistant-new-chat-btn')
            ?.addEventListener('click', () => this.newChat());

        const editToggle = document.getElementById(
            'assistant-edit-toggle'
        ) as HTMLButtonElement | null;
        editToggle?.addEventListener('click', () => {
            if (this.isStreaming) return;
            this.allowFontEdits = !this.allowFontEdits;
            localStorage.setItem(
                'assistantAllowFontEdits',
                String(this.allowFontEdits)
            );
            this.updateAssistantEditToggle();
        });
        this.updateAssistantEditToggle();

        window.addEventListener('scriptEditorDocumentChanged', (event) => {
            const state = (event as CustomEvent<{ revision: string }>).detail;
            if (
                this.lastKnownScriptRevision &&
                state.revision !== this.lastKnownScriptRevision
            ) {
                this.scriptStateInvalidated = true;
            }
        });

        document
            .getElementById('assistant-stop-btn')
            ?.addEventListener('click', () => this.interruptPrompt());

        this.promptInput.addEventListener('input', () => {
            this.promptInput!.style.height = 'auto';
            this.promptInput!.style.height =
                Math.min(this.promptInput!.scrollHeight, 120) + 'px';
        });

        this.setupInfoModal();
    }

    updateAssistantEditToggle() {
        const editToggle = document.getElementById(
            'assistant-edit-toggle'
        ) as HTMLButtonElement | null;
        if (!editToggle) return;

        const editsAllowed = this.allowFontEdits;
        const isLocked = this.isStreaming;
        const stateLabel = editsAllowed ? 'on' : 'off';
        const label = isLocked
            ? `Assistant edits are ${stateLabel} for this prompt and locked`
            : `Assistant edits are ${stateLabel}`;

        editToggle.classList.toggle('active', editsAllowed);
        editToggle.classList.toggle('locked', isLocked);
        editToggle.disabled = isLocked;
        editToggle.setAttribute('aria-pressed', String(editsAllowed));
        editToggle.setAttribute('aria-label', label);
        editToggle.title = label;

        const icon = editToggle.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = editsAllowed ? 'edit' : 'edit_off';
        }
    }

    private async getRuntimeSystemPrompt(): Promise<string> {
        const editorState = await this.executeToolCall({
            function: { name: 'get_editor_state', arguments: '{}' }
        });
        const promptContext = this.activePromptContext;
        const scriptState = window.scriptEditor?.getDocumentState();
        if (
            scriptState &&
            this.lastKnownScriptRevision &&
            scriptState.revision !== this.lastKnownScriptRevision
        ) {
            this.scriptStateInvalidated = true;
        }
        const staleScriptNotice = this.scriptStateInvalidated
            ? '\n\nSCRIPT STATE NOTICE: The Script Editor changed after the Assistant last read it. The buffer is authoritative; read the active Python document before proposing or applying another script edit.'
            : '';
        return `${ASSISTANT_SYSTEM_PROMPT}\n\nCURRENT PROMPT PERMISSION: Assistant editing is ${promptContext?.allowFontEdits ? 'allowed' : 'disabled'} for this prompt.${staleScriptNotice}\n\nCURRENT EDITOR STATE:\n${editorState}`;
    }

    setupInfoModal() {
        const btn = document.getElementById('assistant-info-btn');
        const modal = document.getElementById('assistant-info-modal');
        const close = document.getElementById('assistant-info-modal-close-btn');
        const content = document.getElementById('assistant-info-modal-content');
        if (!btn || !modal || !close || !content) return;

        const createLiveToolButton = (tool: AssistantTool) => {
            const properties = this.getToolParameterProperties(tool);
            const hasParameters = Object.keys(properties).length > 0;
            const infoBtn = document.createElement('button');
            infoBtn.className = 'assistant-tool-call-info-btn';
            infoBtn.textContent = 'ⓘ';
            infoBtn.title = hasParameters
                ? 'Configure and run tool'
                : 'Run tool and show current output';

            const instance = tippy(infoBtn, {
                content: this.createToolInvocationPopup(tool),
                allowHTML: true,
                interactive: true,
                appendTo: document.body,
                maxWidth: 520,
                placement: 'right',
                trigger: 'manual',
                zIndex: 99999,
                theme: getTheme(),
                popperOptions: {
                    modifiers: [
                        {
                            name: 'preventOverflow',
                            options: {
                                boundary: 'viewport',
                                padding: 12
                            }
                        }
                    ]
                },
                onMount(instance) {
                    const inner = instance.popper.querySelector(
                        '.tippy-content'
                    ) as HTMLElement | null;
                    if (inner) {
                        inner.style.maxHeight = '70vh';
                        inner.style.overflowY = 'auto';
                    }
                }
            });

            infoBtn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                instance.setContent(
                    this.createToolInvocationPopup(tool, {
                        autoRun: !hasParameters
                    })
                );
                instance.show();
            });

            return infoBtn;
        };

        const search = document.createElement('div');
        search.className = 'find-glyph-search overview-search-control';

        const searchIcon = document.createElement('span');
        searchIcon.className = 'material-symbols-outlined overview-search-icon';
        searchIcon.textContent = 'search';
        search.appendChild(searchIcon);

        const searchInput = document.createElement('input');
        searchInput.className = 'find-glyph-search-input';
        searchInput.type = 'search';
        searchInput.placeholder = 'Search tool names';
        searchInput.setAttribute('aria-label', 'Search tool names');
        search.appendChild(searchInput);

        const categoryChips = document.createElement('div');
        categoryChips.className = 'assistant-tool-category-chips';
        categoryChips.setAttribute('aria-label', 'Tool categories');
        categoryChips.setAttribute('role', 'group');

        const toolList = document.createElement('div');
        toolList.className = 'assistant-tool-list';

        const categories = [
            ...new Set(
                ASSISTANT_TOOLS.map(
                    (tool) => ASSISTANT_TOOL_CATEGORIES[tool.function.name]
                )
            )
        ];
        let activeCategory: AssistantToolCategory | null = null;

        const renderTools = () => {
            const searchTerm = searchInput.value.trim().toLowerCase();
            toolList.replaceChildren();

            for (const category of categories) {
                if (activeCategory && category !== activeCategory) {
                    continue;
                }

                const matchingTools = ASSISTANT_TOOLS.filter(
                    (tool) =>
                        ASSISTANT_TOOL_CATEGORIES[tool.function.name] ===
                            category &&
                        tool.function.name.toLowerCase().includes(searchTerm)
                );
                if (matchingTools.length === 0) {
                    continue;
                }

                const categorySection = document.createElement('section');
                categorySection.className = 'assistant-tool-category';

                const categoryTitle = document.createElement('h4');
                categoryTitle.className = 'assistant-tool-category-title';
                categoryTitle.textContent = category;
                categorySection.appendChild(categoryTitle);

                for (const tool of matchingTools) {
                    const section = document.createElement('div');
                    section.className = 'ai-info-section';
                    section.style.marginBottom = '16px';

                    const titleRow = document.createElement('div');
                    titleRow.style.cssText =
                        'display:flex;align-items:center;gap:6px;margin:0 0 4px 0;';

                    const title = document.createElement('h4');
                    title.style.cssText =
                        'font-size:14px;margin:0;color:var(--text-primary);font-weight:600;';
                    title.textContent = tool.function.name;
                    titleRow.appendChild(title);

                    const properties = this.getToolParameterProperties(tool);
                    titleRow.appendChild(createLiveToolButton(tool));

                    section.appendChild(titleRow);

                    const description = document.createElement('div');
                    description.style.cssText =
                        'margin:0 0 8px 0;font-size:12px;color:var(--text-tertiary);line-height:1.5';
                    if (typeof marked !== 'undefined') {
                        description.innerHTML = marked.parse(
                            tool.function.description
                        );
                    } else {
                        description.textContent = tool.function.description;
                    }
                    section.appendChild(description);

                    const params = document.createElement('div');
                    params.style.cssText =
                        'font-size:11px;color:var(--text-faint)';
                    if (Object.keys(properties).length > 0) {
                        const strong = document.createElement('strong');
                        strong.textContent = 'Parameters:';
                        params.appendChild(strong);
                        params.appendChild(document.createTextNode(' '));

                        for (const name of Object.keys(properties)) {
                            const code = document.createElement('code');
                            code.style.cssText =
                                'background:var(--background-hover);padding:1px 4px;border-radius:3px;margin-right:4px';
                            code.textContent = name;
                            params.appendChild(code);
                        }
                    } else {
                        const em = document.createElement('em');
                        em.textContent = 'No parameters';
                        params.appendChild(em);
                    }
                    section.appendChild(params);
                    categorySection.appendChild(section);
                }

                toolList.appendChild(categorySection);
            }

            if (!toolList.hasChildNodes()) {
                const emptyState = document.createElement('p');
                emptyState.className = 'assistant-tool-empty';
                emptyState.textContent = 'No matching tools.';
                toolList.appendChild(emptyState);
            }
        };

        const renderCategoryChips = () => {
            categoryChips.replaceChildren();
            for (const category of [null, ...categories]) {
                const chip = document.createElement('button');
                chip.className = 'assistant-tool-category-chip';
                chip.type = 'button';
                chip.textContent = category || 'All';
                chip.setAttribute(
                    'aria-pressed',
                    String(activeCategory === category)
                );
                chip.addEventListener('click', () => {
                    activeCategory = category;
                    renderCategoryChips();
                    renderTools();
                });
                categoryChips.appendChild(chip);
            }
        };

        searchInput.addEventListener('input', renderTools);
        content.replaceChildren(search, categoryChips, toolList);
        renderCategoryChips();
        renderTools();

        // Open
        let escapeBinding: ModalEscapeBinding | null = null;
        const closeModal = () => {
            escapeBinding?.release();
            escapeBinding = null;
            modal.style.display = 'none';
        };

        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            modal.style.display = 'flex';
            escapeBinding?.release();
            escapeBinding = bindModalEscape(closeModal, {
                isOpen: () => modal.style.display === 'flex'
            });
            requestAnimationFrame(() => searchInput.focus());
        });

        close.addEventListener('click', closeModal);

        // Close on backdrop click
        modal.addEventListener('click', (e: Event) => {
            if (e.target === modal) closeModal();
        });
    }

    getToolParameterProperties(tool: AssistantTool): Record<string, any> {
        return ((tool.function.parameters as any)?.properties || {}) as Record<
            string,
            any
        >;
    }

    getToolRequiredParameters(tool: AssistantTool): Set<string> {
        const required = (tool.function.parameters as any)?.required;
        return new Set(Array.isArray(required) ? required : []);
    }

    shouldUseTextareaForToolParameter(
        paramName: string,
        schema: Record<string, any>
    ): boolean {
        if (schema.type === 'array' || schema.type === 'object') {
            return true;
        }

        return paramName === 'code' || paramName === 'text';
    }

    parseToolParameterValue(
        rawValue: string,
        schema: Record<string, any>
    ): any {
        const trimmed = rawValue.trim();

        switch (schema.type) {
            case 'array': {
                if (!trimmed) {
                    return [];
                }

                if (trimmed.startsWith('[')) {
                    const parsed = JSON.parse(trimmed);
                    if (!Array.isArray(parsed)) {
                        throw new Error('Expected a JSON array.');
                    }
                    return parsed;
                }

                return trimmed
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .filter(Boolean);
            }
            case 'integer': {
                if (!trimmed) {
                    return undefined;
                }
                const value = Number(trimmed);
                if (!Number.isInteger(value)) {
                    throw new Error('Expected an integer value.');
                }
                return value;
            }
            case 'number': {
                if (!trimmed) {
                    return undefined;
                }
                const value = Number(trimmed);
                if (!Number.isFinite(value)) {
                    throw new Error('Expected a numeric value.');
                }
                return value;
            }
            case 'boolean': {
                if (!trimmed) {
                    return undefined;
                }
                if (trimmed === 'true') {
                    return true;
                }
                if (trimmed === 'false') {
                    return false;
                }
                throw new Error('Expected `true` or `false`.');
            }
            case 'object': {
                if (!trimmed) {
                    return {};
                }
                return JSON.parse(trimmed);
            }
            default:
                return rawValue;
        }
    }

    collectToolInvocationArguments(
        tool: AssistantTool,
        fields: Record<
            string,
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >
    ): Record<string, any> {
        const properties = this.getToolParameterProperties(tool);
        const required = this.getToolRequiredParameters(tool);
        const args: Record<string, any> = {};

        for (const [paramName, schema] of Object.entries(properties)) {
            const field = fields[paramName];
            if (!field) {
                continue;
            }

            const rawValue = field.value;
            const trimmed = rawValue.trim();
            if (!trimmed && schema.type !== 'array') {
                if (required.has(paramName)) {
                    throw new Error(`Missing required parameter: ${paramName}`);
                }
                continue;
            }

            const value = this.parseToolParameterValue(rawValue, schema);
            if (value === undefined && !required.has(paramName)) {
                continue;
            }
            args[paramName] = value;
        }

        return args;
    }

    createToolInvocationPopup(
        tool: AssistantTool,
        options: { autoRun?: boolean } = {}
    ): HTMLElement {
        const properties = this.getToolParameterProperties(tool);
        const fieldEntries = Object.entries(properties);
        const fields: Record<
            string,
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        > = {};

        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'min-width:320px;max-width:520px;padding:8px;color:var(--text-primary);';

        const title = document.createElement('div');
        title.textContent = tool.function.name;
        title.style.cssText =
            'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary);';
        wrapper.appendChild(title);

        const form = document.createElement('form');
        form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

        for (const [paramName, schema] of fieldEntries) {
            const fieldWrapper = document.createElement('label');
            fieldWrapper.style.cssText =
                'display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-primary);';

            const label = document.createElement('span');
            label.textContent = paramName;
            label.style.cssText = 'font-weight:600;';
            fieldWrapper.appendChild(label);

            const enumValues = Array.isArray(schema.enum)
                ? schema.enum.filter(
                      (value: unknown): value is string =>
                          typeof value === 'string'
                  )
                : [];
            const input =
                enumValues.length > 0
                    ? document.createElement('select')
                    : this.shouldUseTextareaForToolParameter(paramName, schema)
                      ? document.createElement('textarea')
                      : document.createElement('input');

            input.style.cssText =
                'width:100%;box-sizing:border-box;border:1px solid var(--border-primary);border-radius:6px;padding:8px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:11px;';
            input.name = paramName;
            if (input instanceof HTMLSelectElement) {
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = `Choose ${paramName}`;
                input.appendChild(placeholder);
                for (const value of enumValues) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = value;
                    input.appendChild(option);
                }
            } else if (input instanceof HTMLTextAreaElement) {
                input.rows = schema.type === 'array' ? 4 : 6;
                if (schema.type === 'array') {
                    input.placeholder =
                        '["liga", "kern"] or one value per line';
                }
            } else {
                input.type = 'text';
            }

            if (
                !(input instanceof HTMLSelectElement) &&
                !input.placeholder &&
                typeof schema.description === 'string'
            ) {
                input.placeholder = schema.description;
            }

            fieldWrapper.appendChild(input);

            if (typeof schema.description === 'string' && schema.description) {
                const description = document.createElement('div');
                description.textContent = schema.description;
                description.style.cssText =
                    'font-size:10px;line-height:1.4;color:var(--text-tertiary);';
                fieldWrapper.appendChild(description);
            }

            fields[paramName] = input;
            form.appendChild(fieldWrapper);
        }

        const controls = document.createElement('div');
        controls.style.cssText =
            'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = 'Run tool';
        submitButton.style.cssText =
            'border:1px solid var(--border-primary);border-radius:6px;padding:6px 10px;background:var(--background-hover);color:var(--text-primary);font-size:11px;cursor:pointer;';
        controls.appendChild(submitButton);

        const status = document.createElement('div');
        status.style.cssText =
            'font-size:10px;line-height:1.4;color:var(--text-tertiary);';
        status.textContent =
            fieldEntries.length > 0
                ? 'Fill parameters, then invoke this tool.'
                : 'Invoke this tool.';
        controls.appendChild(status);

        form.appendChild(controls);
        wrapper.appendChild(form);

        const output = document.createElement('div');
        output.style.marginTop = '10px';
        wrapper.appendChild(output);

        const setOutput = (element: HTMLElement) => {
            output.innerHTML = '';
            output.appendChild(element);
        };

        const runTool = async () => {
            let args: Record<string, any> = {};
            try {
                args = this.collectToolInvocationArguments(tool, fields);
            } catch (error: any) {
                status.textContent = error.message || 'Invalid parameters.';
                status.style.color = 'var(--accent-red)';
                return;
            }

            submitButton.disabled = true;
            submitButton.style.opacity = '0.65';
            status.textContent = 'Running...';
            status.style.color = 'var(--text-tertiary)';

            try {
                const toolResult = await this.executeToolCall({
                    id: `info-${tool.function.name}`,
                    function: {
                        name: tool.function.name,
                        arguments: JSON.stringify(args)
                    }
                });

                status.textContent = 'Completed.';
                setOutput(
                    this.createToolCallMetaElement(
                        tool.function.name,
                        args,
                        toolResult,
                        new Date().toLocaleTimeString()
                    )
                );
            } catch (error: any) {
                status.textContent = 'Tool call failed.';
                status.style.color = 'var(--accent-red)';
                setOutput(
                    this.createToolCallMetaElement(
                        tool.function.name,
                        args,
                        `Error: ${error.message}`,
                        new Date().toLocaleTimeString()
                    )
                );
                return;
            } finally {
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
            }

            status.style.color = 'var(--text-tertiary)';
        };

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            await runTool();
        });

        if (options.autoRun) {
            void runTool();
        }

        return wrapper;
    }

    createAssistantMessageShell() {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'assistant-message assistant-message-assistant';

        const header = document.createElement('div');
        header.className = 'assistant-message-header';
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.gap = '6px';

        const label = document.createElement('span');
        label.style.display = 'inline-flex';
        label.style.alignItems = 'center';
        label.style.gap = '4px';
        label.innerHTML =
            '<span class="material-symbols-outlined">robot_2</span> Assistant';
        header.appendChild(label);

        messageDiv.appendChild(header);

        const body = document.createElement('div');
        messageDiv.appendChild(body);

        return { messageDiv, header, body };
    }

    attachPopup(
        button: HTMLElement,
        contentFactory: () => HTMLElement,
        placement: string = 'right',
        maxWidth: number = 520
    ) {
        tippy(button, {
            content: contentFactory(),
            allowHTML: true,
            interactive: true,
            appendTo: document.body,
            maxWidth,
            placement: placement as any,
            zIndex: 99999,
            theme: getTheme(),
            popperOptions: {
                modifiers: [
                    {
                        name: 'preventOverflow',
                        options: {
                            boundary: 'viewport',
                            padding: 12
                        }
                    }
                ]
            },
            onShow: (instance) => {
                instance.setContent(contentFactory());
            },
            onMount(instance) {
                const content = instance.popper.querySelector(
                    '.tippy-content'
                ) as HTMLElement | null;
                if (content) {
                    content.style.maxHeight = '70vh';
                    content.style.overflowY = 'auto';
                }
            }
        });
    }

    toolCallHasNoArguments(args: any): boolean {
        return (
            !args ||
            (typeof args === 'object' &&
                !Array.isArray(args) &&
                Object.keys(args).length === 0)
        );
    }

    createToolCallMetaElement(
        toolName: string,
        args: any,
        toolResult: string,
        timeLabel: string
    ): HTMLElement {
        const resultLen = toolResult.length;
        const metaEl = document.createElement('div');
        metaEl.style.cssText =
            'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';

        let argsHtml: string;
        if (toolName === 'execute_python_code' && args.code) {
            argsHtml = `<b>Arguments:</b><br><pre style="margin:4px 0 0 0;padding:8px;background:var(--background-hover);border-radius:4px;font-size:11px;line-height:1.5;overflow-x:auto;font-family:var(--font-families-mono);tab-size:4">${this.highlightPython(args.code)}</pre>`;
        } else {
            argsHtml = `<b>Arguments:</b> ${this.escapeHtml(JSON.stringify(args, null, 2))}`;
        }

        metaEl.innerHTML = `
            <b>Tool:</b> ${toolName}<br>
            ${argsHtml}<br>
            <b>Result:</b> ${resultLen} characters<br>
            <b>Time:</b> ${this.escapeHtml(timeLabel)}<br>
            <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${this.escapeHtml(toolResult)}</pre>
        `;

        if (
            toolName === 'replace_python_text_in_editor' &&
            typeof args.old_text === 'string' &&
            typeof args.new_text === 'string'
        ) {
            this.addPythonDocumentToolActions(metaEl, args, toolResult);
        }

        return metaEl;
    }

    private addPythonDocumentToolActions(
        metaEl: HTMLElement,
        args: { old_text: string; new_text: string },
        toolResult: string
    ): void {
        const revision = toolResult.match(/^Revision: (.+)$/m)?.[1];
        if (!revision) return;

        const actions = document.createElement('div');
        actions.style.cssText =
            'display:flex;gap:4px;margin-top:6px;align-items:center;';
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.title = 'Open in Script Editor';
        openButton.setAttribute('aria-label', 'Open in Script Editor');
        openButton.innerHTML =
            '<span class="material-symbols-outlined">code</span>';
        const revertButton = document.createElement('button');
        revertButton.type = 'button';
        revertButton.title = 'Revert this Assistant edit';
        revertButton.setAttribute('aria-label', 'Revert this Assistant edit');
        revertButton.innerHTML =
            '<span class="material-symbols-outlined">undo</span>';
        const status = document.createElement('span');
        status.style.cssText = 'font-size:10px;';

        openButton.addEventListener('click', () => {
            document.getElementById('view-scripts')?.click();
        });
        revertButton.addEventListener('click', () => {
            if (!this.allowFontEdits) {
                status.textContent =
                    'Enable editing in the Assistant title bar before reverting.';
                return;
            }
            const scriptEditor = window.scriptEditor;
            const state = scriptEditor?.getDocumentState();
            if (!scriptEditor || !state || state.revision !== revision) {
                status.textContent =
                    'The script changed since this Assistant edit. Use the Script Editor recovery controls instead.';
                return;
            }
            try {
                const restored = scriptEditor.replaceExactText(
                    args.new_text,
                    args.old_text,
                    revision
                );
                this.lastKnownScriptRevision = restored.revision;
                this.scriptStateInvalidated = false;
                revertButton.disabled = true;
                status.textContent = 'Assistant edit reverted, not saved.';
            } catch (error) {
                status.textContent = (error as Error).message;
            }
        });

        actions.append(openButton, revertButton, status);
        metaEl.appendChild(actions);
    }

    createToolCallOutputElement(
        toolName: string,
        toolResult: string,
        timeLabel: string
    ): HTMLElement {
        const outputEl = document.createElement('div');
        outputEl.style.cssText =
            'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';
        outputEl.innerHTML = `
            <b>Tool:</b> ${toolName}<br>
            <b>Time:</b> ${this.escapeHtml(timeLabel)}<br>
            <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${this.escapeHtml(toolResult)}</pre>
        `;
        return outputEl;
    }

    private createInlinePythonEditDiffElement(
        toolResult: string,
        args?: { old_text?: string; new_text?: string }
    ): HTMLElement {
        const outputEl = document.createElement('div');
        outputEl.className = 'assistant-python-edit-diff';
        outputEl.style.cssText =
            'margin:4px 0 8px 20px;padding:8px;border:1px solid var(--border-primary);border-radius:6px;background:var(--background-secondary);color:var(--text-primary);font-size:11px;line-height:1.5;';

        const diffStart = toolResult.indexOf('@@ Script Editor @@');
        const summary =
            diffStart >= 0 ? toolResult.slice(0, diffStart).trim() : '';
        const title = document.createElement('div');
        title.textContent = 'Python edit diff';
        title.style.cssText = 'font-weight:600;margin-bottom:4px';
        outputEl.appendChild(title);

        if (summary) {
            const summaryEl = document.createElement('div');
            summaryEl.textContent = summary;
            summaryEl.style.cssText =
                'margin-bottom:6px;color:var(--text-secondary);white-space:pre-wrap';
            outputEl.appendChild(summaryEl);
        }

        const hasLineInputs =
            typeof args?.old_text === 'string' &&
            typeof args?.new_text === 'string';
        if (hasLineInputs) {
            const rows = this.createPythonLineDiffRows(
                args.old_text || '',
                args.new_text || ''
            );
            outputEl.appendChild(this.renderPythonLineDiffRows(rows));
        } else {
            const diff =
                diffStart >= 0
                    ? toolResult.slice(diffStart).trim()
                    : toolResult.trim();
            const pre = document.createElement('pre');
            pre.textContent = diff;
            pre.style.cssText =
                'margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px;font-family:var(--font-families-mono);tab-size:4';
            outputEl.appendChild(pre);
        }
        return outputEl;
    }

    private createPythonLineDiffRows(
        oldText: string,
        newText: string
    ): Array<{
        type: 'context' | 'removed' | 'added' | 'omitted';
        oldLine?: number;
        newLine?: number;
        text: string;
    }> {
        const oldLines = oldText.split(/\r?\n/);
        const newLines = newText.split(/\r?\n/);
        const lengths = Array.from(
            { length: oldLines.length + 1 },
            () => Array(newLines.length + 1).fill(0) as number[]
        );

        for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
            for (
                let newIndex = newLines.length - 1;
                newIndex >= 0;
                newIndex--
            ) {
                lengths[oldIndex][newIndex] =
                    oldLines[oldIndex] === newLines[newIndex]
                        ? lengths[oldIndex + 1][newIndex + 1] + 1
                        : Math.max(
                              lengths[oldIndex + 1][newIndex],
                              lengths[oldIndex][newIndex + 1]
                          );
            }
        }

        const rows: Array<{
            type: 'context' | 'removed' | 'added' | 'omitted';
            oldLine?: number;
            newLine?: number;
            text: string;
        }> = [];
        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < oldLines.length || newIndex < newLines.length) {
            if (
                oldIndex < oldLines.length &&
                newIndex < newLines.length &&
                oldLines[oldIndex] === newLines[newIndex]
            ) {
                rows.push({
                    type: 'context',
                    oldLine: oldIndex + 1,
                    newLine: newIndex + 1,
                    text: oldLines[oldIndex]
                });
                oldIndex++;
                newIndex++;
            } else if (
                newIndex < newLines.length &&
                (oldIndex >= oldLines.length ||
                    lengths[oldIndex][newIndex + 1] >
                        lengths[oldIndex + 1][newIndex])
            ) {
                rows.push({
                    type: 'added',
                    newLine: newIndex + 1,
                    text: newLines[newIndex]
                });
                newIndex++;
            } else {
                rows.push({
                    type: 'removed',
                    oldLine: oldIndex + 1,
                    text: oldLines[oldIndex]
                });
                oldIndex++;
            }
        }

        return this.collapsePythonDiffContextRows(rows);
    }

    private collapsePythonDiffContextRows(
        rows: Array<{
            type: 'context' | 'removed' | 'added' | 'omitted';
            oldLine?: number;
            newLine?: number;
            text: string;
        }>
    ): Array<{
        type: 'context' | 'removed' | 'added' | 'omitted';
        oldLine?: number;
        newLine?: number;
        text: string;
    }> {
        const contextRadius = 2;
        const changedIndexes = rows
            .map((row, index) => (row.type === 'context' ? -1 : index))
            .filter((index) => index >= 0);
        if (changedIndexes.length === 0) return rows;

        const keep = new Set<number>();
        for (const changedIndex of changedIndexes) {
            for (
                let index = Math.max(0, changedIndex - contextRadius);
                index <=
                Math.min(rows.length - 1, changedIndex + contextRadius);
                index++
            ) {
                keep.add(index);
            }
        }

        const collapsed: Array<{
            type: 'context' | 'removed' | 'added' | 'omitted';
            oldLine?: number;
            newLine?: number;
            text: string;
        }> = [];
        let omittedCount = 0;
        for (let index = 0; index < rows.length; index++) {
            if (keep.has(index) || rows[index].type !== 'context') {
                if (omittedCount > 0) {
                    collapsed.push({
                        type: 'omitted',
                        text: `${omittedCount} unchanged line${
                            omittedCount === 1 ? '' : 's'
                        } hidden`
                    });
                    omittedCount = 0;
                }
                collapsed.push(rows[index]);
            } else {
                omittedCount++;
            }
        }
        if (omittedCount > 0) {
            collapsed.push({
                type: 'omitted',
                text: `${omittedCount} unchanged line${
                    omittedCount === 1 ? '' : 's'
                } hidden`
            });
        }
        return collapsed;
    }

    private renderPythonLineDiffRows(
        rows: Array<{
            type: 'context' | 'removed' | 'added' | 'omitted';
            oldLine?: number;
            newLine?: number;
            text: string;
        }>
    ): HTMLElement {
        const list = document.createElement('div');
        list.style.cssText =
            'display:flex;flex-direction:column;gap:1px;font-family:var(--font-families-mono);font-size:10px;tab-size:4;';

        for (const row of rows) {
            const line = document.createElement('div');
            line.className = `assistant-python-edit-diff-row assistant-python-edit-diff-row-${row.type}`;
            const marker = document.createElement('span');
            const text = document.createElement('span');

            line.style.cssText =
                'display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;padding:2px 6px;border-radius:4px;white-space:pre-wrap;word-break:break-word;';
            marker.style.cssText =
                'user-select:none;color:var(--text-tertiary);text-align:right;';
            text.textContent = row.text;

            if (row.type === 'added') {
                line.style.background =
                    'color-mix(in srgb, var(--accent-green) 16%, transparent)';
                line.style.borderLeft = '3px solid var(--accent-green)';
                marker.textContent = `+${row.newLine || ''}`;
            } else if (row.type === 'removed') {
                line.style.background =
                    'color-mix(in srgb, var(--accent-red) 16%, transparent)';
                line.style.borderLeft = '3px solid var(--accent-red)';
                marker.textContent = `-${row.oldLine || ''}`;
            } else if (row.type === 'omitted') {
                line.style.color = 'var(--text-tertiary)';
                line.style.fontStyle = 'italic';
                marker.textContent = '...';
            } else {
                line.style.color = 'var(--text-secondary)';
                marker.textContent = ` ${row.oldLine || row.newLine || ''}`;
            }

            line.append(marker, text);
            list.appendChild(line);
        }

        return list;
    }

    parseOpenTypeSearchTerms(query: string): string[] {
        return query
            .toLowerCase()
            .split(/\s+/)
            .map((term) => term.trim())
            .filter(Boolean);
    }

    parseOpenTypeClassGlyphMembers(classCode: string): Set<string> {
        const glyphs = new Set<string>();
        if (!classCode) {
            return glyphs;
        }

        const codeWithoutComments = classCode.replace(/#.*/g, '');
        const tokens = codeWithoutComments
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean);

        tokens.forEach((token) => glyphs.add(token));
        return glyphs;
    }

    getAllOpenTypeGlyphsInClass(
        className: string,
        classGlyphMembers: Map<string, Set<string>>,
        visited: Set<string> = new Set()
    ): Set<string> {
        const allGlyphs = new Set<string>();
        if (visited.has(className)) {
            return allGlyphs;
        }
        visited.add(className);

        const cleanName = className.startsWith('@')
            ? className.slice(1)
            : className;
        const members = classGlyphMembers.get(cleanName);
        if (!members) {
            return allGlyphs;
        }

        members.forEach((member) => {
            if (member.startsWith('@')) {
                const nestedGlyphs = this.getAllOpenTypeGlyphsInClass(
                    member,
                    classGlyphMembers,
                    visited
                );
                nestedGlyphs.forEach((glyph) => allGlyphs.add(glyph));
                return;
            }

            allGlyphs.add(member);
        });

        return allGlyphs;
    }

    findOpenTypeFeatureMatchLines(
        code: string,
        searchTerms: string[],
        matchingClasses: string[]
    ): Array<{ lineNumber: number; line: string }> {
        const lines = code.split(/\r?\n/);
        const matches: Array<{ lineNumber: number; line: string }> = [];

        lines.forEach((line, index) => {
            const lineLower = line.toLowerCase();
            const matchesSearchTerm = searchTerms.some((term) =>
                lineLower.includes(term)
            );
            const matchesClassReference = matchingClasses.some((className) =>
                line.includes(`@${className}`)
            );

            if (!matchesSearchTerm && !matchesClassReference) {
                return;
            }

            matches.push({
                lineNumber: index + 1,
                line: line.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim()
            });
        });

        return matches;
    }

    searchFontOpenTypeClassesAndFeatures(query: string): string {
        const font = (window as any).currentFontModel;
        if (!font) {
            throw new Error('No font is currently open.');
        }

        const searchTerms = this.parseOpenTypeSearchTerms(query);
        if (searchTerms.length === 0) {
            throw new Error('Search query is empty.');
        }

        const classEntries = Object.entries(
            font.features?.classes || {}
        ) as Array<[string, { code?: string }]>;
        const featureEntries = (font.features?.features || []) as Array<
            [string, { code?: string }]
        >;

        const classCodeData = new Map<string, string>();
        const classGlyphMembers = new Map<string, Set<string>>();

        classEntries.forEach(([className, classData]) => {
            const code = classData?.code || '';
            classCodeData.set(className, code);
            classGlyphMembers.set(
                className,
                this.parseOpenTypeClassGlyphMembers(code)
            );
        });

        const matchingClasses = classEntries
            .map(([className, classData]) => {
                const code = classData?.code || '';
                const directMatchText = `${className} ${code}`.toLowerCase();
                const hasDirectMatch = searchTerms.every((term) =>
                    directMatchText.includes(term)
                );
                const matchingGlyphs = Array.from(
                    this.getAllOpenTypeGlyphsInClass(
                        className,
                        classGlyphMembers
                    )
                )
                    .filter((glyph) => {
                        const glyphLower = glyph.toLowerCase();
                        return searchTerms.every((term) =>
                            glyphLower.includes(term)
                        );
                    })
                    .sort((left, right) => left.localeCompare(right));

                if (!hasDirectMatch && matchingGlyphs.length === 0) {
                    return null;
                }

                return {
                    className,
                    matchingGlyphs
                };
            })
            .filter(
                (
                    value
                ): value is { className: string; matchingGlyphs: string[] } =>
                    value !== null
            )
            .sort((left, right) =>
                left.className.localeCompare(right.className)
            );

        const matchingClassNames = matchingClasses.map(
            ({ className }) => className
        );

        const matchingFeatures = featureEntries
            .map(([tag, codeData], index) => {
                const code = codeData?.code || '';
                const searchText = `${tag} ${code}`.toLowerCase();
                const hasDirectMatch = searchTerms.every((term) =>
                    searchText.includes(term)
                );
                const referencedMatchingClasses = matchingClassNames.filter(
                    (className) => code.includes(`@${className}`)
                );

                if (!hasDirectMatch && referencedMatchingClasses.length === 0) {
                    return null;
                }

                const lineMatches = this.findOpenTypeFeatureMatchLines(
                    code,
                    searchTerms,
                    referencedMatchingClasses
                );

                return {
                    tag,
                    index,
                    lineMatches,
                    tagOnlyMatch: lineMatches.length === 0 && hasDirectMatch
                };
            })
            .filter(
                (
                    value
                ): value is {
                    tag: string;
                    index: number;
                    lineMatches: Array<{ lineNumber: number; line: string }>;
                    tagOnlyMatch: boolean;
                } => value !== null
            );

        const lines: string[] = [
            `Search query: ${query}`,
            `Parsed search terms: ${searchTerms.join(', ')}`,
            '',
            '## Matching classes',
            ...(matchingClasses.length > 0
                ? matchingClasses.map(({ className, matchingGlyphs }) =>
                      matchingGlyphs.length > 0
                          ? `- @${className} (matching glyphs: ${matchingGlyphs.join(', ')})`
                          : `- @${className}`
                  )
                : ['- (none)']),
            '',
            '## Matching features',
            ...(matchingFeatures.length > 0
                ? matchingFeatures.flatMap((feature) => {
                      const featureLines = [
                          `- ${feature.tag} # index ${feature.index}`
                      ];

                      if (feature.lineMatches.length > 0) {
                          featureLines.push(
                              ...feature.lineMatches.map(
                                  ({ lineNumber, line }) =>
                                      `  - line ${lineNumber}: ${line || '(blank line)'}`
                              )
                          );
                      } else if (feature.tagOnlyMatch) {
                          featureLines.push(
                              '  - tag/code-level match, but no individual code line matched directly'
                          );
                      }

                      return featureLines;
                  })
                : ['- (none)'])
        ];

        return lines.join('\n');
    }

    getFontFeatureSourceOrder(): string[] {
        const font = (window as any).currentFontModel;
        if (!font?.features?.features) {
            return [];
        }

        return font.features.features
            .map(([tag]: [string, unknown]) => tag)
            .filter((tag: string): tag is string => typeof tag === 'string');
    }

    extractFontLanguageSystems(): string[] {
        const font = (window as any).currentFontModel;
        if (!font?.features) {
            return ['DFLT'];
        }

        const scripts = new Set<string>();
        scripts.add('DFLT');

        const allCode: string[] = [];

        if (font.features.prefixes) {
            Object.values(font.features.prefixes).forEach((prefix: any) => {
                if (prefix?.code) {
                    allCode.push(prefix.code);
                }
            });
        }

        if (font.features.features) {
            font.features.features.forEach(([, codeData]: [string, any]) => {
                if (codeData?.code) {
                    allCode.push(codeData.code);
                }
            });
        }

        const languageSystemRegex = /languagesystem\s+(\w+)\s+\w+/gi;
        allCode.forEach((code) => {
            let match: RegExpExecArray | null;
            while ((match = languageSystemRegex.exec(code)) !== null) {
                scripts.add(match[1]);
            }
        });

        return Array.from(scripts).sort();
    }

    getShapersInUse(): Map<string, string[]> {
        const supportedScripts = this.extractFontLanguageSystems();
        const shaperMap = new Map<string, string[]>();

        supportedScripts.forEach((script) => {
            const shaper = SCRIPT_TO_SHAPER[script] || 'default';
            if (!shaperMap.has(shaper)) {
                shaperMap.set(shaper, []);
            }
            shaperMap.get(shaper)!.push(script);
        });

        return new Map(
            Array.from(shaperMap.entries()).sort(([left], [right]) =>
                left.localeCompare(right)
            )
        );
    }

    categorizeFeaturesForShaper(
        features: Array<[string, any]>,
        executionOrder: string[]
    ): {
        usedByShaper: Array<{ tag: string; index: number }>;
        discretionary: Array<{ tag: string; index: number }>;
        postUserFeatures: Array<{ tag: string; index: number }>;
        notUsedByShaper: Array<{ tag: string; index: number }>;
    } {
        const userFeaturesIndex = executionOrder.indexOf(
            '--- USER FEATURES ---'
        );

        let preUserFeatures: string[] = [];
        let postUserFeaturesList: string[] = [];

        if (userFeaturesIndex >= 0) {
            preUserFeatures = executionOrder
                .slice(0, userFeaturesIndex)
                .filter((feature) => !feature.startsWith('---'));
            postUserFeaturesList = executionOrder
                .slice(userFeaturesIndex + 1)
                .filter((feature) => !feature.startsWith('---'));
        } else {
            preUserFeatures = executionOrder.filter(
                (feature) => !feature.startsWith('---')
            );
        }

        const preUserFeaturesSet = new Set(preUserFeatures);
        const postUserFeaturesSet = new Set(postUserFeaturesList);

        const usedByShaper: Array<{ tag: string; index: number }> = [];
        const discretionary: Array<{ tag: string; index: number }> = [];
        const postUserFeatures: Array<{ tag: string; index: number }> = [];
        const notUsedByShaper: Array<{ tag: string; index: number }> = [];

        features.forEach(([tag], index) => {
            if (isDiscretionary(tag)) {
                discretionary.push({ tag, index });
                return;
            }

            if (preUserFeaturesSet.has(tag)) {
                usedByShaper.push({ tag, index });
                return;
            }

            if (postUserFeaturesSet.has(tag)) {
                postUserFeatures.push({ tag, index });
                return;
            }

            notUsedByShaper.push({ tag, index });
        });

        usedByShaper.sort(
            (left, right) =>
                preUserFeatures.indexOf(left.tag) -
                preUserFeatures.indexOf(right.tag)
        );
        discretionary.sort((left, right) => left.index - right.index);
        postUserFeatures.sort(
            (left, right) =>
                postUserFeaturesList.indexOf(left.tag) -
                postUserFeaturesList.indexOf(right.tag)
        );
        notUsedByShaper.sort((left, right) =>
            left.tag.localeCompare(right.tag)
        );

        return {
            usedByShaper,
            discretionary,
            postUserFeatures,
            notUsedByShaper
        };
    }

    formatFeatureSection(
        title: string,
        features: Array<{ tag: string; index: number }>
    ): string[] {
        return [
            `### ${title}`,
            ...(features.length > 0
                ? features.map(
                      (feature) => `- ${feature.tag} # index ${feature.index}`
                  )
                : ['- (empty)']),
            ''
        ];
    }

    getFontOpenTypeInfo(): string {
        const font = (window as any).currentFontModel;
        if (!font) {
            throw new Error('No font is currently open.');
        }

        const features: Array<[string, any]> = font.features?.features || [];
        const sourceOrder = this.getFontFeatureSourceOrder();
        const shapersInUse = this.getShapersInUse();

        const lines: string[] = [
            'OpenType shaping order depends on the script-specific HarfBuzz shaper used for the current script, not on the raw order in which features are defined in the font.',
            '',
            'Other shaping engines besides HarfBuzz exist and may handle feature execution differently. Counterpunch is explicitly based on HarfBuzz, so the shaper ordering described here is HarfBuzz-specific and matches Counterpunch.',
            '',
            'The feature order below is the explicit source order as defined in the font. This is not the order in which shaping executes those features.',
            '',
            'One feature may be defined several times in the font under the same tag but with different instructions each. The shaper will execute these in the order they are defined in the font, which is why some features may appear several times in the shaper-specific sections below.',
            '',
            'The indices shown here and in the shaper-specific sections refer to the feature array as defined in the font.',
            'Since one feature may be defined several times in a font under the same tag, it is best to retrieve a feature by its index in Python code instead of looping over the feature names. Example: `font.features.features[3]` instead of searching for a feature with a specific tag, since multiple features may have the same tag.',
            '',
            '## Feature order as defined in the font',
            ...(sourceOrder.length > 0
                ? sourceOrder.map((tag, index) => `${index}. ${tag}`)
                : ['(empty)']),
            '',
            'For each shaper in use below, the output is split into up to four sections exactly like the features editor sidebar in the UI:',
            '- `Used by X shaper`: required features that this HarfBuzz shaper uses before the user-features split, ordered by the shaper. These features are not accessible in typesetting applications as user-controllable features but are controlled by the shaper based on the language of the text inferred either explicitly or implicitly.',
            '- `Discretionary (sortable)`: user-controllable features, ordered by the user-defined source sorting in the font editor. Typesetting applications typically only allow activating these discretionary features, so these are the only features that can be user-controlled in those applications. The discretionary section is sorted by the user-defined source order in the font, and also executed by the shaper in this order. Reordering these features can change the shaping outcome, so their order is critical. If glyph substitutions are not reachable, the discretionary feature order could be a culprit.',
            '- `Used by X shaper, continued`: required features that this HarfBuzz shaper uses after the user-features split, ordered by the shaper. These features are not accessible in typesetting applications as user-controllable features but are controlled by the shaper based on the language of the text inferred either explicitly or implicitly.',
            '- `Inactive for X shaper`: features present in the font but unused by that shaper, listed as the inactive remainder for that shaper.',
            ''
        ];

        if (shapersInUse.size === 0) {
            lines.push('No shapers are currently in use for this font.');
            return lines.join('\n');
        }

        for (const [shaper, scripts] of shapersInUse.entries()) {
            const shaperDisplayName =
                shaper.charAt(0).toUpperCase() + shaper.slice(1);
            const categorized = this.categorizeFeaturesForShaper(
                features,
                getFeatureExecutionOrder(shaper)
            );

            lines.push(`## ${shaperDisplayName} shaper`);
            lines.push(
                `Scripts in use for this shaper: ${scripts.join(', ') || '(none)'}`
            );
            lines.push('');
            lines.push(
                ...this.formatFeatureSection(
                    `Used by ${shaperDisplayName} shaper`,
                    categorized.usedByShaper
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    'Discretionary (sortable)',
                    categorized.discretionary
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    `Used by ${shaperDisplayName} shaper, continued`,
                    categorized.postUserFeatures
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    `Inactive for ${shaperDisplayName} shaper`,
                    categorized.notUsedByShaper
                )
            );
        }

        return lines.join('\n');
    }

    createHeaderToolCallsElement(toolCalls: any[]): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'min-width:260px;max-width:420px;padding:4px;color:var(--text-primary);';

        const title = document.createElement('div');
        title.textContent = 'Tool calls';
        title.style.cssText =
            'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary);';
        wrapper.appendChild(title);

        if (toolCalls.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No tool calls recorded.';
            empty.style.cssText = 'font-size:11px;color:var(--text-tertiary);';
            wrapper.appendChild(empty);
            return wrapper;
        }

        for (const call of toolCalls) {
            const row = document.createElement('div');
            row.style.cssText =
                'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--border-primary);';

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:6px;';

            const name = document.createElement('span');
            name.textContent = call.name;
            name.style.cssText =
                'font-size:11px;font-family:var(--font-families-mono);color:var(--text-primary);';
            left.appendChild(name);

            if (this.toolCallHasNoArguments(call.args)) {
                const infoBtn = document.createElement('button');
                infoBtn.className = 'assistant-tool-call-info-btn';
                infoBtn.textContent = 'ⓘ';
                infoBtn.title = 'Show tool output';
                this.attachPopup(
                    infoBtn,
                    () =>
                        this.createToolCallOutputElement(
                            call.name,
                            call.result,
                            call.timeLabel
                        ),
                    'right',
                    520
                );
                left.appendChild(infoBtn);
            }

            const meta = document.createElement('span');
            meta.textContent = this.toolCallHasNoArguments(call.args)
                ? 'no arguments'
                : `${Object.keys(call.args || {}).length} args`;
            meta.style.cssText =
                'font-size:10px;color:var(--text-tertiary);white-space:nowrap;';

            row.appendChild(left);
            row.appendChild(meta);
            wrapper.appendChild(row);
        }

        return wrapper;
    }

    ensureHeaderToolCallsButton(header: HTMLElement, toolCalls: any[]) {
        let button = header.querySelector(
            '.assistant-message-info-btn'
        ) as HTMLButtonElement | null;

        if (!button) {
            button = document.createElement('button');
            button.className =
                'assistant-tool-call-info-btn assistant-message-info-btn';
            button.textContent = 'ⓘ';
            button.title = 'Show tool calls';
            button.style.marginLeft = '2px';
            header.appendChild(button);
            this.attachPopup(
                button,
                () => this.createHeaderToolCallsElement(toolCalls),
                'bottom-end',
                440
            );
        }

        button.style.display = toolCalls.length > 0 ? 'inline-flex' : 'none';
    }

    addMessage(role: 'user' | 'assistant' | 'error', content: string) {
        if (!this.messagesContainer) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = `assistant-message assistant-message-${role}`;
        msgDiv.style.whiteSpace = 'pre-wrap';
        const header = document.createElement('div');
        header.className = 'assistant-message-header';
        if (role === 'user') {
            header.innerHTML =
                '<span class="material-symbols-outlined">person</span> You';
            msgDiv.appendChild(header);
            msgDiv.appendChild(document.createTextNode(content));
        } else if (role === 'assistant') {
            const shell = this.createAssistantMessageShell();
            shell.body.innerHTML =
                typeof marked !== 'undefined'
                    ? rewriteHtmlAnchorsForDocs(marked.parse(content))
                    : this.escapeHtml(content);
            this.messagesContainer.appendChild(shell.messageDiv);
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;
            return;
        } else {
            header.innerHTML =
                '<span class="material-symbols-outlined">error</span> Error';
            msgDiv.appendChild(header);
            msgDiv.appendChild(document.createTextNode(content));
        }
        this.messagesContainer.appendChild(msgDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    private requireAssistantEditPermission(): void {
        if (!this.activePromptContext?.allowFontEdits) {
            throw new Error(
                'Enable editing in the Assistant title bar before changing Python code.'
            );
        }
    }

    private isManagedPythonPath(path: string): boolean {
        return (
            path.endsWith('.py') &&
            (path.startsWith(`${SETTINGS_FOLDER_PATHS.scripts}/`) ||
                path.startsWith(`${SETTINGS_FOLDER_PATHS.filters}/`))
        );
    }

    private getPythonDocumentKind(
        path: string
    ): 'general-script' | 'glyph-filter' {
        return path.startsWith(`${SETTINGS_FOLDER_PATHS.filters}/`)
            ? 'glyph-filter'
            : 'general-script';
    }

    private async getPythonSettingsFolderAdapter(): Promise<{
        hasDirectory?: () => boolean;
        initialize?: () => Promise<boolean | void>;
        fileExists?: (path: string) => Promise<boolean>;
        listFilesRecursive?: (
            path: string,
            depth: number
        ) => Promise<Array<{ path: string }>>;
        readFile: (path: string) => Promise<string | Uint8Array>;
    }> {
        const adapter = settingsFolder.getAdapter();
        await settingsFolder.initialize();
        if (!settingsFolder.hasFolder()) {
            throw new Error(
                'Choose a Settings Folder before reading Python files.'
            );
        }
        return adapter;
    }

    private async listManagedPythonFiles(
        collection: string = 'both'
    ): Promise<
        Array<{ path: string; kind: 'general-script' | 'glyph-filter' }>
    > {
        const adapter = await this.getPythonSettingsFolderAdapter();
        if (!adapter.listFilesRecursive) {
            throw new Error('Settings Folder cannot list Python files.');
        }
        const roots =
            collection === 'scripts'
                ? [SETTINGS_FOLDER_PATHS.scripts]
                : collection === 'filters'
                  ? [SETTINGS_FOLDER_PATHS.filters]
                  : [
                        SETTINGS_FOLDER_PATHS.scripts,
                        SETTINGS_FOLDER_PATHS.filters
                    ];
        const files: Array<{
            path: string;
            kind: 'general-script' | 'glyph-filter';
        }> = [];
        for (const root of roots) {
            if (adapter.fileExists && !(await adapter.fileExists(root))) {
                continue;
            }
            const entries = await adapter.listFilesRecursive(root, 3);
            entries
                .filter((entry) => entry.path.endsWith('.py'))
                .forEach((entry) =>
                    files.push({
                        path: entry.path,
                        kind: this.getPythonDocumentKind(entry.path)
                    })
                );
        }
        return files.sort((first, second) =>
            first.path.localeCompare(second.path)
        );
    }

    private formatPythonLines(
        content: string,
        startLine: number,
        endLine: number
    ): string {
        return content
            .split(/\r?\n/)
            .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
            .map((line, index) => `${startLine + index}: ${line}`)
            .join('\n');
    }

    private validatePythonSyntax(content: string): PythonSyntaxCheck {
        const pyodide = (window as any).pyodide;
        const runPython = pyodide?._originalRunPython || pyodide?.runPython;
        const globals = pyodide?.globals;
        if (
            !pyodide ||
            typeof runPython !== 'function' ||
            !globals ||
            typeof globals.set !== 'function'
        ) {
            return {
                checked: false,
                valid: false,
                message:
                    'Python syntax validation is not available yet. Wait for Pyodide to finish loading and validate again.'
            };
        }
        const sourceKey = '__counterpunch_assistant_python_validation_source';
        globals.set(sourceKey, content);
        try {
            const rawResult = runPython.call(
                pyodide,
                `import json

def __counterpunch_assistant_validate_syntax(source):
    try:
        compile(source, "<script-editor>", "exec")
    except SyntaxError as exc:
        return json.dumps({
            "valid": False,
            "message": exc.msg,
            "line": exc.lineno,
            "offset": exc.offset,
            "text": (exc.text or "").rstrip("\\n")
        })
    return json.dumps({"valid": True, "message": "Python syntax is valid."})

__counterpunch_assistant_validate_syntax(${sourceKey})`
            );
            const parsed = JSON.parse(String(rawResult || '{}'));
            return {
                checked: true,
                valid: parsed.valid === true,
                message:
                    typeof parsed.message === 'string'
                        ? parsed.message
                        : parsed.valid === true
                          ? 'Python syntax is valid.'
                          : 'Python syntax is invalid.',
                line: typeof parsed.line === 'number' ? parsed.line : undefined,
                offset:
                    typeof parsed.offset === 'number'
                        ? parsed.offset
                        : undefined,
                text: typeof parsed.text === 'string' ? parsed.text : undefined
            };
        } catch (error: any) {
            return {
                checked: false,
                valid: false,
                message:
                    error?.message ||
                    'Python syntax validation failed before parsing completed.'
            };
        } finally {
            if (typeof globals.delete === 'function') {
                globals.delete(sourceKey);
            }
        }
    }

    private createPythonDiff(oldText: string, newText: string): string {
        const limit = 12;
        const oldLines = oldText.split(/\r?\n/).slice(0, limit);
        const newLines = newText.split(/\r?\n/).slice(0, limit);
        const truncated =
            oldText.split(/\r?\n/).length > limit ||
            newText.split(/\r?\n/).length > limit;
        return [
            '@@ Script Editor @@',
            ...oldLines.map((line) => `-${line}`),
            ...newLines.map((line) => `+${line}`),
            ...(truncated ? ['… diff truncated'] : [])
        ].join('\n');
    }

    async executeToolCall(toolCall: any): Promise<string> {
        const { name, arguments: argsStr } = toolCall.function;
        const args = JSON.parse(argsStr || '{}');
        switch (name) {
            case 'handbook_toc': {
                const manifestText = await this.fetchText(
                    '/handbook/manifest.json'
                );
                const manifest = JSON.parse(manifestText) as {
                    nodes: HandbookManifestNode[];
                };
                return formatHandbookToc(manifest.nodes);
            }
            case 'handbook_topic': {
                const topic = args.topic;
                if (!topic)
                    throw new Error('Missing required parameter: topic');
                const clean = normalizeHandbookTopic(String(topic));
                let path = clean.endsWith('.md') ? clean : null;
                if (!path) {
                    const manifestText = await this.fetchText(
                        '/handbook/manifest.json'
                    );
                    const manifest = JSON.parse(manifestText) as {
                        nodes: HandbookManifestNode[];
                    };
                    path = findHandbookPath(manifest.nodes, clean);
                }
                if (!path || !path.endsWith('.md'))
                    throw new Error('Only .md files can be accessed');
                return await this.fetchText(`/handbook/${path}`);
            }
            case 'python_api_docs': {
                let res = await fetch('/API.md').catch(() => null);
                if (!res || !res.ok)
                    res = await fetch(
                        `${this.getWebsiteURL()}/data/api-docs.md`
                    );
                if (!res.ok) throw new Error('API documentation not found');
                return await res.text();
            }
            case 'python_authoring_guide': {
                const guides: Record<string, string> = {
                    'general-script':
                        '/handbook/python/04-writing-general-scripts.md',
                    'glyph-filter':
                        '/handbook/python/05-writing-glyph-overview-filters.md'
                };
                const guidePath = guides[args.kind];
                if (!guidePath) {
                    throw new Error(
                        'Choose general-script or glyph-filter for the Python authoring guide.'
                    );
                }
                return await this.fetchText(guidePath);
            }
            case 'glyph_filter_event_types':
                return `${JSON.stringify(getGlyphFilterEventAssistantView(), null, 2)}

Write only the simple filter contract. Subscribe EVENT_TYPES only to glyph-content events that can change the classification. Do not subscribe to glyph.created, glyph.deleted, glyph.renamed, or font.masters.changed: the app handles those itself.

Example single-file filter:

\`\`\`python
EVENT_TYPES = ["glyph.unicode.changed"]

def classify_glyph(glyph):
    return not glyph.codepoints
\`\`\``;
            case 'list_available_fonts': {
                const pluginRegistry = (window as any).pluginRegistry;
                if (!pluginRegistry) return 'Plugin registry not available.';

                const plugins = pluginRegistry.getAll() || [];
                const results: string[] = [];
                const messages: string[] = [];
                const fontExtensions = [
                    '.babelfont',
                    '.glyphs',
                    '.vfj',
                    '.sfd',
                    '.designspace'
                ];

                for (const plugin of plugins) {
                    const pluginId = plugin.getId();
                    const pluginName = plugin.getName?.() || pluginId;
                    const adapter = plugin.getAdapter();
                    if (!adapter) continue;

                    // Check plugin readiness with contextual messages
                    if (pluginId === 'disk') {
                        const hasDir =
                            typeof adapter.hasDirectory === 'function' &&
                            adapter.hasDirectory();
                        if (!hasDir) {
                            messages.push(
                                `⚠️ **${pluginName}**: No folder linked yet. Open the file browser and select a folder to enable disk access.`
                            );
                            continue;
                        }
                        const perm =
                            typeof adapter.checkPermission === 'function'
                                ? await adapter.checkPermission()
                                : 'granted';
                        if (perm !== 'granted') {
                            messages.push(
                                `⚠️ **${pluginName}**: Folder access expired. Re-enable access in the file browser to continue.`
                            );
                            continue;
                        }
                    }

                    const scanPath = plugin.getDefaultPath?.() || '/';

                    try {
                        const files = await adapter.scanDirectory(scanPath);
                        let found = 0;
                        for (const [name, info] of Object.entries(files)) {
                            const fileInfo = info as {
                                is_dir: boolean;
                                path: string;
                            };
                            const filePath = fileInfo.path || `/${name}`;
                            const lowerName = name.toLowerCase();
                            if (fileInfo.is_dir) {
                                if (
                                    lowerName.endsWith('.glyphspackage') ||
                                    lowerName.endsWith('.ufo')
                                ) {
                                    results.push(
                                        `${name} — ${pluginId}:///${filePath.replace(/^\//, '')}`
                                    );
                                    found++;
                                }
                                continue;
                            }
                            if (
                                fontExtensions.some((ext) =>
                                    lowerName.endsWith(ext)
                                )
                            ) {
                                results.push(
                                    `${name} — ${pluginId}:///${filePath.replace(/^\//, '')}`
                                );
                                found++;
                            }
                        }
                        if (found === 0) {
                            messages.push(
                                `📂 **${pluginName}**: No font files found.`
                            );
                        }
                    } catch {
                        messages.push(
                            `⚠️ **${pluginName}**: Could not scan — plugin may need setup.`
                        );
                    }
                }

                const output: string[] = [];
                if (results.length > 0) {
                    output.push('**Available fonts (name — URL):**');
                    output.push('');
                    output.push(...results);
                    output.push('');
                }
                if (messages.length > 0) {
                    output.push(...messages);
                }
                return output.length > 0
                    ? output.join('\n')
                    : 'No fonts found in any available storage plugin.';
            }
            case 'open_font': {
                const url = args.url;
                if (!url) throw new Error('Missing required parameter: url');

                const parsed = (window as any).parseFileUri?.(url);
                if (!parsed)
                    throw new Error(
                        `Invalid font URL: "${url}". Expected format: pluginId:///path (e.g. memory:///user/Fustat.glyphs)`
                    );

                const plugin = (window as any).pluginRegistry?.get?.(
                    parsed.pluginId
                );
                if (!plugin)
                    throw new Error(
                        `Plugin "${parsed.pluginId}" not found. Available: ${
                            ((window as any).pluginRegistry?.getAll?.() || [])
                                .map((p: any) => p.getId())
                                .join(', ') || 'none'
                        }`
                    );

                try {
                    // Check file exists before attempting to open
                    const adapter = plugin.getAdapter();
                    if (adapter && typeof adapter.fileExists === 'function') {
                        const exists = await adapter.fileExists(parsed.path);
                        if (!exists) {
                            throw new Error(
                                `File not found: ${parsed.path} (from ${url})`
                            );
                        }
                    }
                    await (window as any).openFont?.(parsed.path, undefined, {
                        sourcePluginOverride: plugin
                    });
                } catch (err: any) {
                    throw new Error(`Failed to open font: ${err.message}`);
                }

                return `Font opened successfully: ${url}`;
            }
            case 'current_font': {
                const fm = (window as any).fontManager;
                const currentFont = fm?.currentFont;
                if (!currentFont) return 'No font is currently open.';
                const pluginId = currentFont.sourcePlugin?.getId?.();
                const path = currentFont.path || '';
                const url = pluginId
                    ? `${pluginId}:///${path.replace(/^\//, '')}`
                    : path;
                return `${currentFont.name} — ${url}`;
            }
            case 'execute_python_code': {
                const code = args.code;
                if (!code) throw new Error('Missing required parameter: code');

                const pyodide = (window as any).pyodide;
                if (!pyodide)
                    throw new Error(
                        'Python environment not loaded yet. Please wait and try again.'
                    );

                // Stdout setup and cleanup are implementation details, not
                // user-authored Python edits. Running them through the wrapper
                // would take extra model snapshots and could re-emit the user
                // script's synthetic change set into the prompt transaction.
                if (typeof pyodide._originalRunPythonAsync !== 'function') {
                    throw new Error(
                        'Python execution wrapper is not ready yet. Please wait and try again.'
                    );
                }
                if (!window.__counterpunchPythonPostExecutionHookInstalled) {
                    throw new Error(
                        'Python edit lifecycle is not ready yet. Please wait and try again.'
                    );
                }
                if (!window.patchSyncEngine) {
                    throw new Error(
                        'Python edit bridge is not ready yet. Please wait and try again.'
                    );
                }
                const runInternalPythonAsync =
                    pyodide._originalRunPythonAsync.bind(pyodide);

                const promptContext = this.activePromptContext ?? {
                    id: `assistant-manual-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    allowFontEdits: this.allowFontEdits,
                    historySummary: 'Manual Assistant tool call'
                };
                return await runAssistantPythonExecution(
                    promptContext,
                    async () => {
                        let output = '';
                        try {
                            // Stdout is shared Pyodide process state, so it must
                            // be configured inside the serialized execution.
                            await runInternalPythonAsync(`
import sys
from io import StringIO
_assistant_output_buffer = StringIO()
_assistant_original_stdout = sys.stdout
sys.stdout = _assistant_output_buffer
                            `);
                            await pyodide.runPythonAsync(code);
                            await awaitActiveAssistantPythonExecutionSettled();
                            output = await runInternalPythonAsync(`
output = _assistant_output_buffer.getvalue()
sys.stdout = _assistant_original_stdout
del _assistant_output_buffer
del _assistant_original_stdout
output
                    `);
                        } catch (err: any) {
                            const execution =
                                getActiveAssistantPythonExecution();
                            await awaitActiveAssistantPythonExecutionSettled();
                            // Restore stdout on error
                            try {
                                await runInternalPythonAsync(`
if '_assistant_original_stdout' in dir():
    sys.stdout = _assistant_original_stdout
                        `);
                            } catch (cleanupError) {
                                console.warn(
                                    'Could not restore assistant Python stdout after an execution error',
                                    cleanupError
                                );
                            }
                            const pythonError =
                                window.sanitizePythonRuntimeError(
                                    err?.message
                                        ? String(err.message)
                                        : String(err)
                                );
                            if (execution?.commitState === 'partial') {
                                return JSON.stringify({
                                    error: `Python error: ${pythonError}`,
                                    changesCommitted: true,
                                    state: 'partial'
                                });
                            }
                            throw new Error(`Python error: ${pythonError}`);
                        }

                        return output || '(no output)';
                    }
                );
            }
            case 'get_active_python_document': {
                const state = window.scriptEditor.getDocumentState();
                const kindInfo = getPythonDocumentKindInfo(state);
                const includeContent = args.include_content !== false;
                const maxChars = Math.max(0, Number(args.max_chars) || 12000);
                this.lastKnownScriptRevision = state.revision;
                this.scriptStateInvalidated = false;
                return JSON.stringify({
                    ...state,
                    kind: kindInfo.kind,
                    editorKind: kindInfo.editorKind,
                    kindConfidence: kindInfo.confidence,
                    kindMessage: kindInfo.message,
                    content: includeContent
                        ? state.content.slice(0, maxChars)
                        : undefined,
                    truncated: includeContent && state.content.length > maxChars
                });
            }
            case 'list_python_files': {
                return JSON.stringify({
                    files: await this.listManagedPythonFiles(
                        String(args.collection || 'both')
                    )
                });
            }
            case 'search_python_files': {
                const query = String(args.query || '')
                    .trim()
                    .toLowerCase();
                if (!query) throw new Error('Search query is empty.');

                const adapter = await this.getPythonSettingsFolderAdapter();
                const files = await this.listManagedPythonFiles(
                    String(args.collection || 'both')
                );
                const matches: Array<{
                    path: string;
                    kind: 'general-script' | 'glyph-filter';
                    lines: string[];
                }> = [];
                for (const file of files) {
                    const data = await adapter.readFile(file.path);
                    const content =
                        typeof data === 'string'
                            ? data
                            : new TextDecoder().decode(data);
                    const lines = content
                        .split(/\r?\n/)
                        .map((line, index) => ({ line, index }))
                        .filter(({ line }) =>
                            line.toLowerCase().includes(query)
                        )
                        .slice(0, 3)
                        .map(
                            ({ line, index }) => `${index + 1}: ${line.trim()}`
                        );
                    if (
                        file.path.toLowerCase().includes(query) ||
                        lines.length > 0
                    ) {
                        matches.push({
                            path: file.path,
                            kind: file.kind,
                            lines
                        });
                    }
                }
                return JSON.stringify({ matches: matches.slice(0, 30) });
            }
            case 'read_python_file': {
                const path = String(args.path || '');
                if (!this.isManagedPythonPath(path)) {
                    throw new Error(
                        `Python files must be under ${SETTINGS_FOLDER_PATHS.scripts} or ${SETTINGS_FOLDER_PATHS.filters}.`
                    );
                }
                const active = window.scriptEditor.getDocumentState();
                const adapter = await this.getPythonSettingsFolderAdapter();
                const data =
                    active.path === path
                        ? active.content
                        : await adapter.readFile(path);
                const content =
                    typeof data === 'string'
                        ? data
                        : new TextDecoder().decode(data);
                const lines = content.split(/\r?\n/);
                const startLine = Math.max(1, Number(args.start_line) || 1);
                const endLine = Math.min(
                    lines.length,
                    Math.max(
                        startLine,
                        Number(args.end_line) || startLine + 199
                    )
                );
                return JSON.stringify({
                    path,
                    kind: this.getPythonDocumentKind(path),
                    revision: active.path === path ? active.revision : null,
                    content: this.formatPythonLines(
                        content,
                        startLine,
                        endLine
                    ),
                    truncated: endLine < lines.length
                });
            }
            case 'open_python_document_in_editor': {
                const path = String(args.path || '');
                if (!this.isManagedPythonPath(path)) {
                    throw new Error(
                        `Python files must be under ${SETTINGS_FOLDER_PATHS.scripts} or ${SETTINGS_FOLDER_PATHS.filters}.`
                    );
                }
                const opened = await window.scriptEditor.openFile(
                    path,
                    'settings'
                );
                if (!opened) throw new Error(`Could not open ${path}.`);
                return JSON.stringify(window.scriptEditor.getDocumentState());
            }
            case 'create_python_draft_in_editor': {
                this.requireAssistantEditPermission();
                const kind = args.kind;
                if (kind !== 'general-script' && kind !== 'glyph-filter') {
                    throw new Error(
                        'Draft kind must be general-script or glyph-filter.'
                    );
                }
                window.scriptEditor.createDraft(kind, args.content);
                const state = window.scriptEditor.getDocumentState();
                this.lastKnownScriptRevision = state.revision;
                this.scriptStateInvalidated = false;
                return JSON.stringify(state);
            }
            case 'replace_python_text_in_editor': {
                this.requireAssistantEditPermission();
                const oldText = String(args.old_text || '');
                const newText = String(args.new_text || '');
                if (!oldText) throw new Error('old_text is required.');
                const state = window.scriptEditor.replaceExactText(
                    oldText,
                    newText,
                    String(args.expected_revision || '')
                );
                this.lastKnownScriptRevision = state.revision;
                this.scriptStateInvalidated = false;
                return [
                    `Edited ${state.path || 'untitled Python draft'} (${state.kind})`,
                    `Revision: ${state.revision}`,
                    'Modified, not saved',
                    '',
                    this.createPythonDiff(oldText, newText)
                ].join('\n');
            }
            case 'validate_python_document': {
                const state = window.scriptEditor.getDocumentState();
                const kindInfo = getPythonDocumentKindInfo(state);
                const syntax = this.validatePythonSyntax(state.content || '');
                const hasFilterFunction =
                    /^\s*def\s+classify_glyph\s*\(\s*glyph\s*\)\s*:/m.test(
                        state.content
                    );
                const hasEventTypes = /^\s*EVENT_TYPES\s*=/m.test(
                    state.content
                );
                const structureValid =
                    kindInfo.editorKind !== 'glyph-filter' ||
                    (hasEventTypes && hasFilterFunction);
                const messages: string[] = [];
                if (!syntax.valid) {
                    const location = syntax.line
                        ? ` on line ${syntax.line}${
                              syntax.offset ? `, column ${syntax.offset}` : ''
                          }`
                        : '';
                    messages.push(
                        syntax.checked
                            ? `Python syntax error${location}: ${syntax.message}`
                            : syntax.message
                    );
                }
                if (kindInfo.editorKind === 'glyph-filter') {
                    if (!hasEventTypes) {
                        messages.push('Glyph filters must define EVENT_TYPES.');
                    }
                    if (!hasFilterFunction) {
                        messages.push(
                            'Glyph filters must define classify_glyph(glyph).'
                        );
                    }
                }
                if (kindInfo.confidence !== 'saved-path') {
                    messages.push(kindInfo.message);
                }
                return JSON.stringify({
                    kind: kindInfo.kind,
                    editorKind: kindInfo.editorKind,
                    kindConfidence: kindInfo.confidence,
                    kindMessage: kindInfo.message,
                    revision: state.revision,
                    valid: syntax.valid && structureValid,
                    syntaxChecked: syntax.checked,
                    syntaxValid: syntax.valid,
                    syntaxError: syntax.valid
                        ? null
                        : {
                              message: syntax.message,
                              line: syntax.line,
                              offset: syntax.offset,
                              text: syntax.text
                          },
                    structureValid,
                    message:
                        messages.length > 0
                            ? messages.join(' ')
                            : 'Python syntax and static structure are valid. Python was not run.'
                });
            }
            case 'get_editor_state': {
                const sm = (window as any).stateManager;
                const fm = (window as any).fontManager;
                if (!sm) throw new Error('State manager not available');

                const snapshot = sm.getStateSnapshot();
                const s = snapshot.state;

                // Build feature list with descriptions from all font-defined features
                const allFeatureTags = new Set<string>();
                const featuresIn = s.editor_opentype_features_in_subset || {};
                const featuresOut =
                    s.editor_opentype_features_not_in_subset || {};
                for (const tag of Object.keys(featuresIn))
                    allFeatureTags.add(tag);
                for (const tag of Object.keys(featuresOut))
                    allFeatureTags.add(tag);

                const features = [...allFeatureTags].sort().map((tag) => {
                    const availableToActivate = tag in featuresIn;
                    const enabledPreference = availableToActivate
                        ? featuresIn[tag] === true
                        : featuresOut[tag] === true;
                    const active =
                        availableToActivate && enabledPreference === true;
                    return {
                        tag,
                        description: getFeatureDescription(tag) || tag,
                        active,
                        enabled: enabledPreference,
                        availableToActivate,
                        // Kept for compatibility with earlier tool consumers.
                        inSubset: availableToActivate,
                        status: availableToActivate
                            ? active
                                ? 'Active now in the current editing subset.'
                                : 'Available to activate now in the current editing subset.'
                            : 'Exists in the font, but greyed out in the sidebar because the current editing subset cannot reach it yet.',
                        note: availableToActivate
                            ? active
                                ? 'This feature is on and affecting the current text.'
                                : 'Turn this on with set_editor_opentype_features when you want its effect.'
                            : 'The feature is real; it is just not reachable under the current text buffer and active feature set. Explain that to the user, then recommend enabling it with set_editor_opentype_features when its effect is wanted.'
                    };
                });

                const featureStateByTag = Object.fromEntries(
                    features.map((feature) => [feature.tag, feature.active])
                );

                const userspaceLocationRaw =
                    s.editor_variation_location &&
                    typeof s.editor_variation_location === 'object'
                        ? s.editor_variation_location
                        : {};
                const userspaceLocation = Object.fromEntries(
                    Object.entries(userspaceLocationRaw).filter(
                        ([, value]) =>
                            typeof value === 'number' && Number.isFinite(value)
                    )
                ) as Record<string, number>;

                const axes = fm?.currentFontModel?.axes || [];
                const designspaceLocation = userspaceToDesignspace(
                    userspaceLocation as any,
                    axes
                );
                const textBufferRaw = String(s.editor_text_buffer || '');
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                const textRunStateMatches =
                    textRunEditor?.textBuffer === textBufferRaw;
                // The state snapshot is authoritative; only reuse parsed UI state
                // when it was derived from the same raw buffer.
                const textBufferDisplay =
                    textRunStateMatches &&
                    typeof textRunEditor.displayTextBuffer === 'string'
                        ? textRunEditor.displayTextBuffer
                        : textBufferRaw.replace(/\/\//g, '/');
                const explicitGlyphTokens = textRunStateMatches
                    ? textRunEditor.explicitGlyphTokens.map(
                          ({
                              name,
                              start,
                              end
                          }: {
                              name: string;
                              start: number;
                              end: number;
                          }) => ({ name, start, end })
                      )
                    : [];
                const liveGlyphNameBuffer = textRunStateMatches
                    ? textRunEditor.glyphNameBuffer
                    : null;
                const liveGlyphBuffer = textRunStateMatches
                    ? textRunEditor.shapedGlyphs
                    : null;
                const hasLiveShapingState =
                    Array.isArray(liveGlyphNameBuffer) &&
                    Array.isArray(liveGlyphBuffer);
                const liveCursorPosition =
                    textRunStateMatches &&
                    typeof textRunEditor.cursorPosition === 'number' &&
                    Number.isFinite(textRunEditor.cursorPosition)
                        ? textRunEditor.cursorPosition
                        : null;
                const snapshotCursor = Number(s.editor_cursor_position);
                const cursorPosition =
                    liveCursorPosition ??
                    (Number.isFinite(snapshotCursor) ? snapshotCursor : 0);
                const glyphCanvas = (window as any).glyphCanvas;
                const outlineEditor = glyphCanvas?.outlineEditor;
                const outlineGlyphName =
                    typeof outlineEditor?.currentGlyphName === 'string'
                        ? outlineEditor.currentGlyphName
                        : '';
                const namedOutlineGlyph =
                    outlineGlyphName && outlineGlyphName !== 'undefined'
                        ? outlineGlyphName
                        : null;
                const getterGlyphName =
                    typeof glyphCanvas?.getCurrentGlyphName === 'function'
                        ? glyphCanvas.getCurrentGlyphName()
                        : null;
                const namedGetterGlyph =
                    typeof getterGlyphName === 'string' &&
                    getterGlyphName &&
                    getterGlyphName !== 'undefined'
                        ? getterGlyphName
                        : null;
                const activeGlyphName =
                    outlineEditor?.active === true && namedOutlineGlyph
                        ? namedOutlineGlyph
                        : namedGetterGlyph;
                const glyphs = hasLiveShapingState
                    ? liveGlyphNameBuffer.join(' ')
                    : s.editor_harfbuzz_glyph_names || '';
                const gids = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { g?: number }) =>
                          String(glyph.g ?? '')
                      )
                    : s.editor_harfbuzz_gids || '';
                const advances = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { ax?: number }) =>
                          String(glyph.ax ?? '')
                      )
                    : s.editor_harfbuzz_ax || '';
                const clusters = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { cl?: number }) =>
                          String(glyph.cl ?? '')
                      )
                    : s.editor_harfbuzz_cl || '';

                return JSON.stringify(
                    {
                        textBuffer: textBufferRaw,
                        textBufferRaw,
                        textBufferDisplay,
                        textBufferInterpretationIsCurrent: textRunStateMatches,
                        explicitGlyphTokens,
                        textBufferSyntax:
                            'Raw syntax: // is one literal slash; /glyphname is an explicit glyph reference only when it resolves. Never infer // unless textBufferRaw contains it.',
                        activeGlyphName,
                        cursorPosition,
                        glyphs,
                        gids: Array.isArray(gids) ? gids.join(' ') : gids,
                        advances: Array.isArray(advances)
                            ? advances.join(' ')
                            : advances,
                        clusters: Array.isArray(clusters)
                            ? clusters.join(' ')
                            : clusters,
                        shapingStateSource: hasLiveShapingState
                            ? 'live-text-run'
                            : 'state-manager',
                        userspaceLocation,
                        designspaceLocation,
                        opentypeFeaturesExplanation:
                            'Every feature listed below exists in the font. availableToActivate true means it is reachable in the current editing subset (from the current text buffer and active feature set) and can be turned on/off immediately. availableToActivate false means the sidebar shows it greyed out: the feature still exists, but the current subset cannot reach it yet. When that happens, explain the situation clearly and recommend enabling the feature with set_editor_opentype_features if its effect is wanted. active is true only when the feature is both reachable and currently on. enabled is the on/off preference even when the feature is not currently reachable.',
                        featureStateByTag,
                        features,
                        file: s.editor_file || ''
                    },
                    null,
                    2
                );
            }
            case 'set_prompt_history_summary': {
                const summary = String(args.summary || '').trim();
                if (!summary) {
                    throw new Error('Missing required parameter: summary');
                }
                if (!this.activePromptContext) {
                    throw new Error('No assistant prompt is currently running');
                }
                this.activePromptContext.historySummary = summary;
                return 'Prompt history summary will be used for subsequent edits.';
            }
            case 'get_font_opentype_info': {
                return this.getFontOpenTypeInfo();
            }
            case 'search_font_opentype_classes_and_features': {
                const query = args.query;
                if (query == null) {
                    throw new Error('Missing required parameter: query');
                }

                return this.searchFontOpenTypeClassesAndFeatures(String(query));
            }
            case 'set_editor_text_buffer': {
                const text = args.text;
                if (text == null)
                    throw new Error('Missing required parameter: text');

                const gcSet = (window as any).glyphCanvas;
                if (!gcSet?.textRunEditor)
                    throw new Error('Editor not available');

                gcSet.textRunEditor.setTextBuffer(String(text));
                return `Text buffer set to: ${text}`;
            }
            case 'set_editor_opentype_features': {
                const featureTags: string[] = args.features || [];
                const gcSet2 = (window as any).glyphCanvas;
                if (!gcSet2?.featuresManager)
                    throw new Error('Editor not available');

                const fm2 = gcSet2.featuresManager;
                await fm2.setEnabledFeatures(featureTags);

                const activeFeatures = Object.entries(fm2.featureSettings)
                    .filter(([, enabled]) => enabled)
                    .map(([tag]) => tag);

                return `Features updated. Active: ${activeFeatures.length > 0 ? activeFeatures.join(', ') : '(none)'}`;
            }
            case 'binary_font_api_docs':
                this.binaryFontApiDocsViewed = true;
                return BINARY_FONT_API_DOCS;
            case 'describe_binary_font': {
                const path =
                    typeof args.path === 'string' && args.path.trim()
                        ? args.path.trim()
                        : undefined;
                return JSON.stringify(getBinaryFontSurfaceDescription(path));
            }
            case 'list_binary_font_children': {
                assertBinaryFontMainWindow('list_binary_font_children');
                const runtime = getBinaryFontRuntime();
                const analysisCompiler = runtime.fullFontCompilation;
                if (!analysisCompiler || !analysisCompiler.sendMessage) {
                    throw new Error(
                        'list_binary_font_children analysis compiler is not available yet.'
                    );
                }

                const fontHash = String(args.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'Missing required parameter: fontHash. Call compile_binary_font first.'
                    );
                }
                const path = String(args.path || '').trim();
                if (!path) {
                    throw new Error(
                        'Missing required parameter: path (string).'
                    );
                }
                if (
                    args.fontIndex !== undefined &&
                    (!Number.isInteger(args.fontIndex) || args.fontIndex < 0)
                ) {
                    throw new Error(
                        'fontIndex must be a non-negative integer when provided.'
                    );
                }
                if (
                    args.limit !== undefined &&
                    (!Number.isInteger(args.limit) || args.limit < 0)
                ) {
                    throw new Error(
                        'limit must be a non-negative integer when provided.'
                    );
                }

                const result = await fetchBinaryFontChildren(
                    analysisCompiler,
                    fontHash,
                    path,
                    args.fontIndex ?? 0,
                    args.limit
                );
                return JSON.stringify(result);
            }
            case 'search_binary_font_surface': {
                const query = String(args.query || '').trim();
                if (!query) {
                    throw new Error('Missing required parameter: query.');
                }

                const path =
                    typeof args.path === 'string' && args.path.trim()
                        ? args.path.trim()
                        : undefined;

                return JSON.stringify({
                    query,
                    path: path || null,
                    matches: searchBinaryFontSurface(query, path)
                });
            }
            case 'search_binary_font_children': {
                assertBinaryFontMainWindow('search_binary_font_children');

                const query = String(args.query || '').trim();
                if (!query) {
                    throw new Error('Missing required parameter: query.');
                }

                const fontHash = String(args.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'Missing required parameter: fontHash. Call compile_binary_font first.'
                    );
                }

                const path =
                    typeof args.path === 'string' && args.path.trim()
                        ? args.path.trim()
                        : typeof args.withinPath === 'string' &&
                            args.withinPath.trim()
                          ? args.withinPath.trim()
                          : '';
                if (!path) {
                    throw new Error(
                        'Missing required parameter: path (string).'
                    );
                }
                if (
                    args.fontIndex !== undefined &&
                    (!Number.isInteger(args.fontIndex) || args.fontIndex < 0)
                ) {
                    throw new Error(
                        'fontIndex must be a non-negative integer when provided.'
                    );
                }
                if (
                    args.limit !== undefined &&
                    (!Number.isInteger(args.limit) || args.limit < 0)
                ) {
                    throw new Error(
                        'limit must be a non-negative integer when provided.'
                    );
                }

                const runtime = getBinaryFontRuntime();
                const analysisCompiler = runtime.fullFontCompilation;
                if (!analysisCompiler || !analysisCompiler.sendMessage) {
                    throw new Error(
                        'search_binary_font_children analysis compiler is not available yet.'
                    );
                }
                if (runtime.fontCompilation === analysisCompiler) {
                    throw new Error(
                        'search_binary_font_children requires a separate analysis compiler.'
                    );
                }

                const result = await searchBinaryFontChildren(
                    analysisCompiler,
                    fontHash,
                    path,
                    query,
                    args.fontIndex ?? 0,
                    args.limit ?? 64
                );
                return JSON.stringify(result);
            }
            case 'search_binary_font': {
                const query = String(args.query || '').trim();
                if (!query) {
                    throw new Error('Missing required parameter: query.');
                }

                const surfaceMatches = searchBinaryFontSurface(
                    query,
                    typeof args.path === 'string' && args.path.trim()
                        ? args.path.trim()
                        : undefined
                );

                const fontHash =
                    typeof args.fontHash === 'string'
                        ? String(args.fontHash).trim()
                        : '';
                const withinPath =
                    typeof args.withinPath === 'string' &&
                    args.withinPath.trim()
                        ? args.withinPath.trim()
                        : '';
                const matches = [...surfaceMatches];
                if (fontHash && withinPath) {
                    assertBinaryFontMainWindow('search_binary_font');
                    const runtime = getBinaryFontRuntime();
                    const analysisCompiler = runtime.fullFontCompilation;
                    if (!analysisCompiler || !analysisCompiler.sendMessage) {
                        throw new Error(
                            'search_binary_font analysis compiler is not available yet.'
                        );
                    }
                    const listed = await fetchBinaryFontChildren(
                        analysisCompiler,
                        fontHash,
                        withinPath,
                        typeof args.fontIndex === 'number' ? args.fontIndex : 0,
                        typeof args.limit === 'number' ? args.limit : 64
                    );
                    const childMatches = listed.children
                        .filter((child) => {
                            const haystack =
                                JSON.stringify(child).toLowerCase();
                            return haystack.includes(query.toLowerCase());
                        })
                        .map((child) => ({
                            kind: child.kind,
                            path: child.path,
                            label: child.label,
                            value: child.value
                        }));
                    matches.push(...childMatches);
                }

                return JSON.stringify({
                    query,
                    fontHash: fontHash || null,
                    withinPath: withinPath || null,
                    matches
                });
            }
            case 'snapshot_binary_font': {
                assertBinaryFontMainWindow('snapshot_binary_font');
                const runtime = getBinaryFontRuntime();
                const analysisCompiler = runtime.fullFontCompilation;
                if (
                    !analysisCompiler ||
                    !analysisCompiler.sendMessage ||
                    typeof analysisCompiler.inspectDebugCachedFont !==
                        'function'
                ) {
                    throw new Error(
                        'snapshot_binary_font analysis compiler is not available yet.'
                    );
                }
                const fontHash = String(args.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'Missing required parameter: fontHash. Call compile_binary_font first.'
                    );
                }
                const profile = String(args.profile || 'summary').trim();
                if (
                    args.fontIndex !== undefined &&
                    (!Number.isInteger(args.fontIndex) || args.fontIndex < 0)
                ) {
                    throw new Error(
                        'fontIndex must be a non-negative integer when provided.'
                    );
                }

                return await buildBinaryFontSnapshot(
                    analysisCompiler,
                    fontHash,
                    profile,
                    args.fontIndex ?? 0
                );
            }
            case 'compile_binary_font': {
                const runtime = getBinaryFontRuntime();
                const fontManager = runtime.fontManager;
                const editingCompiler = runtime.fontCompilation;
                const analysisCompiler = runtime.fullFontCompilation;
                if (!fontManager || !editingCompiler || !analysisCompiler) {
                    throw new Error(
                        'compile_binary_font dependencies are not available yet.'
                    );
                }
                if (editingCompiler === analysisCompiler) {
                    throw new Error(
                        'compile_binary_font requires a separate analysis compiler.'
                    );
                }
                assertBinaryFontMainWindow('compile_binary_font');

                const target = args.target ?? 'full';
                if (
                    target !== 'full' &&
                    target !== 'subset' &&
                    target !== 'editing'
                ) {
                    throw new Error(
                        'target must be either "full" or "subset".'
                    );
                }
                const subsetTarget =
                    target === 'subset' || target === 'editing';
                if (subsetTarget && typeof args.text !== 'string') {
                    throw new Error('target "subset" requires text (string).');
                }
                const getFontRevision = () => {
                    const currentFont = fontManager.currentFont;
                    return {
                        pluginId: currentFont?.sourcePlugin?.getId?.() || '',
                        fontPath: currentFont?.path || '',
                        changeVersion:
                            typeof currentFont?.changeVersion === 'number'
                                ? currentFont.changeVersion
                                : null
                    };
                };
                await prepareBinaryFontAnalysisWorker(
                    fontManager,
                    editingCompiler,
                    analysisCompiler,
                    () => JSON.stringify(getFontRevision())
                );

                if (subsetTarget) {
                    if (
                        typeof fontManager.deriveSubsetGlyphsFromText !==
                        'function'
                    ) {
                        throw new Error(
                            'compile_binary_font subset target requires layout-closure support.'
                        );
                    }
                    if (
                        typeof analysisCompiler.compileCommittedDebugFont !==
                        'function'
                    ) {
                        throw new Error(
                            'compile_binary_font subset target is not available in the analysis compiler.'
                        );
                    }
                    const subsetGlyphs = fontManager.deriveSubsetGlyphsFromText(
                        args.text
                    );
                    if (!subsetGlyphs.length) {
                        throw new Error(
                            'target "subset" requires text that resolves to at least one glyph.'
                        );
                    }
                    const result =
                        await analysisCompiler.compileCommittedDebugFont(
                            subsetGlyphs,
                            'assistant-binary-font.ttf',
                            'editing'
                        );
                    const fontHash = String(result.fontHash || '').trim();
                    if (!fontHash) {
                        throw new Error(
                            'compile_binary_font returned an empty font hash.'
                        );
                    }
                    return fontHash;
                }

                if (typeof analysisCompiler.compileBinaryFont !== 'function') {
                    throw new Error(
                        'compile_binary_font is not available in the analysis compiler.'
                    );
                }
                const result = await analysisCompiler.compileBinaryFont(
                    'full',
                    'assistant-binary-font.ttf',
                    getBinaryFontAnalysisWorkerState(analysisCompiler)
                );
                const fontHash = String(result.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'compile_binary_font returned an empty font hash.'
                    );
                }
                return fontHash;
            }
            case 'shape_binary_font': {
                const fontHash = String(args.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'Missing required parameter: fontHash. Call compile_binary_font first.'
                    );
                }
                if (typeof args.text !== 'string') {
                    throw new Error(
                        'Missing required parameter: text (string).'
                    );
                }
                if (
                    args.features !== undefined &&
                    (typeof args.features !== 'object' ||
                        args.features === null ||
                        Array.isArray(args.features))
                ) {
                    throw new Error(
                        'features must be an object when provided.'
                    );
                }
                if (
                    args.variationLocation !== undefined &&
                    (typeof args.variationLocation !== 'object' ||
                        args.variationLocation === null ||
                        Array.isArray(args.variationLocation))
                ) {
                    throw new Error(
                        'variationLocation must be an object when provided.'
                    );
                }

                const runtime = getBinaryFontRuntime();
                const analysisCompiler = runtime.fullFontCompilation;
                const shapeWithFontDetailed = runtime.shapeTextWithFontDetailed;
                if (
                    !analysisCompiler ||
                    typeof analysisCompiler.getDebugCachedFontBytes !==
                        'function' ||
                    !shapeWithFontDetailed
                ) {
                    throw new Error(
                        'shape_binary_font dependencies are not available yet.'
                    );
                }
                if (runtime.fontCompilation === analysisCompiler) {
                    throw new Error(
                        'shape_binary_font requires a separate analysis compiler.'
                    );
                }
                assertBinaryFontMainWindow('shape_binary_font');

                const variationLocation = Object.fromEntries(
                    Object.entries(
                        (args.variationLocation || {}) as Record<
                            string,
                            unknown
                        >
                    ).filter(
                        ([, value]) =>
                            typeof value === 'number' && Number.isFinite(value)
                    )
                ) as Record<string, number>;
                const fontBytes =
                    await analysisCompiler.getDebugCachedFontBytes(fontHash);
                const shaped = await shapeWithFontDetailed(
                    fontBytes,
                    args.text,
                    {
                        features: args.features,
                        variationLocation
                    }
                );
                return JSON.stringify({
                    fontHash,
                    text: args.text,
                    ...shaped
                });
            }
            case 'inspect_binary_font': {
                assertBinaryFontMainWindow('inspect_binary_font');
                if (!this.binaryFontApiDocsViewed) {
                    throw new Error(
                        'Call binary_font_api_docs before inspect_binary_font.'
                    );
                }
                const fontHash = String(args.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error(
                        'Missing required parameter: fontHash. Call compile_binary_font first.'
                    );
                }
                if (!Array.isArray(args.paths)) {
                    throw new Error(
                        'Missing required parameter: paths (array of strings).'
                    );
                }
                if (
                    args.fontIndex !== undefined &&
                    (!Number.isInteger(args.fontIndex) || args.fontIndex < 0)
                ) {
                    throw new Error(
                        'fontIndex must be a non-negative integer when provided.'
                    );
                }
                if (
                    args.paths.some((path: unknown) => typeof path !== 'string')
                ) {
                    throw new Error('Every inspection path must be a string.');
                }

                const runtime = getBinaryFontRuntime();
                const analysisCompiler = runtime.fullFontCompilation;
                if (
                    !analysisCompiler ||
                    typeof analysisCompiler.inspectDebugCachedFont !==
                        'function'
                ) {
                    throw new Error(
                        'inspect_binary_font analysis compiler is not available yet.'
                    );
                }
                if (runtime.fontCompilation === analysisCompiler) {
                    throw new Error(
                        'inspect_binary_font requires a separate analysis compiler.'
                    );
                }

                const result = await analysisCompiler.inspectDebugCachedFont(
                    fontHash,
                    {
                        fontIndex: args.fontIndex,
                        paths: args.paths
                    }
                );
                return JSON.stringify(result);
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    async fetchText(url: string): Promise<string> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Not found (HTTP ${res.status})`);
        return await res.text();
    }

    // ── Single streaming round ──

    async streamRound(
        messages: any[],
        onChunk: (text: string) => void,
        billingRunId: string,
        signal?: AbortSignal,
        previousGenerationIds?: string[]
    ): Promise<any> {
        const sessionToken = window.authManager?.getSessionToken();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

        const body: Record<string, any> = {
            messages,
            tools: ASSISTANT_TOOLS,
            systemPrompt: await this.getRuntimeSystemPrompt(),
            stream: true,
            billingRunId
        };
        if (previousGenerationIds && previousGenerationIds.length > 0) {
            body.previousGenerationIds = previousGenerationIds;
        }

        let response: Response;
        try {
            response = await fetch(`${this.getWebsiteURL()}/api/ai/assistant`, {
                method: 'POST',
                credentials: 'include',
                headers,
                signal,
                body: JSON.stringify(body)
            });
        } catch (err: any) {
            // Re-throw AbortError so the caller's stop-button handler works
            if (err.name === 'AbortError') throw err;
            return {
                text: '',
                toolCalls: null,
                done: false,
                connectionDropped: true,
                dropError: err.message || 'Network request failed'
            };
        }

        if (!response.ok) {
            const errBody = await response
                .json()
                .catch(() => ({ error: 'Request failed' }));
            throw new Error(errBody.error || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');

        const decoder = new TextDecoder();
        let buf = '';
        let streamedText = '';
        let toolCalls: any[] | null = null;
        let generationId: string | null = null;

        while (true) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch (err: any) {
                // Re-throw AbortError so the caller's stop-button handler works
                if (err.name === 'AbortError') throw err;
                // Connection dropped mid-stream — return partial text
                // so the caller can rehydrate and continue
                return {
                    text: streamedText,
                    toolCalls,
                    done: false,
                    connectionDropped: true,
                    dropError: err.message || 'Connection lost',
                    generationId
                };
            }
            const { done, value } = readResult;
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                try {
                    const parsed = JSON.parse(data);
                    // Capture OpenRouter generationId from every event
                    if (parsed.generationId) {
                        generationId = parsed.generationId;
                    }
                    if (parsed.type === 'chunk' && parsed.content) {
                        streamedText += parsed.content;
                        onChunk(parsed.content);
                    } else if (
                        parsed.type === 'tool_call' &&
                        parsed.tool_calls
                    ) {
                        toolCalls = parsed.tool_calls;
                    } else if (parsed.type === 'done') {
                        return {
                            text: streamedText,
                            toolCalls,
                            usage: parsed.usage,
                            generationId: generationId || parsed.generationId,
                            cumulativeUsage: parsed.cumulativeUsage,
                            done: true
                        };
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error || 'Stream error');
                    }
                } catch {
                    /* skip unparseable */
                }
            }
        }
        return { text: streamedText, toolCalls, done: false, generationId };
    }

    // ── Main entry: streaming multi-round loop ──

    async sendPrompt() {
        if (
            !this.promptInput ||
            !this.messagesContainer ||
            this.isStreaming ||
            this.promptInput.disabled
        )
            return;
        const prompt = this.promptInput.value.trim();
        if (!prompt) return;

        this.promptInput.value = '';
        this.promptInput.style.height = 'auto';
        this.isStreaming = true;
        this.activePromptContext = {
            id: `assistant-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            allowFontEdits: this.allowFontEdits,
            historySummary: DEFAULT_PROMPT_HISTORY_SUMMARY
        };
        this.promptTransactionOpen = false;
        this.promptInterrupted = false;
        this.updateAssistantEditToggle();
        if (this.sendButton)
            (this.sendButton as HTMLButtonElement).disabled = true;
        this.showStreamIndicator();

        this.addMessage('user', prompt);
        const conversationMessages: any[] = [
            ...this.conversationMessages,
            { role: 'user', content: prompt }
        ];
        this.showInitialStatus();

        const abortController = new AbortController();
        this.abortController = abortController;
        const signal = abortController.signal;
        let roundTexts: string[] = [];
        const billingRunId = `assistant-billing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Track generationIds across retry legs for cumulative cost reporting
        const previousGenerationIds: string[] = [];

        try {
            let messageDiv: HTMLDivElement | null = null;
            let bodyDiv: HTMLDivElement | null = null;
            let headerDiv: HTMLDivElement | null = null;
            let currentRoundIndex = -1;
            const executedToolCalls: any[] = [];

            const ensureMessageShell = () => {
                if (!messageDiv) {
                    const shell = this.createAssistantMessageShell();
                    messageDiv = shell.messageDiv;
                    headerDiv = shell.header;
                    bodyDiv = shell.body;
                    this.messagesContainer!.appendChild(messageDiv);
                }
            };

            while (true) {
                currentRoundIndex++;
                const result = await this.streamRound(
                    conversationMessages,
                    (chunk) => {
                        this.clearInitialStatus();
                        ensureMessageShell();

                        // Append/render to the LAST round-text container in bodyDiv
                        roundTexts[currentRoundIndex] =
                            (roundTexts[currentRoundIndex] || '') + chunk;
                        const bd = bodyDiv as HTMLDivElement;
                        let textContainer = bd.querySelector(
                            '.assistant-round-text:last-child'
                        ) as HTMLDivElement | null;
                        if (!textContainer) {
                            textContainer = document.createElement('div');
                            textContainer.className = 'assistant-round-text';
                            bd.appendChild(textContainer);
                        }
                        if (typeof marked !== 'undefined') {
                            textContainer.innerHTML = rewriteHtmlAnchorsForDocs(
                                marked.parse(roundTexts[currentRoundIndex])
                            );
                        } else {
                            textContainer.textContent =
                                roundTexts[currentRoundIndex];
                        }
                        this.scrollToBottomIfNear();
                    },
                    billingRunId,
                    signal,
                    previousGenerationIds.length > 0
                        ? [...previousGenerationIds]
                        : undefined
                );

                // Successful round — reset reconnect counter and clear
                // previous generation IDs (their cost has now been captured
                // in cumulativeUsage or they're no longer relevant)
                this._reconnectAttempts = 0;

                // ── Track usage for this round ──
                // On retry legs, the backend returns cumulativeUsage which
                // is the total across ALL prior dropped legs + current leg.
                // We compute the delta (dropped legs = cumulative - current)
                // and accumulate that separately, then accumulate the current
                // leg normally. This avoids double-counting while capturing
                // the costs of legs whose SSE never completed.
                const roundUsage = result.usage;
                if (result.cumulativeUsage && roundUsage) {
                    const droppedPrompt =
                        (result.cumulativeUsage.prompt_tokens || 0) -
                        (roundUsage.prompt_tokens || 0);
                    const droppedCompletion =
                        (result.cumulativeUsage.completion_tokens || 0) -
                        (roundUsage.completion_tokens || 0);
                    const droppedCost =
                        (result.cumulativeUsage.total_cost || 0) -
                        (roundUsage.total_cost || 0);
                    if (droppedPrompt > 0 || droppedCompletion > 0) {
                        this.accumulateSessionTotals({
                            prompt_tokens: droppedPrompt,
                            completion_tokens: droppedCompletion,
                            total_tokens: droppedPrompt + droppedCompletion,
                            cached_tokens:
                                (result.cumulativeUsage.cached_tokens || 0) -
                                (roundUsage.cached_tokens || 0),
                            total_cost: droppedCost
                        });
                    }
                    this.accumulateSessionTotals(roundUsage);
                    // Clear previous gen IDs — their costs are now captured
                    // in sessionTotals via the delta above
                    previousGenerationIds.length = 0;
                } else if (roundUsage) {
                    this.accumulateSessionTotals(roundUsage);
                }

                // ── Render per-round metrics (dev mode only) ──
                const isDev = window.isDevelopment?.() ?? false;
                if (isDev && bodyDiv) {
                    const bd = bodyDiv as HTMLDivElement;
                    const metricsStr = this.formatUsageMetrics(roundUsage);
                    if (metricsStr) {
                        const roundTextEl = bd.querySelector(
                            '.assistant-round-text:last-child'
                        ) as HTMLElement | null;
                        if (roundTextEl) {
                            const metricsEl = document.createElement('div');
                            metricsEl.className = 'assistant-round-metrics';
                            metricsEl.textContent = metricsStr;
                            roundTextEl.insertAdjacentElement(
                                'afterend',
                                metricsEl
                            );
                        }
                    }
                }

                this.updateSessionMetricsBar();

                // ── Connection dropped mid-stream — auto-retry in-place ──
                if (result.connectionDropped) {
                    const partialText =
                        roundTexts.filter(Boolean).join(' ').trim() ||
                        result.text ||
                        '';
                    if (partialText) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: partialText
                        });
                        this.conversationMessages = conversationMessages;
                    }
                    // Save the generationId from the dropped leg so the retry
                    // request includes it — the backend will query OpenRouter's
                    // generation API to include its usage in cumulativeUsage
                    if (result.generationId) {
                        previousGenerationIds.push(result.generationId);
                    }
                    if (!this._reconnectAttempts) this._reconnectAttempts = 0;
                    this._reconnectAttempts++;
                    if (this._reconnectAttempts <= 3) {
                        const reconnMsg = document.createElement('div');
                        reconnMsg.className = 'assistant-connection-dropped';
                        reconnMsg.textContent = `🔄 Reconnecting... (attempt ${this._reconnectAttempts}/3)`;
                        const appendTarget: HTMLElement | null =
                            bodyDiv || this.messagesContainer;
                        if (appendTarget) appendTarget.appendChild(reconnMsg);
                        // Back off: 500ms, 1s, 1.5s
                        await new Promise((r) =>
                            setTimeout(r, 500 * this._reconnectAttempts)
                        );
                        // Remove the notice before retry.
                        reconnMsg.remove();
                        // Retry the same round into the same shell;
                        // conversationMessages now ends with the partial
                        // model response, so the model picks up from
                        // where it left off
                        currentRoundIndex--; // undo the increment
                        continue;
                    }
                    // Max retries exhausted — give up
                    const exhaustedMsg = document.createElement('div');
                    exhaustedMsg.className = 'assistant-connection-dropped';
                    exhaustedMsg.textContent =
                        '⚠️ Connection lost after 3 retries. Type "continue" to resume.';
                    const appendTarget: HTMLElement | null =
                        bodyDiv || this.messagesContainer;
                    if (appendTarget) appendTarget.appendChild(exhaustedMsg);
                    this.hideStreamIndicator();
                    this.isStreaming = false;
                    this.finishPromptTransaction();
                    this.activePromptContext = null;
                    this.updateAssistantEditToggle();
                    if (this.sendButton)
                        (this.sendButton as HTMLButtonElement).disabled = false;
                    if (this.promptInput) this.promptInput.focus();
                    this.scrollToBottomIfNear();
                    return;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Ensure the assistant message container exists even when the model
                    // responds with only a tool call and no preamble text
                    ensureMessageShell();

                    conversationMessages.push({
                        role: 'assistant',
                        content: result.text || null,
                        tool_calls: result.toolCalls
                    });

                    for (const toolCall of result.toolCalls) {
                        let args;
                        try {
                            args = JSON.parse(
                                toolCall.function.arguments || '{}'
                            );
                        } catch {
                            args = {};
                        }

                        let toolResult: string;
                        let resultLen = 0;

                        // Add tool-call line directly into bodyDiv — between rounds,
                        // so it appears chronologically between Round 1 text and Round 2 text
                        if (bodyDiv) {
                            const line = document.createElement('div');
                            line.className = 'assistant-tool-call-line';
                            line.textContent = `📖 Calling ${toolCall.function.name}`;

                            const infoBtn = document.createElement('button');
                            infoBtn.className = 'assistant-tool-call-info-btn';
                            infoBtn.textContent = 'ⓘ';
                            line.appendChild(infoBtn);

                            try {
                                toolResult =
                                    await this.executeToolCall(toolCall);
                                resultLen = toolResult.length;
                            } catch (err: any) {
                                toolResult = `Error: ${err.message}`;
                            }

                            const timeLabel = new Date().toLocaleTimeString();

                            this.attachPopup(
                                infoBtn,
                                () =>
                                    this.createToolCallMetaElement(
                                        toolCall.function.name,
                                        args,
                                        toolResult,
                                        timeLabel
                                    ),
                                'right',
                                520
                            );

                            executedToolCalls.push({
                                name: toolCall.function.name,
                                args,
                                result: toolResult,
                                timeLabel
                            });
                            if (headerDiv) {
                                this.ensureHeaderToolCallsButton(
                                    headerDiv,
                                    executedToolCalls
                                );
                            }

                            (bodyDiv as HTMLDivElement).appendChild(line);
                            if (
                                toolCall.function.name ===
                                    'replace_python_text_in_editor' &&
                                !toolResult.startsWith('Error:')
                            ) {
                                (bodyDiv as HTMLDivElement).appendChild(
                                    this.createInlinePythonEditDiffElement(
                                        toolResult,
                                        args
                                    )
                                );
                            }
                            this.scrollToBottomIfNear();
                        } else {
                            try {
                                toolResult =
                                    await this.executeToolCall(toolCall);
                            } catch (err: any) {
                                toolResult = `Error: ${err.message}`;
                            }
                        }

                        conversationMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResult
                        });
                    }
                    // Continue to next streaming round
                } else {
                    // No more tool calls — final text response
                    const finalText = roundTexts.join(' ') || result.text || '';
                    this.conversationMessages = conversationMessages;
                    conversationMessages.push({
                        role: 'assistant',
                        content: finalText
                    });
                    this.messages.push({
                        role: 'assistant',
                        content: finalText
                    });
                    this.hideStreamIndicator();
                    this.isStreaming = false;
                    this.abortController = null;
                    this.finishPromptTransaction();
                    this.activePromptContext = null;
                    this.updateAssistantEditToggle();
                    if (this.sendButton)
                        (this.sendButton as HTMLButtonElement).disabled = false;
                    if (this.promptInput) this.promptInput.focus();
                    return;
                }
            }
        } catch (err: any) {
            this.clearInitialStatus();
            if (err.name === 'AbortError') {
                // User clicked stop — save whatever text was streamed so the
                // model can pick up from "Continue"
                const partialText = roundTexts.filter(Boolean).join(' ').trim();
                if (partialText) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: partialText
                    });
                    this.conversationMessages = conversationMessages;
                }
            } else {
                this.addMessage('error', err.message || 'Network error');
                console.error('[AIAssistant]', 'Request failed:', err);
            }
        }

        this.hideStreamIndicator();
        this.isStreaming = false;
        this.finishPromptTransaction(this.promptInterrupted);
        this.activePromptContext = null;
        this.updateAssistantEditToggle();
        if (this.sendButton)
            (this.sendButton as HTMLButtonElement).disabled = false;
        if (this.promptInput) this.promptInput.focus();
    }

    private interruptPrompt() {
        if (!this.isStreaming) {
            return;
        }

        this.promptInterrupted = true;
        this.abortController?.abort();
        this.abortController = null;
    }

    private finishPromptTransaction(interrupted: boolean = false) {
        this.promptTransactionOpen = false;
    }

    showInitialStatus() {
        if (!this.messagesContainer) return;
        const el = document.createElement('div');
        el.id = 'assistant-initial-status';
        el.className = 'assistant-tool-call-line';
        el.textContent = '💭 Understanding your question...';
        this.messagesContainer.appendChild(el);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    showStreamIndicator() {
        const el = document.getElementById('assistant-stream-indicator');
        if (el) el.style.display = 'flex';
    }

    hideStreamIndicator() {
        const el = document.getElementById('assistant-stream-indicator');
        if (el) el.style.display = 'none';
    }

    clearInitialStatus() {
        document.getElementById('assistant-initial-status')?.remove();
    }

    scrollToBottomIfNear(threshold = 150) {
        if (!this.messagesContainer) return;
        const dist =
            this.messagesContainer.scrollHeight -
            this.messagesContainer.scrollTop -
            this.messagesContainer.clientHeight;
        if (dist < threshold) {
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;
        }
    }

    escapeHtml(text: string): string {
        const d = document.createElement('div');
        d.appendChild(document.createTextNode(text));
        return d.innerHTML;
    }

    highlightPython(code: string): string {
        const escaped = this.escapeHtml(code);
        let html = escaped;

        // Triple-quoted strings (must come before single-line strings)
        html = html.replace(
            /(&quot;&quot;&quot;[\s\S]*?&quot;&quot;&quot;|&#x27;&#x27;&#x27;[\s\S]*?&#x27;&#x27;&#x27;)/g,
            '<span style="color:var(--accent-orange)">$1</span>'
        );
        // Comments
        html = html.replace(
            /(#[^\n]*)/g,
            '<span style="color:var(--accent-green);font-style:italic">$1</span>'
        );
        // F-strings (before regular strings)
        html = html.replace(
            /(f&quot;[^&]*?&quot;|f&#x27;[^&]*?&#x27;)/g,
            '<span style="color:var(--accent-magenta)">$1</span>'
        );
        // Regular strings
        html = html.replace(
            /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,
            '<span style="color:var(--accent-orange)">$1</span>'
        );
        // Keywords
        html = html.replace(
            /\b(def|class|if|elif|else|for|while|import|from|as|return|yield|try|except|finally|raise|with|pass|break|continue|and|or|not|in|is|lambda|async|await|True|False|None|self|del|global|nonlocal|assert)\b/g,
            '<span style="color:var(--accent-blue);font-weight:bold">$1</span>'
        );
        // Built-in functions
        html = html.replace(
            /\b(print|len|range|int|str|float|list|dict|set|tuple|type|open|map|filter|zip|enumerate|sorted|reversed|abs|min|max|sum|any|all|isinstance|hasattr|getattr|setattr|super|property|staticmethod|classmethod|object|__init__|__str__|__repr__|__len__|__getitem__|__setitem__|__delitem__|__iter__|__next__|__enter__|__exit__)\b/g,
            '<span style="color:var(--accent-cyan)">$1</span>'
        );
        // Numbers
        html = html.replace(
            /\b(\d+\.?\d*)\b/g,
            '<span style="color:var(--accent-magenta)">$1</span>'
        );

        return html;
    }

    // ── Dev-mode usage metrics ──

    formatUsageMetrics(usage: UsageMetrics | null | undefined): string {
        if (!usage) return '';
        const parts: string[] = [];
        if (usage.prompt_tokens != null)
            parts.push(`in: ${usage.prompt_tokens}`);
        if (usage.completion_tokens != null)
            parts.push(`out: ${usage.completion_tokens}`);
        if (usage.cached_tokens != null)
            parts.push(`cached: ${usage.cached_tokens}`);
        if (usage.total_cost != null)
            parts.push(`$${usage.total_cost.toFixed(6)}`);
        else if (usage.cost_eur_cents != null)
            parts.push(`${usage.cost_eur_cents}c`);
        return parts.length > 0 ? parts.join(' · ') : '';
    }

    accumulateSessionTotals(usage: UsageMetrics | null | undefined): void {
        if (!usage) return;
        this.sessionTotals.prompt_tokens =
            (this.sessionTotals.prompt_tokens || 0) +
            (usage.prompt_tokens || 0);
        this.sessionTotals.completion_tokens =
            (this.sessionTotals.completion_tokens || 0) +
            (usage.completion_tokens || 0);
        this.sessionTotals.cached_tokens =
            (this.sessionTotals.cached_tokens || 0) +
            (usage.cached_tokens || 0);
        this.sessionTotals.total_cost =
            (this.sessionTotals.total_cost || 0) + (usage.total_cost || 0);
        this.sessionTotals.cost_eur_cents =
            (this.sessionTotals.cost_eur_cents || 0) +
            (usage.cost_eur_cents || 0);
    }

    updateSessionMetricsBar(): void {
        const bar = document.getElementById('assistant-session-metrics');
        if (!bar) return;
        const isDev = window.isDevelopment?.() ?? false;
        if (!isDev) {
            bar.style.display = 'none';
            bar.textContent = '';
            return;
        }
        const s = this.sessionTotals;
        const hasData =
            s.prompt_tokens != null ||
            s.completion_tokens != null ||
            s.total_cost != null;
        if (!hasData || Object.keys(s).length === 0) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'inline';
        bar.textContent = this.formatUsageMetrics(s);
    }

    newChat() {
        this.interruptPrompt();
        if (this.messagesContainer) this.messagesContainer.innerHTML = '';
        this.messages = [];
        this.conversationMessages = [];
        this.roundUsage = [];
        this.sessionTotals = {};
        this._reconnectAttempts = 0;
        if (this.promptInput) {
            this.promptInput.value = '';
            this.promptInput.style.height = 'auto';
        }
        this.lockAssistantInput(
            !this.isAuthenticated || !this.canUseAssistant()
        );
        this.clearInitialStatus();
        this.hideStreamIndicator();
        this.updateSessionMetricsBar();
        if (this.promptInput && !this.promptInput.disabled) {
            this.promptInput.focus();
        }
    }
}

function initAssistant() {
    const checkReady = () => {
        if (window.authManager) {
            window.aiAssistant = new AIAssistant();
        } else {
            setTimeout(checkReady, 100);
        }
    };
    checkReady();
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initAssistant);
else initAssistant();

export default AIAssistant;
