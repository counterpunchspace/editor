// Filesystem plugin base class and shared types.
// Each plugin is a different file access method (OPFS, disk, cloud, etc.).

import type { FileSystemAdapter } from '../file-system-adapter';

/**
 * Title bar menu item for plugin-specific actions
 */
export interface TitleBarMenuItem {
    label: string;
    action: () => Promise<void>;
    icon?: string; // Optional Material icon name
}

export type FileContextAction =
    | 'open'
    | 'open-new-tab'
    | 'open-in-script-editor'
    | 'download'
    | 'rename'
    | 'delete';

export interface FileContextTarget {
    path: string;
    name: string;
    isDir: boolean;
}

export interface PluginMessageOptions {
    icon: string;
    title: string;
    message: string;
    detail?: string;
    tone?: 'info' | 'warning' | 'error';
    actionLabel?: string;
    onAction?: () => void;
    spinning?: boolean;
}

export interface CanAddGlyphsResult {
    allowed: boolean;
    remaining?: number | null;
    reason?: string;
}

export interface FilesystemPluginUICallbacks {
    showOpenFolderUI: () => void;
    hideOpenFolderUI: () => void;
    showPermissionBanner: (show: boolean) => void;
    showUnsupportedBrowserUI: () => void;
    hideUnsupportedBrowserUI: () => void;
    showPluginMessage: (options: PluginMessageOptions) => void;
    hidePluginMessage: () => void;
}

/**
 * Abstract base class for filesystem plugins.
 * Hooks have safe defaults; subclasses override only what they need.
 */
export abstract class FilesystemPlugin {
    protected adapter: FileSystemAdapter;

    constructor(adapter: FileSystemAdapter) {
        this.adapter = adapter;
    }

    /** Unique identifier for this plugin (e.g., 'memory', 'disk', 'cloud') */
    abstract getId(): string;

    /** Display name shown in UI (e.g., 'Memory', 'Disk', 'Cloud Storage') */
    abstract getName(): string;

    /** Icon/emoji shown in UI (e.g., '🧠', '💾', '☁️') */
    abstract getIcon(): string;

    /** Get the underlying filesystem adapter */
    getAdapter(): FileSystemAdapter {
        return this.adapter;
    }

    /** Whether this plugin supports saving files */
    canSave(): boolean {
        return true;
    }

    /** Whether this plugin supports uploading files and folders */
    supportsUpload(): boolean {
        return true;
    }

    /** Whether this plugin supports creating new folders */
    supportsNewFolder(): boolean {
        return true;
    }

    /** Whether this plugin supports creating new empty files */
    supportsNewFile(): boolean {
        return true;
    }

    /** Whether this plugin requires user permission/authentication */
    requiresPermission(): boolean {
        return false;
    }

    /**
     * Called when plugin is activated (user switches to this context)
     * @returns true if activation successful, false if failed
     */
    async onActivate(): Promise<boolean> {
        return true;
    }

    /**
     * Called when plugin is deactivated (user switches away)
     */
    async onDeactivate(): Promise<void> {
        // Default: no cleanup needed
    }

    /**
     * Show plugin-specific setup UI (e.g., folder picker, login dialog)
     * @returns true if setup completed, false if cancelled
     */
    async showSetupUI(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        return true;
    }

    /**
     * Check if plugin is ready to use (has directory selected, authenticated, etc.)
     */
    async isReady(): Promise<boolean> {
        return true;
    }

    /**
     * Get the current root path for this plugin's context
     */
    getDefaultPath(): string {
        return '/';
    }

    /**
     * Whether this plugin can be closed (e.g., disconnect folder access)
     */
    canClose(): boolean {
        return false;
    }

    /**
     * Close/disconnect this plugin's access (e.g., clear folder handle)
     * Only called if canClose() returns true
     */
    async close(): Promise<void> {
        // Default: no-op
    }

