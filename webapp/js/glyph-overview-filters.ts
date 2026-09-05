// Glyph Overview Filters
// Manages hierarchical filter sidebar with Python plugin-based dynamic filters

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { Logger } from './logger';
import { NativeAdapter } from './file-system-adapter';
import {
    createFolderSetupCallout,
    isSettingsFolderReadySync
} from './folder-permissions-dialog';
import {
    settingsFolder,
    SETTINGS_FOLDER_PATHS,
    SETTINGS_FOLDER_SOURCE_ID
} from './settings-folder';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { createGlyphFilterTemplate } from './glyph-filter-template';
import {
    MANAGED_FILE_CHANGED_EVENT,
    cancelManagedFileInternalWrite,
    extractManagedChangedPaths,
    markManagedFileInternalWrite,
    normalizeManagedPath,
    wereAllBasenamesInternalWrites,
    wereAllManagedPathsInternalWrites
} from './managed-file-events';
import type { ManagedFileChangedDetail } from './managed-file-events';
import {
    isGlyphFilterEventType,
    type GlyphFilterChange,
    type GlyphFilterChangeBatch,
    type GlyphFilterEventType
} from './glyph-filter-events';
import { listOverviewGlyphRecords } from './filesystem-plugins/cloud-glyph-catalog';
import {
    dedupeGlyphFilterChanges,
    deriveGlyphFilterChangesFromCommittedEntry,
    type GlyphFilterLifecycleChange
} from './glyph-filter-change-derivation';
import { getGlyphFilterIds, setGlyphFilterIds } from './window-ui-state';

const console = new Logger('GlyphOverviewFilters');

/**
 * Path registry for filter categories.
 * Keys are path identifiers, values are display names.
 * Plugins must reference these paths to be displayed.
 */
const FILTER_PATHS: Record<string, string> = {
    'basic': 'Basic',
    'basic/glyph_categories': 'Categories',
    'basic/debugging': 'Debugging'
};

/**
 * Filter result from a plugin
 */
export interface FilterResult {
    glyph_name: string;
    group?: string; // Single group keyword
    groups?: string[]; // Array of group keywords (for multi-group support)
    color?: string; // Primary resolved hex color (used for display)
    colors?: string[]; // Array of resolved hex colors for all groups
}

/**
 * Group definition from a plugin
 */
export interface GroupDefinition {
    description: string;
    color: string; // Hex color
}

/**
 * Plugin metadata after discovery
 */
interface GlyphFilterPlugin {
    path: string;
    keyword: string;
    display_name: string;
    instance: any; // Python plugin instance
    eventTypes: GlyphFilterEventType[];
    groups?: Record<string, GroupDefinition>;
    lastResults?: FilterResult[];
    glyphCount?: number;
    hasError?: boolean; // True if last run resulted in an error
    hasNoFilterFunction?: boolean; // True if plugin lacks classify_glyph
    isUserFilter?: boolean; // True if this is a user-defined filter from disk
    filePath?: string; // Path to .py file for user filters
    pythonCode?: string; // Source code for user filters
    validationDiagnostic?: string;
    classifications: Map<string, GlyphClassification>;
    sourceLoaded?: boolean;
    sourceNamespace?: string;
    hasCandidateFunction?: boolean;
    cachedDataVersion?: number;
    cachedContextVersion?: number;
    cachedOpenGeneration?: number;
}

type FilterPyodide = {
    globals: {
        set: (name: string, value: unknown) => void;
    };
    runPython?: (code: string) => unknown;
    _originalRunPython?: (code: string) => unknown;
};

const FILTER_SOURCE_LOAD_USER = [
    'globals()[__glyph_filter_namespace] = {}',
    'exec(__glyph_filter_source, globals()[__glyph_filter_namespace])',
    "if not callable(globals()[__glyph_filter_namespace].get('classify_glyph')):",
    "    raise ValueError('Missing classify_glyph(glyph).')",
    "callable(globals()[__glyph_filter_namespace].get('is_candidate'))"
].join('\n');

const FILTER_SOURCE_LOAD_INSTANCE = [
    "if not callable(getattr(__glyph_filter_instance, 'classify_glyph', None)):",
    "    raise ValueError('Missing classify_glyph(glyph).')",
    "callable(getattr(__glyph_filter_instance, 'is_candidate', None))"
].join('\n');

const FILTER_CLASSIFY_BATCH = [
    'if __glyph_filter_is_user:',
    '    _ns = globals()[__glyph_filter_namespace]',
    "    _classify = _ns.get('classify_glyph')",
    "    _candidate = _ns.get('is_candidate') if __glyph_filter_use_candidate else None",
    'else:',
    "    _classify = getattr(__glyph_filter_instance, 'classify_glyph', None)",
    '    _candidate = (',
    "        getattr(__glyph_filter_instance, 'is_candidate', None)",
    '        if __glyph_filter_use_candidate',
    '        else None',
    '    )',
    '_cp_classify_filter_glyphs(',
    '    __glyph_filter_glyphs,',
    '    _classify,',
    '    _candidate if callable(_candidate) else None,',
    ')'
].join('\n');

interface GlyphClassification {
    groups: Array<{ name: string; color: string }>;
}

interface FilterExecutionResult {
    results: FilterResult[];
    groups: Record<string, GroupDefinition>;
    status: string;
    delta?: { add?: Array<string | FilterResult>; remove?: string[] };
}

/**
 * Tree node for sidebar rendering
 */
interface TreeNode {
    path: string;
    displayName: string;
    children: Map<string, TreeNode>;
    plugins: GlyphFilterPlugin[];
    element?: HTMLElement;
    expanded: boolean;
}

interface RefreshPluginsOptions {
    deferCounts?: boolean;
}

const ALL_GLYPHS_FILTER_KEYWORD = 'com.context.allglyphs';

/** Empty batch requests a host-owned full cache rebuild. */
const FULL_FILTER_REBUILD_BATCH: GlyphFilterChangeBatch = { changes: [] };

export class GlyphOverviewFilterManager {
    private plugins: GlyphFilterPlugin[] = [];
    private userFilters: GlyphFilterPlugin[] = [];
    private loaded: boolean = false;
    private sidebarContainer: HTMLElement | null = null;
    private groupLegendContainer: HTMLElement | null = null;
    private glyphOverview: any = null;
    private activeFilter: GlyphFilterPlugin | null = null;
    private activeGroupFilters: Set<string> = new Set(); // Selected group keywords for filtering (not colors)
    private selectedGlyphGroups: Set<string> = new Set(); // Groups that selected glyphs belong to
    private groupElements: Map<string, HTMLElement> = new Map(); // Map group keyword to legend element
    private rootNode: TreeNode;
    private userFiltersNode: TreeNode;
    private pendingActiveFilters: string[] = [];
    private readonly USER_FILTERS_PATH = SETTINGS_FOLDER_PATHS.filters;
    private readonly FILTER_TIMEOUT_MS = 5000;
    private fileSystemObserver: any = null; // FileSystemObserver instance
    private observerSupported: boolean = 'FileSystemObserver' in window;
    private tippyInstances: TippyInstance[] = []; // Context menu instances
    private refreshRetryTimer: number | null = null;
    private deferredCountRefreshScheduled: boolean = false;
    private pluginRefreshInFlight: boolean = false;
    private openRecountPending: boolean = false;
    private openGeneration: number = 0;
    private filterWorkChain: Promise<void> = Promise.resolve();
    private inFlightCountRequests: number = 0;
    private sharedPluginContext: Record<string, any> = {};
    private sharedPluginContextVersion: number = 1;
    private userFilterScanGeneration: number = 0;
    private pendingUserFilterChangeRecords: unknown[] = [];
    private pendingUserFilterChangePaths: Set<string> = new Set();
    private userFilterChangeFlushScheduled: boolean = false;
    /** True while discoverUserFilters is running for a queued file change. */
    private userFilterChangeFlushInFlight: boolean = false;
    private managedFileChangeListener: EventListener;
    /**
     * Last observed `Glyph.isCompatible` per glyph name. Used so
     * `glyph.compatibility.changed` fires only on an actual boolean toggle,
     * not on every layer edit that might affect outlines.
     */
    private glyphCompatibilityByName: Map<string, boolean> = new Map();

    constructor() {
        this.rootNode = this.buildEmptyTree();
        this.userFiltersNode = this.buildUserFiltersTree();
        this.loadActiveState();
        this.managedFileChangeListener = (event: Event) => {
            const detail = (event as CustomEvent<ManagedFileChangedDetail>)
                .detail;
            if (!detail || detail.pluginId !== SETTINGS_FOLDER_SOURCE_ID) {
                return;
            }

            const paths = extractManagedChangedPaths(detail);
            if (
                paths.length > 0 &&
                !paths.some((path) => this.isUserFilterPath(path))
            ) {
                return;
            }

            this.queueUserFilterFileChangeRefresh({
                paths,
                records: detail.records || []
            });
        };
        window.addEventListener(
            MANAGED_FILE_CHANGED_EVENT,
            this.managedFileChangeListener
        );
        window.addEventListener('fontLoaded', () => {
            this.openGeneration += 1;
            this.openRecountPending = true;
        });
        window.addEventListener(
            'filteredBooleanCompatibilityUpdated',
            (event: Event) => {
                const glyphNames = (
                    event as CustomEvent<{ glyphNames?: string[] }>
                ).detail?.glyphNames;
                if (!Array.isArray(glyphNames) || glyphNames.length === 0) {
                    return;
                }
                void this.enqueueFilterWork(async () => {
                    const changes = this.collectCompatibilityToggleChanges(
                        glyphNames,
                        false
                    );
                    if (!changes.length) {
                        return;
                    }
                    await this.handleCommittedGlyphFilterBatch({
                        changes: dedupeGlyphFilterChanges(changes)
                    });
                });
            }
        );
    }

