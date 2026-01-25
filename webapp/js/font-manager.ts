// Font Manager
// Keeps track of all open fonts, and access to font data.
// Also maintains the opened font dropdown UI.
// Implements two-stage font compilation architecture:
// 1. "typing" font: Compiled once when font opens, kept in memory permanently for glyph name extraction
// 2. "editing" font: Recompiled on demand with subset of glyphs for display in canvas

import APP_SETTINGS from './settings';
import { fontCompilation } from './font-compilation';
import { get_glyph_order } from '../wasm-dist/babelfont_fontc_web';
import type { Babelfont } from './babelfont';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation } from './locations';
import { Font, Path } from './babelfont-model';
import { ensureWasmInitialized } from './wasm-init';
import { sidebarErrorDisplay } from './sidebar-error-display';
import type { FilesystemPlugin } from './filesystem-plugins';

export type GlyphData = {
    glyphName: string;
    layers: {
        id: string;
        name: string;
        _master: string;
        location?: DesignspaceLocation;
    }[];
    masters: {
        id: string;
        name: string;
        location: DesignspaceLocation;
    }[];
    axesOrder: string[];
};

class OpenedFont {
    babelfontJson: string;
    babelfontData: any;
    fontModel: Font; // Object model facade
    name: string;
    path: string;
    dirty: boolean;
    sourcePlugin: FilesystemPlugin;
    fileHandle?: FileSystemFileHandle;
    directoryHandle?: FileSystemDirectoryHandle;

