// Glyph Overview Filters
// Manages hierarchical filter sidebar with Python plugin-based dynamic filters

import { Logger } from './logger';

const console = new Logger('GlyphOverviewFilters', true);

/**
 * Path registry for filter categories.
 * Keys are path identifiers, values are display names.
 * Plugins must reference these paths to be displayed.
 */
const FILTER_PATHS: Record<string, string> = {
    'basic': 'Basic',
    'basic/glyph_categories': 'Categories'
};

/**
 * Filter result from a plugin
 */
export interface FilterResult {
    glyph_name: string;
    color?: string; // Either a color keyword or hex color
}

/**
 * Color definition from a plugin
 */
export interface ColorDefinition {
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
    colors?: Record<string, ColorDefinition>;
    lastResults?: FilterResult[];
    glyphCount?: number;
    hasError?: boolean; // True if last run resulted in an error
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

export class GlyphOverviewFilterManager {
    private plugins: GlyphFilterPlugin[] = [];
    private loaded: boolean = false;
    private sidebarContainer: HTMLElement | null = null;
    private colorLegendContainer: HTMLElement | null = null;
    private glyphOverview: any = null;
    private activeFilter: GlyphFilterPlugin | null = null;
    private activeColorFilters: Set<string> = new Set(); // Selected color hex values for filtering
    private rootNode: TreeNode;
    private readonly STORAGE_KEY = 'glyphFilterActive';

    constructor() {
        this.rootNode = this.buildEmptyTree();
        this.loadActiveState();
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
     * Load active filter state from localStorage
     */
    private loadActiveState(): void {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                // Will be applied after plugins are loaded
                (this as any)._pendingActiveFilter = stored;
            }
        } catch (error) {
            console.error('Failed to load filter state:', error);
        }
    }

    /**
     * Save active filter state to localStorage
     */
    private saveActiveState(): void {
        try {
            if (this.activeFilter) {
                const fullId = `${this.activeFilter.path}/${this.activeFilter.keyword}`;
                localStorage.setItem(this.STORAGE_KEY, fullId);
            } else {
                localStorage.removeItem(this.STORAGE_KEY);
            }
        } catch (error) {
            console.error('Failed to save filter state:', error);
        }
    }

    /**
     * Initialize with sidebar container and glyph overview reference
     */
    initialize(
        sidebarContainer: HTMLElement,
        glyphOverview: any,
        colorLegendContainer?: HTMLElement
    ): void {
        this.sidebarContainer = sidebarContainer;
        this.glyphOverview = glyphOverview;
        this.colorLegendContainer = colorLegendContainer || null;

        // Render initial sidebar structure
        this.renderSidebar();
    }

