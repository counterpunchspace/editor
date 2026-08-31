import { Logger } from '../logger';
import type { FilesystemPlugin } from './filesystem-plugin';

const console = new Logger('FilesystemPlugins');

/**
 * Singleton registry for filesystem plugins
 */
class FilesystemPluginRegistry {
    private plugins: Map<string, FilesystemPlugin> = new Map();
    private defaultPluginId: string | null = null;

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

        if (this.defaultPluginId === null) {
            this.defaultPluginId = id;
        }
    }

    get(id: string): FilesystemPlugin | null {
        return this.plugins.get(id) || null;
    }

    getAll(): FilesystemPlugin[] {
        return Array.from(this.plugins.values());
    }

    getIds(): string[] {
        return Array.from(this.plugins.keys());
    }

    has(id: string): boolean {
        return this.plugins.has(id);
    }

    setDefault(id: string): void {
        if (!this.plugins.has(id)) {
            throw new Error(
                `Cannot set default plugin '${id}': not registered`
            );
        }
        this.defaultPluginId = id;
    }

    getDefault(): FilesystemPlugin | null {
        if (this.defaultPluginId === null) {
            return null;
        }
        return this.plugins.get(this.defaultPluginId) || null;
    }

    getDefaultId(): string | null {
        return this.defaultPluginId;
    }
}

export const pluginRegistry = new FilesystemPluginRegistry();