    constructor(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        this.babelfontJson = babelfontJson;
        this.babelfontData = JSON.parse(babelfontJson);
        this.sourcePlugin = sourcePlugin;
        this.fileHandle = fileHandle;
        this.directoryHandle = directoryHandle;

        // Normalize layer master references from dict format to _master field
        // Babelfont format stores: master: { DefaultForMaster: "id" } or { AssociatedWithMaster: "id" }
        // We need: _master: "id"
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (layer.master && typeof layer.master === 'object') {
                    // Extract master ID from dict format
                    const masterDict = layer.master;
                    if ('DefaultForMaster' in masterDict) {
                        layer._master = masterDict.DefaultForMaster;
                    } else if ('AssociatedWithMaster' in masterDict) {
                        layer._master = masterDict.AssociatedWithMaster;
                    }
                }
            }
        }

        this.fontModel = Font.fromData(this.babelfontData); // Create object model
        this.path = path;
        this.name =
            this.babelfontData?.names.family_name.dflt || 'Untitled Font';
        this.dirty = false;
    }

    /**
     * Sync the JSON string from the object model data
     * Call this after making changes through the object model
     * Converts nodes arrays back to string format for Rust compiler
     */
    syncJsonFromModel(): void {
        console.log('[FontManager]', 'Starting syncJsonFromModel...');

        let pathsFound = 0;
        let pathsConverted = 0;
        let pathsAlreadyString = 0;
        let wrappersFixed = 0;

        // Process all layers to prepare for serialization
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (!layer?.shapes) continue;

                for (let i = 0; i < layer.shapes.length; i++) {
                    let shape = layer.shapes[i];

                    // Handle Path shapes - convert array nodes to strings
                    if (shape.Path?.nodes) {
                        pathsFound++;
                        const pathObj = shape.Path;

                        if (Array.isArray(pathObj.nodes)) {
                            // Log first few nodes before conversion to debug
                            if (glyph.name === 'o') {
                                console.log(
                                    '[FontManager]',
                                    `  Before conversion, first 3 nodes:`,
                                    pathObj.nodes
                                        .slice(0, 3)
                                        .map(
                                            (n: any) =>
                                                `(${n.x},${n.y},${n.nodetype}${n.smooth ? 's' : ''})`
                                        )
                                        .join(' ')
                                );
                            }

                            // Convert nodes array back to compact string format
                            const nodesString = Path.nodesToString(
                                pathObj.nodes
                            );
                            console.log(
                                '[FontManager]',
                                `Converting nodes for ${glyph.name}:`,
                                pathObj.nodes.length,
                                'nodes →',
                                nodesString.substring(0, 50) + '...'
                            );
                            pathObj.nodes = nodesString;
                            pathsConverted++;

                            // If this is a normalizer wrapper, also update the duplicate nodes property
                            // so they stay in sync (both should be strings now)
                            if ('nodes' in shape && 'isInterpolated' in shape) {
                                console.log(
                                    '[FontManager]',
                                    `  Wrapper detected, updating shape.nodes too`
                                );
                                console.log(
                                    '[FontManager]',
                                    `  Before: shape.nodes type =`,
                                    typeof shape.nodes,
                                    Array.isArray(shape.nodes)
                                        ? `array[${shape.nodes.length}]`
                                        : ''
                                );
                                shape.nodes = nodesString;
                                console.log(
                                    '[FontManager]',
                                    `  After: shape.nodes type =`,
                                    typeof shape.nodes
                                );
                                wrappersFixed++;
                            }

                            // Verify conversion worked
                            console.log(
                                '[FontManager]',
                                `  After conversion: pathObj.nodes type =`,
                                typeof pathObj.nodes
                            );
                            console.log(
                                '[FontManager]',
                                `  Shape object keys:`,
                                Object.keys(shape)
                            );
                            if ('nodes' in shape) {
                                console.log(
                                    '[FontManager]',
                                    `  shape.nodes type =`,
                                    typeof shape.nodes,
                                    'same as pathObj.nodes?',
                                    shape.nodes === pathObj.nodes
                                );
                            }
                        } else if (typeof pathObj.nodes === 'string') {
                            pathsAlreadyString++;
                        } else {
                            console.error(
                                '[FontManager]',
                                `Unexpected nodes type for ${glyph.name}:`,
                                typeof pathObj.nodes,
                                pathObj.nodes
                            );
                        }
                    }

                    // Note: normalizer wrapper properties (nodes, isInterpolated) are filtered
                    // out during JSON.stringify by the replacer function in toJSONString()
                }
            }
        }

        console.log(
            '[FontManager]',
            `Paths: ${pathsFound} total, ${pathsConverted} converted, ${pathsAlreadyString} already strings, ${wrappersFixed} wrappers fixed`
        );

        this.babelfontJson = this.fontModel.toJSONString();
        console.log(
            '[FontManager]',
            `✅ JSON generated (${this.babelfontJson.length} chars)`
        );

        // Verify conversion worked by checking a sample
        if (pathsConverted > 0) {
            const parsed = JSON.parse(this.babelfontJson);
            const sampleGlyph = parsed.glyphs[0];
            const sampleShape = sampleGlyph?.layers?.[0]?.shapes?.[0];
            if (sampleShape?.Path?.nodes) {
                console.log(
                    '[FontManager]',
                    'Sample nodes type after serialization:',
                    typeof sampleShape.Path.nodes,
                    Array.isArray(sampleShape.Path.nodes)
                        ? '(ARRAY - BUG!)'
                        : '(string - OK)'
                );
            }

            // Check the specific area where Rust parser fails
            const errorCol = 389511;
            if (this.babelfontJson.length > errorCol) {
                console.log('[FontManager]', 'Context around column 389511:');
                console.log(
                    this.babelfontJson.substring(errorCol - 100, errorCol + 100)
                );
            }
        }
    }

    /**
     * Save font using the source plugin's adapter
     */
    async save(): Promise<void> {
        const pluginId = this.sourcePlugin.getId();
        console.log(
            `[FontManager]`,
            `${this.sourcePlugin.getIcon()} Saving font to ${pluginId}: ${this.path}`
        );

        // For disk plugin, need file handle and permission check
        if (pluginId === 'disk') {
            if (!this.fileHandle) {
                throw new Error('No file handle available for disk save');
            }

            // Check permission
            const permission = await (this.fileHandle as any).queryPermission({
                mode: 'readwrite'
            });
            if (permission !== 'granted') {
                const requestedPermission = await (
                    this.fileHandle as any
                ).requestPermission({ mode: 'readwrite' });
                if (requestedPermission !== 'granted') {
                    throw new Error('Write permission not granted');
                }
            }

            // Write to file
            try {
                const writable = await this.fileHandle.createWritable();
                await writable.write(this.babelfontJson);
                await writable.close();
                console.log(
                    '[FontManager]',
                    `✅ Saved font to disk: ${this.path}`
                );
            } catch (error) {
                if (error instanceof Error && error.name === 'SecurityError') {
                    throw new Error(
                        'Permission denied. Please re-enable folder access.'
                    );
                }
                throw error;
            }
        } else {
            // For other plugins, use adapter's writeFile method
            const adapter = this.sourcePlugin.getAdapter();
            await adapter.writeFile(this.path, this.babelfontJson);
            console.log(
                '[FontManager]',
                `✅ Saved font to ${pluginId}: ${this.path}`
            );
        }
    }
}

