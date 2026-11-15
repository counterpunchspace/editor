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

import { Logger } from './logger';
import { editorHealth } from './editor-health-monitor';

const console = new Logger('FontInterpolation');

/**
 * Font Interpolation Module
 *
 * Provides high-level API for glyph interpolation using the fontc worker.
 * The worker automatically caches fonts during compilation, so you don't need
 * to explicitly store them - just compile after edits and interpolation will work!
 *
 * @example
 * // After compilation, interpolation is ready:
 * const drawing = await fontInterpolation.interpolateGlyph('A', { wght: 550 });
 *
 * // Batch interpolate:
 * const drawings = await fontInterpolation.interpolateGlyphs(['A', 'B', 'C'], { wght: 550 });
 */

class FontInterpolationManager {
    worker: Worker | null;
    pendingRequests: Map<
        number,
        {
            resolve: Function;
            reject: Function;
            glyphName: string;
            requestKey: string;
            queuedAt: number;
        }
    >;
    requestId: number;
    currentGlyphRequest: {
        id: number;
        glyphName: string;
        requestKey: string;
    } | null;
    lastRenderedRequestId: number;
    constructor() {
        this.worker = null;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.currentGlyphRequest = null; // Track current glyph being interpolated
        this.lastRenderedRequestId = -1; // Track the last rendered request to discard out-of-order responses
    }

    /**
     * Initialize the interpolation manager with the fontc worker
     *
     * @param {Worker} worker - The fontc worker instance
     */
    setWorker(worker: Worker) {
        this.worker = worker;
        console.log(
            '[FontInterpolation]',
            '✅ Worker connected for interpolation'
        );
    }

    /**
     * Interpolate a glyph at a specific location in design space
     * Cancels any pending interpolation for the same glyph
     *
     * @param {string} glyphName - Name of the glyph to interpolate
     * @param {Object} location - Axis locations, e.g., { wght: 550, wdth: 100 }
     * @returns {Promise<Object>} Interpolated drawing object with shapes, anchors, width, etc.
     * @throws {Error} If no font is cached or interpolation fails
     *
     * @example
     * const drawing = await interpolateGlyph('A', { wght: 550 });
     * console.log(drawing.width); // 600
     * console.log(drawing.shapes); // Array of Path and Component objects
     */
    async interpolateGlyph(
        glyphName: string,
        location: import('./locations').UserspaceLocation,
        extrapolate: boolean = false,
        rootDrawingIds?: string[]
    ): Promise<any> {
        if (!this.worker) {
            throw new Error(
                'Worker not initialized. Make sure fontCompilation is initialized first.'
            );
        }

        const interpolationDomain = rootDrawingIds
            ? [...rootDrawingIds].sort().join(',')
            : '';
        const requestKey = `${glyphName}\u001e${interpolationDomain}`;

        // A new family selection for a glyph must supersede its prior request.
        // Different glyphs can still interpolate concurrently.
        if (
            this.currentGlyphRequest &&
            this.currentGlyphRequest.glyphName === glyphName
        ) {
            const oldId = this.currentGlyphRequest.id;
            const oldRequest = this.pendingRequests.get(oldId);
            if (oldRequest) {
                // Reject the old request as cancelled
                oldRequest.reject(
                    new Error('Interpolation cancelled - newer request pending')
                );
                this.pendingRequests.delete(oldId);
            }
        }

        const id = this.requestId++;

        // Track this as the current request for this glyph and drawing family.
        this.currentGlyphRequest = { id, glyphName, requestKey };

        return new Promise((resolve, reject) => {
            // Store the promise callbacks
            this.pendingRequests.set(id, {
                resolve,
                reject,
                glyphName,
                requestKey,
                queuedAt: Date.now()
            });

            // Send interpolation request to worker
            this.worker!.postMessage({
                type: 'interpolate',
                id,
                glyphName,
                location,
                extrapolate,
                rootLayerIds: rootDrawingIds
            });
        });
    }

