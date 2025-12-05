// Font Manager
// Implements two-stage font compilation architecture:
// 1. "typing" font: Compiled once when font opens, kept in memory permanently for glyph name extraction
// 2. "editing" font: Recompiled on demand with subset of glyphs for display in canvas

class FontManager {
    constructor() {
        this.babelfontJson = null;
        this.babelfontData = null; // Parsed babelfont object
        this.typingFont = null; // Uint8Array of compiled typing font
        this.editingFont = null; // Uint8Array of compiled editing font
        this.currentText = '';
        this.selectedFeatures = [];
        this.isCompiling = false;
        this.glyphOrderCache = null; // Cache for glyph order to avoid re-parsing
    }

    /**
     * Initialize the font manager when a font is loaded
     * Compiles the typing font immediately
     *
     * @param {string} babelfontJson - The .babelfont JSON string
     */
    async loadFont(babelfontJson) {
        console.log('🔧 FontManager: Loading font...');
        this.babelfontJson = babelfontJson;
        this.babelfontData = JSON.parse(babelfontJson);
        this.typingFont = null;
        this.editingFont = null;
        this.glyphOrderCache = null; // Clear cache for new font

        // Compile typing font immediately
        await this.compileTypingFont();

        console.log('✅ FontManager: Font loaded and typing font compiled');
    }

    /**
     * Compile the typing font (happens once per font load)
     * This font is used for glyph name extraction only
     */
    async compileTypingFont() {
        if (!this.babelfontJson) {
            throw new Error('No font loaded');
        }

        if (!window.fontCompilation || !window.fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        console.log('🔨 Compiling typing font...');
        const startTime = performance.now();

        try {
            const result = await window.fontCompilation.compileFromJson(
                this.babelfontJson,
                'typing-font.ttf',
                'typing'
            );

            this.typingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                `✅ Typing font compiled in ${duration}ms (${this.typingFont.length} bytes)`
            );

            // Save to file system for review
            this.saveTypingFontToFileSystem();
        } catch (error) {
            console.error('❌ Failed to compile typing font:', error);
            throw error;
        }
    }

    /**
     * Get glyph names for the given text using the typing font
     *
     * @param {string} text - Text to get glyph names for
     * @returns {Promise<Array<string>>} - Array of glyph names
     */
    async getGlyphNamesForText(text) {
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
    async compileEditingFont(text = '', features = []) {
        if (!this.babelfontJson) {
            throw new Error('No font loaded');
        }

        if (!window.fontCompilation || !window.fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        // Store current text and features for future use
        this.currentText = text;
        this.selectedFeatures = features;

        console.log('🔨 Compiling editing font...');
        const startTime = performance.now();

        try {
            // TODO: In the future, extract glyph names from text and compile subset
            // For now, compile full font with editing target
            const result = await window.fontCompilation.compileFromJson(
                this.babelfontJson,
                'editing-font.ttf',
                'editing'
            );

            this.editingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                `✅ Editing font compiled in ${duration}ms (${this.editingFont.length} bytes)`
            );

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
            console.error('❌ Failed to compile editing font:', error);
            throw error;
        }
    }

    /**
     * Fetch current font JSON from Python
     * @returns {Promise<string>} - The babelfont JSON string
     */
    async fetchFontJsonFromPython() {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        const pythonResult = await window.pyodide.runPythonAsync(`
import orjson

# Get current font using CurrentFont()
font = CurrentFont()
if not font:
    raise ValueError("No font is currently open")

# Export to .babelfont JSON format using orjson (handles datetime objects)
font_dict = font.to_dict()
babelfont_json = orjson.dumps(font_dict).decode('utf-8')

# Return the JSON
babelfont_json
        `);

        if (
            !pythonResult ||
            pythonResult === 'None' ||
            pythonResult === 'undefined'
        ) {
            throw new Error('Failed to get font JSON from Python');
        }

        return pythonResult;
    }

    /**
     * Recompile editing font after font data changes
     * This reloads the font JSON from Python before compiling
     *
     * @param {string} babelfontJson - Optional pre-fetched JSON to avoid redundant Python call
     */
    async recompileEditingFont(babelfontJson = null) {
        try {
            // Only fetch from Python if not provided
            if (!babelfontJson) {
                console.log(
                    '🔄 Reloading font data from Python for recompilation...'
                );
                babelfontJson = await this.fetchFontJsonFromPython();
            } else {
                console.log('🔄 Using provided font data for recompilation...');
            }

            // Update cached font data
            this.babelfontJson = babelfontJson;
            this.babelfontData = JSON.parse(babelfontJson);
            console.log(`✅ Font data ready (${babelfontJson.length} bytes)`);

            // Now compile with updated data
            return await this.compileEditingFont(
                this.currentText,
                this.selectedFeatures
            );
        } catch (error) {
            console.error('Error reloading font data:', error);
            throw error;
        }
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
        if (!window.APP_SETTINGS?.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!window.pyodide || !this.typingFont) {
            return;
        }

        try {
            window.pyodide.FS.writeFile(
                '/_debug_typing_font.ttf',
                this.typingFont
            );
            console.log(
                `💾 Saved typing font to /_debug_typing_font.ttf (${this.typingFont.length} bytes)`
            );

            // Refresh file browser
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }
        } catch (error) {
            console.error('Failed to save typing font:', error);
        }
    }