class FontManager {
    dropdown: HTMLSelectElement | null;
    dirtyIndicator: HTMLElement | null;

    openedFonts: Map<string, OpenedFont>; // Record of fontId to OpenedFont
    currentFontId: string | null = null;
    typingFont: Uint8Array | null;
    editingFont: Uint8Array | null;
    currentText: string;
    selectedFeatures: string[];
    isCompiling: boolean;
    glyphOrderCache: string[] | null;

    constructor() {
        this.dropdown = null;
        this.dirtyIndicator = null;
        this.openedFonts = new Map<string, OpenedFont>();
        this.typingFont = null; // Uint8Array of compiled typing font
        this.editingFont = null; // Uint8Array of compiled editing font
        this.currentText = '';
        this.selectedFeatures = [];
        this.isCompiling = false;
        this.glyphOrderCache = null; // Cache for glyph order to avoid re-parsing
    }
    init() {
        this.dropdown = document.getElementById(
            'open-fonts-dropdown'
        ) as HTMLSelectElement;
        this.dirtyIndicator = document.getElementById('file-dirty-indicator');
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Handle dropdown selection changes
        this.dropdown!.addEventListener('change', (e: Event) => {
            const selectedFontId = (e.target as HTMLSelectElement).value;
            if (selectedFontId) {
                this.currentFontId = selectedFontId;
            }
        });
    }

    get currentFont(): OpenedFont | null {
        if (this.currentFontId && this.openedFonts.has(this.currentFontId)) {
            const font = this.openedFonts.get(this.currentFontId) || null;
            // Update global reference for Python/script access
            if (font) {
                window.currentFontModel = font.fontModel;
            } else {
                window.currentFontModel = null;
            }
            return font;
        }
        window.currentFontModel = null;
        return null;
    }

    populateDropdown() {
        this.dropdown!.innerHTML = '';

        if (this.openedFonts.size === 0) {
            // No fonts open
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No fonts open';
            this.dropdown!.appendChild(option);
            this.dropdown!.disabled = true;
        } else {
            // Add font options
            this.dropdown!.disabled = false;
            this.openedFonts.forEach((openedFont, fontId) => {
                const option = document.createElement('option');
                option.value = fontId;
                const sourceIcon = openedFont.sourcePlugin.getIcon() + ' ';
                const sourceName = openedFont.sourcePlugin.getName();
                option.textContent = sourceIcon + openedFont.name;
                option.title = `${openedFont.path} (${sourceName})`; // Show path and context on hover

                // Select the current font
                if (fontId === this.currentFontId) {
                    option.selected = true;
                }

                this.dropdown!.appendChild(option);
            });
        }
    }

    async updateDirtyIndicator() {
        // Simply show or hide based on dirty state
        if (this.currentFont?.dirty) {
            this.dirtyIndicator!.classList.add('visible');
        } else {
            this.dirtyIndicator!.classList.remove('visible');
        }
    }

