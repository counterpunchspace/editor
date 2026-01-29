// Python utility functions

/**
 * Adjust line numbers in a traceback by subtracting an offset.
 * This is useful when user code is wrapped in boilerplate code.
 *
 * @param {string} errorMessage - The error message/traceback
 * @param {number} lineOffset - Number of lines to subtract from line numbers
 * @param {string[]} [framePatterns] - Patterns to match frames to adjust (default: ['<exec>', '<string>'])
 * @returns {string} - Traceback with adjusted line numbers
 */
window.adjustTracebackLineNumbers = function adjustTracebackLineNumbers(
    errorMessage,
    lineOffset,
    framePatterns = ['<exec>', '<string>']
) {
    if (!errorMessage || typeof errorMessage !== 'string' || lineOffset <= 0) {
        return errorMessage;
    }

    const lines = errorMessage.split('\n');
    const adjustedLines = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Check if this is a File line that matches our patterns
        if (line.trim().startsWith('File "')) {
            const matchesPattern = framePatterns.some((pattern) =>
                line.includes(`"${pattern}"`)
            );

            if (matchesPattern) {
                // Match and adjust line number: File "<exec>", line 27, in <module>
                const lineNumMatch = line.match(/, line (\d+),/);
                if (lineNumMatch) {
                    const originalLineNum = parseInt(lineNumMatch[1], 10);
                    const adjustedLineNum = Math.max(
                        1,
                        originalLineNum - lineOffset
                    );
                    line = line.replace(
                        `, line ${originalLineNum},`,
                        `, line ${adjustedLineNum},`
                    );
                }
            }
        }

        adjustedLines.push(line);
    }

    return adjustedLines.join('\n');
};

/**
 * Clean up Python error traceback by removing Pyodide internal frames
 * and keeping only the relevant user code traceback.
 * Optionally adjusts line numbers for user code frames.
 *
 * @param {string} errorMessage - The full Python error message/traceback
 * @param {Object} [options] - Options object
 * @param {number} [options.lineOffset=0] - Number of wrapper lines to subtract from user code line numbers
 * @param {boolean} [options.skipExecFrames=false] - Whether to skip <exec> frames (true for glyph filters that use <filter>)
 * @returns {string} - Cleaned traceback with only user-relevant frames
 */
window.cleanPythonTraceback = function cleanPythonTraceback(
    errorMessage,
    options = {}
) {
    // Handle legacy call with lineOffset as number
    if (typeof options === 'number') {
        options = { lineOffset: options };
    }
    const lineOffset = options.lineOffset || 0;
    const skipExecFrames = options.skipExecFrames || false;

    if (!errorMessage || typeof errorMessage !== 'string') {
        return errorMessage;
    }

    const lines = errorMessage.split('\n');
    const cleanedLines = [];
    let skipFrame = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Skip "...<N lines>..." markers (continuation of Pyodide frames)
        if (line.trim().match(/^\.\.\.<\d+ lines>\.\.\.$/)) {
            continue;
        }

        // Non-indented lines that aren't "File" or "Traceback" are error messages - always keep
        // (e.g., "TypeError: ...", "ValueError: ...", "NameError: ...")
        if (
            line.length > 0 &&
            !line.startsWith(' ') &&
            !line.startsWith('\t') &&
            !line.trim().startsWith('File "') &&
            !line.startsWith('Traceback')
        ) {
            skipFrame = false;
            cleanedLines.push(line);
            continue;
        }

        // Check if this is a File line
        if (line.trim().startsWith('File "')) {
            // Skip Pyodide internal frames
            if (
                line.includes('/lib/python313.zip/_pyodide/') ||
                (line.includes('/lib/python3') && line.includes('/_pyodide/'))
            ) {
                skipFrame = true;
                continue;
            }

            // Skip wrapper <exec> frames when skipExecFrames is true
            // (used for glyph filters where user code uses <filter>)
            if (skipExecFrames && line.includes('"<exec>"')) {
                skipFrame = true;
                continue;
            }

            // This is a user code frame - keep it
            skipFrame = false;

            // Adjust line numbers for user code frames if offset provided
            if (
                lineOffset > 0 &&
                (line.includes('"<filter>"') ||
                    line.includes('"<script>"') ||
                    line.includes('"<string>"'))
            ) {
                const lineNumMatch = line.match(/, line (\d+),/);
                if (lineNumMatch) {
                    const originalLineNum = parseInt(lineNumMatch[1], 10);
                    const adjustedLineNum = Math.max(
                        1,
                        originalLineNum - lineOffset
                    );
                    line = line.replace(
                        `, line ${originalLineNum},`,
                        `, line ${adjustedLineNum},`
                    );
                }
            }
        }

        // Skip code lines that are part of skipped frames
        if (skipFrame) {
            continue;
        }

        // Keep all other lines (user code frames, error messages, traceback header)
        cleanedLines.push(line);
    }

    let result = cleanedLines.join('\n').trim();

    // If we ended up with just the traceback header and no frames,
    // extract just the error message for cleaner output
    const headerMatch = result.match(
        /^Traceback \(most recent call last\):\s*\n?([\s\S]*)$/
    );
    if (headerMatch) {
        const afterHeader = headerMatch[1].trim();
        // If there are no "File" lines (no frames), just return the error message
        if (!afterHeader.includes('File "')) {
            return afterHeader;
        }
    }

    return result;
};

/**
 * Count the number of lines in a string (for calculating wrapper code offsets)
 * @param {string} code - The code string
 * @returns {number} - Number of lines
 */
window.countCodeLines = function countCodeLines(code) {
    if (!code || typeof code !== 'string') return 0;
    return code.split('\n').length;
};
