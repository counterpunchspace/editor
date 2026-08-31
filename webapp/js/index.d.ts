import TabLifecycleManager from './tab-lifecycle';
import ThemeSwitcher from './theme-switcher';
import AIAssistant from './ai-assistant';
import CacheManager from './cache-manager';
import type { FontCompilation } from './font-compilation';
import FontManager from './font-manager';
import { GlyphCanvas } from './glyph-canvas';
import ResizableViews from './resizer';
import SaveButton from './save-button';
import { Font } from './babelfont-model';
import type { StateManager, EditorState } from './state-manager';
import type { PatchSyncEngine } from './patch-sync-engine';
import type { WindowSync } from './window-sync';
import type { WindowRoleManager } from './window-role';
import type {
    CloudPlugin,
    CloudEligibility,
    CloudAsset
} from './filesystem-plugins/plugins/cloud-plugin';
import type { FindGlyphDialog } from './find-glyph-dialog';
import type { GlyphDataIndex } from './glyph-data';
import type { QaCorpusIndex } from './auto-qa/auto-qa-corpus';
import type { AddGlyphsDialog } from './add-glyphs-dialog';
import type { RenameGlyphsDialog } from './rename-glyphs-dialog';
import type { DeleteGlyphsDialog } from './delete-glyphs-dialog';
import type { KerningEditorDialog } from './kerning-editor-dialog';