    /**
     * Handle message from worker
     * @private
     */
    handleWorkerMessage(e: MessageEvent) {
        const data = e.data;

        console.log(
            '[FontInterpolation]',
            'Received worker message:',
            data.type,
            'id:',
            data.id
        );

        if (data.type === 'interpolate') {
            editorHealth.noteWorkerMessage();
            const pending = this.pendingRequests.get(data.id);
            console.log(
                '[FontInterpolation]',
                'Found pending request:',
                !!pending
            );

            if (!pending) {
                editorHealth.noteUnmatchedInterpolateReply();
                return;
            }

            if (pending) {
                // Check if this is still the current request for this glyph family.
                // Ignore stale responses that arrived after a newer request was made
                if (
                    this.currentGlyphRequest &&
                    this.currentGlyphRequest.glyphName === pending.glyphName &&
                    this.currentGlyphRequest.id !== data.id
                ) {
                    console.log(
                        '[FontInterpolation]',
                        '⏩ Ignoring stale response for',
                        pending.requestKey,
                        '(request',
                        data.id,
                        'superseded by',
                        this.currentGlyphRequest.id,
                        ')'
                    );
                    this.pendingRequests.delete(data.id);
                    pending.reject(
                        new Error(
                            'Interpolation cancelled - newer request pending'
                        )
                    );
                    return;
                }

                this.pendingRequests.delete(data.id);

                if (data.error) {
                    console.error(
                        '[FontInterpolation]',
                        'Interpolation error:',
                        data.error
                    );
                    pending.reject(new Error(data.error));
                } else {
                    // Parse the JSON drawing
                    try {
                        const drawing = JSON.parse(data.result);
                        console.log(
                            '[FontInterpolation]',
                            '✅ Parsed drawing, resolving promise with requestId:',
                            data.id
                        );
                        // Include the request ID with the drawing so the caller can check ordering
                        drawing._interpolationRequestId = data.id;
                        pending.resolve(drawing);
                    } catch (parseError) {
                        console.error(
                            '[FontInterpolation]',
                            'Parse error:',
                            parseError
                        );
                        pending.reject(
                            new Error(
                                `Failed to parse drawing JSON: ${parseError}`
                            )
                        );
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
     * @returns {Promise<Map<string, Object>>} Map of glyph name to interpolated drawing
     *
     * @example
     * const drawings = await interpolateGlyphs(['A', 'B', 'C'], { wght: 550 });
     * drawings.get('A').width; // 600
     */
    async interpolateGlyphs(
        glyphNames: string[],
        location: Record<string, number>
    ): Promise<Map<string, any>> {
        const promises = glyphNames.map(
            async (glyphName): Promise<[string, any]> => {
                try {
                    const drawing = await this.interpolateGlyph(
                        glyphName,
                        location
                    );
                    return [glyphName, drawing];
                } catch (error) {
                    console.warn(
                        '[FontInterpolation]',
                        `⚠️ Failed to interpolate '${glyphName}':`,
                        error
                    );
                    return [glyphName, null];
                }
            }
        );

        const results = await Promise.all(promises);
        return new Map(results.filter(([_, drawing]) => drawing !== null));
    }

    /**
     * Reset the last rendered request ID counter
     * Call this when switching glyphs or exiting interpolation mode to prevent
     * stale responses from old sessions being discarded incorrectly
     */
    resetRequestTracking() {
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(
                new Error('Interpolation cancelled - request tracking reset')
            );
            this.pendingRequests.delete(id);
        }
        this.currentGlyphRequest = null;
        this.lastRenderedRequestId = -1;
        console.log('[FontInterpolation]', '🔄 Reset request tracking');
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

        return new Promise<void>((resolve, reject) => {
            const messageHandler = (e: MessageEvent) => {
                if (e.data.type === 'clearCache') {
                    this.worker!.removeEventListener('message', messageHandler);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve();
                    }
                }
            };

            this.worker!.addEventListener('message', messageHandler);
            this.worker!.postMessage({ type: 'clearCache' });
        });
    }
}

// Create singleton
export const fontInterpolation = new FontInterpolationManager();

// Make available globally
if (typeof window !== 'undefined') {
    window.fontInterpolation = fontInterpolation;
}
