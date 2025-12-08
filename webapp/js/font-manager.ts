// Font Manager
// Implements two-stage font compilation architecture:
// 1. "typing" font: Compiled once when font opens, kept in memory permanently for glyph name extraction
// 2. "editing" font: Recompiled on demand with subset of glyphs for display in canvas

import { ParsedNode } from './basictypes';
import APP_SETTINGS from './settings';
import { fontCompilation } from './font-compilation';
class FontManager {
    babelfontJson: string | null;
    babelfontData: any;
    typingFont: Uint8Array | null;
    editingFont: Uint8Array | null;
    currentText: string;
    selectedFeatures: string[];
    isCompiling: boolean;
    glyphOrderCache: string[] | null;

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
    async loadFont(babelfontJson: string) {
        console.log('[FontManager]', '🔧 FontManager: Loading font...');
        this.babelfontJson = babelfontJson;
        this.babelfontData = JSON.parse(babelfontJson);
        this.typingFont = null;
        this.editingFont = null;
        this.glyphOrderCache = null; // Clear cache for new font

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
        if (!this.babelfontJson) {
            throw new Error('No font loaded');
        }

        if (!fontCompilation || !fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        console.log('[FontManager]', '🔨 Compiling typing font...');
        const startTime = performance.now();

        try {
            const result = await fontCompilation.compileFromJson(
                this.babelfontJson,
                'typing-font.ttf',
                'typing'
            );

            this.typingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                '[FontManager]',
                `✅ Typing font compiled in ${duration}ms (${this.typingFont.length} bytes)`
            );

            // Save to file system for review
            this.saveTypingFontToFileSystem();
        } catch (error) {
            console.error(
                '[FontManager]',
                '❌ Failed to compile typing font:',
                error
            );
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
        if (!this.babelfontJson) {
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
                this.babelfontJson,
                'editing-font.ttf',
                'editing'
            );

            this.editingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            console.log(
                '[FontManager]',
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
            console.error(
                '[FontManager]',
                '❌ Failed to compile editing font:',
                error
            );
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
    async recompileEditingFont(babelfontJson: string = '') {
        try {
            // Only fetch from Python if not provided
            if (!babelfontJson) {
                console.log(
                    '[FontManager]',
                    '🔄 Reloading font data from Python for recompilation...'
                );
                babelfontJson = await this.fetchFontJsonFromPython();
            } else {
                console.log(
                    '[FontManager]',
                    '🔄 Using provided font data for recompilation...'
                );
            }

            // Update cached font data
            this.babelfontJson = babelfontJson;
            this.babelfontData = JSON.parse(babelfontJson!);
            console.log(
                '[FontManager]',
                `✅ Font data ready (${babelfontJson!.length} bytes)`
            );

            // Now compile with updated data
            return await this.compileEditingFont(
                this.currentText,
                this.selectedFeatures
            );
        } catch (error) {
            console.error('[FontManager]', 'Error reloading font data:', error);
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
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
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
                '[FontManager]',
                `💾 Saved typing font to /_debug_typing_font.ttf (${this.typingFont.length} bytes)`
            );

            // Refresh file browser
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }
        } catch (error) {
            console.error(
                '[FontManager]',
                'Failed to save typing font:',
                error
            );
        }
    }

    /**
     * Save editing font to file system
     */
    saveEditingFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
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
                '[FontManager]',
                `💾 Saved editing font to /_debug_editing_font.ttf (${this.editingFont.length} bytes)`
            );