    private enqueueFilterWork(work: () => Promise<void>): Promise<void> {
        const run = this.filterWorkChain.then(work, work);
        this.filterWorkChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private normalizeFilterPath(path: string): string {
        return normalizeManagedPath(path);
    }

    private isUserFilterPath(path: string): boolean {
        const normalizedPath = this.normalizeFilterPath(path);
        const filtersRoot = this.normalizeFilterPath(this.USER_FILTERS_PATH);
        return (
            normalizedPath === filtersRoot ||
            normalizedPath.startsWith(`${filtersRoot}/`)
        );
    }

    private isPythonFilterPath(path: string): boolean {
        return this.isUserFilterPath(path) && path.endsWith('.py');
    }

    /**
     * Resolve Filters-root FileSystemObserver records to Settings Folder paths
     * such as `/Filters/foo.py` so they can match internal-write markers from
     * Script Editor saves.
     */
    private resolveFilterObserverRecordPaths(records: unknown[]): string[] {
        const filtersRoot = this.normalizeFilterPath(this.USER_FILTERS_PATH);
        const paths = new Set<string>();

        for (const record of records) {
            if (!record || typeof record !== 'object') {
                continue;
            }

            const changedRecord = record as {
                changedHandle?: { name?: string };
                relativePathComponents?: unknown;
                relativePathMovedFrom?: unknown;
            };

            const relativeComponents = changedRecord.relativePathComponents;
            if (
                Array.isArray(relativeComponents) &&
                relativeComponents.length > 0 &&
                relativeComponents.every(
                    (component) => typeof component === 'string'
                )
            ) {
                paths.add(
                    normalizeManagedPath(
                        `${filtersRoot}/${relativeComponents.join('/')}`
                    )
                );
                continue;
            }

            const name = changedRecord.changedHandle?.name;
            if (typeof name === 'string' && name.trim()) {
                paths.add(normalizeManagedPath(`${filtersRoot}/${name}`));
            }

            const movedFrom = changedRecord.relativePathMovedFrom;
            if (
                Array.isArray(movedFrom) &&
                movedFrom.length > 0 &&
                movedFrom.every((component) => typeof component === 'string')
            ) {
                paths.add(
                    normalizeManagedPath(
                        `${filtersRoot}/${movedFrom.join('/')}`
                    )
                );
            }
        }

        return [...paths];
    }

    private queueUserFilterFileChangeRefresh({
        paths = [],
        records = []
    }: {
        paths?: string[];
        records?: unknown[];
    }): void {
        let isRelevant = false;

        for (const path of paths) {
            if (this.isUserFilterPath(path)) {
                isRelevant = true;
                this.pendingUserFilterChangePaths.add(
                    this.normalizeFilterPath(path)
                );
            }
        }

        for (const record of records) {
            if (!record || typeof record !== 'object') {
                continue;
            }

            const changedRecord = record as any;
            const changedName = changedRecord.changedHandle?.name || '';
            if (
                changedName.endsWith('.py') ||
                changedRecord.type === 'appeared' ||
                changedRecord.type === 'disappeared' ||
                changedRecord.type === 'moved'
            ) {
                isRelevant = true;
                this.pendingUserFilterChangeRecords.push(record);
            }
        }

        if (!isRelevant) {
            return;
        }

        // Coalesce: if a flush is already scheduled or running, just keep the
        // pending paths/records. A trailing microtask runs after in-flight work.
        if (this.userFilterChangeFlushScheduled) {
            return;
        }

        this.userFilterChangeFlushScheduled = true;
        if (this.userFilterChangeFlushInFlight) {
            return;
        }

        queueMicrotask(() => {
            void this.flushUserFilterFileChangeRefresh();
        });
    }

    private async flushUserFilterFileChangeRefresh(): Promise<void> {
        this.userFilterChangeFlushScheduled = false;
        this.userFilterChangeFlushInFlight = true;

        try {
            // Collect everything that arrives while we are about to refresh,
            // then rediscover once. Overlapping FSO echoes during discovery
            // should not produce a second sidebar reload.
            const records: unknown[] = [];
            const changedPaths = new Set<string>();

            do {
                records.push(...this.pendingUserFilterChangeRecords.splice(0));
                for (const path of this.pendingUserFilterChangePaths) {
                    changedPaths.add(path);
                }
                this.pendingUserFilterChangePaths.clear();

                // Yield once so any same-turn observer callbacks can enqueue.
                await Promise.resolve();
            } while (
                this.pendingUserFilterChangeRecords.length > 0 ||
                this.pendingUserFilterChangePaths.size > 0
            );

            await this.applyUserFilterFileChangeRefresh(records, [
                ...changedPaths
            ]);
        } finally {
            this.userFilterChangeFlushInFlight = false;
            if (this.userFilterChangeFlushScheduled) {
                this.userFilterChangeFlushScheduled = false;
                if (
                    this.pendingUserFilterChangeRecords.length > 0 ||
                    this.pendingUserFilterChangePaths.size > 0
                ) {
                    this.userFilterChangeFlushScheduled = true;
                    queueMicrotask(() => {
                        void this.flushUserFilterFileChangeRefresh();
                    });
                }
            }
        }
    }

    private async applyUserFilterFileChangeRefresh(
        records: unknown[],
        changedPaths: string[]
    ): Promise<void> {
        if (!records.length && !changedPaths.length) {
            return;
        }

        const movedPy: { oldName: string; newName: string }[] = [];
        const modifiedPy = new Set<string>();

        for (const record of records) {
            if (!record || typeof record !== 'object') {
                continue;
            }

            const changedRecord = record as any;
            const name = changedRecord.changedHandle?.name || '';
            if (!name.endsWith('.py')) {
                continue;
            }

            if (changedRecord.type === 'moved') {
                const oldPath = changedRecord.relativePathMovedFrom;
                if (oldPath && oldPath.length > 0) {
                    movedPy.push({
                        oldName: oldPath[oldPath.length - 1],
                        newName: name
                    });
                }
            } else if (changedRecord.type === 'modified') {
                modifiedPy.add(name.replace(/\.py$/, ''));
            }
        }

        const activeUserFilterKeyword = this.activeFilter?.isUserFilter
            ? this.activeFilter.keyword
            : null;
        const activeUserFilterDisplayName = this.activeFilter?.isUserFilter
            ? this.activeFilter.display_name
            : null;
        const activeUserFilterPath = this.activeFilter?.isUserFilter
            ? this.activeFilter.filePath
            : null;

        let renamedToName: string | null = null;
        if (movedPy.length > 0 && activeUserFilterDisplayName) {
            for (const moved of movedPy) {
                const oldDisplayName = moved.oldName.replace(/\.py$/, '');
                if (activeUserFilterDisplayName === oldDisplayName) {
                    renamedToName = moved.newName.replace(/\.py$/, '');
                    break;
                }
            }
        }

        const activeFilterModifiedByPath =
            !!activeUserFilterPath &&
            changedPaths.some(
                (path) =>
                    this.isPythonFilterPath(path) &&
                    this.normalizeFilterPath(path) ===
                        this.normalizeFilterPath(activeUserFilterPath)
            );
        const activeFilterModifiedByName =
            !!activeUserFilterDisplayName &&
            modifiedPy.has(activeUserFilterDisplayName);
        const activeFilterModified =
            activeFilterModifiedByPath || activeFilterModifiedByName;

        console.log(
            '[GlyphOverviewFilters]',
            'User filter file change detected, refreshing user filters',
            { activeUserFilterKeyword, changedPaths, movedPy }
        );

        await this.discoverUserFilters(true, renamedToName);

        if (
            (renamedToName || activeFilterModified) &&
            this.activeFilter?.isUserFilter
        ) {
            this.invalidatePluginCache(this.activeFilter);
            await this.runFilter(this.activeFilter);
        }
    }

    private isDiskAdapterLike(adapter: unknown): adapter is NativeAdapter {
        if (!adapter || typeof adapter !== 'object') {
            return false;
        }

        const candidate = adapter as {
            hasDirectory?: unknown;
            initialize?: unknown;
            fileExists?: unknown;
            listFilesRecursive?: unknown;
            readFile?: unknown;
        };

        return (
            typeof candidate.hasDirectory === 'function' &&
            typeof candidate.initialize === 'function' &&
            typeof candidate.fileExists === 'function' &&
            typeof candidate.listFilesRecursive === 'function' &&
            typeof candidate.readFile === 'function'
        );
    }

    /**
     * Build empty tree structure from FILTER_PATHS
     */
    private buildEmptyTree(): TreeNode {
        const root: TreeNode = {
            path: '',
            displayName: 'Filters',
            children: new Map(),
            plugins: [],
            expanded: true
        };

        // Build tree from path definitions
        for (const [pathKey, displayName] of Object.entries(FILTER_PATHS)) {
            const parts = pathKey.split('/');
            let currentNode = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const fullPath = parts.slice(0, i + 1).join('/');

                if (!currentNode.children.has(part)) {
                    currentNode.children.set(part, {
                        path: fullPath,
                        displayName: FILTER_PATHS[fullPath] || part,
                        children: new Map(),
                        plugins: [],
                        expanded: true
                    });
                }
                currentNode = currentNode.children.get(part)!;
            }
        }

        return root;
    }

    /**
     * Build empty tree structure for user filters
     */
    private buildUserFiltersTree(): TreeNode {
        return {
            path: 'user',
            displayName: 'User Filters',
            children: new Map(),
            plugins: [],
            expanded: true
        };
    }

    /**
     * Load active filter ids from this window's UI string.
     */
    private loadActiveState(): void {
        this.pendingActiveFilters = getGlyphFilterIds();
    }

    /**
     * Save active filter ids on this window slot. Storage is a list so
     * multi-select can land later; the UI still writes one id today.
     */
    private saveActiveState(): void {
        if (this.activeFilter) {
            setGlyphFilterIds([
                `${this.activeFilter.path}/${this.activeFilter.keyword}`
            ]);
            return;
        }
        setGlyphFilterIds([]);
    }

    /**
     * Initialize with sidebar container and glyph overview reference
     */
    initialize(
        sidebarContainer: HTMLElement,
        glyphOverview: any,
        groupLegendContainer?: HTMLElement
    ): void {
        this.sidebarContainer = sidebarContainer;
        this.glyphOverview = glyphOverview;
        this.groupLegendContainer = groupLegendContainer || null;

        // Render initial sidebar structure
        this.renderSidebar();
    }

    /** Main-thread Pyodide already owns package installation. */
    async syncWorkerPackages(packages: string[]): Promise<void> {
        void packages;
    }

    /**
     * Replace shared plugin context snapshot and bump version.
     */
    setSharedPluginContext(context: Record<string, any>): void {
        this.sharedPluginContext =
            context && typeof context === 'object' ? { ...context } : {};
        this.sharedPluginContextVersion += 1;
    }

    /**
     * Apply a shallow patch to shared plugin context and bump version.
     */
    updateSharedPluginContext(patch: Record<string, any>): void {
        if (!patch || typeof patch !== 'object') {
            return;
        }

        this.sharedPluginContext = {
            ...this.sharedPluginContext,
            ...patch
        };
        this.sharedPluginContextVersion += 1;
    }

    /**
     * Return a copy of the currently shared plugin context.
     */
    getSharedPluginContext(): Record<string, any> {
        return { ...this.sharedPluginContext };
    }

    /** Route one committed semantic batch to only subscribed filters. */
    async handleCommittedGlyphFilterBatch(
        batch: GlyphFilterChangeBatch
    ): Promise<void> {
        if (batch.changes.length === 0 || !window.currentFontModel) {
            return;
        }

        for (const plugin of this.getAllLoadedPlugins()) {
            await this.applyCommittedChanges(plugin, batch.changes);
            if (plugin === this.activeFilter) {
                this.applyCachedFilterResults(plugin);
            } else {
                this.updatePluginCount(plugin);
            }
        }
    }

    /**
     * Snapshot every glyph's current `isCompatible` boolean without emitting
     * events. Called on full filter rebuilds so subsequent edits can toggle.
     */
    seedGlyphCompatibilityState(): void {
        this.glyphCompatibilityByName.clear();
        const glyphs = window.currentFontModel?.glyphs;
        if (!Array.isArray(glyphs)) {
            return;
        }
        for (const glyph of glyphs) {
            const glyphName =
                typeof glyph?.name === 'string' ? glyph.name : undefined;
            if (!glyphName) {
                continue;
            }
            this.glyphCompatibilityByName.set(
                glyphName,
                Boolean(glyph.isCompatible)
            );
        }
    }

    /**
     * Recheck outline compatibility for the given glyphs (or every glyph when
     * masters change) and emit `glyph.compatibility.changed` only when the
     * boolean toggles relative to the last observed value.
     */
    private collectCompatibilityToggleChanges(
        glyphNames: Iterable<string>,
        recheckAllGlyphs: boolean
    ): GlyphFilterChange[] {
        const changes: GlyphFilterChange[] = [];
        const font = window.currentFontModel;
        if (!font) {
            return changes;
        }

        const names = recheckAllGlyphs
            ? Array.isArray(font.glyphs)
                ? font.glyphs
                      .map((glyph: { name?: string }) => glyph?.name)
                      .filter(
                          (name: unknown): name is string =>
                              typeof name === 'string' && name.length > 0
                      )
                : []
            : [...new Set(glyphNames)];

        for (const glyphName of names) {
            const glyph =
                typeof font.findGlyph === 'function'
                    ? font.findGlyph(glyphName)
                    : Array.isArray(font.glyphs)
                      ? font.glyphs.find(
                            (candidate: { name?: string }) =>
                                candidate?.name === glyphName
                        )
                      : undefined;

            if (!glyph) {
                this.glyphCompatibilityByName.delete(glyphName);
                continue;
            }

            const compatible = Boolean(glyph.isCompatible);
            const previous = this.glyphCompatibilityByName.get(glyphName);
            this.glyphCompatibilityByName.set(glyphName, compatible);

            // First observation seeds state only — a toggle requires a prior
            // known value (normally established by seedGlyphCompatibilityState).
            if (previous === undefined || previous === compatible) {
                continue;
            }

            const layerIds = Array.isArray(glyph.layers)
                ? glyph.layers
                      .map((layer: { id?: string }) => layer?.id)
                      .filter(
                          (id: unknown): id is string =>
                              typeof id === 'string' && id.length > 0
                      )
                : [];

            changes.push({
                type: 'glyph.compatibility.changed',
                metadata: {
                    glyphName,
                    compatible,
                    layerIds
                }
            });
        }

        return changes;
    }

    /**
     * Derive the filter-facing semantic contract from committed change paths.
     * Path classification is delegated to glyph-filter-change-derivation.ts;
     * compatibility events are appended only when `Glyph.isCompatible` toggles.
     */
    async handleCommittedChangeEntries(
        entries: Array<{
            path: string;
            op: string;
            oldValue: unknown;
            newValue: unknown;
        }>
    ): Promise<void> {
        const changes: GlyphFilterChange[] = [];
        const lifecycleChanges: GlyphFilterLifecycleChange[] = [];
        const compatibilityCheckGlyphNames = new Set<string>();
        let mastersChanged = false;
        for (const entry of entries) {
            const derived = deriveGlyphFilterChangesFromCommittedEntry(entry);
            changes.push(...derived.changes);
            lifecycleChanges.push(...derived.lifecycleChanges);
            for (const glyphName of derived.compatibilityCheckGlyphNames) {
                compatibilityCheckGlyphNames.add(glyphName);
            }
            if (derived.mastersChanged) {
                mastersChanged = true;
            }

            for (const lifecycle of derived.lifecycleChanges) {
                if (lifecycle.kind === 'deleted') {
                    this.glyphCompatibilityByName.delete(lifecycle.glyphName);
                } else if (lifecycle.kind === 'created') {
                    compatibilityCheckGlyphNames.add(lifecycle.glyphName);
                } else {
                    this.glyphCompatibilityByName.delete(
                        lifecycle.previousGlyphName
                    );
                    compatibilityCheckGlyphNames.add(lifecycle.glyphName);
                }
            }
        }

        changes.push(
            ...this.collectCompatibilityToggleChanges(
                compatibilityCheckGlyphNames,
                mastersChanged
            )
        );

        await this.applyLifecycleChanges(lifecycleChanges);
        await this.handleCommittedGlyphFilterBatch({
            changes: dedupeGlyphFilterChanges(changes)
        });
    }

