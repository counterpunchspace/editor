// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Canvas Plugin Manager
 *
 * Discovers and manages Python-based canvas plugins that can draw on top of the glyph canvas.
 * Plugins are loaded from wheels via Pyodide and discovered using entry points.
 */

import { Logger } from './logger';

const console = new Logger('CanvasPluginManager', true);

export class CanvasPluginManager {
    private plugins: any[] = [];
    private loaded: boolean = false;
    private enabledPlugins: Set<string> = new Set();
    private readonly STORAGE_KEY = 'canvasPluginsEnabled';

    constructor() {
        this.loadEnabledState();
    }

    /**
     * Load enabled plugin state from localStorage
     */
    private loadEnabledState(): void {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const enabledArray = JSON.parse(stored);
                this.enabledPlugins = new Set(enabledArray);
            }
        } catch (error) {
            console.error('Failed to load plugin state:', error);
        }
    }

    /**
     * Save enabled plugin state to localStorage
     */
    private saveEnabledState(): void {
        try {
            const enabledArray = Array.from(this.enabledPlugins);
            localStorage.setItem(
                this.STORAGE_KEY,
                JSON.stringify(enabledArray)
            );
        } catch (error) {
            console.error('Failed to save plugin state:', error);
        }
    }

    /**
     * Check if a plugin is enabled
     */
    isPluginEnabled(entryPoint: string): boolean {
        return this.enabledPlugins.has(entryPoint);
    }

    /**
     * Enable a plugin
     */
    enablePlugin(entryPoint: string): void {
        this.enabledPlugins.add(entryPoint);
        this.saveEnabledState();
    }

    /**
     * Disable a plugin
     */
    disablePlugin(entryPoint: string): void {
        this.enabledPlugins.delete(entryPoint);
        this.saveEnabledState();
    }

    /**
     * Toggle a plugin's enabled state
     */
    togglePlugin(entryPoint: string): boolean {
        if (this.enabledPlugins.has(entryPoint)) {
            this.disablePlugin(entryPoint);
            return false;
        } else {
            this.enablePlugin(entryPoint);
            return true;
        }
    }

    /**
     * Discover and load all canvas plugins from installed packages.
     * Uses Python's entry_points system to find plugins in the 'context_canvas_plugins' group.
     */
    async discoverPlugins(): Promise<void> {
        if (!window.pyodide) {
            console.error('Pyodide not available');
            return;
        }

        try {
            console.log('Discovering canvas plugins...');

            // Use importlib.metadata to discover plugins via entry points
            const pluginsResult = await window.pyodide.runPythonAsync(`
                import sys
                from importlib.metadata import entry_points

                # Discover plugins in the 'context_canvas_plugins' group
                discovered_plugins = []
                
                # Handle different Python versions (entry_points API changed in 3.10)
                if sys.version_info >= (3, 10):
                    eps = entry_points(group='context_canvas_plugins')
                else:
                    eps = entry_points().get('context_canvas_plugins', [])
                
                for ep in eps:
                    try:
                        plugin_class = ep.load()
                        plugin_instance = plugin_class()
                        discovered_plugins.append({
                            'name': getattr(plugin_instance, 'name', ep.name),
                            'version': getattr(plugin_instance, 'version', '0.0.0'),
                            'entry_point': ep.name,
                            'instance': plugin_instance
                        })
                        print(f"[CanvasPluginManager] Loaded plugin: {ep.name}")
                    except Exception as e:
                        print(f"[CanvasPluginManager] Error loading plugin {ep.name}: {e}")
                        import traceback
                        traceback.print_exc()
                
                discovered_plugins
            `);

            // Convert PyProxy to JavaScript array
            if (pluginsResult && pluginsResult.toJs) {
                this.plugins = pluginsResult.toJs({
                    dict_converter: Object.fromEntries
                });
            } else {
                this.plugins = [];
            }

            console.log(
                `Discovered ${this.plugins.length} canvas plugin(s):`,
                this.plugins
            );
            this.loaded = true;

            // Update the UI dropdown if it exists
            if (window.editorPluginsUI) {
                window.editorPluginsUI.updatePluginList();
            }
        } catch (error) {
            console.error('Failed to discover plugins:', error);
            this.plugins = [];
        }
    }

    /**
     * Call draw_above() on all loaded plugins.
     *
     * @param layerData - The layer data object
     * @param glyphName - The name of the glyph
     * @param ctx - The canvas 2D rendering context
     * @param viewportManager - The viewport manager
     */
    async drawPluginsAbove(
        layerData: any,
        glyphName: string,
        ctx: CanvasRenderingContext2D,
        viewportManager: any
    ): Promise<void> {
        await this._drawPlugins(
            'draw_above',
            layerData,
            glyphName,
            ctx,
            viewportManager
        );
    }

    /**
     * Call draw_below() on all loaded plugins.
     *
     * @param layerData - The layer data object
     * @param glyphName - The name of the glyph
     * @param ctx - The canvas 2D rendering context
     * @param viewportManager - The viewport manager
     */
    async drawPluginsBelow(
        layerData: any,
        glyphName: string,
        ctx: CanvasRenderingContext2D,
        viewportManager: any
    ): Promise<void> {
        await this._drawPlugins(
            'draw_below',
            layerData,
            glyphName,
            ctx,
            viewportManager
        );
    }

    /**
     * Internal method to call a specific hook on all loaded plugins.
     *
     * @param hookName - The name of the hook method to call (draw_above or draw_below)
     * @param layerData - The layer data object
     * @param glyphName - The name of the glyph
     * @param ctx - The canvas 2D rendering context
     * @param viewportManager - The viewport manager
     */
    private async _drawPlugins(
        hookName: string,
        layerData: any,
        glyphName: string,
        ctx: CanvasRenderingContext2D,
        viewportManager: any
    ): Promise<void> {
        if (!this.loaded || this.plugins.length === 0) {
            return;
        }

        if (!window.pyodide) {
            return;
        }

        try {
            // Make the data available in the global JavaScript namespace temporarily
            (window as any)._pluginLayerData = layerData;
            (window as any)._pluginGlyphName = glyphName;
            (window as any)._pluginCtx = ctx;
            (window as any)._pluginViewportManager = viewportManager;

            // Call each plugin
            for (const plugin of this.plugins) {
                try {
                    // Skip if plugin is not enabled
                    if (!this.isPluginEnabled(plugin.entry_point)) {
                        continue;
                    }

                    // Access the plugin instance
                    const pluginPy = plugin.instance;

                    // Check if the plugin has this hook
                    if (!pluginPy[hookName]) {
                        continue;
                    }

                    // Convert JS objects to Python
                    const layerDataPy = window.pyodide.toPy(layerData);

                    // Call the hook method
                    pluginPy[hookName](
                        layerDataPy,
                        glyphName,
                        ctx,
                        viewportManager
                    );

                    // Clean up Python proxy
                    layerDataPy.destroy();
                } catch (error) {
                    console.error(
                        `Error drawing plugin ${plugin.name} (${hookName}):`,
                        error
                    );
                }
            }

            // Clean up temporary globals
            delete (window as any)._pluginLayerData;
            delete (window as any)._pluginGlyphName;
            delete (window as any)._pluginCtx;
            delete (window as any)._pluginViewportManager;
        } catch (error) {
            console.error(`Error in _drawPlugins (${hookName}):`, error);
        }
    }

    /**
     * Get a plugin instance by entry point name.
     * Used by Python code to access plugin instances.
     *
     * @param entryPoint - The entry point name
     * @returns The plugin instance or null
     */
    getPluginInstance(entryPoint: string): any {
        const plugin = this.plugins.find((p) => p.entry_point === entryPoint);
        return plugin ? plugin.instance : null;
    }

    /**
     * Get the list of loaded plugins.
     */
    getPlugins(): any[] {
        return this.plugins;
    }

    /**
     * Check if plugins are loaded.
     */
    isLoaded(): boolean {
        return this.loaded;
    }
}

// Create and export a singleton instance
const canvasPluginManager = new CanvasPluginManager();

// Make it globally available
declare global {
    interface Window {
        canvasPluginManager: CanvasPluginManager;
    }
}

window.canvasPluginManager = canvasPluginManager;

export default canvasPluginManager;