    /**
     * Save editing font to file system
     */
    saveEditingFontToFileSystem() {
        if (!window.APP_SETTINGS?.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!window.pyodide || !this.editingFont) {
            return;
        }

        try {
            window.pyodide.FS.writeFile(
                '/_debug_editing_font.ttf',
                this.editingFont
            );
            console.log(
                `💾 Saved editing font to /_debug_editing_font.ttf (${this.editingFont.length} bytes)`
            );

            // Refresh file browser
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }
        } catch (error) {
            console.error('Failed to save editing font:', error);
        }
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

        // Extract from compiled typing font using opentype.js
        if (this.typingFont) {
            try {
                const font = opentype.parse(this.typingFont.buffer);
                const glyphOrder = [];
                for (let i = 0; i < font.numGlyphs; i++) {
                    const glyph = font.glyphs.get(i);
                    if (glyph && glyph.name) {
                        glyphOrder.push(glyph.name);
                    } else {
                        glyphOrder.push(`.notdef`);
                    }
                }
                // Cache the result
                this.glyphOrderCache = glyphOrder;
                return glyphOrder;
            } catch (error) {
                console.error(
                    'Failed to extract glyph order from typing font:',
                    error
                );
            }
        }

        console.warn('No glyph order available - font not loaded');
        return [];
    }

    /**
     * Get glyph name by GID from source font
     */
    getGlyphName(gid) {
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
}

// Create global instance
const fontManager = new FontManager();
window.fontManager = fontManager;

// Listen for font loaded events and initialize font manager
window.addEventListener('fontLoaded', async (event) => {
    try {
        console.log('🎯 FontManager: Received fontLoaded event');

        // Wait for font compilation system to be ready
        if (!window.fontCompilation || !window.fontCompilation.isInitialized) {
            console.log('⏳ Waiting for font compilation system...');
            // Wait up to 30 seconds for initialization
            let attempts = 0;
            while (
                attempts < 300 &&
                (!window.fontCompilation ||
                    !window.fontCompilation.isInitialized)
            ) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                attempts++;
            }
            if (
                !window.fontCompilation ||
                !window.fontCompilation.isInitialized
            ) {
                console.error(
                    '❌ Font compilation system not ready after 30 seconds'
                );
                return;
            }
            console.log('✅ Font compilation system ready');
        }

        // Get the babelfont JSON from Python
        console.log('📞 Fetching font from Python...');
        const pythonResult = await fontManager.fetchFontJsonFromPython();

        console.log(
            `📦 Received font JSON from Python (${pythonResult.length} bytes)`
        );

        // Load font into font manager
        await fontManager.loadFont(pythonResult);

        // Compile initial editing font
        await fontManager.compileEditingFont();
    } catch (error) {
        console.error('Failed to initialize font manager:', error);
    }
});

console.log('✅ Font Manager module loaded');