    /** Apply host-owned glyph identity maintenance to every loaded filter. */
    private async applyLifecycleChanges(
        lifecycleChanges: readonly GlyphFilterLifecycleChange[]
    ): Promise<void> {
        if (!lifecycleChanges.length || !window.currentFontModel) {
            return;
        }

        for (const plugin of this.getAllLoadedPlugins()) {
            const glyphsToClassify: object[] = [];
            for (const change of lifecycleChanges) {
                if (change.kind === 'deleted') {
                    plugin.classifications.delete(change.glyphName);
                    continue;
                }
                if (change.kind === 'renamed') {
                    plugin.classifications.delete(change.previousGlyphName);
                }
                const glyph = window.currentFontModel.findGlyph(
                    change.glyphName
                );
                if (glyph) {
                    glyphsToClassify.push(glyph);
                }
            }
            if (glyphsToClassify.length > 0) {
                this.classifyGlyphs(plugin, glyphsToClassify);
            }
            this.derivePluginResults(plugin);
            if (plugin === this.activeFilter) {
                this.applyCachedFilterResults(plugin);
            } else {
                this.updatePluginCount(plugin);
            }
        }
    }

    private getAllLoadedPlugins(): GlyphFilterPlugin[] {
        return [...this.plugins, ...this.userFilters];
    }

    private normalizeAutoUpdateEvents(events: unknown): string[] {
        if (!Array.isArray(events)) {
            return [];
        }

        return [
            ...new Set(
                events
                    .filter(
                        (eventName): eventName is string =>
                            typeof eventName === 'string'
                    )
                    .map((eventName) => eventName.trim())
                    .filter(Boolean)
            )
        ];
    }

    private invalidatePluginCache(plugin: GlyphFilterPlugin): void {
        plugin.classifications.clear();
        plugin.lastResults = undefined;
        plugin.cachedDataVersion = undefined;
        plugin.cachedContextVersion = undefined;
        plugin.cachedOpenGeneration = undefined;
        // Keep sourceLoaded so font-open rebuilds reuse already-exec'd Python.
        // Drop the displayed count so the sidebar shows "—" while a reload
        // runs (event-engine batches, font open, file-change re-run).
        plugin.glyphCount = undefined;
        this.updatePluginCount(plugin);
    }

    /**
     * Discover and load all glyph filter plugins from installed packages.
     * Uses Python's entry_points system to find plugins in the 'counterpunch_glyphfilter_plugins' group.
     */
    async discoverPlugins(): Promise<void> {
        if (!window.pyodide) {
            console.error('Pyodide not available');
            return;
        }

        try {
            console.log('Discovering glyph filter plugins...');

            // Use importlib.metadata to discover plugins via entry points
            const pluginsResult = await window.pyodide.runPythonAsync(`
                import sys
                from importlib.metadata import entry_points

                # Discover plugins in the 'counterpunch_glyphfilter_plugins' group
                discovered_plugins = []
                
                # Handle different Python versions (entry_points API changed in 3.10)
                if sys.version_info >= (3, 10):
                    eps = entry_points(group='counterpunch_glyphfilter_plugins')
                else:
                    eps = entry_points().get('counterpunch_glyphfilter_plugins', [])
                
                for ep in eps:
                    try:
                        plugin_class = ep.load()
                        plugin_instance = plugin_class()
                        discovered_plugins.append({
                            'path': getattr(plugin_instance, 'path', ''),
                            'keyword': getattr(plugin_instance, 'keyword', ep.name),
                            'display_name': getattr(plugin_instance, 'display_name', ep.name),
                            'event_types': list(getattr(plugin_instance, 'event_types', [])),
                            'instance': plugin_instance
                        })
                    except Exception as e:
                        print(f"[GlyphOverviewFilters] Error loading plugin {ep.name}: {e}")
                        import traceback
                        traceback.print_exc()
                
                discovered_plugins
            `);

            // Convert PyProxy to JavaScript array
            let rawPlugins: any[] = [];
            if (pluginsResult && pluginsResult.toJs) {
                rawPlugins = pluginsResult.toJs({
                    dict_converter: Object.fromEntries
                });
            }

            // Validate plugin paths and load group definitions
            this.plugins = [];
            for (const plugin of rawPlugins) {
                // Check if plugin is visible
                try {
                    const instance = plugin.instance;
                    if (instance && instance.visible) {
                        const isVisible = instance.visible();
                        if (!isVisible) {
                            console.log(
                                `Plugin "${plugin.keyword}" is hidden (visible=false)`
                            );
                            continue;
                        }
                    }
                } catch (error) {
                    console.error(
                        `Error checking visibility for ${plugin.keyword}:`,
                        error
                    );
                }

                // Check if path is valid
                if (!this.isValidPath(plugin.path)) {
                    console.error(
                        `Plugin "${plugin.keyword}" has invalid path "${plugin.path}". ` +
                            `Valid paths are: ${Object.keys(FILTER_PATHS).join(', ')}`
                    );
                    continue;
                }

                // Load group definitions
                try {
                    const instance = plugin.instance;
                    if (instance && instance.get_groups) {
                        const groupsResult = instance.get_groups();
                        if (groupsResult && groupsResult.toJs) {
                            plugin.groups = groupsResult.toJs({
                                dict_converter: Object.fromEntries
                            });
                        } else {
                            plugin.groups = {};
                        }
                    } else {
                        plugin.groups = {};
                    }
                } catch (error) {
                    console.error(
                        `Error getting groups for ${plugin.display_name}:`,
                        error
                    );
                    plugin.groups = {};
                }

                const eventTypes = Array.isArray(plugin.event_types)
                    ? plugin.event_types.filter(
                          (
                              eventType: unknown
                          ): eventType is GlyphFilterEventType =>
                              typeof eventType === 'string' &&
                              isGlyphFilterEventType(eventType)
                      )
                    : [];
                if (
                    eventTypes.length === 0 &&
                    plugin.keyword !== ALL_GLYPHS_FILTER_KEYWORD
                ) {
                    console.error(
                        `Plugin "${plugin.keyword}" must declare supported event_types.`
                    );
                    continue;
                }
                plugin.eventTypes = eventTypes;
                plugin.classifications = new Map();

                this.plugins.push(plugin as GlyphFilterPlugin);
            }

            // Add plugins to tree nodes
            for (const plugin of this.plugins) {
                const node = this.findNode(plugin.path);
                if (node) {
                    node.plugins.push(plugin);
                }
            }

            console.log(
                `Discovered ${this.plugins.length} glyph filter plugin(s):`,
                this.plugins.map((p) => p.display_name)
            );
            this.loaded = true;

            // Apply pending active filter if any
            if (this.pendingActiveFilters.length > 0) {
                const plugin = this.pendingActiveFilters
                    .map((fullId) =>
                        this.plugins.find(
                            (p) => `${p.path}/${p.keyword}` === fullId
                        )
                    )
                    .find((entry) => entry);
                if (plugin) {
                    this.activeFilter = plugin;
                }
                this.pendingActiveFilters = [];
            }

            // If no active filter, select "All Glyphs" as default
            if (!this.activeFilter && this.plugins.length > 0) {
                const allGlyphsFilter = this.plugins.find(
                    (p) => p.keyword === 'com.context.allglyphs'
                );
                if (allGlyphsFilter) {
                    this.activeFilter = allGlyphsFilter;
                } else {
                    // Fallback to first plugin if All Glyphs not found
                    this.activeFilter = this.plugins[0];
                }
            }

            // Re-render sidebar with plugins
            this.renderSidebar();

            await this.discoverUserFilters();
            if (window.currentFontModel) {
                await this.refreshPlugins({ deferCounts: true });
            }
        } catch (error) {
            console.error('Failed to discover plugins:', error);
            this.plugins = [];
        }
    }

    /**
     * Discover user-defined filters from /Filters/ in the Settings Folder
     * @param skipObserverSetup - If true, skip setting up file system observer (used when called from observer callback)
     * @param renamedToDisplayName - If provided, look for filter with this display_name when keyword match fails (for renames)
     */
    async discoverUserFilters(
        skipObserverSetup: boolean = false,
        renamedToDisplayName: string | null = null
    ): Promise<void> {
        return this.enqueueFilterWork(() =>
            this.discoverUserFiltersWork(
                skipObserverSetup,
                renamedToDisplayName
            )
        );
    }

    private async discoverUserFiltersWork(
        skipObserverSetup: boolean = false,
        renamedToDisplayName: string | null = null
    ): Promise<void> {
        const scanGeneration = ++this.userFilterScanGeneration;
        const isCurrentScan = () =>
            scanGeneration === this.userFilterScanGeneration;

        const previousUserFilters = this.userFilters;
        // Remember active user filter keyword to restore after reload
        const activeUserFilterKeyword = this.activeFilter?.isUserFilter
            ? this.activeFilter.keyword
            : null;

        // Reset user filters tree
        this.userFiltersNode = this.buildUserFiltersTree();
        this.userFilters = [];

        const adapter = settingsFolder.getAdapter();
        if (!this.isDiskAdapterLike(adapter)) {
            console.log('Settings adapter is not NativeAdapter');
            if (isCurrentScan()) {
                this.renderSidebar();
            }
            return;
        }

        // Ensure adapter is initialized (restores directory handle from IndexedDB)
        await settingsFolder.initialize();
        if (!isCurrentScan()) {
            return;
        }

        // Check if Settings Folder is selected
        if (!settingsFolder.hasFolder()) {
            console.log('No Settings Folder selected');
            if (isCurrentScan()) {
                this.renderSidebar();
            }
            return;
        }

        try {
            // Check if /Filters exists
            const filtersPath = this.USER_FILTERS_PATH;
            const exists = await adapter.fileExists(filtersPath);
            if (!isCurrentScan()) {
                return;
            }
            if (!exists) {
                console.log(`${filtersPath} does not exist`);
                this.renderSidebar();
                return;
            }

            // Scan for .py files recursively (max 3 levels)
            const files = await adapter.listFilesRecursive(filtersPath, 3);
            if (!isCurrentScan()) {
                return;
            }
            const pyFiles = files.filter((f) => f.path.endsWith('.py'));

            console.log(`Found ${pyFiles.length} user filter file(s)`);

            for (const file of pyFiles) {
                // Extract relative path from /Filters/ (used in both
                // success and error paths, so compute it outside try).
                const relativePath = file.path
                    .substring(filtersPath.length + 1)
                    .replace(/\.py$/, '');
                const pathParts = relativePath.split('/');
                const fileName = pathParts.pop()!;
                const folderPath = pathParts.join('/');

                try {
                    // Read file content
                    const content = await adapter.readFile(file.path);
                    if (!isCurrentScan()) {
                        return;
                    }
                    const code =
                        typeof content === 'string'
                            ? content
                            : new TextDecoder().decode(content);

                    const inspection = this.inspectUserFilterSource(code);

                    // Parse GROUPS from code (simple regex extraction)
                    let groups: Record<string, GroupDefinition> = {};
                    try {
                        const groupsMatch = code.match(
                            /GROUPS\s*=\s*(\{[\s\S]*?\n\})/
                        );
                        if (groupsMatch) {
                            // We'll parse groups at runtime in Python
                        }
                    } catch (e) {
                        // Ignore group parsing errors
                    }

                    // Create user filter plugin
                    const userFilter: GlyphFilterPlugin = {
                        path: folderPath ? `user/${folderPath}` : 'user',
                        keyword: `user.${relativePath.replace(/\//g, '.')}`,
                        display_name: fileName,
                        instance: null, // Will be created at runtime
                        groups: groups,
                        eventTypes: inspection.eventTypes,
                        validationDiagnostic: inspection.diagnostic,
                        isUserFilter: true,
                        filePath: file.path,
                        pythonCode: code,
                        classifications: new Map()
                    };

                    this.userFilters.push(userFilter);

                    // Add to user filters tree
                    this.addUserFilterToTree(userFilter, folderPath);
                } catch (error) {
                    console.error(
                        `Error loading user filter ${file.path}:`,
                        error
                    );
                    // Still show the filter with an error diagnostic so the
                    // user can see and edit it even when inspection fails.
                    const userFilter: GlyphFilterPlugin = {
                        path: folderPath ? `user/${folderPath}` : 'user',
                        keyword: `user.${relativePath.replace(/\//g, '.')}`,
                        display_name: fileName,
                        instance: null,
                        groups: {},
                        eventTypes: [],
                        validationDiagnostic:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        isUserFilter: true,
                        filePath: file.path,
                        pythonCode: '',
                        classifications: new Map()
                    };
                    this.userFilters.push(userFilter);
                    this.addUserFilterToTree(userFilter, folderPath);
                }
            }

            console.log(
                `Loaded ${this.userFilters.length} user filter(s):`,
                this.userFilters.map((f) => f.display_name)
            );

            if (!isCurrentScan()) {
                return;
            }

            // Restore active user filter reference if it still exists
            if (activeUserFilterKeyword) {
                let restoredFilter = this.userFilters.find(
                    (f) => f.keyword === activeUserFilterKeyword
                );

                // If not found by keyword but we have a rename target, find by display_name
                if (!restoredFilter && renamedToDisplayName) {
                    restoredFilter = this.userFilters.find(
                        (f) => f.display_name === renamedToDisplayName
                    );
                }

                if (restoredFilter) {
                    this.activeFilter = restoredFilter;
                } else {
                    // Filter was renamed/deleted, fall back to "All Glyphs"
                    const allGlyphsFilter = this.plugins.find(
                        (p) => p.keyword === 'com.context.allglyphs'
                    );
                    if (allGlyphsFilter) {
                        this.activeFilter = allGlyphsFilter;
                        // Run the filter to update glyph overview
                        if (window.currentFontModel && isCurrentScan()) {
                            await this.runFilter(allGlyphsFilter);
                        }
                    }
                }
            }

            if (!isCurrentScan()) {
                return;
            }

            this.restoreUserFilterRuntimeState(previousUserFilters);
            this.renderSidebar();

            await this.countUserFiltersIfIdle();
            if (!isCurrentScan()) {
                return;
            }

            // Set up file system observer for auto-refresh (skip if called from observer)
            if (!skipObserverSetup && isCurrentScan()) {
                await this.setupFileSystemObserver(adapter);
            }
        } catch (error) {
            if (isCurrentScan()) {
                console.error('Error discovering user filters:', error);
            }
        }
    }

