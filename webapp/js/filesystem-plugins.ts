// Filesystem Plugin Architecture
// Defines extensible plugin system for different filesystem access methods

import type { FileSystemAdapter } from './file-system-adapter';
import { OPFSAdapter, NativeAdapter } from './file-system-adapter';

/**
 * Abstract base class for filesystem plugins
 * Each plugin represents a different method of accessing files (OPFS, disk, cloud, etc.)
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
        return true; // Default: all plugins can save
    }

    /** Whether this plugin requires user permission/authentication */
    requiresPermission(): boolean {
        return false; // Default: no permission needed
    }

    /**
     * Called when plugin is activated (user switches to this context)
     * Override to perform setup, check permissions, etc.
     * @returns true if activation successful, false if failed
     */
    async onActivate(): Promise<boolean> {
        return true; // Default: always succeeds
    }

    /**
     * Called when plugin is deactivated (user switches away)
     * Override to perform cleanup
     */
    async onDeactivate(): Promise<void> {
        // Default: no cleanup needed
    }

    /**
     * Show plugin-specific setup UI (e.g., folder picker, login dialog)
     * @returns true if setup completed, false if cancelled
     */
    async showSetupUI(): Promise<boolean> {
        return true; // Default: no setup needed
    }

    /**
     * Check if plugin is ready to use (has directory selected, authenticated, etc.)
     */
    async isReady(): Promise<boolean> {
        return true; // Default: always ready
    }

    /**
     * Get the current root path for this plugin's context
     */
    getDefaultPath(): string {
        return '/'; // Default: root
    }
}

/**
 * Memory Plugin - uses OPFS (Origin Private File System) for browser storage
 */
export class MemoryPlugin extends FilesystemPlugin {
    constructor() {
        super(new OPFSAdapter());
    }

    getId(): string {
        return 'memory';
    }

    getName(): string {
        return 'Memory';
    }

    getIcon(): string {
        return '🧠';
    }

    getDefaultPath(): string {
        return '/user'; // Memory context starts in /user folder
    }
}

/**
 * Disk Plugin - uses File System Access API for direct disk access
 */
export class DiskPlugin extends FilesystemPlugin {
    private nativeAdapter: NativeAdapter;

    constructor() {
        const adapter = new NativeAdapter();
        super(adapter);
        this.nativeAdapter = adapter;
    }

    getId(): string {
        return 'disk';
    }

    getName(): string {
        return 'Disk';
    }

    getIcon(): string {
        return '💾';
    }

    requiresPermission(): boolean {
        return true;
    }

    async onActivate(): Promise<boolean> {
        // Check if directory is already selected
        const isReady = await this.isReady();
        if (!isReady) {
            // Will show setup UI via file-browser
            return false;
        }

        // Check permissions
        const hasPermission = await this.nativeAdapter.checkPermission();
        if (!hasPermission) {
            // Will show permission banner via file-browser
            return false;
        }

        return true;
    }

    async showSetupUI(): Promise<boolean> {
        // Show directory picker
        try {
            await this.nativeAdapter.selectDirectory();
            return true;
        } catch (error) {
            console.error('[DiskPlugin] Setup cancelled or failed:', error);
            return false;
        }
    }

    async isReady(): Promise<boolean> {
        return await this.nativeAdapter.hasDirectory();
    }

    getDefaultPath(): string {
        return '/'; // Disk context starts at root of selected folder
    }

    /** Get the name of the selected directory */
    getDirectoryName(): string | null {
        return this.nativeAdapter.getDirectoryName();
    }

    /** Request write permission for disk access */
    async requestPermission(): Promise<boolean> {
        const permission = await this.nativeAdapter.requestPermission();
        return permission === 'granted';
    }

    /** Clear the selected directory */
    async clearDirectory(): Promise<void> {
        await this.nativeAdapter.clearDirectory();
    }
}

/**
 * Singleton registry for filesystem plugins
 */
class FilesystemPluginRegistry {
    private plugins: Map<string, FilesystemPlugin> = new Map();
    private defaultPluginId: string | null = null;

    /**
     * Register a filesystem plugin
     */
    register(plugin: FilesystemPlugin): void {
        const id = plugin.getId();
        if (this.plugins.has(id)) {
            console.warn(
                `[PluginRegistry] Plugin '${id}' already registered, replacing`
            );
        }
        this.plugins.set(id, plugin);
        console.log(
            `[PluginRegistry] Registered plugin: ${id} (${plugin.getName()})`
        );

        // First plugin registered becomes default
        if (this.defaultPluginId === null) {
            this.defaultPluginId = id;
        }
    }

    /**
     * Get a plugin by ID
     */
    get(id: string): FilesystemPlugin | null {
        return this.plugins.get(id) || null;
    }

    /**
     * Get all registered plugins
     */
    getAll(): FilesystemPlugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * Get all plugin IDs
     */
    getIds(): string[] {
        return Array.from(this.plugins.keys());
    }

    /**
     * Check if a plugin is registered
     */
    has(id: string): boolean {
        return this.plugins.has(id);
    }

    /**
     * Set the default plugin ID
     */
    setDefault(id: string): void {
        if (!this.plugins.has(id)) {
            throw new Error(
                `Cannot set default plugin '${id}': not registered`
            );
        }
        this.defaultPluginId = id;
    }

    /**
     * Get the default plugin
     */
    getDefault(): FilesystemPlugin | null {
        if (this.defaultPluginId === null) {
            return null;
        }
        return this.plugins.get(this.defaultPluginId) || null;
    }

    /**
     * Get the default plugin ID
     */
    getDefaultId(): string | null {
        return this.defaultPluginId;
    }
}

// Export singleton instance
export const pluginRegistry = new FilesystemPluginRegistry();

// Auto-register built-in plugins
pluginRegistry.register(new MemoryPlugin());
pluginRegistry.register(new DiskPlugin());
pluginRegistry.setDefault('memory');

console.log(
    '[FilesystemPlugins] ✅ Plugin system initialized with',
    pluginRegistry.getIds().join(', ')
);