            // Refresh file browser
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }
        } catch (error) {
            console.error(
                '[FontManager]',
                'Failed to save editing font:',
                error
            );
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
                const font = window.opentype.parse(this.typingFont.buffer);
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

    /**
     *  Fetch layer data for a specific component glyph
     *
     * @param {string} componentGlyphName
     * @param {string} selectedLayerId
     * @returns any
     */

    async fetchComponentLayerData(
        componentGlyphName: string,
        selectedLayerId: string
    ): Promise<any> {
        // Fetch layer data for a specific component glyph, including nested components
        if (!window.pyodide || !selectedLayerId) {
            return null;
        }

        try {
            const dataJson = await window.pyodide.runPythonAsync(`
import json

def fetch_component_recursive(glyph_name, layer_id, visited=None):
    """Recursively fetch component data including nested components"""
    if visited is None:
        visited = set()
    
    if glyph_name in visited:
        print(f"Warning: Circular component reference detected for {glyph_name}")
        return None
    
    visited.add(glyph_name)
    
    current_font = CurrentFont()
    if not current_font or not hasattr(current_font, 'glyphs'):
        return None
    
    glyph = current_font.glyphs.get(glyph_name)
    if not glyph:
        return None
    
    # Find the layer by ID
    layer = None
    for l in glyph.layers:
        if l.id == layer_id:
            layer = l
            break
    
    if not layer:
        return None
    
    # Serialize the layer
    result = layer.to_dict()
    
    # Recursively fetch nested component data
    if result and 'shapes' in result:
        for shape in result['shapes']:
            if 'Component' in shape and 'reference' in shape['Component']:
                ref_name = shape['Component']['reference']
                # Fetch nested component data
                nested_data = fetch_component_recursive(ref_name, layer_id, visited.copy())
                if nested_data:
                    shape['Component']['layerData'] = nested_data
    
    return result

result = None
try:
    result = fetch_component_recursive('${componentGlyphName}', '${selectedLayerId}')
except Exception as e:
    print(f"Error fetching component layer data: {e}")
    import traceback
    traceback.print_exc()
    result = None

json.dumps(result)
`);

            return JSON.parse(dataJson);
        } catch (error) {
            console.error(
                '[GlyphCanvas]',
                'Error fetching component layer data from Python:',
                error
            );
            return null;
        }
    }

    async fetchRootLayerData(glyphName: string, layerId: string): Promise<any> {
        // Fetch full root layer data including shapes
        if (!window.pyodide || !layerId) {
            return null;
        }

        const dataJson = await window.pyodide.runPythonAsync(`
import json

def fetch_component_recursive(glyph_name, layer_id, visited=None):
    """Recursively fetch component data including nested components"""
    if visited is None:
        visited = set()
    
    if glyph_name in visited:
        print(f"Warning: Circular component reference detected for {glyph_name}")
        return None
    
    visited.add(glyph_name)
    
    current_font = CurrentFont()
    if not current_font or not hasattr(current_font, 'glyphs'):
        return None
    
    glyph = current_font.glyphs.get(glyph_name)
    if not glyph:
        return None
    
    # Find the layer by ID
    layer = None
    for l in glyph.layers:
        if l.id == layer_id:
            layer = l
            break
    
    if not layer:
        return None
    
    # Serialize the layer
    result = layer.to_dict()
    
    # Recursively fetch nested component data
    if result and 'shapes' in result:
        for shape in result['shapes']:
            if 'Component' in shape and 'reference' in shape['Component']:
                ref_name = shape['Component']['reference']
                # Fetch nested component data
                nested_data = fetch_component_recursive(ref_name, layer_id, visited.copy())
                if nested_data:
                    shape['Component']['layerData'] = nested_data
    
    return result

result = None
try:
    result = fetch_component_recursive('${glyphName}', '${layerId}')
except Exception as e:
    print(f"Error fetching layer data: {e}")
    import traceback
    traceback.print_exc()
    result = None

json.dumps(result)
`);

        let layerData = JSON.parse(dataJson);
        // Clear isInterpolated flag since we're loading actual layer data
        if (layerData) {
            layerData.isInterpolated = false;
        }
        console.log(
            '[FontManager]',
            'Fetched root layer data with',
            layerData?.shapes?.length || 0,
            'shapes'
        );
        return layerData;
    }

    /**
     *
     * @param {Event} e
     */
    async onFontLoaded(e: Event): Promise<ArrayBuffer | null> {
        console.log('[FontManager]', 'Font loaded event received');
        if (window.glyphCanvas && window.pyodide) {
            try {
                // Try to find a compiled TTF in the file system
                const result = await window.pyodide.runPythonAsync(`
import os
import glob

# Look for TTF files in the current directory and subdirectories
ttf_files = []
for root, dirs, files in os.walk('.'):
    for file in files:
        if file.endswith('.ttf'):
            ttf_files.append(os.path.join(root, file))

# Use the most recently modified TTF
if ttf_files:
    ttf_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    ttf_files[0]
else:
    None
                `);

                if (result) {
                    console.log('[FontManager]', 'Found TTF file:', result);
                    const fontBytes = window.pyodide.FS.readFile(result);
                    const arrayBuffer = fontBytes.buffer.slice(
                        fontBytes.byteOffset,
                        fontBytes.byteOffset + fontBytes.byteLength
                    );
                    return arrayBuffer;
                } else {
                    console.warn(
                        '[FontManager]',
                        'No TTF files found in file system'
                    );
                }
            } catch (error) {
                console.error(
                    '[FontManager]',
                    'Error loading font from file system:',
                    error
                );
            }
        }
        return null;
    }

    /**
     * Looks for a font-level format_specific key in the current font
     *
     * @param {string} key
     * @returns {any}
     */
    getFormatSpecific(key: string): any {
        return this.babelfontData?.format_specific?.[key];
    }

    /**
     * Sets a font-level format_specific key in the current font
     *
     * @param {string} key
     * @param {any} value
     */
    setFormatSpecific(key: string, value: any) {
        if (this.babelfontData) {
            if (!this.babelfontData.format_specific) {
                this.babelfontData.format_specific = {};
            }
            this.babelfontData.format_specific[key] = value;
        }
    }

    async fetchGlyphData(glyphName: string): Promise<any> {
        // Fetch glyph and font data from Python
        if (!window.pyodide) {
            return null;
        }
        try {
            // Fetch glyph and font data from Python
            const dataJson = await window.pyodide.runPythonAsync(`
import json

result = None
try:
    current_font = CurrentFont()
    if current_font and hasattr(current_font, 'glyphs'):
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Get master IDs for filtering
            master_ids = set(m.id for m in current_font.masters)
            
            # Get foreground layers (filter out background layers and non-master layers)
            layers_data = []
            for layer in glyph.layers:
                if not layer.is_background:
                    # For master layers, _master is None and the layer.id IS the master ID
                    # For alternate/intermediate layers, _master points to the parent master
                    master_id = layer._master if layer._master else layer.id
                    
                    # Only include layers whose master ID exists in the masters list
                    if master_id in master_ids:
                        layer_info = {
                            'id': layer.id,
                            'name': layer.name or 'Default',
                            '_master': master_id,
                            'location': layer.location
                        }
                        layers_data.append(layer_info)
            
            # Get masters data with userspace locations
            masters_data = []
            for master in current_font.masters:
                # Convert design space location to user space
                userspace_location = current_font.map_backward(master.location)
                masters_data.append({
                    'id': master.id,
                    'name': master.name,
                    'location': userspace_location
                })
            
            # Get axes order (list of axis tags in definition order)
            axes_order = [axis.tag for axis in current_font.axes]
            
            result = {
                'glyphName': glyph.name,
                'layers': layers_data,
                'masters': masters_data,
                'axesOrder': axes_order
            }
except Exception as e:
    print(f"Error fetching glyph data: {e}")
    result = None

json.dumps(result)
`);

            return JSON.parse(dataJson);
        } catch (error) {
            console.error(
                '[GlyphCanvas]',
                'Error fetching glyph data from Python:',
                error
            );
            return null;
        }
    }

    async fetchLayerData(glyphName: string, layerId: string): Promise<any> {
        const dataJson = await window.pyodide.runPythonAsync(`
import json

# Get current font once at the top level
current_font = CurrentFont()
if not current_font or not hasattr(current_font, 'glyphs'):
    result = None
else:
    def fetch_component_recursive(font, glyph_name, layer_id, visited=None):
        """Recursively fetch component data including nested components"""
        if visited is None:
            visited = set()
        
        if glyph_name in visited:
            print(f"Warning: Circular component reference detected for {glyph_name}")
            return None
        
        visited.add(glyph_name)
        
        if not font or not hasattr(font, 'glyphs'):
            return None
        
        glyph = font.glyphs.get(glyph_name)
        if not glyph:
            return None
        
        # Find the layer by ID
        layer = None
        for l in glyph.layers:
            if l.id == layer_id:
                layer = l
                break
        
        if not layer:
            return None
        
        # Serialize the layer
        result = layer.to_dict()
        
        # Recursively fetch nested component data
        if result and 'shapes' in result:
            for shape in result['shapes']:
                if 'Component' in shape and 'reference' in shape['Component']:
                    ref_name = shape['Component']['reference']
                    # Fetch nested component data
                    nested_data = fetch_component_recursive(font, ref_name, layer_id, visited.copy())
                    if nested_data:
                        shape['Component']['layerData'] = nested_data
        
        return result

    result = None
    try:
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Find the layer by ID
            layer = None
            for l in glyph.layers:
                if l.id == '${layerId}':
                    layer = l
                    break
            
            if layer:
                # Use to_dict() to serialize the layer
                result = layer.to_dict()
                
                # Recursively fetch component layer data
                if result and 'shapes' in result:
                    for shape in result['shapes']:
                        if 'Component' in shape and 'reference' in shape['Component']:
                            ref_name = shape['Component']['reference']
                            nested_data = fetch_component_recursive(current_font, ref_name, '${layerId}')
                            if nested_data:
                                shape['Component']['layerData'] = nested_data
    except Exception as e:
        print(f"Error fetching layer data: {e}")
        import traceback
        traceback.print_exc()
        result = None

json.dumps(result)
`);

        return JSON.parse(dataJson);
    }

    async saveLayerData(glyphName: string, layerId: string, layerData: any) {
        // Convert nodes array back to string format for Python
        const layerDataCopy = JSON.parse(JSON.stringify(layerData));
        if (layerDataCopy.shapes) {
            layerDataCopy.shapes.forEach((shape: any) => {
                if (shape.nodes && Array.isArray(shape.nodes)) {
                    // Convert array back to string: [[x, y, type], ...] -> "x y type x y type ..."
                    const nodesString = shape.nodes
                        .map(
                            (node: ParsedNode) =>
                                `${node[0]} ${node[1]} ${node[2]}`
                        )
                        .join(' ');
                    // Store in Path.nodes format
                    if (!shape.Path) {
                        shape.Path = {};
                    }
                    shape.Path.nodes = nodesString;
                    shape.Path.closed = true; // Assume closed for now
                    delete shape.nodes; // Remove the parsed array
                }
            });
        }
        const layerDataJson = JSON.stringify(layerDataCopy);

        await window.pyodide.runPythonAsync(`
import json

try:
    current_font = CurrentFont()
    if current_font and hasattr(current_font, 'glyphs'):
        glyph = current_font.glyphs.get('${glyphName}')
        if glyph:
            # Find the layer by ID
            layer = None
            for l in glyph.layers:
                if l.id == '${layerId}':
                    layer = l
                    break
            
            if layer:
                # Parse the JSON data
                layer_dict = json.loads('''${layerDataJson}''')
                
                # Update the layer's _data dictionary directly
                # from_dict() is a classmethod that creates a NEW object,
                # so we need to update the existing layer's internal data
                layer._data.update(layer_dict)
                
                # Mark layer and parent glyph as dirty to trigger recompilation
                if hasattr(layer, 'mark_dirty'):
                    layer.mark_dirty()
                
                # Also mark glyph dirty
                if glyph and hasattr(glyph, 'mark_dirty'):
                    glyph.mark_dirty()
                
except Exception as e:
    print(f"Error saving layer data: {e}")
    import traceback
    traceback.print_exc()
`);
    }
}

// Create singleton instance
const fontManager = new FontManager();
export default fontManager;

// Listen for font loaded events and initialize font manager
window.addEventListener('fontLoaded', async (event) => {
    try {
        console.log(
            '[FontManager]',
            '🎯 FontManager: Received fontLoaded event'
        );

        // Wait for font compilation system to be ready
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

        // Get the babelfont JSON from Python
        console.log('[FontManager]', '📞 Fetching font from Python...');
        const pythonResult = await fontManager.fetchFontJsonFromPython();

        console.log(
            '[FontManager]',
            `📦 Received font JSON from Python (${pythonResult.length} bytes)`
        );

        // Load font into font manager
        await fontManager.loadFont(pythonResult);

        // Compile initial editing font
        await fontManager.compileEditingFont();
    } catch (error) {
        console.error(
            '[FontManager]',
            'Failed to initialize font manager:',
            error
        );
    }
});

console.log('[FontManager]', '✅ Font Manager module loaded');
