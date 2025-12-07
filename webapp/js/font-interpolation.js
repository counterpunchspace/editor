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
 * Font Interpolation Module
 * 
 * Provides high-level API for glyph interpolation using the fontc worker.
 * The worker automatically caches fonts during compilation, so you don't need
 * to explicitly store them - just compile after edits and interpolation will work!
 * 
 * @example
 * // After compilation, interpolation is ready:
 * const layer = await fontInterpolation.interpolateGlyph('A', { wght: 550 });
 * 
 * // Batch interpolate:
 * const layers = await fontInterpolation.interpolateGlyphs(['A', 'B', 'C'], { wght: 550 });
 */

class FontInterpolationManager {
    constructor() {
        this.worker = null;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.currentGlyphRequest = null; // Track current glyph being interpolated
    }

    /**
     * Initialize the interpolation manager with the fontc worker
     * 
     * @param {Worker} worker - The fontc worker instance
     */
    setWorker(worker) {
        this.worker = worker;
        console.log('[FontInterpolation]', '✅ Worker connected for interpolation');
    }

    /**
     * Interpolate a glyph at a specific location in design space
     * Cancels any pending interpolation for the same glyph
     * 
     * @param {string} glyphName - Name of the glyph to interpolate
     * @param {Object} location - Axis locations, e.g., { wght: 550, wdth: 100 }
     * @returns {Promise<Object>} Interpolated layer object with shapes, anchors, width, etc.
     * @throws {Error} If no font is cached or interpolation fails
     * 
     * @example
     * const layer = await interpolateGlyph('A', { wght: 550 });
     * console.log(layer.width); // 600
     * console.log(layer.shapes); // Array of Path and Component objects
     */
    async interpolateGlyph(glyphName, location) {
        if (!this.worker) {
            throw new Error(
                'Worker not initialized. Make sure fontCompilation is initialized first.'
            );
        }

        // Cancel previous request for this glyph if it exists
        if (this.currentGlyphRequest && this.currentGlyphRequest.glyphName === glyphName) {
            const oldId = this.currentGlyphRequest.id;
            const oldRequest = this.pendingRequests.get(oldId);
            if (oldRequest) {
                // Reject the old request as cancelled
                oldRequest.reject(new Error('Interpolation cancelled - newer request pending'));
                this.pendingRequests.delete(oldId);
            }
        }

        const id = this.requestId++;
        
        // Track this as the current request for this glyph
        this.currentGlyphRequest = { id, glyphName };

        return new Promise((resolve, reject) => {
            // Store the promise callbacks
            this.pendingRequests.set(id, { resolve, reject, glyphName });

            // Send interpolation request to worker
            this.worker.postMessage({
                type: 'interpolate',
                id,
                glyphName,
                location
            });
        });
    }

    /**
     * Handle message from worker
     * @private
     */
    handleWorkerMessage(e) {
        const data = e.data;
        
        console.log('[FontInterpolation]', 'Received worker message:', data.type, 'id:', data.id);
        
        if (data.type === 'interpolate') {
            const pending = this.pendingRequests.get(data.id);
            console.log('[FontInterpolation]', 'Found pending request:', !!pending);
            
            if (pending) {
                this.pendingRequests.delete(data.id);
                
                if (data.error) {
                    console.error('[FontInterpolation]', 'Interpolation error:', data.error);
                    pending.reject(new Error(data.error));
                } else {
                    // Parse the JSON layer
                    try {
                        const layer = JSON.parse(data.result);
                        console.log('[FontInterpolation]', '✅ Parsed layer, resolving promise');
                        pending.resolve(layer);
                    } catch (parseError) {
                        console.error('[FontInterpolation]', 'Parse error:', parseError);
                        pending.reject(new Error(`Failed to parse layer JSON: ${parseError}`));
                    }
                }
            }
        }
    }

    /**
     * Interpolate multiple glyphs at once
     * 
     * @param {Array<string>} glyphNames - Array of glyph names
     * @param {Object} location - Axis locations
     * @returns {Promise<Map<string, Object>>} Map of glyph name to interpolated layer
     * 
     * @example
     * const layers = await interpolateGlyphs(['A', 'B', 'C'], { wght: 550 });
     * layers.get('A').width; // 600
     */
    async interpolateGlyphs(glyphNames, location) {
        const promises = glyphNames.map(async (glyphName) => {
            try {
                const layer = await this.interpolateGlyph(glyphName, location);
                return [glyphName, layer];
            } catch (error) {
                console.warn(
                    '[FontInterpolation]',
                    `⚠️ Failed to interpolate '${glyphName}':`,
                    error
                );
                return [glyphName, null];
            }
        });

        const results = await Promise.all(promises);
        return new Map(results.filter(([_, layer]) => layer !== null));
    }

    /**
     * Clear the cached font from worker memory
     */
    async clearCache() {
        if (!this.worker) {
            console.warn('[FontInterpolation]', 'Worker not initialized');
            return;
        }

        console.log('[FontInterpolation]', '🗑️ Clearing font cache...');
        
        return new Promise((resolve, reject) => {
            const messageHandler = (e) => {
                if (e.data.type === 'clearCache') {
                    this.worker.removeEventListener('message', messageHandler);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve();
                    }
                }
            };
            
            this.worker.addEventListener('message', messageHandler);
            this.worker.postMessage({ type: 'clearCache' });
        });
    }
}

// Create singleton instance
const fontInterpolation = new FontInterpolationManager();

// Make available globally
if (typeof window !== 'undefined') {
    window.fontInterpolation = fontInterpolation;
}

export default fontInterpolation;