    async onOpened() {
        await this.populateDropdown();
        // Update save button state
        if (window.saveButton) {
            window.saveButton.updateButtonState();
        }
    }
    async onClosed() {
        await this.onOpened(); // same thing
    }

    /**
     * Initialize the font manager when a font is loaded
     * Compiles the typing font immediately
     *
     * @param {string} babelfontJson - The .babelfont JSON string
     * @param {string} path - File path
     * @param {FilesystemPlugin} sourcePlugin - The filesystem plugin used to load this font
     * @param {FileSystemFileHandle} fileHandle - Optional file handle (for disk plugin)
     * @param {FileSystemDirectoryHandle} directoryHandle - Optional directory handle (for disk plugin)
     */
    async loadFont(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        console.log(
            '[FontManager]',
            `🔧 Loading font from ${sourcePlugin.getName()}...`
        );
        let newFont = new OpenedFont(
            babelfontJson,
            path,
            sourcePlugin,
            fileHandle,
            directoryHandle
        );
        let newid = `font-${Date.now()}`;
        this.openedFonts.set(newid, newFont);
        this.currentFontId = newid;

        this.typingFont = null;
        this.editingFont = null;
        this.glyphOrderCache = null; // Clear cache for new font

        // Reset initialFontLoaded flag in glyphCanvas when new font is loaded
        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }

        // Compile typing font immediately
        await this.compileTypingFont();