    private restoreUserFilterRuntimeState(
        previousUserFilters: GlyphFilterPlugin[]
    ): void {
        if (previousUserFilters.length === 0 || this.userFilters.length === 0) {
            return;
        }
        const previousByKeyword = new Map(
            previousUserFilters.map((filter) => [filter.keyword, filter])
        );
        for (const filter of this.userFilters) {
            const prior = previousByKeyword.get(filter.keyword);
            if (!prior || prior.pythonCode !== filter.pythonCode) {
                continue;
            }
            filter.classifications = prior.classifications;
            filter.lastResults = prior.lastResults;
            filter.groups = prior.groups;
            filter.sourceLoaded = prior.sourceLoaded;
            filter.sourceNamespace = prior.sourceNamespace;
            filter.hasCandidateFunction = prior.hasCandidateFunction;
            filter.cachedDataVersion = prior.cachedDataVersion;
            filter.cachedContextVersion = prior.cachedContextVersion;
            filter.cachedOpenGeneration = prior.cachedOpenGeneration;
            filter.glyphCount = prior.glyphCount;
            filter.hasError = prior.hasError;
            filter.hasNoFilterFunction = prior.hasNoFilterFunction;
            filter.instance = prior.instance;
        }
    }

    private shouldCountUserFiltersNow(): boolean {
        return (
            !!window.currentFontModel &&
            !this.openRecountPending &&
            !this.pluginRefreshInFlight
        );
    }

    private async countUserFiltersIfIdle(): Promise<void> {
        if (!this.shouldCountUserFiltersNow()) {
            return;
        }
        const generation = this.userFilterScanGeneration;
        for (const filter of this.userFilters) {
            if (generation !== this.userFilterScanGeneration) {
                return;
            }
            if (filter.validationDiagnostic) {
                continue;
            }
            if (this.canUseCachedFilterResults(filter)) {
                this.updatePluginCount(filter);
                continue;
            }
            await this.runPluginForCount(filter);
        }
    }

    private inspectUserFilterSource(code: string): {
        eventTypes: GlyphFilterEventType[];
        diagnostic?: string;
    } {
        const eventTypesMatch = code.match(
            /^\s*EVENT_TYPES\s*=\s*([\[\(\{])([\s\S]*?)[\]\)\}]/m
        );
        if (!eventTypesMatch) {
            return {
                eventTypes: [],
                diagnostic: 'Missing literal EVENT_TYPES.'
            };
        }
        const quotedEvents = [
            ...eventTypesMatch[2].matchAll(/['"]([^'"]+)['"]/g)
        ].map((match) => match[1]);
        if (
            quotedEvents.length === 0 ||
            quotedEvents.some((eventType) => !isGlyphFilterEventType(eventType))
        ) {
            return {
                eventTypes: [],
                diagnostic:
                    'EVENT_TYPES must be a literal list, tuple, or set of supported content events.'
            };
        }
        if (!/^\s*def\s+classify_glyph\s*\(\s*glyph\s*\)\s*:/m.test(code)) {
            return {
                eventTypes: [],
                diagnostic: 'Missing classify_glyph(glyph).'
            };
        }
        if (
            /(^|\n)\s*def\s+is_candidate\s*\((?!\s*glyph\s*\)\s*:)/.test(code)
        ) {
            return {
                eventTypes: [],
                diagnostic: 'is_candidate(), when present, must accept glyph.'
            };
        }
        return {
            eventTypes: [...new Set(quotedEvents)] as GlyphFilterEventType[]
        };
    }

    /**
     * Set up FileSystemObserver to watch for changes in the filters directory
     */
    private async setupFileSystemObserver(
        adapter: NativeAdapter
    ): Promise<void> {
        // Disconnect existing observer if any
        if (this.fileSystemObserver) {
            try {
                this.fileSystemObserver.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
            this.fileSystemObserver = null;
        }

        // Check if FileSystemObserver is supported (Chrome 133+)
        if (!this.observerSupported) {
            console.log(
                'FileSystemObserver not supported, using manual refresh'
            );
            return;
        }

        try {
            // Get the filters directory handle
            const filtersPath = this.USER_FILTERS_PATH;
            const handle = await (adapter as any).getHandleAtPath(filtersPath);
            if (!handle || handle.kind !== 'directory') {
                console.log('Cannot get directory handle for observer');
                return;
            }

            // Create observer
            const FileSystemObserver = (window as any).FileSystemObserver;
            this.fileSystemObserver = new FileSystemObserver(
                async (records: any[]) => {
                    // Log all records for debugging (full object)
                    for (const r of records) {
                        console.log(
                            '[GlyphOverviewFilters]',
                            'Record:',
                            JSON.stringify({
                                type: r.type,
                                changedHandleName: r.changedHandle?.name,
                                relativePathComponents:
                                    r.relativePathComponents,
                                relativePathMovedFrom: r.relativePathMovedFrom,
                                root: r.root?.name
                            })
                        );
                    }

                    // Check if any .py files were affected
                    let needsRefresh = false;

                    for (const record of records) {
                        const name = record.changedHandle?.name || '';
                        if (name.endsWith('.py')) {
                            needsRefresh = true;
                        } else if (
                            record.type === 'appeared' ||
                            record.type === 'disappeared'
                        ) {
                            needsRefresh = true;
                        }
                    }

                    if (!needsRefresh) {
                        return;
                    }

                    // Script Editor / in-app writes already refresh via
                    // managedFileChanged. Suppress FileSystemObserver echoes
                    // for those same paths for the full internal-write TTL
                    // (createWritable can emit more than one record/callback).
                    const observedPaths =
                        this.resolveFilterObserverRecordPaths(records);
                    const pyBasenames = records
                        .map((record) =>
                            record && typeof record === 'object'
                                ? (
                                      record as {
                                          changedHandle?: { name?: string };
                                      }
                                  ).changedHandle?.name
                                : undefined
                        )
                        .filter(
                            (name): name is string =>
                                typeof name === 'string' && name.endsWith('.py')
                        );

                    const suppressEcho =
                        (observedPaths.length > 0 &&
                            wereAllManagedPathsInternalWrites(
                                SETTINGS_FOLDER_SOURCE_ID,
                                observedPaths
                            )) ||
                        (pyBasenames.length > 0 &&
                            wereAllBasenamesInternalWrites(
                                SETTINGS_FOLDER_SOURCE_ID,
                                pyBasenames
                            ));

                    if (suppressEcho) {
                        console.log(
                            '[GlyphOverviewFilters]',
                            'Ignoring FileSystemObserver echo of internal filter write',
                            { observedPaths, pyBasenames }
                        );
                        return;
                    }

                    console.log(
                        '[GlyphOverviewFilters]',
                        'File system change detected, refreshing user filters'
                    );
                    this.queueUserFilterFileChangeRefresh({ records });
                }
            );

            // Start observing the filters directory
            await this.fileSystemObserver.observe(handle, { recursive: true });
            console.log('FileSystemObserver watching', filtersPath);
        } catch (error) {
            console.error('Failed to set up FileSystemObserver:', error);
        }
    }

    /**
     * Add a user filter to the user filters tree structure
     */
    private addUserFilterToTree(
        filter: GlyphFilterPlugin,
        folderPath: string
    ): void {
        if (!folderPath) {
            // Add directly to user filters root
            this.userFiltersNode.plugins.push(filter);
            return;
        }

        // Navigate/create path in user filters tree
        const parts = folderPath.split('/');
        let currentNode = this.userFiltersNode;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!currentNode.children.has(part)) {
                currentNode.children.set(part, {
                    path: `user/${parts.slice(0, i + 1).join('/')}`,
                    displayName: part,
                    children: new Map(),
                    plugins: [],
                    expanded: true
                });
            }
            currentNode = currentNode.children.get(part)!;
        }

