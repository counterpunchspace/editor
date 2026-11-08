// Stack Trace Source Mapping
// Applies source maps to stack traces for readable error reports

import { SourceMapConsumer } from 'source-map-js';
import { Logger } from './logger';

const console = new Logger('StackMapper');

// Source maps by script URL. The in-flight promise is cached, so every frame
// of a stack (and every concurrent stack) shares one fetch and parse.
const sourceMapCache = new Map<string, Promise<SourceMapConsumer | null>>();

const HELPER_FRAME_PATTERNS = [
    /\bGenerator\.next\b/,
    /\bfulfilled\b/,
    /\b__awaiter\b/,
    /\bstep\b/,
    /\bmapStackLine\b/,
    /\bmapStackTrace\b/,
    /\bmapStackTraceAsync\b/,
    /\bloadSourceMap\b/
];

/**
 * Parse a stack trace line to extract file, line, and column
 * Handles formats like:
 *   at functionName (http://localhost:8000/js/bootstrap.js:123:45)
 *   at http://localhost:8000/js/bootstrap.js:123:45
 */
function parseStackLine(line: string): {
    prefix: string;
    functionName: string | null;
    file: string;
    line: number;
    column: number;
} | null {
    const trimmed = line.trim();

    // Format: at functionName (https://host/file.js:line:col)
    const withFunction = trimmed.match(
        /^at\s+(.+?)\s+\((https?:\/\/[^)]+|file:\/\/[^)]+):(\d+):(\d+)\)$/
    );
    if (withFunction) {
        const [, functionName, file, lineStr, colStr] = withFunction;
        return {
            prefix: '    at ',
            functionName,
            file,
            line: parseInt(lineStr, 10),
            column: parseInt(colStr, 10)
        };
    }

    // Format: at https://host/file.js:line:col
    const noFunction = trimmed.match(
        /^at\s+((?:https?:\/\/|file:\/\/).+):(\d+):(\d+)$/
    );
    if (noFunction) {
        const [, file, lineStr, colStr] = noFunction;
        return {
            prefix: '    at ',
            functionName: null,
            file,
            line: parseInt(lineStr, 10),
            column: parseInt(colStr, 10)
        };
    }

    return null;
}

/**
 * Load a source map for a given JS file
 */
function loadSourceMap(jsUrl: string): Promise<SourceMapConsumer | null> {
    const normalizedUrl = jsUrl.trim();
    let cached = sourceMapCache.get(normalizedUrl);
    if (!cached) {
        cached = fetchSourceMap(normalizedUrl);
        sourceMapCache.set(normalizedUrl, cached);
    }
    return cached;
}

async function fetchSourceMap(
    normalizedUrl: string
): Promise<SourceMapConsumer | null> {
    // Only map browser script URLs
    if (
        !/^https?:\/\//.test(normalizedUrl) &&
        !/^file:\/\//.test(normalizedUrl)
    ) {
        return null;
    }

    if (!normalizedUrl.endsWith('.js')) {
        return null;
    }

    try {
        // Load the source map file
        const mapUrl = normalizedUrl + '.map';
        const response = await fetch(mapUrl);
        if (!response.ok) {
            return null;
        }

        const mapData = await response.json();
        return await new SourceMapConsumer(mapData);
    } catch (error) {
        console.warn(`Failed to load source map for ${normalizedUrl}:`, error);
        return null;
    }
}

/**
 * Map a single stack trace line to original source location
 */
async function mapStackLine(line: string): Promise<string> {
    const parsed = parseStackLine(line);
    if (!parsed) return line; // Return unchanged if can't parse

    const {
        prefix,
        functionName: parsedFunctionName,
        file,
        line: bundledLine,
        column: bundledColumn
    } = parsed;

    // Load source map
    const consumer = await loadSourceMap(file);
    if (!consumer) return line; // Return unchanged if no source map

    // Map position
    const original = consumer.originalPositionFor({
        line: bundledLine,
        column: bundledColumn
    });

    if (!original.source) return line; // Return unchanged if mapping failed

    // Reconstruct the stack line with original position
    const sourceFile = original.source
        .replace(/^webpack:\/\/[^/]+\/\.\//, '')
        .replace(/^webpack:\/\/\/\.\//, '')
        .replace(/^webpack:\/\//, '')
        .replace(/^\.\//, '');
    const functionName = original.name || parsedFunctionName || 'anonymous';

    return `${prefix}${functionName} (${sourceFile}:${original.line}:${original.column})`;
}

function isHelperFrame(line: string): boolean {
    return HELPER_FRAME_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Apply source maps to an entire stack trace
 * Returns a promise that resolves to the mapped stack
 */
export async function mapStackTrace(stack: string): Promise<string> {
    const lines = stack.split('\n');
    const mappedLines = await Promise.all(
        lines.map((line) => mapStackLine(line))
    );
    const filteredLines = mappedLines.filter((line) => {
        if (!line.trim()) {
            return false;
        }
        return !isHelperFrame(line);
    });

    return filteredLines.join('\n');
}

/**
 * Synchronous version that returns the raw stack immediately
 * and triggers async mapping in the background
 */
export function mapStackTraceAsync(
    stack: string,
    callback: (mapped: string) => void
): string {
    // Trigger async mapping
    mapStackTrace(stack)
        .then(callback)
        .catch((error) => {
            console.error('Stack mapping failed:', error);
        });

    // Return original stack immediately
    return stack;
}
