// Glyph Overview Filters
// Manages hierarchical filter sidebar with Python plugin-based dynamic filters

import { Logger } from './logger';
import { pluginRegistry } from './filesystem-plugins';
import { NativeAdapter } from './file-system-adapter';

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
    groups?: Record<string, GroupDefinition>;
    lastResults?: FilterResult[];
    glyphCount?: number;
    hasError?: boolean; // True if last run resulted in an error
    isUserFilter?: boolean; // True if this is a user-defined filter from disk
    filePath?: string; // Path to .py file for user filters
    pythonCode?: string; // Source code for user filters
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
    private userFilters: GlyphFilterPlugin[] = [];
    private loaded: boolean = false;
    private sidebarContainer: HTMLElement | null = null;
    private groupLegendContainer: HTMLElement | null = null;
    private glyphOverview: any = null;
    private activeFilter: GlyphFilterPlugin | null = null;
    private activeGroupFilters: Set<string> = new Set(); // Selected group keywords for filtering (not colors)
    private rootNode: TreeNode;
    private userFiltersNode: TreeNode;
    private readonly STORAGE_KEY = 'glyphFilterActive';
    private readonly USER_FILTERS_PATH = '/Counterpunch/Filters';
    private fileSystemObserver: any = null; // FileSystemObserver instance
    private observerSupported: boolean = 'FileSystemObserver' in window;

    constructor() {
        this.rootNode = this.buildEmptyTree();
        this.userFiltersNode = this.buildUserFiltersTree();
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
        groupLegendContainer?: HTMLElement
    ): void {
        this.sidebarContainer = sidebarContainer;
        this.glyphOverview = glyphOverview;
        this.groupLegendContainer = groupLegendContainer || null;

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

            // Discover user filters from disk
            await this.discoverUserFilters();
        } catch (error) {
            console.error('Failed to discover plugins:', error);
            this.plugins = [];
        }
    }

    /**
     * Discover user-defined filters from /Counterpunch/Filters/ on disk
     */
    async discoverUserFilters(): Promise<void> {
        // Remember active user filter keyword to restore after reload
        const activeUserFilterKeyword = this.activeFilter?.isUserFilter
            ? this.activeFilter.keyword
            : null;

        // Reset user filters tree
        this.userFiltersNode = this.buildUserFiltersTree();
        this.userFilters = [];

        // Get disk adapter
        const diskPlugin = pluginRegistry.get('disk');
        if (!diskPlugin) {
            console.log('Disk plugin not available');
            return;
        }

        const adapter = diskPlugin.getAdapter();
        if (!(adapter instanceof NativeAdapter)) {
            console.log('Disk adapter is not NativeAdapter');
            return;
        }

        // Ensure adapter is initialized (restores directory handle from IndexedDB)
        if (!adapter.hasDirectory()) {
            await adapter.initialize();
        }

        // Check if disk folder is selected
        if (!adapter.hasDirectory()) {
            console.log('No disk folder selected');
            return;
        }

        try {
            // Check if /Counterpunch/Filters exists
            const filtersPath = this.USER_FILTERS_PATH;
            const exists = await adapter.fileExists(filtersPath);
            if (!exists) {
                console.log(`${filtersPath} does not exist`);
                return;
            }

            // Scan for .py files recursively (max 3 levels)
            const files = await adapter.listFilesRecursive(filtersPath, 3);
            const pyFiles = files.filter((f) => f.path.endsWith('.py'));

            console.log(`Found ${pyFiles.length} user filter file(s)`);

            for (const file of pyFiles) {
                try {
                    // Read file content
                    const content = await adapter.readFile(file.path);
                    const code =
                        typeof content === 'string'
                            ? content
                            : new TextDecoder().decode(content);

                    // Extract relative path from /Counterpunch/Filters/
                    const relativePath = file.path
                        .substring(filtersPath.length + 1)
                        .replace(/\.py$/, '');
                    const pathParts = relativePath.split('/');
                    const fileName = pathParts.pop()!;
                    const folderPath = pathParts.join('/');

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
                        isUserFilter: true,
                        filePath: file.path,
                        pythonCode: code
                    };

                    this.userFilters.push(userFilter);

                    // Add to user filters tree
                    this.addUserFilterToTree(userFilter, folderPath);
                } catch (error) {
                    console.error(
                        `Error loading user filter ${file.path}:`,
                        error
                    );
                }
            }

            console.log(
                `Loaded ${this.userFilters.length} user filter(s):`,
                this.userFilters.map((f) => f.display_name)
            );

            // Restore active user filter reference if it still exists
            if (activeUserFilterKeyword) {
                const restoredFilter = this.userFilters.find(
                    (f) => f.keyword === activeUserFilterKeyword
                );
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
                        if (window.currentFontModel) {
                            await this.runFilter(allGlyphsFilter);
                        }
                    }
                }
            }

            // Re-render sidebar
            this.renderSidebar();

            // Update counts for user filters if font is loaded
            if (window.currentFontModel) {
                for (const filter of this.userFilters) {
                    await this.runPluginForCount(filter);
                }
            }

            // Set up file system observer for auto-refresh
            await this.setupFileSystemObserver(adapter);
        } catch (error) {
            console.error('Error discovering user filters:', error);
        }
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
                    // Check if any .py files were affected
                    let needsRefresh = false;
                    for (const record of records) {
                        const name = record.changedHandle?.name || '';
                        if (
                            name.endsWith('.py') ||
                            record.type === 'appeared' ||
                            record.type === 'disappeared'
                        ) {
                            needsRefresh = true;
                            break;
                        }
                    }

                    if (needsRefresh) {
                        console.log(
                            'File system change detected, refreshing user filters'
                        );
                        // Remember if active filter is a user filter
                        const activeUserFilterKeyword = this.activeFilter
                            ?.isUserFilter
                            ? this.activeFilter.keyword
                            : null;

                        // discoverUserFilters updates counts for ALL user filters
                        await this.discoverUserFilters();

                        // Also update glyph list if active filter is a user filter
                        if (activeUserFilterKeyword) {
                            const updatedFilter = this.userFilters.find(
                                (f) => f.keyword === activeUserFilterKeyword
                            );
                            if (updatedFilter) {
                                this.activeFilter = updatedFilter;
                                await this.runFilter(updatedFilter);
                            }
                        }
                    }
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

        // Check if disk is available
        const diskPlugin = pluginRegistry.get('disk');
        const hasDisk =
            diskPlugin &&
            diskPlugin.getAdapter() instanceof NativeAdapter &&
            (diskPlugin.getAdapter() as NativeAdapter).hasDirectory();

        // Create header with refresh button
        const header = document.createElement('div');
        header.className = 'editor-section-title glyph-filter-user-header';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'User Filters';
        header.appendChild(titleSpan);

        if (hasDisk) {
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
            header.appendChild(refreshBtn);
        }

        this.sidebarContainer.appendChild(header);

        // Render user filters tree
        const userTreeContainer = document.createElement('div');
        userTreeContainer.className =
            'glyph-filter-tree glyph-filter-user-tree';

        if (!hasDisk) {
            const noAccessMsg = document.createElement('div');
            noAccessMsg.className = 'glyph-filter-no-access';
            noAccessMsg.textContent =
                'Select a Disk folder to enable user filters';
            userTreeContainer.appendChild(noAccessMsg);
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
    }

    /**
     * Render user filters tree with root-level plugins first, then folders
     */
    private renderUserFiltersTree(
        node: TreeNode,
        container: HTMLElement
    ): void {
        // Render root-level plugins first (filters directly in /Counterpunch/Filters/)
        for (const plugin of node.plugins) {
            const pluginElement = this.renderPluginItem(plugin, 0);
            container.appendChild(pluginElement);
        }

        // Then render child nodes (subfolders)
        this.renderTreeNode(node, container, 0);
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

            let results: FilterResult[] = [];
            let groups: Record<string, GroupDefinition> = {};

            if (plugin.isUserFilter && plugin.pythonCode) {
                // Execute user filter with timeout
                const execResult = await this.executeUserFilter(plugin);
                results = execResult.results;
                groups = execResult.groups;
                plugin.groups = groups;
            } else {
                // Call the plugin's filter_glyphs method
                const instance = plugin.instance;
                if (!instance || !instance.filter_glyphs) {
                    console.error(
                        `Plugin ${plugin.display_name} has no filter_glyphs method`
                    );
                    return;
                }

                // Store instance in Python global for wrapper to access
                (window as any).pyodide.globals.set(
                    '_plugin_instance',
                    instance
                );

                // Execute filter and handle generator/list result
                const resultsProxy = await window.pyodide.runPythonAsync(`
import types
_font = CurrentFont()
_result = _plugin_instance.filter_glyphs(_font)
# Convert generator to list if needed
list(_result) if isinstance(_result, types.GeneratorType) else _result
`);

                // Clean up global
                (window as any).pyodide.globals.delete('_plugin_instance');

                // Convert results to JS
                if (resultsProxy && resultsProxy.toJs) {
                    results = resultsProxy.toJs({
                        dict_converter: Object.fromEntries
                    });
                    resultsProxy.destroy();
                }
                groups = plugin.groups || {};
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

            // Update count in sidebar
            this.updatePluginCount(plugin);

            // Update group legend (uses augmentedGroups via plugin.groups)
            this.updateGroupLegend(plugin, usedGroupKeywords);

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
     * Execute a user-defined filter with sandboxing and timeout
     */
    private async executeUserFilter(plugin: GlyphFilterPlugin): Promise<{
        results: FilterResult[];
        groups: Record<string, GroupDefinition>;
    }> {
        const TIMEOUT_MS = 5000;
        const code = plugin.pythonCode!;

        // Create a promise that rejects on timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
                () => reject(new Error('Filter execution timed out (5s)')),
                TIMEOUT_MS
            );
        });

        // Execute the filter
        const execPromise = (async () => {
            // Execute the user filter code and call filter_glyphs
            const result = await window.pyodide.runPythonAsync(`
import sys
from io import StringIO
import types

# Capture any print output
_captured_output = StringIO()
_old_stdout = sys.stdout
sys.stdout = _captured_output

_filter_result = {"results": [], "groups": {}}
try:
    # Execute user filter code
    _user_code = ${JSON.stringify(code)}
    _user_globals = {}
    exec(_user_code, _user_globals)
    
    # Get GROUPS if defined
    _groups = _user_globals.get('GROUPS', {})
    
    # Get and call filter_glyphs
    _filter_func = _user_globals.get('filter_glyphs')
    if _filter_func is None:
        raise ValueError("filter_glyphs function not found in filter file")
    
    _font = CurrentFont()
    _results = _filter_func(_font)
    
    # Handle generator (yield) or list (return)
    if isinstance(_results, types.GeneratorType):
        _results = list(_results)
    
    # Store results and groups
    _filter_result = {"results": _results, "groups": _groups}
finally:
    sys.stdout = _old_stdout

_filter_result
`);

            if (result && result.toJs) {
                const jsResult = result.toJs({
                    dict_converter: Object.fromEntries
                });
                result.destroy();
                return {
                    results: jsResult.results || [],
                    groups: jsResult.groups || {}
                };
            }
            return { results: [], groups: {} };
        })();

        // Race between execution and timeout
        return Promise.race([execPromise, timeoutPromise]);
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
                    // No definition - check if it looks like a color value
                    // If it starts with # or is a named color, treat as raw color
                    // Otherwise create a group with no color
                    if (!augmentedGroups[g]) {
                        // Check if it looks like a CSS color (starts with #, rgb, hsl, or is short)
                        const looksLikeColor =
                            g.startsWith('#') ||
                            g.startsWith('rgb') ||
                            g.startsWith('hsl') ||
                            /^[a-z]+$/i.test(g); // Named colors like 'red', 'lightblue'
                        augmentedGroups[g] = {
                            description: g,
                            color: looksLikeColor ? g : '' // Empty string = no color
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

            // Click to toggle group filter by keyword
            item.addEventListener('click', () => {
                this.toggleGroupFilter(keyword, item);
            });

            this.groupLegendContainer.appendChild(item);
        }
    }

    /**
     * Toggle a group filter on/off by keyword
     */
    private toggleGroupFilter(
        groupKeyword: string,
        itemElement: HTMLElement
    ): void {
        if (this.activeGroupFilters.has(groupKeyword)) {
            this.activeGroupFilters.delete(groupKeyword);
            itemElement.classList.remove('active');
        } else {
            this.activeGroupFilters.add(groupKeyword);
            itemElement.classList.add('active');
        }

        // Apply group filter to glyph overview
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
     * Refresh all plugins (re-run active filter and update counts)
     */
    async refreshPlugins(): Promise<void> {
        // Run all built-in plugins to update counts
        for (const plugin of this.plugins) {
            await this.runPluginForCount(plugin);
        }

        // Run all user filters to update counts
        for (const filter of this.userFilters) {
            await this.runPluginForCount(filter);
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
            let results: FilterResult[] = [];

            if (plugin.isUserFilter && plugin.pythonCode) {
                // Execute user filter
                const execResult = await this.executeUserFilter(plugin);
                results = execResult.results;
                plugin.groups = execResult.groups;
            } else {
                const instance = plugin.instance;
                if (!instance || !instance.filter_glyphs) return;

                // Store instance in Python global for wrapper to access
                (window as any).pyodide.globals.set(
                    '_plugin_instance',
                    instance
                );

                // Execute filter and handle generator/list result
                const resultsProxy = await window.pyodide.runPythonAsync(`
import types
_font = CurrentFont()
_result = _plugin_instance.filter_glyphs(_font)
# Convert generator to list if needed
list(_result) if isinstance(_result, types.GeneratorType) else _result
`);

                // Clean up global
                (window as any).pyodide.globals.delete('_plugin_instance');

                if (resultsProxy && resultsProxy.toJs) {
                    results = resultsProxy.toJs({
                        dict_converter: Object.fromEntries
                    });
                    resultsProxy.destroy();
                }
            }

            // Process results (consolidate duplicates, normalize groups)
            const groups = plugin.groups || {};
            const { results: processedResults } = this.processFilterResults(
                results,
                groups
            );

            plugin.glyphCount = processedResults.length;
            plugin.hasError = false;
            this.updatePluginCount(plugin);
        } catch (error) {
            console.error(
                `Error running plugin ${plugin.display_name} for count:`,
                error
            );
            plugin.hasError = true;
            this.updatePluginCount(plugin);
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