declare global {
    var marked: any;
    var Diff: any;
    var Diff2HtmlUI: any;

    // Any property augmentation we make to the Window interface
    // should be declared here.
    interface Window {
        // Undo/redo & collaboration
        patchSyncEngine: PatchSyncEngine | undefined;
        changeBridge: PatchSyncEngine | undefined;
        windowSync: WindowSync | undefined;
        windowRole: WindowRoleManager | undefined;
        syncRustCacheAndRefreshCanvas:
            | ((
                  rootGlyphName?: string,
                  editedGlyphName?: string,
                  options?: {
                      skipDeferredCanvasRepaint?: boolean;
                      workerReplayTargets?: WorkerReplayTarget[];
                      allowSelectedLayerFallback?: boolean;
                  }
              ) => Promise<void>)
            | undefined;
        runBridgeUndoRedo:
            | ((
                  action: 'undo' | 'redo',
                  glyphName?: string,
                  refreshRootGlyphName?: string,
                  layerId?: string | null,
                  historyTargetKey?: string | null,
                  surface?:
                      | 'canvas'
                      | 'overview'
                      | 'font'
                      | 'feature'
                      | 'automation'
                      | null
              ) => Promise<void>)
            | undefined;
        getHistoryUndoContext:
            | (() => {
                  scope:
                      | 'font'
                      | 'glyph'
                      | 'layer'
                      | 'feature'
                      | 'overview'
                      | 'automation';
                  glyphName: string | null;
                  layerId: string | null;
                  historyTargetKey: string | null;
              })
            | undefined;
        getUndoRedoContext:
            | (() => {
                  rootGlyphName: string | undefined;
                  undoGlyphName: string | undefined;
                  undoLayerId: string | null;
                  historyTargetKey: string | null;
                  surface:
                      'canvas' | 'overview' | 'font' | 'feature' | 'automation';
              })
            | undefined;

        // From our dependencies
        opentype: any; // OpenType.js
        pyodide: any; // Pyodide
        __pyodideLoadPromise?: Promise<any>;
        __pyodideLoadStarted?: boolean;
        __startPyodideLoad?: () => void;
        __fontcWorker?: Worker;
        __fontcWorkerReadyPromise?: Promise<boolean>;
        __startFontcWorker?: () => void;
        createHarfBuzz: any; // HarfBuzz.js
        hbjs: any; // HarfBuzz.js
        hbInit: () => Promise<void>; // HarfBuzz.js
        initFontEditor: () => Promise<boolean>;

        // From index.html helper functions
        isDevelopment: () => boolean;
        isProduction: () => boolean;
        /** True when the URL has `?test=` (`isTestMode`). Not `navigator.webdriver`. */
        isTestMode: () => boolean;
        isTest: () => boolean;
        __liveTextDiagnostics:
            | {
                  enabled: boolean;
                  entries: import('./live-text-diagnostics').LiveTextDiagnosticEntry[];
              }
            | undefined;

        // From perf-timeline.ts
        timelineMark: (
            stage: string,
            context?: {
                process?: string;
                traceId?: string;
                parentSpanId?: string;
                requestId?: string;
                fontRevisionKey?: string;
            }
        ) => void;
        timelineSpanStart: (
            stage: string,
            detail?:
                | Record<string, unknown>
                | {
                      detail?: Record<string, unknown>;
                      context?: {
                          process?: string;
                          traceId?: string;
                          parentSpanId?: string;
                          requestId?: string;
                          fontRevisionKey?: string;
                      };
                  },
            context?: {
                process?: string;
                traceId?: string;
                parentSpanId?: string;
                requestId?: string;
                fontRevisionKey?: string;
            }
        ) => string;
        timelineSpanEnd: (spanId: string) => void;
        dumpCodeLoadingTimeline: () => import('./perf-timeline').CodeLoadingTimelineDump;

        // Build metadata
        EDITOR_VERSION: string | null;
        __pendingUpdate: {
            version: string;
            tag?: string;
            isPreview: boolean;
        } | null;
        BUILD_HASH_FULL: string | null;
        BUILD_HASH_SHORT: string | null;
        WORKTREE_NAME: string;

        // From ai-assistant.ts
        aiAssistant: AIAssistant;

        // From file-browser.ts
        showFontFileDialog:
            | ((options?: {
                  mode?: 'open' | 'save-as';
                  pluginId?: string;
                  path?: string;
                  highlightPath?: string;
                  suggestedName?: string;
              }) => Promise<void>)
            | undefined;
        closeFontFileDialog: (() => void) | undefined;
        locatePathInFileDialog:
            ((pluginId: string, fullPath: string) => Promise<void>) | undefined;

        // From auth-manager.ts
        authManager: {
            websiteURL: string;
            user: { email?: string; [key: string]: unknown } | null;
            subscription: {
                isAdvanced?: boolean;
                [key: string]: unknown;
            } | null;
            credits: {
                amountCents?: number;
                overageAllowed?: boolean;
                [key: string]: unknown;
            } | null;
            checkAuthStatus: () => Promise<{
                email?: string;
                [key: string]: unknown;
            } | null>;
            isLocalWebsiteURL: () => boolean;
            bootstrapLocalCloudSession: (email?: string) => Promise<{
                email?: string;
                [key: string]: unknown;
            } | null>;
            ensureCloudSession: (options?: {
                localEmail?: string;
                allowLoginRedirect?: boolean;
            }) => Promise<{
                email?: string;
                [key: string]: unknown;
            } | null>;
            getSessionToken: () => string | null;
            login: () => Promise<void>;
            logout: () => Promise<void>;
            isAuthenticated: () => boolean;
            getUser: () => { email?: string; [key: string]: unknown } | null;
            onAuthStateChanged: (
                isAuthenticated: boolean,
                user: { email?: string; [key: string]: unknown } | null,
                subscription: {
                    isAdvanced?: boolean;
                    [key: string]: unknown;
                } | null
            ) => void;
            updateSettingsUI: (
                isAuthenticated: boolean,
                user: { email?: string; [key: string]: unknown } | null,
                subscription: {
                    isAdvanced?: boolean;
                    [key: string]: unknown;
                } | null
            ) => void;
        };

        // From auto-compile-manager.js
        autoCompileManager: {
            checkAndSchedule: () => void;
            setEnabled: (enabled: boolean) => void;
            setStartupBlocked: (blocked: boolean) => void;
            scheduleCompilation: () => void;
            testDirtyCheck: () => void;
            forceTrigger: () => void;
            getStatus: () => {
                isEnabled: boolean;
                isCompiling: boolean;
                loopRunning: boolean;
                isStartupBlocked: boolean;
            };
        };

        // From cache-manager.js
        cacheManager: CacheManager;
        cacheStats: () => Record<string, unknown>;

        // From save-button.ts
        saveButton: SaveButton;

        // From python-utils.js
        cleanPythonTraceback: (
            errorMessage: string,
            options?: number | { lineOffset?: number; skipExecFrames?: boolean }
        ) => string;
        sanitizePythonRuntimeError: (errorMessage: string) => string;
        adjustTracebackLineNumbers: (
            errorMessage: string,
            lineOffset: number,
            framePatterns?: string[]
        ) => string;
        countCodeLines: (code: string) => number;

        // From system-notifications.ts
        getSystemNotificationPermission: () => import('./system-notifications').SystemNotificationPermission;
        requestSystemNotificationPermission: () => Promise<
            import('./system-notifications').SystemNotificationPermission
        >;
        showSystemNotification: (
            title: string,
            options?:
                | import('./system-notifications').SystemNotificationOptions
                | string
        ) => Promise<import('./system-notifications').SystemNotificationResult>;

        // From critical-error-handler.ts
        showCriticalError: (
            title: string,
            message: string,
            instructions: string
        ) => void;
        isWebAssemblyMemoryError: (error: Error) => boolean;

        // From canvas-plugin-manager.ts
        canvasPluginManager: {
            discoverPlugins: () => Promise<void>;
            drawPluginsAbove: (
                layerData: any,
                glyphName: string,
                ctx: CanvasRenderingContext2D,
                viewportManager: any
            ) => Promise<void>;
            drawPluginsBelow: (
                layerData: any,
                glyphName: string,
                ctx: CanvasRenderingContext2D,
                viewportManager: any
            ) => Promise<void>;
            getPluginInstance: (entryPoint: string) => any;
            getPlugins: () => any[];
            isLoaded: () => boolean;
            isPluginEnabled: (entryPoint: string) => boolean;
            enablePlugin: (entryPoint: string) => void;
            disablePlugin: (entryPoint: string) => void;
            togglePlugin: (entryPoint: string) => boolean;
        };

        windowUi: {
            getCanvasPluginParam: (
                className: string,
                paramId: string
            ) => string | null;
            setCanvasPluginParam: (
                className: string,
                paramId: string,
                value: string
            ) => void;
            getEnabledCanvasPluginIds: () => string[];
            setEnabledCanvasPluginIds: (ids: string[]) => void;
            getState: () => import('./window-ui-state').WindowUiState;
            save: () => void;
            apply: (ui?: import('./window-ui-state').WindowUiState) => void;
        };

        // From editor-plugins-ui.js
        editorPluginsUI: {
            updatePluginList: () => void;
        };

        // From glyph-overview-filters.ts
        glyphOverviewFilterManager: {
            initialize: (
                sidebarContainer: HTMLElement,
                glyphOverview: any,
                groupLegendContainer?: HTMLElement
            ) => void;
            discoverPlugins: () => Promise<void>;
            discoverUserFilters: (
                skipObserverSetup?: boolean,
                renamedToDisplayName?: string | null
            ) => Promise<void>;
            refreshPlugins: (options?: {
                deferCounts?: boolean;
            }) => Promise<void>;
            getPlugins: () => any[];
            isLoaded: () => boolean;
            getActiveFilter: () => any | null;
            clearActiveFilter: () => void;
            updateSelectedGlyphGroups: (groups: Set<string>) => void;
            clearGroupSelection: () => void;
            syncWorkerPackages: (packages: string[]) => Promise<void>;
            setSharedPluginContext: (context: Record<string, any>) => void;
            updateSharedPluginContext: (patch: Record<string, any>) => void;
            getSharedPluginContext: () => Record<string, any>;
            handleCommittedChangeEntries: (
                entries: Array<{
                    path: string;
                    op: string;
                    oldValue: unknown;
                    newValue: unknown;
                }>
            ) => Promise<void>;
        };

        // From glyph-overview.ts / overview-view.ts
        GlyphOverview: new (container: HTMLElement) => any;
        glyphOverviewInstance: any;

        // From glyph-data.ts
        glyphDataIndex: GlyphDataIndex;
        qaCorpusIndex: QaCorpusIndex;
        addGlyphsDialog: AddGlyphsDialog;
        renameGlyphsDialog: RenameGlyphsDialog;
        deleteGlyphsDialog: DeleteGlyphsDialog;
        kerningEditorDialog: KerningEditorDialog;

        // From file-browser.js
        navigateToPath: (
            path: string,
            highlightFolder?: string
        ) => Promise<void>;
        navigateToParent: () => Promise<void>;
        selectFile: (filePath: string) => void;
        initFileBrowser: () => Promise<void>;
        waitForFileBrowserReady: (timeoutMs?: number) => Promise<void>;
        uploadFiles: (
            files: File[] | FileList,
            targetPathOrOptions?:
                | string
                | null
                | {
                      directory?: string | null;
                      pluginId?: string;
                      skipRefresh?: boolean;
                  }
        ) => Promise<void>;
        createFolder: () => Promise<void>;
        createFile: () => Promise<void>;
        deleteItem: (
            itemPath: string,
            itemName: string,
            isDir: boolean
        ) => Promise<void>;
        handleFileUpload: (e: Event) => void;
        openFont: (
            path: string,
            fileHandle?: FileSystemFileHandle,
            options?: { sourcePluginOverride?: any }
        ) => Promise<void>;
        downloadFile: (filePath: string, fileName: string) => Promise<void>;
        selectDiskFolder: () => Promise<void>;
        reEnableAccess: () => Promise<void>;
        parseFileUri: (
            uri: string
        ) => { pluginId: string; path: string } | null;

        // From font-compilation.js
        fontCompilation: FontCompilation;
        fullFontCompilation: FontCompilation;
        compileFontFromPython: (command: string) => Promise<any>;
        compileFontDirect: (
            fontVarName: string,
            outputFile: string
        ) => Promise<Uint8Array>;
        compileFontFromJson: (
            json: any,
            outputFile: string
        ) => Promise<Uint8Array>;
        shapeTextWithFont: (
            fontBytes: Uint8Array,
            text: string
        ) => Promise<string[]>;
        shapeTextWithFontDetailed: (
            fontBytes: Uint8Array,
            text: string,
            options?: {
                features?: string[] | string;
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

        // From file-browser.js
        refreshFileSystem: () => Promise<void>;

        // From font-manager.js
        fontManager: FontManager;

        // From state-manager.ts
        stateManager: StateManager & {
            focused_view: string;
            editor_file: string;
            editor_text_buffer: string;
            editor_cursor_position: number;
            editor_mode: 'text' | 'edit';
            editor_glyph_stack: string;
            editor_harfbuzz_glyph_names: string;
            editor_harfbuzz_gids: string;
            editor_harfbuzz_dx: string;
            editor_harfbuzz_dy: string;
            editor_harfbuzz_ax: string;
            editor_harfbuzz_ay: string;
            editor_harfbuzz_cl: string;
            editor_isInterpolating: boolean;
            editor_isAnimating: boolean;
            editor_opentype_features_in_subset: Record<string, boolean>;
            editor_opentype_features_not_in_subset: Record<string, boolean>;
            editor_variation_location: import('./locations').UserspaceLocation;
            editor_active_canvas_plugins: string[];
            editor_line_height: number;
            editor_text_align: 'left' | 'center' | 'right';
            syncUrlNow: () => void;
            [key: string]: any;
        };

        // From babelfont-model.js
        currentFontModel: Font | null;

        // From font-interpolation.js
        fontInterpolation: FontInterpolationManager;

        // From font-info.ts
        fontInfoManager: {
            updateEditorTheme: (theme: 'light' | 'dark') => void;
            refreshVisibleContentForExternalSync: () => void;
            getHistoryScopeTarget: () => {
                type: 'prefix' | 'class' | 'feature';
                key: string;
                label: string;
            } | null;
            showFeatureCompilationError: (errorInput: unknown) => void;
            clearFeatureErrorHighlight: () => void;
            getFeatureCompilationErrorLocation: (errorInput: unknown) => {
                type: 'prefix' | 'class' | 'feature';
                label: string;
            } | null;
            getFeatureCompilationErrorDetails: (errorInput: unknown) => {
                type: 'prefix' | 'class' | 'feature' | null;
                label: string;
                message: string;
            } | null;
            openFeatureCompilationError: (errorInput: unknown) => void;
        };

        // From glyph-canvas.js
        glyphCanvas: GlyphCanvas;
        editorHealth: typeof import('./editor-health-monitor').editorHealth;
        findGlyphDialog: FindGlyphDialog;

        // From keyboard-navigation.js
        focusView: (
            viewId: string,
            viaKeyboard?: boolean,
            options?: { skipExpand?: boolean }
        ) => void;
        restoreFocusedViewDomFocus: () => void;
        getViewVisitOrder: () => { top: string[]; bottom: string[] };
        setViewVisitOrder: (visitOrder: {
            top?: string[];
            bottom?: string[];
        }) => void;

        // From bootstrap.ts (loading status)
        updateLoadingStatus: (message: string, isReady?: boolean) => void;

        // From matplotlib-handler.js
        showMatplotlibPlot: (element: HTMLElement) => void;
        closePlotModal: () => void;

        // From python-ui-sync.js
        setFontLoadingState: (loading: boolean) => void;
        pythonExecutionHistoryContext: {
            beforeFontDataJson: string | null;
            code: string | null;
            label: string;
            startedAt: number;
            historySummary?: string | null;
            transactionStarted: boolean;
            releaseRecordingSuppression: (() => void) | null;
        } | null;

        // From pyodide-official-console.js
        consoleEcho: (msg: string, ...opts: any[]) => void;
        consoleError: (msg: string, ...opts: any[]) => void;
        term: any; // Terminal
        clearConsole: () => void;
        mountDirectory: () => Promise<void>;
        getMountedDirectoryInfo: () => Promise<Record<string, unknown>>;
        unmountDirectory: () => Promise<string>;

        // From python-execution-wrapper.js
        beforePythonExecution?: (code?: string) => void | Promise<void>;
        afterPythonExecution?: (outcome?: {
            succeeded: boolean;
        }) => void | Promise<void>;
        __counterpunchPythonPostExecutionHookInstalled?: boolean;

        // From example-loader.ts
        loadExampleFonts: () => Promise<void>;

        // From editor-startup-ready.ts
        __fontEditorReadyState?: 'pending' | 'ready' | 'failed';
        __fontEditorReadyError?: Error | null;

        // From resizer.js
        resizableViews: ResizableViews;

        // From save-button.js
        _fontSaveCallbacks: {
            beforeSave: (fontId: string, filename: string) => void;
            afterSave: (
                fontId: string,
                filename: string,
                duration: number
            ) => void;
            onError: (fontId: string, filename: string, error: string) => void;
        };
        saveButton: SaveButton;

        // From script-editor.js
        ace: any; // Ace
        scriptEditor: {
            getDocumentState: () => {
                content: string;
                kind: 'general-script' | 'glyph-filter';
                path: string | null;
                revision: string;
                isModified: boolean;
            };
            setDocumentKind: (kind: 'general-script' | 'glyph-filter') => void;
            createDraft: (
                kind: 'general-script' | 'glyph-filter',
                content?: string
            ) => void;
            revertToSaved: () => boolean;
            replaceExactText: (
                oldText: string,
                newText: string,
                expectedRevision: string
            ) => {
                content: string;
                kind: 'general-script' | 'glyph-filter';
                path: string | null;
                revision: string;
                isModified: boolean;
            };
            runScript: () => void;
            openFile: (path: string, pluginId: string) => Promise<boolean>;
            openFileFromUri: (uri: string) => Promise<boolean>;
            newFile: () => Promise<void>;
            save: () => Promise<boolean>;
            saveAs: () => Promise<boolean>;
            updateFilePath: (newPath: string) => void;
            get editor(): any; // Ace Editor instance
            get isModified(): boolean;
            get currentFilePath(): string | null;
            get currentPluginId(): string | null;
        };

        runPythonScriptDialog: {
            open: () => Promise<void>;
            reRunLast: () => Promise<void>;
            getLastRun: () => { path: string; title: string } | null;
        };

        // From file-browser.ts
        pluginRegistry: {
            get: (id: string) => any;
            getDefault: () => any;
            getAll: () => any[];
            getIds: () => string[];
        };
        fileBrowser: {
            getCurrentPlugin: () => any;
            getCurrentPath: () => string;
        };
        applyFontsFolderSelection: (options?: {
            source?: 'attach' | 'settings';
        }) => Promise<void>;

        // From index.html (inline script)
        isDevelopment: () => boolean;
        isProduction: () => boolean;
        /** True when the URL has `?test=` (`isTestMode`). Not `navigator.webdriver`. */
        isTestMode: () => boolean;
        isTest: () => boolean;

        // From settings.js
        APP_SETTINGS: Record<string, any>;

        // From tab-lifecycle.js
        tabLifecycleManager: TabLifecycleManager;

        // From theme-switcher.js
        themeSwitcher: ThemeSwitcher;

        // From translations.ts
        translations: {
            ai: {
                buttons: {
                    reviewChanges: {
                        text: string;
                        title: string;
                    };
                    openInEditor: {
                        text: string;
                        title: string;
                    };
                };
            };
        };

        // From docs-viewer.ts
        docsViewer: import('./docs-viewer').DocsViewer | undefined;
        openDocs: (id?: string, heading?: string) => Promise<void>;
        closeDocs: () => void;

        // From view-settings.js
        VIEW_SETTINGS: Record<string, any>;

        // From keyboard-navigation.js
        resizeView: (viewId: string) => void;
        collapseActiveView: (viewId: string) => void;
        getCurrentFocusedView: () => string | null;

        // From view-title-buttons.ts
        updateViewTitleButtonVisibility: (viewId: string) => void;

        // From filesystem-plugins/plugins/cloud-plugin.ts — Phase 1 cloud storage
        cloudPlugin: CloudPlugin | undefined;

        // From filesystem-plugins/plugins/cloud-plugin.ts — dev helper for Phase 0/1 cloud testing
        cloudDebug:
            | {
                  bootstrapLocalSession: (email?: string) => Promise<{
                      sessionToken: string;
                      user: {
                          id: string;
                          email: string;
                          name: string | null;
                      };
                  }>;
                  connectToRoom: (assetId: string) => Promise<void>;
                  connectWithToken: (
                      assetId: string,
                      token: string,
                      roomUrl: string
                  ) => Promise<void>;
                  disconnectFromRoom: () => void;
                  getStatus: () => string;
              }
            | undefined;
    }
}

/**
 * Font Interpolation Manager
 */
interface FontInterpolationManager {
    setWorker(worker: Worker): void;
    interpolateGlyph(
        glyphName: string,
        location: Record<string, number>
    ): Promise<any>;
    interpolateGlyphs(
        glyphNames: string[],
        location: Record<string, number>
    ): Promise<Map<string, any>>;
    clearCache(): Promise<void>;
    handleWorkerMessage(e: MessageEvent): void;
    pendingRequests: Map<
        number,
        {
            glyphName: string;
            requestKey: string;
            queuedAt: number;
        }
    >;
}

declare module 'bidi-js' {
    interface BidiEmbeddingLevels {
        levels: number[];
    }

    interface BidiApi {
        getEmbeddingLevels(text: string): BidiEmbeddingLevels;
        getReorderedIndices(
            text: string,
            levels: BidiEmbeddingLevels
        ): number[];
    }

    type BidiFactory = () => BidiApi;

    const bidiFactory: BidiFactory;
    export default bidiFactory;
}

export {};
