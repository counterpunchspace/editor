import TabLifecycleManager from './tab-lifecycle.js';
import ThemeSwitcher from './theme-switcher.js';
import AIAssistant from './ai-assistant.js';
import CacheManager from './cache-manager.js';
import type { FontCompilation } from './font-compilation.js';
import FontManager from './font-manager.js';
import FontDropdownManager from './font-dropdown.js';
import { GlyphCanvas } from './glyph-canvas.js';
import MemoryMonitor from './memory-monitor.js';
import ResizableViews from './resizer.js';
import SaveButton from './save-button.js';
declare global {
    // Any property augmentation we make to the Window interface
    // should be declared here.
    interface Window {
        // From our dependencies
        opentype: any; // OpenType.js
        pyodide: any; // Pyodide
        createHarfBuzz: any; // HarfBuzz.js
        hbjs: any; // HarfBuzz.js
        hbInit: () => Promise<void>; // HarfBuzz.js

        // From ai-assistant.js
        aiAssistant: AIAssistant;

        // From auto-compile-manager.js
        autoCompileManager: {
            checkAndSchedule: () => void;
            setEnabled: (enabled: boolean) => void;
            scheduleCompilation: () => void;
            testDirtyCheck: () => void;
            forceTrigger: () => void;
            getStatus: () => {
                isEnabled: boolean;
                hasPendingCompile: boolean;
            };
        };

        // From cache-manager.js
        cacheManager: CacheManager;
        cacheStats: () => { size: number; itemCount: number };

        // From compile-button.js
        compileFontButton: {
            compile: () => void;
            updateState: () => void;
        };

        // From file-browser.js
        _trackingInitPromise: Promise<void> | null;
        navigateToPath: (path: string) => Promise<void>;
        selectFile: (filePath: string) => void;
        initFileBrowser: () => Promise<void>;
        uploadFiles: (files: File[], targetPath?: string) => Promise<void>;
        createFolder: () => Promise<void>;
        deleteItem: (
            itemPath: string,
            itemName: string,
            isDir: boolean
        ) => Promise<void>;
        handleFileUpload: (e: Event) => void;
        openFont: (path: string) => Promise<void>;
        downloadFile: (filePath: string, fileName: string) => Promise<void>;

        // From font-compilation.js
        fontCompilation: FontCompilation;
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

        // From file-browser.js
        refreshFileSystem: () => Promise<void>;

        // From font-manager.js
        fontManager: typeof FontManager;

        // From font-dropdown.js
        fontDropdownManager: FontDropdownManager;

        // From font-interpolation.js
        fontInterpolation: FontInterpolationManager;

        // From glyph-canvas.js
        glyphCanvas: GlyphCanvas;

        // From keyboard-navigation.js
        focusView: (viewId: string) => void;

        // From loading-animation.js
        updateLoadingStatus: (status: string, isReady: boolean) => void;
        WarpSpeedAnimation: {
            requestStop: (onCompleteHook: () => void) => void;
            instance: () => any; // WarpSpeedAnimation instance
        };

        // From matplotlib-handler.js
        showMatplotlibPlot: (element: HTMLElement) => void;
        closePlotModal: () => void;

        // From memory-monitor.js
        memoryMonitor: MemoryMonitor;
        MemoryMonitor: any; // MemoryMonitor class

        // From python-ui-sync.js
        setFontLoadingState: (loading: boolean) => void;

        // From pyodide-official-console.js
        consoleEcho: (msg: string, ...opts: any[]) => void;
        consoleError: (msg: string, ...opts: any[]) => void;
        term: any; // Terminal
        clearConsole: () => void;

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
            runScript: () => void;
            get editor(): any; // Ace Editor instance
        };

        // From settings.js
        APP_SETTINGS: Record<string, any>;

        // From sound-preloader.js
        preloadedSounds: Record<string, HTMLAudioElement>;
        playSound: (name: string) => void;
        setVolume: (volume: number) => void;
        getVolume: () => number;

        // From tab-lifecycle.js
        tabLifecycleManager: TabLifecycleManager;

        // From theme-switcher.js
        themeSwitcher: ThemeSwitcher;

        // From view-settings.js
        VIEW_SETTINGS: Record<string, any>;
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
}

export {};
