// URL State Management
// Synchronizes application state with URL parameters

import { Logger } from './logger';
import type { UserspaceLocation } from './locations';
import {
    isTextAlign,
    parseLineHeightPercent,
    type TextAlign
} from './glyph-canvas/text-run-layout';

const console = new Logger('URLState');

export type { TextAlign };

export interface AppState {
    file?: string | null;
    mode?: 'text' | 'edit' | null;
    text?: string | null;
    cursor?: number | null;
    location?: string | null; // JSON-encoded userspace location
    features?: string | null; // Comma-separated list of active features
    lineheight?: number | null;
    align?: TextAlign | null;
    /** Cloud sparse residency. `true` writes `sparse=true`; `false` removes it. */
    sparse?: boolean | null;
}

function mustPercentEncodeQueryChar(ch: string, isKey: boolean): boolean {
    const code = ch.codePointAt(0);
    if (code === undefined) {
        return false;
    }
    // C0 controls, space, and DEL cannot appear raw in a URL.
    if (code <= 0x20 || code === 0x7f) {
        return true;
    }
    // Query delimiters, percent-escape introducer, and '+' (form-urlencoded
    // space) must be escaped. '=' splits key from value.
    if (ch === '#' || ch === '&' || ch === '%' || ch === '+') {
        return true;
    }
    return isKey && ch === '=';
}

/**
 * Percent-encode only characters that would break the query string.
 * ASCII space becomes `+` in values so `text=hello+world` stays readable;
 * a literal `+` becomes `%2B`.
 */
/**
 * Store newlines as the two-character sequence `\n` in URL query values.
 * Backslashes are doubled so a typed `\n` round-trips.
 */
export function encodeTextForUrl(text: string): string {
    let encoded = '';
    for (const ch of text) {
        if (ch === '\\') {
            encoded += '\\\\';
            continue;
        }
        if (ch === '\n') {
            encoded += '\\n';
            continue;
        }
        encoded += ch;
    }
    return encoded;
}

/** Inverse of `encodeTextForUrl`; also keeps a real newline from `%0A`. */
export function decodeTextFromUrl(text: string): string {
    let decoded = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            const next = text[i + 1];
            if (next === 'n') {
                decoded += '\n';
                i += 1;
                continue;
            }
            if (next === '\\') {
                decoded += '\\';
                i += 1;
                continue;
            }
        }
        decoded += ch;
    }
    return decoded;
}

export function encodeQueryComponent(value: string, isKey = false): string {
    let encoded = '';
    for (const ch of value) {
        if (!isKey && ch === ' ') {
            encoded += '+';
            continue;
        }
        encoded += mustPercentEncodeQueryChar(ch, isKey)
            ? encodeURIComponent(ch)
            : ch;
    }
    return encoded;
}

export function serializeSearchParams(params: URLSearchParams): string {
    const parts: string[] = [];
    for (const [key, value] of params) {
        parts.push(
            `${encodeQueryComponent(key, true)}=${encodeQueryComponent(value)}`
        );
    }
    return parts.join('&');
}

/** Absolute href using minimal query encoding (keeps `:`, `/`, `,`, Unicode). */
export function formatUrl(url: URL): string {
    const query = serializeSearchParams(url.searchParams);
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
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
        } else if (key === 'sparse') {
            if (value === true || value === 'true' || value === '1') {
                searchParams.set('sparse', 'true');
            } else {
                searchParams.delete('sparse');
            }
        } else if (key === 'text') {
            searchParams.set(key, encodeTextForUrl(String(value)));
        } else {
            searchParams.set(key, String(value));
        }
    }

    // Update URL without reload
    const query = serializeSearchParams(searchParams);
    const newUrl = `${url.pathname}${query ? '?' + query : ''}`;
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

    // Text (`+` is a space; `%2B` is a literal plus; `\n` is a line break)
    const text = urlParams.get('text');
    if (text) state.text = decodeTextFromUrl(text);

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

    const lineheight = parseLineHeightPercent(urlParams.get('lineheight'));
    if (lineheight !== null) state.lineheight = lineheight;

    const align = urlParams.get('align');
    if (isTextAlign(align)) state.align = align;

    const sparse = parseSparseQueryValue(urlParams.get('sparse'));
    if (sparse !== undefined) {
        state.sparse = sparse;
    }

    console.log('Read state from URL:', state);
    return state;
}

/** `sparse=true` / `sparse=1` enable sparse cloud residency. */
export function parseSparseQueryValue(
    raw: string | null | undefined
): boolean | undefined {
    if (raw == null || raw === '') {
        return undefined;
    }
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    return undefined;
}

/**
 * Encode userspace location as URL parameter
 * Converts {wght: 400, wdth: 100} to "wght:400,wdth:100"
 * Values are rounded to integers
 */
export function encodeLocation(location: UserspaceLocation): string {
    return Object.entries(location)
        .map(([tag, value]) => `${tag}:${Math.round(Number(value))}`)
        .join(',');
}

/**
 * Decode userspace location from URL parameter
 * Converts "wght:400,wdth:100" to {wght: 400, wdth: 100}
 */
export function decodeLocation(encoded: string): UserspaceLocation | null {
    if (!encoded) return null;

    try {
        const result: UserspaceLocation = {};
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
