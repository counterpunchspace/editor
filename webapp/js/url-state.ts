// URL State Management
// Synchronizes application state with URL parameters

import { Logger } from './logger';

const console = new Logger('URLState', true);

export interface AppState {
    file?: string | null;
    mode?: 'text' | 'edit' | null;
    text?: string | null;
    cursor?: number | null;
    location?: string | null; // JSON-encoded designspace location
    features?: string | null; // Comma-separated list of active features
}

/**
 * Update URL with application state
 * Only updates parameters that are provided (partial update)
 */
export function updateUrlState(state: AppState): void {
    const url = new URL(window.location.href);
    const searchParams = new URLSearchParams(url.search);

    // Update or remove parameters
    for (const [key, value] of Object.entries(state)) {
        if (value === null || value === undefined) {
            searchParams.delete(key);
        } else {
            searchParams.set(key, String(value));
        }
    }

    // Update URL without reload
    const newUrl = `${url.pathname}${searchParams.toString() ? '?' + searchParams.toString() : ''}`;
    window.history.replaceState(null, '', newUrl);
    console.log('URL updated:', newUrl);
}

/**
 * Read application state from URL
 */
export function readUrlState(): AppState {
    const urlParams = new URLSearchParams(window.location.search);

    const state: AppState = {};

    // File
    const file = urlParams.get('file');
    if (file) state.file = file;

    // Mode
    const mode = urlParams.get('mode');
    if (mode === 'text' || mode === 'edit') state.mode = mode;

    // Text
    const text = urlParams.get('text');
    if (text) state.text = decodeURIComponent(text);

    // Cursor
    const cursor = urlParams.get('cursor');
    if (cursor) {
        const cursorNum = parseInt(cursor, 10);
        if (!isNaN(cursorNum)) state.cursor = cursorNum;
    }

    // Location
    const location = urlParams.get('location');
    if (location) state.location = location;

    // Features
    const features = urlParams.get('features');
    if (features) state.features = features;

    console.log('Read state from URL:', state);
    return state;
}

/**
 * Encode designspace location as URL parameter
 * Converts {wght: 400, wdth: 100} to "wght:400,wdth:100"
 */
export function encodeLocation(location: Record<string, number>): string {
    return Object.entries(location)
        .map(([tag, value]) => `${tag}:${value}`)
        .join(',');
}

/**
 * Decode designspace location from URL parameter
 * Converts "wght:400,wdth:100" to {wght: 400, wdth: 100}
 */
export function decodeLocation(encoded: string): Record<string, number> | null {
    if (!encoded) return null;

    try {
        const result: Record<string, number> = {};
        const pairs = encoded.split(',');

        for (const pair of pairs) {
            const [tag, valueStr] = pair.split(':');
            const value = parseFloat(valueStr);

            if (!tag || isNaN(value)) {
                console.warn('Invalid location pair:', pair);
                continue;
            }

            result[tag] = value;
        }

        return Object.keys(result).length > 0 ? result : null;
    } catch (error) {
        console.error('Error decoding location:', error);
        return null;
    }
}

/**
 * Encode feature list as URL parameter
 * Converts ['liga', 'kern'] to "liga,kern"
 */
export function encodeFeatures(features: string[]): string {
    return features.join(',');
}

/**
 * Decode feature list from URL parameter
 * Converts "liga,kern" to ['liga', 'kern']
 */
export function decodeFeatures(encoded: string): string[] | null {
    if (!encoded) return null;
    return encoded.split(',').filter((f) => f.length > 0);
}