        console.log(
            '[FontManager]',
            '✅ FontManager: Font loaded and typing font compiled'
        );
    }

    /**
     * Compile the typing font (happens once per font load)
     * This font is used for glyph name extraction only
     */
    async compileTypingFont() {
        // Ensure WASM is initialized before doing anything
        await ensureWasmInitialized();

        if (!this.currentFont) {
            throw new Error('No font loaded');
        }

        if (!fontCompilation || !fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        console.log('[FontManager]', '🔨 Compiling typing font...');
        const startTime = performance.now();

        try {
            const result = await fontCompilation.compileFromJson(
                this.currentFont.babelfontJson,
                'typing-font.ttf',
                'typing'
            );

            this.typingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                '[FontManager]',
                `✅ Typing font compiled in ${duration}ms (${this.typingFont.length} bytes)`
            );

            // Hide any error messages in sidebar
            sidebarErrorDisplay.hideError();

            // Save to file system for review
            this.saveTypingFontToFileSystem();
        } catch (error) {
            console.error(
                '[FontManager]',
                '❌ Failed to compile typing font:',
                error
            );
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            sidebarErrorDisplay.showError(errorMessage);
            throw error;
        }
    }

    /**
     * Get glyph names for the given text using the typing font
     *
     * @param {string} text - Text to get glyph names for
     * @returns {Promise<Array<string>>} - Array of glyph names
     */
    async getGlyphNamesForText(text: string): Promise<string[]> {
        if (!this.typingFont) {
            throw new Error('Typing font not compiled yet');
        }

        // Use the shapeTextWithFont function from font-compilation.js
        return await window.shapeTextWithFont(this.typingFont, text);
    }

    /**
     * Compile the editing font for display in canvas
     * For now, compiles the full font (subsetting will be added later)
     *
     * @param {string} text - Text being edited (for future subsetting)
     * @param {Array<string>} features - Selected OpenType features (for future subsetting)
     */
    async compileEditingFont(text: string = '', features: string[] = []) {
        if (!this.currentFont) {
            throw new Error('No font loaded');
        }

        if (!fontCompilation || !fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        // Store current text and features for future use
        this.currentText = text;
        this.selectedFeatures = features;

        console.log('[FontManager]', '🔨 Compiling editing font...');
        const startTime = performance.now();

        try {
            // TODO: In the future, extract glyph names from text and compile subset
            // For now, compile full font with editing target
            const result = await fontCompilation.compileFromJson(
                this.currentFont.babelfontJson,
                'editing-font.ttf',
                'editing'
            );

            this.editingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                '[FontManager]',
                `✅ Editing font compiled in ${duration}ms (${this.editingFont.length} bytes)`
            );

            // Hide any error messages in sidebar
            sidebarErrorDisplay.hideError();

            // Save to file system for review
            this.saveEditingFontToFileSystem();

            // Dispatch event to notify canvas that new font is ready
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: this.editingFont,
                        duration: duration
                    }
                })
            );

            return this.editingFont;
        } catch (error) {
            console.error(
                '[FontManager]',
                '❌ Failed to compile editing font:',
                error
            );
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            sidebarErrorDisplay.showError(errorMessage);
            throw error;
        }
    }

    /**
     * Recompile editing font after font data changes
     */
    async recompileEditingFont() {
        await this.compileEditingFont(this.currentText, this.selectedFeatures);
        this.currentFont!.dirty = false;
        await this.updateDirtyIndicator();
        return;
    }

    /**
     * Save compiled fonts to file system for review
     */
    saveFontsToFileSystem() {
        this.saveTypingFontToFileSystem();
        this.saveEditingFontToFileSystem();
    }

    /**
     * Save typing font to file system
     */
    saveTypingFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!this.typingFont) {
            return;
        }

        window.uploadFiles([
            new File(
                [this.typingFont as Uint8Array<ArrayBuffer>],
                '_debug_typing_font.ttf',
                { type: 'font/ttf' }
            )
        ]);
        console.log(
            '[FontManager]',
            `💾 Saved typing font to /_debug_typing_font.ttf (${this.typingFont.length} bytes)`
        );
    }

    /**
     * Save editing font to file system
     */
    saveEditingFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!this.editingFont) {
            return;
        }

        window.uploadFiles([
            new File(
                [this.editingFont as Uint8Array<ArrayBuffer>],
                '_debug_editing_font.ttf',
                { type: 'font/ttf' }
            )
        ]);
        console.log(
            '[FontManager]',
            `💾 Saved editing font to /_debug_editing_font.ttf (${this.editingFont.length} bytes)`
        );
    }

    /**
     * Get the current editing font bytes
     */
    getEditingFont() {
        return this.editingFont;
    }

    /**
     * Get the current typing font bytes
     */
    getTypingFont() {
        return this.typingFont;
    }

    /**
     * Get the glyph order (array of glyph names) from the source font
     */
    getGlyphOrder() {
        // Return cached glyph order if available
        if (this.glyphOrderCache) {
            return this.glyphOrderCache;
        }

        // Extract from compiled typing font using WASM
        if (this.typingFont) {
            try {
                const glyphOrder = get_glyph_order(this.typingFont);
                // Cache the result
                this.glyphOrderCache = glyphOrder;
                return glyphOrder;
            } catch (error) {
                console.error(
                    '[FontManager]',
                    'Failed to extract glyph order from typing font:',
                    error
                );
            }
        }

        console.warn(
            '[FontManager]',
            'No glyph order available - font not loaded'
        );
        return [];
    }

    /**
     * Get glyph name by GID from source font
     */
    getGlyphName(gid: number): string {
        const glyphOrder = this.getGlyphOrder();
        if (gid >= 0 && gid < glyphOrder.length) {
            return glyphOrder[gid];
        }
        return `GID${gid}`;
    }

    /**
     * Check if fonts are ready
     */
    isReady() {
        return this.typingFont !== null && this.editingFont !== null;
    }

    private getGlyph(glyphName: string): Babelfont.Glyph | null {
        // Get glyph data for a specific glyph name
        if (!this.currentFont) {
            return null;
        }
        let glyphs: Babelfont.Glyph[] = this.currentFont.babelfontData.glyphs;
        if (!glyphs) {
            return null;
        }
        let glyph = glyphs.find((g) => g.name === glyphName);
        if (!glyph) {
            return null;
        }
        return glyph;
    }

    private getLayer(
        glyphName: string,
        layerId: string
    ): Babelfont.Layer | null {
        // Get layer data for a specific glyph and layer ID
        let glyph = this.getGlyph(glyphName);
        if (!glyph || !glyph.layers) {
            console.warn(
                `[FontManager] getLayer: glyph "${glyphName}" not found or has no layers`
            );
            return null;
        }
        let layer = glyph.layers.find((l) => l.id === layerId);
        if (!layer) {
            console.warn(
                `[FontManager] getLayer: layer ID "${layerId}" not found in glyph "${glyphName}"`,
                {
                    availableLayerIds: glyph.layers.map((l) => l.id),
                    requestedLayerId: layerId
                }
            );
            return null;
        }
        console.log(
            `[FontManager] getLayer: Found layer "${layerId}" for glyph "${glyphName}"`
        );
        return layer;
    }

    /**
     *  Fetch layer data for a specific glyph, including nested components
     */
    fetchLayerData(
        componentGlyphName: string,
        selectedLayerId: string
    ): Babelfont.Layer | null {
        // Fetch layer data for a specific glyph, recursively fetching nested component layer data
        let layer = this.getLayer(componentGlyphName, selectedLayerId);
        if (!layer) {
            return null;
        }
        // Recursively fetch component layer data for nested components
        for (const shape of layer.shapes || []) {
            if ('Component' in shape && shape.Component.reference) {
                let nestedData = this.fetchLayerData(
                    shape.Component.reference,
                    selectedLayerId
                );
                if (nestedData) {
                    shape.Component.layerData = nestedData;
                }
            }
        }
        return layer;
    }

    /**
     * Looks for a font-level format_specific key in the current font
     *
     * @param {string} key
     * @returns {any}
     */
    getFormatSpecific(key: string): any {
        return this.currentFont?.babelfontData?.format_specific?.[key];
    }

    /**
     * Sets a font-level format_specific key in the current font
     *
     * @param {string} key
     * @param {any} value
     */
    setFormatSpecific(key: string, value: any) {
        if (this.currentFont?.babelfontData) {
            if (!this.currentFont.babelfontData.format_specific) {
                this.currentFont.babelfontData.format_specific = {};
            }
            this.currentFont.babelfontData.format_specific[key] = value;
        }
    }

    fetchGlyphData(glyphName: string): GlyphData | null {
        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            return null;
        }
        let master_ids = new Set<string>();
        for (let master of this.currentFont!.babelfontData.masters) {
            master_ids.add(master.id);
        }
        let layersData = [];
        for (let layer of glyph.layers || []) {
            // Only include non-background layers that are DEFAULT layers for their master
            // (not AssociatedWithMaster layers, which are intermediate/alternate designs)
            if (!layer.is_background) {
                // Check if this is a default layer (has DefaultForMaster in master dict)
                const layerAny = layer as any;
                const isDefaultLayer =
                    layerAny.master &&
                    typeof layerAny.master === 'object' &&
                    'DefaultForMaster' in layerAny.master;

                if (isDefaultLayer) {
                    let master_id = layer._master || layer.id;
                    if (master_id && master_ids.has(master_id)) {
                        layersData.push({
                            id: layer.id as string,
                            name: layer.name || 'Default',
                            _master: master_id,
                            location: layer.location
                        });
                    }
                }
            }
        }
        let axes_order = this.currentFont!.babelfontData.axes.map(
            (axis: Babelfont.Axis) => axis.tag
        );

        let mastersData = [];
        for (let master of this.currentFont!.babelfontData
            .masters as Babelfont.Master[]) {
            let userspaceLocation = designspaceToUserspace(
                master.location || {},
                this.currentFont!.babelfontData.axes
            );
            // Extract master name from I18NDictionary (use 'en' or first available)
            let masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name?.en ||
                      Object.values(master.name || {})[0] ||
                      'Unknown';
            mastersData.push({
                id: master.id,
                name: masterName,
                location: userspaceLocation
            });
        }
        return {
            glyphName: glyph.name,
            layers: layersData,
            masters: mastersData,
            axesOrder: axes_order
        };
    }

    async saveLayerData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ) {
        // Helper function to recursively clean shapes for saving
        const cleanShapeForSaving = (shape: Babelfont.Shape): any => {
            if ('Path' in shape) {
                // For Path shapes, ensure we only save the string representation
                // Remove any parsed 'nodes' array that was added during rendering
                if ('nodes' in shape && Array.isArray(shape.nodes)) {
                    // Convert array back to string: [{x, y, nodetype}, ...] -> "x y nodetype x y nodetype ..."
                    const nodesString = shape.nodes
                        .map((node) => `${node.x} ${node.y} ${node.nodetype}`)
                        .join(' ');
                    return {
                        Path: { nodes: nodesString, closed: shape.Path.closed }
                    };
                } else {
                    // Already in string format, just copy the Path data
                    return {
                        Path: { ...shape.Path }
                    };
                }
            } else if ('Component' in shape) {
                // Strip the layerData property from components before saving
                // layerData is only for internal rendering, not part of the font format
                const componentData = { ...shape.Component };
                delete componentData.layerData; // Remove the populated layerData
                return {
                    Component: componentData
                };
            } else {
                // For other shape types (Anchor, etc.), create a clean copy
                // Avoid JSON.parse(JSON.stringify()) which can fail on circular refs
                const isObject =
                    shape && typeof shape === 'object' && !Array.isArray(shape);
                if (isObject) {
                    return { ...(shape as object) } as Babelfont.Shape;
                }
                return shape;
            }
        };

        // Convert nodes array back to string format and strip internal properties
        let newShapes = layerData.shapes?.map(cleanShapeForSaving);

        // Deep copy anchors and guides to avoid circular references
        const cleanAnchors = layerData.anchors?.map((anchor) => ({
            name: anchor.name,
            x: anchor.x,
            y: anchor.y
        }));

        const cleanGuides = layerData.guides?.map((guide) => ({
            pos: {
                x: guide.pos.x,
                y: guide.pos.y,
                angle: guide.pos.angle
            },
            name: guide.name,
            ...(guide.color && { color: guide.color })
        }));

        // Create a clean copy of the layer data with only serializable properties
        // Don't save isInterpolated flag - it's runtime state only
        let layerDataCopy: Babelfont.Layer = {
            width: layerData.width,
            height: layerData.height,
            vertWidth: layerData.vertWidth,
            name: layerData.name,
            id: layerData.id,
            _master: layerData._master,
            shapes: newShapes || [],
            isInterpolated: false, // Always false for saved data
            // Copy other optional properties if they exist
            ...(cleanAnchors && { anchors: cleanAnchors }),
            ...(cleanGuides && { guides: cleanGuides }),
            ...(layerData.color && { color: layerData.color }),
            ...(layerData.layer_index !== undefined && {
                layer_index: layerData.layer_index
            }),
            ...(layerData.is_background !== undefined && {
                is_background: layerData.is_background
            }),
            ...(layerData.background_layer_id && {
                background_layer_id: layerData.background_layer_id
            }),
            ...(layerData.location && { location: { ...layerData.location } }),
            ...(layerData.format_specific && {
                format_specific: layerData.format_specific
            }),
            // Preserve the master property which contains DefaultForMaster
            // This is crucial for the layer to be recognized as a default layer
            ...((layerData as any).master && {
                master: (layerData as any).master
            })
        };

        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} not found - cannot save layer data`
            );
            return;
        }

        if (!glyph.layers) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} has no layers - cannot save layer data`
            );
            return;
        }

        // Update the layer in the current font's babelfontData
        let layerIndex = glyph.layers.findIndex((l) => l.id === layerId);
        if (layerIndex === -1) {
            console.error(
                `[FontManager]`,
                `Layer ${layerId} not found in glyph ${glyphName} - cannot save layer data`
            );
            return;
        }
        // Directly assign the cleaned layer data (no need for JSON.parse/stringify)
        glyph.layers[layerIndex] = layerDataCopy;
        console.log(glyph.layers[layerIndex]);

        // Update the babelfontJson string
        // We need to parse the JSON, update the specific layer, and stringify again
        // to avoid circular references from other layers that were rendered
        try {
            const fontData = JSON.parse(this.currentFont!.babelfontJson);
            // Find the glyph in the parsed data
            const glyphInJson = fontData.glyphs.find(
                (g: any) =>
                    g.name === glyphName ||
                    (glyphName.startsWith('GID ') && g.name === undefined)
            );
            if (glyphInJson && glyphInJson.layers) {
                const layerIndexInJson = glyphInJson.layers.findIndex(
                    (l: any) => l.id === layerId
                );
                if (layerIndexInJson !== -1) {
                    glyphInJson.layers[layerIndexInJson] = layerDataCopy;
                }
            }
            this.currentFont!.babelfontJson = JSON.stringify(fontData);
            // Also update the babelfontData reference
            this.currentFont!.babelfontData = fontData;
            // Recreate the font model to reflect changes
            this.currentFont!.fontModel = Font.fromData(fontData);
            // Update global reference
            window.currentFontModel = this.currentFont!.fontModel;
        } catch (error) {
            console.error(
                '[FontManager] Error updating babelfont JSON:',
                error
            );
            return;
        }

        // Mark font as dirty
        this.currentFont!.dirty = true;
        window.autoCompileManager.checkAndSchedule();
        await this.updateDirtyIndicator();
    }
}

