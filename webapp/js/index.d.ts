declare global {
    // Any property augmentation we make to the Window interface
    // should be declared here.
    interface Window {
        // From our dependencies
        opentype: any; // OpenType.js
        pyodide: any; // Pyodide
        bidi_js: any; // bidi-js
        createHarfBuzz: any; // HarfBuzz.js
        hbjs: any; // HarfBuzz.js

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
        _trackingInitPromise: Promise<void>;

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

        // From font-manager.js
        fontManager: FontManager;

        // From font-dropdown.js
        fontDropdownManager: FontDropdownManager;

        // From glyph-canvas.js
        glyphCanvas: GlyphCanvas;

        // From keyboard-navigation.js
        focusView: (viewId: string) => void;

        // From loading-animation.js
        updateLoadingStatus: (status: string, isReady: boolean = false) => void;
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

export {};