        currentNode.plugins.push(filter);
    }

    /**
     * Check if a path is valid (exists in FILTER_PATHS)
     */
    private isValidPath(path: string): boolean {
        return path in FILTER_PATHS;
    }

    /**
     * Find a tree node by path
     */
    private findNode(path: string): TreeNode | null {
        if (!path) return this.rootNode;

        const parts = path.split('/');
        let currentNode = this.rootNode;

        for (const part of parts) {
            const child = currentNode.children.get(part);
            if (!child) return null;
            currentNode = child;
        }

        return currentNode;
    }

    /**
     * Render the sidebar tree structure
     */
    private renderSidebar(): void {
        if (!this.sidebarContainer) return;

        // Clean up existing tippy instances
        this.tippyInstances.forEach((instance) => instance.destroy());
        this.tippyInstances = [];

        // Clear existing content
        this.sidebarContainer.innerHTML = '';

        // Create header
        const header = document.createElement('div');
        header.className = 'editor-section-title';
        header.textContent = 'Filters';
        this.sidebarContainer.appendChild(header);

        // Render tree nodes for built-in plugins
        const treeContainer = document.createElement('div');
        treeContainer.className = 'glyph-filter-tree';
        this.renderTreeNode(this.rootNode, treeContainer, 0);
        this.sidebarContainer.appendChild(treeContainer);

        // Render User Filters section
        this.renderUserFiltersSection();
    }

    /**
     * Render the User Filters section with refresh button
     */
    private renderUserFiltersSection(): void {
        if (!this.sidebarContainer) return;

        // Check if Settings Folder is available
        const settingsAdapter = settingsFolder.getAdapter();
        const hasSettingsFolder =
            this.isDiskAdapterLike(settingsAdapter) &&
            settingsAdapter.hasDirectory() &&
            isSettingsFolderReadySync();

        // Create header with refresh button
        const header = document.createElement('div');
        header.className = 'editor-section-title glyph-filter-user-header';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'User Filters';
        header.appendChild(titleSpan);

        if (hasSettingsFolder) {
            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'glyph-filter-header-buttons';

            const newBtn = document.createElement('button');
            newBtn.className = 'glyph-filter-new-btn';
            newBtn.title = 'Create new filter';
            newBtn.innerHTML =
                '<span class="material-symbols-outlined">add</span>';
            newBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.createNewFilter();
            });
            buttonContainer.appendChild(newBtn);

            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'glyph-filter-refresh-btn';
            refreshBtn.title = 'Refresh user filters';
            refreshBtn.innerHTML =
                '<span class="material-symbols-outlined">refresh</span>';
            refreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                refreshBtn.classList.add('spinning');
                await this.discoverUserFilters();
                refreshBtn.classList.remove('spinning');
            });
            buttonContainer.appendChild(refreshBtn);

            header.appendChild(buttonContainer);
        }

        this.sidebarContainer.appendChild(header);

        // Render user filters tree
        const userTreeContainer = document.createElement('div');
        userTreeContainer.className =
            'glyph-filter-tree glyph-filter-user-tree';

        if (!hasSettingsFolder) {
            userTreeContainer.appendChild(createFolderSetupCallout());
        } else if (this.userFilters.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'glyph-filter-empty';
            emptyMsg.textContent = `No filters in ${this.USER_FILTERS_PATH}`;
            userTreeContainer.appendChild(emptyMsg);
        } else {
            // Render user filters tree (root-level plugins first, then folders)
            this.renderUserFiltersTree(this.userFiltersNode, userTreeContainer);
        }

        this.sidebarContainer.appendChild(userTreeContainer);
    }

    /**
     * Recursively render a tree node and its children
     */
    private renderTreeNode(
        node: TreeNode,
        container: HTMLElement,
        depth: number
    ): void {
        // Render child nodes (categories) - sorted alphabetically
        const sortedChildren = Array.from(node.children.entries()).sort(
            ([keyA], [keyB]) =>
                keyA.localeCompare(keyB, undefined, { sensitivity: 'base' })
        );
        for (const [key, childNode] of sortedChildren) {
            const nodeElement = document.createElement('div');
            nodeElement.className = 'glyph-filter-node';
            nodeElement.style.setProperty(
                '--glyph-filter-node-depth',
                String(depth)
            );

            // Category header with expand/collapse toggle
            const header = document.createElement('div');
            header.className = 'glyph-filter-node-header';

            const toggle = document.createElement('span');
            toggle.className = 'glyph-filter-toggle material-symbols-outlined';
            toggle.textContent = childNode.expanded
                ? 'expand_more'
                : 'chevron_right';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                childNode.expanded = !childNode.expanded;
                toggle.textContent = childNode.expanded
                    ? 'expand_more'
                    : 'chevron_right';
                childContent.style.display = childNode.expanded ? '' : 'none';
            });

            const label = document.createElement('span');
            label.className = 'glyph-filter-node-label';
            label.textContent = childNode.displayName;

            header.appendChild(toggle);
            header.appendChild(label);
            nodeElement.appendChild(header);

            // Child content container
            const childContent = document.createElement('div');
            childContent.className = 'glyph-filter-node-content';
            childContent.style.display = childNode.expanded ? '' : 'none';

            // Render plugins in this node - sorted alphabetically
            const sortedPlugins = [...childNode.plugins].sort((a, b) =>
                a.display_name.localeCompare(b.display_name, undefined, {
                    sensitivity: 'base'
                })
            );
            for (const plugin of sortedPlugins) {
                const pluginElement = this.renderPluginItem(plugin, depth + 1);
                childContent.appendChild(pluginElement);
            }

            // Recursively render children
            this.renderTreeNode(childNode, childContent, depth + 1);

            nodeElement.appendChild(childContent);
            container.appendChild(nodeElement);
            childNode.element = nodeElement;
        }
    }

    /**
     * Render user filters tree with root-level plugins first, then folders
     */
    private renderUserFiltersTree(
        node: TreeNode,
        container: HTMLElement
    ): void {
        // Render root-level plugins first (filters directly in /Filters/)
        // Sort alphabetically
        const sortedPlugins = [...node.plugins].sort((a, b) =>
            a.display_name.localeCompare(b.display_name, undefined, {
                sensitivity: 'base'
            })
        );
        for (const plugin of sortedPlugins) {
            const pluginElement = this.renderPluginItem(plugin, 0);
            container.appendChild(pluginElement);
        }

        // Then render child nodes (subfolders) - also sorted
        const sortedChildren = Array.from(node.children.entries()).sort(
            ([keyA], [keyB]) =>
                keyA.localeCompare(keyB, undefined, { sensitivity: 'base' })
        );
        for (const [, childNode] of sortedChildren) {
            this.renderTreeNode(childNode, container, 0);
        }
    }

    /**
     * Render a single plugin item
     */
    private renderPluginItem(
        plugin: GlyphFilterPlugin,
        depth: number
    ): HTMLElement {
        const item = document.createElement('div');
        item.className = 'glyph-filter-item sidebar-item';
        item.dataset.pluginKeyword = plugin.keyword; // For reliable lookup
        if (this.activeFilter === plugin) {
            item.classList.add('active');
        }
        item.style.setProperty('--glyph-filter-item-depth', String(depth));

        const label = document.createElement('span');
        label.className = 'glyph-filter-item-label';
        label.textContent = plugin.validationDiagnostic
            ? `${plugin.display_name} (Invalid)`
            : plugin.display_name;

        const count = document.createElement('span');
        count.className = 'glyph-filter-item-count';
        count.textContent = plugin.validationDiagnostic
            ? 'Error'
            : plugin.glyphCount !== undefined
              ? String(plugin.glyphCount)
              : '—';

        if (plugin.validationDiagnostic) {
            item.classList.add('has-error');
            item.title = plugin.validationDiagnostic;
        }

        item.appendChild(label);
        item.appendChild(count);

        // Click to activate filter
        item.addEventListener('click', async () => {
            await this.activateFilter(plugin, item);
        });

        // Add context menu for user filters
        if (plugin.isUserFilter && plugin.filePath) {
            this.setupUserFilterContextMenu(item, plugin);
        }

        return item;
    }

    /**
     * Setup context menu for a user filter item
     */
    private setupUserFilterContextMenu(
        element: HTMLElement,
        plugin: GlyphFilterPlugin
    ): void {
        const filePath = plugin.filePath!;

        // Build menu HTML (using same structure as file-browser context menus)
        const menuHtml = `
            <div class="plugin-menu">
                <div class="plugin-menu-item" data-action="open-script-editor">
                    <span class="material-symbols-outlined">code</span>
                    <span>Open in Script Editor</span>
                </div>
                <div class="plugin-menu-item" data-action="rename">
                    <span class="material-symbols-outlined">edit</span>
                    <span>Rename</span>
                </div>
                <div class="plugin-menu-divider"></div>
                <div class="plugin-menu-item plugin-menu-item-danger" data-action="delete">
                    <span class="material-symbols-outlined">delete</span>
                    <span>Delete</span>
                </div>
            </div>
        `;

        const backdrop = getOrCreateBackdrop('user-filter-context-backdrop');

        const tippyInstance = tippy(element, {
            content: menuHtml,
            allowHTML: true,
            trigger: 'manual',
            interactive: true,
            placement: 'right-start',
            theme: getTheme(),
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            getReferenceClientRect: null as any,
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) return;

                // Setup keyboard navigation
                setupMenuKeyboardNav(menu);

                // Skip if handlers already set up
                if ((menu as any)._handlersSetup) return;
                (menu as any)._handlersSetup = true;

                menu.querySelectorAll('.plugin-menu-item').forEach(
                    (menuItem: any) => {
                        menuItem.addEventListener('click', async () => {
                            const action = menuItem.getAttribute('data-action');

                            // Hide menu immediately
                            instance.hide();
                            backdrop.classList.remove('visible');
                            element.classList.remove('context-menu-active');

                            switch (action) {
                                case 'open-script-editor':
                                    await this.openFilterInScriptEditor(
                                        filePath
                                    );
                                    break;
                                case 'rename':
                                    await this.renameFilter(plugin, element);
                                    break;
                                case 'delete':
                                    await this.deleteFilter(plugin);
                                    break;
                            }
                        });
                    }
                );
            }
        });

        this.tippyInstances.push(tippyInstance);

        addTippyBackdropSupport(tippyInstance, backdrop, {
            targetElement: element,
            activeClass: 'context-menu-active'
        });

        // Right-click to show context menu
        element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Position at mouse cursor
            tippyInstance.setProps({
                getReferenceClientRect: () => ({
                    width: 0,
                    height: 0,
                    top: e.clientY,
                    bottom: e.clientY,
                    left: e.clientX,
                    right: e.clientX,
                    x: e.clientX,
                    y: e.clientY,
                    toJSON: () => ({})
                })
            });

            tippyInstance.show();
        });
    }

    /**
     * Open a user filter file in the Script Editor
     */
    private async openFilterInScriptEditor(filePath: string): Promise<void> {
        if (window.scriptEditor && window.scriptEditor.openFile) {
            try {
                await window.scriptEditor.openFile(
                    filePath,
                    SETTINGS_FOLDER_SOURCE_ID
                );
                console.log(`Opened ${filePath} in Script Editor`);
            } catch (error) {
                console.error('Error opening in Script Editor:', error);
                alert(
                    'Failed to open file in Script Editor: ' +
                        (error as Error).message
                );
            }
        } else {
            console.error('Script Editor not available');
            alert('Script Editor not available');
        }
    }

    /**
     * Activate a filter plugin.
     * If the filter already has results for the current font data version,
     * reuse them instead of re-executing.
     */
    private async activateFilter(
        plugin: GlyphFilterPlugin,
        itemElement: HTMLElement
    ): Promise<void> {
        // If clicking same filter, do nothing (can't deselect)
        if (this.activeFilter === plugin) {
            return;
        }

        // Deactivate previous
        if (this.activeFilter) {
            const prevItem = this.sidebarContainer?.querySelector(
                '.glyph-filter-item.active'
            );
            prevItem?.classList.remove('active');
        }

        // Activate new filter
        this.activeFilter = plugin;
        itemElement.classList.add('active');
        this.saveActiveState();

        const dataVersion = this.getCurrentDataVersion();
        if (this.canUseCachedFilterResults(plugin, dataVersion)) {
            this.applyCachedFilterResults(plugin);
            return;
        }

        await this.runFilter(plugin);
    }

    /**
     * Run a filter plugin and apply results.
     * An empty change batch forces a host-owned cache rebuild.
     */
    async runFilter(
        plugin: GlyphFilterPlugin,
        changeBatch: GlyphFilterChangeBatch = FULL_FILTER_REBUILD_BATCH
    ): Promise<void> {
        if (plugin.validationDiagnostic) {
            plugin.hasError = true;
            plugin.glyphCount = 0;
            this.updatePluginCount(plugin);
            this.glyphOverview?.showFilterError(
                plugin.display_name,
                plugin.validationDiagnostic
            );
            return;
        }
        if (!window.currentFontModel) {
            console.error('Font not available');
            return;
        }

        if (changeBatch.changes.length === 0) {
            this.seedGlyphCompatibilityState();
        }

        try {
            console.log(`Running filter: ${plugin.display_name}`);

            await this.rebuildFilterCache(plugin);
            this.applyCachedFilterResults(plugin);
            return;

            const dataVersion = this.getCurrentDataVersion();
            if (this.canUseCachedFilterResults(plugin, dataVersion)) {
                console.log(
                    `Using cached results for filter: ${plugin.display_name}`
                );
                this.applyCachedFilterResults(plugin);
                return;
            }

            const fontSnapshotJson = this.getCurrentFontSnapshotJson();
            if (!fontSnapshotJson) {
                this.scheduleRefreshRetry();
                return;
            }

            const execResult = await this.executeFilter(
                plugin,
                fontSnapshotJson,
                changeBatch
            );
            if (execResult.status === 'not_needed') {
                return;
            }
            if (execResult.status === 'incremental') {
                this.mergeFilterGroups(plugin, execResult.groups);
                this.applyFilterDelta(plugin, execResult.delta);
                this.applyCachedFilterResults(plugin);
                return;
            }
            let results = execResult.results;
            const groups = execResult.groups;
            const status = execResult.status || 'ok';
            plugin.groups = groups;

            if (status === 'no_filter_function') {
                plugin.glyphCount = 0;
                plugin.hasError = false;
                plugin.hasNoFilterFunction = true;
                this.updatePluginCount(plugin);
                if (this.glyphOverview) {
                    const message = plugin.isUserFilter
                        ? 'No classify_glyph(glyph) function found in the filter file.'
                        : 'Plugin has no classify_glyph(glyph) function.';
                    this.glyphOverview.showFilterNotice(
                        plugin.display_name,
                        message,
                        'warning'
                    );
                }
                return;
            }

            // Process results (consolidate duplicates, normalize groups, resolve colors)
            const {
                results: processedResults,
                usedGroupKeywords,
                augmentedGroups
            } = this.processFilterResults(results, groups);
            results = processedResults;

            // Store results and augmented groups (includes auto-generated color groups)
            plugin.lastResults = results;
            plugin.groups = augmentedGroups;
            plugin.glyphCount = results.length;
            plugin.hasError = false;
            plugin.hasNoFilterFunction = false;
            plugin.cachedDataVersion = dataVersion ?? undefined;
            plugin.cachedContextVersion = this.sharedPluginContextVersion;

            // Update count in sidebar
            this.updatePluginCount(plugin);

            // Update group legend (uses augmentedGroups via plugin.groups)
            this.updateGroupLegend(plugin, usedGroupKeywords);

            console.log(`Filter returned ${results.length} glyphs`);

            // Apply to overview
            if (this.glyphOverview) {
                // Check for no results
                if (results.length === 0) {
                    this.glyphOverview.showFilterNotice(
                        plugin.display_name,
                        'Filter executed successfully but returned no results.',
                        'info'
                    );
                } else {
                    this.glyphOverview.setActiveFilter(results);
                    // Update selected glyph groups highlighting for current selection
                    this.glyphOverview.updateSelectedGlyphGroups();
                }
            }
        } catch (error) {
            console.error(
                `Error running filter ${plugin.display_name}:`,
                error
            );
            // Mark plugin as having an error
            plugin.hasError = true;
            this.updatePluginCount(plugin);
            // Show error inline in glyph overview
            if (this.glyphOverview) {
                // For user filters, pass file path and code to enable "Fix with AI" button
                if (
                    plugin.isUserFilter &&
                    plugin.filePath &&
                    plugin.pythonCode
                ) {
                    this.glyphOverview.showFilterError(
                        plugin.display_name,
                        error,
                        0,
                        plugin.filePath,
                        plugin.pythonCode
                    );
                } else {
                    this.glyphOverview.showFilterError(
                        plugin.display_name,
                        error
                    );
                }
            }
        }
    }

    private canUseCachedFilterResults(
        plugin: GlyphFilterPlugin,
        _dataVersion?: number | null
    ): boolean {
        const cachedGeneration = plugin.cachedOpenGeneration ?? 0;
        const sourceReady =
            plugin.keyword === ALL_GLYPHS_FILTER_KEYWORD ||
            plugin.sourceLoaded === true;
        return (
            sourceReady &&
            Array.isArray(plugin.lastResults) &&
            cachedGeneration === this.openGeneration &&
            !plugin.hasError &&
            !plugin.hasNoFilterFunction
        );
    }

    private stampFilterCache(plugin: GlyphFilterPlugin): void {
        plugin.cachedOpenGeneration = this.openGeneration;
        plugin.cachedDataVersion = this.getCurrentDataVersion() ?? undefined;
        plugin.cachedContextVersion = this.sharedPluginContextVersion;
    }

    private getCurrentDataVersion(): number | null {
        const version = window.fontManager?.currentFont?.changeVersion;
        return typeof version === 'number' ? version : null;
    }

    /** Compatibility sentinel for count-refresh callers; no font is serialized. */
    private getCurrentFontSnapshotJson(): string | null {
        return window.currentFontModel ? 'main-thread' : null;
    }

    /**
     * Legacy group-cache helper retained for sidebar rendering compatibility.
     */
    private mergeFilterGroups(
        plugin: GlyphFilterPlugin,
        groups: Record<string, GroupDefinition> | undefined
    ): void {
        if (!groups || Object.keys(groups).length === 0) {
            return;
        }
        plugin.groups = { ...(plugin.groups || {}), ...groups };
    }

    private applyCachedFilterResults(plugin: GlyphFilterPlugin): void {
        // Re-resolve colors and legend entries from the current host cache.
        const { results, usedGroupKeywords, augmentedGroups } =
            this.processFilterResults(
                plugin.lastResults || [],
                plugin.groups || {}
            );
        plugin.lastResults = results;
        plugin.groups = augmentedGroups;

        plugin.glyphCount = results.length;
        plugin.hasError = false;
        this.updatePluginCount(plugin);
        this.updateGroupLegend(plugin, usedGroupKeywords);

        if (this.glyphOverview) {
            if (results.length === 0) {
                this.glyphOverview.showFilterNotice(
                    plugin.display_name,
                    'Filter executed successfully but returned no results.',
                    'info'
                );
            } else {
                this.glyphOverview.setActiveFilter(results);
                this.glyphOverview.updateSelectedGlyphGroups();
            }
        }
    }

    /** Apply idempotent glyph-name additions/removals to a complete result cache. */
    private applyFilterDelta(
        plugin: GlyphFilterPlugin,
        delta:
            | { add?: Array<string | FilterResult>; remove?: string[] }
            | undefined
    ): void {
        const results = new Map(
            (plugin.lastResults || []).map((result) => [
                result.glyph_name,
                result
            ])
        );
        // Removals apply before additions so one glyph can be replaced with
        // updated group membership in a single delta.
        for (const glyphName of delta?.remove || []) {
            results.delete(glyphName);
        }
        for (const addition of delta?.add || []) {
            const result =
                typeof addition === 'string'
                    ? { glyph_name: addition }
                    : addition;
            results.set(result.glyph_name, result);
        }
        plugin.lastResults = [...results.values()];
        plugin.cachedDataVersion = this.getCurrentDataVersion() ?? undefined;
        plugin.cachedContextVersion = this.sharedPluginContextVersion;
    }

    private scheduleRefreshRetry(delayMs: number = 200): void {
        if (this.refreshRetryTimer !== null) {
            return;
        }

        this.refreshRetryTimer = window.setTimeout(async () => {
            this.refreshRetryTimer = null;

            if (!window.currentFontModel || !this.loaded) {
                return;
            }

            await this.refreshPlugins();
        }, delayMs);
    }

    private async rebuildFilterCache(plugin: GlyphFilterPlugin): Promise<void> {
        plugin.classifications.clear();
        const glyphs =
            plugin.keyword === ALL_GLYPHS_FILTER_KEYWORD
                ? listOverviewGlyphRecords({
                      fontJson: window.fontManager?.currentFont?.babelfontData,
                      hydratedGlyphs: window.currentFontModel?.glyphs || []
                  })
                : window.currentFontModel?.glyphs || [];
        this.classifyGlyphs(plugin, glyphs);
        this.derivePluginResults(plugin);
        this.stampFilterCache(plugin);
    }

    private async applyCommittedChanges(
        plugin: GlyphFilterPlugin,
        changes: readonly GlyphFilterChange[]
    ): Promise<void> {
        const names = new Set<string>();
        for (const change of changes) {
            const glyphName = change.metadata.glyphName;
            if (plugin.eventTypes.includes(change.type)) {
                if (typeof glyphName === 'string') {
                    names.add(glyphName);
                }
            }
        }
        const glyphsToClassify: object[] = [];
        for (const name of names) {
            const glyph = window.currentFontModel?.findGlyph(name);
            if (glyph) {
                glyphsToClassify.push(glyph);
            } else {
                plugin.classifications.delete(name);
            }
        }
        if (glyphsToClassify.length > 0) {
            this.classifyGlyphs(plugin, glyphsToClassify);
        }
        this.derivePluginResults(plugin);
    }

    private classifyGlyphs(
        plugin: GlyphFilterPlugin,
        glyphs: ReadonlyArray<{ name?: string }>
    ): void {
        const namedGlyphs = glyphs.filter(
            (glyph): glyph is { name: string } =>
                typeof glyph?.name === 'string' && glyph.name.length > 0
        );
        if (namedGlyphs.length === 0) {
            return;
        }

        if (plugin.keyword === ALL_GLYPHS_FILTER_KEYWORD) {
            for (const glyph of namedGlyphs) {
                plugin.classifications.set(glyph.name, { groups: [] });
            }
            return;
        }

        this.ensureFilterSource(plugin);
        const pyodide = this.getFilterPyodide();
        pyodide.globals.set('__glyph_filter_glyphs', namedGlyphs);
        pyodide.globals.set(
            '__glyph_filter_use_candidate',
            plugin.hasCandidateFunction === true
        );
        pyodide.globals.set(
            '__glyph_filter_is_user',
            plugin.isUserFilter === true
        );
        if (plugin.isUserFilter) {
            pyodide.globals.set(
                '__glyph_filter_namespace',
                plugin.sourceNamespace
            );
        } else {
            pyodide.globals.set('__glyph_filter_instance', plugin.instance);
        }

        const raw = this.runFilterPython(FILTER_CLASSIFY_BATCH);
        try {
            const converted = this.toJsObject(raw);
            for (const [glyphName, classification] of Object.entries(
                converted
            )) {
                this.applyGlyphClassification(
                    plugin,
                    glyphName,
                    classification
                );
            }
        } finally {
            this.destroyPyProxy(raw);
        }
    }

    private applyGlyphClassification(
        plugin: GlyphFilterPlugin,
        glyphName: string,
        classification: unknown
    ): void {
        plugin.classifications.delete(glyphName);
        if (classification === false) {
            return;
        }
        if (classification === true) {
            plugin.classifications.set(glyphName, { groups: [] });
            return;
        }
        if (!classification || typeof classification !== 'object') {
            throw new Error(
                'classify_glyph() must return True, False, or a mapping with groups.'
            );
        }
        const groups = (classification as { groups?: unknown }).groups;
        if (!Array.isArray(groups) || groups.length === 0) {
            throw new Error(
                'A classification mapping must contain a non-empty groups list.'
            );
        }
        const normalizedGroups = groups.map((group) => {
            if (
                !group ||
                typeof group !== 'object' ||
                typeof (group as { name?: unknown }).name !== 'string' ||
                !(group as { name: string }).name.trim() ||
                typeof (group as { color?: unknown }).color !== 'string' ||
                !(group as { color: string }).color.trim()
            ) {
                throw new Error(
                    'Each classification group requires non-empty name and color strings.'
                );
            }
            return {
                name: (group as { name: string }).name,
                color: (group as { color: string }).color
            };
        });
        plugin.classifications.set(glyphName, { groups: normalizedGroups });
    }

    private getFilterPyodide(): FilterPyodide {
        const pyodide = window.pyodide as FilterPyodide | undefined;
        if (!pyodide) {
            throw new Error('Pyodide is not available.');
        }
        return pyodide;
    }

    private runFilterPython(code: string): unknown {
        const pyodide = this.getFilterPyodide();
        const run = pyodide._originalRunPython || pyodide.runPython;
        if (typeof run !== 'function') {
            throw new Error('Pyodide runPython is not available.');
        }
        return run.call(pyodide, code);
    }

    private toJsObject(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object') {
            return {};
        }
        const proxy = value as {
            toJs?: (options: {
                dict_converter: typeof Object.fromEntries;
                create_pyproxies?: boolean;
            }) => unknown;
        };
        const converted = proxy.toJs
            ? proxy.toJs({
                  dict_converter: Object.fromEntries,
                  create_pyproxies: false
              })
            : value;
        if (converted instanceof Map) {
            return Object.fromEntries(converted);
        }
        if (converted && typeof converted === 'object') {
            return converted as Record<string, unknown>;
        }
        return {};
    }

    private destroyPyProxy(value: unknown): void {
        const proxy = value as { destroy?: () => void };
        proxy?.destroy?.();
    }

    private ensureFilterSource(plugin: GlyphFilterPlugin): void {
        if (plugin.sourceLoaded) {
            return;
        }
        const pyodide = this.getFilterPyodide();
        plugin.sourceNamespace = `__glyph_filter_${plugin.keyword.replace(/[^A-Za-z0-9_]/g, '_')}`;
        pyodide.globals.set('__glyph_filter_namespace', plugin.sourceNamespace);
        let hasCandidate: unknown;
        if (plugin.isUserFilter) {
            pyodide.globals.set(
                '__glyph_filter_source',
                plugin.pythonCode || ''
            );
            hasCandidate = this.runFilterPython(FILTER_SOURCE_LOAD_USER);
        } else {
            pyodide.globals.set('__glyph_filter_instance', plugin.instance);
            hasCandidate = this.runFilterPython(FILTER_SOURCE_LOAD_INSTANCE);
        }
        plugin.hasCandidateFunction = hasCandidate === true;
        plugin.sourceLoaded = true;
    }

    private derivePluginResults(plugin: GlyphFilterPlugin): void {
        const groups: Record<string, GroupDefinition> = {};
        const results: FilterResult[] = [];
        for (const [glyphName, classification] of plugin.classifications) {
            const names: string[] = [];
            for (const group of classification.groups) {
                names.push(group.name);
                groups[group.name] = {
                    description: group.name,
                    color: group.color
                };
            }
            results.push({ glyph_name: glyphName, groups: names });
        }
        plugin.groups = groups;
        plugin.lastResults = results;
        plugin.glyphCount = results.length;
        plugin.hasError = false;
        plugin.hasNoFilterFunction = false;
    }

    /** Legacy internal adapter kept for count-refresh callers during migration. */
    private async executeFilter(
        plugin: GlyphFilterPlugin,
        _unusedSnapshot: string | null,
        _unusedBatch: GlyphFilterChangeBatch
    ): Promise<FilterExecutionResult> {
        await this.rebuildFilterCache(plugin);
        return {
            results: plugin.lastResults || [],
            groups: plugin.groups || {},
            status: 'ok'
        };
    }

    /**
     * Process filter results: consolidate duplicates, normalize groups, resolve colors
     * This is used by both runFilter and runPluginForCount to ensure consistent handling.
     * Also auto-generates group definitions for raw colors without definitions.
     */
    private processFilterResults(
        results: FilterResult[],
        groups: Record<string, GroupDefinition>
    ): {
        results: FilterResult[];
        usedGroupKeywords: Set<string>;
        augmentedGroups: Record<string, GroupDefinition>;
    } {
        // Consolidate results: merge entries for the same glyph name
        // This handles the case where a glyph is yielded multiple times with different groups
        const consolidatedMap = new Map<string, FilterResult>();
        for (const result of results) {
            const existing = consolidatedMap.get(result.glyph_name);
            if (existing) {
                // Merge groups from both entries
                const existingGroups =
                    existing.groups || (existing.group ? [existing.group] : []);
                const newGroups =
                    result.groups || (result.group ? [result.group] : []);
                // Combine and deduplicate groups
                const mergedGroups = [
                    ...new Set([...existingGroups, ...newGroups])
                ];
                existing.groups = mergedGroups;
                // Clear 'group' field since we now have 'groups' array
                delete existing.group;
            } else {
                consolidatedMap.set(result.glyph_name, { ...result });
            }
        }
        let processedResults = Array.from(consolidatedMap.values());

        // Create augmented groups that includes auto-generated definitions for raw colors
        const augmentedGroups: Record<string, GroupDefinition> = { ...groups };

        // Normalize results: ensure 'groups' array and resolve colors
        // and collect all used group keywords
        const usedGroupKeywords = new Set<string>();
        processedResults = processedResults.map((result) => {
            // Build the groups array from either 'groups' or 'group'
            let resultGroups: string[] = [];
            if (result.groups && Array.isArray(result.groups)) {
                resultGroups = result.groups;
            } else if (result.group) {
                resultGroups = [result.group];
            }

            // Collect used groups and auto-generate definitions for raw colors
            for (const g of resultGroups) {
                if (groups[g]) {
                    // Has a definition, use it
                    usedGroupKeywords.add(g);
                } else if (g) {
                    // No definition - check if the browser recognizes it as a valid CSS color
                    if (!augmentedGroups[g]) {
                        const isValidColor = this.isValidCssColor(g);
                        augmentedGroups[g] = {
                            description: g,
                            color: isValidColor ? g : '' // Empty string = no color
                        };
                    }
                    usedGroupKeywords.add(g);
                }
            }

            // Resolve group keywords to colors
            // Priority: 1) Match group definition key → use its color (if defined)
            //           2) No color defined → skip (no coloration)
            const resolvedColors: string[] = [];
            for (const g of resultGroups) {
                if (augmentedGroups[g] && augmentedGroups[g].color) {
                    resolvedColors.push(augmentedGroups[g].color);
                }
                // If no color defined, don't add anything - no coloration for this group
            }

            return {
                ...result,
                groups: resultGroups,
                color: resolvedColors[0] || undefined, // Primary color for display
                colors: resolvedColors.length > 0 ? resolvedColors : undefined
            };
        });

        return {
            results: processedResults,
            usedGroupKeywords,
            augmentedGroups
        };
    }

    /**
     * Check if a string is a valid CSS color by asking the browser to parse it
     * Returns true for hex, rgb(), hsl(), and named colors like 'red', 'lightblue'
     */
    private isValidCssColor(value: string): boolean {
        // Use a temporary element to test if browser recognizes the color
        const tempEl = document.createElement('div');
        tempEl.style.color = '';
        tempEl.style.color = value;
        // If the browser accepted the color, the style won't be empty
        // Note: invalid colors result in empty string
        return tempEl.style.color !== '';
    }

    /**
     * Update the glyph count display for a plugin
     */
    private updatePluginCount(plugin: GlyphFilterPlugin): void {
        // Find the plugin item by keyword attribute
        const item = this.sidebarContainer?.querySelector(
            `.glyph-filter-item[data-plugin-keyword="${plugin.keyword}"]`
        );
        if (!item) return;

        const count = item.querySelector('.glyph-filter-item-count');
        if (count) {
            if (plugin.hasError) {
                count.innerHTML =
                    '<span class="material-symbols-outlined glyph-filter-error-icon">warning</span>';
                count.classList.add('has-error');
            } else if (plugin.hasNoFilterFunction) {
                count.textContent = '—';
                count.classList.remove('has-error');
            } else {
                count.textContent = String(plugin.glyphCount ?? '—');
                count.classList.remove('has-error');
            }
        }
    }

    /**
     * Update the group legend section based on filter results
     */
    private updateGroupLegend(
        plugin: GlyphFilterPlugin,
        usedGroupKeywords: Set<string>
    ): void {
        if (!this.groupLegendContainer) return;

        // Clear existing content and reset group filters
        this.groupLegendContainer.innerHTML = '';
        this.activeGroupFilters.clear();
        this.groupElements.clear();

        // If no groups used, hide the container
        if (usedGroupKeywords.size === 0 || !plugin.groups) {
            this.groupLegendContainer.style.display = 'none';
            return;
        }

        // Count glyphs per group keyword (a glyph can be counted in multiple groups)
        const groupCounts = new Map<string, number>();
        if (plugin.lastResults) {
            for (const result of plugin.lastResults) {
                if (result.groups) {
                    for (const groupKeyword of result.groups) {
                        groupCounts.set(
                            groupKeyword,
                            (groupCounts.get(groupKeyword) || 0) + 1
                        );
                    }
                }
            }
        }

        // Show container and add legend items
        this.groupLegendContainer.style.display = '';

        for (const keyword of usedGroupKeywords) {
            const groupDef = plugin.groups[keyword];
            if (!groupDef) continue;

            const item = document.createElement('div');
            item.className = 'glyph-filter-legend-item';
            item.dataset.groupKeyword = keyword; // Store keyword for filtering
            item.dataset.groupHex = groupDef.color || ''; // Keep color for reference
            item.style.cursor = 'pointer';

            // Only show circle if there's a color defined
            if (groupDef.color) {
                const circle = document.createElement('span');
                circle.className = 'glyph-filter-legend-circle';
                circle.style.backgroundColor = groupDef.color;
                item.appendChild(circle);
            }

            const label = document.createElement('span');
            label.className = 'glyph-filter-legend-label';
            label.textContent = groupDef.description;

            const count = document.createElement('span');
            count.className = 'glyph-filter-legend-count';
            count.textContent = String(groupCounts.get(keyword) || 0);

            item.appendChild(label);
            item.appendChild(count);

            // Store element reference and keyword for later highlighting
            this.groupElements.set(keyword, item);
            item.dataset.groupKeyword = keyword;

            // Click to toggle group filter by keyword
            item.addEventListener('click', (e) => {
                this.toggleGroupFilter(keyword, item, e);
            });

            this.groupLegendContainer.appendChild(item);
        }

        // Update highlighting for currently selected glyphs
        this.updateGroupHighlighting();
    }

    /**
     * Toggle a group filter on/off by keyword.
     * Normal click: selects only the clicked group.
     * Shift/Cmd/Ctrl click: adds/removes the clicked group from multi-selection.
     */
    private toggleGroupFilter(
        groupKeyword: string,
        itemElement: HTMLElement,
        event?: MouseEvent
    ): void {
        const isMultiSelect =
            event?.shiftKey || event?.metaKey || event?.ctrlKey;

        if (isMultiSelect) {
            // Multi-select mode: toggle individual group
            if (this.activeGroupFilters.has(groupKeyword)) {
                this.activeGroupFilters.delete(groupKeyword);
                itemElement.classList.remove('active');
            } else {
                this.activeGroupFilters.add(groupKeyword);
                itemElement.classList.add('active');
            }
        } else {
            // Single-select mode: toggle if already selected, otherwise select only this group
            if (
                this.activeGroupFilters.has(groupKeyword) &&
                this.activeGroupFilters.size === 1
            ) {
                // Clicking on the only selected group - unselect it
                this.activeGroupFilters.clear();
                itemElement.classList.remove('active');
            } else {
                // Clear all active filters first
                this.activeGroupFilters.clear();

                // Remove active class from all legend items
                if (this.groupLegendContainer) {
                    this.groupLegendContainer
                        .querySelectorAll('.glyph-filter-legend-item.active')
                        .forEach((el: any) => el.classList.remove('active'));
                }

                // Add this group
                this.activeGroupFilters.add(groupKeyword);
                itemElement.classList.add('active');
            }
        }

        // Apply group filter to glyph overview
        this.applyGroupFilter();
    }

    /**
     * Clear all group filter selections
     */
    public clearGroupSelection(): void {
        this.activeGroupFilters.clear();

        // Remove active class from all legend items
        if (this.groupLegendContainer) {
            this.groupLegendContainer
                .querySelectorAll('.glyph-filter-legend-item.active')
                .forEach((el: any) => el.classList.remove('active'));
        }

        // Re-apply filter to show all results
        this.applyGroupFilter();
    }

    /**
     * Apply group filter to show only glyphs matching selected groups
     */
    private applyGroupFilter(): void {
        if (!this.glyphOverview || !this.activeFilter) return;

        const results = this.activeFilter.lastResults;
        if (!results) return;

        // If no groups selected, show all filter results
        if (this.activeGroupFilters.size === 0) {
            this.glyphOverview.setActiveFilter(results);
            return;
        }

        // Filter to only glyphs matching selected groups by keyword (OR logic)
        // A glyph passes if any of its groups match any of the selected group keywords
        const filteredResults = results.filter((result) => {
            if (!result.groups || result.groups.length === 0) return false;
            return result.groups.some((groupKeyword) =>
                this.activeGroupFilters.has(groupKeyword)
            );
        });

        this.glyphOverview.setActiveFilter(filteredResults);
    }

    /**
     * Update which groups are highlighted based on selected glyphs
     * Called from GlyphOverview when selection changes
     */
    public updateSelectedGlyphGroups(groups: Set<string>): void {
        this.selectedGlyphGroups = groups;
        this.updateGroupHighlighting();
    }

    /**
     * Update visual highlighting of group legend items based on selected glyphs
     */
    private updateGroupHighlighting(): void {
        if (!this.groupLegendContainer) return;

        // Update all group elements
        this.groupElements.forEach((element, keyword) => {
            if (this.selectedGlyphGroups.has(keyword)) {
                element.classList.add('selected-glyph-group');
            } else {
                element.classList.remove('selected-glyph-group');
            }
        });
    }

    /**
     * Refresh all plugins (re-run active filter and update counts)
     */
    async refreshPlugins(options: RefreshPluginsOptions = {}): Promise<void> {
        return this.enqueueFilterWork(() => this.refreshPluginsWork(options));
    }

    private async refreshPluginsWork(
        options: RefreshPluginsOptions = {}
    ): Promise<void> {
        const fontSnapshotJson = this.getCurrentFontSnapshotJson();
        if (!fontSnapshotJson) {
            this.scheduleRefreshRetry();
            return;
        }

        this.pluginRefreshInFlight = true;
        try {
            for (const plugin of this.getAllLoadedPlugins()) {
                if (!this.canUseCachedFilterResults(plugin)) {
                    this.invalidatePluginCache(plugin);
                }
            }

            if (this.activeFilter) {
                if (this.canUseCachedFilterResults(this.activeFilter)) {
                    this.applyCachedFilterResults(this.activeFilter);
                } else {
                    await this.runFilter(this.activeFilter);
                }
            }

            if (options.deferCounts) {
                this.deferredCountRefreshScheduled = true;
                await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 0);
                });
                this.deferredCountRefreshScheduled = false;
            }

            await this.refreshNonActivePluginCounts(fontSnapshotJson);
        } finally {
            this.finishOpenRecount();
        }
    }

    private finishOpenRecount(): void {
        this.pluginRefreshInFlight = false;
        this.openRecountPending = false;
    }

    private async refreshNonActivePluginCounts(
        fontSnapshotJson: string | null = null
    ): Promise<void> {
        const snapshotJson =
            fontSnapshotJson || this.getCurrentFontSnapshotJson();
        if (!snapshotJson) {
            this.scheduleRefreshRetry();
            return;
        }

        // Run all built-in plugins to update counts
        for (const plugin of this.plugins) {
            if (plugin === this.activeFilter) {
                continue;
            }
            await this.runPluginForCount(plugin, snapshotJson);
        }

        // Run all user filters to update counts
        for (const filter of this.userFilters) {
            if (filter === this.activeFilter) {
                continue;
            }
            await this.runPluginForCount(filter, snapshotJson);
        }
    }

    /**
     * Run a plugin just to get the count (without applying to overview)
     */
    private async runPluginForCount(
        plugin: GlyphFilterPlugin,
        fontSnapshotJson: string | null = null,
        changeBatch: GlyphFilterChangeBatch = FULL_FILTER_REBUILD_BATCH
    ): Promise<void> {
        if (!window.currentFontModel) return;
        if (plugin.validationDiagnostic) {
            plugin.hasError = true;
            plugin.glyphCount = 0;
            this.updatePluginCount(plugin);
            return;
        }

        const dataVersion = this.getCurrentDataVersion();
        if (this.canUseCachedFilterResults(plugin, dataVersion)) {
            plugin.glyphCount = plugin.lastResults?.length || 0;
            plugin.hasError = false;
            this.updatePluginCount(plugin);
            return;
        }

        const snapshotJson =
            fontSnapshotJson || this.getCurrentFontSnapshotJson();
        if (!snapshotJson) {
            this.scheduleRefreshRetry();
            return;
        }

        this.inFlightCountRequests += 1;
        try {
            const countTimeoutMs = this.FILTER_TIMEOUT_MS + 2000;
            const execResult = (await Promise.race([
                this.executeFilter(plugin, snapshotJson, changeBatch),
                new Promise<never>((_, reject) => {
                    window.setTimeout(() => {
                        reject(
                            new Error(
                                `Count refresh timeout after ${countTimeoutMs}ms`
                            )
                        );
                    }, countTimeoutMs);
                })
            ])) as FilterExecutionResult;
            if (execResult.status === 'not_needed') {
                return;
            }
            if (execResult.status === 'incremental') {
                this.mergeFilterGroups(plugin, execResult.groups);
                this.applyFilterDelta(plugin, execResult.delta);
                const { results: processedResults, augmentedGroups } =
                    this.processFilterResults(
                        plugin.lastResults || [],
                        plugin.groups || {}
                    );
                plugin.lastResults = processedResults;
                plugin.groups = augmentedGroups;
                plugin.glyphCount = processedResults.length;
                plugin.hasError = false;
                this.updatePluginCount(plugin);
                return;
            }
            const results = execResult.results;
            plugin.groups = execResult.groups;

            // Process results (consolidate duplicates, normalize groups)
            const groups = plugin.groups || {};
            const { results: processedResults, augmentedGroups } =
                this.processFilterResults(results, groups);

            plugin.glyphCount = processedResults.length;
            plugin.hasError = false;
            plugin.lastResults = processedResults;
            plugin.groups = augmentedGroups;
            plugin.cachedDataVersion =
                dataVersion === null ? undefined : dataVersion;
            plugin.cachedContextVersion = this.sharedPluginContextVersion;
            this.updatePluginCount(plugin);
        } catch (error) {
            console.error(
                `Error running plugin ${plugin.display_name} for count:`,
                error
            );
            plugin.hasError = true;
            this.updatePluginCount(plugin);
        } finally {
            this.inFlightCountRequests = Math.max(
                0,
                this.inFlightCountRequests - 1
            );
        }
    }

    private isPluginCountResolved(plugin: GlyphFilterPlugin): boolean {
        if (plugin.hasError || plugin.hasNoFilterFunction) {
            return true;
        }

        return (
            typeof plugin.glyphCount === 'number' &&
            Number.isFinite(plugin.glyphCount)
        );
    }

    getPluginCountResolutionStatus(): {
        loaded: boolean;
        inFlightCountRequests: number;
        deferredCountRefreshScheduled: boolean;
        refreshRetryPending: boolean;
        renderedPluginCount: number;
        unresolvedPlugins: Array<{
            keyword: string;
            displayName: string;
            hasError: boolean;
            hasNoFilterFunction: boolean;
            glyphCount: number | null;
        }>;
    } {
        const allLoadedPlugins = [...this.plugins, ...this.userFilters];
        const renderedKeywords = this.sidebarContainer
            ? Array.from(
                  this.sidebarContainer.querySelectorAll(
                      '.glyph-filter-item[data-plugin-keyword]'
                  )
              )
                  .map((item) =>
                      (item as HTMLElement).dataset.pluginKeyword?.trim()
                  )
                  .filter((keyword): keyword is string => Boolean(keyword))
            : [];

        const pluginsToValidate =
            renderedKeywords.length > 0
                ? allLoadedPlugins.filter((plugin) =>
                      renderedKeywords.includes(plugin.keyword)
                  )
                : allLoadedPlugins;

        const unresolvedPlugins = pluginsToValidate
            .filter((plugin) => !this.isPluginCountResolved(plugin))
            .map((plugin) => ({
                keyword: plugin.keyword,
                displayName: plugin.display_name,
                hasError: Boolean(plugin.hasError),
                hasNoFilterFunction: Boolean(plugin.hasNoFilterFunction),
                glyphCount:
                    typeof plugin.glyphCount === 'number'
                        ? plugin.glyphCount
                        : null
            }));

        return {
            loaded: this.loaded,
            inFlightCountRequests: this.inFlightCountRequests,
            deferredCountRefreshScheduled: this.deferredCountRefreshScheduled,
            refreshRetryPending: this.refreshRetryTimer !== null,
            renderedPluginCount: pluginsToValidate.length,
            unresolvedPlugins
        };
    }

    /**
     * Returns true once every currently loaded plugin has produced a stable count
     * (number, error state, or explicit no-filter-function state).
     */
    areAllLoadedPluginCountsResolved(): boolean {
        const status = this.getPluginCountResolutionStatus();

        if (!status.loaded) {
            return false;
        }

        if (status.refreshRetryPending) {
            return false;
        }

        if (status.deferredCountRefreshScheduled) {
            return false;
        }

        if (status.inFlightCountRequests > 0) {
            return false;
        }

        if (status.renderedPluginCount === 0) {
            return false;
        }

        return status.unresolvedPlugins.length === 0;
    }

    /**
     * Create a new filter file using file picker
     */
    private async createNewFilter(): Promise<void> {
        const adapter = settingsFolder.getAdapter();
        if (!this.isDiskAdapterLike(adapter) || !adapter.hasDirectory()) {
            alert('Settings Folder not available');
            return;
        }

        try {
            // Get the directory handle
            const dirHandle = adapter.getDirectoryHandle();
            if (!dirHandle) {
                alert('Directory handle not available');
                return;
            }

            // Navigate to Filters directory (create if doesn't exist)
            const filtersDirParts = this.USER_FILTERS_PATH.split('/').filter(
                (p) => p
            );
            let currentHandle = dirHandle;
            for (const part of filtersDirParts) {
                currentHandle = await currentHandle.getDirectoryHandle(part, {
                    create: true
                });
            }

            // Show save file picker starting from Filters directory
            const fileHandle = await (window as any).showSaveFilePicker({
                startIn: currentHandle,
                suggestedName: 'New Filter.py',
                types: [
                    {
                        description: 'Python Files',
                        accept: { 'text/x-python': ['.py'] }
                    }
                ]
            });

            // Get the relative path from the root
            let filePath = await this.getRelativePathFromHandle(
                dirHandle,
                fileHandle
            );

            // Ensure .py extension
            if (!filePath.endsWith('.py')) {
                filePath += '.py';
            }

            if (!filePath.startsWith(this.USER_FILTERS_PATH)) {
                alert(`Filter must be saved under ${this.USER_FILTERS_PATH}`);
                return;
            }

            // Extract filter name from file path
            const fileName = filePath.split('/').pop() || 'filter';
            const filterName = fileName.replace(/\.py$/, '');

            // Create empty filter file with template
            const template = createGlyphFilterTemplate(filterName);

            // Write file using the file handle
            markManagedFileInternalWrite(SETTINGS_FOLDER_SOURCE_ID, filePath);
            try {
                const writable = await fileHandle.createWritable();
                await writable.write(template);
                await writable.close();
            } catch (error) {
                cancelManagedFileInternalWrite(
                    SETTINGS_FOLDER_SOURCE_ID,
                    filePath
                );
                throw error;
            }

            console.log('[GlyphOverviewFilters] Created new filter:', filePath);

            // Trigger refresh; FileSystemObserver echo is suppressed via the
            // internal-write marker above.
            await this.discoverUserFilters();

            // Select the newly created filter
            setTimeout(() => {
                const newFilter = this.userFilters.find(
                    (f) => f.filePath === filePath
                );
                if (newFilter) {
                    const filterElement = this.sidebarContainer?.querySelector(
                        `.glyph-filter-item[data-plugin-keyword="${newFilter.keyword}"]`
                    ) as HTMLElement;
                    if (filterElement) {
                        this.activateFilter(newFilter, filterElement);
                    }
                }
            }, 300);
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[GlyphOverviewFilters] File creation cancelled');
                return;
            }
            console.error(
                '[GlyphOverviewFilters] Error creating filter:',
                error
            );
            alert(`Error creating filter: ${error.message}`);
        }
    }

    /**
     * Get relative path from root directory handle to a file handle
     */
    private async getRelativePathFromHandle(
        rootHandle: FileSystemDirectoryHandle,
        targetHandle: FileSystemFileHandle
    ): Promise<string> {
        // Try to resolve the path by checking if we can get to the target from root
        const path = await this.resolvePathRecursive(
            rootHandle,
            targetHandle,
            '/'
        );
        if (path) return path;
        throw new Error('Could not resolve file path');
    }

    /**
     * Recursively search for a file handle starting from a directory
     */
    private async resolvePathRecursive(
        dirHandle: FileSystemDirectoryHandle,
        targetHandle: FileSystemFileHandle,
        currentPath: string
    ): Promise<string | null> {
        for await (const [name, handle] of (dirHandle as any).entries()) {
            const itemPath =
                currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;

            if (
                handle.kind === 'file' &&
                (await this.isSameHandle(handle, targetHandle))
            ) {
                return itemPath;
            } else if (handle.kind === 'directory') {
                const result = await this.resolvePathRecursive(
                    handle,
                    targetHandle,
                    itemPath
                );
                if (result) return result;
            }
        }
        return null;
    }

    /**
     * Check if two file handles point to the same file
     */
    private async isSameHandle(
        handle1: FileSystemFileHandle,
        handle2: FileSystemFileHandle
    ): Promise<boolean> {
        try {
            return await handle1.isSameEntry(handle2);
        } catch {
            return false;
        }
    }

    /**
     * Rename a filter file
     */
    private async renameFilter(
        plugin: GlyphFilterPlugin,
        element: HTMLElement
    ): Promise<void> {
        const filePath = plugin.filePath;
        if (!filePath) return;

        const adapter = settingsFolder.getAdapter();
        if (!this.isDiskAdapterLike(adapter)) return;

        // Find the label element
        const labelElement = element.querySelector(
            '.glyph-filter-item-label'
        ) as HTMLElement;
        if (!labelElement) return;

        const originalName = plugin.display_name;
        const fileName = filePath.split('/').pop() || '';

        // Strip .py extension for display
        const displayName = fileName.endsWith('.py')
            ? fileName.slice(0, -3)
            : fileName;

        // Create inline input
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'glyph-filter-rename-input';
        input.value = displayName;

        // Replace label with input
        labelElement.style.display = 'none';
        labelElement.parentNode!.insertBefore(input, labelElement.nextSibling);
        input.focus();
        input.select();

        // Prevent click from propagating
        input.addEventListener('click', (e) => e.stopPropagation());

        // Flag to prevent multiple completions
        let isCompleting = false;

        // Handle rename completion
        const completeRename = async () => {
            if (isCompleting) return;
            isCompleting = true;

            let newName = input.value.trim();

            // Remove input, restore label (check if still in DOM)
            if (input.parentNode) {
                input.remove();
            }
            labelElement.style.display = '';

            if (!newName || newName === displayName) {
                return;
            }

            // Add .py extension if not present
            if (!newName.endsWith('.py')) {
                newName += '.py';
            }

            // Validate new name
            if (newName.includes('/') || newName.includes('\\')) {
                alert('Name cannot contain / or \\ characters');
                return;
            }

            try {
                await adapter.renameItem(filePath, newName, false);
                console.log(
                    '[GlyphOverviewFilters] Renamed:',
                    filePath,
                    '->',
                    newName
                );

                // File system observer will detect the rename and refresh automatically
            } catch (error: any) {
                console.error(
                    '[GlyphOverviewFilters] Error renaming filter:',
                    error
                );
                alert(`Error renaming filter: ${error.message}`);
            }
        };

        // Handle cancel
        const cancelRename = () => {
            if (isCompleting) return;
            isCompleting = true;

            if (input.parentNode) {
                input.remove();
            }
            labelElement.style.display = '';
        };

        // Enter to confirm, Escape to cancel
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                completeRename();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
            }
        });

        // Blur to confirm
        input.addEventListener('blur', completeRename);
    }

    /**
     * Delete a filter file
     */
    private async deleteFilter(plugin: GlyphFilterPlugin): Promise<void> {
        const filePath = plugin.filePath;
        if (!filePath) return;

        const fileName = filePath.split('/').pop() || '';

        // Confirm deletion
        if (
            !confirm(`Delete filter "${fileName}"?\n\nThis cannot be undone.`)
        ) {
            return;
        }

        const adapter = settingsFolder.getAdapter();
        if (!this.isDiskAdapterLike(adapter)) return;

        try {
            await adapter.deleteItem(filePath, false);
            console.log('[GlyphOverviewFilters] Deleted:', filePath);

            // If this filter is currently active, clear it
            if (this.activeFilter === plugin) {
                this.clearActiveFilter();
            }

            // File system observer will automatically detect the deletion and refresh
            // No need to manually call discoverUserFilters() here
        } catch (error: any) {
            console.error(
                '[GlyphOverviewFilters] Error deleting filter:',
                error
            );
            alert(`Error deleting filter: ${error.message}`);
        }
    }

    /**
     * Get the list of loaded plugins
     */
    getPlugins(): GlyphFilterPlugin[] {
        return this.plugins;
    }

    /**
     * Check if plugins have been loaded
     */
    isLoaded(): boolean {
        return this.loaded;
    }

    /**
     * Get the currently active filter
     */
    getActiveFilter(): GlyphFilterPlugin | null {
        return this.activeFilter;
    }

    /**
     * Clear the active filter
     */
    clearActiveFilter(): void {
        if (this.activeFilter) {
            const prevItem = this.sidebarContainer?.querySelector(
                '.glyph-filter-item.active'
            );
            prevItem?.classList.remove('active');
            this.activeFilter = null;
            this.saveActiveState();

            if (this.glyphOverview) {
                this.glyphOverview.setActiveFilter(null);
            }

            // Clear selected glyph groups highlighting
            this.selectedGlyphGroups.clear();
            this.updateGroupHighlighting();
        }
    }
}

// Create singleton instance
export const glyphOverviewFilterManager = new GlyphOverviewFilterManager();

// Make available on window for debugging
(window as any).glyphOverviewFilterManager = glyphOverviewFilterManager;