    /**
     * Update UI elements specific to this plugin's state
     */
    async updateUI(uiCallbacks: FilesystemPluginUICallbacks): Promise<void> {
        uiCallbacks.hideOpenFolderUI();
        uiCallbacks.showPermissionBanner(false);
        uiCallbacks.hideUnsupportedBrowserUI();
        uiCallbacks.hidePluginMessage();
    }

    /**
     * Get title bar menu items for this plugin
     */
    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return [];
    }

    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        switch (action) {
            case 'open':
            case 'open-new-tab':
                return !target.isDir;
            case 'open-in-script-editor':
                return !target.isDir && target.name.endsWith('.py');
            case 'download':
                return !target.isDir;
            case 'rename':
            case 'delete':
                return true;
            default:
                return false;
        }
    }

    /**
     * Trigger a redraw of the title bar buttons for this plugin
     */
    redrawTitleBarButtons(): void {
        window.dispatchEvent(
            new CustomEvent('pluginTitleBarRedraw', {
                detail: { pluginId: this.getId() }
            })
        );
    }

    /** Whether the file dialog should show a manual refresh button. */
    showsManualRefreshButton(): boolean {
        return true;
    }

    /** Whether this plugin should be visible in editor UI surfaces. */
    isVisibleInUI(): boolean {
        return true;
    }

    /**
     * Whether this plugin supports opening files via a file picker dialog
     * If false, files can only be opened via the Files view context menu
     */
    supportsOpenFilePicker(): boolean {
        return false;
    }

    /**
     * Whether this plugin supports Save As via a file picker dialog
     * If false, only Save (to existing path) is supported
     */
    supportsSaveAsFilePicker(): boolean {
        return false;
    }

    /**
     * Whether this plugin handles Save As internally (bypassing writeFile).
     * When true, the file dialog calls handleSaveAs(name) instead of
     * adapter.writeFile(path, content).
     */
    get interceptsSaveAs(): boolean {
        return false;
    }

    /**
     * Plugin-specific Save As handler, called instead of adapter.writeFile
     * when interceptsSaveAs is true.
     */
    async handleSaveAs(_name: string): Promise<boolean> {
        return false;
    }

    /**
     * Plugin-specific open handler for paths that cannot be read through the
     * generic adapter.readFile pipeline.
     * Return true when the plugin fully handled the open.
     */
    async handleOpenPath(_path: string): Promise<boolean> {
        return false;
    }

    /**
     * Refresh plugin-owned data (catalog, indexes) before Save or seed.
     */
    async prepareToSave(): Promise<void> {
        // Default: nothing extra to prepare
    }

    async prepareToSeed(): Promise<void> {
        await this.prepareToSave();
    }

    /**
     * Whether `additionalGlyphCount` new glyphs may be added under this backend.
     */
    async canAddGlyphs(
        additionalGlyphCount: number
    ): Promise<CanAddGlyphsResult> {
        void additionalGlyphCount;
        return { allowed: true };
    }

    /**
     * Sync view of {@link canAddGlyphs} for model mutations that cannot await.
     * Cloud uses live glyph count vs the last known owner cap.
     */
    getCachedCanAddGlyphs(additionalGlyphCount: number): CanAddGlyphsResult {
        void additionalGlyphCount;
        return { allowed: true };
    }

    /**
     * Return a copy of font JSON without this plugin's owned extra data.
     * Used when Save As targets a different plugin.
     */
    stripOwnedFontData<T>(fontJson: T): T {
        return fontJson;
    }

    /**
     * Open a file picker dialog and return the selected file path
     * Only called if supportsOpenFilePicker() returns true
     */
    async showOpenFilePicker(_options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        return null;
    }

    /**
     * Show a save file picker dialog and return the selected file path
     * Only called if supportsSaveAsFilePicker() returns true
     */
    async showSaveFilePicker(_options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
        suggestedName?: string;
    }): Promise<string | null> {
        return null;
    }
}