    /**
     * Discover and load all glyph filter plugins from installed packages.
     * Uses Python's entry_points system to find plugins in the 'context_glyph_filter_plugins' group.
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

                # Discover plugins in the 'context_glyph_filter_plugins' group
                discovered_plugins = []
                
                # Handle different Python versions (entry_points API changed in 3.10)
                if sys.version_info >= (3, 10):
                    eps = entry_points(group='context_glyph_filter_plugins')
                else:
                    eps = entry_points().get('context_glyph_filter_plugins', [])
                
                for ep in eps:
                    try:
                        plugin_class = ep.load()
                        plugin_instance = plugin_class()
                        discovered_plugins.append({
                            'path': getattr(plugin_instance, 'path', ''),
                            'keyword': getattr(plugin_instance, 'keyword', ep.name),
                            'display_name': getattr(plugin_instance, 'display_name', ep.name),
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

            // Validate plugin paths and load color definitions
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

                // Load color definitions
                try {
                    const instance = plugin.instance;
                    if (instance && instance.get_colors) {
                        const colorsResult = instance.get_colors();
                        if (colorsResult && colorsResult.toJs) {
                            plugin.colors = colorsResult.toJs({
                                dict_converter: Object.fromEntries
                            });
                        } else {
                            plugin.colors = {};
                        }
                    } else {
                        plugin.colors = {};
                    }
                } catch (error) {
                    console.error(
                        `Error getting colors for ${plugin.display_name}:`,
                        error
                    );
                    plugin.colors = {};
                }

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
            if ((this as any)._pendingActiveFilter) {
                const fullId = (this as any)._pendingActiveFilter;
                const plugin = this.plugins.find(
                    (p) => `${p.path}/${p.keyword}` === fullId
                );
                if (plugin) {
                    this.activeFilter = plugin;
                }
                delete (this as any)._pendingActiveFilter;
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

            // Run initial filter if one is active and font is loaded
            if (this.activeFilter && window.currentFontModel) {
                await this.runFilter(this.activeFilter);
            }

            // Run all plugins to get initial counts if font is loaded
            if (window.currentFontModel) {
                for (const plugin of this.plugins) {
                    if (plugin !== this.activeFilter) {
                        await this.runPluginForCount(plugin);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to discover plugins:', error);
            this.plugins = [];
        }
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

        // Clear existing content
        this.sidebarContainer.innerHTML = '';

        // Create header
        const header = document.createElement('div');
        header.className = 'editor-section-title';
        header.textContent = 'Filters';
        this.sidebarContainer.appendChild(header);

        // Render tree nodes
        const treeContainer = document.createElement('div');
        treeContainer.className = 'glyph-filter-tree';
        this.renderTreeNode(this.rootNode, treeContainer, 0);
        this.sidebarContainer.appendChild(treeContainer);
    }

    /**
     * Recursively render a tree node and its children
     */
    private renderTreeNode(
        node: TreeNode,
        container: HTMLElement,
        depth: number
    ): void {
        // Render child nodes (categories)
        for (const [key, childNode] of node.children) {
            const nodeElement = document.createElement('div');
            nodeElement.className = 'glyph-filter-node';
            nodeElement.style.paddingLeft = `${depth * 8}px`;

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

            // Render plugins in this node
            for (const plugin of childNode.plugins) {
                const pluginElement = this.renderPluginItem(plugin, depth + 1);
                childContent.appendChild(pluginElement);
            }

            // Recursively render children
            this.renderTreeNode(childNode, childContent, depth + 1);

            nodeElement.appendChild(childContent);
            container.appendChild(nodeElement);
            childNode.element = nodeElement;
        }

        // Render plugins directly under this node (for root level)
        if (depth === 0) {
            for (const plugin of node.plugins) {
                const pluginElement = this.renderPluginItem(plugin, depth);
                container.appendChild(pluginElement);
            }
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
        item.className = 'glyph-filter-item';
        item.dataset.pluginKeyword = plugin.keyword; // For reliable lookup
        if (this.activeFilter === plugin) {
            item.classList.add('active');
        }
        item.style.paddingLeft = `${depth * 4 + 8}px`;

        const label = document.createElement('span');
        label.className = 'glyph-filter-item-label';
        label.textContent = plugin.display_name;

        const count = document.createElement('span');
        count.className = 'glyph-filter-item-count';
        count.textContent =
            plugin.glyphCount !== undefined ? String(plugin.glyphCount) : '—';

        item.appendChild(label);
        item.appendChild(count);

        // Click to activate filter
        item.addEventListener('click', async () => {
            await this.activateFilter(plugin, item);
        });

        return item;
    }

    /**
     * Activate a filter plugin
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

        // Run filter
        await this.runFilter(plugin);
    }

    /**
     * Run a filter plugin and apply results
     */
    async runFilter(plugin: GlyphFilterPlugin): Promise<void> {
        if (!window.pyodide || !window.currentFontModel) {
            console.error('Pyodide or font not available');
            return;
        }

        try {
            console.log(`Running filter: ${plugin.display_name}`);

            // Call the plugin's filter_glyphs method
            const instance = plugin.instance;
            if (!instance || !instance.filter_glyphs) {
                console.error(
                    `Plugin ${plugin.display_name} has no filter_glyphs method`
                );
                return;
            }

            // Get font via CurrentFont() and pass to plugin
            const font = await window.pyodide.runPythonAsync(`CurrentFont()`);
            const resultsProxy = await instance.filter_glyphs(font);

            // Convert results to JS
            let results: FilterResult[] = [];
            if (resultsProxy && resultsProxy.toJs) {
                results = resultsProxy.toJs({
                    dict_converter: Object.fromEntries
                });
                resultsProxy.destroy();
            }

            // Collect used color keywords before resolving
            const usedColorKeywords = new Set<string>();
            results.forEach((result) => {
                if (
                    result.color &&
                    plugin.colors &&
                    plugin.colors[result.color]
                ) {
                    usedColorKeywords.add(result.color);
                }
            });

            // Resolve color keywords to actual colors
            results = results.map((result) => {
                if (
                    result.color &&
                    plugin.colors &&
                    plugin.colors[result.color]
                ) {
                    return {
                        ...result,
                        color: plugin.colors[result.color].color
                    };
                }
                return result;
            });

            // Store results
            plugin.lastResults = results;
            plugin.glyphCount = results.length;
            plugin.hasError = false;

            // Update count in sidebar
            this.updatePluginCount(plugin);

            // Update color legend
            this.updateColorLegend(plugin, usedColorKeywords);

            console.log(`Filter returned ${results.length} glyphs`);

            // Apply to overview
            if (this.glyphOverview) {
                this.glyphOverview.setActiveFilter(results);
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
                this.glyphOverview.showFilterError(plugin.display_name, error);
            }
        }
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
            } else {
                count.textContent = String(plugin.glyphCount ?? '—');
                count.classList.remove('has-error');
            }
        }
    }

    /**
     * Update the color legend section based on filter results
     */
    private updateColorLegend(
        plugin: GlyphFilterPlugin,
        usedColorKeywords: Set<string>
    ): void {
        if (!this.colorLegendContainer) return;

        // Clear existing content and reset color filters
        this.colorLegendContainer.innerHTML = '';
        this.activeColorFilters.clear();

        // If no colors used, hide the container
        if (usedColorKeywords.size === 0 || !plugin.colors) {
            this.colorLegendContainer.style.display = 'none';
            return;
        }

        // Count glyphs per color
        const colorCounts = new Map<string, number>();
        if (plugin.lastResults) {
            for (const result of plugin.lastResults) {
                if (result.color) {
                    colorCounts.set(
                        result.color,
                        (colorCounts.get(result.color) || 0) + 1
                    );
                }
            }
        }

        // Show container and add legend items
        this.colorLegendContainer.style.display = '';

        for (const keyword of usedColorKeywords) {
            const colorDef = plugin.colors[keyword];
            if (!colorDef) continue;

            const item = document.createElement('div');
            item.className = 'glyph-filter-legend-item';
            item.dataset.colorHex = colorDef.color;
            item.style.cursor = 'pointer';

            const circle = document.createElement('span');
            circle.className = 'glyph-filter-legend-circle';
            circle.style.backgroundColor = colorDef.color;

            const label = document.createElement('span');
            label.className = 'glyph-filter-legend-label';
            label.textContent = colorDef.description;

            const count = document.createElement('span');
            count.className = 'glyph-filter-legend-count';
            count.textContent = String(colorCounts.get(colorDef.color) || 0);

            item.appendChild(circle);
            item.appendChild(label);
            item.appendChild(count);

            // Click to toggle color filter
            item.addEventListener('click', () => {
                this.toggleColorFilter(colorDef.color, item);
            });

            this.colorLegendContainer.appendChild(item);
        }
    }

    /**
     * Toggle a color filter on/off
     */
    private toggleColorFilter(
        colorHex: string,
        itemElement: HTMLElement
    ): void {
        if (this.activeColorFilters.has(colorHex)) {
            this.activeColorFilters.delete(colorHex);
            itemElement.classList.remove('active');
        } else {
            this.activeColorFilters.add(colorHex);
            itemElement.classList.add('active');
        }

        // Apply color filter to glyph overview
        this.applyColorFilter();
    }

    /**
     * Apply color filter to show only glyphs matching selected colors
     */
    private applyColorFilter(): void {
        if (!this.glyphOverview || !this.activeFilter) return;

        const results = this.activeFilter.lastResults;
        if (!results) return;

        // If no colors selected, show all filter results
        if (this.activeColorFilters.size === 0) {
            this.glyphOverview.setActiveFilter(results);
            return;
        }

        // Filter to only glyphs matching selected colors (OR logic)
        const filteredResults = results.filter((result) => {
            if (!result.color) return false;
            return this.activeColorFilters.has(result.color);
        });

        this.glyphOverview.setActiveFilter(filteredResults);
    }

    /**
     * Refresh all plugins (re-run active filter and update counts)
     */
    async refreshPlugins(): Promise<void> {
        // Run all plugins to update counts
        for (const plugin of this.plugins) {
            await this.runPluginForCount(plugin);
        }

        // Re-run active filter
        if (this.activeFilter) {
            await this.runFilter(this.activeFilter);
        }
    }

    /**
     * Run a plugin just to get the count (without applying to overview)
     */
    private async runPluginForCount(plugin: GlyphFilterPlugin): Promise<void> {
        if (!window.pyodide || !window.currentFontModel) return;

        try {
            const instance = plugin.instance;
            if (!instance || !instance.filter_glyphs) return;

            // Get font via CurrentFont() and pass to plugin
            const font = await window.pyodide.runPythonAsync(`CurrentFont()`);
            const resultsProxy = await instance.filter_glyphs(font);

            let results: FilterResult[] = [];
            if (resultsProxy && resultsProxy.toJs) {
                results = resultsProxy.toJs({
                    dict_converter: Object.fromEntries
                });
                resultsProxy.destroy();
            }

            plugin.glyphCount = results.length;
            this.updatePluginCount(plugin);
        } catch (error) {
            console.error(
                `Error running plugin ${plugin.display_name} for count:`,
                error
            );
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
        }
    }
}

// Create singleton instance
export const glyphOverviewFilterManager = new GlyphOverviewFilterManager();

// Make available on window for debugging
(window as any).glyphOverviewFilterManager = glyphOverviewFilterManager;