// Create singleton instance when page loads
let fontManager: FontManager = new FontManager();

// Expose to window for global access (needed by object model dirty flag tracking)
(window as any).fontManager = fontManager;

// Initialize global font model reference
window.currentFontModel = null;

document.addEventListener('DOMContentLoaded', () => {
    fontManager.init();
});
export default fontManager;

// Wait for font compilation system to be ready
async function fontCompilationReady() {
    if (!fontCompilation || !fontCompilation.isInitialized) {
        console.log(
            '[FontManager]',
            '⏳ Waiting for font compilation system...'
        );
        // Wait up to 30 seconds for initialization
        let attempts = 0;
        while (
            attempts < 300 &&
            (!fontCompilation || !fontCompilation.isInitialized)
        ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
        }
        if (!fontCompilation || !fontCompilation.isInitialized) {
            console.error(
                '[FontManager]',
                '❌ Font compilation system not ready after 30 seconds'
            );
            return;
        }
        console.log('[FontManager]', '✅ Font compilation system ready');
    }
}

// Listen for font loaded events from file browser
window.addEventListener('fontLoaded', async (event: Event) => {
    console.log('[FontManager]', '🎯 FontManager: Received fontLoaded event');
    await fontCompilationReady();
    try {
        // Get the babelfont JSON from the event
        const detail = (event as CustomEvent).detail;

        const pluginName = detail.sourcePlugin?.getName() || 'unknown';
        console.log(
            '[FontManager]',
            `📦 Received font JSON (${detail.babelfontJson.length} bytes from ${pluginName})`
        );

        // Load font into font manager
        await fontManager!.loadFont(
            detail.babelfontJson,
            detail.path,
            detail.sourcePlugin,
            detail.fileHandle,
            detail.directoryHandle
        );

        // Dispatch fontReady event (font is loaded, currentFont is set)
        window.dispatchEvent(
            new CustomEvent('fontReady', { detail: { path: detail.path } })
        );

        // Update dropdown
        await fontManager!.onOpened();

        // Compile initial editing font
        await fontManager!.compileEditingFont();
    } catch (error) {
        console.error('[FontManager]', 'Failed to initialize font manager:');
        console.error(
            '[FontManager]',
            'Error message:',
            error instanceof Error ? error.message : String(error)
        );
        console.error(
            '[FontManager]',
            'Error stack:',
            error instanceof Error ? error.stack : 'No stack'
        );
        console.error('[FontManager]', 'Raw error object:', error);

        // Error will be shown in sidebar by the error handlers above
    }
});

console.log('[FontManager]', '✅ Font Manager module loaded');
