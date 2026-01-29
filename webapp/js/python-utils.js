// Python utility functions

/**
 * Clean up Python error traceback by removing Pyodide internal frames
 * and keeping only the relevant user code traceback.
 * 
 * @param {string} errorMessage - The full Python error message/traceback
 * @returns {string} - Cleaned traceback with only user-relevant frames
 */
window.cleanPythonTraceback = function cleanPythonTraceback(errorMessage) {
    if (!errorMessage || typeof errorMessage !== 'string') {
        return errorMessage;
    }

    const lines = errorMessage.split('\n');
    const cleanedLines = [];
    let inPyodideFrame = false;
    let foundUserCode = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip Pyodide internal frames
        if (
            line.includes('/lib/python313.zip/_pyodide/_base.py') ||
            line.includes('...<') // Skip "...<9 lines>..." markers
        ) {
            inPyodideFrame = true;
            continue;
        }

        // Check if this is a frame we want to keep (user code)
        if (line.includes('File "<string>"') || line.includes('File "<exec>"')) {
            // Only keep <exec> frames that come after we've started seeing user code
            if (line.includes('File "<string>"')) {
                foundUserCode = true;
            }
            
            if (foundUserCode || line.includes('File "<string>"')) {
                inPyodideFrame = false;
            }
        }

        // Keep the line if we're not in a Pyodide frame
        if (!inPyodideFrame || foundUserCode) {
            // If this is the first line and it's "Traceback...", always keep it
            if (cleanedLines.length === 0 && line.startsWith('Traceback (most recent call last):')) {
                cleanedLines.push(line);
            } else if (cleanedLines.length > 0) {
                cleanedLines.push(line);
            }
        }
    }

    return cleanedLines.join('\n').trim();
};
